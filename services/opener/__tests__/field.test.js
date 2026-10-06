// Lots 1 à 4 de bout en bout : balayage, routes, terrain, journée. Vraie base Postgres en
// mémoire (PGlite) et vrai serveur HTTP ; Google, la création de piste et le courriel simulés.
//   node services/opener/__tests__/field.test.js
//
// ⚠️ Échoue si PGlite est absent plutôt que de se déclarer vert (voir feedback-verify-the-harness).
const assert = require('assert');
const http = require('http');
const express = require('express');
const crypto = require('crypto');
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { console.error('ÉCHEC : @electric-sql/pglite manquant (npm install --no-save @electric-sql/pglite)'); process.exit(1); }
const { registerOpenerRoutes } = require('../routes');
const { registerOpenerFieldRoutes, ymdMtl, addDays, verdict } = require('../field');

// Zone : ~1 km² sur le Plateau.
const ZONE = [[45.520, -73.590], [45.520, -73.577], [45.529, -73.577], [45.529, -73.590]];
const P = (id, name, lat, lng, extra = {}) => ({
  id, displayName: { text: name }, location: { latitude: lat, longitude: lng }, shortFormattedAddress: `${name} adresse`,
  primaryType: 'restaurant', types: ['restaurant', 'establishment'], rating: 4.4, userRatingCount: 120, dineIn: true, takeout: true, ...extra,
});
const IN = (i) => [45.521 + i * 0.0003, -73.589 + i * 0.0004];   // points dans la zone

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
    CREATE TABLE leads (id SERIAL PRIMARY KEY, ref_code TEXT, business_name TEXT, status TEXT DEFAULT 'new', interest JSONB,
      source TEXT, source_detail TEXT, notes TEXT, city TEXT, province TEXT, postal_code TEXT, created_by TEXT, raw JSONB,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO roles (name, permissions) VALUES ('Opener', '["opener:field"]'), ('Manager', '["opener:routes"]');
    INSERT INTO user_roles VALUES ('jo@x.com', 1), ('autre@x.com', 1), ('mgr@x.com', 2);
    INSERT INTO user_tokens VALUES ('jo@x.com', 'Jonathan Opener', false), ('mgr@x.com', 'Marie Manager', false);
  `);

  // --- Google simulé.
  const nearbyCalls = [];
  let full = false;   // true → le 1er cercle revient plein (20) et doit être découpé
  const google = {
    configured: () => true,
    searchText: async () => [],
    details: async () => null,
    searchNearby: async (center, radius) => {
      nearbyCalls.push({ center, radius });
      if (full && nearbyCalls.length === 1) return Array.from({ length: 20 }, (_, i) => P(`FULL_PLACE_${String(i).padStart(4, '0')}`, `Plein ${i}`, ...IN(i % 10)));
      return [
        P('PLACE_CLIENT_0001', 'Resto Client', ...IN(1)),
        P('PLACE_FORMER_0001', 'Ancien Client', ...IN(2)),
        P('PLACE_NEW_000001', 'Tout Neuf', ...IN(3), { dineIn: false, takeout: true }),
        P('PLACE_OUTSIDE_001', 'Hors Zone', 45.60, -73.50),
        P('PLACE_CLOSED_0001', 'Fermé', ...IN(4), { businessStatus: 'CLOSED_PERMANENTLY' }),
      ];
    },
    detailsFull: async (pid) => {
      detailsCalls.push(pid);
      return { id: pid, displayName: { text: 'Tout Neuf' }, formattedAddress: '123 Rue Neuve, Montréal, QC H2J 1A1',
        location: { latitude: IN(3)[0], longitude: IN(3)[1] }, rating: 4.6, userRatingCount: 1240, priceLevel: 'PRICE_LEVEL_MODERATE',
        nationalPhoneNumber: '(514) 555-0101', currentOpeningHours: { openNow: true, weekdayDescriptions: ['lundi: 11 h – 22 h'] },
        dineIn: true, takeout: true,
        addressComponents: [{ types: ['locality'], longText: 'Montréal' }, { types: ['administrative_area_level_1'], shortText: 'QC', longText: 'Québec' }, { types: ['postal_code'], longText: 'H2J 1A1' }] };
    },
  };
  const detailsCalls = [];

  // --- Pistes et courriel simulés (les vraies fonctions vivent dans server.js).
  const mails = [];
  let refN = 1000;
  const late = () => ({
    normalizeLeadInput: (b, d) => ({ businessName: b.businessName || null, source: d.source, interest: b.interest || [],
      notes: b.notes || null, city: b.city || null, province: b.province || null, postalCode: b.postalCode || null }),
    createLeadRow: async (input, { createdBy, raw }) => {
      const r = await pool.query(
        `INSERT INTO leads (ref_code, business_name, interest, source, source_detail, notes, city, province, postal_code, created_by, raw)
         VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) RETURNING id, ref_code`,
        [`SH-${++refN}`, input.businessName, JSON.stringify(input.interest), input.source, input.sourceDetail, input.notes,
         input.city, input.province, input.postalCode, createdBy, JSON.stringify(raw)]);
      return { id: r.rows[0].id, refCode: r.rows[0].ref_code };
    },
    sendMail: async (to, subject, html) => { mails.push({ to, subject, html }); return { sent: true }; },
    mailShell: (title, intro, cta, url) => `<h1>${title}</h1>${intro}<a href="${url}">${cta}</a>`,
  });

  const app = express();
  app.use(express.json());
  const perms = { 'jo@x.com': ['opener:field'], 'autre@x.com': ['opener:field'], 'mgr@x.com': ['opener:routes'], 'rien@x.com': [] };
  app.use((req, _res, next) => { req.user = { email: req.headers['x-user'] }; next(); });
  const authenticateToken = (req, res, next) => (req.user.email ? next() : res.status(401).end());
  const hasPerm = async (req, p) => (perms[req.user.email] || []).includes(p);
  const requirePerm = async (req, res, p) => { if (await hasPerm(req, p)) return true; res.status(403).json({ error: 'forbidden' }); return false; };
  const lot0 = registerOpenerRoutes(app, { authenticateToken, requirePerm, pool, logActivity: async () => {},
    kaizen: { fetchAllStores: async () => [] }, google, kaizenConfigured: () => false });
  registerOpenerFieldRoutes(app, { authenticateToken, requirePerm, hasPerm, pool, logActivity: async () => {}, google, late, baseSchema: lot0.ensureReady });
  await lot0.ensureReady();

  // Le parc Cluster : un client actif et un ancien client, reliés à leur fiche Google.
  await pool.query(`INSERT INTO cluster_locations (source, source_key, name, active, place_id, match_status, software_version)
                    VALUES ('kaizen', 'k1', 'Resto Client', true, 'PLACE_CLIENT_0001', 'auto', 'v2'),
                           ('billing', 'b1', 'Ancien Client', false, 'PLACE_FORMER_0001', 'auto', 'v1')`);

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
  const today = ymdMtl();

  try {
    await t("verdict d'une visite : sur place, à distance, imprécise, sans position", async () => {
      assert.strictEqual(verdict(40, 12, 45.5), 'onsite');
      assert.strictEqual(verdict(150, 100, 45.5), 'onsite', 'seuils inclus');
      assert.strictEqual(verdict(151, 10, 45.5), 'far');
      assert.strictEqual(verdict(900, 500, 45.5), 'far', 'loin prime sur imprécis');
      assert.strictEqual(verdict(80, 250, 45.5), 'imprecise');
      assert.strictEqual(verdict(null, null, null), 'nogps');
      assert.strictEqual(verdict(80, 10, null), 'nogps');
    });

    await t('date de Montréal : 23 h 30 à Montréal = encore aujourd\'hui (pas demain UTC)', async () => {
      assert.strictEqual(ymdMtl(new Date('2026-10-07T03:30:00Z')), '2026-10-06');
      assert.strictEqual(addDays('2026-10-31', 1), '2026-11-01');
    });

    await t('permissions : manager ≠ opener', async () => {
      assert.strictEqual((await call('POST', '/api/opener/scan', { polygon: ZONE }, 'jo@x.com')).status, 403);
      assert.strictEqual((await call('GET', '/api/opener/today', undefined, 'mgr@x.com')).status, 403);
      assert.strictEqual((await call('GET', '/api/opener/config', undefined, 'rien@x.com')).status, 403);
      assert.strictEqual((await call('GET', '/api/opener/config', undefined, 'jo@x.com')).status, 200);
    });

    let scanned;
    await t('balayage : seulement DANS la zone, sans les fermés, avec le statut Cluster', async () => {
      const r = await call('POST', '/api/opener/scan', { polygon: ZONE });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      scanned = Object.fromEntries(r.body.places.map((p) => [p.placeId, p]));
      assert.ok(!scanned.PLACE_OUTSIDE_001, 'hors zone écarté');
      assert.ok(!scanned.PLACE_CLOSED_0001, 'fermé définitivement écarté');
      assert.strictEqual(scanned.PLACE_CLIENT_0001.status, 'client');
      assert.strictEqual(scanned.PLACE_CLIENT_0001.version, 'v2');
      assert.strictEqual(scanned.PLACE_FORMER_0001.status, 'former');
      assert.strictEqual(scanned.PLACE_NEW_000001.status, 'new');
      assert.strictEqual(scanned.PLACE_NEW_000001.serviceType, 'quick');
      assert.strictEqual(scanned.PLACE_CLIENT_0001.serviceType, 'both');
      assert.ok(r.body.calls > 0);
      assert.strictEqual(r.body.budget.calls, r.body.calls);
      const pl = (await pool.query(`SELECT lat, last_seen_in_scan FROM opener_places WHERE place_id = 'PLACE_NEW_000001'`)).rows[0];
      assert.ok(pl.lat && pl.last_seen_in_scan, 'fiche et coordonnées gardées (rien d\'autre)');
    });

    await t('balayage : même zone relancée dans l\'heure → mémoire, aucun appel payant', async () => {
      const before = nearbyCalls.length;
      const r = await call('POST', '/api/opener/scan', { polygon: ZONE });
      assert.strictEqual(r.body.calls, 0);
      assert.ok(r.body.fromCache > 0);
      assert.strictEqual(nearbyCalls.length, before);
    });

    await t('balayage : un cercle plein (20) est découpé en 4', async () => {
      full = true; nearbyCalls.length = 0;
      const shifted = ZONE.map(([a, b]) => [a + 0.05, b]);   // autre zone, pas en mémoire
      await call('POST', '/api/opener/scan', { polygon: shifted });
      full = false;
      const r0 = nearbyCalls[0].radius;
      assert.ok(nearbyCalls.some((c) => c.radius === r0 / 2), 'sous-cercles de rayon moitié');
    });

    await t('balayage : zone démesurée ou invalide refusée AVANT tout appel', async () => {
      const before = nearbyCalls.length;
      const huge = [[45.0, -74.0], [45.0, -73.0], [46.0, -73.0], [46.0, -74.0]];
      assert.strictEqual((await call('POST', '/api/opener/scan', { polygon: huge })).body.error, 'zone_too_large');
      assert.strictEqual((await call('POST', '/api/opener/scan', { polygon: [[1, 2]] })).body.error, 'invalid_polygon');
      assert.strictEqual(nearbyCalls.length, before);
    });

    await t('balayage : budget mensuel épuisé → 429, aucun appel', async () => {
      const saved = (await pool.query(`SELECT value FROM sync_state WHERE key = 'opener_scan_usage'`)).rows[0].value;
      await pool.query(`UPDATE sync_state SET value = $1 WHERE key = 'opener_scan_usage'`, [JSON.stringify({ month: today.slice(0, 7), calls: 999999 })]);
      const before = nearbyCalls.length;
      const r = await call('POST', '/api/opener/scan', { polygon: ZONE.map(([a, b]) => [a - 0.05, b]) });
      assert.strictEqual(r.status, 429);
      assert.strictEqual(nearbyCalls.length, before);
      await pool.query(`UPDATE sync_state SET value = $1 WHERE key = 'opener_scan_usage'`, [saved]);
    });

    await t('quartier / adresse : résultats avec coordonnées, mémoire 1 h, réservé au manager', async () => {
      let calls = 0;
      const real = google.searchText;
      google.searchText = async (q) => { calls++; return [{ displayName: { text: 'Plateau-Mont-Royal' }, formattedAddress: 'Montréal, QC', location: { latitude: 45.52, longitude: -73.58 } }, { displayName: { text: 'sans position' } }]; };
      const r = await call('GET', '/api/opener/geocode?q=Plateau');
      assert.deepStrictEqual(r.body.results, [{ name: 'Plateau-Mont-Royal', address: 'Montréal, QC', lat: 45.52, lng: -73.58 }]);
      await call('GET', '/api/opener/geocode?q=plateau');
      assert.strictEqual(calls, 1, 'même recherche (casse ignorée) → mémoire');
      assert.strictEqual((await call('GET', '/api/opener/geocode?q=Plateau', undefined, 'jo@x.com')).status, 403);
      assert.strictEqual((await call('GET', '/api/opener/geocode?q=ab')).status, 400);
      google.searchText = real;
    });

    await t('openers : les usagers dont un rôle porte opener:field, avec leur nom', async () => {
      const r = await call('GET', '/api/opener/openers');
      assert.deepStrictEqual(r.body.openers.map((o) => o.email).sort(), ['autre@x.com', 'jo@x.com']);
      assert.strictEqual(r.body.openers.find((o) => o.email === 'jo@x.com').name, 'Jonathan Opener');
    });

    let route;
    const stopsBody = ['PLACE_CLIENT_0001', 'PLACE_NEW_000001', 'PLACE_FORMER_0001', 'PLACE_NEW_000001'].map((pid) => ({
      placeId: pid, name: scanned[pid].name, address: scanned[pid].address, lat: scanned[pid].lat, lng: scanned[pid].lng }));
    await t('route : création du brouillon, doublons d\'arrêts retirés, statut des arrêts', async () => {
      const r = await call('POST', '/api/opener/routes', { name: 'Plateau', date: today, zone: ZONE, stops: stopsBody });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      route = r.body.route;
      assert.strictEqual(route.status, 'draft');
      assert.strictEqual(route.stops.length, 3);
      assert.deepStrictEqual(route.stops.map((s) => s.position), [1, 2, 3]);
      assert.strictEqual(route.stops[0].status, 'client');
      assert.strictEqual(route.date, today, 'la date revient telle quelle (aucun décalage de fuseau)');
    });

    await t('route : autosave avec verrou de version', async () => {
      let r = await call('PUT', `/api/opener/routes/${route.id}`, { openerEmail: 'jo@x.com', version: route.version });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.route.version, route.version + 1);
      r = await call('PUT', `/api/opener/routes/${route.id}`, { name: 'Vieux', version: route.version });
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.body.error, 'version_conflict');
      route = (await call('GET', `/api/opener/routes/${route.id}`)).body.route;
      assert.strictEqual(route.openerName, 'Jonathan Opener');
    });

    await t('publication : exige un opener et des arrêts ; courriel à l\'opener ; double publication refusée', async () => {
      const empty = (await call('POST', '/api/opener/routes', { name: 'Vide', date: today, openerEmail: 'jo@x.com' })).body.route;
      assert.strictEqual((await call('POST', `/api/opener/routes/${empty.id}/publish`)).body.error, 'stops_required');
      const r = await call('POST', `/api/opener/routes/${route.id}/publish`);
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.route.status, 'published');
      assert.strictEqual(r.body.emailSent, true);
      assert.strictEqual(mails[0].to, 'jo@x.com');
      assert.ok(mails[0].html.includes('Tout Neuf') && mails[0].html.includes('/opener'));
      const other = (await call('POST', '/api/opener/routes', { name: 'Doublon', date: today, openerEmail: 'jo@x.com', stops: stopsBody.slice(0, 1) })).body.route;
      assert.strictEqual((await call('POST', `/api/opener/routes/${other.id}/publish`)).body.error, 'opener_has_route');
      assert.strictEqual((await call('PUT', `/api/opener/routes/${route.id}`, { name: 'x' })).body.error, 'not_draft', 'publiée = verrouillée');
      assert.strictEqual((await call('DELETE', `/api/opener/routes/${other.id}`)).status, 200);
      assert.strictEqual((await call('DELETE', `/api/opener/routes/${route.id}`)).status, 409);
    });

    await t('terrain : l\'opener voit SA route du jour, un autre opener non', async () => {
      const mine = await call('GET', '/api/opener/today', undefined, 'jo@x.com');
      assert.strictEqual(mine.body.route.id, route.id);
      const theirs = await call('GET', '/api/opener/today', undefined, 'autre@x.com');
      assert.strictEqual(theirs.body.route, null);
    });

    await t('fiche : Google lu à la demande puis gardé UNE heure en mémoire ; préremplissage', async () => {
      const r = await call('GET', '/api/opener/place/PLACE_NEW_000001', undefined, 'jo@x.com');
      assert.strictEqual(r.body.google.rating, 4.6);
      assert.strictEqual(r.body.google.openNow, true);
      assert.strictEqual(r.body.google.province, 'QC');
      assert.strictEqual(r.body.google.postalCode, 'H2J 1A1');
      assert.strictEqual(r.body.cluster.status, 'new');
      await call('GET', '/api/opener/place/PLACE_NEW_000001', undefined, 'jo@x.com');
      assert.strictEqual(detailsCalls.filter((p) => p === 'PLACE_NEW_000001').length, 1);
    });

    const stopNew = () => route.stops.find((s) => s.placeId === 'PLACE_NEW_000001');
    const ck = { id: crypto.randomUUID(), placeId: 'PLACE_NEW_000001', currentPos: 'Lightspeed', serviceType: 'both', terminals: 3,
      onlineDelivery: true, decisionMaker: 'yes', interest: 4, services: ['pos', 'payments', 'bidon'], notes: 'Propriétaire sur place',
      lat: IN(3)[0] + 0.0005, lng: IN(3)[1], accuracy: 12 };
    await t('check-in : champs obligatoires, distance calculée, arrêt complété', async () => {
      assert.strictEqual((await call('POST', '/api/opener/checkins', { ...ck, currentPos: '' }, 'jo@x.com')).body.error, 'current_pos_required');
      assert.strictEqual((await call('POST', '/api/opener/checkins', { ...ck, interest: 9 }, 'jo@x.com')).body.error, 'interest_required');
      const r = await call('POST', '/api/opener/checkins', { ...ck, stopId: stopNew().id }, 'jo@x.com');
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.ok(r.body.distanceM > 40 && r.body.distanceM < 70, String(r.body.distanceM));
      const row = (await pool.query(`SELECT services, user_name FROM opener_checkins WHERE id = $1`, [ck.id])).rows[0];
      assert.deepStrictEqual(row.services, ['pos', 'payments'], 'valeur inconnue écartée');
      assert.strictEqual(row.user_name, 'Jonathan Opener');
      route = (await call('GET', `/api/opener/routes/${route.id}`)).body.route;
      assert.strictEqual(stopNew().outcome, 'done');
      assert.strictEqual(stopNew().status, 'prospect', 'visité = prospect');
    });

    await t('check-in : renvoyé par la file hors ligne → une seule ligne ; l\'arrêt d\'un autre est refusé', async () => {
      const r = await call('POST', '/api/opener/checkins', { ...ck, stopId: stopNew().id }, 'jo@x.com');
      assert.strictEqual(r.body.duplicate, true);
      assert.strictEqual((await pool.query(`SELECT COUNT(*)::int AS n FROM opener_checkins`)).rows[0].n, 1);
      const other = await call('POST', '/api/opener/checkins', { ...ck, id: crypto.randomUUID(), stopId: stopNew().id }, 'autre@x.com');
      assert.strictEqual(other.body.error, 'invalid_stop');
      const stolen = await call('POST', '/api/opener/checkins', { ...ck, stopId: stopNew().id }, 'autre@x.com');
      assert.strictEqual(stolen.status, 409, 'un identifiant déjà pris par quelqu\'un d\'autre');
    });

    let lead;
    const leadBody = { clientRef: crypto.randomUUID(), placeId: 'PLACE_NEW_000001', checkinId: ck.id, businessName: 'Tout Neuf',
      address: '123 Rue Neuve', city: 'Montréal', province: 'QC', postalCode: 'H2J 1A1', interest: ['pos', 'beverage_control', 'xx'],
      notes: 'Rappeler lundi', language: 'fr' };
    await t('piste : source walk_in, détail « Opener · route · date », adresse dans les notes, liée au check-in', async () => {
      const r = await call('POST', '/api/opener/leads', { ...leadBody, stopId: stopNew().id }, 'jo@x.com');
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      lead = r.body;
      const row = (await pool.query(`SELECT * FROM leads WHERE id = $1`, [lead.id])).rows[0];
      assert.strictEqual(row.source, 'walk_in');
      assert.strictEqual(row.source_detail, `Opener · Plateau · ${today}`);
      assert.deepStrictEqual(row.interest, ['pos', 'beverage_control']);
      assert.ok(row.notes.startsWith('Adresse : 123 Rue Neuve'));
      assert.strictEqual(row.raw.via, 'opener');
      assert.strictEqual((await pool.query(`SELECT lead_id FROM opener_checkins WHERE id = $1`, [ck.id])).rows[0].lead_id, lead.id);
      const st = (await call('GET', '/api/opener/place/PLACE_NEW_000001', undefined, 'jo@x.com')).body.cluster;
      assert.strictEqual(st.lead.refCode, lead.refCode);
    });

    await t('piste : renvoyée deux fois → une seule piste, même numéro', async () => {
      const r = await call('POST', '/api/opener/leads', { ...leadBody, stopId: stopNew().id }, 'jo@x.com');
      assert.strictEqual(r.body.duplicate, true);
      assert.strictEqual(r.body.refCode, lead.refCode);
      assert.strictEqual((await pool.query(`SELECT COUNT(*)::int AS n FROM leads`)).rows[0].n, 1);
    });

    await t('mes pistes : seulement celles de l\'opener, créées sur le terrain', async () => {
      const r = await call('GET', '/api/opener/my-leads', undefined, 'jo@x.com');
      assert.strictEqual(r.body.leads.length, 1);
      assert.strictEqual(r.body.leads[0].level, 4);
      assert.strictEqual((await call('GET', '/api/opener/my-leads', undefined, 'autre@x.com')).body.leads.length, 0);
    });

    await t('non visité : raison obligatoire, annulable ; un arrêt fait ne se saute pas', async () => {
      const former = route.stops.find((s) => s.placeId === 'PLACE_FORMER_0001');
      assert.strictEqual((await call('POST', `/api/opener/stops/${former.id}/skip`, { reason: 'x' }, 'jo@x.com')).body.error, 'invalid_reason');
      assert.strictEqual((await call('POST', `/api/opener/stops/${former.id}/skip`, { reason: 'closed' }, 'jo@x.com')).status, 200);
      assert.strictEqual((await call('POST', `/api/opener/stops/${stopNew().id}/skip`, { reason: 'closed' }, 'jo@x.com')).body.error, 'already_done');
      assert.strictEqual((await call('POST', `/api/opener/stops/${former.id}/skip`, { reason: 'closed' }, 'autre@x.com')).status, 404);
    });

    await t('dépublier : refusé dès que l\'opener a commencé', async () => {
      assert.strictEqual((await call('POST', `/api/opener/routes/${route.id}/unpublish`)).body.error, 'route_started');
    });

    await t('journée : check-ins, pistes, décideurs, non visités', async () => {
      const r = await call('GET', '/api/opener/day', undefined, 'jo@x.com');
      const s = r.body.stats;
      assert.deepStrictEqual([s.stops, s.done, s.skipped, s.checkins, s.leads, s.decisionMakers], [3, 1, 1, 1, 1, 1]);
      assert.strictEqual(r.body.leads[0].refCode, lead.refCode);
      assert.deepStrictEqual(r.body.notVisited.map((x) => x.name).sort(), ['Ancien Client', 'Resto Client']);
    });

    await t('reporter à demain : les non visités vont sur la route du lendemain, une seule fois', async () => {
      const r = await call('POST', `/api/opener/routes/${route.id}/postpone`, {}, 'jo@x.com');
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.moved, 2);
      assert.strictEqual(r.body.date, addDays(today, 1));
      const tomorrow = (await call('GET', `/api/opener/today?date=${addDays(today, 1)}`, undefined, 'jo@x.com')).body.route;
      assert.strictEqual(tomorrow.status, 'published');
      assert.strictEqual(tomorrow.stops.length, 2);
      const again = await call('POST', `/api/opener/routes/${route.id}/postpone`, {}, 'jo@x.com');
      assert.strictEqual(again.body.moved, 0, 'aucun doublon');
    });

    await t('terminer la journée : la route se ferme, une seule fois, par son opener seulement', async () => {
      assert.strictEqual((await call('POST', `/api/opener/routes/${route.id}/close`, {}, 'autre@x.com')).status, 409);
      assert.strictEqual((await call('POST', `/api/opener/routes/${route.id}/close`, {}, 'jo@x.com')).status, 200);
      assert.strictEqual((await call('POST', `/api/opener/routes/${route.id}/close`, {}, 'jo@x.com')).status, 409);
      assert.strictEqual((await call('GET', '/api/opener/today', undefined, 'jo@x.com')).body.route.status, 'closed', 'toujours visible, fermée');
    });

    await t('suivi : avancement par route et dernier check-in (« où il est rendu »)', async () => {
      const r = await call('GET', `/api/opener/routes-overview?from=${today}&to=${addDays(today, 1)}`);
      assert.strictEqual(r.status, 200);
      const mine = r.body.routes.find((x) => x.id === route.id);
      assert.deepStrictEqual([mine.total, mine.done, mine.skipped], [3, 1, 2]);
      assert.strictEqual(mine.lastCheckin.stopName, 'Tout Neuf');
      assert.ok(mine.lastCheckin.lat && mine.lastCheckin.at);
      assert.strictEqual(mine.openerName, 'Jonathan Opener');
      const visited = mine.stops.find((s) => s.outcome === 'done');
      assert.strictEqual(visited.checkin.verdict, 'onsite', 'check-in à ~55 m, précision 12 m');
      assert.ok(visited.checkin.distanceM > 40 && visited.checkin.distanceM < 70);
      assert.deepStrictEqual(mine.verdicts, { onsite: 1 });
      assert.ok(r.body.routes.some((x) => x.date === addDays(today, 1)), 'la route du lendemain (reportée) est dans la période');
      assert.strictEqual((await call('GET', '/api/opener/routes-overview', undefined, 'jo@x.com')).status, 403);
    });

    await t('durée de la visite : arrivée → départ ; le verdict suit la position À L\'ARRIVÉE', async () => {
      const d3 = addDays(today, 3);
      const client = scanned.PLACE_CLIENT_0001;
      let r = (await call('POST', '/api/opener/routes', { name: 'Durées', date: d3, openerEmail: 'autre@x.com',
        stops: [{ placeId: client.placeId, name: client.name, lat: client.lat, lng: client.lng }, { placeId: 'PLACE_NEW_000001', name: 'Tout Neuf', lat: IN(3)[0], lng: IN(3)[1] }] })).body.route;
      await call('POST', `/api/opener/routes/${r.id}/publish`);
      const [s1, s2] = r.stops;
      const end = new Date();
      const start = new Date(end.getTime() - 17 * 60000);
      // Arrivé devant le restaurant, reparti à ~400 m avant d'enregistrer.
      const res1 = await call('POST', '/api/opener/checkins', { ...ck, id: crypto.randomUUID(), placeId: client.placeId, stopId: s1.id,
        at: end.toISOString(), lat: client.lat + 0.0036, lng: client.lng, accuracy: 8,
        startedAt: start.toISOString(), startLat: client.lat + 0.0001, startLng: client.lng, startAccuracy: 9 }, 'autre@x.com');
      assert.strictEqual(res1.status, 200, JSON.stringify(res1.body));
      assert.strictEqual(res1.body.durationMin, 17);
      assert.ok(res1.body.distanceM < 30, 'distance À L\'ARRIVÉE');
      // Arrivée incohérente (après le départ) : ignorée, pas de durée.
      await call('POST', '/api/opener/checkins', { ...ck, id: crypto.randomUUID(), placeId: 'PLACE_NEW_000001', stopId: s2.id,
        at: end.toISOString(), startedAt: new Date(end.getTime() + 60000).toISOString(), startLat: 1, startLng: 1 }, 'autre@x.com');
      const ov = (await call('GET', `/api/opener/routes-overview?from=${d3}&to=${d3}`)).body.routes.find((x) => x.id === r.id);
      const c1 = ov.stops.find((s) => s.id === s1.id).checkin;
      assert.strictEqual(c1.durationMin, 17);
      assert.strictEqual(c1.verdict, 'onsite', 'parti avant d\'enregistrer : la visite reste « sur place »');
      assert.ok(c1.endDistanceM > 350, 'mais la distance au départ est gardée');
      assert.ok(new Date(c1.startedAt).getTime() === start.getTime());
      assert.strictEqual(ov.stops.find((s) => s.id === s2.id).checkin.durationMin, null);
      assert.strictEqual(ov.visitMinutes, 17);
      r = (await call('GET', `/api/opener/routes/${r.id}`)).body.route;
      assert.strictEqual(r.stops[0].checkin.durationMin, 17);
      const day = (await call('GET', `/api/opener/day?date=${today}`, undefined, 'autre@x.com')).body.stats;
      assert.ok(day.visitMinutes === 0 || day.visitMinutes === 17);
      const hist = (await call('GET', `/api/opener/place/${client.placeId}`, undefined, 'autre@x.com')).body.history;
      assert.strictEqual(hist[0].durationMin, 17);
    });

    await t('liste des routes du manager : comptes d\'arrêts et de visites', async () => {
      const r = await call('GET', '/api/opener/routes');
      const mine = r.body.routes.find((x) => x.id === route.id);
      assert.deepStrictEqual([mine.stops, mine.done, mine.status], [3, 1, 'closed']);
    });

    console.log(`field : ${n} tests OK (${nearbyCalls.length} appels Nearby simulés dans le dernier lot)`);
  } finally {
    server.close();
    await db.close();
  }
})().catch((e) => { console.error('ÉCHEC :', e); process.exit(1); });
