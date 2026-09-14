'use strict';
// Regression test: the audited v1.12.0 build hardcoded auth:login to accept
// only the single bootstrap 'agarza.admin' account, even though the
// user_accounts schema (company_id, username, role) was built for several
// staff accounts per company. This test drives the real IPC handlers
// (registerAuthIpc / registerIpc, exactly as Electron would call them) to
// prove that: an admin can create additional company users; those users can
// log in on their own username/password; a non-admin cannot create users;
// and the last active admin of a company cannot be deactivated.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { removeTemporaryDirectory } = require('./test-filesystem');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const runtimeSource = source.split('\napp.whenReady().then(()=>{')[0] + `
module.exports = { initMasterDb, registerAuthIpc, registerIpc };`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meyar-users-'));
const handlers = {};
const electronStub = {
  app: { getPath: () => tempRoot, getVersion: () => '1.12.0' },
  BrowserWindow: class {},
  ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; } },
  dialog: {}, shell: {}
};
const localRequire = id => id === 'electron' ? electronStub : id.startsWith('./') ? require(path.join(root,id)) : require(id);
const moduleBox = { exports: {} };
const context = vm.createContext({
  require: localRequire, module: moduleBox, exports: moduleBox.exports,
  __dirname: root, __filename: path.join(root, 'main.js'),
  console, Buffer, URL, setImmediate, clearImmediate, setTimeout, clearTimeout, process
});
new vm.Script(runtimeSource, { filename: 'main.js' }).runInContext(context);
const api = moduleBox.exports;

api.initMasterDb();
api.registerAuthIpc();
api.registerIpc();

async function run() {
  const call = async (channel, payload) => handlers[channel](null, payload);

  const setup = await call('auth:setup', { companyName: 'Test MMC', voen: '1234567890', username: 'agarza.admin', fullName: 'Ağarza Ağalarov', password: 'ownerpass123' });
  assert.equal(setup.ok, true);
  const companyId = setup.company.id;

  // Owner cannot yet be excluded: a random username must still be rejected.
  await assert.rejects(() => call('auth:login', { companyId, username: 'nobody', password: 'ownerpass123' }), /yanlışdır/);
  const directAccess=await call('auth:access',{companyId});
  assert.equal(directAccess.ok,true);
  assert.equal(directAccess.user.username,'agarza.admin');
  assert.equal(directAccess.passwordRequired,false);

  // Owner creates a second, non-admin staff account.
  const created = await call('users:create', { username: 'aysel.mammadova', full_name: 'Aysel Məmmədova', role: 'accountant', password: 'staffpass123' });
  assert.equal(created.username, 'aysel.mammadova');
  assert.equal(created.role, 'accountant');
  const viewer = await call('users:create', { username: 'audit.viewer', full_name: 'Audit Viewer', role: 'viewer', password: 'viewerpass123' });
  assert.equal(viewer.role, 'viewer');

  // The new staff account can now log in on its own credentials - this is
  // exactly the capability that was previously hardcoded shut.
  const staffSession = await call('auth:login', { companyId, username: 'aysel.mammadova', password: 'staffpass123' });
  assert.equal(staffSession.ok, true);
  assert.equal(staffSession.user.role, 'accountant');

  // A non-admin must not be able to create further users.
  await assert.rejects(() => call('users:create', { username: 'someone.else', full_name: 'Someone Else', role: 'viewer', password: 'whatever123' }), /inzibatçı/);

  const viewerSession = await call('auth:login', { companyId, username: 'audit.viewer', password: 'viewerpass123' });
  assert.equal(viewerSession.user.role, 'viewer');
  assert.equal((await call('invoice:list', {})).length,0,'Baxış istifadəçisi reyestri oxuya bilməlidir');
  await assert.rejects(() => call('reference:saveAccount', {code:'999.01',name:'İcazəsiz hesab',kind:'asset'}), /Baxış səlahiyyətli/i);

  // Re-authenticate as the owner/admin to manage users.
  await call('auth:access', { companyId });
  const users = await call('users:list', undefined);
  assert.equal(users.length, 3);

  const staffId = users.find(u => u.username === 'aysel.mammadova').id;
  const ownerId = users.find(u => u.username === 'agarza.admin').id;

  // The sole admin cannot deactivate itself, and cannot leave the company
  // with zero active admins.
  await assert.rejects(() => call('users:setActive', { id: ownerId, active: false }), /aktiv sessiyanızdakı/);

  // But a non-admin staff account can be deactivated, and then can no longer log in.
  await call('users:setActive', { id: staffId, active: false });
  await assert.rejects(() => call('auth:login', { companyId, username: 'aysel.mammadova', password: 'staffpass123' }), /yanlışdır/);

  removeTemporaryDirectory(tempRoot);
  console.log('user management regression: OK');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
