'use strict';
const fs=require('fs');
const vm=require('vm');
const s=fs.readFileSync('main.js','utf8');
for (const name of ['normalizeDirectionValue','invoiceFromRaw','importInvoiceRecords','extractLiveTaxInvoices']) {
  if(!new RegExp(`function\\s+${name}\\s*\\(`).test(s)) throw new Error(`${name} function is missing.`);
}
const normPos=s.indexOf('function normalizeDirectionValue');
const invoicePos=s.indexOf('function invoiceFromRaw');
const importPos=s.indexOf('function importInvoiceRecords');
const handlerPos=s.indexOf("secureHandle('invoice:live:import'");
if(normPos<0 || invoicePos<0 || normPos>invoicePos) throw new Error('normalizeDirectionValue must be defined before invoiceFromRaw.');
if(importPos<0 || handlerPos<0 || importPos>handlerPos) throw new Error('importInvoiceRecords must be defined before the live IPC registration.');
// Execute the helper itself so a declaration can never pass the test while being broken.
const ctx={}; ctx.globalThis=ctx; vm.createContext(ctx);
const helper=s.slice(normPos, invoicePos)+';globalThis.testNormalizeDirectionValue=normalizeDirectionValue;';
vm.runInContext(helper,ctx);
const f=ctx.testNormalizeDirectionValue;
if(f('Göndərilənlər')!=='Gedən') throw new Error('Outgoing direction normalization failed.');
if(f('Gələnlər')!=='Gələn') throw new Error('Incoming direction normalization failed.');
if(f('', 'Gedən')!=='Gedən') throw new Error('Fallback direction failed.');
console.log('live import handler regression: PASS');
