# Преведени субтитри – добавка за Stremio и Nuvio

Добавката дава субтитри на избрания от вас език за филми и сериали.
Оригиналните субтитри (EN) се взимат от `subtitlecat.com` и се превеждат
автоматично с **Google Translate** (безплатен keyless endpoint – без акаунт и без ключ).

> ⚠️ **Важно:** това е превод на *субтитрите*. Пълно озвучаване (дублаж) на аудиото
> не е технически възможно като добавка – Stremio/Nuvio не позволяват подмяна на
> аудиозаписа. (Обсъдено и потвърдено предварително.)

## Как работи

1. Плеърът пита добавката за субтитри по IMDB id
2. Добавката взима името на филма/сериала от Cinemeta (без ключ)
3. Търси подходящи субтитри в `subtitlecat.com` (без ключ)
4. Превежда всяка реплика с Google Translate и връща готов SRT

Дават се две версии: **Google превод** (на всеки език) и **директна** версия,
ако SubtitleCat вече има готови преведени субтитри на същия език.

```
addon/
├── src/server.js    # цялата добавка (Node.js, без зависимости)
├── package.json
├── render.yaml      # конфигурация за безплатен хостинг Render
└── README.bg.md
```

---

## Вариант В: Cloudflare Worker (безплатно, най-стабилно) – за телефон и TV

Google блокира безплатни облаци (Render), затова най-стабилният вариант е Cloudflare:

1. Отвори този линк и логни се с GitHub (акаунт **krass91**):
   **https://deploy.workers.cloudflare.com/?url=https://github.com/krass91/gt-subs**
2. Ако Cloudflare те пита да „Import repository" – доизбери repo-то и натисни **Deploy**.
3. Готов! Адресът ще е от типа `https://gt-subs.ВАШЕ-ИМЕ.workers.dev` – надолу на
   страницата на Worker-а ще видиш мес от типа:
   `https://gt-subs.<cname>.workers.dev`
4. Сложи `/manifest.json` след адреса и дава същото в Stremio/Nuvio.

(Алтернативно през dashboard: workers.cloudflare.com → Create Worker → Quick edit →
paste работата от `worker.js` → Deploy.)

---

## Вариант А: Безплатно на онлайн хостинг (Render) – десктоп Stremio

1. Качете папката на GitHub (PowerShell):

```powershell
cd F:\addon
git init
git add .
git commit -m "Преведени субтитри – добавка за Stremio/Nuvio"
# създайте ПРАЗНО репо на github.com (без README) и после:
git remote add origin https://github.com/ВАШИЯТ-АКАУНТ/gt-subs.git
git branch -M main
git push -u origin main
```

2. Отидете на https://render.com -> **New** -> **Blueprint** -> изберете репото.
   Render прочита `render.yaml` и сам стартира приложението (безплатен план).

3. Готовият адрес (манифест) е:

```
https://ИМЕ-ДОМЕН.onrender.com/manifest.json
```

**В Nuvio:** раздел Addons -> Add -> поставете URL-а горе -> Add.
**В Stremio:** Addons -> Community addons -> полето за URL горе вдясно -> добавете URL-а.

---

## Вариант Б: Локално, без хостинг

Нужен е Node.js 18+ (безплатно от nodejs.org):

```powershell
cd F:\addon
node src\server.js
```

После в Stremio/Nuvio добавяте:

```
http://localhost:7000/manifest.json
```

Работи докато вашият PC е включен и Node.js процессът върви.

---

## Поддържани езици (31)

български, македонски, сръбски, хърватски, словенски, румънски, турски, руски,
украински, полски, чешки, словашки, унгарски, немски, нидерландски, испански,
португалски, италиански, френски, гръцки, арабски, иврит, персийски, хинди,
бенгали, китайски, японски, корейски, виетнамски, индонезийски, тайски.

Списъкът е в `src/server.js` под **`LANGS`** – лесно добавяте/махате редове.
**Език по подразбиране:** `DEFAULT_LANG` (код 3 букви; "bul" = български).

## Ориентирано тестване

```powershell
node src\server.js
# в друг прозорец:
curl http://localhost:7000/manifest.json
curl http://localhost:7000/health
# филм (Inception):
curl http://localhost:7000/subtitles/movie/tt1375666.json
# сериал (Breaking Bad S05E03):
curl http://localhost:7000/subtitles/series/tt0903747:5:3.json
```

## Скорост

Първото превеждане на едно видео (~2500 реплики) е ~5-15 секунди; после резултатът
се кешира за 24 ч и зарежда за мигове.

## Ограничения

- Преводът е машинен (Google Translate) – най-близо до реалния смисъл, но не е
  идеален като професионален дублаж.
- Не всички видео версии имат източник в SubtitleCat – тогава добавката връща празен списък.
- Ако Google Translate временно откаже, част от репликите остават на английски.
