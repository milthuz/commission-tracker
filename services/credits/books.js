// ============================================================================
// Crédits de compensation marchand — accès Zoho Books.
//
// Trois appels, tous avec le jeton ADMIN (getAdminBooksAuth, comme Propositions) et
// l'organisation ZOHO_ORG_ID :
//   searchCustomers(q)  — recherche de comptes clients par nom (GET /contacts, search_text) ;
//   getCustomer(id)     — fiche d'un compte : personne-ressource principale, courriel, téléphone ;
//   createCreditNote(…) — la note de crédit, à l'approbation.
//
// ⚠️ La note de crédit exige la permission OAuth ZohoBooks.creditnotes.CREATE. Elle figure dans
// la liste des portées demandées, mais n'est ACCORDÉE qu'après une nouvelle autorisation de
// Zoho Books (reconnexion avec consentement). Sans elle, Zoho répond 401 / code 57 : on renvoie
// l'erreur telle quelle, le dossier reste « approuvé, note de crédit à créer » et peut être relancé.
// ============================================================================

const axios = require('axios');

function books(getAdminBooksAuth) {
  const org = () => process.env.ZOHO_ORG_ID;

  async function call(method, path, { params = {}, data } = {}) {
    const { accessToken, apiDomain } = await getAdminBooksAuth();
    const r = await axios({
      method, url: `${apiDomain}/books/v3${path}`,
      params: { organization_id: org(), ...params },
      data,
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
      timeout: 30000,
      validateStatus: () => true,
    });
    return r;
  }

  async function searchCustomers(q) {
    const r = await call('get', '/contacts', {
      params: { contact_type: 'customer', search_text: q, per_page: 25, sort_column: 'contact_name' },
    });
    if (r.status !== 200 || !r.data || r.data.code !== 0) {
      const e = new Error((r.data && r.data.message) || `books_${r.status}`); e.status = r.status; throw e;
    }
    return (r.data.contacts || []).map((c) => ({
      id: String(c.contact_id),
      name: c.contact_name || c.company_name || '',
      company: c.company_name || '',
      email: c.email || '',
      phone: c.phone || c.mobile || '',
      status: c.status || '',
    }));
  }

  async function getCustomer(id) {
    const r = await call('get', `/contacts/${encodeURIComponent(id)}`);
    if (r.status !== 200 || !r.data || r.data.code !== 0 || !r.data.contact) {
      const e = new Error((r.data && r.data.message) || `books_${r.status}`); e.status = r.status; throw e;
    }
    const c = r.data.contact;
    const persons = Array.isArray(c.contact_persons) ? c.contact_persons : [];
    const p = persons.find((x) => x.is_primary_contact) || persons[0] || {};
    const personName = [p.first_name, p.last_name].filter(Boolean).join(' ').trim();
    return {
      id: String(c.contact_id),
      legalName: c.company_name || c.contact_name || '',
      contactPerson: personName || [c.first_name, c.last_name].filter(Boolean).join(' ').trim(),
      email: p.email || c.email || '',
      phone: p.phone || p.mobile || c.phone || c.mobile || '',
      language: c.language_code || '',
    };
  }

  // Note de crédit d'UNE ligne, au montant approuvé. CREDIT_NOTE_ITEM_ID / CREDIT_NOTE_ACCOUNT_ID
  // (facultatifs) rattachent la ligne à un article ou à un compte comptable précis si la
  // comptabilité le demande ; sans eux, Zoho applique son compte de ventes par défaut.
  async function createCreditNote({ customerId, amount, ref, lang, legalName }) {
    const label = lang === 'en' ? 'Merchant Compensation Credit' : 'Crédit de compensation marchand';
    const line = {
      name: label,
      description: `${label} — ${ref}${legalName ? ` — ${legalName}` : ''}`,
      rate: Math.round(Number(amount) * 100) / 100,
      quantity: 1,
    };
    if (process.env.CREDIT_NOTE_ITEM_ID) line.item_id = process.env.CREDIT_NOTE_ITEM_ID;
    if (process.env.CREDIT_NOTE_ACCOUNT_ID) line.account_id = process.env.CREDIT_NOTE_ACCOUNT_ID;
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }); // AAAA-MM-JJ
    const r = await call('post', '/creditnotes', {
      data: {
        customer_id: customerId,
        date: today,
        reference_number: ref,
        line_items: [line],
        notes: lang === 'en'
          ? 'Compensation credit for an early-termination penalty from the previous payment processor. Subject to clawback if the 36-month commitment is not met.'
          : 'Crédit de compensation d\'une pénalité de résiliation anticipée du processeur précédent. Sujet à reprise si l\'engagement de 36 mois n\'est pas respecté.',
      },
    });
    if (r.status === 201 || (r.status === 200 && r.data && r.data.code === 0)) {
      const cn = (r.data && r.data.creditnote) || {};
      return { ok: true, id: String(cn.creditnote_id || ''), number: cn.creditnote_number || '' };
    }
    return {
      ok: false,
      status: r.status,
      code: r.data && r.data.code,
      message: (r.data && r.data.message) || `HTTP ${r.status}`,
      scopeMissing: r.status === 401 || (r.data && (r.data.code === 57 || /scope|authoriz/i.test(String(r.data.message || '')))),
    };
  }

  return { searchCustomers, getCustomer, createCreditNote };
}

module.exports = { books };
