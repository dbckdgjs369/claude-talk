// 폰 → 맥 사진 업로드용 로컬 HTTP 서버.
//
// 폰에서 찍은 사진을 방에 넣으려면 지금은 카톡으로 나에게 보내고 → PC 카톡에서 받고 →
// Finder에서 찾아 → 앱에 끌어다 놓아야 한다. 그 5단계를 "QR 찍고 고르기"로 줄인다.
//
// 외부 서비스를 안 거친다. 사진이 폰 → 공유기 → 맥으로만 흐르므로 화질 저하도 없고
// 제3자 서버에 남지도 않는다. 대신 같은 Wi-Fi 안에서만 동작한다.
const http = require('http');
const crypto = require('crypto');
const os = require('os');

const MAX_BYTES = 12 * 1024 * 1024; // 폰 원본 여유분 (페이지에서 줄여 보내지만 방어선)
const TOKEN_TTL = 10 * 60 * 1000; // QR 유효 시간

// QR에 넣을 IP. 인터페이스가 여럿이면(가상 브리지·VPN) 엉뚱한 걸 고르기 쉬운데,
// 그러면 폰에서 절대 안 열린다. 실제 기본 경로로 나가는 인터페이스를 우선한다.
function lanAddress() {
  let preferred = null;
  try {
    preferred = require('child_process')
      .execSync('route -n get default 2>/dev/null | awk \'/interface:/{print $2}\'', { encoding: 'utf8' })
      .trim();
  } catch {}

  const ifaces = os.networkInterfaces();
  const pick = (name) => (ifaces[name] || []).find((i) => i.family === 'IPv4' && !i.internal)?.address;

  if (preferred && pick(preferred)) return pick(preferred);
  // 폴백: 사설 대역 중 가상 브리지로 흔한 것(192.168.64.x 등)을 뒤로 미룬다
  const all = Object.entries(ifaces).flatMap(([name, list]) =>
    (list || []).filter((i) => i.family === 'IPv4' && !i.internal).map((i) => ({ name, ...i }))
  );
  const real = all.find((i) => /^en\d/.test(i.name)) || all[0];
  return real?.address || null;
}

class UploadServer {
  constructor() {
    this.server = null;
    this.port = 0;
    this.tokens = new Map(); // token → { roomId, expires }
    this.onPhoto = null; // (roomId, {name, mediaType, base64, caption}) => void
  }

  async start() {
    if (this.server) return this.port;
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this._handle(req, res));
      this.server.on('error', reject);
      // 0.0.0.0으로 열어야 폰에서 붙는다 (127.0.0.1이면 맥 안에서만)
      this.server.listen(0, '0.0.0.0', () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  stop() {
    this.tokens.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  // 방 하나에 대한 일회성 업로드 주소. QR을 닫거나 시간이 지나면 무효가 된다.
  issue(roomId) {
    for (const [t, v] of this.tokens) if (v.expires < Date.now()) this.tokens.delete(t);
    const token = crypto.randomBytes(16).toString('hex');
    this.tokens.set(token, { roomId, expires: Date.now() + TOKEN_TTL });
    return token;
  }

  revoke(token) {
    this.tokens.delete(token);
  }

  urlFor(token) {
    const ip = lanAddress();
    return ip ? `http://${ip}:${this.port}/u/${token}` : null;
  }

  _valid(token) {
    const v = this.tokens.get(token);
    if (!v) return null;
    if (v.expires < Date.now()) {
      this.tokens.delete(token);
      return null;
    }
    return v;
  }

  _handle(req, res) {
    const m = /^\/u\/([a-f0-9]{32})$/.exec((req.url || '').split('?')[0]);
    if (!m) return this._end(res, 404, 'not found');
    const entry = this._valid(m[1]);
    if (!entry) return this._end(res, 410, '만료된 링크입니다. 앱에서 QR을 다시 띄워주세요.');

    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(PAGE);
    }

    if (req.method === 'POST') {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) {
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return this._end(res, 400, 'bad json');
        }
        const { name, mediaType, base64, caption } = body || {};
        if (!base64 || !/^image\/(png|jpeg|gif|webp)$/.test(mediaType || '')) {
          return this._end(res, 400, '지원하지 않는 형식입니다');
        }
        this.onPhoto?.(entry.roomId, { name: name || 'photo.jpg', mediaType, base64, caption: caption || '' });
        return this._end(res, 200, 'ok');
      });
      return;
    }
    return this._end(res, 405, 'method not allowed');
  }

  _end(res, code, msg) {
    res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(msg);
  }
}

// 폰에서 열리는 페이지. 브라우저가 알아서 하도록 두지 않고 canvas로 다시 그린다:
//  - 아이폰 사진은 HEIC라 그대로 보내면 API가 못 받는다 → JPEG로 변환
//  - 원본은 3~8MB라 4.5MB 제한에 자주 걸린다 → 긴 변 1568px로 축소(모델이 어차피 이 크기로 줄임)
const PAGE = `<!DOCTYPE html><html lang="ko"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CC Talk 사진 보내기</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#17181c;color:#e4e5e8;font:16px/1.5 -apple-system,system-ui,sans-serif;
       min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:24px}
  h1{font-size:17px;font-weight:700}
  label{background:#fee500;color:#1a1a1a;font-weight:700;border-radius:14px;padding:16px 28px;font-size:17px}
  input[type=file]{display:none}
  textarea{width:100%;max-width:420px;background:#232428;border:1px solid #2c2d31;border-radius:12px;
           color:#e4e5e8;padding:12px;font:15px/1.4 inherit;resize:none}
  #status{font-size:14px;color:#8b8d93;min-height:22px;text-align:center}
  #preview{max-width:70vw;max-height:34vh;border-radius:12px;display:none}
  .ok{color:#4ccb6b}.err{color:#e5493a}
</style></head><body>
<h1>사진을 방에 넣기</h1>
<img id="preview"/>
<label>사진 고르기<input id="f" type="file" accept="image/*"></label>
<textarea id="cap" rows="2" placeholder="같이 보낼 메시지 (선택)"></textarea>
<div id="status">같은 Wi-Fi에 연결돼 있어야 해요</div>
<script>
const MAX_EDGE = 1568;
const st = document.getElementById('status');
document.getElementById('f').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  st.textContent = '변환 중…'; st.className = '';
  try {
    const bmp = await createImageBitmap(file);            // HEIC도 여기서 디코드된다
    const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
    const cv = document.createElement('canvas');
    cv.width = Math.round(bmp.width * scale);
    cv.height = Math.round(bmp.height * scale);
    cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
    const dataUrl = cv.toDataURL('image/jpeg', 0.85);     // 항상 JPEG로 통일
    document.getElementById('preview').src = dataUrl;
    document.getElementById('preview').style.display = 'block';
    st.textContent = '보내는 중…';
    const r = await fetch(location.pathname, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: file.name.replace(/\\.[^.]+$/, '') + '.jpg',
        mediaType: 'image/jpeg', base64: dataUrl.split(',')[1],
        caption: document.getElementById('cap').value.trim() }),
    });
    if (!r.ok) throw new Error(await r.text());
    st.textContent = '보냈어요. 맥 화면을 확인하세요'; st.className = 'ok';
  } catch (err) {
    st.textContent = '실패: ' + (err.message || err); st.className = 'err';
  }
};
</script></body></html>`;

module.exports = { UploadServer, lanAddress };
