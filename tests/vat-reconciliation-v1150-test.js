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
const vatUiSource=fs.readFileSync(path.join(projectRoot,'src','vat-v1150.js'),'utf8');
const preloadSource=fs.readFileSync(path.join(projectRoot,'preload.js'),'utf8');

assert.match(rendererSource,/id="vatWorkspace"/,'Aylıq ƏDV üçün ayrıca daxili iş sahəsi olmalıdır');
assert.match(rendererSource,/id="navVat"/,'Aylıq ƏDV modul keçidi olmalıdır');
assert.match(rendererSource,/APP_VERSION='1\.16\.0'/);
assert.match(vatUiSource,/pageSize=200/,'Böyük aylıq registr DOM-da səhifələnməlidir');
assert.match(preloadSource,/vat:\s*\{/,'ƏDV IPC körpüsü ayrıca namespace olmalıdır');
for(const channel of ['vat:report','vat:refresh','vat:candidates','vat:allocate','vat:unallocate','vat:setTreatment','vat:addAdjustment','vat:deleteAdjustment','vat:close','vat:reopen','vat:integrity','vat:export']){
  assert.match(preloadSource,new RegExp(`ipcRenderer\\.invoke\\('${channel.replace(':','\\:')}'`),`${channel} preload körpüsündə olmalıdır`);
  assert.ok(applicationSource.includes(`'${channel}'`),`${channel} main prosesində qeydiyyatdan keçməlidir`);
}

const runtimeSource=applicationSource.split('\napp.whenReady().then(()=>{')[0]+`
module.exports={
  initDb,saveInvoice,invoiceDetail,bankSaveAccount,bankImportRecords,bankTransactions,bankReconcile,bankUnreconcile,
  vatPeriodReport,vatRefreshPeriod,vatAllocatePayment,vatUnallocatePayment,vatSetInvoiceTreatment,
  vatAddAdjustment,vatDeleteAdjustment,vatClosePeriod,vatReopenPeriod,vatIntegrityReport,
  queryOne:(sql,...parameters)=>db.prepare(sql).get(...parameters),
  queryAll:(sql,...parameters)=>db.prepare(sql).all(...parameters),
  closeDatabase:()=>{if(db){db.close();db=null;}}
};`;

const temporaryRoot=fs.mkdtempSync(path.join(os.tmpdir(),'meyar-vat-v1150-'));
const electronStub={app:{getPath:()=>temporaryRoot,getVersion:()=>'1.15.0'},BrowserWindow:class{},ipcMain:{handle(){}},dialog:{},shell:{}};
const localRequire=moduleName=>moduleName==='electron'?electronStub:moduleName.startsWith('./')?require(path.join(projectRoot,moduleName)):require(moduleName);
const moduleContainer={exports:{}};
const context=vm.createContext({require:localRequire,module:moduleContainer,exports:moduleContainer.exports,__dirname:projectRoot,__filename:path.join(projectRoot,'main.js'),console,Buffer,URL,setImmediate,clearImmediate,setTimeout,clearTimeout,process});
new vm.Script(runtimeSource,{filename:'main.js'}).runInContext(context);
const api=moduleContainer.exports;

function invoice({number,direction,voen,date,base,vat,itemType='Xidmət'}){
  return api.saveInvoice({
    invoice_no:number,invoice_date:date,direction,counterparty_name:`Kontragent ${voen}`,voen,currency:'AZN',exchange_rate:1,
    counterparty_account_code:direction==='Gələn'?'531.01':'211.01',vat_posting_account_code:direction==='Gələn'?'241.01':'521.01',
    items:[{item_type:itemType,description:`${itemType} üzrə ƏDV sınağı`,qty:1,unit:itemType==='Mal'?'ədəd':'xidmət',unit_price:base,discount_rate:0,vat_rate:vat/base*100,
      posting_account_code:direction==='Gələn'?(itemType==='Mal'?'205.01':'721.01'):'601.02'}]
  });
}

function importBank(apiObject,accountId,record){
  const result=apiObject.bankImportRecords([record],accountId);
  assert.equal(result.created,1,`${record.external_id} bank əməliyyatı yaranmalıdır`);
  return apiObject.queryOne('SELECT * FROM bank_transactions WHERE external_id=?',record.external_id);
}

try{
  api.initDb(path.join(temporaryRoot,'company.sqlite'),{companyMeta:{name:'ƏDV Test MMC',voen:'1234567890',currency:'AZN'}});
  assert.equal(api.queryOne('PRAGMA user_version').user_version,211);

  const incoming=invoice({number:'VAT-IN-001',direction:'Gələn',voen:'1000000301',date:'2026-08-03',base:100,vat:18});
  const outgoing=invoice({number:'VAT-OUT-001',direction:'Gedən',voen:'1000000302',date:'2026-08-04',base:200,vat:36});
  const nonDeductibleGoods=invoice({number:'VAT-GOODS-ND',direction:'Gələn',voen:'1000000304',date:'2026-08-04',base:100,vat:18,itemType:'Mal'});
  api.vatSetInvoiceTreatment({invoiceId:nonDeductibleGoods.id,treatment:'NON_DEDUCTIBLE',note:'Əvəzləşdirilməyən mal alışı'});
  const bank=api.bankSaveAccount({bank_name:'ƏDV Test Bankı',account_name:'AZN hesabı',iban:'AZ21NABZ00000000137010001944',currency:'AZN',ledger_account_code:'223.01'});

  const firstBasePayment=importBank(api,bank.id,{external_id:'BASE-50',date:'2026-08-05',direction:'Debet',amount:50,currency:'AZN',counterparty_name:'Kontragent 1000000301',counterparty_voen:'1000000301'});
  api.bankReconcile({transactionId:firstBasePayment.id,allocations:[{invoiceId:incoming.id,amount:50}]});
  const firstDeposit=importBank(api,bank.id,{external_id:'VAT-DEP-9',date:'2026-08-06',direction:'Debet',amount:9,currency:'AZN',counterparty_name:'DVX ƏDV depozit',description:'ƏDV depozit VAT-IN-001',reference:'VAT-IN-001'});
  const firstLink=api.vatAllocatePayment({transactionId:firstDeposit.id,invoiceId:incoming.id,kind:'VAT_DEPOSIT',amount:9,source:'manual'});
  assert.equal(firstLink.allocated,9);
  assert.throws(()=>api.vatAllocatePayment({transactionId:firstDeposit.id,invoiceId:incoming.id,kind:'VAT_DEPOSIT',amount:9}),/artıq qaiməyə bağlanıb|istifadə olunmamış/i,'Eyni depozit ikinci dəfə bağlanmamalıdır');
  assert.throws(()=>api.bankReconcile({transactionId:firstDeposit.id,allocations:[{invoiceId:incoming.id,amount:9}]}),/ƏDV modulu|ƏDV bağlantısı/i,'ƏDV-yə bağlanmış bank sətri adi ödəniş kimi ikinci dəfə istifadə edilməməlidir');

  let august=api.vatPeriodReport('2026-08');
  let inputRow=august.inputRows.find(row=>row.invoice_id===incoming.id);
  const nonDeductibleRow=august.inputRows.find(row=>row.invoice_id===nonDeductibleGoods.id);
  assert.equal(inputRow.eligible_period,9,'Yarım əsas ödəniş və yarım depozit yalnız 9 AZN giriş ƏDV yaratmalıdır');
  assert.equal(inputRow.status,'Qismən əvəzləşib');
  assert.equal(inputRow.payment_links.length,1,'Registr bank bağlantısının izini qaytarmalıdır');
  assert.equal(nonDeductibleRow.status,'Əvəzləşmir','Mal qaiməsinin ƏDV rejimi ayrıca idarə edilməli və hesaba təsir etməməlidir');
  api.vatUnallocatePayment(firstLink.allocationIds[0]);
  assert.equal(api.vatPeriodReport('2026-08').inputRows.find(row=>row.invoice_id===incoming.id).eligible_period,0,'Depozit əlaqəsi storno ediləndə giriş ƏDV-si geri açılmalıdır');
  assert.equal(api.queryOne('SELECT reconciliation_status FROM bank_transactions WHERE id=?',firstDeposit.id).reconciliation_status,'Uyğunlaşdırılmayıb');
  api.vatAllocatePayment({transactionId:firstDeposit.id,invoiceId:incoming.id,kind:'VAT_DEPOSIT',amount:9,source:'manual'});

  const secondBasePayment=importBank(api,bank.id,{external_id:'BASE-REST',date:'2026-08-07',direction:'Debet',amount:50,currency:'AZN',counterparty_name:'Kontragent 1000000301',counterparty_voen:'1000000301'});
  api.bankReconcile({transactionId:secondBasePayment.id,allocations:[{invoiceId:incoming.id,amount:50}]});
  const secondDeposit=importBank(api,bank.id,{external_id:'VAT-DEP-REST',date:'2026-08-08',direction:'Debet',amount:9,currency:'AZN',counterparty_name:'DVX ƏDV depozit',description:'ƏDV depozit VAT-IN-001'});
  api.vatAllocatePayment({transactionId:secondDeposit.id,invoiceId:incoming.id,kind:'VAT_DEPOSIT',amount:9});
  const fullyPaidIncoming=api.invoiceDetail(incoming.id);
  assert.equal(fullyPaidIncoming.paid_amount,118,'Əsas ödəniş və ƏDV depoziti qaimənin ödənilmiş məbləğində birlikdə görünməlidir');
  assert.equal(fullyPaidIncoming.outstanding_amount,0,'Tam bölünmüş alış qaiməsinin qalığı sıfır olmalıdır');
  const payableNet=api.queryOne(`SELECT ROUND(COALESCE(SUM(l.debit-l.credit),0),2) net FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id AND j.status='Təsdiqlənib' WHERE l.account_code='531.01' AND l.counterparty_id=?`,incoming.counterparty_id).net;
  assert.equal(payableNet,0,'ƏDV depozit müxabirləşməsi 531 kreditor qalığını bağlamalıdır');

  const customerPayment=importBank(api,bank.id,{external_id:'SALE-236',date:'2026-08-09',direction:'Kredit',amount:236,currency:'AZN',counterparty_name:'Kontragent 1000000302',counterparty_voen:'1000000302'});
  api.bankReconcile({transactionId:customerPayment.id,allocations:[{invoiceId:outgoing.id,amount:236}]});
  august=api.vatPeriodReport('2026-08');
  assert.equal(august.summary.input_vat_current,18);
  assert.equal(august.summary.output_vat_current,36);
  assert.equal(august.summary.offset_used,18);
  assert.equal(august.summary.vat_payable,18);
  assert.equal(august.summary.carry_forward_input_vat,0);

  api.vatAddAdjustment({date:'2026-08-31',side:'INPUT',amount:2,contraAccountCode:'721.01',reason:'Vergi yoxlaması üzrə sənədli əlavə giriş ƏDV-si'});
  august=api.vatPeriodReport('2026-08');
  assert.equal(august.summary.input_vat_current,20);
  assert.equal(august.summary.vat_payable,16);
  const temporaryAdjustment=api.vatAddAdjustment({date:'2026-08-31',side:'OUTPUT',amount:1,contraAccountCode:'721.01',reason:'Storno nəzarəti üçün müvəqqəti düzəliş'});
  api.vatDeleteAdjustment(temporaryAdjustment.id);
  assert.equal(api.queryOne(`SELECT COUNT(*) count FROM journal_entries WHERE source_type='vat_adjustment' AND source_id=? AND status='Təsdiqlənib'`,temporaryAdjustment.id).count,0,'Silinən ƏDV düzəlişinin aktiv müxabirləşməsi qalmamalıdır');
  assert.equal(api.vatPeriodReport('2026-08').summary.vat_payable,16,'Storno edilmiş düzəliş aylıq nəticəni dəyişməməlidir');

  const automaticInvoice=invoice({number:'VAT-AUTO-002',direction:'Gələn',voen:'1000000303',date:'2026-08-10',base:50,vat:9});
  const autoBase=importBank(api,bank.id,{external_id:'AUTO-BASE',date:'2026-08-11',direction:'Debet',amount:50,currency:'AZN',counterparty_name:'Kontragent 1000000303',counterparty_voen:'1000000303'});
  api.bankReconcile({transactionId:autoBase.id,allocations:[{invoiceId:automaticInvoice.id,amount:50}]});
  importBank(api,bank.id,{external_id:'AUTO-VAT',date:'2026-08-12',direction:'Debet',amount:9,currency:'AZN',counterparty_name:'DVX depozit',counterparty_voen:'1000000303',description:'ƏDV depozit VAT-AUTO-002'});
  const futureInvoice=invoice({number:'VAT-FUTURE-003',direction:'Gələn',voen:'1000000305',date:'2026-08-15',base:30,vat:5.4});
  const futureDeposit=importBank(api,bank.id,{external_id:'FUTURE-VAT',date:'2026-09-02',direction:'Debet',amount:5.4,currency:'AZN',counterparty_name:'DVX depozit',counterparty_voen:'1000000305',description:'ƏDV depozit VAT-FUTURE-003'});
  const refreshed=api.vatRefreshPeriod('2026-08');
  assert.equal(refreshed.autoMatch.matched,1,'Unikal qaimə nömrəli depozit Yenilə zamanı avtomatik bağlanmalıdır');
  assert.equal(api.queryOne('SELECT reconciliation_status FROM bank_transactions WHERE id=?',futureDeposit.id).reconciliation_status,'Uyğunlaşdırılmayıb','Avqust yeniləməsi sentyabr depozitini emal etməməlidir');
  assert.equal(api.queryOne('SELECT COUNT(*) count FROM vat_payment_allocations WHERE invoice_id=?',futureInvoice.id).count,0,'Seçilməyən ayın qaiməsinə avtomatik ƏDV bağlantısı yaranmamalıdır');
  assert.equal(api.vatRefreshPeriod('2026-08').autoMatch.matched,0,'İkinci Yenilə mövcud depoziti yenidən işləməməlidir');

  api.vatAddAdjustment({date:'2026-08-31',side:'INPUT',amount:10,contraAccountCode:'721.01',reason:'Növbəti aya qalığın daşınması sınağı'});
  august=api.vatPeriodReport('2026-08');
  assert.equal(august.summary.vat_payable,0);
  assert.equal(august.summary.carry_forward_input_vat,3,'Artıq giriş ƏDV-si növbəti aya daşınmalıdır');

  const closed=api.vatClosePeriod({periodKey:'2026-08'});
  assert.equal(closed.locked,true);
  assert.equal(closed.period.status,'CLOSED');
  assert.equal(api.vatRefreshPeriod('2026-08').autoMatch.skippedClosed,true,'Bağlı ƏDV dövründə Yenilə avtomatik uyğunlaşdırma aparmamalıdır');
  assert.equal(api.queryOne(`SELECT COUNT(*) count FROM journal_entries WHERE source_type='vat_period_close' AND source_id=202608 AND status='Təsdiqlənib'`).count,1,'Ay bağlananda ƏDV əvəzləşmə müxabirləşməsi yaranmalıdır');
  const closeJournalBalance=api.queryOne(`SELECT ROUND(SUM(l.debit),2) debit,ROUND(SUM(l.credit),2) credit FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id WHERE j.source_type='vat_period_close' AND j.source_id=202608`);
  assert.equal(closeJournalBalance.debit,closeJournalBalance.credit,'Ay bağlanış müxabirləşməsi Debet/Kredit üzrə balanslaşmalıdır');
  assert.equal(api.vatPeriodReport('2026-09').summary.opening_input_vat,3,'Bağlı dövrün giriş ƏDV qalığı növbəti aya açılış kimi keçməlidir');
  assert.throws(()=>api.vatAddAdjustment({date:'2026-08-31',side:'OUTPUT',amount:1,reason:'Bağlı ayda dəyişiklik'}),/ƏDV dövrü bağlıdır/i);
  assert.throws(()=>api.bankUnreconcile(customerPayment.id),/ƏDV dövrü bağlıdır/i,'Bağlı aya təsir edən bank storno əməliyyatı bloklanmalıdır');
  assert.throws(()=>api.saveInvoice({...incoming,items:incoming.items}),/ƏDV dövrü bağlıdır|təsir edən/i,'Bağlı aya təsir edən qaimə dəyişdirilməməlidir');
  assert.equal(api.vatPeriodReport('2026-08').locked,true,'Bağlı dövr canlı məlumat deyil, dəyişməz snapshot qaytarmalıdır');

  assert.throws(()=>api.vatReopenPeriod({periodKey:'2026-08',reason:''}),/səbəbi/i);
  const reopened=api.vatReopenPeriod({periodKey:'2026-08',reason:'Nəzarət testi üçün yenidən açıldı'});
  assert.equal(reopened.period.status,'OPEN');
  assert.equal(api.queryOne(`SELECT COUNT(*) count FROM journal_entries WHERE source_type='vat_period_close' AND source_id=202608 AND status='Təsdiqlənib'`).count,0,'Dövr yenidən açılanda bağlanış müxabirləşməsi storno edilməlidir');
  assert.equal(api.vatIntegrityReport().healthy,true,'ƏDV registrində artıq bölgü və zədələnmiş əlaqə olmamalıdır');
  assert.throws(()=>api.vatPeriodReport('2026-13'),/ayı düzgün deyil/i);

  console.log('monthly VAT reconciliation v1.15.0: OK');
}finally{
  try{api.closeDatabase();}catch(_){/* already closed */}
  removeTemporaryDirectory(temporaryRoot);
}
