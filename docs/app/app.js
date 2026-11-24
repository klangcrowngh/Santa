import { apiUrl, exchangeTitle } from './config.js';
import { budget, clampBudget, price } from '../budget/settings.js';

const demo = location.protocol === 'http:' && location.hostname === '127.0.0.1';
const telegram = window.Telegram?.WebApp;
const initData = telegram?.initData;
const endpoint = demo ? '/api/santa' : apiUrl;
const query = new URLSearchParams(location.search);
const participantPreview = demo && query.get('role') === 'participant';
const screen = document.querySelector('#screen');
const garland = document.querySelector('#holiday-garland').innerHTML;
const notice = document.querySelector('#notice');
const dialog = document.querySelector('dialog');
const tabs = { people: 'Участники', draw: 'Жеребьёвка' };
const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));
const initials = (name) => Array.from(name.trim())[0]?.toUpperCase() ?? '?';
const act = (text, action, kind = 'secondary', attr = '') =>
  `<button type="button" class="${kind}" data-action="${action}" ${attr}>${text}</button>`;

const budgetDrafts = new Map();
const savingBudgets = new Map();
const avatarRequests = new Map();
let event;
let view = 'people';
let loading = false;
let syncing = false;
let reveal = false;
let pendingConfirmation;

function status(message = '', error = false) {
  notice.textContent = message;
  notice.hidden = !message;
  notice.toggleAttribute('data-error', error);
}

async function request(action, fields = {}) {
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      signal: ['event', 'avatar', 'budget'].includes(action) ? AbortSignal.timeout?.(12_000) : undefined,
      keepalive: action === 'budget',
      headers: {
        'Content-Type': 'application/json',
        ...(demo ? {} : { Authorization: `tma ${initData}` }),
      },
      body: JSON.stringify({ action, ...fields, ...(participantPreview ? { demoRole: 'participant' } : {}) }),
    });
  } catch {
    throw new Error('Сервер недоступен. Попробуйте ещё раз.');
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Не удалось выполнить действие.');
  return result;
}

function hero(title, phase, summary, showStats = false) {
  const illustrated = title === exchangeTitle;
  return `<header class="hero${illustrated ? ' hero--illustrated' : ''}">
    <div class="snow hero-snow" aria-hidden="true"></div>
    ${showStats ? `<div class="hero-budget" role="status" aria-atomic="true">${budgetSummary()}</div>` : ''}
    <div class="hero-heading">
      ${phase ? `<p class="phase">${phase}</p>` : ''}
      <h1>${escape(title)}</h1>
      ${showStats && event.round > 0 ? `<p class="summary">Раунд ${event.round}</p>` : summary ? `<p class="summary">${summary}</p>` : ''}
    </div>
  </header>`;
}

function budgetSummary() {
  return `<span>${event.status === 'drawn' ? 'Бюджет подарка' : 'Средний бюджет'}</span>
    <strong>${event.amount === null ? '—' : price(event.amount)}</strong>`;
}

async function openCurrentExchange() {
  const { events } = await request('list');
  const next = events.find((item) => item.status === 'open') ?? events[0];
  if (next) {
    selectEvent(await request('event', { event: next.id }));
    return;
  }
  event = undefined;
  document.title = 'Тайный Санта';
  screen.innerHTML = hero('Тайный Санта', '', 'Откройте ссылку на обмен из беседы.');
}

function peoplePanel() {
  const open = event.status === 'open';
  const rows = event.participants.map((person) => {
    const notes = [person.self && 'Вы', person.organizer && 'организатор', person.username && `@${person.username}`]
      .filter(Boolean).join(' · ');
    const remove = open && event.organizer && !person.self
      ? act('×', 'remove', 'quiet remove', `data-id="${person.id}" aria-label="Убрать участника ${escape(person.name)}"`) : '';
    return `<li>
      <span class="avatar" data-photo-id="${person.id}" aria-hidden="true">${escape(initials(person.name))}</span>
      <div><strong class="person">${escape(person.name)}</strong>${notes ? `<small class="person-note">${escape(notes)}</small>` : ''}</div>
      ${remove}
    </li>`;
  }).join('');
  return `<section class="panel">
    <div class="panel-header">
      <h2>Участники · ${event.participants.length}</h2>
    </div>
    <ul class="roster">${rows}</ul>
    ${!open ? `<div class="actions">${act('Мой результат', 'draw', 'primary')}</div>` : ''}
  </section>`;
}

function loadAvatars() {
  if (demo) return;
  const id = event.id;
  for (const avatar of screen.querySelectorAll('[data-photo-id]')) {
    const target = Number(avatar.dataset.photoId);
    const key = `${id}:${target}`;
    if (!avatarRequests.has(key)) {
      avatarRequests.set(key, request('avatar', { event: id, target }).catch(() => {
        avatarRequests.delete(key);
        return {};
      }));
    }
    void avatarRequests.get(key).then(({ photo }) => {
      if (!photo || !avatar.isConnected) return;
      const image = new Image();
      image.alt = '';
      image.onload = () => avatar.replaceChildren(image);
      image.src = photo;
    });
  }
}

function budgetPanel() {
  if (event.status === 'drawn') return `<section class="panel budget-tile" id="budget">
    <div class="budget-row"><h2>Бюджет</h2><strong class="budget-value">${price(event.budget)}</strong></div>
    <p>Ваш голос зафиксирован.</p>
  </section>`;
  const value = clampBudget(budgetDrafts.get(event.id)?.amount ?? event.budget ?? budget.initial);
  return `<section class="panel budget-tile" id="budget">
    <h2><label for="amount">Бюджет</label></h2>
    <input type="range" id="amount" name="amount" min="${budget.min}" max="${budget.max}" step="${budget.step}" value="${value}" style="--filled: ${sliderFill(value)}%" aria-valuetext="${price(value)}" tabindex="-1">
    <div class="bounds"><span aria-hidden="true">${price(budget.min)}</span><output class="budget-value" for="amount" aria-live="off">${price(value)}</output><span aria-hidden="true">${price(budget.max)}</span></div>
    <p class="budget-error" role="alert" hidden></p>
  </section>`;
}

function drawPanel() {
  if (event.status === 'drawn') {
    const recipient = event.recipient;
    const match = recipient && reveal ? `<div class="result">
      <span class="label">Вы дарите подарок</span>
      <span class="avatar result-avatar" data-photo-id="${recipient.id}" aria-hidden="true">${escape(initials(recipient.name))}</span>
      <strong>${escape(recipient.name)}</strong>
      ${recipient.username ? `<span class="recipient-username">@${escape(recipient.username)}</span>` : ''}
    </div>` : '';
    return `<section class="panel">
      <h2>Результат · раунд ${event.round}</h2>
      ${match || act('Открыть мой результат', 'reveal', 'primary full')}
      ${event.organizer ? act('Переиграть жеребьёвку', 'confirm-redraw', 'secondary full') : ''}
      ${demo && event.organizer ? act('Повторить демо', 'demo', 'quiet full') : ''}
    </section>`;
  }
  const ready = event.participants.length >= 2;
  const note = ready
    ? (event.organizer ? 'После жеребьёвки каждый увидит своего получателя.' : 'Организатор запустит жеребьёвку.')
    : 'Для жеребьёвки нужны хотя бы два участника.';
  return `<section class="panel">
    <h2>Жеребьёвка</h2>
    <p>${note}</p>
    ${event.organizer ? act('Провести жеребьёвку', 'confirm-draw', 'primary full', ready ? '' : 'disabled') : ''}
  </section>`;
}

function showEvent() {
  document.title = `${event.title} · Тайный Санта`;
  if (event.invited) {
    const closed = event.status === 'drawn';
    const note = closed ? 'Запись закрыта.' : 'Вы сейчас не участвуете в обмене.';
    screen.innerHTML = hero(event.title, closed ? 'Жеребьёвка завершена' : '', note);
    return;
  }
  const navigation = Object.entries(tabs).map(([id, label]) =>
    act(label, id, '', view === id ? 'aria-current="page"' : '')).join('');
  screen.innerHTML = `${hero(event.title, '', '', true)}${budgetPanel()}${garland}
    <nav aria-label="Разделы обмена">${navigation}</nav><div class="event-panel">${eventPanel()}</div>`;
  loadAvatars();
}

function eventPanel() {
  return { people: peoplePanel, draw: drawPanel }[view]();
}

async function syncEvent() {
  if (!event || budgetDrafts.has(event.id) || document.hidden || (!demo && telegram?.isActive === false) || loading || syncing || dialog.open) return;
  const previous = event;
  syncing = true;
  try {
    const next = await request('event', { event: previous.id });
    if (loading || dialog.open || event !== previous || budgetDrafts.has(previous.id)) return;
    applyEventUpdate(next);
  } catch {
    // The next foreground refresh retries temporary network errors.
  } finally {
    syncing = false;
  }
}

function applyEventUpdate(next) {
  const previous = event;
  if (JSON.stringify(next) === JSON.stringify(previous)) return;
  event = next;
  if (next.invited || previous.invited || next.status !== previous.status || next.round !== previous.round) {
    reveal = false;
    showEvent();
    return;
  }
  if (next.amount !== previous.amount) screen.querySelector('.hero-budget').innerHTML = budgetSummary();
  if (next.budget !== previous.budget && !budgetDrafts.has(next.id)) {
    const input = screen.querySelector('#amount');
    if (input && next.budget !== null) {
      input.value = next.budget;
      slider(input);
    }
  }
  if ((view === 'people' && JSON.stringify(next.participants) !== JSON.stringify(previous.participants))
    || (view === 'draw' && next.participants.length !== previous.participants.length)) renderEventPanel();
}

function renderEventPanel() {
  screen.querySelector('.event-panel').innerHTML = eventPanel();
  loadAvatars();
}

function selectEvent(value, next = 'people') {
  event = value;
  view = next;
  reveal = false;
  showEvent();
}

function slider(input) {
  const choice = input.valueAsNumber;
  const amount = price(choice);
  screen.querySelector('output').value = amount;
  input.setAttribute('aria-valuetext', amount);
  input.style.setProperty('--filled', `${sliderFill(choice)}%`);
}

function queueBudget(input, immediate = false) {
  const id = event.id;
  const amount = input.valueAsNumber;
  const previous = budgetDrafts.get(id);
  if (previous?.amount === amount) {
    if (immediate && previous.timer) {
      clearTimeout(previous.timer);
      previous.timer = undefined;
      void saveBudget(id);
    }
    return;
  }
  clearTimeout(previous?.timer);
  if (!previous && event.budget === amount) return;
  const error = screen.querySelector('.budget-error');
  error.hidden = true;
  const draft = { amount };
  budgetDrafts.set(id, draft);
  if (immediate) {
    void saveBudget(id);
  } else {
    draft.timer = setTimeout(() => {
      draft.timer = undefined;
      void saveBudget(id);
    }, 220);
  }
}

function saveBudget(id) {
  if (savingBudgets.has(id)) return savingBudgets.get(id);
  const draft = budgetDrafts.get(id);
  if (!draft || draft.timer) return;
  const saving = persistBudget(id, draft);
  savingBudgets.set(id, saving);
  return saving;
}

async function persistBudget(id, draft) {
  try {
    const next = await request('budget', { event: id, amount: draft.amount });
    if (event?.id === id && event.status === 'open' && !event.invited) applyEventUpdate(next);
    return true;
  } catch (error) {
    if (event?.id === id && budgetDrafts.get(id) === draft) {
      const message = screen.querySelector('.budget-error');
      if (message) {
        message.textContent = `Бюджет не сохранён. ${error.message}`;
        message.hidden = false;
      }
    }
    return false;
  } finally {
    if (budgetDrafts.get(id) === draft) budgetDrafts.delete(id);
    savingBudgets.delete(id);
    void saveBudget(id);
  }
}

async function flushBudget(id) {
  let saved = true;
  while (budgetDrafts.has(id)) {
    const draft = budgetDrafts.get(id);
    clearTimeout(draft.timer);
    draft.timer = undefined;
    saved = await saveBudget(id);
  }
  return saved;
}

function sliderFill(value) {
  return (value - budget.min) * 100 / (budget.max - budget.min);
}

function confirm(title, description, button, callback) {
  dialog.querySelector('#confirm-title').textContent = title;
  dialog.querySelector('#confirm-copy').textContent = description;
  dialog.querySelector('#confirm-button').textContent = button;
  pendingConfirmation = callback;
  dialog.returnValue = '';
  dialog.showModal();
}

async function perform(callback) {
  if (loading || !endpoint || (!demo && !initData)) return;
  loading = true;
  status();
  screen.setAttribute('aria-busy', 'true');
  try {
    await callback();
  } catch (error) {
    status(error.message, true);
  } finally {
    screen.removeAttribute('aria-busy');
    loading = false;
  }
}

const actions = {
  'confirm-draw': () => confirm('Провести жеребьёвку?', 'Состав участников и бюджет зафиксируются.',
    'Провести', async () => {
      const id = event.id;
      if (!await flushBudget(id)) throw new Error('Бюджет не сохранён. Измените сумму и повторите попытку.');
      selectEvent(await request('draw', { event: id }), 'draw');
    }),
  'confirm-redraw': () => {
    const { id, round, participants } = event;
    const note = participants.length === 2
      ? 'У вас двое участников, поэтому в новом раунде получатели будут теми же.'
      : 'Предыдущие назначения заменятся. Участники получат результаты нового раунда.';
    confirm('Переиграть жеребьёвку?', note, 'Переиграть', async () => {
      selectEvent(await request('redraw', { event: id, round }), 'draw');
      status('Новый раунд готов.');
    });
  },
  reveal: () => { reveal = true; showEvent(); },
  remove: ({ id }) => {
    const person = event.participants.find(({ id: value }) => value === Number(id));
    confirm('Убрать участника?', person.name, 'Убрать', async () => {
      selectEvent(await request('remove', { event: event.id, target: person.id }));
    });
  },
  demo: async () => selectEvent(await request('demo')),
};

for (const tab of Object.keys(tabs)) {
  actions[tab] = () => {
    if (view === tab) return;
    view = tab;
    for (const button of screen.querySelectorAll('nav button')) {
      if (button.dataset.action === view) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    renderEventPanel();
  };
}

dialog.addEventListener('close', () => {
  if (dialog.returnValue === 'confirm') void perform(pendingConfirmation);
});
document.querySelector('main').addEventListener('click', (click) => {
  const button = click.target.closest('[data-action]');
  if (button) void perform(() => actions[button.dataset.action](button.dataset));
});
screen.addEventListener('input', ({ target }) => {
  if (target.id !== 'amount') return;
  slider(target);
  queueBudget(target);
});
screen.addEventListener('pointerup', ({ target }) => {
  if (target.id === 'amount') queueBudget(target, true);
});
screen.addEventListener('keydown', (key) => {
  const valueKeys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Enter', ' '];
  if (key.target.id === 'amount' && valueKeys.includes(key.key)) key.preventDefault();
});
if (initData) {
  const background = document.querySelector('meta[name="theme-color"]').content;
  if (telegram.isVersionAtLeast?.('6.9')) telegram.setHeaderColor?.(background);
  telegram.setBackgroundColor?.(background);
  if (telegram.isVersionAtLeast?.('7.10')) telegram.setBottomBarColor?.(background);
  telegram.onEvent('activated', syncEvent);
  telegram.ready();
  telegram.expand();
  if (telegram.isVersionAtLeast?.('8.0')) telegram.requestFullscreen?.();
}

if (!demo && (!initData || !endpoint)) {
  screen.innerHTML = hero('Тайный Санта', 'Telegram Mini App', 'Откройте приложение из меню бота в Telegram.');
  if (initData) status('Адрес API ещё не настроен.', true);
} else {
  await perform(async () => {
    const id = query.get('event') || telegram?.initDataUnsafe?.start_param || query.get('tgWebAppStartParam');
    if (id) {
      selectEvent(await request('open', { event: id }));
      if (query.get('view') === 'budget') screen.querySelector('#budget')?.scrollIntoView({ block: 'nearest' });
    } else if (participantPreview) selectEvent(await request('open'));
    else await openCurrentExchange();
  });
  setInterval(syncEvent, 3000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && event) void flushBudget(event.id);
    else void syncEvent();
  });
}
