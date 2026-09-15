'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const {
  inferItemType,
  normalizeText: normalizeAccountingText,
  resolvePosting,
  valueInventoryMovements
} = require('./lib/accounting-engine');
const {
  copyVerifiedFile,
  initializeAppUpdater,
  markUpdateHealthy,
  recoverPendingUpdateData,
  snapshotSqliteData
} = require('./lib/app-updater');

let db = null;
let masterDb = null;
let activeCompany = null;
let activeUser = null;
let mainWindow = null;
let liveTaxWindow = null;
let liveTaxDirection = 'Gələn';

const DB_SCHEMA_VERSION = 211;
const MAX_IMPORT_FILE_BYTES = 100 * 1024 * 1024;

const nowIso = () => new Date().toISOString();
const localDate = () => { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const isValidIsoDate = value => {
  const match=String(value||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(!match)return false;
  const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]);
  const date=new Date(Date.UTC(year,month-1,day));
  return date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day;
};
function assertOptionalDateRange(from='',to='') {
  const start=String(from||'').trim(),end=String(to||'').trim();
  if(start&&!isValidIsoDate(start))throw new Error('Başlanğıc tarixi düzgün deyil.');
  if(end&&!isValidIsoDate(end))throw new Error('Son tarix düzgün deyil.');
  if(start&&end&&start>end)throw new Error('Başlanğıc tarixi son tarixdən böyük ola bilməz.');
  return {start:start||'1900-01-01',end:end||'2999-12-31'};
}
const OWNER_USERNAME = 'agarza.admin';
const OWNER_FULL_NAME = 'Ağarza Ağalarov';
const dateAz = (iso = nowIso()) => new Date(iso).toLocaleDateString('az-AZ');

function dataRoot() {
  const dir = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function updateStateFile() {
  return path.join(app.getPath('userData'), 'update-state.json');
}

function masterDatabaseFile() { return path.join(dataRoot(), 'system', 'registry.sqlite'); }
function legacyDatabaseFile() { return path.join(dataRoot(), 'meyar-erp.sqlite'); }
function companyDatabaseFile(companyId) {
  const dir = path.join(dataRoot(), 'companies', `company-${Number(companyId)}`);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'company.sqlite');
}
function databaseFile() {
  if (activeCompany?.id) return companyDatabaseFile(activeCompany.id);
  return masterDatabaseFile();
}
function currentUserName() { return activeUser?.full_name || activeUser?.username || 'Naməlum istifadəçi'; }
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, expectedHash) {
  try {
    const actual = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expectedHash, 'hex'));
  } catch (_) { return false; }
}
function initMasterDb() {
  const file = masterDatabaseFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  masterDb = new DatabaseSync(file);
  masterDb.exec(`
    PRAGMA foreign_keys=ON;
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      voen TEXT NOT NULL UNIQUE,
      currency TEXT NOT NULL DEFAULT 'AZN',
      db_path TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      full_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_companies (
      user_id INTEGER NOT NULL,
      company_id INTEGER NOT NULL,
      PRIMARY KEY(user_id, company_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(company_id) REFERENCES companies(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_uc_company ON user_companies(company_id);
    CREATE TABLE IF NOT EXISTS user_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      full_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      UNIQUE(company_id, username),
      FOREIGN KEY(company_id) REFERENCES companies(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_user_accounts_company ON user_accounts(company_id, active);
  `);

  // One-time migration: keep the old single-file database intact as the first company's isolated base.
  const companyCount = Number(masterDb.prepare(`SELECT COUNT(*) c FROM companies`).get().c || 0);
  if (!companyCount && fs.existsSync(legacyDatabaseFile())) {
    try {
      const old = new DatabaseSync(legacyDatabaseFile());
      const c = old.prepare(`SELECT name,voen,currency FROM companies WHERE id=1`).get() || {name:'Şirkət bazası',voen:'',currency:'AZN'};
      old.close();
      const cid = Number(masterDb.prepare(`INSERT INTO companies(name,voen,currency,db_path,created_at) VALUES(?,?,?,?,?)`).run(String(c.name||'Şirkət bazası'), String(c.voen||`LEGACY-${Date.now()}`), String(c.currency||'AZN'), companyDatabaseFile(1), nowIso()).lastInsertRowid);
      const target = companyDatabaseFile(cid);
      const legacy = legacyDatabaseFile();
      fs.copyFileSync(legacy, target);
      for (const suffix of ['-wal','-shm']) { if (fs.existsSync(legacy+suffix)) fs.copyFileSync(legacy+suffix, target+suffix); }
      if (cid !== 1) { /* ids inside the old base remain local to that company */ }
      console.log('MEYAR: legacy database isolated into company base', target);
    } catch (e) { console.warn('Legacy migration skipped:', e.message); }
  }

  // After legacy-company migration, migrate old global users to the first company.
  const accountCount = Number(masterDb.prepare(`SELECT COUNT(*) c FROM user_accounts`).get().c || 0);
  if (!accountCount) {
    const legacyUsers = masterDb.prepare(`SELECT id,username,full_name,password_hash,password_salt,role,active,created_at FROM users WHERE active=1 ORDER BY id`).all();
    const firstCompany = masterDb.prepare(`SELECT id FROM companies WHERE active=1 ORDER BY id LIMIT 1`).get();
    if (firstCompany && legacyUsers.length) {
      const ins = masterDb.prepare(`INSERT OR IGNORE INTO user_accounts(company_id,username,full_name,password_hash,password_salt,role,active,created_at) VALUES(?,?,?,?,?,?,?,?)`);
      for (const u of legacyUsers) ins.run(firstCompany.id, u.username, u.full_name, u.password_hash, u.password_salt, u.role || 'admin', u.active ? 1 : 0, u.created_at || nowIso());
    }
  }
}

function listCompaniesForUser(userId) {
  return masterDb.prepare(`SELECT c.id,c.name,c.voen,c.currency,c.active FROM companies c JOIN user_companies uc ON uc.company_id=c.id WHERE uc.user_id=? AND c.active=1 ORDER BY c.name`).all(Number(userId));
}
function listActiveCompanies() {
  return masterDb.prepare(`SELECT id,name,voen,currency FROM companies WHERE active=1 ORDER BY name`).all();
}
function getCompanyById(companyId) {
  return masterDb.prepare(`SELECT id,name,voen,currency,active FROM companies WHERE id=? AND active=1`).get(Number(companyId));
}
function requireAuth() {
  if (!activeUser || !activeCompany || !db) throw new Error('Şirkət sessiyası aktiv deyil. Şirkət bazasını seçərək sistemə daxil olun.');
}
function openCompanyDatabase(company) {
  if (db) { try { db.close(); } catch (_) {} db = null; }
  const file = companyDatabaseFile(company.id);
  try {
    if (!fs.existsSync(file)) initDb(file, { companyMeta: company });
    else initDb(file, { backupExisting: true });
    activeCompany = company;
  } catch (error) {
    if (db) { try { db.close(); } catch (_) {} }
    db=null;activeCompany=null;activeUser=null;
    throw error;
  }
}
function closeCompanySession() {
  if (db) { try { db.close(); } catch (_) {} }
  db = null; activeCompany = null; activeUser = null;
}

function checkpointAccountingDatabases() {
  for (const database of [db, masterDb]) {
    if (!database) continue;
    database.exec('PRAGMA wal_checkpoint(FULL)');
  }
}

function createPreUpdateBackup(targetVersion) {
  return snapshotSqliteData({
    sourceRoot: dataRoot(),
    backupRoot: path.join(app.getPath('userData'), 'update-backups'),
    targetVersion,
    checkpoint: checkpointAccountingDatabases,
    keepBackups: 5
  });
}

function closeDatabasesForExit(event) {
  if (event?.defaultPrevented) return;
  if (db) { try { db.close(); } catch (_) {} db = null; }
  if (masterDb) { try { masterDb.close(); } catch (_) {} masterDb = null; }
  activeCompany = null;
  activeUser = null;
}

function restoreMigrationBackup(databasePath, backupPath) {
  const token = `${Date.now()}-${process.pid}`;
  const temporaryPath = `${databasePath}.restore-${token}.tmp`;
  const failedPath = `${databasePath}.migration-failed-${token}`;
  copyVerifiedFile(backupPath, temporaryPath);
  for (const suffix of ['-wal', '-shm']) {
    try { fs.rmSync(`${databasePath}${suffix}`, { force: true }); } catch (_) {}
  }
  if (fs.existsSync(databasePath)) fs.renameSync(databasePath, failedPath);
  try {
    fs.renameSync(temporaryPath, databasePath);
    return failedPath;
  } catch (error) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch (_) {}
    if (fs.existsSync(failedPath) && !fs.existsSync(databasePath)) fs.renameSync(failedPath, databasePath);
    throw error;
  }
}

function initDb(dbPath = databaseFile(), options = {}) {
  let currentSchemaVersion = 0;
  let migrationBackupPath = '';
  if (fs.existsSync(dbPath)) {
    try {
      const probe = new DatabaseSync(dbPath);
      currentSchemaVersion = Number(probe.prepare(`PRAGMA user_version`).get()?.user_version || 0);
      probe.exec('PRAGMA wal_checkpoint(FULL)');
      probe.close();
    } catch (_) {}
  }
  if (fs.existsSync(dbPath) && options.backupExisting && currentSchemaVersion < DB_SCHEMA_VERSION) {
    const stat = fs.statSync(dbPath);
    if (stat.size > 0) {
      const backupDir = path.join(path.dirname(dbPath), 'backups');
      fs.mkdirSync(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g,'-');
      migrationBackupPath = path.join(backupDir, `meyar-erp-pre-migration-${stamp}.sqlite`);
      try {
        copyVerifiedFile(dbPath, migrationBackupPath);
      } catch (backupError) {
        throw new Error(`Baza migrasiyası dayandırıldı: təhlükəsiz ehtiyat yaradıla bilmədi. ${backupError.message}`);
      }
    }
  }
  try {
    db = new DatabaseSync(dbPath);
    db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      voen TEXT,
      currency TEXT NOT NULL DEFAULT 'AZN',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS counterparties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      voen TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL DEFAULT 'Debitor',
      account_code TEXT,
      status TEXT NOT NULL DEFAULT 'Aktiv',
      phone TEXT,
      email TEXT,
      address TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      parent_code TEXT,
      is_postable INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS posting_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      direction TEXT NOT NULL,
      base_debit_code TEXT NOT NULL,
      vat_debit_code TEXT,
      base_credit_code TEXT NOT NULL,
      vat_credit_code TEXT,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      invoice_no TEXT NOT NULL,
      invoice_date TEXT NOT NULL,
      due_date TEXT,
      direction TEXT NOT NULL CHECK(direction IN ('Gələn','Gedən')),
      counterparty_id INTEGER,
      counterparty_name TEXT NOT NULL,
      voen TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'AZN',
      base_amount REAL NOT NULL DEFAULT 0,
      vat_amount REAL NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL DEFAULT 0,
      vat_rate REAL NOT NULL DEFAULT 18,
      status TEXT NOT NULL DEFAULT 'Qaralama',
      note TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      posting_profile_id INTEGER,
      counterparty_account_code TEXT,
      vat_posting_account_code TEXT,
      posting_status TEXT NOT NULL DEFAULT 'Hazırlanmayıb',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      FOREIGN KEY(company_id) REFERENCES companies(id),
      FOREIGN KEY(counterparty_id) REFERENCES counterparties(id)
    );
    CREATE TABLE IF NOT EXISTS invoice_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL,
      line_no INTEGER NOT NULL,
      item_code TEXT,
      description TEXT NOT NULL,
      qty REAL NOT NULL DEFAULT 1,
      unit TEXT NOT NULL DEFAULT 'ədəd',
      unit_price REAL NOT NULL DEFAULT 0,
      discount_rate REAL NOT NULL DEFAULT 0,
      vat_rate REAL NOT NULL DEFAULT 18,
      base_amount REAL NOT NULL DEFAULT 0,
      vat_amount REAL NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL DEFAULT 0,
      FOREIGN KEY(invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      payment_date TEXT NOT NULL,
      document_no TEXT,
      counterparty_id INTEGER,
      counterparty_name TEXT,
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'AZN',
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL,
      FOREIGN KEY(company_id) REFERENCES companies(id)
    );
    CREATE TABLE IF NOT EXISTS payment_allocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id INTEGER NOT NULL,
      invoice_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(payment_id, invoice_id),
      FOREIGN KEY(payment_id) REFERENCES payments(id) ON DELETE CASCADE,
      FOREIGN KEY(invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS journal_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      source_type TEXT NOT NULL,
      source_id INTEGER NOT NULL,
      entry_date TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'Qaralama',
      created_at TEXT NOT NULL,
      FOREIGN KEY(company_id) REFERENCES companies(id)
    );
    CREATE TABLE IF NOT EXISTS journal_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      journal_entry_id INTEGER NOT NULL,
      account_code TEXT NOT NULL,
      debit REAL NOT NULL DEFAULT 0,
      credit REAL NOT NULL DEFAULT 0,
      analytic_type TEXT,
      analytic_key TEXT,
      FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_name TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER,
      before_json TEXT,
      after_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invoice_status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      reason TEXT,
      changed_by TEXT NOT NULL,
      changed_at TEXT NOT NULL,
      FOREIGN KEY(invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      document_kind TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_path TEXT,
      mime_type TEXT,
      checksum TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(company_id) REFERENCES companies(id)
    );
    CREATE TABLE IF NOT EXISTS item_catalog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      item_type TEXT NOT NULL DEFAULT 'Mal' CHECK(item_type IN ('Mal','Xidmət')),
      unit TEXT NOT NULL DEFAULT 'ədəd',
      purchase_account_code TEXT,
      sales_account_code TEXT,
      inventory_account_code TEXT,
      purchase_vat_account_code TEXT,
      sales_vat_account_code TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(company_id,code),
      FOREIGN KEY(company_id) REFERENCES companies(id)
    );
    CREATE TABLE IF NOT EXISTS company_settings (
      id INTEGER PRIMARY KEY CHECK(id=1),
      accounting_enabled INTEGER NOT NULL DEFAULT 0,
      opening_date TEXT,
      activated_at TEXT,
      activated_by TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dvx_integration (
      id INTEGER PRIMARY KEY CHECK(id=1),
      provider TEXT NOT NULL DEFAULT 'Azərbaycan Respublikası Dövlət Vergi Xidməti',
      portal_url TEXT NOT NULL DEFAULT 'https://new.e-taxes.gov.az/',
      environment TEXT NOT NULL DEFAULT 'production',
      mode TEXT NOT NULL DEFAULT 'portal',
      status TEXT NOT NULL DEFAULT 'Hazır',
      last_sync_at TEXT,
      last_sync_result TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dvx_packages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL DEFAULT 1,
      invoice_id INTEGER,
      direction TEXT NOT NULL,
      package_type TEXT NOT NULL DEFAULT 'E-Qaimə',
      file_name TEXT NOT NULL,
      file_path TEXT,
      checksum TEXT,
      status TEXT NOT NULL DEFAULT 'Hazırlandı',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(company_id) REFERENCES companies(id),
      FOREIGN KEY(invoice_id) REFERENCES invoices(id)
    );
    CREATE TABLE IF NOT EXISTS dvx_sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      direction TEXT NOT NULL,
      source TEXT NOT NULL,
      candidate_rows INTEGER NOT NULL DEFAULT 0,
      created_rows INTEGER NOT NULL DEFAULT 0,
      duplicates INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      message TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS integration_sync_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL DEFAULT 1,
      integration_type TEXT NOT NULL CHECK(integration_type IN ('invoice','bank')),
      source_key TEXT NOT NULL,
      source_kind TEXT NOT NULL CHECK(source_kind IN ('file','live')),
      source_path TEXT,
      last_sync_at TEXT,
      last_sync_result TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(company_id,integration_type,source_key),
      FOREIGN KEY(company_id) REFERENCES companies(id)
    );
    CREATE TABLE IF NOT EXISTS integration_sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL DEFAULT 1,
      integration_type TEXT NOT NULL CHECK(integration_type IN ('invoice','bank')),
      source_key TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      candidate_rows INTEGER NOT NULL DEFAULT 0,
      created_rows INTEGER NOT NULL DEFAULT 0,
      skipped_existing_rows INTEGER NOT NULL DEFAULT 0,
      failed_rows INTEGER NOT NULL DEFAULT 0,
      result_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(company_id) REFERENCES companies(id)
    );
    CREATE TABLE IF NOT EXISTS opening_balances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_code TEXT NOT NULL UNIQUE,
      debit REAL NOT NULL DEFAULT 0,
      credit REAL NOT NULL DEFAULT 0,
      note TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(account_code) REFERENCES accounts(code)
    );
    CREATE TABLE IF NOT EXISTS bank_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL DEFAULT 1,
      bank_name TEXT NOT NULL,
      account_name TEXT,
      account_no TEXT,
      iban TEXT,
      currency TEXT NOT NULL DEFAULT 'AZN',
      ledger_account_code TEXT NOT NULL DEFAULT '223.01',
      api_provider TEXT NOT NULL DEFAULT 'PASHA Bank OpenBanking',
      api_environment TEXT NOT NULL DEFAULT 'sandbox',
      integration_status TEXT NOT NULL DEFAULT 'Təsdiq gözləyir',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bank_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bank_account_id INTEGER NOT NULL,
      external_id TEXT,
      transaction_date TEXT NOT NULL,
      value_date TEXT,
      direction TEXT NOT NULL CHECK(direction IN ('Daxilolma','Ödəniş')),
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'AZN',
      counterparty_name TEXT,
      counterparty_voen TEXT,
      description TEXT,
      reference TEXT,
      balance_after REAL,
      source TEXT NOT NULL DEFAULT 'manual',
      reconciliation_status TEXT NOT NULL DEFAULT 'Uyğunlaşdırılmayıb',
      created_at TEXT NOT NULL,
      UNIQUE(bank_account_id, external_id),
      FOREIGN KEY(bank_account_id) REFERENCES bank_accounts(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS bank_reconciliations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id INTEGER NOT NULL UNIQUE,
      invoice_id INTEGER NOT NULL,
      payment_id INTEGER,
      allocated_amount REAL NOT NULL,
      matched_by TEXT NOT NULL,
      matched_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Təsdiqlənib',
      FOREIGN KEY(transaction_id) REFERENCES bank_transactions(id) ON DELETE CASCADE,
      FOREIGN KEY(invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
      FOREIGN KEY(payment_id) REFERENCES payments(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS counterparty_contracts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      counterparty_id INTEGER NOT NULL,
      contract_no TEXT NOT NULL,
      contract_date TEXT,
      end_date TEXT,
      currency TEXT NOT NULL DEFAULT 'AZN',
      note TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(counterparty_id, contract_no),
      FOREIGN KEY(counterparty_id) REFERENCES counterparties(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS account_subcontos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_code TEXT NOT NULL,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      dimension TEXT NOT NULL DEFAULT 'Xərc maddəsi',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(account_code, code),
      FOREIGN KEY(account_code) REFERENCES accounts(code)
    );
    CREATE TABLE IF NOT EXISTS warehouses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL DEFAULT 1,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      valuation_method TEXT NOT NULL DEFAULT 'AVERAGE' CHECK(valuation_method IN ('FIFO','AVERAGE')),
      inventory_account_code TEXT NOT NULL DEFAULT '205.01',
      cogs_account_code TEXT NOT NULL DEFAULT '701.01',
      allow_negative_stock INTEGER NOT NULL DEFAULT 0,
      is_default INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(company_id, code),
      FOREIGN KEY(company_id) REFERENCES companies(id),
      FOREIGN KEY(inventory_account_code) REFERENCES accounts(code),
      FOREIGN KEY(cogs_account_code) REFERENCES accounts(code)
    );
    CREATE TABLE IF NOT EXISTS posting_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL DEFAULT 1,
      name TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 100,
      direction TEXT,
      item_type TEXT,
      match_field TEXT NOT NULL DEFAULT 'all',
      match_value TEXT,
      account_code TEXT NOT NULL,
      subkonto_id INTEGER,
      warehouse_id INTEGER,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(company_id) REFERENCES companies(id),
      FOREIGN KEY(account_code) REFERENCES accounts(code),
      FOREIGN KEY(subkonto_id) REFERENCES account_subcontos(id),
      FOREIGN KEY(warehouse_id) REFERENCES warehouses(id)
    );
    CREATE TABLE IF NOT EXISTS stock_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL DEFAULT 1,
      warehouse_id INTEGER NOT NULL,
      catalog_item_id INTEGER NOT NULL,
      invoice_id INTEGER NOT NULL,
      invoice_item_id INTEGER NOT NULL,
      journal_entry_id INTEGER NOT NULL,
      movement_date TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('IN','OUT')),
      quantity REAL NOT NULL,
      unit_cost REAL NOT NULL DEFAULT 0,
      total_cost REAL NOT NULL DEFAULT 0,
      shortage_quantity REAL NOT NULL DEFAULT 0,
      valuation_method TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(invoice_item_id),
      FOREIGN KEY(company_id) REFERENCES companies(id),
      FOREIGN KEY(warehouse_id) REFERENCES warehouses(id),
      FOREIGN KEY(catalog_item_id) REFERENCES item_catalog(id),
      FOREIGN KEY(invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
      FOREIGN KEY(invoice_item_id) REFERENCES invoice_items(id) ON DELETE CASCADE,
      FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id) ON DELETE CASCADE
    );
  `);

  const cpCols = new Set(db.prepare(`PRAGMA table_info(counterparties)`).all().map(x=>x.name));
  if (!cpCols.has('receivable_account_code')) db.exec(`ALTER TABLE counterparties ADD COLUMN receivable_account_code TEXT`);
  if (!cpCols.has('payable_account_code')) db.exec(`ALTER TABLE counterparties ADD COLUMN payable_account_code TEXT`);
  if (!cpCols.has('is_customer')) db.exec(`ALTER TABLE counterparties ADD COLUMN is_customer INTEGER NOT NULL DEFAULT 0`);
  if (!cpCols.has('is_supplier')) db.exec(`ALTER TABLE counterparties ADD COLUMN is_supplier INTEGER NOT NULL DEFAULT 0`);
  db.prepare(`UPDATE counterparties SET receivable_account_code=COALESCE(receivable_account_code,'211.01'), payable_account_code=COALESCE(payable_account_code,'531.01'),
             is_customer=CASE WHEN type IN ('Debitor','Debitor/Kreditor') OR EXISTS(SELECT 1 FROM invoices i WHERE i.counterparty_id=counterparties.id AND i.direction='Gedən') THEN 1 ELSE is_customer END,
             is_supplier=CASE WHEN type IN ('Kreditor','Debitor/Kreditor') OR EXISTS(SELECT 1 FROM invoices i WHERE i.counterparty_id=counterparties.id AND i.direction='Gələn') THEN 1 ELSE is_supplier END`).run();

  const invoiceCols = new Set(db.prepare(`PRAGMA table_info(invoices)`).all().map(x=>x.name));
  // Backward-compatible invoice schema migrations. Every column referenced by
  // import/manual posting paths must exist before any SELECT/UPDATE runs.
  const invoiceMigrations = [
    ['posting_profile_id','INTEGER'],
    ['counterparty_account_code','TEXT'],
    ['vat_posting_account_code','TEXT']
  ];
  for (const [col,type] of invoiceMigrations) {
    if (!invoiceCols.has(col)) db.exec(`ALTER TABLE invoices ADD COLUMN ${col} ${type}`);
  }
  const refreshedInvoiceCols = new Set(db.prepare(`PRAGMA table_info(invoices)`).all().map(x=>x.name));
  const itemCols = new Set(db.prepare(`PRAGMA table_info(invoice_items)`).all().map(x=>x.name));
  if (!itemCols.has('catalog_item_id')) db.exec(`ALTER TABLE invoice_items ADD COLUMN catalog_item_id INTEGER`);
  if (!itemCols.has('item_type')) db.exec(`ALTER TABLE invoice_items ADD COLUMN item_type TEXT NOT NULL DEFAULT 'Mal'`);
  if (!itemCols.has('posting_account_code')) db.exec(`ALTER TABLE invoice_items ADD COLUMN posting_account_code TEXT`);
  db.exec(`UPDATE invoice_items SET item_type=CASE WHEN lower(COALESCE(description,'')) LIKE '%xidmət%' THEN 'Xidmət' ELSE COALESCE(item_type,'Mal') END WHERE item_type IS NULL OR item_type=''`);
  const invoiceExtraCols = new Set(db.prepare(`PRAGMA table_info(invoices)`).all().map(x=>x.name));
  if (!invoiceExtraCols.has('invoice_series')) db.exec(`ALTER TABLE invoices ADD COLUMN invoice_series TEXT`);
  if (!invoiceExtraCols.has('source_file')) db.exec(`ALTER TABLE invoices ADD COLUMN source_file TEXT`);
  if (!invoiceExtraCols.has('invoice_type_name')) db.exec(`ALTER TABLE invoices ADD COLUMN invoice_type_name TEXT`);
  if (!invoiceExtraCols.has('main_note')) db.exec(`ALTER TABLE invoices ADD COLUMN main_note TEXT`);
  if (!invoiceExtraCols.has('additional_note')) db.exec(`ALTER TABLE invoices ADD COLUMN additional_note TEXT`);
  if (!invoiceExtraCols.has('excise_amount')) db.exec(`ALTER TABLE invoices ADD COLUMN excise_amount REAL NOT NULL DEFAULT 0`);
  if (!invoiceExtraCols.has('vat_taxable_amount')) db.exec(`ALTER TABLE invoices ADD COLUMN vat_taxable_amount REAL NOT NULL DEFAULT 0`);
  if (!invoiceExtraCols.has('vat_non_taxable_amount')) db.exec(`ALTER TABLE invoices ADD COLUMN vat_non_taxable_amount REAL NOT NULL DEFAULT 0`);
  if (!invoiceExtraCols.has('vat_exempt_amount')) db.exec(`ALTER TABLE invoices ADD COLUMN vat_exempt_amount REAL NOT NULL DEFAULT 0`);
  if (!invoiceExtraCols.has('vat_zero_amount')) db.exec(`ALTER TABLE invoices ADD COLUMN vat_zero_amount REAL NOT NULL DEFAULT 0`);
  if (!invoiceExtraCols.has('road_tax_amount')) db.exec(`ALTER TABLE invoices ADD COLUMN road_tax_amount REAL NOT NULL DEFAULT 0`);
  if (!invoiceExtraCols.has('reason_text')) db.exec(`ALTER TABLE invoices ADD COLUMN reason_text TEXT`);
  if (!invoiceExtraCols.has('advance_series')) db.exec(`ALTER TABLE invoices ADD COLUMN advance_series TEXT`);
  if (!invoiceExtraCols.has('advance_number')) db.exec(`ALTER TABLE invoices ADD COLUMN advance_number TEXT`);
  if (!invoiceExtraCols.has('advance_amount')) db.exec(`ALTER TABLE invoices ADD COLUMN advance_amount REAL NOT NULL DEFAULT 0`);
  if (!invoiceExtraCols.has('document_key')) db.exec(`ALTER TABLE invoices ADD COLUMN document_key TEXT`);

  // v1.6 removes the legacy UNIQUE(company_id, invoice_no, direction)
  // constraint. The real business key also contains VÖEN, so two different
  // counterparties may legitimately use the same invoice number.
  const legacyUnique = db.prepare(`PRAGMA index_list(invoices)`).all().some(index => {
    if (index.origin !== 'u') return false;
    const columns = db.prepare(`PRAGMA index_info('${String(index.name).replace(/'/g,"''")}')`).all().map(x => x.name);
    return columns.join('|') === 'company_id|invoice_no|direction';
  });
  if (legacyUnique) {
    db.exec(`
      PRAGMA foreign_keys=OFF;
      BEGIN IMMEDIATE;
      CREATE TABLE invoices_v160 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        invoice_no TEXT NOT NULL,
        invoice_date TEXT NOT NULL,
        due_date TEXT,
        direction TEXT NOT NULL CHECK(direction IN ('Gələn','Gedən')),
        counterparty_id INTEGER,
        counterparty_name TEXT NOT NULL,
        voen TEXT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'AZN',
        base_amount REAL NOT NULL DEFAULT 0,
        vat_amount REAL NOT NULL DEFAULT 0,
        total_amount REAL NOT NULL DEFAULT 0,
        vat_rate REAL NOT NULL DEFAULT 18,
        status TEXT NOT NULL DEFAULT 'Qaralama',
        note TEXT,
        source TEXT NOT NULL DEFAULT 'manual',
        posting_profile_id INTEGER,
        counterparty_account_code TEXT,
        vat_posting_account_code TEXT,
        posting_status TEXT NOT NULL DEFAULT 'Hazırlanmayıb',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        invoice_series TEXT,
        source_file TEXT,
        invoice_type_name TEXT,
        main_note TEXT,
        additional_note TEXT,
        excise_amount REAL NOT NULL DEFAULT 0,
        vat_taxable_amount REAL NOT NULL DEFAULT 0,
        vat_non_taxable_amount REAL NOT NULL DEFAULT 0,
        vat_exempt_amount REAL NOT NULL DEFAULT 0,
        vat_zero_amount REAL NOT NULL DEFAULT 0,
        road_tax_amount REAL NOT NULL DEFAULT 0,
        reason_text TEXT,
        advance_series TEXT,
        advance_number TEXT,
        advance_amount REAL NOT NULL DEFAULT 0,
        document_key TEXT,
        FOREIGN KEY(company_id) REFERENCES companies(id),
        FOREIGN KEY(counterparty_id) REFERENCES counterparties(id)
      );
      INSERT INTO invoices_v160(
        id,company_id,invoice_no,invoice_date,due_date,direction,counterparty_id,counterparty_name,voen,currency,
        base_amount,vat_amount,total_amount,vat_rate,status,note,source,posting_profile_id,counterparty_account_code,
        vat_posting_account_code,posting_status,created_at,updated_at,deleted_at,invoice_series,source_file,
        invoice_type_name,main_note,additional_note,excise_amount,vat_taxable_amount,vat_non_taxable_amount,
        vat_exempt_amount,vat_zero_amount,road_tax_amount,reason_text,advance_series,advance_number,advance_amount,document_key
      )
      SELECT
        id,company_id,invoice_no,invoice_date,due_date,direction,counterparty_id,counterparty_name,voen,currency,
        base_amount,vat_amount,total_amount,vat_rate,status,note,source,posting_profile_id,counterparty_account_code,
        vat_posting_account_code,posting_status,created_at,updated_at,deleted_at,invoice_series,source_file,
        invoice_type_name,main_note,additional_note,excise_amount,vat_taxable_amount,vat_non_taxable_amount,
        vat_exempt_amount,vat_zero_amount,road_tax_amount,reason_text,advance_series,advance_number,advance_amount,document_key
      FROM invoices;
      DROP TABLE invoices;
      ALTER TABLE invoices_v160 RENAME TO invoices;
      COMMIT;
      PRAGMA foreign_keys=ON;
    `);
  }

  // v1.7 stores how the invoice direction was established. Older imports did
  // not retain this evidence, which made a later direction audit impossible.
  const directionCols = new Set(db.prepare(`PRAGMA table_info(invoices)`).all().map(x=>x.name));
  if (!directionCols.has('direction_source')) db.exec(`ALTER TABLE invoices ADD COLUMN direction_source TEXT`);
  if (!directionCols.has('direction_confidence')) db.exec(`ALTER TABLE invoices ADD COLUMN direction_confidence TEXT`);
  if (!directionCols.has('contract_id')) db.exec(`ALTER TABLE invoices ADD COLUMN contract_id INTEGER`);
  if (!directionCols.has('auto_posted')) db.exec(`ALTER TABLE invoices ADD COLUMN auto_posted INTEGER NOT NULL DEFAULT 0`);
  if (!directionCols.has('accounting_review_required')) db.exec(`ALTER TABLE invoices ADD COLUMN accounting_review_required INTEGER NOT NULL DEFAULT 0`);
  if (!directionCols.has('accounting_review_reason')) db.exec(`ALTER TABLE invoices ADD COLUMN accounting_review_reason TEXT`);

  const detailedItemCols = new Set(db.prepare(`PRAGMA table_info(invoice_items)`).all().map(x=>x.name));
  if (!detailedItemCols.has('subkonto_id')) db.exec(`ALTER TABLE invoice_items ADD COLUMN subkonto_id INTEGER`);
  if (!detailedItemCols.has('warehouse_id')) db.exec(`ALTER TABLE invoice_items ADD COLUMN warehouse_id INTEGER`);
  if (!detailedItemCols.has('posting_rule_id')) db.exec(`ALTER TABLE invoice_items ADD COLUMN posting_rule_id INTEGER`);
  if (!detailedItemCols.has('cost_amount')) db.exec(`ALTER TABLE invoice_items ADD COLUMN cost_amount REAL NOT NULL DEFAULT 0`);

  const journalLineCols = new Set(db.prepare(`PRAGMA table_info(journal_lines)`).all().map(x=>x.name));
  if (!journalLineCols.has('subkonto_id')) db.exec(`ALTER TABLE journal_lines ADD COLUMN subkonto_id INTEGER`);
  if (!journalLineCols.has('counterparty_id')) db.exec(`ALTER TABLE journal_lines ADD COLUMN counterparty_id INTEGER`);
  if (!journalLineCols.has('contract_id')) db.exec(`ALTER TABLE journal_lines ADD COLUMN contract_id INTEGER`);
  if (!journalLineCols.has('warehouse_id')) db.exec(`ALTER TABLE journal_lines ADD COLUMN warehouse_id INTEGER`);
  if (!journalLineCols.has('catalog_item_id')) db.exec(`ALTER TABLE journal_lines ADD COLUMN catalog_item_id INTEGER`);
  if (!journalLineCols.has('invoice_item_id')) db.exec(`ALTER TABLE journal_lines ADD COLUMN invoice_item_id INTEGER`);

  // v1.12 (schema 194) attributes opening balances to a counterparty/subkonto
  // instead of one lump-sum row per account. The old UNIQUE(account_code)
  // constraint made per-customer/per-supplier opening balances impossible,
  // which forced accountCounterparties()/accountAnalytics() to always show an
  // unexplained "Analitikasız açılış qalığı" line for receivable/payable
  // accounts that had any opening balance. Rebuilding without that
  // constraint (and with the new attribution columns) lets a company enter
  // its opening debtor/creditor balances split by real counterparty; rows
  // left unattributed (counterparty_id/subkonto_id NULL) keep behaving
  // exactly like before, so existing data and callers are unaffected.
  const openingBalanceCols = new Set(db.prepare(`PRAGMA table_info(opening_balances)`).all().map(x=>x.name));
  if (!openingBalanceCols.has('counterparty_id') || !openingBalanceCols.has('subkonto_id')) {
    db.exec(`
      PRAGMA foreign_keys=OFF;
      BEGIN IMMEDIATE;
      CREATE TABLE opening_balances_v194 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_code TEXT NOT NULL,
        counterparty_id INTEGER,
        subkonto_id INTEGER,
        debit REAL NOT NULL DEFAULT 0,
        credit REAL NOT NULL DEFAULT 0,
        note TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(account_code) REFERENCES accounts(code),
        FOREIGN KEY(counterparty_id) REFERENCES counterparties(id),
        FOREIGN KEY(subkonto_id) REFERENCES account_subcontos(id)
      );
      INSERT INTO opening_balances_v194(id,account_code,debit,credit,note,updated_at)
      SELECT id,account_code,debit,credit,note,updated_at FROM opening_balances;
      DROP TABLE opening_balances;
      ALTER TABLE opening_balances_v194 RENAME TO opening_balances;
      COMMIT;
      PRAGMA foreign_keys=ON;
    `);
  }

  const catalogCols = new Set(db.prepare(`PRAGMA table_info(item_catalog)`).all().map(x=>x.name));
  if (!catalogCols.has('standard_cost')) db.exec(`ALTER TABLE item_catalog ADD COLUMN standard_cost REAL NOT NULL DEFAULT 0`);

  const settingCols = new Set(db.prepare(`PRAGMA table_info(company_settings)`).all().map(x=>x.name));
  if (!settingCols.has('auto_post_invoices')) db.exec(`ALTER TABLE company_settings ADD COLUMN auto_post_invoices INTEGER NOT NULL DEFAULT 1`);
  if (!settingCols.has('default_warehouse_id')) db.exec(`ALTER TABLE company_settings ADD COLUMN default_warehouse_id INTEGER`);
  if (!settingCols.has('suspense_account_code')) db.exec(`ALTER TABLE company_settings ADD COLUMN suspense_account_code TEXT NOT NULL DEFAULT '721.99'`);
  if (!settingCols.has('functional_currency')) db.exec(`ALTER TABLE company_settings ADD COLUMN functional_currency TEXT NOT NULL DEFAULT 'AZN'`);
  if (!settingCols.has('closed_through_date')) db.exec(`ALTER TABLE company_settings ADD COLUMN closed_through_date TEXT`);

  const accountCols = new Set(db.prepare(`PRAGMA table_info(accounts)`).all().map(x=>x.name));
  if (!accountCols.has('role')) db.exec(`ALTER TABLE accounts ADD COLUMN role TEXT`);
  if (!accountCols.has('is_postable')) db.exec(`ALTER TABLE accounts ADD COLUMN is_postable INTEGER NOT NULL DEFAULT 1`);

  const currencyInvoiceCols = new Set(db.prepare(`PRAGMA table_info(invoices)`).all().map(x=>x.name));
  if (!currencyInvoiceCols.has('exchange_rate')) db.exec(`ALTER TABLE invoices ADD COLUMN exchange_rate REAL NOT NULL DEFAULT 1`);
  if (!currencyInvoiceCols.has('functional_total_amount')) db.exec(`ALTER TABLE invoices ADD COLUMN functional_total_amount REAL NOT NULL DEFAULT 0`);
  db.prepare(`UPDATE invoices SET exchange_rate=1 WHERE upper(COALESCE(currency,'AZN'))='AZN' AND COALESCE(exchange_rate,0)<>1`).run();
  db.prepare(`UPDATE invoices SET functional_total_amount=ROUND(total_amount*COALESCE(NULLIF(exchange_rate,0),1),2)
              WHERE upper(COALESCE(currency,'AZN'))='AZN' OR COALESCE(exchange_rate,0)>0`).run();

  const journalEntryCols = new Set(db.prepare(`PRAGMA table_info(journal_entries)`).all().map(x=>x.name));
  if (!journalEntryCols.has('reversal_of_id')) db.exec(`ALTER TABLE journal_entries ADD COLUMN reversal_of_id INTEGER`);
  if (!journalEntryCols.has('reversed_by_id')) db.exec(`ALTER TABLE journal_entries ADD COLUMN reversed_by_id INTEGER`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS bank_reconciliation_allocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reconciliation_id INTEGER NOT NULL,
      invoice_id INTEGER NOT NULL,
      payment_allocation_id INTEGER NOT NULL,
      amount REAL NOT NULL CHECK(amount>0),
      FOREIGN KEY(reconciliation_id) REFERENCES bank_reconciliations(id) ON DELETE CASCADE,
      FOREIGN KEY(invoice_id) REFERENCES invoices(id),
      FOREIGN KEY(payment_allocation_id) REFERENCES payment_allocations(id)
    );
    CREATE TABLE IF NOT EXISTS import_rejections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_type TEXT NOT NULL,
      source_name TEXT,
      row_number INTEGER,
      raw_json TEXT NOT NULL,
      error_message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS vat_invoice_settings (
      invoice_id INTEGER PRIMARY KEY,
      treatment TEXT NOT NULL DEFAULT 'STANDARD'
        CHECK(treatment IN ('STANDARD','NON_DEDUCTIBLE','CUSTOMS','EXEMPT','ZERO')),
      note TEXT,
      updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS vat_payment_allocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL,
      bank_transaction_id INTEGER NOT NULL,
      payment_kind TEXT NOT NULL CHECK(payment_kind IN ('VAT_DEPOSIT','CUSTOMS_VAT')),
      payment_date TEXT NOT NULL,
      amount_azn REAL NOT NULL CHECK(amount_azn>0),
      source TEXT NOT NULL DEFAULT 'manual',
      note TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(invoice_id,bank_transaction_id,payment_kind),
      FOREIGN KEY(invoice_id) REFERENCES invoices(id),
      FOREIGN KEY(bank_transaction_id) REFERENCES bank_transactions(id)
    );
    CREATE TABLE IF NOT EXISTS vat_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER,
      adjustment_date TEXT NOT NULL,
      vat_side TEXT NOT NULL CHECK(vat_side IN ('INPUT','OUTPUT')),
      amount_azn REAL NOT NULL CHECK(ABS(amount_azn)>0.004),
      contra_account_code TEXT,
      reason TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(invoice_id) REFERENCES invoices(id)
    );
    CREATE TABLE IF NOT EXISTS vat_periods (
      period_key TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','CLOSED')),
      snapshot_json TEXT,
      closed_by TEXT,
      closed_at TEXT,
      reopened_by TEXT,
      reopened_at TEXT,
      reopen_reason TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bank_recon_alloc_recon ON bank_reconciliation_allocations(reconciliation_id,id);
    CREATE INDEX IF NOT EXISTS idx_import_rejections_date ON import_rejections(created_at,id);
    CREATE INDEX IF NOT EXISTS idx_vat_payment_invoice_date ON vat_payment_allocations(invoice_id,payment_date,id);
    CREATE INDEX IF NOT EXISTS idx_vat_payment_bank ON vat_payment_allocations(bank_transaction_id,id);
    CREATE INDEX IF NOT EXISTS idx_vat_adjustment_date ON vat_adjustments(adjustment_date,vat_side,id);
    CREATE INDEX IF NOT EXISTS idx_vat_period_status ON vat_periods(status,period_key);
  `);

  const vatAdjustmentColumns=new Set(db.prepare(`PRAGMA table_info(vat_adjustments)`).all().map(column=>column.name));
  if(!vatAdjustmentColumns.has('contra_account_code'))db.exec(`ALTER TABLE vat_adjustments ADD COLUMN contra_account_code TEXT`);

  db.exec(`DROP INDEX IF EXISTS uq_invoices_document_key`);


  // Ensure legacy rows have valid posting defaults before repair/DBC logic.
  db.prepare(`UPDATE invoices SET counterparty_account_code=COALESCE(NULLIF(counterparty_account_code,''),CASE WHEN direction='Gedən' THEN '211.01' ELSE '531.01' END),
             vat_posting_account_code=COALESCE(NULLIF(vat_posting_account_code,''),CASE WHEN direction='Gedən' THEN '521.01' ELSE '241.01' END)
             WHERE deleted_at IS NULL`).run();

  // Legacy source evidence may be documented, but opening the database must
  // never silently move an existing invoice between incoming and outgoing.
  // Direction correction is an explicit user/audit operation.
  db.prepare(`UPDATE invoices SET direction_source='Fayl adı (v1.7 bərpası)', direction_confidence='medium'
             WHERE source IN ('file-import','import') AND COALESCE(direction_source,'')='' AND
               (lower(COALESCE(source_file,'')) LIKE '%gələnlər%' OR lower(COALESCE(source_file,'')) LIKE '%daxil olan%' OR
                lower(COALESCE(source_file,'')) LIKE '%göndərilənlər%' OR lower(COALESCE(source_file,'')) LIKE '%göndərilən%')`).run();
  db.exec(`
    UPDATE invoices SET invoice_no=TRIM(CASE WHEN COALESCE(invoice_series,'')<>'' THEN invoice_series||' '||invoice_no ELSE invoice_no END)
    WHERE COALESCE(invoice_series,'')<>'' AND invoice_no NOT LIKE invoice_series||'%';
  `);
  db.prepare(`UPDATE invoices SET document_key=upper(trim(invoice_no))||'|'||trim(voen)||'|'||direction`).run();
  // Preserve legacy duplicates for audit without allowing new duplicates.
  db.prepare(`UPDATE invoices SET document_key=document_key||'|LEGACY-'||id
              WHERE id NOT IN (SELECT MIN(id) FROM invoices GROUP BY company_id,upper(trim(invoice_no)),trim(voen),direction)`).run();
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_document_key ON invoices(document_key)`);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_invoices_company_date ON invoices(company_id, invoice_date, id);
    CREATE INDEX IF NOT EXISTS idx_invoices_cp ON invoices(counterparty_id, direction, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id, line_no);
    CREATE INDEX IF NOT EXISTS idx_invoice_items_type_account ON invoice_items(invoice_id, item_type, posting_account_code);
    CREATE INDEX IF NOT EXISTS idx_payment_alloc_invoice ON payment_allocations(invoice_id);
    CREATE INDEX IF NOT EXISTS idx_journal_source ON journal_entries(source_type, source_id);
    CREATE INDEX IF NOT EXISTS idx_journal_entry_date ON journal_entries(company_id, entry_date, status);
    CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_lines(account_code, journal_entry_id);
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id, id);
    CREATE INDEX IF NOT EXISTS idx_invoice_status_history ON invoice_status_history(invoice_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_documents_entity ON documents(entity_type, entity_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_item_catalog_company_code ON item_catalog(company_id, code);
    CREATE INDEX IF NOT EXISTS idx_item_catalog_active ON item_catalog(company_id, active, item_type);
    CREATE INDEX IF NOT EXISTS idx_bank_tx_account_date ON bank_transactions(bank_account_id, transaction_date, id);
    CREATE INDEX IF NOT EXISTS idx_bank_tx_status ON bank_transactions(reconciliation_status, transaction_date);
    CREATE INDEX IF NOT EXISTS idx_bank_recon_invoice ON bank_reconciliations(invoice_id);
    CREATE INDEX IF NOT EXISTS idx_contract_counterparty ON counterparty_contracts(counterparty_id,active,contract_no);
    CREATE INDEX IF NOT EXISTS idx_subconto_account ON account_subcontos(account_code,active,name);
    CREATE INDEX IF NOT EXISTS idx_warehouse_active ON warehouses(company_id,active,is_default);
    CREATE INDEX IF NOT EXISTS idx_posting_rules_lookup ON posting_rules(company_id,active,direction,item_type,priority);
    CREATE INDEX IF NOT EXISTS idx_stock_scope_date ON stock_movements(warehouse_id,catalog_item_id,movement_date,id);
    CREATE INDEX IF NOT EXISTS idx_journal_analytics ON journal_lines(account_code,subkonto_id,counterparty_id,warehouse_id);
    CREATE INDEX IF NOT EXISTS idx_opening_balances_account ON opening_balances(account_code,counterparty_id,subkonto_id);
  `);

  if (options.companyMeta) {
    db.prepare(`INSERT OR IGNORE INTO companies(id,name,voen,currency,created_at) VALUES(1,?,?,?,?)`)
      .run(String(options.companyMeta.name||'Şirkət bazası'), String(options.companyMeta.voen||''), String(options.companyMeta.currency||'AZN'), nowIso());
  }

  const accounts = [
    ['201','Material ehtiyatları','asset',null,null,0],
    ['205','Mal-material və əmtəə ehtiyatları','asset',null,null,0],
    ['211','Debitor borcları','asset',null,null,0],
    ['223','Bank hesabları','asset',null,null,0],
    ['241','Əvəzləşdirilən ƏDV','asset',null,null,0],
    ['521','Vergi öhdəlikləri','liability',null,null,0],
    ['531','Kreditor borcları','liability',null,null,0],
    ['601','Satış gəlirləri','income',null,null,0],
    ['701','Satışın maya dəyəri','expense',null,null,0],
    ['721','İnzibati və təsərrüfat xərcləri','expense',null,null,0],
    ['723','Məzənnə fərqləri','expense',null,null,0],
    ['205.01','Mal-material və əmtəə ehtiyatları','asset','205','INVENTORY',1],
    ['205.02','Əmtəə və materiallar','asset','205','INVENTORY',1],
    ['201.01','Material ehtiyatları','asset','201','INVENTORY',1],
    ['211.01','Alıcılar və sifarişçilər','asset','211','RECEIVABLE',1],
    ['223.01','Bank hesabları','asset','223','BANK',1],
    ['241.01','Əvəzləşdirilən ƏDV','asset','241','INPUT_VAT',1],
    ['521.01','Vergilər üzrə öhdəliklər','liability','521','OUTPUT_VAT',1],
    ['531.01','Malsatanlar və podratçılar','liability','531','PAYABLE',1],
    ['601.01','Malların satış gəlirləri','income','601','SALES_GOODS',1],
    ['601.02','Xidmətlərin satış gəlirləri','income','601','SALES_SERVICE',1],
    ['701.01','Satılmış malların maya dəyəri','expense','701','COGS',1],
    ['721.01','İnzibati və təsərrüfat xərcləri','expense','721','EXPENSE',1],
    ['721.99','Təsnifləşdirilməmiş inzibati xərclər','expense','721','SUSPENSE_EXPENSE',1],
    ['723.01','Məzənnə fərqindən xərclər','expense','723','FX_LOSS',1],
    ['723.02','Məzənnə fərqindən gəlirlər','income','723','FX_GAIN',1]
  ];
  const acc = db.prepare(`INSERT OR IGNORE INTO accounts(code,name,kind,parent_code,role,is_postable) VALUES(?,?,?,?,?,?)`);
  for (const a of accounts) {
    acc.run(...a);
    db.prepare(`UPDATE accounts SET role=COALESCE(NULLIF(role,''),?),is_postable=? WHERE code=?`).run(a[4],a[5],a[0]);
  }

  const profiles = [
    ['PURCHASE_STANDARD','Gələn e-qaimə — standart','Gələn','201.01','241.01','531.01',''],
    ['SALE_STANDARD','Gedən e-qaimə — standart','Gedən','211.01','','601.01','521.01']
  ];
  const prof = db.prepare(`INSERT OR IGNORE INTO posting_profiles(code,name,direction,base_debit_code,vat_debit_code,base_credit_code,vat_credit_code) VALUES(?,?,?,?,?,?,?)`);
  for (const p of profiles) prof.run(...p);

  const catalog = [
    ['MAT-001','Qəhvə dənəsi Arabica','Mal','kq','205.01','601.01','205.01','241.01','521.01'],
    ['MAT-014','Karton qablaşdırma','Mal','ədəd','205.01','601.01','205.01','241.01','521.01'],
    ['SRV-001','Nəqliyyat xidməti','Xidmət','xidmət','721.01','601.01','','241.01','521.01']
  ];
  db.prepare(`INSERT OR IGNORE INTO company_settings(id,accounting_enabled,auto_post_invoices,suspense_account_code,functional_currency,updated_at) VALUES(1,1,1,'721.99','AZN',?)`).run(nowIso());
  db.prepare(`UPDATE company_settings SET accounting_enabled=1,auto_post_invoices=1,suspense_account_code=COALESCE(NULLIF(suspense_account_code,''),'721.99'),functional_currency=COALESCE(NULLIF(functional_currency,''),'AZN'),updated_at=? WHERE id=1`).run(nowIso());
  db.prepare(`INSERT OR IGNORE INTO dvx_integration(id,updated_at) VALUES(1,?)`).run(nowIso());

  const catStmt=db.prepare(`INSERT OR IGNORE INTO item_catalog(company_id,code,name,item_type,unit,purchase_account_code,sales_account_code,inventory_account_code,purchase_vat_account_code,sales_vat_account_code,active,created_at,updated_at) VALUES(1,?,?,?,?,?,?,?,?,?,1,?,?)`);
  for (const c of catalog) catStmt.run(...c,nowIso(),nowIso());
  // Defaults only fill missing legacy values. A user's explicit inventory
  // account selection must survive application restarts unchanged.
  db.prepare(`UPDATE item_catalog
    SET purchase_account_code=COALESCE(NULLIF(purchase_account_code,''),'205.01'),
        inventory_account_code=COALESCE(NULLIF(inventory_account_code,''),NULLIF(purchase_account_code,''),'205.01'),
        updated_at=?
    WHERE company_id=1 AND item_type='Mal'
      AND (COALESCE(purchase_account_code,'')='' OR COALESCE(inventory_account_code,'')='')`).run(nowIso());

  const warehouseInsert=db.prepare(`INSERT OR IGNORE INTO warehouses(company_id,code,name,valuation_method,inventory_account_code,cogs_account_code,allow_negative_stock,is_default,active,created_at,updated_at) VALUES(1,?,?,?,?,?,0,1,1,?,?)`);
  warehouseInsert.run('MAIN','Əsas anbar','AVERAGE','205.01','701.01',nowIso(),nowIso());
  const defaultWarehouse=db.prepare(`SELECT id FROM warehouses WHERE company_id=1 AND active=1 ORDER BY is_default DESC,id LIMIT 1`).get();
  if(defaultWarehouse) db.prepare(`UPDATE company_settings SET default_warehouse_id=COALESCE(default_warehouse_id,?) WHERE id=1`).run(defaultWarehouse.id);

  const subkontoInsert=db.prepare(`INSERT OR IGNORE INTO account_subcontos(account_code,code,name,dimension,active,created_at,updated_at) VALUES(?,?,?,?,1,?,?)`);
  for(const subkonto of [
    ['721.01','OFFICE','Ofis və inzibati xərclər','Xərc maddəsi'],
    ['721.01','TRANSPORT','Nəqliyyat və ekspedisiya xərci','Xərc maddəsi'],
    ['721.01','TELECOM','Telefon, internet və rabitə xərci','Xərc maddəsi'],
    ['721.01','MEAL','Yemək və işçi təminatı xərci','Xərc maddəsi'],
    ['721.01','RENT','İcarə xərci','Xərc maddəsi'],
    ['721.01','INSURANCE','Sığorta xərci','Xərc maddəsi'],
    ['721.01','PROFESSIONAL','Audit, hüquq və məsləhət xidməti','Xərc maddəsi'],
    ['721.01','OTHER','Digər inzibati və təsərrüfat xərcləri','Xərc maddəsi'],
    ['721.99','UNCLASSIFIED','Təsnifləşdirilməmiş xərc','Xərc maddəsi'],
    ['205.01','GOODS','Mallar','Mal qrupu'],
    ['211.01','CUSTOMERS','Debitorlar','Kontragent qrupu'],
    ['531.01','SUPPLIERS','Kreditorlar','Kontragent qrupu']
  ]) subkontoInsert.run(...subkonto,nowIso(),nowIso());

  const ruleInsert=db.prepare(`INSERT INTO posting_rules(company_id,name,priority,direction,item_type,match_field,match_value,account_code,subkonto_id,warehouse_id,active,created_at,updated_at)
    SELECT 1,?,?,?,?,?,?,?,?,?,1,?,? WHERE NOT EXISTS(SELECT 1 FROM posting_rules WHERE company_id=1 AND name=?)`);
  const addRule=(name,priority,direction,itemType,field,value,accountCode,subkontoId,warehouseId)=>ruleInsert.run(name,priority,direction,itemType,field,value,accountCode,subkontoId||null,warehouseId||null,nowIso(),nowIso(),name);
  const expenseSubkontoId=code=>db.prepare(`SELECT id FROM account_subcontos WHERE account_code='721.01' AND code=? AND active=1`).get(code)?.id||null;
  const expenseRules=[
    ['Rabitə — internet',20,'internet','TELECOM'],['Rabitə — telefon',21,'telefon','TELECOM'],
    ['Rabitə — mobil',22,'mobil','TELECOM'],['Rabitə — telekom',23,'telekom','TELECOM'],
    ['Rabitə xidməti',24,'rabitə','TELECOM'],['Nəqliyyat xidməti',30,'nəqliyyat','TRANSPORT'],
    ['Daşıma xidməti',31,'daşıma','TRANSPORT'],['Ekspedisiya xidməti',32,'ekspedisiya','TRANSPORT'],
    ['Kuryer xidməti',33,'kuryer','TRANSPORT'],['Yemək xərci',40,'yemək','MEAL'],
    ['Qida və katerinq',41,'katerinq','MEAL'],['İcarə xərci',50,'icarə','RENT'],
    ['Sığorta xərci',60,'sığorta','INSURANCE'],['Audit xidməti',70,'audit','PROFESSIONAL'],
    ['Məsləhət xidməti',71,'məsləhət','PROFESSIONAL'],['Ofis xərci',80,'ofis','OFFICE'],
    ['Dəftərxana xərci',81,'dəftərxana','OFFICE']
  ];
  for(const [name,priority,keyword,subkontoCode] of expenseRules){
    addRule(name,priority,'Gələn','Xidmət','all',keyword,'721.01',expenseSubkontoId(subkontoCode),null);
  }

  repairPollutedCounterpartyNames();
  migrateExpenseAccountsToSubcontos();
  migrateExistingInvoicesToAutomaticAccounting();
  repairAutomaticInvoiceAccountingIntegrity();
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_active_invoice_journal
             ON journal_entries(source_id) WHERE source_type='invoice' AND status='Təsdiqlənib'`);
  } catch (indexError) {
    console.warn('MEYAR: aktiv qaimə jurnalı unikallığı yaradıla bilmədi:', indexError.message);
  }

    db.exec(`PRAGMA user_version=${DB_SCHEMA_VERSION}`);

    // New company bases start clean: no demo counterparties or fake invoices are inserted.
  } catch (migrationError) {
    if (db) { try { db.close(); } catch (_) {} db = null; }
    if (migrationBackupPath) {
      try {
        restoreMigrationBackup(dbPath, migrationBackupPath);
      } catch (restoreError) {
        throw new Error(`Baza migrasiyası və avtomatik bərpa alınmadı: ${migrationError.message}. Bərpa xətası: ${restoreError.message}`);
      }
      throw new Error(`Baza migrasiyası alınmadı və əvvəlki baza avtomatik bərpa edildi: ${migrationError.message}`);
    }
    throw migrationError;
  }
}

function seedInvoice(x) {
  const cp = db.prepare(`SELECT id FROM counterparties WHERE voen=?`).get(x.voen);
  const t = nowIso();
  const result = db.prepare(`INSERT INTO invoices(company_id,invoice_no,invoice_date,due_date,direction,counterparty_id,counterparty_name,voen,currency,base_amount,vat_amount,total_amount,vat_rate,status,source,created_at,updated_at) VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?,?,'seed',?,?)`)
    .run(x.no,x.date,x.due,x.direction,cp?.id || null,x.name,x.voen,'AZN',x.base,x.vat,x.total,18,x.status,t,t);
  db.prepare(`INSERT INTO invoice_items(invoice_id,line_no,item_code,description,qty,unit,unit_price,discount_rate,vat_rate,base_amount,vat_amount,total_amount,catalog_item_id) VALUES(?,?,?,?,1,'ədəd',?,?,?, ?,?,?,?)`)
    .run(result.lastInsertRowid,1,'SEED',x.direction==='Gələn'?'İlkin qaimə sətri':'İlkin satış sətri',x.base,0,18,x.base,x.vat,x.total,null);
}

function audit(action, entityType, entityId, before, after) {
  db.prepare(`INSERT INTO audit_log(user_name,action,entity_type,entity_id,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?)`)
    .run(currentUserName(), action, entityType, entityId || null, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, nowIso());
}

function invoiceFilterSql({type='all', search='', status='all', payment='all', from='', to='', archived=false, reviewOnly=false} = {}) {
  const where = [`i.company_id=1`];
  const params = [];
  if (archived || type === 'archive') {
    where.push(`i.deleted_at IS NOT NULL`);
  } else {
    where.push(`i.deleted_at IS NULL`);
  }
  if (type !== 'all' && type !== 'archive' && type !== 'draft') { where.push(`i.direction=?`); params.push(type); }
  if (status !== 'all') { where.push(`i.status=?`); params.push(status); }
  if (reviewOnly) { where.push(`i.accounting_review_required=1`); }
  if (from) { where.push(`i.invoice_date>=?`); params.push(from); }
  if (to) { where.push(`i.invoice_date<=?`); params.push(to); }
  if (search) {
    where.push(`(lower(i.invoice_no) LIKE ? OR lower(i.counterparty_name) LIKE ? OR i.voen LIKE ? OR printf('%.2f',i.total_amount) LIKE ?)`);
    const q=`%${search.toLowerCase()}%`; params.push(q,q,`%${search}%`,q);
  }
  const paidExpr = `COALESCE(paid.paid_amount,0)`;
  if (payment === 'Ödənilməyib') where.push(`${paidExpr}=0`);
  if (payment === 'Qismən ödənilib') where.push(`${paidExpr}>0 AND ${paidExpr}<i.total_amount-0.005`);
  if (payment === 'Ödənilib') where.push(`${paidExpr}>=i.total_amount-0.005`);

  return {whereSql:where.join(' AND '),params,paidExpr};
}

function invoiceRows(options = {}, maximumLimit=1000) {
  const {limit=500,offset=0}=options;
  const {whereSql,params,paidExpr}=invoiceFilterSql(options);

  const safeMaximum=Math.min(50000,Math.max(1,Number(maximumLimit)||1000));
  const safeLimit=Math.min(safeMaximum,Math.max(1,Number(limit)||500)),safeOffset=Math.max(0,Number(offset)||0);
  const rows = db.prepare(`
    SELECT i.*, ${paidExpr} AS paid_amount,COALESCE(items.service_base_amount,0) service_base_amount,COALESCE(items.goods_base_amount,0) goods_base_amount
    FROM invoices i
    LEFT JOIN (
      SELECT invoice_id,SUM(amount) paid_amount FROM (
        SELECT invoice_id,amount FROM payment_allocations
        UNION ALL
        SELECT v.invoice_id,v.amount_azn/COALESCE(NULLIF(iv.exchange_rate,0),1)
        FROM vat_payment_allocations v JOIN invoices iv ON iv.id=v.invoice_id WHERE iv.direction='Gələn'
      ) GROUP BY invoice_id
    ) paid ON paid.invoice_id=i.id
    LEFT JOIN (SELECT invoice_id,SUM(CASE WHEN item_type='Xidmət' THEN base_amount ELSE 0 END) service_base_amount,SUM(CASE WHEN COALESCE(item_type,'Mal')='Mal' THEN base_amount ELSE 0 END) goods_base_amount FROM invoice_items GROUP BY invoice_id) items ON items.invoice_id=i.id
    WHERE ${whereSql} ORDER BY i.invoice_date DESC, i.id DESC LIMIT ? OFFSET ?
  `).all(...params,safeLimit,safeOffset);
  return rows.map(r => ({...r, outstanding_amount: round2(Math.max(0, Number(r.total_amount) - Number(r.paid_amount)))})).map(safePlain);
}

function invoiceCount(options = {}) {
  const {whereSql,params}=invoiceFilterSql(options);
  const row=db.prepare(`
    SELECT COUNT(*) AS total
    FROM invoices i
    LEFT JOIN (
      SELECT invoice_id,SUM(amount) paid_amount FROM (
        SELECT invoice_id,amount FROM payment_allocations
        UNION ALL
        SELECT v.invoice_id,v.amount_azn/COALESCE(NULLIF(iv.exchange_rate,0),1)
        FROM vat_payment_allocations v JOIN invoices iv ON iv.id=v.invoice_id WHERE iv.direction='Gələn'
      ) GROUP BY invoice_id
    ) paid ON paid.invoice_id=i.id
    WHERE ${whereSql}
  `).get(...params);
  return Number(row?.total||0);
}

function invoiceFinancialSummary() {
  const rows=db.prepare(`
    SELECT i.direction,i.currency,ROUND(SUM(MAX(0,i.total_amount-COALESCE(paid.paid_amount,0))),2) AS outstanding_amount,
      ROUND(SUM(MAX(0,i.total_amount-COALESCE(paid.paid_amount,0))*CASE WHEN i.currency='AZN' THEN 1 ELSE COALESCE(NULLIF(i.exchange_rate,0),1) END),2) AS functional_outstanding_amount
    FROM invoices i
    LEFT JOIN (
      SELECT invoice_id,SUM(amount) paid_amount FROM (
        SELECT invoice_id,amount FROM payment_allocations
        UNION ALL
        SELECT v.invoice_id,v.amount_azn/COALESCE(NULLIF(iv.exchange_rate,0),1)
        FROM vat_payment_allocations v JOIN invoices iv ON iv.id=v.invoice_id WHERE iv.direction='Gələn'
      ) GROUP BY invoice_id
    ) paid ON paid.invoice_id=i.id
    WHERE i.company_id=1 AND i.deleted_at IS NULL
    GROUP BY i.direction,i.currency
  `).all();
  const functionalTotal=direction=>round2(rows.filter(row=>row.direction===direction).reduce((sum,row)=>sum+Number(row.functional_outstanding_amount||0),0));
  return safePlain({receivableAzn:functionalTotal('Gedən'),payableAzn:functionalTotal('Gələn'),byCurrency:rows});
}

function safePlain(value) {
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(safePlain);
  if (value && typeof value === 'object') { const o={}; for (const [k,v] of Object.entries(value)) o[k]=safePlain(v); return o; }
  return value;
}

function invoiceDetail(id, includeArchived=false) {
  const invoice = db.prepare(`SELECT i.*, pp.code AS posting_profile_code, pp.name AS posting_profile_name,
    COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa WHERE pa.invoice_id=i.id),0) AS ordinary_paid_amount,
    CASE WHEN i.direction='Gələn' THEN COALESCE((SELECT SUM(v.amount_azn) FROM vat_payment_allocations v WHERE v.invoice_id=i.id),0) ELSE 0 END AS vat_paid_amount_azn
    FROM invoices i LEFT JOIN posting_profiles pp ON pp.id=i.posting_profile_id WHERE i.id=? AND (${includeArchived ? '1=1' : 'i.deleted_at IS NULL'})`).get(id);
  if (!invoice) return null;
  invoice.vat_paid_amount=invoice.direction==='Gələn'?round2(Number(invoice.vat_paid_amount_azn||0)/Number(invoice.exchange_rate||1)):0;
  invoice.paid_amount=round2(Number(invoice.ordinary_paid_amount||0)+Number(invoice.vat_paid_amount||0));
  invoice.outstanding_amount = Math.max(0, invoice.total_amount - invoice.paid_amount);
  invoice.items = db.prepare(`SELECT ii.*,s.code subkonto_code,s.name subkonto_name,w.name warehouse_name,w.valuation_method
    FROM invoice_items ii
    LEFT JOIN account_subcontos s ON s.id=ii.subkonto_id
    LEFT JOIN warehouses w ON w.id=ii.warehouse_id
    WHERE ii.invoice_id=? ORDER BY ii.line_no`).all(id);
  const ordinaryPayments = db.prepare(`
    SELECT p.id,p.payment_date,p.document_no,p.amount,pa.amount AS allocated_amount,p.source
    FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id WHERE pa.invoice_id=? ORDER BY p.payment_date DESC,p.id DESC
  `).all(id);
  const vatPayments=db.prepare(`SELECT v.id,v.payment_date,COALESCE(NULLIF(bt.reference,''),CASE WHEN v.payment_kind='CUSTOMS_VAT' THEN 'Gömrük ƏDV-si' ELSE 'ƏDV depoziti' END) document_no,
      v.amount_azn amount,v.amount_azn/COALESCE(NULLIF(i.exchange_rate,0),1) allocated_amount,'vat-payment' source,v.payment_kind
    FROM vat_payment_allocations v JOIN bank_transactions bt ON bt.id=v.bank_transaction_id JOIN invoices i ON i.id=v.invoice_id
    WHERE v.invoice_id=? ORDER BY v.payment_date DESC,v.id DESC`).all(id);
  invoice.payments=[...ordinaryPayments,...vatPayments].sort((left,right)=>String(right.payment_date).localeCompare(String(left.payment_date))||Number(right.id)-Number(left.id));
  invoice.journal = db.prepare(`
    SELECT j.id,j.entry_date,j.status,j.description,l.account_code,l.debit,l.credit,l.analytic_type,l.analytic_key,
           l.subkonto_id,l.counterparty_id,l.contract_id,l.warehouse_id,l.catalog_item_id,l.invoice_item_id
    FROM journal_entries j LEFT JOIN journal_lines l ON l.journal_entry_id=j.id WHERE j.source_type='invoice' AND j.source_id=? ORDER BY j.id DESC,l.id
  `).all(id);
  invoice.status_history = invoiceStatusHistory(id);
  invoice.documents = db.prepare(`SELECT * FROM documents WHERE entity_type='E-Qaimə' AND entity_id=? ORDER BY id DESC`).all(id);
  return safePlain(invoice);
}

function ensureCounterparty(name, voen, direction) {
  name=sanitizeCounterpartyName(name);
  if(!name) throw new Error('Kontragent adı oxunmadı. DVX sətrini və ya idxal sütunlarını yoxlayın.');
  const existing = db.prepare(`SELECT * FROM counterparties WHERE voen=?`).get(voen);
  const account = defaultCounterpartyAccount(direction);
  if (existing) {
    const customer=Number(existing.is_customer||0) || direction==='Gedən' ? 1 : 0;
    const supplier=Number(existing.is_supplier||0) || direction==='Gələn' ? 1 : 0;
    const type=customer && supplier ? 'Debitor/Kreditor' : customer ? 'Debitor' : 'Kreditor';
    db.prepare(`UPDATE counterparties SET name=?,type=?,account_code=?,is_customer=?,is_supplier=?,receivable_account_code=COALESCE(receivable_account_code,?),payable_account_code=COALESCE(payable_account_code,?),updated_at=? WHERE id=?`).run(name,type,account,customer,supplier,accountByRole('RECEIVABLE','211.01'),accountByRole('PAYABLE','531.01'),nowIso(),existing.id);
    return existing.id;
  }
  const isCustomer=direction==='Gedən'?1:0,isSupplier=direction==='Gələn'?1:0;
  const res = db.prepare(`INSERT INTO counterparties(name,voen,type,account_code,receivable_account_code,payable_account_code,is_customer,is_supplier,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?, 'Aktiv', ?, ?)` )
    .run(name,voen,isCustomer?'Debitor':'Kreditor',account,accountByRole('RECEIVABLE','211.01'),accountByRole('PAYABLE','531.01'),isCustomer,isSupplier,nowIso(),nowIso());
  return Number(res.lastInsertRowid);
}

function validateInvoicePayload(p) {
  if (!p.invoice_no?.trim()) throw new Error('Qaimə nömrəsi daxil edilməlidir.');
  if (!isValidIsoDate(p.invoice_date)) throw new Error('Qaimə tarixi düzgün daxil edilməlidir.');
  if (p.due_date && (!isValidIsoDate(p.due_date) || p.due_date < p.invoice_date)) throw new Error('Son ödəniş tarixi düzgün olmalı və qaimə tarixindən əvvəl olmamalıdır.');
  if (!['Gələn','Gedən'].includes(p.direction)) throw new Error('Qaimə növü düzgün deyil.');
  if (!['AZN','USD','EUR'].includes(String(p.currency||'AZN').toUpperCase())) throw new Error('Valyuta AZN, USD və ya EUR olmalıdır.');
  if (String(p.currency||'AZN').toUpperCase()!=='AZN' && (!(Number(p.exchange_rate)>0) || !Number.isFinite(Number(p.exchange_rate)))) throw new Error('Xarici valyutalı qaimə üçün müsbət AZN məzənnəsi daxil edilməlidir.');
  if (!p.counterparty_name?.trim()) throw new Error('Kontragent adı daxil edilməlidir.');
  if (!/^\d{10}$/.test(String(p.voen || '').trim())) throw new Error('VÖEN 10 rəqəm olmalıdır.');
  if (!Array.isArray(p.items) || !p.items.length) throw new Error('Qaimədə ən azı bir sətir olmalıdır.');
  for (const [idx,x] of p.items.entries()) {
    if (!String(x.description||'').trim()) throw new Error(`Qaimə sətri ${idx+1}: mal/xidmət adı daxil edilməlidir.`);
    if (Number(x.qty||0) <= 0) throw new Error(`Qaimə sətri ${idx+1}: miqdar 0-dan böyük olmalıdır.`);
    if (Number(x.unit_price||0) < 0) throw new Error(`Qaimə sətri ${idx+1}: vahid qiymət mənfi ola bilməz.`);
    if (Number(x.discount_rate||0) < 0 || Number(x.discount_rate||0) > 100) throw new Error(`Qaimə sətri ${idx+1}: endirim 0-100 aralığında olmalıdır.`);
    if (Number(x.vat_rate||0) < 0 || Number(x.vat_rate||0) > 100) throw new Error(`Qaimə sətri ${idx+1}: ƏDV 0-100 aralığında olmalıdır.`);
  }
  const totalBase = p.items.reduce((s,x)=>s+Number(x.base_amount||0),0);
  const totalVat = p.items.reduce((s,x)=>s+Number(x.vat_amount||0),0);
  if (totalBase <= 0) throw new Error('Qaimənin əsas məbləği 0-dan böyük olmalıdır.');
  return {base_amount: round2(totalBase), vat_amount: round2(totalVat), total_amount: round2(totalBase+totalVat)};
}

const round2 = n => Math.round((Number(n)||0)*100)/100;
const invoiceBusinessKey = (invoiceNo, voen, direction) =>
  `${String(invoiceNo||'').trim().toUpperCase()}|${String(voen||'').trim()}|${direction}`;

function allowedStatusTransition(from, to) {
  if (!from) return ['Qaralama','Gözləyir','Göndərilib','Təsdiqlənib'].includes(to);
  const allowed = {
    'Qaralama': new Set(['Qaralama','Gözləyir','Göndərilib','Təsdiqlənib']),
    'Gözləyir': new Set(['Gözləyir','Göndərilib','Təsdiqlənib']),
    'Göndərilib': new Set(['Göndərilib','Təsdiqlənib']),
    'Təsdiqlənib': new Set(['Təsdiqlənib'])
  };
  return !!allowed[from]?.has(to);
}

function recordStatusTransition(invoiceId, from, to, reason='') {
  if (from === to) return;
  if (!allowedStatusTransition(from, to)) throw new Error(`Status ${from} → ${to} keçidi icazəli deyil.`);
  db.prepare(`INSERT INTO invoice_status_history(invoice_id,from_status,to_status,reason,changed_by,changed_at) VALUES(?,?,?,?,?,?)`)
    .run(invoiceId, from || null, to, reason || null, currentUserName(), nowIso());
}

function invoiceStatusHistory(id) {
  return db.prepare(`SELECT * FROM invoice_status_history WHERE invoice_id=? ORDER BY id DESC`).all(id);
}

function paymentCandidates({invoiceId, direction, counterpartyId}) {
  const rows = db.prepare(`
    SELECT p.id,p.payment_date,p.document_no,p.amount,p.currency,p.source,p.counterparty_id,p.counterparty_name,
           COALESCE((SELECT SUM(pa2.amount) FROM payment_allocations pa2 WHERE pa2.payment_id=p.id),0) AS allocated_total
    FROM payments p
    WHERE p.company_id=1
      AND p.counterparty_id IS NOT NULL
      AND (? IS NULL OR p.counterparty_id=?)
    ORDER BY p.payment_date DESC,p.id DESC
  `).all(counterpartyId ?? null, counterpartyId ?? null);
  return rows.map(r => ({...r, available_amount: Math.max(0, Number(r.amount)-Number(r.allocated_total))}));
}

function accountByRole(role, fallback='') {
  const row=db.prepare(`SELECT code FROM accounts WHERE role=? AND active=1 AND COALESCE(is_postable,1)=1 ORDER BY code LIMIT 1`).get(String(role));
  return String(row?.code||fallback).trim();
}
function accountRole(code) {
  return String(db.prepare(`SELECT role FROM accounts WHERE code=? AND active=1`).get(String(code||'').trim())?.role||'');
}
function defaultCounterpartyAccount(direction){ return direction==='Gələn' ? accountByRole('PAYABLE','531.01') : accountByRole('RECEIVABLE','211.01'); }
function defaultVatAccount(direction){ return direction==='Gələn' ? accountByRole('INPUT_VAT','241.01') : accountByRole('OUTPUT_VAT','521.01'); }
function fxGainAccount(){ return accountByRole('FX_GAIN','723.02'); }
function fxLossAccount(){ return accountByRole('FX_LOSS','723.01'); }
function suspenseAccount(){ return String(accountingStatus().suspense_account_code||accountByRole('SUSPENSE_EXPENSE','721.99')); }
function defaultExpenseSubkontoId() {
  return Number(db.prepare(`SELECT id FROM account_subcontos WHERE account_code=? AND code='OTHER' AND active=1`).get(accountByRole('EXPENSE','721.01'))?.id||0)||null;
}
function unclassifiedExpenseSubkontoId() {
  return Number(db.prepare(`SELECT id FROM account_subcontos WHERE account_code=? AND code='UNCLASSIFIED' AND active=1`).get(suspenseAccount())?.id||0)||null;
}
function assertAccountingDateOpen(entryDate) {
  if(!isValidIsoDate(entryDate))throw new Error('Uçot yazılışının tarixi düzgün deyil.');
  const settings=accountingStatus();
  if(settings.opening_date && entryDate<settings.opening_date) throw new Error(`Tarix uçotun başlanğıc tarixindən (${settings.opening_date}) əvvəl ola bilməz.`);
  if(settings.closed_through_date && entryDate<=settings.closed_through_date) throw new Error(`${settings.closed_through_date} tarixinədək uçot dövrü bağlıdır. Əvvəlcə dövrü yenidən açın.`);
}

function saveInvoice(payload) {
  const normalizedPayload = {...payload};
  normalizedPayload.currency = String(payload.currency||'AZN').trim().toUpperCase();
  normalizedPayload.counterparty_name = sanitizeCounterpartyName(payload.counterparty_name);
  normalizedPayload.status = 'Təsdiqlənib';
  normalizedPayload.exchange_rate = normalizedPayload.currency==='AZN' ? 1 : Number(payload.exchange_rate||0);
  const preparedItems = normalizeInvoiceItems(payload.items || [], payload.direction, normalizedPayload);
  normalizedPayload.items = preparedItems;
  const reviewRequired=preparedItems.some(item=>item.accounting_review_required);
  const reviewReason=reviewRequired?'Mal/xidmət növü qayda və ya məlumat kitabçası ilə dəqiqləşdirilməlidir.':'';
  const calc = validateInvoicePayload(normalizedPayload);
  assertAccountingDateOpen(normalizedPayload.invoice_date);
  assertVatDateOpen(normalizedPayload.invoice_date);
  if(normalizedPayload.id)assertVatInvoiceOpen(Number(normalizedPayload.id));
  const businessNo = normalizedPayload.invoice_no.trim();
  const businessVoen = String(normalizedPayload.voen || '').trim();
  const duplicate = db.prepare(`SELECT id,invoice_no,direction,counterparty_name,voen FROM invoices WHERE company_id=1 AND upper(trim(invoice_no))=upper(trim(?)) AND voen=? AND direction=?${normalizedPayload.id ? ' AND id<>?' : ''} LIMIT 1`);
  const duplicateArgs = [businessNo,businessVoen,normalizedPayload.direction];
  if (normalizedPayload.id) duplicateArgs.push(normalizedPayload.id);
  const dup = duplicate.get(...duplicateArgs);
  if (dup) throw new Error(`Bu ${normalizedPayload.direction.toLowerCase()} qaimə (${businessNo}) həmin kontragent/VÖEN üzrə artıq mövcuddur: ${dup.counterparty_name}.`);

  const profile = normalizedPayload.posting_profile_id
    ? db.prepare(`SELECT id,direction,active,base_debit_code,vat_debit_code,base_credit_code,vat_credit_code FROM posting_profiles WHERE id=?`).get(Number(normalizedPayload.posting_profile_id))
    : db.prepare(`SELECT id,direction,active,base_debit_code,vat_debit_code,base_credit_code,vat_credit_code FROM posting_profiles WHERE direction=? AND active=1 ORDER BY id LIMIT 1`).get(normalizedPayload.direction);
  if (!profile || !profile.active || profile.direction !== normalizedPayload.direction) throw new Error('Bu qaimə növü üçün aktiv uçot profili tapılmadı.');
  const t=nowIso();
  db.exec('BEGIN IMMEDIATE');
  try {
    const cpId = ensureCounterparty(normalizedPayload.counterparty_name.trim(), businessVoen, normalizedPayload.direction);
    if (normalizedPayload.id) {
      const before=invoiceDetail(normalizedPayload.id);
      if (!before) throw new Error('Qaimə tapılmadı.');
      const allocated=Number(db.prepare(`SELECT COALESCE(SUM(amount),0) amount FROM payment_allocations WHERE invoice_id=?`).get(Number(normalizedPayload.id)).amount||0);
      const vatAllocated=Number(db.prepare(`SELECT COALESCE(SUM(amount_azn),0) amount FROM vat_payment_allocations WHERE invoice_id=?`).get(Number(normalizedPayload.id)).amount||0);
      const nextVatAzn=round2(Number(calc.vat_amount)*Number(normalizedPayload.exchange_rate||1));
      const beforeVatAzn=round2(Number(before.vat_amount||0)*Number(before.exchange_rate||1));
      const paymentSensitiveChange=before.direction!==normalizedPayload.direction||before.voen!==businessVoen||before.currency!==normalizedPayload.currency||
        Math.abs(Number(before.exchange_rate||1)-Number(normalizedPayload.exchange_rate||1))>0.0000001||
        Math.abs(Number(before.total_amount)-Number(calc.total_amount))>0.005||Math.abs(beforeVatAzn-nextVatAzn)>0.005;
      if((allocated>0||vatAllocated>0)&&paymentSensitiveChange){
        throw new Error('Ödəniş bağlanmış qaimənin istiqaməti, VÖEN-i, valyutası, məzənnəsi və məbləğləri dəyişdirilə bilməz; əvvəlcə bank və ƏDV bağlantılarını ləğv edin.');
      }
      const oldScopes=invoiceInventoryScopes(before);
      if (!allowedStatusTransition(before.status, normalizedPayload.status || 'Qaralama')) throw new Error(`Status ${before.status} → ${normalizedPayload.status || 'Qaralama'} keçidi icazəli deyil.`);
      db.prepare(`UPDATE invoices SET
        invoice_no=:invoice_no,invoice_date=:invoice_date,due_date=:due_date,direction=:direction,
        counterparty_id=:counterparty_id,counterparty_name=:counterparty_name,voen=:voen,currency=:currency,
        base_amount=:base_amount,vat_amount=:vat_amount,total_amount=:total_amount,vat_rate=:vat_rate,
        status=:status,note=:note,posting_profile_id=:posting_profile_id,
        counterparty_account_code=:counterparty_account_code,vat_posting_account_code=:vat_posting_account_code,
        document_key=:document_key,invoice_series=:invoice_series,invoice_type_name=:invoice_type_name,
        main_note=:main_note,additional_note=:additional_note,excise_amount=:excise_amount,
        vat_taxable_amount=:vat_taxable_amount,vat_non_taxable_amount=:vat_non_taxable_amount,
        vat_exempt_amount=:vat_exempt_amount,vat_zero_amount=:vat_zero_amount,road_tax_amount=:road_tax_amount,
        reason_text=:reason_text,advance_series=:advance_series,advance_number=:advance_number,
        advance_amount=:advance_amount,contract_id=:contract_id,accounting_review_required=:accounting_review_required,
        accounting_review_reason=:accounting_review_reason,exchange_rate=:exchange_rate,
        functional_total_amount=:functional_total_amount,updated_at=:updated_at
        WHERE id=:id AND deleted_at IS NULL`).run({
          invoice_no:normalizedPayload.invoice_no.trim(),invoice_date:normalizedPayload.invoice_date,due_date:normalizedPayload.due_date||null,
          direction:normalizedPayload.direction,counterparty_id:cpId,counterparty_name:normalizedPayload.counterparty_name.trim(),
          voen:businessVoen,currency:normalizedPayload.currency||'AZN',base_amount:calc.base_amount,vat_amount:calc.vat_amount,
          total_amount:calc.total_amount,vat_rate:Number(normalizedPayload.vat_rate||18),status:normalizedPayload.status||'Qaralama',
          note:normalizedPayload.note||'',posting_profile_id:profile?.id||null,
          counterparty_account_code:String(normalizedPayload.counterparty_account_code||defaultCounterpartyAccount(normalizedPayload.direction)),
          vat_posting_account_code:String(normalizedPayload.vat_posting_account_code||defaultVatAccount(normalizedPayload.direction)),
          document_key:invoiceBusinessKey(businessNo,businessVoen,normalizedPayload.direction),invoice_series:String(normalizedPayload.invoice_series||''),
          invoice_type_name:String(normalizedPayload.invoice_type_name||''),main_note:String(normalizedPayload.main_note??normalizedPayload.note??''),
          additional_note:String(normalizedPayload.additional_note||''),excise_amount:round2(normalizedPayload.excise_amount),
          vat_taxable_amount:round2(normalizedPayload.vat_taxable_amount),vat_non_taxable_amount:round2(normalizedPayload.vat_non_taxable_amount),
          vat_exempt_amount:round2(normalizedPayload.vat_exempt_amount),vat_zero_amount:round2(normalizedPayload.vat_zero_amount),
          road_tax_amount:round2(normalizedPayload.road_tax_amount),reason_text:String(normalizedPayload.reason_text||''),
          advance_series:String(normalizedPayload.advance_series||''),advance_number:String(normalizedPayload.advance_number||''),
          advance_amount:round2(normalizedPayload.advance_amount),contract_id:normalizedPayload.contract_id?Number(normalizedPayload.contract_id):null,
          accounting_review_required:reviewRequired?1:0,accounting_review_reason:reviewReason,
          exchange_rate:normalizedPayload.exchange_rate,functional_total_amount:round2(calc.total_amount*normalizedPayload.exchange_rate),
          updated_at:t,id:Number(normalizedPayload.id)
        });
      db.prepare(`DELETE FROM invoice_items WHERE invoice_id=?`).run(normalizedPayload.id);
      insertItems(normalizedPayload.id,normalizedPayload.items);
      recordStatusTransition(normalizedPayload.id, before.status, normalizedPayload.status || 'Qaralama', 'Sənəd redaktəsi');
      const posting=createInvoicePosting(Number(normalizedPayload.id),{replaceExisting:true});
      rebuildInventoryScopes([...oldScopes,...posting.scopes]);
      audit('Qaimə dəyişdirildi və uçot yeniləndi','E-Qaimə',normalizedPayload.id,before,{...invoiceDetail(normalizedPayload.id),journal_entry_id:posting.journalEntryId});
      db.exec('COMMIT');
      return invoiceDetail(normalizedPayload.id);
    }
    const res=db.prepare(`INSERT INTO invoices(
      company_id,invoice_no,invoice_date,due_date,direction,counterparty_id,counterparty_name,voen,currency,
      base_amount,vat_amount,total_amount,vat_rate,status,note,posting_profile_id,source,created_at,updated_at,
      counterparty_account_code,vat_posting_account_code,document_key,invoice_series,invoice_type_name,main_note,
      additional_note,excise_amount,vat_taxable_amount,vat_non_taxable_amount,vat_exempt_amount,vat_zero_amount,
      road_tax_amount,reason_text,advance_series,advance_number,advance_amount,exchange_rate,functional_total_amount
    ) VALUES(
      1,:invoice_no,:invoice_date,:due_date,:direction,:counterparty_id,:counterparty_name,:voen,:currency,
      :base_amount,:vat_amount,:total_amount,:vat_rate,:status,:note,:posting_profile_id,'manual',:created_at,:updated_at,
      :counterparty_account_code,:vat_posting_account_code,:document_key,:invoice_series,:invoice_type_name,:main_note,
      :additional_note,:excise_amount,:vat_taxable_amount,:vat_non_taxable_amount,:vat_exempt_amount,:vat_zero_amount,
      :road_tax_amount,:reason_text,:advance_series,:advance_number,:advance_amount,:exchange_rate,:functional_total_amount
    )`).run({
      invoice_no:normalizedPayload.invoice_no.trim(),invoice_date:normalizedPayload.invoice_date,due_date:normalizedPayload.due_date||null,
      direction:normalizedPayload.direction,counterparty_id:cpId,counterparty_name:normalizedPayload.counterparty_name.trim(),
      voen:businessVoen,currency:normalizedPayload.currency||'AZN',base_amount:calc.base_amount,vat_amount:calc.vat_amount,
      total_amount:calc.total_amount,vat_rate:Number(normalizedPayload.vat_rate||18),status:normalizedPayload.status||'Qaralama',
      note:normalizedPayload.note||'',posting_profile_id:profile?.id||null,created_at:t,updated_at:t,
      counterparty_account_code:String(normalizedPayload.counterparty_account_code||defaultCounterpartyAccount(normalizedPayload.direction)),
      vat_posting_account_code:String(normalizedPayload.vat_posting_account_code||defaultVatAccount(normalizedPayload.direction)),
      document_key:invoiceBusinessKey(businessNo,businessVoen,normalizedPayload.direction),invoice_series:String(normalizedPayload.invoice_series||''),
      invoice_type_name:String(normalizedPayload.invoice_type_name||''),main_note:String(normalizedPayload.main_note??normalizedPayload.note??''),
      additional_note:String(normalizedPayload.additional_note||''),excise_amount:round2(normalizedPayload.excise_amount),
      vat_taxable_amount:round2(normalizedPayload.vat_taxable_amount),vat_non_taxable_amount:round2(normalizedPayload.vat_non_taxable_amount),
      vat_exempt_amount:round2(normalizedPayload.vat_exempt_amount),vat_zero_amount:round2(normalizedPayload.vat_zero_amount),
      road_tax_amount:round2(normalizedPayload.road_tax_amount),reason_text:String(normalizedPayload.reason_text||''),
      advance_series:String(normalizedPayload.advance_series||''),advance_number:String(normalizedPayload.advance_number||''),
      advance_amount:round2(normalizedPayload.advance_amount),exchange_rate:normalizedPayload.exchange_rate,
      functional_total_amount:round2(calc.total_amount*normalizedPayload.exchange_rate)
    });
    const id=Number(res.lastInsertRowid);
    db.prepare(`UPDATE invoices SET contract_id=?,accounting_review_required=?,accounting_review_reason=? WHERE id=?`).run(normalizedPayload.contract_id?Number(normalizedPayload.contract_id):null,reviewRequired?1:0,reviewReason,id);
    insertItems(id,normalizedPayload.items);
    recordStatusTransition(id, null, normalizedPayload.status || 'Qaralama', 'Sənəd yaradıldı');
    const posting=createInvoicePosting(id);
    rebuildInventoryScopes(posting.scopes);
    audit('Qaimə yaradıldı və avtomatik uçota alındı','E-Qaimə',id,null,{...invoiceDetail(id),journal_entry_id:posting.journalEntryId});
    db.exec('COMMIT');
    return invoiceDetail(id);
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

function accountForInvoiceItem(x, direction) {
  return String(x.posting_account_code || '').trim();
}

function defaultWarehouse() {
  const configured=db.prepare(`SELECT w.* FROM company_settings s LEFT JOIN warehouses w ON w.id=s.default_warehouse_id AND w.active=1 WHERE s.id=1`).get();
  if(configured?.id) return configured;
  return db.prepare(`SELECT * FROM warehouses WHERE company_id=1 AND active=1 ORDER BY is_default DESC,id LIMIT 1`).get() || null;
}

function inventoryAccountForWarehouse(warehouseId=null) {
  const warehouse=warehouseId
    ? db.prepare(`SELECT inventory_account_code FROM warehouses WHERE id=? AND company_id=1 AND active=1`).get(Number(warehouseId))
    : defaultWarehouse();
  return String(warehouse?.inventory_account_code||accountByRole('INVENTORY','205.01'));
}

function activePostingRules() {
  return db.prepare(`SELECT * FROM posting_rules WHERE company_id=1 AND active=1 ORDER BY priority,id`).all();
}

function ensureCatalogItemForLine(item) {
  if(item.catalog_item_id){
    const existing=db.prepare(`SELECT * FROM item_catalog WHERE id=? AND company_id=1`).get(Number(item.catalog_item_id));
    if(existing) return existing;
  }
  if(item.item_code){
    const existing=db.prepare(`SELECT * FROM item_catalog WHERE company_id=1 AND code=?`).get(String(item.item_code).trim());
    if(existing) return existing;
  }
  const description=String(item.description||'').trim();
  const prefix=item.item_type==='Mal'?'MAT':'SRV';
  const digest=crypto.createHash('sha1').update(normalizeAccountingText(description)||description).digest('hex').slice(0,10).toUpperCase();
  const code=String(item.item_code||`${prefix}-${digest}`).trim();
  const t=nowIso();
  const inventoryAccount=item.item_type==='Mal'?inventoryAccountForWarehouse(item.warehouse_id):null;
  db.prepare(`INSERT OR IGNORE INTO item_catalog(company_id,code,name,item_type,unit,purchase_account_code,sales_account_code,inventory_account_code,purchase_vat_account_code,sales_vat_account_code,standard_cost,active,created_at,updated_at)
              VALUES(1,?,?,?,?,?,?,?,?,?,?,1,?,?)`).run(
    code,description,item.item_type,item.unit||'ədəd',
    item.item_type==='Mal'?inventoryAccount:String(item.posting_account_code||suspenseAccount()),
    item.item_type==='Mal'?accountByRole('SALES_GOODS','601.01'):accountByRole('SALES_SERVICE','601.02'),inventoryAccount,defaultVatAccount('Gələn'),defaultVatAccount('Gedən'),
    Number(item.standard_cost||0),t,t
  );
  return db.prepare(`SELECT * FROM item_catalog WHERE company_id=1 AND code=?`).get(code);
}

function normalizeInvoiceItems(items, direction, invoiceContext={}) {
  const warehouse=defaultWarehouse();
  const rules=activePostingRules();
  return items.map(x=>{
    const qty=Number(x.qty||0), price=Number(x.unit_price||0), disc=Number(x.discount_rate||0), vr=Number(x.vat_rate??18);
    const base=round2(Math.max(0,qty*price*(1-disc/100)));
    const vat=round2(base*vr/100);
    const total=round2(base+vat);
    const catalog=x.catalog_item_id
      ? db.prepare(`SELECT * FROM item_catalog WHERE id=? AND company_id=1 AND active=1`).get(Number(x.catalog_item_id))
      : x.item_code ? db.prepare(`SELECT * FROM item_catalog WHERE company_id=1 AND code=? AND active=1`).get(String(x.item_code).trim()) : null;
    const inferred=inferItemType({itemType:x.item_type||catalog?.item_type,description:x.description||catalog?.name,counterpartyName:invoiceContext.counterparty_name,invoiceTypeName:invoiceContext.invoice_type_name});
    const itemType=inferred || catalog?.item_type || '';
    const resolution=resolvePosting({
      direction,itemType,description:x.description||catalog?.name||'',itemCode:x.item_code||catalog?.code||'',
      counterpartyName:invoiceContext.counterparty_name||'',invoiceTypeName:invoiceContext.invoice_type_name||'',
      explicitAccount:String(x.posting_account_code||'').trim(),explicitSubkontoId:x.subkonto_id?Number(x.subkonto_id):null,
      explicitWarehouseId:x.warehouse_id?Number(x.warehouse_id):null,defaultWarehouseId:warehouse?.id||null,
      catalogPurchaseAccount:catalog?.purchase_account_code,catalogSalesAccount:catalog?.sales_account_code,
      defaultItemType:'Xidmət',suspenseAccount:suspenseAccount(),
      inventoryAccount:inventoryAccountForWarehouse(warehouse?.id||null),expenseAccount:accountByRole('EXPENSE','721.01'),
      defaultExpenseSubkontoId:defaultExpenseSubkontoId(),unclassifiedExpenseSubkontoId:unclassifiedExpenseSubkontoId(),
      goodsSalesAccount:accountByRole('SALES_GOODS','601.01'),serviceSalesAccount:accountByRole('SALES_SERVICE','601.02')
    },rules);
    const resolvedWarehouse=resolution.itemType==='Mal'
      ? db.prepare(`SELECT id,inventory_account_code FROM warehouses WHERE id=? AND company_id=1 AND active=1`).get(Number(resolution.warehouseId||warehouse?.id||0))
      : null;
    if(resolution.itemType==='Mal'&&!resolvedWarehouse) throw new Error(`${String(x.description||catalog?.name||'Mal sətri')}: aktiv anbar seçilməlidir.`);
    const resolvedAccount=resolution.itemType==='Mal'&&direction==='Gələn'
      ? assertAccountRole(resolvedWarehouse.inventory_account_code,'INVENTORY','Anbar ehtiyat hesabı')
      : resolution.accountCode;
    return {
      ...x,
      catalog_item_id:catalog?.id || (x.catalog_item_id?Number(x.catalog_item_id):null),
      item_type:resolution.itemType,
      item_code:String(x.item_code||catalog?.code||'').trim(),
      description:String(x.description||catalog?.name||'').trim(),
      qty,unit:String(x.unit||catalog?.unit||'ədəd'),unit_price:price,discount_rate:disc,vat_rate:vr,
      base_amount:base,vat_amount:vat,total_amount:total,posting_account_code:resolvedAccount,
      subkonto_id:resolution.itemType==='Mal'?null:resolution.subkontoId,warehouse_id:resolvedWarehouse?.id||null,
      posting_rule_id:resolution.matchedRuleId,accounting_review_required:resolution.needsReview,
      purchase_account_code:catalog?.purchase_account_code||null,
      sales_account_code:catalog?.sales_account_code||null
    };
  });
}

function insertItems(invoiceId, items) {
  const stmt=db.prepare(`INSERT INTO invoice_items(invoice_id,line_no,item_code,item_type,description,qty,unit,unit_price,discount_rate,vat_rate,base_amount,vat_amount,total_amount,catalog_item_id,posting_account_code,subkonto_id,warehouse_id,posting_rule_id,cost_amount) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`);
  items.forEach((x,i)=>{
    const catalog=ensureCatalogItemForLine(x);
    stmt.run(invoiceId,i+1,catalog?.code||x.item_code||'',x.item_type||'Xidmət',String(x.description||'').trim(),Number(x.qty||0),x.unit||'ədəd',Number(x.unit_price||0),Number(x.discount_rate||0),Number(x.vat_rate||18),Number(x.base_amount||0),Number(x.vat_amount||0),Number(x.total_amount||0),catalog?.id||null,x.posting_account_code||null,x.subkonto_id||null,x.item_type==='Mal'?(x.warehouse_id||defaultWarehouse()?.id||null):null,x.posting_rule_id||null);
  });
}

function migrateExpenseAccountsToSubcontos() {
  const canonicalAccount='721.01';
  const legacyMappings=[
    {accountCode:'721.02',subkontoCode:'TRANSPORT'},
    {accountCode:'721.03',subkontoCode:'TELECOM'},
    {accountCode:'721.04',subkontoCode:'MEAL'}
  ];
  const timestamp=nowIso();
  db.exec('BEGIN IMMEDIATE');
  try{
    for(const mapping of legacyMappings){
      const canonicalSubkonto=db.prepare(`SELECT id FROM account_subcontos WHERE account_code=? AND code=?`).get(canonicalAccount,mapping.subkontoCode);
      if(!canonicalSubkonto) throw new Error(`${mapping.subkontoCode} subkontosu yaradılmayıb.`);
      const legacySubcontos=db.prepare(`SELECT id FROM account_subcontos WHERE account_code=?`).all(mapping.accountCode).map(row=>Number(row.id));
      const legacySubkontoClause=legacySubcontos.length?` OR subkonto_id IN (${legacySubcontos.map(()=>'?').join(',')})`:'';
      db.prepare(`UPDATE invoice_items SET posting_account_code=?,subkonto_id=? WHERE posting_account_code=?${legacySubkontoClause}`)
        .run(canonicalAccount,canonicalSubkonto.id,mapping.accountCode,...legacySubcontos);
      db.prepare(`UPDATE journal_lines SET account_code=?,subkonto_id=? WHERE account_code=?${legacySubkontoClause}`)
        .run(canonicalAccount,canonicalSubkonto.id,mapping.accountCode,...legacySubcontos);
      db.prepare(`UPDATE opening_balances SET account_code=?,subkonto_id=? WHERE account_code=?${legacySubkontoClause}`)
        .run(canonicalAccount,canonicalSubkonto.id,mapping.accountCode,...legacySubcontos);
      db.prepare(`UPDATE posting_rules SET account_code=?,subkonto_id=?,updated_at=? WHERE account_code=?${legacySubkontoClause}`)
        .run(canonicalAccount,canonicalSubkonto.id,timestamp,mapping.accountCode,...legacySubcontos);
      db.prepare(`UPDATE item_catalog SET purchase_account_code=?,updated_at=? WHERE purchase_account_code=?`).run(canonicalAccount,timestamp,mapping.accountCode);
      db.prepare(`UPDATE posting_profiles SET base_debit_code=? WHERE base_debit_code=?`).run(canonicalAccount,mapping.accountCode);
      db.prepare(`UPDATE account_subcontos SET active=0,updated_at=? WHERE account_code=?`).run(timestamp,mapping.accountCode);
      db.prepare(`UPDATE accounts SET active=0,role=NULL WHERE code=?`).run(mapping.accountCode);
    }
    db.prepare(`UPDATE posting_rules SET active=0,updated_at=? WHERE name='Azercell rabitə xidməti'`).run(timestamp);
    db.prepare(`UPDATE accounts SET active=1,is_postable=1,role='EXPENSE',parent_code='721' WHERE code=?`).run(canonicalAccount);
    db.exec('COMMIT');
  }catch(error){
    try{db.exec('ROLLBACK')}catch(_){}
    throw error;
  }
}

function migrateExistingInvoicesToAutomaticAccounting() {
  const pending=db.prepare(`SELECT id FROM invoices WHERE company_id=1 AND deleted_at IS NULL AND posting_status<>'Uçota alınıb' ORDER BY invoice_date,id`).all();
  if(!pending.length)return;
  const scopes=[];db.exec('BEGIN IMMEDIATE');
  try{
    for(const row of pending){
      db.exec('SAVEPOINT migrate_invoice');
      try{
        const invoice=invoiceDetail(row.id);if(!invoice)continue;
        const normalized=normalizeInvoiceItems(invoice.items,invoice.direction,invoice);
        db.prepare(`DELETE FROM invoice_items WHERE invoice_id=?`).run(invoice.id);insertItems(invoice.id,normalized);
        db.prepare(`UPDATE invoices SET status='Təsdiqlənib',accounting_review_required=?,accounting_review_reason=?,updated_at=? WHERE id=?`).run(normalized.some(item=>item.accounting_review_required)?1:0,normalized.some(item=>item.accounting_review_required)?'Köhnə qaimənin mal/xidmət təsnifatı yoxlanmalıdır.':'',nowIso(),invoice.id);
        const posting=createInvoicePosting(invoice.id,{replaceExisting:true});scopes.push(...posting.scopes);
      }catch(error){
        db.exec('ROLLBACK TO migrate_invoice');
        db.prepare(`UPDATE invoices SET accounting_review_required=1,accounting_review_reason=? WHERE id=?`).run(`Avtomatik uçot miqrasiyası: ${String(error.message||error)}`,row.id);
      }finally{db.exec('RELEASE migrate_invoice');}
    }
    // Existing databases may contain historical outgoing goods invoices whose
    // warehouse opening stock was never entered. Startup migration must open
    // the company and mark that shortage for review; it must never lock the
    // user out of the whole ERP application.
    rebuildInventoryScopes(scopes,{strictNegativeStock:false});db.exec('COMMIT');
  }catch(error){try{db.exec('ROLLBACK')}catch(_){};throw error;}
}

function invoiceAccountingIntegrityCandidateIds() {
  return db.prepare(`
    SELECT i.id
    FROM invoices i
    WHERE i.company_id=1 AND i.deleted_at IS NULL AND (
      i.posting_status<>'Uçota alınıb'
      OR ABS(COALESCE(i.functional_total_amount,0)-ROUND(i.total_amount*COALESCE(NULLIF(i.exchange_rate,0),1),2))>0.005
      OR (SELECT COUNT(*) FROM journal_entries j WHERE j.source_type='invoice' AND j.source_id=i.id AND j.status='Təsdiqlənib')<>1
      OR EXISTS(
        SELECT 1 FROM journal_entries j JOIN journal_lines l ON l.journal_entry_id=j.id
        WHERE j.source_type='invoice' AND j.source_id=i.id AND j.status='Təsdiqlənib'
        GROUP BY j.id HAVING ABS(SUM(l.debit)-SUM(l.credit))>0.005
      )
      OR EXISTS(
        SELECT 1 FROM invoice_items ii
        LEFT JOIN accounts a ON a.code=ii.posting_account_code AND a.active=1 AND COALESCE(a.is_postable,1)=1
        LEFT JOIN account_subcontos s ON s.id=ii.subkonto_id AND s.active=1
        LEFT JOIN warehouses w ON w.id=ii.warehouse_id AND w.company_id=1 AND w.active=1
        WHERE ii.invoice_id=i.id AND (
          a.code IS NULL
          OR (ii.subkonto_id IS NOT NULL AND (s.id IS NULL OR s.account_code<>ii.posting_account_code))
          OR (ii.item_type='Mal' AND (w.id IS NULL OR ii.catalog_item_id IS NULL OR ii.subkonto_id IS NOT NULL))
          OR (ii.item_type='Mal' AND i.direction='Gələn' AND ii.posting_account_code<>w.inventory_account_code)
          OR (ii.item_type='Xidmət' AND ii.warehouse_id IS NOT NULL)
        )
      )
      OR NOT EXISTS(
        SELECT 1 FROM accounts a WHERE a.code=i.counterparty_account_code AND a.active=1 AND COALESCE(a.is_postable,1)=1
          AND a.role=CASE WHEN i.direction='Gələn' THEN 'PAYABLE' ELSE 'RECEIVABLE' END
      )
      OR (i.vat_amount>0.005 AND NOT EXISTS(
        SELECT 1 FROM accounts a WHERE a.code=i.vat_posting_account_code AND a.active=1 AND COALESCE(a.is_postable,1)=1
          AND a.role=CASE WHEN i.direction='Gələn' THEN 'INPUT_VAT' ELSE 'OUTPUT_VAT' END
      ))
      OR NOT EXISTS(
        SELECT 1
        FROM journal_entries j JOIN journal_lines l ON l.journal_entry_id=j.id
        WHERE j.source_type='invoice' AND j.source_id=i.id AND j.status='Təsdiqlənib'
          AND l.analytic_type='counterparty' AND l.account_code=i.counterparty_account_code
          AND ABS(CASE WHEN i.direction='Gedən' THEN l.debit ELSE l.credit END-i.functional_total_amount)<0.005
      )
    )
    ORDER BY i.invoice_date,i.id`).all().map(row=>Number(row.id));
}

function balanceJournalForSafeReversal(journalEntryId) {
  const totals=db.prepare(`SELECT ROUND(COALESCE(SUM(debit),0),2) debit,ROUND(COALESCE(SUM(credit),0),2) credit FROM journal_lines WHERE journal_entry_id=?`).get(Number(journalEntryId));
  const difference=round2(Number(totals.debit)-Number(totals.credit));
  if(Math.abs(difference)<=0.005) return false;
  const suspense=assertActiveAccount(suspenseAccount());
  journalLineStatement().run(
    Number(journalEntryId),suspense,difference<0?Math.abs(difference):0,difference>0?difference:0,
    'integrity-repair','Avtomatik balans bərpası',unclassifiedExpenseSubkontoId(),null,null,null,null,null
  );
  assertJournalBalanced(Number(journalEntryId));
  return true;
}

function repairInvoiceAccountingReferences(invoiceId) {
  const invoice=invoiceDetail(Number(invoiceId));
  if(!invoice || !invoice.items.length) throw new Error('Qaimənin uçota alınacaq sətri yoxdur.');
  const defaultInventoryAccount=inventoryAccountForWarehouse();
  const defaultExpenseAccount=accountByRole('EXPENSE','721.01');
  const defaultSalesGoodsAccount=accountByRole('SALES_GOODS','601.01');
  const defaultSalesServiceAccount=accountByRole('SALES_SERVICE','601.02');
  const warehouse=defaultWarehouse();
  let reviewRequired=Number(invoice.accounting_review_required||0)===1;
  let reviewReason=String(invoice.accounting_review_reason||'').trim();
  const validAccount=db.prepare(`SELECT 1 FROM accounts WHERE code=? AND active=1 AND COALESCE(is_postable,1)=1`);
  const validSubkonto=db.prepare(`SELECT 1 FROM account_subcontos WHERE id=? AND account_code=? AND active=1`);
  const updateItem=db.prepare(`UPDATE invoice_items SET item_type=?,catalog_item_id=?,posting_account_code=?,subkonto_id=?,warehouse_id=? WHERE id=?`);

  for(const item of invoice.items){
    const itemType=item.item_type==='Mal'?'Mal':'Xidmət';
    const warehouseId=itemType==='Mal'?(Number(item.warehouse_id)||Number(warehouse?.id)||null):null;
    const selectedWarehouse=warehouseId?db.prepare(`SELECT id,inventory_account_code FROM warehouses WHERE id=? AND company_id=1 AND active=1`).get(warehouseId):null;
    if(itemType==='Mal'&&!selectedWarehouse) throw new Error(`${item.description}: mal sətri üçün aktiv anbar yoxdur.`);
    let accountCode=String(item.posting_account_code||'').trim();
    if(!validAccount.get(accountCode)){
      accountCode=invoice.direction==='Gələn'
        ? itemType==='Mal'?defaultInventoryAccount:suspenseAccount()
        : itemType==='Mal'?defaultSalesGoodsAccount:defaultSalesServiceAccount;
      reviewRequired=true;
      reviewReason=reviewReason||'Etibarsız uçot hesabı təhlükəsiz gözləmə hesabı ilə əvəz edildi.';
    }
    if(itemType==='Mal'&&invoice.direction==='Gələn') accountCode=assertAccountRole(selectedWarehouse.inventory_account_code,'INVENTORY','Anbar ehtiyat hesabı');
    let subkontoId=item.subkonto_id?Number(item.subkonto_id):null;
    if(subkontoId&&!validSubkonto.get(subkontoId,accountCode)) subkontoId=null;
    if(itemType==='Mal')subkontoId=null;
    if(!subkontoId&&invoice.direction==='Gələn'&&itemType==='Xidmət'){
      if(accountCode===defaultExpenseAccount) subkontoId=defaultExpenseSubkontoId();
      if(accountCode===suspenseAccount()) subkontoId=unclassifiedExpenseSubkontoId();
    }
    const catalog=ensureCatalogItemForLine({...item,item_type:itemType,posting_account_code:accountCode,warehouse_id:warehouseId});
    updateItem.run(itemType,catalog?.id||null,accountCode,subkontoId,warehouseId,item.id);
  }

  const expectedCounterpartyRole=invoice.direction==='Gələn'?'PAYABLE':'RECEIVABLE';
  const expectedVatRole=invoice.direction==='Gələn'?'INPUT_VAT':'OUTPUT_VAT';
  const counterpartyAccount=validAccount.get(invoice.counterparty_account_code)&&accountRole(invoice.counterparty_account_code)===expectedCounterpartyRole
    ? invoice.counterparty_account_code : accountByRole(expectedCounterpartyRole,defaultCounterpartyAccount(invoice.direction));
  const vatAccount=validAccount.get(invoice.vat_posting_account_code)&&accountRole(invoice.vat_posting_account_code)===expectedVatRole
    ? invoice.vat_posting_account_code : accountByRole(expectedVatRole,defaultVatAccount(invoice.direction));
  const exchangeRate=String(invoice.currency||'AZN')==='AZN'?1:Number(invoice.exchange_rate||0);
  if(!(exchangeRate>0)) throw new Error('Xarici valyutalı qaimənin AZN məzənnəsi yoxdur.');
  db.prepare(`UPDATE invoices SET counterparty_account_code=?,vat_posting_account_code=?,exchange_rate=?,functional_total_amount=?,accounting_review_required=?,accounting_review_reason=?,updated_at=? WHERE id=?`)
    .run(counterpartyAccount,vatAccount,exchangeRate,round2(Number(invoice.total_amount)*exchangeRate),reviewRequired?1:0,reviewReason,nowIso(),invoice.id);
}

function inventoryIntegrityScopes() {
  return db.prepare(`
    SELECT DISTINCT ii.warehouse_id AS warehouseId,ii.catalog_item_id AS catalogItemId
    FROM invoice_items ii
    JOIN invoices i ON i.id=ii.invoice_id
    WHERE i.company_id=1 AND i.deleted_at IS NULL AND i.posting_status='Uçota alınıb'
      AND ii.item_type='Mal' AND ii.warehouse_id IS NOT NULL AND ii.catalog_item_id IS NOT NULL
    UNION
    SELECT DISTINCT sm.warehouse_id AS warehouseId,sm.catalog_item_id AS catalogItemId
    FROM stock_movements sm
    WHERE sm.company_id=1 AND sm.warehouse_id IS NOT NULL AND sm.catalog_item_id IS NOT NULL
  `).all().map(row=>({warehouseId:Number(row.warehouseId),catalogItemId:Number(row.catalogItemId)}));
}

function inventoryIntegrityMetrics() {
  const missingStockMovements=Number(db.prepare(`
    SELECT COUNT(*) count FROM (
      SELECT ii.id
      FROM invoice_items ii
      JOIN invoices i ON i.id=ii.invoice_id
      LEFT JOIN stock_movements sm ON sm.invoice_item_id=ii.id
      LEFT JOIN journal_entries j ON j.id=sm.journal_entry_id
        AND j.source_type='invoice' AND j.source_id=i.id AND j.status='Təsdiqlənib'
      WHERE i.company_id=1 AND i.deleted_at IS NULL AND i.posting_status='Uçota alınıb'
        AND ii.item_type='Mal' AND ii.warehouse_id IS NOT NULL AND ii.catalog_item_id IS NOT NULL
      GROUP BY ii.id
      HAVING COUNT(j.id)<>1
    )
  `).get().count||0);
  const orphanStockMovements=Number(db.prepare(`
    SELECT COUNT(*) count
    FROM stock_movements sm
    LEFT JOIN invoice_items ii ON ii.id=sm.invoice_item_id
    LEFT JOIN invoices i ON i.id=ii.invoice_id
    LEFT JOIN journal_entries j ON j.id=sm.journal_entry_id
    WHERE sm.company_id=1 AND (
      ii.id IS NULL OR i.id IS NULL OR i.company_id<>1 OR i.deleted_at IS NOT NULL
      OR i.posting_status<>'Uçota alınıb' OR ii.item_type<>'Mal'
      OR j.id IS NULL OR j.source_type<>'invoice' OR j.source_id<>i.id OR j.status<>'Təsdiqlənib'
      OR sm.invoice_id<>i.id OR sm.warehouse_id<>ii.warehouse_id OR sm.catalog_item_id<>ii.catalog_item_id
      OR sm.direction<>CASE WHEN i.direction='Gələn' THEN 'IN' ELSE 'OUT' END
      OR ABS(sm.quantity-ii.qty)>0.00005
    )
  `).get().count||0);
  const mismatchedStockValues=Number(db.prepare(`
    SELECT COUNT(*) count
    FROM stock_movements sm
    JOIN invoice_items ii ON ii.id=sm.invoice_item_id
    JOIN invoices i ON i.id=ii.invoice_id
    JOIN journal_entries j ON j.id=sm.journal_entry_id
    WHERE sm.company_id=1 AND i.company_id=1 AND i.deleted_at IS NULL
      AND i.posting_status='Uçota alınıb' AND ii.item_type='Mal'
      AND j.source_type='invoice' AND j.source_id=i.id AND j.status='Təsdiqlənib'
      AND ABS(sm.total_cost)>0.005
      AND NOT EXISTS(
        SELECT 1 FROM journal_lines l
        WHERE l.journal_entry_id=sm.journal_entry_id
          AND l.invoice_item_id=sm.invoice_item_id
          AND l.warehouse_id=sm.warehouse_id
          AND l.catalog_item_id=sm.catalog_item_id
          AND l.analytic_type=CASE WHEN sm.direction='IN' THEN 'inventory-purchase' ELSE 'inventory-stock-out' END
          AND ABS((CASE WHEN sm.direction='IN' THEN l.debit ELSE l.credit END)-sm.total_cost)<=0.005
      )
  `).get().count||0);
  const stockRows=db.prepare(`
    SELECT warehouse_id,catalog_item_id,
      ROUND(SUM(CASE WHEN direction='IN' THEN total_cost ELSE -total_cost END),2) amount
    FROM stock_movements WHERE company_id=1 GROUP BY warehouse_id,catalog_item_id
  `).all();
  const ledgerRows=db.prepare(`
    SELECT l.warehouse_id,l.catalog_item_id,ROUND(SUM(l.debit-l.credit),2) amount
    FROM journal_entries j
    JOIN journal_lines l ON l.journal_entry_id=j.id
    WHERE j.company_id=1 AND j.source_type='invoice' AND j.status='Təsdiqlənib'
      AND l.analytic_type IN ('inventory-purchase','inventory-stock-out')
      AND l.warehouse_id IS NOT NULL AND l.catalog_item_id IS NOT NULL
    GROUP BY l.warehouse_id,l.catalog_item_id
  `).all();
  const scopeValues=new Map();
  for(const row of stockRows){
    const key=`${row.warehouse_id}:${row.catalog_item_id}`;
    scopeValues.set(key,{stock:round2(row.amount),ledger:0});
  }
  for(const row of ledgerRows){
    const key=`${row.warehouse_id}:${row.catalog_item_id}`;
    const value=scopeValues.get(key)||{stock:0,ledger:0};
    value.ledger=round2(row.amount);scopeValues.set(key,value);
  }
  const differences=[...scopeValues.values()].map(value=>round2(value.stock-value.ledger)).filter(value=>Math.abs(value)>0.005);
  const mismatchedInventoryScopes=differences.length;
  const inventoryDifference=round2(differences.reduce((sum,value)=>sum+Math.abs(value),0));
  return {
    healthy:missingStockMovements===0&&orphanStockMovements===0&&mismatchedStockValues===0&&mismatchedInventoryScopes===0,
    missingStockMovements,orphanStockMovements,mismatchedStockValues,mismatchedInventoryScopes,inventoryDifference
  };
}

function deleteOrphanStockMovements() {
  return db.prepare(`DELETE FROM stock_movements WHERE id IN (
    SELECT sm.id
    FROM stock_movements sm
    LEFT JOIN invoice_items ii ON ii.id=sm.invoice_item_id
    LEFT JOIN invoices i ON i.id=ii.invoice_id
    LEFT JOIN journal_entries j ON j.id=sm.journal_entry_id
    WHERE sm.company_id=1 AND (
      ii.id IS NULL OR i.id IS NULL OR i.company_id<>1 OR i.deleted_at IS NOT NULL
      OR i.posting_status<>'Uçota alınıb' OR ii.item_type<>'Mal'
      OR j.id IS NULL OR j.source_type<>'invoice' OR j.source_id<>i.id OR j.status<>'Təsdiqlənib'
      OR sm.invoice_id<>i.id OR sm.warehouse_id<>ii.warehouse_id OR sm.catalog_item_id<>ii.catalog_item_id
      OR sm.direction<>CASE WHEN i.direction='Gələn' THEN 'IN' ELSE 'OUT' END
      OR ABS(sm.quantity-ii.qty)>0.00005
    )
  )`).run().changes;
}

function repairAutomaticInvoiceAccountingIntegrity() {
  const candidateIds=invoiceAccountingIntegrityCandidateIds();
  const inventoryBefore=inventoryIntegrityMetrics();
  if(!candidateIds.length&&inventoryBefore.healthy) return {checked:0,repaired:0,failed:0,inventoryScopesRebuilt:0,orphanStockMovementsRemoved:0};
  let repaired=0,failed=0,orphanStockMovementsRemoved=0;
  const inventoryScopes=inventoryBefore.healthy?[]:inventoryIntegrityScopes();
  db.exec('BEGIN IMMEDIATE');
  try{
    for(const invoiceId of candidateIds){
      db.exec('SAVEPOINT repair_invoice_accounting');
      try{
        repairInvoiceAccountingReferences(invoiceId);
        const activeJournals=db.prepare(`SELECT id FROM journal_entries WHERE source_type='invoice' AND source_id=? AND status='Təsdiqlənib' ORDER BY id`).all(invoiceId);
        for(const journal of activeJournals) balanceJournalForSafeReversal(journal.id);
        const posting=createInvoicePosting(invoiceId,{replaceExisting:true});
        inventoryScopes.push(...posting.scopes);
        audit('Qaimənin avtomatik uçotu bütövlük auditində bərpa edildi','Uçot bütövlüyü',invoiceId,null,{journal_entry_id:posting.journalEntryId});
        repaired++;
      }catch(error){
        db.exec('ROLLBACK TO repair_invoice_accounting');
        db.prepare(`UPDATE invoices SET accounting_review_required=1,accounting_review_reason=?,updated_at=? WHERE id=?`)
          .run(`Uçot bütövlüyü bərpa edilmədi: ${String(error.message||error)}`,nowIso(),invoiceId);
        failed++;
      }finally{
        db.exec('RELEASE repair_invoice_accounting');
      }
    }
    orphanStockMovementsRemoved=deleteOrphanStockMovements();
    // Integrity repair runs while the company database is being opened. A
    // historical stock shortage is a review condition, not an authentication
    // failure, so startup remains available and the shortage stays visible.
    rebuildInventoryScopes(inventoryScopes,{strictNegativeStock:false});
    db.exec('COMMIT');
  }catch(error){
    try{db.exec('ROLLBACK')}catch(_){}
    throw error;
  }
  return {checked:candidateIds.length,repaired,failed,inventoryScopesRebuilt:new Set(inventoryScopes.map(scope=>`${scope.warehouseId}:${scope.catalogItemId}`)).size,orphanStockMovementsRemoved};
}

function accountingIntegrityReport() {
  const quickCheck=db.prepare(`PRAGMA quick_check`).all();
  const foreignKeyErrors=db.prepare(`PRAGMA foreign_key_check`).all();
  const missingInvoicePostings=Number(db.prepare(`SELECT COUNT(*) count FROM invoices i WHERE i.company_id=1 AND i.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM journal_entries j WHERE j.source_type='invoice' AND j.source_id=i.id AND j.status='Təsdiqlənib')`).get().count||0);
  const duplicateInvoicePostings=Number(db.prepare(`SELECT COUNT(*) count FROM (SELECT source_id FROM journal_entries WHERE source_type='invoice' AND status='Təsdiqlənib' GROUP BY source_id HAVING COUNT(*)>1)`).get().count||0);
  const unbalancedJournals=Number(db.prepare(`SELECT COUNT(*) count FROM (SELECT j.id FROM journal_entries j JOIN journal_lines l ON l.journal_entry_id=j.id WHERE j.status='Təsdiqlənib' GROUP BY j.id HAVING ABS(SUM(l.debit)-SUM(l.credit))>0.005)`).get().count||0);
  const mismatchedSubcontos=Number(db.prepare(`SELECT COUNT(*) count FROM journal_lines l JOIN account_subcontos s ON s.id=l.subkonto_id WHERE s.account_code<>l.account_code`).get().count||0);
  const pendingInvoiceReview=Number(db.prepare(`SELECT COUNT(*) count FROM invoices WHERE company_id=1 AND deleted_at IS NULL AND accounting_review_required=1`).get().count||0);
  const inventory=inventoryIntegrityMetrics();
  const healthy=quickCheck.every(row=>Object.values(row).every(value=>value==='ok'))&&!foreignKeyErrors.length&&!missingInvoicePostings&&!duplicateInvoicePostings&&!unbalancedJournals&&!mismatchedSubcontos&&inventory.healthy;
  return safePlain({healthy,database:healthy?'Sağlam':'Yoxlama tələb edir',missingInvoicePostings,duplicateInvoicePostings,unbalancedJournals,mismatchedSubcontos,pendingInvoiceReview,foreignKeyErrors:foreignKeyErrors.length,...inventory});
}

function assertActiveAccount(accountCode) {
  const code=String(accountCode||'').trim();
  if(!code || !db.prepare(`SELECT 1 FROM accounts WHERE code=? AND active=1 AND COALESCE(is_postable,1)=1`).get(code)) throw new Error(`Uçot hesabı tapılmadı, aktiv deyil və ya qrup hesabıdır: ${code||'boş hesab'}.`);
  return code;
}

function assertAccountRole(accountCode,expectedRoles,contextLabel='Bu sahə') {
  const code=assertActiveAccount(accountCode);
  const role=accountRole(code);
  const roles=Array.isArray(expectedRoles)?expectedRoles:[expectedRoles];
  if(!roles.includes(role)) throw new Error(`${contextLabel} yalnız ${roles.join(' / ')} rolu olan yazılış hesabına bağlana bilər: ${code}.`);
  return code;
}

function assertJournalBalanced(journalEntryId) {
  const balance=db.prepare(`SELECT ROUND(COALESCE(SUM(debit),0),2) debit,ROUND(COALESCE(SUM(credit),0),2) credit FROM journal_lines WHERE journal_entry_id=?`).get(Number(journalEntryId));
  if(Math.abs(Number(balance.debit)-Number(balance.credit))>0.005) throw new Error(`Müxabirləşmə balanslaşmır: Debet ${Number(balance.debit).toFixed(2)} · Kredit ${Number(balance.credit).toFixed(2)}.`);
}

function journalLineStatement() {
  return db.prepare(`INSERT INTO journal_lines(journal_entry_id,account_code,debit,credit,analytic_type,analytic_key,subkonto_id,counterparty_id,contract_id,warehouse_id,catalog_item_id,invoice_item_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
}

function invoiceInventoryScopes(invoice) {
  const unique=new Map();
  for(const item of invoice.items||[]){
    if(item.item_type!=='Mal' || !item.catalog_item_id || !item.warehouse_id) continue;
    const key=`${item.warehouse_id}:${item.catalog_item_id}`;
    unique.set(key,{warehouseId:Number(item.warehouse_id),catalogItemId:Number(item.catalog_item_id)});
  }
  return [...unique.values()];
}

function reverseActiveJournalForSource(sourceType,sourceId,reason='Redaktə üzrə storno') {
  const original=db.prepare(`SELECT * FROM journal_entries WHERE source_type=? AND source_id=? AND status='Təsdiqlənib' ORDER BY id DESC LIMIT 1`).get(String(sourceType),Number(sourceId));
  if(!original) return null;
  assertAccountingDateOpen(original.entry_date);
  const t=nowIso();
  const created=db.prepare(`INSERT INTO journal_entries(company_id,source_type,source_id,entry_date,description,status,created_at,reversal_of_id) VALUES(1,?,?,?,?,?,?,?)`)
    .run(`${sourceType}_reversal`,Number(sourceId),original.entry_date,`${reason} · ${original.description||''}`,'Təsdiqlənib',t,original.id);
  const reversalId=Number(created.lastInsertRowid),insert=journalLineStatement();
  const lines=db.prepare(`SELECT * FROM journal_lines WHERE journal_entry_id=? ORDER BY id`).all(original.id);
  for(const line of lines) insert.run(reversalId,line.account_code,round2(line.credit),round2(line.debit),`reversal:${line.analytic_type||''}`,line.analytic_key,line.subkonto_id,line.counterparty_id,line.contract_id,line.warehouse_id,line.catalog_item_id,line.invoice_item_id);
  assertJournalBalanced(reversalId);
  db.prepare(`UPDATE journal_entries SET source_type=?,reversed_by_id=? WHERE id=?`).run(`${sourceType}_superseded`,reversalId,original.id);
  return reversalId;
}

function reverseAllActiveJournalsForSource(sourceType,sourceId,reason='Redaktə üzrə storno') {
  const reversalIds=[];
  while(db.prepare(`SELECT 1 FROM journal_entries WHERE source_type=? AND source_id=? AND status='Təsdiqlənib' LIMIT 1`).get(String(sourceType),Number(sourceId))){
    const reversalId=reverseActiveJournalForSource(sourceType,sourceId,reason);
    if(!reversalId) break;
    reversalIds.push(reversalId);
  }
  return reversalIds;
}

function createInvoicePosting(id,{replaceExisting=false}={}) {
  const settings=accountingStatus();
  if(!settings.accounting_enabled) throw new Error('Uçot deaktivdir; qaimə uçotsuz saxlanıla bilməz.');
  const inv=invoiceDetail(Number(id));
  if(!inv) throw new Error('Qaimə tapılmadı.');
  assertAccountingDateOpen(inv.invoice_date);
  const exchangeRate=String(inv.currency||'AZN')==='AZN'?1:Number(inv.exchange_rate||0);
  if(!(exchangeRate>0)) throw new Error('Xarici valyutalı qaimənin AZN məzənnəsi düzgün deyil.');
  const existing=db.prepare(`SELECT id FROM journal_entries WHERE source_type='invoice' AND source_id=? AND status='Təsdiqlənib' ORDER BY id DESC LIMIT 1`).get(inv.id);
  if(existing && !replaceExisting){
    assertJournalBalanced(Number(existing.id));
    return {invoice:inv,journalEntryId:Number(existing.id),scopes:invoiceInventoryScopes(inv),created:false};
  }
  if(existing) reverseAllActiveJournalsForSource('invoice',inv.id,'Qaimə redaktəsi üzrə storno');

  const profile=inv.posting_profile_id
    ? db.prepare(`SELECT * FROM posting_profiles WHERE id=? AND active=1`).get(Number(inv.posting_profile_id))
    : db.prepare(`SELECT * FROM posting_profiles WHERE direction=? AND active=1 ORDER BY id LIMIT 1`).get(inv.direction);
  if(!profile || profile.direction!==inv.direction) throw new Error(`${inv.direction} qaimə üçün aktiv uçot profili tapılmadı.`);

  const counterpartyAccount=assertAccountRole(inv.counterparty_account_code||defaultCounterpartyAccount(inv.direction),inv.direction==='Gələn'?'PAYABLE':'RECEIVABLE','Kontragent hesabı');
  const vatAccount=inv.vat_amount>0?assertAccountRole(inv.vat_posting_account_code||defaultVatAccount(inv.direction),inv.direction==='Gələn'?'INPUT_VAT':'OUTPUT_VAT','ƏDV hesabı'):null;
  if(inv.contract_id&&!db.prepare(`SELECT 1 FROM counterparty_contracts WHERE id=? AND counterparty_id=? AND active=1`).get(Number(inv.contract_id),Number(inv.counterparty_id)))throw new Error('Seçilmiş müqavilə qaimənin kontragentinə aid deyil.');
  for(const item of inv.items){
    const itemAccount=assertActiveAccount(item.posting_account_code||(inv.direction==='Gələn'?(item.item_type==='Mal'?inventoryAccountForWarehouse(item.warehouse_id):suspenseAccount()):(item.item_type==='Mal'?accountByRole('SALES_GOODS','601.01'):accountByRole('SALES_SERVICE','601.02'))));
    if(item.subkonto_id&&!db.prepare(`SELECT 1 FROM account_subcontos WHERE id=? AND account_code=? AND active=1`).get(Number(item.subkonto_id),itemAccount))throw new Error(`${item.description}: subkonto ${itemAccount} hesabına aid deyil.`);
    if(item.item_type==='Mal'){
      const selectedWarehouse=db.prepare(`SELECT inventory_account_code FROM warehouses WHERE id=? AND company_id=1 AND active=1`).get(Number(item.warehouse_id));
      if(!selectedWarehouse)throw new Error(`${item.description}: mal sətri üçün aktiv anbar seçilməlidir.`);
      if(inv.direction==='Gələn'&&itemAccount!==selectedWarehouse.inventory_account_code)throw new Error(`${item.description}: gələn malın hesabı seçilmiş anbarın ehtiyat hesabı ilə uyğun deyil (${selectedWarehouse.inventory_account_code}).`);
    }
  }

  const t=nowIso();
  const created=db.prepare(`INSERT INTO journal_entries(company_id,source_type,source_id,entry_date,description,status,created_at) VALUES(1,'invoice',?,?,?,?,?)`)
    .run(inv.id,inv.invoice_date,`${inv.direction} E-Qaimə ${inv.invoice_no} — ${inv.counterparty_name}`,'Təsdiqlənib',t);
  const journalEntryId=Number(created.lastInsertRowid);
  const insertLine=journalLineStatement();
  const addLine=(accountCode,debit,credit,analyticType,analyticKey,item=null)=>insertLine.run(
    journalEntryId,accountCode,round2(debit),round2(credit),analyticType,analyticKey,
    item?.subkonto_id||null,inv.counterparty_id||null,inv.contract_id||null,item?.warehouse_id||null,item?.catalog_item_id||null,item?.id||null
  );

  const allocateBaseAmounts=(items,target)=>{let allocated=0;return items.map((item,index)=>{const amount=index===items.length-1?round2(target-allocated):round2(Number(item.base_amount)*exchangeRate);allocated=round2(allocated+amount);return amount;});};
  const baseTarget=round2(Number(inv.base_amount)*exchangeRate),vatTarget=round2(Number(inv.vat_amount)*exchangeRate),totalTarget=round2(Number(inv.total_amount)*exchangeRate);
  const itemBaseAmounts=allocateBaseAmounts(inv.items,baseTarget);
  if(inv.direction==='Gələn'){
    for(const [index,item] of inv.items.entries()){
      const account=item.posting_account_code||(item.item_type==='Mal'?inventoryAccountForWarehouse(item.warehouse_id):suspenseAccount());
      if(itemBaseAmounts[index]>0) addLine(account,itemBaseAmounts[index],0,item.item_type==='Mal'?'inventory-purchase':'expense-service',`${inv.invoice_no} · ${item.description}`,item);
    }
    if(vatTarget>0) addLine(vatAccount,vatTarget,0,'invoice-vat',inv.invoice_no);
    addLine(counterpartyAccount,0,totalTarget,'counterparty',inv.voen);
  }else{
    addLine(counterpartyAccount,totalTarget,0,'counterparty',inv.voen);
    for(const [index,item] of inv.items.entries()){
      const account=item.posting_account_code||(item.item_type==='Mal'?accountByRole('SALES_GOODS','601.01'):accountByRole('SALES_SERVICE','601.02'));
      if(itemBaseAmounts[index]>0) addLine(account,0,itemBaseAmounts[index],item.item_type==='Mal'?'goods-revenue':'service-revenue',`${inv.invoice_no} · ${item.description}`,item);
    }
    if(vatTarget>0) addLine(vatAccount,0,vatTarget,'invoice-vat',inv.invoice_no);
  }
  assertJournalBalanced(journalEntryId);

  if(inv.status!=='Təsdiqlənib'){
    recordStatusTransition(inv.id,inv.status,'Təsdiqlənib','Avtomatik uçota alma');
  }
  db.prepare(`UPDATE invoices SET status='Təsdiqlənib',posting_status='Uçota alınıb',auto_posted=1,updated_at=? WHERE id=?`).run(t,inv.id);
  return {invoice:invoiceDetail(inv.id),journalEntryId,scopes:invoiceInventoryScopes(inv),created:true};
}

function rebuildInventoryScopes(scopes=[],{strictNegativeStock=true}={}) {
  const normalizedScopes=scopes.map(scope=>({warehouseId:Number(scope.warehouseId??scope.warehouse_id),catalogItemId:Number(scope.catalogItemId??scope.catalog_item_id)})).filter(scope=>scope.warehouseId&&scope.catalogItemId);
  const unique=new Map(normalizedScopes.map(scope=>[`${scope.warehouseId}:${scope.catalogItemId}`,scope]));
  for(const scope of unique.values()){
    const warehouse=db.prepare(`SELECT * FROM warehouses WHERE id=? AND company_id=1 AND active=1`).get(Number(scope.warehouseId));
    const catalog=db.prepare(`SELECT * FROM item_catalog WHERE id=? AND company_id=1 AND active=1`).get(Number(scope.catalogItemId));
    if(!warehouse || !catalog) continue;
    assertActiveAccount(warehouse.inventory_account_code);
    assertActiveAccount(warehouse.cogs_account_code);

    db.prepare(`DELETE FROM journal_lines WHERE analytic_type IN ('inventory-cogs','inventory-stock-out')
      AND warehouse_id=? AND catalog_item_id=?
      AND journal_entry_id IN (SELECT id FROM journal_entries WHERE source_type='invoice' AND status='Təsdiqlənib')`).run(warehouse.id,catalog.id);
    db.prepare(`DELETE FROM stock_movements WHERE warehouse_id=? AND catalog_item_id=?`).run(warehouse.id,catalog.id);

    const sourceRows=db.prepare(`
      SELECT ii.id AS invoice_item_id,ii.invoice_id,ii.qty,
        COALESCE((SELECT l.debit FROM journal_lines l WHERE l.journal_entry_id=j.id AND l.invoice_item_id=ii.id AND l.analytic_type='inventory-purchase' LIMIT 1),ii.base_amount*COALESCE(i.exchange_rate,1)) AS base_amount,
        i.direction,i.invoice_date,j.id AS journal_entry_id
      FROM invoice_items ii
      JOIN invoices i ON i.id=ii.invoice_id AND i.deleted_at IS NULL AND i.posting_status='Uçota alınıb'
      JOIN journal_entries j ON j.source_type='invoice' AND j.source_id=i.id AND j.status='Təsdiqlənib'
      WHERE ii.item_type='Mal' AND ii.warehouse_id=? AND ii.catalog_item_id=?
      ORDER BY i.invoice_date,i.id,ii.line_no,ii.id`).all(warehouse.id,catalog.id);
    const valuation=valueInventoryMovements(sourceRows.map(row=>({
      ...row,direction:row.direction==='Gələn'?'IN':'OUT',quantity:Number(row.qty),
      totalCost:row.direction==='Gələn'?Number(row.base_amount):undefined
    })),warehouse.valuation_method,Number(catalog.standard_cost||0));
    const blocked=valuation.movements.find(movement=>movement.shortageQuantity>0&&!warehouse.allow_negative_stock);
    if(blocked && strictNegativeStock) throw new Error(`${catalog.code} / ${warehouse.name}: qalıq ${blocked.shortageQuantity} ${catalog.unit} çatmır. Mənfi anbara icazə verilmədiyi üçün qaimə uçota alınmadı.`);
    const insertMovement=db.prepare(`INSERT INTO stock_movements(company_id,warehouse_id,catalog_item_id,invoice_id,invoice_item_id,journal_entry_id,movement_date,direction,quantity,unit_cost,total_cost,shortage_quantity,valuation_method,created_at) VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertLine=journalLineStatement();
    for(const movement of valuation.movements){
      insertMovement.run(warehouse.id,catalog.id,movement.invoice_id,movement.invoice_item_id,movement.journal_entry_id,movement.invoice_date,movement.direction,movement.quantity,movement.unitCost,movement.totalCost,movement.shortageQuantity,warehouse.valuation_method,nowIso());
      db.prepare(`UPDATE invoice_items SET cost_amount=? WHERE id=?`).run(movement.direction==='OUT'?movement.totalCost:0,movement.invoice_item_id);
      if(movement.direction==='OUT' && movement.totalCost>0){
        const invoice=db.prepare(`SELECT counterparty_id,contract_id,invoice_no FROM invoices WHERE id=?`).get(movement.invoice_id);
        insertLine.run(movement.journal_entry_id,warehouse.cogs_account_code,movement.totalCost,0,'inventory-cogs',`${invoice.invoice_no} · ${catalog.code}`,null,invoice.counterparty_id||null,invoice.contract_id||null,warehouse.id,catalog.id,movement.invoice_item_id);
        insertLine.run(movement.journal_entry_id,warehouse.inventory_account_code,0,movement.totalCost,'inventory-stock-out',`${invoice.invoice_no} · ${catalog.code}`,null,invoice.counterparty_id||null,invoice.contract_id||null,warehouse.id,catalog.id,movement.invoice_item_id);
      }
      if(movement.shortageQuantity>0&&!warehouse.allow_negative_stock){
        const reason=`${catalog.code} / ${warehouse.name}: ${movement.shortageQuantity} ${catalog.unit} mənfi anbar qalığı`;
        db.prepare(`UPDATE invoices SET accounting_review_required=1,accounting_review_reason=CASE WHEN COALESCE(accounting_review_reason,'')='' THEN ? ELSE accounting_review_reason||' · '||? END WHERE id=?`).run(reason,reason,movement.invoice_id);
      }
      assertJournalBalanced(movement.journal_entry_id);
    }
  }
}

function postInvoice(id) {
  db.exec('BEGIN IMMEDIATE');
  try{
    const result=createInvoicePosting(Number(id));
    rebuildInventoryScopes(result.scopes);
    audit(result.created?'Qaimə avtomatik uçota alındı':'Qaimə uçotda yoxlanıldı','E-Qaimə',Number(id),null,{journal_entry_id:result.journalEntryId,automatic:true});
    db.exec('COMMIT');
    return invoiceDetail(Number(id));
  }catch(error){
    try{db.exec('ROLLBACK')}catch(_){}
    throw error;
  }
}



function bankStatus() {
  const accounts = db.prepare(`SELECT id,bank_name,account_name,account_no,iban,currency,ledger_account_code,api_provider,api_environment,integration_status,active FROM bank_accounts WHERE active=1 ORDER BY bank_name,account_name`).all();
  const txCount = Number(db.prepare(`SELECT COUNT(*) c FROM bank_transactions`).get().c||0);
  const reconciled = Number(db.prepare(`SELECT COUNT(*) c FROM bank_transactions WHERE reconciliation_status<>'Uyğunlaşdırılmayıb'`).get().c||0);
  return {accounts,txCount,reconciled,approvalRequired:true,apiEnabled:false};
}
function bankSaveAccount(payload={}) {
  const bankName=String(payload.bank_name||'').trim();
  if(!bankName) throw new Error('Bank adı daxil edilməlidir.');
  const ledger=assertActiveAccount(payload.ledger_account_code||accountByRole('BANK','223.01'));
  if(accountRole(ledger)!=='BANK') throw new Error(`Bank hesabı yalnız BANK rolu olan uçot hesabına bağlana bilər: ${ledger}.`);
  const currency=String(payload.currency||'AZN').trim().toUpperCase();
  if(!['AZN','USD','EUR'].includes(currency)) throw new Error('Bank hesabının valyutası AZN, USD və ya EUR olmalıdır.');
  const environment=String(payload.api_environment||'sandbox');
  if(!['sandbox','production'].includes(environment)) throw new Error('Bank inteqrasiya mühiti düzgün deyil.');
  const iban=String(payload.iban||'').replace(/\s/g,'').toUpperCase();
  const accountNo=String(payload.account_no||'').trim();
  if(!iban && !accountNo) throw new Error('IBAN və ya bank hesab nömrəsi daxil edilməlidir.');
  if(iban && !/^AZ\d{2}[A-Z0-9]{24}$/.test(iban)) throw new Error('Azərbaycan IBAN-ı AZ ilə başlamalı və 28 simvoldan ibarət olmalıdır.');
  if(iban){
    const duplicate=db.prepare(`SELECT id FROM bank_accounts WHERE upper(replace(iban,' ',''))=? AND active=1${payload.id?' AND id<>?':''}`);
    const hit=payload.id?duplicate.get(iban,Number(payload.id)):duplicate.get(iban);
    if(hit) throw new Error('Bu IBAN üzrə aktiv bank hesabı artıq mövcuddur.');
  }
  const t=nowIso();
  if(payload.id){
    const current=db.prepare(`SELECT currency,ledger_account_code FROM bank_accounts WHERE id=? AND active=1`).get(Number(payload.id));
    if(!current) throw new Error('Dəyişdiriləcək aktiv bank hesabı tapılmadı.');
    const hasTransactions=Number(db.prepare(`SELECT COUNT(*) c FROM bank_transactions WHERE bank_account_id=?`).get(Number(payload.id)).c||0)>0;
    if(hasTransactions && (current.currency!==currency || current.ledger_account_code!==ledger)) throw new Error('Əməliyyatları olan bank hesabının valyutası və mühasibat hesabı dəyişdirilə bilməz.');
    const changed=db.prepare(`UPDATE bank_accounts SET bank_name=?,account_name=?,account_no=?,iban=?,currency=?,ledger_account_code=?,api_environment=?,updated_at=? WHERE id=? AND active=1`).run(bankName,String(payload.account_name||'').trim(),accountNo,iban,currency,ledger,environment,t,Number(payload.id));
    if(!Number(changed.changes||0)) throw new Error('Dəyişdiriləcək aktiv bank hesabı tapılmadı.');
    return db.prepare(`SELECT * FROM bank_accounts WHERE id=?`).get(Number(payload.id));
  }
  const provider=String(payload.api_provider||'Fayl idxalı / əl ilə').trim();
  const r=db.prepare(`INSERT INTO bank_accounts(company_id,bank_name,account_name,account_no,iban,currency,ledger_account_code,api_provider,api_environment,integration_status,created_at,updated_at) VALUES(1,?,?,?,?,?,?,?,?, 'Hazır',?,?)`).run(bankName,String(payload.account_name||'').trim(),accountNo,iban,currency,ledger,provider,environment,t,t);
  return db.prepare(`SELECT * FROM bank_accounts WHERE id=?`).get(Number(r.lastInsertRowid));
}
function bankTransactionFilterSql(args={}) {
  const where=['1=1'], params=[];
  if(args.accountId){where.push('bt.bank_account_id=?');params.push(Number(args.accountId));}
  if(args.direction && ['Daxilolma','Ödəniş'].includes(String(args.direction))){where.push('bt.direction=?');params.push(String(args.direction));}
  if(args.status && args.status!=='all'){where.push('bt.reconciliation_status=?');params.push(String(args.status));}
  if(args.search){const q='%'+String(args.search).toLowerCase()+'%';where.push(`(lower(COALESCE(bt.counterparty_name,'')) LIKE ? OR lower(COALESCE(bt.counterparty_voen,'')) LIKE ? OR lower(COALESCE(bt.reference,'')) LIKE ? OR lower(COALESCE(bt.description,'')) LIKE ?)`);params.push(q,q,q,q);}
  return {whereSql:where.join(' AND '),params};
}
function bankTransactions(args={}) {
  const {whereSql,params}=bankTransactionFilterSql(args);
  const limit=Math.min(500,Math.max(1,Number(args.limit)||200)),offset=Math.max(0,Number(args.offset)||0);
  return db.prepare(`SELECT bt.*,ba.bank_name,ba.account_name,ba.iban,ba.ledger_account_code,br.invoice_id,br.payment_id, i.invoice_no FROM bank_transactions bt JOIN bank_accounts ba ON ba.id=bt.bank_account_id LEFT JOIN bank_reconciliations br ON br.transaction_id=bt.id LEFT JOIN invoices i ON i.id=br.invoice_id WHERE ${whereSql} ORDER BY bt.transaction_date DESC,bt.id DESC LIMIT ? OFFSET ?`).all(...params,limit,offset);
}
function bankTransactionCount(args={}) {
  const {whereSql,params}=bankTransactionFilterSql(args);
  return Number(db.prepare(`SELECT COUNT(*) count FROM bank_transactions bt WHERE ${whereSql}`).get(...params)?.count||0);
}
function bankTransaction(id) {
  return db.prepare(`SELECT bt.*,ba.bank_name,ba.account_name,ba.iban,ba.ledger_account_code,br.invoice_id,br.payment_id,i.invoice_no
    FROM bank_transactions bt JOIN bank_accounts ba ON ba.id=bt.bank_account_id
    LEFT JOIN bank_reconciliations br ON br.transaction_id=bt.id
    LEFT JOIN invoices i ON i.id=br.invoice_id WHERE bt.id=?`).get(Number(id)) || null;
}
function bankSuggestions(transactionId){
  const tx=db.prepare(`SELECT * FROM bank_transactions WHERE id=?`).get(Number(transactionId));
  if(!tx) throw new Error('Bank əməliyyatı tapılmadı.');
  if(tx.reconciliation_status!=='Uyğunlaşdırılmayıb') return [];
  const dir=tx.direction==='Daxilolma'?'Gedən':'Gələn';
  const rows=invoiceRows({type:dir,limit:500,offset:0},500).filter(row=>row.posting_status==='Uçota alınıb'&&String(row.currency)===String(tx.currency||'AZN')&&Number(row.outstanding_amount)>0.005);
  const ref=String(tx.reference||'').trim().toLowerCase(), cp=String(tx.counterparty_name||'').trim().toLowerCase(), voen=String(tx.counterparty_voen||'').trim();
  return rows.map(r=>{let score=0;const invNo=String(r.invoice_no||'').toLowerCase(),name=String(r.counterparty_name||'').toLowerCase();if(ref&&invNo.includes(ref))score+=100;if(cp&&name.includes(cp))score+=60;if(voen&&String(r.voen||'')===voen)score+=80;const diff=Math.abs(Number(r.total_amount)-Number(r.paid_amount)-Number(tx.amount||0));if(diff<0.005)score+=40;return {...r,score,amount_diff:diff};}).sort((a,b)=>Number(b.score)-Number(a.score)||Number(a.amount_diff)-Number(b.amount_diff)).slice(0,20);
}

function bankReconcile(payload={}){
  if(!accountingStatus().accounting_enabled) throw new Error('Əvvəlcə Dövriyyə-Balans uçotunu aktivləşdirin.');
  const tx=db.prepare(`SELECT bt.*,ba.ledger_account_code FROM bank_transactions bt JOIN bank_accounts ba ON ba.id=bt.bank_account_id WHERE bt.id=?`).get(Number(payload.transactionId));
  if(!tx) throw new Error('Bank əməliyyatı tapılmadı.');
  if(db.prepare(`SELECT id FROM bank_reconciliations WHERE transaction_id=?`).get(tx.id)) throw new Error('Bu bank əməliyyatı artıq uyğunlaşdırılıb.');
  if(db.prepare(`SELECT 1 FROM vat_payment_allocations WHERE bank_transaction_id=? LIMIT 1`).get(tx.id)) throw new Error('Bu bank əməliyyatı ƏDV depozit/gömrük ödənişi kimi istifadə olunub. Bağlantını Aylıq ƏDV modulunda idarə edin.');
  const expectedDir=tx.direction==='Daxilolma'?'Gedən':'Gələn';
  assertAccountingDateOpen(tx.transaction_date);
  assertVatDateOpen(tx.transaction_date);
  const requested=Array.isArray(payload.allocations)&&payload.allocations.length?payload.allocations:[{invoiceId:payload.invoiceId,amount:payload.amount||tx.amount}];
  if(requested.length>100) throw new Error('Bir bank əməliyyatı ən çox 100 qaiməyə bölünə bilər.');
  const allocations=requested.map(item=>({invoice:invoiceDetail(Number(item.invoiceId)),amount:round2(item.amount)}));
  const allocationTotalsByInvoice=new Map();
  for(const allocation of allocations){
    const inv=allocation.invoice;if(!inv)throw new Error('Bölgüdə qaimə tapılmadı.');
    if(inv.direction!==expectedDir)throw new Error(`${inv.invoice_no}: bank istiqaməti ${expectedDir} qaimə tələb edir.`);
    if(inv.posting_status!=='Uçota alınıb')throw new Error(`${inv.invoice_no}: qaimə əvvəlcə uçota alınmalıdır.`);
    if(String(inv.currency)!==String(tx.currency))throw new Error(`${inv.invoice_no}: valyuta ${tx.currency} ilə uyğun deyil.`);
    if(!(allocation.amount>0))throw new Error(`${inv.invoice_no}: bölgü məbləği 0-dan böyük olmalıdır.`);
    const allocatedForInvoice=round2((allocationTotalsByInvoice.get(inv.id)||0)+allocation.amount);
    allocationTotalsByInvoice.set(inv.id,allocatedForInvoice);
    if(allocatedForInvoice>Number(inv.outstanding_amount)+0.005)throw new Error(`${inv.invoice_no}: bölgülərin cəmi açıq qalıqdan çoxdur.`);
  }
  if(allocationTotalsByInvoice.size!==allocations.length)throw new Error('Eyni qaimə bölgü siyahısında bir dəfədən çox seçilə bilməz. Məbləği bir sətirdə birləşdirin.');
  const amount=round2(allocations.reduce((sum,row)=>sum+row.amount,0));
  if(Math.abs(amount-Number(tx.amount))>0.005)throw new Error(`Bölgülərin cəmi bank əməliyyatına bərabər olmalıdır: ${amount.toFixed(2)} / ${Number(tx.amount).toFixed(2)} ${tx.currency}.`);
  const rate=String(tx.currency)==='AZN'?1:Number(payload.exchangeRate||0);if(!(rate>0))throw new Error('Xarici valyutalı bank əməliyyatı üçün AZN məzənnəsi daxil edilməlidir.');
  const t=nowIso(); db.exec('BEGIN IMMEDIATE');
  try{
    const uniqueCounterparties=new Set(allocations.map(row=>row.invoice.counterparty_id));const sole=uniqueCounterparties.size===1?allocations[0].invoice:null;
    const p=db.prepare(`INSERT INTO payments(company_id,payment_date,document_no,counterparty_id,counterparty_name,amount,currency,source,created_at) VALUES(1,?,?,?,?,?,?,?,?)`).run(tx.transaction_date,tx.reference||`BANK-${tx.id}`,sole?.counterparty_id||null,sole?.counterparty_name||'Çoxsaylı bölgü',amount,tx.currency,'bank-import',t);
    const paymentId=Number(p.lastInsertRowid);
    const entry=db.prepare(`INSERT INTO journal_entries(company_id,source_type,source_id,entry_date,description,status,created_at) VALUES(1,'bank_payment',?,?,?,?,?)`).run(tx.id,tx.transaction_date,`Bank ${tx.direction} · ${allocations.length} qaimə`,'Təsdiqlənib',t);
    const jid=Number(entry.lastInsertRowid),line=journalLineStatement(),functionalTotal=round2(amount*rate);
    if(tx.direction==='Daxilolma')line.run(jid,assertActiveAccount(tx.ledger_account_code),functionalTotal,0,'bank',String(tx.id),null,null,null,null,null,null);
    const first=allocations[0].invoice;
    const rec=db.prepare(`INSERT INTO bank_reconciliations(transaction_id,invoice_id,payment_id,allocated_amount,matched_by,matched_at) VALUES(?,?,?,?,?,?)`).run(tx.id,first.id,paymentId,amount,currentUserName(),t);
    const reconciliationId=Number(rec.lastInsertRowid);
    for(const allocation of allocations){
      const inv=allocation.invoice,pa=db.prepare(`INSERT INTO payment_allocations(payment_id,invoice_id,amount,created_at) VALUES(?,?,?,?)`).run(paymentId,inv.id,allocation.amount,t);
      // Close the counterparty subledger at the invoice's own booked rate, not the
      // payment's rate, so 211.01/531.01 nets to zero for a fully-paid foreign
      // currency invoice. Any difference from the payment being settled at a
      // different rate is a realized FX gain/loss (723.02 / 723.01), not left
      // sitting unallocated in the counterparty account.
      const invoiceRate=String(inv.currency||'AZN')==='AZN'?1:Number(inv.exchange_rate||rate);
      const functionalAtInvoiceRate=round2(allocation.amount*invoiceRate);
      const functionalAtPaymentRate=round2(allocation.amount*rate);
      const fxDiff=round2(functionalAtPaymentRate-functionalAtInvoiceRate);
      const account=assertActiveAccount(inv.counterparty_account_code||defaultCounterpartyAccount(inv.direction));
      if(tx.direction==='Daxilolma')line.run(jid,account,0,functionalAtInvoiceRate,'counterparty',inv.voen,null,inv.counterparty_id,inv.contract_id||null,null,null,null);
      else line.run(jid,account,functionalAtInvoiceRate,0,'counterparty',inv.voen,null,inv.counterparty_id,inv.contract_id||null,null,null,null);
      if(Math.abs(fxDiff)>0.004){
        // Daxilolma: extra cash received vs. booked receivable is a gain; a shortfall is a loss.
        // Ödəniş: extra cash paid vs. booked payable is a loss; a shortfall is a gain.
        const isGain=tx.direction==='Daxilolma'?fxDiff>0:fxDiff<0;
        const fxAccount=assertActiveAccount(isGain?fxGainAccount():fxLossAccount());
        if(isGain)line.run(jid,fxAccount,0,Math.abs(fxDiff),'fx-difference',inv.invoice_no,null,inv.counterparty_id,inv.contract_id||null,null,null,null);
        else line.run(jid,fxAccount,Math.abs(fxDiff),0,'fx-difference',inv.invoice_no,null,inv.counterparty_id,inv.contract_id||null,null,null,null);
      }
      db.prepare(`INSERT INTO bank_reconciliation_allocations(reconciliation_id,invoice_id,payment_allocation_id,amount) VALUES(?,?,?,?)`).run(reconciliationId,inv.id,Number(pa.lastInsertRowid),allocation.amount);
    }
    if(tx.direction==='Ödəniş')line.run(jid,assertActiveAccount(tx.ledger_account_code),0,functionalTotal,'bank',String(tx.id),null,null,null,null,null,null);
    assertJournalBalanced(jid);
    db.prepare(`UPDATE bank_transactions SET reconciliation_status='Uyğunlaşdırılıb' WHERE id=?`).run(tx.id);
    audit('Bank əməliyyatı qaimələr üzrə bölündü','Bank',tx.id,null,{allocations:allocations.map(row=>({invoice_id:row.invoice.id,amount:row.amount})),payment_id:paymentId,amount,journal_entry_id:jid,exchange_rate:rate});
    db.exec('COMMIT');
    return {ok:true,paymentId,journalEntryId:jid,transaction:db.prepare(`SELECT * FROM bank_transactions WHERE id=?`).get(tx.id)};
  }catch(e){try{db.exec('ROLLBACK')}catch(_){};throw e;}
}
function bankUnreconcile(transactionId){
  const tx=bankTransaction(Number(transactionId));if(!tx)throw new Error('Bank əməliyyatı tapılmadı.');
  const reconciliation=db.prepare(`SELECT * FROM bank_reconciliations WHERE transaction_id=?`).get(tx.id);if(!reconciliation)throw new Error('Bu əməliyyat uyğunlaşdırılmayıb.');
  assertAccountingDateOpen(tx.transaction_date);assertVatDateOpen(tx.transaction_date);db.exec('BEGIN IMMEDIATE');
  try{
    const reversalId=reverseActiveJournalForSource('bank_payment',tx.id,'Bank uyğunlaşdırmasının geri qaytarılması');
    db.prepare(`DELETE FROM bank_reconciliations WHERE id=?`).run(reconciliation.id);
    if(reconciliation.payment_id)db.prepare(`DELETE FROM payments WHERE id=?`).run(reconciliation.payment_id);
    db.prepare(`UPDATE bank_transactions SET reconciliation_status='Uyğunlaşdırılmayıb' WHERE id=?`).run(tx.id);
    audit('Bank uyğunlaşdırması geri qaytarıldı','Bank',tx.id,reconciliation,{reversal_journal_entry_id:reversalId});db.exec('COMMIT');return bankTransaction(tx.id);
  }catch(error){try{db.exec('ROLLBACK')}catch(_){};throw error;}
}

function saveIntegrationSyncSource(integrationType, sourceKey, sourceKind, sourcePath, syncResult=null) {
  const timestamp=nowIso();
  const serializedResult=syncResult==null?null:JSON.stringify(safePlain(syncResult));
  db.prepare(`INSERT INTO integration_sync_sources(
      company_id,integration_type,source_key,source_kind,source_path,last_sync_at,last_sync_result,active,created_at,updated_at
    ) VALUES(1,?,?,?,?,?,?,1,?,?)
    ON CONFLICT(company_id,integration_type,source_key) DO UPDATE SET
      source_kind=excluded.source_kind,
      source_path=excluded.source_path,
      last_sync_at=excluded.last_sync_at,
      last_sync_result=excluded.last_sync_result,
      active=1,
      updated_at=excluded.updated_at`).run(
        String(integrationType),String(sourceKey),String(sourceKind),sourcePath?String(sourcePath):null,
        timestamp,serializedResult,timestamp,timestamp
      );
  return db.prepare(`SELECT * FROM integration_sync_sources
    WHERE company_id=1 AND integration_type=? AND source_key=? AND active=1`).get(String(integrationType),String(sourceKey));
}

function integrationSyncSource(integrationType, sourceKey) {
  return db.prepare(`SELECT * FROM integration_sync_sources
    WHERE company_id=1 AND integration_type=? AND source_key=? AND active=1 LIMIT 1`).get(String(integrationType),String(sourceKey))||null;
}

function recordIntegrationSyncRun(integrationType, sourceKey, sourceKind, candidateRows, syncResult={}) {
  db.prepare(`INSERT INTO integration_sync_runs(
    company_id,integration_type,source_key,source_kind,candidate_rows,created_rows,skipped_existing_rows,failed_rows,result_json,created_at
  ) VALUES(1,?,?,?,?,?,?,?,?,?)`).run(
    String(integrationType),String(sourceKey),String(sourceKind),Number(candidateRows||0),
    Number(syncResult.created||0),Number(syncResult.skippedExisting||syncResult.duplicates||0),Number(syncResult.failed||0),
    JSON.stringify(safePlain(syncResult)),nowIso()
  );
}

function notifyMainDataRefresh(payload={}) {
  if(mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('invoice:refresh',safePlain(payload));
}

function bankImportRecords(records=[], accountId){
  const aid=Number(accountId||0),account=db.prepare(`SELECT id,currency FROM bank_accounts WHERE id=? AND active=1`).get(aid); if(!account) throw new Error('Bank hesabı seçilməyib.');
  let created=0,duplicates=0,skippedExisting=0,failed=0; const t=nowIso();
  db.exec('BEGIN IMMEDIATE');
  try{
    const stmt=db.prepare(`INSERT INTO bank_transactions(bank_account_id,external_id,transaction_date,value_date,direction,amount,currency,counterparty_name,counterparty_voen,description,reference,balance_after,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const existingTransactionByExternalId=db.prepare(`SELECT id FROM bank_transactions WHERE bank_account_id=? AND external_id=? LIMIT 1`);
    const existingTransactionByContent=db.prepare(`SELECT id FROM bank_transactions
      WHERE bank_account_id=? AND transaction_date=? AND COALESCE(value_date,transaction_date)=?
        AND direction=? AND ABS(amount-?)<0.005 AND upper(currency)=?
        AND trim(COALESCE(counterparty_voen,''))=?
        AND lower(trim(COALESCE(counterparty_name,'')))=lower(trim(?))
        AND lower(trim(COALESCE(description,'')))=lower(trim(?))
        AND lower(trim(COALESCE(reference,'')))=lower(trim(?))
        AND ((balance_after IS NULL AND ? IS NULL)
          OR (balance_after IS NOT NULL AND ? IS NOT NULL AND ABS(balance_after-?)<0.005))
      LIMIT 1`);
    for(const [rowIndex,r] of records.entries()){
      try{
        const dirRaw=String(r.direction||r.type||'').toLowerCase().replace(/ə/g,'e').replace(/ö/g,'o').replace(/ı/g,'i').replace(/ü/g,'u').replace(/ğ/g,'g').replace(/ç/g,'c').replace(/ş/g,'s');
        const debit=Math.abs(numberValue(r.debit||0)), credit=Math.abs(numberValue(r.credit||0)), rawAmount=numberValue(r.amount||0);
        let direction;
        if(/out|oden|odeme|debet|debit|withdraw|expense|cixis|mexaric/.test(dirRaw)) direction='Ödəniş';
        else if(/in|medaxil|daxil|credit|kredit|income/.test(dirRaw)) direction='Daxilolma';
        else if(debit>0 && credit===0) direction='Ödəniş';
        else if(credit>0 && debit===0) direction='Daxilolma';
        else direction=rawAmount<0?'Ödəniş':'Daxilolma';
        const amount=Math.abs(rawAmount || (direction==='Ödəniş'?debit:credit) || debit || credit);
        const date=normalizeDateValue(r.date||r.transaction_date);
        if(!date||!amount) throw new Error('tarix/məbləğ yoxdur');
        const reference=String(r.reference||r.document_no||'').trim();
        // Generic row IDs are not bank transaction identifiers. Treat only
        // explicitly named bank/external IDs as authoritative deduplication keys.
        const suppliedId=String(r.external_id||r.transaction_id||r.bank_transaction_id||'').trim();
        const valueDate=normalizeDateValue(r.value_date||date)||date;
        const counterpartyVoen=String(r.counterparty_voen||r.voen||'').replace(/\D/g,'');
        const counterpartyName=String(r.counterparty_name||r.name||'').trim();
        const description=String(r.description||r.purpose||'').trim();
        const hasBalanceAfter=r.balance_after!=null&&String(r.balance_after).trim()!=='';
        const balanceAfter=hasBalanceAfter?round2(numberValue(r.balance_after)):null;
        const fingerprint=[aid,date,direction,round2(amount),String(r.currency||account.currency||'AZN').toUpperCase(),counterpartyVoen,normalizeAccountingText(counterpartyName),normalizeAccountingText(description),normalizeAccountingText(reference),valueDate,balanceAfter==null?'':balanceAfter.toFixed(2)].join('|');
        const ext=suppliedId || `AUTO-${crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0,24)}`;
        const currency=String(r.currency||account.currency||'AZN').toUpperCase();
        if(currency!==String(account.currency)) throw new Error(`Valyuta bank hesabına uyğun deyil: ${currency}/${account.currency}`);
        // Bank refresh is append-only. A transaction already identified by the
        // bank's external ID or our deterministic fingerprint is never updated,
        // reconciled, posted or otherwise processed for a second time.
        const existingByExternalId=existingTransactionByExternalId.get(aid,ext);
        const existingByLegacyReference=!suppliedId&&reference?existingTransactionByExternalId.get(aid,reference):null;
        const existingByContent=existingTransactionByContent.get(aid,date,valueDate,direction,round2(amount),currency,counterpartyVoen,counterpartyName,description,reference,balanceAfter,balanceAfter,balanceAfter);
        if(existingByExternalId||existingByLegacyReference||existingByContent){
          duplicates++;
          skippedExisting++;
          continue;
        }
        stmt.run(aid,ext,date,valueDate,direction,round2(amount),currency,counterpartyName,counterpartyVoen,description,reference,balanceAfter,String(r.source||'import'),t);
        created++;
      }catch(e){if(/unique constraint failed:\s*bank_transactions/i.test(String(e.message))){duplicates++;skippedExisting++;}else{failed++;db.prepare(`INSERT INTO import_rejections(import_type,source_name,row_number,raw_json,error_message,created_at) VALUES('bank',?,?,?,?,?)`).run(String(r.source||'import'),rowIndex+1,JSON.stringify(r),String(e.message||e),t);}}
    }
    db.exec('COMMIT');
  }catch(e){try{db.exec('ROLLBACK')}catch(_){};throw e;}
  return {created,duplicates,skippedExisting,failed};
}

function vatPeriodRange(periodKey) {
  const match=String(periodKey||'').trim().match(/^(\d{4})-(\d{2})$/);
  if(!match)throw new Error('ƏDV dövrü YYYY-AA formatında olmalıdır.');
  const year=Number(match[1]),month=Number(match[2]);
  if(month<1||month>12)throw new Error('ƏDV dövrünün ayı düzgün deyil.');
  const start=`${match[1]}-${match[2]}-01`;
  const finalDay=new Date(Date.UTC(year,month,0)).getUTCDate();
  const end=`${match[1]}-${match[2]}-${String(finalDay).padStart(2,'0')}`;
  return {periodKey:`${match[1]}-${match[2]}`,start,end};
}

function vatDatePeriod(date) {
  if(!isValidIsoDate(date))throw new Error('ƏDV əməliyyatının tarixi düzgün deyil.');
  return String(date).slice(0,7);
}

function vatPeriodRecord(periodKey) {
  const {periodKey:key}=vatPeriodRange(periodKey);
  return db.prepare(`SELECT * FROM vat_periods WHERE period_key=?`).get(key)||{period_key:key,status:'OPEN'};
}

function assertVatDateOpen(date) {
  const key=vatDatePeriod(date);
  const closed=db.prepare(`SELECT period_key FROM vat_periods WHERE period_key=? AND status='CLOSED'`).get(key);
  if(closed)throw new Error(`${key} ƏDV dövrü bağlıdır. Dəyişiklik üçün əvvəlcə həmin dövrü yenidən açın.`);
}

function assertVatInvoiceOpen(invoiceId) {
  const invoice=db.prepare(`SELECT id,invoice_no,invoice_date FROM invoices WHERE id=?`).get(Number(invoiceId));
  if(!invoice)throw new Error('Qaimə tapılmadı.');
  const closed=db.prepare(`SELECT period_key FROM vat_periods WHERE status='CLOSED' AND period_key>=substr(?,1,7) ORDER BY period_key LIMIT 1`).get(invoice.invoice_date);
  if(closed)throw new Error(`${invoice.invoice_no} qaiməsinə təsir edən ${closed.period_key} və ya sonrakı ƏDV dövrü bağlıdır. Əvvəlcə dövrü yenidən açın.`);
  return invoice;
}

function vatPaymentMaps(direction,end,start) {
  const rows=db.prepare(`SELECT pa.invoice_id,
      COALESCE(SUM(CASE WHEN p.payment_date<=? THEN pa.amount ELSE 0 END),0) paid_end,
      COALESCE(SUM(CASE WHEN p.payment_date<? THEN pa.amount ELSE 0 END),0) paid_before
    FROM payment_allocations pa
    JOIN payments p ON p.id=pa.payment_id
    JOIN invoices i ON i.id=pa.invoice_id
    WHERE i.company_id=1 AND i.direction=? AND p.payment_date<=?
    GROUP BY pa.invoice_id`).all(end,start,direction,end);
  return new Map(rows.map(row=>[Number(row.invoice_id),{end:round2(row.paid_end),before:round2(row.paid_before)}]));
}

function vatDepositMaps(end,start) {
  const rows=db.prepare(`SELECT invoice_id,payment_kind,
      COALESCE(SUM(CASE WHEN payment_date<=? THEN amount_azn ELSE 0 END),0) paid_end,
      COALESCE(SUM(CASE WHEN payment_date<? THEN amount_azn ELSE 0 END),0) paid_before
    FROM vat_payment_allocations
    WHERE payment_date<=?
    GROUP BY invoice_id,payment_kind`).all(end,start,end);
  const result=new Map();
  for(const row of rows){
    const item=result.get(Number(row.invoice_id))||{};
    item[row.payment_kind]={end:round2(row.paid_end),before:round2(row.paid_before)};
    result.set(Number(row.invoice_id),item);
  }
  return result;
}

function vatCumulativeInput(invoice,basePaid,depositPaid,customsPaid) {
  const vatAmountAzn=round2(Number(invoice.vat_amount||0)*Number(invoice.exchange_rate||1));
  if(vatAmountAzn<=0)return 0;
  const treatment=String(invoice.vat_treatment||'STANDARD');
  if(treatment==='CUSTOMS')return round2(Math.min(vatAmountAzn,Math.max(0,Number(customsPaid||0))));
  if(treatment!=='STANDARD')return 0;
  const baseAmount=Number(invoice.base_amount||0);
  const baseRatio=baseAmount>0?Math.min(1,Math.max(0,Number(basePaid||0))/baseAmount):0;
  const permittedByBase=round2(vatAmountAzn*baseRatio);
  return round2(Math.min(vatAmountAzn,permittedByBase,Math.max(0,Number(depositPaid||0))));
}

function vatCumulativeOutput(invoice,paidAmount) {
  const vatAmountAzn=round2(Number(invoice.vat_amount||0)*Number(invoice.exchange_rate||1));
  const totalAmount=Number(invoice.total_amount||0);
  if(vatAmountAzn<=0||totalAmount<=0)return 0;
  return round2(vatAmountAzn*Math.min(1,Math.max(0,Number(paidAmount||0))/totalAmount));
}

function vatPreviousClosedCarry(periodKey) {
  const row=db.prepare(`SELECT period_key,snapshot_json FROM vat_periods WHERE status='CLOSED' AND period_key<? ORDER BY period_key DESC LIMIT 1`).get(periodKey);
  if(!row?.snapshot_json)return {periodKey:null,amount:0};
  try{
    const snapshot=JSON.parse(row.snapshot_json);
    return {periodKey:row.period_key,amount:round2(snapshot?.summary?.carry_forward_input_vat||0)};
  }catch(_){
    return {periodKey:row.period_key,amount:0,invalidSnapshot:true};
  }
}

function vatBuildPeriodReport(periodKey) {
  const {periodKey:key,start,end}=vatPeriodRange(periodKey);
  const incoming=db.prepare(`SELECT i.*,COALESCE(s.treatment,'STANDARD') vat_treatment,COALESCE(s.note,'') vat_note
    FROM invoices i LEFT JOIN vat_invoice_settings s ON s.invoice_id=i.id
    WHERE i.company_id=1 AND i.direction='Gələn' AND i.deleted_at IS NULL AND i.invoice_date<=? AND i.vat_amount>0.004
    ORDER BY i.invoice_date,i.id`).all(end);
  const outgoing=db.prepare(`SELECT i.*
    FROM invoices i
    WHERE i.company_id=1 AND i.direction='Gedən' AND i.deleted_at IS NULL AND i.invoice_date<=? AND i.vat_amount>0.004
    ORDER BY i.invoice_date,i.id`).all(end);
  const incomingPayments=vatPaymentMaps('Gələn',end,start);
  const outgoingPayments=vatPaymentMaps('Gedən',end,start);
  const deposits=vatDepositMaps(end,start);
  const paymentLinks=db.prepare(`SELECT v.id,v.invoice_id,v.bank_transaction_id,v.payment_kind,v.payment_date,v.amount_azn,
      v.source,v.note,bt.counterparty_name,bt.counterparty_voen,bt.description,bt.reference
    FROM vat_payment_allocations v JOIN bank_transactions bt ON bt.id=v.bank_transaction_id
    WHERE v.payment_date<=? ORDER BY v.payment_date,v.id`).all(end);
  const paymentLinksByInvoice=new Map();
  for(const link of paymentLinks){
    const invoiceLinks=paymentLinksByInvoice.get(Number(link.invoice_id))||[];
    invoiceLinks.push(link);
    paymentLinksByInvoice.set(Number(link.invoice_id),invoiceLinks);
  }
  const inputRows=[];
  for(const invoice of incoming){
    const base=incomingPayments.get(Number(invoice.id))||{end:0,before:0};
    const deposit=deposits.get(Number(invoice.id))||{};
    const vatDeposit=deposit.VAT_DEPOSIT||{end:0,before:0};
    const customs=deposit.CUSTOMS_VAT||{end:0,before:0};
    const cumulativeEnd=vatCumulativeInput(invoice,base.end,vatDeposit.end,customs.end);
    const cumulativeBefore=vatCumulativeInput(invoice,base.before,vatDeposit.before,customs.before);
    const vatAmountAzn=round2(Number(invoice.vat_amount)*Number(invoice.exchange_rate||1));
    const eligiblePeriod=round2(Math.max(0,cumulativeEnd-cumulativeBefore));
    const remaining=round2(Math.max(0,vatAmountAzn-cumulativeEnd));
    let status='Əvəzləşib',reason='Şərtlər tam yerinə yetirilib';
    if(invoice.vat_treatment==='NON_DEDUCTIBLE'){status='Əvəzləşmir';reason='Əvəzləşdirilməyən alış kimi işarələnib';}
    else if(invoice.vat_treatment==='EXEMPT'){status='Əvəzləşmir';reason='ƏDV-dən azad əməliyyatdır';}
    else if(invoice.vat_treatment==='ZERO'){status='Əvəzləşmir';reason='0% ƏDV əməliyyatıdır';}
    else if(invoice.vat_treatment==='CUSTOMS'&&customs.end<=0.004){status='Gömrük ƏDV-si gözləyir';reason='Gömrük üzrə ƏDV ödənişi əlaqələndirilməyib';}
    else if(invoice.vat_treatment==='STANDARD'&&base.end<=0.004){status='Əsas ödəniş gözləyir';reason='Qaimənin əsas məbləği bank ödənişi ilə bağlanmayıb';}
    else if(invoice.vat_treatment==='STANDARD'&&vatDeposit.end<=0.004){status='Depozit ƏDV-si gözləyir';reason='ƏDV depozit ödənişi əlaqələndirilməyib';}
    else if(remaining>0.004){status='Qismən əvəzləşib';reason='Əsas və ya ƏDV ödənişi qisməndir';}
    inputRows.push({
      invoice_id:Number(invoice.id),invoice_no:invoice.invoice_no,invoice_date:invoice.invoice_date,
      counterparty_name:invoice.counterparty_name,voen:invoice.voen,currency:invoice.currency,
      exchange_rate:Number(invoice.exchange_rate||1),base_amount:round2(invoice.base_amount),vat_amount:round2(invoice.vat_amount),
      vat_amount_azn:vatAmountAzn,treatment:invoice.vat_treatment,note:invoice.vat_note,
      base_paid:round2(base.end),vat_deposit_paid:round2(vatDeposit.end),customs_vat_paid:round2(customs.end),
      eligible_before:cumulativeBefore,eligible_period:eligiblePeriod,eligible_total:cumulativeEnd,remaining,status,reason,
      payment_links:paymentLinksByInvoice.get(Number(invoice.id))||[]
    });
  }
  const outputRows=[];
  for(const invoice of outgoing){
    const paid=outgoingPayments.get(Number(invoice.id))||{end:0,before:0};
    const cumulativeEnd=vatCumulativeOutput(invoice,paid.end);
    const cumulativeBefore=vatCumulativeOutput(invoice,paid.before);
    const recognizedPeriod=round2(Math.max(0,cumulativeEnd-cumulativeBefore));
    const vatAmountAzn=round2(Number(invoice.vat_amount)*Number(invoice.exchange_rate||1));
    if(recognizedPeriod>0.004||invoice.invoice_date>=start){
      outputRows.push({invoice_id:Number(invoice.id),invoice_no:invoice.invoice_no,invoice_date:invoice.invoice_date,
        counterparty_name:invoice.counterparty_name,voen:invoice.voen,currency:invoice.currency,
        total_amount:round2(invoice.total_amount),vat_amount_azn:vatAmountAzn,paid_total:round2(paid.end),
        recognized_before:cumulativeBefore,recognized_period:recognizedPeriod,recognized_total:cumulativeEnd,
        remaining:round2(Math.max(0,vatAmountAzn-cumulativeEnd)),status:cumulativeEnd>=vatAmountAzn-0.004?'Tam hesablanıb':paid.end>0?'Qismən hesablanıb':'Ödəniş gözləyir'});
    }
  }
  const adjustments=db.prepare(`SELECT a.*,i.invoice_no,i.counterparty_name FROM vat_adjustments a LEFT JOIN invoices i ON i.id=a.invoice_id WHERE a.adjustment_date>=? AND a.adjustment_date<=? ORDER BY a.adjustment_date,a.id`).all(start,end);
  const inputAdjustment=round2(adjustments.filter(row=>row.vat_side==='INPUT').reduce((sum,row)=>sum+Number(row.amount_azn),0));
  const outputAdjustment=round2(adjustments.filter(row=>row.vat_side==='OUTPUT').reduce((sum,row)=>sum+Number(row.amount_azn),0));
  const currentInput=round2(inputRows.reduce((sum,row)=>sum+row.eligible_period,0)+inputAdjustment);
  const currentOutput=round2(outputRows.reduce((sum,row)=>sum+row.recognized_period,0)+outputAdjustment);
  const prior=vatPreviousClosedCarry(key);
  const availableInput=round2(prior.amount+currentInput);
  const offsetUsed=round2(Math.min(Math.max(0,currentOutput),Math.max(0,availableInput)));
  const net=round2(currentOutput-availableInput);
  const payable=round2(Math.max(0,net));
  const carry=round2(Math.max(0,-net));
  const issues=[];
  if(prior.invalidSnapshot)issues.push({severity:'error',code:'PRIOR_SNAPSHOT',message:`${prior.periodKey} dövrünün bağlanış məlumatı oxunmur.`});
  const latestPriorActivity=db.prepare(`SELECT MAX(period_key) period_key FROM (
      SELECT substr(p.payment_date,1,7) period_key FROM payments p JOIN payment_allocations pa ON pa.payment_id=p.id JOIN invoices i ON i.id=pa.invoice_id WHERE i.vat_amount>0.004 AND p.payment_date<?
      UNION ALL SELECT substr(v.payment_date,1,7) FROM vat_payment_allocations v WHERE v.payment_date<?
      UNION ALL SELECT substr(a.adjustment_date,1,7) FROM vat_adjustments a WHERE a.adjustment_date<?
    )`).get(start,start,start)?.period_key||null;
  if(latestPriorActivity&&(!prior.periodKey||latestPriorActivity>prior.periodKey))issues.push({severity:'error',code:'UNCLOSED_PRIOR_ACTIVITY',message:`${latestPriorActivity} dövründə bağlanmamış ƏDV fəaliyyəti var. Cari dövrü bağlamazdan əvvəl əvvəlki aktiv ayları ardıcıllıqla bağlayın.`});
  for(const row of inputRows){
    if(row.treatment==='STANDARD'&&row.status!=='Əvəzləşib'&&row.invoice_date>=start)issues.push({severity:'warning',code:'INPUT_WAITING',invoice_id:row.invoice_id,message:`${row.invoice_no}: ${row.reason}`});
  }
  const period=vatPeriodRecord(key);
  return safePlain({period:{key,start,end,status:period.status||'OPEN',closed_by:period.closed_by||null,closed_at:period.closed_at||null},
    summary:{opening_input_vat:prior.amount,opening_source_period:prior.periodKey,input_vat_current:currentInput,input_adjustment:inputAdjustment,
      output_vat_current:currentOutput,output_adjustment:outputAdjustment,available_input_vat:availableInput,offset_used:offsetUsed,
      vat_payable:payable,carry_forward_input_vat:carry,input_invoice_count:inputRows.length,output_invoice_count:outputRows.length,
      waiting_count:inputRows.filter(row=>!['Əvəzləşib','Əvəzləşmir'].includes(row.status)).length,issue_count:issues.length},
    inputRows,outputRows,adjustments,issues});
}

function vatPeriodReport(periodKey,{preferSnapshot=true}={}) {
  const {periodKey:key}=vatPeriodRange(periodKey);
  const period=vatPeriodRecord(key);
  if(preferSnapshot&&period.status==='CLOSED'&&period.snapshot_json){
    try{
      const snapshot=JSON.parse(period.snapshot_json);
      snapshot.period={...snapshot.period,status:'CLOSED',closed_by:period.closed_by,closed_at:period.closed_at};
      snapshot.locked=true;
      return safePlain(snapshot);
    }catch(_){throw new Error(`${key} dövrünün bağlanış snapshot-u zədələnib. Dövrü yenidən açmadan məlumat dəyişdirilməməlidir.`);}
  }
  return vatBuildPeriodReport(key);
}

function updateVatBankTransactionStatus(transactionId) {
  const tx=db.prepare(`SELECT id,amount FROM bank_transactions WHERE id=?`).get(Number(transactionId));
  if(!tx)return;
  if(db.prepare(`SELECT 1 FROM bank_reconciliations WHERE transaction_id=?`).get(tx.id))return;
  const allocated=round2(db.prepare(`SELECT COALESCE(SUM(amount_azn),0) amount FROM vat_payment_allocations WHERE bank_transaction_id=?`).get(tx.id).amount||0);
  const status=allocated<=0.004?'Uyğunlaşdırılmayıb':allocated>=Number(tx.amount)-0.004?'ƏDV ilə bağlanıb':'ƏDV qismən bağlanıb';
  db.prepare(`UPDATE bank_transactions SET reconciliation_status=? WHERE id=?`).run(status,tx.id);
}

function vatAllocatePayment(payload={}) {
  const transactionId=Number(payload.transactionId||0),kind=String(payload.kind||'VAT_DEPOSIT').toUpperCase();
  if(!['VAT_DEPOSIT','CUSTOMS_VAT'].includes(kind))throw new Error('ƏDV ödənişinin növü düzgün deyil.');
  const tx=db.prepare(`SELECT bt.*,ba.account_name,ba.iban,ba.ledger_account_code FROM bank_transactions bt JOIN bank_accounts ba ON ba.id=bt.bank_account_id WHERE bt.id=?`).get(transactionId);
  if(!tx)throw new Error('Bank əməliyyatı tapılmadı.');
  if(tx.direction!=='Ödəniş')throw new Error('ƏDV depozitinə yalnız çıxan bank ödənişi bağlana bilər.');
  if(String(tx.currency)!=='AZN')throw new Error('ƏDV depozit ödənişi AZN valyutasında olmalıdır.');
  if(db.prepare(`SELECT 1 FROM bank_reconciliations WHERE transaction_id=?`).get(tx.id))throw new Error('Bank əməliyyatı artıq adi qaimə ödənişi kimi uyğunlaşdırılıb.');
  const bankLedger=assertAccountRole(tx.ledger_account_code,'BANK','ƏDV ödənişinin bank hesabı');
  assertAccountingDateOpen(tx.transaction_date);
  assertVatDateOpen(tx.transaction_date);
  const requested=Array.isArray(payload.allocations)&&payload.allocations.length?payload.allocations:[{invoiceId:payload.invoiceId,amount:payload.amount}];
  if(!requested.length||requested.length>100)throw new Error('ƏDV bölgüsündə 1–100 qaimə seçilməlidir.');
  const unique=new Set();
  const prepared=requested.map(item=>{
    const invoiceId=Number(item.invoiceId||0),amount=round2(item.amount);
    if(unique.has(invoiceId))throw new Error('Eyni qaimə ƏDV bölgüsündə bir dəfədən çox seçilə bilməz.');
    unique.add(invoiceId);
    const invoice=db.prepare(`SELECT i.*,COALESCE(s.treatment,'STANDARD') vat_treatment FROM invoices i LEFT JOIN vat_invoice_settings s ON s.invoice_id=i.id WHERE i.id=? AND i.company_id=1 AND i.direction='Gələn' AND i.deleted_at IS NULL`).get(invoiceId);
    if(!invoice)throw new Error('ƏDV bölgüsündə gələn qaimə tapılmadı.');
    if(invoice.posting_status!=='Uçota alınıb')throw new Error(`${invoice.invoice_no}: qaimə uçota alınmayıb.`);
    if(!Number.isFinite(Number(item.amount))||Number(item.amount)<=0)throw new Error(`${invoice.invoice_no}: ƏDV bölgüsü düzgün məbləğ olmalıdır.`);
    if(kind==='VAT_DEPOSIT'&&invoice.vat_treatment!=='STANDARD')throw new Error(`${invoice.invoice_no}: standart depozit ƏDV-si yalnız STANDARD rejimində bağlana bilər.`);
    if(kind==='CUSTOMS_VAT'&&invoice.vat_treatment!=='CUSTOMS')throw new Error(`${invoice.invoice_no}: əvvəlcə qaiməni Gömrük ƏDV-si rejiminə keçirin.`);
    const vatAmountAzn=round2(Number(invoice.vat_amount)*Number(invoice.exchange_rate||1));
    const already=round2(db.prepare(`SELECT COALESCE(SUM(amount_azn),0) amount FROM vat_payment_allocations WHERE invoice_id=? AND payment_kind=?`).get(invoiceId,kind).amount||0);
    if(amount>vatAmountAzn-already+0.005)throw new Error(`${invoice.invoice_no}: ƏDV bölgüsü qalan ƏDV məbləğindən çoxdur.`);
    if(db.prepare(`SELECT 1 FROM vat_payment_allocations WHERE invoice_id=? AND bank_transaction_id=? AND payment_kind=?`).get(invoiceId,tx.id,kind))throw new Error(`${invoice.invoice_no}: bu bank əməliyyatı artıq qaiməyə bağlanıb.`);
    const payableAccount=assertAccountRole(invoice.counterparty_account_code||defaultCounterpartyAccount('Gələn'),'PAYABLE',`${invoice.invoice_no} kreditor hesabı`);
    return {invoice,amount,payableAccount};
  });
  const alreadyOnTransaction=round2(db.prepare(`SELECT COALESCE(SUM(amount_azn),0) amount FROM vat_payment_allocations WHERE bank_transaction_id=?`).get(tx.id).amount||0);
  const requestedTotal=round2(prepared.reduce((sum,row)=>sum+row.amount,0));
  if(requestedTotal>Number(tx.amount)-alreadyOnTransaction+0.005)throw new Error('ƏDV bölgülərinin cəmi bank əməliyyatının istifadə olunmamış məbləğindən çoxdur.');
  const t=nowIso();db.exec('BEGIN IMMEDIATE');
  try{
    const insert=db.prepare(`INSERT INTO vat_payment_allocations(invoice_id,bank_transaction_id,payment_kind,payment_date,amount_azn,source,note,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)`);
    const ids=[],journalEntryIds=[],line=journalLineStatement();
    for(const row of prepared){
      const result=insert.run(row.invoice.id,tx.id,kind,tx.transaction_date,row.amount,String(payload.source||'manual'),String(payload.note||''),currentUserName(),t);
      const allocationId=Number(result.lastInsertRowid);ids.push(allocationId);
      const entry=db.prepare(`INSERT INTO journal_entries(company_id,source_type,source_id,entry_date,description,status,created_at) VALUES(1,'vat_payment',?,?,?,?,?)`)
        .run(allocationId,tx.transaction_date,`${kind==='CUSTOMS_VAT'?'Gömrük ƏDV-si':'ƏDV depozit ödənişi'} · ${row.invoice.invoice_no}`,'Təsdiqlənib',t);
      const journalEntryId=Number(entry.lastInsertRowid);journalEntryIds.push(journalEntryId);
      line.run(journalEntryId,row.payableAccount,row.amount,0,'counterparty',row.invoice.voen,null,row.invoice.counterparty_id,row.invoice.contract_id||null,null,null,null);
      line.run(journalEntryId,bankLedger,0,row.amount,'bank',String(tx.id),null,null,null,null,null,null);
      assertJournalBalanced(journalEntryId);
    }
    updateVatBankTransactionStatus(tx.id);
    audit('ƏDV ödənişi qaiməyə bağlandı və uçota alındı','ƏDV',tx.id,null,{payment_kind:kind,transaction_id:tx.id,allocations:prepared.map((row,index)=>({invoice_id:row.invoice.id,amount_azn:row.amount,allocation_id:ids[index],journal_entry_id:journalEntryIds[index]}))});
    db.exec('COMMIT');notifyMainDataRefresh({resource:'vat'});
    return safePlain({ok:true,allocationIds:ids,journalEntryIds,transactionId:tx.id,allocated:requestedTotal,remaining:round2(Number(tx.amount)-alreadyOnTransaction-requestedTotal)});
  }catch(error){try{db.exec('ROLLBACK')}catch(_){};throw error;}
}

function vatUnallocatePayment(allocationId) {
  const allocation=db.prepare(`SELECT v.*,i.invoice_no FROM vat_payment_allocations v JOIN invoices i ON i.id=v.invoice_id WHERE v.id=?`).get(Number(allocationId));
  if(!allocation)throw new Error('ƏDV ödəniş bağlantısı tapılmadı.');
  assertVatDateOpen(allocation.payment_date);
  db.exec('BEGIN IMMEDIATE');
  try{
    const reversalId=reverseActiveJournalForSource('vat_payment',allocation.id,'ƏDV ödəniş bağlantısının geri qaytarılması');
    db.prepare(`DELETE FROM vat_payment_allocations WHERE id=?`).run(allocation.id);
    updateVatBankTransactionStatus(allocation.bank_transaction_id);
    audit('ƏDV ödəniş bağlantısı storno edilərək silindi','ƏDV',allocation.id,allocation,{reversal_journal_entry_id:reversalId});
    db.exec('COMMIT');notifyMainDataRefresh({resource:'vat'});return true;
  }catch(error){try{db.exec('ROLLBACK')}catch(_){};throw error;}
}

function vatSetInvoiceTreatment(payload={}) {
  const invoice=assertVatInvoiceOpen(Number(payload.invoiceId||0));
  const treatment=String(payload.treatment||'STANDARD').toUpperCase();
  if(!['STANDARD','NON_DEDUCTIBLE','CUSTOMS','EXEMPT','ZERO'].includes(treatment))throw new Error('ƏDV rejimi düzgün deyil.');
  const existingLinks=db.prepare(`SELECT payment_kind,COUNT(*) count FROM vat_payment_allocations WHERE invoice_id=? GROUP BY payment_kind`).all(invoice.id);
  if(existingLinks.length&&existingLinks.some(row=>(treatment==='CUSTOMS')!==(row.payment_kind==='CUSTOMS_VAT')))throw new Error('ƏDV rejimini dəyişməzdən əvvəl uyğun olmayan depozit/gömrük ödəniş bağlantılarını silin.');
  const before=db.prepare(`SELECT * FROM vat_invoice_settings WHERE invoice_id=?`).get(invoice.id)||null,t=nowIso();
  db.exec('BEGIN IMMEDIATE');
  try{
    db.prepare(`INSERT INTO vat_invoice_settings(invoice_id,treatment,note,updated_by,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(invoice_id) DO UPDATE SET treatment=excluded.treatment,note=excluded.note,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
      .run(invoice.id,treatment,String(payload.note||''),currentUserName(),t);
    audit('Qaimənin ƏDV rejimi dəyişdirildi','ƏDV',invoice.id,before,{treatment,note:String(payload.note||'')});
    db.exec('COMMIT');notifyMainDataRefresh({resource:'vat'});
    return db.prepare(`SELECT * FROM vat_invoice_settings WHERE invoice_id=?`).get(invoice.id);
  }catch(error){try{db.exec('ROLLBACK')}catch(_){};throw error;}
}

function vatAddAdjustment(payload={}) {
  const date=String(payload.date||'').trim(),side=String(payload.side||'').toUpperCase(),amount=round2(payload.amount),reason=String(payload.reason||'').trim();
  if(!isValidIsoDate(date))throw new Error('ƏDV düzəlişinin tarixi düzgün deyil.');
  if(!['INPUT','OUTPUT'].includes(side))throw new Error('ƏDV düzəlişinin tərəfi düzgün deyil.');
  if(!Number.isFinite(Number(payload.amount))||Math.abs(Number(payload.amount))<=0.004)throw new Error('ƏDV düzəlişinin məbləği 0-dan fərqli olmalıdır.');
  if(!reason)throw new Error('ƏDV düzəlişinin səbəbi yazılmalıdır.');
  assertVatDateOpen(date);
  assertAccountingDateOpen(date);
  const contraAccountCode=assertActiveAccount(payload.contraAccountCode);
  const forbiddenContraRoles=new Set(['RECEIVABLE','PAYABLE','BANK','INPUT_VAT','OUTPUT_VAT','INVENTORY']);
  if(forbiddenContraRoles.has(accountRole(contraAccountCode)))throw new Error('ƏDV düzəlişinin qarşı hesabı kontragent, bank, anbar və ya ƏDV nəzarət hesabı ola bilməz. Analitikasız uyğun gəlir/xərc hesabı seçin.');
  const invoiceId=payload.invoiceId?Number(payload.invoiceId):null;
  if(invoiceId&&!db.prepare(`SELECT 1 FROM invoices WHERE id=? AND company_id=1`).get(invoiceId))throw new Error('Düzəliş qaiməsi tapılmadı.');
  db.exec('BEGIN IMMEDIATE');
  try{
    const createdAt=nowIso();
    const result=db.prepare(`INSERT INTO vat_adjustments(invoice_id,adjustment_date,vat_side,amount_azn,contra_account_code,reason,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)`).run(invoiceId,date,side,amount,contraAccountCode,reason,currentUserName(),createdAt);
    const id=Number(result.lastInsertRowid),absoluteAmount=Math.abs(amount);
    const vatAccount=assertActiveAccount(side==='INPUT'?defaultVatAccount('Gələn'):defaultVatAccount('Gedən'));
    const entry=db.prepare(`INSERT INTO journal_entries(company_id,source_type,source_id,entry_date,description,status,created_at) VALUES(1,'vat_adjustment',?,?,?,?,?)`).run(id,date,`ƏDV düzəlişi · ${reason}`,'Təsdiqlənib',createdAt);
    const journalEntryId=Number(entry.lastInsertRowid),line=journalLineStatement();
    const vatDebit=(side==='INPUT'&&amount>0)||(side==='OUTPUT'&&amount<0);
    if(vatDebit){line.run(journalEntryId,vatAccount,absoluteAmount,0,'vat-adjustment',String(id),null,null,null,null,null,null);line.run(journalEntryId,contraAccountCode,0,absoluteAmount,'vat-adjustment-contra',String(id),null,null,null,null,null,null);}
    else{line.run(journalEntryId,contraAccountCode,absoluteAmount,0,'vat-adjustment-contra',String(id),null,null,null,null,null,null);line.run(journalEntryId,vatAccount,0,absoluteAmount,'vat-adjustment',String(id),null,null,null,null,null,null);}
    assertJournalBalanced(journalEntryId);
    const row=db.prepare(`SELECT * FROM vat_adjustments WHERE id=?`).get(id);audit('ƏDV düzəlişi yaradıldı və uçota alındı','ƏDV',id,null,{...row,journal_entry_id:journalEntryId});db.exec('COMMIT');notifyMainDataRefresh({resource:'vat'});return {...row,journal_entry_id:journalEntryId};
  }catch(error){try{db.exec('ROLLBACK')}catch(_){};throw error;}
}

function vatDeleteAdjustment(adjustmentId) {
  const row=db.prepare(`SELECT * FROM vat_adjustments WHERE id=?`).get(Number(adjustmentId));if(!row)throw new Error('ƏDV düzəlişi tapılmadı.');
  assertVatDateOpen(row.adjustment_date);assertAccountingDateOpen(row.adjustment_date);db.exec('BEGIN IMMEDIATE');
  try{const reversalId=reverseActiveJournalForSource('vat_adjustment',row.id,'ƏDV düzəlişinin geri qaytarılması');db.prepare(`DELETE FROM vat_adjustments WHERE id=?`).run(row.id);audit('ƏDV düzəlişi storno edilərək silindi','ƏDV',row.id,row,{reversal_journal_entry_id:reversalId});db.exec('COMMIT');notifyMainDataRefresh({resource:'vat'});return true;}
  catch(error){try{db.exec('ROLLBACK')}catch(_){};throw error;}
}

function vatBankCandidates(invoiceId,search='') {
  const invoice=db.prepare(`SELECT id,invoice_no,voen,vat_amount,exchange_rate FROM invoices WHERE id=? AND direction='Gələn' AND deleted_at IS NULL`).get(Number(invoiceId));
  if(!invoice)throw new Error('Gələn qaimə tapılmadı.');
  const query=String(search||'').trim().toLowerCase(),params=[];
  let searchSql='';
  if(query){searchSql=` AND (lower(COALESCE(bt.counterparty_name,'')) LIKE ? OR lower(COALESCE(bt.description,'')) LIKE ? OR lower(COALESCE(bt.reference,'')) LIKE ? OR bt.counterparty_voen LIKE ?)`;params.push(...Array(3).fill(`%${query}%`),`%${query}%`);}
  const rows=db.prepare(`SELECT bt.id,bt.transaction_date,bt.amount,bt.currency,bt.counterparty_name,bt.counterparty_voen,bt.description,bt.reference,bt.reconciliation_status,
      ROUND(bt.amount-COALESCE((SELECT SUM(v.amount_azn) FROM vat_payment_allocations v WHERE v.bank_transaction_id=bt.id),0),2) available_amount
    FROM bank_transactions bt
    WHERE bt.direction='Ödəniş' AND bt.currency='AZN' AND NOT EXISTS(SELECT 1 FROM bank_reconciliations br WHERE br.transaction_id=bt.id)
      AND bt.amount-COALESCE((SELECT SUM(v.amount_azn) FROM vat_payment_allocations v WHERE v.bank_transaction_id=bt.id),0)>0.004${searchSql}
    ORDER BY CASE WHEN lower(COALESCE(bt.description,'')||' '||COALESCE(bt.reference,'')) LIKE ? THEN 0 WHEN bt.counterparty_voen=? THEN 1 ELSE 2 END,bt.transaction_date DESC,bt.id DESC LIMIT 200`)
    .all(...params,`%${String(invoice.invoice_no).toLowerCase()}%`,invoice.voen);
  return safePlain(rows);
}

function vatAutoMatchDeposits(periodKey) {
  const {start,end}=vatPeriodRange(periodKey);
  const transactions=db.prepare(`SELECT bt.*,ROUND(bt.amount-COALESCE((SELECT SUM(v.amount_azn) FROM vat_payment_allocations v WHERE v.bank_transaction_id=bt.id),0),2) available_amount
    FROM bank_transactions bt
    WHERE bt.transaction_date>=? AND bt.transaction_date<=?
      AND bt.direction='Ödəniş' AND bt.currency='AZN' AND NOT EXISTS(SELECT 1 FROM bank_reconciliations br WHERE br.transaction_id=bt.id)
      AND bt.amount-COALESCE((SELECT SUM(v.amount_azn) FROM vat_payment_allocations v WHERE v.bank_transaction_id=bt.id),0)>0.004
      AND (lower(COALESCE(bt.description,'')) LIKE '%ədv%' OR lower(COALESCE(bt.description,'')) LIKE '%edv%' OR lower(COALESCE(bt.description,'')) LIKE '%vat%' OR lower(COALESCE(bt.description,'')) LIKE '%depozit%' OR lower(COALESCE(bt.reference,'')) LIKE '%ədv%' OR lower(COALESCE(bt.reference,'')) LIKE '%edv%')
    ORDER BY bt.transaction_date,bt.id LIMIT 1000`).all(start,end);
  const invoices=db.prepare(`SELECT i.*,COALESCE(s.treatment,'STANDARD') vat_treatment,
      COALESCE((SELECT SUM(v.amount_azn) FROM vat_payment_allocations v WHERE v.invoice_id=i.id AND v.payment_kind='VAT_DEPOSIT'),0) deposit_paid
    FROM invoices i LEFT JOIN vat_invoice_settings s ON s.invoice_id=i.id
    WHERE i.direction='Gələn' AND i.deleted_at IS NULL AND i.vat_amount>0.004 AND COALESCE(s.treatment,'STANDARD')='STANDARD'`).all();
  let matched=0,review=0,failed=0;
  for(const tx of transactions){
    const haystack=normalizeAccountingText(`${tx.description||''} ${tx.reference||''} ${tx.counterparty_voen||''}`);
    const byNumber=invoices.filter(invoice=>haystack.includes(normalizeAccountingText(invoice.invoice_no))&&round2(Number(invoice.vat_amount)*Number(invoice.exchange_rate||1)-Number(invoice.deposit_paid||0))>0.004);
    const candidates=byNumber.length?byNumber:invoices.filter(invoice=>String(invoice.voen)===String(tx.counterparty_voen||'')&&round2(Number(invoice.vat_amount)*Number(invoice.exchange_rate||1)-Number(invoice.deposit_paid||0))>0.004);
    if(candidates.length!==1){review++;continue;}
    const invoice=candidates[0],remaining=round2(Number(invoice.vat_amount)*Number(invoice.exchange_rate||1)-Number(invoice.deposit_paid||0));
    const amount=round2(Math.min(Number(tx.available_amount),remaining));
    if(amount<=0.004){review++;continue;}
    try{vatAllocatePayment({transactionId:tx.id,kind:'VAT_DEPOSIT',invoiceId:invoice.id,amount,source:'automatic',note:'Qaimə nömrəsi/VÖEN üzrə təhlükəsiz avtomatik uyğunlaşdırma'});invoice.deposit_paid=round2(Number(invoice.deposit_paid||0)+amount);matched++;}
    catch(_){failed++;}
  }
  return {matched,review,failed,candidates:transactions.length};
}

function vatRefreshPeriod(periodKey) {
  const report=vatPeriodReport(periodKey,{preferSnapshot:true});
  if(report.locked)return {...report,autoMatch:{matched:0,review:0,failed:0,candidates:0,skippedClosed:true}};
  const autoMatch=vatAutoMatchDeposits(periodKey);
  return {...vatPeriodReport(periodKey,{preferSnapshot:false}),autoMatch};
}

function vatClosePeriod(payload={}) {
  const {periodKey:key}=vatPeriodRange(payload.periodKey);
  const existing=vatPeriodRecord(key);
  if(existing.status==='CLOSED')return vatPeriodReport(key,{preferSnapshot:true});
  const report=vatBuildPeriodReport(key);
  const hardErrors=report.issues.filter(issue=>issue.severity==='error');
  if(hardErrors.length)throw new Error(`ƏDV dövrü bağlanmadı: ${hardErrors[0].message}`);
  const integrity=vatIntegrityReport();
  if(!integrity.healthy)throw new Error(`ƏDV dövrü bağlanmadı: registr bütövlük yoxlamasında ${integrity.problems} problem tapıldı.`);
  assertAccountingDateOpen(report.period.end);
  const t=nowIso();
  report.period={...report.period,status:'CLOSED',closed_by:currentUserName(),closed_at:t};report.locked=true;
  db.exec('BEGIN IMMEDIATE');
  try{
    const sourceId=Number(key.replace('-',''));
    if(Number(report.summary.offset_used)>0.004){
      const entry=db.prepare(`INSERT INTO journal_entries(company_id,source_type,source_id,entry_date,description,status,created_at) VALUES(1,'vat_period_close',?,?,?,?,?)`).run(sourceId,report.period.end,`${key} ƏDV əvəzləşməsi`,'Təsdiqlənib',t);
      const journalEntryId=Number(entry.lastInsertRowid),line=journalLineStatement(),offset=Number(report.summary.offset_used);
      line.run(journalEntryId,assertActiveAccount(defaultVatAccount('Gedən')),offset,0,'vat-period',key,null,null,null,null,null,null);
      line.run(journalEntryId,assertActiveAccount(defaultVatAccount('Gələn')),0,offset,'vat-period',key,null,null,null,null,null,null);
      assertJournalBalanced(journalEntryId);report.period.closing_journal_entry_id=journalEntryId;
    }else report.period.closing_journal_entry_id=null;
    db.prepare(`INSERT INTO vat_periods(period_key,status,snapshot_json,closed_by,closed_at,updated_at) VALUES(?,'CLOSED',?,?,?,?)
      ON CONFLICT(period_key) DO UPDATE SET status='CLOSED',snapshot_json=excluded.snapshot_json,closed_by=excluded.closed_by,closed_at=excluded.closed_at,reopened_by=NULL,reopened_at=NULL,reopen_reason=NULL,updated_at=excluded.updated_at`)
      .run(key,JSON.stringify(report),currentUserName(),t,t);
    audit('Aylıq ƏDV dövrü bağlandı','ƏDV dövrü',null,null,{period_key:key,summary:report.summary});db.exec('COMMIT');
    notifyMainDataRefresh({resource:'vat'});return safePlain(report);
  }catch(error){try{db.exec('ROLLBACK')}catch(_){};throw error;}
}

function vatReopenPeriod(payload={}) {
  const {periodKey:key}=vatPeriodRange(payload.periodKey),reason=String(payload.reason||'').trim();
  if(!reason)throw new Error('ƏDV dövrünün yenidən açılma səbəbi yazılmalıdır.');
  const period=db.prepare(`SELECT * FROM vat_periods WHERE period_key=? AND status='CLOSED'`).get(key);if(!period)throw new Error('Bağlı ƏDV dövrü tapılmadı.');
  const later=db.prepare(`SELECT period_key FROM vat_periods WHERE status='CLOSED' AND period_key>? ORDER BY period_key DESC LIMIT 1`).get(key);
  if(later)throw new Error(`Əvvəlcə daha sonrakı ${later.period_key} ƏDV dövrünü yenidən açın.`);
  const range=vatPeriodRange(key);assertAccountingDateOpen(range.end);
  const t=nowIso();db.exec('BEGIN IMMEDIATE');
  try{
    const reversalId=reverseActiveJournalForSource('vat_period_close',Number(key.replace('-','')),'ƏDV dövrünün yenidən açılması');
    db.prepare(`UPDATE vat_periods SET status='OPEN',snapshot_json=NULL,reopened_by=?,reopened_at=?,reopen_reason=?,updated_at=? WHERE period_key=?`).run(currentUserName(),t,reason,t,key);
    audit('Aylıq ƏDV dövrü yenidən açıldı','ƏDV dövrü',null,period,{period_key:key,reason,reversal_journal_entry_id:reversalId});db.exec('COMMIT');
    notifyMainDataRefresh({resource:'vat'});return vatPeriodReport(key,{preferSnapshot:false});
  }catch(error){try{db.exec('ROLLBACK')}catch(_){};throw error;}
}

function vatIntegrityReport() {
  const overallocatedBank=db.prepare(`SELECT COUNT(*) count FROM (SELECT bt.id FROM bank_transactions bt JOIN vat_payment_allocations v ON v.bank_transaction_id=bt.id GROUP BY bt.id HAVING SUM(v.amount_azn)>bt.amount+0.005)`).get().count;
  const overallocatedInvoice=db.prepare(`SELECT COUNT(*) count FROM (SELECT i.id FROM invoices i JOIN vat_payment_allocations v ON v.invoice_id=i.id GROUP BY i.id,v.payment_kind HAVING SUM(v.amount_azn)>i.vat_amount*COALESCE(NULLIF(i.exchange_rate,0),1)+0.005)`).get().count;
  const invalidLinks=db.prepare(`SELECT COUNT(*) count FROM vat_payment_allocations v JOIN invoices i ON i.id=v.invoice_id JOIN bank_transactions bt ON bt.id=v.bank_transaction_id WHERE i.direction<>'Gələn' OR i.deleted_at IS NOT NULL OR bt.direction<>'Ödəniş' OR bt.currency<>'AZN' OR v.payment_date<>bt.transaction_date`).get().count;
  const damagedSnapshots=db.prepare(`SELECT period_key,snapshot_json FROM vat_periods WHERE status='CLOSED'`).all().filter(row=>{try{return !JSON.parse(row.snapshot_json||'null')}catch(_){return true}}).length;
  const missingJournals=db.prepare(`SELECT COUNT(*) count FROM vat_payment_allocations v WHERE NOT EXISTS(SELECT 1 FROM journal_entries j WHERE j.source_type='vat_payment' AND j.source_id=v.id AND j.status='Təsdiqlənib')`).get().count;
  const missingAdjustmentJournals=db.prepare(`SELECT COUNT(*) count FROM vat_adjustments a WHERE NOT EXISTS(SELECT 1 FROM journal_entries j WHERE j.source_type='vat_adjustment' AND j.source_id=a.id AND j.status='Təsdiqlənib')`).get().count;
  const missingPeriodCloseJournals=db.prepare(`SELECT period_key,snapshot_json FROM vat_periods WHERE status='CLOSED'`).all().filter(row=>{try{const report=JSON.parse(row.snapshot_json||'null');return Number(report?.summary?.offset_used||0)>0.004&&!db.prepare(`SELECT 1 FROM journal_entries WHERE source_type='vat_period_close' AND source_id=? AND status='Təsdiqlənib'`).get(Number(row.period_key.replace('-','')))}catch(_){return false}}).length;
  const mixedBankUsage=db.prepare(`SELECT COUNT(*) count FROM bank_reconciliations b WHERE EXISTS(SELECT 1 FROM vat_payment_allocations v WHERE v.bank_transaction_id=b.transaction_id)`).get().count;
  const unbalancedVatJournals=db.prepare(`SELECT COUNT(*) count FROM (
    SELECT j.id FROM journal_entries j JOIN journal_lines l ON l.journal_entry_id=j.id
    WHERE j.status='Təsdiqlənib' AND j.source_type IN ('vat_payment','vat_adjustment','vat_period_close')
    GROUP BY j.id HAVING ABS(SUM(l.debit)-SUM(l.credit))>0.005
  )`).get().count;
  const total=Number(overallocatedBank)+Number(overallocatedInvoice)+Number(invalidLinks)+Number(damagedSnapshots)+Number(missingJournals)+Number(missingAdjustmentJournals)+Number(missingPeriodCloseJournals)+Number(mixedBankUsage)+Number(unbalancedVatJournals);
  return {healthy:total===0,overallocatedBank:Number(overallocatedBank),overallocatedInvoice:Number(overallocatedInvoice),invalidLinks:Number(invalidLinks),damagedSnapshots:Number(damagedSnapshots),missingJournals:Number(missingJournals),missingAdjustmentJournals:Number(missingAdjustmentJournals),missingPeriodCloseJournals:Number(missingPeriodCloseJournals),mixedBankUsage:Number(mixedBankUsage),unbalancedVatJournals:Number(unbalancedVatJournals),problems:total};
}

function accountingStatus() {
  const s=db.prepare(`SELECT accounting_enabled,auto_post_invoices,default_warehouse_id,opening_date,activated_at,activated_by,suspense_account_code,functional_currency,closed_through_date FROM company_settings WHERE id=1`).get() || {accounting_enabled:1,auto_post_invoices:1,suspense_account_code:'721.99',functional_currency:'AZN'};
  return {...s,accounting_enabled:Number(s.accounting_enabled||0)===1,auto_post_invoices:Number(s.auto_post_invoices||0)===1};
}

function setAccountingPeriodClose(payload={}) {
  const through=String(payload.through||'').trim();
  if(through && !isValidIsoDate(through))throw new Error('Bağlanış tarixi düzgün deyil.');
  const before=accountingStatus();db.prepare(`UPDATE company_settings SET closed_through_date=?,updated_at=? WHERE id=1`).run(through||null,nowIso());
  audit(through?'Uçot dövrü bağlandı':'Uçot dövrü yenidən açıldı','Uçot dövrü',null,before,{closed_through_date:through||null});return accountingStatus();
}

function referenceSnapshot() {
  return safePlain({
    accounts:db.prepare(`SELECT a.*,COUNT(DISTINCT s.id) subkonto_count FROM accounts a LEFT JOIN account_subcontos s ON s.account_code=a.code AND s.active=1 WHERE a.active=1 GROUP BY a.id ORDER BY a.code`).all(),
    subcontos:db.prepare(`SELECT s.*,a.name account_name FROM account_subcontos s JOIN accounts a ON a.code=s.account_code WHERE s.active=1 ORDER BY s.account_code,s.name`).all(),
    counterparties:db.prepare(`SELECT c.*,COUNT(DISTINCT cc.id) contract_count FROM counterparties c LEFT JOIN counterparty_contracts cc ON cc.counterparty_id=c.id AND cc.active=1 WHERE c.status='Aktiv' GROUP BY c.id ORDER BY c.name`).all(),
    contracts:db.prepare(`SELECT cc.*,c.name counterparty_name,c.voen FROM counterparty_contracts cc JOIN counterparties c ON c.id=cc.counterparty_id WHERE cc.active=1 ORDER BY c.name,cc.contract_no`).all(),
    warehouses:db.prepare(`SELECT w.*,COUNT(DISTINCT sm.catalog_item_id) item_count FROM warehouses w LEFT JOIN stock_movements sm ON sm.warehouse_id=w.id WHERE w.company_id=1 AND w.active=1 GROUP BY w.id ORDER BY w.is_default DESC,w.name`).all(),
    catalog:db.prepare(`SELECT c.*,a.name purchase_account_name FROM item_catalog c LEFT JOIN accounts a ON a.code=c.purchase_account_code WHERE c.company_id=1 AND c.active=1 ORDER BY c.item_type,c.name`).all(),
    rules:db.prepare(`SELECT r.*,a.name account_name,s.code subkonto_code,s.name subkonto_name,w.name warehouse_name FROM posting_rules r JOIN accounts a ON a.code=r.account_code LEFT JOIN account_subcontos s ON s.id=r.subkonto_id LEFT JOIN warehouses w ON w.id=r.warehouse_id WHERE r.company_id=1 AND r.active=1 ORDER BY r.priority,r.id`).all()
  });
}

function saveReferenceAccount(payload={}) {
  const code=String(payload.code||'').trim(),name=String(payload.name||'').trim(),kind=String(payload.kind||'').trim();
  if(!/^\d{3}(\.\d{2})?$/.test(code)) throw new Error('Hesab kodu 211 və ya 211.01 formatında olmalıdır.');
  if(!name || !['asset','liability','equity','income','expense'].includes(kind)) throw new Error('Hesab adı və növü düzgün daxil edilməlidir.');
  const t=nowIso(),existing=db.prepare(`SELECT * FROM accounts WHERE code=?`).get(code);
  const isPostable=payload.is_postable==null?(code.includes('.')?1:0):(payload.is_postable?1:0);
  const requestedRole=payload.role===undefined?existing?.role:payload.role;
  const role=isPostable?(String(requestedRole||'').trim().toUpperCase()||null):null;
  const roleKinds={RECEIVABLE:'asset',BANK:'asset',INVENTORY:'asset',INPUT_VAT:'asset',PAYABLE:'liability',OUTPUT_VAT:'liability',SALES_GOODS:'income',SALES_SERVICE:'income',FX_GAIN:'income',COGS:'expense',EXPENSE:'expense',SUSPENSE_EXPENSE:'expense',FX_LOSS:'expense'};
  if(role&&roleKinds[role]&&roleKinds[role]!==kind)throw new Error(`${role} rolu yalnız ${roleKinds[role]} növlü hesabda istifadə edilə bilər.`);
  if(existing&&String(existing.role||'')!==String(role||'')){
    const dependencies=Number(db.prepare(`SELECT
      (SELECT COUNT(*) FROM counterparties WHERE status='Aktiv' AND (receivable_account_code=? OR payable_account_code=?))+
      (SELECT COUNT(*) FROM invoices WHERE deleted_at IS NULL AND (counterparty_account_code=? OR vat_posting_account_code=?))+
      (SELECT COUNT(*) FROM warehouses WHERE active=1 AND (inventory_account_code=? OR cogs_account_code=?))+
      (SELECT COUNT(*) FROM bank_accounts WHERE active=1 AND ledger_account_code=?)+
      (SELECT COUNT(*) FROM item_catalog WHERE active=1 AND (purchase_account_code=? OR sales_account_code=? OR inventory_account_code=?))+
      (SELECT COUNT(*) FROM posting_rules WHERE active=1 AND account_code=?)+
      (SELECT COUNT(*) FROM posting_profiles WHERE active=1 AND (base_debit_code=? OR base_credit_code=? OR vat_debit_code=? OR vat_credit_code=?)) AS count`)
      .get(code,code,code,code,code,code,code,code,code,code,code,code,code,code,code)?.count||0);
    if(dependencies)throw new Error(`${code} hesabının semantik rolu aktiv məlumat kartlarında istifadə olunur. Əvvəlcə bağlı kontragent, anbar, bank, mal/xidmət və uçot qaydalarını başqa hesaba keçirin.`);
  }
  if(existing&&Number(existing.is_postable??1)===1&&!isPostable){
    const used=Number(db.prepare(`SELECT
      (SELECT COUNT(*) FROM journal_lines WHERE account_code=?)+
      (SELECT COUNT(*) FROM invoice_items WHERE posting_account_code=?)+
      (SELECT COUNT(*) FROM opening_balances WHERE account_code=?)+
      (SELECT COUNT(*) FROM posting_rules WHERE account_code=?)+
      (SELECT COUNT(*) FROM bank_accounts WHERE ledger_account_code=?)+
      (SELECT COUNT(*) FROM warehouses WHERE inventory_account_code=? OR cogs_account_code=?) AS count`).get(code,code,code,code,code,code,code)?.count||0);
    if(used)throw new Error(`${code} hesabında bağlı yazılış və ya məlumat kartı var; onu qrup hesabına çevirmək olmaz.`);
  }
  const parentCode=code.includes('.')?String(payload.parent_code||code.split('.')[0]):null;
  if(isPostable && parentCode){
    const parent=db.prepare(`SELECT * FROM accounts WHERE code=?`).get(parentCode);
    if(parent && Number(parent.is_postable??1)!==0) throw new Error(`Baş hesab qrup hesabı deyil: ${parentCode}.`);
    if(!parent) db.prepare(`INSERT INTO accounts(code,name,kind,parent_code,role,is_postable,active) VALUES(?,?,?,NULL,NULL,0,1)`).run(parentCode,`${parentCode} hesab qrupu`,kind);
    else if(!parent.active) db.prepare(`UPDATE accounts SET active=1 WHERE code=?`).run(parentCode);
  }
  if(existing) db.prepare(`UPDATE accounts SET name=?,kind=?,parent_code=?,role=?,is_postable=?,active=1 WHERE code=?`).run(name,kind,parentCode,role,isPostable,code);
  else db.prepare(`INSERT INTO accounts(code,name,kind,parent_code,role,is_postable,active) VALUES(?,?,?,?,?,?,1)`).run(code,name,kind,parentCode,role,isPostable);
  audit(existing?'Hesab dəyişdirildi':'Hesab yaradıldı','Məlumat kitabçası',null,existing,{code,name,kind,role,is_postable:isPostable,updated_at:t});
  return db.prepare(`SELECT * FROM accounts WHERE code=?`).get(code);
}

function saveSubkonto(payload={}) {
  const accountCode=assertActiveAccount(payload.account_code),code=String(payload.code||'').trim().toUpperCase(),name=String(payload.name||'').trim();
  if(!code || !name) throw new Error('Subkonto kodu və adı daxil edilməlidir.');
  const t=nowIso();
  const duplicate=db.prepare(`SELECT id FROM account_subcontos WHERE account_code=? AND code=? AND id<>?`).get(accountCode,code,Number(payload.id||0));
  if(duplicate)throw new Error(`${accountCode} hesabında ${code} kodlu subkonto artıq mövcuddur.`);
  if(payload.id){
    const before=db.prepare(`SELECT * FROM account_subcontos WHERE id=?`).get(Number(payload.id));if(!before)throw new Error('Subkonto tapılmadı.');
    if(before.account_code!==accountCode){
      const used=Number(db.prepare(`SELECT
        (SELECT COUNT(*) FROM journal_lines WHERE subkonto_id=?)+
        (SELECT COUNT(*) FROM invoice_items WHERE subkonto_id=?)+
        (SELECT COUNT(*) FROM opening_balances WHERE subkonto_id=?)+
        (SELECT COUNT(*) FROM posting_rules WHERE subkonto_id=?) AS count`).get(Number(payload.id),Number(payload.id),Number(payload.id),Number(payload.id))?.count||0);
      if(used)throw new Error('İstifadə olunmuş subkontonun hesabını dəyişmək audit tarixçəsini pozar. Yeni hesabda yeni subkonto yaradın və lazım olan qaimələri redaktə edərək storno/yeni yazılışla yenidən təsnif edin.');
    }
    db.prepare(`UPDATE account_subcontos SET account_code=?,code=?,name=?,dimension=?,active=1,updated_at=? WHERE id=?`).run(accountCode,code,name,String(payload.dimension||'Analitika'),t,Number(payload.id));
    audit('Subkonto məlumatı dəyişdirildi','Məlumat kitabçası',Number(payload.id),before,payload);
    return db.prepare(`SELECT * FROM account_subcontos WHERE id=?`).get(Number(payload.id));
  }
  const created=db.prepare(`INSERT INTO account_subcontos(account_code,code,name,dimension,active,created_at,updated_at) VALUES(?,?,?,?,1,?,?)`).run(accountCode,code,name,String(payload.dimension||'Analitika'),t,t);
  audit('Subkonto yaradıldı','Məlumat kitabçası',Number(created.lastInsertRowid),null,payload);return db.prepare(`SELECT * FROM account_subcontos WHERE id=?`).get(Number(created.lastInsertRowid));
}

function saveCounterparty(payload={}) {
  const name=sanitizeCounterpartyName(payload.name),voen=String(payload.voen||'').replace(/\D/g,''),isCustomer=payload.is_customer?1:0,isSupplier=payload.is_supplier?1:0;
  if(!name || !/^\d{10}$/.test(voen)) throw new Error('Kontragent adı və 10 rəqəmli VÖEN tələb olunur.');
  if(!isCustomer && !isSupplier) throw new Error('Kontragent ən azı Debitor və ya Kreditor kimi seçilməlidir.');
  const receivableAccount=assertAccountRole(payload.receivable_account_code||accountByRole('RECEIVABLE','211.01'),'RECEIVABLE','Debitor hesabı'),payableAccount=assertAccountRole(payload.payable_account_code||accountByRole('PAYABLE','531.01'),'PAYABLE','Kreditor hesabı');
  const type=isCustomer&&isSupplier?'Debitor/Kreditor':isCustomer?'Debitor':'Kreditor',t=nowIso();
  if(payload.id){
    const before=db.prepare(`SELECT * FROM counterparties WHERE id=?`).get(Number(payload.id));if(!before)throw new Error('Kontragent tapılmadı.');
    if(db.prepare(`SELECT 1 FROM counterparties WHERE voen=? AND id<>?`).get(voen,Number(payload.id)))throw new Error(`Bu VÖEN üzrə kontragent artıq mövcuddur: ${voen}.`);
    const invoices=db.prepare(`SELECT id,direction FROM invoices WHERE counterparty_id=? AND deleted_at IS NULL AND posting_status='Uçota alınıb'`).all(Number(payload.id));db.exec('BEGIN IMMEDIATE');
    try{
      if(!isCustomer&&invoices.some(invoice=>invoice.direction==='Gedən'))throw new Error('Bu kontragentin aktiv gedən qaimələri var; Debitor rolu silinə bilməz.');
      if(!isSupplier&&invoices.some(invoice=>invoice.direction==='Gələn'))throw new Error('Bu kontragentin aktiv gələn qaimələri var; Kreditor rolu silinə bilməz.');
      db.prepare(`UPDATE counterparties SET name=?,voen=?,type=?,is_customer=?,is_supplier=?,receivable_account_code=?,payable_account_code=?,phone=?,email=?,address=?,updated_at=? WHERE id=?`).run(name,voen,type,isCustomer,isSupplier,receivableAccount,payableAccount,String(payload.phone||''),String(payload.email||''),String(payload.address||''),t,Number(payload.id));
      const accountingChanged=before.voen!==voen||before.receivable_account_code!==receivableAccount||before.payable_account_code!==payableAccount;
      const scopes=[];for(const invoice of invoices){const account=invoice.direction==='Gedən'?receivableAccount:payableAccount;db.prepare(`UPDATE invoices SET counterparty_account_code=?,counterparty_name=?,voen=?,document_key=upper(trim(invoice_no))||'|'||?||'|'||direction,updated_at=? WHERE id=?`).run(account,name,voen,voen,t,invoice.id);if(accountingChanged){const posting=createInvoicePosting(invoice.id,{replaceExisting:true});scopes.push(...posting.scopes)}}if(accountingChanged)rebuildInventoryScopes(scopes);
      audit('Kontragent və bağlı uçot dəyişdirildi','Kontragent',Number(payload.id),before,payload);db.exec('COMMIT');return db.prepare(`SELECT * FROM counterparties WHERE id=?`).get(Number(payload.id));
    }catch(error){try{db.exec('ROLLBACK')}catch(_){};throw error;}
  }
  if(db.prepare(`SELECT 1 FROM counterparties WHERE voen=?`).get(voen))throw new Error(`Bu VÖEN üzrə kontragent artıq mövcuddur: ${voen}.`);
  const created=db.prepare(`INSERT INTO counterparties(name,voen,type,account_code,receivable_account_code,payable_account_code,is_customer,is_supplier,status,phone,email,address,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?, 'Aktiv',?,?,?,?,?)`).run(name,voen,type,isSupplier?payableAccount:receivableAccount,receivableAccount,payableAccount,isCustomer,isSupplier,String(payload.phone||''),String(payload.email||''),String(payload.address||''),t,t);
  audit('Kontragent yaradıldı','Kontragent',Number(created.lastInsertRowid),null,payload);return db.prepare(`SELECT * FROM counterparties WHERE id=?`).get(Number(created.lastInsertRowid));
}

function saveContract(payload={}) {
  const counterpartyId=Number(payload.counterparty_id),number=String(payload.contract_no||'').trim();
  if(!db.prepare(`SELECT 1 FROM counterparties WHERE id=? AND status='Aktiv'`).get(counterpartyId)||!number) throw new Error('Kontragent və müqavilə nömrəsi seçilməlidir.');
  const currency=String(payload.currency||'AZN').toUpperCase();if(!['AZN','USD','EUR'].includes(currency))throw new Error('Müqavilə valyutası düzgün deyil.');
  const contractDate=String(payload.contract_date||'').trim(),endDate=String(payload.end_date||'').trim();
  if(contractDate&&!isValidIsoDate(contractDate))throw new Error('Müqavilə tarixi düzgün deyil.');
  if(endDate&&!isValidIsoDate(endDate))throw new Error('Müqavilənin son tarixi düzgün deyil.');
  if(contractDate&&endDate&&endDate<contractDate)throw new Error('Müqavilənin son tarixi başlanğıc tarixindən əvvəl ola bilməz.');
  const duplicate=db.prepare(`SELECT id FROM counterparty_contracts WHERE counterparty_id=? AND contract_no=? AND id<>?`).get(counterpartyId,number,Number(payload.id||0));
  if(duplicate)throw new Error(`Bu kontragent üçün ${number} nömrəli müqavilə artıq mövcuddur.`);
  const t=nowIso();
  if(payload.id){const id=Number(payload.id),before=db.prepare(`SELECT * FROM counterparty_contracts WHERE id=?`).get(id);if(!before)throw new Error('Müqavilə tapılmadı.');db.prepare(`UPDATE counterparty_contracts SET counterparty_id=?,contract_no=?,contract_date=?,end_date=?,currency=?,note=?,active=1,updated_at=? WHERE id=?`).run(counterpartyId,number,contractDate||null,endDate||null,currency,String(payload.note||''),t,id);audit('Müqavilə dəyişdirildi','Müqavilə',id,before,payload);return db.prepare(`SELECT * FROM counterparty_contracts WHERE id=?`).get(id);}
  const created=db.prepare(`INSERT INTO counterparty_contracts(counterparty_id,contract_no,contract_date,end_date,currency,note,active,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)`).run(counterpartyId,number,contractDate||null,endDate||null,currency,String(payload.note||''),t,t);audit('Müqavilə yaradıldı','Müqavilə',Number(created.lastInsertRowid),null,payload);return db.prepare(`SELECT * FROM counterparty_contracts WHERE id=?`).get(Number(created.lastInsertRowid));
}

function saveWarehouse(payload={}) {
  const code=String(payload.code||'').trim().toUpperCase(),name=String(payload.name||'').trim(),method=payload.valuation_method==='FIFO'?'FIFO':'AVERAGE';
  if(!code||!name)throw new Error('Anbar kodu və adı daxil edilməlidir.');
  const inventoryAccount=assertAccountRole(payload.inventory_account_code||inventoryAccountForWarehouse(),'INVENTORY','Anbar ehtiyat hesabı'),cogsAccount=assertAccountRole(payload.cogs_account_code||accountByRole('COGS','701.01'),'COGS','Satışın maya dəyəri hesabı'),t=nowIso();
  db.exec('BEGIN IMMEDIATE');
  try{
    if(payload.is_default)db.prepare(`UPDATE warehouses SET is_default=0 WHERE company_id=1`).run();
    let id=Number(payload.id||0);
    const before=id?db.prepare(`SELECT * FROM warehouses WHERE id=?`).get(id):null;
    if(id&&!before)throw new Error('Anbar tapılmadı.');
    const duplicate=db.prepare(`SELECT id FROM warehouses WHERE company_id=1 AND code=? AND id<>?`).get(code,id||0);
    if(duplicate)throw new Error(`Bu anbar kodu artıq mövcuddur: ${code}.`);
    const allowNegative=payload.allow_negative_stock==null?Number(before?.allow_negative_stock||0):(payload.allow_negative_stock?1:0);
    if(id){db.prepare(`UPDATE warehouses SET code=?,name=?,valuation_method=?,inventory_account_code=?,cogs_account_code=?,allow_negative_stock=?,is_default=?,active=1,updated_at=? WHERE id=?`).run(code,name,method,inventoryAccount,cogsAccount,allowNegative,payload.is_default?1:0,t,id);}
    else{id=Number(db.prepare(`INSERT INTO warehouses(company_id,code,name,valuation_method,inventory_account_code,cogs_account_code,allow_negative_stock,is_default,active,created_at,updated_at) VALUES(1,?,?,?,?,?,?,?,1,?,?)`).run(code,name,method,inventoryAccount,cogsAccount,payload.allow_negative_stock?1:0,payload.is_default?1:0,t,t).lastInsertRowid);}
    let selectedDefault=db.prepare(`SELECT id FROM warehouses WHERE company_id=1 AND active=1 AND is_default=1 ORDER BY id LIMIT 1`).get();
    if(!selectedDefault){db.prepare(`UPDATE warehouses SET is_default=1 WHERE id=?`).run(id);selectedDefault={id};}
    db.prepare(`UPDATE company_settings SET default_warehouse_id=? WHERE id=1`).run(Number(selectedDefault.id));
    const linked=db.prepare(`SELECT DISTINCT ii.invoice_id id,ii.catalog_item_id FROM invoice_items ii JOIN invoices i ON i.id=ii.invoice_id WHERE ii.warehouse_id=? AND ii.item_type='Mal' AND i.deleted_at IS NULL`).all(id);
    const accountMappingChanged=!!before&&(before.inventory_account_code!==inventoryAccount||before.cogs_account_code!==cogsAccount);
    const valuationChanged=!!before&&(before.valuation_method!==method||Number(before.allow_negative_stock)!==allowNegative);
    if(accountMappingChanged){
      db.prepare(`UPDATE invoice_items SET posting_account_code=? WHERE warehouse_id=? AND item_type='Mal' AND invoice_id IN (SELECT id FROM invoices WHERE direction='Gələn' AND deleted_at IS NULL)`).run(inventoryAccount,id);
      const scopes=[];for(const invoiceId of [...new Set(linked.map(row=>Number(row.id)))]){const posting=createInvoicePosting(invoiceId,{replaceExisting:true});scopes.push(...posting.scopes)}
      rebuildInventoryScopes(scopes);
    }else if(valuationChanged){
      rebuildInventoryScopes(linked.map(row=>({warehouse_id:id,catalog_item_id:Number(row.catalog_item_id)})));
    }
    audit(before?'Anbar məlumatı dəyişdirildi':'Anbar yaradıldı','Anbar',id,before,{code,name,method,inventory_account_code:inventoryAccount,cogs_account_code:cogsAccount,allow_negative_stock:allowNegative});db.exec('COMMIT');return db.prepare(`SELECT * FROM warehouses WHERE id=?`).get(id);
  }catch(error){try{db.exec('ROLLBACK')}catch(_){};throw error;}
}

function saveCatalogItem(payload={}) {
  const code=String(payload.code||'').trim().toUpperCase(),name=String(payload.name||'').trim(),itemType=payload.item_type==='Xidmət'?'Xidmət':'Mal';
  if(!code||!name)throw new Error('Mal/xidmət kodu və adı daxil edilməlidir.');
  const purchase=itemType==='Mal'
    ? assertAccountRole(payload.purchase_account_code||inventoryAccountForWarehouse(),'INVENTORY','Malın alış hesabı')
    : assertActiveAccount(payload.purchase_account_code||suspenseAccount());
  const sales=itemType==='Mal'
    ? assertAccountRole(payload.sales_account_code||accountByRole('SALES_GOODS','601.01'),'SALES_GOODS','Malın satış hesabı')
    : assertAccountRole(payload.sales_account_code||accountByRole('SALES_SERVICE','601.02'),'SALES_SERVICE','Xidmətin satış hesabı');
  const inventoryAccount=itemType==='Mal'?purchase:null,t=nowIso();
  if(payload.id){
    const id=Number(payload.id),before=db.prepare(`SELECT * FROM item_catalog WHERE id=? AND company_id=1`).get(id);if(!before)throw new Error('Mal/xidmət kartı tapılmadı.');
    const duplicate=db.prepare(`SELECT id FROM item_catalog WHERE company_id=1 AND code=? AND id<>?`).get(code,id);if(duplicate)throw new Error(`Bu mal/xidmət kodu artıq mövcuddur: ${code}.`);
    const linkedItems=db.prepare(`SELECT ii.id,ii.invoice_id,ii.warehouse_id,ii.subkonto_id,i.direction FROM invoice_items ii JOIN invoices i ON i.id=ii.invoice_id WHERE ii.catalog_item_id=? AND i.deleted_at IS NULL`).all(id);
    const invoiceIds=[...new Set(linkedItems.map(row=>Number(row.invoice_id)))];
    db.exec('BEGIN IMMEDIATE');
    try{
      db.prepare(`UPDATE item_catalog SET code=?,name=?,item_type=?,unit=?,purchase_account_code=?,sales_account_code=?,inventory_account_code=?,standard_cost=?,active=1,updated_at=? WHERE id=? AND company_id=1`).run(code,name,itemType,String(payload.unit||'ədəd'),purchase,sales,inventoryAccount,round2(payload.standard_cost),t,id);
      const accountingMappingChanged=before.item_type!==itemType||before.purchase_account_code!==purchase||before.sales_account_code!==sales;
      const standardCostChanged=round2(before.standard_cost)!==round2(payload.standard_cost);
      const previousInventoryScopes=linkedItems.filter(row=>before.item_type==='Mal'&&row.warehouse_id).map(row=>({warehouse_id:Number(row.warehouse_id),catalog_item_id:id}));
      const updateLinkedItem=db.prepare(`UPDATE invoice_items SET item_type=?,posting_account_code=?,subkonto_id=?,warehouse_id=? WHERE id=?`);
      if(accountingMappingChanged)for(const linked of linkedItems){
        const linkedWarehouse=itemType==='Mal'
          ? db.prepare(`SELECT id,inventory_account_code FROM warehouses WHERE id=? AND company_id=1 AND active=1`).get(Number(linked.warehouse_id||defaultWarehouse()?.id||0))
          : null;
        if(itemType==='Mal'&&!linkedWarehouse)throw new Error('Mal kartına keçid üçün aktiv anbar yoxdur.');
        const postingAccount=linked.direction==='Gələn'?(itemType==='Mal'?linkedWarehouse.inventory_account_code:purchase):sales;
        const validLinkedSubkonto=linked.subkonto_id&&db.prepare(`SELECT id FROM account_subcontos WHERE id=? AND account_code=? AND active=1`).get(Number(linked.subkonto_id),postingAccount);
        const serviceSubkonto=validLinkedSubkonto?.id||(
          linked.direction==='Gələn'&&postingAccount===accountByRole('EXPENSE','721.01')?defaultExpenseSubkontoId():
          linked.direction==='Gələn'&&postingAccount===suspenseAccount()?unclassifiedExpenseSubkontoId():null
        );
        updateLinkedItem.run(itemType,postingAccount,itemType==='Mal'?null:serviceSubkonto,linkedWarehouse?.id||null,linked.id);
      }
      const scopes=[];
      if(accountingMappingChanged)for(const invoiceId of invoiceIds){const posting=createInvoicePosting(invoiceId,{replaceExisting:true});scopes.push(...posting.scopes)}
      if(accountingMappingChanged||standardCostChanged)rebuildInventoryScopes([...previousInventoryScopes,...scopes]);
      audit('Mal/xidmət kartı və bağlı uçot dəyişdirildi','Mal/xidmət',id,before,payload);
      db.exec('COMMIT');
      return db.prepare(`SELECT * FROM item_catalog WHERE id=?`).get(id);
    }catch(error){try{db.exec('ROLLBACK')}catch(_){};throw error;}
  }
  if(db.prepare(`SELECT 1 FROM item_catalog WHERE company_id=1 AND code=?`).get(code))throw new Error(`Bu mal/xidmət kodu artıq mövcuddur: ${code}.`);
  const created=db.prepare(`INSERT INTO item_catalog(company_id,code,name,item_type,unit,purchase_account_code,sales_account_code,inventory_account_code,purchase_vat_account_code,sales_vat_account_code,standard_cost,active,created_at,updated_at) VALUES(1,?,?,?,?,?,?,?,?,?,?,1,?,?)`).run(code,name,itemType,String(payload.unit||'ədəd'),purchase,sales,inventoryAccount,defaultVatAccount('Gələn'),defaultVatAccount('Gedən'),round2(payload.standard_cost),t,t);audit('Mal/xidmət kartı yaradıldı','Mal/xidmət',Number(created.lastInsertRowid),null,{code,name,item_type:itemType});return db.prepare(`SELECT * FROM item_catalog WHERE id=?`).get(Number(created.lastInsertRowid));
}

function savePostingRule(payload={}) {
  const name=String(payload.name||'').trim(),direction=['Gələn','Gedən'].includes(payload.direction)?payload.direction:null,itemType=['Mal','Xidmət'].includes(payload.item_type)?payload.item_type:null;
  const field=['all','counterparty','description','item_code'].includes(payload.match_field)?payload.match_field:'all';
  if(!name)throw new Error('Uçot qaydasının adı daxil edilməlidir.');
  const accountCode=assertActiveAccount(payload.account_code),subkontoId=payload.subkonto_id?Number(payload.subkonto_id):null,warehouseId=payload.warehouse_id?Number(payload.warehouse_id):null,t=nowIso();
  if(subkontoId&&!db.prepare(`SELECT 1 FROM account_subcontos WHERE id=? AND account_code=? AND active=1`).get(subkontoId,accountCode))throw new Error('Subkonto seçilmiş hesaba aid deyil.');
  if(warehouseId&&!db.prepare(`SELECT 1 FROM warehouses WHERE id=? AND active=1`).get(warehouseId))throw new Error('Seçilmiş anbar tapılmadı.');
  if(payload.id){
    const id=Number(payload.id),before=db.prepare(`SELECT * FROM posting_rules WHERE id=? AND company_id=1`).get(id);
    if(!before)throw new Error('Dəyişdiriləcək uçot qaydası tapılmadı.');
    db.prepare(`UPDATE posting_rules SET name=?,priority=?,direction=?,item_type=?,match_field=?,match_value=?,account_code=?,subkonto_id=?,warehouse_id=?,active=1,updated_at=? WHERE id=? AND company_id=1`).run(name,Number(payload.priority||100),direction,itemType,field,String(payload.match_value||''),accountCode,subkontoId,warehouseId,t,id);
    audit('Uçot qaydası dəyişdirildi','Uçot qaydası',id,before,{name,direction,item_type:itemType,match_field:field,match_value:String(payload.match_value||''),account_code:accountCode,subkonto_id:subkontoId,warehouse_id:warehouseId});
    return db.prepare(`SELECT * FROM posting_rules WHERE id=?`).get(id);
  }
  const created=db.prepare(`INSERT INTO posting_rules(company_id,name,priority,direction,item_type,match_field,match_value,account_code,subkonto_id,warehouse_id,active,created_at,updated_at) VALUES(1,?,?,?,?,?,?,?,?,?,1,?,?)`).run(name,Number(payload.priority||100),direction,itemType,field,String(payload.match_value||''),accountCode,subkontoId,warehouseId,t,t);
  const id=Number(created.lastInsertRowid);
  audit('Uçot qaydası yaradıldı','Uçot qaydası',id,null,{name,direction,item_type:itemType,match_field:field,match_value:String(payload.match_value||''),account_code:accountCode,subkonto_id:subkontoId,warehouse_id:warehouseId});
  return db.prepare(`SELECT * FROM posting_rules WHERE id=?`).get(id);
}

function getAccountingSetup() {
  const settings=accountingStatus();
  const lines=db.prepare(`
    SELECT a.code,a.name,a.kind,ob.id ob_id,COALESCE(ob.debit,0) debit,COALESCE(ob.credit,0) credit,ob.note,
      ob.counterparty_id,cp.name counterparty_name,cp.voen counterparty_voen,
      ob.subkonto_id,sk.code subkonto_code,sk.name subkonto_name
    FROM accounts a
    LEFT JOIN opening_balances ob ON ob.account_code=a.code
    LEFT JOIN counterparties cp ON cp.id=ob.counterparty_id
    LEFT JOIN account_subcontos sk ON sk.id=ob.subkonto_id
    WHERE a.active=1 AND COALESCE(a.is_postable,1)=1 ORDER BY a.code,cp.name,sk.name
  `).all();
  const byAccount=new Map();
  for(const row of lines){
    if(!byAccount.has(row.code)) byAccount.set(row.code,{code:row.code,name:row.name,kind:row.kind,debit:0,credit:0,note:null,lines:[]});
    const acc=byAccount.get(row.code);
    if(row.ob_id!=null){
      acc.debit=round2(acc.debit+Number(row.debit));
      acc.credit=round2(acc.credit+Number(row.credit));
      if(!acc.note) acc.note=row.note;
      acc.lines.push({id:row.ob_id,debit:round2(row.debit),credit:round2(row.credit),note:row.note,
        counterparty_id:row.counterparty_id,counterparty_name:row.counterparty_name,counterparty_voen:row.counterparty_voen,
        subkonto_id:row.subkonto_id,subkonto_code:row.subkonto_code,subkonto_name:row.subkonto_name});
    }
  }
  return {settings,accounts:[...byAccount.values()]};
}

function saveAccountingSetup(payload={}) {
  const openingDate=String(payload.openingDate||'').trim();
  const balances=Array.isArray(payload.balances)?payload.balances:[];
  if(!isValidIsoDate(openingDate)) throw new Error('Açılış tarixi düzgün seçilməlidir.');
  assertAccountingDateOpen(openingDate);
  const earliest=db.prepare(`SELECT MIN(entry_date) date FROM journal_entries WHERE company_id=1 AND status='Təsdiqlənib'`).get()?.date;
  if(earliest&&openingDate>earliest)throw new Error(`Açılış tarixi mövcud uçot yazılışından (${earliest}) sonra ola bilməz.`);
  const merged=new Map(); let totalD=0,totalK=0;
  for(const x of balances){
    const code=String(x.code||'').trim();
    const rawDebit=x.debit==null||x.debit===''?0:Number(x.debit),rawCredit=x.credit==null||x.credit===''?0:Number(x.credit);
    if(!Number.isFinite(rawDebit)||!Number.isFinite(rawCredit))throw new Error(`${code||'Hesab'}: Debet və Kredit rəqəm olmalıdır.`);
    const d=round2(Math.max(0,rawDebit)),c=round2(Math.max(0,rawCredit));
    if(!code || d===0 && c===0) continue;
    const a=db.prepare(`SELECT code FROM accounts WHERE code=? AND active=1 AND COALESCE(is_postable,1)=1`).get(code); if(!a) throw new Error(`Yazılış aparılan aktiv hesab tapılmadı: ${code}`);
    if(d>0 && c>0) throw new Error(`${code}: Debet və Kredit eyni anda daxil edilə bilməz.`);
    const counterpartyId=x.counterparty_id!=null && x.counterparty_id!=='' ? Number(x.counterparty_id) : null;
    if(counterpartyId!=null){
      const cp=db.prepare(`SELECT id FROM counterparties WHERE id=?`).get(counterpartyId);
      if(!cp) throw new Error(`${code}: kontragent tapılmadı.`);
    }
    const subkontoId=x.subkonto_id!=null && x.subkonto_id!=='' ? Number(x.subkonto_id) : null;
    if(subkontoId!=null){
      const sk=db.prepare(`SELECT id FROM account_subcontos WHERE id=? AND account_code=?`).get(subkontoId,code);
      if(!sk) throw new Error(`${code}: subkonto bu hesaba aid deyil.`);
    }
    // Multiple lines for the same account+counterparty+subkonto combination
    // (e.g. duplicated rows submitted from the UI) are merged rather than
    // silently overwriting one another.
    const key=`${code}|${counterpartyId ?? ''}|${subkontoId ?? ''}`;
    const note=String(x.note||'').trim();
    if(merged.has(key)){
      const existing=merged.get(key);
      existing.debit=round2(existing.debit+d); existing.credit=round2(existing.credit+c);
      if(note && !existing.note) existing.note=note;
    } else {
      merged.set(key,{code,debit:d,credit:c,note,counterparty_id:counterpartyId,subkonto_id:subkontoId});
    }
    totalD+=d; totalK+=c;
  }
  const clean=[...merged.values()].map(row=>{
    const net=round2(row.debit-row.credit);
    return {...row,debit:net>0?net:0,credit:net<0?Math.abs(net):0};
  }).filter(x=>x.debit>0||x.credit>0);
  if(Math.abs(totalD-totalK)>0.005) throw new Error(`Açılış qalığı balanslaşmır. Debet ${totalD.toFixed(2)} · Kredit ${totalK.toFixed(2)} · Fərq ${(totalD-totalK).toFixed(2)}.`);
  const t=nowIso(); db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`DELETE FROM opening_balances`).run();
    const ins=db.prepare(`INSERT INTO opening_balances(account_code,counterparty_id,subkonto_id,debit,credit,note,updated_at) VALUES(?,?,?,?,?,?,?)`);
    for(const x of clean) ins.run(x.code,x.counterparty_id,x.subkonto_id,x.debit,x.credit,x.note||null,t);
    db.prepare(`UPDATE company_settings SET accounting_enabled=1,opening_date=?,activated_at=COALESCE(activated_at,?),activated_by=?,updated_at=? WHERE id=1`).run(openingDate,t,currentUserName(),t);
    audit('Dövriyyə-Balans uçotu aktivləşdirildi','Uçot',null,null,{opening_date:openingDate,accounts:clean.length,total_debit:round2(totalD),total_credit:round2(totalK)});
    db.exec('COMMIT'); return getAccountingSetup();
  } catch(e){ try{db.exec('ROLLBACK')}catch(_){}; throw e; }
}

function accountScopeCodes(accountCode) {
  const requested=String(accountCode||'').trim();
  if(!requested) return [];
  return db.prepare(`SELECT code FROM accounts
    WHERE active=1 AND COALESCE(is_postable,1)=1
      AND (code=? OR parent_code=? OR code LIKE ?)
    ORDER BY code`).all(requested,requested,`${requested}.%`).map(row=>String(row.code));
}

function turnoverBalance({from='',to='',accountCode='',includeZero=false}={}) {
  const {start,end}=assertOptionalDateRange(from,to);
  const scopedCodes=accountCode?accountScopeCodes(accountCode):[];
  if(accountCode && !scopedCodes.length) return [];
  const acctFilter=scopedCodes.length?`AND a.code IN (${scopedCodes.map(()=>'?').join(',')})`:'';
  const rows=db.prepare(`
    SELECT a.code,a.name,a.kind,a.parent_code,
      COALESCE(ob.debit,0) AS opening_debit, COALESCE(ob.credit,0) AS opening_credit,
      COALESCE(SUM(CASE WHEN j.entry_date < ? THEN l.debit ELSE 0 END),0) AS prior_debit,
      COALESCE(SUM(CASE WHEN j.entry_date < ? THEN l.credit ELSE 0 END),0) AS prior_credit,
      COALESCE(SUM(CASE WHEN j.entry_date BETWEEN ? AND ? THEN l.debit ELSE 0 END),0) AS period_debit,
      COALESCE(SUM(CASE WHEN j.entry_date BETWEEN ? AND ? THEN l.credit ELSE 0 END),0) AS period_credit
    FROM accounts a
    LEFT JOIN (SELECT account_code,SUM(debit) debit,SUM(credit) credit FROM opening_balances GROUP BY account_code) ob ON ob.account_code=a.code
    LEFT JOIN journal_lines l ON l.account_code=a.code
    LEFT JOIN journal_entries j ON j.id=l.journal_entry_id AND j.company_id=1 AND j.status='Təsdiqlənib'
    WHERE a.active=1 AND COALESCE(a.is_postable,1)=1 ${acctFilter}
    GROUP BY a.id,a.code,a.name,a.kind,a.parent_code,ob.debit,ob.credit
    ORDER BY a.code
  `).all(start,start,start,end,start,end,...scopedCodes);
  const settings=accountingStatus();
  const openingDate=settings.opening_date||'1900-01-01';
  const out=rows.map(r=>{
    const sourceOpening=Number(r.opening_debit)-Number(r.opening_credit);
    const openingBeforePeriod=settings.accounting_enabled && openingDate<=start ? sourceOpening : 0;
    const openingInsidePeriod=settings.accounting_enabled && openingDate>start && openingDate<=end ? sourceOpening : 0;
    const openingNet=round2(openingBeforePeriod+Number(r.prior_debit)-Number(r.prior_credit));
    const openD=openingNet>0?openingNet:0, openK=openingNet<0?Math.abs(openingNet):0;
    const turnD=round2(Number(r.period_debit)+(openingInsidePeriod>0?openingInsidePeriod:0));
    const turnK=round2(Number(r.period_credit)+(openingInsidePeriod<0?Math.abs(openingInsidePeriod):0));
    const net=round2((openD+turnD)-(openK+turnK));
    return {...r,open_debit:openD,open_credit:openK,period_debit:turnD,period_credit:turnK,
      close_debit:net>0?net:0, close_credit:net<0?Math.abs(net):0,
      has_activity:Math.abs(openD)+Math.abs(openK)+Math.abs(turnD)+Math.abs(turnK)>0.004};
  });
  return includeZero ? out : out.filter(r=>r.has_activity);
}

function turnoverBalanceGroups({from='',to='',accountCode='',includeZero=false}={}) {
  const leafRows=turnoverBalance({from,to,accountCode,includeZero:true});
  const groups=new Map();
  for(const row of leafRows){
    const code=String(row.parent_code||row.code.split('.')[0]||row.code);
    if(!groups.has(code)){
      const parent=db.prepare(`SELECT code,name,kind FROM accounts WHERE code=? AND active=1`).get(code);
      groups.set(code,{code,name:parent?.name||row.name,kind:parent?.kind||row.kind,parent_code:null,open_debit:0,open_credit:0,period_debit:0,period_credit:0,close_debit:0,close_credit:0,child_count:0,has_activity:false});
    }
    const group=groups.get(code);
    group.open_debit=round2(group.open_debit+Number(row.open_debit||0));
    group.open_credit=round2(group.open_credit+Number(row.open_credit||0));
    group.period_debit=round2(group.period_debit+Number(row.period_debit||0));
    group.period_credit=round2(group.period_credit+Number(row.period_credit||0));
    group.close_debit=round2(group.close_debit+Number(row.close_debit||0));
    group.close_credit=round2(group.close_credit+Number(row.close_credit||0));
    group.child_count+=1;
    group.has_activity=group.has_activity||!!row.has_activity;
  }
  const result=[...groups.values()].sort((left,right)=>left.code.localeCompare(right.code,'az'));
  return includeZero?result:result.filter(row=>row.has_activity);
}


function counterpartyLedger(counterpartyId, accountCode, from='', to='') {
  const cpId=Number(counterpartyId); const account=String(accountCode||'').trim();
  if(!cpId || !account) throw new Error('Kontragent və hesab seçilməlidir.');
  const scopedCodes=accountScopeCodes(account);if(!scopedCodes.length)throw new Error('Hesab və ya hesab qrupu tapılmadı.');
  const cp=db.prepare(`SELECT id,name,voen,receivable_account_code,payable_account_code FROM counterparties WHERE id=?`).get(cpId);
  if(!cp) throw new Error('Kontragent tapılmadı.');
  const {start,end}=assertOptionalDateRange(from,to);
  const allEntries=db.prepare(`SELECT j.id,j.entry_date date,j.source_type,j.source_id,j.description document_no,l.debit,l.credit,l.analytic_key
    FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id AND j.company_id=1 AND j.status='Təsdiqlənib'
    WHERE l.counterparty_id=? AND l.account_code IN (${scopedCodes.map(()=>'?').join(',')}) AND j.entry_date<=? ORDER BY j.entry_date,j.id,l.id`).all(cpId,...scopedCodes,end).map(row=>({
      kind:['bank_payment','vat_payment'].includes(row.source_type)?'payment':row.source_type==='invoice'?'invoice':String(row.source_type).endsWith('_reversal')?'reversal':'superseded',
      journal_entry_id:Number(row.id),date:row.date,document_no:row.document_no,direction:Number(row.debit)>0?'Debet':'Kredit',debit:round2(row.debit),credit:round2(row.credit),amount:round2(Number(row.debit)+Number(row.credit)),balance_effect:round2(Number(row.debit)-Number(row.credit)),currency:'AZN',source_type:row.source_type,source_id:row.source_id,analytic_key:row.analytic_key
    }));
  const settings=accountingStatus(),openingDate=settings.opening_date||'1900-01-01';
  const attributedOpening=settings.accounting_enabled?db.prepare(`SELECT COALESCE(SUM(debit-credit),0) net FROM opening_balances WHERE counterparty_id=? AND account_code IN (${scopedCodes.map(()=>'?').join(',')})`).get(cpId,...scopedCodes):{net:0};
  const openingNet=round2(Number(attributedOpening.net||0));
  if(openingNet && openingDate>start && openingDate<=end){
    allEntries.push({kind:'opening',date:openingDate,document_no:'Açılış qalığı',direction:openingNet>0?'Debet':'Kredit',debit:openingNet>0?openingNet:0,credit:openingNet<0?Math.abs(openingNet):0,amount:Math.abs(openingNet),balance_effect:openingNet,currency:'AZN',source_type:'opening_balance',source_id:0,analytic_key:cp.voen});
  }
  allEntries.sort((a,b)=>String(a.date).localeCompare(String(b.date)) || Number(a.journal_entry_id||0)-Number(b.journal_entry_id||0));
  const opening=round2(allEntries.filter(e=>e.date<start).reduce((sum,e)=>sum+e.balance_effect,0)+(openingNet&&openingDate<=start?openingNet:0));
  const entries=allEntries.filter(e=>e.date>=start);
  let running=opening; entries.forEach(e=>{running=round2(running+e.balance_effect);e.running_balance=running});
  const invoiceTotal=round2(entries.filter(e=>e.kind==='invoice').reduce((s,r)=>s+Number(r.amount||0),0));
  const paidTotal=round2(entries.filter(e=>e.kind==='payment').reduce((s,r)=>s+Number(r.amount||0),0));
  return {counterparty:cp,accountCode:account,from:start,to:end,entries,summary:{opening,invoice_total:invoiceTotal,payments_total:paidTotal,debit:round2(entries.reduce((s,r)=>s+r.debit,0)),credit:round2(entries.reduce((s,r)=>s+r.credit,0)),closing:running,invoice_count:entries.filter(e=>e.kind==='invoice').length,payment_count:entries.filter(e=>e.kind==='payment').length}};
}

function accountCounterparties(accountCode, from='', to='') {
  const account=String(accountCode||'').trim(); if(!account) throw new Error('Hesab seçilməlidir.');
  const scopedCodes=accountScopeCodes(account);if(!scopedCodes.length)throw new Error('Hesab və ya hesab qrupu tapılmadı.');
  const {start,end}=assertOptionalDateRange(from,to);
  const counterparties=new Map();
  const ensure=(id,name,voen)=>{if(!counterparties.has(id))counterparties.set(id,{id,name,voen,invoice_count:0,opening:0,period_debit:0,period_credit:0,receivable:0,payable:0,allocated_payments:0});return counterparties.get(id)};
  const movements=db.prepare(`SELECT l.counterparty_id id,c.name,c.voen,j.entry_date date,j.source_type,l.debit,l.credit
    FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id AND j.company_id=1 AND j.status='Təsdiqlənib'
    JOIN counterparties c ON c.id=l.counterparty_id WHERE l.account_code IN (${scopedCodes.map(()=>'?').join(',')}) AND j.entry_date<=? ORDER BY j.entry_date,j.id,l.id`).all(...scopedCodes,end);
  for(const row of movements){const target=ensure(row.id,row.name,row.voen),debit=Number(row.debit||0),credit=Number(row.credit||0);if(row.date<start)target.opening+=debit-credit;else{target.period_debit+=debit;target.period_credit+=credit;if(row.source_type==='invoice'){target.invoice_count++;target.receivable+=debit;target.payable+=credit}else if(['bank_payment','vat_payment'].includes(row.source_type))target.allocated_payments+=debit+credit;}}
  // Opening balances entered against a specific counterparty (see
  // saveAccountingSetup) fold into that counterparty's own row instead of
  // showing up as an unexplained lump sum. Only unattributed opening rows
  // (counterparty_id IS NULL) still fall through to the "Analitikasız açılış
  // qalığı" reconciliation line below.
  const settings=accountingStatus();
  const openingDate=settings.opening_date||'1900-01-01';
  const openingRows=db.prepare(`SELECT ob.debit,ob.credit,c.id,c.name,c.voen
    FROM opening_balances ob JOIN counterparties c ON c.id=ob.counterparty_id
    WHERE ob.account_code IN (${scopedCodes.map(()=>'?').join(',')}) AND ob.counterparty_id IS NOT NULL`).all(...scopedCodes);
  for(const row of openingRows){
    if(!settings.accounting_enabled) continue;
    const target=ensure(row.id,row.name,row.voen),net=Number(row.debit||0)-Number(row.credit||0);
    if(openingDate<=start) target.opening+=net;
    else if(openingDate<=end){ if(net>0) target.period_debit+=net; else target.period_credit+=-net; }
  }
  const result=[...counterparties.values()].map(r=>{const opening=round2(r.opening),debit=round2(r.period_debit),credit=round2(r.period_credit),net=round2(opening+debit-credit);return {...r,opening,debit,credit,receivable:round2(r.receivable),payable:round2(r.payable),allocated_payments:round2(r.allocated_payments),net,closing_amount:Math.abs(net),closing_side:net>0?'Debet':net<0?'Kredit':'Bağlı'};});
  const dbc=turnoverBalance({from:start,to:end,accountCode:account,includeZero:true});
  const targetNet=round2(dbc.reduce((sum,row)=>sum+Number(row.close_debit||0)-Number(row.close_credit||0),0)),analyticNet=round2(result.reduce((sum,row)=>sum+row.net,0)),difference=round2(targetNet-analyticNet);
  if(Math.abs(difference)>0.004){const asOpening=!settings.opening_date||settings.opening_date<=start;result.push({id:0,name:'Analitikasız açılış qalığı',voen:'—',invoice_count:0,opening:asOpening?difference:0,debit:!asOpening&&difference>0?difference:0,credit:!asOpening&&difference<0?Math.abs(difference):0,receivable:0,payable:0,allocated_payments:0,net:difference,closing_amount:Math.abs(difference),closing_side:difference>0?'Debet':'Kredit',unallocated_opening:true});}
  return result.sort((a,b)=>a.name.localeCompare(b.name,'az'));
}

function inventoryAccountAnalytics(accountCode,from='',to='') {
  const account=String(accountCode||'205.01').trim(),{start,end}=assertOptionalDateRange(from,to);
  const scopedCodes=accountScopeCodes(account);if(!scopedCodes.length)throw new Error('Anbar hesabı və ya hesab qrupu tapılmadı.');
  const rows=db.prepare(`
    SELECT sm.warehouse_id,w.code AS warehouse_code,w.name AS warehouse_name,w.valuation_method,
           sm.catalog_item_id,c.code AS item_code,c.name AS item_name,c.unit,
           SUM(CASE WHEN sm.movement_date<? AND sm.direction='IN' THEN sm.quantity WHEN sm.movement_date<? AND sm.direction='OUT' THEN -sm.quantity ELSE 0 END) AS opening_qty,
           SUM(CASE WHEN sm.movement_date<? AND sm.direction='IN' THEN sm.total_cost WHEN sm.movement_date<? AND sm.direction='OUT' THEN -sm.total_cost ELSE 0 END) AS opening_value,
           SUM(CASE WHEN sm.movement_date BETWEEN ? AND ? AND sm.direction='IN' THEN sm.quantity ELSE 0 END) AS incoming_qty,
           SUM(CASE WHEN sm.movement_date BETWEEN ? AND ? AND sm.direction='IN' THEN sm.total_cost ELSE 0 END) AS incoming_value,
           SUM(CASE WHEN sm.movement_date BETWEEN ? AND ? AND sm.direction='OUT' THEN sm.quantity ELSE 0 END) AS outgoing_qty,
           SUM(CASE WHEN sm.movement_date BETWEEN ? AND ? AND sm.direction='OUT' THEN sm.total_cost ELSE 0 END) AS outgoing_value,
           SUM(CASE WHEN sm.movement_date<=? AND sm.direction='IN' THEN sm.quantity WHEN sm.movement_date<=? AND sm.direction='OUT' THEN -sm.quantity ELSE 0 END) AS closing_qty,
           SUM(CASE WHEN sm.movement_date<=? AND sm.direction='IN' THEN sm.total_cost WHEN sm.movement_date<=? AND sm.direction='OUT' THEN -sm.total_cost ELSE 0 END) AS closing_value,
           SUM(CASE WHEN sm.movement_date<=? THEN sm.shortage_quantity ELSE 0 END) AS shortage_qty
    FROM stock_movements sm
    JOIN warehouses w ON w.id=sm.warehouse_id
    JOIN item_catalog c ON c.id=sm.catalog_item_id
    WHERE w.inventory_account_code IN (${scopedCodes.map(()=>'?').join(',')})
    GROUP BY sm.warehouse_id,w.code,w.name,w.valuation_method,sm.catalog_item_id,c.code,c.name,c.unit
    ORDER BY c.name,w.name`).all(start,start,start,start,start,end,start,end,start,end,start,end,end,end,end,end,end,...scopedCodes);
  const result=rows.map(row=>({
    ...row,opening_qty:Number(row.opening_qty||0),opening_value:round2(row.opening_value),incoming_qty:Number(row.incoming_qty||0),incoming_value:round2(row.incoming_value),
    outgoing_qty:Number(row.outgoing_qty||0),outgoing_value:round2(row.outgoing_value),closing_qty:Number(row.closing_qty||0),closing_value:round2(row.closing_value),
    average_cost:Number(row.closing_qty)>0?round2(Number(row.closing_value)/Number(row.closing_qty)):0,shortage_qty:Number(row.shortage_qty||0)
  }));
  const dbc=turnoverBalance({from:start,to:end,accountCode:account,includeZero:true}),target=round2(dbc.reduce((sum,row)=>sum+Number(row.close_debit||0)-Number(row.close_credit||0),0)),actual=round2(result.reduce((sum,row)=>sum+Number(row.closing_value||0),0)),difference=round2(target-actual);
  if(Math.abs(difference)>0.004)result.push({warehouse_id:0,warehouse_code:'—',warehouse_name:'Analitikasız açılış qalığı',valuation_method:'—',catalog_item_id:0,item_code:'—',item_name:'Miqdar analitikası daxil edilməyib',unit:'—',opening_qty:0,opening_value:difference,incoming_qty:0,incoming_value:0,outgoing_qty:0,outgoing_value:0,closing_qty:0,closing_value:difference,average_cost:0,shortage_qty:0,unallocated_opening:true});
  return result;
}

function accountAnalytics(accountCode,from='',to='') {
  const account=String(accountCode||'').trim();
  const scopedCodes=accountScopeCodes(account);if(!scopedCodes.length)throw new Error('Hesab və ya hesab qrupu tapılmadı.');
  const roles=new Set(db.prepare(`SELECT role FROM accounts WHERE code IN (${scopedCodes.map(()=>'?').join(',')})`).all(...scopedCodes).map(row=>String(row.role||'')));
  if(roles.has('RECEIVABLE')||roles.has('PAYABLE')) return {type:'counterparties',accountCode:account,rows:accountCounterparties(account,from,to)};
  if(roles.has('INVENTORY')) return {type:'inventory',accountCode:account,rows:inventoryAccountAnalytics(account,from,to)};
  const {start,end}=assertOptionalDateRange(from,to);
  const rows=db.prepare(`SELECT s.id subkonto_id,COALESCE(s.account_code,MIN(l.account_code)) account_code,COALESCE(s.code,'—') subkonto_code,COALESCE(s.name,'Analitikasız') name,
    ROUND(SUM(CASE WHEN j.entry_date<? THEN l.debit-l.credit ELSE 0 END),2) opening,
    ROUND(SUM(CASE WHEN j.entry_date BETWEEN ? AND ? THEN l.debit ELSE 0 END),2) debit,
    ROUND(SUM(CASE WHEN j.entry_date BETWEEN ? AND ? THEN l.credit ELSE 0 END),2) credit
    FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id AND j.status='Təsdiqlənib'
    LEFT JOIN account_subcontos s ON s.id=l.subkonto_id WHERE l.account_code IN (${scopedCodes.map(()=>'?').join(',')}) AND j.entry_date<=?
    GROUP BY l.subkonto_id,s.account_code,s.code,s.name ORDER BY name`).all(start,start,end,start,end,...scopedCodes,end);
  const bySubkonto=new Map(rows.map(row=>[row.subkonto_id??null,{...row,opening:Number(row.opening),debit:Number(row.debit),credit:Number(row.credit)}]));
  // Opening balances entered against a specific subkonto (see
  // saveAccountingSetup) fold into that subkonto's own row instead of
  // showing up as an unexplained lump sum. Only unattributed opening rows
  // (subkonto_id IS NULL) still fall through to the "Analitikasız açılış
  // qalığı" reconciliation line below.
  const settings=accountingStatus(),openingDate=settings.opening_date||'1900-01-01';
  if(settings.accounting_enabled){
    const openingRows=db.prepare(`SELECT ob.subkonto_id,ob.debit,ob.credit,s.code,s.name
      FROM opening_balances ob JOIN account_subcontos s ON s.id=ob.subkonto_id
      WHERE ob.account_code IN (${scopedCodes.map(()=>'?').join(',')}) AND ob.subkonto_id IS NOT NULL`).all(...scopedCodes);
    for(const row of openingRows){
      const net=Number(row.debit||0)-Number(row.credit||0);
      if(!bySubkonto.has(row.subkonto_id)) bySubkonto.set(row.subkonto_id,{subkonto_id:row.subkonto_id,subkonto_code:row.code,name:row.name,opening:0,debit:0,credit:0});
      const target=bySubkonto.get(row.subkonto_id);
      if(openingDate<=start) target.opening+=net;
      else if(openingDate<=end){ if(net>0) target.debit+=net; else target.credit+=-net; }
    }
  }
  const result=[...bySubkonto.values()].map(row=>{const opening=round2(row.opening),debit=round2(row.debit),credit=round2(row.credit),closing=round2(opening+debit-credit);return {...row,opening,debit,credit,closing_debit:closing>0?closing:0,closing_credit:closing<0?Math.abs(closing):0};}).sort((a,b)=>String(a.name).localeCompare(String(b.name),'az'));
  const dbc=turnoverBalance({from:start,to:end,accountCode:account,includeZero:true}),target=round2(dbc.reduce((sum,row)=>sum+Number(row.close_debit||0)-Number(row.close_credit||0),0)),actual=round2(result.reduce((sum,row)=>sum+Number(row.closing_debit||0)-Number(row.closing_credit||0),0)),difference=round2(target-actual);
  if(Math.abs(difference)>0.004)result.push({subkonto_code:'—',name:'Analitikasız açılış qalığı',opening:difference,debit:0,credit:0,closing_debit:difference>0?difference:0,closing_credit:difference<0?Math.abs(difference):0,unallocated_opening:true});
  return {type:'subcontos',accountCode:account,rows:result};
}

function accountAnalyticLedger({accountCode='',subkontoId=null,from='',to=''}={}) {
  const account=String(accountCode||'').trim(),{start,end}=assertOptionalDateRange(from,to);
  const scopedCodes=accountScopeCodes(account);if(!scopedCodes.length)throw new Error('Hesab və ya hesab qrupu tapılmadı.');
  const selectedSubkontoId=subkontoId==null||subkontoId===''?null:Number(subkontoId);
  if(selectedSubkontoId!=null&&!db.prepare(`SELECT 1 FROM account_subcontos WHERE id=? AND account_code IN (${scopedCodes.map(()=>'?').join(',')}) AND active=1`).get(selectedSubkontoId,...scopedCodes))throw new Error('Subkonto seçilmiş hesaba aid deyil və ya aktiv deyil.');
  const subkontoFilter=selectedSubkontoId==null?'l.subkonto_id IS NULL':'l.subkonto_id=?';
  const queryParameters=[...scopedCodes];if(selectedSubkontoId!=null)queryParameters.push(selectedSubkontoId);queryParameters.push(end);
  const movements=db.prepare(`SELECT j.id journal_entry_id,j.entry_date date,j.source_type,j.source_id,j.description document_no,
      l.account_code,l.debit,l.credit,l.analytic_key,cp.name counterparty_name,cp.voen,c.contract_no
    FROM journal_lines l
    JOIN journal_entries j ON j.id=l.journal_entry_id AND j.company_id=1 AND j.status='Təsdiqlənib'
    LEFT JOIN counterparties cp ON cp.id=l.counterparty_id
    LEFT JOIN counterparty_contracts c ON c.id=l.contract_id
    WHERE l.account_code IN (${scopedCodes.map(()=>'?').join(',')}) AND ${subkontoFilter} AND j.entry_date<=?
    ORDER BY j.entry_date,j.id,l.id`).all(...queryParameters).map(row=>({...row,debit:round2(row.debit),credit:round2(row.credit),balance_effect:round2(Number(row.debit)-Number(row.credit))}));
  const openingParameters=[...scopedCodes];if(selectedSubkontoId!=null)openingParameters.push(selectedSubkontoId);
  const openingSubkontoFilter=selectedSubkontoId==null?'subkonto_id IS NULL':'subkonto_id=?';
  const settings=accountingStatus(),openingDate=settings.opening_date||'1900-01-01';
  const openingRow=settings.accounting_enabled?db.prepare(`SELECT COALESCE(SUM(debit-credit),0) net FROM opening_balances WHERE account_code IN (${scopedCodes.map(()=>'?').join(',')}) AND ${openingSubkontoFilter}`).get(...openingParameters):{net:0};
  const attributedOpening=round2(openingRow.net||0);
  if(attributedOpening&&openingDate>start&&openingDate<=end){
    movements.push({journal_entry_id:0,date:openingDate,source_type:'opening_balance',source_id:0,document_no:'Açılış qalığı',account_code:account,debit:attributedOpening>0?attributedOpening:0,credit:attributedOpening<0?Math.abs(attributedOpening):0,balance_effect:attributedOpening,analytic_key:'Açılış qalığı',counterparty_name:'',voen:'',contract_no:''});
    movements.sort((left,right)=>String(left.date).localeCompare(String(right.date))||Number(left.journal_entry_id)-Number(right.journal_entry_id));
  }
  const opening=round2(movements.filter(row=>row.date<start).reduce((sum,row)=>sum+Number(row.balance_effect),0)+(attributedOpening&&openingDate<=start?attributedOpening:0));
  const entries=movements.filter(row=>row.date>=start);
  let runningBalance=opening;
  for(const entry of entries){runningBalance=round2(runningBalance+Number(entry.balance_effect));entry.running_balance=runningBalance;}
  return {accountCode:account,subkontoId:selectedSubkontoId,from:start,to:end,opening,closing:runningBalance,entries};
}

function turnoverBalanceSummary({from='',to=''}={}) {
  const rows=turnoverBalance({from,to,includeZero:true});
  return {
    accounts: rows.length,
    active_accounts: rows.filter(r=>r.has_activity).length,
    opening_debit: round2(rows.reduce((s,r)=>s+r.open_debit,0)),
    opening_credit: round2(rows.reduce((s,r)=>s+r.open_credit,0)),
    turnover_debit: round2(rows.reduce((s,r)=>s+r.period_debit,0)),
    turnover_credit: round2(rows.reduce((s,r)=>s+r.period_credit,0)),
    closing_debit: round2(rows.reduce((s,r)=>s+r.close_debit,0)),
    closing_credit: round2(rows.reduce((s,r)=>s+r.close_credit,0))
  };
}

function removeInvoice(id) {
  const before=invoiceDetail(id);
  if(!before) throw new Error('Qaimə tapılmadı.');
  assertVatInvoiceOpen(id);
  const allocations=Number(db.prepare(`SELECT COUNT(*) c FROM payment_allocations WHERE invoice_id=?`).get(id).c||0);
  if(allocations)throw new Error('Qaiməyə ödəniş bağlanıb. Əvvəlcə bank uyğunlaşdırmasını geri qaytarın.');
  const vatAllocations=Number(db.prepare(`SELECT COUNT(*) c FROM vat_payment_allocations WHERE invoice_id=?`).get(id).c||0);
  if(vatAllocations)throw new Error('Qaiməyə ƏDV depozit/gömrük ödənişi bağlanıb. Əvvəlcə ƏDV modulunda bağlantını silin.');
  assertAccountingDateOpen(before.invoice_date);const scopes=invoiceInventoryScopes(before),t=nowIso();db.exec('BEGIN IMMEDIATE');
  try{
    const reversalIds=reverseAllActiveJournalsForSource('invoice',id,'Qaimənin arxivlənməsi üzrə storno');
    db.prepare(`UPDATE invoices SET deleted_at=?,posting_status='Storno edilib',updated_at=? WHERE id=?`).run(t,t,id);
    rebuildInventoryScopes(scopes);
    audit('Qaimə storno edilərək arxivləndi','E-Qaimə',id,before,{reversal_journal_entry_ids:reversalIds});db.exec('COMMIT');return true;
  }catch(error){try{db.exec('ROLLBACK')}catch(_){};throw error;}
}

function hardDeleteInvoice(id) {
  const before=invoiceDetail(id,true);
  if(!before) throw new Error('Qaimə tapılmadı.');
  assertVatInvoiceOpen(id);
  if(db.prepare(`SELECT 1 FROM journal_entries WHERE source_id=? AND source_type LIKE 'invoice%' LIMIT 1`).get(id)) throw new Error('Audit izi olan qaimə tam silinə bilməz; storno edilərək arxivlənməlidir.');
  const allocations=db.prepare(`SELECT COUNT(*) AS c FROM payment_allocations WHERE invoice_id=?`).get(id).c;
  if(allocations>0) throw new Error('Ödənişlə əlaqələndirilmiş qaimə silinə bilməz. Əvvəlcə əlaqəni ləğv edin.');
  const vatAllocations=db.prepare(`SELECT COUNT(*) AS c FROM vat_payment_allocations WHERE invoice_id=?`).get(id).c;
  if(vatAllocations>0) throw new Error('ƏDV ödənişi ilə əlaqələndirilmiş qaimə silinə bilməz. Əvvəlcə ƏDV bağlantısını ləğv edin.');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`DELETE FROM invoice_status_history WHERE invoice_id=?`).run(id);
    db.prepare(`DELETE FROM documents WHERE entity_type='E-Qaimə' AND entity_id=?`).run(id);
    db.prepare(`DELETE FROM journal_lines WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE source_type='invoice' AND source_id=?)`).run(id);
    db.prepare(`DELETE FROM journal_entries WHERE source_type='invoice' AND source_id=?`).run(id);
    db.prepare(`DELETE FROM vat_invoice_settings WHERE invoice_id=?`).run(id);
    db.prepare(`DELETE FROM vat_adjustments WHERE invoice_id=?`).run(id);
    db.prepare(`DELETE FROM invoice_items WHERE invoice_id=?`).run(id);
    db.prepare(`DELETE FROM invoices WHERE id=?`).run(id);
    audit('Qaimə tam silindi','E-Qaimə',id,before,null);
    db.exec('COMMIT');
    return true;
  } catch(e) { try{db.exec('ROLLBACK')}catch(_){}; throw e; }
}

function restoreInvoice(id) {
  const inv=db.prepare(`SELECT * FROM invoices WHERE id=? AND deleted_at IS NOT NULL`).get(id);
  if(!inv) throw new Error('Arxivlənmiş qaimə tapılmadı.');
  const active=db.prepare(`SELECT id FROM invoices WHERE company_id=1 AND upper(trim(invoice_no))=upper(trim(?)) AND voen=? AND direction=? AND deleted_at IS NULL`).get(inv.invoice_no,inv.voen,inv.direction);
  if(active) throw new Error(`Eyni nömrəli aktiv ${inv.direction.toLowerCase()} qaimə həmin kontragent/VÖEN üzrə artıq mövcuddur.`);
  const before={...inv}; const t=nowIso();assertAccountingDateOpen(inv.invoice_date);assertVatDateOpen(inv.invoice_date);db.exec('BEGIN IMMEDIATE');
  try{db.prepare(`UPDATE invoices SET deleted_at=NULL,posting_status='Hazırlanmayıb',updated_at=? WHERE id=?`).run(t,id);const posting=createInvoicePosting(id);rebuildInventoryScopes(posting.scopes);audit('Qaimə arxivdən bərpa edildi və yenidən uçota alındı','E-Qaimə',id,before,{...invoiceDetail(id),journal_entry_id:posting.journalEntryId});db.exec('COMMIT');return invoiceDetail(id);}catch(error){try{db.exec('ROLLBACK')}catch(_){};throw error;}
}

function changeInvoiceStatus(id, toStatus, reason='') {
  const inv=invoiceDetail(id); if(!inv) throw new Error('Qaimə tapılmadı.');
  if(String(toStatus||'')!=='Təsdiqlənib') throw new Error('Qəbul edilmiş qaimələr avtomatik uçota alınır; yalnız “Təsdiqlənib” statusu mümkündür.');
  if(inv.status==='Təsdiqlənib') return inv;
  recordStatusTransition(id, inv.status, toStatus, reason);
  db.prepare(`UPDATE invoices SET status=?,updated_at=? WHERE id=?`).run(toStatus,nowIso(),id);
  audit('Qaimə statusu dəyişdirildi','E-Qaimə',id,{status:inv.status},{status:toStatus,reason});
  return invoiceDetail(id);
}


function pick(obj, keys) {
  const entries = Object.entries(obj || {});
  const norm = v => String(v ?? '').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim().toLowerCase();
  for (const key of keys) {
    const nk = norm(key);
    const hit = entries.find(([k]) => norm(k) === nk);
    if (hit) return hit[1];
  }
  for (const key of keys) {
    const nk = norm(key);
    // Generic aliases such as "name", "no", "type" and "date" are valid
    // only as exact headers. Substring matching them would confuse
    // invoice_type_name with counterparty name and similar DVX fields.
    if (nk.length < 4 || ['name','type','date','number'].includes(nk)) continue;
    const hit = entries.find(([k]) => norm(k).includes(nk));
    if (hit) return hit[1];
  }
  return '';
}

function sanitizeCounterpartyName(value='') {
  let name=String(value||'')
    .replace(/\u00a0/g,' ')
    .replace(/[\r\n\t]+/g,' ')
    .replace(/\s+/g,' ')
    .trim()
    .replace(/^[“”"'`]+|[“”"'`]+$/g,'');
  // DVX card layouts sometimes expose the entire card as one grid cell. Keep
  // only the legal counterparty name and stop before the next labelled field.
  const marker=/\s*(?:\||;)?\s*(?=(?:seriya\s+v[əe]\s+n[öo]mr[əe]|qaim[əe]\s*(?:n[öo]mr[əe]si|no)|yekun\s+m[əe]bl[əe]ğ|[əe]dv\s+m[əe]bl[əe]ğ|n[öo]v[üu]\s*:|sistem\s+t[əe]r[əe]find[əe]n|qaim[əe]\s+tarixi|son\s+tarix|status\s*:))/i;
  name=name.split(marker)[0].trim().replace(/[|;,:-]+$/,'').trim();
  return name.slice(0,240);
}

function repairPollutedCounterpartyNames() {
  const rows=db.prepare(`SELECT id,name FROM counterparties WHERE status='Aktiv'`).all();
  const updateCounterparty=db.prepare(`UPDATE counterparties SET name=?,updated_at=? WHERE id=?`);
  const updateInvoices=db.prepare(`UPDATE invoices SET counterparty_name=?,updated_at=? WHERE counterparty_id=?`);
  const updateInvoice=db.prepare(`UPDATE invoices SET counterparty_name=?,updated_at=? WHERE id=?`);
  const timestamp=nowIso();
  for(const row of rows){
    const clean=sanitizeCounterpartyName(row.name);
    if(!clean || clean===row.name) continue;
    updateCounterparty.run(clean,timestamp,row.id);
    updateInvoices.run(clean,timestamp,row.id);
  }
  for(const invoice of db.prepare(`SELECT id,counterparty_name FROM invoices WHERE deleted_at IS NULL`).all()){
    const clean=sanitizeCounterpartyName(invoice.counterparty_name);
    if(clean && clean!==invoice.counterparty_name) updateInvoice.run(clean,timestamp,invoice.id);
  }
}
function numberValue(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  let s=String(v ?? '').trim();
  if (!s) return 0;
  s=s.replace(/\s/g,'').replace(/[^0-9,.-]/g,'');
  if (s.includes(',') && s.includes('.')) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s=s.replace(/\./g,'').replace(',','.');
    else s=s.replace(/,/g,'');
  } else if (s.includes(',')) s=s.replace(',','.');
  const n=Number(s); return Number.isFinite(n)?n:0;
}
function normalizeDateValue(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0,10);
  const s=String(v ?? '').trim();
  if (!s) return '';
  let m=s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if(m){const candidate=`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;return isValidIsoDate(candidate)?candidate:'';}
  m=s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if(m){const candidate=`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;return isValidIsoDate(candidate)?candidate:'';}
  if (/^\d+(\.\d+)?$/.test(s)) { const serial=Number(s); if(serial>20000 && serial<60000){const d=new Date(Date.UTC(1899,11,30)+serial*86400000),candidate=d.toISOString().slice(0,10);return isValidIsoDate(candidate)?candidate:'';} }
  return '';
}
function normalizeStatus(v) {
  const s=String(v||'').trim().toLowerCase();
  if(s.includes('sistem tərəfindən təsdiqləndi')) return 'Təsdiqlənib';
  if(s.includes('təsdiqləndi')) return 'Təsdiqlənib';
  if(s.includes('göndərildi') || s.includes('göndərilib')) return 'Göndərilib';
  if(s.includes('gözləyir')) return 'Gözləyir';
  if(s.includes('qaralama')) return 'Qaralama';
  return 'Gözləyir';
}
function normalizeDirectionValue(v, fallback='') {
  const s=String(v ?? '').trim().toLowerCase()
    .replace(/ə/g,'e').replace(/ı/g,'i').replace(/ö/g,'o').replace(/ü/g,'u')
    .replace(/ğ/g,'g').replace(/ç/g,'c').replace(/ş/g,'s');
  if (/(^|\b)(geden|gonderilen(?:ler)?|gonderdiklerim|gonderilmis|sent|outgoing|sale|satis|satish)(\b|$)/i.test(s)) return 'Gedən';
  if (/(^|\b)(gelen(?:ler)?|daxil olan|alinan|alis|received|incoming|purchase)(\b|$)/i.test(s)) return 'Gələn';
  return fallback === 'Gedən' ? 'Gedən' : fallback === 'Gələn' ? 'Gələn' : '';
}

function invoiceFromRaw(raw, fallbackDirection='', source='import') {
  const rawNo=String(pick(raw,['invoice_no','invoiceNo','InvoiceNumber','invoice','qaiməNo','qaimə','number','no','Qaimə nömrəsi','Nömrə'])||'').trim();
  const seriesRaw=String(pick(raw,['invoice_series','Qaimə seriyası','Seriya'])||'').trim();
  const no=(seriesRaw && rawNo && !rawNo.toUpperCase().startsWith(seriesRaw.toUpperCase())) ? `${seriesRaw} ${rawNo}` : rawNo;
  const name=sanitizeCounterpartyName(pick(raw,['counterparty_name','CounterpartyName','counterparty','payer','buyer','seller','name','Adı','Ödəyici adı','Kontragent']));
  const voen=String(pick(raw,['voen','Voen','VÖEN','tin','taxId'])||'').replace(/\D/g,'');
  const date=normalizeDateValue(pick(raw,['invoice_date','invoiceDate','InvoiceDate','date','tarix','Tarix','Qaimə tarixi']));
  const direction=normalizeDirectionValue(pick(raw,['direction','direction_name','type','növ','Tipi']),fallbackDirection);
  let base=numberValue(pick(raw,['base_amount','BaseAmount','Base','base','amount_without_vat','mal_value','Malın ƏDV-siz ümumi dəyəri','Əsas məbləğ']));
  let vat=numberValue(pick(raw,['vat_amount','VatAmount','Vat','vat','ƏDV','Malın ƏDV məbləği']));
  const total=numberValue(pick(raw,['total_amount','TotalAmount','Total','total','yekun','Yekun məbləğ','Yekun','Ümumi məbləğ'])) || (base+vat);
  if (!base && total) base=Math.max(0,total-vat);
  if (!vat && total && base) vat=Math.max(0,total-base);
  const rate=base>0 ? Number((vat/base*100).toFixed(4)) : 0;
  const typeName=String(pick(raw,['invoice_type_name','Qaimə/Akt növləri','Növü'])||'').trim();
  const explicitItemType=String(pick(raw,['item_type','Mal/Xidmət','Məhsul növü','Sətir növü'])||'').trim();
  const note=String(pick(raw,['note','qeyd','Əsas qeyd'])||'').trim();
  const additionalNote=String(pick(raw,['additional_note','Əlavə qeyd'])||'').trim();
  const extra={
    invoice_series:seriesRaw,
    invoice_type_name:typeName,
    main_note:note,
    additional_note:additionalNote,
    excise_amount:numberValue(pick(raw,['excise_amount','Aksiz məbləği'])),
    vat_taxable_amount:numberValue(pick(raw,['vat_taxable_amount','ƏDV-yə cəlb edilən'])),
    vat_non_taxable_amount:numberValue(pick(raw,['vat_non_taxable_amount','ƏDV-yə cəlb edilməyən'])),
    vat_exempt_amount:numberValue(pick(raw,['vat_exempt_amount','ƏDV-dən azad olan'])),
    vat_zero_amount:numberValue(pick(raw,['vat_zero_amount','ƏDV-yə "0" dərəcə ilə cəlb edilən','ƏDV-yə 0 dərəcə ilə cəlb edilən'])),
    road_tax_amount:numberValue(pick(raw,['road_tax_amount','Yol vergisi'])),
    reason_text:String(pick(raw,['reason_text','Səbəb'])||'').trim(),
    advance_series:String(pick(raw,['advance_series','Avans Seriası','Avans Seriyası'])||'').trim(),
    advance_number:String(pick(raw,['advance_number','Avans Nömrəsi'])||'').trim(),
    advance_amount:numberValue(pick(raw,['advance_amount','Avans Məbləği']))
  };
  return {invoice_no:no,invoice_date:date,direction,counterparty_name:name,voen,currency:String(pick(raw,['currency','valyuta'])||'AZN').trim().toUpperCase(),exchange_rate:numberValue(pick(raw,['exchange_rate','Məzənnə','mezennə','rate']))||0,base_amount:round2(base),vat_amount:round2(vat),total_amount:round2(total),vat_rate:rate,status:'Təsdiqlənib',item_type:explicitItemType,note:[note,additionalNote].filter(Boolean).join(' · '),source,...extra};
}
function detectLiveTaxDirection(meta={}, preferred='') {
  const norm = (v='') => String(v||'').toLowerCase()
    .replace(/ə/g,'e').replace(/ı/g,'i').replace(/ö/g,'o').replace(/ü/g,'u')
    .replace(/ğ/g,'g').replace(/ç/g,'c').replace(/ş/g,'s')
    .replace(/\s+/g,' ').trim();
  const outgoing = /(^|\b)(gonderilen(?:ler)?|gonderdiklerim|gonderilmis|sent|outgoing|sale|satish)(\b|$)/i;
  const incoming = /(^|\b)(gelen(?:ler)?|daxil olan|alinan|received|incoming|purchase)(\b|$)/i;
  const scoreField = (v) => {
    const raw=norm(v);
    if(!raw) return 0;
    const o=(raw.match(outgoing)||[]).length;
    const i=(raw.match(incoming)||[]).length;
    return o>i ? 2 : i>o ? 1 : 0;
  };
  // Active folder/page evidence wins. The full sidebar contains both labels and
  // must never decide the direction on its own.
  const strong = ['activeTab','folder','heading','breadcrumb','url','title'];
  for (const key of strong) {
    const v=meta?.[key];
    const score=scoreField(v);
    if(score===2) return 'Gedən';
    if(score===1) return 'Gələn';
  }
  const evidence=Array.isArray(meta?.directionEvidence)?meta.directionEvidence:[];
  const outE=evidence.filter(x=>x==='Gedən').length;
  const inE=evidence.filter(x=>x==='Gələn').length;
  if(outE>inE && outE>0) return 'Gedən';
  if(inE>outE && inE>0) return 'Gələn';
  const body=norm(meta?.bodyText||'');
  const bodyOut=(body.match(outgoing)||[]).length, bodyIn=(body.match(incoming)||[]).length;
  if(bodyOut>0 && bodyIn===0) return 'Gedən';
  if(bodyIn>0 && bodyOut===0) return 'Gələn';
  return normalizeDirectionValue(preferred, '');
}

function normalizeImportText(v='') {
  return String(v||'').toLowerCase().replace(/ə/g,'e').replace(/ı/g,'i')
    .replace(/ö/g,'o').replace(/ü/g,'u').replace(/ğ/g,'g')
    .replace(/ç/g,'c').replace(/ş/g,'s').replace(/[^a-z0-9]+/g,' ').trim();
}

function directionFromEvidenceText(v='') {
  const s=normalizeImportText(v);
  if (!s) return '';
  const outgoing=(s.match(/\b(gonderilen(?:ler)?|gonderdiklerim|gonderilmis|sent|outgoing|sales?|satis)\b/g)||[]).length;
  const incoming=(s.match(/\b(gelen(?:ler)?|daxil olan|alinan|received|incoming|purchases?|alis)\b/g)||[]).length;
  return outgoing>incoming ? 'Gedən' : incoming>outgoing ? 'Gələn' : '';
}

function rawInvoiceDirection(raw={}) {
  return normalizeDirectionValue(pick(raw,[
    'direction','direction_name','İstiqamət','Qaimə istiqaməti','Sənəd istiqaməti',
    'type','növ','Tipi'
  ]),'');
}

function importedPostingAccount(x) {
  const warehouse=defaultWarehouse();
  const itemType=inferItemType({itemType:x.item_type,description:x.main_note||x.note,counterpartyName:x.counterparty_name,invoiceTypeName:x.invoice_type_name});
  const resolved=resolvePosting({
    direction:x.direction,itemType,description:x.main_note||x.note||x.invoice_type_name||'',counterpartyName:x.counterparty_name,
    invoiceTypeName:x.invoice_type_name,defaultWarehouseId:defaultWarehouse()?.id||null,defaultItemType:'Xidmət',suspenseAccount:suspenseAccount(),
    inventoryAccount:inventoryAccountForWarehouse(warehouse?.id||null),expenseAccount:accountByRole('EXPENSE','721.01'),
    defaultExpenseSubkontoId:defaultExpenseSubkontoId(),unclassifiedExpenseSubkontoId:unclassifiedExpenseSubkontoId(),
    goodsSalesAccount:accountByRole('SALES_GOODS','601.01'),serviceSalesAccount:accountByRole('SALES_SERVICE','601.02')
  },activePostingRules());
  return {itemType:resolved.itemType,account:resolved.accountCode,subkontoId:resolved.subkontoId,warehouseId:resolved.warehouseId,postingRuleId:resolved.matchedRuleId,needsReview:resolved.needsReview};
}

function importInvoiceRecords(records, source='import', sourceFile='', forcedDirection='', options={}) {
  if(!Array.isArray(records)||records.length>50000)throw new Error('Bir idxal paketində ən çox 50 000 sətir qəbul edilir.');
  const result={created:0,posted:0,reclassified:0,duplicates:0,skippedExisting:0,review:0,failed:0,errors:[],warnings:[]};
  const ins=db.prepare(`INSERT INTO invoices(company_id,invoice_no,invoice_date,due_date,direction,counterparty_id,counterparty_name,voen,currency,base_amount,vat_amount,total_amount,vat_rate,status,note,source,created_at,updated_at,invoice_series,source_file,invoice_type_name,main_note,additional_note,excise_amount,vat_taxable_amount,vat_non_taxable_amount,vat_exempt_amount,vat_zero_amount,road_tax_amount,reason_text,advance_series,advance_number,advance_amount,counterparty_account_code,vat_posting_account_code,document_key,exchange_rate,functional_total_amount) VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const inventoryScopes=[];
  db.exec('BEGIN');
  try {
    for (const [rowIndex,raw] of records.entries()) {
      db.exec('SAVEPOINT import_row');
      try {
        const detected=rawInvoiceDirection(raw);
        const x=invoiceFromRaw(raw, detected || forcedDirection, source);
        if (!x.direction) throw new Error('Qaimənin istiqaməti müəyyən edilmədi; Gələn və ya Gedən seçimi təsdiqlənməlidir');
        if (!isValidIsoDate(x.invoice_date)) throw new Error('Qaimə tarixi yoxdur və ya düzgün deyil');
        assertVatDateOpen(x.invoice_date);
        if (!x.invoice_no || !x.counterparty_name || !/^\d{10}$/.test(x.voen)) throw new Error('Qaimə №, kontragent adı və 10 rəqəmli VÖEN tələb olunur');
        if (!(x.total_amount>0)) throw new Error('Yekun məbləğ 0-dan böyük olmalıdır');
        if (!['AZN','USD','EUR'].includes(x.currency)) throw new Error(`Dəstəklənməyən valyuta: ${x.currency}`);
        if(x.currency!=='AZN'&&!(x.exchange_rate>0))throw new Error('Xarici valyutalı qaimədə AZN məzənnəsi yoxdur');
        const directionSource=detected ? 'Sətirdə istiqamət sütunu' : String(options.directionSource||'Təsdiqlənmiş idxal istiqaməti');
        const directionConfidence=detected ? 'high' : String(options.directionConfidence||'confirmed');
        const dup=db.prepare(`SELECT id FROM invoices WHERE company_id=1 AND upper(trim(invoice_no))=upper(trim(?)) AND voen=? AND direction=? LIMIT 1`).get(x.invoice_no,x.voen,x.direction);
        if (dup) {
          // Import/refresh is append-only. An existing business document is
          // immutable in the synchronization path: do not update metadata,
          // rebuild postings, touch inventory or change payment allocations.
          // Accounting repair is intentionally handled by the separate audit
          // mechanism and never by an external refresh.
          result.duplicates++;
          result.skippedExisting++;
          continue;
        }
        if(detected||options.trustedDirection){
          const oppositeDirectionDocument=db.prepare(`SELECT id FROM invoices
            WHERE company_id=1 AND upper(trim(invoice_no))=upper(trim(?)) AND voen=? AND direction<>? LIMIT 1`)
            .get(x.invoice_no,x.voen,x.direction);
          if(oppositeDirectionDocument){
            result.review++;
            if(result.warnings.length<20) result.warnings.push(`${x.invoice_no}: eyni nömrə və VÖEN əks istiqamətdə də mövcuddur; hər iki sənəd dəyişdirilmədən ayrıca saxlanıldı.`);
          }
        }
        const cpId=ensureCounterparty(x.counterparty_name,x.voen,x.direction);
        const t=nowIso();
        const rate=x.currency==='AZN'?1:Number(x.exchange_rate);
        const r=ins.run(x.invoice_no,x.invoice_date,null,x.direction,cpId,x.counterparty_name,x.voen,x.currency,x.base_amount,x.vat_amount,x.total_amount,x.vat_rate,'Təsdiqlənib',x.note,source,t,t,x.invoice_series,sourceFile,x.invoice_type_name,x.main_note,x.additional_note,x.excise_amount,x.vat_taxable_amount,x.vat_non_taxable_amount,x.vat_exempt_amount,x.vat_zero_amount,x.road_tax_amount,x.reason_text,x.advance_series,x.advance_number,x.advance_amount,defaultCounterpartyAccount(x.direction),defaultVatAccount(x.direction),invoiceBusinessKey(x.invoice_no,x.voen,x.direction),rate,round2(x.total_amount*rate));
        const id=Number(r.lastInsertRowid);
        db.prepare(`UPDATE invoices SET direction_source=?,direction_confidence=? WHERE id=?`).run(directionSource,directionConfidence,id);
        const posting=importedPostingAccount(x);
        const desc=x.main_note || x.invoice_type_name || (x.direction==='Gələn'?'İdxal edilmiş e-qaimə':'İdxal edilmiş satış qaiməsi');
        insertItems(id,[{item_code:'',item_type:posting.itemType,description:desc,qty:1,unit:posting.itemType==='Xidmət'?'xidmət':'ədəd',unit_price:x.base_amount,discount_rate:0,vat_rate:x.vat_rate,base_amount:x.base_amount,vat_amount:x.vat_amount,total_amount:x.total_amount,posting_account_code:posting.account,subkonto_id:posting.subkontoId,warehouse_id:posting.warehouseId,posting_rule_id:posting.postingRuleId,accounting_review_required:posting.needsReview}]);
        db.prepare(`UPDATE invoices SET accounting_review_required=?,accounting_review_reason=? WHERE id=?`).run(posting.needsReview?1:0,posting.needsReview?'İdxal sətrinin mal/xidmət təsnifatı məlumat kitabçasında dəqiqləşdirilməlidir.':'',id);
        recordStatusTransition(id,null,'Təsdiqlənib',`Sənəd ${source} mənbəyindən idxal edildi və avtomatik uçota alındı`);
        const journal=createInvoicePosting(id);
        inventoryScopes.push(...journal.scopes);
        audit('Qaimə idxal edildi və avtomatik uçota alındı','E-Qaimə',id,null,{source,sourceFile,journal_entry_id:journal.journalEntryId,...x});
        result.created++;result.posted++;
      } catch(e) {
        db.exec('ROLLBACK TO import_row');
        result.failed++;if(result.errors.length<20)result.errors.push(String(e.message||e));
        db.prepare(`INSERT INTO import_rejections(import_type,source_name,row_number,raw_json,error_message,created_at) VALUES('invoice',?,?,?,?,?)`).run(sourceFile||source,rowIndex+1,JSON.stringify(raw),String(e.message||e),nowIso());
      } finally {
        db.exec('RELEASE import_row');
      }
    }
    // A trusted DVX/file import is an accounting source document and must not
    // disappear because one imported sale predates its warehouse opening
    // balance. Post every valid invoice, rebuild inventory, and mark any
    // shortage for review. Interactive manual entries still respect each
    // warehouse's negative-stock policy and can be blocked before saving.
    rebuildInventoryScopes(inventoryScopes,{strictNegativeStock:false});
    db.exec('COMMIT');
  } catch(e) { try{db.exec('ROLLBACK')}catch(_){}; throw e; }
  return result;
}

function openLiveTaxPortal(direction='Gələn') {
  liveTaxDirection = direction==='Gedən'?'Gedən':'Gələn';
  if (liveTaxWindow && !liveTaxWindow.isDestroyed()) { liveTaxDirection=direction==='Gedən'?'Gedən':'Gələn'; liveTaxWindow.focus(); navigateLiveTaxInvoices(liveTaxDirection).catch(()=>{}); return {opened:true,reused:true,direction:liveTaxDirection}; }

  liveTaxWindow=new BrowserWindow({
    width:1280,height:900,
    title:`Meyar ERP — DVX Canlı E-Qaimə (${liveTaxDirection})`,
    backgroundColor:'#eef2f6',
    webPreferences:{
      preload:path.join(__dirname,'live-preload.js'),
      contextIsolation:true,
      nodeIntegration:false,
      sandbox:true,
      partition:'persist:meyar-dvx'
    }
  });

  // The current DVX portal uses the /etaxes/ application route. Loading the
  // application directly is more reliable than loading the domain root and
  // waiting for a redirect.
  // DVX is an SPA and some menu entries (including E-Qaimə) may use
  // target=\"_blank\" / window.open(). Electron would otherwise create a
  // second BrowserWindow, which is exactly the 2nd/3rd-window problem.
  // Keep the entire DVX journey inside the same liveTaxWindow.
  const allowedTaxUrl=(value)=>{try{const parsed=new URL(value);return parsed.protocol==='https:'&&['new.e-taxes.gov.az','e-taxes.gov.az','www.e-taxes.gov.az'].includes(parsed.hostname.toLowerCase())?parsed.href:''}catch(_){return ''}};
  liveTaxWindow.webContents.setWindowOpenHandler(({url}) => {
    let safeUrl='';
    safeUrl=allowedTaxUrl(url);
    if (safeUrl) {
      setImmediate(() => {
        if (liveTaxWindow && !liveTaxWindow.isDestroyed()) liveTaxWindow.loadURL(safeUrl);
      });
    }
    return { action: 'deny' };
  });

  liveTaxWindow.webContents.on('did-create-window', (childWindow) => {
    // Safety net for Electron/Chromium paths that still surface a child window.
    try {
      childWindow.close();
    } catch (_) {}
  });
  liveTaxWindow.webContents.on('will-navigate',(event,url)=>{if(!allowedTaxUrl(url))event.preventDefault();});

  liveTaxWindow.loadURL('https://new.e-taxes.gov.az/etaxes/');
  liveTaxWindow.on('closed',()=>{liveTaxWindow=null;});
  return {opened:true};
}

async function navigateLiveTaxInvoices(direction='AUTO') {
  if(!liveTaxWindow || liveTaxWindow.isDestroyed()) throw new Error('DVX canlı pəncərəsi açıq deyil.');
  const target = direction==='Gedən' ? 'Gedən' : direction==='Gələn' ? 'Gələn' : liveTaxDirection;
  return liveTaxWindow.webContents.executeJavaScript(`(async()=>{
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const norm=s=>String(s||'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
    const low=s=>norm(s).toLowerCase();
    const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect?.();const st=getComputedStyle(el);return !!r&&r.width>0&&r.height>0&&st.display!=='none'&&st.visibility!=='hidden'};
    const deep=()=>{const out=[];const walk=r=>{for(const el of r.querySelectorAll?.('*')||[]){out.push(el);if(el.shadowRoot)walk(el.shadowRoot)}};walk(document);return out};
    const text=el=>norm(el?.innerText||el?.textContent||el?.getAttribute?.('aria-label')||el?.title||'');
    const clickable=el=>{const tag=(el.tagName||'').toLowerCase(),role=low(el.getAttribute?.('role')||'');return ['a','button','li','mat-tab','mat-list-item'].includes(tag)||['button','tab','menuitem','link'].includes(role)||el.onclick};
    const clickBest=(names)=>{const ns=names.map(low);let best=null,score=-1;for(const el of deep()){if(!visible(el)||!clickable(el))continue;const t=low(text(el));if(!t||t.length>140)continue;for(const n of ns){let s=t===n?100:t.includes(n)?70:-1;if(s<0)continue;if(t.length<n.length+25)s+=10;if(['button','a'].includes((el.tagName||'').toLowerCase()))s+=4;if(s>score){best=el;score=s}}}if(best){best.scrollIntoView({block:'center'});best.click();return text(best)}return ''};
    const wanted=${JSON.stringify(target==='Gələn'?['Gələnlər','Gələn']:['Göndərilənlər','Göndərdiklərim','Göndərilənlər / Qaimələr'])};
    const nav=clickBest(['Elektron qaimə-fakturalar','Elektron qaimələr','E-Qaimə','Qaimələr']);
    await sleep(1200);
    let folder=clickBest(wanted);
    if(!folder){clickBest(['Filtr']);await sleep(600);folder=clickBest(wanted)}
    await sleep(1800);
    return {ok:true,navigation:nav,folder,url:location.href,title:document.title,body:norm(document.body?.innerText||'').slice(0,5000)};
  })()`);
}

async function extractLiveTaxInvoices() {
  if(!liveTaxWindow || liveTaxWindow.isDestroyed()) throw new Error('DVX canlı pəncərəsi açıq deyil.');
  await new Promise(r=>setTimeout(r,900));

  // Keep DOM inspection bounded. The previous version walked every element and
  // inspected each parent repeatedly; on a large DVX list this could lock the
  // renderer. We now collect only likely rows/cards and cap the work.
  const page=await liveTaxWindow.webContents.executeJavaScript(`(()=>{
    const norm=s=>String(s||'').replace(/\\u00a0/g,' ').replace(/\\u200b/g,' ').replace(/\\s+/g,' ').trim();
    const text=el=>norm(el?.innerText||el?.textContent||el?.getAttribute?.('aria-label')||el?.title||'');
    const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect?.();const st=getComputedStyle(el);return !!r&&r.width>0&&r.height>0&&st.display!=='none'&&st.visibility!=='hidden'&&st.opacity!=='0'};
    const all=(sel)=>Array.from(document.querySelectorAll(sel));
    const rows=[];
    const push=(headers,cells,source)=>{
      const h=headers.map(text).filter(Boolean), c=cells.map(text).filter(Boolean), joined=c.join(' | ');
      if(c.length<2||joined.length>2600)return;
      if(!/\\b\\d{10}\\b/.test(joined.replace(/[^0-9 ]/g,' ')))return;
      if(!/(qaim|faktura|seriya|yekun|\\bMT\\d{6,}|\\d{4,})/i.test(joined))return;
      rows.push({headers:h,cells:c,source});
    };

    // Standard/virtual grids.
    for(const table of all('table')){
      if(!visible(table))continue;
      let hs=all('thead th, thead td').filter(x=>table.contains(x)).map(text).filter(Boolean);
      if(!hs.length){const tr=table.querySelector(':scope > tr, thead tr');if(tr)hs=Array.from(tr.children).map(text).filter(Boolean)}
      for(const tr of Array.from(table.querySelectorAll('tbody tr'))){if(visible(tr))push(hs,Array.from(tr.children),'table');if(rows.length>=3000)break;}
      if(rows.length>=3000)break;
    }
    if(rows.length<3000){
      const gridRows=all('[role="row"], .mat-row, .cdk-row, .ag-row, .p-datatable-tbody tr').slice(0,4000);
      for(const row of gridRows){
        if(!visible(row))continue;
        const cells=Array.from(row.querySelectorAll('[role="gridcell"],[role="cell"],.mat-cell,.cdk-cell,.ag-cell,[col-id],td')).map(text).filter(Boolean);
        if(cells.length)push([],cells,'grid');
        if(rows.length>=3000)break;
      }
    }

    // DVX's current invoice list is card/list based. Only inspect likely item
    // containers rather than every descendant in the DOM.
    const cardNodes=all('article,li,[role="listitem"],mat-list-item,.mat-mdc-list-item,[class*="invoice"],[class*="qaime"],[class*="card"]')
      .filter(visible).slice(0,5000);
    const seenCard=new Set();
    for(const el of cardNodes){
      const t=text(el);
      if(t.length<45||t.length>2200)continue;
      if(!/\\b\\d{10}\\b/.test(t)||!/(seriya\\s+v[əe]\\s+n[öo]mr[əe]|qaim[əe]\\s*(?:n[öo]mr[əe]|no))/i.test(t))continue;
      if(!/(yekun\\s+m[əe]bl[əe]ğ|\\bAZN\\b|₼)/i.test(t))continue;
      const key=t.slice(0,700);
      if(seenCard.has(key))continue; seenCard.add(key);
      push([],t.split(/\\n+/).map(x=>norm(x)).filter(Boolean),'card');
      if(rows.length>=3000)break;
    }

    // Active folder detection: only elements that actually carry an active/
    // selected/current state are evidence. The sidebar often contains BOTH
    // Gələnlər and Göndərilənlər, so plain labels are deliberately ignored.
    const activeCandidates=all('a,button,[role="tab"],[role="menuitem"],[aria-current],[aria-selected],[data-state],mat-tab,.mat-tab-label,.mat-mdc-tab')
      .filter(visible)
      .filter(el=>{
        const aria=String(el.getAttribute('aria-selected')||'').toLowerCase()==='true' ||
                   String(el.getAttribute('aria-current')||'').toLowerCase()==='page' ||
                   String(el.getAttribute('data-state')||'').toLowerCase()==='active';
        const cl=String(el.className||'');
        return aria || /(^|[\\s_-])(active|selected|highlight|mat-tab-label-active|mdc-tab--active|p-highlight)([\\s_-]|$)/i.test(cl);
      });
    const directionEvidence=[];
    const toDir=v=>{const x=norm(v).toLowerCase().replace(/ə/g,'e').replace(/ı/g,'i').replace(/ö/g,'o').replace(/ü/g,'u').replace(/ğ/g,'g').replace(/ç/g,'c').replace(/ş/g,'s');
      if(/(^|\\b)(gonderilen(?:ler)?|gonderdiklerim|gonderilmis|sent|outgoing)(\\b|$)/i.test(x))return 'Gedən';
      if(/(^|\\b)(gelen(?:ler)?|daxil olan|alinan|received|incoming)(\\b|$)/i.test(x))return 'Gələn';
      return '';
    };
    const activeTexts=activeCandidates.map(text).filter(x=>x.length<180);
    for(const t of activeTexts){const d=toDir(t);if(d)directionEvidence.push(d)}
    // Also use URL only when it contains a real route hint.
    const url=location.href;
    const routeDir=/\\b(sent|outgoing|gonder|gonderilen)\\b/i.test(url)?'Gedən':/\\b(received|incoming|gelen|daxil)\\b/i.test(url)?'Gələn':'';
    if(routeDir)directionEvidence.push(routeDir);
    const activeTab=activeTexts.find(t=>toDir(t))||'';
    const headings=all('h1,h2,h3,[aria-current="page"]').filter(visible).map(text).filter(Boolean).slice(0,20);
    const heading=headings.find(t=>toDir(t))||headings[0]||'';
    const bodyText=norm(document.body?.innerText||'');
    return {url,title:document.title,bodyText:bodyText.slice(0,12000),rows:rows.slice(0,3000),activeTab,heading,activeControls:activeTexts.slice(0,50),directionEvidence};
  })()`);

  const normText=s=>String(s||'').toLowerCase().replace(/ə/g,'e').replace(/ı/g,'i').replace(/ö/g,'o').replace(/ü/g,'u').replace(/ğ/g,'g').replace(/ç/g,'c').replace(/ş/g,'s');
  const nh=s=>normText(s).replace(/[^a-z0-9]+/g,' ').trim();
  const field=(h,c,ps)=>{for(let i=0;i<h.length;i++){const x=nh(h[i]);if(ps.some(p=>x===nh(p)||x.includes(nh(p))))return c[i]||''}return ''};
  const autoDirection=detectLiveTaxDirection(page,liveTaxDirection);
  const records=[];
  const parseCard=(cells)=>{
    const one=cells.join('\n').replace(/\u00a0/g,' ').replace(/[ \t]+/g,' ').trim(); const out={}; let m;
    m=one.match(/(^|\n)\s*(\d{10})\s*\/\s*(.+?)(?=\s*(?:\||\n|Seriya\s+v[əe]\s+n[öo]mr[əe]|Qaim[əe]\s*(?:n[öo]mr[əe]si|no)|Yekun\s+m[əe]bl[əe]ğ|ƏDV\s+m[əe]bl[əe]ğ|N[öo]v[üu]\s*:|Sistem\s+t[əe]r[əe]find[əe]n)|$)/im); if(m){out.voen=m[2];out.counterparty_name=sanitizeCounterpartyName(m[3]);}
    m=one.match(/Seriya\s*v[əe]\s*n[öo]mr[əe]\s*:\s*([^|\n]+)/i); if(m)out.invoice_no=m[1].trim();
    m=one.match(/(?:Qaim[əe]\s*(?:n[öo]mr[əe]si|no)|Invoice\s*(?:No|Number))\s*[:#]?\s*([^|\n]+)/i); if(!out.invoice_no&&m)out.invoice_no=m[1].trim();
    m=one.match(/(\d{1,2}[./-]\d{1,2}[./-]\d{4})\s+\d{1,2}:\d{2}(?::\d{2})?/); if(m)out.invoice_date=m[1];
    m=one.match(/Yekun\s*m[əe]bl[əe]ğ\s*:\s*([^|\n]+)/i); if(m)out.total_amount=m[1].trim();
    m=one.match(/ƏDV\s*m[əe]bl[əe]ğ\s*:\s*([^|\n]+)/i); if(m)out.vat_amount=m[1].trim();
    m=one.match(/N[öo]v[üu]\s*:\s*([^\n]+)/i); if(m)out.invoice_type_name=m[1].trim();
    m=one.match(/(Sistem\s*t[əe]r[əe]find[əe]n\s*t[əe]sdiql[əe]ndi|status\s*:\s*[^\n|]+)/i); if(m)out.status=m[0];
    m=one.match(/(?:Əsas|S[əe]b[əe]b)\s*:\s*([^\n]+)/i); if(m)out.note=m[1].trim(); return out;
  };
  for(const row of page.rows||[]){
    const h=row.headers||[],c=row.cells||[],card=parseCard(c);
    let invoice_no=card.invoice_no||field(h,c,['qaimə nömrəsi','qaimə nomrəsi','seriya və nömrəsi','nömrə','invoice no']);
    let series=field(h,c,['qaimə seriyası','seriya']);
    let voen=card.voen||field(h,c,['vöen','vergi ödəyicisi','tin']);
    let name=sanitizeCounterpartyName(card.counterparty_name||field(h,c,['ödəyici adı','alıcı adı','satıcı adı','kontragent','ad']));
    let date=card.invoice_date||field(h,c,['qaimə tarixi','tarix','date']);
    let base=field(h,c,['malın edv siz ümumi dəyəri','malin edv siz umumi deyeri','əsas məbləğ','vergi tutulan','base']);
    let vat=card.vat_amount||field(h,c,['malın edv məbləği','edv məbləği','vat']);
    let total=card.total_amount||field(h,c,['yekun məbləğ','yekun','ümumi məbləğ','total']);
    let status=card.status||field(h,c,['vəziyyəti','status']);
    if(!voen)voen=c.find(x=>/^\s*\d{10}\s*$/.test(String(x).replace(/[^0-9]/g,'')))||'';
    if(!invoice_no)invoice_no=c.find(x=>/^[A-ZƏÖÜĞÇŞİ]{0,8}[\s-]*\d{4,}$/i.test(String(x).trim())||/^MT\d{8,}$/i.test(String(x).trim()))||'';
    if(!date)date=c.find(x=>/^(?:\d{1,2}[.\/-]){2}\d{2,4}$/.test(String(x).trim())||/^\d{4}[.\/-]\d{1,2}[.\/-]\d{1,2}$/.test(String(x).trim()))||'';
    if(!name)name=sanitizeCounterpartyName(c.find(x=>{const v=String(x).trim();return v.length>3&&!/^[-+]?\d[\d\s.,]*$/.test(v)&&v!==invoice_no&&v!==voen})||'');
    if(!total){const nums=c.filter(x=>/\d[\d\s.,]*\s*(?:₼|AZN)?$/i.test(String(x).trim()));total=nums.length?nums[nums.length-1]:'';}
    if(!base&&total){const tv=numberValue(total),vv=numberValue(vat);base=vv>0?Math.max(0,tv-vv):total;}
    if(invoice_no&&name&&/^\d{10}$/.test(String(voen).replace(/\D/g,''))){
      records.push({invoice_no,invoice_series:series,voen:String(voen).replace(/\D/g,''),counterparty_name:name,invoice_date:date,base_amount:base,vat_amount:vat,total_amount:total,status,direction:autoDirection,invoice_type_name:card.invoice_type_name||'',main_note:card.note||''});
    }
  }
  const unique=[],seen=new Set();
  for(const r of records){const k=`${String(r.invoice_no).trim().toUpperCase()}|${String(r.voen).replace(/\D/g,'')}|${r.direction}`;if(!seen.has(k)){seen.add(k);unique.push(r)}}
  if(!unique.length){const hint=/login|giri[şs]|imza|asan|sima/i.test(page.bodyText||'')?' DVX sessiyasına giriş tamamlanmayıb.':'';return {ok:false,message:`DVX qaimə siyahısından oxuna bilən sətir tapılmadı.${hint} “Gələnlər” və ya “Göndərilənlər” bölməsini açın və siyahı göründükdən sonra yenidən cəhd edin.`,url:page.url,candidates:(page.rows||[]).length,direction:autoDirection};}
  // Safety: if the active-folder evidence explicitly contradicts the window
  // direction, never silently move records to the wrong register.
  const evidenceDir=detectLiveTaxDirection(page,'');
  if(evidenceDir && evidenceDir!==autoDirection && page.activeTab){
    throw new Error(`DVX qovluğu ${evidenceDir} kimi tanındı, lakin idxal istiqaməti ${autoDirection} idi. Səhv qovluğa yazılmasının qarşısı alındı.`);
  }
  const result=importInvoiceRecords(unique,'live-dvx',page.url,autoDirection,{
    trustedDirection:!!evidenceDir,
    directionSource:evidenceDir?'DVX aktiv qovluğu':'İstifadəçinin açdığı DVX istiqaməti',
    directionConfidence:evidenceDir?'high':'confirmed'
  });
  result.ok=true;
  result.sourceAvailable=true;
  result.sourceKind='live';
  result.candidates=unique.length;
  result.direction=autoDirection;
  result.detectedControls=page.activeControls||[];
  db.prepare(`UPDATE dvx_integration SET last_sync_at=?,last_sync_result=?,updated_at=? WHERE id=1`)
    .run(nowIso(),JSON.stringify(safePlain(result)),nowIso());
  recordIntegrationSyncRun('invoice',autoDirection,'live',unique.length,result);
  audit('Canlı DVX sinxronizasiyası','E-Qaimə',null,null,{candidateRows:unique.length,...result,url:page.url,direction:autoDirection,requestedDirection:liveTaxDirection});
  notifyMainDataRefresh({resource:'invoice',direction:autoDirection,...result});
  return result;
}

function decodeXmlText(value='') {
  return String(value).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&').trim();
}

function xmlRows(xml='') {
  const source=String(xml||'');
  const blocks=[...source.matchAll(/<(?:row|record|invoice|qaim[eə])\b[^>]*>([\s\S]*?)<\/(?:row|record|invoice|qaim[eə])>/gi)].map(x=>x[1]);
  const candidates=blocks.length?blocks:[source];
  return candidates.map(block=>{
    const row={};
    for(const match of block.matchAll(/<([A-Za-z_][\w:.-]*)\b[^>]*>([^<]*(?:<!\[CDATA\[[\s\S]*?\]\]>[^<]*)?)<\/\1>/g)){
      const key=match[1].split(':').pop();
      const value=decodeXmlText(match[2]);
      if(value && row[key]===undefined) row[key]=value;
    }
    return row;
  }).filter(row=>Object.keys(row).length);
}

function findImportHeaderRow(matrix=[]) {
  const limit=Math.min(matrix.length,60);
  for (let index=0;index<limit;index++) {
    const cells=(Array.isArray(matrix[index])?matrix[index]:[]).map(normalizeImportText);
    const joined=cells.join(' ');
    const hasVoen=cells.some(x=>x==='voen'||x.includes('voen')||x==='tin'||x.includes('vergi odeyicisinin eynilesdirme'));
    const hasInvoice=(joined.includes('qaime') && /(nomre|seriya|number| no )/.test(` ${joined} `)) || /invoice (no|number)/.test(joined);
    if (hasVoen && hasInvoice) return index;
  }
  return -1;
}

function resolveImportDirectionEvidence({fileName='',sheetName='',titleText='',records=[]}={}) {
  const stats={incoming:0,outgoing:0,unknown:0};
  for (const row of records) {
    const d=rawInvoiceDirection(row);
    if (d==='Gələn') stats.incoming++;
    else if (d==='Gedən') stats.outgoing++;
    else stats.unknown++;
  }
  if (stats.incoming>0 && stats.outgoing>0 && stats.unknown===0) {
    return {direction:'',directionSource:'Sətirlərdə qarışıq istiqamət',directionConfidence:'high',mixed:true,requiresConfirmation:false,stats};
  }
  const candidates=[];
  const add=(value,source,confidence='high')=>{const direction=directionFromEvidenceText(value);if(direction)candidates.push({direction,source,confidence})};
  if (stats.incoming>0 && stats.outgoing===0) candidates.push({direction:'Gələn',source:'Sətirdə istiqamət sütunu',confidence:'high'});
  if (stats.outgoing>0 && stats.incoming===0) candidates.push({direction:'Gedən',source:'Sətirdə istiqamət sütunu',confidence:'high'});
  add(titleText,'DVX çıxarışının başlığı');
  add(sheetName,'Excel vərəqinin adı');
  add(fileName,'Fayl adı','medium');
  const unique=[...new Set(candidates.map(x=>x.direction))];
  if (unique.length>1) {
    return {direction:'',directionSource:'Mənbələr ziddiyyətlidir',directionConfidence:'none',mixed:stats.incoming>0&&stats.outgoing>0,requiresConfirmation:true,stats,candidates};
  }
  if (unique.length===1) {
    const chosen=candidates.find(x=>x.direction===unique[0]);
    return {direction:unique[0],directionSource:chosen.source,directionConfidence:chosen.confidence,mixed:false,requiresConfirmation:false,stats,candidates};
  }
  return {direction:'',directionSource:'İstiqamət sübutu tapılmadı',directionConfidence:'none',mixed:false,requiresConfirmation:true,stats,candidates:[]};
}

function countUnquotedDelimiter(text,delimiter) {
  let quoted=false,count=0;
  for(let index=0;index<text.length;index++){
    const character=text[index];
    if(character==='"'){
      if(quoted&&text[index+1]==='"'){index++;continue;}
      quoted=!quoted;
    }else if(!quoted&&character===delimiter){count++;}
  }
  return count;
}

function detectDelimitedSeparator(text,extension) {
  if(extension==='.tsv')return '\t';
  const sample=String(text||'').slice(0,16384);
  const candidates=['\t',';',','].map(delimiter=>({delimiter,count:countUnquotedDelimiter(sample,delimiter)}));
  candidates.sort((left,right)=>right.count-left.count);
  return candidates[0].count>0?candidates[0].delimiter:(extension==='.csv'?';':'\t');
}

function parseDelimitedMatrix(text,delimiter) {
  const rows=[];
  let row=[],cell='',quoted=false;
  const source=String(text||'').replace(/^\uFEFF/,'');
  for(let index=0;index<source.length;index++){
    const character=source[index];
    if(character==='"'){
      if(quoted&&source[index+1]==='"'){cell+='"';index++;}
      else quoted=!quoted;
      continue;
    }
    if(!quoted&&character===delimiter){row.push(cell);cell='';continue;}
    if(!quoted&&(character==='\n'||character==='\r')){
      if(character==='\r'&&source[index+1]==='\n')index++;
      row.push(cell);cell='';
      if(row.some(value=>String(value).trim()!==''))rows.push(row);
      row=[];
      continue;
    }
    cell+=character;
  }
  row.push(cell);
  if(row.some(value=>String(value).trim()!==''))rows.push(row);
  return rows;
}

function recordsFromDelimitedMatrix(matrix,headerRow) {
  if(!matrix.length)return [];
  const start=headerRow>=0?headerRow:0;
  const usedHeaders=new Map();
  const headers=(matrix[start]||[]).map((value,index)=>{
    const base=String(value||'').trim()||`Sütun ${index+1}`;
    const occurrence=(usedHeaders.get(base)||0)+1;
    usedHeaders.set(base,occurrence);
    return occurrence===1?base:`${base} ${occurrence}`;
  });
  return matrix.slice(start+1).map(values=>{
    const record={};
    headers.forEach((header,index)=>{record[header]=String(values[index]??'').trim();});
    return record;
  }).filter(record=>Object.values(record).some(value=>String(value).trim()!==''));
}

function readImportRecords(filePath) {
  const fileStat=fs.statSync(filePath);
  if(!fileStat.isFile())throw new Error('İdxal mənbəyi adi fayl deyil.');
  if(fileStat.size>MAX_IMPORT_FILE_BYTES)throw new Error('İdxal faylı 100 MB limitini keçir. Faylı hissələrə bölün.');
  const ext=path.extname(filePath).toLowerCase();
  const fileName=path.basename(filePath);
  if(ext==='.json'){
    const parsed=JSON.parse(fs.readFileSync(filePath,'utf8').replace(/^\uFEFF/,''));
    const rows=Array.isArray(parsed)?parsed:(parsed.rows||parsed.data||parsed.invoices||parsed.transactions||[]);
    if(!Array.isArray(rows)) throw new Error('JSON faylında sətir massivi tapılmadı.');
    const titleText=Array.isArray(parsed)?'':[parsed.title,parsed.name,parsed.folder,parsed.direction].filter(Boolean).join(' ');
    return {records:rows,meta:resolveImportDirectionEvidence({fileName,titleText,records:rows})};
  }
  if(ext==='.xml') {
    const xml=fs.readFileSync(filePath,'utf8').replace(/^\uFEFF/,'');
    const rows=xmlRows(xml);
    const titleText=(xml.match(/<(?:title|direction|folder)[^>]*>([\s\S]*?)<\//i)||[])[1]||'';
    return {records:rows,meta:resolveImportDirectionEvidence({fileName,titleText,records:rows})};
  }
  if(!['.xlsx','.xls','.csv','.txt','.tsv'].includes(ext)) throw new Error(`Dəstəklənməyən fayl formatı: ${ext||'naməlum'}.`);
  if(['.csv','.txt','.tsv'].includes(ext)){
    const text=fs.readFileSync(filePath,'utf8');
    const separator=detectDelimitedSeparator(text,ext);
    const matrix=parseDelimitedMatrix(text,separator);
    const headerRow=findImportHeaderRow(matrix);
    const titleLimit=headerRow>=0?headerRow:Math.min(matrix.length,15);
    const titleText=matrix.slice(0,titleLimit).flat().map(value=>String(value||'').trim()).filter(Boolean).join(' ');
    const records=recordsFromDelimitedMatrix(matrix,headerRow);
    return {records,meta:resolveImportDirectionEvidence({fileName,titleText,records})};
  }
  let XLSX;
  try { XLSX=require('xlsx'); } catch (_) { throw new Error('XLSX oxuma modulu quraşdırılmayıb. Layihə qovluğunda npm install icra edin.'); }
  const workbook=XLSX.readFile(filePath,{cellDates:true,raw:false});
  const sheetName=workbook.SheetNames[0];
  if(!sheetName) return {records:[],meta:resolveImportDirectionEvidence({fileName})};
  const sheet=workbook.Sheets[sheetName];
  const matrix=XLSX.utils.sheet_to_json(sheet,{header:1,defval:'',raw:false,dateNF:'yyyy-mm-dd'});
  const headerRow=findImportHeaderRow(matrix);
  const titleLimit=headerRow>=0?headerRow:Math.min(matrix.length,15);
  const titleText=matrix.slice(0,titleLimit).flat().map(v=>String(v||'').trim()).filter(Boolean).join(' ');
  const records=XLSX.utils.sheet_to_json(sheet,{range:headerRow>=0?headerRow:0,defval:'',raw:false,dateNF:'yyyy-mm-dd'})
    .filter(row=>Object.values(row).some(value=>String(value??'').trim()!==''));
  return {records,meta:resolveImportDirectionEvidence({fileName,sheetName,titleText,records})};
}

async function chooseAndImportInvoiceFile(direction='Gələn') {
  const picked=await dialog.showOpenDialog({title:`${direction} e-qaimə çıxarışını seçin`,properties:['openFile'],filters:[
    {name:'Qaimə çıxarışları',extensions:['xlsx','xls','csv','tsv','xml','json','txt']},
    {name:'Bütün fayllar',extensions:['*']}
  ]});
  if(picked.canceled||!picked.filePaths[0]) return {cancelled:true};
  const filePath=picked.filePaths[0],fileName=path.basename(filePath);
  const parsed=readImportRecords(filePath),records=parsed.records,meta=parsed.meta;
  if(!records.length) throw new Error('Seçilmiş çıxarışda oxuna bilən məlumat sətri tapılmadı.');
  let importDirection=meta.direction;
  let directionSource=meta.directionSource;
  let directionConfidence=meta.directionConfidence;
  if (meta.requiresConfirmation) {
    const choice=await dialog.showMessageBox({
      type:'question',title:'Qaimələrin istiqamətini təsdiqləyin',
      message:meta.directionSource==='Mənbələr ziddiyyətlidir'
        ? 'Fayldakı istiqamət məlumatları bir-biri ilə uyğun gəlmir.'
        : 'Bu faylın Gələn və ya Gedən olduğu avtomatik müəyyən edilmədi.',
      detail:`${fileName}\n\nQaimələrin səhv bölməyə düşməməsi üçün istiqaməti təsdiqləyin. Açıq pəncərə avtomatik mənbə hesab edilmir.`,
      buttons:['Gələn qaimələr','Göndərilən qaimələr','Ləğv et'],
      defaultId:direction==='Gedən'?1:0,cancelId:2,noLink:true
    });
    if (choice.response===2) return {cancelled:true};
    importDirection=choice.response===1?'Gedən':'Gələn';
    directionSource='İstifadəçi təsdiqi';
    directionConfidence='confirmed';
  }
  const trustedDirection=meta.mixed || ['high','medium','confirmed'].includes(directionConfidence);
  if(meta.mixed&&!meta.requiresConfirmation){
    const aggregate={created:0,posted:0,reclassified:0,duplicates:0,skippedExisting:0,review:0,failed:0,errors:[],warnings:[]};
    for(const configuredDirection of ['Gələn','Gedən']){
      const directionRecords=records.filter(record=>rawInvoiceDirection(record)===configuredDirection);
      const directionResult=importInvoiceRecords(directionRecords,'file-import',fileName,configuredDirection,{trustedDirection:true,directionSource:'Sətirdə istiqamət sütunu',directionConfidence:'high'});
      for(const counter of ['created','posted','reclassified','duplicates','skippedExisting','review','failed']) aggregate[counter]+=Number(directionResult[counter]||0);
      aggregate.errors.push(...directionResult.errors.slice(0,Math.max(0,20-aggregate.errors.length)));
      aggregate.warnings.push(...directionResult.warnings.slice(0,Math.max(0,20-aggregate.warnings.length)));
      saveIntegrationSyncSource('invoice',configuredDirection,'file',filePath,directionResult);
      recordIntegrationSyncRun('invoice',configuredDirection,'file',directionRecords.length,directionResult);
    }
    return {cancelled:false,fileName,rows:records.length,detectedDirection:'Qarışıq',directionSource:'Sətirdə istiqamət sütunu',...aggregate};
  }
  const result=importInvoiceRecords(records,'file-import',fileName,importDirection,{trustedDirection,directionSource,directionConfidence});
  saveIntegrationSyncSource('invoice',importDirection,'file',filePath,result);
  recordIntegrationSyncRun('invoice',importDirection,'file',records.length,result);
  return {cancelled:false,fileName,rows:records.length,detectedDirection:meta.mixed?'Qarışıq':importDirection,directionSource,...result};
}

async function refreshInvoicesFromConfiguredSource(direction='Gələn') {
  const normalizedDirection=direction==='Gedən'?'Gedən':'Gələn';
  if(liveTaxWindow && !liveTaxWindow.isDestroyed()){
    liveTaxDirection=normalizedDirection;
    await navigateLiveTaxInvoices(normalizedDirection);
    return extractLiveTaxInvoices();
  }
  const configuredSource=integrationSyncSource('invoice',normalizedDirection);
  if(!configuredSource?.source_path){
    return {sourceAvailable:false,sourceKind:'none',direction:normalizedDirection,created:0,duplicates:0,skippedExisting:0,failed:0};
  }
  if(!fs.existsSync(configuredSource.source_path)){
    return {sourceAvailable:false,sourceKind:'file',direction:normalizedDirection,created:0,duplicates:0,skippedExisting:0,failed:0,message:'Əvvəlki idxal faylı artıq həmin ünvanda deyil.'};
  }
  const sourceFilePath=configuredSource.source_path;
  const sourceFileName=path.basename(sourceFilePath);
  const parsedSource=readImportRecords(sourceFilePath);
  if(!parsedSource.records.length) throw new Error('Sinxronizasiya mənbəyində oxuna bilən qaimə sətri tapılmadı.');
  if(!parsedSource.meta.mixed && parsedSource.meta.direction && parsedSource.meta.direction!==normalizedDirection){
    throw new Error(`Sinxronizasiya faylı ${parsedSource.meta.direction} qaimələrə aiddir; ${normalizedDirection} reyestrinə işlənmədi.`);
  }
  const recordsForDirection=parsedSource.meta.mixed
    ?parsedSource.records.filter(record=>rawInvoiceDirection(record)===normalizedDirection)
    :parsedSource.records;
  if(!recordsForDirection.length){
    const emptyResult={created:0,duplicates:0,skippedExisting:0,failed:0};
    saveIntegrationSyncSource('invoice',normalizedDirection,'file',sourceFilePath,emptyResult);
    recordIntegrationSyncRun('invoice',normalizedDirection,'file',0,emptyResult);
    return {sourceAvailable:true,sourceKind:'file',direction:normalizedDirection,candidates:0,...emptyResult};
  }
  const result=importInvoiceRecords(recordsForDirection,'file-import',sourceFileName,normalizedDirection,{
    // The source was explicitly selected and assigned to this register during
    // its first import. Refresh may therefore reuse that stored assignment.
    trustedDirection:true,
    directionSource:parsedSource.meta.directionSource||'Əvvəl təsdiqlənmiş sinxronizasiya mənbəyi',
    directionConfidence:parsedSource.meta.directionConfidence||'confirmed'
  });
  saveIntegrationSyncSource('invoice',normalizedDirection,'file',sourceFilePath,result);
  recordIntegrationSyncRun('invoice',normalizedDirection,'file',recordsForDirection.length,result);
  notifyMainDataRefresh({resource:'invoice',direction:normalizedDirection,...result});
  return {sourceAvailable:true,sourceKind:'file',direction:normalizedDirection,candidates:recordsForDirection.length,...result};
}

function bankRecordFromRaw(raw,fileName='') {
  const value=(keys)=>pick(raw,keys);
  return {
    date:normalizeDateValue(value(['transaction_date','Əməliyyat tarixi','Tarix','Date','Operation date'])),
    value_date:normalizeDateValue(value(['value_date','Valyuta tarixi','Dəyər tarixi','Value date'])),
    direction:value(['direction','İstiqamət','Əməliyyat növü','Type']),
    amount:value(['amount','Məbləğ','Amount']),
    debit:value(['debit','Debet','Məxaric','Çıxış']),
    credit:value(['credit','Kredit','Mədaxil','Daxilolma']),
    currency:value(['currency','Valyuta','Currency']),
    counterparty_name:value(['counterparty_name','Kontragent','Qarşı tərəf','Benefisiar','Ödəyici','Ad']),
    counterparty_voen:value(['counterparty_voen','VÖEN','VOEN','TIN']),
    description:value(['description','Təyinat','Ödənişin təyinatı','Açıqlama','Purpose']),
    reference:value(['reference','Referans','Sənəd №','Document no','Tranzaksiya №']),
    external_id:value(['external_id','Əməliyyat ID','Transaction ID','Tranzaksiya ID']),
    balance_after:value(['balance_after','Son qalıq','Balans','Balance']),
    source:`bank-file:${fileName}`
  };
}

async function chooseAndImportBankFile(accountId) {
  if(!db.prepare(`SELECT id FROM bank_accounts WHERE id=? AND active=1`).get(Number(accountId))) throw new Error('Əvvəlcə aktiv bank hesabı seçin.');
  const picked=await dialog.showOpenDialog({title:'Bank çıxarışını seçin',properties:['openFile'],filters:[
    {name:'Bank çıxarışları',extensions:['xlsx','xls','csv','tsv','json','txt']},
    {name:'Bütün fayllar',extensions:['*']}
  ]});
  if(picked.canceled||!picked.filePaths[0]) return {cancelled:true};
  const filePath=picked.filePaths[0],fileName=path.basename(filePath),rawRows=readImportRecords(filePath).records;
  if(!rawRows.length) throw new Error('Seçilmiş bank çıxarışında məlumat sətri tapılmadı.');
  const records=rawRows.map(row=>bankRecordFromRaw(row,fileName));
  const result=bankImportRecords(records,Number(accountId));
  saveIntegrationSyncSource('bank',String(Number(accountId)),'file',filePath,result);
  recordIntegrationSyncRun('bank',String(Number(accountId)),'file',records.length,result);
  return {cancelled:false,fileName,rows:records.length,...result};
}

function refreshBankFromConfiguredSource(accountId) {
  const normalizedAccountId=Number(accountId||0);
  if(!db.prepare(`SELECT id FROM bank_accounts WHERE id=? AND active=1`).get(normalizedAccountId)) throw new Error('Əvvəlcə aktiv bank hesabı seçin.');
  const configuredSource=integrationSyncSource('bank',String(normalizedAccountId));
  if(!configuredSource?.source_path){
    return {sourceAvailable:false,sourceKind:'none',accountId:normalizedAccountId,created:0,duplicates:0,skippedExisting:0,failed:0};
  }
  if(!fs.existsSync(configuredSource.source_path)){
    return {sourceAvailable:false,sourceKind:'file',accountId:normalizedAccountId,created:0,duplicates:0,skippedExisting:0,failed:0,message:'Əvvəlki bank çıxarışı faylı artıq həmin ünvanda deyil.'};
  }
  const sourceFilePath=configuredSource.source_path;
  const sourceFileName=path.basename(sourceFilePath);
  const rawRecords=readImportRecords(sourceFilePath).records;
  if(!rawRecords.length) throw new Error('Sinxronizasiya mənbəyində bank əməliyyatı tapılmadı.');
  const normalizedRecords=rawRecords.map(record=>bankRecordFromRaw(record,sourceFileName));
  const result=bankImportRecords(normalizedRecords,normalizedAccountId);
  saveIntegrationSyncSource('bank',String(normalizedAccountId),'file',sourceFilePath,result);
  recordIntegrationSyncRun('bank',String(normalizedAccountId),'file',normalizedRecords.length,result);
  return {sourceAvailable:true,sourceKind:'file',accountId:normalizedAccountId,candidates:normalizedRecords.length,...result};
}

function dvxStatus() {
  const integration=db.prepare(`SELECT * FROM dvx_integration WHERE id=1`).get() || {};
  const packageCount=Number(db.prepare(`SELECT COUNT(*) c FROM dvx_packages WHERE company_id=1`).get().c||0);
  const lastPackage=db.prepare(`SELECT created_at,status,file_name FROM dvx_packages WHERE company_id=1 ORDER BY id DESC LIMIT 1`).get()||null;
  return safePlain({...integration,packageCount,lastPackage});
}

function dvxSaveSettings(payload={}) {
  const portalUrl=String(payload.portal_url||'https://new.e-taxes.gov.az/').trim();
  let parsed;
  try { parsed=new URL(portalUrl); } catch (_) { throw new Error('DVX portal ünvanı düzgün deyil.'); }
  if(parsed.protocol!=='https:' || !/(^|\.)e-taxes\.gov\.az$/i.test(parsed.hostname)) throw new Error('Yalnız rəsmi e-taxes.gov.az HTTPS ünvanına icazə verilir.');
  const environment=String(payload.environment||'production');
  if(!['production','sandbox'].includes(environment)) throw new Error('DVX mühiti düzgün deyil.');
  const t=nowIso();
  db.prepare(`UPDATE dvx_integration SET portal_url=?,environment=?,mode='portal',updated_at=? WHERE id=1`).run(parsed.href,environment,t);
  return dvxStatus();
}

function dvxOpenPortal(direction='Gedən') { return openLiveTaxPortal(direction); }

function dvxPackages() {
  return db.prepare(`SELECT p.*,i.invoice_no,i.counterparty_name,i.voen FROM dvx_packages p LEFT JOIN invoices i ON i.id=p.invoice_id WHERE p.company_id=1 ORDER BY p.id DESC`).all().map(safePlain);
}

function xmlEscape(value='') {
  return String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

function crc32(buffer) {
  let crc=0xffffffff;
  for(const byte of buffer){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  return (crc^0xffffffff)>>>0;
}

function zipBuffer(entries) {
  const localParts=[],centralParts=[]; let offset=0;
  const now=new Date(),dosTime=((now.getHours()&31)<<11)|((now.getMinutes()&63)<<5)|((Math.floor(now.getSeconds()/2))&31),dosDate=(((Math.max(1980,now.getFullYear())-1980)&127)<<9)|(((now.getMonth()+1)&15)<<5)|(now.getDate()&31);
  for(const entry of entries){
    const name=Buffer.from(String(entry.name).replace(/\\/g,'/'),'utf8'),data=Buffer.isBuffer(entry.data)?entry.data:Buffer.from(String(entry.data),'utf8'),crc=crc32(data);
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0x0800,6);local.writeUInt16LE(0,8);local.writeUInt16LE(dosTime,10);local.writeUInt16LE(dosDate,12);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);local.writeUInt16LE(0,28);
    localParts.push(local,name,data);
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x0800,8);central.writeUInt16LE(0,10);central.writeUInt16LE(dosTime,12);central.writeUInt16LE(dosDate,14);central.writeUInt32LE(crc,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(name.length,28);central.writeUInt16LE(0,30);central.writeUInt16LE(0,32);central.writeUInt16LE(0,34);central.writeUInt16LE(0,36);central.writeUInt32LE(0,38);central.writeUInt32LE(offset,42);centralParts.push(central,name);
    offset+=local.length+name.length+data.length;
  }
  const central=Buffer.concat(centralParts),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(0,4);end.writeUInt16LE(0,6);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(offset,16);end.writeUInt16LE(0,20);
  return Buffer.concat([...localParts,central,end]);
}

async function dvxPreparePackage(invoiceId) {
  const invoice=invoiceDetail(Number(invoiceId));
  if(!invoice) throw new Error('Paket üçün qaimə tapılmadı.');
  if(invoice.direction!=='Gedən') throw new Error('XML/ZIP arxiv paketi yalnız gedən qaimə üçün hazırlanır.');
  if(invoice.status==='Qaralama') throw new Error('Qaralama qaimə üçün arxiv paketi hazırlana bilməz. Əvvəlcə statusu dəyişin.');
  const itemXml=invoice.items.map((item,index)=>`    <Item line="${index+1}"><Code>${xmlEscape(item.item_code)}</Code><Description>${xmlEscape(item.description)}</Description><Quantity>${Number(item.qty||0).toFixed(4)}</Quantity><Unit>${xmlEscape(item.unit)}</Unit><UnitPrice>${Number(item.unit_price||0).toFixed(2)}</UnitPrice><BaseAmount>${Number(item.base_amount||0).toFixed(2)}</BaseAmount><VatRate>${Number(item.vat_rate||0).toFixed(2)}</VatRate><VatAmount>${Number(item.vat_amount||0).toFixed(2)}</VatAmount><TotalAmount>${Number(item.total_amount||0).toFixed(2)}</TotalAmount></Item>`).join('\n');
  const xml=`<?xml version="1.0" encoding="UTF-8"?>\n<MeyarEInvoice version="1.0">\n  <Header><InvoiceNumber>${xmlEscape(invoice.invoice_no)}</InvoiceNumber><InvoiceDate>${xmlEscape(invoice.invoice_date)}</InvoiceDate><Direction>Gedən</Direction><Currency>${xmlEscape(invoice.currency)}</Currency></Header>\n  <Counterparty><Name>${xmlEscape(invoice.counterparty_name)}</Name><Voen>${xmlEscape(invoice.voen)}</Voen></Counterparty>\n  <Amounts><Base>${Number(invoice.base_amount||0).toFixed(2)}</Base><Vat>${Number(invoice.vat_amount||0).toFixed(2)}</Vat><Total>${Number(invoice.total_amount||0).toFixed(2)}</Total></Amounts>\n  <Items>\n${itemXml}\n  </Items>\n  <Note>${xmlEscape(invoice.note||'')}</Note>\n</MeyarEInvoice>\n`;
  const xmlBytes=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(xml,'utf8')]),xmlHash=crypto.createHash('sha256').update(xmlBytes).digest('hex');
  const manifest=`Manifest-Version: 1.0\nCreated-By: Meyar ERP ${app.getVersion()}\nInvoice-No: ${invoice.invoice_no}\nInvoice-SHA256: ${xmlHash}\n`;
  const zip=zipBuffer([{name:'invoice.xml',data:xmlBytes},{name:'vhf-inf/vhf.mf',data:manifest}]);
  const safeNo=String(invoice.invoice_no).replace(/[^A-Za-z0-9ƏÖÜĞÇŞİəöüğçşı._-]+/g,'_').slice(0,80)||`invoice-${invoice.id}`;
  const packageDir=path.join(path.dirname(databaseFile()),'dvx-packages');fs.mkdirSync(packageDir,{recursive:true});
  const defaultPath=path.join(packageDir,`${safeNo}-${localDate()}.zip`);
  const picked=await dialog.showSaveDialog({title:'DVX paketini saxla',defaultPath,filters:[{name:'ZIP paket',extensions:['zip']}]});
  if(picked.canceled||!picked.filePath) return {cancelled:true};
  const finalPath=picked.filePath.toLowerCase().endsWith('.zip')?picked.filePath:`${picked.filePath}.zip`;
  fs.writeFileSync(finalPath,zip);
  const checksum=crypto.createHash('sha256').update(zip).digest('hex'),t=nowIso(),fileName=path.basename(finalPath);
  db.exec('BEGIN IMMEDIATE');
  try{
    const created=db.prepare(`INSERT INTO dvx_packages(company_id,invoice_id,direction,file_name,file_path,checksum,status,created_by,created_at) VALUES(1,?,'Gedən',?,?,?,'Hazırlandı',?,?)`).run(invoice.id,fileName,finalPath,checksum,currentUserName(),t);
    db.prepare(`INSERT INTO documents(company_id,entity_type,entity_id,document_kind,file_name,file_path,mime_type,checksum,created_at) VALUES(1,'E-Qaimə',?,'XML/ZIP arxiv paketi',?,?,'application/zip',?,?)`).run(invoice.id,fileName,finalPath,checksum,t);
    audit('XML/ZIP arxiv paketi hazırlandı','E-Qaimə',invoice.id,null,{package_id:Number(created.lastInsertRowid),file_name:fileName,checksum});
    db.exec('COMMIT');
  }catch(e){try{db.exec('ROLLBACK')}catch(_){};throw e;}
  return {cancelled:false,invoiceNo:invoice.invoice_no,filePath:finalPath,fileName,checksum};
}

function exportCsv(rows, filePath) {
  const headers=['Tarix','Qaimə №','Kontragent','VÖEN','Növ','Valyuta','Əsas məbləğ','ƏDV','Yekun','Ödənilib','Qalıq','Status','Uçot'];
  const esc=v=>`"${String(v??'').replace(/"/g,'""')}"`;
  const lines=[headers.map(esc).join(';')];
  rows.forEach(r=>lines.push([r.invoice_date,r.invoice_no,r.counterparty_name,r.voen,r.direction,r.currency||'AZN',Number(r.base_amount||0).toFixed(2),Number(r.vat_amount||0).toFixed(2),Number(r.total_amount||0).toFixed(2),Number(r.paid_amount||0).toFixed(2),Number(r.outstanding_amount||0).toFixed(2),r.status,r.posting_status].map(esc).join(';')));
  fs.writeFileSync(filePath,'\uFEFF'+lines.join('\n'),'utf8');
}

function exportVatReportCsv(report,filePath) {
  const quote=value=>`"${String(value??'').replace(/"/g,'""')}"`;
  const add=(lines,values)=>lines.push(values.map(quote).join(';'));
  const lines=[];
  add(lines,['AYLIQ ƏDV ƏVƏZLƏŞMƏSİ',report.period.key]);
  add(lines,['Dövr',report.period.start,report.period.end,report.period.status]);
  add(lines,[]);
  add(lines,['XÜLASƏ','Məbləğ (AZN)']);
  add(lines,['Əvvəlki dövrdən ƏDV qalığı',Number(report.summary.opening_input_vat||0).toFixed(2)]);
  add(lines,['Cari ay əvəzləşdirilən ƏDV',Number(report.summary.input_vat_current||0).toFixed(2)]);
  add(lines,['Cari ay hesablanan ƏDV',Number(report.summary.output_vat_current||0).toFixed(2)]);
  add(lines,['Əvəzləşmədə istifadə',Number(report.summary.offset_used||0).toFixed(2)]);
  add(lines,['Büdcəyə ödəniləcək ƏDV',Number(report.summary.vat_payable||0).toFixed(2)]);
  add(lines,['Növbəti aya qalıq ƏDV',Number(report.summary.carry_forward_input_vat||0).toFixed(2)]);
  add(lines,[]);
  add(lines,['ALINAN QAİMƏLƏR']);
  add(lines,['Tarix','Qaimə №','Kontragent','VÖEN','ƏDV rejimi','Qaimə ƏDV-si','Əsas ödəniş','ƏDV depoziti','Cari ay əvəzləşmə','Cəmi əvəzləşmə','Qalıq','Vəziyyət']);
  for(const row of report.inputRows||[])add(lines,[row.invoice_date,row.invoice_no,row.counterparty_name,row.voen,row.treatment,
    Number(row.vat_amount_azn||0).toFixed(2),Number(row.base_paid||0).toFixed(2),Number((row.treatment==='CUSTOMS'?row.customs_vat_paid:row.vat_deposit_paid)||0).toFixed(2),
    Number(row.eligible_period||0).toFixed(2),Number(row.eligible_total||0).toFixed(2),Number(row.remaining||0).toFixed(2),row.status]);
  add(lines,[]);
  add(lines,['SATIŞ QAİMƏLƏRİ']);
  add(lines,['Tarix','Qaimə №','Kontragent','VÖEN','Qaimə ƏDV-si','Ödəniş','Cari ay hesablanan','Cəmi hesablanan','Qalıq','Vəziyyət']);
  for(const row of report.outputRows||[])add(lines,[row.invoice_date,row.invoice_no,row.counterparty_name,row.voen,
    Number(row.vat_amount_azn||0).toFixed(2),Number(row.paid_total||0).toFixed(2),Number(row.recognized_period||0).toFixed(2),
    Number(row.recognized_total||0).toFixed(2),Number(row.remaining||0).toFixed(2),row.status]);
  add(lines,[]);
  add(lines,['DÜZƏLİŞLƏR']);
  add(lines,['Tarix','Tərəf','Məbləğ','Qarşı hesab','Qaimə №','Səbəb','İstifadəçi']);
  for(const row of report.adjustments||[])add(lines,[row.adjustment_date,row.vat_side,Number(row.amount_azn||0).toFixed(2),row.contra_account_code||'',row.invoice_no||'',row.reason,row.created_by]);
  fs.writeFileSync(filePath,'\uFEFF'+lines.join('\n'),'utf8');
}

function openInvoiceDirectionWindow(direction){
  // v1.5: incoming/outgoing invoices are internal ERP sections, not child windows.
  return {internal:true,direction:direction==='Gedən'?'Gedən':'Gələn'};
}

// Company-scoped user management. Login (auth:login above) already accepts
// any active username for the selected company; these handlers let the
// company's admin actually create those additional accounts (accountant,
// anbardar, viewer, etc.) instead of every company being limited to the
// single bootstrap owner account.
function listCompanyUsers() {
  requireAuth();
  return masterDb.prepare(`SELECT id,username,full_name,role,active,created_at FROM user_accounts WHERE company_id=? ORDER BY active DESC, full_name`).all(activeUser.company_id);
}
function createCompanyUser(payload={}) {
  requireAuth();
  if (activeUser.role !== 'admin') throw new Error('Yeni istifadəçi yalnız inzibatçı tərəfindən yaradıla bilər.');
  const username=String(payload.username||'').trim().toLowerCase();
  const fullName=String(payload.full_name||'').trim();
  const role=['admin','accountant','viewer'].includes(String(payload.role||'')) ? String(payload.role) : 'accountant';
  const password=String(payload.password||'');
  if(!/^[a-z0-9._-]{3,32}$/.test(username)) throw new Error('İstifadəçi adı 3-32 simvol, yalnız hərf, rəqəm, nöqtə, tire və alt xətdən ibarət ola bilər.');
  if(!fullName) throw new Error('Ad və soyad daxil edilməlidir.');
  if(password.length<8) throw new Error('Parol ən azı 8 simvol olmalıdır.');
  if(masterDb.prepare(`SELECT 1 FROM user_accounts WHERE company_id=? AND username=?`).get(activeUser.company_id,username)) throw new Error('Bu istifadəçi adı artıq mövcuddur.');
  const hp=hashPassword(password);
  const r=masterDb.prepare(`INSERT INTO user_accounts(company_id,username,full_name,password_hash,password_salt,role,created_at) VALUES(?,?,?,?,?,?,?)`).run(activeUser.company_id,username,fullName,hp.hash,hp.salt,role,nowIso());
  audit('İstifadəçi yaradıldı','İstifadəçi',Number(r.lastInsertRowid),null,{username,full_name:fullName,role});
  return {id:Number(r.lastInsertRowid),username,full_name:fullName,role,active:1};
}
function setCompanyUserActive(userId, active) {
  requireAuth();
  if (activeUser.role !== 'admin') throw new Error('İstifadəçi vəziyyəti yalnız inzibatçı tərəfindən dəyişdirilə bilər.');
  const target=masterDb.prepare(`SELECT * FROM user_accounts WHERE id=? AND company_id=?`).get(Number(userId),activeUser.company_id);
  if(!target) throw new Error('İstifadəçi tapılmadı.');
  if(!active){
    if(Number(target.id)===Number(activeUser.id)) throw new Error('Öz aktiv sessiyanızdakı hesabı deaktiv edə bilməzsiniz.');
    const activeAdmins=Number(masterDb.prepare(`SELECT COUNT(*) c FROM user_accounts WHERE company_id=? AND role='admin' AND active=1`).get(activeUser.company_id).c||0);
    if(target.role==='admin' && activeAdmins<=1) throw new Error('Şirkətdə ən azı bir aktiv inzibatçı qalmalıdır.');
  }
  masterDb.prepare(`UPDATE user_accounts SET active=? WHERE id=?`).run(active?1:0,Number(userId));
  audit(active?'İstifadəçi aktivləşdirildi':'İstifadəçi deaktiv edildi','İstifadəçi',Number(userId),target,{active:active?1:0});
  return masterDb.prepare(`SELECT id,username,full_name,role,active,created_at FROM user_accounts WHERE id=?`).get(Number(userId));
}

const VIEWER_READ_CHANNELS=new Set([
  'app:info','invoice:list','invoice:count','invoice:financialSummary','invoice:get','invoice:counterparties',
  'invoice:catalog','invoice:profiles','invoice:accounts','invoice:audit','invoice:statusHistory',
  'invoice:paymentCandidates','invoice:stats','invoice:status','invoice:dbc','invoice:accountCounterparties',
  'invoice:accountAnalytics','invoice:analyticLedger','invoice:counterpartyLedger','invoice:openDirectionWindow',
  'invoice:exportCsv','invoice:exportFiltered','dvx:status','dvx:packages','accounting:status','accounting:health',
  'accounting:setup','reference:list','bank:status','bank:get','bank:transactions','bank:count','bank:suggestions',
  'vat:report','vat:candidates','vat:integrity','vat:export'
]);

function secureHandle(channel, handler) {
  ipcMain.handle(channel, async (...args) => {
    requireAuth();
    if(activeUser.role==='viewer'&&!VIEWER_READ_CHANNELS.has(channel))throw new Error('Baxış səlahiyyətli istifadəçi məlumatı dəyişdirə bilməz.');
    const payload=args.slice(1);let size=0;try{size=Buffer.byteLength(JSON.stringify(payload),'utf8')}catch(_){throw new Error('Sorğu məlumatı oxuna bilmədi.');}
    if(size>10*1024*1024)throw new Error('Sorğu həcmi 10 MB limitini keçir. Faylı hissələrə bölün.');
    return handler(...args);
  });
}

function registerAuthIpc() {
  ipcMain.handle('auth:status', () => {
    const users = Number(masterDb.prepare(`SELECT COUNT(*) c FROM user_accounts WHERE active=1`).get().c || 0);
    const ownerUsers = Number(masterDb.prepare(`SELECT COUNT(*) c FROM user_accounts WHERE username=? AND role='admin' AND active=1`).get(OWNER_USERNAME).c || 0);
    const companies = Number(masterDb.prepare(`SELECT COUNT(*) c FROM companies WHERE active=1`).get().c || 0);
    const existingCompany = masterDb.prepare(`SELECT id,name,voen,currency FROM companies WHERE active=1 ORDER BY id LIMIT 1`).get() || null;
    return { needsSetup: ownerUsers === 0, needsUserSetup: ownerUsers === 0 && companies > 0, users, ownerUsers, companies, existingCompany };
  });

  ipcMain.handle('auth:companies', () => listActiveCompanies());

  ipcMain.handle('auth:access', (_, payload) => {
    const companyId=Number(payload?.companyId||0);
    if(!companyId)throw new Error('Şirkət bazası seçilməlidir.');
    const company=getCompanyById(companyId);if(!company)throw new Error('Seçilmiş şirkət bazası tapılmadı və ya deaktivdir.');
    let user=masterDb.prepare(`SELECT * FROM user_accounts WHERE company_id=? AND username=? AND role='admin' AND active=1 ORDER BY id LIMIT 1`).get(companyId,OWNER_USERNAME);
    if(!user)user=masterDb.prepare(`SELECT * FROM user_accounts WHERE company_id=? AND active=1 ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END,id LIMIT 1`).get(companyId);
    if(!user){
      const internalCredential=hashPassword(crypto.randomBytes(32).toString('hex'));
      const created=masterDb.prepare(`INSERT INTO user_accounts(company_id,username,full_name,password_hash,password_salt,role,active,created_at) VALUES(?,?,?,?,?,'admin',1,?)`).run(companyId,OWNER_USERNAME,OWNER_FULL_NAME,internalCredential.hash,internalCredential.salt,nowIso());
      user=masterDb.prepare(`SELECT * FROM user_accounts WHERE id=?`).get(Number(created.lastInsertRowid));
    }
    openCompanyDatabase(company);activeUser={id:user.id,username:user.username,full_name:user.full_name,role:user.role,company_id:companyId};
    return {ok:true,user:activeUser,company,companies:listActiveCompanies(),passwordRequired:false};
  });

  ipcMain.handle('auth:setup', (_, payload) => {
    if (Number(masterDb.prepare(`SELECT COUNT(*) c FROM user_accounts WHERE username=? AND role='admin' AND active=1`).get(OWNER_USERNAME).c||0) > 0) throw new Error('Baş inzibatçı hesabı artıq yaradılıb.');
    const companyName=String(payload?.companyName||'').trim(), voen=String(payload?.voen||'').replace(/\D/g,'');
    const username=OWNER_USERNAME, fullName=OWNER_FULL_NAME;
    if(!companyName || !/^\d{10}$/.test(voen)) throw new Error('Şirkət adı və 10 rəqəmli VÖEN tələb olunur.');
    let company=masterDb.prepare(`SELECT id,name,voen,currency FROM companies WHERE active=1 ORDER BY id LIMIT 1`).get() || null;
    const hp=hashPassword(crypto.randomBytes(32).toString('hex')); masterDb.exec('BEGIN');
    try {
      let companyId;
      // The setup screen is allowed to bootstrap a new company even when an older
      // company already exists in registry.sqlite. Reuse the existing company only
      // when its VÖEN matches; otherwise create a completely separate company DB.
      const sameVoen = company && String(company.voen||'') === voen;
      if (!sameVoen) {
        const cr=masterDb.prepare(`INSERT INTO companies(name,voen,currency,db_path,created_at) VALUES(?,?,?,?,?)`).run(companyName,voen,'AZN','',nowIso());
        companyId=Number(cr.lastInsertRowid); const dbPath=companyDatabaseFile(companyId);
        masterDb.prepare(`UPDATE companies SET db_path=? WHERE id=?`).run(dbPath,companyId);
        company=null;
      } else {
        companyId=Number(company.id);
        // Any legacy/non-owner accounts can no longer authenticate. They are kept for audit/history.
        masterDb.prepare(`UPDATE user_accounts SET active=0 WHERE company_id=?`).run(companyId);
      }
      const ur=masterDb.prepare(`INSERT INTO user_accounts(company_id,username,full_name,password_hash,password_salt,role,created_at) VALUES(?,?,?,?,?,?,?)`).run(companyId,username,fullName,hp.hash,hp.salt,'admin',nowIso());
      masterDb.exec('COMMIT');
      company=getCompanyById(companyId); openCompanyDatabase(company); activeUser={id:Number(ur.lastInsertRowid),username,full_name:fullName,role:'admin',company_id:companyId};
      return {ok:true,user:activeUser,company};
    } catch(e){ try{masterDb.exec('ROLLBACK')}catch(_){}; throw e; }
  });

  ipcMain.handle('auth:createCompany', (_, payload) => {
    // Company creation is an administrator-only operation. There is no public
    // registration path: an unauthenticated process cannot create a new base.
    requireAuth();
    if (activeUser.role !== 'admin' || activeUser.username !== OWNER_USERNAME) throw new Error('Yeni şirkət bazası yalnız baş inzibatçı tərəfindən yaradıla bilər.');
    const companyName=String(payload?.companyName||'').trim(), voen=String(payload?.voen||'').replace(/\D/g,'');
    if(!companyName || !/^\d{10}$/.test(voen)) throw new Error('Şirkət adı və 10 rəqəmli VÖEN tələb olunur.');
    if (masterDb.prepare(`SELECT 1 FROM companies WHERE voen=? AND active=1`).get(voen)) throw new Error('Bu VÖEN ilə baza artıq mövcuddur.');
    const hp=hashPassword(crypto.randomBytes(32).toString('hex')); masterDb.exec('BEGIN');
    try {
      const cr=masterDb.prepare(`INSERT INTO companies(name,voen,currency,db_path,created_at) VALUES(?,?,?,?,?)`).run(companyName,voen,'AZN','',nowIso());
      const companyId=Number(cr.lastInsertRowid); const dbPath=companyDatabaseFile(companyId);
      masterDb.prepare(`UPDATE companies SET db_path=? WHERE id=?`).run(dbPath,companyId);
      const ur=masterDb.prepare(`INSERT INTO user_accounts(company_id,username,full_name,password_hash,password_salt,role,created_at) VALUES(?,?,?,?,?,?,?)`).run(companyId,OWNER_USERNAME,OWNER_FULL_NAME,hp.hash,hp.salt,'admin',nowIso());
      masterDb.exec('COMMIT');
      const company=getCompanyById(companyId);
      openCompanyDatabase(company);
      activeUser={id:Number(ur.lastInsertRowid),username:OWNER_USERNAME,full_name:OWNER_FULL_NAME,role:'admin',company_id:companyId};
      return {ok:true,company,user:activeUser};
    } catch(e){ try{masterDb.exec('ROLLBACK')}catch(_){}; throw e; }
  });

  ipcMain.handle('auth:login', (_, payload) => {
    const companyId=Number(payload?.companyId||0), username=String(payload?.username||'').trim().toLowerCase(), password=String(payload?.password||'');
    if(!companyId) throw new Error('Əvvəlcə şirkət bazasını seçin.');
    const company=getCompanyById(companyId); if(!company) throw new Error('Seçilmiş şirkət bazası tapılmadı və ya deaktivdir.');
    // Any active user account created for this company (baş inzibatçı or a
    // staff account created via users:create) may log in — not only the
    // bootstrap owner account. See users:create below.
    const u=masterDb.prepare(`SELECT * FROM user_accounts WHERE company_id=? AND username=? AND active=1`).get(companyId,username);
    if(!u || !verifyPassword(password,u.password_salt,u.password_hash)) throw new Error('Bu şirkət bazası üçün istifadəçi adı və ya parol yanlışdır.');
    openCompanyDatabase(company); activeUser={id:u.id,username:u.username,full_name:u.full_name,role:u.role,company_id:companyId};
    return {ok:true,user:activeUser,company,companies:listActiveCompanies()};
  });
  ipcMain.handle('auth:logout', () => { closeCompanySession(); return {ok:true}; });
}

function registerIpc() {
  secureHandle('app:info',()=>({version:app.getVersion(),dataPath:databaseFile()}));
  secureHandle('invoice:list',(_,args)=>invoiceRows(args||{}));
  secureHandle('invoice:count',(_,args)=>invoiceCount(args||{}));
  secureHandle('invoice:financialSummary',()=>invoiceFinancialSummary());
  secureHandle('invoice:get',(_,args)=>{ if(args && typeof args==='object') return invoiceDetail(Number(args.id),!!args.includeArchived); return invoiceDetail(Number(args)); });
  secureHandle('invoice:save',(_,payload)=>saveInvoice(payload));
  secureHandle('invoice:post',(_,id)=>postInvoice(Number(id)));
  secureHandle('invoice:archive',(_,id)=>removeInvoice(Number(id)));
  secureHandle('invoice:delete',(_,id)=>hardDeleteInvoice(Number(id)));
  secureHandle('invoice:restore',(_,id)=>restoreInvoice(Number(id)));
  secureHandle('invoice:status:change',(_,args)=>changeInvoiceStatus(Number(args.id),String(args.status),String(args.reason||'')));
  secureHandle('invoice:counterparties',()=>db.prepare(`SELECT id,name,voen,type,is_customer,is_supplier,account_code,receivable_account_code,payable_account_code,status FROM counterparties WHERE status='Aktiv' ORDER BY name`).all());
  secureHandle('invoice:catalog',()=>db.prepare(`SELECT * FROM item_catalog WHERE company_id=1 AND active=1 ORDER BY item_type,name`).all());
  secureHandle('invoice:profiles',(_,direction)=>db.prepare(`SELECT id,code,name,direction,base_debit_code,vat_debit_code,base_credit_code,vat_credit_code FROM posting_profiles WHERE direction=? AND active=1 ORDER BY name`).all(String(direction)));
  secureHandle('invoice:accounts',()=>db.prepare(`SELECT code,name,kind,parent_code,role,is_postable FROM accounts WHERE active=1 ORDER BY code`).all());
  secureHandle('invoice:audit',(_,id)=>db.prepare(`SELECT * FROM audit_log WHERE entity_type='E-Qaimə' AND entity_id=? ORDER BY id DESC`).all(Number(id)));
  secureHandle('invoice:statusHistory',(_,id)=>invoiceStatusHistory(Number(id)));
  secureHandle('invoice:paymentCandidates',(_,args)=>paymentCandidates(args||{}));
  secureHandle('invoice:importFile',(_,direction)=>chooseAndImportInvoiceFile(String(direction)==='Gedən'?'Gedən':'Gələn'));
  secureHandle('invoice:sync',(_,direction)=>refreshInvoicesFromConfiguredSource(String(direction)==='Gedən'?'Gedən':'Gələn'));
  secureHandle('invoice:live:open',(_,direction)=>openLiveTaxPortal(String(direction)==='Gedən'?'Gedən':'Gələn'));
  secureHandle('invoice:live:navigate',(_,direction)=>navigateLiveTaxInvoices(direction));
  secureHandle('dvx:status',()=>dvxStatus());
  secureHandle('dvx:settings',(_,payload)=>dvxSaveSettings(payload||{}));
  secureHandle('dvx:openPortal',(_,direction)=>dvxOpenPortal(String(direction)==='Gələn'?'Gələn':'Gedən'));
  secureHandle('dvx:preparePackage',(_,id)=>dvxPreparePackage(Number(id)));
  secureHandle('dvx:packages',()=>dvxPackages());
  secureHandle('invoice:openDirectionWindow',(_,direction)=>openInvoiceDirectionWindow(String(direction)==='Gedən'?'Gedən':'Gələn'));
  secureHandle('invoice:stats',()=>{
    const current=db.prepare(`SELECT direction, COUNT(*) AS c FROM invoices WHERE company_id=1 AND deleted_at IS NULL GROUP BY direction`).all();
    const incoming=Number(current.find(x=>x.direction==='Gələn')?.c||0);
    const outgoing=Number(current.find(x=>x.direction==='Gedən')?.c||0);
    const archived=Number(db.prepare(`SELECT COUNT(*) AS c FROM invoices WHERE company_id=1 AND deleted_at IS NOT NULL`).get().c||0);
    const directionReview=Number(db.prepare(`SELECT COUNT(*) AS c FROM invoices WHERE company_id=1 AND deleted_at IS NULL AND source IN ('file-import','import') AND COALESCE(direction_source,'')=''`).get().c||0);
    const accountingReview=Number(db.prepare(`SELECT COUNT(*) AS c FROM invoices WHERE company_id=1 AND deleted_at IS NULL AND accounting_review_required=1`).get().c||0);
    return {incoming,outgoing,archived,all:incoming+outgoing,directionReview,accountingReview,dataPath:databaseFile()};
  });
  secureHandle('invoice:live:import',(event)=>extractLiveTaxInvoices(event));
  secureHandle('invoice:status',(_,id)=>{ const r=db.prepare(`SELECT id,status,posting_status,deleted_at FROM invoices WHERE id=?`).get(Number(id)); return r||null; });
  secureHandle('invoice:dbc',(_,args)=>{
    const options=args||{};
    return {rows:options.accountCode?turnoverBalance(options):turnoverBalanceGroups(options),summary:turnoverBalanceSummary(options)};
  });
  secureHandle('invoice:accountCounterparties',(_,args)=>accountCounterparties(args?.accountCode,args?.from,args?.to));
  secureHandle('invoice:accountAnalytics',(_,args)=>accountAnalytics(args?.accountCode,args?.from,args?.to));
  secureHandle('invoice:analyticLedger',(_,args)=>accountAnalyticLedger(args||{}));
  secureHandle('invoice:counterpartyLedger',(_,args)=>counterpartyLedger(args?.counterpartyId,args?.accountCode,args?.from,args?.to));
  secureHandle('accounting:status',()=>accountingStatus());
  secureHandle('accounting:health',()=>accountingIntegrityReport());
  secureHandle('accounting:setup',()=>getAccountingSetup());
  secureHandle('accounting:activate',(_,payload)=>saveAccountingSetup(payload||{}));
  secureHandle('accounting:periodClose',(_,payload)=>setAccountingPeriodClose(payload||{}));
  secureHandle('reference:list',()=>referenceSnapshot());
  secureHandle('reference:saveAccount',(_,payload)=>saveReferenceAccount(payload||{}));
  secureHandle('reference:saveSubkonto',(_,payload)=>saveSubkonto(payload||{}));
  secureHandle('reference:saveCounterparty',(_,payload)=>saveCounterparty(payload||{}));
  secureHandle('reference:saveContract',(_,payload)=>saveContract(payload||{}));
  secureHandle('reference:saveWarehouse',(_,payload)=>saveWarehouse(payload||{}));
  secureHandle('reference:saveCatalog',(_,payload)=>saveCatalogItem(payload||{}));
  secureHandle('reference:saveRule',(_,payload)=>savePostingRule(payload||{}));
  secureHandle('users:list',()=>listCompanyUsers());
  secureHandle('users:create',(_,payload)=>createCompanyUser(payload||{}));
  secureHandle('users:setActive',(_,payload)=>setCompanyUserActive(Number(payload?.id),!!payload?.active));
  secureHandle('bank:status',()=>bankStatus());
  secureHandle('bank:saveAccount',(_,payload)=>bankSaveAccount(payload||{}));
  secureHandle('bank:get',(_,id)=>bankTransaction(Number(id)));
  secureHandle('bank:transactions',(_,args)=>bankTransactions(args||{}));
  secureHandle('bank:count',(_,args)=>bankTransactionCount(args||{}));
  secureHandle('bank:suggestions',(_,id)=>bankSuggestions(Number(id)));
  secureHandle('bank:reconcile',(_,payload)=>bankReconcile(payload||{}));
  secureHandle('bank:unreconcile',(_,id)=>bankUnreconcile(Number(id)));
  secureHandle('bank:import',(_,payload)=>bankImportRecords(payload?.records||[],payload?.accountId));
  secureHandle('bank:importFile',(_,accountId)=>chooseAndImportBankFile(Number(accountId)));
  secureHandle('bank:sync',(_,accountId)=>refreshBankFromConfiguredSource(Number(accountId)));
  secureHandle('vat:report',(_,periodKey)=>vatPeriodReport(periodKey));
  secureHandle('vat:refresh',(_,periodKey)=>vatRefreshPeriod(periodKey));
  secureHandle('vat:candidates',(_,payload)=>vatBankCandidates(Number(payload?.invoiceId),String(payload?.search||'')));
  secureHandle('vat:allocate',(_,payload)=>vatAllocatePayment(payload||{}));
  secureHandle('vat:unallocate',(_,allocationId)=>vatUnallocatePayment(Number(allocationId)));
  secureHandle('vat:setTreatment',(_,payload)=>vatSetInvoiceTreatment(payload||{}));
  secureHandle('vat:addAdjustment',(_,payload)=>vatAddAdjustment(payload||{}));
  secureHandle('vat:deleteAdjustment',(_,adjustmentId)=>vatDeleteAdjustment(Number(adjustmentId)));
  secureHandle('vat:close',(_,payload)=>vatClosePeriod(payload||{}));
  secureHandle('vat:reopen',(_,payload)=>vatReopenPeriod(payload||{}));
  secureHandle('vat:integrity',()=>vatIntegrityReport());
  secureHandle('vat:export',async(_,periodKey)=>{
    const report=vatPeriodReport(periodKey);
    const {canceled,filePath}=await dialog.showSaveDialog({title:'Aylıq ƏDV əvəzləşməsini ixrac et',defaultPath:`meyar_edv_${report.period.key}.csv`,filters:[{name:'CSV',extensions:['csv']}]});
    if(canceled||!filePath)return {cancelled:true};
    exportVatReportCsv(report,filePath);return {cancelled:false,filePath};
  });
  secureHandle('invoice:exportCsv',async(_,rows)=>{
    if(!Array.isArray(rows)||rows.length>50000)throw new Error('İxrac üçün ən çox 50 000 sətir seçilə bilər.');
    const {canceled,filePath}=await dialog.showSaveDialog({title:'E-Qaimələri ixrac et',defaultPath:'meyar_e-qaimeler.csv',filters:[{name:'CSV',extensions:['csv']}]});
    if(canceled||!filePath)return {cancelled:true};
    exportCsv(rows,filePath); return {cancelled:false,filePath};
  });
  secureHandle('invoice:exportFiltered',async(_,args)=>{
    const options=args||{};
    const total=invoiceCount(options);
    if(total>50000)throw new Error('İxrac nəticəsi 50 000 sətri keçir. Tarix və ya digər filtrlərlə nəticəni daraldın.');
    const rows=total?invoiceRows({...options,limit:Math.max(1,total),offset:0},50000):[];
    const {canceled,filePath}=await dialog.showSaveDialog({title:'Filtrlənmiş e-qaimələri ixrac et',defaultPath:'meyar_e-qaimeler.csv',filters:[{name:'CSV',extensions:['csv']}]});
    if(canceled||!filePath)return {cancelled:true};
    exportCsv(rows,filePath);return {cancelled:false,filePath,count:rows.length};
  });
  secureHandle('app:openDataFolder',async()=>{await shell.openPath(path.dirname(databaseFile()));return true;});
}

function createWindow() {
  mainWindow=new BrowserWindow({
    width:1500,height:950,minWidth:900,minHeight:600,
    show:false,
    backgroundColor:'#eef7f1',
    title:'Meyar ERP — Peşəkar uçot sistemi',
    webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true}
  });
  mainWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  mainWindow.webContents.on('will-navigate',(event,url)=>{if(!String(url).startsWith('file:'))event.preventDefault();});
  mainWindow.once('ready-to-show',()=>mainWindow.show());
  mainWindow.webContents.on('did-finish-load',()=>{
    if(!mainWindow.isDestroyed()) mainWindow.webContents.send('invoice:refresh',{resource:'all'});
    try { markUpdateHealthy(updateStateFile(), app.getVersion()); }
    catch (error) { console.warn('MEYAR update journal could not be finalized:', error.message); }
  });
  mainWindow.on('closed',()=>{mainWindow=null;});
  mainWindow.loadFile(path.join(__dirname,'src','index.html'),{query:{invoiceDirection:'Gələn'}});
  return mainWindow;
}

app.whenReady().then(()=>{
  try {
    initMasterDb();
    registerAuthIpc();
    registerIpc();
    createWindow();
    initializeAppUpdater({
      app,
      ipcMain,
      getWindow: () => mainWindow,
      createBackup: createPreUpdateBackup,
      stateFile: updateStateFile(),
      logFile: path.join(app.getPath('userData'), 'logs', 'updater.log'),
      onInstallBlocked: message => {
        if (!mainWindow || mainWindow.isDestroyed()) createWindow();
        dialog.showErrorBox('Yenilənmə təhlükəsizlik səbəbi ilə dayandırıldı', String(message || 'Baza ehtiyatı yaradıla bilmədi.'));
      }
    });
    app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow();});
  } catch (err) {
    console.error('MEYAR ERP startup error:', err);
    closeDatabasesForExit();
    let recoveryMessage = '';
    try {
      const recovery = recoverPendingUpdateData({
        stateFile: updateStateFile(),
        currentVersion: app.getVersion(),
        destinationRoot: dataRoot()
      });
      if (recovery.recovered) recoveryMessage = '\n\nYenilənmədən əvvəlki məlumat bazaları avtomatik bərpa edildi.';
    } catch (recoveryError) {
      recoveryMessage = `\n\nAvtomatik məlumat bərpası da alınmadı: ${recoveryError.message}`;
    }
    dialog.showErrorBox('MEYAR ERP açıla bilmədi', `${String(err?.message || err)}${recoveryMessage}`);
    app.quit();
  }
});
app.on('before-quit', closeDatabasesForExit);
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
