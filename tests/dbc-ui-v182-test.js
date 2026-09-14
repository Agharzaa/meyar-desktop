'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'src', 'dbc-v182.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src', 'styles-v182.css'), 'utf8');

assert.match(html, /styles-v182\.css/);
assert.match(html, /dbc-v182\.js/);
assert.match(html, /APP_VERSION='1\.17\.0'/);
assert.match(script, /Dövrün əvvəlinə qalıq/);
assert.match(script, /Dövr ərzində dövriyyə/);
assert.match(script, /Dövrün sonuna qalıq/);
assert.match(script, /<th>Debet<\/th><th>Kredit<\/th>/);
assert.match(script, /function toggleCounterpartyDetails/);
assert.match(script, /function toggleAnalyticDetails/);
assert.match(script, /analyticLedger/);
assert.match(script, /counterpartyLedger/);
assert.match(script, /totalsFooter/);
assert.match(css, /\.dbc-v182-toggle/);
assert.match(css, /position: sticky/);
assert.doesNotMatch(css, /!important/);

const browser = { window: {}, Intl };
vm.runInNewContext(script, browser, { filename: 'dbc-v182.js' });
assert.equal(typeof browser.window.MeyarDBC.openReport, 'function');
assert.equal(typeof browser.window.MeyarDBC.openAccount, 'function');

console.log('DBC UI v1.8.2: OK');
