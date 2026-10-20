// ============================================================================
// Module Finance — gestionnaires : écritures de journal dans Zoho Books.
//
//   GET  /books/v3/chartofaccounts  (ZohoBooks.accountants.READ)   → plan comptable, en cache
//   POST /books/v3/journals         (ZohoBooks.accountants.CREATE) → écriture manuelle
//
// Jeton ADMIN (kit.late().getAdminBooksAuth, comme les crédits marchands), organisation
// ZOHO_ORG_ID. ⚠️ Les portées accountants.* ne sont ACCORDÉES qu'après une nouvelle autorisation
// de Zoho Books par l'admin (reconnexion avec consentement). Sans elles, Zoho répond 401 /
// code 57 : on le détecte (`scopeMissing`) et l'écran dit « Zoho Books à reconnecter ».
//
// Retry : une fois sur 429 (pause) ou 401 (nouvelle lecture du jeton : une autre tâche a pu le
// faire tourner), comme saasTenureWithRetry dans server.js. Rien d'autre n'est relancé :
// une écriture de journal ne se relance JAMAIS à l'aveugle (risque de doublon dans Books).
//
// ⚠️ Jamais testé contre le vrai Zoho Books : les bancs d'essai parlent à un faux Books local.
// ============================================================================

const axios = require('axios');

const BACKOFF_MS = () => Number(process.env.FINANCE_BOOKS_BACKOFF_MS) || 20000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isScopeError = (r) => r.status === 401 || !!(r.data && (r.data.code === 57 || /scope|not authori[sz]ed/i.test(String(r.data.message || ''))));

class BooksError extends Error {
  constructor(code, message, extra = {}) { super(message || code); this.code = code; Object.assign(this, extra); }
}

function booksClient(kit) {
  const late = kit.late() || {};
  const org = () => process.env.ZOHO_ORG_ID;

  async function auth() {
    if (typeof late.getAdminBooksAuth !== 'function') throw new BooksError('books_not_connected', 'Zoho Books is not available');
    try { return await late.getAdminBooksAuth(); } catch (e) { throw new BooksError('books_not_connected', e.message); }
  }

  async function call(method, path, { params = {}, data } = {}) {
    if (!org()) throw new BooksError('books_not_configured', 'ZOHO_ORG_ID is not set');
    let a = await auth();
    let r;
    for (let attempt = 0; attempt < 2; attempt++) {
      r = await axios({
        method, url: `${a.apiDomain}/books/v3${path}`,
        params: { organization_id: org(), ...params },
        data,
        headers: { Authorization: `Zoho-oauthtoken ${a.accessToken}` },
        timeout: 30000,
        validateStatus: () => true,
      });
      if (attempt === 0 && r.status === 429) { await sleep(BACKOFF_MS()); continue; }
      if (attempt === 0 && r.status === 401) { a = await auth(); continue; }
      break;
    }
    return r;
  }

  const fail = (r, code) => new BooksError(isScopeError(r) ? 'books_scope_missing' : code,
    (r.data && r.data.message) || `HTTP ${r.status}`, { status: r.status, booksCode: r.data && r.data.code });

  /** Plan comptable complet (pages de 200). */
  async function chartOfAccounts() {
    const out = [];
    for (let page = 1; page <= 25; page++) {
      const r = await call('get', '/chartofaccounts', { params: { page, per_page: 200 } });
      if (r.status !== 200 || !r.data || r.data.code !== 0) throw fail(r, 'books_read_failed');
      for (const a of r.data.chartofaccounts || []) {
        out.push({
          id: String(a.account_id),
          code: a.account_code ? String(a.account_code) : '',
          name: a.account_name || '',
          type: a.account_type || '',
          active: a.is_active !== false,
        });
      }
      if (!(r.data.page_context && r.data.page_context.has_more_page)) break;
    }
    return out;
  }

  /** Écriture manuelle. `lines` : [{ accountId, side, amount, description }]. */
  async function createJournal({ date, reference, notes, lines }) {
    const r = await call('post', '/journals', {
      data: {
        journal_date: date,
        reference_number: reference,
        notes,
        journal_type: 'both',
        line_items: lines.map((l) => ({
          account_id: l.accountId,
          debit_or_credit: l.side,
          amount: Math.round(l.amount * 100) / 100,
          description: l.description,
        })),
      },
    });
    if ((r.status === 201 || r.status === 200) && r.data && r.data.code === 0 && r.data.journal) {
      return { id: String(r.data.journal.journal_id || ''), number: String(r.data.journal.entry_number || '') };
    }
    throw fail(r, 'books_post_failed');
  }

  return { chartOfAccounts, createJournal };
}

module.exports = { booksClient, BooksError, isScopeError };
