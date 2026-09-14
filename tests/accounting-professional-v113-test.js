'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
const runtimeSource = source.split('\napp.whenReady().then(()=>{')[0] + `
module.exports={
  initDb,saveInvoice,invoiceDetail,importInvoiceRecords,turnoverBalance,turnoverBalanceGroups,
  accountAnalytics,accountAnalyticLedger,accountingIntegrityReport,repairAutomaticInvoiceAccountingIntegrity,
  saveReferenceAccount,saveSubkonto,saveContract,saveCatalogItem,
  queryAll:(sql,...params)=>db.prepare(sql).all(...params),
  queryOne:(sql,...params)=>db.prepare(sql).get(...params),
  execute:(sql,...params)=>db.prepare(sql).run(...params),
  closeDatabase:()=>{db.close();db=null;}
};`;

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meyar-v113-professional-'));
const electronStub = {
  app: { getPath: () => temporaryRoot, getVersion: () => '1.13.0' },
  BrowserWindow: class {}, ipcMain: { handle() {} }, dialog: {}, shell: {}
};
const localRequire = moduleId => moduleId === 'electron'
  ? electronStub
  : moduleId.startsWith('./') ? require(path.join(projectRoot, moduleId)) : require(moduleId);
const moduleBox = { exports: {} };
const context = vm.createContext({
  require: localRequire,module:moduleBox,exports:moduleBox.exports,__dirname:projectRoot,__filename:path.join(projectRoot,'main.js'),
  console,Buffer,URL,setImmediate,clearImmediate,setTimeout,clearTimeout,process
});
new vm.Script(runtimeSource,{filename:'main.js'}).runInContext(context);
const api = moduleBox.exports;

function manualInvoice({number,direction='Gələn',name='Test Kontragent MMC',voen='1234567890',date='2026-08-10',itemType='Xidmət',description='Peşəkar xidmət',code='',quantity=1,price=100,account,warehouseId=null,id=null}) {
  return api.saveInvoice({
    id,invoice_no:number,invoice_date:date,direction,counterparty_name:name,voen,currency:'AZN',exchange_rate:1,
    counterparty_account_code:direction==='Gələn'?'531.01':'211.01',vat_posting_account_code:direction==='Gələn'?'241.01':'521.01',
    items:[{item_code:code,item_type:itemType,description,qty:quantity,unit:itemType==='Mal'?'ədəd':'xidmət',unit_price:price,discount_rate:0,vat_rate:0,
      posting_account_code:account||(direction==='Gələn'?(itemType==='Mal'?'205.01':'721.01'):(itemType==='Mal'?'601.01':'601.02')),warehouse_id:warehouseId}]
  });
}

try {
  api.initDb(path.join(temporaryRoot,'company.sqlite'),{companyMeta:{name:'Peşəkar Audit MMC',voen:'1234567890',currency:'AZN'}});

  const settings=api.queryOne(`SELECT accounting_enabled,auto_post_invoices FROM company_settings WHERE id=1`);
  assert.equal(settings.accounting_enabled,1,'Uçot hər şirkət bazasında aktiv olmalıdır');
  assert.equal(settings.auto_post_invoices,1,'Qaimələrin avtomatik uçotu məcburi olmalıdır');
  assert.equal(api.queryOne(`SELECT is_postable FROM accounts WHERE code='721'`).is_postable,0,'721 qrup hesabı olmalıdır');
  assert.equal(api.queryOne(`SELECT is_postable FROM accounts WHERE code='721.01'`).is_postable,1,'721.01 yazılış hesabı olmalıdır');
  assert.equal(api.queryOne(`SELECT COUNT(*) count FROM accounts WHERE code IN ('721.02','721.03','721.04') AND active=1`).count,0,'Xərc maddələri ayrıca hesab kimi aktiv qalmamalıdır');
  assert.equal(api.queryOne(`SELECT COUNT(*) count FROM account_subcontos WHERE account_code='721.01' AND active=1`).count>=8,true,'721.01 daxilində xərc subkontoları olmalıdır');

  const imported=api.importInvoiceRecords([
    {invoice_no:'TEL-001',invoice_date:'2026-08-01',counterparty_name:'Ümumi Telekom MMC',voen:'1000000001',direction:'Gələn',main_note:'Mobil telefon və internet rabitə xidməti',base_amount:100,vat_amount:0,total_amount:100},
    {invoice_no:'TRN-001',invoice_date:'2026-08-02',counterparty_name:'Logistika MMC',voen:'1000000002',direction:'Gələn',main_note:'Nəqliyyat və ekspedisiya xidməti',base_amount:200,vat_amount:0,total_amount:200},
    {invoice_no:'MEAL-001',invoice_date:'2026-08-03',counterparty_name:'Katerinq MMC',voen:'1000000003',direction:'Gələn',main_note:'İşçi yemək və katerinq xidməti',base_amount:300,vat_amount:0,total_amount:300}
  ],'file-import','professional-import.csv','Gələn',{trustedDirection:true});
  assert.deepEqual({created:imported.created,posted:imported.posted,failed:imported.failed},{created:3,posted:3,failed:0});

  const classifiedRows=api.queryAll(`SELECT i.invoice_no,ii.posting_account_code,s.code subkonto_code,i.posting_status
    FROM invoices i JOIN invoice_items ii ON ii.invoice_id=i.id LEFT JOIN account_subcontos s ON s.id=ii.subkonto_id
    WHERE i.invoice_no IN ('TEL-001','TRN-001','MEAL-001') ORDER BY i.invoice_no`);
  assert.deepEqual(classifiedRows.map(row=>row.posting_account_code),['721.01','721.01','721.01']);
  assert.deepEqual(classifiedRows.map(row=>row.posting_status),['Uçota alınıb','Uçota alınıb','Uçota alınıb']);
  assert.equal(classifiedRows.find(row=>row.invoice_no==='TEL-001').subkonto_code,'TELECOM');
  assert.equal(classifiedRows.find(row=>row.invoice_no==='TRN-001').subkonto_code,'TRANSPORT');
  assert.equal(classifiedRows.find(row=>row.invoice_no==='MEAL-001').subkonto_code,'MEAL');

  const expenseAnalytics=api.accountAnalytics('721','2026-08-01','2026-08-31');
  assert.equal(expenseAnalytics.type,'subcontos');
  assert.equal(expenseAnalytics.rows.filter(row=>row.subkonto_code==='TELECOM').length,1,'Eyni subkonto sənədlər üzrə təkrarlanmamalıdır');
  assert.equal(expenseAnalytics.rows.find(row=>row.subkonto_code==='TELECOM').debit,100);
  assert.equal(expenseAnalytics.rows.find(row=>row.subkonto_code==='TRANSPORT').debit,200);
  assert.equal(expenseAnalytics.rows.find(row=>row.subkonto_code==='MEAL').debit,300);
  const telecomSubkonto=api.queryOne(`SELECT id FROM account_subcontos WHERE account_code='721.01' AND code='TELECOM'`);
  const telecomLedger=api.accountAnalyticLedger({accountCode:'721',subkontoId:telecomSubkonto.id,from:'2026-08-01',to:'2026-08-31'});
  assert.equal(telecomLedger.entries.length,1,'Subkonto DBC-dən sənədə açılmalıdır');
  assert.equal(telecomLedger.entries[0].account_code,'721.01');

  manualInvoice({number:'STOCK-IN',date:'2026-08-04',itemType:'Mal',description:'Test malı',code:'STOCK-001',quantity:10,price:10,account:'205.01',warehouseId:1,voen:'1000000004'});
  let outgoing=manualInvoice({number:'STOCK-OUT',direction:'Gedən',date:'2026-08-05',itemType:'Mal',description:'Test malı',code:'STOCK-001',quantity:4,price:15,account:'601.01',warehouseId:1,voen:'1000000005'});
  assert.ok(outgoing.journal.some(line=>line.account_code==='701.01'&&line.debit===40),'Gedən mal qaiməsi maya dəyərini yazmalıdır');
  outgoing=manualInvoice({id:outgoing.id,number:'STOCK-OUT',direction:'Gedən',date:'2026-08-05',itemType:'Mal',description:'Test malı',code:'STOCK-001',quantity:5,price:15,account:'601.01',warehouseId:1,voen:'1000000005'});
  assert.ok(outgoing.journal.some(line=>line.account_code==='701.01'&&line.debit===50),'Redaktədən sonra aktiv maya dəyəri yenidən hesablanmalıdır');
  const netByAccount=api.queryAll(`SELECT l.account_code,ROUND(SUM(l.debit-l.credit),2) net
    FROM journal_entries j JOIN journal_lines l ON l.journal_entry_id=j.id
    WHERE j.source_id=? AND j.source_type LIKE 'invoice%' AND j.status='Təsdiqlənib'
    GROUP BY l.account_code ORDER BY l.account_code`,outgoing.id);
  const netMap=Object.fromEntries(netByAccount.map(row=>[row.account_code,row.net]));
  assert.equal(netMap['205.01'],-50,'Storno edilmiş maya sətirləri aktiv uçotu pozmamalıdır');
  assert.equal(netMap['701.01'],50,'Maya dəyərinin yekun təsiri yalnız cari sənədə bərabər olmalıdır');
  assert.equal(netMap['211.01'],75);assert.equal(netMap['601.01'],-75);
  assert.equal(api.queryOne(`SELECT COUNT(*) count FROM (SELECT j.id FROM journal_entries j JOIN journal_lines l ON l.journal_entry_id=j.id GROUP BY j.id HAVING ABS(SUM(l.debit)-SUM(l.credit))>0.005)`).count,0);

  const repairTarget=api.queryOne(`SELECT id FROM invoices WHERE invoice_no='TEL-001'`);
  api.execute(`DELETE FROM journal_entries WHERE source_type='invoice' AND source_id=?`,repairTarget.id);
  assert.equal(api.accountingIntegrityReport().missingInvoicePostings,1);
  const repair=api.repairAutomaticInvoiceAccountingIntegrity();
  assert.equal(repair.failed,0);assert.equal(repair.repaired,1);
  assert.equal(api.invoiceDetail(repairTarget.id).posting_status,'Uçota alınıb');
  assert.equal(api.accountingIntegrityReport().healthy,true,'Yekun uçot bütövlüyü sağlam olmalıdır');

  const groups=api.turnoverBalanceGroups({from:'2026-08-01',to:'2026-08-31',includeZero:false});
  const expenseGroup=groups.find(row=>row.code==='721');
  assert.equal(expenseGroup.period_debit,600,'721 qrup DBC-si bütün subkonto xərclərini toplamalıdır');

  api.execute(`UPDATE warehouses SET allow_negative_stock=1 WHERE id=1`);
  const legacyShortage=manualInvoice({number:'LEGACY-SHORTAGE',direction:'Gedən',date:'2026-08-20',itemType:'Mal',description:'Tarixi mənfi qalıqlı mal',code:'LEGACY-NEG-001',quantity:2,price:25,account:'601.01',warehouseId:1,voen:'1000000099'});
  api.execute(`UPDATE warehouses SET allow_negative_stock=0 WHERE id=1`);
  api.execute(`DELETE FROM journal_entries WHERE source_type LIKE 'invoice%' AND source_id=?`,legacyShortage.id);
  api.execute(`UPDATE invoices SET posting_status='Hazırlanmayıb',auto_posted=0 WHERE id=?`,legacyShortage.id);
  api.execute(`UPDATE company_settings SET accounting_enabled=0,auto_post_invoices=0 WHERE id=1`);
  api.closeDatabase();
  api.initDb(path.join(temporaryRoot,'company.sqlite'),{backupExisting:false});
  const reactivatedSettings=api.queryOne(`SELECT accounting_enabled,auto_post_invoices FROM company_settings WHERE id=1`);
  assert.equal(reactivatedSettings.accounting_enabled,1,'Köhnə bazada söndürülmüş uçot avtomatik aktivləşdirilməlidir');
  assert.equal(reactivatedSettings.auto_post_invoices,1,'Köhnə bazada avtomatik uçot məcburi aktivləşdirilməlidir');
  const migratedShortage=api.invoiceDetail(legacyShortage.id);
  assert.equal(migratedShortage.posting_status,'Uçota alınıb','Mənfi qalıqlı tarixi qaimə bazanın açılmasını bloklamamalıdır');
  assert.equal(Number(migratedShortage.accounting_review_required),1,'Tarixi mənfi qalıq istifadəçiyə yoxlama xəbərdarlığı kimi saxlanmalıdır');

  const stockOutItem=api.queryOne(`SELECT id FROM invoice_items WHERE invoice_id=?`,outgoing.id);
  api.execute(`UPDATE stock_movements SET total_cost=total_cost+1 WHERE invoice_item_id=?`,stockOutItem.id);
  const damagedStockValue=api.accountingIntegrityReport();
  assert.equal(damagedStockValue.mismatchedStockValues,1,'Anbar hərəkətinin jurnal ilə uyğunlaşmayan dəyəri aşkarlanmalıdır');
  assert.equal(damagedStockValue.healthy,false);
  api.repairAutomaticInvoiceAccountingIntegrity();
  assert.equal(api.accountingIntegrityReport().mismatchedStockValues,0,'Uyğunlaşmayan anbar dəyəri yenidən hesablanmalıdır');

  api.execute(`DELETE FROM stock_movements WHERE invoice_item_id=?`,stockOutItem.id);
  const damagedInventory=api.accountingIntegrityReport();
  assert.equal(damagedInventory.missingStockMovements,1,'Silinmiş anbar hərəkəti auditdə aşkarlanmalıdır');
  assert.equal(damagedInventory.healthy,false,'Anbar və Baş kitab fərqi sağlam hesab edilə bilməz');
  const inventoryRepair=api.repairAutomaticInvoiceAccountingIntegrity();
  assert.equal(inventoryRepair.failed,0);
  assert.equal(inventoryRepair.inventoryScopesRebuilt>0,true,'Anbar sahəsi yenidən hesablanmalıdır');
  assert.equal(api.accountingIntegrityReport().healthy,true,'Anbar hərəkəti bərpa edildikdən sonra bütövlük sağlam olmalıdır');

  const importedShortage=api.importInvoiceRecords([{invoice_no:'DVX-STOCK-SHORTAGE',invoice_date:'2026-08-25',counterparty_name:'DVX Müştəri MMC',voen:'1000000088',direction:'Gedən',item_type:'Mal',main_note:'Anbarda açılış qalığı olmayan satış malı',base_amount:90,vat_amount:0,total_amount:90}],'file-import','dvx-stock-shortage.xlsx','Gedən',{trustedDirection:true});
  assert.deepEqual({created:importedShortage.created,posted:importedShortage.posted,failed:importedShortage.failed},{created:1,posted:1,failed:0},'Etibarlı idxal mənfi qalıq səbəbindən bütün paketi itirməməlidir');
  const importedShortageInvoice=api.queryOne(`SELECT posting_status,accounting_review_required FROM invoices WHERE invoice_no='DVX-STOCK-SHORTAGE'`);
  assert.equal(importedShortageInvoice.posting_status,'Uçota alınıb');
  assert.equal(Number(importedShortageInvoice.accounting_review_required),1,'Mənfi anbar qalığı yoxlama bildirişi yaratmalıdır');

  api.saveReferenceAccount({code:'721.50',name:'Test xərc hesabı',kind:'expense',role:'EXPENSE',is_postable:true});
  api.saveReferenceAccount({code:'721.50',name:'Test xərc hesabı',kind:'expense',role:'',is_postable:true});
  assert.equal(api.queryOne(`SELECT role FROM accounts WHERE code='721.50'`).role,null,'İstifadə olunmayan semantik rol silinə bilməlidir');
  api.saveSubkonto({account_code:'721.50',code:'TEST',name:'Test analitikası',dimension:'Xərc maddəsi'});
  assert.throws(()=>api.saveSubkonto({account_code:'721.50',code:'TEST',name:'Dublikat',dimension:'Xərc maddəsi'}),/artıq mövcuddur/,'Eyni hesabda subkonto kodu təkrarlanmamalıdır');
  const contractCounterparty=api.queryOne(`SELECT id FROM counterparties WHERE voen='1000000001'`);
  api.saveContract({counterparty_id:contractCounterparty.id,contract_no:'M-001',contract_date:'2026-01-01',end_date:'2026-12-31',currency:'AZN'});
  assert.throws(()=>api.saveContract({counterparty_id:contractCounterparty.id,contract_no:'M-001',currency:'AZN'}),/artıq mövcuddur/,'Kontragent üzrə müqavilə nömrəsi təkrarlanmamalıdır');
  assert.throws(()=>api.saveContract({counterparty_id:contractCounterparty.id,contract_no:'M-002',contract_date:'2026-12-31',end_date:'2026-01-01',currency:'AZN'}),/əvvəl ola bilməz/,'Müqavilə tarix ardıcıllığı qorunmalıdır');

  const telecomCatalog=api.queryOne(`SELECT c.* FROM item_catalog c JOIN invoice_items ii ON ii.catalog_item_id=c.id JOIN invoices i ON i.id=ii.invoice_id WHERE i.invoice_no='TEL-001'`);
  api.saveCatalogItem({id:telecomCatalog.id,code:telecomCatalog.code,name:telecomCatalog.name,item_type:'Xidmət',unit:telecomCatalog.unit,purchase_account_code:'721.99',sales_account_code:'601.02',standard_cost:0});
  const remappedTelecom=api.queryOne(`SELECT ii.posting_account_code,s.account_code subkonto_account,s.code subkonto_code FROM invoice_items ii JOIN invoices i ON i.id=ii.invoice_id LEFT JOIN account_subcontos s ON s.id=ii.subkonto_id WHERE i.invoice_no='TEL-001'`);
  assert.equal(remappedTelecom.posting_account_code,'721.99');
  assert.equal(remappedTelecom.subkonto_account,'721.99','Hesab dəyişəndə köhnə hesabın subkontosu saxlanmamalıdır');
  assert.equal(remappedTelecom.subkonto_code,'UNCLASSIFIED');
  assert.equal(api.accountingIntegrityReport().healthy,true);

  console.log('accounting professional v1.13.0: OK');
} finally {
  fs.rmSync(temporaryRoot,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
