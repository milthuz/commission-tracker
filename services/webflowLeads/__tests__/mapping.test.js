const crypto = require('crypto');
const { mapSubmission, screenSubmission, guessTarget, verifySignature } = require('..');

describe('guessTarget', () => {
  test.each([
    ['Nom de l\'entreprise', 'businessName'],
    ['Company', 'businessName'],
    ['Prénom', 'contactFirstName'],
    ['First Name', 'contactFirstName'],
    ['Nom', 'contactName'],
    ['Nom de famille', 'contactLastName'],
    ['Courriel', 'contactEmail'],
    ['Email Address', 'contactEmail'],
    ['Téléphone', 'contactPhone'],
    ['Phone', 'contactPhone'],
    ['language', 'language'],
    ['Langue', 'language'],
    ['Message', 'notes'],
    ['Code postal', 'postalCode'],
    ['Type de commerce', 'businessType'],
    ['Nombre de succursales', 'locationsCount'],
    ['Système actuel', 'currentPos'],
  ])('%s → %s', (field, target) => expect(guessTarget(field)).toBe(target));

  test('champ inconnu → null', () => expect(guessTarget('Comment avez-vous entendu parler de nous')).toBe('notes'));
  test('vraiment inconnu → null', () => expect(guessTarget('Budget')).toBeNull());
});

describe('mapSubmission', () => {
  test('champs reconnus, inconnus ajoutés au message, vides ignorés', () => {
    const out = mapSubmission({
      'Nom de l\'entreprise': 'Pomme de pierre', 'Prénom': 'Marie', 'Nom de famille': 'Roy',
      'Courriel': 'marie@example.com', 'Téléphone': '514-555-0100', 'language': 'fr',
      'Message': 'On ouvre une 2e succursale', 'Budget': '5 000 $', 'Vide': '',
    });
    expect(out).toMatchObject({
      businessName: 'Pomme de pierre', contactFirstName: 'Marie', contactLastName: 'Roy',
      contactEmail: 'marie@example.com', contactPhone: '514-555-0100', language: 'fr',
    });
    expect(out.notes).toBe('On ouvre une 2e succursale\n\nBudget : 5 000 $');
  });

  test('la correspondance explicite prime, « ignore » écarte, « extra » envoie au message', () => {
    const out = mapSubmission(
      { 'Champ 3': 'Café X', 'Nom': 'Luc', 'Honeypot': 'bot', 'Source': 'Salon' },
      { 'Champ 3': 'businessName', 'Honeypot': 'ignore', 'Nom': 'extra' });
    expect(out.businessName).toBe('Café X');
    expect(out.contactName).toBeUndefined();
    expect(out.notes).toContain('Nom : Luc');
    expect(out.notes).not.toContain('bot');
  });

  test('deux champs sur la même cible sont joints, les tableaux aussi', () => {
    const out = mapSubmission({ 'Intérêt POS': 'POS', 'Intérêt paiements': ['Paiements', 'Terminal'] });
    expect(out.interest).toBe('POS, Paiements, Terminal');
  });
});

test("cases à cocher d'intérêt : le nom de la case devient la valeur, décochées ignorées", () => {
  const out = mapSubmission({ 'Intérêt - POS': 'true', 'Intérêt - Paiements': 'true', 'Intérêt - Matériel': 'false', 'Interest: Online Ordering': 'on' });
  expect(out.interest).toBe('POS, Paiements, Online Ordering');
});

describe('verifySignature', () => {
  const secret = 'abc123';
  const body = Buffer.from('{"triggerType":"form_submission","payload":{"id":"x"}}');
  const ts = String(Date.now());
  const sign = (t, b) => crypto.createHmac('sha256', secret).update(`${t}:${b}`).digest('hex');

  test('signature valide', () => expect(verifySignature({ secret, timestamp: ts, signature: sign(ts, body), rawBody: body }).ok).toBe(true));
  test('corps modifié → refus', () => expect(verifySignature({ secret, timestamp: ts, signature: sign(ts, body), rawBody: Buffer.from('{}') })).toEqual({ ok: false, reason: 'bad_signature' }));
  test('trop vieux → refus', () => {
    const old = String(Date.now() - 6 * 60 * 1000);
    expect(verifySignature({ secret, timestamp: old, signature: sign(old, body), rawBody: body })).toEqual({ ok: false, reason: 'stale' });
  });
  test('en-têtes absents → refus', () => expect(verifySignature({ secret, rawBody: body }).reason).toBe('missing_signature'));
  test('sans secret (webhook non signé) → accepté par la clé d\'adresse seule', () => expect(verifySignature({ secret: null, rawBody: body })).toEqual({ ok: true, skipped: true }));
});

// Les noms EXACTS proposés par l'équipe Webflow (audit du 2026-09-29).
describe('formulaires du site (audit 2026-09-29)', () => {
  test('Contact Us : noms proposés', () => {
    const data = {
      'Interest - Point of Sale': 'true', 'Interest - Cluster Payments': 'false', 'Interest - Hardware': 'true',
      'First Name': 'Julie', 'Last Name': 'Tremblay', 'Email': 'julie@cafe.ca', 'Company': 'Café Merlebleu',
      'Phone': '514-555-0142', 'Message': 'Un ami', 'Consent': 'true', 'language': 'fr', 'website_url': '', 'Page': '/fr-ca/pricing',
    };
    expect(screenSubmission(data)).toBeNull();
    const out = mapSubmission(data);
    expect(out).toMatchObject({ contactFirstName: 'Julie', contactLastName: 'Tremblay', contactEmail: 'julie@cafe.ca',
      businessName: 'Café Merlebleu', contactPhone: '514-555-0142', language: 'fr', interest: 'Point of Sale, Hardware' });
    expect(out.website).toBeUndefined();
    expect(out.notes).toContain('Un ami');
    expect(out.notes).toContain('Page : /fr-ca/pricing');
    expect(out.notes).toContain('Consent : true');
  });

  test('champ piège rempli → ignoré ; jamais versé dans « site web »', () => {
    const data = { 'Email': 'bot@spam.io', 'Company': 'Spam', 'website_url': 'http://spam.io' };
    expect(screenSubmission(data)).toEqual({ reason: 'honeypot', detail: 'website_url' });
    expect(mapSubmission(data).website).toBeUndefined();
  });

  test('un vrai champ « Website » n\'est PAS un piège', () => {
    expect(screenSubmission({ 'Website': 'https://cafe.ca', 'Email': 'a@b.ca' })).toBeNull();
    expect(mapSubmission({ 'Website': 'https://cafe.ca' }).website).toBe('https://cafe.ca');
  });

  test.each([
    ['Existing', 'Technical Support', 'existing_customer'],
    ['Existing', 'Account & Billing', 'existing_customer'],
    ['Existing', 'Customer Service', 'existing_customer'],
    ['Existant', 'Soutien', 'existing_customer'],
    ['Existing', undefined, 'existing_customer'],
    ['Existing', 'Sales', null],
    ['Existant', 'Ventes', null],
    ['New', 'Technical Support', null],
    ['Nouveau', undefined, null],
  ])('Get in Touch : %s / %s → %s', (type, dept, reason) => {
    const data = { 'Customer Type': type, 'First Name': 'Luc', 'Email': 'luc@x.ca', 'Company': 'X', 'Message': 'Allo' };
    if (dept) data.Department = dept;
    const r = screenSubmission(data);
    expect(r ? r.reason : null).toBe(reason);
  });

  test('Get in Touch gardé : type et service vont au message', () => {
    const out = mapSubmission({ 'Customer Type': 'Existing', 'Department': 'Sales', 'Company': 'X', 'Message': 'Une 2e succursale' });
    expect(out.businessName).toBe('X');
    expect(out.notes).toContain('Customer Type : Existing');
    expect(out.notes).toContain('Department : Sales');
  });

  test('Kaizen Early Access : noms proposés', () => {
    const out = mapSubmission({ 'First Name': 'Ana', 'Last Name': 'Diaz', 'Email': 'ana@x.ca', 'Phone': '438-555-0101', 'Company': 'Tacos Ana', 'language': 'en' });
    expect(out).toMatchObject({ contactFirstName: 'Ana', contactLastName: 'Diaz', contactPhone: '438-555-0101', businessName: 'Tacos Ana', language: 'en' });
  });
});
