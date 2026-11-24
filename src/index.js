import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createBot } from './bot.js';
import { createMiniApp } from './mini-app.js';
import { createProfilePhotos } from './profile-photo.js';
import { createStore } from './store.js';

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
    if (path === '/api/santa') return api(request, response);
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

  async function api(method, fields = {}) {
    for (;;) {
      let result;
      try {
        const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(fields),
          signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(35_000)]),
        });
        result = await response.json();
      } catch {
        throw new Error(`Нет ответа от Telegram (${method}).`);
      }
      if (result.ok) return result.result;
      if (method === 'editMessageText' && result.description?.includes('message is not modified')) return;
      const retry = result.parameters?.retry_after;
      if (result.error_code === 429 && retry > 0) {
        await delay(retry * 1000, undefined, { signal: shutdown.signal });
        continue;
      }
      throw new Error(`Telegram ${method} (${result.error_code}): ${result.description}`);
    }
  }

  const { username } = await api('getMe');
  const webhook = await api('getWebhookInfo');
  if (webhook.url) throw new Error('У бота активен вебхук. Отключите его перед запуском в режиме опроса.');
  await api('setMyCommands', {
    commands: [
      { command: 'start', description: 'Мои обмены' },
      { command: 'new', description: 'Создать обмен' },
      ...(miniAppUrl ? [{ command: 'link', description: 'Ссылка на обмен для беседы' }] : []),
      { command: 'cancel', description: 'Вернуться в меню' },
    ],
  });
  const store = createStore(process.env.DATABASE_PATH ?? 'data/santa.sqlite', { organizerId });
  const bot = createBot({ api, store, username, miniAppUrl });
  let server;
  if (miniAppUrl) {
    const profilePhoto = createProfilePhotos({ api, token, signal: shutdown.signal });
    const miniApp = createMiniApp({ store, api, token, origin: miniAppUrl.origin, profilePhoto });
    server = createServer((request, response) => {
      if (request.url === '/api/santa') return miniApp(request, response);
      response.writeHead(404).end();
    });
  }
  let offset = 0;
  try {
    if (server) {
      const host = process.env.HOST ?? '127.0.0.1';
      const port = Number(process.env.PORT ?? '3000');
      await new Promise((resolve, reject) => server.once('error', reject).listen(port, host, resolve));
      await api('setChatMenuButton', {
        menu_button: { type: 'web_app', text: 'Тайный Санта', web_app: { url: miniAppUrl.href } },
      });
      console.log(`API: http://${host}:${port}/api/santa`);
    }
    console.log(`Бот запущен: https://t.me/${username}`);
    while (!shutdown.signal.aborted) {
      let updates;
      try {
        updates = await api('getUpdates', {
          offset,
          timeout: 25,
          allowed_updates: ['message', 'callback_query'],
        });
      } catch (error) {
        if (shutdown.signal.aborted) break;
        console.error(error.message);
        if (error.message.includes('(409)')) throw new Error('Остановите другой экземпляр этого бота.');
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
