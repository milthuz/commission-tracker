// ============================================================================
// Franchises (2026-10-09, demande de David : « classifier les franchises à part, car souvent elles
// utilisent le même POS — ça nous évite de nous déplacer pour rien »).
//
// La BANNIÈRE d'un commerce = son nom sans succursale (« Thai Express - Plateau » → « Thai
// Express »), normalisé en clé (« thaiexpress »). Une bannière est une franchise si elle est
// CONNUE (liste ci-dessous) ou si elle compte au moins MIN_LOCATIONS adresses sur le territoire.
// Le gestionnaire peut forcer une bannière : « franchise » (skip) ou « à visiter » (visit).
// On ne garde de Google que la clé de bannière, pas la fiche.
// ============================================================================

const { normName } = require('./matching');

const MIN_LOCATIONS = 3;

// Bannières répandues au Québec, écrites comme on les lit (normalisées au chargement). Une
// bannière absente d'ici est quand même reconnue dès qu'elle a MIN_LOCATIONS adresses.
const KNOWN_LABELS = [
  "McDonald's", 'Tim Hortons', 'Subway', 'A&W', 'A&W Canada', 'St-Hubert', 'Rôtisserie St-Hubert', 'Pizza Pizza',
  "Domino's Pizza", 'Pizza Hut', 'Little Caesars', 'Starbucks', 'Second Cup', 'Van Houtte', 'Café Dépôt',
  'Presse Café', 'Première Moisson', 'Cora', 'Chez Cora', 'Ben & Florentine', 'Eggsquis', 'Benny & Co.',
  'Rôtisseries Benny', "Mary Brown's", 'KFC', 'Burger King', "Wendy's", "Harvey's", 'Dairy Queen', 'Valentine',
  'La Belle Province', 'Lafleur', 'Restaurants Lafleur', 'Popeyes', 'Popeyes Louisiana Kitchen', 'Boston Pizza',
  'Scores', 'Rôtisserie Scores', "Mike's", 'Normandin', 'Bâton Rouge', 'Les 3 Brasseurs', 'La Cage', 'La Cage Brasserie sportive',
  'Thai Express', 'Sushi Shop', 'Yuzu Sushi', 'Copper Branch', 'Freshii', 'Jugo Juice', 'Booster Juice', 'Panago',
  'Chez Ashton', 'Basha', 'Amir', 'Boustan', 'Pizzédélic', 'Tutti Frutti', 'Cocofrutti', 'Krispy Kreme', 'Five Guys',
  'Chipotle', 'Chipotle Mexican Grill', 'Taco Bell', "Nando's", 'Mucho Burrito', 'Quesada', 'Quesada Burritos & Tacos',
  'BarBurrito', 'Pita Pit', 'Mr. Sub', 'Quiznos', 'Jimmy the Greek', 'Manchu Wok', 'Edo Japan', 'Teriyaki Experience',
  'Tiki-Ming', 'Café Vienne', 'Madame Poulet', 'Allô mon coco', 'La Panthère Verte', 'Tommy Café', 'Jollibee',
  'Chick-fil-A', "Denny's", "Kelsey's", "Montana's", "East Side Mario's", "Chuck's Roadhouse", 'Elephant & Castle',
  'Milestones', 'La Boîte à Pain', 'Dixie Lee', 'Dixie Lee Chicken', "Papa John's", 'Pizza Nova', '241 Pizza',
  'Pizzaville', 'Pacini', 'Commensal', 'Il Fornello', 'Ok Pizza', 'Pizza Salvatoré', 'Pizza Royale', 'Mikes',
  'Chez Victor', 'Prêt à Manger', 'Mandy\'s', 'Lola Rosa', 'Café Myriade', 'Crémy', 'Marble Slab', 'Cinnabon',
  'Cultures', 'Sushi Taxi', 'Sushi À La Maison', 'Gyu-Kaku', 'Kinton Ramen', 'Pho Bang New York', 'Poulet Rouge',
  'Mon Ami Poké', 'Poke Box', 'Nouilles de Lan Zhou', 'Shawarma Djouné', 'Beavertails', 'Queues de Castor',
];
const KNOWN = new Set(KNOWN_LABELS.map(normName).filter((k) => k.length >= 2));
// Préfixes sûrs (≥ 6 lettres) : « Allô mon Coco Plateau Gatineau » → allomoncoco.
const PREFIXES = [...KNOWN].filter((k) => k.length >= 6).sort((a, b) => b.length - a.length);

// Libellé de bannière : le nom avant le séparateur de succursale.
function brandLabel(name) {
  const s = String(name || '').trim();
  if (!s) return null;
  const head = s.split(/\s+[-–—|·:]\s+|\s*\(|\s+#\s*\d|\s+no\.?\s*\d/i)[0].trim();
  return (head || s).slice(0, 160);
}
function brandKey(name) {
  const label = brandLabel(name);
  if (!label) return null;
  const k = normName(label);
  if (KNOWN.has(k)) return k;
  const p = PREFIXES.find((x) => k.startsWith(x));
  if (p) return p;
  return k.length >= 3 ? k.slice(0, 120) : null;
}
const isKnown = (key) => !!key && KNOWN.has(key);

// ---------------------------------------------------------------------------- stockage
// opener_places.brand_key + opener_brands (une ligne par bannière : libellé, connue ?, nombre
// d'adresses, décision du gestionnaire). Exécuté après le schéma de field.js.
const SCHEMA = [
  `ALTER TABLE opener_places ADD COLUMN IF NOT EXISTS brand_key VARCHAR(120)`,
  `CREATE INDEX IF NOT EXISTS idx_opener_places_brand ON opener_places (brand_key)`,
  `CREATE TABLE IF NOT EXISTS opener_brands (
    brand_key  VARCHAR(120) PRIMARY KEY,
    label      VARCHAR(160) NOT NULL,
    known      BOOLEAN NOT NULL DEFAULT false,
    n          INTEGER NOT NULL DEFAULT 0,
    decision   VARCHAR(5),
    decided_by VARCHAR(255),
    decided_at TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
];

// LA règle, en une seule expression partagée par tous les points qui écartent une franchise
// (campagne, balayage, fiche) : décision « skip », ou pas de décision et (connue ou ≥ 3 adresses).
const franchiseSql = (alias = 'p') =>
  `EXISTS (SELECT 1 FROM opener_brands fb WHERE fb.brand_key = ${alias}.brand_key
     AND (fb.decision = 'skip' OR (fb.decision IS NULL AND (fb.known OR fb.n >= ${MIN_LOCATIONS}))))`;

// Étiquette des établissements vus chez Google : [{ id, name }]. Le nombre d'adresses de chaque
// bannière touchée est recompté aussitôt.
async function tagPlaces(pool, list) {
  const byKey = new Map(); const ids = []; const keys = [];
  for (const p of list) {
    const key = brandKey(p.name);
    if (!p.id || !key) continue;
    ids.push(p.id); keys.push(key);
    if (!byKey.has(key)) byKey.set(key, brandLabel(p.name));
  }
  if (!ids.length) return 0;
  const bk = [...byKey.keys()];
  await pool.query(
    `INSERT INTO opener_brands (brand_key, label, known)
     SELECT k, l, kn FROM unnest($1::text[], $2::text[], $3::bool[]) AS t(k, l, kn)
     ON CONFLICT (brand_key) DO UPDATE SET known = EXCLUDED.known`,
    [bk, bk.map((k) => byKey.get(k)), bk.map(isKnown)]);
  await pool.query(
    `UPDATE opener_places p SET brand_key = t.k FROM unnest($1::text[], $2::text[]) AS t(id, k)
      WHERE p.place_id = t.id AND p.brand_key IS DISTINCT FROM t.k`, [ids, keys]);
  await refreshCounts(pool, bk);
  return ids.length;
}

// Nombre d'adresses (non exclues) par bannière ; toutes les bannières si keys est absent.
async function refreshCounts(pool, keys) {
  await pool.query(
    `UPDATE opener_brands b SET n = COALESCE(c.n, 0), updated_at = CURRENT_TIMESTAMP
       FROM opener_brands b2
       LEFT JOIN (SELECT brand_key, COUNT(*)::int AS n FROM opener_places
                   WHERE brand_key IS NOT NULL AND excluded_at IS NULL GROUP BY brand_key) c ON c.brand_key = b2.brand_key
      WHERE b.brand_key = b2.brand_key AND ($1::text[] IS NULL OR b.brand_key = ANY($1::text[]))
        AND b.n IS DISTINCT FROM COALESCE(c.n, 0)`, [keys || null]);
}

module.exports = { brandKey, brandLabel, isKnown, MIN_LOCATIONS, KNOWN, SCHEMA, franchiseSql, tagPlaces, refreshCounts };
