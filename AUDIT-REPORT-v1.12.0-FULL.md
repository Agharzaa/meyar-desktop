# Meyar ERP Desktop v1.12.0 — Tam audit hesabatı
**Tarix:** 2026-09-05 · **Əhatə:** kod keyfiyyəti, təhlükəsizlik, mühasibat/uçot məntiqi, test sistemi, UI/dizayn, paketləşdirmə

---

## 0. Ümumi mənzərə

Bu, real mənada ciddi mühəndislik işi görülmüş bir layihədir — sadə "CRUD proqram" deyil, əsl 1C-tipli müxabirləşmə mühərriki qurulub: hər sənəd vahid tranzaksiyada Debet=Kredit balansına yoxlanır, geri qaytarma (storno) mexanizmi var, anbar FIFO/orta maya hesablanır, dövriyyə-balans analitik sətirlərlə üst-üstə düşür (reconciliation). Bu, çoxlarının Electron+SQLite ERP-lərində görmədiyim səviyyədə diqqətli işdir.

Bununla belə, "bütün Azərbaycanda istifadə olunacaq" hədəfi ilə müqayisədə **bir neçə struktur məsələ** var ki, bunlar kodun "səhv olması" deyil, "hədəfə uyğun olub-olmaması" məsələsidir. Onları da açıq şəkildə qeyd edirəm.

Tapıntılar üç səviyyəyə bölünüb: 🔴 Kritik (istehsala qədər həll olunmalı), 🟠 Vacib (yaxın buraxılışda), 🟡 Töhfə/keyfiyyət (vaxt olanda).

---

## 1. Mühasibat/uçot mühərriki — məzmun auditi

### 1.1 Doğru işləyən əsas mexanizmlər (yoxlanıldı)
- **Balans nəzarəti** (`assertJournalBalanced`): hər `journal_entries` yazısından sonra Debet=Kredit yoxlanır, uyğunsuzluqda bütün tranzaksiya (`BEGIN IMMEDIATE…ROLLBACK`) geri qaytarılır. `saveInvoice`, `postInvoice`, `bankReconcile`, `rebuildInventoryScopes` — hamısı bu qaydaya tabedir. Kodu oxuyanda yarımçıq/balanslaşmamış jurnal yazısının bazaya düşməsi üçün heç bir yol tapmadım.
- **Redaktə/storno məntiqi** (`reverseActiveJournalForSource`): qaimə redaktə olunanda köhnə jurnal sətirləri silinmir, əksinə əks işarəli "storno" yazısı əlavə olunur və audit izi saxlanılır. Bu, mühasibat qaydalarına görə düzgün yanaşmadır (silinmə əvəzinə storno).
- **Anbar dəyərləmə** (`lib/accounting-engine.js::valueInventoryMovements`): FIFO qatları və orta maya both düzgün riyazi məntiqlə yazılıb; mənfi qalıq (shortage) ayrıca izlənir və anbar `allow_negative_stock=0` olduqda əməliyyat bloklanır — real anbar itkisini gizlətmir.
- **Analitika ↔ DBC uzlaşması**: `accountCounterparties`, `accountAnalytics`, `inventoryAccountAnalytics` funksiyalarının hər biri öz nəticəsini `turnoverBalance()`-un müstəqil hesabladığı closing balansla **çarpaz yoxlayır** və fərq çıxarsa, "Analitikasız açılış qalığı" adlı düzəldici sətir əlavə edir. Bu, mən nadir hallarda gördüyüm özünü-yoxlayan mühasibat dizaynıdır — əlində 205/211/531 hesabları uyğunsuz görünəndə səbəbini gizlətmir, göstərir.
- **VÖEN, tarix, məbləğ validasiyası** (`validateInvoicePayload`) sərtdir: 10 rəqəmli VÖEN, keçərli tarix formatı, mənfi qiymət/faiz qadağası, sıfır əsas məbləğin qadağası. Bu, real DVX/vergi tələblərinə uyğundur.
- **Dövr bağlama** (`assertAccountingDateOpen` + `closed_through_date`): bağlanmış dövrə yeni yazı və ya storno aparıla bilmir — mühasibat intizamı üçün vacib nəzarətdir və mövcuddur.

### 1.2 🟠 Diqqət tələb edən uçot məqamları
1. **Suspense/gözləmə hesabı defolt seçimi.** `resolvePosting()`-də mal/xidmət növü tapılmadıqda əməliyyat avtomatik **721.99** ("gözləmə/qeyri-müəyyən") hesabına yazılır və `needsReview` bayrağı qalxır — amma bu bayraq yalnız `accounting_review_required` sahəsində saxlanılır, UI-də bu sənədləri **filtrləyib tək ekranda görmək** üçün ayrıca "Nəzərdən keçirilməli" iş tabı yoxdur (yalnız qaimə kartında qeyd forması var). Real mühasiblik təcrübəsində aylıq bağlanışdan əvvəl "721.99-da neçə sənəd qalıb" sualı hər zaman veriləcək — bunun üçün ayrıca hesabat/filtr tövsiyə olunur.
2. **Məzənnə fərqi (FX) hesabı yoxdur.** Xarici valyutalı qaimələrdə `exchange_rate` daxil edilir və `functional_total_amount` hesablanır, lakin ödəniş fərqli tarixdə fərqli məzənnə ilə daxil olanda **məzənnə fərqi (course difference) üçün ayrıca 723/523 tipli hesaba yazılan sətir görmədim** — `bankReconcile`-da ödənişin məzənnəsi (`payload.exchangeRate`) sadəcə həmin əməliyyatın funksional məbləğini hesablamaq üçün işlədilir, əsl qaimə ilə ödəniş məzənnəsi arasındakı fərq ayrıca mühasibat sətri kimi çıxarılmır. Yalnız AZN ilə işləyən şirkətlər üçün bu problem deyil, lakin USD/EUR fakturası olan şirkətlər üçün DBC-də kiçik uyğunsuzluqlar toplana bilər.
3. **Yalnız bir aktiv "posting profile" defolt seçilir.** `createInvoicePosting`-də profil verilməyibsə, `direction`-a görə **ilk aktiv profil** avtomatik seçilir (`ORDER BY id LIMIT 1`). Əgər bir şirkətdə eyni istiqamətdə birdən çox profil olsa (məs., "Mal alışı" və "Xidmət alışı" ayrı profil kimi qurulubsa), sistem həmişə ilkini seçəcək və istifadəçi diqqətli olmasa səhv profil tətbiq oluna bilər. Tövsiyə: profil seçimi item_type-a görə də filtirlənsin, ya da profil seçilmədən saxlamaq qadağan edilsin.
4. **VÖEN yoxlaması yalnız formatdır, nəzarət rəqəmi deyil.** `/^\d{10}$/` — Azərbaycan VÖEN-inin çek-rəqəm alqoritmi tətbiq olunmur, ona görə "1234567890" kimi mənasız amma formatca düzgün VÖEN qəbul olunur. DVX inteqrasiyası olduğu üçün real VÖEN doğrulama (nəzarət rəqəmi və ya DVX API-dən kontragent axtarışı) əlavə etmək faydalı olardı.

### 1.3 🔴 Ən vacib struktur məsələ: tək istifadəçili giriş
`auth:login` funksiyası:
```js
if (username !== OWNER_USERNAME) throw new Error('Bu sistemdə yalnız baş inzibatçı hesabı ilə giriş mümkündür.');
```
Baza sxemi (`user_accounts`, `role`, hər şirkət üçün ayrı istifadəçi siyahısı) **çox-istifadəçili** işləmək üçün qurulub, lakin giriş məntiqi sistemdə **yalnız `agarza.admin`** adlı hesaba icazə verir — həm `auth:setup`, həm `auth:createCompany` yaradılan hər yeni şirkətin admin hesabını məcburən bu adla yaradır. Nəticə:
- Mühasib, kassir, anbardar kimi ayrı rollu istifadəçilər **heç vaxt daxil ola bilmir**, baxmayaraq ki DB sxemi və `role` sahəsi bunun üçün nəzərdə tutulub.
- "Bütün Azərbaycanda istifadə olunacaq" hədəfi ilə bu, ciddi ziddiyyətdir — hər şirkətdə faktiki olaraq yalnız bir nəfər (adı literal olaraq kodda yazılmış "Ağarza Ağalarov") sistemə daxil ola bilər.
- Bu, ya bilərəkdən qoyulmuş lisenziya/nəzarət mexanizmidir (yəni məhsulun sahibi hər instalasiyaya şəxsən nəzarət etmək istəyir), ya da hələ tamamlanmamış çox-istifadəçili funksiyadır. Hər iki halda **məhsulun genişlənmə planına birbaşa təsir edən qərardır** və gizli qalmamalıdır — açıq şəkildə sənədləşdirilməli və ya açılmalıdır.

---

## 2. Kod keyfiyyəti və təhlükəsizlik auditi

### 2.1 Yaxşı tərəflər (təsdiqlənib)
- **Electron təhlükəsizlik konfiqurasiyası düzgündür**: bütün pəncərələrdə `contextIsolation:true`, `nodeIntegration:false`, `sandbox:true`; `setWindowOpenHandler` yeni pəncərə açılışını rədd edir; `will-navigate` yalnız `file:` protokoluna icazə verir. DVX canlı pəncərəsində URL yalnız `new.e-taxes.gov.az` ailəsinə whitelisting ilə məhdudlaşdırılıb (`allowedTaxUrl`).
- **SQL injection riski tapılmadı.** Bütün sorğular parametrləşdirilib (`?` + `.run()/.get()/.all()` arqumentləri). Dinamik SQL fraqmentləri (`WHERE ${where.join(' AND ')}` kimi) yalnız sabit mətn parçalarını birləşdirir, istifadəçi datası həmişə `params` massivində ötürülür — düzgün yanaşma.
- **XSS-dən qorunma ardıcıldır.** `src/index.html` və `src/dbc-v182.js`-də bütün dinamik HTML `esc()`/`escape()` funksiyası ilə keçir (`&<>"'` kodlaşdırılır). Yoxladığım bütün `innerHTML` yerlərində bu tətbiq olunub.
- **Parol saxlanması təhlükəsiz**: `crypto.scryptSync` + təsadüfi duz (salt) + `timingSafeEqual` — müasir və düzgün üsuldur (sadə SHA1/MD5 deyil).
- **Tranzaksiya təhlükəsizliyi**: bütün yazma əməliyyatları `BEGIN IMMEDIATE` ilə açılır və `try/catch`-də `ROLLBACK` təmin olunur; qismən yazılmış vəziyyət qalmır.
- `secureHandle()` sarğısı hər IPC çağırışında `requireAuth()` yoxlayır və payload ölçüsünü 10MB-la məhdudlaşdırır (DoS-a qarşı sadə amma faydalı tədbir).

### 2.2 🔴 Kritik: `xlsx` (SheetJS) paketi köhnə və zəiflikli versiyada
`package.json`-da `"xlsx": "^0.18.5"`. Bu, npm reyestrində mövcud olan **son** versiyadır və içində iki həll olunmamış zəiflik var:
- **CVE-2024-22363** — ReDoS (Regular Expression Denial of Service), Yüksək təhlükə;
- **CVE-2023-30533 / GHSA-4r6h-8v6p-xvw6** — Prototip çirklənməsi (Prototype Pollution), xüsusi hazırlanmış fayl oxunanda.

SheetJS özü bu düzəlişləri yalnız öz CDN-i (`cdn.sheetjs.com`) üzərindən yayır, npm-də paket **artıq yenilənmir**. Meyar ERP-də bu paket məhz **xarici mənbədən gələn XLSX/CSV fayllarını** (bank çıxarışı, DVX/e-qaimə idxalı) oxumaq üçün işlədilir — yəni tam olaraq zəifliyin istismar oluna biləcəyi ssenari: kimsə xüsusi hazırlanmış "bank çıxarışı.xlsx" faylı versə, tətbiq bu faylı oxuyarkən risk altındadır.
**Tövsiyə:** `xlsx` paketini SheetJS-in rəsmi CDN buraxılışı (məs. `https://cdn.sheetjs.com/xlsx-0.20.2/xlsx-0.20.2.tgz`) ilə `package.json`-da `overrides`/birbaşa asılılıq kimi əvəz edin, ya da idxal yalnız CSV-yə keçirilsin (XLSX parametrləşməsi minimuma enərsə risk azalır).

### 2.3 🟠 Ölü/artıq kod — repo təmizliyi
- **`src/legacy.html` (1919 sətir)** — `main.js`-də heç bir yerdən yüklənmir (yalnız `src/index.html` yüklənir). Bu, əvvəlki versiyaların UI-si olub, silinməyib. Təsadüfən kimsə gələcəkdə bu fayla keçid əlavə etsə, README-də qeyd olunan "eyni anda yüklənən zidd UI qatları" problemi (v1.8.1-də düzəldilmiş) yenidən geri qayıda bilər.
- **`src/styles-v170.css`** — `index.html` yalnız v180/v181/v182 CSS-lərini bağlayır, v170 heç yerdə keçid almır, ölü fayldır.
- Tövsiyə: hər iki fayl ya silinsin, ya `archive/` qovluğuna keçirilsin ki, aktiv mənbə ilə qarışmasın.

### 2.4 🟡 Kiçik gözlənilməz vəziyyətlər
- `postInvoice`/`saveInvoice` daxilində `createInvoicePosting` çağırılır, o da öz növbəsində `accountingStatus().accounting_enabled` yoxlayır — yəni uçot deaktiv olan şirkətdə **heç bir qaimə saxlanıla bilmir** (`saveInvoice` daxilində statusu birbaşa "Təsdiqlənib" edir və avtomatik postinq cəhd edir). Bu, dizayn baxımından məntiqlidir, amma "uçotsuz, sadəcə reyestr kimi" istifadə etmək istəyən kiçik biznes üçün seçim yoxdur — README-də "uçot deaktiv" halının nə üçün var olduğu izah olunmayıb, amma praktikada demək olar işə yaramır.
- `resolvePosting` funksiyasında mal/xidmət təsnifatı açar-söz siyahısına əsaslanır (`inferItemType`). Bu evristik üsuldur — yeni məhsul/xidmət adları (məs. "SIM kart", "server icarəsi") siyahıda olmadıqda səhv təsnif oluna bilər. Hazırkı kодда bu, `needsReview` bayrağı ilə qismən kompensasiya olunur, amma söz siyahısının vaxtaşırı yenilənməsi əməliyyat tələb edir (statistik/ML yanaşma deyil, sabit lüğətdir).

---

## 3. Test sistemi auditi

`package.json`-dakı `test` skripti 18 test faylını ardıcıl çağırır. Faylların əksəriyyəti — `accounting-core-v112-test.js`, `v180-system-regression.js`, `core-v160-regression.js` — **çox ağıllı bir texnika** işlədir: `main.js`-in mənbə kodunu `fs.readFileSync` ilə oxuyub, `app.whenReady()`-dən əvvəlki hissəni kəsib, `module.exports` əlavə edib, `electron` modulunu stub edib, `vm.Script` daxilində icra edirlər. Beləliklə, **real production funksiyalar** (`saveInvoice`, `postInvoice`, `accountAnalytics` və s.) həqiqətən müvəqqəti SQLite bazası üzərində test olunur. Bu, `main.js`-in özü `module.exports` olmadığı üçün normal `require()` ilə test edilə bilməyəcəyi vəziyyətdə **düzgün seçilmiş bir mühəndislik həllidir**.

### 🟠 Tapıntı: `tests/dbc-test.js` real koddan ayrı düşüb
Bu fayl yuxarıdakı VM-texnikasını işlətmir — əvəzinə `turnoverBalance()` funksiyasının **öz sadələşdirilmiş surətini** yenidən yazır (heç bir açılış qalığı (`opening_balances`) cədvəli, `accounting_enabled`/`opening_date` məntiqi yoxdur). Mən bunu işlədib yoxladım — test keçir (`DBC TEST OK`), amma real `main.js::turnoverBalance()`-un indi malik olduğu **açılış tarixi daxilində/xaricində qalıq bölgüsü** məntiqini heç test etmir. Yəni bu test faktiki olaraq **köhnə, sadə versiyanın** düzgünlüyünü göstərir, hazırkı istehsal kodunun düzgünlüyünü yox. Əgər gələcəkdə kimsə `turnoverBalance`-ı dəyişdirib səhv salsa, bu test yenə "OK" göstərəcək, çünki öz ayrı surətini yoxlayır.
**Tövsiyə:** `dbc-test.js`-i silin (artıq `core-v160-regression.js`/`v180-system-regression.js` eyni funksiyanı VM-texnika ilə real kodda test edir) və ya onu da eyni VM-injection üsuluna keçirin.

Ümumilikdə test infrastrukturu — bir istisna ilə — gözlədiyimdən daha ciddi və etibarlıdır.

---

## 4. UI/Dizayn auditi

- **Dizayn dili ardıcıldır**: ağ-yaşıl (Meyar) rəng sistemi CSS dəyişənləri (`--dbc-green`, `--dbc-text` və s.) ilə mərkəzləşdirilib, v180→v182 CSS qatları üst-üstə düzəliş şəklində qurulub (versiyalanmış patch-lər kimi, tam yenidən yazma deyil). Bu, uzunmüddətdə saxlanmanı çətinləşdirir (3 ayrı CSS faylı bir-birini "override" edir) — münasib vaxtda bir `styles.css`-ə birləşdirmək faydalı olardı.
- **Cədvəl davranışı düzgün həll olunub**: `table-layout:fixed`, sabit sütun, `ellipsis`+tooltip — uzun kontragent adlarının qonşu sütuna basmaması təmin olunub (README-də iddia edilən problem faktiki CSS-də düzəldilib).
- **🟡 Şrift ölçüsü kiçikdir**: DBC kart başlıq mətnləri 8–9px təyin olunub (`styles-v182.css`). Mühasiblər tez-tez uzun saatlar ekrana baxır və yaş aralığı da geniş ola bilər — 8px demək olar oxunmaz həddədir, xüsusən aşağı DPI monitorlarda. Minimum 11–12px tövsiyə olunur (əsas mətn üçün onsuz da README-də "12–13px" hədəfi qoyulub, amma bu konkret başlıq mətnləri həddindən kiçik qalıb).
- Modallar, DVX kartı, bank iş sahəsi eyni "idarəetmə zolağı + sabit başlıqlı cədvəl" strukturuna tabedir — 1C-yə bənzər desktop mühasibat proqramları üçün tanış və məntiqli seçimdir.

---

## 5. Paketləşdirmə və yayım (istehsala hazırlıq)

🟠 **"Bütün Azərbaycanda" hədəfi ilə ziddiyyət təşkil edən əməli məqam:** hazırda proqram end-user-ə **quraşdırılmış `.exe` installer** kimi deyil, xam mənbə kodu + `.cmd` işə salma skripti kimi paylanır:
```
if not exist node_modules ( npm.cmd install )
start npm.cmd start
```
Bu o deməkdir ki, **hər mühasibin kompüterində**:
1. Node.js 24 LTS əl ilə quraşdırılmalıdır (skript link açır, avtomatik qurmur);
2. İlk açılışda internetdən Electron (yüzlərlə MB) və `xlsx` daxil bütün asılılıqlar `npm install` ilə endirilir;
3. `package.json`, `node_modules` və mənbə kodu istənilən istifadəçi tərəfindən açıla/dəyişdirilə bilər (kod imzalama, versiya nəzarəti və avtomatik yenilənmə yoxdur).

Kiçik komanda daxilində (bir neçə mühasib) bu qəbul edilə bilər, amma "bütün Azərbaycanda" miqyasında **electron-builder/electron-forge ilə imzalanmış tək-fayl Windows installer + avtomatik yenilənmə (auto-update) mexanizmi** olmadan dəstək və təhlükəsizlik yükü sürətlə böyüyəcək (hər müştəridə fərqli Node versiyası, fərqli `npm install` xətaları, fərqli disk icazələri).

---

## 6. Prioritetli tövsiyələr xülasəsi

**🔴 Kritik (buraxılışdan əvvəl):**
1. `xlsx@0.18.5`-i SheetJS-in düzəldilmiş CDN buraxılışı ilə əvəz edin (ReDoS + prototip çirklənməsi).
2. Giriş sisteminin "yalnız `agarza.admin`" məhdudiyyətini şüurlu qərar kimi sənədləşdirin və ya çox-istifadəçili girişi (mühasib/anbardar rolları üçün) həqiqətən açın — DB sxemi artıq buna hazırdır.
3. Distributiv strategiyası: electron-builder ilə imzalanmış installer + auto-update, əl ilə `npm install`-dan asılı olmayan yayım.

**🟠 Vacib (yaxın buraxılış):**
4. `tests/dbc-test.js`-i silin və ya real koda (VM-injection üsulu ilə) bağlayın — hazırda yanlış təhlükəsizlik hissi verir.
5. 721.99 (gözləmə hesabı) üçün ayrıca "Nəzərdən keçirilməli sənədlər" iş sahəsi/hesabatı əlavə edin.
6. Xarici valyutalı qaimə+ödəniş üçün məzənnə fərqi mühasibat sətri əlavə edin.
7. `src/legacy.html` və `src/styles-v170.css` ölü fayllarını silin/arxivləşdirin.
8. Posting profile seçimini item_type-a görə də filtrləyin ki, "ilk aktiv profil" səhvən yanlış hesaba yönləndirməsin.

**🟡 Töhfə (vaxt olanda):**
9. VÖEN-ə Azərbaycan nəzarət-rəqəmi alqoritmi əlavə edin (sadəcə 10 rəqəm yoxlaması kifayət deyil).
10. DBC kart başlıq şriftlərini 8–9px-dən minimum 11–12px-ə qaldırın.
11. `styles-v180/181/182.css` üç qatını tək fayla birləşdirin.

---

## 7. Yekun

Meyar ERP-nin **mühasibat nüvəsi** — jurnal balansı, storno, anbar dəyərləmə, DBC-analitika uzlaşması — mən gördüyüm bənzər layihələrin çoxundan daha ciddi qurulub və 1C məntiqinə sadiqdir. Əsas risklər kodun məntiqi səhvlərində deyil, **(a)** köhnəlmiş xarici paket (`xlsx`), **(b)** giriş sisteminin tək-istifadəçili qalması və **(c)** ölkə miqyasında yayım üçün paketləmə infrastrukturunun olmamasındadır. Bu üçü həll olunsa, sistem həqiqətən genişmiqyaslı istifadəyə hazır olar.
