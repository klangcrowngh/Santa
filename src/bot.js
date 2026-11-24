import { budget, clampBudget, isBudget, price } from '../docs/budget/settings.js';
import { average, drawReady, SantaError } from './store-data.js';
import { exchangeTitle } from '../docs/app/config.js';

const button = (text, callback_data) => ({ text, callback_data });
const back = (id) => [button('‹ К обмену', `e:${id}`)];
const home = [button('‹ Мои обмены', 'home')];
const escape = (value) => value.replace(/[&<>]/g, (character) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[character]
));
const title = (event) => `🎄 <b>${escape(event.title)}</b>`;
const name = (person) => escape(person.name + (person.username ? ` (@${person.username})` : ''));

export function createBot({ api, store, username, miniAppUrl }) {
  const simpleChat = store.fixedExchange && miniAppUrl;
  const welcome = `Привет! 🎁 Приглашаю тебя в Тайного Санту «${exchangeTitle}».\n\nНажми «Тайный Санта» внизу чата, чтобы участвовать.`;
  function appButton(text, eventId, view) {
    const url = new URL(miniAppUrl);
    if (eventId) url.searchParams.set('event', eventId);
    if (view) url.searchParams.set('view', view);
    return { text, web_app: { url: url.href } };
  }

  function card(context, text, rows) {
    const fields = { text, parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } };
    return context.messageId
      ? api('editMessageText', { chat_id: context.user.id, message_id: context.messageId, ...fields })
      : api('sendMessage', { chat_id: context.user.id, ...fields });
  }

  function send(userId, text, fields = {}) {
    return api('sendMessage', { chat_id: userId, text, ...fields });
  }

  function requireMember(id, userId) {
    const person = store.member(id, userId);
    if (!person) throw new SantaError('Этот обмен доступен его участникам.');
    return person;
  }

  function showHome(context, requestedPage = 0) {
    const current = store.ensureOrganizerExchange(context.user);
    if (current) return showEvent(context, current);
    const events = store.list(context.user.id);
    const { start, navigation } = paginate(events.length, 8, requestedPage, 'home:');
    const canCreate = !store.fixedExchange && store.canCreate(context.user.id);
    const rows = canCreate ? [[button('＋ Создать обмен', 'new')]] : [];
    if (miniAppUrl) rows.unshift([appButton('🎄 Открыть Тайного Санту')]);
    for (const event of events.slice(start, start + 8)) {
      rows.push([button(`${event.status === 'open' ? '🎄' : '🎁'} ${event.title}`, `e:${event.id}`)]);
    }
    if (navigation.length) rows.push(navigation);
    const note = events.length ? 'Выберите обмен.'
      : canCreate ? 'Создайте обмен для друзей или откройте ссылку от организатора.'
      : 'Откройте ссылку на обмен из беседы.';
    return card(context, `🎁 <b>Тайный Санта</b>\n\n${note}`, rows);
  }

  function showEvent(context, event, note = '') {
    const { id, status, owner_id: ownerId } = event;
    const userId = context.user.id;
    const person = requireMember(id, userId);
    const people = store.roster(id);
    const open = status === 'open';
    const organizer = ownerId === userId;
    const lines = [title(event), '', open ? '🟢 <b>Сбор участников</b>' : '✨ <b>Жеребьёвка прошла</b>'];
    const rows = [[button(`👥 Участники · ${people.length}`, `p:${id}:0`)]];

    if (open) {
      lines.push(`Ваш бюджет · <b>${price(person.budget ?? budget.initial)}</b>`);
      lines.push(`Общий ориентир · <b>${price(average(people))}</b>`);
      rows.unshift([button('💰 Изменить бюджет', `b:${id}`)]);
      if (organizer) {
        if (!miniAppUrl) rows.push([button('🔗 Пригласить друзей', `i:${id}`)]);
        if (people.length >= 2) {
          rows.push([button('🎲 Провести жеребьёвку', `d:${id}`)]);
        } else {
          lines.push('Для жеребьёвки нужны хотя бы два участника.');
        }
      }
    } else {
      lines.push(`Бюджет подарка · <b>${price(event.amount)}</b>`);
      rows.unshift([button('🎁 Узнать, кому дарю', `result:${id}`)]);
      if (organizer) rows.push([button('🔄 Переиграть жеребьёвку', `redraw:${id}`)]);
    }
    if (miniAppUrl) rows.unshift([appButton('🎄 Открыть обмен', id)]);
    if (note) lines.push('', note);
    return card(context, lines.join('\n'), [...rows, home]);
  }

  function showInvite(context, event) {
    const start = miniAppUrl ? 'startapp' : 'start';
    const link = `https://t.me/${username}?${start}=${event.id}`;
    const share = new URL('https://t.me/share/url');
    share.searchParams.set('url', link);
    share.searchParams.set('text', '🎁 Присоединяйся к нашему Тайному Санте!');
    return card(context, `${title(event)}\n\n<b>Приглашение</b>\nОтправьте ссылку друзьям.\n\n${link}`, [
      [{ text: '↗ Поделиться ссылкой', url: share.href }],
      back(event.id),
    ]);
  }

  function showPeople(context, event, requestedPage) {
    const people = store.roster(event.id);
    const organizer = context.user.id === event.owner_id && event.status === 'open';
    const { start, navigation } = paginate(people.length, 8, requestedPage, `p:${event.id}:`);
    const visible = people.slice(start, start + 8);
    const lines = [title(event), '', `👥 <b>Участники · ${people.length}</b>`, ''];
    const removalRows = [];
    for (const person of visible) {
      const role = person.user_id === event.owner_id ? ' · организатор' : '';
      lines.push(`• ${name(person)}${role}`);
      if (organizer && person.user_id !== event.owner_id) {
        removalRows.push([button(`Убрать: ${Array.from(person.name).slice(0, 28).join('')}`, `r:${event.id}:${person.user_id}`)]);
      }
    }
    const rows = navigation.length ? [...removalRows, navigation] : removalRows;
    return card(context, lines.join('\n'), [...rows, back(event.id)]);
  }

  function showBudget(context, event, amount) {
    const { id } = event;
    const current = requireMember(id, context.user.id).budget;
    const value = amount ?? clampBudget(current ?? budget.initial);
    if (!isBudget(value)) throw new SantaError('Выберите сумму в пределах шкалы бюджета.');
    const adjust = (change, label) => {
      const next = clampBudget(value + change);
      return button(label, `v:${id}:${next}`);
    };
    const lines = [
      title(event),
      '',
      '💰 <b>Сколько вам комфортно потратить?</b>',
      `Выбрано · <b>${price(value)}</b>`,
      `От ${price(budget.min)} до ${price(budget.max)}.`,
      '',
      `Общий бюджет — среднее по участникам. Если сумму не меняли, учитывается ${price(budget.initial)}.`,
    ];
    const rows = [
      [adjust(-1000, '−1 000'), adjust(-100, '−100'), adjust(100, '+100'), adjust(1000, '+1 000')],
      [button('✓ Сохранить бюджет', `s:${id}:${value}`)],
      back(id),
    ];
    if (miniAppUrl) rows.unshift([appButton('🎚 Открыть ползунок', id, 'budget')]);
    return card(context, lines.join('\n'), rows);
  }

  function sendResult(id, userId) {
    const person = requireMember(id, userId);
    if (person.recipient_id === null) throw new SantaError('Сначала дождитесь жеребьёвки.');
    return sendDrawResult({ store, api, id, userId });
  }

  async function finishDraw(context, event, previousRound = 0) {
    const givers = store.draw(event.id, context.user.id, previousRound);
    let failed = 0;
    for (const userId of givers) {
      try {
        await sendDrawResult({ api, store, id: event.id, userId, round: previousRound + 1 });
      } catch {
        failed++;
      }
    }
    const note = failed
      ? `Доставлено личных сообщений: ${givers.length - failed} из ${givers.length}. Каждый участник может найти свой результат в карточке обмена.`
      : 'Каждый участник получил свой результат в личном сообщении.';
    return showEvent(context, store.event(event.id), note);
  }

  async function onClick(context, data) {
    const [action, id, argument] = data.split(':');
    const userId = context.user.id;
    if (action === 'home') {
      store.cancelTitle(userId);
      return showHome(context, Number(id));
    }
    if ((action === 'new' || action === 'new-chat') && !store.canCreate(userId)) {
      throw new SantaError('Создавать обмен может только организатор.');
    }
    if ((action === 'new' || action === 'new-chat') && store.fixedExchange) {
      return showEvent(context, store.ensureOrganizerExchange(context.user));
    }
    if (action === 'new') {
      if (miniAppUrl) {
        return card(context, '🎄 <b>Новый обмен</b>\n\nОткройте приложение, чтобы создать обмен.', [
          [appButton('Создать обмен', null, 'create')],
          [button('Продолжить в чате', 'new-chat')],
          home,
        ]);
      }
    }
    if (action === 'new' || action === 'new-chat') {
      store.requestTitle(userId);
      return card(context, '🎄 <b>Новый обмен</b>\n\nНапишите название, например «Новый год с друзьями».', [home]);
    }
    if (!id || !/^[\w-]{16}$/.test(id)) throw new SantaError('Откройте карточку обмена.');
    const event = store.event(id);
    if (!event) throw new SantaError('Обмен не найден.');
    if (action === 'j') {
      store.join(id, context.user);
      return showEvent(context, event);
    }
    requireMember(id, userId);
    if (action === 'e') return showEvent(context, event);
    if (action === 'p') return showPeople(context, event, Number(argument));
    if (action === 'result') return sendResult(id, userId);
    if (event.status === 'drawn' && userId === event.owner_id && action === 'redraw') {
      return card(context, `${title(event)}\n\n🔄 <b>Переиграть жеребьёвку?</b>\nПредыдущие назначения заменятся. Бот отправит результаты нового раунда.`, [
        [button('🔄 Подтвердить', `redraw-ok:${id}:${event.draw_round}`)],
        back(id),
      ]);
    }
    if (event.status === 'drawn' && userId === event.owner_id && action === 'redraw-ok') {
      return finishDraw(context, event, Number(argument));
    }
    if (event.status !== 'open') return showEvent(context, event);
    if (action === 'b') return showBudget(context, event);
    if (action === 'v') return showBudget(context, event, Number(argument));
    if (action === 'm') return showBudget(context, event, Number(argument));
    if (action === 's') {
      store.setBudget(id, userId, Number(argument));
      return showEvent(context, event, '✓ Ваш бюджет сохранён.');
    }
    if (action === 'r' || action === 'remove') {
      const target = store.member(id, Number(argument));
      if (!target) return showPeople(context, event, 0);
      if (target.user_id === event.owner_id || userId !== event.owner_id) {
        throw new SantaError('Это действие недоступно.');
      }
      if (action === 'r') {
        const question = `Убрать участника <b>${name(target)}</b>?`;
        return card(context, `${title(event)}\n\n${question}`, [
          [button('Убрать участника', `remove:${id}:${target.user_id}`)],
          back(id),
        ]);
      }
      store.remove(id, userId, target.user_id);
      return showPeople(context, event, 0);
    }
    if (userId !== event.owner_id) throw new SantaError('Это действие доступно организатору.');
    if (action === 'i') return showInvite(context, event);
    if (action === 'draw') return finishDraw(context, event);
    if (action === 'd') {
      drawReady(store.roster(id));
      return card(context, `${title(event)}\n\n🎲 <b>Провести жеребьёвку?</b>\nСостав и бюджет зафиксируются. Бот отправит каждому имя получателя в личном сообщении.`, [
        [button('🎲 Подтвердить жеребьёвку', `draw:${id}`)],
        back(id),
      ]);
    }
    throw new SantaError('Откройте актуальную карточку обмена.');
  }

  async function onMessage(message) {
    const context = { user: message.from };
    const userId = context.user.id;
    if (message.web_app_data) {
      try {
        let vote;
        try {
          vote = JSON.parse(message.web_app_data.data);
        } catch {
          throw new SantaError('Откройте ползунок заново и повторите выбор.');
        }
        if (!vote || typeof vote.event !== 'string' || !/^[\w-]{16}$/.test(vote.event)) {
          throw new SantaError('Откройте ползунок из карточки обмена.');
        }
        store.setBudget(vote.event, userId, vote.amount);
        await send(userId, `✓ Бюджет сохранён · ${price(vote.amount)}`, {
          reply_markup: { remove_keyboard: true },
        });
        return showEvent(context, store.event(vote.event));
      } catch (error) {
        if (!(error instanceof SantaError)) throw error;
        return send(userId, error.message, { reply_markup: { remove_keyboard: true } });
      }
    }
    const text = message.text?.trim();
    if (!text) return;
    if (text === 'Закрыть ползунок') {
      return send(userId, 'Ползунок закрыт.', { reply_markup: { remove_keyboard: true } });
    }
    const [command, parameter] = text.split(/\s+/, 2);
    if (command === '/start' || command === '/menu') {
      store.cancelTitle(userId);
      if (command === '/start' && parameter) {
        const event = store.event(parameter);
        if (!event) throw new SantaError('Обмен не найден. Проверьте ссылку-приглашение.');
        if (store.member(event.id, userId)) return showEvent(context, event);
        if (event.status !== 'open') throw new SantaError('Жеребьёвка уже прошла. Запись закрыта.');
        const entry = miniAppUrl ? appButton('🎁 Открыть обмен', event.id) : button('🎁 Присоединиться', `j:${event.id}`);
        const rows = [[entry], home];
        return card(context, `${title(event)}\n\nВас пригласили в обмен подарками.`, rows);
      }
      return showHome(context);
    }
    if (command === '/link' && miniAppUrl) {
      store.ensureOrganizerExchange(context.user);
      const event = store.list(userId).find((item) => item.owner_id === userId && item.status === 'open');
      if (!event) throw new SantaError(store.fixedExchange ? 'Ссылка доступна организатору открытого обмена.' : 'Сначала создайте обмен командой /new.');
      return showInvite(context, event);
    }
    if (command === '/new') return onClick(context, 'new');
    if (command === '/cancel') {
      store.cancelTitle(userId);
      return showHome(context);
    }
    if (!store.needsTitle(userId) || command.startsWith('/')) return showHome(context);
    const eventTitle = text.replace(/\s+/g, ' ');
    if (Array.from(eventTitle).length > 48) {
      throw new SantaError('Название должно быть не длиннее 48 символов.');
    }
    return showEvent(context, store.create(eventTitle, context.user));
  }

  return async function handleUpdate(update) {
    const query = update.callback_query;
    const message = query?.message ?? update.message;
    const user = query?.from ?? message?.from;
    if (message?.chat.type !== 'private' || !user || message.chat.id !== user.id) return;
    if (query) {
      await api('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});
    }
    try {
      if (simpleChat) {
        if (query) return card({ user, messageId: message.message_id }, escape(welcome), []);
        const command = message.text?.trim().split(/\s+/, 1)[0];
        if (['/start', '/new', '/link', '/menu', '/help'].includes(command)) return send(user.id, welcome);
        return;
      }
      return await (query
        ? onClick({ user, messageId: message.message_id }, query.data ?? '')
        : onMessage(message));
    } catch (error) {
      if (!(error instanceof SantaError)) throw error;
      return send(user.id, error.message);
    }
  };
}

export function sendDrawResult({ store, api, id, userId, round }) {
  const person = store.member(id, userId);
  const event = store.event(id);
  if (round !== undefined && round !== event.draw_round) return;
  const recipient = store.member(id, person.recipient_id);
  return api('sendMessage', {
    chat_id: userId,
    text: `${title(event)}\n\nЖеребьёвка · раунд ${event.draw_round}\n🎁 <b>Вы дарите подарок</b>\n${name(recipient)}\n\nБюджет подарка · <b>${price(event.amount)}</b>`,
    parse_mode: 'HTML',
    protect_content: true,
    reply_markup: { inline_keyboard: [back(id)] },
  });
}

function paginate(total, pageSize, requested, prefix) {
  const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1);
  const page = Number.isSafeInteger(requested) ? Math.max(0, Math.min(lastPage, requested)) : 0;
  const navigation = [];
  if (page > 0) navigation.push(button('‹ Назад', `${prefix}${page - 1}`));
  if (page < lastPage) navigation.push(button('Далее ›', `${prefix}${page + 1}`));
  return { start: page * pageSize, navigation };
}
