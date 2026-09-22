'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const XLSX=require('xlsx');
const {removeTemporaryDirectory}=require('./test-filesystem');
const root=path.resolve(__dirname,'..');
const temporaryRoot=fs.mkdtempSync(path.join(os.tmpdir(),'meyar-bank-statement-'));
let selectedFile;
const electron={app:{getPath:()=>temporaryRoot,getVersion:()=>require('../package.json').version},BrowserWindow:class{},ipcMain:{handle(){}},dialog:{showOpenDialog:async()=>selectedFile?{filePaths:[selectedFile],canceled:false}:{filePaths:[],canceled:true}},shell:{}};
const moduleBox={exports:{}};
const source=fs.readFileSync(path.join(root,'main.js'),'utf8').split('\napp.whenReady().then(()=>{')[0]+`
module.exports={initDb,bankSaveAccount,readBankImportRecords,chooseAndImportBankFile,refreshBankFromConfiguredSource,closeDatabasesForExit,
query:(sql)=>db.prepare(sql).all()};`;
new vm.Script(source).runInContext(vm.createContext({require:id=>id==='electron'?electron:id.startsWith('./')?require(path.join(root,id)):require(id),module:moduleBox,exports:moduleBox.exports,__dirname:root,console,Buffer,URL,setTimeout,clearTimeout,setImmediate,clearImmediate,process}));
const api=moduleBox.exports;
const iban='AZ00TEST40050AZNHC0000000001';
const headers=['Əməliyyat tarixi','İcra tarixi','Ödəyən/Benefisiar','Təyinat','İstinad No','VÖEN','Mədaxil','Məxaric','Balans'];
function fixture(file,format='xlsx'){
  const rows=Array.from({length:12},()=>[]);
  rows[6]=['HESAB ÜZRƏ ÇIXARIŞ'];rows[7]=['IBAN:',iban];
  rows.push(headers,
    ['01.01.2026','','DÖVRÜN ƏVVƏLİNƏ BALANS AZN','','','','','',100],
    ['01.01.2026','','MÖVCUD BALANS AZN','','','','','',100],
    ['05.01.2026','06.01.2026','Test müştəri MMC','Test daxilolması','REF-SHARED','1000000001',200,'',300],
    ['05.01.2026','06.01.2026','Test bank','Komissiya','REF-SHARED','1000000002','',2,298],
    ['07.01.2026','07.01.2026','Test təchizatçı','Test ödənişi','REF-OUT','1000000003','',30,268],
    ['22.09.2026','','DÖVRÜN SONUNA BALANS AZN','','','',200,32,268],
    ['22.09.2026','','MÖVCUD BALANS AZN','','','','','',260],
    [],['Test bank footer','','','Ünvan','','','tel: +994 00 000 00 00']);
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(rows),'Statement');
  wb.Sheets.Statement['!ref']='A7:I23';
  XLSX.writeFile(wb,file,{bookType:format});
}
(async()=>{
  try{
    api.initDb(path.join(temporaryRoot,'company.sqlite'),{companyMeta:{name:'Bank test MMC',voen:'1234567890',currency:'AZN'}});
    const account=api.bankSaveAccount({bank_name:'Test bank',iban,currency:'AZN',ledger_account_code:'223.01'});
    selectedFile=path.join(temporaryRoot,'statement.xlsx');fixture(selectedFile);
    const records=api.readBankImportRecords(selectedFile,account.id);
    assert.equal(records.length,3,'Opening/closing balances and footer are not transactions');
    assert.equal(records[0].counterparty_name,'Test müştəri MMC');
    assert.equal(records[0].reference,'REF-SHARED');
    assert.equal(records[0].value_date,'2026-01-06');
    const result=await api.chooseAndImportBankFile(account.id);
    assert.equal(result.created,3);assert.equal(result.failed,0);
    const totals=api.query('SELECT direction,SUM(amount) amount,COUNT(*) count FROM bank_transactions GROUP BY direction');
    assert.equal(totals.find(r=>r.direction==='Ödəniş').amount,32);
    assert.equal(totals.find(r=>r.direction==='Daxilolma').amount,200);
    const repeat=await api.chooseAndImportBankFile(account.id);
    assert.equal(repeat.created,0);assert.equal(repeat.skippedExisting,3);
    const sync=api.refreshBankFromConfiguredSource(account.id);
    assert.equal(sync.created,0);assert.equal(sync.skippedExisting,3);assert.equal(sync.failed,0);
    const other=api.bankSaveAccount({bank_name:'Other bank',iban:'AZ00TEST40050AZNHC0000000002',currency:'AZN',ledger_account_code:'223.01'});
    assert.throws(()=>api.readBankImportRecords(selectedFile,other.id),/IBAN/);
    await assert.rejects(()=>api.chooseAndImportBankFile(other.id),/IBAN/);
    assert.equal(api.query('SELECT COUNT(*) n FROM bank_transactions')[0].n,3);
    const csv=path.join(temporaryRoot,'statement.csv');fixture(csv,'csv');
    assert.equal(api.readBankImportRecords(csv,account.id).length,3);
    selectedFile=undefined;
    assert.equal((await api.chooseAndImportBankFile(account.id)).cancelled,true);
    console.log('Bank statement import: XLSX/CSV, totals, aliases, account validation, cancellation, repeat import and refresh OK');
    // Optional private fixtures stay outside the repository and are never copied.
    for(const file of process.argv.slice(2)){
      const wb=XLSX.readFile(file);const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{range:0,header:1,defval:''});
      const realIban=String(rows[7][1]);
      const known=api.query('SELECT id,iban FROM bank_accounts').find(a=>a.iban===realIban);
      const realAccount=known||api.bankSaveAccount({bank_name:'Statement validation',iban:realIban,currency:'AZN',ledger_account_code:'223.01'});
      selectedFile=file;
      const expected=rows.slice(15).filter(r=>r[1]&&r[4]);
      const parsed=api.readBankImportRecords(file,realAccount.id);
      assert.equal(parsed.length,expected.length);
      const imported=await api.chooseAndImportBankFile(realAccount.id);
      assert.equal(imported.created,expected.length);assert.equal(imported.failed,0);
      const duplicate=await api.chooseAndImportBankFile(realAccount.id);
      assert.equal(duplicate.created,0);assert.equal(duplicate.skippedExisting,expected.length);
      const sum=(values)=>Math.round(values.reduce((a,v)=>a+Number(v||0),0)*100)/100;
      assert.equal(sum(parsed.map(r=>r.credit)),sum(expected.map(r=>r[6])));
      assert.equal(sum(parsed.map(r=>r.debit)),sum(expected.map(r=>r[7])));
      console.log(JSON.stringify({file:path.basename(file),transactions:parsed.length,created:imported.created,duplicates:duplicate.skippedExisting,failed:imported.failed,totalsMatch:true}));
    }
  }finally{api.closeDatabasesForExit();removeTemporaryDirectory(temporaryRoot);}
})().catch(error=>{console.error(error);process.exitCode=1;});
