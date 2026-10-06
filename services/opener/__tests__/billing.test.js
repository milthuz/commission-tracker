// Lecteur Zoho Billing → emplacements.   node services/opener/__tests__/billing.test.js
const assert = require('assert');
const B = require('../billing');

const ACTIVE = new Set(['live', 'non_renewing', 'dunning', 'unpaid', 'paused']);

(async () => {
  let n = 0;
  const t = async (name, fn) => { await fn(); n++; console.log('  ✓', name); };

  await t('organisations par défaut : Cluster Canada + Xperio, jamais Cluster USA', async () => {
    assert.deepStrictEqual(B.billingOrgs({}), ['697704869', '905113716']);
    assert.deepStrictEqual(B.billingOrgs({ OPENER_BILLING_ORG_IDS: ' 1, 2 ,' }), ['1', '2']);
  });

  await t('abonnements → un client ; actif si UN abonnement actif ; paused compte comme actif', async () => {
    const m = B.groupCustomers('O', [
      { customer_id: 'A', customer_name: 'Resto A', status: 'cancelled', plan_name: 'Vieux' },
      { customer_id: 'A', customer_name: 'Resto A', status: 'live', plan_name: 'POS', subscription_number: 'SUB-1' },
      { customer_id: 'B', customer_name: 'Resto B', status: 'expired' },
      { customer_id: 'C', company_name: 'Resto C', status: 'paused' },
      { customer_id: '', customer_name: 'sans id', status: 'live' },
    ], ACTIVE);
    assert.strictEqual(m.size, 3);
    const a = m.get('O:A');
    assert.strictEqual(a.active, true);
    assert.strictEqual(a.subs, 2);
    assert.strictEqual(a.activeSubs, 1);
    assert.deepStrictEqual([...a.plans].sort(), ['POS', 'Vieux']);
    assert.strictEqual(m.get('O:B').active, false);
    assert.strictEqual(m.get('O:C').active, true);
    assert.strictEqual(m.get('O:C').name, 'Resto C');
  });

  await t('adresse : livraison si elle a une rue, sinon facturation', async () => {
    const both = B.pickAddress({ shipping_address: { address: '1 Resto', zip: 'H1A 1A1', city: 'Mtl' }, billing_address: { address: '9 Siège', zip: 'H9Z 9Z9' } });
    assert.strictEqual(both.street, '1 Resto');
    assert.strictEqual(both.which, 'shipping');
    const billOnly = B.pickAddress({ shipping_address: { address: '', zip: '' }, billing_address: { address: '9 Siège', street2: 'Bureau 2', zip: 'H9Z 9Z9', state: 'Quebec' } });
    assert.strictEqual(billOnly.street, '9 Siège');
    assert.strictEqual(billOnly.unit, 'Bureau 2');
    assert.strictEqual(billOnly.region, 'Quebec');
    assert.strictEqual(billOnly.which, 'billing');
    const none = B.pickAddress({});
    assert.strictEqual(none.street, null);
  });

  await t('Canada : pays vide accepté (organisations canadiennes), États-Unis refusés', async () => {
    assert.ok(B.isCanada(''));
    assert.ok(B.isCanada(null));
    assert.ok(B.isCanada('Canada'));
    assert.ok(B.isCanada('CA'));
    assert.ok(!B.isCanada('United States'));
    assert.ok(!B.isCanada('USA'));
  });

  await t('contact Books : 429 → 2 nouvelles tentatives espacées, puis succès', async () => {
    let calls = 0; const waits = [];
    const http = { get: async (url, cfg) => {
      calls++;
      assert.ok(url.endsWith('/books/v3/contacts/123'));
      assert.strictEqual(cfg.params.organization_id, 'ORG');
      return calls < 3 ? { status: 429, data: {} } : { status: 200, data: { contact: { contact_id: '123' } } };
    } };
    const c = await B.createBooksContacts({ http, sleep: async (ms) => waits.push(ms) }).fetchContact('https://z', 'T', 'ORG', '123');
    assert.strictEqual(c.contact_id, '123');
    assert.deepStrictEqual(waits, [3000, 6000]);
  });

  await t('contact Books : quota persistant (code 43) → erreur marquée quota ; 404 → erreur simple', async () => {
    const q = B.createBooksContacts({ http: { get: async () => ({ status: 400, data: { code: 43 } }) }, sleep: async () => {} });
    const e1 = await q.fetchContact('https://z', 'T', 'ORG', '1').catch((e) => e);
    assert.strictEqual(e1.quota, true);
    const nf = B.createBooksContacts({ http: { get: async () => ({ status: 404, data: {} }) }, sleep: async () => {} });
    const e2 = await nf.fetchContact('https://z', 'T', 'ORG', '1').catch((e) => e);
    assert.strictEqual(e2.quota, false);
    assert.match(e2.message, /HTTP 404/);
  });

  console.log(`billing : ${n} tests OK`);
})().catch((e) => { console.error('ÉCHEC :', e); process.exit(1); });
