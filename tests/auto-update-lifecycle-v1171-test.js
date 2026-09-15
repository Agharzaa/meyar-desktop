'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { removeTemporaryDirectory } = require('./test-filesystem');
const { initializeAppUpdater, markUpdateHealthy, readUpdateJournal, snapshotSqliteData } = require('../lib/app-updater');

class FakeAutoUpdater extends EventEmitter {
  constructor() {
    super();
    this.autoDownload = false;
    this.autoInstallOnAppQuit = false;
    this.allowDowngrade = true;
    this.allowPrerelease = true;
    this.checkCount = 0;
    this.quitAndInstallCount = 0;
  }

  async checkForUpdates() {
    this.checkCount += 1;
    return { updateInfo: { version: '1.17.1' } };
  }

  quitAndInstall() {
    this.quitAndInstallCount += 1;
  }
}

function fakeApplication() {
  const application = new EventEmitter();
  application.isPackaged = true;
  application.getVersion = () => '1.17.0';
  return application;
}

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, handler) { handlers.set(channel, handler); }
  };
}

function fakeWindow() {
  return {
    sent: [],
    isDestroyed: () => false,
    webContents: {
      send(channel, payload) { this.owner.sent.push({ channel, payload }); },
      owner: null
    }
  };
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meyar-update-lifecycle-'));
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
const originalModuleLoad = Module._load;

async function run() {
  try {
  Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });
  const dataRoot = path.join(temporaryRoot, 'data');
  const databasePath = path.join(dataRoot, 'companies', 'company-1', 'company.sqlite');
  const backupRoot = path.join(temporaryRoot, 'update-backups');
  const stateFile = path.join(temporaryRoot, 'update-state.json');
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  fs.writeFileSync(databasePath, 'database-before-download');

  const application = fakeApplication();
  const ipcMain = fakeIpcMain();
  const updater = new FakeAutoUpdater();
  const window = fakeWindow();
  window.webContents.owner = window;
  let backupCount = 0;

  Module._load = function loadWithUpdaterMock(request, parent, isMain) {
    if (request === 'electron-updater') return { autoUpdater: updater };
    return originalModuleLoad.call(this, request, parent, isMain);
  };
  const controller = initializeAppUpdater({
    app: application,
    ipcMain,
    getWindow: () => window,
    stateFile,
    createBackup: targetVersion => {
      backupCount += 1;
      return snapshotSqliteData({ sourceRoot: dataRoot, backupRoot, targetVersion });
    }
  });

  assert.equal(controller.getState().phase, 'idle');
  assert.equal(updater.autoDownload, true);
  assert.equal(updater.autoInstallOnAppQuit, false);

  updater.emit('update-available', { version: '1.17.1' });
  updater.emit('download-progress', { percent: 67.4 });
  updater.emit('update-downloaded', { version: '1.17.1' });
  assert.equal(controller.getState().phase, 'ready');
  assert.equal(controller.getState().backupPrepared, false);
  assert.equal(backupCount, 0, 'Download completion must not create a stale backup');

  fs.writeFileSync(databasePath, 'latest-database-at-real-exit');
  const quitEvent = {
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }
  };
  application.emit('before-quit', quitEvent);
  assert.equal(quitEvent.defaultPrevented, false);
  assert.equal(backupCount, 1, 'The backup must be created at the actual exit boundary');
  assert.equal(controller.getState().backupPrepared, true);
  const journal = readUpdateJournal(stateFile);
  assert.equal(journal.status, 'prepared');
  assert.equal(journal.targetVersion, '1.17.1');
  assert.equal(
    fs.readFileSync(path.join(journal.backupPath, 'companies', 'company-1', 'company.sqlite'), 'utf8'),
    'latest-database-at-real-exit'
  );
  assert.equal(markUpdateHealthy(stateFile, '1.17.0'), false);
  assert.equal(markUpdateHealthy(stateFile, '1.17.1'), true);
  assert.equal(readUpdateJournal(stateFile).status, 'healthy');

  const installResult = ipcMain.handlers.get('updates:install')();
  assert.deepEqual(installResult, { ok: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(updater.quitAndInstallCount, 1);
  controller.dispose();

  const failingApplication = fakeApplication();
  const failingIpc = fakeIpcMain();
  const failingUpdater = new FakeAutoUpdater();
  let blockedMessage = '';
  Module._load = function loadWithFailingUpdaterMock(request, parent, isMain) {
    if (request === 'electron-updater') return { autoUpdater: failingUpdater };
    return originalModuleLoad.call(this, request, parent, isMain);
  };
  const failingController = initializeAppUpdater({
    app: failingApplication,
    ipcMain: failingIpc,
    getWindow: () => null,
    createBackup: () => { throw new Error('disk write failed'); },
    onInstallBlocked: message => { blockedMessage = message; }
  });
  failingUpdater.emit('update-downloaded', { version: '1.17.1' });
  const blockedQuitEvent = {
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }
  };
  failingApplication.emit('before-quit', blockedQuitEvent);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(blockedQuitEvent.defaultPrevented, true, 'App exit must be blocked when the final backup fails');
  assert.equal(failingUpdater.autoInstallOnAppQuit, false);
  assert.equal(failingController.getState().phase, 'error');
  assert.equal(failingController.getState().canRetryInstall, true);
  assert.match(blockedMessage, /disk write failed/);
  failingController.dispose();

  console.log('automatic update lifecycle v1.17.1: OK');
  } finally {
    Module._load = originalModuleLoad;
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    removeTemporaryDirectory(temporaryRoot);
  }
}

run().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
