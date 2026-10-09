// Campagne de bout en bout : inventaire, découpage, exclusion, planification de la semaine.
// Vraie base Postgres en mémoire (PGlite), vrai serveur HTTP ; Google et le courriel simulés.
//   node services/opener/__tests__/campaignRoutes.test.js
const assert = require('assert');
const http = require('http');
const express = require('express');
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { console.error('ÉCHEC : @electric-sql/pglite manquant'); process.exit(1); }
const { registerOpenerRoutes } = require('../routes');
const { registerOpenerFieldRoutes } = require('../field');
const { registerOpenerCampaignRoutes } = require('../campaignRoutes');
const F = require('../franchise');

(async () => {
  const db = new PGlite();
  const pool = { query: (q, p) => db.query(q, p).then((r) => ({ ...r, rowCount: r.affectedRows ?? r.rows.length })) };
  await db.exec(`
    CREATE TABLE sync_state (key VARCHAR(100) PRIMARY KEY, value TEXT, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE activity_log (id SERIAL, entity_type TEXT, entity_id TEXT, event_type TEXT, description TEXT, actor TEXT, metadata JSONB);
    CREATE TABLE roles (id SERIAL PRIMARY KEY, name TEXT, permissions JSONB);
    CREATE TABLE user_roles (user_email TEXT, role_id INT);
    CREATE TABLE user_tokens (email TEXT, display_name TEXT, is_admin BOOLEAN);
    CREATE TABLE local_users (email TEXT, display_name TEXT);
    CREATE TABLE leads (id SERIAL PRIMARY KEY, ref_code TEXT, business_name TEXT, status TEXT, interest JSONB, created_by TEXT, raw JSONB, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO user_tokens VALUES ('a@x.com', 'Alice Opener', false), ('b@x.com', 'Bruno Opener', false);
  `);

  // --- Google simulé : chaque cercle « contient » des restaurants déterministes autour de son
  // centre ; un cercle précis (le premier balayé) revient PLEIN (20) pour forcer le découpage.
  let nearbyCalls = 0;
  let quotaAt = Infinity;
  let quotaFails = 0;          // refus de quota passagers (limite par minute)
  const sleeps = [];
  const seen = [];             // cercles demandés, dans l'ordre
  const fullOnce = new Set();
  const google = {
    configured: () => true,
    searchText: async () => [],
    details: async (pid) => ({ id: pid, displayName: { text: `Nom ${pid.slice(-4)}` }, formattedAddress: `${pid.slice(-3)} Rue Test, Montréal, QC` }),
    searchNearby: async (center, radius, types, { fields } = {}) => {
      nearbyCalls++;
      seen.push(`${center[0].toFixed(5)},${center[1].toFixed(5)},${radius}`);
      if (quotaFails > 0) { quotaFails--; const e = new Error('RESOURCE_EXHAUSTED'); e.quota = true; throw e; }
      if (nearbyCalls > quotaAt) { const e = new Error('plafond'); e.quota = true; throw e; }
      assert.ok(fields && !fields.includes('places.rating'), 'masque léger pour l\'inventaire');
      assert.ok(fields.includes('places.displayName'), 'le nom sert à reconnaître les franchises');
      const key = `${center[0].toFixed(4)},${center[1].toFixed(4)}`;
      const n = nearbyCalls === 1 && !fullOnce.has(key) ? (fullOnce.add(key), 20) : 6;
      return Array.from({ length: n }, (_, i) => ({
        id: `PL_${key}_${radius}_${i}`.replace(/[^A-Za-z0-9_]/g, '_'),
        location: { latitude: center[0] + ((i % 3) - 1) * radius / 3 / 111320, longitude: center[1] + (Math.floor(i / 3) - 1) * radius / 3 / 78000 },
        primaryType: i === 5 ? 'barber_shop' : i === 4 ? 'cafe' : 'restaurant',
        businessStatus: i === 3 ? 'CLOSED_PERMANENTLY' : 'OPERATIONAL',
        displayName: { text: `Resto ${key} ${radius} ${i}` },   // tous différents : aucune franchise
      }));
    },
  };
  const mails = [];
  const late = () => ({
    sendMail: async (to, subject, html) => { mails.push({ to, subject, html }); return { sent: true }; },
    mailShell: (title, intro, cta, url) => `<h1>${title}</h1>${intro}<a href="${url}">${cta}</a>`,
  });

  const app = express();
  app.use(express.json());
  const perms = { 'mgr@x.com': ['opener:routes'], 'boss@x.com': ['opener:routes', 'opener:franchises'], 'a@x.com': ['opener:field'] };
  app.use((req, _res, next) => { req.user = { email: req.headers['x-user'] }; next(); });
  const authenticateToken = (req, res, next) => (req.user.email ? next() : res.status(401).end());
  const hasPerm = async (req, p) => (perms[req.user.email] || []).includes(p);
  const requirePerm = async (req, res, p) => { if (await hasPerm(req, p)) return true; res.status(403).json({ error: 'forbidden' }); return false; };
  const lot0 = registerOpenerRoutes(app, { authenticateToken, requirePerm, pool, logActivity: async () => {}, kaizen: { fetchAllStores: async () => [] }, google, kaizenConfigured: () => false });
  const field = registerOpenerFieldRoutes(app, { authenticateToken, requirePerm, hasPerm, pool, logActivity: async () => {}, google, late, baseSchema: lot0.ensureReady });
  const camp = registerOpenerCampaignRoutes(app, { authenticateToken, requirePerm, pool, logActivity: async () => {}, field, google, late,
    sleep: async (ms) => { sleeps.push(ms); }, paceMs: 0 });
  await field.schema();

  const server = http.createServer(app).listen(0);
  const port = server.address().port;
  const call = (method, path, body, user = 'mgr@x.com') => new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const r = http.request({ port, path, method, headers: { 'x-user': user, 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => resolve({ status: res.statusCode, body: s ? JSON.parse(s) : null }));
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });

  let n = 0;
  const t = async (name, fn) => { await fn(); n++; console.log('  ✓', name); };

  try {
    let inv;
    await t('inventaire : les quatre régions quadrillées, Montréal d\'abord, cercle plein découpé', async () => {
      inv = await camp.runInventory({ budget: 60, source: 'test' });
      assert.strictEqual(inv.calls, 60);
      assert.strictEqual(inv.split, 1);
      const cells = (await pool.query(`SELECT region, COUNT(*)::int n, COUNT(*) FILTER (WHERE status = 'done')::int d, MAX(depth) md FROM opener_inventory_cells GROUP BY region`)).rows;
      for (const r of ['montreal', 'laval', 'rive-sud', 'rive-nord']) assert.ok(cells.find((c) => c.region === r)?.n > 10, r);
      assert.strictEqual(cells.find((c) => c.region === 'montreal').d, 60, 'Montréal balayé en premier');
      assert.strictEqual(cells.find((c) => c.region === 'montreal').md, 1, 'sous-cercles du cercle plein');
      const pl = (await pool.query(`SELECT COUNT(*)::int n, COUNT(*) FILTER (WHERE kind IS NULL OR region IS NULL)::int bad FROM opener_places`)).rows[0];
      assert.ok(pl.n > 200);
      assert.strictEqual(pl.bad, 0, 'catégorie et région sur chaque établissement');
      assert.strictEqual((await pool.query(`SELECT COUNT(*)::int n FROM opener_places WHERE place_id LIKE '%\\_3' ESCAPE '\\'`)).rows[0].n, 0, 'les fermés définitivement ne sont pas gardés');
    });

    await t('inventaire : budget mensuel tenu, aucun appel au-delà', async () => {
      const u = JSON.parse((await pool.query(`SELECT value FROM sync_state WHERE key = 'opener_scan_usage'`)).rows[0].value);
      assert.strictEqual(u.calls, 60);
    });

    await t('inventaire : refus de quota passager (limite par minute) → pause d\'une minute, puis reprise du même cercle', async () => {
      sleeps.length = 0;
      seen.length = 0;
      quotaFails = 2;
      const out = await camp.runInventory({ budget: 4, source: 'quota-minute' });
      assert.strictEqual(out.stopped, undefined, 'pas d\'arrêt sur un refus passager');
      assert.strictEqual(out.quotaPauses, 2);
      assert.strictEqual(out.calls, 4, 'le budget est quand même consommé');
      assert.strictEqual(sleeps.filter((ms) => ms >= 60000).length, 2, 'une pause d\'au moins une minute par refus');
      // Les deux refus et le premier succès portent sur le MÊME cercle : rien n'est sauté.
      assert.strictEqual(seen.length, 6);
      assert.ok(seen[0] === seen[1] && seen[1] === seen[2], `même cercle réessayé : ${seen.slice(0, 3).join(' | ')}`);
      assert.strictEqual(out.cells, 4);
    });

    await t('inventaire : refus de quota persistant → arrêt après 3 pauses, cercles restants en file', async () => {
      quotaAt = nearbyCalls + 3;
      sleeps.length = 0;
      const out = await camp.runInventory({ budget: 50, source: 'quota' });
      assert.strictEqual(out.stopped, 'quota Google atteint');
      assert.strictEqual(out.calls, 3);
      assert.strictEqual(out.quotaPauses, 3);
      quotaAt = Infinity;
      const lock = (await pool.query(`SELECT value FROM sync_state WHERE key = 'opener_inventory_lock'`)).rows[0].value;
      assert.strictEqual(lock, 'idle', 'verrou relâché');
    });

    // Un client actif sur un des restaurants inventoriés, et un établissement exclu.
    const anyPlaces = (await pool.query(`SELECT place_id FROM opener_places WHERE kind = 'restaurant' ORDER BY place_id LIMIT 3`)).rows.map((r) => r.place_id);
    await pool.query(`INSERT INTO cluster_locations (source, source_key, name, active, place_id, match_status, software_version) VALUES ('kaizen', 'k1', 'Client', true, $1, 'auto', 'v2')`, [anyPlaces[0]]);

    await t('exclure un établissement (« pas un restaurant ») : manager ou opener ; rétablir : manager seulement', async () => {
      assert.strictEqual((await call('POST', `/api/opener/places/${anyPlaces[1]}/exclude`, { reason: 'pas un restaurant' }, 'a@x.com')).status, 200);
      assert.strictEqual((await call('DELETE', `/api/opener/places/${anyPlaces[1]}/exclude`, undefined, 'a@x.com')).status, 403);
      const list = (await call('GET', '/api/opener/excluded')).body.excluded;
      assert.strictEqual(list[0].placeId, anyPlaces[1]);
      assert.strictEqual(list[0].reason, 'pas un restaurant');
      assert.strictEqual(list[0].name, `Nom ${anyPlaces[1].slice(-4)}`, 'le nom vient de Google, pas de la base');
    });

    let campaign;
    await t('découpage : chaque restaurant visé dans UNE route, clients COMPRIS, sans les exclus ni les « autres »', async () => {
      // Un client apparié au lot 0 que l'inventaire n'a pas vu (catégorie « magasin », sans région) :
      // il est quand même mis sur une route, sa région calculée depuis ses coordonnées.
      await pool.query(`INSERT INTO opener_places (place_id, lat, lng, source, kind) VALUES ('PL_CLIENT_HORS_INV', 45.5017, -73.5673, 'match', 'other')`);
      await pool.query(`INSERT INTO cluster_locations (source, source_key, name, active, place_id, match_status, software_version) VALUES ('billing', 'b-hors', 'Client hors inventaire', true, 'PL_CLIENT_HORS_INV', 'auto', 'v1')`);
      const r = await call('POST', '/api/opener/campaign/recompute');
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.ok(r.body.routes > 0);
      campaign = (await call('GET', '/api/opener/campaign')).body;
      const all = campaign.routes.flatMap((x) => x.id);
      assert.strictEqual(all.length, r.body.routes);
      const pids = (await pool.query(`SELECT jsonb_array_elements_text(place_ids) AS p FROM opener_campaign_routes`)).rows.map((x) => x.p);
      assert.strictEqual(pids.length, new Set(pids).size, 'aucun doublon');
      assert.ok(pids.includes(anyPlaces[0]), 'client actif INCLUS (satisfaction, paiements)');
      assert.ok(pids.includes('PL_CLIENT_HORS_INV'), 'client hors inventaire inclus');
      assert.strictEqual(r.body.clients, 2);
      assert.ok(!pids.includes(anyPlaces[1]), 'établissement exclu écarté');
      const others = (await pool.query(`SELECT place_id FROM opener_places WHERE kind = 'other' AND place_id <> 'PL_CLIENT_HORS_INV'`)).rows.map((x) => x.place_id);
      assert.ok(others.length > 0 && others.every((o) => !pids.includes(o)), 'les « autres » (barbier…) écartés');
      const target = (await pool.query(`SELECT COUNT(*)::int n FROM opener_places WHERE kind <> 'other' AND excluded_at IS NULL AND region IS NOT NULL`)).rows[0].n;
      assert.strictEqual(pids.length, target + 1, 'tous les restaurants + le client hors inventaire');
      const withClients = (await call('GET', '/api/opener/campaign')).body.routes.filter((x) => x.clients > 0);
      assert.strictEqual(withClients.reduce((s, x) => s + x.clients, 0), 2, 'nombre de clients par route');
    });

    await t('vue campagne : progression de la cartographie par région, routes avec zone et statut', async () => {
      const mtl = campaign.regions.find((r) => r.key === 'montreal');
      assert.ok(mtl.cells.total > mtl.cells.done && mtl.cells.done > 0);
      assert.ok(mtl.places.total > 0);
      assert.strictEqual(mtl.places.clients, 1);
      assert.strictEqual(campaign.excluded, 1);
      assert.ok(campaign.routes.every((r) => r.status === 'todo' && Array.isArray(r.hull) && r.n > 0 && r.minutes <= 300));
      assert.strictEqual((await call('GET', '/api/opener/campaign', undefined, 'a@x.com')).status, 403);
    });

    await t('détail d\'une route : arrêts avec nom et statut', async () => {
      const r = (await call('GET', `/api/opener/campaign/routes/${campaign.routes[0].id}`)).body;
      assert.strictEqual(r.stops.length, campaign.routes[0].n);
      assert.ok(r.stops[0].name.startsWith('Nom '));
      assert.strictEqual(r.stops[0].status, 'new');
    });

    let week;
    let proposal;
    await t('aperçu de la semaine : les routes proposées à chacun, RIEN de publié, aucun courriel', async () => {
      const r = await call('POST', '/api/opener/campaign/plan-week', { openers: ['a@x.com', 'b@x.com'], weekStart: '2026-11-02', days: 5, preview: true });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      proposal = r.body.openers;
      assert.strictEqual(proposal[0].days.length, 5);
      assert.deepStrictEqual(proposal[0].days.map((d) => d.date), ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']);
      assert.ok(proposal[0].days[0].name.startsWith('R') && proposal[0].days[0].stops > 0);
      const n = (await pool.query(`SELECT COUNT(*)::int n FROM opener_routes`)).rows[0].n;
      assert.strictEqual(n, 0, 'aucune route créée par un aperçu');
      assert.strictEqual(mails.length, 0, 'aucun courriel pour un aperçu');
      const planned = (await pool.query(`SELECT COUNT(*)::int n FROM opener_campaign_routes WHERE status <> 'todo'`)).rows[0].n;
      assert.strictEqual(planned, 0);
      // Opener jamais connecté (aucun nom en base) : nom tiré de l'adresse, jamais l'adresse entière.
      const anon = await call('POST', '/api/opener/campaign/plan-week', { openers: ['jean-luc.tremblay@x.com'], weekStart: '2026-11-02', days: 1, preview: true });
      assert.strictEqual(anon.body.openers[0].openerName, 'Jean Luc Tremblay');
    });

    await t('planifier la semaine : 5 routes par opener, du lundi au vendredi, aucune en double, UN courriel chacun', async () => {
      // Confirmation de l'aperçu : on publie EXACTEMENT ce qui a été montré.
      const assignments = proposal.map((o) => ({ openerEmail: o.openerEmail, ids: o.days.map((d) => d.campaignRouteId) }));
      const r = await call('POST', '/api/opener/campaign/plan-week', { openers: ['a@x.com', 'b@x.com'], weekStart: '2026-11-02', days: 5, assignments });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      week = r.body.openers;
      assert.deepStrictEqual(week.map((o) => o.days.map((d) => d.campaignRouteId)), assignments.map((a) => a.ids), 'la confirmation publie l\'aperçu tel quel');
      assert.strictEqual(week.length, 2);
      const dates = week[0].days.map((d) => d.date);
      assert.deepStrictEqual(dates, ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']);
      const allIds = week.flatMap((o) => o.days.map((d) => d.campaignRouteId));
      assert.strictEqual(allIds.length, Math.min(10, campaign.routes.length));
      assert.strictEqual(new Set(allIds).size, allIds.length);
      assert.strictEqual(mails.length, 2);
      assert.ok(mails[0].html.includes('Alice Opener') && mails[0].subject.includes('route'));
      const pub = (await pool.query(`SELECT COUNT(*)::int n FROM opener_routes WHERE status = 'published' AND LOWER(opener_email) = 'a@x.com'`)).rows[0].n;
      assert.strictEqual(pub, 5);
      const stop = (await pool.query(`SELECT label, lat FROM opener_route_stops LIMIT 1`)).rows[0];
      assert.ok(stop.label.startsWith('Nom ') && stop.lat != null, 'noms et positions copiés sur la route');
    });

    await t('l\'opener voit sa route du lundi dans l\'application', async () => {
      const r = await call('GET', '/api/opener/today?date=2026-11-02', undefined, 'a@x.com');
      assert.ok(r.body.route && r.body.route.stops.length > 0);
    });

    await t('quelques jours seulement (« des routes pour demain ») : date de départ libre, fins de semaine sautées', async () => {
      // Un mercredi, 1 jour : ce mercredi.
      let r = await call('POST', '/api/opener/campaign/plan-week', { openers: ['b@x.com'], weekStart: '2026-10-21', days: 1, preview: true });
      assert.deepStrictEqual(r.body.openers[0].days.map((d) => d.date), ['2026-10-21']);
      // Un samedi, 2 jours : lundi et mardi.
      r = await call('POST', '/api/opener/campaign/plan-week', { openers: ['b@x.com'], weekStart: '2026-10-24', days: 2, preview: true });
      assert.deepStrictEqual(r.body.openers[0].days.map((d) => d.date), ['2026-10-26', '2026-10-27']);
      // Un jour déjà pris par une route publiée est sauté (b@x.com a sa semaine du 2 au 6 novembre).
      r = await call('POST', '/api/opener/campaign/plan-week', { openers: ['b@x.com'], weekStart: '2026-11-05', days: 2, preview: true });
      assert.deepStrictEqual(r.body.openers[0].days.map((d) => d.date), ['2026-11-09', '2026-11-10']);
      // Jour férié : lundi 12 octobre 2026 = Action de grâce → mardi et mercredi.
      r = await call('POST', '/api/opener/campaign/plan-week', { openers: ['jean-luc.tremblay@x.com'], weekStart: '2026-10-12', days: 2, preview: true });
      assert.deepStrictEqual(r.body.openers[0].days.map((d) => d.date), ['2026-10-13', '2026-10-14'], 'Action de grâce sautée');
    });

    await t('la semaine suivante repart du secteur de l\'opener (voisinage)', async () => {
      const before = week[0].days[week[0].days.length - 1];
      const r = await call('POST', '/api/opener/campaign/plan-week', { openers: ['a@x.com'], weekStart: '2026-10-19', days: 2 });
      const first = r.body.openers[0].days[0];
      const cr = (await pool.query(`SELECT id, centroid_lat, centroid_lng FROM opener_campaign_routes WHERE id = ANY($1::int[])`, [[before.campaignRouteId, first.campaignRouteId]])).rows;
      const [a, b] = cr;
      const d = Math.hypot((a.centroid_lat - b.centroid_lat) * 111, (a.centroid_lng - b.centroid_lng) * 78);
      const todo = (await pool.query(`SELECT centroid_lat, centroid_lng FROM opener_campaign_routes WHERE status = 'todo'`)).rows;
      const anchor = cr.find((x) => x.id === before.campaignRouteId);
      const nearestOther = Math.min(...todo.map((x) => Math.hypot((x.centroid_lat - anchor.centroid_lat) * 111, (x.centroid_lng - anchor.centroid_lng) * 78)));
      assert.ok(d <= nearestOther + 0.001, `${d.toFixed(2)} km contre ${nearestOther.toFixed(2)} km`);
    });

    await t('route visitée → « faite » ; route retirée avant de commencer → revient « à faire »', async () => {
      const mon = week[0].days[0];
      await pool.query(`UPDATE opener_route_stops SET outcome = 'done' WHERE route_id = $1`, [mon.routeId]);
      const tue = week[0].days[1];
      assert.strictEqual((await call('POST', `/api/opener/campaign/routes/${tue.campaignRouteId}/unassign`)).status, 200);
      assert.strictEqual((await call('POST', `/api/opener/campaign/routes/${mon.campaignRouteId}/unassign`)).body.error, 'not_planned');
      const c = (await call('GET', '/api/opener/campaign')).body;
      assert.strictEqual(c.routes.find((r) => r.id === mon.campaignRouteId).status, 'done');
      assert.strictEqual(c.routes.find((r) => r.id === tue.campaignRouteId).status, 'todo');
      assert.strictEqual((await pool.query(`SELECT 1 FROM opener_routes WHERE id = $1`, [tue.routeId])).rows.length, 0);
    });

    await t('recalcul : routes planifiées gardées ; les NON VISITÉS d\'une route faite sont redistribués, pas les visités ni les refus', async () => {
      // Route du mercredi : 1 visité, 1 fermé, 1 refus, le reste jamais touché ; journée fermée.
      const wed = week[0].days[2];
      const stops = (await pool.query(`SELECT id, place_id FROM opener_route_stops WHERE route_id = $1 ORDER BY position`, [wed.routeId])).rows;
      assert.ok(stops.length >= 4);
      const [visited, closed, refused, untouched] = stops;
      await pool.query(`UPDATE opener_route_stops SET outcome = 'done', done_at = CURRENT_TIMESTAMP WHERE id = $1`, [visited.id]);
      await pool.query(`UPDATE opener_route_stops SET outcome = 'skipped', skip_reason = 'closed', done_at = CURRENT_TIMESTAMP WHERE id = $1`, [closed.id]);
      await pool.query(`UPDATE opener_route_stops SET outcome = 'skipped', skip_reason = 'refused', done_at = CURRENT_TIMESTAMP WHERE id = $1`, [refused.id]);
      await pool.query(`UPDATE opener_routes SET status = 'closed', closed_at = CURRENT_TIMESTAMP WHERE id = $1`, [wed.routeId]);
      const planned = (await pool.query(`SELECT id, place_ids FROM opener_campaign_routes WHERE status = 'planned' AND id <> $1`, [wed.campaignRouteId])).rows;
      assert.ok(planned.length > 0);
      await call('POST', '/api/opener/campaign/recompute');
      const after = (await pool.query(`SELECT id, status, place_ids FROM opener_campaign_routes`)).rows;
      for (const k of planned) {
        const info = (await pool.query(`SELECT r.route_date::text d, r.status, (SELECT COUNT(*)::int FROM opener_route_stops s WHERE s.route_id = r.id AND s.outcome = 'planned') p
          FROM opener_routes r JOIN opener_campaign_routes cr ON cr.route_id = r.id WHERE cr.id = $1`, [k.id])).rows;
        assert.ok(after.find((a) => a.id === k.id && a.status === 'planned'), `route planifiée ${k.id} gardée : ${after.find((a) => a.id === k.id)?.status} ${JSON.stringify(info)}`);
      }
      assert.strictEqual(after.find((a) => a.id === wed.campaignRouteId).status, 'done', 'la route du mercredi reste « faite »');
      const todoP = new Set(after.filter((a) => a.status === 'todo').flatMap((a) => a.place_ids));
      assert.ok(todoP.has(closed.place_id), 'fermé à l\'arrivée → redistribué');
      assert.ok(todoP.has(untouched.place_id), 'jamais touché → redistribué');
      assert.ok(!todoP.has(visited.place_id), 'visité → pas redistribué');
      assert.ok(!todoP.has(refused.place_id), 'refus d\'entrer → pas redistribué (90 jours)');
      const stillPlanned = new Set(planned.flatMap((k) => k.place_ids));
      assert.ok([...todoP].every((p) => !stillPlanned.has(p)), 'rien d\'une route encore planifiée');
    });

    await t('route dont la date est passée sans fermer la journée → « faite », ses restaurants non visités reviennent', async () => {
      const thu = week[0].days[3];
      await pool.query(`UPDATE opener_routes SET route_date = DATE '2026-01-05' WHERE id = $1`, [thu.routeId]);
      const one = (await pool.query(`SELECT place_id FROM opener_route_stops WHERE route_id = $1 LIMIT 1`, [thu.routeId])).rows[0].place_id;
      await call('POST', '/api/opener/campaign/recompute');
      const cr = (await pool.query(`SELECT status FROM opener_campaign_routes WHERE id = $1`, [thu.campaignRouteId])).rows[0];
      assert.strictEqual(cr.status, 'done');
      const todoP = (await pool.query(`SELECT jsonb_array_elements_text(place_ids) p FROM opener_campaign_routes WHERE status = 'todo'`)).rows.map((x) => x.p);
      assert.ok(todoP.includes(one));
    });

    await t('exclu depuis le terrain : l\'arrêt passe « non visité (exclu) »', async () => {
      const wed = week[0].days[4]; // vendredi : route encore à faire
      const stop = (await pool.query(`SELECT id, place_id FROM opener_route_stops WHERE route_id = $1 ORDER BY position LIMIT 1`, [wed.routeId])).rows[0];
      const r = await call('POST', `/api/opener/places/${stop.place_id}/exclude`, { reason: 'pas un restaurant', stopId: stop.id }, 'a@x.com');
      assert.strictEqual(r.status, 200);
      const s = (await pool.query(`SELECT outcome, skip_reason FROM opener_route_stops WHERE id = $1`, [stop.id])).rows[0];
      assert.deepStrictEqual([s.outcome, s.skip_reason], ['skipped', 'excluded']);
    });

    await t('bannières : reconnaissance du nom (succursale retirée, chaînes connues, préfixe)', async () => {
      assert.strictEqual(F.brandKey('Thai Express - Plateau'), 'thaiexpress');
      assert.strictEqual(F.brandKey('St-Hubert (Laval)'), 'sthubert');
      assert.strictEqual(F.brandKey('Tim Hortons #1234'), 'timhortons');
      assert.strictEqual(F.brandKey('Allô mon Coco Plateau Gatineau'), 'allomoncoco');
      assert.ok(F.isKnown('sushishop') && !F.isKnown(F.brandKey('Pizzeria Bella')));
      const tagged = (await pool.query(`SELECT COUNT(*)::int n FROM opener_places WHERE source = 'inventory' AND brand_key IS NULL`)).rows[0].n;
      assert.strictEqual(tagged, 0, 'chaque établissement inventorié porte sa bannière');
    });

    await t('franchises : écartées des routes (connue OU ≥ 3 adresses), sauf chez un client ; décision du gestionnaire', async () => {
      const todoP = (await pool.query(`SELECT jsonb_array_elements_text(place_ids) p FROM opener_campaign_routes WHERE status = 'todo'`)).rows.map((x) => x.p);
      const cand = (await pool.query(
        `SELECT place_id FROM opener_places WHERE place_id = ANY($1::text[]) AND kind = 'restaurant' AND region IS NOT NULL AND excluded_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM cluster_locations l WHERE l.place_id = opener_places.place_id) ORDER BY place_id LIMIT 4`, [todoP])).rows.map((x) => x.place_id);
      assert.strictEqual(cand.length, 4);
      const [g1, g2, g3, tim] = cand;
      // Un client Cluster d'une chaîne : on le visite toujours (satisfaction, paiements).
      await pool.query(`INSERT INTO opener_places (place_id, lat, lng, source, kind, region) VALUES ('PL_TIM_CLIENT', 45.52, -73.58, 'inventory', 'restaurant', 'montreal')`);
      await pool.query(`INSERT INTO cluster_locations (source, source_key, name, active, place_id, match_status, software_version) VALUES ('billing', 'b-tim', 'Tim client', true, 'PL_TIM_CLIENT', 'auto', 'v1')`);
      const c0 = (await call('POST', '/api/opener/campaign/recompute')).body;
      await F.tagPlaces(pool, [
        { id: g1, name: 'Chez Gus - Plateau' }, { id: g2, name: 'Chez Gus - Rosemont' }, { id: g3, name: 'Chez Gus (Verdun)' },
        { id: tim, name: 'Tim Hortons #12' }, { id: 'PL_TIM_CLIENT', name: 'Tim Hortons - Client' },
      ]);
      const rc = (await call('POST', '/api/opener/campaign/recompute')).body;
      const pids = async () => new Set((await pool.query(`SELECT jsonb_array_elements_text(place_ids) p FROM opener_campaign_routes WHERE status = 'todo'`)).rows.map((x) => x.p));
      let all = await pids();
      for (const p of cand) assert.ok(!all.has(p), `franchise ${p} écartée`);
      // Le client (« Tim Hortons - Client ») est compté dans la campagne avant comme après.
      assert.ok(c0.clients > 0);
      assert.strictEqual(rc.clients, c0.clients, 'un CLIENT d\'une franchise reste sur sa route');
      assert.strictEqual(rc.places, c0.places - 4);
      assert.ok(all.has('PL_TIM_CLIENT'), 'le client Tim Hortons est sur une route');
      const c = (await call('GET', '/api/opener/campaign')).body;
      assert.deepStrictEqual(c.franchises, { places: 4, brands: 2 });
      const st = (await field.statusOf([tim, anyPlaces[0]]));
      assert.strictEqual(st.get(tim).franchise, true);
      assert.strictEqual(st.get(tim).brand, 'Tim Hortons');

      let b = (await call('GET', '/api/opener/brands')).body;
      assert.strictEqual(b.canDecide, false);
      const gus = b.brands.find((x) => x.key === 'chezgus');
      assert.deepStrictEqual([gus.label, gus.n, gus.known, gus.franchise], ['Chez Gus', 3, false, true]);
      const th = b.brands.find((x) => x.key === 'timhortons');
      assert.deepStrictEqual([th.known, th.clients, th.franchise], [true, 1, true]);

      // « À visiter quand même » : permission opener:franchises, puis retour dans la campagne.
      assert.strictEqual((await call('PATCH', '/api/opener/brands/chezgus', { decision: 'visit' })).status, 403);
      assert.strictEqual((await call('PATCH', '/api/opener/brands/chezgus', { decision: 'bof' }, 'boss@x.com')).status, 400);
      assert.strictEqual((await call('PATCH', '/api/opener/brands/chezgus', { decision: 'visit' }, 'boss@x.com')).status, 200);
      await new Promise((res) => setTimeout(res, 300));
      all = await pids();
      for (const p of [g1, g2, g3]) assert.ok(all.has(p), 'Chez Gus revient');
      assert.ok(!all.has(tim), 'Tim Hortons reste écarté');
      // Forcer une bannière indépendante (1 adresse) en franchise.
      await F.tagPlaces(pool, [{ id: cand[0], name: 'Chez Gus - Plateau' }]);
      b = (await call('GET', '/api/opener/brands', undefined, 'boss@x.com')).body;
      assert.strictEqual(b.canDecide, true);
      assert.strictEqual(b.brands.find((x) => x.key === 'chezgus').franchise, false);
      assert.strictEqual((await call('PATCH', '/api/opener/brands/chezgus', { decision: null }, 'boss@x.com')).status, 200);
      await new Promise((res) => setTimeout(res, 300));
      assert.ok(!(await pids()).has(g2), 'règle automatique : de nouveau écartée');
    });

    await t('bannières : noms génériques ignorés, fiches au même endroit = une adresse, anciennes clés recalculées', async () => {
      assert.strictEqual(F.brandKey('Pizzéria'), null);
      assert.strictEqual(F.brandKey('Le Café'), null);
      assert.strictEqual(F.brandKey('Restaurant Boustan'), 'boustan');
      assert.strictEqual(F.brandKey('Express St-Hubert'), 'sthubert');
      assert.strictEqual(F.brandKey('Restaurant Scores'), 'scores');
      assert.strictEqual(F.brandKey('PFK'), 'kfc');
      assert.strictEqual(F.brandKey('Café Olimpico'), 'cafeolimpico', 'une bannière inconnue garde son nom entier');
      // Trois fiches Google d'un même restaurant (à quelques mètres) : UNE adresse, pas une franchise.
      const ids = ['PL_SAME_1', 'PL_SAME_2', 'PL_SAME_3'];
      for (const [i, id] of ids.entries()) await pool.query(
        `INSERT INTO opener_places (place_id, lat, lng, source, kind, region) VALUES ($1, $2, -73.6001, 'inventory', 'restaurant', 'montreal')`, [id, 45.5001 + i * 0.00002]);
      await F.tagPlaces(pool, ids.map((id) => ({ id, name: 'Bergham' })));
      const b = (await pool.query(`SELECT n FROM opener_brands WHERE brand_key = 'bergham'`)).rows[0];
      assert.strictEqual(b.n, 1);
      // Clés d'avant la version 2 : recalculées sans Google, décision conservée, libellé lisible.
      await pool.query(`INSERT INTO opener_brands (brand_key, label, decision, decided_by) VALUES ('restaurantboustan', 'Restaurant Boustan', 'visit', 'boss@x.com'), ('pizzeria', 'Pizzéria', NULL, NULL)`);
      await pool.query(`UPDATE opener_places SET brand_key = 'restaurantboustan' WHERE place_id = 'PL_SAME_1'`);
      await pool.query(`UPDATE opener_places SET brand_key = 'pizzeria' WHERE place_id = 'PL_SAME_2'`);
      await pool.query(`UPDATE sync_state SET value = '2' WHERE key = 'opener_brand_canon'`);
      const out = await F.recanonicalize(pool);
      assert.deepStrictEqual(out, { moved: 1, cleared: 1 });
      const p = (await pool.query(`SELECT place_id, brand_key FROM opener_places WHERE place_id IN ('PL_SAME_1', 'PL_SAME_2') ORDER BY place_id`)).rows;
      assert.deepStrictEqual(p.map((x) => x.brand_key), ['boustan', null]);
      const bo = (await pool.query(`SELECT label, known, decision FROM opener_brands WHERE brand_key = 'boustan'`)).rows[0];
      assert.deepStrictEqual([bo.label, bo.known, bo.decision], ['Boustan', true, 'visit']);
      assert.strictEqual(await F.recanonicalize(pool), null, 'une seule fois par version');
    });

    await t('rattrapage unique : les cercles « feuilles » déjà balayés repassent une fois pour lire les noms', async () => {
      await pool.query(`DELETE FROM sync_state WHERE key = 'opener_brand_backfill'`);
      const before = (await pool.query(`SELECT COUNT(*) FILTER (WHERE status = 'pending')::int p, COUNT(*) FILTER (WHERE status = 'done' AND found >= 20)::int full FROM opener_inventory_cells`)).rows[0];
      await camp.runInventory({ budget: 1, source: 'backfill' });
      const flag = JSON.parse((await pool.query(`SELECT value FROM sync_state WHERE key = 'opener_brand_backfill'`)).rows[0].value);
      assert.ok(flag.cells > 0);
      const after = (await pool.query(`SELECT COUNT(*) FILTER (WHERE status = 'pending')::int p, COUNT(*) FILTER (WHERE status = 'done' AND found >= 20)::int full FROM opener_inventory_cells`)).rows[0];
      assert.strictEqual(after.p, before.p + flag.cells - 1, 'feuilles remises en file (une déjà rebalayée)');
      assert.strictEqual(after.full, before.full, 'un cercle plein (déjà découpé) n\'est pas repassé');
      await camp.runInventory({ budget: 1, source: 'again' });
      const again = (await pool.query(`SELECT COUNT(*) FILTER (WHERE status = 'pending')::int p FROM opener_inventory_cells`)).rows[0].p;
      assert.strictEqual(again, after.p - 1, 'une seule fois');
    });

    console.log(`campaignRoutes : ${n} tests OK (${nearbyCalls} appels Nearby simulés)`);
  } finally {
    server.close();
    await db.close();
  }
})().catch((e) => { console.error('ÉCHEC :', e); process.exit(1); });
