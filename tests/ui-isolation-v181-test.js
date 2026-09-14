'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'src','index.html'),'utf8');
const css=fs.readFileSync(path.join(root,'src','styles-v1170.css'),'utf8');
const main=fs.readFileSync(path.join(root,'main.js'),'utf8');

assert.match(html,/APP_VERSION='1\.17\.0'/);
assert.doesNotMatch(html,/href="\.\/styles-v170\.css"/,'Legacy v1.7 stylesheet must not be loaded with the new UI');
assert.doesNotMatch(html,/href="\.\/styles-v181\.css"/,'Historical UI patch must not compete with the authoritative stylesheet');
assert.match(html,/href="\.\/styles-v1170\.css"/);

assert.match(html,/invoice-incoming/);
assert.match(html,/invoice-outgoing/);
assert.match(html,/bank-incoming/);
assert.match(html,/bank-outgoing/);
assert.match(html,/data-close-work/,'Internal windows must be closable from the bottom tab strip');
assert.match(html,/direction:bankActiveDirection/,'Incoming and outgoing bank operations must be queried separately');

assert.match(html,/href="\.\/styles-v182\.css"/);
assert.match(html,/src="\.\/dbc-v182\.js"/);
assert.match(html,/class="cell-clip"/);
assert.match(css,/table-layout: fixed !important/);
assert.match(css,/overflow: hidden !important/);
assert.match(css,/text-overflow: ellipsis !important/);
assert.match(css,/#invoiceWorkspace > \.pagehead[\s\S]*display: none !important/);
assert.match(css,/\.work-tabs \{[\s\S]*height: 30px !important/);

assert.match(main,/DB_SCHEMA_VERSION = 211/);
assert.match(main,/function sanitizeCounterpartyName/);
assert.match(main,/repairPollutedCounterpartyNames\(\);\s*\n\s*migrateExpenseAccountsToSubcontos\(\);\s*\n\s*migrateExistingInvoicesToAutomaticAccounting\(\);\s*\n\s*repairAutomaticInvoiceAccountingIntegrity\(\);/,
  'Polluted names must be repaired before accounting migration');

console.log('UI/data isolation v1.17.0: OK');
