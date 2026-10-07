// ============================================================================
// Module Opener — lots 1 à 4 : balayage Google, routes, terrain.
//
// Plan : design/opener/PLAN-TECHNIQUE.md, §2 et §4 à §6.
//
//   Lot 1  POST /api/opener/scan          la zone dessinée → restaurants Google + statut Cluster
//   Lot 2  /api/opener/routes…            conception des routes par le manager, publication
//   Lot 3  /api/opener/today, /place, /checkins, /leads   l'opener sur le terrain
//   Lot 4  /api/opener/day, postpone, close              le résumé de journée
//
// Statut d'un restaurant sur la carte (calculé, jamais saisi) :
//   client    emplacement Cluster ACTIF (Kaizen V2 ou abonné Billing) relié à la fiche Google
//   former    emplacement Cluster inactif (ancien client)
//   prospect  piste créée, ou déjà visité (check-in)
//   new       rien de tout ça
//
// Google : seules la fiche (place_id) et ses coordonnées sont gardées en base (opener_places).
// Le reste (nom, note, horaires, téléphone) est lu à la demande et gardé UNE heure en mémoire.
// Le nom et l'adresse d'un ARRÊT sont recopiés sur la route : c'est la route que le manager a
// préparée, l'opener doit pouvoir la lire même sans réseau.
//
// Permissions : opener:routes (concevoir, publier), opener:field (faire sa route).
// ============================================================================

const crypto = require('crypto');
const G = require('./geo');
const M = require('./matching');
const E = require('./emails');

const PERM_FIELD = 'opener:field';
const PERM_ROUTES = 'opener:routes';
const TZ = 'America/Toronto';
const PLACE_RE = /^[A-Za-z0-9_-]{10,300}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SCAN_TYPES = ['restaurant', 'cafe', 'bar', 'bakery', 'meal_takeaway'];
const SCAN_START_RADIUS = 700;       // m — cercle de départ du quadrillage
const SCAN_MIN_RADIUS = 120;         // m — en dessous, on ne découpe plus
const SCAN_MAX_CALLS = 80;           // appels Nearby Search par zone
const SCAN_MAX_AREA = 25e6;          // m² — au-delà, la zone est refusée (≈ 5 km × 5 km)
const SCAN_MONTHLY_BUDGET = 6000;    // appels Nearby Search par mois (balayages + inventaire de la campagne). Variable OPENER_SCAN_MONTHLY_BUDGET
const MAX_STOPS = 60;
const CACHE_MS = 60 * 60 * 1000;     // mémoire des réponses Google (jamais en base)
const SERVICES = ['payments', 'pos', 'beverage_control'];
const SKIP_REASONS = ['closed', 'no_time', 'refused', 'other'];

const SCHEMA = [
  `ALTER TABLE opener_places ADD COLUMN IF NOT EXISTS last_seen_in_scan TIMESTAMP`,
  `ALTER TABLE opener_places ADD COLUMN IF NOT EXISTS lead_id INTEGER`,
  // Inventaire du territoire (campagne) : catégorie et région de chaque établissement.
  `ALTER TABLE opener_places ADD COLUMN IF NOT EXISTS kind VARCHAR(12)`,
  `ALTER TABLE opener_places ADD COLUMN IF NOT EXISTS region VARCHAR(20)`,
  // Exclu (« pas un restaurant », fermé…) : ne revient plus dans les balayages, les routes, la campagne.
  `ALTER TABLE opener_places ADD COLUMN IF NOT EXISTS excluded_at TIMESTAMP`,
  `ALTER TABLE opener_places ADD COLUMN IF NOT EXISTS excluded_by VARCHAR(255)`,
  `ALTER TABLE opener_places ADD COLUMN IF NOT EXISTS excluded_reason VARCHAR(200)`,
  `CREATE TABLE IF NOT EXISTS opener_routes (
    id            SERIAL PRIMARY KEY,
    name          VARCHAR(160) NOT NULL,
    route_date    DATE NOT NULL,
    opener_email  VARCHAR(255),
    status        VARCHAR(12) NOT NULL DEFAULT 'draft',
    zone          JSONB,
    start_lat     DOUBLE PRECISION,
    start_lng     DOUBLE PRECISION,
    created_by    VARCHAR(255) NOT NULL,
    updated_by    VARCHAR(255),
    published_at  TIMESTAMP,
    published_by  VARCHAR(255),
    closed_at     TIMESTAMP,
    version       INTEGER NOT NULL DEFAULT 1,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  // Une seule route publiée par opener et par jour.
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_opener_route_published
     ON opener_routes (LOWER(opener_email), route_date) WHERE status IN ('published','closed')`,
  `CREATE INDEX IF NOT EXISTS idx_opener_routes_date ON opener_routes (route_date)`,
  `CREATE TABLE IF NOT EXISTS opener_route_stops (
    id          SERIAL PRIMARY KEY,
    route_id    INTEGER NOT NULL REFERENCES opener_routes(id) ON DELETE CASCADE,
    place_id    VARCHAR(300) NOT NULL,
    position    INTEGER NOT NULL,
    label       VARCHAR(255) NOT NULL,
    address     VARCHAR(400),
    lat         DOUBLE PRECISION,
    lng         DOUBLE PRECISION,
    outcome     VARCHAR(12) NOT NULL DEFAULT 'planned',
    skip_reason VARCHAR(20),
    done_at     TIMESTAMP,
    UNIQUE (route_id, place_id)
  )`,
  `CREATE TABLE IF NOT EXISTS opener_checkins (
    id             UUID PRIMARY KEY,
    place_id       VARCHAR(300) NOT NULL,
    route_stop_id  INTEGER REFERENCES opener_route_stops(id) ON DELETE SET NULL,
    user_email     VARCHAR(255) NOT NULL,
    user_name      VARCHAR(255),
    at             TIMESTAMPTZ NOT NULL,
    lat            DOUBLE PRECISION,
    lng            DOUBLE PRECISION,
    accuracy_m     INTEGER,
    distance_m     INTEGER,
    current_pos    VARCHAR(40) NOT NULL,
    service_type   VARCHAR(10) NOT NULL,
    terminals      SMALLINT,
    online_delivery BOOLEAN,
    decision_maker VARCHAR(6),
    interest_level SMALLINT NOT NULL,
    services       JSONB NOT NULL DEFAULT '[]'::jsonb,
    notes          TEXT,
    lead_id        INTEGER,
    received_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_opener_checkins_place ON opener_checkins (place_id, at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_opener_checkins_user  ON opener_checkins (LOWER(user_email), at DESC)`,
  // Durée de la visite (demande de David, 2026-10-06) : l'ARRIVÉE = l'ouverture de l'écran de
  // check-in au restaurant, avec la position à ce moment-là ; le DÉPART = l'enregistrement (`at`,
  // lat/lng). Le verdict « sur place » se fonde sur la position à l'arrivée quand elle existe.
  `ALTER TABLE opener_checkins ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ`,
  `ALTER TABLE opener_checkins ADD COLUMN IF NOT EXISTS start_lat DOUBLE PRECISION`,
  `ALTER TABLE opener_checkins ADD COLUMN IF NOT EXISTS start_lng DOUBLE PRECISION`,
  `ALTER TABLE opener_checkins ADD COLUMN IF NOT EXISTS start_accuracy_m INTEGER`,
  `ALTER TABLE opener_checkins ADD COLUMN IF NOT EXISTS start_distance_m INTEGER`,
  // Visite d'un CLIENT Cluster (2026-10-08) : est-il satisfait (1 à 5), et qui traite ses
  // paiements (cluster | other | unknown) — la porte d'entrée pour proposer les paiements.
  `ALTER TABLE opener_checkins ADD COLUMN IF NOT EXISTS satisfaction SMALLINT`,
  `ALTER TABLE opener_checkins ADD COLUMN IF NOT EXISTS payments_by VARCHAR(10)`,
];

// AAAA-MM-JJ à Montréal. Jamais `new Date().toISOString()` : à 20 h à Montréal, c'est déjà demain en UTC.
const ymdMtl = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const addDays = (ymd, n) => { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const fmtDay = (ymd, lang) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString(lang === 'en' ? 'en-CA' : 'fr-CA', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
const clean = (v, n) => { const s = String(v == null ? '' : v).replace(/[\r\t]+/g, ' ').trim(); return s ? s.slice(0, n) : null; };
const comp = (place, type, short = false) => {
  const c = (place?.addressComponents || []).find((x) => (x.types || []).includes(type));
  return c ? (short ? c.shortText || c.longText : c.longText || c.shortText) : null;
};
// Verdict d'une visite, d'après la position GPS du téléphone AU MOMENT du check-in.
//   onsite     ≤ 150 m du restaurant, précision ≤ 100 m
//   far        à plus de 150 m
//   imprecise  à moins de 150 m mais précision GPS de plus de 100 m (intérieur, signal faible)
//   nogps      aucune position (localisation refusée ou indisponible)
// Projections SQL d'un check-in `c` : position qui atteste la visite (l'arrivée si elle est connue,
// sinon le départ) et durée en minutes (null si l'arrivée est inconnue).
const V_LAT = 'COALESCE(c.start_lat, c.lat)';
const V_DIST = 'CASE WHEN c.start_lat IS NOT NULL THEN c.start_distance_m ELSE c.distance_m END';
const V_ACC = 'CASE WHEN c.start_lat IS NOT NULL THEN c.start_accuracy_m ELSE c.accuracy_m END';
const DUR_MIN = 'ROUND(EXTRACT(EPOCH FROM (c.at - c.started_at)) / 60)::int';
const ONSITE_M = 150;
const PRECISE_M = 100;
function verdict(distanceM, accuracyM, lat) {
  if (lat == null || distanceM == null) return 'nogps';
  if (distanceM > ONSITE_M) return 'far';
  if (accuracyM != null && accuracyM > PRECISE_M) return 'imprecise';
  return 'onsite';
}
const num = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

function registerOpenerFieldRoutes(app, deps) {
  const { authenticateToken, requirePerm, hasPerm, pool, logActivity } = deps;
  const google = deps.google || M.createGooglePlaces();
  const late = () => (deps.late ? deps.late() : {});
  const frontend = () => process.env.FRONTEND_URL || 'https://saleshub.clusterpos.com';

  let ready = null;
  const schema = () => (ready = ready || (async () => {
    // opener_places est créée par le lot 0 (routes.js) ; on attend qu'elle existe.
    if (deps.baseSchema) await deps.baseSchema();
    for (const sql of SCHEMA) await pool.query(sql);
  })().catch((e) => { ready = null; throw e; }));
  if (pool) schema().catch((e) => console.error('opener field schema:', e.message));

  const me = (req) => String(req.user?.email || '').toLowerCase();
  const actorOf = (req) => req.user?.realAdminEmail || req.user?.email || 'unknown';
  const isAdmin = (req) => req.user && req.user.isAdmin === true;
  const can = async (req, perm) => isAdmin(req) || (await Promise.resolve(hasPerm(req, perm)).catch(() => false));
  const log = (type, id, event, desc, actor, extra) =>
    Promise.resolve(logActivity && logActivity(type, id, event, desc, actor, extra)).catch(() => {});

  async function guard(req, res, perm) {
    if (!(await requirePerm(req, res, perm))) return false;
    await schema();
    return true;
  }
  async function guardAny(req, res, perms) {
    for (const p of perms) if (await can(req, p)) { await schema(); return true; }
    res.status(403).json({ error: 'forbidden' });
    return false;
  }

  // --------------------------------------------------------------------------
  // Mémoire Google (une heure, jamais en base)
  // --------------------------------------------------------------------------
  const cache = new Map();
  async function cached(key, fn) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.v;
    const v = await fn();
    cache.set(key, { at: Date.now(), v });
    if (cache.size > 3000) for (const k of [...cache.keys()].slice(0, 500)) cache.delete(k);
    return v;
  }

  async function userName(email) {
    if (!email) return null;
    const r = await pool.query(
      `SELECT COALESCE(
          (SELECT display_name FROM user_tokens WHERE LOWER(email) = $1 AND display_name IS NOT NULL LIMIT 1),
          (SELECT display_name FROM local_users WHERE LOWER(email) = $1 AND display_name IS NOT NULL LIMIT 1)) AS n`,
      [String(email).toLowerCase()]).catch(() => ({ rows: [] }));
    return r.rows[0]?.n || null;
  }

  // Nom à AFFICHER : le nom Sales Hub, sinon tiré de l'adresse (« haominh.phung@… » → « Haominh
  // Phung »). Un opener qui ne s'est jamais connecté n'a pas de nom en base, et une adresse
  // courriel complète débordait sur la carte de campagne (2026-10-08).
  const prettyEmail = (email) => String(email || '').split('@')[0].split(/[._-]+/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ') || String(email || '');
  async function displayName(email) {
    if (!email) return null;
    return (await userName(email)) || prettyEmail(email);
  }

  // --------------------------------------------------------------------------
  // Statut Cluster d'un lot de fiches Google
  // --------------------------------------------------------------------------
  async function statusOf(placeIds) {
    const ids = [...new Set(placeIds.filter(Boolean))];
    const out = new Map();
    if (!ids.length) return out;
    const { rows } = await pool.query(
      `SELECT p.pid,
         (SELECT json_build_object('id', l.id, 'active', l.active, 'source', l.source, 'name', l.name,
                                   'version', COALESCE(l.version_override, l.software_version))
            FROM cluster_locations l
           WHERE l.place_id = p.pid AND l.missing_since IS NULL AND l.match_status <> 'ignored'
           ORDER BY l.active DESC, (l.source = 'kaizen') DESC, l.id LIMIT 1) AS loc,
         (SELECT json_build_object('at', c.at, 'by', COALESCE(c.user_name, c.user_email), 'currentPos', c.current_pos,
                                   'serviceType', c.service_type, 'interest', c.interest_level,
                                   'satisfaction', c.satisfaction, 'paymentsBy', c.payments_by)
            FROM opener_checkins c WHERE c.place_id = p.pid ORDER BY c.at DESC LIMIT 1) AS last,
         (SELECT json_build_object('id', ld.id, 'refCode', ld.ref_code, 'status', ld.status)
            FROM opener_places op JOIN leads ld ON ld.id = op.lead_id WHERE op.place_id = p.pid) AS lead,
         (SELECT COUNT(*)::int FROM opener_checkins c WHERE c.place_id = p.pid) AS visits
       FROM unnest($1::text[]) AS p(pid)`, [ids]);
    for (const r of rows) {
      const loc = r.loc || null;
      const status = loc && loc.active ? 'client' : loc ? 'former' : (r.lead || r.last) ? 'prospect' : 'new';
      out.set(r.pid, {
        status, version: loc?.version || null, clusterName: loc?.name || null, source: loc?.source || null,
        lastVisitAt: r.last?.at || null, lastVisitBy: r.last?.by || null, competitorPos: r.last?.currentPos || null,
        serviceTypeSeen: r.last?.serviceType || null, lastInterest: r.last?.interest ?? null,
        lastSatisfaction: r.last?.satisfaction ?? null, lastPaymentsBy: r.last?.paymentsBy || null,
        lead: r.lead || null, visits: r.visits || 0,
      });
    }
    return out;
  }

  async function upsertPlaces(list, source) {
    for (let i = 0; i < list.length; i += 200) {
      const part = list.slice(i, i + 200);
      const vals = []; const rows = part.map((p, j) => {
        vals.push(p.placeId, p.lat ?? null, p.lng ?? null);
        return `($${j * 3 + 1}, $${j * 3 + 2}::float8, $${j * 3 + 3}::float8, CURRENT_TIMESTAMP, '${source}', ${source === 'scan' ? 'CURRENT_TIMESTAMP' : 'NULL'})`;
      });
      await pool.query(
        `INSERT INTO opener_places (place_id, lat, lng, coords_refreshed_at, source, last_seen_in_scan)
         VALUES ${rows.join(',')}
         ON CONFLICT (place_id) DO UPDATE SET
           lat = COALESCE(EXCLUDED.lat, opener_places.lat), lng = COALESCE(EXCLUDED.lng, opener_places.lng),
           coords_refreshed_at = CASE WHEN EXCLUDED.lat IS NULL THEN opener_places.coords_refreshed_at ELSE CURRENT_TIMESTAMP END,
           last_seen_in_scan = COALESCE(EXCLUDED.last_seen_in_scan, opener_places.last_seen_in_scan)`, vals);
    }
  }

  // ==========================================================================
  // LOT 1 — Balayage d'une zone
  // ==========================================================================
  async function scanBudget(calls) {
    const month = ymdMtl().slice(0, 7);
    const key = 'opener_scan_usage';
    const cur = (await pool.query(`SELECT value FROM sync_state WHERE key = $1`, [key])).rows[0]?.value;
    let u = { month, calls: 0 };
    try { const v = JSON.parse(cur); if (v && v.month === month) u = v; } catch { /* nouveau mois */ }
    if (calls) {
      u.calls += calls;
      await pool.query(
        `INSERT INTO sync_state (key, value, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP)
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP`, [key, JSON.stringify(u)]);
    }
    const limit = Number(process.env.OPENER_SCAN_MONTHLY_BUDGET) || SCAN_MONTHLY_BUDGET;
    return { ...u, limit, left: Math.max(0, limit - u.calls) };
  }

  async function scanZone(poly) {
    const budget = await scanBudget(0);
    const maxCalls = Math.min(SCAN_MAX_CALLS, budget.left);
    if (maxCalls <= 0) { const e = new Error('scan_budget_exhausted'); e.code = 429; throw e; }
    const queue = G.coverCircles(poly, SCAN_START_RADIUS);
    const found = new Map();
    let calls = 0, fromCache = 0;
    while (queue.length && calls < maxCalls) {
      const c = queue.shift();
      const key = `nearby:${c.center[0].toFixed(5)},${c.center[1].toFixed(5)},${Math.round(c.radius)}`;
      let places;
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < CACHE_MS) { places = hit.v; fromCache++; }
      else { places = await google.searchNearby(c.center, c.radius, SCAN_TYPES); calls++; cache.set(key, { at: Date.now(), v: places }); }
      for (const p of places) {
        const lat = p.location?.latitude, lng = p.location?.longitude;
        if (lat == null || lng == null || p.businessStatus === 'CLOSED_PERMANENTLY') continue;
        if (!G.pointInPolygon([lat, lng], poly)) continue;
        found.set(p.id, p);
      }
      if (places.length >= 20 && c.radius > SCAN_MIN_RADIUS) {
        for (const k of G.splitCircle(c)) if (G.circleTouchesPolygon(k.center, k.radius, poly)) queue.push(k);
      }
    }
    if (calls) await scanBudget(calls);
    return { places: [...found.values()], calls, fromCache, truncated: queue.length > 0 };
  }

  const shapeScanned = (p, st) => ({
    placeId: p.id,
    name: p.displayName?.text || '',
    address: p.shortFormattedAddress || p.formattedAddress || '',
    lat: p.location?.latitude ?? null,
    lng: p.location?.longitude ?? null,
    rating: p.rating ?? null,
    reviews: p.userRatingCount ?? null,
    primaryType: p.primaryType || null,
    serviceType: M.serviceTypeOf(p) || st?.serviceTypeSeen || null,
    ...(st || { status: 'new', visits: 0 }),
  });

  app.post('/api/opener/scan', authenticateToken, async (req, res) => {
    if (!(await guard(req, res, PERM_ROUTES))) return;
    const poly = G.cleanPolygon(req.body?.polygon);
    if (!poly) return res.status(400).json({ error: 'invalid_polygon' });
    if (G.areaM2(poly) > SCAN_MAX_AREA) return res.status(400).json({ error: 'zone_too_large', maxKm2: SCAN_MAX_AREA / 1e6 });
    if (!google.configured()) return res.status(503).json({ error: 'GOOGLE_PLACES_API_KEY absente' });
    try {
      const r = await scanZone(poly);
      await upsertPlaces(r.places.map((p) => ({ placeId: p.id, lat: p.location?.latitude, lng: p.location?.longitude })), 'scan');
      const excluded = new Set((await pool.query(
        `SELECT place_id FROM opener_places WHERE excluded_at IS NOT NULL AND place_id = ANY($1::text[])`,
        [r.places.map((p) => p.id)])).rows.map((x) => x.place_id));
      const kept = r.places.filter((p) => !excluded.has(p.id));
      const st = await statusOf(kept.map((p) => p.id));
      const places = kept.map((p) => shapeScanned(p, st.get(p.id)));
      const budget = await scanBudget(0);
      res.json({ places, calls: r.calls, fromCache: r.fromCache, truncated: r.truncated, budget, excluded: excluded.size });
    } catch (e) {
      if (e.code === 429) return res.status(429).json({ error: 'scan_budget_exhausted', budget: await scanBudget(0) });
      res.status(502).json({ error: e.message });
    }
  });

  // Exclure un établissement (« pas un restaurant », fermé, entrepôt…) : il ne revient plus dans
  // les balayages, les routes suggérées ni la campagne. Demande de David (2026-10-07). Le manager
  // ET l'opener peuvent exclure (l'opener le constate sur place) ; seul le manager rétablit.
  // Depuis une route, l'arrêt est marqué « non visité » avec la raison.
  app.post('/api/opener/places/:placeId/exclude', authenticateToken, async (req, res) => {
    if (!(await guardAny(req, res, [PERM_ROUTES, PERM_FIELD]))) return;
    const pid = String(req.params.placeId || '');
    if (!PLACE_RE.test(pid)) return res.status(404).json({ error: 'not_found' });
    const reason = clean(req.body?.reason, 200) || 'not_restaurant';
    try {
      await pool.query(
        `INSERT INTO opener_places (place_id, excluded_at, excluded_by, excluded_reason, source) VALUES ($1, CURRENT_TIMESTAMP, $2, $3, 'exclude')
         ON CONFLICT (place_id) DO UPDATE SET excluded_at = CURRENT_TIMESTAMP, excluded_by = $2, excluded_reason = $3`,
        [pid, actorOf(req), reason]);
      const stopId = parseInt(req.body?.stopId, 10) || 0;
      if (stopId) {
        const stop = await myStop(req, stopId);
        if (stop && stop.place_id === pid && stop.outcome === 'planned') {
          await pool.query(`UPDATE opener_route_stops SET outcome = 'skipped', skip_reason = 'excluded', done_at = CURRENT_TIMESTAMP WHERE id = $1`, [stop.id]);
        }
      }
      log('opener_place', pid, 'excluded', `Établissement exclu (${reason})`, actorOf(req));
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/opener/places/:placeId/exclude', authenticateToken, async (req, res) => {
    if (!(await guard(req, res, PERM_ROUTES))) return;
    const pid = String(req.params.placeId || '');
    try {
      const r = await pool.query(`UPDATE opener_places SET excluded_at = NULL, excluded_by = NULL, excluded_reason = NULL WHERE place_id = $1`, [pid]);
      if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
      log('opener_place', pid, 'unexcluded', 'Établissement rétabli', actorOf(req));
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Les établissements exclus (pour les rétablir).
  app.get('/api/opener/excluded', authenticateToken, async (req, res) => {
    if (!(await guard(req, res, PERM_ROUTES))) return;
    try {
      const { rows } = await pool.query(
        `SELECT place_id, lat, lng, excluded_at, excluded_by, excluded_reason FROM opener_places
          WHERE excluded_at IS NOT NULL ORDER BY excluded_at DESC LIMIT 500`);
      // Nom et adresse : lus chez Google (gardés 1 h en mémoire, jamais en base) pour les 60 plus
      // récents — assez pour reconnaître un lieu exclu par erreur.
      const names = new Map();
      if (google.configured()) {
        await Promise.all(rows.slice(0, 60).map(async (r) => {
          try {
            const d = await cached(`lite:${r.place_id}`, () => google.details(r.place_id));
            names.set(r.place_id, { name: d?.displayName?.text || null, address: d?.formattedAddress ? d.formattedAddress.split(',').slice(0, 2).join(',') : null });
          } catch { /* nom absent : la ligne reste rétablissable */ }
        }));
      }
      res.json({ excluded: rows.map((r) => ({ placeId: r.place_id, lat: r.lat, lng: r.lng, at: r.excluded_at, by: r.excluded_by, reason: r.excluded_reason,
        name: names.get(r.place_id)?.name || null, address: names.get(r.place_id)?.address || null })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Trouver un quartier ou une adresse (« Plateau-Mont-Royal », « 4520 Saint-Denis ») : le point
  // de départ d'une zone suggérée, sans dessiner. Une recherche Google, gardée 1 h en mémoire.
  app.get('/api/opener/geocode', authenticateToken, async (req, res) => {
    if (!(await guard(req, res, PERM_ROUTES))) return;
    const q = String(req.query.q || '').trim().slice(0, 200);
    if (q.length < 3) return res.status(400).json({ error: 'query_too_short' });
    if (!google.configured()) return res.status(503).json({ error: 'GOOGLE_PLACES_API_KEY absente' });
    try {
      const places = await cached(`geo:${q.toLowerCase()}`, () => google.searchText(`${q}, Québec`, { max: 5 }));
      res.json({ results: places.filter((p) => p.location).map((p) => ({
        name: p.displayName?.text || q, address: p.formattedAddress || '',
        lat: p.location.latitude, lng: p.location.longitude,
      })) });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  // Clé navigateur Google Maps (restreinte au domaine dans la console Google) : servie par l'API
  // et non compilée dans le site, pour la changer sans redéployer Netlify.
  app.get('/api/opener/config', authenticateToken, async (req, res) => {
    if (!(await guardAny(req, res, [PERM_FIELD, PERM_ROUTES]))) return;
    res.json({
      mapsKey: process.env.GOOGLE_MAPS_BROWSER_KEY || null,
      mapId: process.env.GOOGLE_MAPS_MAP_ID || null,
      today: ymdMtl(),
      scanBudget: (await can(req, PERM_ROUTES)) ? await scanBudget(0) : undefined,
    });
  });

  // Les openers : usagers dont un rôle porte opener:field.
  app.get('/api/opener/openers', authenticateToken, async (req, res) => {
    if (!(await guard(req, res, PERM_ROUTES))) return;
    try {
      const { rows } = await pool.query(
        `SELECT DISTINCT LOWER(ur.user_email) AS email FROM user_roles ur JOIN roles r ON r.id = ur.role_id
          WHERE r.permissions ? $1 OR r.permissions ? 'opener:*'`, [PERM_FIELD]);
      const out = [];
      for (const r of rows) out.push({ email: r.email, name: await displayName(r.email) });
      out.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
      res.json({ openers: out });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ==========================================================================
  // LOT 2 — Routes (manager)
  // ==========================================================================
  const ROUTE_COLS = `r.id, r.name, r.route_date::text AS route_date, r.opener_email, r.status, r.zone, r.start_lat, r.start_lng,
                      r.created_by, r.updated_by, r.published_at, r.published_by, r.closed_at, r.version, r.updated_at`;
  async function loadRoute(id) {
    const r = (await pool.query(`SELECT ${ROUTE_COLS} FROM opener_routes r WHERE r.id = $1`, [id])).rows[0];
    if (!r) return null;
    const stops = (await pool.query(
      `SELECT s.*, (SELECT json_build_object('id', c.id, 'at', c.at, 'interest', c.interest_level, 'leadId', c.lead_id,
                                             'decisionMaker', c.decision_maker, 'currentPos', c.current_pos,
                                             'lat', ${V_LAT}, 'distanceM', ${V_DIST}, 'accuracyM', ${V_ACC},
                                             'startedAt', c.started_at, 'durationMin', ${DUR_MIN}, 'endDistanceM', c.distance_m)
                      FROM opener_checkins c WHERE c.route_stop_id = s.id ORDER BY c.at DESC LIMIT 1) AS checkin
         FROM opener_route_stops s WHERE s.route_id = $1 ORDER BY s.position, s.id`, [id])).rows;
    const st = await statusOf(stops.map((s) => s.place_id));
    return {
      id: r.id, name: r.name, date: r.route_date, openerEmail: r.opener_email, openerName: await displayName(r.opener_email),
      status: r.status, zone: r.zone, start: r.start_lat != null ? [r.start_lat, r.start_lng] : null,
      createdBy: r.created_by, updatedBy: r.updated_by, publishedAt: r.published_at, publishedBy: r.published_by,
      closedAt: r.closed_at, version: r.version, updatedAt: r.updated_at,
      stops: stops.map((s) => ({
        id: s.id, placeId: s.place_id, position: s.position, name: s.label, address: s.address, lat: s.lat, lng: s.lng,
        outcome: s.outcome, skipReason: s.skip_reason, doneAt: s.done_at,
        checkin: s.checkin ? { ...s.checkin, verdict: verdict(s.checkin.distanceM, s.checkin.accuracyM, s.checkin.lat) } : null,
        ...(st.get(s.place_id) || { status: 'new' }),
      })),
    };
  }

  function parseRouteBody(b, { partial = false } = {}) {
    const out = {};
    if (!partial || b.name !== undefined) {
      out.name = clean(b.name, 160);
      if (!out.name) return { error: 'name_required' };
    }
    if (!partial || b.date !== undefined) {
      if (!DATE_RE.test(String(b.date || ''))) return { error: 'invalid_date' };
      out.date = b.date;
    }
    if (b.openerEmail !== undefined) {
      const e = String(b.openerEmail || '').trim().toLowerCase();
      if (e && !EMAIL_RE.test(e)) return { error: 'invalid_opener' };
      out.openerEmail = e || null;
    }
    if (b.zone !== undefined) {
      if (b.zone === null) out.zone = null;
      else { const z = G.cleanPolygon(b.zone); if (!z) return { error: 'invalid_zone' }; out.zone = z; }
    }
    if (b.start !== undefined) {
      const s = Array.isArray(b.start) ? b.start.map(Number) : null;
      out.start = s && s.length === 2 && s.every(Number.isFinite) ? s : null;
    }
    if (b.stops !== undefined) {
      if (!Array.isArray(b.stops) || b.stops.length > MAX_STOPS) return { error: 'invalid_stops', max: MAX_STOPS };
      const seen = new Set();
      out.stops = [];
      for (const s of b.stops) {
        const pid = String(s?.placeId || '');
        if (!PLACE_RE.test(pid)) return { error: 'invalid_stop_place' };
        if (seen.has(pid)) continue;
        seen.add(pid);
        out.stops.push({ placeId: pid, name: clean(s.name, 255) || '(sans nom)', address: clean(s.address, 400),
          lat: num(s.lat), lng: num(s.lng) });
      }
    }
    return { value: out };
  }

  async function writeStops(routeId, stops) {
    // Une route encore modifiable n'a aucun arrêt commencé : on la réécrit entièrement.
    await pool.query(`DELETE FROM opener_route_stops WHERE route_id = $1`, [routeId]);
    for (const [i, s] of stops.entries()) {
      await pool.query(
        `INSERT INTO opener_route_stops (route_id, place_id, position, label, address, lat, lng) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [routeId, s.placeId, i + 1, s.name, s.address, s.lat, s.lng]);
    }
    await upsertPlaces(stops.filter((s) => s.lat != null).map((s) => ({ placeId: s.placeId, lat: s.lat, lng: s.lng })), 'route');
  }

  app.get('/api/opener/routes', authenticateToken, async (req, res) => {
    if (!(await guard(req, res, PERM_ROUTES))) return;
    try {
      const today = ymdMtl();
      const from = DATE_RE.test(String(req.query.from || '')) ? req.query.from : addDays(today, -14);
      const to = DATE_RE.test(String(req.query.to || '')) ? req.query.to : addDays(today, 30);
      const { rows } = await pool.query(
        `SELECT ${ROUTE_COLS},
                (SELECT COUNT(*)::int FROM opener_route_stops s WHERE s.route_id = r.id) AS stops,
                (SELECT COUNT(*)::int FROM opener_route_stops s WHERE s.route_id = r.id AND s.outcome = 'done') AS done
           FROM opener_routes r WHERE r.route_date BETWEEN $1 AND $2
          ORDER BY r.route_date DESC, r.id DESC`, [from, to]);
      const out = [];
      for (const r of rows) {
        out.push({ id: r.id, name: r.name, date: r.route_date, openerEmail: r.opener_email, openerName: await displayName(r.opener_email),
          status: r.status, stops: r.stops, done: r.done, updatedAt: r.updated_at, version: r.version });
      }
      res.json({ routes: out, from, to });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Vue de suivi : les routes d'une période avec leurs arrêts (position + résultat) et le DERNIER
  // check-in de chaque route — « où il est rendu ». Pas de suivi GPS continu : la dernière position
  // connue est celle du dernier check-in, avec son heure.
  app.get('/api/opener/routes-overview', authenticateToken, async (req, res) => {
    if (!(await guard(req, res, PERM_ROUTES))) return;
    try {
      const today = ymdMtl();
      const from = DATE_RE.test(String(req.query.from || '')) ? req.query.from : today;
      const to = DATE_RE.test(String(req.query.to || '')) ? req.query.to : addDays(from, 6);
      const routes = (await pool.query(
        `SELECT ${ROUTE_COLS} FROM opener_routes r WHERE r.route_date BETWEEN $1 AND $2 ORDER BY r.route_date, r.id`, [from, to])).rows;
      const ids = routes.map((r) => r.id);
      const stops = ids.length ? (await pool.query(
        `SELECT s.id, s.route_id, s.place_id, s.position, s.label, s.lat, s.lng, s.outcome, s.skip_reason, s.done_at,
                c.at AS c_at, c.lat AS c_lat, c.lng AS c_lng, c.distance_m AS c_dist, c.accuracy_m AS c_acc,
                c.started_at AS c_start, c.duration_min AS c_dur, c.end_distance_m AS c_end_dist
           FROM opener_route_stops s
           LEFT JOIN LATERAL (SELECT c.at, ${V_LAT} AS lat, COALESCE(c.start_lng, c.lng) AS lng, ${V_DIST} AS distance_m,
                                     ${V_ACC} AS accuracy_m, c.started_at, ${DUR_MIN} AS duration_min, c.distance_m AS end_distance_m
                                FROM opener_checkins c
                               WHERE c.route_stop_id = s.id ORDER BY c.at DESC LIMIT 1) c ON true
          WHERE s.route_id = ANY($1::int[]) ORDER BY s.route_id, s.position`, [ids])).rows : [];
      const last = ids.length ? (await pool.query(
        `SELECT DISTINCT ON (s.route_id) s.route_id, c.at, c.lat, c.lng, c.distance_m, s.label
           FROM opener_checkins c JOIN opener_route_stops s ON s.id = c.route_stop_id
          WHERE s.route_id = ANY($1::int[]) ORDER BY s.route_id, c.at DESC`, [ids])).rows : [];
      const lastBy = new Map(last.map((l) => [l.route_id, l]));
      const out = [];
      for (const r of routes) {
        const st = stops.filter((s) => s.route_id === r.id);
        const l = lastBy.get(r.id);
        out.push({
          id: r.id, name: r.name, date: r.route_date, status: r.status, openerEmail: r.opener_email,
          openerName: await displayName(r.opener_email), zone: r.zone,
          total: st.length, done: st.filter((s) => s.outcome === 'done').length, skipped: st.filter((s) => s.outcome === 'skipped').length,
          stops: st.map((s) => ({
            id: s.id, name: s.label, lat: s.lat, lng: s.lng, outcome: s.outcome, skipReason: s.skip_reason, doneAt: s.done_at,
            // La visite : où était le téléphone au check-in, et le verdict qui en découle.
            checkin: s.c_at ? { at: s.c_at, lat: s.c_lat, lng: s.c_lng, distanceM: s.c_dist, accuracyM: s.c_acc,
              startedAt: s.c_start, durationMin: s.c_dur, endDistanceM: s.c_end_dist,
              verdict: verdict(s.c_dist, s.c_acc, s.c_lat) } : null,
          })),
          // Temps passé en visite sur la route (somme des durées connues).
          visitMinutes: st.reduce((a, s) => a + (s.c_dur > 0 ? s.c_dur : 0), 0),
          verdicts: st.reduce((acc, s) => {
            if (s.c_at) { const v = verdict(s.c_dist, s.c_acc, s.c_lat); acc[v] = (acc[v] || 0) + 1; }
            return acc;
          }, {}),
          lastCheckin: l ? { at: l.at, lat: l.lat, lng: l.lng, stopName: l.label, distanceM: l.distance_m } : null,
        });
      }
      res.json({ from, to, today, routes: out });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/opener/routes/:id', authenticateToken, async (req, res) => {
    if (!(await guard(req, res, PERM_ROUTES))) return;
    try {
      const r = await loadRoute(parseInt(req.params.id, 10) || 0);
      if (!r) return res.status(404).json({ error: 'not_found' });
      res.json({ route: r });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/opener/routes', authenticateToken, async (req, res) => {
    if (!(await guard(req, res, PERM_ROUTES))) return;
    const p = parseRouteBody(req.body || {});
    if (p.error) return res.status(400).json(p);
    const v = p.value;
    try {
      const actor = actorOf(req);
      const r = await pool.query(
        `INSERT INTO opener_routes (name, route_date, opener_email, zone, start_lat, start_lng, created_by, updated_by)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $7) RETURNING id`,
        [v.name, v.date, v.openerEmail || null, v.zone ? JSON.stringify(v.zone) : null, v.start?.[0] ?? null, v.start?.[1] ?? null, actor]);
      const id = r.rows[0].id;
      if (v.stops) await writeStops(id, v.stops);
      log('opener_route', id, 'created', `${v.name} — ${v.date}`, actor);
      res.json({ route: await loadRoute(id) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Autosave du brouillon. `version` = verrou optimiste : deux managers sur la même route ne
  // s'écrasent pas en silence (409, l'écran recharge).
  app.put('/api/opener/routes/:id', authenticateToken, async (req, res) => {
    if (!(await guard(req, res, PERM_ROUTES))) return;
    const id = parseInt(req.params.id, 10) || 0;
    const p = parseRouteBody(req.body || {}, { partial: true });
    if (p.error) return res.status(400).json(p);
    const v = p.value;
    try {
      const cur = (await pool.query(`SELECT status, version FROM opener_routes WHERE id = $1`, [id])).rows[0];
      if (!cur) return res.status(404).json({ error: 'not_found' });
      if (cur.status !== 'draft') return res.status(409).json({ error: 'not_draft', status: cur.status });
      if (req.body?.version !== undefined && Number(req.body.version) !== cur.version) {
        return res.status(409).json({ error: 'version_conflict', version: cur.version });
      }
      const sets = []; const vals = [id];
      const set = (col, val, cast = '') => { vals.push(val); sets.push(`${col} = $${vals.length}${cast}`); };
      if (v.name !== undefined) set('name', v.name);
      if (v.date !== undefined) set('route_date', v.date);
      if (v.openerEmail !== undefined) set('opener_email', v.openerEmail);
      if (v.zone !== undefined) set('zone', v.zone ? JSON.stringify(v.zone) : null, '::jsonb');
      if (v.start !== undefined) { set('start_lat', v.start?.[0] ?? null); set('start_lng', v.start?.[1] ?? null); }
      set('updated_by', actorOf(req));
      await pool.query(`UPDATE opener_routes SET ${sets.join(', ')}, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, vals);
      if (v.stops) await writeStops(id, v.stops);
      res.json({ route: await loadRoute(id) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/opener/routes/:id', authenticateToken, async (req, res) => {
    if (!(await guard(req, res, PERM_ROUTES))) return;
    const id = parseInt(req.params.id, 10) || 0;
    try {
      const cur = (await pool.query(`SELECT name, status FROM opener_routes WHERE id = $1`, [id])).rows[0];
      if (!cur) return res.status(404).json({ error: 'not_found' });
      if (cur.status !== 'draft') return res.status(409).json({ error: 'not_draft' });
      await pool.query(`DELETE FROM opener_routes WHERE id = $1`, [id]);
      log('opener_route', id, 'deleted', `${cur.name} — brouillon supprimé`, actorOf(req));
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  async function sendRouteEmail(route, actor) {
    const L = late();
    if (!L.sendMail || !L.mailShell || !route.openerEmail) return { sent: false };
    const mail = E.routePublishedEmail(L.mailShell, {
      openerName: route.openerName || '', routeName: route.name,
      dateFr: fmtDay(route.date, 'fr'), dateEn: fmtDay(route.date, 'en'),
      stops: route.stops.map((s) => ({ name: s.name, address: s.address })),
      publishedBy: (await userName(actor)) || actor, link: `${frontend()}/opener`,
    });
    return L.sendMail(route.openerEmail, mail.subject, mail.html).catch((e) => ({ sent: false, reason: e.message }));
  }

  // Publier : verrouille la route pour ce jour et prévient l'opener par courriel.
  app.post('/api/opener/routes/:id/publish', authenticateToken, async (req, res) => {
    if (!(await guard(req, res, PERM_ROUTES))) return;
    const id = parseInt(req.params.id, 10) || 0;
    try {
      const route = await loadRoute(id);
      if (!route) return res.status(404).json({ error: 'not_found' });
      if (route.status !== 'draft') return res.status(409).json({ error: 'not_draft' });
      if (!route.openerEmail) return res.status(400).json({ error: 'opener_required' });
      if (!route.stops.length) return res.status(400).json({ error: 'stops_required' });
      const clash = (await pool.query(
        `SELECT id, name FROM opener_routes WHERE LOWER(opener_email) = $1 AND route_date = $2 AND status IN ('published','closed') AND id <> $3`,
        [route.openerEmail.toLowerCase(), route.date, id])).rows[0];
      if (clash) return res.status(409).json({ error: 'opener_has_route', route: clash });
      const actor = actorOf(req);
      await pool.query(
        `UPDATE opener_routes SET status = 'published', published_at = CURRENT_TIMESTAMP, published_by = $2,
                version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [id, actor]);
      const fresh = await loadRoute(id);
      const mail = await sendRouteEmail(fresh, actor);
      log('opener_route', id, 'published', `${fresh.name} — ${fresh.date} → ${fresh.openerEmail} (${fresh.stops.length} arrêts)`, actor,
        { metadata: { emailSent: !!mail?.sent } });
      res.json({ route: fresh, emailSent: !!mail?.sent });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Dépublier : seulement tant que l'opener n'a rien commencé.
  app.post('/api/opener/routes/:id/unpublish', authenticateToken, async (req, res) => {
    if (!(await guard(req, res, PERM_ROUTES))) return;
    const id = parseInt(req.params.id, 10) || 0;
    try {
      const cur = (await pool.query(`SELECT name, status FROM opener_routes WHERE id = $1`, [id])).rows[0];
      if (!cur) return res.status(404).json({ error: 'not_found' });
      if (cur.status !== 'published') return res.status(409).json({ error: 'not_published' });
      const started = (await pool.query(
        `SELECT 1 FROM opener_route_stops s WHERE s.route_id = $1 AND (s.outcome <> 'planned'
            OR EXISTS (SELECT 1 FROM opener_checkins c WHERE c.route_stop_id = s.id)) LIMIT 1`, [id])).rows.length > 0;
      if (started) return res.status(409).json({ error: 'route_started' });
      await pool.query(`UPDATE opener_routes SET status = 'draft', published_at = NULL, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
      log('opener_route', id, 'unpublished', `${cur.name} — remise en brouillon`, actorOf(req));
      res.json({ route: await loadRoute(id) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ==========================================================================
  // LOT 3 — Terrain (opener)
  // ==========================================================================
  async function myRoute(req, date) {
    const r = (await pool.query(
      `SELECT id FROM opener_routes WHERE LOWER(opener_email) = $1 AND route_date = $2 AND status IN ('published','closed')
        ORDER BY id DESC LIMIT 1`, [me(req), date])).rows[0];
    return r ? loadRoute(r.id) : null;
  }
  async function myStop(req, stopId) {
    return (await pool.query(
      `SELECT s.*, r.name AS route_name, r.route_date::text AS route_date, r.status AS route_status
         FROM opener_route_stops s JOIN opener_routes r ON r.id = s.route_id
        WHERE s.id = $1 AND LOWER(r.opener_email) = $2`, [stopId, me(req)])).rows[0] || null;
  }

  app.get('/api/opener/today', authenticateToken, async (req, res) => {
    if (!(await guard(req, res, PERM_FIELD))) return;
    try {
      const date = DATE_RE.test(String(req.query.date || '')) ? req.query.date : ymdMtl();
      res.json({ date, route: await myRoute(req, date) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Fiche d'un restaurant : Google (lu à la demande) + Cluster + historique des visites.
  app.get('/api/opener/place/:placeId', authenticateToken, async (req, res) => {
    if (!(await guardAny(req, res, [PERM_FIELD, PERM_ROUTES]))) return;
    const pid = String(req.params.placeId || '');
    if (!PLACE_RE.test(pid)) return res.status(404).json({ error: 'not_found' });
    const lang = String(req.query.lang || 'fr') === 'en' ? 'en' : 'fr';
    try {
      let g = null, googleError = null;
      if (google.configured()) {
        try { g = await cached(`detail:${lang}:${pid}`, () => google.detailsFull(pid, lang)); }
        catch (e) { googleError = e.message; }
      }
      const st = (await statusOf([pid])).get(pid);
      const history = (await pool.query(
        `SELECT c.id, c.at, ${V_LAT} AS lat, ${V_DIST} AS distance_m, ${V_ACC} AS accuracy_m, ${DUR_MIN} AS duration_min,
                COALESCE(c.user_name, c.user_email) AS by, c.current_pos, c.service_type, c.terminals,
                c.decision_maker, c.interest_level, c.services, c.notes, c.satisfaction, c.payments_by, ld.ref_code
           FROM opener_checkins c LEFT JOIN leads ld ON ld.id = c.lead_id
          WHERE c.place_id = $1 ORDER BY c.at DESC LIMIT 15`, [pid])).rows;
      res.json({
        placeId: pid,
        google: g ? {
          name: g.displayName?.text || null, address: g.formattedAddress || null,
          lat: g.location?.latitude ?? null, lng: g.location?.longitude ?? null,
          rating: g.rating ?? null, reviews: g.userRatingCount ?? null, priceLevel: g.priceLevel || null,
          category: g.primaryTypeDisplayName?.text || null, phone: g.nationalPhoneNumber || null,
          website: g.websiteUri || null, mapsUrl: g.googleMapsUri || null,
          openNow: g.currentOpeningHours?.openNow ?? null,
          hours: g.regularOpeningHours?.weekdayDescriptions || g.currentOpeningHours?.weekdayDescriptions || [],
          serviceType: M.serviceTypeOf(g), businessStatus: g.businessStatus || null,
          // Pour préremplir la piste : ville, province (QC), code postal.
          city: comp(g, 'locality') || comp(g, 'sublocality') || null,
          province: comp(g, 'administrative_area_level_1', true) || null,
          postalCode: comp(g, 'postal_code') || null,
        } : null,
        googleError,
        cluster: st || { status: 'new', visits: 0 },
        history: history.map((h) => ({
          id: h.id, at: h.at, by: h.by, distanceM: h.distance_m, durationMin: h.duration_min, verdict: verdict(h.distance_m, h.accuracy_m, h.lat), currentPos: h.current_pos, serviceType: h.service_type, terminals: h.terminals,
          decisionMaker: h.decision_maker, interest: h.interest_level, services: h.services || [], notes: h.notes, leadRef: h.ref_code,
          satisfaction: h.satisfaction ?? null, paymentsBy: h.payments_by || null,
        })),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  function parseCheckin(b) {
    if (!UUID_RE.test(String(b.id || ''))) return { error: 'invalid_id' };
    if (!PLACE_RE.test(String(b.placeId || ''))) return { error: 'invalid_place' };
    const currentPos = clean(b.currentPos, 40);
    if (!currentPos) return { error: 'current_pos_required' };
    if (!['tables', 'quick', 'both'].includes(b.serviceType)) return { error: 'service_type_required' };
    const interest = parseInt(b.interest, 10);
    if (!(interest >= 1 && interest <= 5)) return { error: 'interest_required' };
    // Heure du TÉLÉPHONE (un check-in hors ligne part plus tard), bornée : pas dans le futur,
    // pas plus de 7 jours en arrière.
    let at = new Date(b.at || Date.now());
    if (isNaN(at.getTime()) || at.getTime() > Date.now() + 10 * 60000 || at.getTime() < Date.now() - 7 * 86400000) at = new Date();
    const terminals = num(b.terminals);
    return { value: {
      id: String(b.id).toLowerCase(), placeId: b.placeId, stopId: parseInt(b.stopId, 10) || null, at,
      lat: num(b.lat), lng: num(b.lng), accuracy: num(b.accuracy) != null ? Math.round(num(b.accuracy)) : null,
      currentPos, serviceType: b.serviceType,
      terminals: terminals == null ? null : Math.max(0, Math.min(20, Math.round(terminals))),
      onlineDelivery: typeof b.onlineDelivery === 'boolean' ? b.onlineDelivery : null,
      decisionMaker: ['yes', 'no', 'later'].includes(b.decisionMaker) ? b.decisionMaker : null,
      interest, services: Array.isArray(b.services) ? [...new Set(b.services.filter((s) => SERVICES.includes(s)))] : [],
      notes: clean(b.notes, 2000),
      satisfaction: (() => { const v = parseInt(b.satisfaction, 10); return v >= 1 && v <= 5 ? v : null; })(),
      paymentsBy: ['cluster', 'other', 'unknown'].includes(b.paymentsBy) ? b.paymentsBy : null,
      // Arrivée : retenue seulement si elle précède le départ de moins de 12 h.
      startedAt: (() => {
        const s = new Date(b.startedAt || '');
        if (isNaN(s.getTime()) || s.getTime() > at.getTime() || at.getTime() - s.getTime() > 12 * 3600000) return null;
        return s;
      })(),
      startLat: num(b.startLat), startLng: num(b.startLng),
      startAccuracy: num(b.startAccuracy) != null ? Math.round(num(b.startAccuracy)) : null,
    } };
  }

  // Check-in : idempotent par l'identifiant généré sur le téléphone (la file d'envoi hors ligne
  // peut le renvoyer plusieurs fois).
  app.post('/api/opener/checkins', authenticateToken, async (req, res) => {
    if (!(await guard(req, res, PERM_FIELD))) return;
    const p = parseCheckin(req.body || {});
    if (p.error) return res.status(400).json(p);
    const c = p.value;
    try {
      const existing = (await pool.query(`SELECT id, user_email, distance_m FROM opener_checkins WHERE id = $1`, [c.id])).rows[0];
      if (existing) {
        if (existing.user_email.toLowerCase() !== me(req)) return res.status(409).json({ error: 'id_taken' });
        return res.json({ checkin: { id: existing.id }, distanceM: existing.distance_m, duplicate: true });
      }
      let stop = null;
      if (c.stopId) {
        stop = await myStop(req, c.stopId);
        if (!stop || stop.place_id !== c.placeId) return res.status(400).json({ error: 'invalid_stop' });
      }
      const place = (await pool.query(`SELECT lat, lng FROM opener_places WHERE place_id = $1`, [c.placeId])).rows[0];
      const ref = place?.lat != null ? [place.lat, place.lng] : stop?.lat != null ? [stop.lat, stop.lng] : null;
      const distance = c.lat != null && c.lng != null && ref ? Math.round(G.haversine([c.lat, c.lng], ref)) : null;
      const hasStart = c.startedAt && c.startLat != null && c.startLng != null;
      const startDistance = hasStart && ref ? Math.round(G.haversine([c.startLat, c.startLng], ref)) : null;
      await pool.query(
        `INSERT INTO opener_checkins (id, place_id, route_stop_id, user_email, user_name, at, lat, lng, accuracy_m, distance_m,
                current_pos, service_type, terminals, online_delivery, decision_maker, interest_level, services, notes,
                started_at, start_lat, start_lng, start_accuracy_m, start_distance_m, satisfaction, payments_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19,$20,$21,$22,$23,$24,$25)
         ON CONFLICT (id) DO NOTHING`,
        [c.id, c.placeId, stop?.id || null, me(req), (await userName(me(req))) || req.user?.name || null, c.at.toISOString(),
         c.lat, c.lng, c.accuracy, distance, c.currentPos, c.serviceType, c.terminals, c.onlineDelivery, c.decisionMaker,
         c.interest, JSON.stringify(c.services), c.notes,
         c.startedAt ? c.startedAt.toISOString() : null, hasStart ? c.startLat : null, hasStart ? c.startLng : null,
         hasStart ? c.startAccuracy : null, startDistance, c.satisfaction, c.paymentsBy]);
      if (!place) await upsertPlaces([{ placeId: c.placeId, lat: stop?.lat, lng: stop?.lng }], 'checkin');
      if (stop) {
        await pool.query(`UPDATE opener_route_stops SET outcome = 'done', skip_reason = NULL, done_at = $2 WHERE id = $1`,
          [stop.id, c.at.toISOString()]);
      }
      res.json({ checkin: { id: c.id }, distanceM: hasStart ? startDistance : distance,
        durationMin: c.startedAt ? Math.round((c.at - c.startedAt) / 60000) : null, duplicate: false });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Piste créée depuis le terrain : le même chemin que la saisie interne (file de révision,
  // doublons Zoho, attribution), source « walk_in ». Idempotente par `clientRef`.
  app.post('/api/opener/leads', authenticateToken, async (req, res) => {
    if (!(await guard(req, res, PERM_FIELD))) return;
    const b = req.body || {};
    const clientRef = String(b.clientRef || '').toLowerCase();
    if (!UUID_RE.test(clientRef)) return res.status(400).json({ error: 'invalid_client_ref' });
    if (!PLACE_RE.test(String(b.placeId || ''))) return res.status(400).json({ error: 'invalid_place' });
    const L = late();
    if (!L.normalizeLeadInput || !L.createLeadRow) return res.status(503).json({ error: 'leads_unavailable' });
    try {
      const prior = (await pool.query(`SELECT id, ref_code FROM leads WHERE raw->>'clientRef' = $1`, [clientRef])).rows[0];
      if (prior) return res.json({ id: prior.id, refCode: prior.ref_code, duplicate: true });

      let stop = null;
      if (b.stopId) {
        stop = await myStop(req, parseInt(b.stopId, 10) || 0);
        if (!stop || stop.place_id !== b.placeId) return res.status(400).json({ error: 'invalid_stop' });
      }
      const interest = Array.isArray(b.interest) ? b.interest.filter((s) => SERVICES.includes(s)) : [];
      const street = clean(b.address, 300);
      const notes = [street ? `Adresse : ${street}` : null, clean(b.notes, 6000)].filter(Boolean).join('\n\n') || null;
      const input = L.normalizeLeadInput({
        businessName: b.businessName, businessType: b.businessType, website: b.website,
        firstName: b.firstName, lastName: b.lastName, title: b.title, email: b.email, phone: b.phone,
        city: b.city, province: b.province, postalCode: b.postalCode, language: b.language,
        interest, locationsCount: b.locationsCount, currentPos: b.currentPos, timeline: b.timeline, notes,
      }, { source: 'walk_in' });
      if (!input.businessName) return res.status(400).json({ error: 'businessName is required' });
      input.source = 'walk_in';
      input.sourceDetail = stop ? `Opener · ${stop.route_name} · ${stop.route_date}`.slice(0, 160) : 'Opener · porte-à-porte';
      const checkinId = UUID_RE.test(String(b.checkinId || '')) ? String(b.checkinId).toLowerCase() : null;
      const out = await L.createLeadRow(input, {
        createdBy: actorOf(req),
        raw: { via: 'opener', clientRef, placeId: b.placeId, stopId: stop?.id || null, checkinId },
      });
      await upsertPlaces([{ placeId: b.placeId, lat: stop?.lat, lng: stop?.lng }], 'lead');
      await pool.query(`UPDATE opener_places SET lead_id = $2 WHERE place_id = $1`, [b.placeId, out.id]);
      if (checkinId) await pool.query(`UPDATE opener_checkins SET lead_id = $2 WHERE id = $1 AND LOWER(user_email) = $3`, [checkinId, out.id, me(req)]);
      if (stop && stop.outcome === 'planned') {
        await pool.query(`UPDATE opener_route_stops SET outcome = 'done', done_at = CURRENT_TIMESTAMP WHERE id = $1`, [stop.id]);
      }
      res.json({ id: out.id, refCode: out.refCode, duplicate: false });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/opener/my-leads', authenticateToken, async (req, res) => {
    if (!(await guard(req, res, PERM_FIELD))) return;
    try {
      const { rows } = await pool.query(
        `SELECT ld.id, ld.ref_code, ld.business_name, ld.status, ld.interest, ld.created_at, ld.raw->>'placeId' AS place_id,
                (SELECT c.interest_level FROM opener_checkins c WHERE c.lead_id = ld.id ORDER BY c.at DESC LIMIT 1) AS level
           FROM leads ld
          WHERE ld.raw->>'via' = 'opener' AND LOWER(ld.created_by) = $1
          ORDER BY ld.created_at DESC LIMIT 100`, [me(req)]);
      res.json({ leads: rows.map((r) => ({ id: r.id, refCode: r.ref_code, businessName: r.business_name, status: r.status,
        interest: Array.isArray(r.interest) ? r.interest : [], level: r.level, createdAt: r.created_at, placeId: r.place_id })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/opener/stops/:id/skip', authenticateToken, async (req, res) => {
    if (!(await guard(req, res, PERM_FIELD))) return;
    const reason = String(req.body?.reason || '');
    if (!SKIP_REASONS.includes(reason)) return res.status(400).json({ error: 'invalid_reason' });
    try {
      const stop = await myStop(req, parseInt(req.params.id, 10) || 0);
      if (!stop) return res.status(404).json({ error: 'not_found' });
      if (stop.outcome === 'done') return res.status(409).json({ error: 'already_done' });
      await pool.query(`UPDATE opener_route_stops SET outcome = 'skipped', skip_reason = $2, done_at = CURRENT_TIMESTAMP WHERE id = $1`, [stop.id, reason]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/opener/stops/:id/unskip', authenticateToken, async (req, res) => {
    if (!(await guard(req, res, PERM_FIELD))) return;
    try {
      const stop = await myStop(req, parseInt(req.params.id, 10) || 0);
      if (!stop) return res.status(404).json({ error: 'not_found' });
      if (stop.outcome !== 'skipped') return res.status(409).json({ error: 'not_skipped' });
      await pool.query(`UPDATE opener_route_stops SET outcome = 'planned', skip_reason = NULL, done_at = NULL WHERE id = $1`, [stop.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ==========================================================================
  // LOT 4 — Journée
  // ==========================================================================
  app.get('/api/opener/day', authenticateToken, async (req, res) => {
    if (!(await guard(req, res, PERM_FIELD))) return;
    try {
      const date = DATE_RE.test(String(req.query.date || '')) ? req.query.date : ymdMtl();
      const route = await myRoute(req, date);
      // Les check-ins de la JOURNÉE (heure de Montréal), route ou pas.
      const checkins = (await pool.query(
        `SELECT id, place_id, at, lat, lng, decision_maker, interest_level, lead_id,
                ROUND(EXTRACT(EPOCH FROM (at - started_at)) / 60)::int AS duration_min
           FROM opener_checkins WHERE LOWER(user_email) = $1 AND (at AT TIME ZONE '${TZ}')::date = $2::date ORDER BY at`,
        [me(req), date])).rows;
      const leads = (await pool.query(
        `SELECT ld.id, ld.ref_code, ld.business_name, ld.status, ld.interest,
                (SELECT c.interest_level FROM opener_checkins c WHERE c.lead_id = ld.id ORDER BY c.at DESC LIMIT 1) AS level
           FROM leads ld WHERE ld.raw->>'via' = 'opener' AND LOWER(ld.created_by) = $1
            AND (ld.created_at AT TIME ZONE 'UTC' AT TIME ZONE '${TZ}')::date = $2::date
          ORDER BY ld.created_at`, [me(req), date])).rows;
      const pts = checkins.filter((c) => c.lat != null).map((c) => [c.lat, c.lng]);
      const first = checkins[0]?.at ? new Date(checkins[0].at) : null;
      const last = checkins.length ? new Date(checkins[checkins.length - 1].at) : null;
      const stops = route?.stops || [];
      res.json({
        date, route: route ? { id: route.id, name: route.name, status: route.status } : null,
        stats: {
          stops: stops.length,
          done: stops.filter((s) => s.outcome === 'done').length,
          skipped: stops.filter((s) => s.outcome === 'skipped').length,
          checkins: checkins.length,
          leads: leads.length,
          decisionMakers: checkins.filter((c) => c.decision_maker === 'yes').length,
          distanceM: Math.round(G.pathLength(pts)),
          durationMin: first && last ? Math.round((last - first) / 60000) : 0,
          // Temps passé DANS les restaurants (arrivée → départ), et la durée moyenne d'une visite.
          visitMinutes: checkins.reduce((a, c) => a + (c.duration_min > 0 ? c.duration_min : 0), 0),
          avgVisitMin: (() => {
            const d = checkins.map((c) => c.duration_min).filter((x) => x > 0);
            return d.length ? Math.round(d.reduce((a, x) => a + x, 0) / d.length) : null;
          })(),
        },
        leads: leads.map((l) => ({ id: l.id, refCode: l.ref_code, businessName: l.business_name, status: l.status,
          interest: Array.isArray(l.interest) ? l.interest : [], level: l.level })),
        notVisited: stops.filter((s) => s.outcome !== 'done').map((s) => ({
          id: s.id, name: s.name, status: s.status, outcome: s.outcome, skipReason: s.skipReason })),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // « Reporter à demain » : les arrêts non visités passent sur la route du lendemain du même
  // opener (créée, publiée, si elle n'existe pas). Ils restent « reportés » sur la route du jour.
  app.post('/api/opener/routes/:id/postpone', authenticateToken, async (req, res) => {
    if (!(await guard(req, res, PERM_FIELD))) return;
    const id = parseInt(req.params.id, 10) || 0;
    try {
      const r = (await pool.query(
        `SELECT ${ROUTE_COLS} FROM opener_routes r WHERE r.id = $1 AND LOWER(r.opener_email) = $2`, [id, me(req)])).rows[0];
      if (!r) return res.status(404).json({ error: 'not_found' });
      const left = (await pool.query(
        `SELECT * FROM opener_route_stops WHERE route_id = $1 AND outcome <> 'done' ORDER BY position`, [id])).rows;
      if (!left.length) return res.json({ moved: 0 });
      const next = addDays(r.route_date, 1);
      let target = (await pool.query(
        `SELECT id FROM opener_routes WHERE LOWER(opener_email) = $1 AND route_date = $2 AND status <> 'closed' ORDER BY (status = 'published') DESC, id LIMIT 1`,
        [me(req), next])).rows[0]?.id;
      if (!target) {
        target = (await pool.query(
          `INSERT INTO opener_routes (name, route_date, opener_email, status, zone, created_by, updated_by, published_at, published_by)
           VALUES ($1, $2, $3, 'published', $4::jsonb, $5, $5, CURRENT_TIMESTAMP, $5) RETURNING id`,
          [`${r.name} (suite)`.slice(0, 160), next, r.opener_email, r.zone ? JSON.stringify(r.zone) : null, actorOf(req)])).rows[0].id;
      }
      const maxPos = (await pool.query(`SELECT COALESCE(MAX(position), 0)::int AS m FROM opener_route_stops WHERE route_id = $1`, [target])).rows[0].m;
      let moved = 0;
      for (const [i, s] of left.entries()) {
        const ins = await pool.query(
          `INSERT INTO opener_route_stops (route_id, place_id, position, label, address, lat, lng) VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (route_id, place_id) DO NOTHING`, [target, s.place_id, maxPos + i + 1, s.label, s.address, s.lat, s.lng]);
        moved += ins.rowCount || 0;
        await pool.query(`UPDATE opener_route_stops SET outcome = 'skipped', skip_reason = COALESCE(skip_reason, 'postponed') WHERE id = $1`, [s.id]);
      }
      log('opener_route', id, 'postponed', `${r.name} — ${moved} arrêt(s) reporté(s) au ${next}`, actorOf(req), { metadata: { target } });
      res.json({ moved, routeId: target, date: next });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/opener/routes/:id/close', authenticateToken, async (req, res) => {
    if (!(await guard(req, res, PERM_FIELD))) return;
    const id = parseInt(req.params.id, 10) || 0;
    try {
      const r = await pool.query(
        `UPDATE opener_routes SET status = 'closed', closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND LOWER(opener_email) = $2 AND status = 'published' RETURNING name`, [id, me(req)]);
      if (!r.rows.length) return res.status(409).json({ error: 'not_open' });
      log('opener_route', id, 'closed', `${r.rows[0].name} — journée terminée`, actorOf(req));
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Outils partagés avec la campagne (campaignRoutes.js).
  return { scanZone, statusOf, ymdMtl, upsertPlaces, scanBudget, userName, displayName, cached, loadRoute, schema, google, frontend, can };
}

module.exports = { registerOpenerFieldRoutes, PERM_FIELD, PERM_ROUTES, SERVICES, SKIP_REASONS, ymdMtl, addDays, verdict };
