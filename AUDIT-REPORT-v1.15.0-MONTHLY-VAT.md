# MEYAR ERP Desktop v1.15.0 — aylıq ƏDV əvəzləşməsi auditi

## Nəticə

Bu buraxılışda aylıq ƏDV əvəzləşməsi ayrıca uçot nüvəsi, SQLite registrləri,
IPC sərhədi və cədvəl-mərkəzli iş sahəsi kimi qurulub. ƏDV hesabı qaimənin
sadəcə bazada olmasına görə deyil, qaimə növü, faktiki əsas ödəniş, ƏDV
depozit/gömrük ödənişi, ödəniş tarixi və dövrün bağlanma vəziyyətinə görə
hesablanır.

## Mühasibat modeli

| Hadisə | Debet | Kredit | Analitika |
|---|---:|---:|---|
| Gələn xidmət qaiməsi | 721.01 + 241.01 | 531.01 | kontragent, müqavilə, xidmət subkontosu |
| Gələn mal qaiməsi | anbarın 205 hesabı + 241.01 | 531.01 | kontragent, müqavilə, anbar, mal |
| Gələn qaimənin əsas ödənişi | 531.01 | 223.01 | kontragent və bank əməliyyatı |
| ƏDV depozit/gömrük ödənişi | 531.01 | 223.01 | kontragent, qaimə və bank əməliyyatı |
| Gedən qaimə | 211.01 | gəlir hesabı + 521.01 | kontragent, müqavilə, mal/xidmət |
| Gedən qaimənin ödənişi | 223.01 | 211.01 | kontragent və bank əməliyyatı |
| Aylıq ƏDV əvəzləşməsi | 521.01 | 241.01 | ay açarı, məsələn `202608` |
| ƏDV əl düzəlişi | seçilmiş tərəfə görə 241/521 | istifadəçinin seçdiyi qarşı hesab | səbəb, istifadəçi və tarix |

Hər avtomatik yazılış yaradılmadan əvvəl hesabın aktivliyi və rolu yoxlanır.
Jurnalın Debet və Kredit cəmləri bərabər deyilsə tranzaksiya geri qaytarılır.

## Giriş ƏDV-si

Standart gələn qaimə üçün əvəzləşdirilə bilən kumulyativ məbləğ aşağıdakı
üç həddin minimumudur:

1. Qaimənin AZN-lə ƏDV məbləği.
2. Əsas məbləğin faktiki ödənilmə nisbətinə düşən ƏDV.
3. Qaiməyə bağlanmış ƏDV depozit ödənişi.

Beləliklə, yalnız qaimənin daxil olması, yalnız əsas məbləğin ödənilməsi və ya
yalnız depozit ödənişi giriş ƏDV-sini əsassız şəkildə tam əvəzləşdirmir.
Gömrük rejimində ayrıca `CUSTOMS_VAT` bağlantısı istifadə olunur.
Əvəzləşdirilməyən, ƏDV-dən azad və 0% əməliyyatlar ayrıca rejim kimi saxlanılır.

## Çıxış ƏDV-si

Gedən qaimənin çıxış ƏDV-si faktiki bank ödəniş allocation-u üzrə proporsional
hesablanır. Qismən ödəniş yalnız öz nisbətində ƏDV yaradır; sonrakı ayda daxil
olan ödəniş həmin sonrakı ayın dövriyyəsinə düşür. Eyni ödəniş ikinci dəfə
istifadə edilmir.

## Bank və təkrar-emal nəzarəti

- Bankın xarici əməliyyat ID-si varsa həmin ID, yoxdursa deterministik məzmun
  fingerprint-i istifadə olunur.
- Mövcud qaimə və bank sətri yeniləmə zamanı dəyişdirilmir və təkrar post edilmir.
- ƏDV-yə bağlanmış bank sətri adi qaimə ödənişi kimi ikinci dəfə istifadə edilmir.
- Adi qaimə ödənişinə bağlanmış bank sətri ƏDV depoziti kimi istifadə edilmir.
- Avtomatik ƏDV uyğunlaşdırması yalnız seçilmiş ayın AZN çıxan ödənişlərini
  yoxlayır; başqa ayın sətrlərinə toxunmur.
- Avtomatik seçim yalnız unikal qaimə nömrəsi və ya tək nəticə verən VÖEN sübutu
  olduqda aparılır. Qeyri-müəyyən sətir istifadəçi baxışına saxlanılır.
- Bağlı ayda `Yenilə` avtomatik bağlantı yaratmır.

## Dövrün bağlanması

Ay bağlanmazdan əvvəl registr yenidən hesablanır və sərt nəzarət xətaları
yoxlanır. Əvvəlki ƏDV fəaliyyəti olan ay bağlanmayıbsa sonrakı ayın bağlanması
bloklanır. Uğurlu bağlanışda:

- istifadə edilən əvəzləşmə üçün balanslı `521.01 / 241.01` jurnalı yaranır;
- nəticənin dəyişməz JSON snapshot-u saxlanılır;
- qaimə, bank storno-su, ƏDV bağlantısı və əl düzəlişi ilə geriyə dəyişiklik
  bloklanır;
- növbəti aya yalnız bağlı snapshot-dakı giriş ƏDV qalığı daşınır.

Ay yalnız səbəb yazılmaqla və ən son bağlı dövrdən başlayaraq yenidən açıla
bilər. Açılma zamanı bağlanış jurnalı storno edilir, snapshot ləğv olunur və
hadisə audit izinə yazılır.

## Məlumat bütövlüyü

SQLite schema versiyası `211`-dir. ƏDV modulu aşağıdakı registrlərdən istifadə
edir:

- `vat_invoice_settings` — qaimənin ƏDV rejimi və qeydi;
- `vat_payment_allocations` — bank sətri, qaimə, ödəniş növü, tarix və AZN məbləği;
- `vat_adjustments` — tərəf, məbləğ, qarşı hesab, səbəb və istifadəçi;
- `vat_periods` — açıq/bağlı vəziyyət və bağlanış snapshot-u.

Əməliyyatlar `BEGIN IMMEDIATE / COMMIT / ROLLBACK` sərhədində işləyir. Modulun
bütövlük yoxlaması artıq bölgünü, yanlış əlaqəni, zədələnmiş snapshot-u,
çatışmayan ƏDV ödəniş jurnalını, çatışmayan düzəliş jurnalını və çatışmayan ay
bağlanış jurnalını ayrıca aşkarlayır.

## İnterfeys

- Aylıq ƏDV proqram daxilində ayrıca aşağı iş tabında açılır.
- Filtr/əməliyyat sahəsi kompakt saxlanılıb; əsas hündürlük registr cədvəlinə verilib.
- Alış ƏDV-si, satış ƏDV-si, düzəlişlər və nəzarət ayrı tablarda göstərilir.
- Cədvəllərdə sabit sütun eni, yapışqan başlıq, zebra sətirlər, hover/seçim
  vəziyyəti, ellipsis və tooltip tətbiq olunub.
- Eyni anda DOM-a maksimum 200 sətir çıxarılır; tam registr CSV-yə ixrac edilir.
- Kiçik ekranda xülasə və modal formalar yenidən düzülür, cədvəl isə üfüqi
  sürüşmə ilə sütun sərhədlərini qoruyur.

## Avtomatlaşdırılmış yoxlama

`npm test` komandası aşağıdakı əsas ssenarilərlə uğurla tamamlanıb:

- sintaksis, renderer və preload/IPC müqaviləsi;
- şirkət bazalarının ayrılığı və parolsuz müvəqqəti giriş;
- qaimə istiqaməti, DVX idxalı və duplicate qorunması;
- avtomatik qaimə jurnalı, DBC, subkonto, anbar və valyuta fərqi;
- bank reconciliation və storno;
- giriş/çıxış ƏDV-si, qismən və tam ödəniş;
- ƏDV depozitinin 531.01/223.01 müxabirləşməsi;
- ay üzrə avtomatik uyğunlaşdırma və təkrar-emal bloklaması;
- əl düzəlişi və storno;
- ay bağlanışı, 521.01/241.01 balansı, növbəti aya qalıq və yenidən açılma;
- ƏDV registrinin daxili bütövlük hesabatı.

Real DVX və bank serveri ilə canlı inteqrasiya credential və rəsmi giriş tələb
etdiyindən lokal avtomatlaşdırılmış testin əhatəsinə daxil deyil. Fayl idxalı,
lokal bank registri, müxabirləşmə və aylıq ƏDV mexanizmi tam test olunub.
