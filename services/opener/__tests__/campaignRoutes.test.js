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
  const fullOnce = new Set();
  const google = {
    configured: () => true,
    searchText: async () => [],
    details: async (pid) => ({ id: pid, displayName: { text: `Nom ${pid.slice(-4)}` }, formattedAddress: `${pid.slice(-3)} Rue Test, Montréal, QC` }),
    searchNearby: async (center, radius, types, { fields } = {}) => {
      nearbyCalls++;
      if (nearbyCalls > quotaAt) { const e = new Error('plafond'); e.quota = true; throw e; }
      assert.ok(fields && !fields.includes('places.rating'), 'masque léger pour l\'inventaire');
      const key = `${center[0].toFixed(4)},${center[1].toFixed(4)}`;
      const n = nearbyCalls === 1 && !fullOnce.has(key) ? (fullOnce.add(key), 20) : 6;
      return Array.from({ length: n }, (_, i) => ({
        id: `PL_${key}_${radius}_${i}`.replace(/[^A-Za-z0-9_]/g, '_'),
        location: { latitude: center[0] + ((i % 3) - 1) * radius / 3 / 111320, longitude: center[1] + (Math.floor(i / 3) - 1) * radius / 3 / 78000 },
        primaryType: i === 5 ? 'barber_shop' : i === 4 ? 'cafe' : 'restaurant',
        businessStatus: i === 3 ? 'CLOSED_PERMANENTLY' : 'OPERATIONAL',
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
  const perms = { 'mgr@x.com': ['opener:routes'], 'a@x.com': ['opener:field'] };
  app.use((req, _res, next) => { req.user = { email: req.headers['x-user'] }; next(); });
  const authenticateToken = (req, res, next) => (req.user.email ? next() : res.status(401).end());
  const hasPerm = async (req, p) => (perms[req.user.email] || []).includes(p);
  const requirePerm = async (req, res, p) => { if (await hasPerm(req, p)) return true; res.status(403).json({ error: 'forbidden' }); return false; };
  const lot0 = registerOpenerRoutes(app, { authenticateToken, requirePerm, pool, logActivity: async () => {}, kaizen: { fetchAllStores: async () => [] }, google, kaizenConfigured: () => false });
  const field = registerOpenerFieldRoutes(app, { authenticateToken, requirePerm, hasPerm, pool, logActivity: async () => {}, google, late, baseSchema: lot0.ensureReady });
  const camp = registerOpenerCampaignRoutes(app, { authenticateToken, requirePerm, pool, logActivity: async () => {}, field, google, late });
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

    await t('inventaire : plafond Google du jour → arrêt net, cercles restants en file', async () => {
      quotaAt = nearbyCalls + 3;
      const out = await camp.runInventory({ budget: 50, source: 'quota' });
      assert.strictEqual(out.stopped, 'plafond Google du jour atteint');
      assert.strictEqual(out.calls, 3);
      quotaAt = Infinity;
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
    await t('découpage : chaque restaurant visé dans UNE route, sans les clients, les exclus ni les « autres »', async () => {
      const r = await call('POST', '/api/opener/campaign/recompute');
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.ok(r.body.routes > 0);
      campaign = (await call('GET', '/api/opener/campaign')).body;
      const all = campaign.routes.flatMap((x) => x.id);
      assert.strictEqual(all.length, r.body.routes);
      const pids = (await pool.query(`SELECT jsonb_array_elements_text(place_ids) AS p FROM opener_campaign_routes`)).rows.map((x) => x.p);
      assert.strictEqual(pids.length, new Set(pids).size, 'aucun doublon');
      assert.ok(!pids.includes(anyPlaces[0]), 'client actif écarté');
      assert.ok(!pids.includes(anyPlaces[1]), 'établissement exclu écarté');
      const others = (await pool.query(`SELECT place_id FROM opener_places WHERE kind = 'other'`)).rows.map((x) => x.place_id);
      assert.ok(others.length > 0 && others.every((o) => !pids.includes(o)), 'les « autres » (barbier…) écartés');
      const target = (await pool.query(`SELECT COUNT(*)::int n FROM opener_places WHERE kind <> 'other' AND excluded_at IS NULL`)).rows[0].n;
      assert.strictEqual(pids.length, target - 1, 'tous les autres restaurants sont couverts');
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
    await t('planifier la semaine : 5 routes par opener, du lundi au vendredi, aucune en double, UN courriel chacun', async () => {
      const r = await call('POST', '/api/opener/campaign/plan-week', { openers: ['a@x.com', 'b@x.com'], weekStart: '2026-10-12', days: 5 });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      week = r.body.openers;
      assert.strictEqual(week.length, 2);
      const dates = week[0].days.map((d) => d.date);
      assert.deepStrictEqual(dates, ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']);
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
      const r = await call('GET', '/api/opener/today?date=2026-10-12', undefined, 'a@x.com');
      assert.ok(r.body.route && r.body.route.stops.length > 0);
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

    await t('recalcul : les routes planifiées et faites sont gardées, leurs restaurants pas redistribués', async () => {
      const keep = (await pool.query(`SELECT id, place_ids FROM opener_campaign_routes WHERE status IN ('planned','done')`)).rows;
      await call('POST', '/api/opener/campaign/recompute');
      const after = (await pool.query(`SELECT id, status, place_ids FROM opener_campaign_routes`)).rows;
      for (const k of keep) assert.ok(after.find((a) => a.id === k.id), `route ${k.id} gardée`);
      const kept = new Set(keep.flatMap((k) => k.place_ids));
      const todoP = after.filter((a) => a.status === 'todo').flatMap((a) => a.place_ids);
      assert.ok(todoP.every((p) => !kept.has(p)));
    });

    await t('exclu depuis le terrain : l\'arrêt passe « non visité (exclu) »', async () => {
      const wed = week[0].days[2];
      const stop = (await pool.query(`SELECT id, place_id FROM opener_route_stops WHERE route_id = $1 ORDER BY position LIMIT 1`, [wed.routeId])).rows[0];
      const r = await call('POST', `/api/opener/places/${stop.place_id}/exclude`, { reason: 'pas un restaurant', stopId: stop.id }, 'a@x.com');
      assert.strictEqual(r.status, 200);
      const s = (await pool.query(`SELECT outcome, skip_reason FROM opener_route_stops WHERE id = $1`, [stop.id])).rows[0];
      assert.deepStrictEqual([s.outcome, s.skip_reason], ['skipped', 'excluded']);
    });

    console.log(`campaignRoutes : ${n} tests OK (${nearbyCalls} appels Nearby simulés)`);
  } finally {
    server.close();
    await db.close();
  }
})().catch((e) => { console.error('ÉCHEC :', e); process.exit(1); });
