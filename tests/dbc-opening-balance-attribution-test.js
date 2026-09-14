'use strict';

// Regression test for the opening_balances attribution fix (schema 194).
//
// Before this fix, opening_balances only stored one lump-sum row per
// account (UNIQUE(account_code), no counterparty_id/subkonto_id). That made
// it impossible to say *which* customer or supplier an opening debtor/
// creditor balance belonged to, so accountCounterparties()/accountAnalytics()
// always folded any receivable/payable opening balance into a phantom
// "Analitikasız açılış qalığı" (unattributed opening balance) row instead of
// showing it against the real counterparty.
//
// This test verifies:
//  1. An opening balance can be split across two real counterparties on the
//     same account without producing a phantom row.
//  2. Each counterparty's own opening amount is correct.
//  3. turnoverBalance() still reports the correct combined total for the
//     account (guards against the Cartesian-product bug that a naive
//     per-counterparty JOIN in turnoverBalance() would reintroduce, now that
//     an account can have more than one opening_balances row).
//  4. Old-style unattributed (lump-sum) opening balances still work exactly
//     as before and still surface the phantom row — backward compatibility.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { removeTemporaryDirectory } = require('./test-filesystem');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const runtimeSource = source.split('\napp.whenReady().then(()=>{')[0] + `
module.exports={
  initDb,saveAccountingSetup,getAccountingSetup,saveCounterparty,
  accountCounterparties,accountAnalytics,turnoverBalance,
  queryAll:(sql,...params)=>db.prepare(sql).all(...params),queryOne:(sql,...params)=>db.prepare(sql).get(...params)
};`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meyar-dbc-opening-'));
const electronStub = {
  app: { getPath: () => tempRoot, getVersion: () => '1.12.0' },
  BrowserWindow: class {}, ipcMain: { handle() {} }, dialog: {}, shell: {}
};
const localRequire = id => id === 'electron' ? electronStub : id.startsWith('./') ? require(path.join(root,id)) : require(id);
const moduleBox = { exports: {} };
const context = vm.createContext({
  require: localRequire,module:moduleBox,exports:moduleBox.exports,__dirname:root,__filename:path.join(root,'main.js'),
  console,Buffer,URL,setImmediate,clearImmediate,setTimeout,clearTimeout,process
});
new vm.Script(runtimeSource,{filename:'main.js'}).runInContext(context);
const api=moduleBox.exports;

try{
  api.initDb(path.join(tempRoot,'company.sqlite'),{companyMeta:{name:'DBC Attribution Test MMC',voen:'1234567890',currency:'AZN'}});

  const customerA = api.saveCounterparty({name:'Alfa Trading MMC',voen:'1000000011',is_customer:true});
  const customerB = api.saveCounterparty({name:'Beta Logistics MMC',voen:'1000000012',is_customer:true});

  // 500 attributed to customer A, 300 attributed to customer B, balanced by
  // a credit line on a non-analytic expense account so debit=credit overall.
  api.saveAccountingSetup({
    openingDate:'2026-01-01',
    balances:[
      {code:'211.01',debit:500,credit:0,counterparty_id:customerA.id},
      {code:'211.01',debit:300,credit:0,counterparty_id:customerB.id},
      {code:'721.99',debit:0,credit:800}
    ]
  });

  // --- 1 & 2: both customers show up with correct opening amounts, no phantom row ---
  const rows = api.accountCounterparties('211.01','2026-01-01','2026-01-31');
  const phantom = rows.find(r=>r.unallocated_opening);
  assert.equal(phantom, undefined, 'Tam atribusiya edilmiş açılış qalığı fantom sətir yaratmamalıdır');

  const rowA = rows.find(r=>r.id===customerA.id);
  const rowB = rows.find(r=>r.id===customerB.id);
  assert.ok(rowA, 'Alfa Trading DBC-də görünməlidir');
  assert.ok(rowB, 'Beta Logistics DBC-də görünməlidir');
  assert.equal(rowA.opening, 500);
  assert.equal(rowB.opening, 300);
  assert.equal(rowA.net, 500);
  assert.equal(rowB.net, 300);

  // --- 3: turnoverBalance() combines multiple opening_balances rows correctly ---
  // (guards against the Cartesian-product bug: if the SQL summed
  // opening_balances after joining to journal_lines instead of before, the
  // 800 total below would come out multiplied instead of correct).
  const dbc = api.turnoverBalance({from:'2026-01-01',to:'2026-01-31',accountCode:'211.01',includeZero:true})[0];
  assert.equal(dbc.open_debit, 800, '211.01 üzrə açılış qalığı 500+300=800 olmalıdır');
  assert.equal(dbc.open_credit, 0);

  // getAccountingSetup() must expose the per-counterparty breakdown too.
  const setup = api.getAccountingSetup();
  const accountRow = setup.accounts.find(a=>a.code==='211.01');
  assert.equal(accountRow.debit, 800, 'Hesab üzrə cəmlənmiş məbləğ düzgün olmalıdır');
  assert.equal(accountRow.lines.length, 2, 'İki ayrı kontragent sətri saxlanmalıdır');
  assert.ok(accountRow.lines.every(l=>l.counterparty_id), 'Hər sətir bir kontragentə aid olmalıdır');

  // --- 4: old-style unattributed lump sum still works and still shows the phantom row ---
  api.saveAccountingSetup({
    openingDate:'2026-01-01',
    balances:[
      {code:'531.01',debit:0,credit:150},
      {code:'721.99',debit:150,credit:0}
    ]
  });
  const supplierRows = api.accountCounterparties('531.01','2026-01-01','2026-01-31');
  const supplierPhantom = supplierRows.find(r=>r.unallocated_opening);
  assert.ok(supplierPhantom, 'Kontragentsiz açılış qalığı hələ də analitikasız sətirlə göstərilməlidir');
  assert.equal(supplierPhantom.net, -150);

  console.log('dbc opening balance attribution: OK');
} finally {
  removeTemporaryDirectory(tempRoot);
}
