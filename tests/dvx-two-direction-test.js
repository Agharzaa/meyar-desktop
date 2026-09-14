'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const XLSX=require('xlsx');
const samples=process.argv.slice(2);
assert.equal(samples.length,2,'Pass both incoming and outgoing DVX XLSX sample paths.');
for(const file of samples){
  const wb=XLSX.readFile(file,{cellDates:true,raw:false});
  const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,defval:'',raw:false});
  const title=rows.slice(0,10).flat().map(v=>String(v||'')).join(' ');
  const direction=/göndərilən qaimələrin siyahısı/i.test(title)||/göndərilən/i.test(path.basename(file))?'Gedən':'Gələn';
  const hi=rows.findIndex(r=>r.some(v=>String(v||'').trim()==='VÖEN')&&r.some(v=>String(v||'').trim()==='Qaimə nömrəsi'));
  assert.ok(hi>=0,'DVX header row not found');
  const headers=rows[hi].map(v=>String(v??'').trim());
  const ixSeries=headers.indexOf('Qaimə seriyası'), ixNo=headers.indexOf('Qaimə nömrəsi');
  const records=rows.slice(hi+1).filter(r=>/^\d/.test(String(r[0]||'').trim()));
  assert.ok(records.length>0,'No invoice rows found');
  const full=String(records[0][ixSeries]||'').trim()+' '+String(records[0][ixNo]||'').trim();
  assert.ok(full.trim().split(/\s+/).length>=2,'Series + number not combined');
  console.log(`${path.basename(file)} => ${direction}: ${records.length} rows; first=${full.trim()}`);
}
