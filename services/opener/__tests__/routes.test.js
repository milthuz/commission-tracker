// Lot 0 de bout en bout, contre une vraie base Postgres en mémoire (PGlite) et un vrai serveur
// HTTP. Kaizen et Google sont simulés.
//   npm install --no-save @electric-sql/pglite   (une fois)
//   node services/opener/__tests__/routes.test.js
//
// ⚠️ Échoue si PGlite est absent plutôt que de se déclarer vert (voir feedback-verify-the-harness).
const assert = require('assert');
const http = require('http');
const express = require('express');
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { console.error('ÉCHEC : @electric-sql/pglite manquant (npm install --no-save @electric-sql/pglite)'); process.exit(1); }
const { registerOpenerRoutes } = require('../routes');

const U = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const kStore = (i, name, street, postal, extra = {}) => ({
  uuid: U(i), name, store_id: `ORG-${i}`,
  address: { street, unit: '', city: 'Montreal', region: 'Quebec', postalCode: postal, country: 'Canada' },
  active: true, ...extra,
});
const gPlace = (id, name, postal, num, extra = {}) => ({
  id, displayName: { text: name }, formattedAddress: `${num} Rue, Montréal ${postal}`,
  location: { latitude: 45.5, longitude: -73.6 },
  addressComponents: [{ types: ['street_number'], shortText: num }, { types: ['postal_code'], shortText: postal }],
  ...extra,
});

(async () => {
  const db = new PGlite();
  const pool = { query: (q, p) => db.query(q, p).then((r) => ({ ...r, rowCount: r.affectedRows ?? r.rows.length })) };
  await db.exec(`
    CREATE TABLE sync_state (key VARCHAR(100) PRIMARY KEY, value TEXT, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE activity_log (id SERIAL, entity_type TEXT, entity_id TEXT, event_type TEXT, description TEXT, actor TEXT, metadata JSONB);
  `);

  // --- Kaizen simulé : le parc change d'un appel à l'autre.
  let parc = [
    kStore(1, 'Restaurant Saoko Inc.', '4520 Rue Saint-Denis', 'H2J 2L3'),
    kStore(2, 'Pizza Nova', '100 Rue Laurier', 'H2T 1A1'),          // deux candidats ambigus
    kStore(3, 'Entrepôt test', '', '', { address: {} }),             // sans adresse
    kStore(4, 'Bistro Fermé', '9 Rue Rachel', 'H2W 1A1', { active: false }),
    kStore(5, 'Introuvable', '1 Rue Nulle', 'H0H 0H0'),
  ];
  let kaizenCalls = 0;
  const kaizen = { fetchAllStores: async () => { kaizenCalls++; return parc.concat([{ uuid: 'pas-un-uuid' }]); } };

  // --- Google simulé : réponses par mot-clé de la requête.
  const googleCalls = [];
  const db_g = {
    Saoko: [gPlace('PLACE_SAOKO_0001', 'Saoko', 'H2J 2L3', '4520'), gPlace('PLACE_SAOKO_9999', 'Saoko Centre-Ville', 'H3B 1A1', '1000')],
    'Pizza Nova': [gPlace('PLACE_NOVA_00001', 'Pizza Nova', 'H2T 1A1', '100'), gPlace('PLACE_NOVA_00002', 'Pizza Nova', 'H2T 1A1', '100')],
    Bistro: [gPlace('PLACE_BISTRO_001', 'Bistro Fermé', 'H2W 1A1', '9')],
    Introuvable: [],
  };
  const google = {
    configured: () => true,
    searchText: async (q) => { googleCalls.push(q); const k = Object.keys(db_g).find((x) => q.includes(x)); return k ? db_g[k] : []; },
    details: async (id) => Object.values(db_g).flat().find((p) => p.id === id) || null,
  };

  const app = express();
  app.use(express.json());
  const perms = { 'admin@x.com': ['opener:match'], 'rep@x.com': [] };
  app.use((req, _res, next) => { req.user = { email: req.headers['x-user'] }; next(); });
  const authenticateToken = (req, res, next) => (req.user.email ? next() : res.status(401).end());
  const requirePerm = async (req, res, p) => {
    if ((perms[req.user.email] || []).includes(p)) return true;
    res.status(403).json({ error: 'forbidden' }); return false;
  };
  const logs = [];
  const logActivity = async (...a) => { logs.push(a); };
  const mod = registerOpenerRoutes(app, { authenticateToken, requirePerm, pool, logActivity, kaizen, google, kaizenConfigured: () => true });

  const server = http.createServer(app).listen(0);
  const port = server.address().port;
  const call = (method, path, body, user = 'admin@x.com') => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ port, path, method, headers: { 'x-user': user, 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => resolve({ status: res.statusCode, body: s ? JSON.parse(s) : null }));
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });

  let n = 0;
  const t = async (name, fn) => { await fn(); n++; console.log('  ✓', name); };

  try {
    await t('sans opener:match → 403 partout', async () => {
      assert.strictEqual((await call('GET', '/api/opener/kaizen/status', null, 'rep@x.com')).status, 403);
      assert.strictEqual((await call('GET', '/api/opener/kaizen/stores', null, 'rep@x.com')).status, 403);
      assert.strictEqual((await call('POST', '/api/opener/kaizen/sync', {}, 'rep@x.com')).status, 403);
    });

    let out;
    await t('synchro + appariement : chaque magasin dans le bon statut', async () => {
      out = await mod.runAll({ source: 'test' });
      assert.strictEqual(out.sync.fetched, 6);
      assert.strictEqual(out.sync.rejected, 1, 'la ligne sans uuid valide est rejetée');
      assert.strictEqual(out.sync.inserted, 5);
      const st = Object.fromEntries((await pool.query(`SELECT uuid::text, match_status, place_id FROM kaizen_stores`)).rows.map((r) => [r.uuid, r]));
      assert.strictEqual(st[U(1)].match_status, 'auto');
      assert.strictEqual(st[U(1)].place_id, 'PLACE_SAOKO_0001');
      assert.strictEqual(st[U(2)].match_status, 'review', 'deux fiches presque identiques → humain');
      assert.strictEqual(st[U(3)].match_status, 'no_address');
      assert.strictEqual(st[U(4)].match_status, 'auto', 'un inactif s\'apparie aussi (ancien client)');
      assert.strictEqual(st[U(5)].match_status, 'none');
      assert.ok(!googleCalls.some((q) => q.includes('Entrepôt')), 'aucun appel Google sans adresse');
      const pl = (await pool.query(`SELECT * FROM opener_places WHERE place_id = 'PLACE_SAOKO_0001'`)).rows[0];
      assert.ok(pl && pl.lat === 45.5 && pl.coords_refreshed_at, 'coordonnées gardées avec leur date');
    });

    await t('les actifs passent avant les inactifs dans le budget', async () => {
      const first = googleCalls[0];
      assert.ok(!first.includes('Bistro'));
    });

    await t('statut : compteurs et dernier passage', async () => {
      const r = await call('GET', '/api/opener/kaizen/status');
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.counts.auto, 2);
      assert.strictEqual(r.body.counts.review, 1);
      assert.strictEqual(r.body.totals.active, 4);
      assert.strictEqual(r.body.totals.inactive, 1);
      assert.strictEqual(r.body.running, false);
      assert.strictEqual(r.body.lastRun.source, 'test');
    });

    await t('liste « à traiter » : review d\'abord, candidats inclus', async () => {
      const r = await call('GET', '/api/opener/kaizen/stores?status=todo');
      assert.strictEqual(r.body.total, 3);
      assert.strictEqual(r.body.stores[0].status, 'review');
      assert.strictEqual(r.body.stores[0].candidates.length, 2);
      assert.ok(r.body.stores[0].candidates[0].googleName);
      const q = await call('GET', '/api/opener/kaizen/stores?q=h2j2l3');
      assert.strictEqual(q.body.total, 1, 'recherche par code postal sans espace');
    });

    await t('confirmer un candidat → manuel, coordonnées, journal', async () => {
      const r = await call('POST', `/api/opener/kaizen/stores/${U(2)}/confirm`, { placeId: 'PLACE_NOVA_00002' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.store.status, 'manual');
      assert.strictEqual(r.body.store.candidates.length, 0, 'les données Google en attente sont effacées');
      assert.strictEqual(r.body.store.lat, 45.5);
      assert.ok(logs.some((l) => l[2] === 'matched' && l[1] === U(2)));
      const bad = await call('POST', `/api/opener/kaizen/stores/${U(2)}/confirm`, { placeId: 'PLACE_INEXISTANT' });
      assert.strictEqual(bad.status, 400);
      assert.strictEqual((await call('POST', `/api/opener/kaizen/stores/pas-un-uuid/confirm`, { placeId: 'PLACE_NOVA_00002' })).status, 404);
    });

    await t('ignorer et remettre en file', async () => {
      assert.strictEqual((await call('POST', `/api/opener/kaizen/stores/${U(3)}/ignore`, { reason: 'Magasin test' })).status, 200);
      let row = (await pool.query(`SELECT match_status, match_note FROM kaizen_stores WHERE uuid = $1`, [U(3)])).rows[0];
      assert.deepStrictEqual([row.match_status, row.match_note], ['ignored', 'Magasin test']);
      assert.strictEqual((await call('POST', `/api/opener/kaizen/stores/${U(5)}/reset`)).status, 200);
      row = (await pool.query(`SELECT match_status FROM kaizen_stores WHERE uuid = $1`, [U(5)])).rows[0];
      assert.strictEqual(row.match_status, 'pending');
    });

    await t('2e synchro : manuel et ignoré intacts ; adresse changée → auto remis en jeu', async () => {
      parc = parc.map((s) => (s.uuid === U(1) ? { ...s, address: { ...s.address, street: '4600 Rue Saint-Denis' } } : s));
      parc = parc.map((s) => (s.uuid === U(2) ? { ...s, address: { ...s.address, street: '102 Rue Laurier' } } : s));
      const before = googleCalls.length;
      out = await mod.runAll({ source: 'test2' });
      assert.strictEqual(out.sync.inserted, 0);
      const st = Object.fromEntries((await pool.query(`SELECT uuid::text, match_status, place_id, match_note FROM kaizen_stores`)).rows.map((r) => [r.uuid, r]));
      assert.strictEqual(st[U(2)].match_status, 'manual', 'décision humaine conservée');
      assert.strictEqual(st[U(2)].place_id, 'PLACE_NOVA_00002');
      assert.ok(/Adresse modifiée/.test(st[U(2)].match_note), 'mais signalée');
      assert.strictEqual(st[U(3)].match_status, 'ignored');
      assert.ok(googleCalls.slice(before).some((q) => q.includes('4600')), 'Saoko recherché à sa nouvelle adresse');
      assert.ok(!googleCalls.slice(before).some((q) => q.includes('Introuvable') && false));
    });

    await t('« none » n\'est pas retenté avant 30 jours', async () => {
      await pool.query(`UPDATE kaizen_stores SET match_status = 'none', match_attempted_at = CURRENT_TIMESTAMP WHERE uuid = $1`, [U(5)]);
      const before = googleCalls.length;
      await mod.runAll({ source: 'test3' });
      assert.ok(!googleCalls.slice(before).some((q) => q.includes('Introuvable')));
      await pool.query(`UPDATE kaizen_stores SET match_attempted_at = CURRENT_TIMESTAMP - INTERVAL '31 days' WHERE uuid = $1`, [U(5)]);
      await mod.runAll({ source: 'test4' });
      assert.ok(googleCalls.slice(before).some((q) => q.includes('Introuvable')));
    });

    await t('magasin disparu de Kaizen → missing_since, jamais supprimé', async () => {
      parc = parc.filter((s) => s.uuid !== U(5));
      out = await mod.runAll({ source: 'test5' });
      assert.strictEqual(out.sync.missing, 1);
      const row = (await pool.query(`SELECT missing_since FROM kaizen_stores WHERE uuid = $1`, [U(5)])).rows[0];
      assert.ok(row && row.missing_since);
      const r = await call('GET', '/api/opener/kaizen/stores?status=missing');
      assert.strictEqual(r.body.total, 1);
      parc.push(kStore(5, 'Introuvable', '1 Rue Nulle', 'H0H 0H0'));
      await mod.runAll({ source: 'test6' });
      assert.strictEqual((await pool.query(`SELECT missing_since FROM kaizen_stores WHERE uuid = $1`, [U(5)])).rows[0].missing_since, null, 'revenu → plus disparu');
    });

    await t('réponse Kaizen réduite de moitié → personne n\'est marqué disparu', async () => {
      const big = Array.from({ length: 30 }, (_, i) => kStore(100 + i, `Resto ${i}`, `${i} Rue A`, 'H1A 1A1'));
      parc = parc.concat(big);
      await mod.runAll({ source: 'big' });
      const keep = parc;
      parc = parc.slice(0, 10);
      out = await mod.runAll({ source: 'partial' });
      assert.strictEqual(out.sync.missingSkipped, true);
      assert.strictEqual(out.sync.missing, 0);
      parc = keep;
    });

    await t('Kaizen en panne → erreur rapportée, base intacte, verrou relâché', async () => {
      const real = kaizen.fetchAllStores;
      kaizen.fetchAllStores = async () => { throw new Error('Kaizen connexion : HTTP 401 — bad credentials'); };
      const count = (await pool.query(`SELECT COUNT(*)::int AS n FROM kaizen_stores WHERE missing_since IS NULL`)).rows[0].n;
      out = await mod.runAll({ source: 'down' });
      assert.ok(/401/.test(out.syncError));
      assert.strictEqual((await pool.query(`SELECT COUNT(*)::int AS n FROM kaizen_stores WHERE missing_since IS NULL`)).rows[0].n, count);
      assert.strictEqual((await pool.query(`SELECT value FROM sync_state WHERE key = 'kaizen_sync_lock'`)).rows[0].value, 'idle');
      kaizen.fetchAllStores = real;
    });

    await t('verrou : une 2e synchro simultanée est refusée', async () => {
      await pool.query(`UPDATE sync_state SET value = 'running', updated_at = CURRENT_TIMESTAMP WHERE key = 'kaizen_sync_lock'`);
      assert.strictEqual(await mod.runAll({ source: 'concurrent' }), null);
      assert.strictEqual((await call('POST', '/api/opener/kaizen/sync', {})).status, 409);
      // Un verrou abandonné depuis plus de 30 minutes ne bloque plus.
      await pool.query(`UPDATE sync_state SET updated_at = CURRENT_TIMESTAMP - INTERVAL '31 minutes' WHERE key = 'kaizen_sync_lock'`);
      assert.ok(await mod.runAll({ source: 'stale' }));
    });

    await t('passage planifié : sauté si le dernier date de moins de 20 h (redémarrages du worker)', async () => {
      const before = kaizenCalls;
      await mod.runNightly();
      assert.strictEqual(kaizenCalls, before, 'aucun appel juste après un passage');
      await pool.query(`UPDATE sync_state SET updated_at = CURRENT_TIMESTAMP - INTERVAL '21 hours' WHERE key = 'kaizen_last_ok'`);
      await mod.runNightly();
      assert.strictEqual(kaizenCalls, before + 1);
    });

    await t('un passage EN ÉCHEC (identifiants absents) ne repousse pas le suivant', async () => {
      await pool.query(`UPDATE sync_state SET updated_at = CURRENT_TIMESTAMP - INTERVAL '21 hours' WHERE key = 'kaizen_last_ok'`);
      const real = kaizen.fetchAllStores;
      kaizen.fetchAllStores = async () => { throw new Error('Kaizen : identifiants absents'); };
      await mod.runNightly();                      // échoue
      kaizen.fetchAllStores = real;
      const before = kaizenCalls;
      await mod.runNightly();                      // identifiants ajoutés → doit tourner tout de suite
      assert.strictEqual(kaizenCalls, before + 1);
    });

    await t('Google non activé → passage arrêté au premier échec', async () => {
      const real = google.searchText;
      let calls = 0;
      google.searchText = async () => { calls++; throw new Error("Google : « Places API (New) » n'est pas activée sur la clé GOOGLE_PLACES_API_KEY"); };
      await pool.query(`UPDATE kaizen_stores SET match_status = 'pending' WHERE match_status = 'auto'`);
      out = await mod.runAll({ source: 'nokey' });
      assert.strictEqual(calls, 1);
      assert.strictEqual(out.match.aborted, true);
      google.searchText = real;
    });

    console.log(`routes : ${n} tests OK (${kaizenCalls} appels Kaizen, ${googleCalls.length} appels Google simulés)`);
  } finally {
    server.close();
    await db.close();
  }
})().catch((e) => { console.error('ÉCHEC :', e); process.exit(1); });
