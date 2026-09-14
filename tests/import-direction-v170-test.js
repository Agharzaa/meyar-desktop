'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

const source=fs.readFileSync('main.js','utf8');
const helperStart=source.indexOf('function pick');
const helperEnd=source.indexOf('function importedPostingAccount',helperStart);
const parserStart=source.indexOf('function findImportHeaderRow');
const parserEnd=source.indexOf('function readImportRecords',parserStart);
assert.ok(helperStart>=0&&helperEnd>helperStart&&parserStart>=0&&parserEnd>parserStart,'İdxal istiqaməti köməkçiləri tapılmalıdır');

const context={};
context.globalThis=context;
vm.createContext(context);
vm.runInContext(
  source.slice(helperStart,helperEnd)+source.slice(parserStart,parserEnd)+
  ';globalThis.findImportHeaderRow=findImportHeaderRow;globalThis.resolveImportDirectionEvidence=resolveImportDirectionEvidence;globalThis.sanitizeCounterpartyName=sanitizeCounterpartyName;',
  context
);

const header=context.findImportHeaderRow([
  ['Elektron qaimə-fakturalar — Göndərilən qaimələrin siyahısı'],
  ['Hesabat dövrü','01.01.2026–31.01.2026'],
  ['Sıra','VÖEN','Ödəyici adı','Qaimə seriyası','Qaimə nömrəsi','Yekun məbləğ']
]);
assert.equal(header,2,'DVX-in real başlıq sətri ön məlumatlardan sonra tapılmalıdır');

const outgoing=context.resolveImportDirectionEvidence({
  fileName:'export.xlsx',sheetName:'Sheet1',titleText:'Göndərilən qaimələrin siyahısı',
  records:[{'VÖEN':'1234567890','Qaimə nömrəsi':'1001'}]
});
assert.equal(outgoing.direction,'Gedən');
assert.equal(outgoing.directionSource,'DVX çıxarışının başlığı');
assert.equal(outgoing.requiresConfirmation,false);

const incoming=context.resolveImportDirectionEvidence({
  fileName:'Elektron_qaimeler_Gelenler.xlsx',records:[{'VÖEN':'1234567890'}]
});
assert.equal(incoming.direction,'Gələn');

assert.equal(context.resolveImportDirectionEvidence({titleText:'Satış qaimələri',records:[{}]}).direction,'Gedən');
assert.equal(context.resolveImportDirectionEvidence({titleText:'Alış qaimələri',records:[{}]}).direction,'Gələn');

const ambiguous=context.resolveImportDirectionEvidence({
  fileName:'export.xlsx',sheetName:'Sheet1',records:[{'VÖEN':'1234567890'}]
});
assert.equal(ambiguous.direction,'');
assert.equal(ambiguous.requiresConfirmation,true,'Sübutsuz fayl açıq pəncərəyə görə səssiz təsnif edilməməlidir');

const mixed=context.resolveImportDirectionEvidence({records:[
  {direction:'Gələn'},{direction:'Gedən'}
]});
assert.equal(mixed.mixed,true);
assert.equal(mixed.requiresConfirmation,false,'Tam istiqamətli qarışıq fayl sətir-sətir saxlanmalıdır');

const conflict=context.resolveImportDirectionEvidence({
  fileName:'gelenler.xlsx',titleText:'Göndərilən qaimələrin siyahısı',records:[{}]
});
assert.equal(conflict.requiresConfirmation,true,'Zidd mənbələrdə istifadəçi təsdiqi tələb olunmalıdır');

assert.match(source,/sheet_to_json\(sheet,\{header:1/,'Başlıqdan əvvəlki DVX sətirləri oxunmalıdır');
assert.match(source,/Açıq pəncərə avtomatik mənbə hesab edilmir/,'Pəncərə istiqaməti səssiz fallback olmamalıdır');
assert.equal(
  context.sanitizeCounterpartyName('Avicom Məhdud Məsuliyyətli Cəmiyyəti Seriya və nömrə: MT260811498054 | Yekun məbləğ: 7 480,00'),
  'Avicom Məhdud Məsuliyyətli Cəmiyyəti',
  'Bir sətirə yığılmış DVX kartı kontragent adını çirkləndirməməlidir'
);

console.log('import direction v1.7.0: OK');
