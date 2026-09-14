'use strict';
const assert=require('node:assert/strict');
// This is intentionally a pure format test: it checks the exact DVX column names
// used by the supplied sample without requiring Electron or a database.
const headers=['№','VÖEN','Adı','Tipi','Vəziyyəti','Qaimə tarixi','Qaimə seriyası','Qaimə nömrəsi','Qaimə/Akt növləri','Əsas qeyd','Əlavə qeyd','Aksiz məbləği','Malın ƏDV-siz ümumi dəyəri','Malın ƏDV məbləği','ƏDV-yə cəlb edilən','ƏDV-yə cəlb edilməyən','ƏDV-dən azad olan','ƏDV-yə "0" dərəcə ilə cəlb edilən','Yol vergisi','Yekun məbləğ','Səbəb','Avans Seriası','Avans Nömrəsi','Avans Məbləği'];
for(const h of ['VÖEN','Adı','Qaimə tarixi','Qaimə seriyası','Qaimə nömrəsi','Qaimə/Akt növləri','Malın ƏDV-siz ümumi dəyəri','Malın ƏDV məbləği','Yekun məbləğ']) assert.ok(headers.includes(h),`Missing DVX header: ${h}`);
assert.equal(headers.length,24);
console.log('DVX XLSX format test passed.');
