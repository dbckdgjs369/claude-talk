// Claude Code 세션 jsonl 파싱 레이어.
// jsonl 포맷은 Claude Code 내부 구현이라 버전업 때 바뀔 수 있으므로
// 포맷 지식은 전부 이 파일 안에만 둔다. (확인 기준: Claude Code 2.1.x)
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { homeDir } = require('./platform');
const { isTaskTool } = require('./tasks');
const { parseEnvelope } = require('./mentions');

// cwd → ~/.claude/projects/ 하위 디렉토리명 인코딩.
// macOS 경로는 NFD(분해형)로 오지만 Claude Code는 NFC 기준으로 인코딩함 → 정규화 필수
function encodeProjectDir(cwd) {
  return cwd.normalize('NFC').replace(/[^a-zA-Z0-9-]/g, '-');
}

function projectDirFor(cwd) {
  return path.join(homeDir(), '.claude', 'projects', encodeProjectDir(cwd));
}

function truncate(s, n) {
  s = (s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// tool_use 한 건을 "🔧 Bash · ls -la" 같은 한 줄 요약으로
function summarizeToolUse(item) {
  const input = item.input || {};
  const detail =
    input.command || input.file_path || input.path || input.pattern ||
    input.url || input.query || input.description || input.prompt || '';
  // 원본 줄바꿈 유지 — 접힌 상태(nowrap)에선 한 줄, 펼치면 그대로 보임
  return `${item.name} · ${String(detail).slice(0, 5000)}`;
}

// jsonl 한 줄(파싱된 객체) → 렌더링용 메시지 or 이벤트. 해당 없으면 null.
// 반환: {kind:'msg', role:'user'|'assistant'|'tool', text, ts}
//     | {kind:'event', event:'turn_end', ts}
function parseLine(obj) {
  if (!obj || obj.isSidechain) return null;
  const ts = obj.timestamp || null;

  if (obj.type === 'system' && obj.subtype === 'turn_duration') {
    return { kind: 'event', event: 'turn_end', ts };
  }

  const msg = obj.message;
  if (!msg) return null;

  if (obj.type === 'user' && msg.role === 'user') {
    if (obj.isMeta) return null;
    // 압축 요약본. Claude Code가 /compact 뒤에 "이전 대화는 이랬다"를 user 메시지로 써 넣는데,
    // 내가 친 말이 아니라 모델에게 주는 주입이다. isMeta가 아니라 isCompactSummary가 붙어서
    // 위 필터를 그냥 통과했고, 그 결과 재시작해서 기록을 복원할 때마다 2만 자짜리 영문 요약이
    // 내 말풍선으로 올라왔다. 통째로 숨기지 않고 한 줄로 남기는 이유는, 안 그러면 맥락이 왜
    // 끊겼는지 알 수가 없어서다 — 이 줄 위쪽은 원문이 아니라 요약만 남아 있다는 표시다.
    if (obj.isCompactSummary) return { kind: 'msg', role: 'system', text: '🗜️ 압축됨', ts };
    let text = '';
    let images = [];
    if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
      images = msg.content
        .filter((c) => c.type === 'image' && c.source?.type === 'base64')
        .map((c) => `data:${c.source.media_type};base64,${c.source.data}`);
    }
    text = text.trim();
    // 슬래시 커맨드 전개, 시스템 주입 메시지는 채팅에 안 보이게
    if (!text && images.length === 0) return null;
    if (text.startsWith('<')) return null;
    // 다른 방에서 전달돼 온 말은 내가 한 말이 아니다. 봉투가 씌워져 있으므로
    // 껐다 켜도 발신자를 되살릴 수 있다 (형식은 lib/mentions.js)
    const env = parseEnvelope(text);
    if (env) return { kind: 'msg', role: 'peer', from: env.from, text: env.text, images, ts };
    return { kind: 'msg', role: 'user', text, images, ts };
  }

  if (msg.role === 'assistant' && Array.isArray(msg.content)) {
    const out = [];
    for (const c of msg.content) {
      if (c.type === 'text' && c.text && c.text.trim()) {
        out.push({ kind: 'msg', role: 'assistant', text: c.text.trim(), ts });
      } else if (c.type === 'tool_use') {
        // 할 일 도구는 채팅에 한 줄로 흘리지 않는다 — 별도 패널에서 상태로 보여준다.
        // (TaskUpdate는 taskId/status뿐이라 요약하면 빈 줄이 된다)
        if (isTaskTool(c.name)) out.push({ kind: 'task-op', name: c.name, input: c.input || {}, ts });
        else out.push({ kind: 'msg', role: 'tool', text: summarizeToolUse(c), ts });
      }
    }
    if (out.length === 0) return null;
    return out.length === 1 ? out[0] : out;
  }

  return null;
}

function parseFileSync(file) {
  const items = [];
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return items;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const r = parseLine(obj);
    if (!r) continue;
    if (Array.isArray(r)) items.push(...r);
    else items.push(r);
  }
  return items;
}

// jsonl 파일을 폴링으로 tail하면서 새 라인을 파싱해 emit
class Tailer extends EventEmitter {
  constructor(file, { fromStart = false } = {}) {
    super();
    this.file = file;
    this.offset = fromStart ? 0 : this._size();
    this.buf = '';
    this.timer = setInterval(() => this._poll(), 400);
    this._poll();
  }

  _size() {
    try {
      return fs.statSync(this.file).size;
    } catch {
      return 0;
    }
  }

  _poll() {
    let st;
    try {
      st = fs.statSync(this.file);
    } catch {
      return;
    }
    if (st.size <= this.offset) return;
    const stream = fs.createReadStream(this.file, { start: this.offset, end: st.size - 1, encoding: 'utf8' });
    this.offset = st.size;
    let chunk = '';
    stream.on('data', (d) => (chunk += d));
    stream.on('end', () => {
      this.buf += chunk;
      const lines = this.buf.split('\n');
      this.buf = lines.pop(); // 마지막 조각(미완성 라인)은 보관
      const items = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        const r = parseLine(obj);
        if (!r) continue;
        if (Array.isArray(r)) items.push(...r);
        else items.push(r);
      }
      if (items.length) this.emit('items', items);
    });
  }

  stop() {
    clearInterval(this.timer);
  }
}

// spawn 이후 프로젝트 디렉토리에 새로 생긴 세션 jsonl 찾기 (폴링)
function findNewSessionFile(cwd, sinceMs, cb) {
  const dir = projectDirFor(cwd);
  const timer = setInterval(() => {
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return;
    }
    let best = null;
    for (const f of files) {
      const full = path.join(dir, f);
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.birthtimeMs >= sinceMs - 2000 && (!best || st.birthtimeMs > best.birth)) {
        best = { file: full, sessionId: f.replace('.jsonl', ''), birth: st.birthtimeMs };
      }
    }
    if (best) {
      clearInterval(timer);
      cb(best);
    }
  }, 500);
  return () => clearInterval(timer);
}

function sessionFileFor(cwd, sessionId) {
  return path.join(projectDirFor(cwd), sessionId + '.jsonl');
}

// 세션의 마지막 컨텍스트 크기(usage 합). 방을 열자마자 무게를 보여주려면 필요하다 —
// 세션이 안 떠 있으면 엔진의 실시간 값이 0이라 파일에서 되살린다.
// 뒤에서부터 훑는다: 큰 파일 전체를 파싱할 이유가 없다.
function lastContextTokens(file) {
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n');
  } catch {
    return 0;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i] || !lines[i].includes('"usage"')) continue;
    try {
      const u = JSON.parse(lines[i]).message?.usage;
      if (!u) continue;
      const total =
        (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (total > 0) return total;
    } catch {}
  }
  return 0;
}

module.exports = { encodeProjectDir, projectDirFor, parseLine, parseFileSync, summarizeToolUse, lastContextTokens, Tailer, findNewSessionFile, sessionFileFor, truncate };
