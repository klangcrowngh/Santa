import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
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
    const request = Readable.from([Buffer.from(JSON.stringify(input))]);
    request.headers = { origin: requestOrigin, authorization: user && `tma ${signed(user)}` };
    request.method = 'POST';
    const result = {};
    const response = {
      setHeader() {},
      writeHead(status) { result.status = status; return this; },
      end(body) { result.body = JSON.parse(body); },
    };
    await handle(request, response);
    return result;
  }

  assert.equal((await submit({ action: 'list' })).status, 401);
  assert.equal((await submit({ action: 'list' }, owner, 'https://example.org')).status, 403);
  assert.equal((await submit({ action: 'list' }, guest)).body.canCreate, false);
  assert.equal((await submit({ action: 'create', title: 'Новый год' }, guest)).status, 400);
  const { body: created } = await submit({ action: 'create', title: 'Новый год' }, owner);
  const event = created.id;
  const invitation = (await submit({ action: 'event', event }, outsider)).body;
  assert.equal(invitation.invited, true);
  assert.equal(invitation.participants, undefined);
  const entered = (await submit({ action: 'open', event }, guest)).body;
  assert.equal(entered.organizer, false);
  assert.equal(entered.budget, 2500);
  assert.equal(entered.amount, 2500);
  assert.equal((await submit({ action: 'remove', event, target: guest.id }, guest)).status, 400);
  assert.equal(entered.participants.find((person) => person.self).name, guest.first_name);
  assert.equal((await submit({ action: 'open', event }, guest)).body.participants.length, 2);
  assert.equal((await submit({ action: 'avatar', event, target: owner.id }, outsider)).status, 400);
  assert.equal((await submit({ action: 'avatar', event, target: outsider.id }, owner)).status, 400);
  assert.equal((await submit({ action: 'avatar', event, target: owner.id }, guest)).body.photo, 'data:image/jpeg;base64,SGk=');
  assert.equal((await submit({ action: 'avatar', event, target: guest.id }, owner)).body.photo, null);
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
  assert.deepEqual(reopened.participants.filter((person) => person.id === guest.id).map((person) => person.name), ['Валерия']);
  assert.equal((await submit({ action: 'draw', event }, guest)).status, 400);
  const draw = (await submit({ action: 'draw', event }, owner)).body;
  assert.deepEqual(draw.recipient, { id: guest.id, name: renamed.first_name, username: renamed.username });
  assert.equal(sent.length, 2);
  assert.ok(sent.every((message) => message.protect_content));
  assert.equal((await submit({ action: 'event', event }, outsider)).body.recipient, undefined);
  assert.equal((await submit({ action: 'open', event }, outsider)).body.invited, true);
  assert.equal(store.member(event, outsider.id), undefined);
  const result = (await submit({ action: 'event', event }, guest)).body.recipient;
  assert.equal(result.name, owner.first_name);
  assert.equal((await submit({ action: 'avatar', event, target: result.id }, guest)).body.photo, 'data:image/jpeg;base64,SGk=');
  assert.equal((await submit({ action: 'redraw', event, round: 1 }, guest)).status, 400);
  const { body: redrawn } = await submit({ action: 'redraw', event, round: 1 }, owner);
  assert.equal(redrawn.round, 2);
  assert.equal(redrawn.amount, 2250);
  assert.equal((await submit({ action: 'redraw', event, round: 1 }, owner)).status, 400);
  assert.equal(sent.length, 4);
  assert.match(sent.at(-1).text, /раунд 2/);
  const { body: next } = await submit({ action: 'create', title: 'Обмен по умолчанию' }, owner);
  await submit({ action: 'open', event: next.id }, guest);
  const defaults = (await submit({ action: 'draw', event: next.id }, owner)).body;
  assert.equal(defaults.amount, 2500);
  assert.equal(defaults.status, 'drawn');
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
