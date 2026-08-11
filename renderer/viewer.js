const { ipcRenderer } = require('electron');

const key = new URLSearchParams(window.location.search).get('k');
const img = document.getElementById('viewer-img');
const resetBtn = document.getElementById('v-reset');

let scale = 1;
let tx = 0;
let ty = 0;

function apply() {
  img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  resetBtn.textContent = Math.round(scale * 100) + '%';
}

function zoom(factor) {
  scale = Math.min(8, Math.max(0.2, scale * factor));
  apply();
}

function reset() {
  scale = 1;
  tx = 0;
  ty = 0;
  apply();
}

// 휠 = 확대/축소
document.getElementById('viewer-stage').addEventListener('wheel', (e) => {
  e.preventDefault();
  zoom(e.deltaY < 0 ? 1.12 : 1 / 1.12);
}, { passive: false });

// 드래그 = 이동
let dragging = false;
let lastX = 0;
let lastY = 0;
img.addEventListener('mousedown', (e) => {
  dragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
});
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  tx += e.clientX - lastX;
  ty += e.clientY - lastY;
  lastX = e.clientX;
  lastY = e.clientY;
  apply();
});
window.addEventListener('mouseup', () => (dragging = false));

img.addEventListener('dblclick', reset);

document.getElementById('v-in').onclick = () => zoom(1.25);
document.getElementById('v-out').onclick = () => zoom(1 / 1.25);
resetBtn.onclick = reset;
document.getElementById('v-save').onclick = () => ipcRenderer.invoke('image:save', key);

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.close();
  if (e.key === '+' || e.key === '=') zoom(1.25);
  if (e.key === '-') zoom(1 / 1.25);
  if (e.key === '0') reset();
});

(async () => {
  const src = await ipcRenderer.invoke('image:get', key);
  if (src) img.src = src;
  apply();
})();
