(() => {
  'use strict';

  const amountFormatter = new Intl.NumberFormat('az-AZ', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

  function amount(value) {
    const number = Number(value || 0);
    return Math.abs(number) < 0.005 ? '' : amountFormatter.format(number);
  }

  function splitBalance(value) {
    const number = Number(value || 0);
    return {
      debit: number > 0.004 ? number : 0,
      credit: number < -0.004 ? Math.abs(number) : 0
    };
  }

  function sumRows(rows) {
    return rows.reduce((totals, row) => {
      totals.openDebit += Number(row.openDebit || 0);
      totals.openCredit += Number(row.openCredit || 0);
      totals.periodDebit += Number(row.periodDebit || 0);
      totals.periodCredit += Number(row.periodCredit || 0);
      totals.closeDebit += Number(row.closeDebit || 0);
      totals.closeCredit += Number(row.closeCredit || 0);
      return totals;
    }, { openDebit: 0, openCredit: 0, periodDebit: 0, periodCredit: 0, closeDebit: 0, closeCredit: 0 });
  }

  function amountCell(value) {
    const number = Number(value || 0);
    const negativeClass = number < -0.004 ? ' is-negative' : '';
    return `<td class="dbc-v182-amount${negativeClass}">${amount(number)}</td>`;
  }

  function kindClass(kind) {
    return ['asset','liability','income','expense','equity'].includes(String(kind)) ? ` kind-${kind}` : '';
  }

  function groupedHeader(firstColumnTitle) {
    return `<thead>
      <tr>
        <th rowspan="2" class="dbc-v182-name-head">${firstColumnTitle}</th>
        <th colspan="2">Dövrün əvvəlinə qalıq</th>
        <th colspan="2">Dövr ərzində dövriyyə</th>
        <th colspan="2">Dövrün sonuna qalıq</th>
      </tr>
      <tr>
        <th>Debet</th><th>Kredit</th>
        <th>Debet</th><th>Kredit</th>
        <th>Debet</th><th>Kredit</th>
      </tr>
    </thead>`;
  }

  function totalsFooter(totals) {
    return `<tfoot><tr>
      <th>Cəmi</th>
      <th class="dbc-v182-amount">${amount(totals.openDebit)}</th>
      <th class="dbc-v182-amount">${amount(totals.openCredit)}</th>
      <th class="dbc-v182-amount">${amount(totals.periodDebit)}</th>
      <th class="dbc-v182-amount">${amount(totals.periodCredit)}</th>
      <th class="dbc-v182-amount">${amount(totals.closeDebit)}</th>
      <th class="dbc-v182-amount">${amount(totals.closeCredit)}</th>
    </tr></tfoot>`;
  }

  function bindClose(root, queryAll, closeModal) {
    queryAll('[data-close]', root).forEach(element => element.addEventListener('click', closeModal));
  }

  function shell({ title, subtitle, filters, table, footer = '' }) {
    return `<div class="modal dbc-v182-modal">
      <div class="backdrop" data-close></div>
      <div class="modalcard dbc-v182-card">
        <header class="modalhead dbc-v182-titlebar">
          <div class="dbc-v182-title-copy"><span>HESABATLAR / DÖVRİYYƏ-BALANS</span><h2>${title}</h2>${subtitle ? `<p>${subtitle}</p>` : ''}</div>
          <button class="close dbc-v182-close" data-close aria-label="Bağla">×</button>
        </header>
        <div class="dbc-v182-body">
          <div class="dbc-v182-toolbar">${filters}</div>
          <div class="dbc-v182-grid">${table}</div>
        </div>
        <footer class="dbc-v182-footer">${footer}<button class="btn" data-close>Bağla</button></footer>
      </div>
    </div>`;
  }

  function reportFilters({ from, to, accountCode, accounts, escape }) {
    return `<label><span>Dövrün əvvəli</span><input id="dbcV182From" type="date" value="${escape(from)}"></label>
      <label><span>Dövrün sonu</span><input id="dbcV182To" type="date" value="${escape(to)}"></label>
      <label class="dbc-v182-account-filter"><span>Hesab</span><select id="dbcV182Account"><option value="">Bütün hesablar</option>${accounts.map(account => `<option value="${escape(account.code)}" ${account.code === accountCode ? 'selected' : ''}>${escape(account.code)} — ${escape(account.name)}</option>`).join('')}</select></label>
      <button class="btn primary" id="dbcV182Build">Formalaşdır</button>`;
  }

  function analyticFilters({ from, to, accountCode, accounts, escape }) {
    return `<label><span>Dövrün əvvəli</span><input id="dbcV182From" type="date" value="${escape(from)}"></label>
      <label><span>Dövrün sonu</span><input id="dbcV182To" type="date" value="${escape(to)}"></label>
      <label class="dbc-v182-account-filter"><span>Hesab</span><select id="dbcV182Account">${accounts.map(account => `<option value="${escape(account.code)}" ${account.code === accountCode ? 'selected' : ''}>${escape(account.code)} — ${escape(account.name)}</option>`).join('')}</select></label>
      <button class="btn primary" id="dbcV182Build">Formalaşdır</button>
      <button class="btn" id="dbcV182AllAccounts">Bütün hesablar</button>`;
  }

  async function openReport(context, initial = {}) {
    const { root, api, accounts, escape, query, queryAll, closeModal, toast } = context;
    const from = initial.from || `${new Date().getFullYear()}-01-01`;
    const to = initial.to || new Date().toISOString().slice(0, 10);
    const selectedAccount = initial.accountCode || '';
    root.innerHTML = shell({
      title: 'Hesablar üzrə dövriyyə-balans cədvəli',
      subtitle: 'Hesabı açmaq üçün sətrin əvvəlindəki “+” işarəsinə klikləyin.',
      filters: reportFilters({ from, to, accountCode: selectedAccount, accounts, escape }),
      table: `<table class="dbc-v182-table" id="dbcV182Table"><colgroup><col class="dbc-v182-name-col"><col span="6" class="dbc-v182-money-col"></colgroup>${groupedHeader('Hesab / Subkonto')}<tbody id="dbcV182Body"><tr><td colspan="7" class="dbc-v182-empty">Hesabat hazırlanır…</td></tr></tbody>${totalsFooter(sumRows([]))}</table>`,
      footer: '<span id="dbcV182Status">Yalnız təsdiqli müxabirləşmələr</span>'
    });
    bindClose(root, queryAll, closeModal);

    async function refresh() {
      const currentFrom = query('#dbcV182From', root).value;
      const currentTo = query('#dbcV182To', root).value;
      const accountCode = query('#dbcV182Account', root).value;
      if (currentFrom && currentTo && currentFrom > currentTo) {
        toast('Başlanğıc tarixi son tarixdən böyük ola bilməz.', 'warn');
        return;
      }
      if (accountCode) {
        await openAccount(context, { accountCode, from: currentFrom, to: currentTo });
        return;
      }
      try {
        const data = await api.invoice.dbc({ from: currentFrom, to: currentTo, accountCode: '', includeZero: false });
        const rows = (data.rows || []).map(row => ({
          code: row.code,
          name: row.name,
          kind: row.kind,
          openDebit: row.open_debit,
          openCredit: row.open_credit,
          periodDebit: row.period_debit,
          periodCredit: row.period_credit,
          closeDebit: row.close_debit,
          closeCredit: row.close_credit,
          childCount: row.child_count || 0
        }));
        const body = query('#dbcV182Body', root);
        body.innerHTML = rows.length ? rows.map(row => `<tr class="dbc-v182-parent" data-account="${escape(row.code)}">
          <td><button class="dbc-v182-toggle" type="button" aria-label="${escape(row.code)} hesabını aç">+</button><b class="dbc-v182-code${kindClass(row.kind)}">${escape(row.code)}</b><span class="dbc-v182-row-name">${escape(row.name)}</span>${row.childCount ? `<small>${row.childCount} uçot hesabı</small>` : ''}</td>
          ${amountCell(row.openDebit)}${amountCell(row.openCredit)}${amountCell(row.periodDebit)}${amountCell(row.periodCredit)}${amountCell(row.closeDebit)}${amountCell(row.closeCredit)}
        </tr>`).join('') : '<tr><td colspan="7" class="dbc-v182-empty">Bu tarix intervalında hərəkət tapılmadı.</td></tr>';
        query('#dbcV182Table tfoot', root).outerHTML = totalsFooter(sumRows(rows));
        const summary = data.summary || {};
        const balanced = Math.abs(Number(summary.turnover_debit || 0) - Number(summary.turnover_credit || 0)) < 0.005;
        query('#dbcV182Status', root).textContent = balanced ? `Debet = Kredit · ${summary.active_accounts || 0} aktiv hesab` : 'Debet və Kredit arasında fərq var';
        queryAll('.dbc-v182-parent', root).forEach(row => row.addEventListener('dblclick', () => openAccount(context, { accountCode: row.dataset.account, from: currentFrom, to: currentTo })));
        queryAll('.dbc-v182-toggle', root).forEach(button => button.addEventListener('click', event => {
          const row = event.currentTarget.closest('[data-account]');
          openAccount(context, { accountCode: row.dataset.account, from: currentFrom, to: currentTo });
        }));
      } catch (error) {
        toast(error.message || 'Dövriyyə-balans hesabatı hazırlanmadı.', 'error');
      }
    }

    query('#dbcV182Build', root).addEventListener('click', refresh);
    await refresh();
  }

  function normalizeAnalyticRows(data, escape) {
    const rows = data.rows || [];
    if (data.type === 'counterparties') {
      return {
        title: 'Kontragent',
        rows: rows.map(row => {
          const opening = splitBalance(row.opening);
          const closing = splitBalance(row.net);
          return {
            key: row.id,
            expandable: Number(row.id)>0 && !row.unallocated_opening,
            label: escape(row.name),
            meta: escape(row.voen || ''),
            openDebit: opening.debit,
            openCredit: opening.credit,
            periodDebit: row.debit,
            periodCredit: row.credit,
            closeDebit: closing.debit,
            closeCredit: closing.credit
          };
        })
      };
    }
    if (data.type === 'inventory') {
      return {
        title: 'Mal / Anbar',
        rows: rows.map(row => {
          const opening = splitBalance(row.opening_value);
          const closing = splitBalance(row.closing_value);
          return {
            label: `${escape(row.item_name)} <b class="dbc-v182-code">${escape(row.item_code)}</b>`,
            meta: `${escape(row.warehouse_name)} · ${escape(row.valuation_method)} · ${escape(row.closing_qty)} ${escape(row.unit)}`,
            openDebit: opening.debit,
            openCredit: opening.credit,
            periodDebit: row.incoming_value,
            periodCredit: row.outgoing_value,
            closeDebit: closing.debit,
            closeCredit: closing.credit
          };
        })
      };
    }
    return {
      title: 'Subkonto',
      rows: rows.map(row => {
        const opening = splitBalance(row.opening);
        return {
          key: row.subkonto_id,
          expandable: Number(row.subkonto_id) > 0 && !row.unallocated_opening,
          label: escape(row.name),
          meta: escape([row.account_code, row.subkonto_code].filter(Boolean).join(' · ')),
          openDebit: opening.debit,
          openCredit: opening.credit,
          periodDebit: row.debit,
          periodCredit: row.credit,
          closeDebit: row.closing_debit,
          closeCredit: row.closing_credit
        };
      })
    };
  }

  async function toggleCounterpartyDetails(context, button, accountCode, from, to) {
    const { api, escape, toast } = context;
    const parent = button.closest('tr');
    const existing = parent.nextElementSibling;
    if (existing?.classList.contains('dbc-v182-detail-row')) {
      existing.remove();
      button.textContent = '+';
      button.setAttribute('aria-expanded', 'false');
      return;
    }
    try {
      button.disabled = true;
      const data = await api.invoice.counterpartyLedger({ counterpartyId: Number(parent.dataset.key), accountCode, from, to });
      const detail = document.createElement('tr');
      detail.className = 'dbc-v182-detail-row';
      detail.innerHTML = `<td colspan="7"><div class="dbc-v182-detail"><table><thead><tr><th>Tarix</th><th>Sənəd</th><th>İstiqamət</th><th>Debet</th><th>Kredit</th><th>Qalıq</th></tr></thead><tbody>${data.entries.length ? data.entries.map(entry => `<tr><td>${escape(entry.date)}</td><td>${escape(entry.invoice_nos || entry.document_no || '')}</td><td>${escape(entry.direction)}</td><td class="dbc-v182-amount">${amount(entry.debit)}</td><td class="dbc-v182-amount">${amount(entry.credit)}</td><td class="dbc-v182-amount">${amount(entry.running_balance)}</td></tr>`).join('') : '<tr><td colspan="6" class="dbc-v182-empty">Bu dövrdə sənəd hərəkəti yoxdur.</td></tr>'}</tbody></table></div></td>`;
      parent.after(detail);
      button.textContent = '−';
      button.setAttribute('aria-expanded', 'true');
    } catch (error) {
      toast(error.message || 'Kontragent hərəkətləri açıla bilmədi.', 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function toggleAnalyticDetails(context, button, accountCode, from, to) {
    const { api, escape, toast } = context;
    const parent = button.closest('tr');
    const existing = parent.nextElementSibling;
    if (existing?.classList.contains('dbc-v182-detail-row')) {
      existing.remove();
      button.textContent = '+';
      button.setAttribute('aria-expanded', 'false');
      return;
    }
    try {
      button.disabled = true;
      const data = await api.invoice.analyticLedger({ accountCode, subkontoId: Number(parent.dataset.key), from, to });
      const detail = document.createElement('tr');
      detail.className = 'dbc-v182-detail-row';
      detail.innerHTML = `<td colspan="7"><div class="dbc-v182-detail"><table><thead><tr><th>Tarix</th><th>Hesab</th><th>Sənəd</th><th>Kontragent / müqavilə</th><th>Debet</th><th>Kredit</th><th>Qalıq</th></tr></thead><tbody>${data.entries.length ? data.entries.map(entry => `<tr><td>${escape(entry.date)}</td><td><b class="dbc-v182-code">${escape(entry.account_code)}</b></td><td title="${escape(entry.document_no || '')}">${escape(entry.document_no || '')}</td><td title="${escape([entry.counterparty_name,entry.contract_no].filter(Boolean).join(' · '))}">${escape([entry.counterparty_name,entry.contract_no].filter(Boolean).join(' · ') || '—')}</td><td class="dbc-v182-amount">${amount(entry.debit)}</td><td class="dbc-v182-amount">${amount(entry.credit)}</td><td class="dbc-v182-amount">${amount(entry.running_balance)}</td></tr>`).join('') : '<tr><td colspan="7" class="dbc-v182-empty">Bu dövrdə subkonto hərəkəti yoxdur.</td></tr>'}</tbody></table></div></td>`;
      parent.after(detail);
      button.textContent = '−';
      button.setAttribute('aria-expanded', 'true');
    } catch (error) {
      toast(error.message || 'Subkonto hərəkətləri açıla bilmədi.', 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function openAccount(context, initial) {
    const { root, api, accounts, escape, query, queryAll, closeModal, toast } = context;
    const accountCode = initial.accountCode;
    const from = initial.from;
    const to = initial.to;
    const account = accounts.find(item => item.code === accountCode);
    root.innerHTML = shell({
      title: `${escape(accountCode)} — ${escape(account?.name || 'Hesab analitikası')}`,
      subtitle: 'Hesab üzrə subkonto dövriyyə-balans cədvəli',
      filters: analyticFilters({ from, to, accountCode, accounts, escape }),
      table: `<table class="dbc-v182-table" id="dbcV182Table"><colgroup><col class="dbc-v182-name-col"><col span="6" class="dbc-v182-money-col"></colgroup>${groupedHeader('Subkonto')}<tbody id="dbcV182Body"><tr><td colspan="7" class="dbc-v182-empty">Hesabat hazırlanır…</td></tr></tbody>${totalsFooter(sumRows([]))}</table>`,
      footer: `<span><b>${escape(accountCode)}</b> hesabı · məbləğlər AZN</span>`
    });
    bindClose(root, queryAll, closeModal);

    async function refresh() {
      const currentFrom = query('#dbcV182From', root).value;
      const currentTo = query('#dbcV182To', root).value;
      const selected = query('#dbcV182Account', root).value;
      if (currentFrom && currentTo && currentFrom > currentTo) {
        toast('Başlanğıc tarixi son tarixdən böyük ola bilməz.', 'warn');
        return;
      }
      if (selected !== accountCode) {
        await openAccount(context, { accountCode: selected, from: currentFrom, to: currentTo });
        return;
      }
      try {
        const data = await api.invoice.accountAnalytics({ accountCode, from: currentFrom, to: currentTo });
        const normalized = normalizeAnalyticRows(data, escape);
        query('.dbc-v182-name-head', root).textContent = normalized.title;
        const body = query('#dbcV182Body', root);
        body.innerHTML = normalized.rows.length ? normalized.rows.map(row => `<tr class="dbc-v182-analytic-row" ${row.key ? `data-key="${row.key}"` : ''}>
          <td>${row.expandable ? `<button class="dbc-v182-toggle" type="button" aria-expanded="false" aria-label="Sənədləri aç">+</button>` : '<span class="dbc-v182-toggle-spacer"></span>'}<span class="dbc-v182-row-name">${row.label}</span>${row.meta ? `<small>${row.meta}</small>` : ''}</td>
          ${amountCell(row.openDebit)}${amountCell(row.openCredit)}${amountCell(row.periodDebit)}${amountCell(row.periodCredit)}${amountCell(row.closeDebit)}${amountCell(row.closeCredit)}
        </tr>`).join('') : '<tr><td colspan="7" class="dbc-v182-empty">Bu hesab üzrə analitik hərəkət tapılmadı.</td></tr>';
        query('#dbcV182Table tfoot', root).outerHTML = totalsFooter(sumRows(normalized.rows));
        if (data.type === 'counterparties') {
          queryAll('.dbc-v182-toggle', root).forEach(button => button.addEventListener('click', () => toggleCounterpartyDetails(context, button, accountCode, currentFrom, currentTo)));
        } else if (data.type === 'subcontos') {
          queryAll('.dbc-v182-toggle', root).forEach(button => button.addEventListener('click', () => toggleAnalyticDetails(context, button, accountCode, currentFrom, currentTo)));
        }
      } catch (error) {
        toast(error.message || 'Hesab üzrə dövriyyə-balans hazırlanmadı.', 'error');
      }
    }

    query('#dbcV182Build', root).addEventListener('click', refresh);
    query('#dbcV182AllAccounts', root).addEventListener('click', () => openReport(context, { from: query('#dbcV182From', root).value, to: query('#dbcV182To', root).value }));
    await refresh();
  }

  window.MeyarDBC = { openReport, openAccount };
})();
