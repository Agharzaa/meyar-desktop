# Meyar ERP v1.7.0 — Texniki və UI/UX audit hesabatı

## Nəticə

Layihə kodu backend, SQLite sxemi, IPC/preload müqaviləsi, renderer və aktiv
ekranlar üzrə audit edildi. Tapılan bloklayıcı xətalar düzəldildi və yeni
regresiya testləri ilə qorundu.

## v1.7 kritik düzəlişi — Gələn/Gedən təsnifatı

Əvvəlki idxal funksiyası Excel-in ilk real cədvəl sətrindən məlumat götürürdü,
amma ondan yuxarıdakı DVX başlığını saxlamırdı. Neytral adlı faylda sətirlərin
öz istiqamət sütunu olmadıqda açıq UI bölməsi fallback olur və gedən qaimələr
“Gələn”ə düşə bilirdi.

Yeni axın:

1. XLSX/CSV matrisini başlıqdan əvvəlki sətirlərlə birlikdə oxuyur.
2. `VÖEN + Qaimə nömrəsi` siqnalları ilə real cədvəl başlığını tapır.
3. Sətir istiqaməti, DVX sənəd başlığı, vərəq adı və fayl adını ayrıca sübut
   kimi qiymətləndirir.
4. Ziddiyyət və ya sübut yoxdursa səssiz fallback etmir, istifadəçidən Gələn /
   Gedən təsdiqi alır.
5. Etibarlı yenidən idxal zamanı eyni qaimənin köhnə səhv tərəfdə olan,
   uçota alınmamış və ödənişsiz nüsxəsini dublikat yaratmadan düzgün reyestrə
   keçirir.
6. Uçota alınmış, jurnal qeydi və ya ödəniş allocation-u olan sənədə avtomatik
   toxunmur; ayrıca baxış tələb edən hal kimi saxlayır.
7. `direction_source` və `direction_confidence` sahələri ilə qərarın audit
   izini bazada saxlayır.

## Kritik funksional düzəlişlər

1. **Qaimə biznes açarı**
   - Köhnə `company_id + invoice_no + direction` UNIQUE məhdudiyyəti çıxarıldı.
   - Yeni qayda: `Qaimə № + VÖEN + İstiqamət`.
   - Eyni nömrəli Gələn/Gedən və fərqli VÖEN-li sənədlər ayrıca saxlanılır.
   - Mövcud bazalar məlumat itirmədən miqrasiya və əvvəlcədən backup olunur.

2. **Journal və DBC**
   - Qaimə və bank Journal INSERT-lərində çatışmayan `source_id` düzəldildi.
   - Hər müxabirləşmədə Debet/Kredit bərabərliyi commit-dən əvvəl yoxlanır.
   - DBC seçilən başlanğıc tarixindən əvvəlki təsdiqli hərəkətləri başlanğıc
     saldoya daşıyır.
   - 211.01/531.01 analitikası yalnız uçota alınmış qaimə və faktiki payment
     allocation-ları ilə hesablanır; əvvəlki dövr ayrıca başlanğıc saldo göstərir.

3. **Bank**
   - Yeni hesabın INSERT sütun/dəyər ardıcıllığı düzəldildi.
   - IBAN, valyuta, mühit, duplicate və hesab nömrəsi yoxlamaları əlavə edildi.
   - `Kredit/Mədaxil` daxilolma, `Debet/Məxaric` ödəniş kimi tanınır.
   - Bank hesabının valyutası ilə çıxarış valyutası yoxlanır.
   - Yalnız uçota alınmış, eyni valyutalı və uyğun istiqamətli qaimə üzləşdirilir.
   - “Bütün hesablar” filtri, hesab redaktəsi və tam bank əməliyyatı məbləğinin
     qaiməyə allocation-u düzəldildi.

4. **İdxal və DVX**
   - Qaimə üçün XLSX/XLS/CSV/TSV/XML/JSON/TXT idxalı tamamlandı.
   - Bank üçün XLSX/XLS/CSV/TSV/JSON/TXT idxalı tamamlandı.
   - DVX statusu, paket siyahısı və canlı portal funksiyalarının çatışmayan
     backend hissələri əlavə edildi.
   - Gedən qaimədən daxili audit üçün UTF-8 XML və SHA-256 manifestli ZIP arxiv
     paketi yaradılır və bütövlüyü test edilir.

5. **Manual qaimə kartı**
   - Əlavə qeyd, ƏDV-yə cəlb edilməyən məbləğ, səbəb və digər DVX sahələrinin
     backend-də itməsi düzəldildi.
   - Son tarix, valyuta, VÖEN, məbləğ və hesab yoxlamaları gücləndirildi.
   - Xarici valyutalı sənədlər valyutası ilə göstərilir; məzənnə modulu olmadan
     AZN DBC-yə yazılmır.

## UI/UX düzəlişləri

- Eyni əməliyyatı təkrarlayan böyük mənbə kartları əsas görünüşdən çıxarıldı.
- Qaimə cədvəli 14 xırda sütundan 10 məntiqli sütuna yığıldı; kontragent/VÖEN,
  yekun/ƏDV və ödənilib/qalıq məlumatları ikisəviyyəli hüceyrələrə çevrildi.
- Reyestr flex quruluş və sticky başlıqla ekranın qalan hündürlüyünü tutur.
- Sidebar 224 px, əsas idarəetmələr 36 px, mətn 12–13 px səviyyəsində
  standartlaşdırıldı; 1366×768 desktop görünüşü əsas hədəf kimi götürüldü.
- Dashboard, Bank, DVX, DBC, autentifikasiya və modal ekranları eyni lacivərt–
  mavi rəng, sərhəd, radius, kölgə və fokus sisteminə keçirildi.
- Dashboard və işlək Kömək ekranı əlavə edildi.
- Aktiv ekranlarda şriftlər, kontrast, aralıqlar, düymə ölçüləri və fokus
  vəziyyətləri oxunaqlı səviyyəyə qaldırıldı.
- Xarici font/icon CDN asılılığı çıxarıldı; sistem fontları və lokal simvollar
  istifadə olunur.
- İç-içə və səhv bağlanan `<style>` blokları düzəldildi.
- Cədvəl enlərinin bütün modullara səhv tətbiq edilməsi aradan qaldırıldı.
- Bank, DVX, Dashboard, DBC və qaimə cədvəlləri üçün ayrıca daşma qaydaları
  verildi.
- Modal pəncərələrə `role=dialog`, `aria-modal`, başlıq əlaqəsi, fokus və
  klaviatura ilə bağlama davranışı əlavə edildi.
- Axtarış sorğularında debounce və köhnə asinxron cavabın yeni nəticəni
  əvəz etməsinə qarşı request nəzarəti əlavə edildi.
- Bank/DVX düymələrinin həqiqi davranışını ifadə etməyən mətnləri düzəldildi.

## Test nəticəsi

Tam lokal test dəsti keçir:

- JavaScript sintaksisi;
- renderer sintaksisi və UI strukturu;
- preload/IPC müqaviləsi — 39 API;
- şirkət bazalarının ayrılığı və autentifikasiya UI-si;
- Gələn/Gedən və canlı DVX istiqamət regresiyaları;
- DBC və 211/531 hesablamaları;
- köhnə UNIQUE sxeminin miqrasiyası;
- bank Kredit/Debet istiqamətləri;
- XML/ZIP arxiv paketinin CRC və fayl bütövlüyü.
- DVX başlıq sətrinin aşkarlanması, zidd sübutun bloklanması və sübutsuz faylda
  məcburi təsdiq;
- köhnə səhv “Gələn” idxalının etibarlı gedən çıxarışla təhlükəsiz
  yenidən təsnifatı.

## Qəsdən aktiv edilməyən hissələr

- PASHA Bank canlı API-si bank credential və rəsmi təsdiq olmadan aktiv deyil.
- Rəsmi elektron imzalı DVX göndərişi portalda aparılır. Yaradılan XML/ZIP
  Meyar daxili audit/ötürmə arxividir və rəsmi imza faylını əvəz etmir.
- Xarici valyutanın DBC uçotu məzənnə sənədi əlavə edilənədək bloklanır.
- Kassa, Anbar və ayrıca Kontragent kartları menyuda planlaşdırılmış modul kimi
  göstərilir və saxta işlək funksiya təqdim etmir.
