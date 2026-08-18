// 플랫폼 차이를 한 곳에 모은다 — claude CLI 기동 셸/환경, 홈 디렉토리, 창 크롬.
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

// process.env.HOME은 Windows에 없다 (USERPROFILE). os.homedir()가 양쪽을 다 커버한다.
const homeDir = () => os.homedir();

// ---------- claude 실행 파일 찾기 (Windows) ----------

// Explorer로 띄운 GUI 앱은 로그인 시점의 PATH를 물려받는다. 설치 직후라 PATH가 아직
// 갱신되지 않았거나 설치 경로가 애초에 PATH에 없으면 `claude`를 못 찾는다.
// → 알려진 설치 위치를 직접 뒤져서 PATH에 얹어준다.
function winClaudeDirs() {
  const home = homeDir();
  return [
    path.join(home, '.local', 'bin'), // 네이티브 설치본
    path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm'), // npm -g
    path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'claude'),
    path.join(home, 'AppData', 'Local', 'Volta', 'bin'),
    path.join(home, 'scoop', 'shims'),
  ];
}

const WIN_EXTS = ['.cmd', '.exe', '.bat', '.ps1', ''];

// claude 실행 파일의 전체 경로. 못 찾으면 null.
function findClaude() {
  if (!isWin) return null; // mac은 로그인 셸이 PATH를 채워주므로 탐색 불필요
  const dirs = [...(process.env.PATH || '').split(path.delimiter).filter(Boolean), ...winClaudeDirs()];
  for (const d of dirs) {
    for (const ext of WIN_EXTS) {
      const p = path.join(d, 'claude' + ext);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {}
    }
  }
  return null;
}

// claude 자식에게 물려줄 env.
// - CLAUDE* 제거: 부모가 Claude Code 세션이면 그 env가 상속돼 transcript 저장이 꺼진다
// - Windows: 알려진 설치 경로를 PATH 앞에 붙여 `claude`가 반드시 잡히게 한다
function claudeEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('CLAUDE') || k === 'npm_config_prefix') delete env[k];
  }
  if (isWin) {
    const cur = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
    const extra = winClaudeDirs().filter((d) => !cur.includes(d));
    // Windows env는 대소문자 무시라 Path/PATH가 섞여 있을 수 있다 → 하나로 정리
    delete env.Path;
    env.PATH = [...cur, ...extra].join(path.delimiter);
  }
  return env;
}

// ---------- 셸 기동 ----------

// 셸 한 줄 명령을 자식으로 띄운다.
// mac/linux: 로그인+인터랙티브 zsh 경유 — fnm/nvm이 심어주는 PATH가 있어야 claude가 잡힌다.
// win: cmd.exe. Windows는 PATH가 프로세스 env로 그대로 상속되므로 로그인 셸 트릭이 불필요하고,
//      claude가 .cmd 셰방 스크립트라 셸 없이는 직접 spawn되지 않는다.
//      인용 처리는 Node의 shell:true 구현(cmd.exe /d /s /c "…" + verbatim)에 맡긴다.
function spawnShell(cmd, opts) {
  if (isWin) {
    return spawn(cmd, [], { ...opts, shell: true, windowsHide: true });
  }
  return spawn('/bin/zsh', ['-ilc', cmd], opts);
}

// claude를 못 찾아 죽은 건지 판별 — 사용자에게 설치 안내를 띄우기 위해
function looksLikeClaudeMissing(stderr) {
  const s = (stderr || '').toLowerCase();
  return (
    s.includes('command not found') ||
    s.includes('is not recognized') ||
    s.includes('내부 또는 외부 명령') ||
    s.includes('cannot find path')
  );
}

const CLAUDE_MISSING_HINT = isWin
  ? 'claude 명령을 찾을 수 없습니다.\nClaude Code CLI를 설치한 뒤 앱을 다시 실행해 주세요.\n  npm i -g @anthropic-ai/claude-code\n설치돼 있는데도 이 메시지가 뜨면 PATH 갱신을 위해 로그아웃 후 다시 로그인해 보세요.'
  : 'claude 명령을 찾을 수 없습니다. Claude Code CLI 설치를 확인해 주세요.';

// ---------- 창 크롬 ----------

// 프레임리스 + 커스텀 헤더를 양 플랫폼에서 유지한다.
// mac은 신호등이 왼쪽 위(hiddenInset), Windows는 오버레이로 오른쪽 위에 네이티브 버튼을 얹는다.
// (Windows에서 hiddenInset은 무시돼 닫기 버튼이 통째로 사라진다 — 반드시 분기해야 한다)
const TITLEBAR_COLORS = {
  dark: { color: '#232428', symbolColor: '#e4e5e8' },
  light: { color: '#f7f8fa', symbolColor: '#1f2023' },
};

const overlayFor = (theme) => ({ ...TITLEBAR_COLORS[theme === 'light' ? 'light' : 'dark'], height: 40 });

function titleBarOptions(theme) {
  if (isMac) return { titleBarStyle: 'hiddenInset' };
  if (isWin) return { titleBarStyle: 'hidden', titleBarOverlay: overlayFor(theme) };
  return {}; // linux: 기본 프레임
}

// 테마 토글 시 오버레이 색을 따라가게 한다 (Windows 전용, 그 외는 no-op)
function applyTitleBarTheme(win, theme) {
  if (!isWin || win.isDestroyed()) return;
  try {
    win.setTitleBarOverlay(overlayFor(theme));
  } catch {}
}

module.exports = {
  isWin,
  isMac,
  homeDir,
  findClaude,
  claudeEnv,
  spawnShell,
  looksLikeClaudeMissing,
  CLAUDE_MISSING_HINT,
  titleBarOptions,
  applyTitleBarTheme,
};
