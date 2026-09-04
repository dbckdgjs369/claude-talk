// 방 하나에 영향을 주는 마크다운 파일들을 모은다 ("공지" 패널용).
//
// 방을 열었을 때 이 세션이 뭘 읽고 시작하는지가 지금은 아무데도 안 보인다. 그런데 그게
// 곧 매 요청의 바닥값이다 — 압축 직후에도 안 내려가는 그 49k가 여기서 나온다. 그래서
// 목록만 세는 게 아니라 "항상 읽는 것"과 "이름만 올라가는 것"을 갈라서 보여준다.
//
// Claude Code 내부 규칙을 따라 하는 코드라 버전업 때 어긋날 수 있다. 실제로 뭘 읽었는지는
// claude만 알기 때문에 여기 목록은 근사치다 — 틀려도 방이 망가지진 않는 읽기 전용 정보다.
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const USER_DIR = path.join(HOME, '.claude');

// 토큰 수 어림. 정확히 세려면 토크나이저가 필요한데 그것 때문에 의존성을 들이긴 아깝다.
// 한글은 글자당 대략 1.5토큰, ASCII는 4글자당 1토큰으로 잡는다 — 자릿수만 맞으면 된다.
function estimateTokens(text) {
  let ko = 0;
  for (const ch of text) if (ch.charCodeAt(0) > 0x2e7f) ko++;
  return Math.round(ko * 1.5 + (text.length - ko) / 4);
}

function statFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return { path: file, bytes: Buffer.byteLength(text), tokens: estimateTokens(text), text };
  } catch {
    return null;
  }
}

// CLAUDE.md 안의 @경로 import. 한 줄이 통째로 @로 시작할 때만 친다 — 문장 중간의 @이름은
// 사람 호출이지 import가 아니다. 순환을 막으려고 seen을 물려 가며 깊이 5까지만 따라간다.
function collectImports(file, text, seen, depth = 0) {
  if (depth >= 5) return [];
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^@(\S+)/.exec(line.trim());
    if (!m) continue;
    let p = m[1];
    if (p.startsWith('~/')) p = path.join(HOME, p.slice(2));
    else if (!path.isAbsolute(p)) p = path.resolve(path.dirname(file), p);
    if (seen.has(p)) continue;
    seen.add(p);
    const st = statFile(p);
    if (!st) continue;
    out.push({ ...st, kind: 'import' });
    out.push(...collectImports(p, st.text, seen, depth + 1));
  }
  return out;
}

// cwd에서 위로 올라가며 CLAUDE.md를 줍는다. 홈 위로는 안 올라간다 — /Users나 /까지 뒤지면
// 남의 프로젝트 파일을 이 방 것처럼 보여주게 된다. 가까운 쪽이 나중에 읽히므로 위에서
// 아래(루트→cwd) 순으로 뒤집어 돌려준다.
function claudeMdChain(cwd) {
  const dirs = [];
  let d = path.resolve(cwd);
  for (let i = 0; i < 40; i++) {
    dirs.push(d);
    if (d === HOME || d === path.parse(d).root) break;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  const seen = new Set();
  const out = [];
  // 사용자 전역이 가장 먼저 읽힌다
  for (const f of [path.join(USER_DIR, 'CLAUDE.md')]) {
    const st = statFile(f);
    if (!st) continue;
    seen.add(f);
    out.push({ ...st, kind: 'user' });
    out.push(...collectImports(f, st.text, seen));
  }
  for (const dir of dirs.reverse()) {
    for (const name of ['CLAUDE.md', 'CLAUDE.local.md', path.join('.claude', 'CLAUDE.md')]) {
      const f = path.join(dir, name);
      if (seen.has(f)) continue;
      const st = statFile(f);
      if (!st) continue;
      seen.add(f);
      out.push({ ...st, kind: dir === path.resolve(cwd) ? 'project' : 'ancestor' });
      out.push(...collectImports(f, st.text, seen));
    }
  }
  return out;
}

// 앞머리(frontmatter)의 name/description만 뽑는다. 본문은 호출될 때만 읽히므로 여기선 안 센다.
function frontmatter(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8').slice(0, 4000);
  } catch {
    return null;
  }
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  const body = m ? m[1] : '';
  const get = (k) => {
    const r = new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(body);
    return r ? r[1].trim().replace(/^["']|["']$/g, '') : null;
  };
  return { name: get('name') || path.basename(file, '.md'), description: get('description') || '' };
}

function listDir(dir, pick) {
  let names;
  try {
    names = fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    const f = pick(dir, n);
    if (!f || !fs.existsSync(f)) continue;
    const fm = frontmatter(f);
    if (fm) out.push({ path: f, ...fm });
  }
  return out;
}

const agentsIn = (root) => listDir(path.join(root, 'agents'), (d, n) => (n.endsWith('.md') ? path.join(d, n) : null));
const skillsIn = (root) => listDir(path.join(root, 'skills'), (d, n) => path.join(d, n, 'SKILL.md'));
const commandsIn = (root) => listDir(path.join(root, 'commands'), (d, n) => (n.endsWith('.md') ? path.join(d, n) : null));

// cwd가 없는 방(폴더 미지정)은 전역 것만 나온다 — 그것도 사실이라 그대로 보여준다.
function collectHarness(cwd) {
  const projDir = cwd ? path.join(cwd, '.claude') : null;
  const memory = cwd ? claudeMdChain(cwd) : claudeMdChain(HOME);
  const scope = (root, tag) => (arr) => arr.map((x) => ({ ...x, scope: tag, root }));

  const agents = [...scope(USER_DIR, 'user')(agentsIn(USER_DIR)), ...(projDir ? scope(projDir, 'project')(agentsIn(projDir)) : [])];
  const skills = [...scope(USER_DIR, 'user')(skillsIn(USER_DIR)), ...(projDir ? scope(projDir, 'project')(skillsIn(projDir)) : [])];
  const commands = [...scope(USER_DIR, 'user')(commandsIn(USER_DIR)), ...(projDir ? scope(projDir, 'project')(commandsIn(projDir)) : [])];

  // 항상 읽히는 건 CLAUDE.md뿐이다. 에이전트·스킬·커맨드는 이름과 설명 한 줄만 시스템
  // 프롬프트에 올라가고 본문은 부를 때 읽힌다 — 그래서 바닥값 합계에 본문은 안 넣는다.
  const alwaysTokens = memory.reduce((a, m) => a + m.tokens, 0);
  const listedTokens = [...agents, ...skills, ...commands].reduce(
    (a, x) => a + estimateTokens(`${x.name} ${x.description}`),
    0
  );

  return {
    cwd: cwd || null,
    home: HOME, // 렌더러가 경로를 ~로 줄이는 데 쓴다

    memory: memory.map(({ text, ...m }) => m), // 본문은 안 넘긴다 (IPC로 수십 KB 흘릴 이유가 없다)
    agents,
    skills,
    commands,
    alwaysTokens,
    listedTokens,
  };
}

module.exports = { collectHarness, estimateTokens };
