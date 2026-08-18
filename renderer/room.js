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

const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024; // API 이미지 제한(~5MB) 여유분
let pendingImages = []; // {name, mediaType, base64}

let roomState = 'offline';
let roomInfo = { model: null, slashCommands: [] };
let quota = null; // { session: %, week: % }

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

function appendMessage(msg, { scroll = true } = {}) {
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
  messagesEl.appendChild(el);
  updateTypingIndicator();
  if (scroll) messagesEl.scrollTop = messagesEl.scrollHeight;
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
    messagesEl.scrollTop = messagesEl.scrollHeight;
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
  messagesEl.scrollTop = messagesEl.scrollHeight;
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

// ESC 우선순위: 모델 픽커 > 자동완성 > 창 숨김 (세션은 계속 돌아감)
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !e.isComposing) {
    e.preventDefault();
    if (!pickerEl.classList.contains('hidden')) {
      pickerEl.classList.add('hidden');
    } else if (!slashMenuEl.classList.contains('hidden')) {
      closeSlashMenu();
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
  streamEl = null;
  messagesEl.innerHTML = '';
  for (const m of messages) appendMessage(m, { scroll: false });
  messagesEl.scrollTop = messagesEl.scrollHeight;
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
  for (const m of res.messages) appendMessage(m, { scroll: false });
  messagesEl.scrollTop = messagesEl.scrollHeight;
  inputEl.focus();
})();
