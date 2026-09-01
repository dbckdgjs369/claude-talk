#!/usr/bin/env node
// `claude-talk` 명령을 Node 버전과 무관하게 쓰도록 런처를 설치한다.
//
// `npm i -g .`로 깔면 그 명령은 "설치할 때 활성이던 Node의 전역 bin"에만 생긴다.
// 그런데 .nvmrc가 있는 폴더에 들어가면 fnm/nvm이 Node를 바꾸고, 그 Node의 전역 bin에는
// claude-talk이 없어 command not found가 난다. (Node 18을 쓰는 프로젝트에서 실제로 겪음)
//
// 그래서 항상 PATH에 있는 디렉토리에 얇은 셸 스크립트를 두고, 그 안에서 node를 절대 경로로
// 부른다. 이러면 프로젝트가 Node를 몇 번 바꾸든 명령이 사라지지 않는다.
const fs = require('fs');
const os = require('os');
const path = require('path');

const CANDIDATES = [path.join(os.homedir(), '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin'];

function pickDir() {
  const parts = (process.env.PATH || '').split(path.delimiter);
  for (const d of CANDIDATES) {
    if (!parts.includes(d)) continue;
    try {
      fs.mkdirSync(d, { recursive: true });
      fs.accessSync(d, fs.constants.W_OK);
      return d;
    } catch {}
  }
  return null;
}

const dir = pickDir();
if (!dir) {
  console.error('PATH 안에 쓸 수 있는 디렉토리가 없습니다. ~/.local/bin을 만들고 PATH에 추가해 주세요.');
  process.exit(1);
}

const entry = path.join(__dirname, 'claude-talk.js');
const target = path.join(dir, 'claude-talk');
// 지금 이 스크립트를 돌리는 node의 실경로 — fnm_multishells 같은 임시 링크가 아니라 실제 파일
const node = fs.realpathSync(process.execPath);

fs.writeFileSync(
  target,
  `#!/bin/sh
# CC Talk CLI 런처 (npm run link-cli 로 생성됨)
# node를 절대 경로로 부른다 — 프로젝트의 .nvmrc가 Node를 바꿔도 이 명령은 살아 있어야 한다.
NODE=${JSON.stringify(node)}
[ -x "$NODE" ] || NODE="$(command -v node)"
exec "$NODE" ${JSON.stringify(entry)} "$@"
`
);
fs.chmodSync(target, 0o755);

console.log('설치 완료:', target);
console.log('  node :', node);
console.log('  진입점:', entry);
console.log('\n이제 어느 폴더에서든 `claude-talk` 을 쓸 수 있습니다.');
