'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const {removeTemporaryDirectory}=require('./test-filesystem');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');

const projectRoot=path.resolve(__dirname,'..');
const applicationSource=fs.readFileSync(path.join(projectRoot,'main.js'),'utf8');
const rendererSource=fs.readFileSync(path.join(projectRoot,'src','index.html'),'utf8');
const preloadSource=fs.readFileSync(path.join(projectRoot,'preload.js'),'utf8');
assert.match(rendererSource,/id="invoiceRefresh"/,'Qaimə reyestrində artımlı Yenilə düyməsi olmalıdır');
assert.match(rendererSource,/api\.invoice\.sync\(launchDirection\)/,'Qaimə Yenilə əməliyyatı sinxronizasiya IPC-sini çağırmalıdır');
assert.match(rendererSource,/api\.bank\.sync\(bankSelectedAccountId\)/,'Bank Yenilə əməliyyatı yalnız seçilmiş hesabı sinxronlaşdırmalıdır');
assert.match(preloadSource,/sync: \(direction\) => ipcRenderer\.invoke\('invoice:sync'/,'Qaimə sinxronizasiya körpüsü olmalıdır');
assert.match(preloadSource,/sync: \(accountId\) => ipcRenderer\.invoke\('bank:sync'/,'Bank sinxronizasiya körpüsü olmalıdır');
const runtimeSource=applicationSource.split('\napp.whenReady().then(()=>{')[0]+`
module.exports={
  initDb,importInvoiceRecords,bankSaveAccount,bankImportRecords,
  saveIntegrationSyncSource,refreshInvoicesFromConfiguredSource,refreshBankFromConfiguredSource,
  queryOne:(sql,...parameters)=>db.prepare(sql).get(...parameters),
  queryAll:(sql,...parameters)=>db.prepare(sql).all(...parameters),
  execute:(sql,...parameters)=>db.prepare(sql).run(...parameters)
};`;

const temporaryRoot=fs.mkdtempSync(path.join(os.tmpdir(),'meyar-sync-v1142-'));
const electronStub={
  app:{getPath:()=>temporaryRoot,getVersion:()=>'1.14.2'},
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
const applicationApi=moduleContainer.exports;

function writeJson(filePath,value){fs.writeFileSync(filePath,JSON.stringify(value,null,2),'utf8');}

(async()=>{
  try{
    applicationApi.initDb(path.join(temporaryRoot,'company.sqlite'),{companyMeta:{name:'Sinxronizasiya Test MMC',voen:'1234567890',currency:'AZN'}});

    const invoiceSourcePath=path.join(temporaryRoot,'incoming-invoices.json');
    const firstInvoice={invoice_no:'SYNC-INV-1',invoice_date:'2026-09-01',counterparty_name:'Birinci Təchizatçı MMC',voen:'1000000101',direction:'Gələn',base_amount:100,vat_amount:18,total_amount:118};
    writeJson(invoiceSourcePath,[firstInvoice]);
    applicationApi.saveIntegrationSyncSource('invoice','Gələn','file',invoiceSourcePath,null);

    const firstInvoiceSync=await applicationApi.refreshInvoicesFromConfiguredSource('Gələn');
    assert.equal(firstInvoiceSync.created,1,'İlk sinxronizasiya yeni qaiməni yaratmalıdır');
    assert.equal(firstInvoiceSync.skippedExisting,0);

    const firstStoredInvoice=applicationApi.queryOne(`SELECT id,total_amount,updated_at FROM invoices WHERE invoice_no='SYNC-INV-1' AND voen='1000000101' AND direction='Gələn'`);
    const firstInvoiceJournalCount=applicationApi.queryOne(`SELECT COUNT(*) count FROM journal_entries WHERE source_type='invoice' AND source_id=?`,firstStoredInvoice.id).count;
    applicationApi.execute(`UPDATE invoices SET posting_status='Gözləyir' WHERE id=?`,firstStoredInvoice.id);

    writeJson(invoiceSourcePath,[
      {...firstInvoice,total_amount:999,base_amount:999,vat_amount:0},
      {invoice_no:'SYNC-INV-2',invoice_date:'2026-09-02',counterparty_name:'İkinci Təchizatçı MMC',voen:'1000000102',direction:'Gələn',base_amount:50,vat_amount:9,total_amount:59}
    ]);
    const secondInvoiceSync=await applicationApi.refreshInvoicesFromConfiguredSource('Gələn');
    assert.equal(secondInvoiceSync.created,1,'Yalnız yeni qaimə əlavə olunmalıdır');
    assert.equal(secondInvoiceSync.skippedExisting,1,'Bazadakı qaimə dəyişdirilmədən keçilməlidir');
    assert.equal(applicationApi.queryOne(`SELECT COUNT(*) count FROM invoices WHERE invoice_no LIKE 'SYNC-INV-%'`).count,2);

    const unchangedInvoice=applicationApi.queryOne(`SELECT total_amount,updated_at FROM invoices WHERE id=?`,firstStoredInvoice.id);
    assert.equal(unchangedInvoice.total_amount,118,'Duplicate mənbə mövcud qaimənin məbləğini dəyişməməlidir');
    assert.equal(unchangedInvoice.updated_at,firstStoredInvoice.updated_at,'Duplicate mənbə mövcud qaiməyə toxunmamalıdır');
    assert.equal(applicationApi.queryOne(`SELECT COUNT(*) count FROM journal_entries WHERE source_type='invoice' AND source_id=?`,firstStoredInvoice.id).count,firstInvoiceJournalCount,'Duplicate qaimə yenidən müxabirləşməməlidir');
    assert.equal(applicationApi.queryOne(`SELECT posting_status FROM invoices WHERE id=?`,firstStoredInvoice.id).posting_status,'Gözləyir','Sinxronizasiya mövcud qaimənin uçot statusunu bərpa etməməlidir');

    const oppositeDirection=applicationApi.importInvoiceRecords([{...firstInvoice,direction:'Gedən',counterparty_name:'Birinci Müştəri MMC'}],'file-import','outgoing.json','Gedən',{trustedDirection:true});
    assert.equal(oppositeDirection.created,1,'Eyni nömrənin əks istiqaməti ayrıca biznes sənədidir');
    assert.equal(applicationApi.queryOne(`SELECT COUNT(*) count FROM invoices WHERE invoice_no='SYNC-INV-1' AND voen='1000000101'`).count,2);

    const bankAccount=applicationApi.bankSaveAccount({bank_name:'Test Bank',account_name:'AZN hesabı',iban:'AZ21NABZ00000000137010001944',currency:'AZN',ledger_account_code:'223.01'});
    const bankSourcePath=path.join(temporaryRoot,'bank-transactions.json');
    const firstBankTransaction={external_id:'BANK-SYNC-1',transaction_date:'2026-09-03',direction:'Kredit',amount:200,currency:'AZN',counterparty_name:'Birinci Müştəri MMC',description:'Qaimə ödənişi'};
    writeJson(bankSourcePath,[firstBankTransaction]);
    applicationApi.saveIntegrationSyncSource('bank',String(bankAccount.id),'file',bankSourcePath,null);

    const firstBankSync=applicationApi.refreshBankFromConfiguredSource(bankAccount.id);
    assert.equal(firstBankSync.created,1);
    writeJson(bankSourcePath,[
      {...firstBankTransaction,amount:900,description:'Dəyişdirilməyə cəhd'},
      {external_id:'BANK-SYNC-2',transaction_date:'2026-09-04',direction:'Debet',amount:75,currency:'AZN',counterparty_name:'İkinci Təchizatçı MMC',description:'Yeni ödəniş'}
    ]);
    const secondBankSync=applicationApi.refreshBankFromConfiguredSource(bankAccount.id);
    assert.equal(secondBankSync.created,1,'Yalnız yeni bank əməliyyatı əlavə olunmalıdır');
    assert.equal(secondBankSync.skippedExisting,1,'Mövcud bank əməliyyatı dəyişdirilmədən keçilməlidir');
    assert.equal(applicationApi.queryOne(`SELECT COUNT(*) count FROM bank_transactions WHERE bank_account_id=?`,bankAccount.id).count,2);
    assert.equal(applicationApi.queryOne(`SELECT amount FROM bank_transactions WHERE bank_account_id=? AND external_id='BANK-SYNC-1'`,bankAccount.id).amount,200,'Duplicate bank əməliyyatının məbləği dəyişməməlidir');

    const legacyBankRecord={date:'2026-09-05',direction:'Kredit',amount:33,currency:'AZN',counterparty_name:'Legacy Müştəri MMC',description:'Əvvəlki versiya əməliyyatı',reference:'LEGACY-REF-1'};
    applicationApi.bankImportRecords([legacyBankRecord],bankAccount.id);
    const legacyBankTransaction=applicationApi.queryOne(`SELECT id FROM bank_transactions WHERE bank_account_id=? AND reference='LEGACY-REF-1'`,bankAccount.id);
    applicationApi.execute(`UPDATE bank_transactions SET external_id='LEGACY-REF-1' WHERE id=?`,legacyBankTransaction.id);
    const legacyBankDuplicate=applicationApi.bankImportRecords([legacyBankRecord],bankAccount.id);
    assert.equal(legacyBankDuplicate.skippedExisting,1,'Əvvəlki versiyada referansla saxlanmış bank əməliyyatı da təkrar işlənməməlidir');
    assert.equal(applicationApi.queryOne(`SELECT COUNT(*) count FROM bank_transactions WHERE bank_account_id=? AND reference='LEGACY-REF-1'`,bankAccount.id).count,1);
    assert.ok(applicationApi.queryOne(`SELECT COUNT(*) count FROM integration_sync_runs`).count>=4,'Sinxronizasiya audit jurnalı yazılmalıdır');

    console.log('idempotent incremental sync v1.14.2: OK');
  }finally{
    removeTemporaryDirectory(temporaryRoot);
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
