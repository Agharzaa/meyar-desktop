'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const runtimeSource = source.split('\napp.whenReady().then(()=>{')[0] + `
module.exports = {
  initDb, saveInvoice, invoiceDetail, saveAccountingSetup, postInvoice,
  turnoverBalance, turnoverBalanceSummary, counterpartyLedger,
  bankSaveAccount, bankImportRecords, bankTransactions, dvxPreparePackage, saveWarehouse,
  importInvoiceRecords, closeDatabasesForExit
};`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meyar-v170-'));
const electronStub = {
  app: { getPath: () => tempRoot, getVersion: () => '1.7.0' },
  BrowserWindow: class {},
  ipcMain: { handle() {} },
  dialog: {},
  shell: {}
};
const localRequire = id => id === 'electron' ? electronStub : id.startsWith('./') ? require(path.join(root,id)) : require(id);
const moduleBox = { exports: {} };
const context = vm.createContext({
  require: localRequire, module: moduleBox, exports: moduleBox.exports,
  __dirname: root, __filename: path.join(root, 'main.js'),
  console, Buffer, URL, setImmediate, clearImmediate, setTimeout, clearTimeout,
  process
});
new vm.Script(runtimeSource, { filename: 'main.js' }).runInContext(context);
const api = moduleBox.exports;

async function run() {

const dbPath = path.join(tempRoot, 'company.sqlite');
api.initDb(dbPath, { companyMeta: { name: 'Test MMC', voen: '1234567890', currency: 'AZN' } });
// This legacy regression intentionally sells more than its single receipt.
// Negative stock is enabled only here; dedicated v1.12 tests verify the block.
api.saveWarehouse({id:1,code:'MAIN',name:'Əsas anbar',valuation_method:'AVERAGE',inventory_account_code:'205.01',cogs_account_code:'701.01',allow_negative_stock:true,is_default:true});

// v1.8 posts every accepted invoice atomically. A later contradictory source
// must not silently rewrite a posted journal; it is retained as a review case.
const legacyWrong=api.importInvoiceRecords([{
  invoice_no:'IMP 7001',invoice_date:'2026-01-05',counterparty_name:'İdxal Test MMC',
  voen:'7777777777',base_amount:100,vat_amount:18,total_amount:118
}],'file-import','export.xlsx','Gələn',{trustedDirection:false,directionSource:'Köhnə görünüş seçimi',directionConfidence:'none'});
assert.equal(legacyWrong.created,1);
const repaired=api.importInvoiceRecords([{
  invoice_no:'IMP 7001',invoice_date:'2026-01-05',counterparty_name:'İdxal Test MMC',
  voen:'7777777777',base_amount:100,vat_amount:18,total_amount:118
}],'file-import','export.xlsx','Gedən',{trustedDirection:true,directionSource:'DVX çıxarışının başlığı',directionConfidence:'high'});
assert.equal(repaired.reclassified,0,'Uçota alınmış sənəd səssiz yenidən təsnif edilməməlidir');
assert.equal(repaired.review,1,'Zidd istiqamət ayrıca audit baxışı yaratmalıdır');
assert.equal(repaired.created,1,'Əks istiqamətli sənəd ayrıca biznes sənədi kimi saxlanmalıdır');

function invoice(direction, no, voen, extra = {}) {
  return api.saveInvoice({
    invoice_no: no,
    invoice_series: no.split(' ')[0],
    invoice_date: extra.invoice_date || '2026-01-10',
    direction,
    counterparty_name: extra.counterparty_name || `Kontragent ${voen}`,
    voen,
    currency: extra.currency || 'AZN',
    status: extra.status || 'Təsdiqlənib',
    note: extra.note || 'Əsas qeyd',
    main_note: extra.note || 'Əsas qeyd',
    additional_note: extra.additional_note || 'Əlavə qeyd',
    invoice_type_name: extra.invoice_type_name || 'Malların təqdim edilməsi',
    vat_non_taxable_amount: extra.vat_non_taxable_amount || 7.25,
    reason_text: extra.reason_text || 'Test səbəbi',
    counterparty_account_code: direction === 'Gələn' ? '531.01' : '211.01',
    vat_posting_account_code: direction === 'Gələn' ? '241.01' : '521.01',
    items: [{
      item_code: 'T-1', item_type: 'Mal', description: 'Test malı', qty: 1,
      unit: 'ədəd', unit_price: extra.unit_price || 100, discount_rate: 0,
      vat_rate: 18, posting_account_code: direction === 'Gələn' ? '205.01' : '601.01'
    }]
  });
}

const incoming = invoice('Gələn', 'MT 1001', '1111111111');
const outgoing = invoice('Gedən', 'MT 1001', '1111111111');
assert.notEqual(incoming.id, outgoing.id, 'Gələn və Gedən eyni biznes nömrəsi ilə ayrı saxlanmalıdır');

const otherCounterparty = invoice('Gedən', 'MT 1001', '2222222222');
assert.ok(otherCounterparty.id, 'Fərqli VÖEN eyni nömrəli gedən qaiməni saxlaya bilməlidir');
assert.throws(() => invoice('Gedən', 'MT 1001', '1111111111'), /artıq mövcuddur/);

const saved = api.invoiceDetail(outgoing.id);
assert.equal(saved.additional_note, 'Əlavə qeyd');
assert.equal(saved.vat_non_taxable_amount, 7.25);
assert.equal(saved.reason_text, 'Test səbəbi');

api.saveAccountingSetup({ openingDate: '2026-01-01', balances: [] });
api.postInvoice(outgoing.id);
api.postInvoice(incoming.id);
const february = invoice('Gedən', 'MT 2002', '3333333333', { invoice_date: '2026-02-05', unit_price: 50 });
api.postInvoice(february.id);

const dbc = api.turnoverBalanceSummary({ from: '2026-02-01', to: '2026-02-28' });
assert.equal(dbc.opening_debit, dbc.opening_credit, 'Əvvəlki dövr balanslı başlanğıc saldo verməlidir');
assert.equal(dbc.opening_debit,590,'Yanvardakı bütün avtomatik uçota alınmış qaimələr başlanğıc saldoya daxil olmalıdır');
assert.equal(dbc.turnover_debit,159,'Satış və anbarın orta maya dəyəri birlikdə dövr debetində görünməlidir');
assert.equal(dbc.turnover_credit,159);

const ledger = api.counterpartyLedger(outgoing.counterparty_id, '211.01', '2026-02-01', '2026-02-28');
assert.equal(ledger.summary.opening, 118, 'Kontragent analitikası əvvəlki dövrü başlanğıc qalığa daşımalıdır');

const iban = 'AZ21NABZ00000000137010001944';
const bank = api.bankSaveAccount({ bank_name: 'PASHA Bank', account_name: 'AZN hesabı', iban, currency: 'AZN', ledger_account_code: '223.01', api_environment: 'sandbox' });
assert.equal(bank.api_provider, 'Fayl idxalı / əl ilə');
assert.equal(bank.api_environment, 'sandbox');
assert.equal(bank.integration_status, 'Hazır');

const imported = api.bankImportRecords([
  { date: '2026-02-10', credit: '120,00', direction: 'Kredit', reference: 'CR-1' },
  { date: '2026-02-11', debit: '50,00', direction: 'Debet', reference: 'DR-1' }
], bank.id);
assert.equal(imported.created, 2);
const transactions = api.bankTransactions({ accountId: bank.id });
assert.equal(transactions.find(row => row.reference === 'CR-1').direction, 'Daxilolma');
assert.equal(transactions.find(row => row.reference === 'DR-1').direction, 'Ödəniş');

const packagePath = path.join(tempRoot, 'dvx-test.zip');
electronStub.dialog.showSaveDialog = async () => ({ canceled: false, filePath: packagePath });
const dvxPackage = await api.dvxPreparePackage(outgoing.id);
assert.equal(dvxPackage.cancelled, false);
assert.equal(fs.existsSync(packagePath), true);
const zipCheck = spawnSync('unzip', ['-t', packagePath], { encoding: 'utf8' });
assert.equal(zipCheck.status, 0, zipCheck.stderr || zipCheck.stdout);
assert.match(zipCheck.stdout, /invoice\.xml/);
assert.match(zipCheck.stdout, /vhf-inf\/vhf\.mf/);

// Existing v1.5 databases contained a narrower UNIQUE(company_id,
// invoice_no,direction) constraint. Verify that the migration removes it
// without deleting the existing row.
const legacyPath = path.join(tempRoot, 'legacy-company.sqlite');
const legacy = new DatabaseSync(legacyPath);
legacy.exec(`
  CREATE TABLE companies(id INTEGER PRIMARY KEY,name TEXT NOT NULL,voen TEXT,currency TEXT NOT NULL DEFAULT 'AZN',created_at TEXT NOT NULL);
  INSERT INTO companies VALUES(1,'Legacy MMC','4444444444','AZN','2026-01-01T00:00:00.000Z');
  CREATE TABLE invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,company_id INTEGER NOT NULL,invoice_no TEXT NOT NULL,invoice_date TEXT NOT NULL,
    due_date TEXT,direction TEXT NOT NULL CHECK(direction IN ('Gələn','Gedən')),counterparty_id INTEGER,counterparty_name TEXT NOT NULL,
    voen TEXT NOT NULL,currency TEXT NOT NULL DEFAULT 'AZN',base_amount REAL NOT NULL DEFAULT 0,vat_amount REAL NOT NULL DEFAULT 0,
    total_amount REAL NOT NULL DEFAULT 0,vat_rate REAL NOT NULL DEFAULT 18,status TEXT NOT NULL DEFAULT 'Qaralama',note TEXT,
    source TEXT NOT NULL DEFAULT 'manual',posting_status TEXT NOT NULL DEFAULT 'Hazırlanmayıb',created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,deleted_at TEXT,UNIQUE(company_id,invoice_no,direction)
  );
  INSERT INTO invoices(company_id,invoice_no,invoice_date,direction,counterparty_name,voen,base_amount,vat_amount,total_amount,created_at,updated_at)
  VALUES(1,'LEG-1','2026-01-01','Gedən','Legacy CP','5555555555',100,18,118,'2026-01-01','2026-01-01');
`);
legacy.close();
api.initDb(legacyPath);
api.saveWarehouse({id:1,code:'MAIN',name:'Əsas anbar',valuation_method:'AVERAGE',inventory_account_code:'205.01',cogs_account_code:'701.01',allow_negative_stock:true,is_default:true});
const migrated = new DatabaseSync(legacyPath);
const hasLegacyUnique = migrated.prepare(`PRAGMA index_list(invoices)`).all().some(index => {
  if (index.origin !== 'u') return false;
  const columns = migrated.prepare(`PRAGMA index_info('${index.name}')`).all().map(row => row.name);
  return columns.join('|') === 'company_id|invoice_no|direction';
});
assert.equal(hasLegacyUnique, false, 'Köhnə dar UNIQUE constraint miqrasiya zamanı silinməlidir');
assert.equal(migrated.prepare(`SELECT COUNT(*) c FROM invoices WHERE invoice_no='LEG-1'`).get().c, 1, 'Miqrasiya mövcud qaiməni qorumalıdır');
migrated.close();
const migratedSecondVoen = invoice('Gedən', 'LEG-1', '6666666666');
assert.ok(migratedSecondVoen.id, 'Miqrasiyadan sonra fərqli VÖEN eyni nömrəni istifadə edə bilməlidir');

api.closeDatabasesForExit();
fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
console.log('core v1.7.0 regression: OK');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
