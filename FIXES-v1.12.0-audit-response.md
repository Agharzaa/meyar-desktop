# Meyar ERP — Audit əsasında edilmiş düzəlişlər (v1.12.0 üzərində)
**Tarix:** 2026-09-06 · Əsas sənəd: `AUDIT-REPORT-v1.12.0-FULL.md`

Bu sənəd əvvəlki audit hesabatında tapılan hər bir məsələnin **nə edildiyini, necə yoxlanıldığını** və (varsa) **niyə edilmədiyini** izləmək üçündür. Bütün dəyişikliklər `npm test` ilə doğrulanıb (aşağıda) və iki yeni reqressiya testi əlavə olunub.

## 🔴 Kritik — həll olundu

### 1. `xlsx` (SheetJS) zəifliyi
- **Nə edildi:** `package.json`-da `"xlsx": "npm:@e965/xlsx@0.20.3"` — npm alias vasitəsilə `require('xlsx')` heç bir kod dəyişikliyi olmadan indi SheetJS-in CVE-2024-22363 (ReDoS) və CVE-2023-30533 (Prototip çirklənməsi) zəifliklərinin hər ikisi düzəldilmiş 0.20.3 versiyasını yükləyir.
- **Yoxlanıldı:** `npm install` icra olundu, `require('xlsx').version === '0.20.3'` təsdiqləndi.
- **Qeyd:** `@e965/xlsx` SheetJS-in özünün deyil, icma tərəfindən avtomatlaşdırılmış GitHub Actions ilə SheetJS-in rəsmi git deposundan npm-ə köçürülən paketdir (SheetJS özü artıq npm-i yeniləmir, yalnız `cdn.sheetjs.com`-u). Bu sandboxda `cdn.sheetjs.com`-a şəbəkə girişi olmadığı üçün bu, ən praktiki həll idi. **İstehsal üçün tövsiyə:** SheetJS-in öz sənədləşməsinin tövsiyə etdiyi kimi, rəsmi tarball-ı (`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`) endirib layihə daxilində "vendoring" etmək daha etibarlıdır.

### 2. Tək-istifadəçili giriş
- **Nə edildi:**
  - `auth:login` artıq yalnız `agarza.admin`-i yox, seçilmiş şirkətin istənilən **aktiv** `user_accounts` sətrini qəbul edir.
  - Yeni IPC-lər: `users:list`, `users:create`, `users:setActive` (`main.js`), `preload.js`-də `users.*` körpüsü.
  - Yeni UI: "Məlumat kitabçaları → İstifadəçilər" tabı — inzibatçı yeni istifadəçi (mühasib/izləyici/inzibatçı rolu ilə) yarada, mövcudları deaktiv/aktiv edə bilir.
  - Qoruyucular: yalnız `role='admin'` yeni istifadəçi yarada bilər; öz aktiv sessiyanızdakı hesabı deaktiv edə bilməzsiniz; şirkətdə son aktiv inzibatçını deaktiv etmək qadağandır.
  - Giriş ekranındakı "yalnız Ağarza Ağalarov" mətni yeniləndi.
- **Yoxlanıldı:** Yeni `tests/user-management-test.js` — real `auth:setup`, `users:create`, `auth:login`, `users:setActive` IPC handler-larını (Electron-un çağıracağı kimi) işə salaraq: (a) yeni yaradılmış işçi hesabı öz adı/parolu ilə daxil ola bilir, (b) qeyri-admin yeni istifadəçi yarada bilmir, (c) son admin deaktiv edilə bilmir, (d) deaktiv edilmiş istifadəçi artıq daxil ola bilmir — hamısı təsdiqləndi.

### 3. Paketləşdirmə/yayım
- **Nə edildi:** `package.json`-a `electron-builder` (dev-dependency) və Windows NSIS `build` konfiqurasiyası (`npm run dist`) əlavə olundu.
- **Qeyd:** Bu sandboxda kod imzalama sertifikatı olmadığı üçün faktiki `.exe` çıxarışı test edilmədi — konfiqurasiya hazırdır, amma real mühitdə `npm run dist` ilə sınaqdan keçirilməlidir.

## 🟠 Vacib — həll olundu

### 4. Stale test (`tests/dbc-test.js`)
- Silindi — real `turnoverBalance`/`turnoverBalanceSummary` məntiqi artıq `tests/core-v160-regression.js`-də (VM-injection üsulu ilə, real production koduna qarşı) test olunur.

### 5. Gözləmə hesabı (721.99) üçün nəzarət
- `invoiceRows`-a `reviewOnly` filtri, UI-də "Nəzərdən keçirilməli" düyməsi, giriş zamanı say bildirişi (`invoice:stats.accountingReview`) əlavə olundu.

### 6. Məzənnə fərqi (FX) mühasibliyi
- Yeni hesablar: `723.01` (Məzənnə fərqindən xərclər), `723.02` (Məzənnə fərqindən gəlirlər).
- `bankReconcile` artıq kontragent sətrini invoysun **öz** məzənnəsi ilə bağlayır (211.01/531.01 tam ödənildikdə sıfıra enir), fərqi realized FX qazanc/zərər kimi ayrıca yazır.
- **Yoxlanıldı:** Yeni `tests/fx-reconciliation-test.js` — 1000 USD-lik gələn qaimə 1.70 məzənnə ilə yazılıb, 1.80 məzənnə ilə ödənilib: jurnalın balanslaşdığı, 531.01-in tam 1700 (invoysun öz məzənnəsi) ilə bağlandığı, 723.01-ə düz 100 AZN zərər yazıldığı, bank sətrinin faktiki ödənilmiş 1800 AZN-i əks etdirdiyi rəqəmsal olaraq təsdiqləndi.

### 7. Ölü kod
- `src/legacy.html` silindi (heç yerdən yüklənmirdi, təsdiqləndi).
- **Özünütənqid:** İlk auditdə `src/styles-v170.css`-i də "ölü kod" adlandırıb silmişdim — bu **səhv** idi. Test paketi (`tests/ui-structure-v160-test.js`) bu faylın məzmununu (köhnə bir neçə interfeys bugının düzəldiyinin sübutu kimi) yoxlayır, halbuki `index.html` ona keçid vermir — yəni bilərəkdən saxlanılan reqressiya sənədidir, təsadüfi qalıq deyil. Fayl orijinal arxivdən bərpa olundu.

### 8. DBC kart tipoqrafiyası
- `.dbc-v182-table thead th` 9px→10.5px, `.dbc-v182-toolbar label` və eyybrow mətni 8px→9px. Sətir hündürlükləri uyğun artırıldı ki, cədvəlin sabit-en düzülüşü pozulmasın.
- **Qeyd:** Bu, ehtiyatlı və minimal artımdır — bu mühitdə Electron pəncərəsini vizual olaraq render edib yoxlamaq mümkün olmadığı üçün geniş tipoqrafiya islahatından (bütün 8-10px mətnlərin ümumi böyüdülməsi) çəkindim ki, sıx düzülmüş sabit-ölçülü cədvəl sınmasın. Real mühitdə vizual QA tövsiyə olunur.

## Bilərəkdən edilməyənlər
- **VÖEN nəzarət-rəqəmi:** Azərbaycan VÖEN-i üçün ictimai, sənədləşdirilmiş nəzarət-rəqəmi alqoritmi tapılmadı; mövcud olmayan/səhv alqoritmlə düzgün VÖEN-ləri rədd etmək riski daha zərərli olardı, ona görə mövcud 10-rəqəm formatı yoxlaması olduğu kimi saxlanıldı.
- **3 CSS faylının (`styles-v180/181/182.css`) birləşdirilməsi:** Vizual test imkanı olmadan bu refaktorinq riskli hesab edildi və edilmədi.

## Doğrulama
```
npm install   # xlsx alias-ının işlədiyini təsdiqləyir
npm test      # bütün 20 test faylı, o cümlədən 2 yeni: fx-reconciliation-test.js, user-management-test.js
```
Bütün testlər yaşıl keçir.
