# Памет на проекта – Преведени субтитри (Stremio/Nuvio добавка)

## Решение
- Добавка: Node.js без зависимости (`src/server.js`), Stremio манифест + ресурс `subtitles` (+ по езици). Работи и в Nuvio (поддържа Stremio манифести).
- Превод: Google Translate keyless endpoint `translate_a/t?client=dict-chrome-ex` (множество `q=` параметри, връща преведен масив в същия ред).
- Източник на субтитри: `subtitlecat.com` (търсене по име+година / „Name SxxEyy", директни SRT линкове, EN версия чрез `-en.srt` или `-orig.srt`). Името се взима от Cinemeta (`v3-cinemeta.strem.io`).

## Проверено в сесията (правило 87-88)
- GT пакетния endpoint: реални заявки EN→BG/TR с няколко q – ОК.
- SubtitleCat: търсене филм+сериал, `-orig.srt` (135 КБ), директни преведени SRT – ОК.
- Cinemeta `/meta/series/tt....json` (само цяла серия; форма с :S:E дава 404) – ОК.
- Локално: манифест, health, списъци (Inception BG 11 s; BB S05E03 TR 4.9 s; кеш hit 0.015 s) – ОК.

## Уроци (правило 196)
- `podnapisi.net` е МЪРТЪВ от ~26.03.2026 (DNS-ът изцяло е свален – проверено с nslookup 8.8.8.8 и през облак).
- BSPlayer subtitle API: LogIn работи (строг SOAP формат от bazarr), но searchSubtitles по IMDB без локален файл-хеш връща „Not found" – негодно за добавка.
- SubDL API иска ключ (безплатна регистрация) – отказан като основен източник.
- Излишно е `?language=` param и suffix-ресурсите да очертават пътища: заявен език се парсва от пътя И от query параметрите.
