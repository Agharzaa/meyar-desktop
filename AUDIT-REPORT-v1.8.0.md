# Meyar ERP Desktop v1.8.0 — Texniki audit və qəbul qeydləri

## Nəticə

v1.8.0 qaimə, anbar və müxabirləşmə axınını vahid məlumat modelinə keçirir.
Qaimə təsdiqləndiyi anda jurnal və stok hərəkəti eyni SQLite tranzaksiyasında
yazılır. Sonradan hesab, subkonto, müqavilə və ya anbar dəyişdiriləndə köhnə
təsir silinib yeni təsir yenidən hesablanır.

## Uçot mexanizmi

| Sənəd | Debet | Kredit | Analitika |
|---|---|---|---|
| Gələn xidmət | seçilən xidmət hesabı (məs. 721.03) | 531.01 | kontragent, müqavilə, subkonto |
| Gələn mal | 205.01 | 531.01 | anbar, mal, kontragent |
| Gedən xidmət | 211.01 | seçilən gəlir hesabı | kontragent, müqavilə, subkonto |
| Gedən mal | 211.01 | 601.01 | anbar, mal, kontragent |
| Gedən malın maya dəyəri | 701.01 | 205.01 | anbar, mal, qaimə |
| ƏDV | 241.01 / 521.01 | qarşı hesab | qaimə |

Məbləğlər qəpik dəqiqliyində yuvarlaqlaşdırılır. Debet/Kredit balansı və hesab
əlaqələri keçmədikdə tranzaksiya geri qaytarılır.

## Anbar

Anbar kartında FIFO və ya orta maya seçilir. Gələn mal partiyaları stokda
saxlanılır; gedən mal həmin üsulla maya dəyərinə çevrilir. Çatışmayan stok
qaiməni yarımçıq post etmir — sənəd uçota alınır, lakin uçot baxışı tələb edən
aydın xəbərdarlıq saxlanılır.

## Təsnifat və idxal

Sətir növü əvvəlcə kataloqdan, sonra uçot qaydasından və sənəd mətnindən
alınır. Sübut olmadıqda təhlükəsiz seçim “Xidmət”dir. Bu, xidmət qaiməsinin
205 mal hesabına yanlış düşməsinin qarşısını alır. Gələn/Gedən istiqaməti isə
idxal faylının məzmunu və etibarlı DVX sübutu ilə müəyyən edilir.

## UI/UX qəbul meyarları

- İlk girişdə əsas səhifə açılır.
- Qaimə reyestri aşağı iş tabında ayrıca açılır.
- Filtr sahəsi yığcamdır; cədvəl əsas iş sahəsini tutur.
- Cədvəllər yaşıl başlıq, zebra sətirlər, hover və seçmə vəziyyəti ilə oxunur.
- Hesab kodları yalnız kod çipində rənglə fərqlənir; mətn kontrastı qorunur.
- 900px və daha geniş ekranlarda layout daşmır; dar ekranlarda cədvəl üfüqi
  sürüşdürülə bilir.

## Yoxlamalar

Keçən yoxlamalar: accounting-engine v1.8.0, system v1.8.0, core regression,
UI structure, renderer/preload syntax və mövcud import/direction/company/DBC
regresiya testləri. `dvx-two-direction-test.js` yalnız lokal `xlsx` paketinin
olmaması səbəbilə icra edilməyib; son istifadəçi paketində `npm install`
ilə dependency qurulur.
