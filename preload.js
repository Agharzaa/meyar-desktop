'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('meyarDesktop', {
  info: () => ipcRenderer.invoke('app:info'),
  auth: {
    status: () => ipcRenderer.invoke('auth:status'),
    setup: (payload) => ipcRenderer.invoke('auth:setup', payload),
    createCompany: (payload) => ipcRenderer.invoke('auth:createCompany', payload),
    access: (payload) => ipcRenderer.invoke('auth:access', payload),
    login: (payload) => ipcRenderer.invoke('auth:login', payload),
    logout: () => ipcRenderer.invoke('auth:logout'),
    companies: () => ipcRenderer.invoke('auth:companies')
  },
  invoice: {
    list: (args) => ipcRenderer.invoke('invoice:list', args),
    count: (args) => ipcRenderer.invoke('invoice:count', args),
    financialSummary: () => ipcRenderer.invoke('invoice:financialSummary'),
    get: (id, includeArchived=false) => ipcRenderer.invoke('invoice:get', {id, includeArchived}),
    save: (payload) => ipcRenderer.invoke('invoice:save', payload),
    post: (id) => ipcRenderer.invoke('invoice:post', id),
    archive: (id) => ipcRenderer.invoke('invoice:archive', id),
    delete: (id) => ipcRenderer.invoke('invoice:delete', id),
    restore: (id) => ipcRenderer.invoke('invoice:restore', id),
    changeStatus: (args) => ipcRenderer.invoke('invoice:status:change', args),
    counterparties: () => ipcRenderer.invoke('invoice:counterparties'),
    catalog: () => ipcRenderer.invoke('invoice:catalog'),
    profiles: (direction) => ipcRenderer.invoke('invoice:profiles', direction),
    accounts: () => ipcRenderer.invoke('invoice:accounts'),
    audit: (id) => ipcRenderer.invoke('invoice:audit', id),
    status: (id) => ipcRenderer.invoke('invoice:status', id),
    statusHistory: (id) => ipcRenderer.invoke('invoice:statusHistory', id),
    paymentCandidates: (args) => ipcRenderer.invoke('invoice:paymentCandidates', args),
    importFile: (direction) => ipcRenderer.invoke('invoice:importFile', direction),
    sync: (direction) => ipcRenderer.invoke('invoice:sync', direction),
    stats: () => ipcRenderer.invoke('invoice:stats'),
    liveOpen: (direction) => ipcRenderer.invoke('invoice:live:open', direction),
    liveNavigate: (direction) => ipcRenderer.invoke('invoice:live:navigate', direction),
    exportCsv: (rows) => ipcRenderer.invoke('invoice:exportCsv', rows),
    exportFiltered: (args) => ipcRenderer.invoke('invoice:exportFiltered', args),
    liveImport: () => ipcRenderer.invoke('invoice:live:import'),
    dbc: (args) => ipcRenderer.invoke('invoice:dbc', args),
    accountCounterparties: (args) => ipcRenderer.invoke('invoice:accountCounterparties', args),
    accountAnalytics: (args) => ipcRenderer.invoke('invoice:accountAnalytics', args),
    analyticLedger: (args) => ipcRenderer.invoke('invoice:analyticLedger', args),
    counterpartyLedger: (args) => ipcRenderer.invoke('invoice:counterpartyLedger', args)
  },
  dvx: {
    status: () => ipcRenderer.invoke('dvx:status'),
    settings: (payload) => ipcRenderer.invoke('dvx:settings', payload),
    openPortal: (direction) => ipcRenderer.invoke('dvx:openPortal', direction),
    preparePackage: (id) => ipcRenderer.invoke('dvx:preparePackage', id),
    packages: () => ipcRenderer.invoke('dvx:packages')
  },
  accounting: {
    status: () => ipcRenderer.invoke('accounting:status'),
    health: () => ipcRenderer.invoke('accounting:health'),
    setup: () => ipcRenderer.invoke('accounting:setup'),
    activate: (payload) => ipcRenderer.invoke('accounting:activate', payload),
    periodClose: (payload) => ipcRenderer.invoke('accounting:periodClose', payload)
  },
  reference: {
    list: () => ipcRenderer.invoke('reference:list'),
    saveAccount: (payload) => ipcRenderer.invoke('reference:saveAccount', payload),
    saveSubkonto: (payload) => ipcRenderer.invoke('reference:saveSubkonto', payload),
    saveCounterparty: (payload) => ipcRenderer.invoke('reference:saveCounterparty', payload),
    saveContract: (payload) => ipcRenderer.invoke('reference:saveContract', payload),
    saveWarehouse: (payload) => ipcRenderer.invoke('reference:saveWarehouse', payload),
    saveCatalog: (payload) => ipcRenderer.invoke('reference:saveCatalog', payload),
    saveRule: (payload) => ipcRenderer.invoke('reference:saveRule', payload)
  },
  users: {
    list: () => ipcRenderer.invoke('users:list'),
    create: (payload) => ipcRenderer.invoke('users:create', payload),
    setActive: (id, active) => ipcRenderer.invoke('users:setActive', { id, active })
  },
  bank: {
    status: () => ipcRenderer.invoke('bank:status'),
    saveAccount: (payload) => ipcRenderer.invoke('bank:saveAccount', payload),
    get: (id) => ipcRenderer.invoke('bank:get', id),
    transactions: (args) => ipcRenderer.invoke('bank:transactions', args),
    count: (args) => ipcRenderer.invoke('bank:count', args),
    suggestions: (id) => ipcRenderer.invoke('bank:suggestions', id),
    reconcile: (payload) => ipcRenderer.invoke('bank:reconcile', payload),
    unreconcile: (id) => ipcRenderer.invoke('bank:unreconcile', id),
    importFile: (accountId) => ipcRenderer.invoke('bank:importFile', accountId),
    sync: (accountId) => ipcRenderer.invoke('bank:sync', accountId)
  },
  vat: {
    report: (periodKey) => ipcRenderer.invoke('vat:report', periodKey),
    refresh: (periodKey) => ipcRenderer.invoke('vat:refresh', periodKey),
    candidates: (invoiceId, search='') => ipcRenderer.invoke('vat:candidates', { invoiceId, search }),
    allocate: (payload) => ipcRenderer.invoke('vat:allocate', payload),
    unallocate: (allocationId) => ipcRenderer.invoke('vat:unallocate', allocationId),
    setTreatment: (payload) => ipcRenderer.invoke('vat:setTreatment', payload),
    addAdjustment: (payload) => ipcRenderer.invoke('vat:addAdjustment', payload),
    deleteAdjustment: (adjustmentId) => ipcRenderer.invoke('vat:deleteAdjustment', adjustmentId),
    close: (payload) => ipcRenderer.invoke('vat:close', payload),
    reopen: (payload) => ipcRenderer.invoke('vat:reopen', payload),
    integrity: () => ipcRenderer.invoke('vat:integrity'),
    export: (periodKey) => ipcRenderer.invoke('vat:export', periodKey)
  },
  openDataFolder: () => ipcRenderer.invoke('app:openDataFolder'),
  updates: {
    status: () => ipcRenderer.invoke('updates:status'),
    check: () => ipcRenderer.invoke('updates:check'),
    install: () => ipcRenderer.invoke('updates:install'),
    onStatus: (handler) => {
      if (typeof handler !== 'function') return () => {};
      const listener = (_event, payload) => handler(payload || {});
      ipcRenderer.on('updates:status', listener);
      return () => ipcRenderer.removeListener('updates:status', listener);
    }
  },
  openDirectionWindow: (direction) => ipcRenderer.invoke('invoice:openDirectionWindow', direction),
  onRefresh: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, payload) => handler(payload||{});
    ipcRenderer.on('invoice:refresh', listener);
    return () => ipcRenderer.removeListener('invoice:refresh', listener);
  }
});
