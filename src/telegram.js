import { setTimeout as delay } from 'node:timers/promises';

export const telegramUpdates = ['message', 'callback_query'];

export function createTelegramApi(token, { signal } = {}) {
  return async (method, fields = {}) => {
    for (let attempt = 0; ; attempt++) {
      let result;
      try {
        const timeout = AbortSignal.timeout(35_000);
        const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(fields),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        result = await response.json();
      } catch {
        throw new Error(`Нет ответа от Telegram (${method}).`);
      }
      if (result.ok) return result.result;
      if (method === 'editMessageText' && result.description?.includes('message is not modified')) return;
      const retry = result.parameters?.retry_after;
      if (result.error_code === 429 && attempt < 2 && retry > 0 && retry <= 10) {
        await delay(retry * 1000, undefined, { signal });
        continue;
      }
      const error = new Error(`Telegram ${method} (${result.error_code}): ${result.description}`);
      error.status = result.error_code;
      throw error;
    }
  };
}

export async function configureTelegramMenu(api, miniAppUrl) {
  await api('setMyCommands', {
    commands: [
      { command: 'start', description: 'Открыть Тайного Санту' },
      { command: 'new', description: 'Создать обмен' },
      ...(miniAppUrl ? [{ command: 'link', description: 'Ссылка на обмен для беседы' }] : []),
      { command: 'cancel', description: 'Вернуться в меню' },
    ],
  });
  if (miniAppUrl) {
    await api('setChatMenuButton', {
      menu_button: { type: 'web_app', text: 'Тайный Санта', web_app: { url: miniAppUrl.href } },
    });
  }
}
