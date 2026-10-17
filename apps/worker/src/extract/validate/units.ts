// Units of measure for number fields that name one ("Weight in kilograms",
// "SSD capacity in GB", "batteryMah").
//
// A spec cell rarely holds one number: "512 GB PCIe 4.0 NVMe SSD",
// "16 GB LPDDR5X-8533", "1.4 kg (3.09 lb)". When the field names its unit,
// the number printed with that unit is the value, and the others are not.
// A value printed only in another unit of the same quantity is converted
// when the conversion is exact by definition (mass, length, duration,
// frequency, volume) and rejected otherwise ("1 TB" for a field in GB:
// decimal or binary?).

export type Dimension = 'mass' | 'length' | 'data' | 'charge' | 'energy' | 'power' | 'duration' | 'frequency' | 'volume' | 'pixels';

export interface Unit {
  id: string;
  dim: Dimension;
  /** Factor to the dimension's base unit; absent when conversion is not exact. */
  toBase?: number;
}

interface UnitDef extends Unit {
  /** Case-insensitive spellings after a number. */
  words: readonly string[];
  /** Case-sensitive single-letter or symbol spellings ("g", "W", "\""). */
  symbols?: readonly string[];
  /** Spellings recognised in a field name ("weightKg"); defaults to `words`. */
  nameWords?: readonly string[];
}

const DEFS: readonly UnitDef[] = [
  { id: 'mg', dim: 'mass', toBase: 1e-6, words: ['mg', 'milligram', 'milligrams'] },
  { id: 'g', dim: 'mass', toBase: 1e-3, words: ['gram', 'grams', 'gr'], symbols: ['g'], nameWords: ['grams'] },
  { id: 'kg', dim: 'mass', toBase: 1, words: ['kg', 'kgs', 'kilogram', 'kilograms', 'kilo', 'kilos'] },
  { id: 'lb', dim: 'mass', toBase: 0.45359237, words: ['lb', 'lbs', 'pound', 'pounds'], nameWords: ['lb', 'lbs'] },
  { id: 'oz', dim: 'mass', toBase: 0.028349523125, words: ['oz', 'ounce', 'ounces'] },
  { id: 'mm', dim: 'length', toBase: 1e-3, words: ['mm', 'millimeter', 'millimeters', 'millimetre', 'millimetres'] },
  { id: 'cm', dim: 'length', toBase: 1e-2, words: ['cm', 'centimeter', 'centimeters', 'centimetre', 'centimetres'] },
  { id: 'm', dim: 'length', toBase: 1, words: ['meter', 'meters', 'metre', 'metres'], symbols: ['m'] },
  { id: 'km', dim: 'length', toBase: 1e3, words: ['km', 'kilometer', 'kilometers', 'kilometre', 'kilometres'] },
  { id: 'in', dim: 'length', toBase: 0.0254, words: ['inch', 'inches'], symbols: ['"', '′′', '”', 'in.'], nameWords: ['inch', 'inches'] },
  { id: 'ft', dim: 'length', toBase: 0.3048, words: ['ft', 'feet', 'foot'] },
  { id: 'mi', dim: 'length', toBase: 1609.344, words: ['mile', 'miles'] },
  { id: 'kb', dim: 'data', words: ['kb', 'kilobyte', 'kilobytes'] },
  { id: 'mb', dim: 'data', words: ['mb', 'megabyte', 'megabytes'] },
  { id: 'gb', dim: 'data', words: ['gb', 'gigabyte', 'gigabytes'] },
  { id: 'tb', dim: 'data', words: ['tb', 'terabyte', 'terabytes'] },
  { id: 'mah', dim: 'charge', words: ['mah'] },
  { id: 'wh', dim: 'energy', words: ['wh'] },
  { id: 'kwh', dim: 'energy', words: ['kwh'] },
  { id: 'w', dim: 'power', words: ['watt', 'watts'], symbols: ['W'] },
  { id: 'kw', dim: 'power', words: ['kw', 'kilowatt', 'kilowatts'] },
  { id: 's', dim: 'duration', toBase: 1, words: ['sec', 'secs', 'second', 'seconds'] },
  // "priceMin" is a minimum, not minutes: "min" names minutes only after a time word (below).
  { id: 'min', dim: 'duration', toBase: 60, words: ['min', 'mins', 'minute', 'minutes'], nameWords: ['mins', 'minute', 'minutes'] },
  { id: 'h', dim: 'duration', toBase: 3600, words: ['hr', 'hrs', 'hour', 'hours'], symbols: ['h'] },
  { id: 'hz', dim: 'frequency', toBase: 1, words: ['hz', 'hertz'] },
  { id: 'khz', dim: 'frequency', toBase: 1e3, words: ['khz'] },
  { id: 'mhz', dim: 'frequency', toBase: 1e6, words: ['mhz'] },
  { id: 'ghz', dim: 'frequency', toBase: 1e9, words: ['ghz'] },
  { id: 'ml', dim: 'volume', toBase: 1e-3, words: ['ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres'] },
  { id: 'l', dim: 'volume', toBase: 1, words: ['liter', 'liters', 'litre', 'litres'], symbols: ['l', 'L'] },
  { id: 'mp', dim: 'pixels', words: ['mp', 'megapixel', 'megapixels'] },
];

const INCH = DEFS.find((d) => d.id === 'in') as UnitDef;
const BY_WORD = new Map<string, UnitDef>();
const BY_NAME_WORD = new Map<string, UnitDef>();
for (const def of DEFS) {
  for (const w of def.words) BY_WORD.set(w, def);
  for (const w of def.nameWords ?? def.words) BY_NAME_WORD.set(w, def);
}
// Longest first so "in." wins over shorter spellings.
const SYMBOLS = DEFS.flatMap((def) => (def.symbols ?? []).map((s) => [s, def] as const)).sort((a, b) => b[0].length - a[0].length);

// Words that name a unit after a number but are ordinary words in prose.
const DESCRIPTION_SKIP = new Set(['gr', 'kilo', 'kilos', 'min', 'sec', 'secs']);
// A field about money: "pounds" there is sterling, not a mass. Whole words
// only ("displayWeightLb" is not about pay).
const MONEY_WORDS = new Set([
  'price', 'prices', 'cost', 'costs', 'fee', 'fees', 'amount', 'salary', 'salaries', 'wage', 'wages', 'pay', 'rent',
  'budget', 'revenue', 'income', 'currency', 'sterling', 'gbp', 'msrp',
]);
const CURRENCY_POUND = new Set(['pound', 'pounds']);
// "cookTimeMin", "durationMin": minutes. "priceMin", "ageMin": a minimum.
const TIME_WORD = /^(?:time|duration|runtime|prep|cook|cooking|total|wait|waiting|delivery|travel|commute|drive|driving|walk|walking|read|reading|play|playing|video|ride|flight|charge|charging)$/i;
// "videoLengthMin", "batteryLifeMin": minutes too ("lengthMin" alone is a minimum length).
const MEDIA_WORD = /^(?:video|song|track|film|movie|episode|call|audio|clip|podcast|show|lesson|class|course|meeting)$/i;
// A field about a weight keeps "pounds" as a mass even when it mentions a price.
const WEIGHT_WORDS = new Set(['weight', 'weights', 'weighs', 'mass', 'heavy', 'heaviness', 'load']);

function isTimeName(words: readonly string[], at: number): boolean {
  const w = words[at];
  if (w === undefined) return false;
  if (TIME_WORD.test(w)) return true;
  const before = words[at - 1];
  if (/^length$/i.test(w)) return before !== undefined && MEDIA_WORD.test(before);
  if (/^life$/i.test(w)) return before !== undefined && /^battery$/i.test(before);
  return false;
}

function nameWords(text: string): string[] {
  return text
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .split(/[^\p{L}\p{N}£]+/u)
    .filter((w) => w !== '')
    .map((w) => w.toLowerCase());
}

/**
 * Whether "pound(s)"/"lb" is money here: the name is about money, or the
 * description is and nothing says the field is a weight ("Shipping weight,
 * used for the shipping cost" stays a mass).
 */
function moneyContext(name: string, description: string): { name: boolean; description: boolean } {
  const nameW = nameWords(name);
  const descW = nameWords(description);
  const nameMoney = nameW.some((w) => MONEY_WORDS.has(w));
  const weight = [...nameW, ...descW].some((w) => WEIGHT_WORDS.has(w));
  const descMoney = !weight && (description.includes('£') || descW.some((w) => MONEY_WORDS.has(w)));
  return { name: nameMoney, description: nameMoney || descMoney };
}

const MAX_FIELD_TEXT = 300;

/**
 * The unit a number field asks for, from its description ("in GB",
 * "(kg)") or the last word of its name ("weightKg", "battery_mah").
 * Undefined when the field names none, or names two different ones.
 */
export function fieldUnit(field: { name: string; description?: string }): Unit | undefined {
  const found = new Set<UnitDef>();
  const description = (field.description ?? '').slice(0, MAX_FIELD_TEXT);
  const money = moneyContext(field.name.slice(0, MAX_FIELD_TEXT), description);
  // "in GB", "(kg)", "[mAh]"; not "per kg" (a price per kilogram is not a mass).
  for (const m of description.matchAll(/(?:\bin\s+|\(\s*|\[\s*)([a-zA-Z]+)\b/g)) {
    const word = m[1].toLowerCase();
    if (DESCRIPTION_SKIP.has(word) || (money.description && CURRENCY_POUND.has(word))) continue;
    const def = BY_WORD.get(word) ?? SYMBOLS.find(([symbol]) => symbol === m[1])?.[1];
    if (def) found.add(def);
  }
  const words = field.name
    .slice(0, MAX_FIELD_TEXT)
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .filter((w) => w !== '');
  // "weightKg" asks for kilograms; "pricePerKg" is a price.
  if (words.length > 1 && words[words.length - 2].toLowerCase() !== 'per') {
    const last = words[words.length - 1].toLowerCase();
    const def = last === 'min' && isTimeName(words, words.length - 2) ? BY_WORD.get('min') : BY_NAME_WORD.get(last);
    if (def && !(money.name && def.id === 'lb')) found.add(def);
  }
  if (found.size !== 1) return undefined;
  const [def] = found;
  return { id: def.id, dim: def.dim, ...(def.toBase !== undefined ? { toBase: def.toBase } : {}) };
}

/** The unit printed right after a number (`after` is the text following it), if any. */
export function unitAfter(after: string): Unit | undefined {
  const rest = after.replace(/^[  ]?/, '');
  for (const [symbol, def] of SYMBOLS) {
    if (!rest.startsWith(symbol)) continue;
    // A symbol must stand alone: "5 g", not "5G" or "5 grams" (a word, below).
    if (/[\p{L}\d]/u.test(rest.charAt(symbol.length))) continue;
    return unitOf(def);
  }
  // Bare "in" only at the end of a value or before punctuation: "14 in",
  // "14 in, 2.8K"; never "14 in stock".
  if (/^in(?:$|[,;:)\]/])/.test(rest)) return unitOf(INCH);
  const word = /^\p{L}+/u.exec(rest)?.[0];
  if (!word) return undefined;
  const def = BY_WORD.get(word.toLowerCase());
  return def ? unitOf(def) : undefined;
}

function unitOf(def: UnitDef): Unit {
  return { id: def.id, dim: def.dim, ...(def.toBase !== undefined ? { toBase: def.toBase } : {}) };
}

/**
 * `value` in `from` expressed in `to`, rounded to the precision it was
 * printed with (at least three significant digits): 3.09 lb → 1.4 kg.
 * Null when the units measure different things or have no exact factor.
 */
export function convertUnit(value: number, printed: string, from: Unit, to: Unit): number | null {
  if (from.dim !== to.dim || from.toBase === undefined || to.toBase === undefined) return null;
  const converted = (value * from.toBase) / to.toBase;
  if (!Number.isFinite(converted)) return null;
  const digits = Math.min(15, Math.max(3, significantDigits(printed)));
  const rounded = Number(converted.toPrecision(digits));
  return rounded === 0 ? 0 : rounded;
}

function significantDigits(printed: string): number {
  const digits = printed.replace(/[^\d]/g, '').replace(/^0+/, '');
  return digits.length;
}

// 6'2", 5′10″, 6 ft 2 in, 6’ 2”: one length in feet and inches.
// The feet number starts at a number's start: "105 ft 3 in" is never "05 ft 3 in".
const FEET_INCHES =
  /(?<![\d.,'’′])(\d{1,3}(?:\.\d+)?)\s*(?:'|′|’|ft\.?|feet|foot)\s*(\d{1,2}(?:\.\d+)?)\s*(?:"|″|”|′′|''|’’|in\.?|inch(?:es)?)?(?![\p{L}\d])/giu;

/**
 * A height printed in feet and inches, as inches (6'2" → 74), with the
 * text it was read from. 'ambiguous' when the text holds several.
 */
export function feetAndInches(text: string): { inches: number; printed: string } | 'ambiguous' | null {
  const found = [...text.matchAll(FEET_INCHES)].filter((m) => Number(m[2]) < 12);
  if (found.length === 0) return null;
  const values = new Set(found.map((m) => Number(m[1]) * 12 + Number(m[2])));
  if (values.size > 1) return 'ambiguous';
  return { inches: [...values][0], printed: found[0][0] };
}

/** The inch, as a unit to convert from. */
export const INCH_UNIT: Unit = unitOf(INCH);
