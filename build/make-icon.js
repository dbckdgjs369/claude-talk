// 의존성 없이 앱 아이콘 PNG를 그린다 (zlib만 사용). iconutil/electron-builder가 .icns로 변환.
// 구성: 배경 없이 진갈색 말풍선 + 가운데 Claude 심볼(선버스트)만.
// 캔버스 1024 중 실제 그림은 가운데 824 영역 안에만 그린다 — macOS 아이콘 규격의 여백.
// (여백 없이 꽉 채우면 Dock에서 다른 앱보다 커 보인다)
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const S = 1024;
const SS = 3; // 슈퍼샘플링 배수 (안티에일리어싱)

const BROWN = [0x3c, 0x1e, 0x1e];
const ORANGE = [0xd9, 0x77, 0x57]; // Claude 오렌지

// --- 도형 헬퍼: 내부면 true ---
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return Math.hypot(x - cx, y - cy) <= r;
}

// 그림 영역: 가운데 824×824 (여백 100). 말풍선 본체 + 꼬리가 이 안에 딱 들어간다.
const BODY = { x0: 100, y0: 176, x1: 924, y1: 736, r: 168 };
const TAIL = { top: 700, bot: 848, lx: 246, rx: 442 };

// 말풍선 꼬리: 밑변에서 아래로 뻗는 삼각형
function inTail(x, y) {
  if (y < TAIL.top || y > TAIL.bot) return false;
  const t = (y - TAIL.top) / (TAIL.bot - TAIL.top);
  const w = TAIL.rx - TAIL.lx;
  return x >= TAIL.lx + w * t * 0.42 && x <= TAIL.rx - w * t * 0.58;
}

const inBubble = (x, y) => inRoundRect(x, y, BODY.x0, BODY.y0, BODY.x1, BODY.y1, BODY.r) || inTail(x, y);

// Claude 심볼: 중심에서 뻗는 뾰족한 광선 다발
const RAYS = 11;
const CX = (BODY.x0 + BODY.x1) / 2, CY = (BODY.y0 + BODY.y1) / 2, R = 228;
function inBurst(x, y) {
  const dx = x - CX, dy = y - CY;
  const dist = Math.hypot(dx, dy);
  if (dist > R) return false;
  if (dist < 15) return true; // 중심 코어
  const ang = Math.atan2(dy, dx);
  for (let i = 0; i < RAYS; i++) {
    const a = (i / RAYS) * Math.PI * 2 - Math.PI / 2;
    // 광선 축까지의 각도 차
    let d = Math.abs(((ang - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    const t = dist / R; // 0(중심) ~ 1(끝)
    // 중간이 가장 두껍고 끝은 뾰족하게
    const halfWidth = 0.155 * Math.pow(t, 0.45) * Math.pow(1 - t, 0.42) / Math.max(t, 0.10);
    if (d <= halfWidth) return true;
  }
  return false;
}

// --- 렌더 ---
const raw = Buffer.alloc((S * 4 + 1) * S);
let p = 0;
const step = 1 / SS;
for (let py = 0; py < S; py++) {
  raw[p++] = 0; // filter: none
  for (let px = 0; px < S; px++) {
    let bub = 0, sym = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const x = px + (sx + 0.5) * step;
        const y = py + (sy + 0.5) * step;
        if (!inBubble(x, y)) continue;
        bub++;
        if (inBurst(x, y)) sym++;
      }
    }
    const n = SS * SS;
    const aBub = bub / n, aSym = sym / n;
    // 배경은 투명 — 말풍선 안에서만 심볼을 합성한다
    const symRatio = aBub > 0 ? aSym / aBub : 0;
    for (let c = 0; c < 3; c++) {
      const v = BROWN[c] * (1 - symRatio) + ORANGE[c] * symRatio;
      raw[p++] = Math.max(0, Math.min(255, Math.round(v)));
    }
    raw[p++] = Math.round(255 * aBub);
  }
}

// --- PNG 인코딩 ---
let table = null;
function crc32(buf) {
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, 'icon.png');
fs.writeFileSync(out, png);
console.log('wrote', out, png.length, 'bytes');
