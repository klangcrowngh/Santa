# Тайный Санта

Telegram Mini App для обмена подарками. Организатор делится ссылкой на «НГ 202(sex)7» и запускает жеребьёвку. Участники выбирают бюджет и открывают личный результат в приложении.

## Локальный предпросмотр

Нужен Node.js 22.13 или новее. Запустите `npm run preview` и откройте `http://127.0.0.1:3000/app/` для просмотра от лица организатора или `http://127.0.0.1:3000/app/?role=participant` для просмотра от лица участника. Данные предпросмотра хранятся в памяти.

## Публикация на GitHub Pages и Cloudflare

1. Заполните `BOT_TOKEN` и `ORGANIZER_TELEGRAM_ID` в локальном `.env`.
2. В GitHub откройте **Settings → Pages**, выберите **Deploy from a branch**, ветку `main` и папку **/docs**. [Инструкция GitHub](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
3. Укажите адрес GitHub Pages в `vars.MINI_APP_URL` в `wrangler.jsonc`. Для этого репозитория задан `https://klangcrowngh.github.io/Santa/app/`. Включите **Main Mini App** у бота через [@BotFather](https://t.me/BotFather) и укажите тот же адрес. [Документация Telegram](https://core.telegram.org/bots/webapps#launching-the-main-mini-app)
4. Выполните `npm ci` и `npx wrangler login`. В аккаунте Cloudflare должен быть выбран поддомен `workers.dev`. [Настройка workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
5. Выполните `npm run cloudflare:deploy`. Команда развернёт Worker, передаст токен как секрет Cloudflare, проверит API, настроит вебхук Telegram и запишет опубликованный адрес API в `docs/app/config.js`.
6. Закоммитьте обновлённый `docs/app/config.js` и отправьте в `main`. После обновления GitHub Pages снова откройте Mini App в Telegram.

GitHub Pages отдаёт интерфейс. Worker проверяет подпись Telegram и хранит обмены, голоса и результаты в SQLite внутри Durable Object. SQLite Durable Objects доступны на бесплатном плане Cloudflare с его лимитами. [Документация Cloudflare](https://developers.cloudflare.com/durable-objects/) · [Проверка подписи Telegram](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)

При запуске через Cloudflare бот получает обновления по вебхуку. Команда `npm start` нужна только для отдельного запуска через Node.js в режиме опроса Telegram. При таком запуске база хранится в `data/santa.sqlite` по умолчанию. `.env` и каталог `data` исключены из Git.

## Как проходит обмен

1. В чате с ботом отправьте `/start`. Бот ответит коротким приветствием. Нажмите «Тайный Санта» рядом с полем ввода. Обмен появляется автоматически при первом входе организатора.
2. Каждый, кто откроет Mini App из меню бота до жеребьёвки, автоматически становится участником.
3. Начальный бюджет каждого участника составляет 2 500 ₽ и сразу входит в среднее. Сумму можно изменить ползунком от 1 000 до 5 000 ₽ с шагом 100 ₽. Изменения сохраняются автоматически. Среднее в шапке и список участников обновляются каждые три секунды.
4. Когда есть хотя бы двое участников, организатор может изменить состав или провести жеребьёвку. После запуска состав и бюджет фиксируются.
5. Каждый участник открывает свой результат во вкладке «Жеребьёвка». Организатор может запустить новый раунд с тем же составом и бюджетом.

Автоматические проверки запускаются командой `npm test`.
