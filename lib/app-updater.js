'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_UPDATE_CHECK_DELAY_MS = 12 * 1000;
const MAX_UPDATE_BACKUPS = 5;

function safeVersion(value) {
  const normalized = String(value || 'unknown').replace(/[^0-9A-Za-z._-]/g, '-');
  return normalized || 'unknown';
}

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function databaseFiles(sourceRoot) {
  const found = [];
  const visit = directory => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(sourceRoot, absolute);
      const parts = relative.split(path.sep);
      if (parts.includes('backups') || parts.includes('update-backups')) continue;
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.sqlite')) found.push(absolute);
    }
  };
  visit(sourceRoot);
  return found.sort();
}

function pruneOldBackups(backupRoot, keep = MAX_UPDATE_BACKUPS) {
  if (!fs.existsSync(backupRoot)) return;
  const folders = fs.readdirSync(backupRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('pre-update-'))
    .map(entry => entry.name)
    .sort()
    .reverse();
  for (const folder of folders.slice(Math.max(1, Number(keep) || MAX_UPDATE_BACKUPS))) {
    fs.rmSync(path.join(backupRoot, folder), { recursive: true, force: true });
  }
}

function snapshotSqliteData(options = {}) {
  const sourceRoot = path.resolve(String(options.sourceRoot || ''));
  const backupRoot = path.resolve(String(options.backupRoot || ''));
  if (!sourceRoot || !backupRoot || sourceRoot === backupRoot || backupRoot.startsWith(`${sourceRoot}${path.sep}`)) {
    throw new Error('Yeniləmə ehtiyatının qovluğu məlumat qovluğundan ayrı olmalıdır.');
  }
  if (typeof options.checkpoint === 'function') options.checkpoint();
  const files = databaseFiles(sourceRoot);
  if (!files.length) throw new Error('Ehtiyat üçün heç bir SQLite bazası tapılmadı.');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const folderName = `pre-update-${stamp}-to-${safeVersion(options.targetVersion)}`;
  const destinationRoot = path.join(backupRoot, folderName);
  fs.mkdirSync(destinationRoot, { recursive: true });

  const manifestFiles = [];
  for (const sourcePath of files) {
    const relativePath = path.relative(sourceRoot, sourcePath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) throw new Error('Təhlükəsiz olmayan baza yolu aşkarlandı.');
    const destinationPath = path.join(destinationRoot, relativePath);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
    const sourceHash = sha256(sourcePath);
    const destinationHash = sha256(destinationPath);
    if (sourceHash !== destinationHash) throw new Error(`Baza ehtiyatının bütövlük yoxlaması alınmadı: ${relativePath}`);
    manifestFiles.push({ path: relativePath.split(path.sep).join('/'), bytes: fs.statSync(destinationPath).size, sha256: destinationHash });
  }

  const manifest = {
    createdAt: new Date().toISOString(),
    targetVersion: safeVersion(options.targetVersion),
    sourceRoot,
    files: manifestFiles
  };
  fs.writeFileSync(path.join(destinationRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  pruneOldBackups(backupRoot, options.keepBackups);
  return { destinationRoot, manifest };
}

function initializeAppUpdater(options = {}) {
  const { app, ipcMain } = options;
  if (!app || !ipcMain) throw new Error('Updater üçün Electron app və ipcMain tələb olunur.');

  let state = { phase: 'disabled', message: 'Yeniləmə yalnız quraşdırılmış Windows proqramında aktivdir.' };
  let autoUpdater = null;
  let backup = null;

  const publish = next => {
    state = { ...state, ...next, checkedAt: new Date().toISOString() };
    const window = typeof options.getWindow === 'function' ? options.getWindow() : null;
    if (window && !window.isDestroyed()) window.webContents.send('updates:status', state);
    return state;
  };
  const publicError = error => String(error?.message || error || 'Naməlum yeniləmə xətası').replace(/[\r\n]+/g, ' ').slice(0, 300);

  ipcMain.handle('updates:status', () => state);
  ipcMain.handle('updates:check', async () => {
    if (!autoUpdater) return state;
    publish({ phase: 'checking', message: 'Yeni versiya yoxlanılır…' });
    try { await autoUpdater.checkForUpdates(); } catch (error) { publish({ phase: 'error', message: publicError(error) }); }
    return state;
  });
  ipcMain.handle('updates:install', () => {
    if (!autoUpdater || state.phase !== 'ready' || !backup) return { ok: false, reason: 'Yeniləmə quraşdırılmağa hazır deyil.' };
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return { ok: true };
  });

  if (!app.isPackaged || process.platform !== 'win32') return { getState: () => state };

  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (error) {
    publish({ phase: 'error', message: `Yeniləmə modulu açıla bilmədi: ${publicError(error)}` });
    return { getState: () => state };
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('checking-for-update', () => publish({ phase: 'checking', message: 'Yeni versiya yoxlanılır…' }));
  autoUpdater.on('update-available', info => publish({ phase: 'available', version: info.version, progress: 0, message: `v${info.version} endirilir…` }));
  autoUpdater.on('update-not-available', info => publish({ phase: 'current', version: info.version, message: 'Proqram aktualdır.' }));
  autoUpdater.on('download-progress', progress => publish({
    phase: 'downloading',
    progress: Math.max(0, Math.min(100, Number(progress.percent || 0))),
    message: `Yeniləmə endirilir: ${Math.round(Number(progress.percent || 0))}%`
  }));
  autoUpdater.on('update-downloaded', info => {
    try {
      backup = options.createBackup(info.version);
      autoUpdater.autoInstallOnAppQuit = true;
      publish({
        phase: 'ready',
        version: info.version,
        progress: 100,
        backupPath: backup.destinationRoot,
        message: `v${info.version} hazırdır — proqramdan çıxanda avtomatik qurulacaq.`
      });
    } catch (error) {
      backup = null;
      autoUpdater.autoInstallOnAppQuit = false;
      publish({ phase: 'error', message: `Baza ehtiyatı yaradılmadığı üçün yeniləmə dayandırıldı: ${publicError(error)}` });
    }
  });
  autoUpdater.on('error', error => publish({ phase: 'error', message: publicError(error) }));

  const check = () => autoUpdater.checkForUpdates().catch(error => publish({ phase: 'error', message: publicError(error) }));
  const firstTimer = setTimeout(check, FIRST_UPDATE_CHECK_DELAY_MS);
  const interval = setInterval(check, UPDATE_CHECK_INTERVAL_MS);
  firstTimer.unref?.();
  interval.unref?.();
  return { getState: () => state, check };
}

module.exports = {
  MAX_UPDATE_BACKUPS,
  databaseFiles,
  initializeAppUpdater,
  snapshotSqliteData
};
