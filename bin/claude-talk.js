#!/usr/bin/env node
// `claude`처럼 현재 폴더에서 바로 채팅방을 여는 진입점.
//
//   cd ~/projects/foo && claude-talk    → foo 방이 열린다 (없으면 만들어서)
//
// 앱이 이미 떠 있으면 새 프로세스는 single-instance 락에 걸려 즉시 죽고,
// argv만 원본 프로세스로 넘어가 거기서 방이 열린다 (main.js의 second-instance).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const APP_NAME = 'CC Talk';
const REPO_ROOT = path.join(__dirname, '..');

const args = process.argv.slice(2);

if (args[0] === '-h' || args[0] === '--help') {
  console.log(`사용법: claude-talk [폴더]

  폴더를 생략하면 현재 디렉토리로 채팅방을 연다.
  이미 그 폴더의 방이 있으면 새로 만들지 않고 그 방을 연다.

환경변수:
  CC_TALK_APP   설치된 앱 경로를 직접 지정 (자동 탐색 실패 시)`);
  process.exit(0);
}

// ---------- 열 폴더 ----------

const target = path.resolve(args[0] || process.cwd());
let stat;
try {
  stat = fs.statSync(target);
} catch {
  console.error(`claude-talk: 폴더가 없습니다 — ${target}`);
  process.exit(1);
}
if (!stat.isDirectory()) {
  console.error(`claude-talk: 폴더가 아닙니다 — ${target}`);
  process.exit(1);
}

// ---------- 설치된 앱 찾기 ----------

const exists = (p) => {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
};

function findInstalledApp() {
  if (process.env.CC_TALK_APP && exists(process.env.CC_TALK_APP)) return process.env.CC_TALK_APP;
  const home = os.homedir();
  const candidates =
    process.platform === 'darwin'
      ? [`/Applications/${APP_NAME}.app`, path.join(home, 'Applications', `${APP_NAME}.app`)]
      : process.platform === 'win32'
        ? [
            path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'cc-talk', `${APP_NAME}.exe`),
            path.join(process.env.PROGRAMFILES || 'C:\\Program Files', APP_NAME, `${APP_NAME}.exe`),
          ]
        : [];
  return candidates.find(exists) || null;
}

// 설치본이 없으면 소스에서 바로 띄운다 (개발 중 `npm link` 시나리오)
function findDevElectron() {
  if (!exists(path.join(REPO_ROOT, 'main.js'))) return null;
  try {
    const bin = require(path.join(REPO_ROOT, 'node_modules', 'electron'));
    return typeof bin === 'string' && exists(bin) ? bin : null;
  } catch {
    return null;
  }
}

// ---------- 띄우기 ----------

const detached = { detached: true, stdio: 'ignore' };
const installed = findInstalledApp();

if (installed && process.platform === 'darwin') {
  // -n: 새 인스턴스를 강제로 띄운다. 그래야 argv가 실려서 나가고, 락에 걸려 죽으면서
  //     원본 프로세스로 폴더 경로가 전달된다. -n 없이는 기존 창만 포커스되고 끝난다.
  spawn('open', ['-n', '-a', installed, '--args', `--dir=${target}`], detached).unref();
} else if (installed) {
  spawn(installed, [`--dir=${target}`], detached).unref();
} else {
  const electron = findDevElectron();
  if (!electron) {
    console.error(`claude-talk: ${APP_NAME} 앱을 찾을 수 없습니다.
설치본 경로를 CC_TALK_APP 환경변수로 지정하거나, 소스 폴더에서 \`npm install\` 후 다시 시도해 주세요.`);
    process.exit(1);
  }
  spawn(electron, [REPO_ROOT, `--dir=${target}`], detached).unref();
}
