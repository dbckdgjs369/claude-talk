// 방 사이 말 전달(@호출명)의 규칙을 한 곳에 모은다.
//
// 방은 여전히 "세션 하나 = 기록 파일 하나"다. 멤버 개념은 없다. 대신 한 방의 답변에서
// @호출명으로 시작하는 부분만 잘라 상대 방의 stdin에 넣는다. 넣을 때 봉투를 씌우므로
// 그 말은 상대 방의 기록 파일에 그대로 남고, 방을 다시 열거나 앱을 껐다 켜도
// "누가 보낸 말풍선"인지 복원할 수 있다.

// ---------- 호출명 ----------

// 폴더명 → 호출명. 한글을 남기는 이유는 폴더명이 한글인 방이 흔해서다.
function slugify(name) {
  const s = String(name || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/, '');
  return s || 'room';
}

function uniqueHandle(base, taken) {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const c = `${base}-${i}`;
    if (!taken.has(c)) return c;
  }
  return base + '-' + Date.now();
}

// "@프론트한테" 처럼 조사가 공백 없이 붙는 게 한국어의 기본이라, 일반 문자 클래스로
// 호출명 경계를 그으면 조사까지 먹는다. 알려진 호출명 중 가장 긴 것을 접두사로 맞춘다.
function sortedHandles(handles) {
  return [...new Set(handles)].filter(Boolean).sort((a, b) => b.length - a.length);
}

function handleAt(text, i, sorted) {
  for (const h of sorted) if (text.startsWith(h, i)) return h;
  return null;
}

// ---------- 봉투 ----------
//
// 이 형식은 상대 방의 기록 파일에 영구히 남는다. 바꾸면 과거 기록의 발신자 귀속이
// 깨지므로(내 말풍선으로 보이게 된다) 함부로 손대지 말 것.

const ENVELOPE_RE = /^\[@(.+?) 방에서\]\n?/;
const HINT_RE = /\n*\(답장하려면[\s\S]*?\)\s*$/;

function wrapEnvelope(from, body) {
  return (
    `[@${from} 방에서]\n${body}\n\n` +
    `(답장하려면 답변에 "@${from}" 로 시작하는 줄을 쓰세요. 안 쓰면 전달되지 않습니다.)`
  );
}

function parseEnvelope(text) {
  const s = String(text || '');
  const m = ENVELOPE_RE.exec(s);
  if (!m) return null;
  return { from: m[1], text: s.slice(m[0].length).replace(HINT_RE, '').trim() };
}

// ---------- 멘션 찾기 ----------

// 사용자 말에 섞인 @호출명. "@프론트한테 물어봐" 처럼 조사가 붙어도 잡힌다.
function findMentions(text, handles) {
  const sorted = sortedHandles(handles);
  const s = String(text || '');
  const hit = new Set();
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '@') continue;
    const h = handleAt(s, i + 1, sorted);
    if (h) {
      hit.add(h);
      i += h.length;
    }
  }
  return [...hit];
}

// @로 시작하지만 방 이름이 아닌 것들 — 오타를 사용자에게 알려주는 데만 쓴다.
// 코드에 흔한 at-word는 걸러야 붙여넣기마다 경고가 뜨지 않는다.
const NOT_HANDLES = new Set([
  'media', 'import', 'use', 'param', 'params', 'returns', 'return', 'override', 'types', 'type',
  'keyframes', 'supports', 'charset', 'font-face', 'namespace', 'apply', 'tailwind', 'layer',
  'see', 'throws', 'deprecated', 'example', 'author', 'since', 'todo', 'ts-ignore', 'ts-expect-error',
  'eslint-disable', 'property', 'default', 'link', 'inheritdoc', 'component', 'input', 'output',
  'me', 'all', 'here', 'channel', 'everyone', 's', 'v',
]);

function unknownMentions(text, handles) {
  const sorted = sortedHandles(handles);
  const s = String(text || '');
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '@') continue;
    // foo@bar.com 같은 주소는 멘션이 아니다 — @ 앞이 공백이 아니면 건너뛴다
    if (i > 0 && /\S/.test(s[i - 1])) continue;
    if (handleAt(s, i + 1, sorted)) continue;
    const tok = /^[^\s@]{1,32}/.exec(s.slice(i + 1))?.[0];
    if (!tok) continue;
    // 알려진 이름이면 조사까지 정확히 떼어낼 수 있지만(handleAt), 모르는 이름은 경계를
    // 알 수 없다. 안내 문구에 "@프론드한테 라는 방이 없어요"로 나가지 않게 흔한 조사만 턴다.
    const bare = tok
      .replace(/[.,!?)\]}:;'"]+$/, '')
      .replace(/(한테서|에게서|한테|에게|이랑|하고|께서|랑|께)$/, '');
    if (bare.length < 2 || NOT_HANDLES.has(bare.toLowerCase())) continue;
    out.push(bare);
  }
  return [...new Set(out)];
}

// ---------- 답변에서 전달할 부분 잘라내기 ----------
//
// 규칙: "@호출명" 으로 시작하는 줄부터, 다음 "@호출명" 줄(또는 답변 끝)까지.
// 빈 줄로 끊지 않는 이유는 여러 문단짜리 보고를 그대로 넘길 수 있어야 해서다.
// 이 규칙은 relayRule()로 발신 세션에도 그대로 알려준다 — 양쪽이 같은 약속을 봐야 한다.
function extractRelays(text, handles) {
  const sorted = sortedHandles(handles);
  const lines = String(text || '').split('\n');
  const marks = [];
  let inFence = false;
  lines.forEach((line, idx) => {
    // 코드블록 안의 @데코레이터를 전달로 오해하지 않게
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const at = /^[ \t]{0,3}@/.exec(line)?.[0].length;
    if (!at) return;
    const h = handleAt(line, at, sorted);
    if (h) marks.push({ idx, handle: h, rest: line.slice(at + h.length).replace(/^[ \t:,·-]+/, '') });
  });

  const out = [];
  marks.forEach((m, k) => {
    const end = k + 1 < marks.length ? marks[k + 1].idx : lines.length;
    const body = [m.rest, ...lines.slice(m.idx + 1, end)].join('\n').trim();
    if (body) out.push({ handle: m.handle, body });
  });
  return out;
}

// 답변 하나가 유발하는 전달을 계획한다 — 어디로 무엇을 보낼지, 무엇을 상한에 막을지.
//
// 상한이 필요한 이유: A가 @B를, B가 @A를 쓰면 사람이 끼지 않고도 끝없이 오간다. 에이전트
// 루프는 호출마다 컨텍스트 전량을 다시 읽으므로 방치하면 곧장 토큰 폭주다. 사용자 발언
// 하나가 유발할 수 있는 전달 횟수를 묶고, 사용자가 다시 말을 걸면 0에서 다시 센다.
function planRelays(text, handles, { fromHandle = null, priorHops = 0, maxHops = 6 } = {}) {
  const hops = priorHops + 1;
  const sends = [];
  const blocked = [];
  for (const r of extractRelays(text, handles)) {
    if (r.handle === fromHandle) continue; // 자기 자신 멘션은 전달이 아니다
    if (hops > maxHops) blocked.push(r.handle);
    else sends.push(r);
  }
  return { hops, sends, blocked };
}

// 사용자 말에 @호출명이 섞인 턴에만 stdin에 덧붙이는 안내 (말풍선에는 안 보인다).
// 이게 없으면 "@프론트한테 물어봐"에 대해 "네, 물어보겠습니다"로만 답하고 끝난다 —
// 전달이 어떻게 일어나는지 모르니까.
function relayRule(handles) {
  const list = handles.map((h) => `@${h}`).join(', ');
  return (
    `[전달 규칙] ${list} 은(는) 이 앱의 다른 채팅방입니다. 그 방에 보낼 말은 답변에서 ` +
    `"@호출명" 으로 시작하는 줄부터 쓰세요. 그 줄부터 다음 "@호출명" 줄(또는 답변 끝)까지가 ` +
    `그 방으로 전달되고, 앞부분은 사용자만 봅니다. 보낼 내용이 없으면 쓰지 마세요.`
  );
}

module.exports = {
  slugify,
  uniqueHandle,
  wrapEnvelope,
  parseEnvelope,
  findMentions,
  unknownMentions,
  extractRelays,
  planRelays,
  relayRule,
};
