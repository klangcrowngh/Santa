import { budget, isBudget, price } from './settings.js';

const query = new URLSearchParams(location.search);
const eventId = query.get('event') ?? '';
const requested = Number(query.get('amount'));
const telegram = window.Telegram?.WebApp;
const inTelegram = Boolean(telegram?.platform && telegram.platform !== 'unknown' && /^[\w-]{16}$/.test(eventId));

const form = document.querySelector('form');
const slider = document.querySelector('#amount');
const output = document.querySelector('#selected');
const status = document.querySelector('.status');
const submit = document.querySelector('.submit');
const presets = [...document.querySelectorAll('[data-amount]')];

slider.min = budget.min;
slider.max = budget.max;
slider.step = budget.step;
slider.value = isBudget(requested) ? requested : budget.initial;
document.querySelector('#minimum').textContent = price(budget.min);
document.querySelector('#maximum').textContent = price(budget.max);
for (const preset of presets) preset.textContent = price(Number(preset.dataset.amount));

function render() {
  const amount = slider.valueAsNumber;
  const position = (amount - budget.min) / (budget.max - budget.min);
  slider.style.setProperty('--position', `${position * 100}%`);
  output.value = price(amount);
  slider.setAttribute('aria-valuetext', price(amount));
  for (const preset of presets) {
    preset.setAttribute('aria-pressed', String(Number(preset.dataset.amount) === amount));
  }
  status.hidden = true;
}

if (inTelegram) {
  telegram.ready();
  telegram.expand();
} else {
  submit.firstChild.textContent = 'Проверить выбор ';
}

slider.addEventListener('input', render);
for (const preset of presets) {
  preset.addEventListener('click', () => {
    slider.value = preset.dataset.amount;
    render();
  });
}
form.addEventListener('submit', (event) => {
  event.preventDefault();
  const amount = slider.valueAsNumber;
  if (inTelegram) {
    submit.disabled = true;
    try {
      telegram.sendData(JSON.stringify({ event: eventId, amount }));
      return;
    } catch {
      submit.disabled = false;
      status.textContent = 'Не удалось отправить сумму. Откройте ползунок из чата с ботом и попробуйте снова.';
    }
  } else {
    status.textContent = `Выбрано ${price(amount)}. Чтобы сохранить голос, откройте ползунок в Telegram.`;
  }
  status.hidden = false;
});

render();
