'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src', 'styles-v1170.css'), 'utf8');

const linkedStyles = [...html.matchAll(/<link rel="stylesheet" href="\.\/(styles-[^"]+\.css)">/g)].map(match => match[1]);
assert.equal(linkedStyles.at(-1), 'styles-v1170.css', 'The authoritative UI contract must load last');
assert.equal(linkedStyles.includes('styles-v181.css'), false, 'Historical density patches must not remain active');
assert.equal(linkedStyles.includes('styles-v113.css'), false, 'Historical table patches must not remain active');

const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
assert.equal((withoutComments.match(/\{/g) || []).length, (withoutComments.match(/\}/g) || []).length, 'CSS blocks must be balanced');

assert.match(css, /\.shell \{[\s\S]*flex-direction: column !important/);
assert.match(css, /\.sidebar \{[\s\S]*width: 100% !important[\s\S]*height: 52px !important/);
assert.match(css, /#invoiceWorkspace > \.pagehead,[\s\S]*display: none !important/);
assert.match(css, /#invoiceWorkspace > \.filters,[\s\S]*flex: 0 0 44px !important/);
assert.match(css, /#invoiceWorkspace > \.registry-panel,[\s\S]*flex: 1 1 auto !important/);
assert.match(css, /\.work-tabs \{[\s\S]*height: 30px !important/);

assert.match(css, /\.tablewrap \{[\s\S]*overflow: auto !important/);
assert.match(css, /\.registry-table,[\s\S]*table-layout: fixed !important/);
assert.match(css, /\.registry-table td,[\s\S]*max-width: 0 !important[\s\S]*text-overflow: ellipsis !important/);
assert.match(css, /\.registry-table tbody tr\.is-selected > td/);
assert.match(css, /\.registry-table \{[\s\S]*min-width: 1180px !important/);
assert.match(css, /\.registry-table \.col-select \{ width: 3% !important; \}/);
assert.match(css, /\.registry-table \.col-actions \{ width: 6% !important; \}/);

assert.match(html, /class="bank-table" aria-label="Bank əməliyyatları"><colgroup>/);
assert.match(html, /class="dashboard-table dashboard-bank-table" aria-label="Son beş çıxan bank ödənişi"><colgroup>/);
assert.match(html, /class="reference-table data-table" aria-label="Uçot məlumat kitabçası"/);
assert.match(html, /class="vat-table" aria-label="Aylıq ƏDV registri"/);
assert.match(html, /row\.classList\.toggle\('is-selected',checkbox\.checked\)/);
assert.match(html, /row\.setAttribute\('aria-selected',String\(checkbox\.checked\)\)/);

assert.match(css, /@media \(max-width: 1280px\)/);
assert.match(css, /@media \(max-width: 900px\)/);
assert.match(css, /@media \(max-width: 640px\)/);

console.log('professional UI v1.17.0: OK');
