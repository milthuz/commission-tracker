// ============================================================================
// Client de l'API Kaizen (backend Cluster POS) — magasins et adresses.
//
// Guide : « Store Addresses Quick Guide » (2026-10). Trois appels :
//   POST /public/v1/auth/login     { email, password, remember_me } → { token, refresh_token, … }
//   POST /public/v1/auth/refresh   { email, refresh_token }         → nouveaux jetons
//   GET  /console/v1/stores/addresses  (OData : $top ≤ 1000, $skip, $orderby, includeInactive)
//
// 🔑 ON SE CONNECTE À CHAQUE SYNCHRO, sans jamais garder de jeton. Le refresh token de Kaizen
// CHANGE à chaque rafraîchissement : le garder imposerait de le persister en base et de
// sérialiser web + worker sous verrou, faute de quoi deux processus s'invalideraient l'un
// l'autre et la synchro tomberait en panne jusqu'à une intervention humaine. Une connexion
// par nuit coûte un appel ; rien à garder, rien à corrompre. Le refresh n'est pas utilisé.
//
// Les identifiants viennent de KAIZEN_API_EMAIL / KAIZEN_API_PASSWORD (Railway). Ils ne sont
// jamais journalisés, ni renvoyés dans un message d'erreur.
// ============================================================================

const axios = require('axios');

const DEFAULT_BASE = 'https://backend.kaizen.clusterpos.com/prod/api';
const PAGE = 1000;       // plafond documenté de $top
const MAX_PAGES = 200;   // garde-fou : 200 000 magasins, bien au-delà du parc réel

function kaizenConfigured(env = process.env) {
  return !!(env.KAIZEN_API_EMAIL && env.KAIZEN_API_PASSWORD);
}

// Message d'erreur SANS le corps de la requête (il contient le mot de passe).
function describe(err, what) {
  const st = err?.response?.status;
  const msg = err?.response?.data?.message || err?.response?.data?.error || err?.message || 'erreur';
  return new Error(`Kaizen ${what} : ${st ? `HTTP ${st} — ` : ''}${String(msg).slice(0, 200)}`);
}

function createKaizenClient({ http = axios, env = process.env } = {}) {
  const base = (env.KAIZEN_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');

  async function login() {
    if (!kaizenConfigured(env)) throw new Error('Kaizen : KAIZEN_API_EMAIL / KAIZEN_API_PASSWORD absents');
    try {
      const r = await http.post(`${base}/public/v1/auth/login`,
        { email: env.KAIZEN_API_EMAIL, password: env.KAIZEN_API_PASSWORD, remember_me: false },
        { headers: { 'Content-Type': 'application/json' }, timeout: 20000 });
      const token = r?.data?.token;
      if (!token) throw new Error('réponse sans jeton');
      return token;
    } catch (e) { throw describe(e, 'connexion'); }
  }

  // Toutes les pages, actifs ET inactifs. Une page de moins de 1 000 magasins est la dernière.
  // Un 401 en cours de route (jeton expiré pendant la boucle) → une seule reconnexion.
  async function fetchAllStores() {
    let token = await login();
    const out = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = { $top: PAGE, $skip: page * PAGE, $orderby: 'Uuid', includeInactive: true };
      let r;
      try {
        r = await http.get(`${base}/console/v1/stores/addresses`,
          { params, headers: { Authorization: `Bearer ${token}` }, timeout: 60000 });
      } catch (e) {
        if (e?.response?.status === 401) {
          token = await login();
          try {
            r = await http.get(`${base}/console/v1/stores/addresses`,
              { params, headers: { Authorization: `Bearer ${token}` }, timeout: 60000 });
          } catch (e2) { throw describe(e2, `magasins, page ${page + 1}`); }
        } else throw describe(e, `magasins, page ${page + 1}`);
      }
      const rows = Array.isArray(r?.data) ? r.data : null;
      // Une réponse qui n'est pas une liste n'est PAS « zéro magasin » : on échoue, sinon la
      // synchro marquerait tout le parc comme disparu.
      if (!rows) throw new Error(`Kaizen magasins, page ${page + 1} : réponse inattendue (pas une liste)`);
      out.push(...rows);
      if (rows.length < PAGE) return out;
    }
    throw new Error(`Kaizen magasins : plus de ${MAX_PAGES} pages, arrêt par prudence`);
  }

  return { login, fetchAllStores };
}

// Une ligne de l'API → colonnes de kaizen_stores. Retourne null si la ligne est inutilisable.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cut = (v, n) => { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, n) : null; };
function normalizeStore(s) {
  if (!s || !UUID_RE.test(String(s.uuid || ''))) return null;
  const a = s.address || {};
  return {
    uuid: String(s.uuid).toLowerCase(),
    storeId: cut(s.store_id, 60),
    name: cut(s.name, 255) || '(sans nom)',
    street: cut(a.street, 255),
    unit: cut(a.unit, 60),
    city: cut(a.city, 120),
    region: cut(a.region, 120),
    postalCode: cut(a.postalCode, 20),
    country: cut(a.country, 60),
    active: s.active !== false,
  };
}

module.exports = { createKaizenClient, kaizenConfigured, normalizeStore, PAGE };
