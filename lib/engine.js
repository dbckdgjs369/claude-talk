// 채팅방 하나 = HeadlessSession 하나.
// claude -p stream-json 모드를 자식 프로세스로 띄워 구조화 이벤트로 대화한다.
// (PTY/TUI 스크래핑 없음 — trust 다이얼로그, 준비 감지, 재전송 안전망 전부 불필요)
const fs = require('fs');
const readline = require('readline');
const { EventEmitter } = require('events');
const { parseFileSync, sessionFileFor, summarizeToolUse, lastContextTokens } = require('./transcript');
const { isTaskTool, applyTaskTool, emptyTaskState, foldTaskOps, taskSummary } = require('./tasks');
const { spawnShell, claudeBin, claudeEnv, looksLikeClaudeMissing, CLAUDE_MISSING_HINT } = require('./platform');

// 자동 압축 임계 (토큰). 모델 한도와 무관한 절대값 — 이유는 _compactAt() 주석 참고.
const AUTO_COMPACT_AT = 180_000;

// Node 크래시는 첫 줄에 원인이 나오고 그 뒤로 번들 소스가 수십 KB 쏟아진다.
// 뒤에서 자르면(기존 동작) 난독화된 코드 조각만 남아 아무 정보가 없다 → 앞에서 자른다.
function explainStderr(raw) {
  const s = (raw || '').trim();
  if (!s) return '(에러 출력 없음)';
  // 옛 Node에서 죽은 경우는 경로에 버전이 드러난다 — 그대로 번역해서 알려준다
  const old = /node\/v(\d+)\.[\d.]+\/lib\/node_modules\/@anthropic-ai\/claude-code/.exec(s);
  if (old && Number(old[1]) < 18) {
    return `이 폴더가 Node ${old[1]} 환경으로 잡혀 claude가 실행되지 못했어요 (Claude Code는 Node 18 이상 필요).`;
  }
  const head = s.split('\n').slice(0, 3).join('\n');
  return head.length > 400 ? head.slice(0, 400) + '…' : head;
}

class HeadlessSession extends EventEmitter {
  constructor(room) {
    super();
    this.room = room; // {id, dir, name, sessionId}
    this.state = 'offline'; // offline | starting | working | waiting
    this.child = null;
    this._stderrTail = '';
    // 앞부분을 따로 보관한다. 크래시 원인은 첫 줄에 있는데 tail만 두면(그 뒤로 번들 소스가
    // 수십 KB 쏟아져) 진작에 밀려나 사라진다.
    this._stderrHead = '';
    this.tasks = emptyTaskState(); // 할 일 목록 (history() 복원 + 실시간 task-op로 갱신)
  }

  spawn() {
    if (this.child) return;
    // 폴더가 사라졌으면(이동·이름 변경·외장 디스크 분리) spawn은 ENOENT로 실패한다.
    // 미리 잡아야 "폴더가 없다"는 걸 알려줄 수 있다 — ENOENT만으로는 원인을 짐작할 수 없다.
    if (!fs.existsSync(this.room.dir)) {
      this._setState('offline');
      this._awaitingTurn = false;
      this.emit('message', {
        role: 'system',
        text: `폴더를 찾을 수 없습니다\n${this.room.dir}\n\n폴더를 옮겼거나 지웠다면 이 방은 더 쓸 수 없어요. 우클릭으로 삭제할 수 있습니다.`,
        ts: new Date().toISOString(),
      });
      return;
    }
    // 권한 모드는 기본적으로 지정하지 않는다 — settings.json의 전역 설정을 그대로 따른다.
    // 방에서 따로 고른 경우에만 덮어쓴다.
    const perm = this.room.permissionMode ? ` --permission-mode ${this.room.permissionMode}` : '';
    const args =
      '-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages' + perm;
    // 분기(fork): 아직 자기 세션이 없고 forkFrom이 있으면 원본을 이어받아 새 세션 ID로 갈라낸다.
    // --fork-session은 대화를 복사해 새 ID로 다시 쓰므로 원본 파일은 그대로 남는다.
    const resumeId = this.room.sessionId || (this.room.forkFrom ? this.room.forkFrom : null);
    const forkFlag = !this.room.sessionId && this.room.forkFrom ? ' --fork-session' : '';
    // 셸이 방 폴더에서 PATH를 해석하면 그 프로젝트의 .nvmrc를 타서 엉뚱한 claude가 잡힌다.
    // 홈에서 한 번 찾아둔 절대 경로를 쓴다 (platform.claudeBin 주석 참고)
    const bin = JSON.stringify(claudeBin());
    const cmd = resumeId
      ? `${bin} ${args} --resume ${JSON.stringify(resumeId)}${forkFlag}`
      : `${bin} ${args}`;

    const env = claudeEnv();

    this._setState('starting');
    this.child = spawnShell(cmd, {
      cwd: this.room.dir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // 자식이 먼저 죽은 뒤 stdin에 쓰면 EPIPE — 핸들러 없으면 uncaughtException으로 앱 전체가 죽음
    this.child.stdin.on('error', () => {});
    // spawn 실패(폴더 없음 등)는 error만 오고 exit은 오지 않는다. 삼키면 상태가 starting에
    // 갇혀 "응답 대기 중"이 무한정 올라간다 — 폴더를 옮기거나 외장 디스크가 빠져도 같은 증상.
    this.child.on('error', (err) => {
      this.child = null;
      this._awaitingTurn = false;
      this._setState('offline');
      this.emit('message', {
        role: 'system',
        text: `세션을 시작할 수 없습니다 (${err.code || err.message})`,
        ts: new Date().toISOString(),
      });
    });

    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on('line', (line) => this._onEvent(line));

    this.child.stderr.on('data', (d) => {
      const s = d.toString();
      if (this._stderrHead.length < 2000) this._stderrHead = (this._stderrHead + s).slice(0, 2000);
      this._stderrTail = (this._stderrTail + s).slice(-2000);
    });

    this.child.on('exit', (code) => {
      const wasStarting = this.state === 'starting';
      this.child = null;
      this._awaitingTurn = false; // 턴 도중 죽어도 대기줄이 갇히지 않게
      this._setState('offline');
      // 대기 중이던 메시지가 있으면 재기동해서 이어서 투입
      if (this.queue?.length && code === 0) {
        const next = this.queue.shift();
        this.spawn();
        this.emit('queue-flushed');
        this._writeUser(next.text, next.images, { emitMessage: false });
      }
      if (code !== 0 && wasStarting) {
        // claude 자체가 없어서 죽은 경우는 stderr 원문 대신 설치 안내를 보여준다
        const detail = looksLikeClaudeMissing(this._stderrHead + this._stderrTail)
          ? CLAUDE_MISSING_HINT
          : explainStderr(this._stderrHead || this._stderrTail);
        this.emit('message', {
          role: 'system',
          text: `세션 시작 실패 (exit ${code})\n${detail}`,
          ts: new Date().toISOString(),
        });
      }
    });
  }

  _onEvent(line) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }

    // init이 안 오는 경로로 다음 턴이 시작되는 경우도 같이 잡는다 (아래 init 분기 주석 참고)
    if ((ev.type === 'stream_event' || ev.type === 'assistant') && this.state === 'waiting') {
      this._resumeTurn();
    }

    // 실시간 진행 신호: 생각/타이핑/도구 준비를 상태줄로, 텍스트 델타는 스트리밍 버블로
    if (ev.type === 'stream_event') {
      const se = ev.event;
      if (!se) return;
      if (se.type === 'content_block_start') {
        const t = se.content_block?.type;
        if (t === 'thinking') this._setActivity('생각 중');
        else if (t === 'text') {
          this._streamText = '';
          this._setActivity('답변 작성 중');
        } else if (t === 'tool_use') {
          this._setActivity(`${se.content_block.name} 실행 중`);
        }
      } else if (se.type === 'content_block_delta') {
        const d = se.delta;
        if (d?.type === 'text_delta' && this._streamText !== null && this._streamText !== undefined) {
          this._streamText += d.text;
          this.emit('stream-text', this._streamText);
        } else if (d?.type === 'thinking_delta') {
          this._setActivity('생각 중');
        }
      }
      return;
    }

    if (ev.type === 'system' && ev.subtype === 'init') {
      if (ev.session_id && ev.session_id !== this.room.sessionId) {
        this.room.sessionId = ev.session_id;
        this.emit('session-id', ev.session_id);
      }
      // 현재 모델·슬래시 커맨드 목록 (자동완성/모델 픽커용).
      // init은 세션 시작값이라 /model로 이미 바꾼 뒤라면 모델은 덮어쓰지 않음
      if (ev.model && !this._lastModel) this._lastModel = ev.model;
      // init의 permissionMode는 전역 설정이 반영된 "실효 모드"라 그대로 표시하면 된다
      if (ev.permissionMode) this.permissionMode = ev.permissionMode;
      this.emit('info', {
        model: this._lastModel || ev.model || null,
        slashCommands: ev.slash_commands || [],
        permissionMode: this.permissionMode || null,
      });
      if (this.state === 'starting') this._setState('working');
      // 턴이 끝난 직후 init이 또 오면, 우리가 안 보낸 턴이 시작된 것이다 — 턴 중에 끼워 넣은
      // 말에 도구 경계가 없어서 claude가 별도 턴으로 처리하는 경우. 상태를 도로 올려야
      // "대기 중"으로 보이면서 실제로는 돌고 있는 상황이 안 생긴다.
      else if (this.state === 'waiting') this._resumeTurn();
      return;
    }

    if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
      // 매 응답에 실제 사용 모델이 실려 옴 — /model로 중간에 바꿔도 표시가 즉시 따라가게
      // (<synthetic> = 로컬 명령 응답의 가짜 모델명이라 제외)
      if (ev.message.model && !ev.message.model.startsWith('<') && ev.message.model !== this._lastModel) {
        this._lastModel = ev.message.model;
        this.emit('info', { model: ev.message.model, slashCommands: [] });
      }
      // usage 합 = 현재 세션 컨텍스트 크기. 자동 컴팩션·모델 전환 경고의 기준값
      const u = ev.message.usage;
      if (u) {
        const total =
          (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        if (total > 0) this.contextTokens = total;
      }
      const ts = new Date().toISOString();
      for (const c of ev.message.content) {
        if (c.type === 'text' && c.text && c.text.trim()) {
          this._streamText = null; // 스트리밍 버블 확정 신호
          this.emit('message', { role: 'assistant', text: c.text.trim(), ts });
        } else if (c.type === 'tool_use') {
          // 할 일 도구는 채팅 줄이 아니라 상태 갱신으로 (transcript 복원 경로와 동일한 판정)
          if (isTaskTool(c.name)) {
            this.tasks = applyTaskTool(this.tasks, c.name, c.input || {});
            this.emit('tasks', taskSummary(this.tasks));
          } else {
            this.emit('message', { role: 'tool', text: summarizeToolUse(c), ts });
          }
        }
      }
      return;
    }

    // 권한 모드가 바뀌면 CLI가 status로 알려준다 (앱이 바꿨든 세션 내부에서 바뀌었든)
    if (ev.type === 'system' && ev.subtype === 'status' && ev.permissionMode) {
      if (ev.permissionMode !== this.permissionMode) {
        this.permissionMode = ev.permissionMode;
        this.emit('info', { model: this._lastModel || null, slashCommands: [], permissionMode: ev.permissionMode });
      }
      return;
    }

    if (ev.type === 'control_response') return; // interrupt 응답 등은 무시

    if (ev.type === 'result') {
      this._setActivity(null);
      this.turnStartedAt = null;
      this._awaitingTurn = false;
      clearTimeout(this._intTimer);
      if (this._interrupting) {
        this._interrupting = false;
        this.emit('message', { role: 'system', text: '⏹ 작업을 중단했어요', ts: new Date().toISOString() });
      } else if (ev.is_error) {
        const errText = String(ev.result || ev.subtype || '알 수 없는 오류');
        this.emit('message', {
          role: 'system',
          text: `⚠️ 턴 실패: ${errText.slice(0, 300)}`,
          ts: new Date().toISOString(),
        });
        // 히스토리가 현재 모델 컨텍스트 한도 초과 — /compact 자체도 실패하는 상태라 복구 경로 안내
        if (/prompt is too long/i.test(errText)) {
          const ctx = this.contextTokens
            ? `현재 히스토리 약 ${Math.round(this.contextTokens / 10000)}만 토큰 / 한도 ${Math.round(this._contextLimit() / 10000)}만 토큰. `
            : '';
          this.emit('message', {
            role: 'system',
            text: `💡 대화 히스토리가 현재 모델의 컨텍스트 한도를 초과했어요. ${ctx}/model opus 등 큰 모델로 전환한 뒤 /compact 로 압축하고, 필요하면 원래 모델로 돌아오세요.`,
            ts: new Date().toISOString(),
          });
        }
      }
      if (this._autoCompacting) {
        // 방금 끝난 턴이 자동 /compact — 성공했으면 컨텍스트 카운터 리셋
        this._autoCompacting = false;
        if (!ev.is_error) {
          this.contextTokens = 0;
          this._compactFailed = false;
          this.emit('message', {
            role: 'system',
            text: '🗜️ 자동 압축 완료 — 대화를 계속하세요',
            ts: new Date().toISOString(),
          });
        } else {
          // 압축이 실패하면 contextTokens가 그대로라 매 턴 다시 시도하게 된다.
          // 한 번 실패했으면 접고 사용자에게 넘긴다 (수동 /compact로 복구 가능)
          this._compactFailed = true;
          this.emit('message', {
            role: 'system',
            text: '🗜️ 자동 압축에 실패했어요. 필요하면 /compact 를 직접 보내주세요.',
            ts: new Date().toISOString(),
          });
        }
      } else if (!ev.is_error && !this._compactFailed && this._lastModel && this.contextTokens && this.contextTokens > this._compactAt()) {
        // TUI의 auto-compact 재현. _lastModel을 조건에 넣은 이유: 모델을 아직 못 봤으면
        // _contextLimit()이 기본값 200K로 떨어져 큰 방이 첫 턴부터 압축을 맞는다.
        this._autoCompacting = true;
        this.emit('message', {
          role: 'system',
          text: `🗜️ 컨텍스트 ${Math.round(this.contextTokens / 1000)}k — 자동 압축 중... (턴마다 이만큼을 다시 읽지 않도록)`,
          ts: new Date().toISOString(),
        });
        this._writeUser('/compact', [], { emitMessage: false });
        return;
      }
      // 대기줄에 메시지가 있으면 waiting을 거치지 않고 바로 다음 턴 투입 (터미널 큐와 동일)
      if (this.queue?.length) {
        const next = this.queue.shift();
        this.emit('queue-flushed');
        this._writeUser(next.text, next.images, { emitMessage: false });
        return;
      }
      this._setState('waiting');
      this.emit('turn-end');
    }
  }

  // 진행 중인 턴만 중단 (세션은 유지) — Claude Code TUI의 ESC와 동일
  interrupt() {
    if (!this.child || this.state !== 'working') return;
    this._interrupting = true;
    this.child.stdin.write(
      JSON.stringify({
        type: 'control_request',
        request_id: 'int-' + Date.now(),
        request: { subtype: 'interrupt' },
      }) + '\n'
    );
    // result 이벤트가 안 오는 경우 대비 안전망
    clearTimeout(this._intTimer);
    this._intTimer = setTimeout(() => {
      if (this._interrupting) {
        this._interrupting = false;
        this._setState('waiting');
        this.emit('turn-end');
      }
    }, 5000);
  }

  // images: [{media_type, data(base64)}]
  // 턴 진행 중에 온 메시지는 터미널처럼 대기줄에 뒀다가 턴이 끝나면 투입
  send(text, images = []) {
    if (!this.child) this.spawn();
    // 이미 임계를 넘은 방을 다시 열었을 때: 사용자 말을 먼저 보내면 그 한 턴이 컨텍스트
    // 전량(예: 93만)을 읽고 나서야 압축이 걸린다. 순서를 뒤집어 압축부터 하고, 사용자 말은
    // 대기줄에 넣어 압축 완료 직후 자동으로 투입되게 한다 (result 핸들러의 큐 플러시 경로).
    if (!this._autoCompacting && !this._compactFailed && !this._awaitingTurn && this.contextTokens > AUTO_COMPACT_AT) {
      this._autoCompacting = true;
      this.queue = this.queue || [];
      this.queue.push({ text, images });
      this.emit('message', {
        role: 'user',
        text,
        images: images.map((img) => `data:${img.media_type};base64,${img.data}`),
        ts: new Date().toISOString(),
        pending: true,
      });
      this.emit('message', {
        role: 'system',
        text: `🗜️ 컨텍스트 ${Math.round(this.contextTokens / 1000)}k — 먼저 압축하고 보낼게요`,
        ts: new Date().toISOString(),
      });
      this._writeUser('/compact', [], { emitMessage: false });
      return;
    }
    // 턴 중에 온 말도 그대로 stdin에 흘린다.
    //
    // 예전엔 대기줄에 넣고 턴이 끝나야 투입했는데, 그건 터미널과 다르게 동작한 것이었다.
    // 헤드리스 stream-json도 턴 중 입력을 받아 "도구 호출 경계"에서 집어간다 — 실측:
    // sleep을 6번 도는 턴의 두 번째 도구 직후에 넣었더니 남은 4번을 버리고 그 말에 답했다.
    // (도구가 없는 순수 텍스트 생성 턴은 경계가 없어서 끝난 뒤에 처리된다. 터미널도 같다.)
    //
    // 압축 중일 때만 예외다. 압축 턴에 사용자 말이 섞이면 압축 자체가 오염된다.
    if (this._autoCompacting) {
      this.queue = this.queue || [];
      this.queue.push({ text, images });
      this.emit('message', {
        role: 'user',
        text,
        images: images.map((img) => `data:${img.media_type};base64,${img.data}`),
        ts: new Date().toISOString(),
        pending: true, // UI: "대기 중" 표시
      });
      return;
    }
    this._writeUser(text, images, { emitMessage: true, midTurn: this._awaitingTurn });
  }

  // 모델별 컨텍스트 한도 (토큰). 1M은 [1m] 변형에만 해당하고, 기본 opus/sonnet은 200K다.
  // 예전엔 /opus|sonnet/이면 무조건 1M으로 봤는데, 그러면 200K 모델에서 압축이 안 걸린 채
  // 한도를 넘겨 "Prompt is too long"으로 죽는다.
  _limitFor(modelId) {
    const m = String(modelId || '').toLowerCase();
    if (/\[1m\]|-1m\b/.test(m)) return 1_000_000;
    if (/haiku/.test(m)) return 200_000;
    if (/fable|mythos|opus|sonnet/.test(m)) return 200_000;
    return 200_000;
  }

  _contextLimit() {
    return this._limitFor(this._lastModel);
  }

  // 자동 압축을 실제로 거는 지점.
  //
  // 왜 한도의 80%가 아니라 절대값인가: 에이전트 루프는 도구 호출 하나마다 API 요청 1건이고
  // 매 요청이 컨텍스트 전량을 다시 읽는다. 한도가 1M인 모델에서 80%를 기다리면 요청당
  // 80만 토큰을 읽게 된다. 실측(8/29 요청당 평균 757k, 8/30 890k)에서 캐시 읽기가 그날
  // 비용의 78%였다. TUI의 자체 auto-compact는 수만 토큰대에서 돌며 이 상황을 안 만든다.
  // 헤드리스(-p) 모드엔 그 auto-compact가 없어서 여기서 대신 건다.
  _compactAt() {
    return Math.min(AUTO_COMPACT_AT, Math.floor(this._contextLimit() * 0.8));
  }

  // 터미널처럼 /model 입력 즉시 표시를 갱신 (실제 모델은 다음 응답에서 확정·정정됨)
  _applyOptimisticModel(text) {
    const alias = /^\/model\s+(\S+)/.exec(text || '')?.[1];
    if (!alias) return;
    const known = { fable: 'claude-fable-5', opus: 'claude-opus-5', sonnet: 'claude-sonnet-5', haiku: 'claude-haiku-4-5' };
    const base = alias.replace('[1m]', '').toLowerCase();
    const id = known[base] || (base.startsWith('claude-') ? base : null);
    if (!id) return;
    // 히스토리가 새 모델 창에 안 들어가면 다음 턴부터 무조건 Prompt is too long — 전환 전에 경고
    if (this.contextTokens && this.contextTokens > this._limitFor(id)) {
      this.emit('message', {
        role: 'system',
        text: `⚠️ 현재 히스토리(약 ${Math.round(this.contextTokens / 10000)}만 토큰)가 ${alias}의 컨텍스트 한도(${Math.round(this._limitFor(id) / 10000)}만 토큰)를 넘어요. 전환하면 모든 메시지가 "Prompt is too long"으로 실패합니다. 먼저 /compact 로 압축하세요.`,
        ts: new Date().toISOString(),
      });
    }
    this._lastModel = id;
    this.emit('info', { model: id, slashCommands: [] });
  }

  _writeUser(text, images, { emitMessage, midTurn = false }) {
    this._applyOptimisticModel(text);
    const content = [
      ...images.map((img) => ({
        type: 'image',
        source: { type: 'base64', media_type: img.media_type, data: img.data },
      })),
      ...(text ? [{ type: 'text', text }] : []),
    ];
    // stdin은 버퍼링되므로 init 전에 써도 안전함 (검증됨)
    this.child.stdin.write(
      JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n'
    );
    if (emitMessage) {
      this.emit('message', {
        role: 'user',
        text,
        images: images.map((img) => `data:${img.media_type};base64,${img.data}`),
        ts: new Date().toISOString(),
      });
    }
    this._awaitingTurn = true;
    // 턴 중에 끼워 넣은 말은 새 턴을 여는 게 아니다. 경과 시간을 0으로 되돌리거나 진행 중인
    // 활동 표시를 "응답 대기 중"으로 덮으면, 이미 돌고 있는 작업이 방금 시작한 것처럼 보인다.
    if (!midTurn) {
      this.turnStartedAt = Date.now();
      // 이번 턴의 말만 알림에 쓰도록 비운다. 안 지우면 도구만 돌리고 텍스트 없이 끝난 턴에서
      // 직전 턴의 말이 그대로 알림에 실려 "이미 읽은 메시지"가 다시 온다.
      this.lastSay = null;
      this._setActivity('응답 대기 중');
    }
    if (this.state !== 'starting') this._setState('working');
  }

  _setActivity(label) {
    if (this.activity === label) return;
    this.activity = label;
    this.emit('activity');
  }

  // 이미 돌고 있는 세션의 권한 모드를 바꾼다 (TUI의 shift+tab에 해당).
  // 세션이 안 떠 있으면 다음 spawn 때 인자로 들어가므로 저장만 해두면 된다.
  setPermissionMode(mode) {
    this.room.permissionMode = mode;
    this.permissionMode = mode;
    if (this.child) {
      this.child.stdin.write(
        JSON.stringify({
          type: 'control_request',
          request_id: 'pm-' + Date.now(),
          request: { subtype: 'set_permission_mode', mode },
        }) + '\n'
      );
    }
    this.emit('info', { model: this._lastModel || null, slashCommands: [], permissionMode: mode });
  }

  history() {
    // 분기 직후에는 자기 세션 파일이 아직 없다 (첫 턴에서 생긴다).
    // 그동안은 원본 파일을 읽어 물려받을 대화를 보여준다 — 빈 방으로 보이지 않게.
    const sid = this.room.sessionId || this.room.forkFrom;
    if (!sid) return [];
    const file = sessionFileFor(this.room.dir, sid);
    // 세션이 꺼져 있어도 방을 열면 무게가 보이게 (턴이 돌면 실시간 값으로 덮인다)
    if (!this.contextTokens) this.contextTokens = lastContextTokens(file);
    const items = parseFileSync(file);
    // 할 일 상태는 세션 처음부터 접어야 나온다 (증분 도구가 섞여 있어 마지막 것만 봐선 안 됨)
    this.tasks = foldTaskOps(items.filter((i) => i.kind === 'task-op'));
    return items.filter((i) => i.kind === 'msg');
  }

  // 우리가 보내지 않은 턴이 시작됐을 때 상태를 되돌린다 (턴 중 입력이 별도 턴으로 처리된 경우)
  _resumeTurn() {
    this._awaitingTurn = true;
    this.turnStartedAt = Date.now();
    this.lastSay = null;
    this._setActivity('응답 대기 중');
    this._setState('working');
  }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', s);
  }

  kill() {
    if (this.child) {
      try {
        this.child.stdin.end();
        this.child.kill();
      } catch {}
      this.child = null;
    }
    this._setState('offline');
  }
}

module.exports = { HeadlessSession };
