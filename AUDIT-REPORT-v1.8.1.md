# Meyar ERP Desktop v1.8.1 — buraxılış auditi

## Düzəldilən kritik problemlər

- Eyni anda yüklənən zidd UI qatları ayrıldı; aktiv interfeys yalnız v1.8.0 baza
  dizaynı və v1.8.1 izolyasiya qatından istifadə edir.
- Bütün əsas cədvəllərdə `table-layout: fixed`, sərt sütun ölçüsü, hüceyrədaxili
  `overflow: hidden` və `text-overflow: ellipsis` tətbiq edildi. Heç bir mətn
  qonşu sütunun üzərinə çəkilmir.
- DVX kartı bir sətir kimi oxunanda “Seriya və nömrə”, “Yekun məbləğ”, “ƏDV”
  və digər sahələrin kontragent adına əlavə olunması bloklandı. Schema 181
  miqrasiyası mövcud çirklənmiş adları kontragent və qaimə cədvəllərində
  təmizləyir.
- Gələn/Gedən qaimələr və Daxil olan/Çıxan bank ödənişləri ayrıca daxili iş
  tablarına bölündü. Bank ayrılığı SQL `direction` filtri ilə qorunur.
- Qaimə və bank iş sahələri 1C tipli “idarəetmə zolağı + əsas cədvəl” quruluşuna
  keçirildi; böyük məlumat kartları reyestr pəncərəsindən çıxarıldı.
- Bank hesabları ayrıca “Məlumat kitabçaları → Banklar” siyahısına əlavə edildi.

## Qorunan uçot prinsipləri

- Qaimə yadda saxlananda status avtomatik “Təsdiqlənib”, posting statusu
  “Uçota alınıb” olur.
- Qaimə, jurnal sətirləri və anbar hərəkəti eyni SQLite tranzaksiyasında yazılır;
  xəta zamanı bütün əməliyyat geri qaytarılır.
- Redaktə əvvəlki jurnal/anbar təsirini yenidən qurur və dəyişdirilmiş hesab,
  subkonto, müqavilə və anbarı bazada əks etdirir.
- Mal qaiməsi 205/anbar uçotuna, xidmət isə xərc/gəlir hesabına yönəlir.
- Anbar üzrə FIFO və orta maya dəstəyi, satışda maya müxabirləşməsi və
  Debet=Kredit nəzarəti saxlanılıb.
- 211.01, 531.01, 205 və digər hesablar üzrə analitik dövriyyə-balans işləyir.

## Yoxlama nəticəsi

Kod sintaksisi, renderer sintaksisi, UI izolyasiyası, avtomatik uçot, DBC,
mal/xidmət təsnifatı, anbar maya hesabı, şirkət bazalarının ayrılığı, DVX
istiqaməti, canlı import və preload müqaviləsi üzrə mövcud testlər uğurla keçib.
`xlsx` paketini tələb edən iki-istiqamətli real fayl testi quraşdırılmış
asılılıqlarla işə düşür; paket quraşdırılması başlanğıc skripti tərəfindən edilir.
