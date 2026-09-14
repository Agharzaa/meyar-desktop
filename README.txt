# MEYAR ERP Desktop — v1.16.0 Installed Windows Application

## Açılış

Windows-da `MEYAR-ERP-Setup-1.16.0.exe` faylını bir dəfə işə salın. Quraşdırıcı
Meyar ERP-ni Start menyusuna və masaüstünə əlavə edir. Sonrakı buraxılışlar
proqram daxilində yoxlanılır, təhlükəsiz endirilir və proqramdan çıxarkən tətbiq
olunur.

Mənbə kodundan yalnız developer rejimində işə salmaq üçün:

```cmd
npm.cmd install
npm.cmd start
```

## v1.16.0 quraşdırma və təhlükəsiz yeniləmə

- Windows x64 üçün normal NSIS `Setup.exe`; ZIP və `.cmd` istifadəçi axını deyil.
- Yeniləmə 12 saniyə sonra və hər 6 saatdan bir yoxlanılır; proqramın işinə mane olmur.
- Yeni versiya endiriləndə bütün aktiv şirkət SQLite bazaları əvvəlcə WAL checkpoint-dən keçirilir.
- Hər baza ayrıca SHA-256 ilə yoxlanılan `update-backups` ehtiyatına köçürülür.
- Ehtiyat alınmasa yeniləmə tətbiq edilmir; uğurlu olduqda çıxış/restart zamanı quraşdırılır.
- Şirkət bazaları proqram qovluğundan kənarda, Electron `userData/data` daxilində qalır.
- Avtomatik build əvvəlcə tam regresiya testini işlədir; test uğursuzdursa release yaranmır.
- Production dependency auditində yüksək səviyyəli məlum zəiflik yoxdur.

## v1.15.0 aylıq ƏDV əvəzləşməsi

- Giriş ƏDV-si əsas ödəniş və ayrıca ƏDV depozit/gömrük ödənişi ilə yoxlanılır.
- Çıxış ƏDV-si satış qaiməsinin faktiki ödəniş allocation-u üzrə aylıq hesablanır.
- Bank əməliyyatı və qaimə üzrə artıq bölgü, yanlış istiqamət/valyuta və duplicate bloklanır.
- ƏDV ödənişi 531.01/223.01, aylıq əvəzləşmə 521.01/241.01 müxabirləşməsi yaradır.
- Yenilə yalnız seçilmiş ayda unikal qaimə nömrəsi və ya VÖEN sübutu olan depoziti avtomatik bağlayır.
- Standart, əvəzləşdirilməyən, gömrük, azad və 0% ƏDV rejimləri ayrıca saxlanılır.
- Əvvəlki qalıq, cari giriş/çıxış, əvəzləşmə, ödəniləcək ƏDV və növbəti aya qalıq hesablanır.
- Bağlı ay dəyişməz snapshot-dır; geriyə dəyişiklik bloklanır və yenidən açılma audit olunur.
- Əl düzəlişi seçilən qarşı hesabla balanslı jurnal yaradır, silinməsi storno ilə aparılır.
- Böyük registr 200 sətirlik səhifələrə bölünür və UTF-8 CSV-yə ixrac olunur.

## v1.14.3 kod bütövlüyü düzəlişləri

- Gələn mal qaiməsi seçilmiş/default anbarın ehtiyat hesabına avtomatik post olunur.
- İstifadəçinin mal hesabı seçimi proqram açılışında dəyişdirilmir.
- Yanlış təqvim tarixləri qaimə, bank, müqavilə və DBC-yə buraxılmır.
- Bank dublikat nəzarəti son qalığı da nəzərə alır; storno edilmiş ödəniş aktiv sayılmır.
- İdxal xətaları düzgün mənbə sətir nömrəsi ilə saxlanılır.
- Viewer rolu məlumat dəyişdirə bilmir; SQLite gözləmə və fayl ölçüsü limitləri tətbiq olunur.

## v1.14.2 artımlı sinxronizasiya düzəlişləri

- Bazadakı qaimə və bank əməliyyatı sinxronizasiya zamanı ikinci dəfə işlənmir.
- Yenilə düyməsi yadda saxlanmış fayl və ya açıq DVX canlı mənbəyindən yalnız
  yeni sənədləri gətirir.
- Mövcud qaimənin uçot, jurnal, anbar və ödəniş məlumatları dəyişdirilmir.
- Sinxronizasiya tarixçəsi yeni, keçilmiş və xətalı sətir sayları ilə saxlanılır.

## v1.14.1 interfeys düzəlişləri

- Daxil edilən qaimə dərhal avtomatik Journal və Dövriyyə-Balansa alınır; xidmət
  qaimələri mal hesabına düşmür.
- Mal/xidmət sətirləri, subkontolar, müqavilələr və anbarlar ayrıca məlumat
  kitabçalarında idarə olunur.
- 205 mal uçotunda anbar üzrə FIFO və orta maya; satış maya müxabirləşməsi
  avtomatik yaradılır.
- Qaimə kartında müqavilə, hesab, subkonto və anbar dəyişiklikləri atomik
  şəkildə yenidən müxabirləşdirilir.
- Əsas səhifədə bank üzrə son 5 ödəniş və bildirişlər; qaimələr aşağı iş
  tabında ayrıca açılır.
- DBC hesab sətirlərinə kliklə 211/531/205 və subkonto analitikası.
- Cədvəllər zebra formatında, seçilə bilən sətirlərlə və responsivdir.
- Jurnal–anbar bütövlüyü ayrıca yoxlanılır və qırılmış mal hərəkətləri avtomatik bərpa olunur.
- Qaimə filtr zolağı incəldilib, köhnə əməliyyat paneli çıxarılıb və hesab/subkonto seçimi kod–ad əlaqəsi ilə qorunub.
- Təkrarlanan yuxarı başlıq və axtarış sətri silinib; qaimə və məlumat kitabçası sütunları bütün ekran üzrə deterministik ölçüləndirilib.
- Qısa siyahılarda yaranan böyük boş çərçivə və cədvəl əməliyyat sütununun sürüşməsi aradan qaldırılıb.

## v1.7.0 əsas düzəlişləri

- DVX XLSX faylının cədvəldən əvvəlki başlığı ayrıca oxunur; “Göndərilən
  qaimələrin siyahısı” artıq itmir.
- İstiqamət sətir sütunu, DVX başlığı, Excel vərəqi və fayl adı üzrə yoxlanır.
  Mənbələr ziddiyyətli və ya sübutsuz olduqda sistem səssiz “Gələn” seçmir,
  istifadəçidən təsdiq alır.
- Yenidən idxal mövcud sənədin istiqamətini avtomatik dəyişmir; eyni nömrə və
  VÖEN-in Gələn/Gedən istiqamətləri ayrı biznes sənədləri kimi qorunur.
- İstiqamətin mənbəyi və etibarlılıq səviyyəsi bazada audit üçün saxlanılır.
- İnterfeys başdan qurulub: təkrarlanan əməliyyat kartları çıxarılıb, vahid
  rəng/şrift/ölçü sistemi tətbiq edilib, reyestr 14-dən 10 oxunaqlı sütuna
  yığılıb və ekranın qalan hündürlüyünü istifadə edir.

## v1.6.0-dan qorunan düzəlişlər

- Gələn və Gedən qaimələr `Qaimə № + VÖEN + İstiqamət` biznes açarı ilə
  ayrı saxlanılır.
- Köhnə, daha məhdud SQLite UNIQUE qaydası məlumat itirmədən miqrasiya olunur.
- Uçota alma zamanı Journal `source_id` və Debet/Kredit balans nəzarəti
  düzəldilib.
- DBC seçilmiş tarixdən əvvəlki hərəkətləri başlanğıc saldoya daşıyır.
- 211.01 və 531.01 kontragent analitikası yalnız uçota alınmış qaimə və
  faktiki allocation-lar əsasında işləyir.
- Bank hesabı sütun ardıcıllığı, IBAN yoxlaması, Kredit/Mədaxil və
  Debet/Məxaric istiqamətləri düzəldilib.
- XLSX/CSV/TSV/XML/JSON/TXT qaimə idxalı və bank çıxarışı idxalı işləkdir.
- DVX statusu, canlı portal və daxili audit üçün XML/ZIP arxiv paketi əlavə
  edilib. Rəsmi elektron imzalı göndəriş DVX portalında tamamlanır.
- Dashboard, Kömək ekranı, çoxvalyutalı məbləğ göstərimi, fokus vəziyyətləri,
  oxunaqlı şriftlər və responsiv görünüş yenilənib.

## Məlumat təhlükəsizliyi

Hər şirkət ayrıca SQLite bazasında saxlanılır. v1.7.0-dan əvvəlki baza ilk
miqrasiya zamanı avtomatik ehtiyat nüsxələnir. DBC hazırda yalnız AZN uçotudur;
xarici valyutalı sənəd məzənnə modulu olmadan uçota alınmır.

## Test

```cmd
npm.cmd test
```
