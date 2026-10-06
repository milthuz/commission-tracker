// Client Kaizen : pagination, reconnexion, réponses aberrantes.   node services/opener/__tests__/kaizen.test.js
const assert = require('assert');
const { createKaizenClient, normalizeStore, PAGE } = require('../kaizen');

const env = { KAIZEN_API_EMAIL: 'svc@cluster', KAIZEN_API_PASSWORD: 'S3cret!pw', KAIZEN_API_BASE: 'https://k.test/api' };
const store = (i) => ({ uuid: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name: `S${i}`, address: {}, active: true });

function fakeHttp({ total, failOnce401AtSkip = null, notAList = false, loginFails = false }) {
  const log = { logins: 0, gets: [] };
  let tokenN = 0;
  let failed = false;
  return {
    log,
    post: async (url, body) => {
      assert.ok(url.endsWith('/public/v1/auth/login'));
      log.logins++;
      if (loginFails) { const e = new Error('Request failed'); e.response = { status: 401, data: { message: 'Invalid credentials' } }; e.config = { data: JSON.stringify(body) }; throw e; }
      return { data: { token: `T${++tokenN}` } };
    },
    get: async (url, { params, headers }) => {
      log.gets.push({ skip: params.$skip, auth: headers.Authorization, params });
      if (failOnce401AtSkip === params.$skip && !failed) { failed = true; const e = new Error('401'); e.response = { status: 401 }; throw e; }
      if (notAList) return { data: { error: 'maintenance' } };
      const n = Math.max(0, Math.min(PAGE, total - params.$skip));
      return { data: Array.from({ length: n }, (_, i) => store(params.$skip + i)) };
    },
  };
}

(async () => {
  let n = 0;
  const t = async (name, fn) => { await fn(); n++; console.log('  ✓', name); };

  await t('pagine par 1 000 jusqu\'à une page incomplète, actifs et inactifs, triés par Uuid', async () => {
    const http = fakeHttp({ total: 2345 });
    const rows = await createKaizenClient({ http, env }).fetchAllStores();
    assert.strictEqual(rows.length, 2345);
    assert.deepStrictEqual(http.log.gets.map((g) => g.skip), [0, 1000, 2000]);
    const p = http.log.gets[0].params;
    assert.strictEqual(p.$top, 1000); assert.strictEqual(p.$orderby, 'Uuid'); assert.strictEqual(p.includeInactive, true);
    assert.strictEqual(http.log.gets[0].auth, 'Bearer T1');
  });

  await t('exactement 1 000 → demande une page de plus (vide) avant de s\'arrêter', async () => {
    const http = fakeHttp({ total: 1000 });
    assert.strictEqual((await createKaizenClient({ http, env }).fetchAllStores()).length, 1000);
    assert.strictEqual(http.log.gets.length, 2);
  });

  await t('401 en cours de route → une reconnexion, la page est refaite', async () => {
    const http = fakeHttp({ total: 1500, failOnce401AtSkip: 1000 });
    const rows = await createKaizenClient({ http, env }).fetchAllStores();
    assert.strictEqual(rows.length, 1500);
    assert.strictEqual(http.log.logins, 2);
    assert.strictEqual(http.log.gets.at(-1).auth, 'Bearer T2');
  });

  await t('réponse qui n\'est pas une liste → échec (jamais « zéro magasin »)', async () => {
    await assert.rejects(createKaizenClient({ http: fakeHttp({ total: 5, notAList: true }), env }).fetchAllStores(), /pas une liste/);
  });

  await t('connexion refusée → message sans le mot de passe', async () => {
    const err = await createKaizenClient({ http: fakeHttp({ total: 0, loginFails: true }), env }).fetchAllStores().catch((e) => e);
    assert.match(err.message, /HTTP 401/);
    assert.ok(!err.message.includes(env.KAIZEN_API_PASSWORD));
  });

  await t('sans identifiants → erreur claire, aucun appel', async () => {
    const http = fakeHttp({ total: 1 });
    await assert.rejects(createKaizenClient({ http, env: {} }).fetchAllStores(), /absents/);
    assert.strictEqual(http.log.logins, 0);
  });

  await t('normalizeStore : uuid obligatoire, champs bornés, active par défaut', async () => {
    assert.strictEqual(normalizeStore({ name: 'x' }), null);
    const s = normalizeStore({ uuid: store(1).uuid.toUpperCase(), name: '  ', address: { postalCode: 'H2X 1Y4' } });
    assert.strictEqual(s.uuid, store(1).uuid);
    assert.strictEqual(s.name, '(sans nom)');
    assert.strictEqual(s.postalCode, 'H2X 1Y4');
    assert.strictEqual(s.active, true);
    assert.strictEqual(normalizeStore({ ...store(2), active: false }).active, false);
  });

  console.log(`kaizen : ${n} tests OK`);
})().catch((e) => { console.error('ÉCHEC :', e); process.exit(1); });
