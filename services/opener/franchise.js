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
  // Ajoutées après le premier vrai passage (2026-10-09) : succursales au nom différent ou trop peu nombreuses ici.
  'Kojax', 'Kojax Souvlaki', 'Rockaberry', 'Baskin Robbins', 'Couche-Tard', 'Mito Sushi', 'Onigiri Shop', 'Poke Monster', 'Bento Sushi',
  'Sushi Sama', 'Aki Sushi', "L'Œufrier", 'Columbus Café', 'Dagwoods', 'Mr. Puffs', 'Uniburger', 'Au Pain Doré', 'Double Pizza', 'Pizza Salvatoré',
  'Juliette & Chocolat', 'Cacao 70', 'DAVIDsTEA', 'New York Fries', 'Kitchy Cupcakes', 'Tim Hortons Express', 'Pizzeria Bros', 'Spicebros', "Osmow's", 'Lafleur Restaurants',
];
const KNOWN = new Set(KNOWN_LABELS.map(normName).filter((k) => k.length >= 2));
// Libellé lisible d'une chaîne connue (le premier de la liste) : « Sushi Shop », pas « Sushi Shop Kirkland ».
const KNOWN_LABEL = new Map();
for (const l of KNOWN_LABELS) { const k = normName(l); if (!KNOWN_LABEL.has(k)) KNOWN_LABEL.set(k, l); }
// Préfixes sûrs (≥ 6 lettres) : « Allô mon Coco Plateau Gatineau » → allomoncoco.
const PREFIXES = [...KNOWN].filter((k) => k.length >= 6).sort((a, b) => b.length - a.length);
// Autres noms d'une même chaîne.
const ALIASES = { pfk: 'kfc', toujoursmikes: 'mikes', coradejeunersetdiners: 'cora', chezcora: 'cora',
  rotisseriesthubert: 'sthubert', awcanada: 'aw', quesadaburritostacos: 'quesada', chipotlemexicangrill: 'chipotle',
  popeyeslouisianakitchen: 'popeyes', dixieleechicken: 'dixielee', rotisseriescores: 'scores', restaurantslafleur: 'lafleur',
  cagebrasseriesportive: 'cage', queuesdecastor: 'beavertails', dominos: 'dominospizza',
  kojaxsouflaki: 'kojax', kojaxsouvlaki: 'kojax', timhortonsexpress: 'timhortons', lafleurrestaurants: 'lafleur' };
// Noms GÉNÉRIQUES (premier passage réel, 2026-10-09 : 13 « Pizzéria », 4 « Boulangerie »,
// 7 « Le Café » sans lien entre eux) : jamais une bannière.
const GENERIC = new Set(['restaurant', 'restaurants', 'resto', 'cafe', 'pizzeria', 'pizza', 'boulangerie', 'patisserie',
  'bistro', 'bar', 'pub', 'brasserie', 'traiteur', 'depanneur', 'sushi', 'grill', 'deli', 'bakery', 'cassecroute',
  'shawarma', 'poutine', 'bagel', 'cuisine', 'comptoir', 'epicerie', 'marche', 'cafebar', 'restobar', 'momos', 'snackbar']);
// Mots de tête retirés SEULEMENT pour retrouver une chaîne connue (« Restaurant Boustan » → Boustan,
// « Express St-Hubert » → St-Hubert) ; une bannière inconnue garde son nom entier.
const LEAD_WORDS = ['restaurantetbar', 'restaurants', 'restaurant', 'resto', 'boulangerie', 'cafe', 'express', 'rotisseries', 'rotisserie', 'chez'];

// Clé normalisée → clé de bannière retenue (null = pas une bannière). S'applique aussi aux clés
// déjà en base (sans relire Google) : voir recanonicalize().
function canonicalKey(k) {
  if (!k || GENERIC.has(k)) return null;
  if (ALIASES[k]) return ALIASES[k];
  if (KNOWN.has(k)) return k;
  let p = PREFIXES.find((x) => k.startsWith(x));
  if (p) return p;
  // Toutes les façons de retirer 1 à 3 mots de tête (« restaurantscores » = restaurant + scores,
  // pas restaurants + cores).
  let level = [k];
  for (let i = 0; i < 3 && level.length; i++) {
    const next = [];
    for (const s of level) {
      for (const w of LEAD_WORDS) {
        if (!s.startsWith(w) || s.length <= w.length) continue;
        const t = s.slice(w.length);
        if (ALIASES[t]) return ALIASES[t];
        if (KNOWN.has(t)) return t;
        p = PREFIXES.find((x) => t.startsWith(x));
        if (p) return p;
        next.push(t);
      }
    }
    level = next;
  }
  return k.length >= 3 ? k.slice(0, 120) : null;
}

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
  return canonicalKey(normName(label));
}
const isKnown = (key) => !!key && KNOWN.has(key);
const labelFor = (key, name) => KNOWN_LABEL.get(key) || brandLabel(name);

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
    if (!byKey.has(key)) byKey.set(key, labelFor(key, p.name));
  }
  if (!ids.length) return 0;
  const bk = [...byKey.keys()];
  await pool.query(
    `INSERT INTO opener_brands (brand_key, label, known)
     SELECT k, l, kn FROM unnest($1::text[], $2::text[], $3::bool[]) AS t(k, l, kn)
     ON CONFLICT (brand_key) DO UPDATE SET known = EXCLUDED.known,
       label = CASE WHEN EXCLUDED.known THEN EXCLUDED.label ELSE opener_brands.label END`,
    [bk, bk.map((k) => byKey.get(k)), bk.map(isKnown)]);
  await pool.query(
    `UPDATE opener_places p SET brand_key = t.k FROM unnest($1::text[], $2::text[]) AS t(id, k)
      WHERE p.place_id = t.id AND p.brand_key IS DISTINCT FROM t.k`, [ids, keys]);
  await refreshCounts(pool, bk);
  return ids.length;
}

// Nombre d'ADRESSES (non exclues) par bannière ; toutes les bannières si keys est absent. Deux
// fiches Google à moins d'environ 100 m comptent pour une adresse : un même restaurant a parfois
// 3 fiches (café, bar, traiteur) et passait pour 3 succursales (premier passage, 2026-10-09).
async function refreshCounts(pool, keys) {
  await pool.query(
    `UPDATE opener_brands b SET n = COALESCE(c.n, 0), updated_at = CURRENT_TIMESTAMP
       FROM opener_brands b2
       LEFT JOIN (SELECT brand_key, COUNT(DISTINCT COALESCE(ROUND(lat::numeric, 3)::text || ',' || ROUND(lng::numeric, 3)::text, place_id))::int AS n
                    FROM opener_places
                   WHERE brand_key IS NOT NULL AND excluded_at IS NULL GROUP BY brand_key) c ON c.brand_key = b2.brand_key
      WHERE b.brand_key = b2.brand_key AND ($1::text[] IS NULL OR b.brand_key = ANY($1::text[]))
        AND b.n IS DISTINCT FROM COALESCE(c.n, 0)`, [keys || null]);
}

// Les règles de reconnaissance ont changé (CANON_VERSION) : les clés déjà en base sont
// recalculées depuis la clé elle-même, sans relire Google. Les décisions du gestionnaire suivent
// la bannière quand elle est fusionnée dans une autre qui n'en a pas.
const CANON_VERSION = 5;
async function recanonicalize(pool) {
  const st = (await pool.query(`SELECT value FROM sync_state WHERE key = 'opener_brand_canon'`)).rows[0]?.value;
  if (Number(st) >= CANON_VERSION) return null;
  const old = (await pool.query(
    `SELECT DISTINCT p.brand_key AS k, b.label, b.decision, b.decided_by, b.decided_at
       FROM opener_places p LEFT JOIN opener_brands b ON b.brand_key = p.brand_key WHERE p.brand_key IS NOT NULL`)).rows;
  let moved = 0, cleared = 0;
  for (const o of old) {
    const k = canonicalKey(o.k);
    if (k === o.k) continue;
    if (!k) {
      await pool.query(`UPDATE opener_places SET brand_key = NULL WHERE brand_key = $1`, [o.k]);
      cleared++; continue;
    }
    await pool.query(
      `INSERT INTO opener_brands (brand_key, label, known, decision, decided_by, decided_at) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (brand_key) DO UPDATE SET
         decision = COALESCE(opener_brands.decision, EXCLUDED.decision),
         decided_by = CASE WHEN opener_brands.decision IS NULL THEN EXCLUDED.decided_by ELSE opener_brands.decided_by END,
         decided_at = CASE WHEN opener_brands.decision IS NULL THEN EXCLUDED.decided_at ELSE opener_brands.decided_at END`,
      [k, KNOWN_LABEL.get(k) || o.label || k, isKnown(k), o.decision || null, o.decided_by || null, o.decided_at || null]);
    await pool.query(`UPDATE opener_places SET brand_key = $2 WHERE brand_key = $1`, [o.k, k]);
    moved++;
  }
  // Liste des chaînes connues élargie : drapeau et libellé lisible à jour partout.
  const known = [...KNOWN];
  await pool.query(`UPDATE opener_brands SET known = (brand_key = ANY($1::text[])) WHERE known IS DISTINCT FROM (brand_key = ANY($1::text[]))`, [known]);
  for (const [k, l] of KNOWN_LABEL) await pool.query(`UPDATE opener_brands SET label = $2 WHERE brand_key = $1 AND label <> $2`, [k, l]);
  await refreshCounts(pool);
  await pool.query(
    `INSERT INTO sync_state (key, value, updated_at) VALUES ('opener_brand_canon', $1, CURRENT_TIMESTAMP)
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = CURRENT_TIMESTAMP`, [String(CANON_VERSION)]);
  return { moved, cleared };
}

module.exports = { brandKey, brandLabel, canonicalKey, isKnown, MIN_LOCATIONS, KNOWN, SCHEMA, franchiseSql, tagPlaces, refreshCounts, recanonicalize };
