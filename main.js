const { app, BrowserWindow, ipcMain, dialog, Notification } = require('electron');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');
const {
  isMac,
  isWin,
  homeDir,
  findClaude,
  claudeEnv,
  spawnShell,
  CLAUDE_MISSING_HINT,
  titleBarOptions,
  applyTitleBarTheme,
} = require('./lib/platform');
const { RoomsStore } = require('./lib/rooms-store');
const { HeadlessSession, COMPACT_CHOICES, AUTO_COMPACT_AT } = require('./lib/engine');
const fs = require('fs');
const { scanPastSessions, deleteSessionFile, titleForFile, tailInfoForFile, renameSession, normalizeSdkMarkers } = require('./lib/sessions-index');
const { sessionFileFor, parseFileSync } = require('./lib/transcript');
const { taskSummary, foldTaskOps } = require('./lib/tasks');
const { UploadServer } = require('./lib/upload-server');
const {
  slugify, uniqueHandle, findMentions, unknownMentions, relayRule,
} = require('./lib/mentions');
const { createRelay } = require('./lib/relay');
const QRCode = require('qrcode');

let mainWin = null;
let store = null;
let globalSlashCommands = []; // 아무 방에서든 받은 최신 커맨드 목록 (새 방 자동완성 폴백)
const roomWins = new Map(); // roomId → BrowserWindow
const sessions = new Map(); // roomId → HeadlessSession
const unread = new Map(); // roomId → count

const truncate = (s, n) => {
  s = (s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
};

// 알림 배너는 평문이라 마크다운 기호가 날것으로 노출된다 (`코드`, **굵게**, ## 제목 …).
// 채팅창 렌더링은 그대로 두고 알림 본문에만 적용한다.
function plainify(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' (코드) ') // 코드블록은 통째로 축약
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' (이미지) ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // 링크는 글자만
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // 제목 기호
    .replace(/^\s*>\s?/gm, '') // 인용
    .replace(/^\s*[-*+]\s+/gm, '') // 불릿
    .replace(/^\s*\|.*\|\s*$/gm, ' ') // 표는 통째로 버림 (평문으로 옮기면 깨진다)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, '$1$2') // 기울임 (곱셈 기호와 헷갈리지 않게)
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function roomSummary(room) {
  const s = sessions.get(room.id);
  return {
    id: room.id,
    dir: room.dir,
    name: room.name,
    title: room.aiTitle || room.name, // ai-title 우선, 폴더명 폴백
    sessionId: room.sessionId || null,
    handle: room.handle || null, // @호출명 — 다른 방에서 이 방을 부를 때 쓴다
    state: s ? s.state : 'offline',
    activity: s?.activity || null,
    turnStart: s?.turnStartedAt || null,
    preview: room.lastPreview || '',
    time: room.lastTime || null,
    unread: unread.get(room.id) || 0,
    // 이 방이 얼마나 무거운지 — 턴마다 이만큼을 통째로 다시 읽으므로 방을 새로 팔 판단 근거가 된다
    context: s?.contextTokens || 0,
    contextLimit: s?._contextLimit?.() || 0,
    // 자동 압축이 걸리는 지점 — 상태줄 경고 색을 모델 한도가 아니라 이 값 기준으로 매긴다.
    // 방이 꺼져 있으면 모델을 몰라 한도로 깎을 수 없다 → 고른 값(없으면 기본)을 그대로 보여준다.
    compactAt: s?._compactAt?.() || room.compactAt || AUTO_COMPACT_AT,
    // 사용자가 직접 고른 값(안 골랐으면 null) — 픽커에서 "기본"과 구분해 체크 표시하는 데 쓴다
    compactPick: room.compactAt || null,
    // 분기 방이면 목록에서 원본을 알 수 있게 (원본이 삭제됐으면 이름은 비어 있다)
    forkedFrom: room.forkedFrom || null,
    forkedFromName: room.forkedFrom ? store.get(room.forkedFrom)?.aiTitle || store.get(room.forkedFrom)?.name || null : null,
  };
}

function broadcast(room) {
  const summary = roomSummary(room);
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('room:update', summary);
  const w = roomWins.get(room.id);
  if (w && !w.isDestroyed()) w.webContents.send('room:update', summary);
}

function roomWinFocused(roomId) {
  const w = roomWins.get(roomId);
  return !!w && !w.isDestroyed() && w.isFocused();
}

// Dock 아이콘에 안읽음 합계를 띄운다 (카톡처럼). 앱을 보고 있지 않아도 몇 개 쌓였는지 보이게.
// setBadgeCount는 macOS·Linux만 지원하므로 Windows에서는 조용히 넘긴다.
function refreshBadge() {
  if (!isMac) return;
  let total = 0;
  for (const n of unread.values()) total += n;
  try {
    app.setBadgeCount(total); // 0이면 뱃지가 사라진다
  } catch {}
}

// 발송한 알림을 붙잡아 둔다. 지역 변수로 두면 show() 직후 참조가 사라져 GC 대상이 되고,
// 그러면 네이티브 알림은 화면에 남아 있는데 click 핸들러만 죽어 눌러도 아무 일이 없다.
// (배너는 5초지만 알림 센터에서는 한참 뒤에도 누를 수 있어 실제로 걸린다)
const liveNotifications = new Set();

function notify(room, body) {
  const n = new Notification({
    // 제목이 폴더명이면 방이 여러 개일 때 구분이 안 된다 → 목록에 보이는 방 제목을 쓰고
    // 폴더는 부제목으로 (subtitle은 macOS 전용, 다른 OS에선 무시됨)
    title: room.aiTitle || room.name,
    subtitle: room.aiTitle ? room.name : '',
    body,
  });
  liveNotifications.add(n);
  const release = () => liveNotifications.delete(n);
  n.on('click', () => {
    release();
    openRoomWindow(room.id);
  });
  n.on('close', release);
  n.on('failed', release);
  // close가 안 오는 경우(알림 센터에 계속 쌓여 있는 등)를 대비한 상한 — 무한정 붙들지 않게
  setTimeout(release, 10 * 60 * 1000).unref?.();
  n.show();
}

// ---------- 방 사이 말 전달 (@호출명) ----------
//
// 방은 그대로 "세션 하나 = 기록 파일 하나"다. 초대·멤버 개념은 없다. A방에서 "@프론트한테
// 물어봐"라고 하면, A의 답변에서 @프론트로 시작하는 부분만 프론트 방의 stdin에 들어가
// 그 방에 말풍선으로 남는다. 규칙과 봉투 형식은 lib/mentions.js.

// 전달이 A→B→A→B로 끝없이 돌 수 있다. 사용자 발언 하나가 유발할 수 있는 전달 횟수를 묶는다.
// (에이전트 루프는 호출당 컨텍스트 전량을 다시 읽으므로 방치하면 곧장 토큰 폭주다)
const MAX_RELAY_HOPS = 6;

function handleIndex() {
  const m = new Map();
  for (const r of store.rooms) if (r.handle) m.set(r.handle, r);
  return m;
}

// 이 방을 부를 이름 후보들. 앞에 있는 것부터 쓴다.
//
// 폴더명이 1순위지만, 홈 폴더에서 그냥 `claude`를 친 세션이 많아 폴더명이 전부 사용자명으로
// 겹친다. 그런 방까지 폴더명 + 번호로 밀면 @yoochangheon-37 같은 부를 수 없는 이름이 된다
// → 겹치면 방 제목에서 뽑는다.
function handleCandidates(room) {
  const base = slugify(room.name);
  const title = room.aiTitle ? slugify(room.aiTitle).split('-').slice(0, 3).join('-') : '';
  const isHome = base === slugify(path.basename(homeDir()));
  return [...(isHome ? [title] : []), base, title].filter(Boolean);
}

// 호출명이 없는 방에 하나씩 붙인다 (기존 방·새로 합류한 방 모두)
function assignHandles() {
  const taken = new Set(store.rooms.map((r) => r.handle).filter(Boolean));
  let changed = false;
  for (const room of store.rooms) {
    if (room.handle) continue;
    const cands = handleCandidates(room);
    // 후보 중 안 겹치는 첫 번째, 다 겹치면 첫 후보에 번호를 단다
    room.handle = cands.find((c) => !taken.has(c)) || uniqueHandle(cands[0] || 'room', taken);
    taken.add(room.handle);
    changed = true;
  }
  if (changed) store.save();
  return changed;
}

function sysMessage(s, text) {
  s.emit('message', { role: 'system', text, ts: new Date().toISOString() });
}

// 잘라낸 말을 상대 방에 넣는다. 그 방이 꺼져 있으면 --resume으로 알아서 깨어나고,
// 무거우면 선압축이 먼저 걸린다 (engine.send의 기존 경로).
function relayTo(target, fromHandle, body, hops) {
  const s = ensureSession(target);
  s._relayHops = hops;
  s.send(body, [], { peerFrom: fromHandle });
  // 카톡처럼 도착 즉시 알린다 — 그 방을 보고 있지 않으면 온 걸 알 방법이 없다
  if (!roomWinFocused(target.id)) {
    notify(target, `@${fromHandle} → ${truncate(plainify(body), 100)}`);
  }
}

const handleRelays = createRelay({
  maxHops: MAX_RELAY_HOPS,
  handleIndex,
  deliver: relayTo,
  sysMessage,
});

function ensureSession(room) {
  let s = sessions.get(room.id);
  if (s) return s;
  s = new HeadlessSession(room);
  sessions.set(room.id, s);

  s.on('state', (st) => {
    broadcast(room);
    // 세션 종료 시 sdk 마킹 정규화 → 터미널 claude --resume 픽커에도 보이게.
    // 정리할 게 없어도 파일을 통째로 읽는다(이 방은 8.5MB). 유휴 종료가 생기면서 offline
    // 전환이 잦아졌으므로, 마커가 없다고 확인된 파일은 다시 켜질 때까지 건너뛴다.
    if (st === 'offline' && room.sessionId && !s._markersClean) {
      normalizeSdkMarkers(sessionFileFor(room.dir, room.sessionId));
      s._markersClean = true; // 돌린 직후엔 마커가 없다 (다시 켜지면 아래에서 해제)
    }
    if (st === 'starting') {
      s._markersClean = false; // 새 턴이 돌면 sdk 마커가 다시 붙는다
      // 프로세스가 하나 늘었다 → 상한을 넘겼으면 가장 값싸게 내릴 수 있는 방을 내린다.
      // 여기서 걸어야 하는 이유: spawn은 엔진이 send() 안에서 하므로 창을 안 열고 전달
      // (@호출명)로만 깨어나는 방도 있다. 창 닫힘 경로에만 두면 그게 안 세어진다.
      s._lastUsedAt = Date.now();
      enforceLiveCap();
    }
  });
  s.on('session-id', (sid) => {
    // 분기가 확정되면 forkFrom은 역할이 끝난다 (다음 기동은 자기 세션을 resume)
    if (room.forkFrom) delete room.forkFrom;
    // 20초 세션 스캐너가 이 파일을 먼저 발견해 별도 방으로 만들었을 수 있다 →
    // 같은 세션을 가리키는 다른 방은 정리한다. 막기보다 확정 시점에 고치는 쪽이 확실하다
    const dupes = store.rooms.filter((r) => r.id !== room.id && r.sessionId === sid);
    if (dupes.length) {
      store.rooms = store.rooms.filter((r) => !dupes.includes(r));
      for (const d of dupes) {
        if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('room:removed', d.id);
      }
    }
    store.save();
  });
  s.on('activity', () => broadcast(room));
  // 스트리밍 텍스트는 델타가 매우 잦으므로 60ms 스로틀로 방 창에 전달
  let streamPending = null;
  let streamTimer = null;
  s.on('stream-text', (text) => {
    streamPending = text;
    if (streamTimer) return;
    streamTimer = setTimeout(() => {
      streamTimer = null;
      const w = roomWins.get(room.id);
      if (w && !w.isDestroyed()) w.webContents.send('room:stream-text', streamPending);
    }, 60);
  });
  s.on('queue-flushed', () => {
    const w = roomWins.get(room.id);
    if (w && !w.isDestroyed()) w.webContents.send('room:queue-flushed');
  });
  s.on('tasks', (summary) => {
    const w = roomWins.get(room.id);
    if (w && !w.isDestroyed()) w.webContents.send('room:tasks', summary);
  });
  s.on('info', (info) => {
    room.model = info.model;
    if (info.slashCommands.length) {
      room.slashCommands = info.slashCommands;
      globalSlashCommands = info.slashCommands;
    }
    store.save();
    const w = roomWins.get(room.id);
    if (w && !w.isDestroyed()) {
      w.webContents.send('room:info', {
        model: room.model,
        slashCommands: room.slashCommands || [],
        permissionMode: info.permissionMode || s.permissionMode || null,
      });
    }
  });
  s.on('message', (msg) => {
    // 최종 메시지 확정 후 뒤늦게 나가는 스트림 묶음이 유령 버블(커서 잔상)을 만들지 않게 취소
    if (msg.role === 'assistant') {
      clearTimeout(streamTimer);
      streamTimer = null;
      streamPending = null;
    }
    // 알림 본문용으로 마지막 "말"을 따로 들고 있는다.
    // lastPreview는 도구 실행 줄까지 포함하므로(목록에선 그게 유용하다) 알림에 그대로 쓰면
    // "작업 끝났다"는 알림에 🔧 Bash · cat > ... 같은 게 뜬다.
    if (msg.role === 'assistant' && msg.text) s.lastSay = truncate(plainify(msg.text), 120);
    const prefix =
      msg.role === 'tool' ? '🔧 ' : msg.role === 'system' ? '⚠️ ' : msg.role === 'peer' ? `@${msg.from} · ` : '';
    const imgTag = msg.images?.length ? `📷 사진${msg.images.length > 1 ? ` ${msg.images.length}장` : ''} ` : '';
    room.lastPreview = prefix + imgTag + truncate(msg.text, 60);
    room.lastTime = msg.ts;
    store.save();
    if (msg.role !== 'user' && !roomWinFocused(room.id)) {
      unread.set(room.id, (unread.get(room.id) || 0) + 1);
      refreshBadge();
    }
    const w = roomWins.get(room.id);
    if (w && !w.isDestroyed()) w.webContents.send('room:message', msg);
    broadcast(room);
    // 답변에 @호출명이 있으면 그 부분을 상대 방으로 넘긴다. 말풍선을 먼저 보낸 뒤에
    // 호출해야 "↗ 전달했어요" 줄이 그 아래에 붙는다.
    if (msg.role === 'assistant' && msg.text) handleRelays(room, s, msg.text);
  });
  s.on('turn-end', () => {
    // 첫 턴들이 끝난 뒤 ai-title이 생겼을 수 있음 (생성이 비동기라 약간 늦게 확인)
    if (!room.aiTitle && room.sessionId) {
      setTimeout(() => {
        const title = titleForFile(sessionFileFor(room.dir, room.sessionId));
        if (title && !room.aiTitle) {
          room.aiTitle = title;
          store.save();
          broadcast(room);
        }
      }, 4000);
    }
    broadcast(room);
    // 그 방 창을 보고 있으면 알릴 필요가 없다. 다른 앱에 있거나 창이 뒤에 있을 때만.
    if (!roomWinFocused(room.id)) {
      notify(room, s.lastSay || '응답이 끝났어요. 입력을 기다리는 중.');
    }
  });
  return s;
}

// ---------- 할당량 조회 (/usage 헤드리스 프로브, 토큰 소모 없음) ----------

let quota = null; // { session: %, week: %, weekModel: %, fetchedAt }

function broadcastQuota() {
  for (const w of roomWins.values()) {
    if (!w.isDestroyed()) w.webContents.send('room:quota', quota);
  }
}

// 쿼터 프로브 전용 디렉토리 — 여기서 생긴 세션은 방이 아니므로 합류·보존 대상이 아님
function quotaProbeDir() {
  return path.join(app.getPath('userData'), 'quota-probe');
}

// 프로브 세션 transcript 청소. 프로브 성공/실패와 무관하게 자식 종료 시 항상 호출
function cleanProbeSessions() {
  try {
    const enc = quotaProbeDir().normalize('NFC').replace(/[^a-zA-Z0-9-]/g, '-');
    const pdir = path.join(homeDir(), '.claude', 'projects', enc);
    for (const f of fs.readdirSync(pdir)) {
      const fp = path.join(pdir, f);
      if (fs.statSync(fp).isFile()) fs.unlinkSync(fp);
    }
  } catch {}
}

function refreshQuota() {
  // 프로브는 claude를 통째로 띄우고 그때마다 MCP 서버까지 딸려 올라온다. 표시할 창이
  // 없으면 그 비용을 낼 이유가 없다 — 창을 열 때 room:init이 최신 값을 다시 받아간다.
  if (!anyWindowVisible()) return;
  const probeDir = quotaProbeDir();
  fs.mkdirSync(probeDir, { recursive: true });
  const env = claudeEnv();
  const c = spawnShell('claude -p --input-format stream-json --output-format stream-json --verbose', {
    cwd: probeDir,
    env,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  // 프로브가 먼저 죽은 뒤 stdin 쓰기 완료 콜백에서 EPIPE — 핸들러 없으면 메인 프로세스가 통째로 죽음
  c.stdin.on('error', () => {});
  c.on('error', () => {});
  readline.createInterface({ input: c.stdout }).on('line', (line) => {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.type !== 'result') return;
    const text = String(ev.result || '');
    const session = text.match(/Current session:\s*(\d+)%/)?.[1];
    const week = text.match(/Current week \(all models\):\s*(\d+)%/)?.[1];
    if (session || week) {
      quota = {
        session: session ? Number(session) : null,
        week: week ? Number(week) : null,
        fetchedAt: Date.now(),
      };
      broadcastQuota();
    }
    c.stdin.end();
    setTimeout(() => {
      try { c.kill(); } catch {}
    }, 1000);
  });
  // 성공이든 실패든 프로브 잔해는 항상 청소 — result 핸들러 안에만 두면 실패 시 잔해가 남아
  // 20초 세션 스캐너가 그걸 방으로 합류시키는 레이스가 생김
  c.on('exit', () => setTimeout(cleanProbeSessions, 500));
  c.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '/usage' }] } }) + '\n');
  setTimeout(() => { try { c.kill(); } catch {} }, 60000); // 안전망
}

// ---------- 창 크기·위치 기억 (카톡처럼 방마다) ----------

const DEFAULT_SIZE = { width: 380, height: 760 };
let winState = { main: null, rooms: {}, theme: 'dark' };
let winStateFile = null;
let winStateTimer = null;

function loadWinState() {
  winStateFile = path.join(app.getPath('userData'), 'window-state.json');
  try {
    const data = JSON.parse(fs.readFileSync(winStateFile, 'utf8'));
    winState = { main: data.main || null, rooms: data.rooms || {}, theme: data.theme || 'dark' };
  } catch {}
}

// ---------- 테마 (다크/라이트) ----------

ipcMain.handle('theme:get', () => winState.theme || 'dark');
ipcMain.handle('theme:set', (e, theme) => {
  winState.theme = theme === 'light' ? 'light' : 'dark';
  saveWinState();
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    w.webContents.send('theme-changed', winState.theme);
    applyTitleBarTheme(w, winState.theme); // Windows 오버레이 버튼 색도 같이 (mac/linux는 no-op)
  }
});

function saveWinState() {
  clearTimeout(winStateTimer);
  winStateTimer = setTimeout(() => {
    try {
      fs.writeFileSync(winStateFile, JSON.stringify(winState, null, 2));
    } catch {}
  }, 300);
}

function trackBounds(win, apply) {
  const update = () => {
    if (win.isDestroyed()) return;
    apply(win.getBounds());
    saveWinState();
  };
  win.on('resize', update);
  win.on('move', update);
}

function createMainWindow() {
  const saved = winState.main;
  mainWin = new BrowserWindow({
    width: saved?.width || DEFAULT_SIZE.width,
    height: saved?.height || DEFAULT_SIZE.height,
    x: saved?.x,
    y: saved?.y,
    minWidth: 320,
    minHeight: 480,
    ...titleBarOptions(winState.theme),
    backgroundColor: '#17181c',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  mainWin.loadFile(path.join(__dirname, 'renderer', 'list.html'));
  trackBounds(mainWin, (b) => (winState.main = b));
  mainWin.on('closed', () => {
    mainWin = null;
    app.quit(); // 메인(목록) 창을 닫으면 앱 종료
  });
}

// 창을 닫아도 claude 자식 프로세스는 그대로 남아 있었다. 큰 방 하나가 500~700MB를 잡고,
// 방을 여러 개 열어두면 그게 누적돼 발열·메모리로 돌아온다. 세션 객체는 그대로 두고
// (컨텍스트·할 일·히스토리 유지) 프로세스만 내린다 — 다시 열면 --resume으로 이어진다.
//
// 유예를 5분에서 2시간으로 늘렸다. 프로세스를 내리는 값이 생각보다 훨씬 컸기 때문이다:
// resume은 대화 본문을 캐시에서 읽지 못하고 통째로 다시 쓴다. 실험(claude -p로 같은 세션을
// 몇 초 간격으로 재개)에서 cache_read가 16,035에 고정된 채 나머지가 매번 cache_creation으로
// 잡혔다 — 캐시에서 살아 오는 건 시스템 프롬프트뿐이다. 게다가 이 캐시는 1시간 TTL이라
// 쓰기 값이 정가의 2배다. 즉 300k 방을 한 번 내리면 다음 메시지 하나가 600k를 문다.
// 실측으로 이 재작성이 216회, 전체 입력 비용의 25%였다.
//
// 유예만 늘리면 메모리가 터지므로 개수 상한(MAX_LIVE_SESSIONS)으로 대신 묶는다.
const IDLE_KILL_MS = 2 * 60 * 60 * 1000;

// 유예가 끝났는데 턴이 도는 중이라 못 내린 경우 다시 확인하는 간격
const IDLE_RECHECK_MS = 60 * 1000;

// 동시에 살려둘 claude 프로세스 수. 실측 130~270MB(큰 방은 500~700MB)라 4개면 최대 1~2GB다.
const MAX_LIVE_SESSIONS = 4;

const idleKillTimers = new Map();

function cancelIdleKill(roomId) {
  const t = idleKillTimers.get(roomId);
  if (t) {
    clearTimeout(t);
    idleKillTimers.delete(roomId);
  }
}

// 프로세스를 내려도 되는 방인가. 보이는 창이 있으면(=지금 쓰는 중) 안 되고, 턴이 도는 중이면
// 안 된다 — 창을 닫아도 턴은 계속 돌고 사용자는 알림으로 완료를 받는 사용 방식이다.
function killableSession(roomId) {
  const w = roomWins.get(roomId);
  if (w && !w.isDestroyed() && w.isVisible()) return false;
  const s = sessions.get(roomId);
  if (!s || !s.child) return false;
  return s.state !== 'working' && s.state !== 'starting';
}

// 살아있는 프로세스를 MAX_LIVE_SESSIONS개로 묶는다.
//
// 어느 걸 내릴지는 "다시 깨울 때 물 값 ÷ 방치된 시간"으로 고른다. 깨우는 값은 컨텍스트에
// 정비례하고(위 주석), 다시 올 확률은 최근에 썼는지에 달렸으니 — 크고 방금 쓴 방은 남기고
// 작고 오래 안 쓴 방을 먼저 내린다. 단순 LRU로 하면 30k짜리를 살려두고 500k짜리를 내려
// 정확히 반대로 움직인다.
function enforceLiveCap() {
  const live = [...sessions.entries()].filter(([, s]) => s.child);
  let over = live.length - MAX_LIVE_SESSIONS;
  if (over <= 0) return;
  const now = Date.now();
  const cands = live
    .filter(([id]) => killableSession(id))
    .map(([id, s]) => ({
      id,
      s,
      // 컨텍스트를 아직 모르는 방(0)은 깨우는 값도 작으니 먼저 내려도 된다 → 1로 둔다
      score: (s.contextTokens || 1) / Math.max(1, (now - (s._lastUsedAt || 0)) / 60000),
    }))
    .sort((a, b) => a.score - b.score);
  for (const c of cands) {
    if (over <= 0) break;
    cancelIdleKill(c.id);
    c.s.kill();
    over--;
  }
}

function scheduleIdleKill(roomId, delay = IDLE_KILL_MS) {
  cancelIdleKill(roomId);
  // 치워둔 시점을 방치 시간의 기준으로 삼는다 (enforceLiveCap의 분모).
  // 재시도(delay가 짧은 경우)에는 건드리지 않는다 — 그건 새로 쓴 게 아니다.
  if (delay === IDLE_KILL_MS) {
    const s0 = sessions.get(roomId);
    if (s0) s0._lastUsedAt = Date.now();
    // 이 방이 물러났으니 상한을 넘긴 게 있으면 지금 정리한다
    enforceLiveCap();
  }
  const t = setTimeout(() => {
    idleKillTimers.delete(roomId);
    // 그새 다시 열었거나 턴이 도는 중이면 그만둔다. 숨김도 대상이므로 보이는지로 판단한다.
    if (!killableSession(roomId)) {
      const s = sessions.get(roomId);
      // 턴이 도는 중이라 못 내린 경우만 다시 재운다. 유예를 처음부터 다시 주면 2시간을 더
      // 기다리게 되므로 턴이 끝나는지만 짧게 확인한다. (창을 다시 연 경우는 열 때 취소된다)
      if (s?.child && (s.state === 'working' || s.state === 'starting')) {
        scheduleIdleKill(roomId, IDLE_RECHECK_MS);
      }
      return;
    }
    sessions.get(roomId).kill();
  }, delay);
  t.unref?.();
  idleKillTimers.set(roomId, t);
}

// "지금 이 방을 썼다"고 표시. enforceLiveCap이 무엇을 내릴지 고를 때의 분모가 된다.
function touchSession(roomId) {
  const s = sessions.get(roomId);
  if (s) s._lastUsedAt = Date.now();
}

function openRoomWindow(roomId) {
  cancelIdleKill(roomId);
  touchSession(roomId);
  const existing = roomWins.get(roomId);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore(); // 최소화 상태면 show()만으론 안 올라온다
    existing.show();
    existing.focus();
    return;
  }
  const room = store.get(roomId);
  if (!room) return;

  // 방별 저장 크기 → 없으면 목록 창 크기와 동일 (카톡 기본 동작)
  const saved = winState.rooms[roomId];
  const listBounds = mainWin && !mainWin.isDestroyed() ? mainWin.getBounds() : null;
  const w = new BrowserWindow({
    width: saved?.width || listBounds?.width || DEFAULT_SIZE.width,
    height: saved?.height || listBounds?.height || DEFAULT_SIZE.height,
    x: saved?.x,
    y: saved?.y,
    minWidth: 320,
    minHeight: 420,
    ...titleBarOptions(winState.theme),
    backgroundColor: '#1e1f22',
    title: room.name,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  roomWins.set(roomId, w);
  // 마크다운 링크가 새 창을 열거나 창 안에서 이동하지 않게 (렌더러에서 openExternal로 처리)
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (ev) => ev.preventDefault());
  w.loadFile(path.join(__dirname, 'renderer', 'room.html'), { query: { id: roomId } });
  trackBounds(w, (b) => (winState.rooms[roomId] = b));
  w.on('focus', () => {
    cancelIdleKill(roomId);
    touchSession(roomId);
    unread.set(roomId, 0);
    refreshBadge();
    broadcast(room);
  });
  w.on('show', () => cancelIdleKill(roomId));
  w.on('closed', () => {
    roomWins.delete(roomId);
    scheduleIdleKill(roomId);
  });
}

// 방이 될 수 없는 위치인가.
//
// 20초 스캐너는 ~/.claude/projects 아래 전부를 방으로 합류시킨다. 그래서 임시 폴더에서
// claude를 잠깐 돌리기만 해도(디버깅·프로브·테스트) 목록에 쓰레기 방이 남았다. 예전엔
// 쿼터 프로브 디렉토리 하나만 걸렀는데, 임시 폴더 전반을 걸러야 같은 일이 안 반복된다.
function transientRoots() {
  if (transientRoots._cache) return transientRoots._cache;
  const roots = [quotaProbeDir(), app.getPath('userData'), os.tmpdir(), '/tmp', '/private/tmp'];
  const out = new Set();
  for (const r of roots) {
    if (!r) continue;
    out.add(path.resolve(r));
    // macOS의 /tmp는 /private/tmp 심볼릭 링크다 — 양쪽 표기를 다 담아야 걸러진다
    try {
      out.add(fs.realpathSync(r));
    } catch {}
  }
  return (transientRoots._cache = [...out]);
}

function isTransientDir(dir) {
  if (!dir) return true;
  const d = path.resolve(dir);
  return transientRoots().some((root) => d === root || d.startsWith(root + path.sep));
}

// 필터가 생기기 전에 이미 합류해 버린 임시 폴더 방들을 시작할 때 한 번 걷어낸다.
//
// 방을 지우는 건 되돌릴 수 없으니 조건을 좁게 잡는다: 임시 폴더 안이면서, 그 폴더가 이미
// 사라진 것만. 둘 다 만족하면 사용자가 만든 방일 수 없다. 대화 기록 파일은 건드리지 않고
// 목록에서만 뺀다 — 판단이 틀렸더라도 원본은 남아 다시 합류시킬 수 있다.
function pruneTransientRooms() {
  const junk = store.rooms.filter((r) => isTransientDir(r.dir) && !fs.existsSync(r.dir));
  if (!junk.length) return 0;
  const ids = new Set(junk.map((r) => r.id));
  store.rooms = store.rooms.filter((r) => !ids.has(r.id));
  for (const r of junk) {
    sessions.get(r.id)?.kill();
    sessions.delete(r.id);
    unread.delete(r.id);
    delete winState.rooms[r.id];
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('room:removed', r.id);
    console.log('[cc-talk] 임시 폴더 방 정리:', r.aiTitle || r.name, '—', r.dir);
  }
  store.save();
  refreshBadge();
  return junk.length;
}

// 과거 세션(터미널에서 하던 대화 포함)을 방으로 합류 — 삭제(무시)했거나 이미 있는 건 제외
function importPastSessions() {
  if (!anyWindowVisible()) return; // 새 방을 합류시켜도 볼 사람이 없다 — 창을 열 때 따라잡는다
  const exclude = new Set([
    ...store.rooms.map((r) => r.sessionId).filter(Boolean),
    ...store.ignoredSessions,
  ]);
  const found = scanPastSessions({ excludeSessionIds: exclude }).filter((sess) => {
    if (isTransientDir(sess.dir)) return false;
    // 폴더가 이미 없는 세션을 새로 방으로 만들면 열자마자 "폴더를 찾을 수 없습니다"인 방이
    // 된다. 기존 방은 건드리지 않는다 — 외장 디스크처럼 잠깐 빠졌을 수 있다.
    if (!fs.existsSync(sess.dir)) return false;
    return true;
  });
  for (const sess of found) {
    const room = {
      id: crypto.randomUUID(),
      dir: sess.dir,
      name: sess.name,
      aiTitle: sess.aiTitle,
      sessionId: sess.sessionId,
      lastPreview: sess.preview,
      lastTime: sess.time,
    };
    store.rooms.push(room);
  }
  if (found.length) {
    assignHandles(); // 새로 합류한 방에도 @호출명을 붙인 뒤에 알린다
    for (const sess of found) {
      const room = store.rooms.find((r) => r.sessionId === sess.sessionId);
      if (room) broadcast(room);
    }
    store.save();
  }
  return found.length;
}

// 아직 제목이 없는 방들의 ai-title 갱신 (제목은 첫 턴 이후 비동기 생성됨)
function refreshTitles() {
  let changed = false;
  for (const room of store.rooms) {
    if (room.aiTitle || !room.sessionId) continue;
    const title = titleForFile(sessionFileFor(room.dir, room.sessionId));
    if (title) {
      room.aiTitle = title;
      changed = true;
      broadcast(room);
    }
  }
  if (changed) store.save();
}

// 터미널에서 이어간 대화도 목록에 실시간 반영: 방 파일의 mtime을 폴링해
// 변하면 미리보기·시간·제목 갱신 (앱 엔진이 살아있는 방은 엔진 이벤트가 담당)
const fileMtimes = new Map(); // roomId → mtimeMs
// 보이는 창이 하나도 없으면 아무도 결과를 못 본다 — 그 동안 4초마다 65개 방을 stat하고
// 8MB짜리 세션 파일을 다시 파싱할 이유가 없다. 창을 다시 열면 그때 최신 상태로 그린다.
function anyWindowVisible() {
  if (mainWin && !mainWin.isDestroyed() && mainWin.isVisible()) return true;
  for (const w of roomWins.values()) if (!w.isDestroyed() && w.isVisible()) return true;
  return false;
}

function pollFileChanges() {
  if (!anyWindowVisible()) return;
  for (const room of store.rooms) {
    if (!room.sessionId) continue;
    const fp = sessionFileFor(room.dir, room.sessionId);
    let st;
    try {
      st = fs.statSync(fp);
    } catch {
      continue;
    }
    const prev = fileMtimes.get(room.id);
    fileMtimes.set(room.id, st.mtimeMs);
    // 실행 중 변경(prev 대비) + 앱이 꺼져 있던 동안의 변경(방이 기억하는 마지막 시각 대비) 모두 감지
    const lastMs = Date.parse(room.lastTime || 0) || 0;
    const changed =
      prev !== undefined ? st.mtimeMs > prev : st.mtimeMs > lastMs + 2000;
    if (!changed) continue;
    const live = sessions.get(room.id);
    if (live && live.child) continue; // 앱이 스폰한 세션이 살아있으면 스킵

    const tail = tailInfoForFile(fp);
    if (tail.preview) {
      room.lastPreview = tail.preview;
      room.lastTime = tail.ts || new Date(st.mtimeMs).toISOString();
    }
    if (!room.aiTitle) room.aiTitle = titleForFile(fp);
    store.save();
    broadcast(room);
    // 그 방 창이 열려 있으면 내용도 다시 그리기
    const w = roomWins.get(room.id);
    if (w && !w.isDestroyed()) {
      // 터미널에서 이어간 대화에도 할 일 변경이 섞여 있을 수 있으므로 같이 다시 접는다
      const items = parseFileSync(fp);
      const s = sessions.get(room.id);
      if (s) {
        s.tasks = foldTaskOps(items.filter((i) => i.kind === 'task-op'));
        w.webContents.send('room:tasks', taskSummary(s.tasks));
      }
      w.webContents.send('room:history-reset', items.filter((i) => i.kind === 'msg'));
    }
  }
}

// CLI 진입점(`claude-talk`)이 넘겨주는 작업 폴더. 개발 실행은 argv에 스크립트 경로가
// 하나 더 끼므로 위치 대신 접두사로 찾는다.
function dirArg(argv) {
  const hit = (argv || []).find((a) => a.startsWith('--dir='));
  if (!hit) return null;
  const dir = hit.slice('--dir='.length);
  try {
    return fs.statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

// 두 번 실행되면 rooms.json/window-state.json을 두 프로세스가 같이 쓰다 깨진다.
// (Windows는 포터블 exe·바로가기 더블클릭으로 중복 실행이 쉽게 난다)
// 겸사겸사 여기가 CLI 재진입 통로다 — 앱이 이미 떠 있을 때 `claude-talk`을 치면
// 두 번째 프로세스는 즉시 죽고 argv만 원본 프로세스로 넘어온다.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (e, argv) => {
    const dir = dirArg(argv);
    if (dir && store) {
      createRoomForDir(dir);
      return;
    }
    if (!mainWin || mainWin.isDestroyed()) return;
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show();
    mainWin.focus();
  });
}

// Windows 토스트 알림은 AppUserModelID가 설치본 것과 맞아야 뜬다 (없으면 조용히 무시됨)
if (isWin) app.setAppUserModelId('com.dbckdgjs369.cctalk');

// ---------- 에러 보고 ----------

// 예외 하나로 앱이 내려가는 건 막되, 조용히 삼키지도 않는다.
// 핵심은 중복 제거다 — 4초마다 도는 pollFileChanges에서 같은 에러가 계속 터지면
// 다이얼로그가 무한히 쌓여 창을 닫아도 이길 수 없다 (실제로 겪음).
// 같은 에러는 한 번만 띄우고, 총 3회를 넘으면 콘솔에만 남긴다.
const seenErrors = new Set();
const MAX_ERROR_DIALOGS = 3;
let errorDialogsShown = 0;

function reportError(title, err) {
  const detail = err?.stack || String(err);
  console.error(`[${title}]`, detail);

  const sig = title + '|' + detail.slice(0, 300);
  if (seenErrors.has(sig)) return; // 같은 에러 반복 — 이미 알렸다
  seenErrors.add(sig);
  if (errorDialogsShown >= MAX_ERROR_DIALOGS || !app.isReady()) return;
  errorDialogsShown++;

  const last = errorDialogsShown === MAX_ERROR_DIALOGS;
  dialog
    .showMessageBox({
      type: 'error',
      title,
      message: title,
      detail: detail.slice(0, 1200) + (last ? '\n\n(이후 오류는 콘솔에만 기록됩니다)' : ''),
      buttons: ['확인'],
      noLink: true,
    })
    .catch(() => {}); // 다이얼로그 실패가 또 예외를 던지지 않게
}

// 타이머·이벤트 콜백에서 새는 예외는 Electron 기본 동작으로는
// "A JavaScript error occurred in the main process" + 앱 종료로 이어진다.
// 방 하나가 삐끗했다고 창 전체가 내려갈 이유는 없다.
process.on('uncaughtException', (err) => reportError('예상치 못한 오류', err));
process.on('unhandledRejection', (err) => reportError('처리되지 않은 오류', err));

app.whenReady().then(() => {
  // 패키징된 앱은 .icns를 쓰지만, 개발 실행(npm start)은 Electron 기본 아이콘이라 직접 지정
  if (!app.isPackaged && isMac) {
    const icon = path.join(__dirname, 'build', 'icon.png');
    if (fs.existsSync(icon)) app.dock.setIcon(icon);
  }
  loadWinState();
  store = new RoomsStore(app.getPath('userData'), (err) => reportError('방 목록 저장 실패', err));
  // 과거 레이스로 잘못 합류된 quota-probe 방 제거 (세션 파일이 이미 지워져 살릴 수 없는 좀비 방)
  const probeRooms = store.rooms.filter((r) => r.dir === quotaProbeDir());
  if (probeRooms.length) {
    for (const r of probeRooms) if (r.sessionId) store.ignoredSessions.add(r.sessionId);
    store.rooms = store.rooms.filter((r) => r.dir !== quotaProbeDir());
    store.save();
  }
  assignHandles(); // 목록이 그려지기 전에 @호출명을 채워둔다
  const seeded = store.rooms.find((r) => r.slashCommands?.length);
  if (seeded) globalSlashCommands = seeded.slashCommands;
  createMainWindow();
  // `claude-talk`으로 켠 경우: 목록 창은 띄워두고 해당 폴더 방을 바로 연다
  const cliDir = dirArg(process.argv);
  if (cliDir) createRoomForDir(cliDir);
  // Windows에선 claude가 PATH에 없어 방마다 조용히 실패하는 일이 흔하다 → 처음에 한 번 명확히 알린다
  if (isWin && !findClaude()) {
    dialog.showMessageBox(mainWin, {
      type: 'warning',
      title: 'Claude Code CLI를 찾을 수 없습니다',
      message: 'Claude Code CLI가 설치돼 있지 않거나 PATH에 없습니다.',
      detail: CLAUDE_MISSING_HINT,
      buttons: ['확인'],
    });
  }
  // 창 뜬 뒤 백그라운드로 과거 세션 합류 + 기존 방 제목 갱신 + sdk 마킹 정규화
  setTimeout(() => {
    pruneTransientRooms();
    importPastSessions();
    refreshTitles();
    for (const room of store.rooms) {
      if (!room.sessionId || sessions.get(room.id)?.child) continue;
      normalizeSdkMarkers(sessionFileFor(room.dir, room.sessionId));
    }
  }, 500);
  setInterval(pollFileChanges, 4000); // 터미널 활동 반영
  setInterval(importPastSessions, 20000); // 새 세션 실시간 합류
  setTimeout(refreshQuota, 3000); // 할당량 초기 조회
  setInterval(refreshQuota, 10 * 60 * 1000); // 10분마다 갱신
});

// Dock 아이콘 클릭 → 숨겨둔 목록 창 복귀
app.on('activate', () => {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.show();
    mainWin.focus();
  }
});

app.on('window-all-closed', () => {
  for (const s of sessions.values()) s.kill();
  app.quit();
});
app.on('quit', () => {
  for (const s of sessions.values()) s.kill();
});

// ---------- IPC: 목록 창 ----------

ipcMain.handle('rooms:list', () => store.rooms.map(roomSummary));

// 폴더로 새 방을 만들어 연다. 같은 폴더에 방이 이미 있어도 새로 만든다 —
// 터미널에서 `claude`를 다시 치면 새 세션이 열리는 것과 같다. 한 프로젝트에서
// 여러 세션을 병렬로 굴리는 게 정상 사용 패턴이므로 폴더로 묶지 않는다.
// (dialog 선택과 CLI `claude-talk` 양쪽이 같이 쓴다)
function createRoomForDir(dir) {
  const room = store.add({
    id: crypto.randomUUID(),
    dir,
    name: path.basename(dir).normalize('NFC'), // macOS 폴더명은 NFD라 정규화
    sessionId: null,
    lastPreview: '',
    lastTime: null,
  });
  assignHandles();
  openRoomWindow(room.id);
  return room;
}

ipcMain.handle('rooms:create', async () => {
  const res = await dialog.showOpenDialog(mainWin, {
    title: '채팅방 열 프로젝트 폴더 선택',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  return roomSummary(createRoomForDir(res.filePaths[0]));
});

ipcMain.handle('room:openWindow', (e, id) => openRoomWindow(id));

// 방 분기 — 원본을 그대로 두고 대화를 물려받은 새 방을 만든다.
// 실제 세션 복사는 첫 턴에 `--resume <원본> --fork-session`으로 일어나므로 여기서는 표시만 해둔다.
ipcMain.handle('room:fork', (e, id) => {
  const src = store.get(id);
  if (!src) return null;
  if (!src.sessionId) return { error: '아직 대화가 없는 방은 분기할 수 없어요.' };

  // 분기선을 그을 지점 = 지금까지의 메시지 개수
  const inherited = ensureSession(src).history().length;
  const room = store.add({
    id: crypto.randomUUID(),
    dir: src.dir,
    name: src.name,
    aiTitle: src.aiTitle ? src.aiTitle + ' (분기)' : null,
    sessionId: null,
    forkFrom: src.sessionId,
    forkedFrom: src.id,
    forkedAt: inherited,
    lastPreview: src.lastPreview,
    lastTime: new Date().toISOString(),
  });
  assignHandles();
  openRoomWindow(room.id);
  return roomSummary(room);
});

// ---------- 사진 뷰어 창 ----------

const viewerData = new Map(); // key → dataUrl
let viewerSeq = 0;

ipcMain.handle('image:openViewer', (e, dataUrl) => {
  const key = 'v' + ++viewerSeq;
  viewerData.set(key, dataUrl);
  const w = new BrowserWindow({
    width: 860,
    height: 700,
    minWidth: 320,
    minHeight: 280,
    ...titleBarOptions(winState.theme),
    backgroundColor: '#0b0b0d',
    title: '사진',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  w.loadFile(path.join(__dirname, 'renderer', 'viewer.html'), { query: { k: key } });
  w.on('closed', () => viewerData.delete(key));
});

ipcMain.handle('image:get', (e, key) => viewerData.get(key) || null);

ipcMain.handle('image:save', async (e, key) => {
  const dataUrl = viewerData.get(key);
  if (!dataUrl) return null;
  const ext = (dataUrl.match(/^data:image\/(\w+);/) || [])[1] || 'png';
  const res = await dialog.showSaveDialog({
    defaultPath: `image-${Date.now()}.${ext === 'jpeg' ? 'jpg' : ext}`,
  });
  if (res.canceled || !res.filePath) return null;
  fs.writeFileSync(res.filePath, Buffer.from(dataUrl.split(',')[1], 'base64'));
  return res.filePath;
});

ipcMain.handle('room:rename', (e, id, newName) => {
  const room = store.get(id);
  if (!room || !newName?.trim()) return false;
  const title = newName.trim();
  room.aiTitle = title;
  store.save();
  // Claude Code와 동일한 방식으로 파일에도 기록 → 터미널 픽커에도 반영
  if (room.sessionId) renameSession(room.dir, room.sessionId, title);
  broadcast(room);
  return true;
});

// ESC: 목록 창 숨김 (Dock 클릭으로 복귀)
ipcMain.handle('main:hide', () => {
  if (mainWin && !mainWin.isDestroyed()) mainWin.hide();
});

ipcMain.handle('rooms:delete', (e, id) => {
  const room = store.get(id);
  const s = sessions.get(id);
  if (s) s.kill();
  sessions.delete(id);
  unread.delete(id);
  refreshBadge();
  const w = roomWins.get(id);
  if (w && !w.isDestroyed()) w.close();
  // 그 방의 대화 기록 파일도 완전 삭제 (1 파일 = 1 방)
  if (room?.sessionId) deleteSessionFile(room.dir, room.sessionId);
  delete winState.rooms[id];
  saveWinState();
  store.remove(id);
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('room:removed', id);
});

// ---------- IPC: 채팅방 창 ----------

ipcMain.handle('room:init', (e, id) => {
  const room = store.get(id);
  if (!room) return null;
  unread.set(id, 0);
  refreshBadge();
  // 창이 다 닫혀 있는 동안엔 프로브를 안 돌린다 → 값이 낡았을 수 있으니 여기서 따라잡는다
  if (!quota || Date.now() - quota.fetchedAt > 10 * 60 * 1000) setTimeout(refreshQuota, 0);
  const s = ensureSession(room);
  const messages = s.history();
  broadcast(room);
  return {
    room: roomSummary(room),
    messages,
    tasks: taskSummary(s.tasks), // history()가 세션 전체를 접어 채워둔 상태
    forkedAt: room.forkedAt || 0, // 앞 N개는 물려받은 대화 — 접어서 보여준다
    info: {
      model: room.model || null,
      slashCommands: room.slashCommands || globalSlashCommands,
      // 방에서 고른 게 없으면 세션이 알려준 실효 모드(= 전역 설정)를 보여준다
      permissionMode: room.permissionMode || s.permissionMode || null,
    },
    quota,
  };
});

ipcMain.handle('room:send', (e, id, text, images) => {
  const room = store.get(id);
  if (!room) return;
  const s = ensureSession(room);
  // 사용자가 말을 걸면 전달 체인이 새로 시작된다 (홉 상한 리셋)
  s._relayHops = 0;
  s._lastUsedAt = Date.now(); // 창을 안 열고 보낼 수도 있다 — 여기서도 최근 사용으로 표시

  // 사용자의 @프론트는 "프론트한테 물어봐"라고 이 방에 시키는 말이다 — 프론트로 전달되지
  // 않는다. 대신 claude가 전달 방법을 알아야 하니 그 턴에만 규칙을 stdin에 덧붙인다.
  const others = store.rooms.filter((r) => r.id !== room.id).map((r) => r.handle).filter(Boolean);
  const mentioned = findMentions(text, others);
  const opts = mentioned.length ? { wireSuffix: relayRule(mentioned) } : {};
  s.send(text, images || [], opts);

  // 오타를 조용히 삼키면 "보냈는데 안 갔다"가 된다. 내 말풍선 바로 아래에 알려준다.
  if (!mentioned.length) {
    const unknown = unknownMentions(text, others);
    if (unknown.length) {
      const list = others.slice(0, 12).map((h) => '@' + h).join(', ');
      sysMessage(
        s,
        `@${unknown[0]} 이라는 방이 없어요.` + (list ? ` 쓸 수 있는 이름: ${list}${others.length > 12 ? ' …' : ''}` : '')
      );
    }
  }
});

// 대기줄에서 아직 안 나간 말 취소. 방이 꺼져 있으면 대기줄도 없다(-1).
ipcMain.handle('room:cancel-pending', (e, id, index, text) => {
  const s = sessions.get(id);
  return s ? s.cancelQueued(index, text) : -1;
});

// @자동완성용 방 목록 (자기 방은 제외)
ipcMain.handle('rooms:handles', (e, exceptId) =>
  store.rooms
    .filter((r) => r.handle && r.id !== exceptId)
    .map((r) => ({ handle: r.handle, title: r.aiTitle || r.name, name: r.name }))
    .sort((a, b) => a.handle.localeCompare(b.handle))
);

// 말풍선의 이름표를 누르면 그 방을 연다
ipcMain.handle('room:openByHandle', (e, handle) => {
  const room = handleIndex().get(handle);
  if (room) openRoomWindow(room.id);
  return !!room;
});

ipcMain.handle('room:setHandle', (e, id, raw) => {
  const room = store.get(id);
  if (!room) return null;
  const want = slugify(raw);
  const taken = store.rooms.filter((r) => r.id !== id).map((r) => r.handle);
  if (taken.includes(want)) return { error: `@${want} 는 이미 다른 방이 쓰고 있어요.` };
  room.handle = want;
  store.save();
  broadcast(room);
  return { handle: want };
});

ipcMain.handle('room:kill', (e, id) => {
  const s = sessions.get(id);
  if (s) s.kill();
});

// ---------- 폰에서 사진 넣기 (같은 Wi-Fi, QR) ----------

const uploader = new UploadServer();
uploader.onPhoto = (roomId, photo) => {
  const w = roomWins.get(roomId);
  if (!w || w.isDestroyed()) return;
  w.webContents.send('room:photo', photo);
  w.show(); // 폰에서 보냈으면 맥 화면에서 바로 보이는 게 자연스럽다
};

ipcMain.handle('room:uploadUrl', async (e, id) => {
  if (!store.get(id)) return null;
  try {
    await uploader.start();
    const token = uploader.issue(id);
    const url = uploader.urlFor(token);
    if (!url) return { error: 'Wi-Fi에 연결돼 있지 않아요. 같은 네트워크가 필요합니다.' };
    return { url, token, qr: await QRCode.toDataURL(url, { margin: 1, width: 260 }) };
  } catch (err) {
    return { error: `업로드 서버를 열 수 없어요 (${err.code || err.message})` };
  }
});

ipcMain.handle('room:uploadDone', (e, token) => uploader.revoke(token));

app.on('quit', () => uploader.stop());

const PERMISSION_MODES = ['bypassPermissions', 'acceptEdits', 'plan'];

ipcMain.handle('room:setPermissionMode', (e, id, mode) => {
  const room = store.get(id);
  if (!room || !PERMISSION_MODES.includes(mode)) return null;
  ensureSession(room).setPermissionMode(mode);
  store.save();
  return mode;
});

// 방별 자동 압축 시점. null이면 기본값(AUTO_COMPACT_AT)으로 되돌린다.
// 세션을 새로 띄우지 않는다 — 엔진이 매번 room.compactAt을 읽으므로 켜져 있는 방도 즉시 반영된다.
ipcMain.handle('room:setCompactAt', (e, id, tokens) => {
  const room = store.get(id);
  if (!room) return null;
  if (tokens !== null && !COMPACT_CHOICES.includes(tokens)) return null;
  room.compactAt = tokens || undefined;
  store.save();
  broadcast(room); // 상태줄의 경고 색 기준이 바뀌므로 바로 다시 그린다
  return room.compactAt || null;
});

ipcMain.handle('room:interrupt', (e, id) => {
  const s = sessions.get(id);
  if (s) s.interrupt();
});

// ESC: 창만 숨김 (세션은 백그라운드 유지, 목록에서 클릭하면 다시 표시)
ipcMain.handle('room:hide', (e, id) => {
  const w = roomWins.get(id);
  if (w && !w.isDestroyed()) w.hide();
  // 숨긴 것도 치워둔 것과 같다 — 닫았을 때와 똑같이 유예 후 프로세스를 내린다.
  // (다시 열면 openRoomWindow가 취소한다)
  scheduleIdleKill(id);
});
