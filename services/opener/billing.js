// ============================================================================
// Clients Zoho Billing → emplacements Cluster (la source des clients V1).
//
// L'API Kaizen ne connaît que le parc V2. Les clients V1 n'ont pas de liste à eux : on les
// retrouve par leurs abonnements Zoho Billing (demande de David, 2026-10-06), dans les DEUX
// organisations canadiennes seulement — Cluster Canada et Xperio POS. Cluster USA est exclue.
//
// Un client Billing = un emplacement. L'adresse ne figure PAS sur l'abonnement : elle vient du
// contact Zoho Books, dont l'identifiant est le même que le `customer_id` de Billing (Billing et
// Books partagent leurs contacts dans une même organisation). Livraison d'abord — c'est le
// restaurant ; la facturation est souvent un siège social ou un comptable.
//
// ⚠️ Limite connue : un client qui exploite plusieurs restaurants sous UN seul contact n'apparaît
// qu'une fois, à l'adresse du contact.
// ============================================================================

const axios = require('axios');

// Cluster Canada, Xperio POS. Modifiable sans déploiement.
const DEFAULT_ORGS = ['697704869', '905113716'];
const billingOrgs = (env = process.env) =>
  String(env.OPENER_BILLING_ORG_IDS || DEFAULT_ORGS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);

// Abonnements → clients. `activeStatuses` = les statuts qui font un « client » (pour les
// emplacements : CLIENT_STATUSES de routes.js — payants + en pause). Un client sans aucun abonnement
// actif est un ANCIEN client, gardé (utile aux openers : reconquête), marqué inactif.
function groupCustomers(orgId, subs, activeStatuses) {
  const out = new Map();
  for (const s of subs || []) {
    const cid = String(s.customer_id || '').trim();
    if (!cid) continue;
    const key = `${orgId}:${cid}`;
    let c = out.get(key);
    if (!c) {
      c = { key, orgId, customerId: cid, name: '', active: false, plans: new Set(), subs: 0, activeSubs: 0, pausedSubs: 0, subNumbers: [] };
      out.set(key, c);
    }
    const name = String(s.customer_name || s.company_name || '').trim();
    if (name && !c.name) c.name = name;
    const st = String(s.status || '').toLowerCase();
    c.subs++;
    if (activeStatuses.has(st)) { c.active = true; c.activeSubs++; if (st === 'paused') c.pausedSubs++; }
    if (s.plan_name) c.plans.add(String(s.plan_name).trim());
    if (s.subscription_number && c.subNumbers.length < 10) c.subNumbers.push(String(s.subscription_number));
  }
  // Saisonnier : client dont TOUS les abonnements actifs sont en pause (restaurant fermé l'hiver…).
  for (const c of out.values()) c.seasonal = c.activeSubs > 0 && c.pausedSubs === c.activeSubs;
  return out;
}

// Une adresse Zoho : { address, street2, city, state, zip, country }.
const hasStreet = (a) => !!(a && String(a.address || a.street || '').trim());
function pickAddress(contact) {
  const sh = contact?.shipping_address || {};
  const b = contact?.billing_address || {};
  const a = hasStreet(sh) ? sh : hasStreet(b) ? b : (sh.zip ? sh : b);
  const clean = (v, n) => { const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); return s ? s.slice(0, n) : null; };
  return {
    street: clean(a.address || a.street, 255),
    unit: clean(a.street2, 60),
    city: clean(a.city, 120),
    region: clean(a.state, 120),
    postalCode: clean(a.zip, 20),
    country: clean(a.country, 60),
    which: a === sh ? 'shipping' : 'billing',
  };
}
// Les deux organisations sont canadiennes : un pays vide compte comme Canada.
const isCanada = (country) => !country || /canad|^ca$/i.test(String(country).trim());

// Lecture d'un contact Books, avec la même tolérance au quota que le reste de l'application
// (429, ou le code maison 43 parfois rendu en 400) : deux nouvelles tentatives espacées.
function createBooksContacts({ http = axios, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  async function fetchContact(apiDomain, accessToken, orgId, customerId) {
    let r = null;
    for (let essai = 0; essai < 3; essai++) {
      r = await http.get(`${apiDomain}/books/v3/contacts/${encodeURIComponent(customerId)}`, {
        params: { organization_id: orgId },
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
        validateStatus: () => true, timeout: 20000,
      });
      const limite = r.status === 429 || r.data?.code === 43;
      if (!limite) break;
      if (essai < 2) await sleep(3000 * (essai + 1));
    }
    if (r.status === 200 && r.data?.contact) return r.data.contact;
    const err = new Error(`Books contact ${customerId} (org ${orgId}) : HTTP ${r.status}${r.data?.code ? ` code ${r.data.code}` : ''}`);
    err.status = r.status;
    err.quota = r.status === 429 || r.data?.code === 43;
    throw err;
  }
  return { fetchContact };
}

module.exports = { DEFAULT_ORGS, billingOrgs, groupCustomers, pickAddress, isCanada, createBooksContacts };
