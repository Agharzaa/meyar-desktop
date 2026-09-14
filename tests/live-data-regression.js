const assert=require('node:assert/strict');
const sample=`1401005061 / "Abc-Telecom" Məhdud Məsuliyyətli Cəmiyyət\n19.08.2026 16:23:37\nSeriya və nömrə: MT260811721540 | Yekun məbləğ: 420,00 | ƏDV məbləği: 64,07 |\nNövü: Malların, işlərin və xidmətlərin təqdim edilməsi barədə elektron qaimə-faktura\nƏsas: 0000000005988\nSistem tərəfindən təsdiqlandı`;
const voen=sample.match(/(^|\n)\s*(\d{10})\s*\/\s*(.+?)(?=\n|$)/m);
assert(voen,'VÖEN/card line not detected'); assert.equal(voen[2],'1401005061'); assert.match(voen[3],/Abc-Telecom/); assert.match(voen[3],/Məhdud Məsuliyyətli Cəmiyyət/);
const no=sample.match(/Seriya\s*v[əe]\s*n[öo]mr[əe]\s*:\s*([^|\n]+)/i); assert.equal(no[1].trim(),'MT260811721540');
const total=420,vat=64.07; assert.equal(Math.round((total-vat)*100)/100,355.93);
console.log('live card data regression: OK');
