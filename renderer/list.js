const { ipcRenderer } = require('electron');

const roomListEl = document.getElementById('room-list');
const rooms = new Map();

// 헤더 여백이 창 버튼 위치를 따라가게 (mac=왼쪽 신호등, Windows=오른쪽 오버레이)
document.body.classList.add(process.platform === 'win32' ? 'win' : 'mac');

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    let h = d.getHours();
    const ampm = h < 12 ? '오전' : '오후';
    h = h % 12 || 12;
    return `${ampm} ${h}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

// Claude 픽셀 캐릭터 아바타. 방 ID 해시로 포즈가 갈린다 (같은 방은 항상 같은 포즈).
const AVATAR_POSES = 6;

function claudeAvatar(key) {
  let h = 0;
  for (const ch of String(key)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  const pose = h % AVATAR_POSES;

  const O = '#d97757'; // Claude 오렌지
  const D = '#2b1a16'; // 눈
  const px = (x, y, w, hh, fill) => `<rect x="${x}" y="${y}" width="${w}" height="${hh}" fill="${fill}"/>`;

  const parts = [px(3, 3, 10, 7, O)]; // 몸통

  // 양옆 팔 — 포즈에 따라 한쪽을 위로 든다
  parts.push(px(2, pose === 4 ? 3 : 5, 1, 2, O));
  parts.push(px(13, pose === 5 ? 3 : 5, 1, 2, O));

  // 눈 — 정면/좌/우 보기, 윙크
  const dx = pose === 1 ? -1 : pose === 2 ? 1 : 0;
  if (pose === 3) {
    parts.push(px(5.5, 5, 1.5, 2.5, D));
    parts.push(px(9.5, 6, 1.5, 1, D)); // 감은 쪽
  } else {
    parts.push(px(5.5 + dx, 5, 1.5, 2.5, D));
    parts.push(px(9.5 + dx, 5, 1.5, 2.5, D));
  }

  // 다리 — 포즈에 따라 한쪽을 살짝 든다
  parts.push(px(4.5, 10, 1, pose === 2 ? 1 : 1.6, O));
  parts.push(px(6.5, 10, 1, 1.6, O));
  parts.push(px(8.5, 10, 1, 1.6, O));
  parts.push(px(10.5, 10, 1, pose === 1 ? 1 : 1.6, O));

  return `<svg class="avatar-char" viewBox="0 0 16 16" shape-rendering="crispEdges">${parts.join('')}</svg>`;
}

// ---------- 방 검색 ----------
// 방 제목(ai-title)·폴더명으로 거른다. 대화 내용은 대상이 아니다 —
// 그건 방 안의 Cmd+F가 하고, 여기서 하면 50개 세션 파일을 다 읽어야 한다.
const searchEl = document.getElementById('list-search');
const searchInputEl = document.getElementById('list-search-input');
let searchQuery = '';

const matchesQuery = (r) => {
  if (!searchQuery) return true;
  const q = searchQuery;
  return (r.title || '').toLowerCase().includes(q) || (r.name || '').toLowerCase().includes(q);
};

function openListSearch() {
  searchEl.classList.remove('hidden');
  searchInputEl.focus();
  searchInputEl.select();
}

function closeListSearch() {
  searchEl.classList.add('hidden');
  searchInputEl.value = '';
  searchQuery = '';
  render();
}

searchInputEl.addEventListener('input', () => {
  searchQuery = searchInputEl.value.trim().toLowerCase();
  render();
});
document.getElementById('list-search-close').onclick = closeListSearch;

function render() {
  const all = [...rooms.values()].sort((a, b) => (b.time || '').localeCompare(a.time || ''));
  const sorted = all.filter(matchesQuery);
  roomListEl.innerHTML = '';
  // 검색 중엔 "방을 만들어봐" 안내가 아니라 결과 없음이 맞다
  document.getElementById('list-empty').classList.toggle('hidden', sorted.length > 0 || !!searchQuery);
  document.getElementById('list-search-count').textContent = searchQuery
    ? sorted.length
      ? `${sorted.length}/${all.length}`
      : '결과 없음'
    : '';
  document.getElementById('list-search-count').classList.toggle('empty', !!searchQuery && sorted.length === 0);

  for (const r of sorted) {
    const el = document.createElement('div');
    el.className = 'room';
    el.onclick = () => ipcRenderer.invoke('room:openWindow', r.id);
    el.oncontextmenu = (e) => {
      e.preventDefault();
      openCtxMenu(e.clientX, e.clientY, r);
    };

    const working = r.state === 'working' || r.state === 'starting';
    const title = r.title || r.name;
    const basePreview = working
      ? (r.activity ? r.activity + '…' : 'Claude가 작업 중이에요')
      : (r.preview || '메시지를 보내 대화를 시작해봐');
    // 제목이 ai-title이면 폴더명을 미리보기 앞에 붙여 구분
    let preview = title !== r.name ? `${r.name} · ${basePreview}` : basePreview;
    // 분기 방은 어디서 갈라졌는지 밝힌다 — 이름이 원본과 비슷해 목록에서 헷갈리기 쉽다
    if (r.forkedFrom) preview = `🌿 ${r.forkedFromName || '삭제된 방'}에서 분기 · ${basePreview}`;

    el.innerHTML = `
      <div class="avatar">${claudeAvatar(r.id || r.name)}<div class="status-dot ${r.state}"></div></div>
      <div class="body">
        <div class="name"></div>
        <div class="preview ${working ? 'typing' : ''}"></div>
      </div>
      <div class="meta">
        <div class="time">${fmtTime(r.time)}</div>
        ${r.unread > 0 ? `<div class="badge">${r.unread}</div>` : ''}
      </div>`;
    el.querySelector('.name').textContent = title;
    el.querySelector('.preview').textContent = preview;
    roomListEl.appendChild(el);
  }
}

// ---------- 우클릭 컨텍스트 메뉴 ----------

const ctxMenuEl = document.getElementById('ctx-menu');
let ctxRoom = null;

function openCtxMenu(x, y, room) {
  ctxRoom = room;
  ctxMenuEl.classList.remove('hidden');
  // 화면 밖으로 안 나가게 위치 보정
  const rect = ctxMenuEl.getBoundingClientRect();
  ctxMenuEl.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
  ctxMenuEl.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
}

function closeCtxMenu() {
  ctxMenuEl.classList.add('hidden');
}

document.addEventListener('click', closeCtxMenu);
window.addEventListener('blur', closeCtxMenu);

ctxMenuEl.addEventListener('click', (e) => {
  const action = e.target.closest('.ctx-item')?.dataset.action;
  closeCtxMenu();
  if (!action || !ctxRoom) return;
  if (action === 'delete') {
    const label = ctxRoom.title || ctxRoom.name;
    if (confirm(`"${label}" 채팅방을 삭제할까?\n대화 기록 파일도 완전히 삭제돼 (터미널 claude --resume에서도 사라짐). 되돌릴 수 없어.`)) {
      ipcRenderer.invoke('rooms:delete', ctxRoom.id);
    }
  } else if (action === 'rename') {
    openRenameModal(ctxRoom);
  } else if (action === 'handle') {
    openHandleModal(ctxRoom);
  } else if (action === 'fork') {
    ipcRenderer.invoke('room:fork', ctxRoom.id).then((res) => {
      if (res?.error) alert(res.error);
    });
  }
});

// ---------- 이름 변경 모달 ----------

// 방 이름과 호출명이 같은 모달을 쓴다 — 입력창 하나에 확인 버튼 하나로 끝나는 같은 모양이다.
const renameModalEl = document.getElementById('rename-modal');
const renameInputEl = document.getElementById('rename-input');
let renameRoom = null;
let renameMode = 'title'; // 'title' | 'handle'

function openModal(room, mode, { value, title, sub }) {
  renameRoom = room;
  renameMode = mode;
  document.getElementById('rename-title').textContent = title;
  document.getElementById('rename-sub').textContent = sub;
  renameInputEl.value = value;
  renameModalEl.classList.remove('hidden');
  renameInputEl.focus();
  renameInputEl.select();
}

function openRenameModal(room) {
  openModal(room, 'title', {
    value: room.title || room.name,
    title: '방 이름 변경',
    sub: '터미널 claude --resume 목록에도 반영돼요',
  });
}

// 호출명 = 다른 방에서 이 방을 부를 이름(@호출명). 방 제목과 따로 두는 이유는
// 제목은 AI가 지어 길고 바뀌는데 멘션은 짧고 안 변해야 하기 때문이다.
function openHandleModal(room) {
  openModal(room, 'handle', {
    value: room.handle || '',
    title: '호출명 변경',
    sub: '다른 방에서 "@이름"으로 이 방을 부를 때 쓰는 이름이에요',
  });
}

function closeRenameModal() {
  renameModalEl.classList.add('hidden');
  renameRoom = null;
}

async function submitRename() {
  const value = renameInputEl.value.trim();
  if (value && renameRoom) {
    if (renameMode === 'handle') {
      const res = await ipcRenderer.invoke('room:setHandle', renameRoom.id, value);
      if (res?.error) {
        alert(res.error);
        return; // 모달을 열어둔다 — 다른 이름을 바로 넣을 수 있게
      }
    } else {
      await ipcRenderer.invoke('room:rename', renameRoom.id, value);
    }
  }
  closeRenameModal();
}

document.getElementById('rename-ok').onclick = submitRename;
document.getElementById('rename-cancel').onclick = closeRenameModal;
renameInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) submitRename();
  if (e.key === 'Escape') {
    e.stopPropagation();
    closeRenameModal();
  }
});
renameModalEl.addEventListener('click', (e) => {
  if (e.target === renameModalEl) closeRenameModal();
});

// ---------- 테마 토글 ----------

let currentTheme = 'dark';
(async () => {
  currentTheme = await ipcRenderer.invoke('theme:get');
  document.body.classList.toggle('light', currentTheme === 'light');
})();
ipcRenderer.on('theme-changed', (e, theme) => {
  currentTheme = theme;
  document.body.classList.toggle('light', theme === 'light');
});
document.getElementById('btn-theme').onclick = () => {
  ipcRenderer.invoke('theme:set', currentTheme === 'light' ? 'dark' : 'light');
};

document.getElementById('btn-new').onclick = async () => {
  const room = await ipcRenderer.invoke('rooms:create');
  if (room) {
    rooms.set(room.id, room);
    render();
  }
};

// ESC 우선순위: 모달 > 메뉴 > 검색 > 목록 창 숨김 (Dock 클릭으로 복귀)
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
    e.preventDefault();
    openListSearch();
    return;
  }
  if (e.key === 'Escape' && !e.isComposing) {
    e.preventDefault();
    const modal = document.getElementById('rename-modal');
    const menu = document.getElementById('ctx-menu');
    if (!modal.classList.contains('hidden')) modal.classList.add('hidden');
    else if (!menu.classList.contains('hidden')) menu.classList.add('hidden');
    else if (!searchEl.classList.contains('hidden')) closeListSearch();
    else ipcRenderer.invoke('main:hide');
  }
  // 검색창에서 Enter → 첫 결과 열기 (목록에서 손 떼지 않고 바로 진입)
  if (e.key === 'Enter' && !e.isComposing && document.activeElement === searchInputEl) {
    e.preventDefault();
    const first = roomListEl.firstElementChild;
    if (first) first.click();
  }
});

ipcRenderer.on('room:update', (e, summary) => {
  rooms.set(summary.id, summary);
  render();
});

ipcRenderer.on('room:removed', (e, id) => {
  rooms.delete(id);
  render();
});

(async () => {
  for (const r of await ipcRenderer.invoke('rooms:list')) rooms.set(r.id, r);
  render();
})();
