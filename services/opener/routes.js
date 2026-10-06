// ============================================================================
// Module Opener — lot 0 : magasins Cluster (Kaizen) et leur fiche Google.
//
// Plan : design/opener/PLAN-TECHNIQUE.md, §1 et §3.
//
//   1. Synchro Kaizen (nuit, worker) → kaizen_stores, actifs ET inactifs.
//   2. Appariement automatique → place_id Google (Text Search), noté et décidé.
//   3. Écran Admin → Opener : confirmer, chercher, ignorer.
//
// Statuts d'appariement (kaizen_stores.match_status) :
//   pending     jamais tenté (ou adresse modifiée depuis)
//   auto        apparié par le score (≥ 0,80, sans rival proche)
//   review      candidat plausible, décision humaine requise
//   none        rien de plausible ; retenté après 30 jours
//   no_address  ni rue ni code postal : pas de recherche automatique (une chaîne s'y tromperait)
//   manual      choisi par un humain — JAMAIS écrasé par l'automatique
//   ignored     écarté par un humain (magasin test, entrepôt, sans fiche Google)
//
// Permission : opener:match (tout l'écran, y compris les boutons de synchro).
// ============================================================================

const { createKaizenClient, kaizenConfigured, normalizeStore } = require('./kaizen');
const M = require('./matching');

const PERM_MATCH = 'opener:match';
const STATUSES = ['pending', 'auto', 'review', 'none', 'no_address', 'manual', 'ignored'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLACE_RE = /^[A-Za-z0-9_-]{10,300}$/;
const DEFAULT_MATCH_BUDGET = 300;   // appels Text Search par passage ; ~0,03 $US l'appel
const RETRY_NONE_DAYS = 30;
const LOCK_KEY = 'kaizen_sync_lock';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS kaizen_stores (
    uuid               UUID PRIMARY KEY,
    store_id           VARCHAR(60),
    name               VARCHAR(255) NOT NULL,
    street             VARCHAR(255),
    unit               VARCHAR(60),
    city               VARCHAR(120),
    region             VARCHAR(120),
    postal_code        VARCHAR(20),
    country            VARCHAR(60),
    active             BOOLEAN NOT NULL DEFAULT true,
    addr_key           VARCHAR(500),
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
    match_note         VARCHAR(200)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_kaizen_stores_status ON kaizen_stores (match_status)`,
  `CREATE INDEX IF NOT EXISTS idx_kaizen_stores_place  ON kaizen_stores (place_id)`,
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
}

// Clé d'adresse : sert à savoir si l'adresse a BOUGÉ depuis le dernier appariement.
const addrKey = (s) => [s.street, s.unit, s.city, s.region, M.normPostal(s.postalCode)]
  .map((x) => String(x || '').trim().toLowerCase()).join('|').slice(0, 500);

function registerOpenerRoutes(app, deps) {
  const { authenticateToken, requirePerm, pool, logActivity } = deps;
  const kaizen = deps.kaizen || createKaizenClient();
  const google = deps.google || M.createGooglePlaces();
  const kaizenReady = deps.kaizenConfigured || (() => kaizenConfigured());

  let ready = null;
  const schema = () => (ready = ready || ensureSchema(pool).catch((e) => { ready = null; throw e; }));
  if (pool) schema().catch((e) => console.error('opener schema:', e.message));

  const actorOf = (req) => req.user?.realAdminEmail || req.user?.email || 'unknown';
  const log = (uuid, event, desc, actor, extra) =>
    Promise.resolve(logActivity && logActivity('kaizen_store', uuid, event, desc, actor, extra)).catch(() => {});

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
        WHERE sync_state.value <> 'running' OR sync_state.updated_at < CURRENT_TIMESTAMP - INTERVAL '30 minutes'
       RETURNING key`, [LOCK_KEY]);
    return r.rows.length > 0;
  }
  const isRunning = async () => (await pool.query(
    `SELECT 1 FROM sync_state WHERE key = $1 AND value = 'running'
        AND updated_at >= CURRENT_TIMESTAMP - INTERVAL '30 minutes'`, [LOCK_KEY])).rows.length > 0;
  const releaseLock = () => pool.query(`UPDATE sync_state SET value = 'idle', updated_at = CURRENT_TIMESTAMP WHERE key = $1`, [LOCK_KEY]);

  // --------------------------------------------------------------------------
  // 1. Synchro Kaizen
  // --------------------------------------------------------------------------
  async function syncStores() {
    const fetched = await kaizen.fetchAllStores();
    const byUuid = new Map();
    let rejected = 0;
    for (const raw of fetched) {
      const s = normalizeStore(raw);
      if (s) byUuid.set(s.uuid, s); else rejected++;
    }
    const stores = [...byUuid.values()];
    const start = (await pool.query(`SELECT CURRENT_TIMESTAMP::timestamp AS t`)).rows[0].t;
    const before = Number((await pool.query(`SELECT COUNT(*)::int AS n FROM kaizen_stores WHERE missing_since IS NULL`)).rows[0].n);

    let inserted = 0, updated = 0, rematch = 0;
    for (let i = 0; i < stores.length; i += 300) {
      const part = stores.slice(i, i + 300);
      const vals = [];
      const rows = part.map((s, j) => {
        const b = j * 11;
        vals.push(s.uuid, s.storeId, s.name, s.street, s.unit, s.city, s.region, s.postalCode, s.country, s.active, addrKey(s));
        return `($${b + 1}::uuid,$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10}::boolean,$${b + 11},$${part.length * 11 + 1}::timestamp)`;
      });
      vals.push(start);
      // Une adresse modifiée remet en jeu un appariement AUTOMATIQUE (ou un échec), jamais un
      // appariement manuel ni un « ignoré » : une décision humaine ne se défait pas en silence.
      const r = await pool.query(
        `INSERT INTO kaizen_stores (uuid, store_id, name, street, unit, city, region, postal_code, country, active, addr_key, synced_at)
         VALUES ${rows.join(',')}
         ON CONFLICT (uuid) DO UPDATE SET
           store_id = EXCLUDED.store_id, name = EXCLUDED.name, street = EXCLUDED.street, unit = EXCLUDED.unit,
           city = EXCLUDED.city, region = EXCLUDED.region, postal_code = EXCLUDED.postal_code,
           country = EXCLUDED.country, active = EXCLUDED.active, synced_at = EXCLUDED.synced_at,
           missing_since = NULL,
           match_status = CASE WHEN kaizen_stores.addr_key IS DISTINCT FROM EXCLUDED.addr_key
                                 AND kaizen_stores.match_status IN ('auto','review','none','no_address')
                               THEN 'pending' ELSE kaizen_stores.match_status END,
           place_id = CASE WHEN kaizen_stores.addr_key IS DISTINCT FROM EXCLUDED.addr_key
                             AND kaizen_stores.match_status IN ('auto','review','none','no_address')
                           THEN NULL ELSE kaizen_stores.place_id END,
           match_candidates = CASE WHEN kaizen_stores.addr_key IS DISTINCT FROM EXCLUDED.addr_key
                                     AND kaizen_stores.match_status IN ('auto','review','none','no_address')
                                   THEN NULL ELSE kaizen_stores.match_candidates END,
           match_note = CASE WHEN kaizen_stores.addr_key IS DISTINCT FROM EXCLUDED.addr_key
                               AND kaizen_stores.match_status = 'manual'
                             THEN 'Adresse modifiée dans Kaizen depuis l''appariement manuel'
                             ELSE kaizen_stores.match_note END,
           addr_key = EXCLUDED.addr_key
         RETURNING (xmax = 0) AS ins, (match_status = 'pending') AS pend`, vals);
      for (const row of r.rows) { if (row.ins) inserted++; else { updated++; if (row.pend) rematch++; } }
    }

    // Disparus : seulement si la réponse est crédible. Une liste soudain réduite de moitié est
    // bien plus probablement une réponse partielle qu'une vague de fermetures — même leçon que
    // les fausses suppressions de la synchro Zoho (2026-08-18).
    let missing = 0, missingSkipped = false;
    if (before >= 20 && stores.length < before * 0.5) {
      missingSkipped = true;
    } else {
      const r = await pool.query(
        `UPDATE kaizen_stores SET missing_since = $1 WHERE synced_at < $1 AND missing_since IS NULL`, [start]);
      missing = r.rowCount || 0;
    }
    return { fetched: fetched.length, rejected, inserted, updated, rematch, missing, missingSkipped };
  }

  // --------------------------------------------------------------------------
  // 2. Appariement automatique
  // --------------------------------------------------------------------------
  async function upsertPlace(placeId, lat, lng) {
    if (!placeId) return;
    await pool.query(
      `INSERT INTO opener_places (place_id, lat, lng, coords_refreshed_at, source)
       VALUES ($1, $2, $3, CASE WHEN $2::float8 IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END, 'kaizen')
       ON CONFLICT (place_id) DO UPDATE SET
         lat = COALESCE(EXCLUDED.lat, opener_places.lat), lng = COALESCE(EXCLUDED.lng, opener_places.lng),
         coords_refreshed_at = COALESCE(EXCLUDED.coords_refreshed_at, opener_places.coords_refreshed_at)`,
      [placeId, lat ?? null, lng ?? null]);
  }

  function scorePlaces(store, places) {
    return places
      .map((p) => ({ p, s: M.scoreCandidate(store, p) }))
      .sort((a, b) => b.s.score - a.s.score)
      .map(({ p, s }) => ({ id: p.id, score: s.score, view: M.candidateView(p, s) }));
  }

  async function matchOne(store) {
    if (!store.street && !store.postal_code) {
      await pool.query(
        `UPDATE kaizen_stores SET match_status = 'no_address', match_attempted_at = CURRENT_TIMESTAMP,
                place_id = NULL, match_candidates = NULL WHERE uuid = $1 AND match_status NOT IN ('manual','ignored')`, [store.uuid]);
      return 'no_address';
    }
    const places = await google.searchText(M.storeQuery(store));
    const scored = scorePlaces(store, places);
    const d = M.decide(scored);
    const top = scored.slice(0, 3).map((c) => c.view);
    if (d.status === 'auto') {
      const best = scored[0].view;
      await pool.query(
        `UPDATE kaizen_stores SET match_status = 'auto', place_id = $2, match_score = $3, match_candidates = NULL,
                match_attempted_at = CURRENT_TIMESTAMP, matched_by = 'auto', matched_at = CURRENT_TIMESTAMP, match_note = NULL
          WHERE uuid = $1 AND match_status NOT IN ('manual','ignored')`, [store.uuid, d.placeId, d.score]);
      await upsertPlace(best.id, best.lat, best.lng);
    } else {
      await pool.query(
        `UPDATE kaizen_stores SET match_status = $2, place_id = NULL, match_score = $3, match_candidates = $4::jsonb,
                match_attempted_at = CURRENT_TIMESTAMP
          WHERE uuid = $1 AND match_status NOT IN ('manual','ignored')`,
        [store.uuid, d.status, d.score || null, top.length ? JSON.stringify(top) : null]);
    }
    return d.status;
  }

  async function runMatching({ budget = DEFAULT_MATCH_BUDGET } = {}) {
    if (!google.configured()) return { skipped: 'GOOGLE_PLACES_API_KEY absente' };
    const { rows } = await pool.query(
      `SELECT uuid, name, street, unit, city, region, postal_code FROM kaizen_stores
        WHERE missing_since IS NULL
          AND (match_status = 'pending'
               OR (match_status = 'none' AND (match_attempted_at IS NULL OR match_attempted_at < CURRENT_TIMESTAMP - INTERVAL '${RETRY_NONE_DAYS} days')))
        ORDER BY active DESC, (match_status = 'pending') DESC, first_seen_at
        LIMIT $1`, [Math.max(1, Math.min(2000, budget | 0))]);
    const res = { tried: 0, auto: 0, review: 0, none: 0, no_address: 0, errors: 0, remaining: 0 };
    let streak = 0;
    for (const s of rows) {
      try {
        const st = await matchOne(s);
        res[st] = (res[st] || 0) + 1;
        res.tried++;
        streak = 0;
      } catch (e) {
        res.errors++;
        res.lastError = e.message;
        // Clé non activée, quota épuisé, réseau coupé : inutile de brûler le reste du lot.
        if (/n'est pas activée|absente/.test(e.message) || ++streak >= 5) { res.aborted = true; break; }
      }
    }
    res.remaining = Number((await pool.query(
      `SELECT COUNT(*)::int AS n FROM kaizen_stores WHERE missing_since IS NULL AND match_status = 'pending'`)).rows[0].n);
    return res;
  }

  // Synchro + appariement, sous verrou. Retourne null si une autre synchro tourne déjà.
  async function runAll({ source = 'manual', budget } = {}) {
    await schema();
    if (!(await takeLock())) return null;
    const out = { at: new Date().toISOString(), source };
    try {
      if (kaizenReady()) {
        try { out.sync = await syncStores(); }
        catch (e) { out.syncError = e.message; }
      } else out.syncError = 'KAIZEN_API_EMAIL / KAIZEN_API_PASSWORD absents';
      try { out.match = await runMatching({ budget }); }
      catch (e) { out.matchError = e.message; }
      await putState('kaizen_last_run', out);
      // « Dernier passage RÉUSSI » : seul lui retient le passage planifié (voir runNightly). Un
      // passage sans identifiants ou en panne ne doit pas repousser le suivant de 20 h.
      if (out.sync && !out.matchError) await putState('kaizen_last_ok', { at: out.at });
      return out;
    } finally { await releaseLock().catch(() => {}); }
  }

  // --------------------------------------------------------------------------
  // 3. HTTP
  // --------------------------------------------------------------------------
  const guard = async (req, res) => {
    if (!(await requirePerm(req, res, PERM_MATCH))) return false;
    await schema();
    return true;
  };

  const shape = (r) => ({
    uuid: r.uuid,
    storeId: r.store_id,
    storeName: r.name,                  // clé couverte par le mode démo
    street: r.street, unit: r.unit, city: r.city, region: r.region, postalCode: r.postal_code,
    active: r.active,
    missingSince: r.missing_since,
    status: r.match_status,
    placeId: r.place_id,
    score: r.match_score == null ? null : Number(r.match_score),
    candidates: r.match_candidates || [],
    attemptedAt: r.match_attempted_at,
    matchedBy: r.matched_by, matchedAt: r.matched_at,
    note: r.match_note,
    lat: r.lat ?? null, lng: r.lng ?? null,
    sharedPlace: Number(r.shared_place || 0),  // autres magasins sur la même fiche Google
  });

  app.get('/api/opener/kaizen/status', authenticateToken, async (req, res) => {
    if (!(await guard(req, res))) return;
    try {
      const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
      const { rows } = await pool.query(
        `SELECT match_status, COUNT(*)::int AS n FROM kaizen_stores WHERE missing_since IS NULL GROUP BY match_status`);
      for (const r of rows) counts[r.match_status] = r.n;
      const tot = (await pool.query(
        `SELECT COUNT(*) FILTER (WHERE missing_since IS NULL AND active)::int AS active,
                COUNT(*) FILTER (WHERE missing_since IS NULL AND NOT active)::int AS inactive,
                COUNT(*) FILTER (WHERE missing_since IS NOT NULL)::int AS missing
           FROM kaizen_stores`)).rows[0];
      res.json({
        configured: { kaizen: kaizenReady(), google: google.configured() },
        running: await isRunning(),
        lastRun: await getState('kaizen_last_run'),
        counts, totals: tot,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Lance synchro + appariement en arrière-plan. 409 si une synchro tourne déjà.
  app.post('/api/opener/kaizen/sync', authenticateToken, async (req, res) => {
    if (!(await guard(req, res))) return;
    const budget = Math.max(1, Math.min(2000, parseInt(req.body?.budget, 10) || DEFAULT_MATCH_BUDGET));
    // L'âge du verrou se calcule DANS Postgres : `updated_at` est un TIMESTAMP sans fuseau, et le
    // comparer à Date.now() dépendrait du fuseau du processus Node.
    if (await isRunning()) return res.status(409).json({ error: 'already_running' });
    const actor = actorOf(req);
    res.status(202).json({ started: true });
    runAll({ source: `manual:${actor}`, budget })
      .then((out) => out && console.log('[OPENER] synchro Kaizen :', JSON.stringify({ sync: out.sync, match: out.match, syncError: out.syncError, matchError: out.matchError })))
      .catch((e) => console.error('[OPENER] synchro Kaizen :', e.message));
  });

  app.get('/api/opener/kaizen/stores', authenticateToken, async (req, res) => {
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
      const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM kaizen_stores k ${w}`, p)).rows[0].n;
      const { rows } = await pool.query(
        `SELECT k.*, op.lat, op.lng,
                (SELECT COUNT(*) FROM kaizen_stores o WHERE o.place_id = k.place_id AND o.uuid <> k.uuid AND o.missing_since IS NULL) AS shared_place
           FROM kaizen_stores k LEFT JOIN opener_places op ON op.place_id = k.place_id
           ${w}
          ORDER BY CASE k.match_status WHEN 'review' THEN 0 WHEN 'none' THEN 1 WHEN 'no_address' THEN 2 WHEN 'pending' THEN 3 ELSE 4 END,
                   k.active DESC, k.match_score DESC NULLS LAST, k.name
          LIMIT ${limit} OFFSET ${offset}`, p);
      res.json({ total, stores: rows.map(shape) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  async function loadStore(req, res) {
    const uuid = String(req.params.uuid || '');
    if (!UUID_RE.test(uuid)) { res.status(404).json({ error: 'not_found' }); return null; }
    const row = (await pool.query(`SELECT * FROM kaizen_stores WHERE uuid = $1`, [uuid])).rows[0];
    if (!row) { res.status(404).json({ error: 'not_found' }); return null; }
    return row;
  }

  // Recherche Google libre, notée par rapport au magasin si `uuid` est fourni. Rien n'est gardé.
  app.get('/api/opener/kaizen/search', authenticateToken, async (req, res) => {
    if (!(await guard(req, res))) return;
    const q = String(req.query.q || '').trim().slice(0, 200);
    if (q.length < 3) return res.status(400).json({ error: 'query_too_short' });
    try {
      let store = null;
      if (req.query.uuid && UUID_RE.test(String(req.query.uuid))) {
        store = (await pool.query(`SELECT * FROM kaizen_stores WHERE uuid = $1`, [String(req.query.uuid)])).rows[0] || null;
      }
      const places = await google.searchText(q, { max: 8 });
      const out = store ? scorePlaces(store, places).map((c) => c.view)
        : places.map((p) => M.candidateView(p, { score: null, parts: {} }));
      res.json({ candidates: out });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  // Confirmer une fiche (parmi les candidats ou trouvée par la recherche). Le place_id est
  // revérifié auprès de Google : il donne aussi les coordonnées.
  app.post('/api/opener/kaizen/stores/:uuid/confirm', authenticateToken, async (req, res) => {
    if (!(await guard(req, res))) return;
    const placeId = String(req.body?.placeId || '');
    if (!PLACE_RE.test(placeId)) return res.status(400).json({ error: 'invalid_place_id' });
    try {
      const row = await loadStore(req, res); if (!row) return;
      let place;
      try { place = await google.details(placeId); }
      catch (e) { return res.status(502).json({ error: e.message }); }
      if (!place || place.id !== placeId) return res.status(400).json({ error: 'place_not_found' });
      const sc = M.scoreCandidate(row, place);
      const actor = actorOf(req);
      await pool.query(
        `UPDATE kaizen_stores SET match_status = 'manual', place_id = $2, match_score = $3, match_candidates = NULL,
                matched_by = $4, matched_at = CURRENT_TIMESTAMP, match_note = NULL WHERE uuid = $1`,
        [row.uuid, placeId, sc.score, actor]);
      await upsertPlace(placeId, place.location?.latitude, place.location?.longitude);
      log(row.uuid, 'matched', `${row.name} → fiche Google ${place.displayName?.text || placeId} (manuel)`, actor,
        { metadata: { placeId, previous: row.place_id, previousStatus: row.match_status, score: sc.score } });
      const fresh = (await pool.query(
        `SELECT k.*, op.lat, op.lng FROM kaizen_stores k LEFT JOIN opener_places op ON op.place_id = k.place_id WHERE k.uuid = $1`, [row.uuid])).rows[0];
      res.json({ store: shape(fresh) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/opener/kaizen/stores/:uuid/ignore', authenticateToken, async (req, res) => {
    if (!(await guard(req, res))) return;
    try {
      const row = await loadStore(req, res); if (!row) return;
      const reason = String(req.body?.reason || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200) || null;
      const actor = actorOf(req);
      await pool.query(
        `UPDATE kaizen_stores SET match_status = 'ignored', place_id = NULL, match_candidates = NULL,
                matched_by = $2, matched_at = CURRENT_TIMESTAMP, match_note = $3 WHERE uuid = $1`, [row.uuid, actor, reason]);
      log(row.uuid, 'ignored', `${row.name} — écarté de l'appariement${reason ? ` : ${reason}` : ''}`, actor,
        { metadata: { previous: row.place_id, previousStatus: row.match_status } });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Remettre en file automatique (défait une décision manuelle ou un « ignoré »).
  app.post('/api/opener/kaizen/stores/:uuid/reset', authenticateToken, async (req, res) => {
    if (!(await guard(req, res))) return;
    try {
      const row = await loadStore(req, res); if (!row) return;
      const actor = actorOf(req);
      await pool.query(
        `UPDATE kaizen_stores SET match_status = 'pending', place_id = NULL, match_score = NULL, match_candidates = NULL,
                match_attempted_at = NULL, matched_by = NULL, matched_at = NULL, match_note = NULL WHERE uuid = $1`, [row.uuid]);
      log(row.uuid, 'match_reset', `${row.name} — appariement remis à refaire`, actor,
        { metadata: { previous: row.place_id, previousStatus: row.match_status } });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return {
    runAll, syncStores, runMatching,
    // Worker : une fois par nuit. Sans identifiants Kaizen ni clé Google, ne fait rien et ne
    // journalise rien de plus qu'une ligne.
    // ⚠️ Le worker redémarre à CHAQUE déploiement (plusieurs par jour) : sans cette garde, chaque
    // redémarrage relancerait jusqu'à 300 recherches Google payantes. Le bouton de l'écran, lui,
    // passe outre — c'est le moyen d'écouler l'arriéré plus vite.
    runNightly: () => schema()
      .then(() => pool.query(
        `SELECT 1 FROM sync_state WHERE key = 'kaizen_last_ok' AND updated_at > CURRENT_TIMESTAMP - INTERVAL '20 hours'`))
      .then((r) => (r.rows.length ? 'recent' : runAll({ source: 'scheduled' })))
      .then((out) => {
        if (out === 'recent') return;
        if (!out) return console.log('[OPENER] synchro Kaizen déjà en cours — passage ignoré');
        console.log('[OPENER] synchro Kaizen :', JSON.stringify({ sync: out.sync, match: out.match, syncError: out.syncError, matchError: out.matchError }));
      })
      .catch((e) => console.error('[OPENER] synchro Kaizen :', e.message)),
  };
}

module.exports = { registerOpenerRoutes, ensureSchema, PERM_MATCH, STATUSES, addrKey };
