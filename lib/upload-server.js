// 폰 → 맥 로컬 HTTP 서버. QR을 찍으면 폰에서 그 방과 대화할 수 있다 (사진도 같이).
//
// 사진: 지금은 카톡으로 나에게 보내고 → PC 카톡에서 받고 → Finder에서 찾아 → 앱에
// 끌어다 놓아야 한다. 그 5단계를 "QR 찍고 고르기"로 줄인다.
// 대화: 자리를 비운 사이 방이 뭘 물어보면 맥 앞으로 돌아가야만 답할 수 있었다.
//
// 외부 서비스를 안 거친다. 폰 → 공유기 → 맥으로만 흐르므로 사진 화질도 안 깎이고
// 대화가 제3자 서버에 남지도 않는다. 대신 같은 Wi-Fi 안에서만 동작한다.
//
// 토큰은 128비트 난수라 같은 Wi-Fi에 있어도 주소를 모르면 못 연다. 다만 QR을 남이
// 찍으면 그 방에 말을 걸 수 있다는 뜻이므로(방 권한이 bypassPermissions면 더더욱),
// 유효 시간을 두고 앱에서 바로 끊을 수 있게 한다.
const http = require('http');
const crypto = require('crypto');
const os = require('os');

const MAX_BYTES = 12 * 1024 * 1024; // 폰 원본 여유분 (페이지에서 줄여 보내지만 방어선)

// 폰 브라우저가 폴링 응답을 캐시하면 대화가 멈춘 것처럼 보인다
const NO_STORE = { 'cache-control': 'no-store' };

// 사진만 보낼 때는 QR을 띄운 그 자리에서 끝나므로 짧아도 됐다. 원격 대화는 자리를 비운
// 동안 쓰는 것이라 짧으면 쓸모가 없다 — 반나절로 두고 앱에서 언제든 끊을 수 있게 했다.
const TOKEN_TTL = 12 * 60 * 60 * 1000;


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
    this.onSend = null; // (roomId, text) => void — 폰에서 친 말을 방에 넣는다
    this.getFeed = null; // (roomId, since) => { seq, items, state, title }
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

  // 이 방에 대해 아직 살아있는 주소인가 (QR을 다시 열 때 같은 걸 보여주기 위함)
  has(roomId, token) {
    if (!token) return false;
    const v = this._valid(token);
    return !!v && v.roomId === roomId;
  }

  // 이 방에 살아있는 주소가 있으면 그 토큰. 창을 닫았다 열면 렌더러는 기억을 잃으므로
  // 메인이 알려줘야 "폰이 붙어 있음" 표시가 유지된다.
  tokenFor(roomId) {
    for (const [t, v] of this.tokens) {
      if (v.roomId === roomId && v.expires > Date.now()) return t;
    }
    return null;
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
    const [pathname, query] = (req.url || '').split('?');
    // /u/<token> 은 페이지, 그 아래 /poll · /send 는 폰이 부르는 창구.
    // 사진 POST는 예전처럼 /u/<token>으로 그대로 온다 (경로를 안 바꿔야 옛 QR도 산다).
    const m = /^\/u\/([a-f0-9]{32})(?:\/(poll|send))?$/.exec(pathname);
    if (!m) return this._end(res, 404, 'not found');
    const entry = this._valid(m[1]);
    if (!entry) return this._end(res, 410, '만료된 링크입니다. 앱에서 QR을 다시 띄워주세요.');
    const sub = m[2];

    if (req.method === 'GET' && !sub) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...NO_STORE });
      return res.end(PAGE);
    }

    // 폴링. 폰은 마지막으로 받은 seq를 들고 오고, 그 뒤에 생긴 것만 돌려준다.
    if (req.method === 'GET' && sub === 'poll') {
      const since = Number(new URLSearchParams(query || '').get('since')) || 0;
      const feed = this.getFeed?.(entry.roomId, since) || { seq: 0, items: [], state: 'offline' };
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', ...NO_STORE });
      return res.end(JSON.stringify(feed));
    }

    if (req.method === 'POST') {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) {
          // 그냥 끊으면 폰에는 "네트워크 오류"로만 보인다. 이유를 주고 끊는다.
          this._end(res, 413, '파일이 너무 큽니다');
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (res.writableEnded) return; // 위에서 413으로 이미 끝냈다
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return this._end(res, 400, 'bad json');
        }

        if (sub === 'send') {
          const text = typeof body?.text === 'string' ? body.text.trim() : '';
          if (!text) return this._end(res, 400, '빈 메시지입니다');
          this.onSend?.(entry.roomId, text);
          return this._end(res, 200, 'ok');
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

// 폰에서 열리는 페이지 — 그 방과 그대로 대화한다. 사진도 여기서 보낸다.
//
// 사진은 브라우저가 알아서 하도록 두지 않고 canvas로 다시 그린다:
//  - 아이폰 사진은 HEIC라 그대로 보내면 API가 못 받는다 → JPEG로 변환
//  - 원본은 3~8MB라 4.5MB 제한에 자주 걸린다 → 긴 변 1568px로 축소(모델이 어차피 이 크기로 줄임)
//
// 새 말은 폴링으로 가져온다. LAN이라 1.2초면 사람이 느끼기엔 즉시고, WebSocket을 쓰면
// 폰 화면이 꺼졌다 켜질 때 끊긴 연결을 되살리는 코드를 따로 써야 해서 얻는 것보다 번거롭다.
const PAGE = `<!DOCTYPE html><html lang="ko"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>CC Talk</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
  body{background:#17181c;color:#e4e5e8;font:16px/1.55 -apple-system,system-ui,sans-serif;
       height:100dvh;display:flex;flex-direction:column;overflow:hidden}
  header{flex-shrink:0;padding:calc(env(safe-area-inset-top) + 10px) 16px 10px;
         background:#1d1e23;border-bottom:1px solid #2c2d31;display:flex;align-items:center;gap:10px}
  #title{font-size:15px;font-weight:700;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #dot{width:8px;height:8px;border-radius:50%;background:#5c5e66;flex-shrink:0}
  #dot.working{background:#f0b429;animation:pulse 1.1s ease-in-out infinite}
  #dot.waiting{background:#4ccb6b}
  @keyframes pulse{50%{opacity:.3}}
  #log{flex:1;overflow-y:auto;padding:14px 12px 4px;display:flex;flex-direction:column;gap:8px;
       -webkit-overflow-scrolling:touch}
  .b{max-width:84%;padding:9px 12px;border-radius:14px;font-size:15px;white-space:pre-wrap;
     word-break:break-word;overflow-wrap:anywhere}
  .b.user{align-self:flex-end;background:#fee500;color:#1a1a1a;border-bottom-right-radius:4px}
  .b.assistant{align-self:flex-start;background:#26272c;border-bottom-left-radius:4px}
  .b.tool{align-self:flex-start;background:none;color:#7e8089;font-size:12.5px;padding:2px 4px;max-width:96%}
  .b.system{align-self:center;background:#2a2118;color:#d9a441;font-size:12.5px;text-align:center}
  .b.peer{align-self:flex-start;background:#1f2a33;border-bottom-left-radius:4px}
  .b .who{display:block;font-size:11px;color:#7e8089;margin-bottom:3px}
  .b img{max-width:100%;border-radius:8px;margin-top:6px;display:block}
  footer{flex-shrink:0;display:flex;gap:8px;align-items:flex-end;padding:8px 10px;
         padding-bottom:calc(env(safe-area-inset-bottom) + 8px);background:#1d1e23;border-top:1px solid #2c2d31}
  #t{flex:1;background:#26272c;border:1px solid #33343a;border-radius:18px;color:#e4e5e8;
     padding:9px 13px;font:15px/1.4 inherit;resize:none;max-height:34vh}
  #t:focus{outline:none;border-color:#4a4b52}
  button,label.btn{flex-shrink:0;border:none;border-radius:18px;font:700 15px inherit;padding:9px 15px;cursor:pointer}
  #send{background:#fee500;color:#1a1a1a}
  #send:disabled{opacity:.4}
  label.btn{background:#26272c;color:#e4e5e8;font-size:19px;padding:7px 12px}
  input[type=file]{display:none}
  #st{flex-shrink:0;font-size:12px;color:#8b8d93;text-align:center;padding:0 12px 6px;min-height:17px}
  #st.err{color:#e5493a}
</style></head><body>
<header><div id="dot"></div><div id="title">연결 중…</div></header>
<div id="log"></div>
<div id="st"></div>
<footer>
  <label class="btn">📷<input id="f" type="file" accept="image/*"></label>
  <textarea id="t" rows="1" placeholder="메시지 입력"></textarea>
  <button id="send">전송</button>
</footer>
<script>
const MAX_EDGE = 1568, BASE = location.pathname.replace(/\\/$/, '');
const logEl = document.getElementById('log'), stEl = document.getElementById('st');
const tEl = document.getElementById('t'), sendEl = document.getElementById('send');
const dotEl = document.getElementById('dot'), titleEl = document.getElementById('title');
let seq = 0, polling = false;

function atBottom() { return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 60; }
function toBottom() { logEl.scrollTop = logEl.scrollHeight; }

function add(m) {
  const stick = atBottom();
  const d = document.createElement('div');
  d.className = 'b ' + (m.role || 'assistant');
  if (m.from) { const w = document.createElement('span'); w.className = 'who'; w.textContent = '@' + m.from; d.appendChild(w); }
  d.appendChild(document.createTextNode(m.text || ''));
  if (m.img) { const i = document.createElement('img'); i.src = m.img; d.appendChild(i); }
  logEl.appendChild(d);
  if (stick) toBottom();
}

function say(msg, bad) { stEl.textContent = msg || ''; stEl.className = bad ? 'err' : ''; }

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const r = await fetch(BASE + '/poll?since=' + seq, { cache: 'no-store' });
    if (r.status === 410) { say('링크가 만료됐어요. 맥에서 QR을 다시 띄워주세요.', 1); clearInterval(timer); return; }
    if (!r.ok) throw new Error(await r.text());
    const d = await r.json();
    titleEl.textContent = d.title || 'CC Talk';
    dotEl.className = d.state === 'working' || d.state === 'starting' ? 'working'
                    : d.state === 'offline' ? '' : 'waiting';
    for (const m of d.items || []) add(m);
    if (d.items?.length) seq = d.seq;
    else if (d.seq > seq) seq = d.seq;
    say('');
  } catch (e) {
    say('연결이 끊겼어요. 같은 Wi-Fi인지 확인해주세요.', 1);
  } finally {
    polling = false;
  }
}

async function send() {
  const text = tEl.value.trim();
  if (!text) return;
  sendEl.disabled = true;
  try {
    const r = await fetch(BASE + '/send', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) throw new Error(await r.text());
    tEl.value = ''; tEl.style.height = 'auto';
    toBottom();
    poll();
  } catch (e) {
    say('보내지 못했어요: ' + (e.message || e), 1);
  } finally {
    sendEl.disabled = false;
  }
}

sendEl.onclick = send;
// 폰에서 Enter는 줄바꿈이어야 한다 — 전송은 버튼으로만. 오타 한 줄이 그대로 나가면 곤란하다.
tEl.addEventListener('input', () => {
  tEl.style.height = 'auto';
  tEl.style.height = Math.min(tEl.scrollHeight, window.innerHeight * 0.34) + 'px';
});

document.getElementById('f').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = ''; // 같은 사진을 다시 고를 수 있게
  say('사진 변환 중…');
  try {
    const bmp = await createImageBitmap(file);            // HEIC도 여기서 디코드된다
    const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
    const cv = document.createElement('canvas');
    cv.width = Math.round(bmp.width * scale);
    cv.height = Math.round(bmp.height * scale);
    cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
    const dataUrl = cv.toDataURL('image/jpeg', 0.85);     // 항상 JPEG로 통일
    say('보내는 중…');
    const r = await fetch(BASE, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: file.name.replace(/\\.[^.]+$/, '') + '.jpg',
        mediaType: 'image/jpeg', base64: dataUrl.split(',')[1],
        caption: tEl.value.trim() }),
    });
    if (!r.ok) throw new Error(await r.text());
    tEl.value = ''; tEl.style.height = 'auto';
    say('');
    poll();
  } catch (err) {
    say('사진 실패: ' + (err.message || err), 1);
  }
};

// 화면을 껐다 켜면 그 사이 온 말을 바로 당겨온다 (타이머는 백그라운드에서 느려진다)
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
const timer = setInterval(poll, 1200);
poll();
</script></body></html>`;

module.exports = { UploadServer, lanAddress, PAGE };
