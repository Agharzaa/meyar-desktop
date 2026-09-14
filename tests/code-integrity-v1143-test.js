'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const {removeTemporaryDirectory}=require('./test-filesystem');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');

const projectRoot=path.resolve(__dirname,'..');
const applicationSource=fs.readFileSync(path.join(projectRoot,'main.js'),'utf8');
const runtimeSource=applicationSource.split('\napp.whenReady().then(()=>{')[0]+`
module.exports={
  initDb,saveInvoice,importInvoiceRecords,saveCatalogItem,bankSaveAccount,bankImportRecords,
  bankTransactions,bankReconcile,bankUnreconcile,counterpartyLedger,accountCounterparties,
  saveAccountingSetup,turnoverBalance,accountAnalyticLedger,accountingIntegrityReport,readImportRecords,
  queryOne:(sql,...parameters)=>db.prepare(sql).get(...parameters),
  queryAll:(sql,...parameters)=>db.prepare(sql).all(...parameters),
  closeDatabase:()=>{if(db){db.close();db=null;}}
};`;

const temporaryRoot=fs.mkdtempSync(path.join(os.tmpdir(),'meyar-integrity-v1143-'));
const electronStub={
  app:{getPath:()=>temporaryRoot,getVersion:()=>'1.14.3'},
  BrowserWindow:class{},ipcMain:{handle(){}},dialog:{},shell:{}
};
const localRequire=moduleName=>moduleName==='electron'
  ?electronStub
  :moduleName.startsWith('./')?require(path.join(projectRoot,moduleName)):require(moduleName);
const moduleContainer={exports:{}};
const context=vm.createContext({
  require:localRequire,module:moduleContainer,exports:moduleContainer.exports,
  __dirname:projectRoot,__filename:path.join(projectRoot,'main.js'),
  console,Buffer,URL,setImmediate,clearImmediate,setTimeout,clearTimeout,process
});
new vm.Script(runtimeSource,{filename:'main.js'}).runInContext(context);
const api=moduleContainer.exports;
const databasePath=path.join(temporaryRoot,'company.sqlite');

function serviceInvoice(number,voen,date='2026-09-10'){
  return api.saveInvoice({
    invoice_no:number,invoice_date:date,direction:'Gedən',counterparty_name:`Müştəri ${voen}`,voen,
    currency:'AZN',exchange_rate:1,counterparty_account_code:'211.01',vat_posting_account_code:'521.01',
    items:[{item_type:'Xidmət',description:'Peşəkar xidmət',qty:1,unit:'xidmət',unit_price:100,discount_rate:0,vat_rate:0,posting_account_code:'601.02'}]
  });
}

try{
  api.initDb(databasePath,{companyMeta:{name:'Kod Audit MMC',voen:'1234567890',currency:'AZN'}});

  assert.throws(()=>serviceInvoice('INVALID-DATE','1000000201','2026-02-31'),/tarixi düzgün/i,'Mövcud olmayan təqvim tarixi qəbul edilməməlidir');
  assert.equal(api.queryOne(`SELECT COUNT(*) count FROM invoices WHERE invoice_no='INVALID-DATE'`).count,0);

  const imported=api.importInvoiceRecords([
    {invoice_no:'ROW-OK',invoice_date:'2026-09-01',counterparty_name:'Birinci Təchizatçı MMC',voen:'1000000202',direction:'Gələn',main_note:'Audit xidməti',base_amount:20,vat_amount:0,total_amount:20},
    {invoice_no:'ROW-BAD',invoice_date:'31/02/2026',counterparty_name:'İkinci Təchizatçı MMC',voen:'1000000203',direction:'Gələn',main_note:'Audit xidməti',base_amount:30,vat_amount:0,total_amount:30}
  ],'file-import','rows.xlsx','Gələn',{trustedDirection:true});
  assert.deepEqual({created:imported.created,failed:imported.failed},{created:1,failed:1});
  assert.equal(api.queryOne(`SELECT row_number FROM import_rejections WHERE import_type='invoice' ORDER BY id DESC LIMIT 1`).row_number,2,'İdxal xətası mənbədəki həqiqi sətir nömrəsini saxlamalıdır');

  const goodsImport=api.importInvoiceRecords([
    {invoice_no:'GOODS-IN',invoice_date:'2026-09-02',counterparty_name:'Mal Təchizatçısı MMC',voen:'1000000204',direction:'Gələn',item_type:'Mal',main_note:'Printer avadanlığı mal alışı',base_amount:250,vat_amount:0,total_amount:250}
  ],'file-import','goods.xlsx','Gələn',{trustedDirection:true});
  assert.deepEqual({created:goodsImport.created,posted:goodsImport.posted,failed:goodsImport.failed},{created:1,posted:1,failed:0},'Gələn mal seçilmiş anbarın hesabı ilə avtomatik uçota alınmalıdır');
  const goodsPosting=api.queryOne(`SELECT ii.posting_account_code,w.inventory_account_code,sm.direction,sm.total_cost
    FROM invoices i JOIN invoice_items ii ON ii.invoice_id=i.id
    JOIN warehouses w ON w.id=ii.warehouse_id JOIN stock_movements sm ON sm.invoice_item_id=ii.id
    WHERE i.invoice_no='GOODS-IN'`);
  assert.equal(goodsPosting.posting_account_code,goodsPosting.inventory_account_code);
  assert.equal(goodsPosting.direction,'IN');
  assert.equal(goodsPosting.total_cost,250);

  api.saveCatalogItem({code:'CUSTOM-STOCK',name:'Xüsusi ehtiyat',item_type:'Mal',unit:'ədəd',purchase_account_code:'205.02',sales_account_code:'601.01',standard_cost:0});
  api.closeDatabase();
  api.initDb(databasePath,{backupExisting:false});
  const preservedCatalog=api.queryOne(`SELECT purchase_account_code,inventory_account_code FROM item_catalog WHERE code='CUSTOM-STOCK'`);
  assert.equal(preservedCatalog.purchase_account_code,'205.02','İstifadəçinin seçdiyi alış hesabı proqram yenidən açılanda dəyişməməlidir');
  assert.equal(preservedCatalog.inventory_account_code,'205.02','İstifadəçinin seçdiyi ehtiyat hesabı proqram yenidən açılanda dəyişməməlidir');

  const bank=api.bankSaveAccount({bank_name:'Audit Bank',account_name:'AZN',iban:'AZ21NABZ00000000137010001944',currency:'AZN',ledger_account_code:'223.01'});
  const similarTransactions=[
    {date:'2026-09-11',direction:'Kredit',amount:10,currency:'AZN',counterparty_name:'Eyni Müştəri MMC',description:'Eyni təyinat',balance_after:1000},
    {date:'2026-09-11',direction:'Kredit',amount:10,currency:'AZN',counterparty_name:'Eyni Müştəri MMC',description:'Eyni təyinat',balance_after:1010}
  ];
  const firstBankImport=api.bankImportRecords(similarTransactions,bank.id);
  assert.equal(firstBankImport.created,2,'Fərqli son qalıqlı real bank əməliyyatları yanlış dublikat sayılmamalıdır');
  const repeatedBankImport=api.bankImportRecords([similarTransactions[0]],bank.id);
  assert.equal(repeatedBankImport.skippedExisting,1,'Eyni bank əməliyyatı yenidən işlənməməlidir');
  api.bankImportRecords([{id:'GRID-ROW-7',date:'2026-09-12',direction:'Kredit',amount:11,currency:'AZN',counterparty_name:'Sətir ID Testi',balance_after:1021}],bank.id);
  const genericIdTransaction=api.queryOne(`SELECT external_id FROM bank_transactions WHERE counterparty_name='Sətir ID Testi'`);
  assert.match(genericIdTransaction.external_id,/^AUTO-/,'Cədvəlin ümumi sətir ID-si bankın tranzaksiya ID-si kimi qəbul edilməməlidir');

  const payableInvoice=serviceInvoice('BANK-ALLOC','1000000205');
  api.bankImportRecords([{external_id:'ALLOC-TX',date:'2026-09-12',direction:'Kredit',amount:100,currency:'AZN',counterparty_name:'Müştəri 1000000205'}],bank.id);
  const allocationTransaction=api.bankTransactions({accountId:bank.id,search:'ALLOC-TX'}).find(row=>row.external_id==='ALLOC-TX')||api.queryOne(`SELECT * FROM bank_transactions WHERE external_id='ALLOC-TX'`);
  assert.throws(()=>api.bankReconcile({transactionId:allocationTransaction.id,allocations:[{invoiceId:payableInvoice.id,amount:50},{invoiceId:payableInvoice.id,amount:50}]}),/bir dəfədən çox/i,'Eyni qaimə eyni bank bölgüsündə təkrarlanmamalıdır');
  assert.equal(api.queryOne(`SELECT COUNT(*) count FROM bank_reconciliations WHERE transaction_id=?`,allocationTransaction.id).count,0,'Yanlış bölgü heç bir yarımçıq yazılış saxlamamalıdır');

  api.bankReconcile({transactionId:allocationTransaction.id,allocations:[{invoiceId:payableInvoice.id,amount:100}]});
  api.bankUnreconcile(allocationTransaction.id);
  const counterparty=api.queryOne(`SELECT id FROM counterparties WHERE voen='1000000205'`);
  const ledger=api.counterpartyLedger(counterparty.id,'211.01','2026-09-01','2026-09-30');
  assert.equal(ledger.summary.payments_total,0,'Storno edilmiş bank uyğunlaşdırması aktiv ödəniş cəminə daxil edilməməlidir');
  assert.equal(ledger.entries.filter(row=>row.kind==='payment').length,0);
  assert.equal(ledger.entries.filter(row=>row.kind==='reversal').length>=1,true);
  const counterpartyBalance=api.accountCounterparties('211.01','2026-09-01','2026-09-30').find(row=>row.id===counterparty.id);
  assert.equal(counterpartyBalance.allocated_payments,0,'Storno edilmiş ödəniş debitor analitikasında ödənilmiş kimi görünməməlidir');

  api.saveAccountingSetup({openingDate:'2026-01-01',balances:[
    {code:'211.01',debit:100,credit:0},{code:'211.01',debit:0,credit:40},{code:'531.01',debit:0,credit:60}
  ]});
  const debtorOpening=api.queryOne(`SELECT debit,credit FROM opening_balances WHERE account_code='211.01' AND counterparty_id IS NULL AND subkonto_id IS NULL`);
  assert.equal(debtorOpening.debit,60,'Eyni analitika üzrə Debet/Kredit bir xalis qalığa çevrilməlidir');
  assert.equal(debtorOpening.credit,0,'Xalis açılış qalığının əks tərəfi sıfır olmalıdır');
  assert.throws(()=>api.turnoverBalance({from:'2026-13-01',to:'2026-12-31'}),/Başlanğıc tarixi düzgün deyil/i);
  const mealSubkonto=api.queryOne(`SELECT id FROM account_subcontos WHERE account_code='721.01' AND code='MEAL'`);
  assert.throws(()=>api.accountAnalyticLedger({accountCode:'531.01',subkontoId:mealSubkonto.id}),/seçilmiş hesaba aid deyil/i);

  const oversizedFile=path.join(temporaryRoot,'oversized.csv');
  fs.writeFileSync(oversizedFile,'Tarix;Məbləğ\n','utf8');
  fs.truncateSync(oversizedFile,100*1024*1024+1);
  assert.throws(()=>api.readImportRecords(oversizedFile),/100 MB limitini keçir/i);
  assert.equal(api.accountingIntegrityReport().healthy,true,'Audit ssenarilərindən sonra uçot bazası sağlam qalmalıdır');

  console.log('code integrity v1.14.3: OK');
}finally{
  try{api.closeDatabase();}catch(_){/* already closed */}
  removeTemporaryDirectory(temporaryRoot);
}
