'use strict';
const sent='Elektron qaimə-fakturalar_Göndərilənlər_Qaimələr üzrə_2026_06_05.xlsx';
const incoming='Elektron qaimə-fakturalar_Gələnlər_Qaimələr üzrə_2026_06_09.xlsx';
function detect(file){ if(/göndərilənlər|göndərilən/i.test(file)) return 'Gedən'; if(/gələnlər|daxil olan/i.test(file)) return 'Gələn'; return 'Gələn'; }
if(detect(sent)!=='Gedən') throw new Error('Göndərilən fayl Gələn kimi tanınır');
if(detect(incoming)!=='Gələn') throw new Error('Gələn fayl Gedən kimi tanınır');
console.log('direction regression: OK');


function detectLive(meta, preferred='Gələn') {
  const raw=[meta.title,meta.url,meta.bodyText,meta.folder,meta.activeTab,meta.heading].filter(Boolean).join(' | ').toLowerCase()
    .replace(/ə/g,'e').replace(/ı/g,'i').replace(/ö/g,'o').replace(/ü/g,'u').replace(/ğ/g,'g').replace(/ç/g,'c').replace(/ş/g,'s');
  if (/gonderilenler|gonderdiklerim|gonderilmis/.test(raw)) return 'Gedən';
  if (/gelenler|gelen qaime|daxil olan/.test(raw)) return 'Gələn';
  return preferred;
}
if(detectLive({title:'Elektron qaimə-fakturalar — Göndərilənlər',url:'https://new.e-taxes.gov.az/etaxes/sent',activeTab:'Göndərilənlər'},'Gələn')!=='Gedən') throw new Error('Live DVX sent page was not auto-detected as Gedən');
if(detectLive({title:'Elektron qaimə-fakturalar — Gələnlər',url:'https://new.e-taxes.gov.az/etaxes/received',activeTab:'Gələnlər'},'Gedən')!=='Gələn') throw new Error('Live DVX received page was not auto-detected as Gələn');
if(detectLive({title:'DVX',url:'https://new.e-taxes.gov.az/etaxes/'},'Gedən')!=='Gedən') throw new Error('Preferred direction fallback failed');
console.log('live direction auto-detection: OK');
