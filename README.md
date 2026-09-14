# MEYAR ERP Desktop — v1.17.0 Installed Windows Application

## v1.17.0 quraşdırma və avtomatik yeniləmə

- `MEYAR-ERP-Setup-1.17.0.exe` Windows x64-də proqramı Start menyusuna və masaüstünə quraşdırır.
- Quraşdırılmış proqram yeni versiyanı avtomatik yoxlayır, arxa planda endirir və çıxış zamanı tətbiq edir.
- Yenilənmədən əvvəl açıq SQLite bazalarında WAL checkpoint icra olunur və bütün şirkət bazaları ayrıca ehtiyatlanır.
- Ehtiyat faylları SHA-256 ilə doğrulanır; backup uğursuzdursa update quraşdırılmır.
- Məlumat bazası tətbiqdən ayrı `userData/data` qovluğundadır və update/uninstall zamanı silinmir.
- GitHub Windows build-i yalnız bütün regresiya testləri keçəndən sonra installer və update metadata yaradır.

Developer rejimi:

```cmd
npm.cmd ci
npm.cmd start
```

## v1.15.0 aylıq ƏDV əvəzləşməsi

- Gələn qaimənin giriş ƏDV-si qaimənin mövcudluğu ilə avtomatik tanınmır:
  əsas məbləğin faktiki bank ödənişi və ƏDV depozit/gömrük ödənişi ayrı
  yoxlanılır, əvəzləşmə yalnız hər iki həddin minimumu qədər hesablanır.
- Gedən qaimənin çıxış ƏDV-si faktiki ödəniş allocation-u üzrə aylara bölünür.
  Qismən ödənişdə yalnız proporsional ƏDV cari aya düşür.
- ƏDV depozit ödənişləri adi qaimə ödənişlərindən ayrıca registrdə saxlanılır.
  Bank əməliyyatı və qaimə üzrə limit, istiqamət, AZN valyutası və duplicate
  nəzarəti server tərəfində tətbiq olunur.
- ƏDV depozit/gömrük ödənişi `Debet 531.01 / Kredit 223.01`, aylıq
  əvəzləşmə isə `Debet 521.01 / Kredit 241.01` müxabirləşməsi ilə yaradılır;
  qaimənin ödənilmiş qalığı əsas ödəniş və ƏDV ödənişini birlikdə göstərir.
- **Yenilə** qaimə nömrəsi və ya unikal VÖEN sübutu olan depozit ödənişlərini
  yalnız seçilmiş ay daxilində təhlükəsiz bağlayır; qeyri-müəyyən əməliyyatları
  və başqa ayın bank sətrlərini avtomatik seçmir.
- Standart, əvəzləşdirilməyən alış, gömrük ƏDV-si, ƏDV-dən azad və 0% rejimləri
  qaimə üzrə ayrıca idarə olunur.
- Aylıq xülasə əvvəlki qalıq, giriş ƏDV, çıxış ƏDV, istifadə edilən əvəzləşmə,
  büdcəyə ödəniləcək məbləğ və növbəti aya qalığı göstərir.
- Ay bağlananda dəyişməz JSON snapshot saxlanılır. Bağlı aya təsir edən qaimə,
  bank storno-su, depozit bağlantısı və düzəliş bloklanır; yenidən açılma səbəbi
  audit izinə yazılır.
- Əvvəlki aktiv ay bağlanmadan sonrakı ayın bağlanması bloklanır. Registr 200
  sətirlik səhifələrlə işləyir və tam məlumatı UTF-8 CSV-yə ixrac edir.
- Əl düzəlişi səbəb və istifadəçi ilə yanaşı seçilmiş qarşı hesab üzrə balanslı
  müxabirləşmə yaradır; silinmə fiziki uçot itkisi deyil, storno ilə aparılır.
- `vatIntegrityReport` bank bölgüsü, qaimə limiti, yanlış əlaqələr, çatışmayan
  müxabirləşmələr və zədələnmiş bağlanış snapshot-larını ayrıca yoxlayır.

## v1.14.3 kod bütövlüyü nəticəsi

v1.14.3 qaiməni sadəcə reyestrdə saxlamır: daxil edilən hər sənəd vahid
əməliyyatla müxabirləşir, mal hərəkəti anbara yazılır, xidmət isə seçilmiş
subkonto üzrə xərc/gəlir hesabına düşür. Qaimə redaktə ediləndə əvvəlki jurnal
və anbar təsiri təhlükəsiz şəkildə geri qurulur və yeni qaydalarla yenidən
hesablanır.

- Gələn mal qaiməsinin avtomatik hesabı artıq təsadüfi `INVENTORY` hesabından
  deyil, seçilmiş/default anbarın ehtiyat hesabından götürülür.
- Məlumat kitabçasında seçilmiş mal hesabı proqram yenidən açıldıqda `205.01`-ə
  qaytarılmır; istifadəçinin uçot seçimi dəyişməz saxlanılır.
- Qaimə, bank, müqavilə, uçot dövrü və DBC tarixləri real təqvim tarixi kimi
  yoxlanılır; mövcud olmayan tarix bazaya buraxılmır.
- Bank fingerprint-i son qalıq məlumatını da nəzərə alır. Eyni tarix/məbləğli,
  lakin fərqli qalıqlı iki real əməliyyat yanlış dublikat sayılmır.
- Storno edilmiş bank uyğunlaşdırması aktiv ödəniş cəminə daxil edilmir.
- Açılış qalığında eyni hesab/analitika üzrə qarşılıqlı Debet və Kredit xalis
  bir tərəfli qalığa çevrilir.
- Baxış (`viewer`) rolu reyestr və hesabatları oxuyur, lakin məlumatı dəyişən
  IPC əməliyyatları server tərəfində bloklanır.
- İdxal xəta jurnalında həqiqi mənbə sətir nömrəsi saxlanılır; 100 MB-dan böyük
  fayl nəzarətsiz şəkildə yaddaşa alınmır.

## v1.14.2 əsas nəticə

- Qaimə sinxronizasiyası append-only işləyir: `qaimə nömrəsi + VÖEN + istiqamət`
  bazada varsa sənədə, jurnala, anbara və ödəniş bölgüsünə toxunulmur.
- Bank əməliyyatı bankın xarici ID-si, bu olmadıqda isə stabil tranzaksiya
  fingerprint-i ilə yoxlanır; mövcud ödəniş ikinci dəfə işlənmir.
- İlk Excel/CSV/JSON mənbəyi istiqamət və ya bank hesabı üzrə yadda saxlanılır.
  Sonrakı **Yenilə** həmin mənbədən yalnız yeni sətirləri əlavə edir.
- DVX canlı pəncərəsi açıq olduqda qaimə reyestrində **Yenilə** aktiv qovluğu
  oxuyur; canlı idxaldan sonra əsas reyestr avtomatik yenilənir.
- Hər sinxronizasiya nəticəsi ayrıca audit jurnalında yeni, keçilmiş və xətalı
  sətir sayları ilə saxlanılır.

## v1.14.1 interfeys nəticəsi

- Müvəqqəti olaraq parol yoxlaması ləğv edilib: şirkət bazası seçilir və sistem birbaşa açılır.
- Köhnə qaimədə mənfi anbar qalığı varsa baza açılışı bloklanmır; çatışmazlıq qaimədə yoxlama xəbərdarlığı kimi saxlanılır.
- Jurnal və anbar hərəkətləri birlikdə yoxlanılır; itmiş, artıq və ya dəyəri uyğun gəlməyən mal hərəkətləri baza açılarkən təhlükəsiz şəkildə yenidən qurulur.
- Qaimə iş pəncərəsində köhnə böyük əməliyyat paneli çıxarılıb; filtr və əsas əməliyyatlar incə zolaqdadır, ekranın əsas hissəsi reyestrə ayrılıb.
- Qaimə sətri başlıqları məlumat sütunları ilə tam uyğunlaşdırılıb; hesab seçimi kod və adla, subkonto isə yalnız seçilmiş hesabın daxilindən təqdim olunur.
- Əsas səhifədə yalnız son 5 çıxan bank ödənişinin kontragent və məbləği göstərilir; qaimə siyahısı əsas səhifədən ayrıdır.
- Təkrarlanan daxili başlıq və qlobal axtarış sətri çıxarılıb; yalnız bir üfüqi modul paneli və cari səhifənin öz idarəetmə sətri saxlanılıb.
- Qaimə əməliyyat xanasının cədvəl quruluşunu pozması aradan qaldırılıb, bütün 10 sütun faizlə tam ekran eninə bölünüb.
- Məlumat kitabçasındakı hər cədvəl üçün ayrıca 100%-lik sütun sxemi verilib; son sütun artıq ekranın boş hissəsini udmur.
- Az məlumat olan reyestr bütün ekran boyu boş çərçivə çəkmir; sətrlər bitəndə panel də məzmun ölçüsündə tamamlanır.

- Hər gələn və gedən qaimə saxlanılan/idxal edilən anda avtomatik müxabirləşir; gözləmə mərhələsi yoxdur.
- Mal və xidmət sətirləri ayrı uçot qaydaları ilə işləyir. Mallarda anbar və FIFO/orta maya məcburidir.
- 721 qrupdur, 721.01 yazılış hesabıdır; nəqliyyat, rabitə, yemək və digər xərc maddələri 721.01 daxilində subkonto kimi saxlanılır.
- Sənəd dəyişdikdə əvvəlki yazılış storno olunur və yeni yazılış atomik yaradılır; audit izi silinmir.
- DBC hesab → subkonto/kontragent/mal → sənəd səviyyəsində açılır; açılış qalıqları analitika üzrə daxil edilir.
- Valyuta, ƏDV, çoxsətirli yuvarlaqlaşdırma və anbar maya dəyəri üçün balans nəzarəti tətbiq olunur.
- Qaimə, bank və DBC pəncərələri proqram daxilində ayrıca aşağı tablarda açılır; kompakt filtr və cədvəl əsaslı görünüş istifadə olunur.

## DBC və uçot görünüşü

- Ümumi hesablar və seçilmiş hesab üzrə iki səviyyəli dövriyyə-balans hesabatı.
- Dövrün əvvəli, dövr ərzində dövriyyə və dövrün sonu üçün ayrıca Debet/Kredit sütunları.
- 211/531 hesablarında kontragent sətrinin `+` ilə qaimə və ödəniş hərəkətlərinə açılması.
- 205 hesabında mal–anbar analitikası, digər hesablarda subkonto analitikası.
- Kompakt filtr zolağı, sabit başlıq/yekun sətri və Meyar ağ–yaşıl rəng sistemi.

## v1.8.1 sabitləşdirmələri

- Gələn qaimələr, gedən qaimələr, daxil olan ödənişlər və çıxan ödənişlər
  proqram daxilində bir-birindən ayrı, bağlana bilən aşağı iş tablarında açılır.
- Qaimə və bank pəncərələrində idarəetmə sahəsi incə zolağa yığılıb; əsas ekran
  sahəsi cədvələ ayrılıb.
- Bütün reyestr, DBC, analitika, bank və məlumat kitabçası cədvəlləri ayrıca
  sabit sütun sxeminə keçirilib. Uzun mətn qonşu sütuna keçmir, ellipsis və
  tooltip ilə göstərilir.
- DVX kartının bütün mətninin kontragent adına düşməsi bloklanıb. Mövcud
  çirklənmiş kontragent adları baza açılarkən qaimələrlə birlikdə təmizlənir.
- Bank daxilolma və ödəniş sorğuları həm interfeysdə, həm də baza sorğusunda
  ayrıca istiqamət filtri ilə ayrılır.

## v1.8.0 uçot yenilikləri

- Gələn və Gedən qaimələrdə mal/xidmət təsnifatı; naməlum sətir təhlükəsiz
  olaraq “Xidmət” sayılır və Azercell kimi xidmət qaimələri 205 hesaba səhvən
  düşmür.
- Təsdiqlənən qaimə avtomatik olaraq Journal və Dövriyyə-Balansda görünür;
  “Gözləyir” statusunda ilişib qalma yoxdur.
- 205 mal uçotu üçün anbar seçimi və anbar üzrə FIFO və ya orta maya üsulu.
  Satış zamanı maya avtomatik 701.01 Debet / 205.01 Kredit yazılır.
- Kontragent, müqavilə, hesablar planı, subkonto, anbar, mal/xidmət kataloqu
  və avtomatik uçot qaydaları üçün ayrıca “Məlumat kitabçaları” iş sahəsi.
- Qaimə kartında müqavilə, subkonto, anbar və uçot hesabı seçimi; hesab və
  subkonto dəyişiklikləri jurnal analitikasında da eyni tranzaksiyada əks olunur.
- DBC hesab sətrinə kliklə 211.01 debitor, 531.01 kreditor, 205 anbar/mal və
  digər hesablar üzrə tarix aralığı analitikası.
- Əsas səhifə artıq qaimə cədvəli göstərmir: ümumi göstəricilər, bank üzrə son
  5 əməliyyat və sistem bildirişləri göstərilir. Qaimə siyahısı ayrıca aşağı
  iş tabında açılır.
- Ağ–açıq yaşıl desktop görünüş, kompakt filtr, sabit başlıq, zebra cədvəl,
  seçilən sətir, rəng kodlu hesab çipləri və 900px-dən geniş ekranlara uyğun
  responsiv düzülüş.

## Uçot nəzarəti

Hər qaimə və bank allocation-u Debet/Kredit balans yoxlamasından keçir. Hesab,
subkonto, müqavilə və anbar əlaqələri etibarsızdırsa əməliyyat geri alınır;
yarımçıq jurnal və yarımçıq mal qalığı saxlanılmır. Mövcud bazalar schema 211
miqrasiyası ilə qorunur və əvvəlki uçotsuz qaimələr avtomatik post edilir.

---

Bu buraxılış DVX istiqamət təsnifatını sübut əsaslı edir, mövcud idxalları
sinxronizasiya zamanı dəyişməz saxlayır və bütün aktiv ekranları vahid desktop dizayn
sisteminə keçirir.

## v1.7.0

- XLSX/CSV faylının cədvəldən əvvəlki DVX başlığı saxlanılır və real başlıq
  sətri avtomatik tapılır.
- İstiqamət sətir məlumatı → DVX başlığı → vərəq adı → fayl adı ardıcıllığı ilə
  yoxlanır; ziddiyyətli və sübutsuz faylda istifadəçi təsdiqi tələb olunur.
- Açıq “Gələn” və ya “Gedən” ekranı artıq faylın istiqamət mənbəyi deyil.
- Yenidən idxal mövcud sənədin istiqamətini və uçotunu avtomatik dəyişmir;
  düzgün istiqamətdə olmayan köhnə sənəd ayrıca audit və istifadəçi qərarı ilə
  düzəldilir.
- İstiqamət sübutu və etibarlılıq səviyyəsi SQLite bazasında audit izi kimi
  saxlanılır; köhnə sübutsuz idxallar reyestrdə xəbərdarlıqla göstərilir.
- Qızılı/boz, sıx interfeys əvəzinə vahid lacivərt–mavi desktop dizayn sistemi,
  12–13 px əsas mətn, 36 px idarəetmələr və aydın fokus vəziyyətləri tətbiq
  edilib.
- Təkrarlanan üç böyük idxal kartı gizlədilib, əməliyyat paneli sadələşdirilib,
  qaimə reyestri 14 sütundan 10 məntiqli sütuna yığılıb və sticky başlıqla
  qalan ekran hündürlüyünü tutur.
- Bank, DVX, Dashboard, autentifikasiya, DBC və modal pəncərələr eyni rəng,
  radius, sərhəd, boşluq və tipoqrafiya sisteminə uyğunlaşdırılıb.

## v1.6.0

- Qaimə biznes açarı `Qaimə № + VÖEN + İstiqamət` qaydasına keçirildi;
  Gələn/Gedən eyni sənəd nömrəsi bir-birini bloklamır.
- Köhnə SQLite UNIQUE məhdudiyyəti təhlükəsiz miqrasiya olunur və miqrasiyadan
  əvvəl yalnız bir dəfə backup yaradılır.
- Qaimə və bank Journal qeydlərində çatışmayan `source_id` düzəldildi.
- DBC əvvəlki dövr dövriyyəsini başlanğıc saldoya daxil edir, 211/531 analitikası
  isə uçota alınmış sənəd və faktiki ödəniş allocation-u üzrə hesablanır.
- Bank hesabı INSERT ardıcıllığı, IBAN/valyuta yoxlaması, Kredit–Mədaxil və
  Debet–Məxaric istiqamət tanınması düzəldildi.
- Fayldan qaimə və bank çıxarışı idxalı, DVX statusu və daxili audit üçün
  XML/ZIP arxiv paketi hazırlama funksiyaları tamamlandı. Rəsmi elektron imzalı
  DVX göndərişi portalda aparılır.
- Dashboard və Kömək bölməsi əlavə edildi; şrift ölçüləri, fokus, kontrast,
  responsivlik, cədvəl daşması və çoxvalyutalı məbləğ göstərimi yeniləndi.
- Xarici valyutalı sənəd məzənnə modulu olmadan AZN DBC-yə buraxılmır.

## Əvvəlki stabillik düzəlişləri

Bu buraxılış E-Qaimə reyestrinin boş görünməsi, pəncərələrin təkrarlanması və DVX import istiqamətinin səhv seçilməsi ilə bağlı stabilləşdirmələri ehtiva edir.

## Əsas düzəlişlər
- Gələn və Göndərilən E-Qaimələr eyni SQLite bazası ilə, ayrı pəncərələrdə işləyir.
- Əsas Gələn pəncərəsi ikinci dəfə açılmır; mövcud pəncərə fokuslanır.
- E-Qaimə reyestri daha təhlükəsiz render olunur; bir UI xətası bütün cədvəli boşaltmır.
- SQLite `invoice:list` nəticələri JSON-safe qaytarılır.
- `invoice:stats` ağır reyestr sorğusundan ayrılıb.
- DVX XLSX istiqaməti faylın məzmunu/adı ilə müəyyən edilir; UI pəncərəsi faylı səhv istiqamətə məcbur etmir.
- Qaimə seriyası + nömrəsi tam saxlanılır (məsələn `MT2605 10030954`).
- İlk açılış və migration xətaları ayrıca göstərilir.
- Migration-dan əvvəl DB backup yaradılır.
- Kompakt, fixed-column E-Qaimə cədvəli istifadə olunur.
- Mövcud E-Qaimə → Journal → Dövriyyə-Balans arxitekturası qorunur.

## Açılış
Bu qovluqda `Meyar ERP - Ac.cmd` faylına iki dəfə klik edin. İlk dəfə Node.js varsa, paketlər avtomatik quraşdırılır.

Alternativ:
```cmd
npm.cmd install
npm.cmd start
```

## v1.5.4 — Bank / PASHA Bank OpenBanking

Bank modulu daxili ERP bölməsi kimi əlavə edilib. Real API çağırışları hazırda qəsdən deaktivdir və bank təsdiqi alınana qədər heç bir xarici serverə credential/request göndərilmir.

Hazır funksiyalar:
- Bank hesablarının ayrıca şirkət bazasında saxlanması
- Bank hesabının 223.01 mühasibat hesabına bağlanması
- Bank çıxarışının XLSX/CSV/TXT/JSON idxalı
- Xarici əməliyyat ID-si ilə duplicate qorunması
- Daxilolma / ödəniş istiqaməti
- Qaimə üzrə uyğunlaşdırma təklifləri
- 211.01 / 531.01 analitik uçota bağlanma
- Ödəniş allocation-u
- Bank əməliyyatından mühasibat jurnalının yaradılması
- PASHA Bank OpenBanking provider/config üçün ayrıca inteqrasiya statusu

API canlı bağlantısı yalnız bank tərəfindən giriş təsdiqləndikdən sonra ayrıca adapter qatında aktivləşdirilməlidir.

## v1.5.6 — Company isolation & invoice business keys

- Every company has its own SQLite database under `data/companies/company-N/company.sqlite`.
- Login is company-scoped: the login screen first selects the company database, then validates that company's username/password.
- The same username may exist in different companies with different passwords/roles; credentials are not shared between company databases.
- New company creation creates a fresh database and a separate administrator account.
- Invoice identity is business-based: `document_key = INVOICE_NO + COUNTERPARTY_VOEN + DIRECTION` within a company. The visible primary document identifier is always the invoice number; internal numeric IDs are not used as the business identifier.
- Duplicate invoice number for the same counterparty/VÖEN and direction is rejected on manual entry and import.
- Existing company data remains physically separated; switching companies closes the active company DB before opening the selected company DB.
- WAL mode and indexed invoice/company access are retained for large datasets and reduced UI blocking.


### Canlı DVX istiqamətinin avtomatik tanınması
Canlı DVX idxalı istifadəçinin əvvəlcə “Gələn” və ya “Gedən” düyməsinə basmasına kor-koranə güvənmir. Portalın aktiv qovluğu/səhifə başlığı/body mətnində “Gələnlər / Daxil olan” və “Göndərilənlər / Göndərdiklərim” siqnallarını yoxlayır; URL route siqnalları və son olaraq açılış istiqaməti fallback kimi istifadə olunur. Eyni qaimə nömrəsi + VÖEN “Gələn” və “Gedən”də ayrıca sənəd kimi saxlanılır.

## v1.5.7 — DVX canlı idxal və sabitlik auditi
- DVX canlı qaimə siyahısında kart/list/table/grid çıxarışı və avtomatik Gələn/Gedən istiqamət tanınması gücləndirildi.
- Gələn və Göndərilən bölmələri eyni DVX pəncərəsində saxlanılır; SPA naviqasiyasından sonra canlı düymələr MutationObserver ilə yenidən qurulur.
- Canlı importda ƏDV-li yekun məbləğdən ƏDV-siz baza məbləğinin səhv götürülməsi düzəldildi.
- Bank API preload körpüsü, import məbləğlərinin AZN formatında oxunması və uçota alma üçün təhlükəsiz hesab fallback-ları düzəldildi.
- Renderer/preload IPC müqaviləsi və canlı kart məlumatı üçün regression testləri əlavə edildi.
