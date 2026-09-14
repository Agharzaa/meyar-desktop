# MEYAR ERP v1.13.0 — peşəkar audit hesabatı

## Audit sahəsi

Nüvə uçotu, qaimə idxalı, avtomatik müxabirləşmə, storno, mal/xidmət təsnifatı, anbar maya dəyəri, kontragent analitikası, açılış qalıqları, DBC, icazələr və əsas UI strukturu yoxlanılıb.

## Tətbiq edilən əsas düzəlişlər

- Uçot və avtomatik postlama bütün şirkət bazalarında məcburi aktivdir.
- Qaimənin saxlanması, jurnal yazılışı və anbar hərəkəti eyni tranzaksiyada icra olunur.
- Redaktə/arxiv/bərpa zamanı cari yazılış storno edilir, audit tarixi qorunur və yeni təsnifat DBC-də düzgün görünür.
- Gələn xidmətlər 721.01 və seçilmiş subkonto, gələn mallar 205.01 və seçilmiş anbar üzrə uçota alınır.
- Gedən mal qaiməsində gəlir yazılışı ilə yanaşı 701.01 Debet / 205.01 Kredit maya yazılışı yaradılır.
- 721.02/721.03 kimi saxta xərc hesabları aktiv uçotdan çıxarılıb; xərc maddələri 721.01 daxilində subkontodur.
- Valyutalı çoxsətirli sənədlərdə qəpik fərqi son sətirdə nəzarətli bölüşdürülür və jurnal balansı pozulmur.
- Bir anbar/mal üzrə maya yenidən hesablananda başqa malların jurnal sətirləri qorunur.
- Tarixi mənfi anbar qalığı şirkət bazasının açılmasını bloklamır; sistem açılır və çatışmazlıq yoxlanılmalı uçot qeydi kimi göstərilir.
- Anbar və mal kartındakı vizual dəyişikliklər lazımsız storno yaratmır; yalnız uçot xəritəsi və maya parametri dəyişəndə əlaqəli məlumat yenidən hesablanır.
- DBC 1C məntiqinə uyğun hesab qrupu, yazılış hesabı, subkonto/kontragent/mal və sənəd səviyyələri ilə qurulub.
- Açılış qalıqları 211/531 üzrə kontragentə, 721 üzrə subkontoya bağlana bilir və Debet/Kredit balansı yoxlanır.
- Reyestrlər kompakt filtr, sabit sütun ölçüləri, ellipsis/tooltip, zebra sətirlər, seçilmiş sətir və aşağı iş tabları ilə yenilənib.

## Yoxlama nəticəsi

Tam avtomatik test paketi uğurla tamamlanıb. Paketə sintaksis, renderer, UI strukturu, idxal istiqaməti, DVX, şirkət izolyasiyası, DBC, açılış qalıqları, valyuta, istifadəçi icazələri, anbar və professional uçot regresiya testləri daxildir.

## Sərhəd

Real bank və DVX istehsal bağlantısı ayrıca provayder açarları və test mühiti tələb edir. Bu paket onların təhlükəsiz idxal/inteqrasiya sərhədini saxlayır, lakin xarici xidmətin işləkliyini imitasiya etmir.
