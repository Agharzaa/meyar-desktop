'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const cssV180 = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles-v180.css'), 'utf8');
const cssV117 = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles-v1170.css'), 'utf8');

assert.equal((html.match(/<style(?:\s|>)/g) || []).length, (html.match(/<\/style>/g) || []).length, 'Style blokları balanslı olmalıdır');
assert.equal((html.match(/<script(?:\s|>)/g) || []).length, (html.match(/<\/script>/g) || []).length, 'Script blokları balanslı olmalıdır');
assert.doesNotMatch(html, /<(?:link|script)[^>]+https?:\/\//i, 'Əsas UI xarici CDN-dən asılı olmamalıdır');
for (const id of ['dashboardWorkspace','invoiceWorkspace','bankWorkspace','taxWorkspace','referenceWorkspace','navDashboard','navReference','helpBtn','modalRoot','toastRoot','workTabs']) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `${id} UI elementi mövcud olmalıdır`);
}
assert.match(html, /const APP_VERSION='1\.17\.1'/);
assert.doesNotMatch(html, /href="\.\/styles-v170\.css"/);
assert.match(html, /styles-v180\.css/);
assert.doesNotMatch(html, /href="\.\/styles-v181\.css"/);
assert.doesNotMatch(html, /href="\.\/styles-v113\.css"/);
assert.match(html, /styles-v1170\.css/);
assert.match(html, /class=["']panel registry-panel["']/);
assert.equal((html.match(/<col class="col-/g) || []).length, 10, 'Qaimə reyestri 10 oxunaqlı sütuna yığılmalıdır');
assert.match(cssV117, /\.sourcegrid[\s\S]*display: none !important/, 'Təkrarlanan mənbə kartları görünməməlidir');
assert.match(cssV117, /#invoiceWorkspace > \.registry-panel > \.tablewrap,[\s\S]*flex: 1 1 auto !important/, 'Qaimə reyestri qalan hündürlüyü istifadə etməlidir');
assert.match(cssV180, /\.shell\{flex-direction:column!important\}/, 'Sol sidebar üst modul panelinə çevrilməlidir');
assert.match(cssV180, /background:#0a754d!important/, 'Cədvəl başlıqları yaşıl dizayn sistemindən istifadə etməlidir');
assert.match(cssV180, /\.work-tabs\{/, 'Açıq daxili pəncərələr aşağı tab panelində göstərilməlidir');
assert.match(cssV117, /table-layout: fixed !important/, 'Bütün aktiv cədvəllər sabit sütun sxemindən istifadə etməlidir');
assert.match(cssV117, /\.line-table-scroll/, 'Qaimə sətirləri ayrıca daşma konteynerində olmalıdır');
assert.match(cssV117, /\.invoice-v10,[\s\S]*\.invoice-detail-v113/, 'Qaimə kartları daxili tam iş pəncərəsi olmalıdır');
assert.match(html, /id="invoiceToolbar" hidden aria-hidden="true"/, 'Köhnə yuxarı qaimə zolağı iş pəncərəsində görünməməlidir');
assert.match(html, /class="invoice-filter-actions"[\s\S]*id="manualInvoice"[\s\S]*id="exportInvoices"[\s\S]*id="resetFilters"/, 'Qaimə əməliyyatları kompakt filtr zolağında olmalıdır');
assert.match(html, /<div class="head">Uçot hesabı<\/div><div class="head">Subkonto<\/div><div class="head">Anbar \/ üsul<\/div><div class="head">Yekun<\/div>/, 'Qaimə sətri başlıqları məlumat sütunları ilə tam uyğun olmalıdır');
assert.match(html, /Bank üzrə son 5 çıxan ödəniş[\s\S]*<th>Kontragent<\/th><th>Məbləğ<\/th>/, 'Əsas səhifə yalnız son çıxan bank ödənişlərinin kontragent və məbləğini göstərməlidir');
assert.match(html, /bank\.transactions\(\{limit:5,direction:'Ödəniş'\}\)/, 'Əsas səhifə daxil olan və çıxan ödənişləri qarışdırmamalıdır');
assert.doesNotMatch(html, /data-reference="users"|newUserPassword/, 'Parollu istifadəçi idarəsi bu mərhələdə interfeysdə göstərilməməlidir');
assert.match(cssV117, /#invoiceToolbar,[\s\S]*display: none !important/, 'Köhnə qaimə toolbarı CSS səviyyəsində də bağlanmalıdır');
assert.match(cssV117, /text-overflow: ellipsis !important/, 'Cədvəl mətnləri qonşu sütuna daşmamalıdır');
assert.match(html, /aria-live/);
assert.match(html, /aria-modal/);
assert.match(html, /focus-visible/);
assert.doesNotMatch(html, /<style>\s*\.tax-grid[\s\S]*<style>/, 'CSS daxilində iç-içə style teqi olmamalıdır');

console.log('UI structure v1.17.1: OK');
