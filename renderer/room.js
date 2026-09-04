const { ipcRenderer, webUtils, shell } = require('electron');
const MarkdownIt = require('markdown-it');
const createDOMPurify = require('dompurify');
const DOMPurify = createDOMPurify(window);

// html:false = 원문 HTML 차단(1차 방어), breaks = 채팅답게 한 줄 개행도 줄바꿈
const mdEngine = new MarkdownIt({ html: false, breaks: true, linkify: true });

// assistant 마크다운 → 안전한 HTML (DOMPurify 2차 방어)
function renderMarkdown(text) {
  return DOMPurify.sanitize(mdEngine.render(text));
}

// 링크는 앱 안에서 열지 않고 기본 브라우저로
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute('href');
  if (/^https?:/i.test(href)) shell.openExternal(href);
});

const roomId = new URLSearchParams(window.location.search).get('id');
const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const attachBarEl = document.getElementById('attach-bar');
const jumpBtnEl = document.getElementById('jump-bottom');
const taskPanelEl = document.getElementById('task-panel');
const taskListEl = document.getElementById('task-list');

const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024; // API 이미지 제한(~5MB) 여유분
let pendingImages = []; // {name, mediaType, base64}

let roomState = 'offline';
let roomInfo = { model: null, slashCommands: [] };
let quota = null; // { session: %, week: % }

// ---------- 스크롤 추적 ----------
// Claude가 스트리밍하는 동안 델타마다 맨 아래로 밀면, 위로 올려 이전 내용을 읽던
// 사용자가 계속 끌려 내려간다. 하단에 붙어 있을 때만 따라가고, 올려둔 상태면 가만히 둔다.
const STICK_PX = 80; // 이 정도 여유는 "하단에 있다"로 친다 (한 줄 늘어난 정도)
let stickToBottom = true;

const bottomGap = () => messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;

// 스크롤이 바닥에서 떨어지면 추적 해제, 다시 붙으면 재개.
// 프로그램이 scrollTop을 바꿔도 이 이벤트가 돌지만, 그때는 바닥이라 true로 유지된다.
messagesEl.addEventListener('scroll', () => {
  stickToBottom = bottomGap() <= STICK_PX;
  jumpBtnEl?.classList.toggle('hidden', stickToBottom);
});

function scrollToBottom({ force = false } = {}) {
  // 검색 중에는 결과 위치를 지킨다. 결과가 하필 하단 근처면 stickToBottom이 true로
  // 남아 스트리밍이 화면을 끌어내리기 때문에 플래그만으로는 부족하다
  if (searchOpen && !force) return;
  if (!force && !stickToBottom) return;
  messagesEl.scrollTop = messagesEl.scrollHeight;
  stickToBottom = true;
  jumpBtnEl?.classList.add('hidden');
}

jumpBtnEl.onclick = () => scrollToBottom({ force: true });

// 헤더 여백이 창 버튼 위치를 따라가게 (mac=왼쪽 신호등, Windows=오른쪽 오버레이)
document.body.classList.add(process.platform === 'win32' ? 'win' : 'mac');

// 테마 적용 (목록 창의 토글과 동기화)
(async () => {
  const theme = await ipcRenderer.invoke('theme:get');
  document.body.classList.toggle('light', theme === 'light');
})();
ipcRenderer.on('theme-changed', (e, theme) => {
  document.body.classList.toggle('light', theme === 'light');
});

// 하단 상태바: 폴더 | 모델 | 5h: n% | 7d: n% (터미널 statusline과 동일 포맷)
function updateStatusbar() {
  const parts = [];
  if (lastRoomSummary?.name) parts.push(lastRoomSummary.name);
  const model = shortModelName(roomInfo.model);
  if (model) parts.push(model);
  if (quota?.session != null) parts.push(`5h: ${quota.session}%`);
  if (quota?.week != null) parts.push(`7d: ${quota.week}%`);

  const bar = document.getElementById('statusbar');
  bar.textContent = parts.join(' | ') || 'Claude Code';

  // 컨텍스트 크기는 따로 붙인다 — 턴마다 이만큼을 다시 읽으므로 방이 무거워지는 걸
  // 눈으로 보고 새 방으로 옮길지 판단할 수 있어야 한다
  const ctx = lastRoomSummary?.context || 0;
  if (!ctx) return;
  const el = document.createElement('span');
  el.className = 'ctx-size';
  // 경고 기준은 모델 한도가 아니라 "자동 압축이 걸리는 지점"이다. 한도가 1M이어도
  // 비용은 컨텍스트 크기에 그대로 비례하므로, 한도 대비 %는 비싼 방을 안 비싸 보이게 만든다.
  const limit = lastRoomSummary?.contextLimit || 0;
  const compactAt = lastRoomSummary?.compactAt || 0;
  if (compactAt && ctx >= compactAt * 0.9) el.classList.add('danger'); // 곧 자동 압축
  else if (ctx >= 100000) el.classList.add('warn'); // 턴당 비용이 눈에 띄게 커지는 구간
  el.textContent = ` | 컨텍스트 ${ctx >= 10000 ? Math.round(ctx / 1000) + 'k' : ctx}`;
  el.title =
    `이 방의 현재 대화 크기 ${ctx.toLocaleString()} 토큰\n` +
    `한 번 주고받을 때마다 이만큼을 다시 읽습니다 (도구 호출 하나당 1회)\n` +
    (compactAt ? `${compactAt.toLocaleString()} 토큰을 넘으면 자동으로 압축합니다` : '') +
    (limit ? ` · 모델 한도 ${limit.toLocaleString()}` : '') +
    `\n클릭하면 압축 시점을 바꿀 수 있어요`;
  el.onclick = openCompactPicker; // 압축이 잦다고 느끼는 건 이 숫자를 볼 때다 — 여기서 바로 고치게
  bar.appendChild(el);
}

ipcRenderer.on('room:quota', (e, q) => {
  quota = q;
  updateStatusbar();
});

const MODELS = [
  { alias: 'default', name: '기본값', desc: '계정 기본 설정을 따름' },
  { alias: 'fable', name: 'Fable 5', desc: '가장 어렵고 긴 작업에 최적' },
  { alias: 'opus', name: 'Opus 5', desc: '일상적인 복잡한 작업' },
  { alias: 'sonnet', name: 'Sonnet 5', desc: '루틴한 작업을 효율적으로' },
  { alias: 'haiku', name: 'Haiku 4.5', desc: '빠른 답변이 필요할 때' },
  { alias: 'opus[1m]', name: 'Opus 5 · 1M', desc: '초대형 컨텍스트' },
  { alias: 'fable[1m]', name: 'Fable 5 · 1M', desc: '초대형 컨텍스트' },
  { alias: 'opusplan', name: 'Opus 플랜모드', desc: '계획은 Opus, 실행은 Sonnet' },
];

function modelMatches(alias, modelId) {
  if (!modelId) return false;
  const base = alias.replace('[1m]', '');
  if (base === 'default' || base === 'opusplan') return false;
  return modelId.includes(base) === true && (alias.includes('[1m]') === modelId.includes('[1m]'));
}

const STATE_LABEL = {
  offline: '오프라인 — 메시지를 보내면 세션이 시작돼요',
  starting: '세션 시작 중…',
  working: 'Claude 작업 중',
  waiting: '입력 기다리는 중',
};

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  let h = d.getHours();
  const ampm = h < 12 ? '오전' : '오후';
  h = h % 12 || 12;
  return `${ampm} ${h}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ---------- 대화 검색 (Cmd/Ctrl+F) ----------
// 방을 열면 세션 전체가 DOM에 그려져 있으므로(최대 ~2,700개) DOM만 훑어도 누락이 없다.
// jsonl을 따로 파싱하면 "화면에 없는 결과"를 가리키게 되는 문제가 생겨 그렇게 하지 않았다.
const searchBarEl = document.getElementById('search-bar');
const searchInputEl = document.getElementById('search-input');
const searchCountEl = document.getElementById('search-count');
let searchOpen = false;
let searchHits = []; // <mark> 엘리먼트들 (문서 순서)
let searchIdx = -1;

function clearHighlights() {
  for (const m of searchHits) {
    const p = m.parentNode;
    if (!p) continue;
    p.replaceChild(document.createTextNode(m.textContent), m);
    p.normalize(); // 쪼갠 텍스트 노드를 다시 합쳐야 다음 검색에서 경계를 넘는 일치를 놓치지 않는다
  }
  searchHits = [];
  searchIdx = -1;
}

function highlight(query) {
  clearHighlights();
  const q = query.trim().toLowerCase();
  if (!q) return;

  // 워커를 돌면서 DOM을 고치면 순회가 깨진다 → 대상 노드를 먼저 모은다
  const walker = document.createTreeWalker(messagesEl, NodeFilter.SHOW_TEXT);
  const targets = [];
  while (walker.nextNode()) {
    const v = walker.currentNode.nodeValue;
    if (v && v.toLowerCase().includes(q)) targets.push(walker.currentNode);
  }

  for (const node of targets) {
    let rest = node;
    let at = rest.nodeValue.toLowerCase().indexOf(q);
    while (at !== -1) {
      const hit = rest.splitText(at);
      const after = hit.splitText(q.length);
      const mark = document.createElement('mark');
      mark.className = 'search-hit';
      mark.textContent = hit.nodeValue;
      hit.parentNode.replaceChild(mark, hit);
      searchHits.push(mark);
      rest = after;
      at = rest.nodeValue.toLowerCase().indexOf(q);
    }
  }
}

function updateSearchCount() {
  const n = searchHits.length;
  searchCountEl.textContent = !searchInputEl.value.trim() ? '' : n ? `${searchIdx + 1}/${n}` : '결과 없음';
  searchCountEl.classList.toggle('empty', !!searchInputEl.value.trim() && n === 0);
}

function gotoHit(i) {
  if (!searchHits.length) return updateSearchCount();
  searchIdx = (i + searchHits.length) % searchHits.length;
  for (const m of searchHits) m.classList.remove('current');
  const m = searchHits[searchIdx];
  m.classList.add('current');
  // 접힌 도구 줄(nowrap+말줄임) 안이면 펼쳐야 실제로 보인다 — 안 그러면 "5건인데 안 보임"이 된다
  m.closest('.msg.tool')?.classList.add('expanded');
  m.scrollIntoView({ block: 'center' });
  updateSearchCount();
}

function runSearch() {
  highlight(searchInputEl.value);
  searchIdx = -1;
  if (searchHits.length) gotoHit(0);
  else updateSearchCount();
}

function openSearch() {
  searchOpen = true;
  searchBarEl.classList.remove('hidden');
  searchInputEl.focus();
  searchInputEl.select();
  if (searchInputEl.value.trim()) runSearch();
}

function closeSearch() {
  searchOpen = false;
  searchBarEl.classList.add('hidden');
  clearHighlights();
  updateSearchCount();
  inputEl.focus();
}

searchInputEl.addEventListener('input', runSearch);
searchInputEl.addEventListener('keydown', (e) => {
  if (e.isComposing) return; // 한글 조합 중 Enter는 확정용이므로 가로채지 않는다
  if (e.key === 'Enter') {
    e.preventDefault();
    gotoHit(searchIdx + (e.shiftKey ? -1 : 1));
  }
});
document.getElementById('search-next').onclick = () => gotoHit(searchIdx + 1);
document.getElementById('search-prev').onclick = () => gotoHit(searchIdx - 1);
document.getElementById('search-close').onclick = closeSearch;

// ---------- 할 일 패널 ----------
// 대화 흐름에 카드로 쌓지 않고 헤더 아래 고정한다. TODO는 "지금 상태"가 중요하고,
// 갱신될 때마다 카드가 쌓이면 대화가 밀려나기 때문.
const TASK_ICON = { completed: '☑', in_progress: '▶', pending: '☐' };
let tasksOpen = false;

function renderTasks(summary) {
  const items = summary?.items || [];
  taskPanelEl.classList.toggle('hidden', items.length === 0);
  if (!items.length) return;

  const done = summary.done || 0;
  const total = summary.total || items.length;
  document.getElementById('task-count').textContent = `${done}/${total}`;
  document.getElementById('task-progress-fill').style.width = total ? (done / total) * 100 + '%' : '0%';
  // 진행 중인 항목이 있으면 접힌 상태에서도 그게 보이게 라벨에 얹는다
  const running = items.find((t) => t.status === 'in_progress');
  document.getElementById('task-label').textContent = running ? running.subject : '할 일';

  taskListEl.innerHTML = '';
  for (const t of items) {
    const li = document.createElement('li');
    li.className = 'task-item ' + t.status;
    const icon = document.createElement('span');
    icon.className = 'task-icon';
    icon.textContent = TASK_ICON[t.status] || '☐';
    const txt = document.createElement('span');
    txt.textContent = t.subject;
    li.append(icon, txt);
    taskListEl.appendChild(li);
  }
}

document.getElementById('task-bar').onclick = () => {
  tasksOpen = !tasksOpen;
  taskListEl.classList.toggle('hidden', !tasksOpen);
  document.getElementById('task-caret').textContent = tasksOpen ? '▾' : '▸';
};

ipcRenderer.on('room:tasks', (e, summary) => renderTasks(summary));

// 말풍선 안 사진의 표시 크기. 가로·세로 어느 쪽도 220을 넘지 않게 원본 비율로 줄인다.
// 원본보다 키우지는 않는다 (작은 썸네일이 뿌옇게 늘어나는 걸 막으려고 scale 상한 1).
// width만 지정하고 height는 auto — 좁은 창에서 CSS max-width:100%가 먹을 때도 비율이 유지된다.
const BUBBLE_IMG_MAX = 220;
function sizeBubbleImage(img) {
  const { naturalWidth: w, naturalHeight: h } = img;
  if (!w || !h) return;
  const scale = Math.min(BUBBLE_IMG_MAX / w, BUBBLE_IMG_MAX / h, 1);
  img.style.width = Math.round(w * scale) + 'px';
}

// ---------- 분기 방: 물려받은 대화 접기 ----------
// fork는 원본 대화를 물리적으로 복사하므로 새 방에도 전체가 들어온다.
// 그대로 펼치면 새 대화가 100개 밑에 묻히니 앞부분은 접어둔다.
let forkedAt = 0;

function renderHistory(messages) {
  streamEl = null;
  messagesEl.innerHTML = '';
  const inherited = Math.min(forkedAt, messages.length);

  if (inherited > 0) {
    const box = document.createElement('div');
    box.className = 'inherited hidden';
    const btn = document.createElement('button');
    btn.className = 'inherited-toggle';
    btn.textContent = `⤴ 분기 전 대화 ${inherited}개 보기`;
    btn.onclick = () => {
      const open = box.classList.toggle('hidden');
      btn.textContent = open ? `⤴ 분기 전 대화 ${inherited}개 보기` : `⤵ 분기 전 대화 접기`;
    };
    messagesEl.append(btn, box);
    for (const m of messages.slice(0, inherited)) appendMessage(m, { scroll: false, into: box });

    const line = document.createElement('div');
    line.className = 'fork-line';
    line.textContent = '여기서 분기됨';
    messagesEl.appendChild(line);
  }

  for (const m of messages.slice(inherited)) appendMessage(m, { scroll: false });
}

// ---------- 다른 방에서 온 말풍선 ----------
// 내가 한 말도, 이 방 claude가 한 말도 아니다. 카톡 단톡방처럼 이름표를 얹어 구분하고
// 호출명 해시로 색을 고정한다 (같은 방은 항상 같은 색).
function peerHue(handle) {
  let h = 0;
  for (const ch of String(handle)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % 360;
}

function appendPeerBubble(el, msg) {
  const hue = peerHue(msg.from || '');
  el.style.setProperty('--peer-hue', hue);

  const col = document.createElement('div');
  col.className = 'peer-col';

  const name = document.createElement('button');
  name.className = 'peer-name';
  name.textContent = '@' + (msg.from || '?');
  name.title = `${msg.from} 방 열기`;
  name.onclick = () => ipcRenderer.invoke('room:openByHandle', msg.from);

  const bubble = document.createElement('div');
  bubble.className = 'bubble md';
  bubble.innerHTML = renderMarkdown(msg.text || '');

  col.append(name, bubble);

  const time = document.createElement('div');
  time.className = 'time-label';
  time.textContent = fmtTime(msg.ts);
  el.append(col, time);
}

function appendMessage(msg, { scroll = true, into = null } = {}) {
  // 대기줄 메시지는 대화 흐름이 아니라 입력창 위 고정 영역에
  if (msg.pending) {
    addPendingRow(msg);
    return;
  }
  // 최종 assistant 메시지 도착 → 스트리밍 버블을 확정본으로 교체
  if (msg.role === 'assistant' && streamEl) {
    streamEl.remove();
    streamEl = null;
  }
  const indicator = messagesEl.querySelector('.typing-indicator');
  if (indicator) indicator.remove();

  const el = document.createElement('div');
  el.className = 'msg ' + msg.role;
  if (msg.role === 'peer') {
    appendPeerBubble(el, msg);
  } else if (msg.role === 'tool') {
    el.textContent = '🔧 ' + msg.text;
    el.onclick = () => el.classList.toggle('expanded'); // 클릭 = 전체 보기 토글
  } else if (msg.role === 'system') {
    el.className = 'msg tool system-msg';
    el.textContent = msg.text;
  } else {
    const time = document.createElement('div');
    time.className = 'time-label';
    time.textContent = fmtTime(msg.ts);
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (msg.images?.length) {
      for (const src of msg.images) {
        const img = document.createElement('img');
        img.className = 'bubble-img';
        img.onload = () => sizeBubbleImage(img);
        img.src = src;
        img.onclick = () => ipcRenderer.invoke('image:openViewer', src); // 별도 뷰어 창
        bubble.appendChild(img);
      }
    }
    if (msg.text) {
      const t = document.createElement('div');
      if (msg.role === 'assistant') {
        t.className = 'md';
        t.innerHTML = renderMarkdown(msg.text);
      } else {
        t.textContent = msg.text; // 사용자 메시지는 원문 그대로
      }
      bubble.appendChild(t);
    }
    if (msg.role === 'user') el.append(time, bubble);
    else el.append(bubble, time);
  }
  (into || messagesEl).appendChild(el);
  if (into) return; // 접힌 영역에 채우는 중이면 타이핑 표시·스크롤은 건드리지 않는다
  updateTypingIndicator();
  if (scroll) scrollToBottom();
}

// 상태줄: 지금 뭘 하는지 + 경과 시간 ("Bash 실행 중 · 47초")
function statusText() {
  const label = lastRoomSummary?.activity || (roomState === 'starting' ? '세션 시작 중' : 'Claude가 작업 중');
  const sec = lastRoomSummary?.turnStart ? Math.floor((Date.now() - lastRoomSummary.turnStart) / 1000) : null;
  return sec !== null && sec > 0 ? `${label} · ${sec}초` : label;
}

// 인디케이터는 세션이 도는 내내 떠 있고 1초마다 갱신된다. textContent로 통째로 갈아끼우면
// 점 세 개까지 매번 새로 만들어져 애니메이션이 끊기므로, 글자 부분만 따로 둔다.
function setTypingText(el, text) {
  const span = el.firstChild;
  if (span.textContent !== text) span.textContent = text;
}

function updateTypingIndicator() {
  const existing = messagesEl.querySelector('.typing-indicator');
  const working = roomState === 'working' || roomState === 'starting';
  if (working && !existing) {
    const el = document.createElement('div');
    el.className = 'typing-indicator';
    el.appendChild(document.createTextNode(statusText()));
    const dots = document.createElement('span');
    dots.className = 'typing-dots';
    dots.innerHTML = '<i>.</i><i>.</i><i>.</i>';
    el.appendChild(dots);
    messagesEl.appendChild(el);
    scrollToBottom();
  } else if (working && existing) {
    setTypingText(existing, statusText());
  } else if (!working && existing) {
    existing.remove();
  }
}

setInterval(() => {
  const existing = messagesEl.querySelector('.typing-indicator');
  if (existing) setTypingText(existing, statusText());
}, 1000);

// ---------- 응답 스트리밍 (타이핑되듯 자라는 버블) ----------

let streamEl = null;

ipcRenderer.on('room:stream-text', (e, text) => {
  if (roomState !== 'working' && roomState !== 'starting') return;
  if (!streamEl) {
    streamEl = document.createElement('div');
    streamEl.className = 'msg assistant streaming';
    const b = document.createElement('div');
    b.className = 'bubble md';
    streamEl.appendChild(b);
    const ind = messagesEl.querySelector('.typing-indicator');
    messagesEl.insertBefore(streamEl, ind || null);
  }
  streamEl.querySelector('.bubble').innerHTML = renderMarkdown(text);
  scrollToBottom(); // 위로 올려둔 상태면 따라가지 않는다
});

const MODEL_FAMILIES = ['fable', 'mythos', 'opus', 'sonnet', 'haiku'];

function shortModelName(modelId) {
  if (!modelId) return '';
  const id = String(modelId).toLowerCase();
  const family = MODEL_FAMILIES.find((f) => id.includes(f));
  if (family) {
    // claude-haiku-4-5-20251001 → 4-5, claude-opus-5 → 5 (뒤의 날짜 8자리는 버전이 아님)
    const ver = new RegExp(`${family}-(\\d{1,2}(?:-\\d{1,2})?)(?!\\d)`).exec(id)?.[1]
      || new RegExp(`(\\d{1,2}(?:-\\d{1,2})?)-${family}`).exec(id)?.[1];
    const label = family[0].toUpperCase() + family.slice(1);
    return label + (ver ? ' ' + ver.replace('-', '.') : '') + (id.includes('[1m]') ? ' · 1M' : '');
  }
  for (const m of MODELS) {
    if (modelMatches(m.alias, modelId)) return m.name;
  }
  return modelId.replace(/^claude-/, '');
}

function renderHeader(room) {
  const title = room.title || room.name;
  document.title = title;
  document.getElementById('chat-title').textContent = title;
  const model = shortModelName(roomInfo.model);
  // 이 방의 호출명도 같이 — 다른 방에서 나를 부를 이름을 알아야 상대에게 알려줄 수 있다
  const handle = room.handle ? `@${room.handle} · ` : '';
  document.getElementById('chat-sub').textContent =
    `${handle}${room.dir} · ${STATE_LABEL[room.state] || room.state}${model ? ' · ' + model : ''}`;
  document.getElementById('btn-kill').style.opacity = room.state === 'offline' ? 0.4 : 1;
  document.getElementById('btn-stop').classList.toggle('hidden', room.state !== 'working');
  // 폰 연결은 창보다 오래 산다(12시간). 창을 닫았다 열어도 표시가 유지되도록 메인이
  // 알려준 값을 그대로 따른다 — 렌더러가 기억하는 토큰은 창과 함께 사라진다.
  if (room.phoneToken !== undefined) {
    qrToken = room.phoneToken;
    markPhoneLink();
  }
}
let lastRoomSummary = null;

function send() {
  const text = inputEl.value.trim();
  if (!text && pendingImages.length === 0) return;
  // 인자 없는 /model → 네이티브 픽커
  if (text === '/model') {
    inputEl.value = '';
    openModelPicker();
    return;
  }
  scrollToBottom({ force: true }); // 내가 보냈으면 답을 봐야 하니 다시 하단에 붙인다
  ipcRenderer.invoke('room:send', roomId, text,
    pendingImages.map((p) => ({ media_type: p.mediaType, data: p.base64 })));
  inputEl.value = '';
  autoGrow();
  pendingImages = [];
  renderAttachBar();
}

// ---------- 자동완성 (/ 슬래시 커맨드, @ 다른 방) ----------
// 메뉴 하나를 두 용도로 쓴다 — 입력창 위 같은 자리에 뜨고 조작 키도 같아서,
// 따로 두면 두 메뉴가 동시에 뜨는 상태를 관리해야 한다.

const slashMenuEl = document.getElementById('slash-menu');
let menuIndex = 0;
let menuMode = null; // 'slash' | 'mention' | null

// 다른 방 호출명 목록. 방이 새로 생기거나 이름이 바뀔 수 있어 오래되면 다시 받아온다.
let handles = [];
let handlesAt = 0;

async function refreshHandles() {
  handles = (await ipcRenderer.invoke('rooms:handles', roomId)) || [];
  handlesAt = Date.now();
}

function slashCandidates() {
  const v = inputEl.value;
  if (!v.startsWith('/') || v.includes(' ') || v.includes('\n')) return [];
  const q = v.slice(1).toLowerCase();
  const all = [...roomInfo.slashCommands].sort();
  // 접두사 일치 우선, 그 다음 부분 일치 — 전체 표시 (메뉴는 스크롤)
  const pre = all.filter((c) => c.toLowerCase().startsWith(q));
  const inc = all.filter((c) => !c.toLowerCase().startsWith(q) && c.toLowerCase().includes(q));
  return [...pre, ...inc];
}

// 커서 바로 앞의 @토큰. 단어 중간의 @(이메일 등)는 대상이 아니다.
function mentionToken() {
  const pos = inputEl.selectionStart ?? inputEl.value.length;
  const before = inputEl.value.slice(0, pos);
  const at = before.lastIndexOf('@');
  if (at === -1) return null;
  if (at > 0 && /\S/.test(before[at - 1])) return null;
  const q = before.slice(at + 1);
  if (/\s/.test(q)) return null;
  return { at, q };
}

function mentionCandidates() {
  const t = mentionToken();
  if (!t) return [];
  const q = t.q.toLowerCase();
  const hit = (h) => h.handle.toLowerCase().startsWith(q);
  const near = (h) => h.handle.toLowerCase().includes(q) || (h.title || '').toLowerCase().includes(q);
  return [...handles.filter(hit), ...handles.filter((h) => !hit(h) && near(h))].slice(0, 40);
}

function menuState() {
  const slash = slashCandidates();
  if (slash.length) return { mode: 'slash', items: slash.map((c) => ({ key: c, label: '/' + c })) };
  const men = mentionCandidates();
  if (men.length) {
    return { mode: 'mention', items: men.map((h) => ({ key: h.handle, label: '@' + h.handle, sub: h.title })) };
  }
  return { mode: null, items: [] };
}

function renderMenu() {
  const { mode, items } = menuState();
  menuMode = mode;
  slashMenuEl.classList.toggle('hidden', items.length === 0);
  if (!items.length) return;
  menuIndex = Math.min(menuIndex, items.length - 1);
  slashMenuEl.innerHTML = '';
  items.forEach((it, i) => {
    const el = document.createElement('div');
    el.className = 'slash-item' + (i === menuIndex ? ' active' : '');
    const key = document.createElement('span');
    key.className = 'slash-key';
    key.textContent = it.label;
    el.appendChild(key);
    if (it.sub) {
      const sub = document.createElement('span');
      sub.className = 'slash-sub';
      sub.textContent = it.sub;
      el.appendChild(sub);
    }
    el.onmousedown = (ev) => {
      ev.preventDefault();
      commitMenu(it.key);
    };
    slashMenuEl.appendChild(el);
  });
  slashMenuEl.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}

function closeMenu() {
  slashMenuEl.classList.add('hidden');
  menuIndex = 0;
  menuMode = null;
}

function commitMenu(key) {
  if (menuMode === 'mention') return completeMention(key);
  return completeSlash(key);
}

function completeSlash(cmd) {
  closeMenu();
  if (cmd === 'model') {
    inputEl.value = '';
    openModelPicker();
    return;
  }
  inputEl.value = '/' + cmd + ' ';
  autoGrow();
  inputEl.focus();
}

function completeMention(handle) {
  const t = mentionToken();
  closeMenu();
  if (!t) return;
  const pos = inputEl.selectionStart ?? inputEl.value.length;
  const after = inputEl.value.slice(pos);
  inputEl.value = inputEl.value.slice(0, t.at) + '@' + handle + after;
  const caret = t.at + 1 + handle.length;
  inputEl.setSelectionRange(caret, caret);
  autoGrow();
  inputEl.focus();
}

// 입력할 때마다 부르기엔 아까워서, @를 치기 시작한 순간에만 목록을 갱신한다
function maybeRefreshHandles() {
  if (!mentionToken()) return;
  if (Date.now() - handlesAt < 30000) return;
  refreshHandles().then(renderMenu);
}

// ---------- 모델 픽커 ----------

const pickerEl = document.getElementById('model-picker');

function openModelPicker() {
  const listEl = document.getElementById('model-list');
  listEl.innerHTML = '';
  for (const m of MODELS) {
    const cur = modelMatches(m.alias, roomInfo.model);
    const el = document.createElement('div');
    el.className = 'model-item' + (cur ? ' current' : '');
    el.innerHTML = `<div class="m-name"></div><div class="m-desc"></div>${cur ? '<div class="m-check">✓</div>' : ''}`;
    el.querySelector('.m-name').textContent = m.name;
    el.querySelector('.m-desc').textContent = m.desc;
    el.onclick = () => {
      pickerEl.classList.add('hidden');
      ipcRenderer.invoke('room:send', roomId, '/model ' + m.alias, []);
    };
    listEl.appendChild(el);
  }
  pickerEl.classList.remove('hidden');
}

pickerEl.addEventListener('click', (e) => {
  if (e.target === pickerEl) pickerEl.classList.add('hidden');
});

// ---------- 폰에서 이어서 대화 (QR) ----------
//
// 예전엔 사진 한 장 올리는 용도라 모달을 닫을 때 주소를 무효화했다. 이제는 QR을 찍고
// 자리를 뜨는 게 목적이라 그러면 기능이 성립하지 않는다 — 닫아도 살려두고, 끊는 건
// 명시적으로 누르게 한다. 대신 살아있는 동안 📱 버튼에 표시가 남는다.
const qrModalEl = document.getElementById('qr-modal');
const qrRevokeEl = document.getElementById('qr-revoke');
const btnPhoneEl = document.getElementById('btn-phone');
let qrToken = null;

function markPhoneLink() {
  btnPhoneEl.classList.toggle('linked', !!qrToken);
  btnPhoneEl.dataset.tip = qrToken
    ? '폰에서 이어서 대화 — 연결됨 (눌러서 주소 보기·끊기)'
    : '폰에서 이어서 대화 — QR을 찍으세요 (같은 Wi-Fi)';
  qrRevokeEl.classList.toggle('hidden', !qrToken);
}

async function openQr() {
  // 이미 살아있는 주소가 있으면 그걸 다시 보여준다. 열 때마다 새로 내면 앞서 찍어둔
  // 폰이 조용히 죽고, 무효화되지 않은 토큰만 쌓인다.
  const res = await ipcRenderer.invoke('room:uploadUrl', roomId, qrToken);
  if (!res) return;
  const body = document.getElementById('qr-body');
  if (res.error) {
    body.innerHTML = '';
    const p = document.createElement('div');
    p.id = 'qr-hint';
    p.textContent = res.error;
    body.appendChild(p);
  } else {
    qrToken = res.token;
    document.getElementById('qr-img').src = res.qr;
    document.getElementById('qr-url').textContent = res.url;
  }
  markPhoneLink();
  qrModalEl.classList.remove('hidden');
}

// 닫기는 모달만 접는다 — 폰 연결은 그대로 살아있다
function closeQr() {
  qrModalEl.classList.add('hidden');
}

qrRevokeEl.onclick = () => {
  if (qrToken) ipcRenderer.invoke('room:uploadDone', qrToken);
  qrToken = null;
  markPhoneLink();
  qrModalEl.classList.add('hidden');
};

document.getElementById('btn-phone').onclick = openQr;
qrModalEl.addEventListener('click', (e) => {
  if (e.target === qrModalEl) closeQr();
});

// 폰에서 사진이 도착 — 첨부칸에 꽂고, 캡션이 있으면 입력창에 채운다
ipcRenderer.on('room:photo', (e, photo) => {
  pendingImages.push({ name: photo.name, mediaType: photo.mediaType, base64: photo.base64 });
  renderAttachBar();
  if (photo.caption) {
    inputEl.value = inputEl.value ? inputEl.value + ' ' + photo.caption : photo.caption;
    autoGrow();
  }
  closeQr();
  inputEl.focus();
});

// ---------- 권한 모드 픽커 ----------
// 기본값은 따로 두지 않는다 — settings.json의 전역 설정을 따르고, 여기서 고르면 그 방만 덮어쓴다.
// 세션이 떠 있으면 control_request로 즉시 반영되고, 꺼져 있으면 다음 기동 때 인자로 들어간다.
const PERM_MODES = [
  { id: 'bypassPermissions', name: '전부 허용', desc: '확인 없이 실행 (기본)' },
  { id: 'acceptEdits', name: '편집만 자동 허용', desc: '파일 수정은 통과, 나머지는 확인' },
  { id: 'plan', name: '계획만', desc: '실행하지 않고 계획만 세움' },
];
const PERM_SHORT = { bypassPermissions: '전부 허용', acceptEdits: '편집 허용', plan: '계획만' };
const permPickerEl = document.getElementById('perm-picker');

function openPermPicker() {
  const listEl = document.getElementById('perm-list');
  listEl.innerHTML = '';
  for (const m of PERM_MODES) {
    const cur = roomInfo.permissionMode === m.id;
    const el = document.createElement('div');
    el.className = 'model-item' + (cur ? ' current' : '');
    el.innerHTML = `<div class="m-name"></div><div class="m-desc"></div>${cur ? '<div class="m-check">✓</div>' : ''}`;
    el.querySelector('.m-name').textContent = m.name;
    el.querySelector('.m-desc').textContent = m.desc;
    el.onclick = () => {
      permPickerEl.classList.add('hidden');
      roomInfo.permissionMode = m.id; // 응답을 기다리지 않고 즉시 반영 (info 이벤트가 곧 확정해준다)
      renderPermButton();
      ipcRenderer.invoke('room:setPermissionMode', roomId, m.id);
    };
    listEl.appendChild(el);
  }
  permPickerEl.classList.remove('hidden');
}

// ---------- 자동 압축 시점 ----------
//
// 비용은 대략 "요청 수 × (임계 + 바닥)/2"다. 임계를 올리면 압축 횟수는 줄지만 매 요청이
// 비싸진다. 잠든 방을 깨우는 값은 이제 임계와 무관하다 — 유휴 종료 전에 압축하고 재우므로
// (engine.compactBeforeIdle) 어떤 임계를 골라도 깨울 때는 바닥값이다. 그래서 이 선택은
// "압축을 얼마나 자주 맞을 것인가 vs 턴마다 얼마를 다시 읽을 것인가"만 남는다.
const COMPACT_OPTS = [
  { v: 140000, name: '140k · 가장 저렴', desc: '턴당 읽기 최소 · 압축 가장 잦음' },
  { v: 180000, name: '180k · 자주', desc: '도구를 많이 부르는 방에 유리' },
  { v: 250000, name: '250k · 보통', desc: '압축 약 35% 감소' },
  { v: 400000, name: '400k · 드물게', desc: '턴당 읽기 1.6배 · 긴 맥락이 필요한 방' },
  { v: 'limit', name: '한도까지 · 기본', desc: '모델이 꽉 찰 때(92%)까지 · 압축 가장 드묾' },
];
const compactPickerEl = document.getElementById('compact-picker');

function openCompactPicker() {
  const listEl = document.getElementById('compact-list');
  const limit = lastRoomSummary?.contextLimit || 0;
  const pick = lastRoomSummary?.compactPick || null;
  listEl.innerHTML = '';
  for (const o of COMPACT_OPTS) {
    // 모델 한도의 80%를 넘는 절대값은 고를 수 없다 — 압축이 걸리기 전에 방이 막힌다.
    // '한도까지'는 한도에 맞춰 따라가므로 언제나 고를 수 있다.
    const tooBig = typeof o.v === 'number' && limit > 0 && o.v > limit * 0.8;
    const cur = pick ? pick === o.v : o.v === 'limit';
    const el = document.createElement('div');
    el.className = 'model-item' + (cur ? ' current' : '') + (tooBig ? ' disabled' : '');
    el.innerHTML = `<div class="m-name"></div><div class="m-desc"></div>${cur ? '<div class="m-check">✓</div>' : ''}`;
    el.querySelector('.m-name').textContent = o.name;
    el.querySelector('.m-desc').textContent = tooBig
      ? `현재 모델 한도(${Math.round(limit / 1000)}k)에는 너무 큽니다`
      : o.desc;
    if (!tooBig) {
      el.onclick = () => {
        compactPickerEl.classList.add('hidden');
        ipcRenderer.invoke('room:setCompactAt', roomId, o.v === 'limit' ? null : o.v);
      };
    }
    listEl.appendChild(el);
  }
  const ctx = lastRoomSummary?.context || 0;
  document.getElementById('compact-note').textContent =
    // 깨우는 값은 이제 이 선택과 무관하다 — 유휴 종료 전에 압축하고 재우기 때문이다.
    // 남은 교환비는 "압축을 얼마나 자주 맞느냐 vs 턴마다 얼마를 다시 읽느냐"뿐이라 그걸 적는다.
    // (압축 한 번은 실측 중앙값 171초로 크기와 거의 무관하다)
    `지금 ${Math.round(ctx / 1000)}k · 압축 한 번은 약 3분 걸립니다 — 임계를 올리면 압축은 드물어지고 ` +
    `대신 턴마다 다시 읽는 양이 그만큼 늘어납니다. 잠든 방을 깨우는 값은 이 선택과 무관합니다.`;
  compactPickerEl.classList.remove('hidden');
}

compactPickerEl.addEventListener('click', (e) => {
  if (e.target === compactPickerEl) compactPickerEl.classList.add('hidden');
});

function renderPermButton() {
  const btn = document.getElementById('btn-perm');
  const mode = roomInfo.permissionMode;
  // 전부 허용은 기본 상태라 조용히, 제한이 걸린 모드만 눈에 띄게
  btn.classList.toggle('restricted', !!mode && mode !== 'bypassPermissions');
  btn.dataset.tip = `권한 모드: ${PERM_SHORT[mode] || '전역 설정'} — 클릭해서 변경`;
}

document.getElementById('btn-perm').onclick = openPermPicker;
permPickerEl.addEventListener('click', (e) => {
  if (e.target === permPickerEl) permPickerEl.classList.add('hidden');
});

// ---------- 첨부 (드래그앤드롭 / 붙여넣기) ----------

function renderAttachBar() {
  attachBarEl.classList.toggle('hidden', pendingImages.length === 0);
  attachBarEl.innerHTML = '';
  pendingImages.forEach((p, i) => {
    const chip = document.createElement('div');
    chip.className = 'attach-chip';
    chip.innerHTML = `<img src="data:${p.mediaType};base64,${p.base64}" /><button title="제거">✕</button>`;
    chip.querySelector('button').onclick = () => {
      pendingImages.splice(i, 1);
      renderAttachBar();
    };
    attachBarEl.appendChild(chip);
  });
}

function addImageFile(file) {
  if (file.size > MAX_IMAGE_BYTES) {
    alert(`"${file.name}"이(가) 너무 커요 (최대 4.5MB). 파일 경로로 대신 넣을게.`);
    return false;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const base64 = reader.result.split(',')[1];
    const mediaType = reader.result.slice(5, reader.result.indexOf(';'));
    pendingImages.push({ name: file.name, mediaType, base64 });
    renderAttachBar();
  };
  reader.readAsDataURL(file);
  return true;
}

function insertPathToInput(filePath) {
  if (!filePath) return;
  const quoted = /\s/.test(filePath) ? `"${filePath}"` : filePath;
  const cur = inputEl.value;
  inputEl.value = cur + (cur && !cur.endsWith(' ') ? ' ' : '') + quoted + ' ';
  inputEl.dispatchEvent(new Event('input'));
  inputEl.focus();
}

function handleFiles(files) {
  for (const file of files) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const isImage = !!IMAGE_TYPES[ext] || (file.type || '').startsWith('image/');
    if (isImage && addImageFile(file)) continue;
    // 이미지가 아니거나 너무 큰 파일 → 경로 삽입 (Claude Code 터미널과 동일)
    let p = '';
    try { p = webUtils.getPathForFile(file); } catch {}
    insertPathToInput(p || file.path || '');
  }
}

let dragDepth = 0;
const overlay = document.getElementById('drop-overlay');
document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (e.dataTransfer?.types?.includes('Files') && ++dragDepth === 1) overlay.classList.remove('hidden');
});
document.addEventListener('dragleave', (e) => {
  e.preventDefault();
  if (dragDepth > 0 && --dragDepth === 0) overlay.classList.add('hidden');
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  overlay.classList.add('hidden');
  if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
});

// 클립보드 이미지 붙여넣기 (스크린샷 등)
document.addEventListener('paste', (e) => {
  const items = [...(e.clipboardData?.items || [])].filter((it) => it.type.startsWith('image/'));
  if (items.length === 0) return;
  e.preventDefault();
  for (const it of items) {
    const f = it.getAsFile();
    if (f) addImageFile(f);
  }
});

document.getElementById('btn-send').onclick = send;
inputEl.addEventListener('keydown', (e) => {
  const menuOpen = !slashMenuEl.classList.contains('hidden');
  if (menuOpen) {
    const { items } = menuState();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      menuIndex = (menuIndex + 1) % items.length;
      renderMenu();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      menuIndex = (menuIndex - 1 + items.length) % items.length;
      renderMenu();
      return;
    }
    if ((e.key === 'Tab' || e.key === 'Enter') && !e.isComposing) {
      const pick = items[menuIndex];
      // 슬래시가 이미 완성돼 있으면 Enter는 전송으로 (기존 동작)
      const exact = menuMode === 'slash' && inputEl.value === pick?.label;
      if (pick && !(e.key === 'Enter' && exact)) {
        e.preventDefault();
        commitMenu(pick.key);
        return;
      }
      closeMenu();
    }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});
// border-box라 scrollHeight엔 테두리가 빠져 있음 — 그만큼 더해야 마지막 줄이 안 잘림
function autoGrow() {
  inputEl.style.height = 'auto';
  const border = inputEl.offsetHeight - inputEl.clientHeight;
  inputEl.style.height = Math.min(inputEl.scrollHeight + border, 140) + 'px';
}
autoGrow();

inputEl.addEventListener('input', () => {
  autoGrow();
  renderMenu();
  maybeRefreshHandles();
});
inputEl.addEventListener('blur', () => setTimeout(closeMenu, 150));

document.getElementById('btn-kill').onclick = () => {
  ipcRenderer.invoke('room:kill', roomId);
};

document.getElementById('btn-stop').onclick = () => {
  ipcRenderer.invoke('room:interrupt', roomId);
};

// ESC 우선순위: 모델 픽커 > 자동완성 > 검색 > 창 숨김 (세션은 계속 돌아감)
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
    e.preventDefault();
    openSearch();
    return;
  }
  if (e.key === 'Escape' && !e.isComposing) {
    e.preventDefault();
    if (!pickerEl.classList.contains('hidden')) {
      pickerEl.classList.add('hidden');
    } else if (!qrModalEl.classList.contains('hidden')) {
      closeQr();
    } else if (!permPickerEl.classList.contains('hidden')) {
      permPickerEl.classList.add('hidden');
    } else if (!compactPickerEl.classList.contains('hidden')) {
      compactPickerEl.classList.add('hidden');
    } else if (!slashMenuEl.classList.contains('hidden')) {
      closeMenu();
    } else if (searchOpen) {
      closeSearch(); // 검색 중 ESC는 창을 숨기지 않고 검색만 닫는다
    } else {
      ipcRenderer.invoke('room:hide', roomId);
    }
  }
});

ipcRenderer.on('room:update', (e, summary) => {
  if (summary.id !== roomId) return;
  roomState = summary.state;
  lastRoomSummary = summary;
  renderHeader(summary);
  updateTypingIndicator();
  // 턴이 끝났는데 스트리밍 버블이 남아있으면 정리 (확정본은 이미 도착한 상태)
  if (roomState !== 'working' && roomState !== 'starting' && streamEl) {
    streamEl.remove();
    streamEl = null;
  }
});

ipcRenderer.on('room:info', (e, info) => {
  roomInfo = info;
  renderPermButton();
  if (lastRoomSummary) renderHeader(lastRoomSummary);
  updateStatusbar();
});

ipcRenderer.on('room:message', (e, msg) => appendMessage(msg));

// ---------- 대기줄 (입력창 위 고정 영역) ----------

const pendingBarEl = document.getElementById('pending-bar');
const pendingQueue = []; // {text, images}

function addPendingRow(msg) {
  // 역할을 같이 들고 있어야 투입될 때 원래 말풍선으로 그려진다 (전달돼 온 말도 대기줄에 들어간다)
  pendingQueue.push({ text: msg.text, images: msg.images || [], role: msg.role, from: msg.from });
  const row = document.createElement('div');
  row.className = 'pending-row' + (msg.role === 'peer' ? ' peer' : '');
  const tag = document.createElement('span');
  tag.className = 'pending-tag';
  tag.textContent = msg.role === 'peer' ? `⏳ @${msg.from}` : '⏳ 대기';
  const body = document.createElement('span');
  body.className = 'pending-text';
  body.textContent = (msg.images?.length ? `📷 사진${msg.images.length}장 ` : '') + (msg.text || '');

  // 취소. 자리는 메인 프로세스가 실제로 뺀 곳을 알려주므로 그걸 그대로 따른다 —
  // 여기서 다시 계산하면 그 사이 투입된 앞줄 때문에 한 칸씩 밀린 걸 지운다.
  const cancel = document.createElement('button');
  cancel.className = 'pending-cancel';
  cancel.textContent = '✕';
  cancel.title = '보내기 취소';
  cancel.onclick = async () => {
    const i = [...pendingBarEl.children].indexOf(row);
    if (i < 0) return;
    cancel.disabled = true;
    // 창만 새로 열고 앱은 안 껐다 켠 상태면 메인 쪽에 핸들러가 없다 — 눌러도 안 죽게
    const at = await ipcRenderer.invoke('room:cancel-pending', roomId, i, msg.text || '').catch(() => -1);
    if (at < 0) {
      cancel.disabled = false; // 이미 투입된 뒤였다 — queue-flushed가 알아서 치운다
      return;
    }
    pendingQueue.splice(at, 1);
    pendingBarEl.children[at]?.remove();
    if (pendingBarEl.childElementCount === 0) pendingBarEl.classList.add('hidden');
  };

  row.append(tag, body, cancel);
  pendingBarEl.appendChild(row);
  pendingBarEl.classList.remove('hidden');
}

// 대기줄 메시지가 실제 투입됨 → 대기 영역에서 빼서 대화 흐름에 정식 버블로
ipcRenderer.on('room:queue-flushed', () => {
  const item = pendingQueue.shift();
  pendingBarEl.firstElementChild?.remove();
  if (pendingBarEl.childElementCount === 0) pendingBarEl.classList.add('hidden');
  if (item) {
    appendMessage({
      role: item.role || 'user',
      from: item.from,
      text: item.text,
      images: item.images,
      ts: new Date().toISOString(),
    });
  }
});

// 터미널에서 대화가 이어지면 전체 다시 그리기
ipcRenderer.on('room:history-reset', (e, messages) => {
  // 통째로 다시 그리면 스크롤 위치가 날아간다. 읽던 중이었다면 바닥에서 떨어진
  // 거리를 기준으로 되돌려 준다 (터미널에서 대화가 이어져도 읽던 자리를 유지)
  const prevGap = bottomGap();
  renderHistory(messages);
  if (stickToBottom) scrollToBottom({ force: true });
  else messagesEl.scrollTop = messagesEl.scrollHeight - messagesEl.clientHeight - prevGap;
});

(async () => {
  const res = await ipcRenderer.invoke('room:init', roomId);
  if (!res) return;
  roomState = res.room.state;
  roomInfo = res.info || roomInfo;
  quota = res.quota || quota;
  lastRoomSummary = res.room;
  renderHeader(res.room);
  updateStatusbar();
  renderPermButton();
  renderTasks(res.tasks);
  forkedAt = res.forkedAt || 0;
  renderHistory(res.messages);
  scrollToBottom({ force: true }); // 방을 열 때는 항상 최신 메시지부터
  inputEl.focus();
  refreshHandles(); // @자동완성 준비 (첫 입력을 기다리지 않게)
})();
