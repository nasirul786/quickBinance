// Tiny exact-decimal helpers for crypto amounts (avoids floating point surprises).
const SCALE = 18n;
const FACTOR = 10n ** SCALE;

const AMOUNT_RE = /^\d+(\.\d+)?$/;

export function isValidAmount(str) {
  return AMOUNT_RE.test(str) && toUnits(str) > 0n;
}

/** Parse a decimal string into fixed-point BigInt units. */
export function toUnits(str) {
  const s = String(str).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s) && !/^-?\d*\.\d+$/.test(s)) {
    // Binance sometimes returns scientific notation for tiny numbers.
    const n = Number(s);
    if (!Number.isFinite(n)) throw new Error(`Invalid decimal: ${str}`);
    return toUnits(n.toFixed(Number(SCALE)));
  }
  const negative = s.startsWith('-');
  const [intPart, fracPart = ''] = s.replace('-', '').split('.');
  const frac = (fracPart + '0'.repeat(Number(SCALE))).slice(0, Number(SCALE));
  const units = BigInt(intPart || '0') * FACTOR + BigInt(frac);
  return negative ? -units : units;
}

export function fromUnits(units) {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const intPart = abs / FACTOR;
  const frac = (abs % FACTOR).toString().padStart(Number(SCALE), '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${intPart}${frac ? '.' + frac : ''}`;
}

export const cmp = (a, b) => {
  const x = toUnits(a);
  const y = toUnits(b);
  return x === y ? 0 : x > y ? 1 : -1;
};

export const add = (a, b) => fromUnits(toUnits(a) + toUnits(b));

export const sub = (a, b) => fromUnits(toUnits(a) - toUnits(b));

export const normalize = (a) => fromUnits(toUnits(a));

/** True when `amount` is an exact multiple of `step` (a step of 0 means "any"). */
export function isMultipleOf(amount, step) {
  const s = toUnits(step);
  if (s === 0n) return true;
  return toUnits(amount) % s === 0n;
}
