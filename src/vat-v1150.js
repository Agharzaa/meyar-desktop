'use strict';

window.createMeyarVatUi=function createMeyarVatUi(dependencies){
  const {api,$,$$,esc,fmtCurrency,toast,closeModal}=dependencies;
  let report=null;
  let activeTab='input';
  let page=1;
  const pageSize=200;
  let bound=false;

  const money=value=>fmtCurrency(Number(value||0),'AZN');
  const currentPeriod=()=>{
    const date=new Date();
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`;
  };
  const treatmentLabel=value=>({
    STANDARD:'Standart',NON_DEDUCTIBLE:'Əvəzləşməyən',CUSTOMS:'Gömrük ƏDV-si',EXEMPT:'ƏDV-dən azad',ZERO:'0% ƏDV'
  }[value]||value||'Standart');
  const sideLabel=value=>value==='INPUT'?'Giriş ƏDV':'Çıxış ƏDV';
  const statusClass=status=>/gözləyir|qismən/i.test(String(status))?'waiting':/əvəzləşmir/i.test(String(status))?'blocked':'';

  function pageRows(rows){
    const pageCount=Math.max(1,Math.ceil(rows.length/pageSize));
    if(page>pageCount)page=pageCount;
    const start=(page-1)*pageSize;
    $('#vatPageInfo').textContent=rows.length?`${start+1}–${Math.min(rows.length,start+pageSize)} / ${rows.length}`:'0 / 0';
    $('#vatPagePrev').disabled=page<=1;
    $('#vatPageNext').disabled=page>=pageCount;
    return rows.slice(start,start+pageSize);
  }

  function setSummary(){
    const summary=report?.summary||{};
    $('#vatOpening').textContent=money(summary.opening_input_vat);
    $('#vatInput').textContent=money(summary.input_vat_current);
    $('#vatOutput').textContent=money(summary.output_vat_current);
    $('#vatOffset').textContent=money(summary.offset_used);
    $('#vatPayable').textContent=money(summary.vat_payable);
    $('#vatCarry').textContent=money(summary.carry_forward_input_vat);
    $('#vatInputCount').textContent=summary.input_invoice_count||0;
    $('#vatOutputCount').textContent=summary.output_invoice_count||0;
    $('#vatAdjustmentCount').textContent=(report?.adjustments||[]).length;
    $('#vatIssueCount').textContent=summary.issue_count||0;
    const closed=report?.period?.status==='CLOSED';
    const state=$('#vatPeriodState');
    state.classList.toggle('closed',closed);
    state.innerHTML=`<span></span>${closed?`Bağlıdır · ${esc(report.period.closed_at||'')}`:'Dövr açıqdır'}`;
    $('#vatClose').classList.toggle('hidden',closed);
    $('#vatReopen').classList.toggle('hidden',!closed);
    $('#vatAdjustmentAdd').disabled=closed;
  }

  function inputRows(){
    $('#vatColumns').innerHTML='<col style="width:84px"><col style="width:130px"><col style="width:230px"><col style="width:112px"><col style="width:94px"><col style="width:98px"><col style="width:98px"><col style="width:98px"><col style="width:98px"><col style="width:125px"><col style="width:74px">';
    $('#vatHead').innerHTML='<tr><th>Tarix</th><th>Qaimə №</th><th>Kontragent</th><th>VÖEN</th><th>ƏDV</th><th>Əsas ödəniş</th><th>Depozit / gömrük</th><th>Cari ay</th><th>Qalıq</th><th>Vəziyyət</th><th></th></tr>';
    const allRows=report?.inputRows||[],rows=pageRows(allRows);
    $('#vatBody').innerHTML=rows.length?rows.map(row=>`<tr data-vat-invoice="${row.invoice_id}" tabindex="0" title="${esc(row.reason)}">
      <td class="mono">${esc(row.invoice_date)}</td>
      <td><span class="vat-main mono">${esc(row.invoice_no)}</span><span class="vat-sub">${esc(treatmentLabel(row.treatment))}</span></td>
      <td><span class="vat-main">${esc(row.counterparty_name)}</span><span class="vat-sub">${esc(row.currency)} · məzənnə ${esc(row.exchange_rate)}</span></td>
      <td class="mono">${esc(row.voen)}</td>
      <td class="vat-money">${money(row.vat_amount_azn)}</td>
      <td class="vat-money">${money(row.base_paid)}</td>
      <td class="vat-money">${money(row.treatment==='CUSTOMS'?row.customs_vat_paid:row.vat_deposit_paid)}</td>
      <td class="vat-money positive">${money(row.eligible_period)}</td>
      <td class="vat-money ${Number(row.remaining)>0.004?'warning':''}">${money(row.remaining)}</td>
      <td><span class="vat-status ${statusClass(row.status)}">${esc(row.status)}</span><span class="vat-sub">${esc(row.reason)}</span></td>
      <td><button class="vat-row-action" data-vat-manage="${row.invoice_id}" ${report.locked?'disabled':''}>İdarə et</button></td>
    </tr>`).join(''):'<tr><td colspan="11" class="vat-empty">Bu dövrədək ƏDV-li gələn qaimə yoxdur.</td></tr>';
  }

  function outputRows(){
    $('#vatColumns').innerHTML='<col style="width:88px"><col style="width:140px"><col style="width:260px"><col style="width:115px"><col style="width:110px"><col style="width:110px"><col style="width:110px"><col style="width:110px"><col style="width:130px">';
    $('#vatHead').innerHTML='<tr><th>Tarix</th><th>Qaimə №</th><th>Kontragent</th><th>VÖEN</th><th>Qaimə ƏDV-si</th><th>Ödəniş</th><th>Cari ay hesablanan</th><th>Qalıq</th><th>Vəziyyət</th></tr>';
    const allRows=report?.outputRows||[],rows=pageRows(allRows);
    $('#vatBody').innerHTML=rows.length?rows.map(row=>`<tr tabindex="0">
      <td class="mono">${esc(row.invoice_date)}</td><td><span class="vat-main mono">${esc(row.invoice_no)}</span></td>
      <td><span class="vat-main">${esc(row.counterparty_name)}</span><span class="vat-sub">Ödənilib: ${money(row.paid_total)}</span></td>
      <td class="mono">${esc(row.voen)}</td><td class="vat-money">${money(row.vat_amount_azn)}</td>
      <td class="vat-money">${money(row.paid_total)}</td><td class="vat-money positive">${money(row.recognized_period)}</td>
      <td class="vat-money ${Number(row.remaining)>0.004?'warning':''}">${money(row.remaining)}</td>
      <td><span class="vat-status ${statusClass(row.status)}">${esc(row.status)}</span></td>
    </tr>`).join(''):'<tr><td colspan="9" class="vat-empty">Bu ay üzrə hesablanan satış ƏDV-si yoxdur.</td></tr>';
  }

  function adjustmentRows(){
    $('#vatColumns').innerHTML='<col style="width:100px"><col style="width:120px"><col style="width:120px"><col style="width:105px"><col style="width:150px"><col><col style="width:130px"><col style="width:70px">';
    $('#vatHead').innerHTML='<tr><th>Tarix</th><th>Tərəf</th><th>Məbləğ</th><th>Qarşı hesab</th><th>Qaimə</th><th>Səbəb</th><th>İstifadəçi</th><th></th></tr>';
    const allRows=report?.adjustments||[],rows=pageRows(allRows);
    $('#vatBody').innerHTML=rows.length?rows.map(row=>`<tr><td class="mono">${esc(row.adjustment_date)}</td><td>${esc(sideLabel(row.vat_side))}</td>
      <td class="vat-money ${Number(row.amount_azn)<0?'warning':'positive'}">${money(row.amount_azn)}</td><td class="mono">${esc(row.contra_account_code||'—')}</td><td class="mono">${esc(row.invoice_no||'—')}</td>
      <td title="${esc(row.reason)}"><span class="vat-main">${esc(row.reason)}</span></td><td>${esc(row.created_by)}</td>
      <td><button class="vat-row-action vat-danger" data-vat-delete-adjustment="${row.id}" ${report.locked?'disabled':''}>Sil</button></td></tr>`).join(''):'<tr><td colspan="8" class="vat-empty">Bu ay üzrə əl düzəlişi yoxdur.</td></tr>';
  }

  function issueRows(){
    $('#vatColumns').innerHTML='<col style="width:110px"><col style="width:150px"><col><col style="width:120px">';
    $('#vatHead').innerHTML='<tr><th>Səviyyə</th><th>Kod</th><th>İzah</th><th>Qaimə ID</th></tr>';
    const allRows=report?.issues||[],rows=pageRows(allRows);
    $('#vatBody').innerHTML=rows.length?rows.map(row=>`<tr><td><span class="vat-status ${row.severity==='error'?'blocked':'waiting'}">${row.severity==='error'?'Xəta':'Diqqət'}</span></td>
      <td class="mono">${esc(row.code)}</td><td title="${esc(row.message)}"><span class="vat-main">${esc(row.message)}</span></td><td class="mono">${esc(row.invoice_id||'—')}</td></tr>`).join(''):'<tr><td colspan="4" class="vat-empty">Aylıq registr üzrə nəzarət problemi tapılmadı.</td></tr>';
  }

  function render(){
    setSummary();
    $$('#vatTabs [data-vat-tab]').forEach(button=>button.classList.toggle('active',button.dataset.vatTab===activeTab));
    if(activeTab==='input')inputRows();
    if(activeTab==='output')outputRows();
    if(activeTab==='adjustments')adjustmentRows();
    if(activeTab==='issues')issueRows();
    const auto=report?.autoMatch;
    const integrityText=report?.integrity?.healthy===false?` · bütövlük problemi: ${report.integrity.problems}`:'';
    $('#vatHealth').className=`vat-health ${report?.integrity?.healthy===false?'error':'ok'}`;
    $('#vatHealth').textContent=`${report.period.key} · ${report.summary.input_invoice_count} alış · ${report.summary.output_invoice_count} satış · ${report.summary.waiting_count} gözləyən${auto?` · avtomatik: ${auto.matched} bağlandı, ${auto.review} yoxlanmalıdır`:''}${integrityText}`;
  }

  async function load(refresh=false){
    bind();
    const input=$('#vatPeriodInput');
    if(!input.value)input.value=currentPeriod();
    const button=$('#vatRefresh');
    const original=button.innerHTML;
    button.disabled=true;button.innerHTML='<i class="fa-solid fa-rotate"></i> Hesablanır';
    try{
      const [periodReport,integrity]=await Promise.all([refresh?api.vat.refresh(input.value):api.vat.report(input.value),api.vat.integrity()]);
      report={...periodReport,integrity};
      page=1;
      render();
      if(refresh&&report.autoMatch)toast(`ƏDV yeniləndi: ${report.autoMatch.matched} yeni depozit bağlandı, ${report.autoMatch.review} əməliyyat yoxlama tələb edir.`,report.autoMatch.failed?'warn':'success');
    }catch(error){
      $('#vatHealth').className='vat-health error';
      $('#vatHealth').textContent=error.message||'ƏDV registri yüklənmədi.';
      toast(error.message||'ƏDV registri yüklənmədi.','error');
    }finally{button.disabled=false;button.innerHTML=original;}
  }

  async function openInvoice(invoiceId){
    const row=(report?.inputRows||[]).find(item=>Number(item.invoice_id)===Number(invoiceId));
    if(!row)return;
    const root=$('#modalRoot');
    root.innerHTML=`<div class="modal"><div class="backdrop" data-close></div><div class="modalcard vat-modalcard"><div class="modalhead"><div><span class="eyebrow">ƏDV / ALIŞ QAİMƏSİ</span><h2>${esc(row.invoice_no)}</h2><p>${esc(row.counterparty_name)} · VÖEN ${esc(row.voen)}</p></div><button class="close" data-close><i class="fa-solid fa-xmark"></i></button></div>
      <div class="modalbody"><div class="vat-form-note">Əvəzləşmə yalnız əsas ödəniş və uyğun ƏDV depozit/gömrük ödənişi həddində hesablanır. Cari uyğun məbləğ: <b>${money(row.eligible_total)}</b>; qalıq: <b>${money(row.remaining)}</b>.</div>
      <div class="vat-modal-grid" style="margin-top:10px"><label>ƏDV rejimi<select id="vatTreatment"><option value="STANDARD">Standart</option><option value="NON_DEDUCTIBLE">Əvəzləşdirilməyən alış</option><option value="CUSTOMS">Gömrük ƏDV-si</option><option value="EXEMPT">ƏDV-dən azad</option><option value="ZERO">0% ƏDV</option></select></label><label>Qeyd<input id="vatTreatmentNote" value="${esc(row.note||'')}" placeholder="İzah və ya sənəd qeydi"></label></div>
      <div class="lineshead" style="margin-top:12px"><strong>Bağlanmış ƏDV ödənişləri</strong><span class="muted">${(row.payment_links||[]).length} əlaqə</span></div><div class="vat-payment-list" id="vatPaymentLinks"></div>
      <div class="lineshead" style="margin-top:12px"><strong>Uyğun bank ödənişi seçin</strong><span class="muted">Yalnız AZN çıxan ödənişləri</span></div>
      <div class="vat-modal-grid"><label class="full">Bank əməliyyatlarında axtarış<input id="vatCandidateSearch" placeholder="Qaimə №, VÖEN, kontragent və ya təyinat"></label></div><div class="vat-candidate-list" id="vatCandidateList"><div class="vat-empty">Bank əməliyyatları yüklənir...</div></div>
      <div class="vat-modal-grid" style="margin-top:10px"><label>Ödəniş növü<select id="vatPaymentKind"><option value="VAT_DEPOSIT">ƏDV depozit ödənişi</option><option value="CUSTOMS_VAT">Gömrük ƏDV-si</option></select></label><label>Məbləğ (AZN)<input id="vatAllocationAmount" type="number" min="0.01" step="0.01" value="${Number(row.remaining||0).toFixed(2)}"></label></div></div>
      <div class="modalfoot"><button class="btn" data-close>Bağla</button><div class="actions"><button class="btn" id="vatSaveTreatment" ${report.locked?'disabled':''}>Rejimi saxla</button><button class="btn primary" id="vatAllocate" ${report.locked?'disabled':''}><i class="fa-solid fa-link"></i> Ödənişi bağla</button></div></div></div></div>`;
    $('#vatTreatment').value=row.treatment||'STANDARD';
    $('#vatPaymentKind').value=row.treatment==='CUSTOMS'?'CUSTOMS_VAT':'VAT_DEPOSIT';
    const renderLinks=()=>{$('#vatPaymentLinks').innerHTML=(row.payment_links||[]).length?row.payment_links.map(link=>`<div class="vat-payment-row"><span class="mono">${esc(link.payment_date)}</span><strong title="${esc(link.description||link.reference||'')}">${esc(link.reference||link.description||'Bank ödənişi')}</strong><span>${esc(link.payment_kind==='CUSTOMS_VAT'?'Gömrük':'Depozit')}</span><span class="amount">${money(link.amount_azn)}</span><button class="vat-row-action vat-danger" data-vat-unlink="${link.id}" ${report.locked?'disabled':''}>Ayır</button></div>`).join(''):'<div class="vat-empty">Bağlanmış ƏDV ödənişi yoxdur.</div>';};
    renderLinks();
    const loadCandidates=async()=>{
      try{
        const rows=await api.vat.candidates(row.invoice_id,$('#vatCandidateSearch').value.trim());
        $('#vatCandidateList').innerHTML=rows.length?rows.map(candidate=>`<label class="vat-candidate"><input type="radio" name="vatCandidate" value="${candidate.id}" data-available="${Number(candidate.available_amount)}"><span class="mono">${esc(candidate.transaction_date)}</span><span><strong>${esc(candidate.counterparty_name||'—')}</strong><small class="vat-sub">${esc(candidate.reference||candidate.description||'')}</small></span><span class="amount">${money(candidate.available_amount)}</span></label>`).join(''):'<div class="vat-empty">İstifadə olunmamış çıxan AZN ödənişi tapılmadı.</div>';
        const first=$('input[name="vatCandidate"]');if(first){first.checked=true;$('#vatAllocationAmount').value=Math.min(Number(first.dataset.available),Number(row.remaining||0)).toFixed(2);}
      }catch(error){$('#vatCandidateList').innerHTML=`<div class="vat-empty">${esc(error.message||'Bank əməliyyatları yüklənmədi.')}</div>`;}
    };
    let searchTimer=null;
    $('#vatCandidateSearch').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(loadCandidates,180)});
    $('#vatCandidateList').addEventListener('change',event=>{if(event.target.matches('input[name="vatCandidate"]'))$('#vatAllocationAmount').value=Math.min(Number(event.target.dataset.available),Number(row.remaining||0)).toFixed(2)});
    $('#vatPaymentLinks').addEventListener('click',async event=>{const button=event.target.closest('[data-vat-unlink]');if(!button)return;if(!confirm('Bu ƏDV ödəniş bağlantısı silinsin?'))return;try{await api.vat.unallocate(Number(button.dataset.vatUnlink));closeModal();await load();toast('ƏDV ödəniş bağlantısı silindi.','success')}catch(error){toast(error.message||'Bağlantı silinmədi.','error')}});
    $('#vatSaveTreatment').addEventListener('click',async()=>{try{await api.vat.setTreatment({invoiceId:row.invoice_id,treatment:$('#vatTreatment').value,note:$('#vatTreatmentNote').value});closeModal();await load();toast('Qaimənin ƏDV rejimi saxlanıldı.','success')}catch(error){toast(error.message||'ƏDV rejimi saxlanmadı.','error')}});
    $('#vatAllocate').addEventListener('click',async()=>{const selected=$('input[name="vatCandidate"]:checked');if(!selected)return toast('Bank ödənişini seçin.','warn');try{await api.vat.allocate({transactionId:Number(selected.value),invoiceId:row.invoice_id,kind:$('#vatPaymentKind').value,amount:Number($('#vatAllocationAmount').value),source:'manual'});closeModal();await load();toast('ƏDV ödənişi qaiməyə bağlandı.','success')}catch(error){toast(error.message||'ƏDV ödənişi bağlanmadı.','error')}});
    $$('[data-close]',root).forEach(element=>element.addEventListener('click',closeModal));
    await loadCandidates();
  }

  async function openAdjustment(){
    const root=$('#modalRoot'),period=$('#vatPeriodInput').value;
    let accounts=[];
    try{accounts=(await api.invoice.accounts()).filter(account=>Number(account.is_postable)!==0&&!['RECEIVABLE','PAYABLE','BANK','INPUT_VAT','OUTPUT_VAT','INVENTORY'].includes(String(account.role||'')));}
    catch(error){return toast(error.message||'Qarşı hesablar yüklənmədi.','error');}
    root.innerHTML=`<div class="modal"><div class="backdrop" data-close></div><div class="modalcard vat-modalcard" style="width:min(620px,calc(100vw - 32px))"><div class="modalhead"><div><span class="eyebrow">ƏDV / ƏL DÜZƏLİŞİ</span><h2>Düzəliş yarat</h2><p>Hər düzəliş səbəb, qarşı hesab və istifadəçi ilə audit izində saxlanılır.</p></div><button class="close" data-close><i class="fa-solid fa-xmark"></i></button></div><div class="modalbody"><div class="vat-modal-grid"><label>Tarix<input id="vatAdjustmentDate" type="date" value="${period}-01"></label><label>Tərəf<select id="vatAdjustmentSide"><option value="INPUT">Giriş ƏDV</option><option value="OUTPUT">Çıxış ƏDV</option></select></label><label>Məbləğ (AZN)<input id="vatAdjustmentAmount" type="number" step="0.01" placeholder="Mənfi düzəliş üçün - yazın"></label><label>Qarşı hesab<select id="vatAdjustmentContra">${accounts.map(account=>`<option value="${esc(account.code)}">${esc(account.code)} — ${esc(account.name)}</option>`).join('')}</select></label><label class="full">Səbəb<textarea id="vatAdjustmentReason" placeholder="Düzəlişin sənədli əsasını yazın"></textarea></label></div></div><div class="modalfoot"><button class="btn" data-close>Bağla</button><button class="btn primary" id="vatSaveAdjustment">Yadda saxla</button></div></div></div>`;
    $$('[data-close]',root).forEach(element=>element.addEventListener('click',closeModal));
    $('#vatSaveAdjustment').addEventListener('click',async()=>{try{await api.vat.addAdjustment({date:$('#vatAdjustmentDate').value,side:$('#vatAdjustmentSide').value,amount:Number($('#vatAdjustmentAmount').value),contraAccountCode:$('#vatAdjustmentContra').value,reason:$('#vatAdjustmentReason').value});closeModal();await load();toast('ƏDV düzəlişi müxabirləşmə və audit izi ilə yaradıldı.','success')}catch(error){toast(error.message||'ƏDV düzəlişi saxlanmadı.','error')}});
  }

  function bind(){
    if(bound)return;bound=true;
    $('#vatRefresh').addEventListener('click',()=>load(true));
    $('#vatPeriodInput').addEventListener('change',()=>{page=1;load(false)});
    $('#vatAdjustmentAdd').addEventListener('click',openAdjustment);
    $('#vatExport').addEventListener('click',async()=>{try{const result=await api.vat.export($('#vatPeriodInput').value);if(!result?.cancelled)toast('Aylıq ƏDV registri CSV formatında ixrac edildi.','success')}catch(error){toast(error.message||'ƏDV registri ixrac edilmədi.','error')}});
    $('#vatClose').addEventListener('click',async()=>{if(!confirm(`${$('#vatPeriodInput').value} ƏDV dövrü snapshot yaradılaraq bağlansın?`))return;try{report=await api.vat.close({periodKey:$('#vatPeriodInput').value});report.integrity=await api.vat.integrity();render();toast('ƏDV dövrü bağlandı və dəyişməz snapshot saxlanıldı.','success')}catch(error){toast(error.message||'ƏDV dövrü bağlanmadı.','error')}});
    $('#vatReopen').addEventListener('click',async()=>{const reason=prompt('Dövrün yenidən açılma səbəbini yazın:','Düzəliş sənədi üzrə yenidən hesablama');if(!String(reason||'').trim())return;try{report=await api.vat.reopen({periodKey:$('#vatPeriodInput').value,reason});report.integrity=await api.vat.integrity();render();toast('ƏDV dövrü yenidən açıldı.','success')}catch(error){toast(error.message||'ƏDV dövrü açıla bilmədi.','error')}});
    $('#vatTabs').addEventListener('click',event=>{const button=event.target.closest('[data-vat-tab]');if(!button)return;activeTab=button.dataset.vatTab;page=1;render()});
    $('#vatPagePrev').addEventListener('click',()=>{if(page>1){page--;render()}});
    $('#vatPageNext').addEventListener('click',()=>{page++;render()});
    $('#vatBody').addEventListener('click',async event=>{
      const manage=event.target.closest('[data-vat-manage]');if(manage)return openInvoice(Number(manage.dataset.vatManage));
      const remove=event.target.closest('[data-vat-delete-adjustment]');if(remove){if(!confirm('Bu ƏDV düzəlişi silinsin?'))return;try{await api.vat.deleteAdjustment(Number(remove.dataset.vatDeleteAdjustment));await load();toast('ƏDV düzəlişi silindi.','success')}catch(error){toast(error.message||'Düzəliş silinmədi.','error')}return;}
      const row=event.target.closest('tr[data-vat-invoice]');if(row){$$('#vatBody tr').forEach(item=>item.classList.toggle('vat-selected',item===row));}
    });
    $('#vatBody').addEventListener('dblclick',event=>{const row=event.target.closest('tr[data-vat-invoice]');if(row&&!report?.locked)openInvoice(Number(row.dataset.vatInvoice))});
    $('#vatBody').addEventListener('keydown',event=>{const row=event.target.closest('tr[data-vat-invoice]');if(row&&event.key==='Enter'&&!report?.locked){event.preventDefault();openInvoice(Number(row.dataset.vatInvoice))}});
  }

  return {load,render};
};
