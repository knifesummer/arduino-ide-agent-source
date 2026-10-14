// @ts-check
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  windowsSigningArgs,
  writeWindowsStartupRepair,
} = require('../scripts/windows-startup');

const powershell = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
);

describe('Windows 启动修复发布配置', () => {
  it('有证书时强制启用签名，无证书时保留本地构建', () => {
    assert.deepEqual(windowsSigningArgs({}), []);
    for (const key of ['CSC_LINK', 'WIN_CSC_LINK']) {
      assert.deepEqual(windowsSigningArgs({ [key]: 'test-certificate' }), [
        '-c.win.signAndEditExecutable',
        'true',
        '-c.forceCodeSigning',
        'true',
      ]);
    }
  });
});

(process.platform === 'win32' ? describe : describe.skip)(
  'Windows 启动修复工具',
  function () {
    this.timeout(30000);
    /** @type {string} */
    let directory;
    const files = ['Arduino IDE Agent.exe', 'Arduino IDE Agent Core.exe'];

    beforeEach(() => {
      directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'arduino-startup-test-')
      );
      // 使用有空格和中文的子目录覆盖真实解压路径。
      directory = path.join(directory, '中文应用 folder');
      fs.mkdirSync(directory);
      for (const file of files) {
        fs.writeFileSync(path.join(directory, file), `test fixture: ${file}`);
      }
      fs.writeFileSync(path.join(directory, 'unrelated.exe'), 'unrelated file');
      writeWindowsStartupRepair(directory);
      command(
        "$taskZone='[ZoneTransfer]' + [char]13 + [char]10 + 'ZoneId=3'; " +
          "Get-ChildItem -LiteralPath $env:ARDUINO_AGENT_TEST_DIRECTORY -Filter '*.exe' | ForEach-Object { Set-Content -LiteralPath $_.FullName -Stream Zone.Identifier -Value $taskZone }"
      );
    });

    afterEach(() => {
      const root = path.dirname(directory);
      assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith('arduino-startup-test-'));
      fs.rmSync(root, { recursive: true, force: true });
    });

    /** @param {string[]} args */
    function run(args) {
      return spawnSync(
        powershell,
        ['-NoLogo', '-NoProfile', '-NonInteractive', ...args],
        {
          cwd: directory,
          encoding: 'utf8',
          timeout: 15000,
          windowsHide: true,
          windowsVerbatimArguments: true,
          env: { ...process.env, ARDUINO_AGENT_TEST_DIRECTORY: directory },
        }
      );
    }

    /** @param {string} script */
    function command(script) {
      const result = run(['-Command', script]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return result.stdout;
    }

    /** @param {string} filename */
    function fileHash(filename) {
      return crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(directory, filename)))
        .digest('hex');
    }

    it('只读检查不会解除锁定，普通修复只修改两个匹配文件的下载标记', () => {
      const check = run(['-File', 'repair-startup.ps1', '-CheckOnly']);
      assert.equal(check.status, 0, check.stdout + check.stderr);
      assert.ok(JSON.parse(check.stdout).every((file) => file.DownloadMarked));
      const originalHashes = files.map(fileHash);
      const repair = run(['-File', 'repair-startup.ps1']);
      assert.equal(repair.status, 0, repair.stdout + repair.stderr);
      assert.deepEqual(files.map(fileHash), originalHashes);
      const after = run(['-File', 'repair-startup.ps1', '-CheckOnly']);
      assert.ok(JSON.parse(after.stdout).every((file) => !file.DownloadMarked));
      const unrelated = command(
        "@(Get-Item -LiteralPath (Join-Path $env:ARDUINO_AGENT_TEST_DIRECTORY 'unrelated.exe') -Stream Zone.Identifier).Count"
      );
      assert.equal(unrelated.trim(), '1');
      const backups = fs
        .readdirSync(directory)
        .filter((file) => file.startsWith('.agent-startup-unblock-backup-'));
      assert.equal(backups.length, 1);
      const saved = JSON.parse(
        fs
          .readFileSync(path.join(directory, backups[0]), 'utf8')
          .replace(/^\ufeff/, '')
      );
      assert.equal(saved.length, 2);
      assert.ok(
        saved.every((file) => file.ZoneIdentifier.includes('ZoneId=3'))
      );
      const again = run(['-File', 'repair-startup.ps1']);
      assert.equal(again.status, 0, again.stdout + again.stderr);
      assert.equal(
        fs
          .readdirSync(directory)
          .filter((file) => file.startsWith('.agent-startup-unblock-backup-'))
          .length,
        1
      );
    });

    it('任一启动文件被修改时保留全部下载标记', () => {
      fs.appendFileSync(path.join(directory, files[1]), 'changed');
      const repair = run(['-File', 'repair-startup.ps1']);
      assert.equal(repair.status, 1);
      const count = command(
        "@(Get-ChildItem -LiteralPath $env:ARDUINO_AGENT_TEST_DIRECTORY -Filter '*.exe' | ForEach-Object { Get-Item -LiteralPath $_.FullName -Stream Zone.Identifier }).Count"
      );
      assert.equal(count.trim(), '3');
      assert.equal(
        fs
          .readdirSync(directory)
          .filter((file) => file.startsWith('.agent-startup-unblock-backup-'))
          .length,
        0
      );
    });

    it('签名或资源更新后重新生成对应文件的校验值', async () => {
      fs.appendFileSync(path.join(directory, files[0]), 'signed');
      const afterSign = require('../scripts/notarize').default;
      await afterSign({ electronPlatformName: 'win32', appOutDir: directory });
      const check = run(['-File', 'repair-startup.ps1', '-CheckOnly']);
      assert.equal(check.status, 0, check.stdout + check.stderr);
      assert.equal(
        JSON.parse(check.stdout)[0].SHA256.toLowerCase(),
        fileHash(files[0])
      );
    });

    it('批处理入口可在 Windows PowerShell 5.1 下修复并校验配套脚本', () => {
      const result = spawnSync(
        'cmd.exe',
        ['/d', '/c', 'call "修复启动提示.cmd"'],
        {
          cwd: directory,
          input: '\r\n',
          encoding: 'utf8',
          timeout: 15000,
          windowsHide: true,
          windowsVerbatimArguments: true,
        }
      );
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const after = run(['-File', 'repair-startup.ps1', '-CheckOnly']);
      assert.ok(JSON.parse(after.stdout).every((file) => !file.DownloadMarked));
      fs.appendFileSync(
        path.join(directory, 'repair-startup.ps1'),
        '# changed'
      );
      const tampered = spawnSync(
        'cmd.exe',
        ['/d', '/c', 'call "修复启动提示.cmd"'],
        {
          cwd: directory,
          input: '\r\n',
          encoding: 'utf8',
          timeout: 15000,
          windowsHide: true,
        }
      );
      assert.equal(tampered.status, 1, tampered.stdout + tampered.stderr);
    });
  }
);
