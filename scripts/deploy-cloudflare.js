import { createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureTelegramMenu, createTelegramApi, telegramUpdates } from '../src/telegram.js';

try {
  await deploy();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

async function deploy() {
  const token = process.env.BOT_TOKEN?.trim();
  const organizerId = process.env.ORGANIZER_TELEGRAM_ID?.trim();
  if (!token || !/^\d+$/.test(organizerId ?? '') || !Number.isSafeInteger(Number(organizerId)) || Number(organizerId) < 1) {
    throw new Error('Заполните BOT_TOKEN и ORGANIZER_TELEGRAM_ID в локальном .env.');
  }
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  const miniAppUrl = new URL(config.vars.MINI_APP_URL);
  const api = createTelegramApi(token);
  const { username } = await api('getMe');
  const secret = createHmac('sha256', token).update('santa:cloudflare:telegram-webhook').digest('base64url');
  const secrets = {
    BOT_TOKEN: token,
    BOT_USERNAME: username,
    ORGANIZER_TELEGRAM_ID: organizerId,
    TELEGRAM_WEBHOOK_SECRET: secret,
  };
  const worker = await publish(config.name, secrets);
  const webhook = new URL('/telegram/webhook', worker);
  const endpoint = new URL('/api/santa', worker);
  const health = await fetch(new URL('/health', worker), { signal: AbortSignal.timeout(10_000) });
  if (!health.ok || !(await health.json()).ok) throw new Error('Cloudflare Worker не прошёл проверку /health.');
  const options = await fetch(endpoint, {
    method: 'OPTIONS',
    headers: { Origin: miniAppUrl.origin, 'Access-Control-Request-Method': 'POST' },
    signal: AbortSignal.timeout(10_000),
  });
  if (options.status !== 204 || options.headers.get('Access-Control-Allow-Origin') !== miniAppUrl.origin) {
    throw new Error('Worker не разрешил доступ с GitHub Pages.');
  }
  const probe = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: '{}',
    signal: AbortSignal.timeout(10_000),
  });
  if (probe.status !== 400) throw new Error('Worker не подтвердил секрет вебхука.');

  await configureTelegramMenu(api, miniAppUrl);
  await api('setWebhook', {
    url: webhook.href, secret_token: secret, max_connections: 1, allowed_updates: telegramUpdates,
  });
  const webhookInfo = await api('getWebhookInfo');
  if (webhookInfo.url !== webhook.href) throw new Error('Telegram не подтвердил адрес вебхука.');
  const configPath = new URL('../docs/app/config.js', import.meta.url);
  const frontend = await readFile(configPath, 'utf8');
  const apiLine = /^export const apiUrl = .*;$/m;
  if (!apiLine.test(frontend)) throw new Error('Не удалось найти apiUrl в docs/app/config.js.');
  await writeFile(configPath, frontend.replace(apiLine, `export const apiUrl = ${JSON.stringify(endpoint.href)};`));
  console.log(`Cloudflare API: ${endpoint.href}`);
  console.log('Вебхук Telegram подключён. Закоммитьте docs/app/config.js и отправьте его в main для GitHub Pages.');
}

async function publish(name, secrets) {
  const directory = await mkdtemp(join(tmpdir(), 'santa-worker-'));
  const secretPath = join(directory, 'secrets.json');
  try {
    await writeFile(secretPath, JSON.stringify(secrets), { mode: 0o600 });
    const env = { ...process.env };
    for (const key of Object.keys(secrets)) delete env[key];
    const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
    console.log('Развёртывание Cloudflare Worker…');
    const result = spawnSync(process.execPath, [cli, 'deploy', '--secrets-file', secretPath], {
      env, encoding: 'utf8', windowsHide: true, timeout: 180_000,
    });
    let log = [result.stdout, result.stderr].filter(Boolean).join('\n');
    for (const secret of Object.values(secrets)) log = log.replaceAll(secret, '[hidden]');
    if (result.error) throw new Error(`Wrangler не завершился: ${result.error.code ?? 'ошибка запуска'}.`);
    if (result.status !== 0) throw new Error(log.trim() || 'Wrangler не развернул Worker.');
    const urls = log.match(/https:\/\/[\w.-]+\.workers\.dev\b/g) ?? [];
    const endpoint = urls.find((value) => new URL(value).hostname.startsWith(`${name}.`));
    if (!endpoint) throw new Error('Wrangler не вернул адрес workers.dev. Проверьте поддомен в Cloudflare.');
    return new URL(endpoint);
  } finally {
    await unlink(secretPath).catch(() => {});
    await rmdir(directory);
  }
}
