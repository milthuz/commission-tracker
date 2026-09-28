const crypto = require('crypto');
const { mapSubmission, guessTarget, verifySignature } = require('..');

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
