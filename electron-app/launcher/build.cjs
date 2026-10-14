'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const result = spawnSync(
  'go',
  [
    'build',
    '-trimpath',
    '-buildvcs=false',
    '-ldflags=-H windowsgui -s -w',
    '-o',
    path.join(__dirname, 'Arduino IDE Agent.exe'),
    'main.go',
  ],
  {
    cwd: __dirname,
    env: { ...process.env, GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0' },
    stdio: 'inherit',
    windowsHide: true,
  }
);
if (result.error) console.error('无法运行 Go，请先安装 Go 并配置 PATH。');
else if (result.status === 0) console.log('Windows 启动器编译完成。');
process.exit(result.status ?? 1);
