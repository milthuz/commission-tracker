// ============================================================================
// Campagne de couverture du territoire (Montréal, Laval, Rive-Nord, Rive-Sud).
//
// Demande de David (2026-10-07) : « faire la ville de Montréal au complet dans les prochaines
// semaines ainsi que la Rive-Nord et la Rive-Sud » ; « les routes devraient déjà apparaître ».
//
//   1. INVENTAIRE — le territoire est quadrillé de cercles de 1 km, balayés en arrière-plan
//      (Nearby Search, masque léger) : quelques centaines par nuit. Un cercle plein est découpé.
//      On garde par établissement : place_id, coordonnées (30 jours, rafraîchies), catégorie,
//      région. Les exclus (« pas un restaurant ») ne reviennent jamais.
//   2. DÉCOUPAGE — campaign.planCampaign : routes d'une journée (5 h), compactes, sans
//      chevauchement, à pied en ville et en voiture en banlieue, numérotées de proche en proche.
//      Les CLIENTS ACTIFS de Cluster sont inclus, quelle que soit leur catégorie Google : l'opener
//      vérifie qu'ils sont satisfaits et propose les paiements (décision de David, 2026-10-08).
//      Exclus du découpage : restaurants visités depuis moins de 90 jours, exclus « pas un
//      restaurant », ceux d'une route encore planifiée. Ceux d'une route faite qui n'ont PAS été
//      visités (fermé, manque de temps, journée pas finie) reviennent dans une nouvelle route ;
//      un refus d'entrer est écarté 90 jours, comme une visite.
//   3. PLANIFICATION — « Planifier la semaine » : chaque opener coché reçoit 5 routes voisines
//      du lundi au vendredi, publiées, et UN courriel récapitulatif.
//
// Permission : opener:routes.
// ============================================================================

const G = require('./geo');
const T = require('./territory');
const C = require('./campaign');
const E = require('./emails');

const PERM = 'opener:routes';
const SCAN_TYPES = ['restaurant', 'cafe', 'bar', 'bakery', 'meal_takeaway'];
const TARGET_KINDS = ['restaurant', 'takeout', 'cafe', 'bar', 'bakery'];
// Masque léger : l'inventaire n'a besoin que de la position et du type (tranche « Pro »).
const INVENTORY_FIELDS = ['places.id', 'places.location', 'places.primaryType', 'places.businessStatus'];
const START_RADIUS = 1000;
const MIN_RADIUS = 150;
const MANUAL_CALLS = 300;
const NIGHTLY_CALLS = 1200;
const REFRESH_DAYS = 30;          // coordonnées : 30 jours au plus (conditions Google)
const RECENT_VISIT_DAYS = 90;     // un restaurant visité depuis moins de 90 jours n'est pas re-proposé
const LOCK_KEY = 'opener_inventory_lock';
const LOCK_STALE_MIN = 5;
// Rythme : Google refuse au-delà d'environ 600 recherches Nearby PAR MINUTE (quota par défaut).
// Le premier passage en prod (2026-10-07) en a lancé 624 en 41 s et s'est arrêté net. On reste
// sous 400/min ; un refus de quota attend une minute puis reprend le même cercle (3 fois au plus
// d'affilée — au-delà, c'est un vrai plafond, quotidien ou de facturation).
const PACE_MS = 150;
const QUOTA_WAIT_MS = 65 * 1000;
const QUOTA_RETRIES = 3;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS opener_inventory_cells (
    id         SERIAL PRIMARY KEY,
    region     VARCHAR(20) NOT NULL,
    lat        DOUBLE PRECISION NOT NULL,
    lng        DOUBLE PRECISION NOT NULL,
    radius     INTEGER NOT NULL,
    depth      SMALLINT NOT NULL DEFAULT 0,
    status     VARCHAR(8) NOT NULL DEFAULT 'pending',
    found      INTEGER,
    done_at    TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (region, lat, lng, radius)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_opener_cells_status ON opener_inventory_cells (status, region)`,
  `CREATE TABLE IF NOT EXISTS opener_campaign_routes (
    id           SERIAL PRIMARY KEY,
    seq          INTEGER NOT NULL,
    region       VARCHAR(20) NOT NULL,
    mode         VARCHAR(5) NOT NULL,
    place_ids    JSONB NOT NULL,
    n            INTEGER NOT NULL,
    minutes      INTEGER NOT NULL,
    meters       INTEGER NOT NULL,
    hull         JSONB,
    centroid_lat DOUBLE PRECISION,
    centroid_lng DOUBLE PRECISION,
    status       VARCHAR(10) NOT NULL DEFAULT 'todo',
    route_id     INTEGER,
    computed_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_opener_campaign_status ON opener_campaign_routes (status, seq)`,
];

const r6 = (v) => Math.round(v * 1e6) / 1e6;
const addDays = (ymd, n) => { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isWeekday = (ymd) => { const w = new Date(`${ymd}T12:00:00Z`).getUTCDay(); return w !== 0 && w !== 6; };
const fmtDay = (ymd, lang) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString(lang === 'en' ? 'en-CA' : 'fr-CA', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
const regionLabel = (key, lang = 'fr') => (T.REGIONS.find((r) => r.key === key) || {})[lang] || key;

function registerOpenerCampaignRoutes(app, deps) {
  const { authenticateToken, requirePerm, pool, logActivity, field } = deps;
  const google = deps.google || field.google;
  const sleep = deps.sleep || ((ms) => new Promise((res) => setTimeout(res, ms)));
  const paceMs = deps.paceMs ?? PACE_MS;
  const late = () => (deps.late ? deps.late() : {});
  const actorOf = (req) => req.user?.realAdminEmail || req.user?.email || 'unknown';
  const log = (id, event, desc, actor, extra) =>
    Promise.resolve(logActivity && logActivity('opener_campaign', id, event, desc, actor, extra)).catch(() => {});

  let ready = null;
  const schema = () => (ready = ready || (async () => {
    await field.schema();
    for (const sql of SCHEMA) await pool.query(sql);
  })().catch((e) => { ready = null; throw e; }));
  if (pool) schema().catch((e) => console.error('opener campaign schema:', e.message));

  async function putState(key, obj) {
    await pool.query(
      `INSERT INTO sync_state (key, value, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP`, [key, JSON.stringify(obj)]);
  }
  async function getState(key) {
    const v = (await pool.query(`SELECT value FROM sync_state WHERE key = $1`, [key])).rows[0]?.value;
    try { return v ? JSON.parse(v) : null; } catch { return null; }
  }

  // ------------------------------------------------------------------ verrou de l'inventaire
  async function takeLock() {
    const r = await pool.query(
      `INSERT INTO sync_state (key, value, updated_at) VALUES ($1, 'running', CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE SET value = 'running', updated_at = CURRENT_TIMESTAMP
        WHERE sync_state.value <> 'running' OR sync_state.updated_at < CURRENT_TIMESTAMP - INTERVAL '${LOCK_STALE_MIN} minutes'
       RETURNING key`, [LOCK_KEY]);
    return r.rows.length > 0;
  }
  const isRunning = async () => (await pool.query(
    `SELECT 1 FROM sync_state WHERE key = $1 AND value = 'running' AND updated_at >= CURRENT_TIMESTAMP - INTERVAL '${LOCK_STALE_MIN} minutes'`,
    [LOCK_KEY])).rows.length > 0;
  const touchLock = () => pool.query(`UPDATE sync_state SET updated_at = CURRENT_TIMESTAMP WHERE key = $1 AND value = 'running'`, [LOCK_KEY]).catch(() => {});
  const releaseLock = () => pool.query(`UPDATE sync_state SET value = 'idle', updated_at = CURRENT_TIMESTAMP WHERE key = $1`, [LOCK_KEY]).catch(() => {});

  // ==========================================================================
  // 1. Inventaire
  // ==========================================================================
  async function insertCells(region, circles, depth) {
    for (let i = 0; i < circles.length; i += 200) {
      const part = circles.slice(i, i + 200);
      const vals = [];
      const rows = part.map((c, j) => {
        vals.push(region, r6(c.center[0]), r6(c.center[1]), Math.round(c.radius), depth);
        const b = j * 5;
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5})`;
      });
      await pool.query(
        `INSERT INTO opener_inventory_cells (region, lat, lng, radius, depth) VALUES ${rows.join(',')}
         ON CONFLICT (region, lat, lng, radius) DO NOTHING`, vals);
    }
  }

  async function seedCells() {
    for (const reg of T.REGIONS) {
      const n = (await pool.query(`SELECT COUNT(*)::int AS n FROM opener_inventory_cells WHERE region = $1`, [reg.key])).rows[0].n;
      if (!n) await insertCells(reg.key, G.coverCircles(reg.polygon, START_RADIUS), 0);
    }
    // Coordonnées à rafraîchir au plus tous les 30 jours : un cercle balayé il y a plus d'un mois
    // est remis en file.
    await pool.query(
      `UPDATE opener_inventory_cells SET status = 'pending' WHERE status = 'done' AND done_at < CURRENT_TIMESTAMP - INTERVAL '${REFRESH_DAYS} days'`);
  }

  async function savePlaces(list) {
    for (let i = 0; i < list.length; i += 200) {
      const part = list.slice(i, i + 200);
      const vals = [];
      const rows = part.map((p, j) => {
        vals.push(p.id, p.lat, p.lng, p.kind, p.region);
        const b = j * 5;
        return `($${b + 1}, $${b + 2}::float8, $${b + 3}::float8, CURRENT_TIMESTAMP, 'inventory', CURRENT_TIMESTAMP, $${b + 4}, $${b + 5})`;
      });
      await pool.query(
        `INSERT INTO opener_places (place_id, lat, lng, coords_refreshed_at, source, last_seen_in_scan, kind, region)
         VALUES ${rows.join(',')}
         ON CONFLICT (place_id) DO UPDATE SET lat = EXCLUDED.lat, lng = EXCLUDED.lng,
           coords_refreshed_at = CURRENT_TIMESTAMP, last_seen_in_scan = CURRENT_TIMESTAMP,
           kind = EXCLUDED.kind, region = EXCLUDED.region`, vals);
    }
  }

  let progLast = 0;
  async function progress(done, total, extra = {}) {
    if (Date.now() - progLast < 1500 && done !== total) return;
    progLast = Date.now();
    await putState('opener_inventory_progress', { done, total, ...extra, at: new Date().toISOString() }).catch(() => {});
    await touchLock();
  }

  async function runInventory({ budget = MANUAL_CALLS, source = 'manual' } = {}) {
    await schema();
    if (!google.configured()) return { skipped: 'GOOGLE_PLACES_API_KEY absente' };
    if (!(await takeLock())) return null;
    const out = { at: new Date().toISOString(), source, calls: 0, cells: 0, places: 0, split: 0 };
    let unbilled = 0;
    try {
      await seedCells();
      const left = (await field.scanBudget(0)).left;
      const maxCalls = Math.max(0, Math.min(budget, left));
      if (!maxCalls) { out.stopped = 'budget mensuel Google épuisé'; return out; }
      let streak = 0, quotaStreak = 0, lastCall = 0;
      out.quotaPauses = 0;
      while (out.calls < maxCalls && !out.stopped) {
        const cells = (await pool.query(
          `SELECT * FROM opener_inventory_cells WHERE status = 'pending'
            ORDER BY CASE region WHEN 'montreal' THEN 0 WHEN 'laval' THEN 1 WHEN 'rive-sud' THEN 2 ELSE 3 END, depth DESC, id
            LIMIT 25`)).rows;
        if (!cells.length) break;
        for (const c of cells) {
          if (out.calls >= maxCalls) break;
          let places;
          try {
            const wait = lastCall + paceMs - Date.now();
            if (wait > 0) await sleep(wait);
            lastCall = Date.now();
            places = await google.searchNearby([c.lat, c.lng], c.radius, SCAN_TYPES, { fields: INVENTORY_FIELDS });
            out.calls++; unbilled++; streak = 0; quotaStreak = 0;
          } catch (e) {
            if (e.quota) {
              if (++quotaStreak > QUOTA_RETRIES) { out.stopped = 'quota Google atteint'; break; }
              out.quotaPauses++;
              await touchLock();
              await sleep(QUOTA_WAIT_MS);
              await touchLock();
              break; // relit la file : le même cercle (toujours en attente) repasse en premier
            }
            out.lastError = e.message;
            if (++streak >= 5) { out.stopped = `erreurs Google : ${e.message}`; break; }
            continue;
          }
          const keep = [];
          for (const p of places) {
            const lat = p.location?.latitude, lng = p.location?.longitude;
            if (lat == null || lng == null || p.businessStatus === 'CLOSED_PERMANENTLY') continue;
            const region = T.regionOf(lat, lng);
            if (!region) continue;
            keep.push({ id: p.id, lat, lng, region, kind: T.kindOf(p.primaryType) });
          }
          await savePlaces(keep);
          out.places += keep.length;
          // Cercle plein (Google plafonne à 20) : découpé en 4, les sous-cercles passent en file.
          if (places.length >= 20 && c.radius > MIN_RADIUS) {
            const reg = T.REGIONS.find((r) => r.key === c.region);
            const kids = G.splitCircle({ center: [c.lat, c.lng], radius: c.radius })
              .filter((k) => !reg || G.circleTouchesPolygon(k.center, k.radius, reg.polygon));
            await insertCells(c.region, kids, c.depth + 1);
            out.split++;
          }
          await pool.query(`UPDATE opener_inventory_cells SET status = 'done', found = $2, done_at = CURRENT_TIMESTAMP WHERE id = $1`, [c.id, places.length]);
          out.cells++;
          // Le budget mensuel est tenu au fil de l'eau : un passage tué n'efface pas ses appels.
          if (unbilled >= 25) { await field.scanBudget(unbilled); unbilled = 0; }
          await progress(out.calls, maxCalls, { cells: out.cells, places: out.places });
        }
        if (out.stopped) break;
      }
      return out;
    } finally {
      if (unbilled) await field.scanBudget(unbilled).catch(() => {});
      await putState('opener_inventory_last_run', out).catch(() => {});
      await releaseLock();
    }
  }

  // ==========================================================================
  // 2. Découpage en routes
  // ==========================================================================
  async function syncStatuses() {
    // Planifiée → faite : la route est terminée, plus aucun arrêt n'est à faire, ou sa DATE EST
    // PASSÉE (l'opener n'a pas fermé sa journée : la route ne doit pas bloquer ses restaurants).
    await pool.query(
      `UPDATE opener_campaign_routes cr SET status = 'done'
         FROM opener_routes r
        WHERE cr.route_id = r.id AND cr.status = 'planned'
          AND (r.status = 'closed' OR r.route_date < $1::date
               OR NOT EXISTS (SELECT 1 FROM opener_route_stops s WHERE s.route_id = r.id AND s.outcome = 'planned'))`, [field.ymdMtl()]);
    // La route a été supprimée : la campagne la reprend.
    await pool.query(
      `UPDATE opener_campaign_routes SET status = 'todo', route_id = NULL
        WHERE status = 'planned' AND (route_id IS NULL OR route_id NOT IN (SELECT id FROM opener_routes))`);
  }

  async function recompute({ actor = 'system' } = {}) {
    await schema();
    await syncStatuses();
    // Un client apparié au lot 0 n'a pas forcément été vu par l'inventaire (catégorie Google
    // « magasin », hors des cercles déjà balayés) : sa région se calcule depuis ses coordonnées.
    const { rows: found } = await pool.query(
      `SELECT p.place_id, p.lat, p.lng, p.region,
              EXISTS (SELECT 1 FROM cluster_locations l WHERE l.place_id = p.place_id AND l.active
                        AND l.missing_since IS NULL AND l.match_status <> 'ignored') AS is_client
         FROM opener_places p
        WHERE p.excluded_at IS NULL AND p.lat IS NOT NULL
          AND (p.kind = ANY($1::text[])
               OR EXISTS (SELECT 1 FROM cluster_locations l WHERE l.place_id = p.place_id AND l.active
                            AND l.missing_since IS NULL AND l.match_status <> 'ignored'))
          AND NOT EXISTS (SELECT 1 FROM opener_checkins c WHERE c.place_id = p.place_id
                            AND c.at > CURRENT_TIMESTAMP - INTERVAL '${RECENT_VISIT_DAYS} days')
          -- REDISTRIBUTION (David, 2026-10-08) : un restaurant d'une route FAITE qui n'a pas été
          -- visité (fermé, manque de temps, autre raison, journée pas finie) revient dans une
          -- nouvelle route au prochain recalcul. Restent écartés : les visités et les REFUS
          -- d'entrer (90 jours), les routes encore planifiées, et tout arrêt encore à faire sur une
          -- route publiée à venir (un arrêt « reporté à demain » y est déjà).
          AND NOT EXISTS (SELECT 1 FROM opener_route_stops s JOIN opener_routes r ON r.id = s.route_id
                           WHERE s.place_id = p.place_id
                             AND (s.outcome = 'done' OR s.skip_reason = 'refused')
                             AND COALESCE(s.done_at, r.route_date::timestamp) > CURRENT_TIMESTAMP - INTERVAL '${RECENT_VISIT_DAYS} days')
          AND NOT EXISTS (SELECT 1 FROM opener_route_stops s JOIN opener_routes r ON r.id = s.route_id
                           WHERE s.place_id = p.place_id AND s.outcome = 'planned'
                             AND r.status = 'published' AND r.route_date >= $2::date)
          AND p.place_id NOT IN (SELECT jsonb_array_elements_text(place_ids) FROM opener_campaign_routes WHERE status = 'planned')`,
      [TARGET_KINDS, field.ymdMtl()]);
    const rows = found.map((r) => ({ ...r, region: r.region || (r.is_client ? T.regionOf(r.lat, r.lng) : null) })).filter((r) => r.region);
    const routes = C.planCampaign(rows.map((r) => ({ placeId: r.place_id, lat: r.lat, lng: r.lng, region: r.region })));
    await pool.query(`DELETE FROM opener_campaign_routes WHERE status = 'todo'`);
    for (let i = 0; i < routes.length; i += 100) {
      const part = routes.slice(i, i + 100);
      const vals = [];
      const rowsSql = part.map((r, j) => {
        vals.push(r.seq, r.region, r.mode, JSON.stringify(r.placeIds), r.placeIds.length, r.minutes, r.meters, JSON.stringify(r.hull), r.centroid[0], r.centroid[1]);
        const b = j * 10;
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}::jsonb, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}::jsonb, $${b + 9}, $${b + 10})`;
      });
      await pool.query(
        `INSERT INTO opener_campaign_routes (seq, region, mode, place_ids, n, minutes, meters, hull, centroid_lat, centroid_lng)
         VALUES ${rowsSql.join(',')}`, vals);
    }
    const res = { at: new Date().toISOString(), routes: routes.length, places: rows.length, clients: rows.filter((r) => r.is_client).length,
      walk: routes.filter((r) => r.mode === 'walk').length, car: routes.filter((r) => r.mode === 'car').length };
    await putState('opener_campaign_computed', res);
    log(0, 'recomputed', `Campagne recalculée : ${res.routes} routes pour ${res.places} restaurants`, actor);
    return res;
  }

  // ==========================================================================
  // 3. Affectation : routes de la campagne → routes publiées d'un opener
  // ==========================================================================
  // Nom et adresse de chaque arrêt : lus chez Google au moment d'affecter (et gardés sur la
  // route, comme pour une route faite à la main). Cinq lectures à la fois.
  async function stopDetails(placeIds) {
    const out = new Map();
    const queue = [...placeIds];
    const worker = async () => {
      while (queue.length) {
        const pid = queue.shift();
        try {
          const d = await field.cached(`lite:${pid}`, () => google.details(pid));
          out.set(pid, { name: d?.displayName?.text || null, address: d?.formattedAddress ? d.formattedAddress.split(',').slice(0, 2).join(',') : null });
        } catch { out.set(pid, { name: null, address: null }); }
      }
    };
    await Promise.all(Array.from({ length: 5 }, worker));
    return out;
  }

  async function freeDates(openerEmail, startDate, count) {
    const taken = new Set((await pool.query(
      `SELECT route_date::text AS d FROM opener_routes WHERE LOWER(opener_email) = $1 AND status IN ('published','closed') AND route_date >= $2`,
      [openerEmail.toLowerCase(), startDate])).rows.map((r) => r.d));
    const out = [];
    for (let d = startDate, guard = 0; out.length < count && guard < 400; d = addDays(d, 1), guard++) {
      if (isWeekday(d) && !taken.has(d)) out.push(d);
    }
    return out;
  }

  async function assignRoutes(ids, openerEmail, startDate, actor, { notify = true } = {}) {
    const crs = (await pool.query(
      `SELECT * FROM opener_campaign_routes WHERE id = ANY($1::int[]) AND status = 'todo'`, [ids])).rows;
    const byId = new Map(crs.map((r) => [r.id, r]));
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
    const dates = await freeDates(openerEmail, startDate, ordered.length);
    const days = [];
    for (const [i, cr] of ordered.entries()) {
      const pids = cr.place_ids;
      const det = await stopDetails(pids);
      const pos = new Map((await pool.query(`SELECT place_id, lat, lng FROM opener_places WHERE place_id = ANY($1::text[])`, [pids])).rows.map((r) => [r.place_id, r]));
      const name = `R${cr.seq} · ${regionLabel(cr.region)}${cr.mode === 'car' ? ' (voiture)' : ''}`;
      const route = (await pool.query(
        `INSERT INTO opener_routes (name, route_date, opener_email, status, zone, created_by, updated_by, published_at, published_by)
         VALUES ($1, $2, $3, 'published', $4::jsonb, $5, $5, CURRENT_TIMESTAMP, $5) RETURNING id`,
        [name.slice(0, 160), dates[i], openerEmail, JSON.stringify(cr.hull), actor])).rows[0];
      for (const [k, pid] of pids.entries()) {
        const d = det.get(pid) || {};
        await pool.query(
          `INSERT INTO opener_route_stops (route_id, place_id, position, label, address, lat, lng) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [route.id, pid, k + 1, (d.name || '(sans nom)').slice(0, 255), d.address, pos.get(pid)?.lat ?? null, pos.get(pid)?.lng ?? null]);
      }
      await pool.query(`UPDATE opener_campaign_routes SET status = 'planned', route_id = $2 WHERE id = $1`, [cr.id, route.id]);
      days.push({ date: dates[i], routeId: route.id, campaignRouteId: cr.id, name, stops: pids.length, minutes: cr.minutes, mode: cr.mode });
    }
    if (days.length) {
      log(0, 'assigned', `${days.length} route(s) de campagne → ${openerEmail} (${days[0].date} → ${days[days.length - 1].date})`, actor,
        { metadata: { openerEmail, days } });
    }
    let emailSent = false;
    if (notify && days.length) {
      const L = late();
      if (L.sendMail && L.mailShell) {
        const mail = E.weekPublishedEmail(L.mailShell, {
          openerName: await field.displayName(openerEmail), weekFr: fmtDay(days[0].date, 'fr'), weekEn: fmtDay(days[0].date, 'en'),
          days: days.map((x) => ({ ...x, dateFr: fmtDay(x.date, 'fr'), dateEn: fmtDay(x.date, 'en') })),
          publishedBy: (await field.userName(actor)) || actor, link: `${field.frontend()}/opener`,
        });
        const r = await L.sendMail(openerEmail, mail.subject, mail.html).catch(() => null);
        emailSent = !!r?.sent;
      }
    }
    return { days, emailSent };
  }

  // Choix de la semaine d'un opener : partir de son dernier secteur (sinon du premier numéro),
  // puis enchaîner les routes les plus proches, en restant dans la même région si possible.
  function pickWeek(todo, anchor, count, taken) {
    const dist = (a, b) => Math.hypot((a[0] - b[0]) * 111, (a[1] - b[1]) * 78);
    const free = todo.filter((r) => !taken.has(r.id));
    if (!free.length) return [];
    let first;
    if (anchor) first = free.reduce((b, r) => (dist([r.centroid_lat, r.centroid_lng], anchor) < dist([b.centroid_lat, b.centroid_lng], anchor) ? r : b));
    else first = free.reduce((b, r) => (r.seq < b.seq ? r : b));
    const out = [first];
    taken.add(first.id);
    while (out.length < count) {
      const cur = out[out.length - 1];
      const cand = todo.filter((r) => !taken.has(r.id));
      if (!cand.length) break;
      const score = (r) => dist([r.centroid_lat, r.centroid_lng], [cur.centroid_lat, cur.centroid_lng]) + (r.region === cur.region ? 0 : 50);
      const next = cand.reduce((b, r) => (score(r) < score(b) ? r : b));
      out.push(next);
      taken.add(next.id);
    }
    return out;
  }

  // ==========================================================================
  // HTTP
  // ==========================================================================
  const guard = async (req, res) => {
    if (!(await requirePerm(req, res, PERM))) return false;
    await schema();
    return true;
  };

  app.get('/api/opener/campaign', authenticateToken, async (req, res) => {
    if (!(await guard(req, res))) return;
    try {
      await syncStatuses();
      const cells = (await pool.query(
        `SELECT region, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'done')::int AS done FROM opener_inventory_cells GROUP BY region`)).rows;
      const places = (await pool.query(
        `SELECT p.region, COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM cluster_locations l WHERE l.place_id = p.place_id AND l.active AND l.missing_since IS NULL))::int AS clients,
                COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM opener_checkins c WHERE c.place_id = p.place_id))::int AS visited
           FROM opener_places p WHERE p.region IS NOT NULL AND p.excluded_at IS NULL AND p.kind = ANY($1::text[]) GROUP BY p.region`,
        [TARGET_KINDS])).rows;
      const excluded = (await pool.query(`SELECT COUNT(*)::int AS n FROM opener_places WHERE excluded_at IS NOT NULL`)).rows[0].n;
      const routes = (await pool.query(
        `SELECT cr.id, cr.seq, cr.region, cr.mode, cr.n, cr.minutes, cr.meters, cr.hull, cr.centroid_lat, cr.centroid_lng, cr.status, cr.route_id,
                r.route_date::text AS date, r.opener_email,
                (SELECT COUNT(*)::int FROM opener_route_stops s WHERE s.route_id = r.id AND s.outcome = 'done') AS visited,
                (SELECT COUNT(*)::int FROM jsonb_array_elements_text(cr.place_ids) x(pid)
                  WHERE EXISTS (SELECT 1 FROM cluster_locations l WHERE l.place_id = x.pid AND l.active
                                  AND l.missing_since IS NULL AND l.match_status <> 'ignored')) AS clients
           FROM opener_campaign_routes cr LEFT JOIN opener_routes r ON r.id = cr.route_id
          ORDER BY cr.status <> 'todo', cr.seq`)).rows;
      const names = new Map();
      for (const e of new Set(routes.map((r) => r.opener_email).filter(Boolean))) names.set(e, await field.displayName(e));
      res.json({
        regions: T.REGIONS.map((r) => ({
          key: r.key, fr: r.fr, en: r.en, polygon: r.polygon,
          cells: cells.find((c) => c.region === r.key) || { total: 0, done: 0 },
          places: places.find((p) => p.region === r.key) || { total: 0, clients: 0, visited: 0 },
        })),
        excluded,
        inventory: { running: await isRunning(), progress: (await isRunning()) ? await getState('opener_inventory_progress') : null, last: await getState('opener_inventory_last_run') },
        computed: await getState('opener_campaign_computed'),
        routes: routes.map((r) => ({
          id: r.id, seq: r.seq, region: r.region, mode: r.mode, n: r.n, minutes: r.minutes, meters: r.meters, hull: r.hull,
          centroid: [r.centroid_lat, r.centroid_lng], status: r.status, routeId: r.route_id, date: r.date,
          openerEmail: r.opener_email, openerName: r.opener_email ? names.get(r.opener_email) : null, visited: r.visited || 0,
          clients: r.clients || 0,
        })),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Les arrêts d'une route de campagne (noms lus chez Google, gardés 1 h en mémoire).
  app.get('/api/opener/campaign/routes/:id', authenticateToken, async (req, res) => {
    if (!(await guard(req, res))) return;
    try {
      const cr = (await pool.query(`SELECT * FROM opener_campaign_routes WHERE id = $1`, [parseInt(req.params.id, 10) || 0])).rows[0];
      if (!cr) return res.status(404).json({ error: 'not_found' });
      const pids = cr.place_ids;
      const det = google.configured() ? await stopDetails(pids) : new Map();
      const pos = new Map((await pool.query(`SELECT place_id, lat, lng, kind FROM opener_places WHERE place_id = ANY($1::text[])`, [pids])).rows.map((r) => [r.place_id, r]));
      const st = await field.statusOf(pids);
      res.json({
        id: cr.id, seq: cr.seq, region: cr.region, mode: cr.mode, minutes: cr.minutes, meters: cr.meters, status: cr.status, routeId: cr.route_id,
        stops: pids.map((pid) => ({ placeId: pid, name: det.get(pid)?.name || null, address: det.get(pid)?.address || null,
          lat: pos.get(pid)?.lat ?? null, lng: pos.get(pid)?.lng ?? null, kind: pos.get(pid)?.kind || null, ...(st.get(pid) || { status: 'new' }) })),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/opener/campaign/recompute', authenticateToken, async (req, res) => {
    if (!(await guard(req, res))) return;
    try { res.json(await recompute({ actor: actorOf(req) })); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Poursuivre l'inventaire maintenant (300 cercles), en arrière-plan ; la campagne est recalculée à la fin.
  app.post('/api/opener/campaign/inventory', authenticateToken, async (req, res) => {
    if (!(await guard(req, res))) return;
    if (await isRunning()) return res.status(409).json({ error: 'already_running' });
    res.status(202).json({ started: true });
    runInventory({ budget: MANUAL_CALLS, source: `manual:${actorOf(req)}` })
      .then(async (out) => { if (out && out.places) await recompute({ actor: actorOf(req) }); })
      .catch((e) => console.error('[OPENER] inventaire :', e.message));
  });

  app.post('/api/opener/campaign/assign', authenticateToken, async (req, res) => {
    if (!(await guard(req, res))) return;
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((x) => parseInt(x, 10)).filter((x) => x > 0).slice(0, 25) : [];
    const opener = String(req.body?.openerEmail || '').trim().toLowerCase();
    const start = String(req.body?.startDate || '');
    if (!ids.length) return res.status(400).json({ error: 'ids_required' });
    if (!EMAIL_RE.test(opener)) return res.status(400).json({ error: 'opener_required' });
    if (!DATE_RE.test(start)) return res.status(400).json({ error: 'invalid_date' });
    try { res.json(await assignRoutes(ids, opener, start, actorOf(req))); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // « Planifier la semaine » : 5 routes voisines par opener, du lundi au vendredi.
  app.post('/api/opener/campaign/plan-week', authenticateToken, async (req, res) => {
    if (!(await guard(req, res))) return;
    const openers = Array.isArray(req.body?.openers) ? [...new Set(req.body.openers.map((e) => String(e).trim().toLowerCase()).filter((e) => EMAIL_RE.test(e)))] : [];
    const weekStart = String(req.body?.weekStart || '');
    const days = Math.max(1, Math.min(5, parseInt(req.body?.days, 10) || 5));
    if (!openers.length) return res.status(400).json({ error: 'openers_required' });
    if (!DATE_RE.test(weekStart)) return res.status(400).json({ error: 'invalid_date' });
    // Aperçu (`preview: true`) : les routes proposées à chacun et leurs dates, RIEN n'est publié —
    // David veut voir les routes avant de planifier (2026-10-08). La confirmation renvoie ces
    // choix (`assignments`) pour publier exactement ce qui a été montré, même si le manager a
    // retiré une route de la proposition.
    const preview = req.body?.preview === true;
    const chosen = new Map((Array.isArray(req.body?.assignments) ? req.body.assignments : [])
      .map((a) => [String(a?.openerEmail || '').trim().toLowerCase(), (Array.isArray(a?.ids) ? a.ids : []).map((x) => parseInt(x, 10)).filter((x) => x > 0)]));
    try {
      await syncStatuses();
      const todo = (await pool.query(`SELECT * FROM opener_campaign_routes WHERE status = 'todo' ORDER BY seq`)).rows;
      const taken = new Set();
      const out = [];
      for (const email of openers) {
        let week;
        if (chosen.has(email)) {
          const byId = new Map(todo.map((r) => [r.id, r]));
          week = chosen.get(email).map((id) => byId.get(id)).filter((r) => r && !taken.has(r.id)).slice(0, days);
          week.forEach((r) => taken.add(r.id));
        } else {
          const last = (await pool.query(
            `SELECT cr.centroid_lat, cr.centroid_lng FROM opener_campaign_routes cr JOIN opener_routes r ON r.id = cr.route_id
              WHERE LOWER(r.opener_email) = $1 ORDER BY r.route_date DESC LIMIT 1`, [email])).rows[0];
          week = pickWeek(todo, last ? [last.centroid_lat, last.centroid_lng] : null, days, taken);
        }
        if (preview) {
          const dates = await freeDates(email, weekStart, week.length);
          out.push({ openerEmail: email, openerName: await field.displayName(email),
            days: week.map((w, i) => ({ date: dates[i], campaignRouteId: w.id, seq: w.seq, region: w.region,
              name: `R${w.seq} · ${regionLabel(w.region)}${w.mode === 'car' ? ' (voiture)' : ''}`, stops: w.n, minutes: w.minutes, mode: w.mode })) });
          continue;
        }
        const r = await assignRoutes(week.map((w) => w.id), email, weekStart, actorOf(req));
        out.push({ openerEmail: email, openerName: await field.displayName(email), ...r });
      }
      res.json({ openers: out, left: todo.length - taken.size });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Retirer une route planifiée (tant que rien n'est commencé) : elle revient dans la campagne.
  app.post('/api/opener/campaign/routes/:id/unassign', authenticateToken, async (req, res) => {
    if (!(await guard(req, res))) return;
    try {
      await syncStatuses();
      const cr = (await pool.query(`SELECT * FROM opener_campaign_routes WHERE id = $1`, [parseInt(req.params.id, 10) || 0])).rows[0];
      if (!cr) return res.status(404).json({ error: 'not_found' });
      if (cr.status !== 'planned' || !cr.route_id) return res.status(409).json({ error: 'not_planned' });
      const started = (await pool.query(
        `SELECT 1 FROM opener_route_stops s WHERE s.route_id = $1 AND (s.outcome <> 'planned'
            OR EXISTS (SELECT 1 FROM opener_checkins c WHERE c.route_stop_id = s.id)) LIMIT 1`, [cr.route_id])).rows.length > 0;
      if (started) return res.status(409).json({ error: 'route_started' });
      await pool.query(`DELETE FROM opener_routes WHERE id = $1`, [cr.route_id]);
      await pool.query(`UPDATE opener_campaign_routes SET status = 'todo', route_id = NULL WHERE id = $1`, [cr.id]);
      log(cr.id, 'unassigned', `R${cr.seq} retirée de la planification`, actorOf(req));
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return {
    runInventory, recompute, syncStatuses, pickWeek, assignRoutes,
    // Worker, une fois par nuit : 1 200 cercles d'inventaire, puis la campagne recalculée.
    runNightly: async () => {
      try {
        await schema();
        const last = (await pool.query(
          `SELECT 1 FROM sync_state WHERE key = 'opener_inventory_last_run' AND updated_at > CURRENT_TIMESTAMP - INTERVAL '20 hours'`)).rows.length;
        if (last) return;
        const out = await runInventory({ budget: NIGHTLY_CALLS, source: 'scheduled' });
        if (!out) return console.log('[OPENER] inventaire déjà en cours — passage ignoré');
        console.log('[OPENER] inventaire :', JSON.stringify(out));
        const c = await recompute({ actor: 'scheduled' });
        console.log('[OPENER] campagne :', JSON.stringify(c));
      } catch (e) { console.error('[OPENER] inventaire/campagne :', e.message); }
    },
  };
}

module.exports = { registerOpenerCampaignRoutes, TARGET_KINDS, INVENTORY_FIELDS };
