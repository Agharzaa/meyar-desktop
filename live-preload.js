'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Keep a public bridge for compatibility, but the injected controls below do
// NOT depend on window.meyarLiveTax. Some DVX SPA navigations can replace the
// page's main-world window object while the preload DOM context remains alive.
// Calling ipcRenderer directly from this preload makes the controls stable
// across DVX route changes / client-side navigation.
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

try {
  contextBridge.exposeInMainWorld('meyarLiveTax', {
    importNow: () => invoke('invoice:live:import'),
    goToInvoices: (direction) => invoke('invoice:live:navigate', direction)
  });
} catch (_) {
  // The page may already have an isolated-world bridge in unusual reload paths.
  // The button handlers below use invoke() directly and do not rely on it.
}

window.addEventListener('DOMContentLoaded', () => {
  const mount = () => {
    if (document.getElementById('__meyarLiveImport')) return;

    const host=document.createElement('div');
    host.id='__meyarLiveImport';
    host.innerHTML=`<div style="position:fixed;right:18px;bottom:18px;z-index:2147483647;font-family:Inter,Arial,sans-serif;display:flex;gap:7px;align-items:center">
      <button id="__meyarLiveNav" style="border:1px solid #475569;background:#1e293b;color:#fff;border-radius:5px;padding:10px 12px;font-weight:700;box-shadow:0 6px 20px rgba(0,0,0,.22);cursor:pointer">Qaimələrə keç</button>
      <button id="__meyarLiveBtn" style="border:1px solid #9e7d1d;background:#c29b27;color:#fff;border-radius:5px;padding:11px 14px;font-weight:800;box-shadow:0 6px 20px rgba(0,0,0,.22);cursor:pointer">↥ Meyar ERP-ə gətir</button>
    </div>`;
    (document.body || document.documentElement).appendChild(host);

    host.querySelector('#__meyarLiveNav').addEventListener('click', async () => {
      const b=host.querySelector('#__meyarLiveNav');
      b.disabled=true; b.textContent='Keçilir...';
      try {
        const r=await invoke('invoice:live:navigate', 'AUTO');
        if(r && r.ok===false) throw new Error(r.message||'DVX qovluğuna keçmək alınmadı.');
      } catch(e) {
        alert(`Qaimələr bölməsi açıla bilmədi: ${e?.message||e}`);
      } finally {
        b.disabled=false; b.textContent='Qaimələrə keç';
      }
    });

    host.querySelector('#__meyarLiveBtn').addEventListener('click', async () => {
      const b=host.querySelector('#__meyarLiveBtn');
      b.disabled=true; b.textContent='Oxunur...';
      try {
        const r=await invoke('invoice:live:import');
        if (r && r.ok === false) {
          alert(`Canlı idxal: ${r.message||'məlumat tapılmadı'}\nSəhifə: ${r.url||location.href}`);
        } else {
          alert(`Meyar ERP canlı sinxronizasiya\nYeni: ${r?.created??0}\nBazadakı sənədlər keçildi: ${r?.skippedExisting??r?.duplicates??0}\nXəta: ${r?.failed??0}${r?.candidates!=null?`\nOxunan sətr: ${r.candidates}`:''}`);
        }
      } catch(e) {
        alert(`Canlı idxal alınmadı: ${e?.message||e}`);
      } finally {
        b.disabled=false; b.textContent='↥ Meyar ERP-ə gətir';
      }
    });
  };

  // The DVX app is a SPA and can replace large parts of the DOM at any time.
  // Keep the controls mounted for the entire authenticated session, not just
  // the first few seconds after the landing page loads.
  mount();
  const observer=new MutationObserver(()=>mount());
  const startObserve=()=>observer.observe(document.documentElement||document,{childList:true,subtree:true});
  if(document.documentElement) startObserve(); else setTimeout(startObserve,50);
  window.addEventListener('beforeunload',()=>observer.disconnect(),{once:true});
});
