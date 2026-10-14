// @ts-check
'use strict';

const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const config = require('./package.json').theia.frontend.config;
// Windows 11 26xxx currently aborts Electron 27's Chromium sandbox before
// the main process reaches JavaScript (STATUS_BREAKPOINT 0x80000003). The
// Agent keeps context isolation and disabled Node integration; disable only
// Chromium's OS sandbox so the application can start on this machine.
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu');
  app.disableHardwareAcceleration();
}
// Electron's instance lock uses userData, independently of the CLI config.
// Unsigned development builds can be blocked from creating a new directory
// under AppData by Windows Controlled Folder Access. A portable ZIP is
// writable beside its executable, so use that isolated profile first and
// retain local/temp fallbacks for installed or restricted machines.
app.setName('Arduino IDE Agent');
const userDataCandidates = [
  path.join(path.dirname(process.execPath), 'agent-data'),
  path.join(app.getPath('temp'), 'arduino-ide-agent'),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'arduino-ide-agent'),
  path.join(app.getPath('appData'), 'arduino-ide-agent'),
].filter(Boolean);
let userDataPath;
let userDataError;
for (const candidate of userDataCandidates) {
  try {
    fs.mkdirSync(candidate, { recursive: true });
    userDataPath = candidate;
    break;
  } catch (error) {
    userDataError = error;
  }
}
if (!userDataPath) {
  throw userDataError || new Error('Unable to create the Agent user-data directory');
}
app.setPath('userData', userDataPath);
// Arduino CLI and Theia derive their config root from the home directory.
// Keep that root beside the Agent as well, so a protected Windows profile
// cannot stop startup while the portable build remains self-contained.
let agentHome = path.join(userDataPath, 'home');
try {
  fs.mkdirSync(agentHome, { recursive: true });
} catch {
  agentHome = userDataPath;
}
// Tell the Theia backend where its isolated home is. Keep USERPROFILE
// untouched so Arduino CLI child processes still resolve Windows known
// folders normally.
process.env.ARDUINO_AGENT_HOME = agentHome;
let agentTemp = path.join(userDataPath, 'temp');
try {
  fs.mkdirSync(agentTemp, { recursive: true });
} catch {
  agentTemp = userDataPath;
}
process.env.TEMP = agentTemp;
process.env.TMP = agentTemp;
const startupLog = path.join(userDataPath, 'startup.log');
process.on('uncaughtExceptionMonitor', (error) => {
  try {
    fs.appendFileSync(startupLog, `${new Date().toISOString()} ${error.stack || error}\n`);
  } catch {
    // Startup diagnostics must never prevent the Agent from opening.
  }
});
// `buildDate` is only available in the bundled application.
if (config.buildDate) {
  // `plugins` folder inside IDE2. IDE2 is shipped with these VS Code extensions. Such as cortex-debug, vscode-cpp, and translations.
  process.env.THEIA_DEFAULT_PLUGINS = `local-dir:${path.resolve(
    __dirname,
    'plugins'
  )}`;
  // `plugins` folder inside the `~/.arduinoIDE` folder. This is for manually installed VS Code extensions. For example, custom themes.
  process.env.THEIA_PLUGINS = [
    process.env.THEIA_PLUGINS,
    `local-dir:${path.resolve(agentHome, '.arduinoIDE-Agent', 'plugins')}`,
  ]
    .filter(Boolean)
    .join(',');
}

require('./lib/backend/electron-main');
