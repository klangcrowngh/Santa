import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBot } from '../src/bot.js';
import { createStore } from '../src/store.js';

const organizer = { id: 123, first_name: 'Аня' };
const guest = { id: 456, first_name: 'Илья', username: 'ilya' };
const stranger = { id: 789, first_name: 'Маша' };

function setup(context) {
  const calls = [];
  const store = createStore(':memory:');
  context.after(() => store.close());
  const handle = createBot({
    store,
    username: 'sample_santa_bot',
    miniAppUrl: 'https://example.github.io/santa/app/',
    api: async (method, fields) => calls.push({ method, ...fields }),
  });
  const message = (from) => ({ from, chat: { id: from.id, type: 'private' }, message_id: 10 });
  return {
    calls,
    store,
    text: (from, text) => handle({ message: { ...message(from), text } }),
    click: (from, data) => handle({ callback_query: { id: 'query', from, data, message: message(from) } }),
    vote: (from, event, amount) => handle({
      message: { ...message(from), web_app_data: { data: JSON.stringify({ event, amount }) } },
    }),
  };
}

test('приглашение, оба способа голосования и приватная жеребьёвка', async (context) => {
  const { calls, store, text, click, vote } = setup(context);
  await text(organizer, '/start');
  await click(organizer, 'new-chat');
  await text(organizer, 'Обмен <для друзей>');
  const [{ id }] = store.list(organizer.id);
  assert.match(calls.at(-1).text, /&lt;для друзей&gt;/);

  await text(organizer, '/link');
  assert.match(calls.at(-1).text, new RegExp(`https://t.me/sample_santa_bot\\?startapp=${id}`));
  await text(guest, `/start ${id}`);
  assert.equal(store.member(id, guest.id), undefined);
  await click(organizer, `draw:${id}`);
  assert.equal(store.event(id).status, 'open');
  assert.match(calls.at(-1).text, /хотя бы два участника/);
  await click(guest, `j:${id}`);
  assert.equal(store.roster(id).length, 2);

  await click(organizer, `v:${id}:3100`);
  await click(organizer, `s:${id}:3100`);
  await click(guest, `b:${id}`);
  const slider = new URL(calls.at(-1).reply_markup.inline_keyboard[0][0].web_app.url);
  assert.equal(slider.pathname, '/santa/app/');
  assert.equal(slider.searchParams.get('event'), id);
  assert.equal(slider.searchParams.get('view'), 'budget');
  await vote(stranger, id, 1500);
  assert.equal(store.member(id, stranger.id), undefined);
  await vote(guest, id, 1350);
  assert.equal(store.member(id, guest.id).budget, null);
  await vote(guest, id, 1500);
  assert.equal(store.member(id, guest.id).budget, 1500);
  assert.match(calls.at(-1).text, /Общий ориентир/);

  await click(guest, `draw:${id}`);
  assert.equal(store.event(id).status, 'open');
  await click(organizer, `d:${id}`);
  assert.match(calls.at(-1).text, /Провести жеребьёвку\?/);
  await click(organizer, `draw:${id}`);
  assert.equal(store.event(id).amount, 2300);
  const outcomes = calls.filter((call) => call.protect_content);
  assert.equal(outcomes.length, 2);
  assert.match(outcomes.find((call) => call.chat_id === organizer.id).text, /Илья/);
  assert.doesNotMatch(outcomes.find((call) => call.chat_id === organizer.id).text, /Аня/);
  assert.match(outcomes.find((call) => call.chat_id === guest.id).text, /Аня/);

  await click(organizer, `draw:${id}`);
  assert.equal(calls.filter((call) => call.protect_content).length, 2);
  await click(stranger, `result:${id}`);
  assert.equal(calls.filter((call) => call.protect_content).length, 2);
  await click(guest, `result:${id}`);
  assert.equal(calls.at(-1).protect_content, true);
  await vote(guest, id, 1600);
  assert.equal(store.member(id, guest.id).budget, 1500);
});

test('организатор управляет составом, а случайные назначения уникальны', (context) => {
  const { store } = setup(context);
  const { id } = store.create('Новый год', organizer);
  store.join(id, guest);
  store.join(id, stranger);
  assert.throws(() => store.remove(id, guest.id, stranger.id), /только организатор/);
  assert.throws(() => store.remove(id, stranger.id, stranger.id), /только организатор/);
  store.remove(id, organizer.id, stranger.id);
  assert.equal(store.roster(id).length, 2);
  store.join(id, stranger);
  const participantIds = [organizer.id, guest.id, stranger.id, 900, 901];
  for (const userId of participantIds) {
    store.join(id, { id: userId });
  }
  store.draw(id, organizer.id);
  assert.equal(store.event(id).amount, 2500);
  const people = store.roster(id);
  assert.ok(people.every((person) => person.user_id !== person.recipient_id));
  assert.deepEqual(new Set(people.map((person) => person.recipient_id)), new Set(participantIds));
  store.draw(id, organizer.id, 1);
  const newRound = store.roster(id);
  assert.ok(newRound.some((person, index) => person.recipient_id !== people[index].recipient_id));
  assert.ok(newRound.every((person) => person.user_id !== person.recipient_id));
  assert.deepEqual(new Set(newRound.map((person) => person.recipient_id)), new Set(participantIds));
});
