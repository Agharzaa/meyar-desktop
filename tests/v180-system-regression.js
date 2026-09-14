'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');

const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'main.js'),'utf8');
const runtimeSource=source.split('\napp.whenReady().then(()=>{')[0]+`
module.exports={initDb,saveInvoice,invoiceDetail,referenceSnapshot,accountAnalytics,turnoverBalanceSummary};`;
const tempRoot=fs.mkdtempSync(path.join(os.tmpdir(),'meyar-v180-'));
const electronStub={app:{getPath:()=>tempRoot,getVersion:()=>'1.8.0'},BrowserWindow:class{},ipcMain:{handle(){}},dialog:{},shell:{}};
const localRequire=id=>id==='electron'?electronStub:id.startsWith('./')?require(path.join(root,id)):require(id);
const moduleBox={exports:{}};
const context=vm.createContext({require:localRequire,module:moduleBox,exports:moduleBox.exports,__dirname:root,__filename:path.join(root,'main.js'),console,Buffer,URL,setImmediate,clearImmediate,setTimeout,clearTimeout,process});
new vm.Script(runtimeSource,{filename:'main.js'}).runInContext(context);
const api=moduleBox.exports;

const dbPath=path.join(tempRoot,'company.sqlite');
api.initDb(dbPath,{companyMeta:{name:'Uçot Test MMC',voen:'1234567890',currency:'AZN'}});
const refs=api.referenceSnapshot();
assert.equal(refs.warehouses.length,1);
assert.equal(refs.warehouses[0].valuation_method,'AVERAGE');
assert.ok(refs.subcontos.some(row=>row.code==='MEAL'));
assert.ok(refs.rules.some(row=>row.name==='Rabitə — mobil'));

const azercell=api.saveInvoice({
  invoice_no:'AZ-100',invoice_date:'2026-09-01',direction:'Gələn',counterparty_name:'Azercell Telekom MMC Seriya və nömrə: MT260800000001 | Yekun məbləğ: 118,00',voen:'9900001121',currency:'AZN',
  counterparty_account_code:'531.01',vat_posting_account_code:'241.01',items:[{description:'Aylıq mobil rabitə xidməti',qty:1,unit:'xidmət',unit_price:100,vat_rate:18}]
});
assert.equal(azercell.posting_status,'Uçota alınıb');
assert.equal(azercell.auto_posted,1);
assert.equal(azercell.counterparty_name,'Azercell Telekom MMC');
assert.equal(azercell.items[0].item_type,'Xidmət');
assert.equal(azercell.items[0].posting_account_code,'721.01');
assert.equal(refs.subcontos.find(row=>row.id===azercell.items[0].subkonto_id).code,'TELECOM');
assert.ok(azercell.journal.some(line=>line.account_code==='721.01'&&line.subkonto_id===azercell.items[0].subkonto_id&&line.debit===100));
assert.ok(azercell.journal.some(line=>line.account_code==='531.01'&&line.credit===118));

const meal=refs.subcontos.find(row=>row.code==='MEAL');
const reclassified=api.saveInvoice({
  id:azercell.id,invoice_no:'AZ-100',invoice_date:'2026-09-01',direction:'Gələn',counterparty_name:'Azercell Telekom MMC',voen:'9900001121',currency:'AZN',
  counterparty_account_code:'531.01',vat_posting_account_code:'241.01',items:[{description:'İşçi yemək xidməti',item_type:'Xidmət',qty:1,unit:'xidmət',unit_price:100,vat_rate:18,posting_account_code:'721.01',subkonto_id:meal.id}]
});
assert.ok(reclassified.journal.some(line=>line.account_code==='721.01'&&line.subkonto_id===meal.id));
assert.equal(reclassified.journal.some(line=>line.subkonto_id===azercell.items[0].subkonto_id),false);

const purchase=api.saveInvoice({
  invoice_no:'MAT-IN-1',invoice_date:'2026-09-02',direction:'Gələn',counterparty_name:'Material Təchizat MMC',voen:'1111111111',currency:'AZN',
  counterparty_account_code:'531.01',vat_posting_account_code:'241.01',items:[{item_code:'MAT-X',item_type:'Mal',description:'Test materialı',qty:10,unit:'ədəd',unit_price:100,vat_rate:0,posting_account_code:'205.01',warehouse_id:refs.warehouses[0].id}]
});
assert.equal(purchase.posting_status,'Uçota alınıb');
const sale=api.saveInvoice({
  invoice_no:'MAT-OUT-1',invoice_date:'2026-09-03',direction:'Gedən',counterparty_name:'Alıcı MMC',voen:'2222222222',currency:'AZN',
  counterparty_account_code:'211.01',vat_posting_account_code:'521.01',items:[{item_code:'MAT-X',item_type:'Mal',description:'Test materialı',qty:4,unit:'ədəd',unit_price:150,vat_rate:0,posting_account_code:'601.01',warehouse_id:refs.warehouses[0].id}]
});
assert.ok(sale.journal.some(line=>line.account_code==='701.01'&&line.debit===400));
assert.ok(sale.journal.some(line=>line.account_code==='205.01'&&line.credit===400));

const inventoryAnalytics=api.accountAnalytics('205.01','2026-09-01','2026-09-30');
assert.equal(inventoryAnalytics.type,'inventory');
const material=inventoryAnalytics.rows.find(row=>row.item_code==='MAT-X');
assert.equal(material.closing_qty,6);
assert.equal(material.closing_value,600);

const summary=api.turnoverBalanceSummary({from:'2026-09-01',to:'2026-09-30'});
assert.equal(summary.turnover_debit,summary.turnover_credit);

fs.rmSync(tempRoot,{recursive:true,force:true});
console.log('system v1.8.0 regression: OK');
