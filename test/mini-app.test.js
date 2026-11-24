import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { createMiniApp, telegramUser } from '../src/mini-app.js';
import { createProfilePhotos } from '../src/profile-photo.js';
import { createStore } from '../src/store.js';

const token = 'test-token';
const origin = 'https://example.github.io';
const owner = { id: 10, first_name: 'Саша' };
const guest = { id: 20, first_name: 'Лера' };
const outsider = { id: 30, first_name: 'Илья' };

function signed(user, time = Date.now()) {
  const fields = new URLSearchParams({
    auth_date: String(Math.floor(time / 1000)),
    query_id: 'test',
    user: JSON.stringify(user),
  });
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const data = [...fields].map(([key, value]) => `${key}=${value}`).join('\n');
  fields.set('hash', createHmac('sha256', secret).update(data).digest('hex'));
  return fields.toString();
}

test('Mini App отклоняет просроченную и изменённую подпись Telegram', () => {
  const now = Date.now();
  assert.deepEqual(telegramUser(signed(owner, now), token, now), owner);
  assert.equal(telegramUser(signed(owner, now - 86_401_000), token, now), null);
  assert.equal(telegramUser(signed(owner, now).replace('10', '11'), token, now), null);
  assert.equal(telegramUser(`${signed(owner, now)}&query_id=test`, token, now), null);
});

test('Mini App выдаёт только свой результат и не раскрывает чужие голоса', async (context) => {
  const store = createStore(':memory:', { organizerId: owner.id });
  context.after(() => store.close());
  const sent = [];
  const handle = createMiniApp({
    store, token, origin,
    api: async (method, fields) => sent.push({ method, ...fields }),
    profilePhoto: async (id) => id === owner.id ? 'data:image/jpeg;base64,SGk=' : null,
  });
  async function submit(input, user, requestOrigin = origin) {
    const headers = { origin: requestOrigin };
    if (user) headers.authorization = `tma ${signed(user)}`;
    const result = await handle(new Request(origin, { method:'POST', headers, body: JSON.stringify(input) }));
    return { status: result.status, body: await result.json() };
  }

  assert.equal((await submit({ action: 'list' })).status, 401);
  assert.equal((await submit({ action: 'list' }, owner, 'https://example.org')).status, 403);
  assert.equal((await submit({ action: 'list' }, guest)).body.canCreate, false);
  assert.equal((await submit({ action: 'create', title: 'Новый год' }, guest)).status, 400);
  const { body: initial } = await submit({ action: 'list' }, owner);
  assert.equal(initial.events.length, 1);
  assert.equal(initial.events[0].title, 'НГ 202(sex)7');
  const event = initial.events[0].id;
  assert.equal((await submit({ action: 'list' }, owner)).body.events[0].id, event);
  assert.equal((await submit({ action: 'create', title: 'Новый год' }, owner)).body.id, event);
  const invitation = (await submit({ action: 'event', event }, outsider)).body;
  assert.equal(invitation.invited, true);
  assert.equal(invitation.participants, undefined);
  assert.equal((await submit({ action: 'list' }, guest)).body.events[0].id, event);
  const entered = (await submit({ action: 'event', event }, guest)).body;
  assert.equal(entered.organizer, false);
  assert.equal(entered.budget, 2500);
  assert.equal(entered.amount, 2500);
  assert.equal(entered.surprise, true);
  assert.equal((await submit({ action: 'remove', event, target: guest.id }, guest)).status, 400);
  assert.equal(entered.participants.find((person) => person.self).name, guest.first_name);
  assert.equal((await submit({ action: 'open', event }, guest)).body.participants.length, 2);
  const product = 'https://www.ozon.ru/product/123456/';
  assert.equal((await submit({ action: 'wish', event, wish: product }, outsider)).status, 400);
  assert.equal((await submit({ action: 'wish', event, wish: 'я'.repeat(501) }, guest)).status, 400);
  assert.equal((await submit({ action: 'wish', event, wish: ` ${product} `, target: owner.id }, guest)).body.wish, product);
  const beforeDraw = (await submit({ action: 'event', event }, owner)).body;
  assert.equal(beforeDraw.wish, '');
  assert.equal(beforeDraw.recipient, null);
  assert.ok(beforeDraw.participants.every((person) => !Object.hasOwn(person, 'wish')));
  assert.equal((await submit({ action: 'avatar', event, target: owner.id }, outsider)).status, 400);
  assert.equal((await submit({ action: 'avatar', event, target: outsider.id }, owner)).status, 400);
  assert.equal((await submit({ action: 'avatar', event, target: owner.id }, guest)).body.photo, 'data:image/jpeg;base64,SGk=');
  assert.equal((await submit({ action: 'avatar', event, target: guest.id }, owner)).body.photo, null);
  assert.equal((await submit({ action: 'open', event }, outsider)).status, 200);
  assert.equal((await submit({ action: 'remove', event, target: outsider.id }, owner)).status, 200);
  assert.equal((await submit({ action: 'list' }, outsider)).body.events.length, 0);
  assert.equal((await submit({ action: 'open', event }, outsider)).status, 400);
  assert.equal((await submit({ action: 'budget', event, amount: 900 }, owner)).status, 400);
  assert.equal((await submit({ action: 'budget', event, amount: 5100 }, owner)).status, 400);
  assert.equal((await submit({ action: 'budget', event, amount: 5000 }, owner)).body.budget, 5000);
  await submit({ action: 'budget', event, amount: 1900 }, owner);
  const interim = (await submit({ action: 'event', event }, guest)).body;
  assert.equal(interim.amount, 2200);
  const vote = (await submit({ action: 'budget', event, amount: 2600 }, guest)).body;
  assert.equal(vote.amount, 2250);
  assert.ok(vote.participants.every((person) => !Object.hasOwn(person, 'budget')));
  const renamed = { ...guest, first_name: 'Валерия', username: 'valeria' };
  const reopened = (await submit({ action: 'open', event }, renamed)).body;
  assert.equal(reopened.budget, 2600);
  assert.equal(reopened.wish, product);
  assert.deepEqual(reopened.participants.filter((person) => person.id === guest.id).map((person) => person.name), ['Валерия']);
  assert.equal((await submit({ action: 'draw', event }, guest)).status, 400);
  const draw = (await submit({ action: 'draw', event }, owner)).body;
  assert.deepEqual(draw.recipient, { id: guest.id, name: renamed.first_name, username: renamed.username, wish: product, surprise: false });
  assert.equal(sent.length, 0);
  assert.equal((await submit({ action: 'event', event }, outsider)).body.recipient, undefined);
  assert.equal((await submit({ action: 'open', event }, outsider)).body.invited, true);
  assert.equal(store.member(event, outsider.id), undefined);
  const result = (await submit({ action: 'event', event }, guest)).body.recipient;
  assert.equal(result.name, owner.first_name);
  assert.equal(result.wish, '');
  assert.equal(result.surprise, true);
  await submit({ action: 'wish', event, wish: 'Настольная игра для компании' }, owner);
  assert.equal((await submit({ action: 'event', event }, guest)).body.recipient.wish, 'Настольная игра для компании');
  await submit({ action: 'wish', event, wish: '', surprise: true }, owner);
  const surpriseResult = (await submit({ action: 'event', event }, guest)).body.recipient;
  assert.equal(surpriseResult.wish, '');
  assert.equal(surpriseResult.surprise, true);
  await submit({ action: 'wish', event, wish: 'Конкретный подарок' }, owner);
  await submit({ action: 'wish', event, wish: '' }, owner);
  assert.equal((await submit({ action: 'event', event }, guest)).body.recipient.surprise, true);
  assert.equal((await submit({ action: 'avatar', event, target: result.id }, guest)).body.photo, 'data:image/jpeg;base64,SGk=');
  assert.equal((await submit({ action: 'redraw', event, round: 1 }, guest)).status, 400);
  const { body: redrawn } = await submit({ action: 'redraw', event, round: 1 }, owner);
  assert.equal(redrawn.round, 2);
  assert.equal(redrawn.amount, 2250);
  assert.equal((await submit({ action: 'redraw', event, round: 1 }, owner)).status, 400);
  assert.equal((await submit({ action: 'reset-draw', event, round: 2 }, guest)).status, 400);
  assert.equal((await submit({ action: 'reset-draw', event, round: 1 }, owner)).status, 400);
  const { body: reset } = await submit({ action: 'reset-draw', event, round: 2 }, owner);
  assert.equal(reset.status, 'open');
  assert.equal(reset.recipient, null);
  assert.equal(reset.participants.length, 2);
  assert.equal(reset.budget, 1900);
  const resetGuest = (await submit({ action: 'event', event }, guest)).body;
  assert.equal(resetGuest.recipient, null);
  assert.equal(resetGuest.wish, product);
  assert.equal((await submit({ action: 'reset-draw', event, round: 2 }, owner)).status, 400);
  assert.equal((await submit({ action: 'redraw', event, round: 2 }, owner)).status, 400);
  assert.equal((await submit({ action: 'draw', event }, owner)).status, 400);
  assert.equal((await submit({ action: 'budget', event, amount: 3100 }, guest)).body.amount, 2500);
  const { body: newDraw } = await submit({ action: 'draw', event, round: reset.round }, owner);
  assert.equal(newDraw.status, 'drawn');
  assert.equal(newDraw.round, 3);
  assert.equal(newDraw.amount, 2500);
  assert.equal(newDraw.recipient.wish, product);
  assert.equal((await submit({ action: 'reset-draw', event, round: 2 }, owner)).status, 400);
  assert.equal(sent.length, 0);
  assert.deepEqual((await submit({ action: 'list' }, owner)).body.events.map(({id}) => id), [event]);
});

test('Сервер запрашивает последнее фото профиля и кэширует миниатюру', async () => {
  const calls = [];
  const photo = createProfilePhotos({
    token,
    api: async (method, fields) => {
      calls.push([method, fields]);
      return method === 'getUserProfilePhotos'
        ? { photos: [[{ file_id: 'avatar', width: 160, file_size: 4 }]] }
        : { file_path: 'photos/file_1.jpg' };
    },
    fetchFile: async (url) => {
      assert.equal(url, `https://api.telegram.org/file/bot${token}/photos/file_1.jpg`);
      return new Response(Uint8Array.of(255, 216, 255, 217));
    },
  });
  const results = await Promise.all([photo(owner.id), photo(owner.id)]);
  assert.deepEqual(results, ['data:image/jpeg;base64,/9j/2Q==', 'data:image/jpeg;base64,/9j/2Q==']);
  assert.deepEqual(calls, [
    ['getUserProfilePhotos', { user_id: owner.id, limit: 1 }],
    ['getFile', { file_id: 'avatar' }],
  ]);
});
