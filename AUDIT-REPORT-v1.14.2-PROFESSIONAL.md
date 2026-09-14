# MEYAR ERP Desktop v1.14.2 — peşəkar audit hesabatı

## Nəticə

Sistem uçot nüvəsi, qaimə axını, anbar qiymətləndirməsi, DBC, məlumat
kitabçaları, şirkət bazalarının ayrılığı və əsas istifadəçi interfeysi üzrə
yenidən yoxlanılıb. Aşkarlanmış kritik məntiq və təqdimat problemləri kodda
düzəldilib, qoruyucu regresiya testləri əlavə olunub.

## Artımlı və idempotent sinxronizasiya

- Qaimənin dəyişməz biznes açarı `qaimə nömrəsi + VÖEN + istiqamət` olaraq
  saxlanılır. Bu açar bazada varsa sinxronizasiya sətri yalnız “mövcud” kimi
  sayır və sənədi dəyişmir.
- Duplicate qaimə üçün əvvəlki versiyada mümkün olan təkrar müxabirləşdirmə
  davranışı çıxarılıb. Sinxronizasiya mövcud qaimənin statusuna, jurnalına,
  anbar hərəkətinə, subkontosuna və ödəniş bölgüsünə toxuna bilməz.
- Eyni qaimə nömrəsi və VÖEN-in Gələn və Gedən istiqamətləri ayrı biznes
  sənədləridir; biri digərini dəyişmir.
- Bank əməliyyatları bankın xarici tranzaksiya ID-si ilə, bu ID olmadıqda isə
  hesab, tarix, istiqamət, məbləğ, valyuta, VÖEN, kontragent, təyinat, referans
  və valyuta tarixindən yaradılan deterministik fingerprint ilə qorunur.
- İlk fayl idxalında mənbə istiqamət və ya bank hesabı üzrə yadda saxlanılır.
  “Yenilə” həmin mənbəni təkrar oxuyur, lakin yalnız yeni sənədləri əlavə edir.
- DVX canlı pəncərəsi açıqdırsa, “Yenilə” düzgün qovluğa keçərək yalnız yeni
  qaimələri gətirir və əsas reyestrə avtomatik yenilənmə siqnalı göndərir.
- Hər sinxronizasiya `integration_sync_runs` jurnalında namizəd, yaradılmış,
  keçilmiş və xətalı sətir sayları ilə audit olunur.

## Uçot və nüvə mexanizmi

- Hər etibarlı gələn və gedən qaimə saxlanılan və ya idxal edilən anda eyni
  baza tranzaksiyasında avtomatik uçota alınır.
- Debet və Kredit bərabərliyi jurnal yazılışı tamamlanmamışdan əvvəl yoxlanır;
  yarımçıq qaimə, jurnal və ya anbar hərəkəti saxlanılmır.
- Mal və xidmət axınları ayrıdır. Mal sətri aktiv anbar, mal kartı və anbar
  hesabı tələb edir; xidmət sətri anbardan istifadə etmir.
- FIFO və orta maya anbar üzrə tətbiq olunur. Gedən mal üçün maya dəyəri və
  ehtiyatın azalması avtomatik yaradılır.
- Etibarlı DVX/fayl idxalı tarixi mənfi qalıq səbəbindən itmir: sənəd uçota
  alınır, çatışmazlıq yoxlama qeydi kimi görünür. Əl ilə daxil edilən yeni
  sənəddə anbarın mənfi qalıq siyasəti tətbiq olunur.
- Qaimə redaktəsi əvvəlki aktiv yazılışı storno edir və yeni hesab, subkonto,
  müqavilə, anbar və məbləğlə yenidən müxabirləşir. Audit izi saxlanılır.
- Jurnal–anbar bütövlük auditi itmiş, artıq, səhv bağlanmış və jurnal dəyəri ilə
  uyğunlaşmayan mal hərəkətlərini aşkarlayır; təsirlənmiş anbar/mal sahəsini
  deterministik qaydada yenidən qurur.

## Hesablar, subkontolar və DBC

- `721` qrup hesabıdır; yazılış `721.01` üzərinə aparılır. Yemək, nəqliyyat,
  rabitə və digər xərc maddələri `721.01` daxilində subkonto kimi saxlanılır.
- Subkonto yalnız aid olduğu yazılış hesabı ilə seçilir. Hesab dəyişəndə köhnə
  hesabın subkontosu daşınmır.
- Hesabın semantik rolu aktiv sənədlər və qaydalar tərəfindən istifadə
  olunursa təhlükəli dəyişiklik bloklanır; istifadə olunmayan rol silinə bilər.
- Müqavilə nömrəsi kontragent daxilində təkrarlana bilməz; tarix ardıcıllığı
  və kontragent əlaqəsi yoxlanılır.
- DBC hesab qrupu → subkonto/kontragent/mal–anbar → sənəd səviyyəsində açılır.
  Dövr əvvəli qalıq, dövr Debet/Kredit dövriyyəsi və dövr sonu qalıq ayrıdır.
- `211` debitorları, `531` kreditorları, `205` mal–anbar analitikasını,
  `721.01` isə xərc subkontolarını göstərir.

## İnterfeys və istifadə rahatlığı

- Sol menyu əvəzinə üfüqi modul naviqasiyası və proqram daxilində açılan iş
  pəncərələri saxlanılıb; açıq pəncərələr aşağıdakı kiçik tablarda görünür.
- Gələn qaimə, gedən qaimə, daxil olan ödəniş və çıxan ödəniş ayrı iş
  səhifələridir; məlumatlar bir-birinə qarışmır.
- Köhnə iri qaimə əməliyyat paneli gizlədilib. Axtarış, status, ödəniş, tarix,
  yoxlama, əlavə etmə və ixrac eyni incə filtr zolağındadır.
- Qaimə reyestri sabit sütun sxemi, zebra fon, hover, klaviatura fokusu, aydın
  seçilmiş sətir, ellipsis və tooltip ilə qurulub. Uzun mətn qonşu sütuna daşmır.
- Qaimə kartının 13 başlığı 13 məlumat sahəsi ilə eyni ardıcıllıqdadır. Hesab
  seçimi artıq sərbəst mətn deyil, `kod — hesabın adı` siyahısıdır.
- Əsas səhifədə qaimə cədvəli yoxdur; yalnız ümumi göstəricilər, son 5 çıxan
  bank ödənişinin kontragent və məbləği, həmçinin sistem bildirişləri var.
- Anbar kitabçasında FIFO/orta maya ilə yanaşı mənfi qalıq siyasəti də görünür
  və idarə olunur.
- Parol və istifadəçi idarəetməsi bu mərhələdə interfeysdən çıxarılıb; şirkət
  bazası seçilərək birbaşa giriş edilir.
- Electron-un öz başlığı ilə təkrarlanan daxili başlıq və hər səhifədə eyni işi
  təkrarlayan qlobal axtarış sətri tam çıxarılıb.
- Köhnə stil qatının gizlətdiyi reyestr filtri yenidən görünəndir; bütün filtr
  elementləri və əməliyyat düymələri bir sətirdə sabit ardıcıllıqla yerləşir.
- Qaimə əməliyyat xanası yenidən həqiqi cədvəl xanasıdır. Sütunlar 100% enə
  deterministik bölünür və sağ tərəfdə süni boş sütun yaranmır.
- Kontragent, müqavilə, bank, hesab, subkonto, anbar, kataloq və uçot qaydaları
  cədvəllərinin hər biri ayrıca sütun xəritəsinə malikdir. Boş nəticə sətri də
  həmin cədvəlin real sütun sayından istifadə edir.

## Yoxlama nəticəsi

`npm test` tam keçib. Sintaksis, renderer, IPC müqaviləsi, idempotent artımlı
sinxronizasiya, şirkət bazalarının
ayrılığı, parolsuz giriş, DVX istiqaməti, fayl idxalı, avtomatik müxabirləşmə,
valyuta üzləşməsi, DBC açılış qalığı, anbar qiymətləndirməsi, məlumat
kitabçaları və UI quruluşu üzrə bütün mövcud testlər uğurludur.

Xarici DVX portalının gələcək HTML və giriş dəyişiklikləri tətbiqin nəzarətindən
kənardır; lokal uçot və idxal nüvəsi bu xarici asılılıqdan ayrılmışdır.
