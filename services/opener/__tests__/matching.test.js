// Notation de l'appariement Kaizen ↔ Google.   node services/opener/__tests__/matching.test.js
const assert = require('assert');
const M = require('../matching');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ✓', name); };

const place = (id, name, postal, num, extra = {}) => ({
  id, displayName: { text: name }, formattedAddress: `${num} Rue X, Montréal, QC ${postal}`,
  location: { latitude: 45.52, longitude: -73.58 },
  primaryType: 'restaurant', types: ['restaurant', 'food', 'point_of_interest', 'establishment'],
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

t('cas réel : « Pile ou Glace - Petite Italie » = « Pile Ou Glace Gelateria » à la même adresse → auto', () => {
  const s = M.scoreCandidate(
    { name: 'Pile ou Glace - Petite Italie', street: '7084 Boulevard Saint-Laurent', postal_code: 'H2S 3E2' },
    place('p', 'Pile Ou Glace Gelateria', 'H2S 3E2', '7084'));
  assert.ok(s.score >= M.AUTO, JSON.stringify(s));
});

t('marque seule : suffixes de succursale reconnus, nom simple inchangé', () => {
  assert.deepStrictEqual(M.nameVariants('Saoko | Mile End'), ['Saoko | Mile End', 'Saoko']);
  assert.deepStrictEqual(M.nameVariants('Kazu (Plateau)'), ['Kazu (Plateau)', 'Kazu']);
  assert.deepStrictEqual(M.nameVariants('Pied-de-Cochon'), ['Pied-de-Cochon'], 'un trait d\'union sans espaces ne coupe pas');
  // La marque seule ne rend pas ressemblant ce qui ne l'est pas.
  assert.ok(M.nameSim('Pile ou Glace - Petite Italie', 'Pizza Italia') < 0.5);
});

t('adresse ≠ commerce : un immeuble est reconnu, un restaurant non', () => {
  assert.strictEqual(M.isAddressOnly({ types: ['premise', 'geocode'] }), true);
  assert.strictEqual(M.isAddressOnly({ types: ['street_address'] }), true);
  assert.strictEqual(M.isAddressOnly({ primaryType: 'restaurant', types: ['restaurant', 'point_of_interest', 'establishment'] }), false);
  assert.strictEqual(M.addressQuery({ street: '51 Westminster North', city: 'Montréal-Ouest', postal_code: 'H4X 1Y8' }),
    'restaurant, 51 Westminster North, Montréal-Ouest, H4X 1Y8');
  assert.strictEqual(M.addressQuery({ street: null }), null);
});

// Les deux cas signalés par David le 2026-10-07 (« dans 95 % des cas ça devrait matcher »).
t('vrai cas : « La terasse du Trad » au 195 contre « La terrasse du Trad » au 194, même code postal → auto', () => {
  const s = { name: 'La terasse du Trad', street: '195 Chem. Métivier', postal_code: 'G0R 2Y0' };
  const sc = M.scoreCandidate(s, place('T', 'La terrasse du Trad', 'G0R 2Y0', '194'));
  assert.strictEqual(sc.parts.civic, 'near');
  assert.strictEqual(M.decide([{ id: 'T', ...sc }]).status, 'auto', JSON.stringify(sc));
});
t('vrai cas : « Pizza 2 Freres » contre « Pizza Deux Frères — Blainville », même adresse → auto', () => {
  const s = { name: 'Pizza 2 Freres', street: '1185 Bd Curé-Labelle', postal_code: 'J7C 4K6' };
  const sc = M.scoreCandidate(s, place('P', 'Pizza Deux Frères — Blainville', 'J7C 4K6', '1185'));
  assert.strictEqual(sc.parts.name, 1);
  assert.strictEqual(M.decide([{ id: 'P', ...sc }]).status, 'auto');
});
t('garde-fous : numéro à plus de 4 portes → pénalité ; nom différent à la même adresse → pas auto', () => {
  const s = { name: 'La terasse du Trad', street: '195 Chem. Métivier', postal_code: 'G0R 2Y0' };
  assert.strictEqual(M.scoreCandidate(s, place('T', 'La terrasse du Trad', 'G0R 2Y0', '205')).parts.civic, 'diff');
  const other = M.scoreCandidate({ name: 'Pizza 2 Freres', street: '1185 Bd Curé-Labelle', postal_code: 'J7C 4K6' },
    place('Q', 'Dépanneur Couche-Tard', 'J7C 4K6', '1185'));
  assert.notStrictEqual(M.decide([{ id: 'Q', ...other }]).status, 'auto', JSON.stringify(other));
});
// Cas réels de la prod (2026-10-07), notés via la vue gardée (adresse formatée), comme en renotation.
const viaView = (s, name, address) => { const r = M.rescoreStored(s, [{ id: 'G', googleName: name, address }]); return { d: M.decide(r), p: r[0].view.parts }; };
t('même porte + code postal approximatif dans Billing → auto (Sawadika, Metro Pizza sans code postal)', () => {
  let x = viaView({ name: 'Sawadika Saint-Hubert', street: '6078, Ch. de Chambly', postal_code: 'J3Y 3R5', city: 'Saint-Hubert' }, 'Sawadika Saint-Hubert', '6078 Ch. de Chambly, Saint-Hubert, QC J3Y 3R6, Canada');
  assert.strictEqual(x.d.status, 'auto', JSON.stringify(x.p)); assert.strictEqual(x.p.address, 'same');
  x = viaView({ name: 'METRO PIZZA VERDUN', street: '5101 Rue Bannantyne', postal_code: null }, 'Metro Pizza Verdun', '5101 Av Bannantyne, Verdun, QC H4H 1E5, Canada');
  assert.strictEqual(x.d.status, 'auto', JSON.stringify(x.p));
});
t('garde-fou : même porte mais code postal ET ville différents (CrepOne Gloucester / Gatineau) → pas auto', () => {
  const x = viaView({ name: 'CrepOne', street: '668 Saint Joseph Boulevard', postal_code: 'K1C 7L1', city: 'Gloucester' }, 'CrepOne', '668 Bd Saint-Joseph, Gatineau, QC J8Y 4A8, Canada');
  assert.notStrictEqual(x.d.status, 'auto', JSON.stringify(x.p));
});
t('local et numéro civique mêlés (« 40-9415 Boul. Leduc », « Unit 8 Blvd 425 ») → même numéro', () => {
  let x = viaView({ name: 'Madame Poulet ‐ Châteauguay (NEW)', street: '136 - 72 boul. Saint-Jean-Baptiste', postal_code: 'J6K4Y7' }, 'Madame Poulet', '72 Bd Saint-Jean-Baptiste #136, Châteauguay, QC J6K 4Y7, Canada');
  assert.strictEqual(x.p.civic, 'same'); assert.strictEqual(x.d.status, 'auto');
  x = viaView({ name: 'Izakaya Kobachi', street: 'Unit 8 Blvd 425 St-Joseph', postal_code: 'J8Y 0A8' }, 'Izakaya Kobachi', '425 Bd Saint-Joseph #8, Gatineau, QC J8Y 3Z5, Canada');
  assert.strictEqual(x.p.civic, 'same'); assert.strictEqual(x.d.status, 'auto');
});
t('mot distinctif commun (« Superbol », « boulle »/« bulle ») → auto ; mot de métier seul (« Lounge », « Golf ») → non', () => {
  let x = viaView({ name: "Superbol Val D'Or", street: '1603 3e avenue', postal_code: 'J9P4N5' }, 'Superbol Abitibi', "1603 3e Avenue, Val-d'Or, QC J9P 4N5, Canada");
  assert.strictEqual(x.p.token, 'superbol'); assert.strictEqual(x.d.status, 'auto');
  x = viaView({ name: 'boulle et bol', street: '3460 rue peel', postal_code: 'H3A 2M1' }, 'Bulle & Bol', '3460 Rue Peel, Montréal, QC H3A 2M1, Canada');
  assert.strictEqual(x.d.status, 'auto', JSON.stringify(x.p));
  x = viaView({ name: 'Golf Le 19 - Marieville', street: '655 Rue Sainte-Marie', postal_code: 'J3M 1J4' }, 'Le19 Golf Lounge', '655 Rue Sainte-Marie, Marieville, QC J3M 1J4, Canada');
  assert.notStrictEqual(x.d.status, 'auto', JSON.stringify(x.p));
  x = viaView({ name: 'Bol express St-Leonard', street: '8770, Boul. Langelier', postal_code: 'H1P 3A3' }, 'Pro Gym', '8770 Boul Langelier, Montréal, QC H1P 3A3, Canada');
  assert.notStrictEqual(x.d.status, 'auto', 'autre commerce à la même adresse');
});
t('« rue St.Vincent » = « Rue St Vincent » (St. avec point)', () => {
  const x = viaView({ name: 'Restaurant Chez Mikael (NEW)', street: '67 rue St.Vincent', postal_code: 'J8C 2A5' }, 'Restaurant Mikael', '67 Rue St Vincent, Sainte-Agathe-des-Monts, QC J8C 2A1, Canada');
  assert.strictEqual(x.p.address, 'same', JSON.stringify(x.p)); assert.strictEqual(x.d.status, 'auto');
});
t('renotation SANS Google à partir des candidats gardés (adresse formatée relue)', () => {
  const s = { name: 'Pizza 2 Freres', street: '1185 Bd Curé-Labelle', postal_code: 'J7C 4K6' };
  const r = M.rescoreStored(s, [{ id: 'P', googleName: 'Pizza Deux Frères — Blainville', address: '1185 Bd Curé-Labelle, Blainville, QC J7C 4K6, Canada', lat: 45.6, lng: -73.8 }]);
  assert.strictEqual(r[0].id, 'P');
  assert.strictEqual(M.decide(r).status, 'auto');
  assert.strictEqual(r[0].view.lat, 45.6, 'la vue garde les coordonnées pour la fiche');
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
  // Plafond du jour : Google répond 429 / RESOURCE_EXHAUSTED → erreur marquée « quota ».
  for (const resp of [{ status: 429, data: { error: { message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } } },
                      { status: 403, data: { error: { message: 'x', status: 'RESOURCE_EXHAUSTED' } } }]) {
    const http429 = { post: async () => { const e = new Error('rq'); e.response = resp; throw e; } };
    const err = await M.createGooglePlaces({ http: http429, env: { GOOGLE_PLACES_API_KEY: 'k' } }).searchText('abc').catch((e) => e);
    assert.strictEqual(err.quota, true, JSON.stringify(resp));
  }
  n++; console.log('  ✓ plafond Google (429 / RESOURCE_EXHAUSTED) → erreur « quota »');
  console.log(`matching : ${n} tests OK`);
})().catch((e) => { console.error('ÉCHEC :', e); process.exit(1); });
