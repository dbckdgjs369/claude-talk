# CC Talk

여러 Claude Code 세션을 PC 카카오톡처럼 관리하는 데스크탑 앱.
세션 하나 = 채팅방 하나 = 창 하나.

## 실행

```bash
npm install
npm start
```

## 터미널에서 열기 (`claude-talk`)

`claude`처럼 프로젝트 폴더에서 바로 방을 연다.

```bash
npm i -g .          # 소스 폴더에서 한 번 (또는 npm link)

cd ~/projects/foo
claude-talk         # foo 방이 열린다
claude-talk ../bar  # 다른 폴더를 지정할 수도 있다
```

칠 때마다 **새 방**이 생긴다 — 터미널에서 `claude`를 다시 치면 새 세션이 열리는 것과 같다.
한 프로젝트에서 세션을 여러 개 병렬로 굴리는 게 정상 패턴이라 폴더로 묶지 않는다.
(`+` 버튼도 동일)

앱이 이미 떠 있어도 그 인스턴스에서 방이 열린다 — 새 프로세스는 single-instance 락에 걸려
바로 죽고 폴더 경로만 원본 프로세스로 넘어간다(`main.js`의 `second-instance`).

CLI가 앱을 찾는 순서는 `CC_TALK_APP` → 설치본(`/Applications`, `%LOCALAPPDATA%\Programs`) →
소스(`node_modules/electron`)다. 자동 탐색이 실패하면 경로를 직접 지정한다.

```bash
export CC_TALK_APP="/Applications/CC Talk.app"
```

## 패키징

```bash
npm run icon          # build/icon.png 재생성 (아이콘 수정했을 때만)
npm run dist          # macOS dmg (arm64 + x64)
npm run dist:win      # Windows 설치본 + 포터블 exe (x64)
npm run dist:win:dir  # Windows 무압축 — dist/win-unpacked/CC Talk.exe
```

Windows 산출물은 `dist/`에 두 개가 나온다.

- `CC-Talk-Setup-0.1.0.exe` — NSIS 설치 마법사(사용자 단위 설치, 경로 변경 가능, 바탕화면·시작 메뉴 바로가기)
- `CC-Talk-0.1.0-portable.exe` — 설치 없이 그대로 실행하는 단일 exe

mac에서도 wine 없이 그대로 빌드된다(electron-builder 26 기준). 코드 서명은 안 붙으므로 Windows에서
처음 실행할 때 SmartScreen 경고가 뜬다 — "추가 정보 → 실행"으로 넘어가면 된다.

### Windows 실행 조건

Claude Code CLI가 설치돼 있어야 한다 (`npm i -g @anthropic-ai/claude-code`). 앱이 `cmd.exe`로 띄운다.

PATH에 없어도 아래 위치는 앱이 알아서 뒤진다 — Explorer로 띄운 GUI 앱은 **로그인 시점의 PATH**를
물려받아서, CLI를 방금 설치했으면 PATH에 아직 안 잡혀 있기 때문이다.

```
%USERPROFILE%\.local\bin        네이티브 설치본
%APPDATA%\npm                   npm -g
%LOCALAPPDATA%\Programs\claude
%USERPROFILE%\AppData\Local\Volta\bin
%USERPROFILE%\scoop\shims
```

그래도 못 찾으면 시작할 때 안내 다이얼로그를 띄우고, 방을 열면 시스템 메시지로 설치 방법을 알려준다.

## 플랫폼 분기

OS별로 갈리는 부분은 전부 `lib/platform.js` 한 곳에 모아뒀다.

- **셸** — mac은 `zsh -ilc`(fnm/nvm PATH 로딩 때문), Windows는 `cmd.exe`.
  인용 처리는 Node의 `shell: true` 구현에 맡긴다
- **홈 경로** — `os.homedir()`. Windows엔 `$HOME`이 없다 (`USERPROFILE`)
- **자식 env** — `claudeEnv()`가 `CLAUDE*` 제거 + Windows PATH 보강을 함께 처리.
  `{...process.env}`로 복사하면 Windows env의 대소문자 무시 성질이 사라져 `Path`/`PATH`가
  갈리므로 하나로 합친다
- **창 크롬** — mac은 `hiddenInset`(왼쪽 신호등), Windows는 `titleBarOverlay`(오른쪽 네이티브 버튼).
  Windows에서 `hiddenInset`은 무시돼 닫기 버튼이 통째로 사라지므로 반드시 분기해야 한다.
  헤더 여백은 `body.win` / `body.mac` 클래스로 CSS에서 맞춘다
- **알림** — Windows 토스트는 `setAppUserModelId`가 설치본 appId와 맞아야 뜬다
- **중복 실행** — 포터블 exe는 더블클릭으로 쉽게 두 번 뜬다. `requestSingleInstanceLock`으로
  막지 않으면 두 프로세스가 `rooms.json`을 같이 쓰다 깨진다

## 구조 (v2 — 헤드리스 엔진)

- **메인 창** = 방 목록 (카톡 메인처럼 좁은 세로 창). 방 클릭 → 전용 채팅 창이 별도로 열림
- 방 생성(`+`) 시 폴더 선택 → 첫 메시지를 보내면 그 폴더에서 `claude -p --input-format stream-json --output-format stream-json --verbose`를 자식 프로세스로 스폰
- 대화는 **구조화 JSON 스트림**으로 주고받음 — PTY/TUI 스크래핑 없음, trust 다이얼로그 없음, 터미널 패널 없음
- `result` 이벤트 = 턴 종료 → "입력 기다리는 중" + (창이 포커스 아니면) 안읽음 뱃지 + 맥 알림 (알림 클릭 시 해당 방 창 포커스)
- 히스토리 복원: 재접속 시 `~/.claude/projects/<인코딩 경로>/<세션ID>.jsonl` 파싱 (헤드리스 모드도 transcript를 남김)
- 세션 이어가기: `--resume <세션ID>`. 방 정보는 `~/Library/Application Support/cc-talk/rooms.json`
- **방 제목 = ai-title**: Claude Code가 첫 턴 이후 자동 생성해 jsonl에 남기는 `{"type":"ai-title"}` 라인을 사용 (`claude --resume` 픽커와 동일한 제목). 없으면 폴더명 폴백, 생기면 자동 갱신(시작 시 + 턴 종료 4초 후 체크)
- **과거 세션 자동 합류**: `~/.claude/projects/` 전체 스캔 (`lib/sessions-index.js` — head/tail만 읽어 ~300ms). **1 파일 = 1 방, 아무것도 합치지 않음** — `claude --resume` 픽커와 개수까지 1:1 (사용자 결정). 빈 세션·사용자 메시지 없는 세션만 제외(픽커도 제외함). 삭제한 세션은 `ignoredSessions`에 기억
- **터미널 활동 실시간 반영**: 방 파일 mtime을 4초마다 폴링 → 터미널에서 이어간 대화의 미리보기·시간·정렬 갱신 + 열린 방 창 내용 갱신. 새 세션 합류 스캔은 20초마다
- **우클릭 메뉴**: 이름 변경 / 삭제. 이름 변경은 Claude Code와 동일하게 jsonl에 `ai-title` 라인 추가(마지막 것이 유효) → 터미널 픽커에도 반영. 제목 읽기는 tail의 마지막 ai-title 우선
- **sdk 마킹 정규화**: 헤드리스(-p) 세션은 `entrypoint:"sdk-cli"`로 마킹돼 `claude --resume` 픽커에서 숨겨짐 → 세션 종료 시·시작 시 `cli`/`typed`로 치환해 앱 대화도 터미널에서 보이게 함 (`normalizeSdkMarkers`)
- 방 삭제(우클릭): **대화 기록 파일까지 완전 삭제** — resume 사본 체인 포함(`deleteSessionChain`). 터미널 `claude --resume` 목록과 항상 일치하는 게 원칙 (앱과 Claude Code는 같은 데이터를 바라본다). 채팅 창 **ESC = 창 숨김**(즉시 복귀), X = 창 닫힘(재오픈 시 기록 복원) — 둘 다 세션은 백그라운드 유지. ⏻ = 세션 종료
- 목록 창도 **ESC = 숨김** — Dock 아이콘 클릭으로 복귀. 목록 창 X는 앱 종료
- **실시간 진행 표시**: `--include-partial-messages`로 응답이 타이핑되듯 스트리밍(▍ 커서), 상태줄에 "생각 중/답변 작성 중/도구 실행 중 · N초". 스트림 조각은 main에서 60ms 스로틀, 확정 메시지 도착 시 대기 조각 취소(유령 버블 방지)
- **메시지 대기줄**: 턴 진행 중에 보낸 메시지는 반투명 "대기 중" 버블로 클라이언트 큐에 보관, 턴 종료 시 자동 투입 (터미널 큐와 동일 UX)
- **⏹ 정지 버튼** (작업 중에만 표시): stream-json `control_request: interrupt`로 이번 턴만 중단, 세션은 유지 — TUI의 ESC와 동일. 버튼들은 hover 툴팁 있음
- **슬래시 커맨드**: `/` 입력 시 자동완성 (목록은 init 이벤트의 `slash_commands`에서 — 하드코딩 아님, 방별 캐시 + 전역 폴백). 인자 필요한 명령은 텍스트로 그대로 전송
- **모델 픽커**: `/model` (인자 없이) → 네이티브 선택 카드. 현재 모델은 init의 `model` 필드로 표시(헤더에도 노출), 선택 시 `/model <alias>` 전송 — 세션 한정. 기본값 저장은 미지원(2단계)
- 첨부: 사진 드래그/붙여넣기 → 이미지 블록으로 전송 (첨부칩 미리보기, 최대 4.5MB), 일반 파일 드래그 → 경로 삽입
- **권한 모드**: 기본은 `settings.json` 전역 설정을 그대로 따른다(앱이 강제하지 않음). 헤더 🛡 버튼으로 방마다 덮어쓸 수 있고(`bypassPermissions`/`acceptEdits`/`plan`) `rooms.json`에 저장된다.
  이미 돌고 있는 세션도 `control_request{subtype:'set_permission_mode'}`로 즉시 바뀐다 — TUI의 shift+tab에 해당.
  현재 모드는 init·`system/status` 이벤트의 `permissionMode`로 읽는다. (`--permission-prompt-tool`은 CLI 2.1.x에 없음)

## 파일

| 파일 | 역할 |
|---|---|
| `main.js` | Electron 메인 — 멀티윈도우, IPC, 뱃지/알림 |
| `lib/engine.js` | 방 하나 = HeadlessSession (stream-json 자식 프로세스 + 상태머신) |
| `lib/transcript.js` | **jsonl 포맷 지식은 전부 여기에만** — 히스토리 복원용 (버전업 시 여기만 고침) |
| `lib/rooms-store.js` | rooms.json 영속화 |
| `renderer/list.*` | 방 목록 창 |
| `renderer/room.*` | 채팅방 창 |

## 히스토리 (v1 PTY 시절 삽질 기록)

v1은 PTY로 TUI를 스크래핑하는 구조였고, 그 대가로: CLAUDE* env 상속 시 transcript 꺼짐, jsonl lazy 생성 데드락, trust 다이얼로그("Quick safety check")가 입력을 삼킴, TUI 준비 감지 휴리스틱, 8초 재전송 안전망... 전부 필요했다.
v2에서 헤드리스로 전환하며 **그 클래스의 문제가 통째로 사라짐**. TUI를 기계로 조종할 생각은 다시 하지 말 것.

- 여전히 유효한 함정: Claude Code 세션 안에서 앱을 띄우면 `CLAUDE*` env 상속으로 transcript 저장이 꺼짐 → 스폰 시 제거함 (`lib/engine.js`)
- macOS 경로는 NFD(분해형) 유니코드인데 Claude Code의 transcript 경로 인코딩은 NFC 기준 → `encodeProjectDir`에서 정규화 필수. 한글 폴더명일 때만 터짐
- Electron `--remote-debugging-port` 사용 시 `/json` HTTP 목록이 새 창을 반영 안 함 → `Target.getTargets`로 조회할 것 (browser 엔드포인트 ws는 동시 1클라이언트)

## 다음 단계 후보

- plan 모드 승인 카드 — plan에서는 Claude가 계획만 세우고 멈추는데, 헤드리스에는
  `ExitPlanMode`가 없어 스스로 빠져나오지 못한다. 앱이 "진행/취소" 카드를 띄우고
  진행 시 `set_permission_mode`로 풀어주면 승인 UX가 된다
- 세션 분기(fork), 방 목록 검색
