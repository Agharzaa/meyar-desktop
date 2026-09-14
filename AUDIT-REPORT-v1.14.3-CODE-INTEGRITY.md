# MEYAR ERP Desktop v1.14.3 — kod və uçot bütövlüyü auditi

## Nəticə

v1.14.2 bazası üzərində uçot nüvəsi, qaimə və bank idxalı, artımlı
sinxronizasiya, anbar hesablarının seçilməsi, DBC analitikası, SQLite
tranzaksiyaları, IPC səlahiyyətləri və giriş sessiyasının xəta davranışı
yenidən yoxlanılıb. Aşağıdakı konkret qüsurlar v1.14.3-də aradan qaldırılıb.

## Düzəldilən uçot və məlumat qüsurları

1. Bir neçə `INVENTORY` rollu hesab olduqda ilk kodun (`201.01`) təsadüfi
   seçilməsi dayandırılıb. Gələn mal qaiməsi seçilmiş/default anbarın
   `inventory_account_code` dəyəri ilə post edilir.
2. Proqram açılarkən bütün mal kartlarının alış/ehtiyat hesabını məcburi
   `205.01` edən geniş `UPDATE` çıxarılıb. Yalnız boş legacy sahələr default
   dəyərlə tamamlanır; istifadəçinin `205.02`, `201.01` və ya digər aktiv
   INVENTORY hesabı saxlanılır.
3. Qaimə idxalında çatışmayan və ya mövcud olmayan tarixə cari günü səssiz
   yazmaq ləğv edilib. Yanlış sətir rədd edilir və mənbə sətir nömrəsi ilə
   `import_rejections` jurnalına düşür.
4. Manual qaimə, müqavilə, bank, uçotun açılış/bağlanış tarixi və DBC filtrində
   yalnız format deyil, real təqvim günü yoxlanılır.
5. Eyni hesab–kontragent–subkonto açılış sətrində Debet və Kredit ayrı-ayrılıqda
   yığılmır; xalis saldo bir tərəfdə saxlanılır.
6. DBC analitik jurnalında başqa hesaba aid subkonto qəbul edilmir.

## Düzəldilən bank və sinxronizasiya qüsurları

1. Bankın xarici tranzaksiya ID-si olmadıqda fingerprint-ə son qalıq da əlavə
   edilir. Eyni gün, məbləğ və təyinatlı, lakin fərqli son qalıqlı iki real
   əməliyyat artıq biri-birini silmir.
2. Cədvəlin texniki `id` sahəsi bankın external ID-si sayılmır. Yalnız
   `external_id`, `transaction_id` və `bank_transaction_id` etibarlı identifikator
   kimi qəbul edilir.
3. Eyni qaimənin bir bank bölgüsünə iki dəfə salınması əməliyyat başlamazdan
   əvvəl bloklanır; yarımçıq payment/journal yazılışı yaranmır.
4. Bank uyğunlaşdırması storno ediləndən sonra superseded və reversal sətirləri
   aktiv ödəniş cəminə daxil edilmir. DBC xalis qalığı və ödəniş göstəricisi
   eyni mənanı verir.
5. Qarışıq Gələn/Gedən faylın sinxronizasiya audit sayları istiqamətlər üzrə
   ayrıca hesablanır; eyni ümumi nəticə iki istiqamətə təkrar yazılmır.

## Davamlılıq və təhlükəsizlik

- SQLite master və şirkət bazalarında `busy_timeout=5000` tətbiq edilib.
- Şirkət bazasının açılması yarıda xətalanarsa köhnə/yarımçıq sessiya aktiv
  saxlanılmır.
- `viewer` rolu üçün server tərəfli read-only IPC sərhədi əlavə edilib.
- İdxal faylı adi fayl olmalı və 100 MB limitini keçməməlidir.
- Uçot qaydasının mövcud olmayan ID ilə redaktəsi səssiz uğur kimi qaytarılmır;
  dəyişikliklər audit jurnalına yazılır.

## Regresiya yoxlaması

Yeni `tests/code-integrity-v1143-test.js` aşağıdakı ssenariləri real müvəqqəti
SQLite bazasında yoxlayır:

- yanlış tarix üçün tam rollback;
- idxal rəddinin düzgün sətir nömrəsi;
- gələn malın anbar hesabı və stock movement-i;
- fərdi mal hesabının restart sonrası qorunması;
- bankda false-positive və true-positive dublikat halları;
- bank bölgüsünün atomikliyi və storno hesabatlaması;
- açılış qalığının xalisləşdirilməsi;
- DBC subkonto–hesab sərhədi;
- böyük idxal faylının qoruyucu limiti;
- yekun SQLite/jurnal/anbar bütövlüyü.

Tam `npm test` zənciri sintaksis, renderer, IPC müqaviləsi, şirkət izolyasiyası,
parolsuz əsas giriş, istifadəçi rolları, DVX istiqaməti, XLSX/CSV idxalı,
idempotent yeniləmə, valyuta, DBC, subkonto, anbar FIFO/orta maya və yeni kod
bütövlüyü testləri ilə birlikdə uğurla tamamlanıb.

## Xarici sərhəd

Lokal nüvə və idxal testlərlə yoxlanılıb. Dövlət Vergi Xidmətinin canlı
portalının gələcək HTML/login dəyişiklikləri və real bank API-si bu lokal test
mühitinin nəzarətindən kənardır; həmin inteqrasiyalar üçün ayrıca real mühit
qəbul testi tələb olunur.
