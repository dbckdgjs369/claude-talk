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
  document.getElementById('statusbar').textContent = parts.join(' | ') || 'Claude Code';
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
  if (msg.role === 'tool') {
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

function updateTypingIndicator() {
  const existing = messagesEl.querySelector('.typing-indicator');
  const working = roomState === 'working' || roomState === 'starting';
  if (working && !existing) {
    const el = document.createElement('div');
    el.className = 'typing-indicator';
    el.textContent = statusText();
    messagesEl.appendChild(el);
    scrollToBottom();
  } else if (working && existing) {
    existing.textContent = statusText();
  } else if (!working && existing) {
    existing.remove();
  }
}

setInterval(() => {
  const existing = messagesEl.querySelector('.typing-indicator');
  if (existing) existing.textContent = statusText();
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
  document.getElementById('chat-sub').textContent =
    `${room.dir} · ${STATE_LABEL[room.state] || room.state}${model ? ' · ' + model : ''}`;
  document.getElementById('btn-kill').style.opacity = room.state === 'offline' ? 0.4 : 1;
  document.getElementById('btn-stop').classList.toggle('hidden', room.state !== 'working');
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

// ---------- 슬래시 커맨드 자동완성 ----------

const slashMenuEl = document.getElementById('slash-menu');
let slashIndex = 0;

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

function renderSlashMenu() {
  const cands = slashCandidates();
  slashMenuEl.classList.toggle('hidden', cands.length === 0);
  if (cands.length === 0) return;
  slashIndex = Math.min(slashIndex, cands.length - 1);
  slashMenuEl.innerHTML = '';
  cands.forEach((c, i) => {
    const el = document.createElement('div');
    el.className = 'slash-item' + (i === slashIndex ? ' active' : '');
    el.textContent = '/' + c;
    el.onmousedown = (ev) => {
      ev.preventDefault();
      completeSlash(c);
    };
    slashMenuEl.appendChild(el);
  });
  slashMenuEl.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}

function closeSlashMenu() {
  slashMenuEl.classList.add('hidden');
  slashIndex = 0;
}

function completeSlash(cmd) {
  closeSlashMenu();
  if (cmd === 'model') {
    inputEl.value = '';
    openModelPicker();
    return;
  }
  inputEl.value = '/' + cmd + ' ';
  autoGrow();
  inputEl.focus();
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
    const cands = slashCandidates();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      slashIndex = (slashIndex + 1) % cands.length;
      renderSlashMenu();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      slashIndex = (slashIndex - 1 + cands.length) % cands.length;
      renderSlashMenu();
      return;
    }
    if ((e.key === 'Tab' || e.key === 'Enter') && !e.isComposing) {
      const pick = cands[slashIndex];
      // 이미 완성돼 있으면 Enter는 전송으로
      if (pick && !(e.key === 'Enter' && inputEl.value === '/' + pick)) {
        e.preventDefault();
        completeSlash(pick);
        return;
      }
      closeSlashMenu();
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
  renderSlashMenu();
});
inputEl.addEventListener('blur', () => setTimeout(closeSlashMenu, 150));

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
    } else if (!permPickerEl.classList.contains('hidden')) {
      permPickerEl.classList.add('hidden');
    } else if (!slashMenuEl.classList.contains('hidden')) {
      closeSlashMenu();
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
  pendingQueue.push({ text: msg.text, images: msg.images || [] });
  const row = document.createElement('div');
  row.className = 'pending-row';
  const tag = document.createElement('span');
  tag.className = 'pending-tag';
  tag.textContent = '⏳ 대기';
  const body = document.createElement('span');
  body.className = 'pending-text';
  body.textContent = (msg.images?.length ? `📷 사진${msg.images.length}장 ` : '') + (msg.text || '');
  row.append(tag, body);
  pendingBarEl.appendChild(row);
  pendingBarEl.classList.remove('hidden');
}

// 대기줄 메시지가 실제 투입됨 → 대기 영역에서 빼서 대화 흐름에 정식 버블로
ipcRenderer.on('room:queue-flushed', () => {
  const item = pendingQueue.shift();
  pendingBarEl.firstElementChild?.remove();
  if (pendingBarEl.childElementCount === 0) pendingBarEl.classList.add('hidden');
  if (item) {
    appendMessage({ role: 'user', text: item.text, images: item.images, ts: new Date().toISOString() });
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
})();
