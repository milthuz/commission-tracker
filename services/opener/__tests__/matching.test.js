// Notation de l'appariement Kaizen ↔ Google.   node services/opener/__tests__/matching.test.js
const assert = require('assert');
const M = require('../matching');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ✓', name); };

const place = (id, name, postal, num, extra = {}) => ({
  id, displayName: { text: name }, formattedAddress: `${num} Rue X, Montréal, QC ${postal}`,
  location: { latitude: 45.52, longitude: -73.58 },
  addressComponents: [
    { types: ['street_number'], shortText: num },
    { types: ['postal_code'], shortText: postal },
  ],
  ...extra,
});
const store = { name: 'Restaurant Saoko Inc.', street: '4520 Rue Saint-Denis', postal_code: 'H2J 2L3', city: 'Montréal' };

t('normName suit sh_norm_name (accents, mots juridiques, ponctuation)', () => {
  assert.strictEqual(M.normName("Café L'Étoile Inc."), 'cafeletoile');
  assert.strictEqual(M.normName('Les Délices ltée'), 'delices');
});

t('nom : les mots génériques ne font pas la ressemblance', () => {
  assert.ok(M.nameSim('Restaurant Saoko', 'Saoko') > 0.8);
  assert.ok(M.nameSim('Restaurant Saoko', 'Restaurant Kazu') < 0.3);
});

t('même code postal + même nom + même numéro → auto', () => {
  const s = M.scoreCandidate(store, place('a', 'Saoko', 'H2J 2L3', '4520'));
  assert.ok(s.score >= M.AUTO, JSON.stringify(s));
  assert.strictEqual(M.decide([{ id: 'a', score: s.score }]).status, 'auto');
});

t('chaîne : même nom, autre code postal et autre numéro → pas auto', () => {
  const s = M.scoreCandidate(store, place('b', 'Saoko', 'H3B 1A1', '1000'));
  assert.ok(s.score < M.REVIEW, JSON.stringify(s));
});

t('nom différent à la même adresse (successeur) → au mieux « à confirmer »', () => {
  const s = M.scoreCandidate(store, place('c', 'Pho Bang', 'H2J 2L3', '4520'));
  assert.ok(s.score >= M.REVIEW && s.score < M.AUTO, JSON.stringify(s));
});

t('fiche fermée définitivement : jamais auto', () => {
  const s = M.scoreCandidate(store, place('d', 'Saoko', 'H2J 2L3', '4520', { businessStatus: 'CLOSED_PERMANENTLY' }));
  assert.ok(s.score < M.AUTO);
});

t('deux candidats au-dessus du seuil et proches → ambigu, à confirmer', () => {
  assert.strictEqual(M.decide([{ id: 'a', score: 0.95 }, { id: 'b', score: 0.93 }]).status, 'review');
  assert.strictEqual(M.decide([{ id: 'a', score: 0.95 }, { id: 'b', score: 0.6 }]).status, 'auto');
  assert.strictEqual(M.decide([]).status, 'none');
});

t('requête Text Search : nom, rue + unité, ville, code postal', () => {
  assert.strictEqual(M.storeQuery({ ...store, unit: '2', region: 'Quebec' }),
    'Restaurant Saoko Inc., 4520 Rue Saint-Denis #2, Montréal, Quebec, H2J 2L3');
});

t('numéro civique : premier nombre de la rue seulement', () => {
  assert.strictEqual(M.civic('123-A rue X'), '123');
  assert.strictEqual(M.civic('rue X'), null);
});

t('clé Google : GOOGLE_PLACES_API_KEY seulement, jamais de repli sur GOOGLE_MAPS_API_KEY', () => {
  assert.strictEqual(M.createGooglePlaces({ env: { GOOGLE_MAPS_API_KEY: 'vieille' } }).configured(), false);
  assert.strictEqual(M.createGooglePlaces({ env: { GOOGLE_PLACES_API_KEY: 'neuve' } }).configured(), true);
});

(async () => {
  // La clé envoyée à Google est bien la nouvelle.
  let sent = null;
  const http = { post: async (_u, _b, cfg) => { sent = cfg.headers['X-Goog-Api-Key']; return { data: { places: [] } }; } };
  await M.createGooglePlaces({ http, env: { GOOGLE_PLACES_API_KEY: 'neuve', GOOGLE_MAPS_API_KEY: 'vieille' } }).searchText('x y z');
  assert.strictEqual(sent, 'neuve');
  n++; console.log('  ✓ la requête Text Search porte la clé dédiée');
  console.log(`matching : ${n} tests OK`);
})().catch((e) => { console.error('ÉCHEC :', e); process.exit(1); });
