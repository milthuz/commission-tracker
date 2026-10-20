// ============================================================================
// Module Finance — onglet KPI : synchronisation des sources (Zoho Billing, Zoho Books, Banque du
// Canada) vers les tables locales. Aucune lecture de l'écran ne parle à Zoho : l'écran lit la
// base, la synchro (nuit, ou « Synchroniser maintenant ») la remplit.
//
// ⚠️ JAMAIS TESTÉ CONTRE LE VRAI ZOHO NI LA VRAIE BANQUE DU CANADA (bancs d'essai : faux
// serveurs locaux). La forme du rapport P&L de Books est lue de façon tolérante (kpiCore.flattenPnl)
// — à vérifier sur la première vraie synchro : Admin → Finance → KPI → Réglages → comptes.
// ============================================================================

const axios = require('axios');
const C = require('./kpiCore');

let BACKOFF_MS = 20000;            // attente après un 429 de Zoho (comme saasTenureWithRetry)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bocBase = () => (process.env.FINANCE_BOC_BASE_URL || 'https://www.bankofcanada.ca').replace(/\/$/, '');

class ScopeError extends Error { constructor(m) { super(m); this.scope = true; } }

async function setStatus(pool, source, state, { error = null, detail = null, ok = false } = {}) {
  await pool.query(
    `INSERT INTO finance_kpi_sync_status (source, state, last_try_at, last_ok_at, last_error, detail)
     VALUES ($1, $2, NOW(), CASE WHEN $3 THEN NOW() ELSE NULL END, $4, $5::jsonb)
     ON CONFLICT (source) DO UPDATE SET state = EXCLUDED.state, last_try_at = NOW(),
       last_ok_at = CASE WHEN $3 THEN NOW() ELSE finance_kpi_sync_status.last_ok_at END,
       last_error = EXCLUDED.last_error, detail = COALESCE(EXCLUDED.detail, finance_kpi_sync_status.detail)`,
    [source, state, ok, error ? String(error).slice(0, 500) : null, detail ? JSON.stringify(detail) : null]);
}

// ---------------------------------------------------------------------------- Zoho Billing
// Une reprise sur 429 (attente) ou 401 (jeton tourné par une autre tâche → ré-authentification),
// comme saasTenureWithRetry dans server.js. `auth` est modifié en place.
async function billingListWithRetry(L, auth, orgId) {
  try {
    return await L.fetchBillingSubs(auth.apiDomain, auth.accessToken, orgId, 'SubscriptionStatus.All');
  } catch (e) {
    if (/HTTP 429/.test(e.message)) await sleep(BACKOFF_MS);
    else if (/HTTP 401/.test(e.message)) Object.assign(auth, await L.getAdminBooksAuth());
    else throw e;
    return await L.fetchBillingSubs(auth.apiDomain, auth.accessToken, orgId, 'SubscriptionStatus.All');
  }
}

const SUB_COLS = ['org_id', 'subscription_number', 'subscription_id', 'customer_id', 'customer_name', 'plan_code', 'plan_name',
  'status', 'activated_at', 'activated_src', 'cancelled_at', 'cancel_reason', 'monthly_amount', 'currency', 'raw_updated_at'];

// Copie COMPLÈTE d'une organisation. Leçon de l'incident des fausses suppressions (2026-08-18) :
// une lecture partielle de Zoho ne doit jamais effacer des abonnements vivants. On n'efface donc
// les absents que si la lecture a réussi ET qu'il en manque peu (5 au plus) ou qu'elle compte au
// moins la moitié des lignes déjà là ; sinon on garde tout et on le signale (état « warning »).
async function rebuildOrg(pool, orgId, list, monthlyFn, activeStatuses, mrrStatuses) {
  const rows = [];
  const seen = new Set();
  for (const s of list) {
    const r = C.normalizeSub(s, orgId, monthlyFn, activeStatuses);
    if (!r || seen.has(r.subscription_number)) continue;
    seen.add(r.subscription_number);
    rows.push(r);
  }
  const stamp = new Date().toISOString();
  for (let i = 0; i < rows.length; i += 200) {
    const lot = rows.slice(i, i + 200);
    const vals = [];
    const ph = lot.map((r, k) => {
      const b = k * (SUB_COLS.length + 1);
      SUB_COLS.forEach((c) => vals.push(r[c]));
      vals.push(stamp);
      return `(${SUB_COLS.map((_, j) => `$${b + j + 1}`).join(', ')}, $${b + SUB_COLS.length + 1}::timestamptz)`;
    });
    await pool.query(
      `INSERT INTO finance_billing_subs (${SUB_COLS.join(', ')}, synced_at) VALUES ${ph.join(', ')}
       ON CONFLICT (org_id, subscription_number) DO UPDATE SET
         ${SUB_COLS.filter((c) => c !== 'org_id' && c !== 'subscription_number').map((c) => `${c} = EXCLUDED.${c}`).join(', ')},
         synced_at = EXCLUDED.synced_at`, vals);
  }
  const before = await pool.query('SELECT COUNT(*)::int AS n FROM finance_billing_subs WHERE org_id = $1 AND synced_at < $2::timestamptz', [orgId, stamp]);
  const stale = before.rows[0].n;
  let removed = 0, keptStale = false;
  const total = rows.length + stale;
  if (stale && (stale <= 5 || rows.length >= total * 0.5)) {
    const d = await pool.query('DELETE FROM finance_billing_subs WHERE org_id = $1 AND synced_at < $2::timestamptz', [orgId, stamp]);
    removed = d.rowCount || 0;
  } else if (stale) keptStale = true;
  // Photo du MRR courant (méthode du tableau de bord : statuts MRR, montant mensuel avant taxes).
  let mrr = 0, active = 0;
  for (const r of rows) {
    if (mrrStatuses.has(r.status)) mrr += r.monthly_amount;
    if (activeStatuses.has(r.status)) active++;
  }
  await pool.query(
    `INSERT INTO finance_billing_mrr_snap (org_id, snap_date, mrr, active_count, captured_at) VALUES ($1, $2::date, $3, $4, NOW())
     ON CONFLICT (org_id, snap_date) DO UPDATE SET mrr = EXCLUDED.mrr, active_count = EXCLUDED.active_count, captured_at = NOW()`,
    [orgId, C.torontoToday(), Math.round(mrr * 100) / 100, active]);
  return { count: rows.length, removed, keptStale };
}

async function syncBilling(pool, L, auth) {
  const orgs = L.ZOHO_BILLING_ORG_IDS || [];
  const monthlyFn = L.subMonthlyAmount || C.subMonthlyAmountLocal;
  const activeStatuses = L.ACTIVE_STATUSES || C.DEFAULT_ACTIVE_STATUSES;
  const mrrStatuses = L.MRR_STATUSES || C.DEFAULT_MRR_STATUSES;
  const out = {};
  for (const orgId of orgs) {
    try {
      const list = await billingListWithRetry(L, auth, orgId);
      out[orgId] = await rebuildOrg(pool, orgId, list, monthlyFn, activeStatuses, mrrStatuses);
      await setStatus(pool, `billing:${orgId}`, out[orgId].keptStale ? 'warning' : 'ok', { ok: true, detail: out[orgId], error: out[orgId].keptStale ? 'partial_read_kept_rows' : null });
    } catch (e) {
      out[orgId] = { error: e.message };
      await setStatus(pool, `billing:${orgId}`, 'error', { error: e.message });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------- Zoho Books
async function booksGet(L, auth, path, params) {
  const call = () => axios.get(`${String(auth.apiDomain || 'https://www.zohoapis.com').replace(/\/$/, '')}${path}`, {
    params: { organization_id: process.env.ZOHO_ORG_ID, ...params },
    headers: { Authorization: `Zoho-oauthtoken ${auth.accessToken}` },
    validateStatus: () => true, timeout: 30000,
  });
  let r = await call();
  if (r.status === 429) { await sleep(BACKOFF_MS); r = await call(); }
  else if (r.status === 401 && !C.isScopeError(r.status, r.data)) { Object.assign(auth, await L.getAdminBooksAuth()); r = await call(); }
  if (C.isScopeError(r.status, r.data)) throw new ScopeError(`Books ${path} HTTP ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
  if (r.status !== 200) throw new Error(`Books ${path} HTTP ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
  return r.data;
}

// Les lignes « books » de finance_gl_monthly se recalculent à partir des comptes bruts du mois et
// du rattachement de la CFO (réglages) — un changement de rattachement n'exige aucun appel Zoho.
async function recomputeBooksLines(pool, mapping, months = null) {
  const q = months
    ? await pool.query("SELECT to_char(month, 'YYYY-MM') AS m, account_key AS key, amount::float8 AS amount FROM finance_gl_raw WHERE to_char(month, 'YYYY-MM') = ANY($1)", [months])
    : await pool.query("SELECT to_char(month, 'YYYY-MM') AS m, account_key AS key, amount::float8 AS amount FROM finance_gl_raw");
  const byMonth = {};
  for (const r of q.rows) (byMonth[r.m] = byMonth[r.m] || []).push(r);
  const synced = months || (await pool.query("SELECT DISTINCT to_char(month, 'YYYY-MM') AS m FROM finance_gl_raw_months")).rows.map((r) => r.m);
  for (const m of synced) {
    for (const line of ['recurringRevenue', 'sellingExpense', 'subscriptionRevenue', 'adyenIncome']) {
      const v = C.glLineFromMapping(byMonth[m] || [], mapping[line]);
      if (v == null) {
        await pool.query("DELETE FROM finance_gl_monthly WHERE month = $1::date AND line_key = $2 AND source = 'books'", [`${m}-01`, line]);
      } else {
        await pool.query(
          `INSERT INTO finance_gl_monthly (month, line_key, source, amount, updated_by) VALUES ($1::date, $2, 'books', $3, 'zoho-books')
           ON CONFLICT (month, line_key, source) DO UPDATE SET amount = EXCLUDED.amount, updated_at = NOW(), version = finance_gl_monthly.version + 1`,
          [`${m}-01`, line, v]);
      }
    }
  }
}

async function syncBooksPnl(pool, L, auth, months, mapping) {
  if (!process.env.ZOHO_ORG_ID) { await setStatus(pool, 'books', 'error', { error: 'ZOHO_ORG_ID missing' }); return { error: 'no_org' }; }
  let done = 0;
  try {
    for (const m of months) {
      const data = await booksGet(L, auth, '/books/v3/reports/profitandloss', { from_date: `${m}-01`, to_date: C.monthEnd(m) });
      const accounts = C.flattenPnl(data);
      await pool.query('DELETE FROM finance_gl_raw WHERE month = $1::date', [`${m}-01`]);
      for (let i = 0; i < accounts.length; i += 200) {
        const lot = accounts.slice(i, i + 200);
        const vals = [];
        const ph = lot.map((a, k) => { vals.push(`${m}-01`, a.key, a.name, a.section, a.isGroup, a.amount); const b = k * 6; return `($${b + 1}::date, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6})`; });
        await pool.query(`INSERT INTO finance_gl_raw (month, account_key, account_name, section, is_group, amount) VALUES ${ph.join(', ')}
          ON CONFLICT (month, account_key) DO NOTHING`, vals);
      }
      await pool.query('INSERT INTO finance_gl_raw_months (month, synced_at, accounts) VALUES ($1::date, NOW(), $2) ON CONFLICT (month) DO UPDATE SET synced_at = NOW(), accounts = EXCLUDED.accounts', [`${m}-01`, accounts.length]);
      done++;
    }
    await recomputeBooksLines(pool, mapping, months);
    await setStatus(pool, 'books', 'ok', { ok: true, detail: { months: done } });
    return { months: done };
  } catch (e) {
    if (done) await recomputeBooksLines(pool, mapping, months.slice(0, done)).catch(() => {});
    await setStatus(pool, 'books', e.scope ? 'reconnect' : 'error', { error: e.message });
    return { error: e.scope ? 'reconnect' : e.message, months: done };
  }
}

// Notes de crédit Books du mois (suggestion du document Word « SaaS CN for the month ») :
// TOUTES les notes non annulées, taxes INCLUSES — la liste de Zoho ne donne ni le sous-total ni
// les articles (question ouverte à la CFO : comment isoler le SaaS).
async function syncCreditNotes(pool, L, auth, months) {
  if (!process.env.ZOHO_ORG_ID) return { error: 'no_org' };
  let done = 0;
  try {
    for (const m of months) {
      let total = 0, count = 0;
      for (let page = 1; page <= 50; page++) {
        const data = await booksGet(L, auth, '/books/v3/creditnotes', { date_start: `${m}-01`, date_end: C.monthEnd(m), per_page: 200, page });
        for (const cn of data.creditnotes || []) {
          if (String(cn.status || '').toLowerCase() === 'void') continue;
          const d = C.zohoDate(cn.date);
          if (d && d.slice(0, 7) !== m) continue; // filtre de date ignoré par Zoho ? on recoupe
          total += C.num(cn.total) || 0; count++;
        }
        if (!(data.page_context && data.page_context.has_more_page)) break;
      }
      await pool.query(
        `INSERT INTO finance_gl_monthly (month, line_key, source, amount, note, updated_by) VALUES ($1::date, 'saasCreditNotes', 'books', $2, $3, 'zoho-books')
         ON CONFLICT (month, line_key, source) DO UPDATE SET amount = EXCLUDED.amount, note = EXCLUDED.note, updated_at = NOW(), version = finance_gl_monthly.version + 1`,
        [`${m}-01`, Math.round(total * 100) / 100, `${count}`]);
      done++;
    }
    await setStatus(pool, 'creditnotes', 'ok', { ok: true, detail: { months: done } });
    return { months: done };
  } catch (e) {
    await setStatus(pool, 'creditnotes', e.scope ? 'reconnect' : 'error', { error: e.message });
    return { error: e.scope ? 'reconnect' : e.message, months: done };
  }
}

// ---------------------------------------------------------------------------- Banque du Canada
async function syncFx(pool, fromMonth, toDay) {
  try {
    const r = await axios.get(`${bocBase()}/valet/observations/FXUSDCAD/json`, {
      params: { start_date: `${fromMonth}-01`, end_date: toDay }, validateStatus: () => true, timeout: 20000,
    });
    if (r.status !== 200) throw new Error(`BoC HTTP ${r.status}`);
    const ends = C.bocMonthEnds(r.data);
    for (const [m, o] of Object.entries(ends)) {
      await pool.query(
        `INSERT INTO finance_fx_monthly (month, source, usdcad, obs_date, updated_by) VALUES ($1::date, 'boc', $2, $3::date, 'bank-of-canada')
         ON CONFLICT (month, source) DO UPDATE SET usdcad = EXCLUDED.usdcad, obs_date = EXCLUDED.obs_date, updated_at = NOW(), version = finance_fx_monthly.version + 1`,
        [`${m}-01`, o.rate, o.date]);
    }
    await setStatus(pool, 'fx', 'ok', { ok: true, detail: { months: Object.keys(ends).length } });
    return { months: Object.keys(ends).length };
  } catch (e) {
    await setStatus(pool, 'fx', 'error', { error: e.message });
    return { error: e.message };
  }
}

module.exports = {
  syncBilling, syncBooksPnl, syncCreditNotes, syncFx, recomputeBooksLines, setStatus, billingListWithRetry,
  _setBackoff: (ms) => { BACKOFF_MS = ms; },
};
