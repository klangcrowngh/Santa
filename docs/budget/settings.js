export const budget = Object.freeze({
  min: 1_000,
  max: 5_000,
  step: 100,
  initial: 2_500,
});

export function clampBudget(value) {
  return Math.min(budget.max, Math.max(budget.min, value));
}

export function isBudget(value) {
  return Number.isSafeInteger(value)
    && value >= budget.min
    && value <= budget.max
    && (value - budget.min) % budget.step === 0;
}

const rubles = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  maximumFractionDigits: 0,
});

export function price(value) {
  return rubles.format(value);
}
