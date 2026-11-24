import { DurableObject } from 'cloudflare:workers';
import { timingSafeEqual } from 'node:crypto';
import { createBot } from './bot.js';
import { createMiniApp, readJson } from './mini-app.js';
import { createProfilePhotos } from './profile-photo.js';
import { createSantaStore, SantaError } from './store-data.js';
import { createTelegramApi } from './telegram.js';

const routes = new Set(['/health', '/api/santa', '/telegram/webhook']);
const webhookHeader = 'X-Telegram-Bot-Api-Secret-Token';

export default {
  fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (!routes.has(path)) return new Response(null, { status: 404 });
    if (path === '/telegram/webhook') {
      const expected = env.TELEGRAM_WEBHOOK_SECRET;
      const provided = request.headers.get(webhookHeader);
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      if (!expected || !provided || !sameSecret(expected, provided)) return new Response(null, { status: 403 });
    }
    return env.SANTA.getByName('santa').fetch(request);
  },
};

export class Santa extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const token = env.BOT_TOKEN;
    const organizerId = Number(env.ORGANIZER_TELEGRAM_ID);
    const miniAppUrl = new URL(env.MINI_APP_URL);
    if (!token || !env.TELEGRAM_WEBHOOK_SECRET || !Number.isSafeInteger(organizerId) || organizerId < 1
      || !env.BOT_USERNAME || miniAppUrl.protocol !== 'https:') {
      throw new Error('Укажите настройки бота в Cloudflare.');
    }
    const { sql } = ctx.storage;
    const database = {
      exec: (statement) => sql.exec(statement).toArray(),
      prepare: (statement) => ({
        get: (...values) => sql.exec(statement, ...values).toArray()[0],
        all: (...values) => sql.exec(statement, ...values).toArray(),
        run: (...values) => sql.exec(statement, ...values).toArray(),
      }),
    };
    const store = createSantaStore(database, {
      organizerId,
      transaction: (callback) => ctx.storage.transactionSync(callback),
    });
    const api = createTelegramApi(token);
    const profilePhoto = createProfilePhotos({ api, token });
    this.miniApp = createMiniApp({ store, api, token, origin: miniAppUrl.origin, profilePhoto });
    this.bot = createBot({ store, api, username: env.BOT_USERNAME, miniAppUrl });
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/health') return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
    if (path === '/api/santa') return this.miniApp(request);
    if (path !== '/telegram/webhook') return new Response(null, { status: 404 });

    let update;
    try {
      update = await readJson(request, 128 * 1024);
      if (!Number.isSafeInteger(update.update_id)) return new Response(null, { status: 400 });
    } catch (error) {
      if (error instanceof SantaError) return new Response(null, { status: 400 });
      return new Response(null, { status: 500 });
    }

    if (await this.ctx.storage.get('telegramLastUpdate') === update.update_id) {
      return new Response(null, { status: 204 });
    }
    try {
      await this.bot(update);
    } catch (error) {
      console.error(error.message);
      if (!(error.status >= 400 && error.status < 500 && error.status !== 429)) {
        return new Response(null, { status: 502 });
      }
    }
    await this.ctx.storage.put('telegramLastUpdate', update.update_id);
    return new Response(null, { status: 204 });
  }
}

function sameSecret(expected, provided) {
  const first = Buffer.from(expected);
  const second = Buffer.from(provided);
  return first.length === second.length && timingSafeEqual(first, second);
}
