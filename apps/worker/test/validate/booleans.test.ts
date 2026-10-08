import { describe, expect, it } from 'vitest';
import { readAvailability, readWorkplace, workplaceTopic } from '../../src/extract/validate/booleans.js';
import { normalizeValue, type NormalizeContext } from '../../src/extract/validate/normalize.js';
import type { FieldSpec } from '../../src/extract/types.js';

const ctx: NormalizeContext = { baseUrl: 'https://shop.example.com/p/1' };

function field(name: string, description?: string): FieldSpec {
  return { name, type: 'boolean', required: false, nullable: true, derived: false, schema: { type: 'boolean' }, ...(description ? { description } : {}) };
}

function read(raw: unknown, f: FieldSpec): unknown {
  const r = normalizeValue(raw, f, ctx);
  return r.ok ? r.value : r.reason;
}

const inStock = field('inStock');

describe('availability in other languages', () => {
  it.each([
    // German
    ['Auf Lager', true],
    ['Nur noch 3 auf Lager', true],
    ['Lagernd', true],
    ['Vorrätig', true],
    ['Sofort lieferbar', true],
    ['Verfügbar', true],
    ['In den Warenkorb', true],
    ['Nicht auf Lager', false],
    ['Nicht vorrätig', false],
    ['Derzeit nicht verfügbar', false],
    ['Zurzeit nicht lieferbar', false],
    ['Ausverkauft', false],
    ['Vergriffen', false],
    ['Bald wieder verfügbar', false],
    // French
    ['En stock', true],
    ['Disponible', true],
    ['Ajouter au panier', true],
    ['En rupture de stock', false],
    ['Rupture de stock', false],
    ['Épuisé', false],
    ['Indisponible', false],
    ['Temporairement indisponible', false],
    ['Non disponible', false],
    ['Pas en stock', false],
    ["N'est plus disponible", false],
    ['Bientôt disponible', false],
    // Spanish
    ['En existencia', true],
    ['Hay existencias', true],
    ['Agotado', false],
    ['Sin stock', false],
    ['No disponible', false],
    ['Fuera de stock', false],
    // Italian
    ['Disponibile', true],
    ['Disponibilità immediata', true],
    ['In magazzino', true],
    ['Esaurito', false],
    ['Non disponibile', false],
    ['Non più disponibile', false],
    // Portuguese
    ['Em estoque', true],
    ['Disponível', true],
    ['Esgotado', false],
    ['Indisponível', false],
    ['Não disponível', false],
    ['Fora de estoque', false],
    // Dutch
    ['Op voorraad', true],
    ['Direct leverbaar', true],
    ['Beschikbaar', true],
    ['Niet op voorraad', false],
    ['Uitverkocht', false],
    ['Tijdelijk uitverkocht', false],
    ['Niet leverbaar', false],
    // Whole-value yes/no
    ['Ja', true],
    ['Oui', true],
    ['Sí', true],
    ['Nein', false],
    ['Non', false],
    ['Não', false],
  ])('%j → %s', (raw, expected) => {
    expect(normalizeValue(raw, inStock, ctx)).toEqual({ ok: true, value: expected, steps: ['parse-boolean'] });
  });

  it('negations win over the positive word they contain', () => {
    for (const raw of ['nicht auf lager', 'no disponible', 'non disponibile', 'não disponível', 'niet op voorraad', 'indisponible', 'pas disponible']) {
      expect(readAvailability(raw), raw).toBe(false);
    }
  });

  it('contradictions are ambiguous', () => {
    expect(read('Auf Lager, online ausverkauft', inStock)).toBe('ambiguous');
    expect(read('Disponible en magasin, épuisé en ligne', inStock)).toBe('ambiguous');
  });

  it('words inside other words do not count', () => {
    expect(read('Disponibilidad limitada', inStock)).toBe('unparseable');
    expect(read('Lagerfeld', inStock)).toBe('unparseable');
    expect(read('Restocking fee applies', inStock)).toBe('unparseable');
  });

  it('workplace words mean nothing for an availability field', () => {
    expect(read('Remote', inStock)).toBe('unparseable');
    expect(read('On-site', inStock)).toBe('unparseable');
    expect(read('Hybrid', inStock)).toBe('unparseable');
  });
});

describe('remote work', () => {
  const remote = field('remote', 'True only when the role can be done fully remotely');

  it.each([
    ['Remote', true],
    ['Remote (US)', true],
    ['Fully remote', true],
    ['100% remote', true],
    ['Remote-first', true],
    ['Work from home', true],
    ['WFH', true],
    ['Telecommute', true],
    ['Remote: yes', true],
    ['Yes', true],
    ['On-site', false],
    ['Onsite', false],
    ['Austin, TX · On-site', false],
    ['In person (Austin, TX)', false],
    ['In-office', false],
    ['Office-based', false],
    ['Not remote', false],
    ['No remote work', false],
    ['not eligible for fully remote work', false],
    ['It is not eligible for fully remote work.', false],
    ['Remote work is not possible', false],
    ['Remote: No', false],
    ['No', false],
    ['Workplace type: On-site', false],
    ['Location type: Remote', true],
    // "fully remotely" in the description: a hybrid role is not.
    ['Hybrid', false],
    ['Hybrid remote', false],
  ])('%j → %s', (raw, expected) => {
    expect(normalizeValue(raw, remote, ctx)).toEqual({ ok: true, value: expected, steps: ['parse-boolean'] });
  });

  it('hybrid is ambiguous unless the description says how to treat it', () => {
    expect(read('Hybrid', field('remote'))).toBe('ambiguous');
    expect(read('Hybrid', field('isRemote', 'Remote work allowed'))).toBe('ambiguous');
    expect(read('Hybrid', field('isRemote', 'True for any remote work, including hybrid'))).toBe(true);
    expect(read('Hybrid', field('remoteAllowed', 'Hybrid counts as remote'))).toBe(true);
    expect(read('Hybrid', field('remote', 'true for remote roles; hybrid is false'))).toBe(false);
    expect(read('Partially remote', field('remote', '100% remote only'))).toBe(false);
  });

  it('contradictions are ambiguous, unrelated text is not guessed', () => {
    expect(read('Remote or on-site', remote)).toBe('ambiguous');
    expect(read('Austin, TX', remote)).toBe('unparseable');
    expect(read('In stock', remote)).toBe('unparseable');
    expect(read('Available', remote)).toBe('unparseable');
    expect(read('Full-time', remote)).toBe('unparseable');
  });

  it('an on-site field reads the same phrases the other way round', () => {
    expect(read('On-site', field('onsite'))).toBe(true);
    expect(read('Remote', field('isOnsite'))).toBe(false);
    expect(read('In office', field('inOffice'))).toBe(true);
    expect(read('Remote: no', field('onSite'))).toBe(true);
    expect(read('Yes', field('inPerson'))).toBe(true);
    expect(read('Hybrid', field('inOffice'))).toBe('ambiguous');
    expect(read('Hybrid', field('inOffice', 'true when the job is fully on-site'))).toBe(false);
  });

  it('other languages', () => {
    expect(read('Télétravail', field('remote'))).toBe(true);
    expect(read('Teletrabajo', field('remote'))).toBe(true);
    expect(read('Presencial', field('remote'))).toBe(false);
    expect(read('Homeoffice', field('remote'))).toBe(true);
    expect(read('Vor Ort', field('remote'))).toBe(false);
  });
});

describe('workplaceTopic', () => {
  it.each([
    [field('remote'), 'remote'],
    [field('isRemote'), 'remote'],
    [field('remote_ok'), 'remote'],
    [field('workFromHome'), 'remote'],
    [field('telecommute'), 'remote'],
    [field('onsite'), 'onsite'],
    [field('isOnSite'), 'onsite'],
    [field('in_office'), 'onsite'],
    [field('inPerson'), 'onsite'],
    [field('flag', 'Whether the job can be done remotely'), 'remote'],
    [field('flag', 'true when the job is on-site, false when remote'), 'onsite'],
    [field('flag', 'True for remote jobs, false for on-site ones'), 'remote'],
  ])('%j → %s', (f, polarity) => {
    expect(workplaceTopic(f)?.polarity).toBe(polarity);
  });

  it('ignores fields that are not about remote work', () => {
    expect(workplaceTopic(field('inStock'))).toBeUndefined();
    expect(workplaceTopic(field('available'))).toBeUndefined();
    expect(workplaceTopic(field('remote', 'Includes a remote control'))).toBeUndefined();
    expect(workplaceTopic(field('hasRemoteControl'))).toBeUndefined();
    expect(workplaceTopic(field('flag', 'remote or on-site, see text'))).toBeUndefined();
    expect(read('Remote control included', field('remote', 'includes a remote control'))).toBe('unparseable');
  });

  it('reads the hybrid policy from the description', () => {
    expect(workplaceTopic(field('remote', 'True only when the role can be done fully remotely'))).toEqual({ polarity: 'remote', hybrid: false });
    expect(workplaceTopic(field('remote', 'any remote work'))).toEqual({ polarity: 'remote', hybrid: true });
    expect(workplaceTopic(field('remote'))).toEqual({ polarity: 'remote' });
  });

  it('readWorkplace on its own', () => {
    expect(readWorkplace('on-site', { polarity: 'remote' })).toBe(false);
    expect(readWorkplace('hybrid', { polarity: 'remote', hybrid: true })).toBe(true);
    expect(readWorkplace('somewhere', { polarity: 'remote' })).toBeNull();
  });
});
