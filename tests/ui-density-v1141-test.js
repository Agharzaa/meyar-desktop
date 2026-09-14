'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'src','index.html'),'utf8');
const css=fs.readFileSync(path.join(root,'src','styles-v113.css'),'utf8');

assert.doesNotMatch(html,/<div class="titlebar">/,'Native Electron frame must not be duplicated by a second title bar');
assert.doesNotMatch(html,/<div class="top">/,'Context screens must not lose height to a duplicate global search/profile row');
assert.doesNotMatch(html,/id="globalSearch"/,'Invoice search must have one authoritative input');
assert.match(html,/data-direction-window="Gedən"[^>]*>[\s\S]*?<span>Gedən qaimələr<\/span>/,'Outgoing invoices must use the agreed label');

assert.match(html,/id="referenceColumns"/,'Dynamic master-data tables require an explicit colgroup');
assert.match(html,/widths:\[31,12,14,15,15,13\]/,'Counterparty columns must have a deterministic 100% allocation');
assert.match(html,/colspan="\$\{config\.widths\.length\}"/,'Empty master-data tables must use their actual column count');

assert.match(css,/#invoiceWorkspace>\.filters>\.field:nth-child\(2\)\{display:flex!important/,'The registry selector must not remain hidden by a legacy stylesheet');
assert.match(css,/\.registry-table \.action-cell\{display:table-cell!important/,'Invoice actions must remain a real table cell');
assert.match(css,/#invoiceWorkspace>\.registry-panel\{display:flex!important;flex:0 1 auto!important/,'Short registers must not draw an unnecessary full-height bordered panel');
assert.match(css,/\.reference-table\{width:100%!important;min-width:900px!important;table-layout:fixed!important/,'Master-data colgroups require fixed table layout');
assert.match(css,/tr\.reference-selected>td/,'Master-data row selection must be visible');

console.log('UI density v1.14.3: OK');
