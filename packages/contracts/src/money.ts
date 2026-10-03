export const SUPPORTED_CURRENCIES = ['EUR'] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

export interface Money {
  amountMinor: number;
  currency: Currency;
}

const MINOR_UNIT_EXPONENT: Record<Currency, number> = {
  EUR: 2,
};

export function minorUnitsPerMajor(currency: Currency): number {
  return 10 ** MINOR_UNIT_EXPONENT[currency];
}

export function money(amountMinor: number, currency: Currency): Money {
  if (!Number.isInteger(amountMinor)) {
    throw new Error(`Money must be an integer in minor units, got ${amountMinor}`);
  }
  return { amountMinor, currency };
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

export function multiplyMoney(a: Money, quantity: number): Money {
  if (!Number.isInteger(quantity)) {
    throw new Error(`Quantity must be an integer, got ${quantity}`);
  }
  return money(a.amountMinor * quantity, a.currency);
}

export function sumMoney(items: readonly Money[], currency: Currency): Money {
  return items.reduce((acc, item) => addMoney(acc, item), money(0, currency));
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function toDecimalString(m: Money): string {
  const per = minorUnitsPerMajor(m.currency);
  const sign = m.amountMinor < 0 ? '-' : '';
  const abs = Math.abs(m.amountMinor);
  const major = Math.floor(abs / per);
  const minor = abs % per;
  return `${sign}${major}.${String(minor).padStart(MINOR_UNIT_EXPONENT[m.currency], '0')}`;
}

export function fromDecimalString(value: string, currency: Currency): Money {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Cannot parse "${value}" as ${currency}`);
  }
  return money(Math.round(parsed * minorUnitsPerMajor(currency)), currency);
}

export function formatMoney(m: Money, locale = 'bg-BG'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: m.currency,
    minimumFractionDigits: MINOR_UNIT_EXPONENT[m.currency],
  }).format(m.amountMinor / minorUnitsPerMajor(m.currency));
}

export const VAT_RATE_BG = 0.2;

export function vatPortion(gross: Money): Money {
  return money(
    Math.round(gross.amountMinor - gross.amountMinor / (1 + VAT_RATE_BG)),
    gross.currency,
  );
}
