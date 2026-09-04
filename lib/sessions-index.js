// ~/.claude/projects/ 전체를 스캔해 과거 세션들을 방 후보로 변환.
// 파일 전체를 읽지 않고 head(경로·첫 메시지)와 tail(미리보기·시간)만 읽는다.
const fs = require('fs');
const path = require('path');
const { parseLine, truncate, projectDirFor } = require('./transcript');
const { homeDir } = require('./platform');

const PROJECTS_DIR = path.join(homeDir(), '.claude', 'projects');
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 64 * 1024;
const MAX_SESSIONS = 300; // 안전 상한

function readChunk(file, position, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, position);
    return buf.toString('utf8', 0, read);
  } finally {
    fs.closeSync(fd);
  }
}

// head에서 cwd·첫 사용자 메시지 uuid·ai-title·entrypoint 추출.
// ai-title은 여러 번 기록될 수 있고(제목 갱신·이름 변경) 마지막 것이 유효.
function parseHead(file) {
  let cwd = null;
  let firstUserUuid = null;
  let aiTitle = null;
  let entrypoint = null;
  for (const line of readChunk(file, 0, HEAD_BYTES).split('\n')) {
    try {
      const o = JSON.parse(line);
      if (!cwd && o.cwd) cwd = o.cwd;
      if (o.type === 'user' && o.message?.role === 'user' && !o.isMeta && !o.isSidechain && !o.isCompactSummary) {
        if (!firstUserUuid) firstUserUuid = o.uuid || null;
        if (!entrypoint) entrypoint = o.entrypoint || null;
      }
      if (o.type === 'ai-title' && o.aiTitle) aiTitle = o.aiTitle;
    } catch {}
  }
  return { cwd, firstUserUuid, aiTitle, entrypoint };
}

// 세션 파일의 유효 제목 — 마지막 ai-title (이름 변경은 파일 끝에 추가되므로 tail 우선)
function titleForFile(file) {
  try {
    const size = fs.statSync(file).size;
    return parseTail(file, size).aiTitle || parseHead(file).aiTitle;
  } catch {
    return null;
  }
}

// 방 이름 변경 — Claude Code와 동일하게 ai-title 라인을 파일 끝에 추가 (픽커에도 반영됨)
function renameSession(cwd, sessionId, newTitle) {
  const file = path.join(projectDirFor(cwd), sessionId + '.jsonl');
  try {
    fs.appendFileSync(file, JSON.stringify({ type: 'ai-title', aiTitle: newTitle, sessionId }) + '\n');
    return true;
  } catch {
    return false;
  }
}

// 헤드리스(-p)로 만든 세션은 sdk-cli로 마킹돼 claude --resume 픽커에서 숨겨짐.
// 앱 대화도 터미널에서 보이도록 cli 마킹으로 정규화 (실험으로 검증됨).
function normalizeSdkMarkers(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.includes('"entrypoint":"sdk-cli"') && !raw.includes('"promptSource":"sdk"')) return false;
    const fixed = raw
      .split('"entrypoint":"sdk-cli"').join('"entrypoint":"cli"')
      .split('"promptSource":"sdk"').join('"promptSource":"typed"');
    const tmp = file + '.cctalk-tmp';
    fs.writeFileSync(tmp, fixed);
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

// 세션 파일의 마지막 메시지 미리보기·시각 (터미널 활동 실시간 반영용)
function tailInfoForFile(file) {
  try {
    const size = fs.statSync(file).size;
    return parseTail(file, size);
  } catch {
    return { preview: null, ts: null };
  }
}

// tail에서 마지막 텍스트 메시지(미리보기)·시각·마지막 ai-title(이름 변경 반영) 추출
function parseTail(file, size) {
  const start = Math.max(0, size - TAIL_BYTES);
  const lines = readChunk(file, start, Math.min(TAIL_BYTES, size)).split('\n');
  let preview = null;
  let ts = null;
  let aiTitle = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    let o;
    try {
      o = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!aiTitle && o.type === 'ai-title' && o.aiTitle) aiTitle = o.aiTitle;
    if (preview) continue;
    const r = parseLine(o);
    const arr = Array.isArray(r) ? r : r ? [r] : [];
    for (let j = arr.length - 1; j >= 0; j--) {
      const it = arr[j];
      // system은 압축 구분선 같은 표시라 목록 미리보기에 올라오면 안 된다 (tool과 같은 취급)
      if (it.kind === 'msg' && it.role !== 'tool' && it.role !== 'system' && it.text) {
        // 다른 방에서 온 말이면 밝힌다 — 안 그러면 이 방이 한 말처럼 보인다
        preview = (it.role === 'peer' ? `@${it.from} · ` : '') + truncate(it.text, 60);
        ts = it.ts;
        break;
      }
    }
  }
  return { preview, ts, aiTitle };
}

// head/tail 훑기가 둘 다 실패하는 특이 케이스(이미지 base64 등으로 한 줄이 수 MB)용
// 전체 스캔 폴백. 비싸므로 실패 파일에만, 같은 크기면 재시도 안 함.
const deepScanCache = new Map(); // file → size (마지막으로 실패한 크기)
function deepScan(file, size) {
  if (deepScanCache.get(file) === size) return null;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let cwd = null;
  let firstUserUuid = null;
  let aiTitle = null;
  let preview = null;
  let ts = null;
  for (const line of raw.split('\n')) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!cwd && o.cwd) cwd = o.cwd;
    if (!firstUserUuid && o.type === 'user' && o.message?.role === 'user' && !o.isMeta && !o.isSidechain && !o.isCompactSummary) {
      firstUserUuid = o.uuid || null;
    }
    if (o.type === 'ai-title' && o.aiTitle) aiTitle = o.aiTitle;
    const r = parseLine(o);
    const arr = Array.isArray(r) ? r : r ? [r] : [];
    for (const it of arr) {
      if (it.kind === 'msg' && it.role !== 'tool' && it.role !== 'system' && it.text) {
        preview = (it.role === 'peer' ? `@${it.from} · ` : '') + truncate(it.text, 60);
        ts = it.ts;
      }
    }
  }
  if (!firstUserUuid && !preview) {
    deepScanCache.set(file, size); // 진짜 빈 세션 — 다음엔 스킵
    return null;
  }
  return { cwd, firstUserUuid, aiTitle, preview, ts };
}

function scanPastSessions({ excludeSessionIds = new Set() } = {}) {
  const files = [];
  let dirs;
  try {
    dirs = fs.readdirSync(PROJECTS_DIR);
  } catch {
    return [];
  }
  for (const d of dirs) {
    const full = path.join(PROJECTS_DIR, d);
    let entries;
    try {
      entries = fs.readdirSync(full);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      const sessionId = f.slice(0, -'.jsonl'.length);
      if (excludeSessionIds.has(sessionId)) continue;
      const fp = path.join(full, f);
      let st;
      try {
        st = fs.statSync(fp);
      } catch {
        continue;
      }
      if (st.size < 500) continue; // 빈 껍데기 세션 제외
      files.push({ fp, sessionId, mtime: st.mtimeMs, size: st.size });
    }
  }

  files.sort((a, b) => b.mtime - a.mtime);
  const out = [];
  // 주의: resume 사본도 합치지 않는다 — claude --resume 픽커와 1:1 동일하게 (사용자 결정)
  for (const f of files) {
    if (out.length >= MAX_SESSIONS) break;
    let head;
    try {
      head = parseHead(f.fp);
    } catch {
      continue;
    }
    let tail;
    try {
      tail = parseTail(f.fp, f.size);
    } catch {
      continue;
    }
    // 빈 세션 제외 — 단, 대형 라인 때문에 head/tail 훑기가 실패한 세션은 전체 스캔으로 구제
    // (cwd조차 head에서 못 찾는 케이스 포함: 앞부분이 거대 라인으로 시작하는 파일)
    if (!head.cwd || (!head.firstUserUuid && !tail.preview)) {
      const deep = deepScan(f.fp, f.size);
      if (!deep || !deep.cwd) continue;
      head = { cwd: deep.cwd, firstUserUuid: deep.firstUserUuid, aiTitle: deep.aiTitle };
      tail = { preview: deep.preview, ts: tail.ts || deep.ts, aiTitle: deep.aiTitle };
    }
    if (head.cwd.includes('cc-talk/quota-probe')) continue; // 앱 내부 할당량 프로브 세션 제외
    out.push({
      sessionId: f.sessionId,
      dir: head.cwd,
      name: path.basename(head.cwd).normalize('NFC'),
      aiTitle: tail.aiTitle || head.aiTitle || null,
      preview: tail.preview || '(기록 보기)',
      time: tail.ts || new Date(f.mtime).toISOString(),
    });
  }
  return out;
}

// 세션 기록 파일 삭제 — 1 파일 = 1 방이므로 딱 그 방의 파일만 지운다
function deleteSessionFile(cwd, sessionId) {
  try {
    fs.unlinkSync(path.join(projectDirFor(cwd), sessionId + '.jsonl'));
    return true;
  } catch {
    return false;
  }
}

module.exports = { scanPastSessions, deleteSessionFile, titleForFile, tailInfoForFile, renameSession, normalizeSdkMarkers };
