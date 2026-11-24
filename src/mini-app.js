import { createHmac, timingSafeEqual } from 'node:crypto';
import { sendDrawResult } from './bot.js';
import { average, SantaError, userName } from './store-data.js';
import { exchangeTitle } from '../docs/app/config.js';
import { budget } from '../docs/budget/settings.js';

const eventId = /^[\w-]{16}$/;
const demoUser = { id: 1, first_name: 'Саша' };
const demoParticipant = { id: 5, first_name: 'Миша' };
const demoGuests = [
  [{ id: 2, first_name: 'Лера' }, 2400],
  [{ id: 3, first_name: 'Илья' }, 3300],
  [{ id: 4, first_name: 'Настя' }, 2900],
];

export function telegramUser(data, token, now = Date.now()) {
  const entries = new URLSearchParams(data);
  if (entries.size !== new Set(entries.keys()).size) return null;
  const hash = entries.get('hash');
  if (!hash || !/^[a-f\d]{64}$/i.test(hash)) return null;
  entries.delete('hash');
  entries.sort();
  const check = [...entries].map(([name, value]) => `${name}=${value}`).join('\n');
  const key = createHmac('sha256', 'WebAppData').update(token).digest();
  const expected = createHmac('sha256', key).update(check).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) return null;

  const sent = Number(entries.get('auth_date'));
  const age = Math.floor(now / 1000) - sent;
  if (!Number.isSafeInteger(sent) || age < -60 || age > 86400) return null;
  try {
    const user = JSON.parse(entries.get('user'));
    return Number.isSafeInteger(user?.id) && user.id > 0 && typeof user.first_name === 'string'
      ? user : null;
  } catch {
    return null;
  }
}

export function createMiniApp({ store, api, token, origin, profilePhoto, demo = false }) {
  let latestDemo;
  const setupDemo = () => {
    const { id } = store.create(exchangeTitle, demoUser);
    for (const [guest, value] of demoGuests) {
      store.join(id, guest);
      store.setBudget(id, guest.id, value);
    }
    latestDemo = id;
    return id;
  };
  if (demo) setupDemo();

  function summary(event, user) {
    return {
      id: event.id,
      title: event.title,
      status: event.status,
      round: event.draw_round,
      organizer: event.owner_id === user.id,
    };
  }

  function getEvent(id, user) {
    const event = store.event(id);
    if (!event) throw new SantaError('Обмен не найден. Проверьте ссылку-приглашение.');
    const info = summary(event, user);
    const member = store.member(id, user.id);
    if (!member) return { ...info, invited: true };

    const roster = store.roster(id);
    const recipient = roster.find((person) => person.user_id === member.recipient_id);
    return {
      ...info,
      budget: member.budget ?? budget.initial,
      amount: event.amount ?? average(roster),
      participants: roster.map((person) => ({
        id: person.user_id,
        name: person.name,
        username: person.username,
        organizer: person.user_id === event.owner_id,
        self: person.user_id === user.id,
      })),
      recipient: recipient ? { id: recipient.user_id, name: recipient.name, username: recipient.username } : null,
    };
  }

  async function action({ action: kind, event: requestedId, amount, title, target, round }, user) {
    if (kind === 'list') {
      const organizerExchange = store.ensureOrganizerExchange(user);
      if (organizerExchange) return { events: [summary(organizerExchange, user)], name: userName(user), canCreate: true };
      const current = store.organizerExchange();
      if (current?.status === 'open' && !store.wasRemoved(current.id, user.id)) store.join(current.id, user);
      return { name: userName(user), canCreate: store.canCreate(user.id), events: store.list(user.id).map((event) => summary(event, user)) };
    }
    if (kind === 'create') return getEvent(store.create(title, user).id, user);
    if (kind === 'demo' && demo && user.id === demoUser.id) return getEvent(setupDemo(), user);
    const id = requestedId ?? (demo && kind === 'open' ? latestDemo : undefined);
    if (typeof id !== 'string' || !eventId.test(id)) throw new SantaError('Выберите обмен.');
    if (kind === 'event') return getEvent(id, user);
    if (kind === 'open') {
      const current = store.event(id);
      if (current?.status === 'open' || store.member(id, user.id)) store.join(id, user);
      return getEvent(id, user);
    }
    if (kind === 'join') {
      store.join(id, user);
      return getEvent(id, user);
    }
    if (!store.member(id, user.id)) throw new SantaError('Сначала присоединитесь к обмену.');
    if (kind === 'avatar') {
      if (!Number.isSafeInteger(target) || !store.member(id, target)) {
        throw new SantaError('Участник не найден.');
      }
      const photo = await profilePhoto?.(target);
      return { photo: store.member(id, user.id) && store.member(id, target) ? photo ?? null : null };
    }
    if (kind === 'budget') store.setBudget(id, user.id, amount);
    else if (kind === 'remove' && Number.isSafeInteger(target)) {
      store.remove(id, user.id, target);
    } else if (kind === 'draw' || (kind === 'redraw' && Number.isSafeInteger(round) && round > 0)) {
      const previousRound = kind === 'draw' ? 0 : round;
      const givers = store.draw(id, user.id, previousRound);
      if (!demo && !store.fixedExchange) {
        for (const userId of givers) {
          try {
            await sendDrawResult({ api, store, id, userId, round: previousRound + 1 });
          } catch (error) {
            console.error(`Telegram не доставил результат жеребьёвки: ${error.message}`);
          }
        }
      }
    } else throw new SantaError('Действие недоступно.');
    return getEvent(id, user);
  }

  return async (request) => {
    const headers = { 'Cache-Control': 'no-store' };
    const json = (status, value) => Response.json(value, { status, headers });
    if (!demo && request.headers.get('Origin') !== origin) return json(403, { error: 'Откройте Тайного Санту в Telegram.' });
    if (!demo) Object.assign(headers, { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: {
        ...headers,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      } });
    }
    if (request.method !== 'POST') return json(405, { error: 'Откройте приложение.' });

    const authorization = request.headers.get('Authorization');
    const user = demo ? demoUser
      : authorization?.startsWith('tma ') ? telegramUser(authorization.slice(4), token) : null;
    if (!user) return json(401, { error: 'Откройте приложение заново из чата с ботом.' });

    try {
      const input = await readJson(request, 4096);
      const viewer = demo && input.demoRole === 'participant' ? demoParticipant : user;
      return json(200, await action(input, viewer));
    } catch (error) {
      if (error instanceof SantaError) return json(400, { error: error.message });
      console.error(error.message);
      return json(500, { error: 'Не удалось выполнить действие. Попробуйте ещё раз.' });
    }
  };
}

export async function readJson(request, maxBytes) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request.body ?? []) {
    length += chunk.length;
    if (length > maxBytes) throw new SantaError('Запрос слишком длинный.');
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch {
    throw new SantaError('Запрос не распознан.');
  }
  throw new SantaError('Запрос не распознан.');
}
