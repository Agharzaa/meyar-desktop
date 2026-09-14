'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const runtimeSource = source.split('\napp.whenReady().then(()=>{')[0] + `
module.exports={
  initDb,saveInvoice,invoiceDetail,importInvoiceRecords,saveAccountingSetup,
  accountCounterparties,accountAnalytics,saveReferenceAccount,setAccountingPeriodClose,
  bankSaveAccount,bankImportRecords,bankTransactions,bankReconcile,bankUnreconcile,
  queryAll:(sql,...params)=>db.prepare(sql).all(...params),queryOne:(sql,...params)=>db.prepare(sql).get(...params)
};`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meyar-v112-'));
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

function invoice(no,direction,voen,options={}){
  return api.saveInvoice({
    invoice_no:no,invoice_date:options.date||'2026-03-10',direction,
    counterparty_name:options.name||`Kontragent ${voen}`,voen,currency:options.currency||'AZN',exchange_rate:options.rate||1,
    counterparty_account_code:direction==='Gələn'?'531.01':'211.01',vat_posting_account_code:direction==='Gələn'?'241.01':'521.01',
    items:[{item_code:options.code||`${direction}-${no}`,item_type:options.itemType||'Xidmət',description:options.description||'Peşəkar xidmət',qty:options.qty||1,unit:'xidmət',unit_price:options.price||100,discount_rate:0,vat_rate:options.vatRate??0,posting_account_code:options.account||(direction==='Gələn'?'721.01':'601.02'),warehouse_id:options.warehouseId||null}]
  });
}

try{
  api.initDb(path.join(tempRoot,'company.sqlite'),{companyMeta:{name:'Audit Test MMC',voen:'1234567890',currency:'AZN'}});

  invoice('STOCK-IN','Gələn','1000000001',{itemType:'Mal',description:'Test malı',code:'STOCK-1',qty:10,price:10,account:'205.01',warehouseId:1});
  assert.throws(()=>invoice('STOCK-OUT','Gedən','1000000002',{itemType:'Mal',description:'Test malı',code:'STOCK-1',qty:11,price:15,account:'601.01',warehouseId:1}),/qalıq.*çatmır/i);
  assert.equal(api.queryOne(`SELECT COUNT(*) c FROM invoices WHERE invoice_no='STOCK-OUT'`).c,0,'Mənfi qalıq bütün tranzaksiyanı geri qaytarmalıdır');

  const usd=invoice('USD-1','Gedən','1000000003',{currency:'USD',rate:1.7,price:100,vatRate:18});
  assert.equal(usd.functional_total_amount,200.6);
  const usdJournal=api.queryOne(`SELECT ROUND(SUM(l.debit),2) d,ROUND(SUM(l.credit),2) c FROM journal_entries j JOIN journal_lines l ON l.journal_entry_id=j.id WHERE j.source_type='invoice' AND j.source_id=?`,usd.id);
  assert.equal(usdJournal.d,200.6);assert.equal(usdJournal.c,200.6);

  const unknown=api.importInvoiceRecords([{invoice_no:'UNKNOWN-1',invoice_date:'2026-03-11',counterparty_name:'Naməlum Xərc MMC',voen:'1000000004',base_amount:25,vat_amount:0,total_amount:25,direction:'Gələn'}],'file-import','unknown.xlsx','Gələn',{trustedDirection:true});
  assert.equal(unknown.created,1);
  const unknownItem=api.queryOne(`SELECT ii.posting_account_code,i.accounting_review_required FROM invoice_items ii JOIN invoices i ON i.id=ii.invoice_id WHERE i.invoice_no='UNKNOWN-1'`);
  assert.equal(unknownItem.posting_account_code,'721.99');assert.equal(unknownItem.accounting_review_required,1);

  api.saveAccountingSetup({openingDate:'2026-01-01',balances:[{code:'211.01',debit:100,credit:0},{code:'531.01',debit:0,credit:100}]});
  const debtors=api.accountCounterparties('211.01','2026-01-01','2026-01-31');
  assert.equal(debtors.some(row=>row.unallocated_opening&&row.net===100),true,'DBC açılışı analitikasız sətirlə uzlaşmalıdır');

  api.saveReferenceAccount({code:'212.55',name:'Xüsusi debitorlar',kind:'asset',role:'RECEIVABLE'});
  assert.equal(api.accountAnalytics('212.55','2026-01-01','2026-12-31').type,'counterparties','Analitika hesab prefiksi ilə deyil, semantik rol ilə seçilməlidir');

  const invA=invoice('BANK-A','Gedən','1000000005',{price:60});
  const invB=invoice('BANK-B','Gedən','1000000006',{price:40});
  const bank=api.bankSaveAccount({bank_name:'Test Bank',account_name:'AZN',iban:'AZ21NABZ00000000137010001944',currency:'AZN',ledger_account_code:'223.01'});
  api.bankImportRecords([{date:'2026-03-15',direction:'Kredit',amount:100,counterparty_name:'Müştərilər',description:'İki qaimə ödənişi'}],bank.id);
  const tx=api.bankTransactions({accountId:bank.id})[0];
  api.bankReconcile({transactionId:tx.id,allocations:[{invoiceId:invA.id,amount:60},{invoiceId:invB.id,amount:40}]});
  assert.equal(api.queryOne(`SELECT COUNT(*) c FROM bank_reconciliation_allocations`).c,2);
  assert.equal(api.queryOne(`SELECT COUNT(*) c FROM payment_allocations`).c,2);
  api.bankUnreconcile(tx.id);
  assert.equal(api.queryOne(`SELECT COUNT(*) c FROM payment_allocations`).c,0);
  assert.equal(api.queryOne(`SELECT reconciliation_status s FROM bank_transactions WHERE id=?`,tx.id).s,'Uyğunlaşdırılmayıb');

  const first=api.bankImportRecords([{date:'2026-03-20',direction:'Kredit',amount:12.34,counterparty_name:'A MMC'},{date:'2026-03-21',direction:'Debet',amount:5.67,counterparty_name:'B MMC'}],bank.id);
  const second=api.bankImportRecords([{date:'2026-03-21',direction:'Debet',amount:5.67,counterparty_name:'B MMC'},{date:'2026-03-20',direction:'Kredit',amount:12.34,counterparty_name:'A MMC'}],bank.id);
  assert.equal(first.created,2);assert.equal(second.duplicates,2,'Sətir sırası dəyişəndə dublikat qoruması pozulmamalıdır');

  api.setAccountingPeriodClose({through:'2026-03-31'});
  assert.throws(()=>invoice('LOCKED-1','Gedən','1000000007',{date:'2026-03-31'}),/dövrü bağlıdır/i);
  api.setAccountingPeriodClose({through:''});

  console.log('accounting core v1.12.0: OK');
} finally {
  fs.rmSync(tempRoot,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
