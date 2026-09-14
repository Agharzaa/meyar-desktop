'use strict';
// Regression test: settling a foreign-currency invoice at a bank rate that
// differs from the invoice's own booked exchange_rate must (a) close the
// counterparty subledger (211.01/531.01) at the invoice's original rate, and
// (b) post the residual difference as a realized FX gain/loss to 723.02 /
// 723.01, so the journal entry stays balanced and the counterparty account
// nets to zero once a foreign-currency invoice is fully paid.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { removeTemporaryDirectory } = require('./test-filesystem');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const runtimeSource = source.split('\napp.whenReady().then(()=>{')[0] + `
module.exports = { initDb, saveInvoice, postInvoice, bankSaveAccount, bankImportRecords, bankTransactions, bankReconcile, invoiceDetail };`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meyar-fx-'));
const electronStub = {
  app: { getPath: () => tempRoot, getVersion: () => '1.12.0' },
  BrowserWindow: class {}, ipcMain: { handle(){} }, dialog: {}, shell: {}
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

const dbPath = path.join(tempRoot, 'company.sqlite');
api.initDb(dbPath, { companyMeta: { name: 'FX Test MMC', voen: '1234567890', currency: 'AZN' } });

// Incoming invoice in USD, booked at 1.70 AZN/USD.
const inv = api.saveInvoice({
  invoice_no: 'USD 1001', invoice_date: '2026-03-01', direction: 'Gələn',
  counterparty_name: 'Foreign Supplier LLC', voen: '9999999999', currency: 'USD', exchange_rate: 1.70,
  status: 'Təsdiqlənib', counterparty_account_code: '531.01', vat_posting_account_code: '241.01',
  items: [{ item_code: 'S-1', item_type: 'Xidmət', description: 'Consulting', qty: 1, unit: 'xidmət',
    unit_price: 1000, discount_rate: 0, vat_rate: 0, posting_account_code: '721.01' }]
});
api.postInvoice(inv.id);

const bank = api.bankSaveAccount({ bank_name: 'Test Bank', account_name: 'USD hesabı', iban: 'AZ21NABZ00000000137010001944', currency: 'USD', ledger_account_code: '223.01', api_environment: 'sandbox' });
api.bankImportRecords([{ date: '2026-03-15', debit: '1000,00', direction: 'Debet', reference: 'PAY-1' }], bank.id);
const tx = api.bankTransactions({ accountId: bank.id }).find(t => t.reference === 'PAY-1');

// Paid at 1.80 (higher than booked) -> we spent more AZN than the payable was
// worth, a realized FX loss.
const result = api.bankReconcile({ transactionId: tx.id, exchangeRate: 1.80, allocations: [{ invoiceId: inv.id, amount: 1000 }] });

const raw = new DatabaseSync(dbPath);
const lines = raw.prepare(`SELECT account_code, debit, credit FROM journal_lines WHERE journal_entry_id=?`).all(result.journalEntryId);
raw.close();

const totalDebit = lines.reduce((sum, l) => sum + l.debit, 0);
const totalCredit = lines.reduce((sum, l) => sum + l.credit, 0);
assert.equal(totalDebit, totalCredit, 'Foreign-currency reconciliation journal must stay balanced');

const payableLine = lines.find(l => l.account_code === '531.01');
assert.equal(payableLine.debit, 1700, 'Payable must close at the invoice\'s own booked rate (1.70), not the payment rate');

const fxLossLine = lines.find(l => l.account_code === '723.01');
assert.ok(fxLossLine, 'A higher payment rate than the booked rate must post a realized FX loss to 723.01');
assert.equal(fxLossLine.debit, 100, 'FX loss must equal amount*(paymentRate-invoiceRate) = 1000*(1.80-1.70)');

const bankLine = lines.find(l => l.account_code === '223.01');
assert.equal(bankLine.credit, 1800, 'Bank line must reflect the actual cash paid at the payment rate (1.80)');

removeTemporaryDirectory(tempRoot);
console.log('FX reconciliation regression: OK');
