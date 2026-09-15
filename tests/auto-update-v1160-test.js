'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { removeTemporaryDirectory } = require('./test-filesystem');
const os = require('node:os');
const path = require('node:path');
const packageJson = require('../package.json');
const {
  databaseFiles,
  readUpdateJournal,
  recoverPendingUpdateData,
  restoreSnapshot,
  snapshotSqliteData,
  verifySnapshot
} = require('../lib/app-updater');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meyar-update-test-'));
try {
  const dataRoot = path.join(root, 'data');
  const backupRoot = path.join(root, 'update-backups');
  const registry = path.join(dataRoot, 'system', 'registry.sqlite');
  const company = path.join(dataRoot, 'companies', 'company-1', 'company.sqlite');
  const historical = path.join(dataRoot, 'companies', 'company-1', 'backups', 'old.sqlite');
  for (const file of [registry, company, historical]) fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(registry, 'registry-database');
  fs.writeFileSync(company, 'company-database');
  fs.writeFileSync(historical, 'historical-backup');

  assert.deepEqual(databaseFiles(dataRoot), [company, registry].sort(), 'only live SQLite databases must be included');
  let checkpointed = false;
  const result = snapshotSqliteData({
    sourceRoot: dataRoot,
    backupRoot,
    targetVersion: '1.17.1',
    checkpoint: () => { checkpointed = true; },
    keepBackups: 5
  });
  assert.equal(checkpointed, true, 'WAL checkpoint must run before copying databases');
  assert.equal(result.manifest.files.length, 2);
  assert.equal(result.manifest.formatVersion, 2);
  assert.equal(result.manifest.totalBytes, Buffer.byteLength('registry-database') + Buffer.byteLength('company-database'));
  for (const file of result.manifest.files) {
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
    assert.equal(fs.existsSync(path.join(result.destinationRoot, ...file.path.split('/'))), true);
  }
  assert.equal(fs.existsSync(path.join(result.destinationRoot, 'manifest.json')), true);
  assert.equal(verifySnapshot(result.destinationRoot).files.length, 2);
  fs.writeFileSync(registry, 'damaged-registry');
  fs.writeFileSync(company, 'damaged-company');
  const restored = restoreSnapshot({ snapshotRoot: result.destinationRoot, destinationRoot: dataRoot });
  assert.equal(restored.restoredFiles, 2);
  assert.equal(fs.readFileSync(registry, 'utf8'), 'registry-database');
  assert.equal(fs.readFileSync(company, 'utf8'), 'company-database');
  const stateFile = path.join(root, 'update-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({
    status: 'prepared',
    targetVersion: '1.17.1',
    backupPath: result.destinationRoot
  }));
  fs.writeFileSync(registry, 'startup-damage');
  fs.writeFileSync(company, 'startup-damage');
  const recovered = recoverPendingUpdateData({ stateFile, currentVersion: '1.17.1', destinationRoot: dataRoot });
  assert.equal(recovered.recovered, true);
  assert.equal(readUpdateJournal(stateFile).status, 'recovered');
  assert.equal(fs.readFileSync(registry, 'utf8'), 'registry-database');
  assert.equal(fs.readFileSync(company, 'utf8'), 'company-database');
  assert.throws(() => snapshotSqliteData({ sourceRoot: '', backupRoot }), /mütləq göstərilməlidir/);
  assert.equal(fs.readdirSync(backupRoot).some(name => name.startsWith('.partial-')), false);

  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'windows-release.yml'), 'utf8');
  assert.equal(packageJson.version, '1.17.1');
  assert.equal(packageJson.dependencies['electron-updater'], '6.8.9');
  assert.equal(packageJson.build.nsis.deleteAppDataOnUninstall, false);
  assert.match(main, /createPreUpdateBackup/);
  assert.match(main, /initializeAppUpdater/);
  assert.match(preload, /updates:install/);
  assert.match(html, /id="updateStatus"/);
  assert.match(workflow, /runs-on: windows-latest/);
  assert.match(workflow, /npm test/);
  console.log('safe Windows installer and auto-update v1.17.1: OK');
} finally {
  removeTemporaryDirectory(root);
}
