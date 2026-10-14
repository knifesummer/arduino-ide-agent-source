// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const { writeWindowsStartupRepair } = require('./windows-startup');

/**
 * Electron 27 on affected Windows builds needs Chromium switches before the
 * Electron main process starts. The native launcher supplies those switches
 * while the Electron core keeps the normal resources layout. A real
 * Authenticode certificate can be supplied through electron-builder's CSC_*
 * settings for release builds; the launcher remains usable for local ZIPs.
 *
 * @param {{ appOutDir: string, electronPlatformName: string }} context
 */
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') {
    return;
  }

  const appName = 'Arduino IDE Agent.exe';
  const coreName = 'Arduino IDE Agent Core.exe';
  const appPath = path.join(context.appOutDir, appName);
  const corePath = path.join(context.appOutDir, coreName);
  const launcherPath = path.resolve(__dirname, '..', 'launcher', appName);

  if (fs.existsSync(appPath) && !fs.existsSync(corePath)) {
    fs.renameSync(appPath, corePath);
  }
  if (!fs.existsSync(corePath)) {
    throw new Error(`Packaged Agent core was not found: ${corePath}`);
  }
  if (!fs.existsSync(launcherPath)) {
    throw new Error(`Agent launcher was not found: ${launcherPath}`);
  }
  fs.copyFileSync(launcherPath, appPath);
  writeWindowsStartupRepair(context.appOutDir);
};
