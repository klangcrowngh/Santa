import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createBot } from './bot.js';
import { createMiniApp } from './mini-app.js';
import { createProfilePhotos } from './profile-photo.js';
import { createStore } from './store.js';
import { configureTelegramMenu, createTelegramApi, telegramUpdates } from './telegram.js';

if (process.argv.includes('--preview')) {
  preview();
} else {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

function preview() {
  const port = Number(process.env.PORT ?? '3000');
  const host = '127.0.0.1';
  const api = createMiniApp({ store: createStore(':memory:'), demo: true });
  const files = new Map([
    ['/budget/', ['/budget/index.html', 'text/html']],
    ['/budget/style.css', ['/budget/style.css', 'text/css']],
    ['/budget/app.js', ['/budget/app.js', 'text/javascript']],
    ['/budget/settings.js', ['/budget/settings.js', 'text/javascript']],
    ['/app/', ['/app/index.html', 'text/html']],
    ['/app/style.css', ['/app/style.css', 'text/css']],
    ['/app/app.js', ['/app/app.js', 'text/javascript']],
    ['/app/config.js', ['/app/config.js', 'text/javascript']],
    ['/app/cats-holiday.jpg', ['/app/cats-holiday.jpg', 'image/jpeg']],
    ['/app/cats-holiday-party.jpg', ['/app/cats-holiday-party.jpg', 'image/jpeg']],
  ]);
  createServer(async (request, response) => {
    const path = request.url.split('?')[0];
    if (path === '/api/santa') return respond(api, request, response);
    if (path === '/' || path === '/app') {
      response.writeHead(302, { location: '/app/' }).end();
      return;
    }
    if (path === '/budget') {
      response.writeHead(302, { location: '/budget/' }).end();
      return;
    }
    if (!files.has(path)) {
      response.writeHead(404).end();
      return;
    }
    const [file, type] = files.get(path);
    try {
      const content = await readFile(new URL(`../docs${file}`, import.meta.url));
      response.writeHead(200, { 'content-type': type.startsWith('text/') ? `${type}; charset=utf-8` : type }).end(content);
    } catch {
      response.writeHead(500).end();
    }
  }).listen(port, host, () => console.log(`Предпросмотр: http://${host}:${port}/app/`));
}

async function run() {
  const token = process.env.BOT_TOKEN?.trim();
  if (!token) throw new Error('Задайте BOT_TOKEN в файле .env. Шаблон — .env.example.');
  const miniAppUrl = readMiniAppUrl();
  const organizerId = readOrganizerId();
  const shutdown = new AbortController();
  process.once('SIGINT', () => shutdown.abort());
  process.once('SIGTERM', () => shutdown.abort());

  const api = createTelegramApi(token, { signal: shutdown.signal });
  const { username } = await api('getMe');
  const webhook = await api('getWebhookInfo');
  if (webhook.url) throw new Error('У бота активен вебхук. Отключите его перед запуском в режиме опроса.');
  const store = createStore(process.env.DATABASE_PATH ?? 'data/santa.sqlite', { organizerId });
  const bot = createBot({ api, store, username, miniAppUrl });
  let server;
  if (miniAppUrl) {
    const profilePhoto = createProfilePhotos({ api, token, signal: shutdown.signal });
    const miniApp = createMiniApp({ store, api, token, origin: miniAppUrl.origin, profilePhoto });
    server = createServer((request, response) => {
      if (request.url === '/api/santa') return respond(miniApp, request, response);
      response.writeHead(404).end();
    });
  }
  let offset = 0;
  try {
    if (server) {
      const host = process.env.HOST ?? '127.0.0.1';
      const port = Number(process.env.PORT ?? '3000');
      await new Promise((resolve, reject) => server.once('error', reject).listen(port, host, resolve));
      console.log(`API: http://${host}:${port}/api/santa`);
    }
    await configureTelegramMenu(api, miniAppUrl);
    console.log(`Бот запущен: https://t.me/${username}`);
    while (!shutdown.signal.aborted) {
      let updates;
      try {
        updates = await api('getUpdates', {
          offset,
          timeout: 25,
          allowed_updates: telegramUpdates,
        });
      } catch (error) {
        if (shutdown.signal.aborted) break;
        console.error(error.message);
        if (error.status === 409) throw new Error('Остановите другой экземпляр этого бота.');
        await delay(3000);
        continue;
      }
      for (const update of updates) {
        if (shutdown.signal.aborted) break;
        try {
          await bot(update);
        } catch (error) {
          console.error(`Ошибка при обработке обновления ${update.update_id}: ${error.message}`);
        }
        offset = update.update_id + 1;
      }
    }
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    store.close();
  }
}

async function respond(handler, request, response) {
  try {
    const body = request.method === 'POST' ? Readable.toWeb(request) : undefined;
    const input = new Request(new URL(request.url, 'http://localhost'), {
      method: request.method, headers: request.headers, body, duplex: 'half',
    });
    const result = await handler(input);
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch {
    response.writeHead(500).end();
  }
}

function readMiniAppUrl() {
  const value = process.env.MINI_APP_URL?.trim();
  if (!value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('MINI_APP_URL должен быть публичным HTTPS-адресом.');
  }
  if (url.protocol !== 'https:') throw new Error('MINI_APP_URL должен начинаться с https://.');
  return url;
}

function readOrganizerId() {
  const value = process.env.ORGANIZER_TELEGRAM_ID?.trim();
  if (!value) return undefined;
  const id = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(id) || id < 1) {
    throw new Error('ORGANIZER_TELEGRAM_ID должен содержать целочисленный Telegram ID.');
  }
  return id;
}
