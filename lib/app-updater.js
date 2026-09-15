'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const UPDATE_RETRY_INTERVAL_MS = 15 * 60 * 1000;
const FIRST_UPDATE_CHECK_DELAY_MS = 12 * 1000;
const MAX_UPDATE_BACKUPS = 5;
const HASH_BUFFER_BYTES = 1024 * 1024;
const MINIMUM_FREE_SPACE_BYTES = 64 * 1024 * 1024;

function safeVersion(value) {
  const normalized = String(value || 'unknown').replace(/[^0-9A-Za-z._-]/g, '-');
  return normalized || 'unknown';
}

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function safeRelativePath(value) {
  const slashNormalized = String(value || '').replace(/\\/g, '/');
  if (!slashNormalized || slashNormalized.startsWith('/') || slashNormalized.split('/').includes('..')) {
    throw new Error('Təhlükəsiz olmayan nisbi fayl yolu aşkarlandı.');
  }
  const nativePath = slashNormalized.split('/').join(path.sep);
  if (path.isAbsolute(nativePath)) throw new Error('Təhlükəsiz olmayan mütləq fayl yolu aşkarlandı.');
  return nativePath;
}

function databaseFiles(sourceRoot) {
  const found = [];
  const ignoredDirectories = new Set(['backups', 'update-backups', 'recovery-artifacts']);
  const visit = directory => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(sourceRoot, absolute);
      const parts = relative.split(path.sep);
      if (parts.some(part => ignoredDirectories.has(part))) continue;
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.sqlite')) found.push(absolute);
    }
  };
  visit(sourceRoot);
  return found.sort();
}

function copyVerifiedFile(sourcePath, destinationPath, options = {}) {
  const sourceHash = sha256(sourcePath);
  fs.copyFileSync(
    sourcePath,
    destinationPath,
    options.exclusive === false ? 0 : fs.constants.COPYFILE_EXCL
  );
  const destinationHash = sha256(destinationPath);
  if (sourceHash !== destinationHash) {
    try { fs.rmSync(destinationPath, { force: true }); } catch (_) {}
    throw new Error(`Faylın bütövlük yoxlaması alınmadı: ${path.basename(sourcePath)}`);
  }
  return {
    bytes: fs.statSync(destinationPath).size,
    sha256: destinationHash
  };
}

function availableDiskBytes(directory) {
  if (typeof fs.statfsSync !== 'function') return null;
  try {
    const statistics = fs.statfsSync(directory);
    return BigInt(statistics.bavail) * BigInt(statistics.bsize);
  } catch (_) {
    return null;
  }
}

function pruneOldBackups(backupRoot, keep = MAX_UPDATE_BACKUPS) {
  if (!fs.existsSync(backupRoot)) return;
  const retainedCount = Math.max(1, Number(keep) || MAX_UPDATE_BACKUPS);
  const folders = fs.readdirSync(backupRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('pre-update-'))
    .map(entry => entry.name)
    .sort()
    .reverse();
  for (const folder of folders.slice(retainedCount)) {
    fs.rmSync(path.join(backupRoot, folder), { recursive: true, force: true });
  }
}

function snapshotSqliteData(options = {}) {
  const sourceValue = String(options.sourceRoot || '').trim();
  const backupValue = String(options.backupRoot || '').trim();
  if (!sourceValue || !backupValue) throw new Error('Məlumat və ehtiyat qovluqları mütləq göstərilməlidir.');

  const sourceRoot = path.resolve(sourceValue);
  const backupRoot = path.resolve(backupValue);
  if (sourceRoot === backupRoot || backupRoot.startsWith(`${sourceRoot}${path.sep}`)) {
    throw new Error('Yeniləmə ehtiyatının qovluğu məlumat qovluğundan ayrı olmalıdır.');
  }
  if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
    throw new Error('Məlumat qovluğu tapılmadı.');
  }

  if (typeof options.checkpoint === 'function') options.checkpoint();
  const files = databaseFiles(sourceRoot);
  if (!files.length) throw new Error('Ehtiyat üçün heç bir SQLite bazası tapılmadı.');

  fs.mkdirSync(backupRoot, { recursive: true });
  const totalBytes = files.reduce((total, filePath) => total + fs.statSync(filePath).size, 0);
  const freeBytes = availableDiskBytes(backupRoot);
  const requiredBytes = BigInt(totalBytes + MINIMUM_FREE_SPACE_BYTES);
  if (freeBytes !== null && freeBytes < requiredBytes) {
    throw new Error('Yeniləmə ehtiyatı üçün diskdə kifayət qədər boş yer yoxdur.');
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const folderName = `pre-update-${stamp}-to-${safeVersion(options.targetVersion)}`;
  const destinationRoot = path.join(backupRoot, folderName);
  const partialRoot = path.join(backupRoot, `.partial-${folderName}-${process.pid}`);
  fs.mkdirSync(partialRoot, { recursive: false });

  try {
    const manifestFiles = [];
    for (const sourcePath of files) {
      const relativePath = path.relative(sourceRoot, sourcePath);
      if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        throw new Error('Təhlükəsiz olmayan baza yolu aşkarlandı.');
      }
      const destinationPath = path.join(partialRoot, relativePath);
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      const copied = copyVerifiedFile(sourcePath, destinationPath);
      manifestFiles.push({
        path: relativePath.split(path.sep).join('/'),
        bytes: copied.bytes,
        sha256: copied.sha256
      });
    }

    const manifest = {
      formatVersion: 2,
      createdAt: new Date().toISOString(),
      targetVersion: safeVersion(options.targetVersion),
      sourceRoot,
      totalBytes,
      files: manifestFiles
    };
    fs.writeFileSync(
      path.join(partialRoot, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' }
    );
    fs.renameSync(partialRoot, destinationRoot);
    pruneOldBackups(backupRoot, options.keepBackups);
    return { destinationRoot, manifest };
  } catch (error) {
    try { fs.rmSync(partialRoot, { recursive: true, force: true }); } catch (_) {}
    throw error;
  }
}

function verifySnapshot(snapshotRoot) {
  const resolvedRoot = path.resolve(String(snapshotRoot || ''));
  const manifestPath = path.join(resolvedRoot, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('Ehtiyat manifesti tapılmadı.');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Ehtiyat manifestində baza faylı yoxdur.');

  for (const file of manifest.files) {
    const relativePath = safeRelativePath(file.path);
    const snapshotPath = path.join(resolvedRoot, relativePath);
    if (!fs.existsSync(snapshotPath) || !fs.statSync(snapshotPath).isFile()) {
      throw new Error(`Ehtiyat faylı tapılmadı: ${file.path}`);
    }
    if (Number(file.bytes) !== fs.statSync(snapshotPath).size || sha256(snapshotPath) !== String(file.sha256 || '')) {
      throw new Error(`Ehtiyat faylının bütövlüyü pozulub: ${file.path}`);
    }
  }
  return manifest;
}

function restoreSnapshot(options = {}) {
  const snapshotValue = String(options.snapshotRoot || '').trim();
  const destinationValue = String(options.destinationRoot || '').trim();
  if (!snapshotValue || !destinationValue) throw new Error('Bərpa mənbəyi və məlumat qovluğu göstərilməlidir.');

  const snapshotRoot = path.resolve(snapshotValue);
  const destinationRoot = path.resolve(destinationValue);
  if (
    snapshotRoot === destinationRoot ||
    destinationRoot.startsWith(`${snapshotRoot}${path.sep}`) ||
    snapshotRoot.startsWith(`${destinationRoot}${path.sep}`)
  ) {
    throw new Error('Bərpa mənbəyi məlumat qovluğundan tamamilə ayrı olmalıdır.');
  }
  const manifest = verifySnapshot(snapshotRoot);
  const token = `${Date.now()}-${process.pid}`;
  const prepared = [];

  try {
    for (const file of manifest.files) {
      const relativePath = safeRelativePath(file.path);
      const snapshotPath = path.join(snapshotRoot, relativePath);
      const destinationPath = path.join(destinationRoot, relativePath);
      const temporaryPath = `${destinationPath}.restore-${token}.tmp`;
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      copyVerifiedFile(snapshotPath, temporaryPath);
      prepared.push({ destinationPath, temporaryPath, originalPath: `${destinationPath}.restore-${token}.original` });
    }

    const replaced = [];
    try {
      for (const item of prepared) {
        if (fs.existsSync(item.destinationPath)) fs.renameSync(item.destinationPath, item.originalPath);
        try {
          fs.renameSync(item.temporaryPath, item.destinationPath);
          replaced.push(item);
        } catch (error) {
          if (fs.existsSync(item.originalPath)) fs.renameSync(item.originalPath, item.destinationPath);
          throw error;
        }
      }
    } catch (error) {
      for (const item of replaced.reverse()) {
        try { fs.rmSync(item.destinationPath, { force: true }); } catch (_) {}
        if (fs.existsSync(item.originalPath)) fs.renameSync(item.originalPath, item.destinationPath);
      }
      throw error;
    }

    for (const item of prepared) {
      try { fs.rmSync(item.originalPath, { force: true }); } catch (_) {}
      for (const suffix of ['-wal', '-shm']) {
        try { fs.rmSync(`${item.destinationPath}${suffix}`, { force: true }); } catch (_) {}
      }
    }
    return { restoredFiles: prepared.length, manifest };
  } finally {
    for (const item of prepared) {
      try { fs.rmSync(item.temporaryPath, { force: true }); } catch (_) {}
    }
  }
}

function writeJsonAtomic(filePath, value) {
  const resolvedPath = path.resolve(filePath);
  const temporaryPath = `${resolvedPath}.${process.pid}.tmp`;
  const previousPath = `${resolvedPath}.previous`;
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'w' });
  if (fs.existsSync(resolvedPath)) {
    try { fs.rmSync(previousPath, { force: true }); } catch (_) {}
    fs.renameSync(resolvedPath, previousPath);
  }
  try {
    fs.renameSync(temporaryPath, resolvedPath);
    try { fs.rmSync(previousPath, { force: true }); } catch (_) {}
  } catch (error) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch (_) {}
    if (fs.existsSync(previousPath) && !fs.existsSync(resolvedPath)) fs.renameSync(previousPath, resolvedPath);
    throw error;
  }
}

function readUpdateJournal(stateFile) {
  if (!stateFile) return null;
  const readablePath = fs.existsSync(stateFile) ? stateFile : `${stateFile}.previous`;
  if (!fs.existsSync(readablePath)) return null;
  try { return JSON.parse(fs.readFileSync(readablePath, 'utf8')); } catch (_) { return null; }
}

function markUpdateHealthy(stateFile, currentVersion) {
  const journal = readUpdateJournal(stateFile);
  if (!journal || journal.status !== 'prepared' || safeVersion(journal.targetVersion) !== safeVersion(currentVersion)) return false;
  writeJsonAtomic(stateFile, { ...journal, status: 'healthy', healthyAt: new Date().toISOString() });
  return true;
}

function recoverPendingUpdateData(options = {}) {
  const journal = readUpdateJournal(options.stateFile);
  if (!journal || journal.status !== 'prepared') return { recovered: false, reason: 'Bərpa gözləyən yenilənmə yoxdur.' };
  if (safeVersion(journal.targetVersion) !== safeVersion(options.currentVersion)) {
    return { recovered: false, reason: 'Yenilənmə versiyası bərpa jurnalı ilə uyğun deyil.' };
  }
  try {
    const result = restoreSnapshot({ snapshotRoot: journal.backupPath, destinationRoot: options.destinationRoot });
    writeJsonAtomic(options.stateFile, {
      ...journal,
      status: 'recovered',
      recoveredAt: new Date().toISOString(),
      restoredFiles: result.restoredFiles
    });
    return { recovered: true, ...result };
  } catch (error) {
    writeJsonAtomic(options.stateFile, {
      ...journal,
      status: 'recovery-failed',
      recoveryFailedAt: new Date().toISOString(),
      recoveryError: String(error?.message || error).slice(0, 500)
    });
    throw error;
  }
}

function createFileLogger(logFile) {
  if (!logFile) return console;
  const resolvedPath = path.resolve(logFile);
  const write = (level, values) => {
    try {
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
      if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).size > 2 * 1024 * 1024) {
        try { fs.rmSync(`${resolvedPath}.previous`, { force: true }); } catch (_) {}
        fs.renameSync(resolvedPath, `${resolvedPath}.previous`);
      }
      const message = values.map(value => value instanceof Error ? value.stack || value.message : String(value)).join(' ');
      fs.appendFileSync(resolvedPath, `${new Date().toISOString()} [${level}] ${message}\n`, 'utf8');
    } catch (_) {}
  };
  return {
    debug: (...values) => write('DEBUG', values),
    info: (...values) => write('INFO', values),
    warn: (...values) => write('WARN', values),
    error: (...values) => write('ERROR', values)
  };
}

function initializeAppUpdater(options = {}) {
  const { app, ipcMain } = options;
  if (!app || !ipcMain) throw new Error('Updater üçün Electron app və ipcMain tələb olunur.');

  let state = { phase: 'disabled', message: 'Yeniləmə yalnız quraşdırılmış Windows proqramında aktivdir.' };
  let autoUpdater = null;
  let backup = null;
  let targetVersion = '';
  let installAuthorized = false;
  let checkPromise = null;
  let retryTimer = null;
  let firstTimer = null;
  let interval = null;

  const publish = next => {
    state = { ...state, ...next, checkedAt: new Date().toISOString() };
    const window = typeof options.getWindow === 'function' ? options.getWindow() : null;
    if (window && !window.isDestroyed()) window.webContents.send('updates:status', state);
    return state;
  };
  const publicError = error => String(error?.message || error || 'Naməlum yeniləmə xətası').replace(/[\r\n]+/g, ' ').slice(0, 300);

  const prepareInstallBackup = () => {
    if (!autoUpdater || !targetVersion || typeof options.createBackup !== 'function') {
      throw new Error('Yenilənmə ehtiyatı üçün tələb olunan məlumatlar hazır deyil.');
    }
    publish({
      phase: 'preparing',
      version: targetVersion,
      progress: 100,
      message: 'Son məlumatlar yoxlanılır və təhlükəsiz ehtiyat yaradılır…'
    });
    try {
      const createdBackup = options.createBackup(targetVersion);
      if (!createdBackup || typeof createdBackup.then === 'function' || !createdBackup.destinationRoot) {
        throw new Error('Yenilənmə ehtiyatı düzgün nəticə qaytarmadı.');
      }
      verifySnapshot(createdBackup.destinationRoot);
      backup = createdBackup;
      installAuthorized = true;
      autoUpdater.autoInstallOnAppQuit = true;
      if (options.stateFile) {
        writeJsonAtomic(options.stateFile, {
          formatVersion: 1,
          status: 'prepared',
          currentVersion: safeVersion(app.getVersion?.()),
          targetVersion: safeVersion(targetVersion),
          backupPath: backup.destinationRoot,
          preparedAt: new Date().toISOString()
        });
      }
      publish({
        phase: 'ready',
        version: targetVersion,
        progress: 100,
        backupPrepared: true,
        backupPath: backup.destinationRoot,
        canRetryInstall: false,
        message: `v${targetVersion} təhlükəsiz hazırlandı — proqram bağlanır.`
      });
      return backup;
    } catch (error) {
      backup = null;
      installAuthorized = false;
      autoUpdater.autoInstallOnAppQuit = false;
      publish({
        phase: 'error',
        version: targetVersion,
        canRetryInstall: true,
        message: `Baza ehtiyatı yaradılmadığı üçün yeniləmə dayandırıldı: ${publicError(error)}`
      });
      throw error;
    }
  };

  let check = () => Promise.resolve(state);
  ipcMain.handle('updates:status', () => state);
  ipcMain.handle('updates:check', async () => {
    if (!autoUpdater) return state;
    await check();
    return state;
  });
  ipcMain.handle('updates:install', () => {
    const retryableBackupFailure = state.phase === 'error' && state.canRetryInstall === true;
    if (!autoUpdater || !targetVersion || (state.phase !== 'ready' && !retryableBackupFailure)) {
      return { ok: false, reason: 'Yeniləmə quraşdırılmağa hazır deyil.' };
    }
    try {
      if (!installAuthorized) prepareInstallBackup();
      setImmediate(() => autoUpdater.quitAndInstall(false, true));
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: publicError(error) };
    }
  });

  if (!app.isPackaged || process.platform !== 'win32') return { getState: () => state, dispose: () => {} };

  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (error) {
    publish({ phase: 'error', canRetryInstall: false, message: `Yeniləmə modulu açıla bilmədi: ${publicError(error)}` });
    return { getState: () => state, dispose: () => {} };
  }

  autoUpdater.logger = createFileLogger(options.logFile);
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;
  publish({ phase: 'idle', message: 'Yenilənmələri yoxla.', canRetryInstall: false });

  const scheduleRetry = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => check(), UPDATE_RETRY_INTERVAL_MS);
    retryTimer.unref?.();
  };

  autoUpdater.on('checking-for-update', () => publish({ phase: 'checking', message: 'Yeni versiya yoxlanılır…', canRetryInstall: false }));
  autoUpdater.on('update-available', info => {
    targetVersion = safeVersion(info.version);
    publish({ phase: 'available', version: targetVersion, progress: 0, message: `v${targetVersion} endirilir…`, canRetryInstall: false });
  });
  autoUpdater.on('update-not-available', info => {
    targetVersion = '';
    backup = null;
    installAuthorized = false;
    autoUpdater.autoInstallOnAppQuit = false;
    publish({ phase: 'current', version: info.version, message: 'Proqram aktualdır.', canRetryInstall: false });
  });
  autoUpdater.on('download-progress', progress => publish({
    phase: 'downloading',
    progress: Math.max(0, Math.min(100, Number(progress.percent || 0))),
    message: `Yeniləmə endirilir: ${Math.round(Number(progress.percent || 0))}%`,
    canRetryInstall: false
  }));
  autoUpdater.on('update-downloaded', info => {
    targetVersion = safeVersion(info.version);
    backup = null;
    installAuthorized = false;
    autoUpdater.autoInstallOnAppQuit = true;
    if (retryTimer) clearTimeout(retryTimer);
    publish({
      phase: 'ready',
      version: targetVersion,
      progress: 100,
      backupPrepared: false,
      canRetryInstall: false,
      message: `v${targetVersion} hazırdır — çıxış zamanı ən son bazanın ehtiyatı yaradılıb avtomatik qurulacaq.`
    });
  });
  autoUpdater.on('error', error => {
    publish({ phase: 'error', canRetryInstall: false, message: publicError(error) });
    scheduleRetry();
  });

  check = () => {
    if (!autoUpdater) return Promise.resolve(state);
    if (checkPromise) return checkPromise;
    checkPromise = autoUpdater.checkForUpdates()
      .catch(error => {
        publish({ phase: 'error', canRetryInstall: false, message: publicError(error) });
        scheduleRetry();
        return null;
      })
      .finally(() => { checkPromise = null; });
    return checkPromise;
  };

  const beforeQuit = event => {
    if (!autoUpdater || !targetVersion || installAuthorized || state.phase !== 'ready') return;
    try {
      prepareInstallBackup();
    } catch (error) {
      event.preventDefault();
      if (typeof options.onInstallBlocked === 'function') {
        setImmediate(() => options.onInstallBlocked(state.message || publicError(error)));
      }
    }
  };
  app.prependListener('before-quit', beforeQuit);

  firstTimer = setTimeout(() => check(), FIRST_UPDATE_CHECK_DELAY_MS);
  interval = setInterval(() => check(), UPDATE_CHECK_INTERVAL_MS);
  firstTimer.unref?.();
  interval.unref?.();

  const dispose = () => {
    if (firstTimer) clearTimeout(firstTimer);
    if (interval) clearInterval(interval);
    if (retryTimer) clearTimeout(retryTimer);
    app.removeListener('before-quit', beforeQuit);
  };
  app.once('will-quit', dispose);
  return { getState: () => state, check, dispose };
}

module.exports = {
  MAX_UPDATE_BACKUPS,
  copyVerifiedFile,
  databaseFiles,
  initializeAppUpdater,
  markUpdateHealthy,
  readUpdateJournal,
  recoverPendingUpdateData,
  restoreSnapshot,
  sha256,
  snapshotSqliteData,
  verifySnapshot
};
