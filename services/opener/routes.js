// ============================================================================
// Module Opener — lot 0 : les emplacements Cluster et leur fiche Google.
//
// Plan : design/opener/PLAN-TECHNIQUE.md, §1 et §3.
//
// DEUX SOURCES dans une seule table, `cluster_locations` :
//   kaizen   l'API Kaizen = le parc V2, certain. Actifs et inactifs.
//   billing  les clients Zoho Billing de Cluster Canada et Xperio (services/opener/billing.js) =
//            le parc V1 (demande de David, 2026-10-06 : l'API Kaizen ne connaît que la V2).
//
// VERSION DU LOGICIEL (software_version, remplaçable à la main par version_override) :
//   kaizen                                   → v2
//   billing, même restaurant qu'un Kaizen    → v2 (« jumeau » : twin_of) — un client V2 a aussi
//                                              un abonnement, c'est le cas normal
//   billing, sans jumeau Kaizen              → v1
// Le jumeau se reconnaît à la même fiche Google, ou au même nom (marque) + même code postal.
//
// Statuts d'appariement (match_status) :
//   pending     jamais tenté (ou adresse modifiée depuis)
//   auto        apparié par le score (≥ 0,80, sans rival proche), ou copié de son jumeau Kaizen
//   review      candidat plausible, décision humaine requise
//   none        rien de plausible ; retenté après 30 jours
//   no_address  ni rue ni code postal : pas de recherche automatique (une chaîne s'y tromperait)
//   manual      choisi par un humain — JAMAIS écrasé par l'automatique
//   ignored     écarté par un humain (magasin test, entrepôt, sans fiche Google)
//
// Permission : opener:match (tout l'écran, y compris les boutons de synchro).
// ============================================================================

const { createKaizenClient, kaizenConfigured, normalizeStore } = require('./kaizen');
const B = require('./billing');
const M = require('./matching');

const PERM_MATCH = 'opener:match';
const STATUSES = ['pending', 'auto', 'review', 'none', 'no_address', 'manual', 'ignored'];
const SOURCES = ['kaizen', 'billing'];
const PLACE_RE = /^[A-Za-z0-9_-]{10,300}$/;
const DEFAULT_MATCH_BUDGET = 300;     // recherches Text Search par passage ; ~0,03 $US l'une
const DEFAULT_ADDRESS_BUDGET = 400;   // contacts Books lus par passage manuel (~5 min)
const NIGHTLY_ADDRESS_BUDGET = 1500;  // la nuit, personne n'attend
// Restaurants cherchés dans Google par passage de NUIT (décision de David, 2026-10-07 : 900, pour
// finir le parc en 3-4 nuits ; même coût total). Un restaurant peut demander 2 recherches : si le
// plafond quotidien Google est atteint, le passage s'arrête proprement (voir runMatching).
const NIGHTLY_MATCH_BUDGET = 900;
const ADDRESS_REFRESH_DAYS = 30;
const RETRY_NONE_DAYS = 30;
const LOCK_KEY = 'opener_locations_lock';
// Un verrou non renouvelé depuis 5 min appartient à un passage mort (redémarrage, déploiement) :
// il est repris. Le passage vivant le renouvelle à chaque écriture de progression (≤ 1,5 s) et
// toutes les 10 adresses / 20 recherches. Il était de 30 min : un passage tué bloquait la suite.
const LOCK_STALE_MIN = 5;
const STATE_LAST_RUN = 'opener_locations_last_run';
const STATE_LAST_OK = 'opener_locations_last_ok';
const STATE_PROGRESS = 'opener_locations_progress';
const ORG_NAMES = { '697704869': 'Cluster Canada', '905113716': 'Xperio POS', '802470810': 'Cluster USA' };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS cluster_locations (
    id                 SERIAL PRIMARY KEY,
    source             VARCHAR(12) NOT NULL,
    source_key         VARCHAR(120) NOT NULL,
    org_id             VARCHAR(20),
    store_id           VARCHAR(60),
    name               VARCHAR(255) NOT NULL,
    street             VARCHAR(255),
    unit               VARCHAR(60),
    city               VARCHAR(120),
    region             VARCHAR(120),
    postal_code        VARCHAR(20),
    country            VARCHAR(60),
    active             BOOLEAN NOT NULL DEFAULT true,
    extra              JSONB,
    addr_key           VARCHAR(500),
    dedup_key          VARCHAR(300),
    software_version   VARCHAR(4),
    version_override   VARCHAR(4),
    twin_of            INTEGER,
    missing_since      TIMESTAMP,
    first_seen_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    synced_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    match_status       VARCHAR(12) NOT NULL DEFAULT 'pending',
    place_id           VARCHAR(300),
    match_score        NUMERIC(4,3),
    match_candidates   JSONB,
    match_attempted_at TIMESTAMP,
    matched_by         VARCHAR(255),
    matched_at         TIMESTAMP,
    match_note         VARCHAR(200),
    match_version      SMALLINT NOT NULL DEFAULT 1,
    UNIQUE (source, source_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cluster_locations_status ON cluster_locations (match_status)`,
  `CREATE INDEX IF NOT EXISTS idx_cluster_locations_place  ON cluster_locations (place_id)`,
  `CREATE INDEX IF NOT EXISTS idx_cluster_locations_dedup  ON cluster_locations (dedup_key)`,
  // Adresses des contacts Books, gardées : les relire à chaque passage coûterait des milliers
  // d'appels. Rafraîchies tous les 30 jours.
  `CREATE TABLE IF NOT EXISTS opener_billing_addresses (
    source_key   VARCHAR(120) PRIMARY KEY,
    street       VARCHAR(255),
    unit         VARCHAR(60),
    city         VARCHAR(120),
    region       VARCHAR(120),
    postal_code  VARCHAR(20),
    country      VARCHAR(60),
    which        VARCHAR(10),
    error        VARCHAR(200),
    fetched_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS opener_places (
    place_id            VARCHAR(300) PRIMARY KEY,
    lat                 DOUBLE PRECISION,
    lng                 DOUBLE PRECISION,
    coords_refreshed_at TIMESTAMP,
    source              VARCHAR(20) NOT NULL DEFAULT 'kaizen',
    first_seen_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_opener_places_geo ON opener_places (lat, lng)`,
];

async function ensureSchema(pool) {
  // Une instruction par appel : PGlite (tests) refuse les lots, et une erreur pointe ainsi la bonne ligne.
  for (const sql of SCHEMA) await pool.query(sql);
  // Reprise UNIQUE de la première table (kaizen_stores, 2026-10-06) : les décisions déjà prises
  // sur les magasins Kaizen ne se perdent pas. L'ancienne table est laissée en place.
  const old = (await pool.query(`SELECT to_regclass('kaizen_stores') AS t`)).rows[0]?.t;
  if (old) {
    await pool.query(
      `INSERT INTO cluster_locations (source, source_key, store_id, name, street, unit, city, region, postal_code,
              country, active, addr_key, software_version, missing_since, first_seen_at, synced_at, match_status,
              place_id, match_score, match_candidates, match_attempted_at, matched_by, matched_at, match_note, match_version)
       SELECT 'kaizen', uuid::text, store_id, name, street, unit, city, region, postal_code,
              country, active, addr_key, 'v2', missing_since, first_seen_at, synced_at, match_status,
              place_id, match_score, match_candidates, match_attempted_at, matched_by, matched_at, match_note,
              COALESCE(match_version, 1)
         FROM kaizen_stores
       ON CONFLICT (source, source_key) DO NOTHING`);
  }
}

// Clé d'adresse : sert à savoir si l'adresse a BOUGÉ depuis le dernier appariement.
const addrKey = (s) => [s.street, s.unit, s.city, s.region, M.normPostal(s.postalCode)]
  .map((x) => String(x || '').trim().toLowerCase()).join('|').slice(0, 500);
// Clé de jumeau : la marque (sans suffixe de succursale) + le code postal. Vide si l'un manque.
function dedupKey(name, postal) {
  const pc = M.normPostal(postal);
  const variants = M.nameVariants(name);
  const k = M.nameKey(variants[variants.length - 1]);
  return pc && k ? `${k}|${pc}`.slice(0, 300) : '';
}

function registerOpenerRoutes(app, deps) {
  const { authenticateToken, requirePerm, pool, logActivity } = deps;
  const kaizen = deps.kaizen || createKaizenClient();
  const google = deps.google || M.createGooglePlaces();
  const books = deps.books || B.createBooksContacts({ sleep: deps.sleep });
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pace = deps.paceMs ?? 650;            // < 100 appels Books à la minute
  const kaizenReady = deps.kaizenConfigured || (() => kaizenConfigured());
  // Ce que le module lit dans server.js, défini bien plus bas que son enregistrement.
  const late = () => (deps.late ? deps.late() : null);

  let ready = null;
  const schema = () => (ready = ready || ensureSchema(pool).catch((e) => { ready = null; throw e; }));
  if (pool) schema().catch((e) => console.error('opener schema:', e.message));

  const actorOf = (req) => req.user?.realAdminEmail || req.user?.email || 'unknown';
  const log = (id, event, desc, actor, extra) =>
    Promise.resolve(logActivity && logActivity('cluster_location', id, event, desc, actor, extra)).catch(() => {});

  async function putState(key, obj) {
    await pool.query(
      `INSERT INTO sync_state (key, value, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP`,
      [key, JSON.stringify(obj)]);
  }
  async function getState(key) {
    const v = (await pool.query(`SELECT value FROM sync_state WHERE key = $1`, [key])).rows[0]?.value;
    try { return v ? JSON.parse(v) : null; } catch { return null; }
  }

  // Verrou en base : une seule synchro à la fois, web ET worker confondus. Un verrou de plus de
  // 30 min est considéré comme abandonné (processus tué en cours de route).
  async function takeLock() {
    const r = await pool.query(
      `INSERT INTO sync_state (key, value, updated_at) VALUES ($1, 'running', CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE SET value = 'running', updated_at = CURRENT_TIMESTAMP
        WHERE sync_state.value <> 'running' OR sync_state.updated_at < CURRENT_TIMESTAMP - INTERVAL '${LOCK_STALE_MIN} minutes'
       RETURNING key`, [LOCK_KEY]);
    return r.rows.length > 0;
  }
  // L'âge du verrou se calcule DANS Postgres : `updated_at` est un TIMESTAMP sans fuseau, et le
  // comparer à Date.now() dépendrait du fuseau du processus Node.
  const isRunning = async () => (await pool.query(
    `SELECT 1 FROM sync_state WHERE key = $1 AND value = 'running'
        AND updated_at >= CURRENT_TIMESTAMP - INTERVAL '${LOCK_STALE_MIN} minutes'`, [LOCK_KEY])).rows.length > 0;
  // Progression lisible par l'écran pendant la synchro (phase + n / total). Écrite au plus toutes
  // les 1,5 s : la base est loin (proxy Railway), un aller-retour par recherche Google serait du
  // gaspillage. Un changement de phase s'écrit tout de suite.
  let progLast = { phase: null, at: 0 };
  async function progress(phase, done = 0, total = 0, force = false) {
    const now = Date.now();
    if (!force && phase === progLast.phase && now - progLast.at < 1500) return;
    progLast = { phase, at: now };
    await putState(STATE_PROGRESS, { phase, done, total, at: new Date(now).toISOString() }).catch(() => {});
    await touchLock();
  }
  const touchLock = () => pool.query(`UPDATE sync_state SET updated_at = CURRENT_TIMESTAMP WHERE key = $1 AND value = 'running'`, [LOCK_KEY]).catch(() => {});
  const releaseLock = () => pool.query(`UPDATE sync_state SET value = 'idle', updated_at = CURRENT_TIMESTAMP WHERE key = $1`, [LOCK_KEY]);

  // --------------------------------------------------------------------------
  // Écriture commune aux deux sources
  // --------------------------------------------------------------------------
  // Une adresse modifiée remet en jeu un appariement AUTOMATIQUE (ou un échec), jamais un
  // appariement manuel ni un « ignoré » : une décision humaine ne se défait pas en silence.
  async function upsertLocations(source, items, start) {
    let inserted = 0, updated = 0, rematch = 0;
    const COLS = 15;
    for (let i = 0; i < items.length; i += 200) {
      const part = items.slice(i, i + 200);
      const vals = [];
      const rows = part.map((s, j) => {
        const b = j * COLS;
        vals.push(source, s.sourceKey, s.orgId || null, s.storeId || null, s.name, s.street, s.unit, s.city, s.region,
          s.postalCode, s.country, s.active, addrKey(s), dedupKey(s.name, s.postalCode), s.extra ? JSON.stringify(s.extra) : null);
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},`
          + `$${b + 12}::boolean,$${b + 13},$${b + 14},$${b + 15}::jsonb,$${part.length * COLS + 1}::timestamp,`
          // Version dès l'écriture : Kaizen = V2 ; un client Billing est V1 jusqu'à ce que linkTwins
          // (fin du passage) lui trouve un jumeau Kaizen. Sans ça, la tuile V1 restait à 0 pendant
          // toute la lecture des adresses. L'UPDATE ne touche pas la version : celle déjà calculée reste.
          + `${source === 'kaizen' ? `'v2'` : `'v1'`})`;
      });
      vals.push(start);
      const changed = `cluster_locations.addr_key IS DISTINCT FROM EXCLUDED.addr_key
                       AND cluster_locations.match_status IN ('auto','review','none','no_address')`;
      const r = await pool.query(
        `INSERT INTO cluster_locations (source, source_key, org_id, store_id, name, street, unit, city, region,
                postal_code, country, active, addr_key, dedup_key, extra, synced_at, software_version)
         VALUES ${rows.join(',')}
         ON CONFLICT (source, source_key) DO UPDATE SET
           org_id = EXCLUDED.org_id, store_id = EXCLUDED.store_id, name = EXCLUDED.name, street = EXCLUDED.street,
           unit = EXCLUDED.unit, city = EXCLUDED.city, region = EXCLUDED.region, postal_code = EXCLUDED.postal_code,
           country = EXCLUDED.country, active = EXCLUDED.active, synced_at = EXCLUDED.synced_at,
           dedup_key = EXCLUDED.dedup_key, extra = EXCLUDED.extra, missing_since = NULL,
           match_status = CASE WHEN ${changed} THEN 'pending' ELSE cluster_locations.match_status END,
           place_id = CASE WHEN ${changed} THEN NULL ELSE cluster_locations.place_id END,
           match_candidates = CASE WHEN ${changed} THEN NULL ELSE cluster_locations.match_candidates END,
           match_note = CASE WHEN cluster_locations.addr_key IS DISTINCT FROM EXCLUDED.addr_key
                               AND cluster_locations.match_status = 'manual'
                             THEN 'Adresse modifiée à la source depuis l''appariement manuel'
                             ELSE cluster_locations.match_note END,
           addr_key = EXCLUDED.addr_key
         RETURNING (xmax = 0) AS ins, (match_status = 'pending') AS pend`, vals);
      for (const row of r.rows) { if (row.ins) inserted++; else { updated++; if (row.pend) rematch++; } }
    }
    return { inserted, updated, rematch };
  }

  // Disparus : seulement si la réponse est crédible. Une liste soudain réduite de moitié est
  // bien plus probablement une réponse partielle qu'une vague de fermetures — même leçon que
  // les fausses suppressions de la synchro Zoho (2026-08-18).
  async function markMissing(source, seenCount, start) {
    const before = Number((await pool.query(
      `SELECT COUNT(*)::int AS n FROM cluster_locations WHERE source = $1 AND missing_since IS NULL`, [source])).rows[0].n);
    if (before >= 20 && seenCount < before * 0.5) return { missing: 0, missingSkipped: true };
    const r = await pool.query(
      `UPDATE cluster_locations SET missing_since = $2 WHERE source = $1 AND synced_at < $2 AND missing_since IS NULL`, [source, start]);
    return { missing: r.rowCount || 0, missingSkipped: false };
  }

  const dbNow = async () => (await pool.query(`SELECT CURRENT_TIMESTAMP::timestamp AS t`)).rows[0].t;

  // --------------------------------------------------------------------------
  // 1a. Synchro Kaizen (V2)
  // --------------------------------------------------------------------------
  async function syncKaizen() {
    const fetched = await kaizen.fetchAllStores();
    const byUuid = new Map();
    let rejected = 0;
    for (const raw of fetched) {
      const s = normalizeStore(raw);
      if (s) byUuid.set(s.uuid, { ...s, sourceKey: s.uuid }); else rejected++;
    }
    const items = [...byUuid.values()];
    const start = await dbNow();
    const up = await upsertLocations('kaizen', items, start);
    const miss = await markMissing('kaizen', items.length, start);
    return { fetched: fetched.length, rejected, ...up, ...miss };
  }

  // --------------------------------------------------------------------------
  // 1b. Synchro Zoho Billing (V1) — Cluster Canada + Xperio
  // --------------------------------------------------------------------------
  async function syncBilling({ addressBudget = DEFAULT_ADDRESS_BUDGET } = {}) {
    const L = late();
    if (!L) return { skipped: 'liaison Zoho absente' };
    // Le jeton Zoho est PARTAGÉ avec les scans SaaS : son rafraîchissement par un processus
    // invalide celui de l'autre. On passe donc par LEUR verrou, sans jamais les préempter.
    const owner = await L.acquireSaasScanLock('opener_billing');
    if (!owner) {
      const h = await L.saasScanLockHolder().catch(() => null);
      throw new Error(`Zoho occupé par un autre scan${h?.label ? ` (${h.label})` : ''} — réessayé au prochain passage`);
    }
    try {
      let { accessToken, apiDomain } = await L.getAdminBooksAuth();
      const orgs = B.billingOrgs();
      const customers = new Map();
      for (const [i, orgId] of orgs.entries()) {
        await progress('billing_subs', i, orgs.length, true);
        const subs = await L.fetchBillingSubs(apiDomain, accessToken, orgId, 'SubscriptionStatus.All');
        for (const [k, c] of B.groupCustomers(orgId, subs, L.ACTIVE_STATUSES)) customers.set(k, c);
      }
      if (await L.saasScanShouldStop(owner)) throw new Error('arrêt demandé par un autre scan Zoho');

      // Adresses à lire : jamais lues, ou lues il y a plus de 30 jours. Les clients ACTIFS d'abord.
      const known = new Map((await pool.query(
        `SELECT source_key, fetched_at < CURRENT_TIMESTAMP - INTERVAL '${ADDRESS_REFRESH_DAYS} days' AS stale
           FROM opener_billing_addresses`)).rows.map((r) => [r.source_key, r.stale]));
      const todo = [...customers.values()]
        .filter((c) => !known.has(c.key) || known.get(c.key) === true)
        .sort((a, b) => Number(b.active) - Number(a.active) || Number(known.has(a.key)) - Number(known.has(b.key)));
      // ⚠️ Les emplacements s'écrivent AU FUR ET À MESURE (vécu le 2026-10-06 : un passage de nuit
      // tué par un redémarrage à 1 208 adresses sur 1 500 n'avait créé AUCUN emplacement, tout
      // n'étant écrit qu'à la fin). D'abord tous les clients dont l'adresse est déjà connue, puis
      // chaque lot de 25 adresses lues.
      const start = await dbNow();
      const tally = { inserted: 0, updated: 0, rematch: 0, outsideCanada: 0 };
      const flush = async (list) => {
        if (!list.length) return;
        const keys = list.map((c) => c.key);
        const addrs = new Map((await pool.query(
          `SELECT * FROM opener_billing_addresses WHERE source_key = ANY($1::text[])`, [keys])).rows.map((r) => [r.source_key, r]));
        const items = [];
        for (const c of list) {
          const a = addrs.get(c.key);
          if (!a) continue;
          if (!B.isCanada(a.country)) { tally.outsideCanada++; continue; }
          items.push({
            sourceKey: c.key, orgId: c.orgId, storeId: c.customerId,
            name: (c.name || '(sans nom)').slice(0, 255),
            street: a.street, unit: a.unit, city: a.city, region: a.region, postalCode: a.postal_code, country: a.country,
            active: c.active,
            extra: { org: ORG_NAMES[c.orgId] || c.orgId, plans: [...c.plans].slice(0, 8), subs: c.subs, activeSubs: c.activeSubs,
              subNumbers: c.subNumbers, addressFrom: a.which, addressError: a.error || undefined },
          });
        }
        const up = await upsertLocations('billing', items, start);
        tally.inserted += up.inserted; tally.updated += up.updated; tally.rematch += up.rematch;
      };
      await flush([...customers.values()].filter((c) => known.has(c.key)));

      let fetchedAddr = 0, addrErrors = 0, stopped = null;
      const batch = todo.slice(0, Math.max(0, addressBudget));
      let pendingFlush = [];
      await progress('billing_addresses', 0, batch.length, true);
      for (const c of batch) {
        await progress('billing_addresses', fetchedAddr, batch.length);
        if (fetchedAddr && fetchedAddr % 10 === 0) {
          await touchLock();
          if (await L.saasScanShouldStop(owner)) { stopped = 'arrêt demandé par un autre scan Zoho'; break; }
        }
        if (fetchedAddr && fetchedAddr % 100 === 0) ({ accessToken, apiDomain } = await L.getAdminBooksAuth());
        try {
          const contact = await books.fetchContact(apiDomain, accessToken, c.orgId, c.customerId);
          const a = B.pickAddress(contact);
          await pool.query(
            `INSERT INTO opener_billing_addresses (source_key, street, unit, city, region, postal_code, country, which, error, fetched_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,CURRENT_TIMESTAMP)
             ON CONFLICT (source_key) DO UPDATE SET street = $2, unit = $3, city = $4, region = $5, postal_code = $6,
               country = $7, which = $8, error = NULL, fetched_at = CURRENT_TIMESTAMP`,
            [c.key, a.street, a.unit, a.city, a.region, a.postalCode, a.country, a.which]);
          fetchedAddr++;
          pendingFlush.push(c);
        } catch (e) {
          // Quota Zoho atteint : on s'arrête là, la suite au prochain passage. Rien n'est noté pour
          // ce client — il sera relu.
          if (e.quota) { stopped = 'quota Zoho atteint'; break; }
          addrErrors++;
          await pool.query(
            `INSERT INTO opener_billing_addresses (source_key, error, fetched_at) VALUES ($1, $2, CURRENT_TIMESTAMP)
             ON CONFLICT (source_key) DO UPDATE SET error = $2, fetched_at = CURRENT_TIMESTAMP`,
            [c.key, String(e.message).slice(0, 200)]);
          fetchedAddr++;
        }
        if (pendingFlush.length >= 25) { await flush(pendingFlush); pendingFlush = []; }
        if (pace) await sleep(pace);
      }
      await flush(pendingFlush);

      const withoutAddress = (await pool.query(
        `SELECT COUNT(*)::int AS n FROM unnest($1::text[]) k WHERE k NOT IN (SELECT source_key FROM opener_billing_addresses)`,
        [[...customers.keys()]])).rows[0].n;
      const outsideCanada = tally.outsideCanada;
      const up = { inserted: tally.inserted, updated: tally.updated, rematch: tally.rematch };
      // Un client toujours abonné mais dont l'adresse n'est pas encore lue n'est pas « disparu ».
      const stillThere = [...customers.keys()];
      if (stillThere.length) {
        await pool.query(
          `UPDATE cluster_locations SET synced_at = $2 WHERE source = 'billing' AND source_key = ANY($1::text[])`,
          [stillThere, start]);
      }
      const miss = await markMissing('billing', customers.size, start);
      return {
        orgs: orgs.map((o) => ORG_NAMES[o] || o), customers: customers.size,
        activeCustomers: [...customers.values()].filter((c) => c.active).length,
        addressesRead: fetchedAddr, addressErrors: addrErrors, addressesPending: Math.max(0, todo.length - fetchedAddr),
        withoutAddress, outsideCanada, stopped, ...up, ...miss,
      };
    } finally { await L.releaseSaasScanLock(owner); }
  }

  // --------------------------------------------------------------------------
  // 2. Jumeaux et version du logiciel
  // --------------------------------------------------------------------------
  async function linkTwins() {
    // Un client Billing au même nom + code postal qu'un magasin Kaizen déjà apparié prend sa
    // fiche Google : même restaurant, aucune recherche payante de plus.
    const copied = await pool.query(
      `UPDATE cluster_locations b SET place_id = k.place_id, match_status = 'auto', match_score = k.match_score,
              match_candidates = NULL, matched_by = 'kaizen', matched_at = CURRENT_TIMESTAMP,
              match_attempted_at = CURRENT_TIMESTAMP, match_version = ${M.MATCH_VERSION}
         FROM cluster_locations k
        WHERE b.source = 'billing' AND k.source = 'kaizen' AND k.missing_since IS NULL AND k.place_id IS NOT NULL
          AND COALESCE(b.dedup_key, '') <> '' AND k.dedup_key = b.dedup_key
          AND b.match_status IN ('pending','review','none','no_address')`);
    await pool.query(
      `UPDATE cluster_locations b SET twin_of = (
          SELECT k.id FROM cluster_locations k
           WHERE k.source = 'kaizen' AND k.missing_since IS NULL
             AND ((b.place_id IS NOT NULL AND k.place_id = b.place_id)
                  OR (COALESCE(b.dedup_key, '') <> '' AND k.dedup_key = b.dedup_key))
           ORDER BY k.id LIMIT 1)
        WHERE b.source = 'billing'`);
    await pool.query(
      `UPDATE cluster_locations SET software_version =
         CASE WHEN source = 'kaizen' THEN 'v2' WHEN twin_of IS NOT NULL THEN 'v2' ELSE 'v1' END`);
    return { placesCopied: copied.rowCount || 0 };
  }

  // --------------------------------------------------------------------------
  // 3. Appariement automatique
  // --------------------------------------------------------------------------
  async function upsertPlace(placeId, lat, lng, source = 'kaizen') {
    if (!placeId) return;
    await pool.query(
      `INSERT INTO opener_places (place_id, lat, lng, coords_refreshed_at, source)
       VALUES ($1, $2, $3, CASE WHEN $2::float8 IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END, $4)
       ON CONFLICT (place_id) DO UPDATE SET
         lat = COALESCE(EXCLUDED.lat, opener_places.lat), lng = COALESCE(EXCLUDED.lng, opener_places.lng),
         coords_refreshed_at = COALESCE(EXCLUDED.coords_refreshed_at, opener_places.coords_refreshed_at)`,
      [placeId, lat ?? null, lng ?? null, source]);
  }

  // Les résultats qui sont des ADRESSES et non des commerces sont écartés : on n'apparie jamais
  // un magasin à un immeuble. Doublons (même place_id renvoyé par les deux recherches) fusionnés.
  function scorePlaces(store, places) {
    const seen = new Set();
    return places
      .filter((p) => p && p.id && !M.isAddressOnly(p) && !seen.has(p.id) && seen.add(p.id))
      .map((p) => ({ p, s: M.scoreCandidate(store, p) }))
      .sort((a, b) => b.s.score - a.s.score)
      .map(({ p, s }) => ({ id: p.id, score: s.score, view: M.candidateView(p, s) }));
  }

  async function matchOne(loc) {
    if (!loc.street && !loc.postal_code) {
      await pool.query(
        `UPDATE cluster_locations SET match_status = 'no_address', match_attempted_at = CURRENT_TIMESTAMP, match_version = ${M.MATCH_VERSION},
                place_id = NULL, match_candidates = NULL WHERE id = $1 AND match_status NOT IN ('manual','ignored')`, [loc.id]);
      return 'no_address';
    }
    let places = await google.searchText(M.storeQuery(loc));
    let scored = scorePlaces(loc, places);
    // Rien de plausible par le nom : 2e essai par l'adresse seule (le nom est parfois un nom de
    // lieu, « Montréal-Ouest », ou de société à numéro). Une recherche de plus, dans ce cas seulement.
    const aq = M.addressQuery(loc);
    if (aq && (!scored.length || scored[0].score < M.REVIEW)) {
      places = places.concat(await google.searchText(aq));
      scored = scorePlaces(loc, places);
    }
    const d = M.decide(scored);
    const top = scored.slice(0, 3).map((c) => c.view);
    if (d.status === 'auto') {
      const best = scored[0].view;
      await pool.query(
        `UPDATE cluster_locations SET match_status = 'auto', place_id = $2, match_score = $3, match_candidates = NULL,
                match_attempted_at = CURRENT_TIMESTAMP, matched_by = 'auto', matched_at = CURRENT_TIMESTAMP, match_note = NULL,
                match_version = ${M.MATCH_VERSION}
          WHERE id = $1 AND match_status NOT IN ('manual','ignored')`, [loc.id, d.placeId, d.score]);
      await upsertPlace(best.id, best.lat, best.lng, loc.source);
    } else {
      await pool.query(
        `UPDATE cluster_locations SET match_status = $2, place_id = NULL, match_score = $3, match_candidates = $4::jsonb,
                match_attempted_at = CURRENT_TIMESTAMP, match_version = ${M.MATCH_VERSION}
          WHERE id = $1 AND match_status NOT IN ('manual','ignored')`,
        [loc.id, d.status, d.score || null, top.length ? JSON.stringify(top) : null]);
    }
    return d.status;
  }

  async function runMatching({ budget = DEFAULT_MATCH_BUDGET } = {}) {
    if (!google.configured()) return { skipped: 'GOOGLE_PLACES_API_KEY absente' };
    // Kaizen d'abord : un client Billing jumeau d'un Kaizen apparié recevra sa fiche sans recherche.
    const { rows } = await pool.query(
      `SELECT id, source, name, street, unit, city, region, postal_code FROM cluster_locations
        WHERE missing_since IS NULL
          AND (match_status = 'pending'
               -- notés par une version antérieure de la notation : renotés une fois
               OR (match_status IN ('review','none') AND match_version < ${M.MATCH_VERSION})
               OR (match_status = 'none' AND (match_attempted_at IS NULL OR match_attempted_at < CURRENT_TIMESTAMP - INTERVAL '${RETRY_NONE_DAYS} days')))
        ORDER BY active DESC, (source = 'kaizen') DESC, (match_status = 'pending') DESC, first_seen_at, id
        LIMIT $1`, [Math.max(1, Math.min(2000, budget | 0))]);
    const res = { tried: 0, auto: 0, review: 0, none: 0, no_address: 0, errors: 0, remaining: 0 };
    let streak = 0;
    let twinsDone = false;
    await progress('matching', 0, rows.length, true);
    for (const [i, s] of rows.entries()) {
      await progress('matching', i, rows.length);
      // Premier client Billing du lot : les Kaizen actifs viennent d'être appariés, leurs jumeaux
      // reçoivent leur fiche maintenant — une seule fois, pas avant chaque client.
      if (s.source === 'billing' && !twinsDone) { await linkTwins(); twinsDone = true; }
      if (s.source === 'billing') {
        const cur = (await pool.query(`SELECT match_status FROM cluster_locations WHERE id = $1`, [s.id])).rows[0];
        if (!cur || !['pending', 'review', 'none'].includes(cur.match_status)) continue;
      }
      try {
        const st = await matchOne(s);
        res[st] = (res[st] || 0) + 1;
        res.tried++;
        streak = 0;
      } catch (e) {
        res.errors++;
        res.lastError = e.message;
        // Clé non activée, quota épuisé, réseau coupé : inutile de brûler le reste du lot.
        // Clé non activée, plafond Google du jour atteint : inutile d'insister, le reste attend le
        // passage suivant (rien n'est marqué pour ce restaurant, il reste « en attente »).
        if (e.quota) { res.aborted = true; res.quota = true; break; }
        if (/n'est pas activée|absente/.test(e.message) || ++streak >= 5) { res.aborted = true; break; }
      }
      if (res.tried % 20 === 0) await touchLock();
    }
    res.remaining = Number((await pool.query(
      `SELECT COUNT(*)::int AS n FROM cluster_locations WHERE missing_since IS NULL AND match_status = 'pending'`)).rows[0].n);
    return res;
  }

  // Synchros + jumeaux + appariement, sous verrou. Retourne null si une autre synchro tourne déjà.
  async function runAll({ source = 'manual', budget, addressBudget } = {}) {
    await schema();
    if (!(await takeLock())) return null;
    const out = { at: new Date().toISOString(), source };
    try {
      await progress('kaizen', 0, 0, true);
      if (kaizenReady()) {
        try { out.sync = await syncKaizen(); }
        catch (e) { out.syncError = e.message; }
      } else out.syncError = 'KAIZEN_API_EMAIL / KAIZEN_API_PASSWORD absents';
      try { out.billing = await syncBilling({ addressBudget }); }
      catch (e) { out.billingError = e.message; }
      await progress('twins', 0, 0, true);
      try { out.twins = await linkTwins(); } catch (e) { out.twinsError = e.message; }
      try { out.match = await runMatching({ budget }); }
      catch (e) { out.matchError = e.message; }
      try { await linkTwins(); } catch { /* déjà signalé plus haut */ }
      await putState(STATE_LAST_RUN, out);
      // « Dernier passage RÉUSSI » : seul lui retient le passage planifié (voir runNightly). Un
      // passage sans identifiants ou en panne ne doit pas repousser le suivant de 20 h.
      if (out.sync && out.billing && !out.billing.skipped && !out.matchError) await putState(STATE_LAST_OK, { at: out.at });
      return out;
    } finally { await releaseLock().catch(() => {}); }
  }

  // --------------------------------------------------------------------------
  // 4. HTTP
  // --------------------------------------------------------------------------
  const guard = async (req, res) => {
    if (!(await requirePerm(req, res, PERM_MATCH))) return false;
    await schema();
    return true;
  };

  const shape = (r) => {
    const x = r.extra || {};
    return {
      id: r.id,
      source: r.source,
      sourceLabel: r.source === 'kaizen' ? 'Kaizen' : `Zoho Billing · ${x.org || r.org_id || ''}`,
      storeId: r.store_id,
      storeName: r.name,                  // clé couverte par le mode démo
      street: r.street, unit: r.unit, city: r.city, region: r.region, postalCode: r.postal_code,
      active: r.active,
      version: r.version_override || r.software_version || null,
      versionAuto: r.software_version || null,
      versionOverride: r.version_override || null,
      twin: r.twin_of ? { id: r.twin_of, storeName: r.twin_name || null } : null,
      plans: Array.isArray(x.plans) ? x.plans : [],
      activeSubs: x.activeSubs ?? null,
      addressFrom: x.addressFrom || null,
      missingSince: r.missing_since,
      status: r.match_status,
      placeId: r.place_id,
      score: r.match_score == null ? null : Number(r.match_score),
      candidates: r.match_candidates || [],
      attemptedAt: r.match_attempted_at,
      matchedBy: r.matched_by, matchedAt: r.matched_at,
      note: r.match_note,
      lat: r.lat ?? null, lng: r.lng ?? null,
      sharedPlace: Number(r.shared_place || 0),  // autres emplacements de la MÊME source sur la même fiche
    };
  };
  const SELECT_ROW = `SELECT k.*, op.lat, op.lng, tw.name AS twin_name,
          (SELECT COUNT(*) FROM cluster_locations o WHERE o.place_id = k.place_id AND o.id <> k.id
              AND o.source = k.source AND o.missing_since IS NULL) AS shared_place
     FROM cluster_locations k
     LEFT JOIN opener_places op ON op.place_id = k.place_id
     LEFT JOIN cluster_locations tw ON tw.id = k.twin_of`;

  app.get('/api/opener/locations/status', authenticateToken, async (req, res) => {
    if (!(await guard(req, res))) return;
    try {
      const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
      const { rows } = await pool.query(
        `SELECT match_status, COUNT(*)::int AS n FROM cluster_locations WHERE missing_since IS NULL GROUP BY match_status`);
      for (const r of rows) counts[r.match_status] = r.n;
      const tot = (await pool.query(
        `SELECT COUNT(*) FILTER (WHERE missing_since IS NULL AND active)::int AS active,
                COUNT(*) FILTER (WHERE missing_since IS NULL AND NOT active)::int AS inactive,
                COUNT(*) FILTER (WHERE missing_since IS NOT NULL)::int AS missing,
                COUNT(*) FILTER (WHERE missing_since IS NULL AND source = 'kaizen')::int AS kaizen,
                COUNT(*) FILTER (WHERE missing_since IS NULL AND source = 'billing')::int AS billing,
                COUNT(*) FILTER (WHERE missing_since IS NULL AND COALESCE(version_override, software_version) = 'v2')::int AS v2,
                COUNT(*) FILTER (WHERE missing_since IS NULL AND COALESCE(version_override, software_version) = 'v1')::int AS v1,
                COUNT(*) FILTER (WHERE missing_since IS NULL AND source = 'billing' AND twin_of IS NOT NULL)::int AS twins
           FROM cluster_locations`)).rows[0];
      res.json({
        configured: { kaizen: kaizenReady(), google: google.configured(), billing: !!deps.late },
        running: await isRunning(),
        lastRun: await getState(STATE_LAST_RUN),
        // Pendant une synchro : la phase en cours et son avancement (n / total).
        progress: (await isRunning()) ? await getState(STATE_PROGRESS) : null,
        counts, totals: tot,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Lance synchros + appariement en arrière-plan. 409 si une synchro tourne déjà.
  app.post('/api/opener/locations/sync', authenticateToken, async (req, res) => {
    if (!(await guard(req, res))) return;
    const budget = Math.max(1, Math.min(2000, parseInt(req.body?.budget, 10) || DEFAULT_MATCH_BUDGET));
    if (await isRunning()) return res.status(409).json({ error: 'already_running' });
    const actor = actorOf(req);
    res.status(202).json({ started: true });
    runAll({ source: `manual:${actor}`, budget })
      .then((out) => out && console.log('[OPENER] synchro des emplacements :', summary(out)))
      .catch((e) => console.error('[OPENER] synchro des emplacements :', e.message));
  });

  app.get('/api/opener/locations', authenticateToken, async (req, res) => {
    if (!(await guard(req, res))) return;
    try {
      const where = [];
      const p = [];
      const status = String(req.query.status || 'all');
      if (status === 'missing') where.push('k.missing_since IS NOT NULL');
      else {
        where.push('k.missing_since IS NULL');
        if (STATUSES.includes(status)) { p.push(status); where.push(`k.match_status = $${p.length}`); }
        else if (status === 'todo') where.push(`k.match_status IN ('review','none','no_address')`);
      }
      if (req.query.active === 'true') where.push('k.active');
      if (req.query.active === 'false') where.push('NOT k.active');
      const version = String(req.query.version || '');
      if (version === 'v1' || version === 'v2') { p.push(version); where.push(`COALESCE(k.version_override, k.software_version) = $${p.length}`); }
      const source = String(req.query.source || '');
      if (SOURCES.includes(source)) { p.push(source); where.push(`k.source = $${p.length}`); }
      const q = String(req.query.q || '').trim().slice(0, 100);
      if (q) {
        p.push(`%${q.toLowerCase()}%`);
        where.push(`(LOWER(k.name) LIKE $${p.length} OR LOWER(COALESCE(k.street,'')) LIKE $${p.length}
                     OR LOWER(COALESCE(k.city,'')) LIKE $${p.length} OR LOWER(COALESCE(k.store_id,'')) LIKE $${p.length}
                     OR REPLACE(UPPER(COALESCE(k.postal_code,'')),' ','') LIKE REPLACE(UPPER($${p.length}),' ',''))`);
      }
      const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
      const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM cluster_locations k ${w}`, p)).rows[0].n;
      const { rows } = await pool.query(
        `${SELECT_ROW}
           ${w}
          ORDER BY CASE k.match_status WHEN 'review' THEN 0 WHEN 'none' THEN 1 WHEN 'no_address' THEN 2 WHEN 'pending' THEN 3 ELSE 4 END,
                   k.active DESC, k.match_score DESC NULLS LAST, k.name, k.id
          LIMIT ${limit} OFFSET ${offset}`, p);
      res.json({ total, locations: rows.map(shape) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  async function loadLoc(req, res) {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) { res.status(404).json({ error: 'not_found' }); return null; }
    const row = (await pool.query(`SELECT * FROM cluster_locations WHERE id = $1`, [id])).rows[0];
    if (!row) { res.status(404).json({ error: 'not_found' }); return null; }
    return row;
  }
  const reloadShaped = async (id) => shape((await pool.query(`${SELECT_ROW} WHERE k.id = $1`, [id])).rows[0]);

  // Recherche Google libre, notée par rapport à l'emplacement si `id` est fourni. Rien n'est gardé.
  app.get('/api/opener/locations/search', authenticateToken, async (req, res) => {
    if (!(await guard(req, res))) return;
    const q = String(req.query.q || '').trim().slice(0, 200);
    if (q.length < 3) return res.status(400).json({ error: 'query_too_short' });
    try {
      let loc = null;
      const id = parseInt(req.query.id, 10);
      if (Number.isInteger(id) && id > 0) {
        loc = (await pool.query(`SELECT * FROM cluster_locations WHERE id = $1`, [id])).rows[0] || null;
      }
      const places = await google.searchText(q, { max: 8 });
      const out = loc ? scorePlaces(loc, places).map((c) => c.view)
        : places.filter((p) => !M.isAddressOnly(p)).map((p) => M.candidateView(p, { score: null, parts: {} }));
      res.json({ candidates: out });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  // Confirmer une fiche (parmi les candidats ou trouvée par la recherche). Le place_id est
  // revérifié auprès de Google : il donne aussi les coordonnées.
  app.post('/api/opener/locations/:id/confirm', authenticateToken, async (req, res) => {
    if (!(await guard(req, res))) return;
    const placeId = String(req.body?.placeId || '');
    if (!PLACE_RE.test(placeId)) return res.status(400).json({ error: 'invalid_place_id' });
    try {
      const row = await loadLoc(req, res); if (!row) return;
      let place;
      try { place = await google.details(placeId); }
      catch (e) { return res.status(502).json({ error: e.message }); }
      if (!place || place.id !== placeId) return res.status(400).json({ error: 'place_not_found' });
      const sc = M.scoreCandidate(row, place);
      const actor = actorOf(req);
      await pool.query(
        `UPDATE cluster_locations SET match_status = 'manual', place_id = $2, match_score = $3, match_candidates = NULL,
                matched_by = $4, matched_at = CURRENT_TIMESTAMP, match_note = NULL WHERE id = $1`,
        [row.id, placeId, sc.score, actor]);
      await upsertPlace(placeId, place.location?.latitude, place.location?.longitude, row.source);
      await linkTwins();
      log(row.id, 'matched', `${row.name} → fiche Google ${place.displayName?.text || placeId} (manuel)`, actor,
        { metadata: { placeId, previous: row.place_id, previousStatus: row.match_status, score: sc.score } });
      res.json({ location: await reloadShaped(row.id) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/opener/locations/:id/ignore', authenticateToken, async (req, res) => {
    if (!(await guard(req, res))) return;
    try {
      const row = await loadLoc(req, res); if (!row) return;
      const reason = String(req.body?.reason || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200) || null;
      const actor = actorOf(req);
      await pool.query(
        `UPDATE cluster_locations SET match_status = 'ignored', place_id = NULL, match_candidates = NULL,
                matched_by = $2, matched_at = CURRENT_TIMESTAMP, match_note = $3 WHERE id = $1`, [row.id, actor, reason]);
      await linkTwins();
      log(row.id, 'ignored', `${row.name} — écarté de l'appariement${reason ? ` : ${reason}` : ''}`, actor,
        { metadata: { previous: row.place_id, previousStatus: row.match_status } });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Remettre en file automatique (défait une décision manuelle ou un « ignoré »).
  app.post('/api/opener/locations/:id/reset', authenticateToken, async (req, res) => {
    if (!(await guard(req, res))) return;
    try {
      const row = await loadLoc(req, res); if (!row) return;
      const actor = actorOf(req);
      await pool.query(
        `UPDATE cluster_locations SET match_status = 'pending', place_id = NULL, match_score = NULL, match_candidates = NULL,
                match_attempted_at = NULL, matched_by = NULL, matched_at = NULL, match_note = NULL WHERE id = $1`, [row.id]);
      await linkTwins();
      log(row.id, 'match_reset', `${row.name} — appariement remis à refaire`, actor,
        { metadata: { previous: row.place_id, previousStatus: row.match_status } });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Version du logiciel imposée à la main ({ version: 'v1' | 'v2' | null }). null = revenir à la
  // version déduite. Pour les cas que la déduction ne peut pas voir : un client V2 dont le
  // contact Books porte l'adresse du siège social, par exemple.
  app.post('/api/opener/locations/:id/version', authenticateToken, async (req, res) => {
    if (!(await guard(req, res))) return;
    const v = req.body?.version;
    if (!(v === null || v === 'v1' || v === 'v2')) return res.status(400).json({ error: 'invalid_version' });
    try {
      const row = await loadLoc(req, res); if (!row) return;
      const actor = actorOf(req);
      await pool.query(`UPDATE cluster_locations SET version_override = $2 WHERE id = $1`, [row.id, v]);
      log(row.id, 'version', `${row.name} — version ${v ? v.toUpperCase() + ' imposée' : 'remise à la déduction automatique'}`, actor,
        { metadata: { previous: row.version_override, auto: row.software_version } });
      res.json({ location: await reloadShaped(row.id) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  const summary = (out) => JSON.stringify({
    sync: out.sync, billing: out.billing, match: out.match,
    errors: [out.syncError, out.billingError, out.twinsError, out.matchError].filter(Boolean),
  });

  return {
    ensureReady: schema,
    runAll, syncKaizen, syncBilling, linkTwins, runMatching,
    // Worker : une fois par nuit, avec un plus gros lot d'adresses Books (personne n'attend).
    // ⚠️ Le worker redémarre à CHAQUE déploiement (plusieurs par jour) : sans cette garde, chaque
    // redémarrage relancerait jusqu'à 300 recherches Google payantes. Le bouton de l'écran, lui,
    // passe outre — c'est le moyen d'écouler l'arriéré plus vite.
    runNightly: () => schema()
      .then(() => pool.query(
        `SELECT 1 FROM sync_state WHERE key = $1 AND updated_at > CURRENT_TIMESTAMP - INTERVAL '20 hours'`, [STATE_LAST_OK]))
      .then((r) => (r.rows.length ? 'recent' : runAll({ source: 'scheduled', addressBudget: NIGHTLY_ADDRESS_BUDGET, budget: NIGHTLY_MATCH_BUDGET })))
      .then((out) => {
        if (out === 'recent') return;
        if (!out) return console.log('[OPENER] synchro des emplacements déjà en cours — passage ignoré');
        console.log('[OPENER] synchro des emplacements :', summary(out));
      })
      .catch((e) => console.error('[OPENER] synchro des emplacements :', e.message)),
  };
}

module.exports = { registerOpenerRoutes, ensureSchema, PERM_MATCH, STATUSES, addrKey, dedupKey };
