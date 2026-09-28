// ============================================================================
// Google Agenda des représentants — compte de service Google Workspace avec délégation à
// l'échelle du domaine.
//
// Un seul compte technique, autorisé UNE fois par l'administrateur Google Workspace, agit « au
// nom de » chaque représentant (le `sub` du jeton). Aucun représentant n'a à connecter quoi que
// ce soit, et aucun jeton personnel n'expire en silence.
//
// Deux portées, et seulement celles-là — la console Google refuse un jeton qui en demande une
// que l'administrateur n'a pas cochée, donc la liste ici DOIT être celle des instructions d'IT :
//   calendar.freebusy  → les plages occupées, SANS titre, contenu ni invités ;
//   calendar.events    → créer / déplacer / supprimer l'événement du rendez-vous.
// Aucune portée Gmail : le compte ne lit ni n'envoie de courriels.
//
// Variable d'environnement : GOOGLE_SERVICE_ACCOUNT_JSON — le fichier .json de la clé, tel quel
// ou encodé en base64 (Railway accepte les deux ; le base64 évite les soucis de sauts de ligne
// dans la clé privée).
//
// Écrit sans la bibliothèque googleapis : un JWT RS256 signé avec `crypto` suffit, et ça évite
// ~80 Mo de dépendance pour trois appels HTTP.
// ============================================================================

const crypto = require('crypto');
const axios = require('axios');

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/calendar.events',
];
const API = 'https://www.googleapis.com/calendar/v3';

let _creds; // undefined = pas encore lu ; null = absent ou illisible
function credentials() {
  if (_creds !== undefined) return _creds;
  const raw = String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
  _creds = null;
  if (!raw) return null;
  try {
    const text = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const j = JSON.parse(text);
    if (j.client_email && j.private_key) {
      // Une clé collée dans une variable garde souvent ses « \n » littéraux.
      _creds = { email: j.client_email, key: String(j.private_key).replace(/\\n/g, '\n'), clientId: j.client_id || null };
    }
  } catch (e) {
    console.warn('[agenda] GOOGLE_SERVICE_ACCOUNT_JSON illisible :', e.message);
  }
  return _creds;
}

const configured = () => !!credentials();
const serviceAccountInfo = () => {
  const c = credentials();
  return c ? { email: c.email, clientId: c.clientId, scopes: SCOPES } : null;
};

const b64url = (s) => Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

// Un jeton par représentant, gardé jusqu'à 5 minutes avant son expiration (1 h chez Google).
const _tokens = new Map();
async function accessToken(subject) {
  const c = credentials();
  if (!c) throw new Error('google_not_configured');
  const key = String(subject).toLowerCase();
  const hit = _tokens.get(key);
  if (hit && hit.exp - Date.now() > 5 * 60 * 1000) return hit.token;

  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: c.email, sub: key, scope: SCOPES.join(' '),
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }));
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${claims}`).sign(c.key)
    .toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

  const r = await axios.post('https://oauth2.googleapis.com/token',
    new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${sig}` }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, validateStatus: () => true, timeout: 15000 });
  if (r.status !== 200 || !r.data?.access_token) {
    // Les deux causes réelles, dites en clair : délégation non accordée (ou portées différentes),
    // ou adresse qui n'existe pas dans le Workspace.
    const why = r.data?.error_description || r.data?.error || `HTTP ${r.status}`;
    throw new Error(`google_auth_failed: ${why}`);
  }
  _tokens.set(key, { token: r.data.access_token, exp: Date.now() + (Number(r.data.expires_in) || 3600) * 1000 });
  return r.data.access_token;
}

async function call(subject, method, path, data) {
  const token = await accessToken(subject);
  const r = await axios({
    method, url: `${API}${path}`, data,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    validateStatus: () => true, timeout: 15000,
  });
  return r;
}
const errorOf = (r) => String(r.data?.error?.message || r.data?.error || `HTTP ${r.status}`).slice(0, 300);

// Plages occupées du calendrier principal du représentant, entre deux instants.
// → [{ start: Date, end: Date }]. Lève si Google refuse : l'appelant décide quoi faire.
async function freeBusy(email, timeMin, timeMax) {
  const r = await call(email, 'post', '/freeBusy', {
    timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), items: [{ id: email }],
  });
  if (r.status !== 200) throw new Error(`freebusy_failed: ${errorOf(r)}`);
  const cal = r.data?.calendars?.[email] || Object.values(r.data?.calendars || {})[0];
  if (cal?.errors?.length) throw new Error(`freebusy_failed: ${cal.errors.map((e) => e.reason).join(', ')}`);
  return (cal?.busy || []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
}

// Le lien Google Meet d'un événement : `hangoutLink`, ou l'entrée « video » de conferenceData.
function meetOf(ev) {
  if (!ev) return null;
  if (ev.hangoutLink) return ev.hangoutLink;
  const v = (ev.conferenceData?.entryPoints || []).find((e) => e.entryPointType === 'video');
  return v?.uri || null;
}

// `sendUpdates: 'none'` partout : Google n'envoie AUCUN courriel. Le marchand reçoit les nôtres,
// dans sa langue et au nom de son représentant — une invitation Google en plus doublerait tout.
// `conferenceDataVersion=1` : obligatoire pour que Google tienne compte de `conferenceData`
// (la demande de Meet) — sans lui, la demande est ignorée EN SILENCE.
async function insertEvent(email, event) {
  const r = await call(email, 'post', '/calendars/primary/events?sendUpdates=none&conferenceDataVersion=1', event);
  if (r.status !== 200) return { ok: false, error: errorOf(r) };
  let meetUrl = meetOf(r.data);
  // La création du Meet peut être asynchrone (`status: pending`) : on relit l'événement une fois.
  if (!meetUrl && event.conferenceData?.createRequest) {
    await new Promise((res) => setTimeout(res, 1500));
    const g = await call(email, 'get', `/calendars/primary/events/${encodeURIComponent(r.data.id)}`);
    if (g.status === 200) meetUrl = meetOf(g.data);
  }
  return { ok: true, id: r.data.id, htmlLink: r.data.htmlLink || null, meetUrl };
}
// Un déplacement ne touche pas `conferenceData` : le lien Meet reste le même, ce que le marchand
// a déjà reçu reste valable.
async function patchEvent(email, id, patch) {
  const r = await call(email, 'patch', `/calendars/primary/events/${encodeURIComponent(id)}?sendUpdates=none&conferenceDataVersion=1`, patch);
  if (r.status === 404 || r.status === 410) return { ok: false, gone: true, error: 'event_not_found' };
  if (r.status !== 200) return { ok: false, error: errorOf(r) };
  return { ok: true, id: r.data.id, meetUrl: meetOf(r.data) };
}
async function deleteEvent(email, id) {
  const r = await call(email, 'delete', `/calendars/primary/events/${encodeURIComponent(id)}?sendUpdates=none`);
  // 410 = déjà supprimé (par le représentant lui-même, par exemple) : le but est atteint.
  if (r.status === 204 || r.status === 200 || r.status === 404 || r.status === 410) return { ok: true };
  return { ok: false, error: errorOf(r) };
}

module.exports = { configured, serviceAccountInfo, freeBusy, insertEvent, patchEvent, deleteEvent, SCOPES };
