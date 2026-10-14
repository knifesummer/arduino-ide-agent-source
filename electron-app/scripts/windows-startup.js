// @ts-check
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** @param {NodeJS.ProcessEnv} env */
function windowsSigningArgs(env) {
  if (!env.WIN_CSC_LINK && !env.CSC_LINK) {
    return [];
  }
  // 有证书时启用签名并要求签名成功，避免配置了证书却继续发布未签名文件。
  return [
    '-c.win.signAndEditExecutable',
    'true',
    '-c.forceCodeSigning',
    'true',
  ];
}

/** @param {string} filename */
function sha256(filename) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(filename))
    .digest('hex');
}

/** @param {string} appOutDir */
function writeWindowsStartupRepair(appOutDir) {
  const resources = path.resolve(__dirname, '..', 'resources', 'windows');
  const launcherHash = sha256(path.join(appOutDir, 'Arduino IDE Agent.exe'));
  const coreHash = sha256(path.join(appOutDir, 'Arduino IDE Agent Core.exe'));
  const template = fs.readFileSync(
    path.join(resources, 'repair-startup.ps1.in'),
    'utf8'
  );
  const script = template
    .replace('__LAUNCHER_SHA256__', launcherHash)
    .replace('__CORE_SHA256__', coreHash)
    .replace(/\r?\n/g, '\r\n');
  const scriptPath = path.join(appOutDir, 'repair-startup.ps1');
  // Windows PowerShell 5.1 需要 BOM 才能正确读取中文。
  fs.writeFileSync(scriptPath, '\ufeff' + script, 'utf8');
  const scriptHash = sha256(scriptPath);
  const command = [
    "$ErrorActionPreference='Stop'",
    'try {',
    "Import-Module -Name (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1')",
    "$taskScript=Join-Path $env:ARDUINO_AGENT_REPAIR_DIRECTORY 'repair-startup.ps1'",
    `if((Get-FileHash -LiteralPath $taskScript -Algorithm SHA256).Hash -ne '${scriptHash}'){throw '修复脚本校验失败，请重新解压完整发布包。'}`,
    'Unblock-File -LiteralPath $taskScript',
    '& $taskScript',
    '} catch { Write-Host $_.Exception.Message -ForegroundColor Red; exit 1 }',
  ].join('; ');
  const batch = [
    '@echo off',
    'setlocal',
    'chcp 65001 >nul',
    'set "ARDUINO_AGENT_REPAIR_DIRECTORY=%~dp0"',
    `powershell.exe -NoLogo -NoProfile -Command "${command}"`,
    'set "ARDUINO_AGENT_REPAIR_RESULT=%errorlevel%"',
    'pause',
    'exit /b %ARDUINO_AGENT_REPAIR_RESULT%',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(appOutDir, '修复启动提示.cmd'), batch, 'utf8');
  fs.copyFileSync(
    path.join(resources, '启动说明.txt'),
    path.join(appOutDir, '启动说明.txt')
  );
}

module.exports = { windowsSigningArgs, writeWindowsStartupRepair };
