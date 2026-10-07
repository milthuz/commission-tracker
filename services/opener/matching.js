// ============================================================================
// Appariement magasin Kaizen ↔ fiche Google (place_id).
//
// Kaizen ne fournit ni coordonnées ni identifiant Google : seulement un nom et une adresse.
// On interroge Google Places (New) Text Search avec « nom, rue, ville, code postal », puis on
// note chaque candidat :
//   code postal identique ............ +0,50 (même RTA, 3 premiers caractères : +0,20)
//   nom (trigrammes, après nettoyage)  jusqu'à +0,40
//   numéro civique identique ......... +0,10  (différent : −0,10)
// ≥ 0,80 → apparié automatiquement ; ≥ 0,50 → « À confirmer » ; sinon « Non trouvé ».
//
// Le code postal pèse le plus parce que les chaînes (plusieurs magasins du même nom) ne se
// départagent QUE par l'adresse, et qu'un nom de commerce Google diffère souvent du nom saisi
// dans Kaizen (« Saoko » contre « Restaurant Saoko Inc. »).
// ============================================================================

const axios = require('axios');

const AUTO = 0.8;
const REVIEW = 0.5;
// Version de la notation. La monter remet en jeu les « à confirmer » et « non trouvés » notés par
// une version antérieure (jamais les décisions humaines, jamais les « auto »).
//   1 — 2026-10-06, première version
//   2 — 2026-10-06, marque sans suffixe de succursale, adresses écartées, 2e essai par adresse
const MATCH_VERSION = 2;

// Équivalent JS de sh_norm_name() (SQL) : accents, mots juridiques et articles retirés,
// puis tout ce qui n'est pas [a-z0-9]. Garder les deux alignés.
const STOP = /\b(inc|ltd|ltee|llc|corp|co|enr|senc|srl|sec|the|le|la|les)\b/g;
function normName(t) {
  return String(t || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(STOP, '')
    .replace(/[^a-z0-9]/g, '');
}

// Mots génériques qui gonflent la ressemblance sans rien prouver (« Restaurant X » contre
// « Restaurant Y »). Retirés AVANT la comparaison des noms seulement.
const GENERIC = /\b(restaurant|resto|bistro|cafe|bar|pizzeria|boulangerie|brasserie|traiteur|sushi|grill)\b/g;
function nameKey(t) {
  const base = String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const k = normName(base.replace(GENERIC, ' '));
  return k || normName(base); // un nom fait SEULEMENT de mots génériques reste comparable
}

function trigrams(s) {
  const p = `  ${s} `;
  const set = new Set();
  for (let i = 0; i < p.length - 2; i++) set.add(p.slice(i, i + 3));
  return set;
}
// Similarité de type pg_trgm (Jaccard sur les trigrammes), 0..1.
function trigramSim(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = trigrams(a), B = trigrams(b);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}
function nameSim1(x, y) {
  if (!x || !y) return 0;
  let s = trigramSim(x, y);
  // L'un contient l'autre (« saoko » dans « saokomileend ») : fort indice, pas une preuve.
  if (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x))) s = Math.max(s, 0.85);
  return s;
}
// Variantes d'un nom Kaizen : le nom entier, et la MARQUE seule quand le nom porte un suffixe de
// succursale (« Pile ou Glace - Petite Italie », « Saoko | Mile End », « Kazu (Plateau) »).
// Constaté sur les vrais magasins le 2026-10-06 : le suffixe faisait tomber le nom à 32 % face à
// « Pile Ou Glace Gelateria », pourtant à la même adresse.
function nameVariants(t) {
  const s = String(t || '');
  const out = [s];
  const brand = s.split(/\s+[-–—|]\s+|\s*\(/)[0];
  if (brand && brand.trim() !== s.trim()) out.push(brand);
  return out;
}
function nameSim(a, b) {
  const y = nameKey(b);
  return Math.max(0, ...nameVariants(a).map((v) => nameSim1(nameKey(v), y)));
}

// Un résultat Google qui est une ADRESSE (immeuble, rue) et non un commerce : Text Search en
// renvoie quand le nom cherché ne correspond à aucun commerce (« Montréal-Ouest » → « 51
// Westminster North »). Un commerce porte toujours `establishment` ou `point_of_interest`.
function isAddressOnly(place) {
  const types = place.types || [];
  if (!types.length) return !place.primaryType;
  return !types.includes('establishment') && !types.includes('point_of_interest');
}

const normPostal = (p) => String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// Premier nombre de la rue : « 123 Example Street », « 123-A rue X » → « 123 ».
const civic = (street) => { const m = String(street || '').match(/^\s*(\d{1,6})/); return m ? m[1] : null; };

function component(place, type) {
  const c = (place.addressComponents || []).find((x) => (x.types || []).includes(type));
  return c ? (c.shortText || c.longText || '') : '';
}

// Note d'un candidat Google pour un magasin Kaizen. Retourne { score, parts }.
function scoreCandidate(store, place) {
  const parts = {};
  let score = 0;
  const sp = normPostal(store.postal_code ?? store.postalCode);
  const gp = normPostal(component(place, 'postal_code'));
  if (sp && gp) {
    if (sp === gp) { score += 0.5; parts.postal = 'same'; }
    else if (sp.slice(0, 3) === gp.slice(0, 3)) { score += 0.2; parts.postal = 'fsa'; }
    else parts.postal = 'diff';
  } else parts.postal = 'unknown';

  const ns = nameSim(store.name, place.displayName?.text || place.displayName || '');
  score += 0.4 * ns;
  parts.name = Math.round(ns * 100) / 100;

  const sc = civic(store.street);
  const gc = component(place, 'street_number').match(/^\d+/)?.[0] || null;
  if (sc && gc) {
    if (sc === gc) { score += 0.1; parts.civic = 'same'; }
    else { score -= 0.1; parts.civic = 'diff'; }
  } else parts.civic = 'unknown';

  // Une fiche fermée définitivement n'est jamais appariée d'office.
  if (place.businessStatus === 'CLOSED_PERMANENTLY') { score = Math.min(score, AUTO - 0.01); parts.closed = true; }

  return { score: Math.max(0, Math.min(1, Math.round(score * 1000) / 1000)), parts };
}

// Décision à partir des candidats notés (triés). Deux candidats au-dessus du seuil et à
// moins de 0,05 l'un de l'autre → ambigu → « À confirmer », jamais d'office.
function decide(scored) {
  const best = scored[0];
  if (!best) return { status: 'none', placeId: null, score: 0 };
  const second = scored[1];
  if (best.score >= AUTO && !(second && second.score >= AUTO && best.score - second.score < 0.05)) {
    return { status: 'auto', placeId: best.id, score: best.score };
  }
  if (best.score >= REVIEW) return { status: 'review', placeId: null, score: best.score };
  return { status: 'none', placeId: null, score: best.score };
}

function storeQuery(store) {
  const street = [store.street, store.unit ? `#${store.unit}` : null].filter(Boolean).join(' ');
  const pc = store.postal_code ?? store.postalCode;
  return [store.name, street, store.city, store.region, pc].filter(Boolean).join(', ');
}
// 2e essai, sans le nom : « quel commerce se trouve à cette adresse ? ». Pour les magasins dont le
// nom Kaizen est un nom de lieu ou de succursale plutôt que de commerce.
function addressQuery(store) {
  const street = [store.street, store.unit ? `#${store.unit}` : null].filter(Boolean).join(' ');
  if (!street) return null;
  const pc = store.postal_code ?? store.postalCode;
  return `restaurant, ${[street, store.city, pc].filter(Boolean).join(', ')}`;
}

// ----------------------------------------------------------------------------
// Google Places (New). Clé DÉDIÉE : GOOGLE_PLACES_API_KEY, avec « Places API (New) » activée.
// ⚠️ Volontairement distincte de GOOGLE_MAPS_API_KEY (avis Google, ancienne API) : chaque usage
// a sa clé, ses restrictions et son plafond de coût dans la console Google. Jamais de repli sur
// l'autre clé — un repli masquerait une configuration incomplète.
// ----------------------------------------------------------------------------
const FIELDS = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.location',
  'places.addressComponents', 'places.businessStatus', 'places.primaryType', 'places.types',
];

function createGooglePlaces({ http = axios, env = process.env } = {}) {
  const key = () => env.GOOGLE_PLACES_API_KEY;
  function explain(e) {
    const d = e?.response?.data?.error;
    const st = e?.response?.status;
    const msg = d?.message || e?.message || 'erreur';
    if (st === 403 && /not been used|disabled|PERMISSION_DENIED/i.test(`${msg} ${d?.status || ''}`)) {
      return new Error('Google : « Places API (New) » n\'est pas activée sur la clé GOOGLE_PLACES_API_KEY');
    }
    // Plafond (quota du jour, ou trop de requêtes) : erreur marquée, l'appelant s'arrête net.
    if (st === 429 || /RESOURCE_EXHAUSTED/i.test(`${msg} ${d?.status || ''}`)) {
      const q = new Error('Google : plafond de recherches du jour atteint — la suite au prochain passage');
      q.quota = true;
      return q;
    }
    return new Error(`Google Places : ${st ? `HTTP ${st} — ` : ''}${String(msg).slice(0, 200)}`);
  }

  async function searchText(textQuery, { max = 5 } = {}) {
    if (!key()) throw new Error('GOOGLE_PLACES_API_KEY absente');
    try {
      const r = await http.post('https://places.googleapis.com/v1/places:searchText',
        { textQuery, regionCode: 'CA', languageCode: 'fr', maxResultCount: max },
        { headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key(), 'X-Goog-FieldMask': FIELDS.join(',') }, timeout: 15000 });
      return Array.isArray(r?.data?.places) ? r.data.places : [];
    } catch (e) { throw explain(e); }
  }

  async function details(placeId) {
    if (!key()) throw new Error('GOOGLE_PLACES_API_KEY absente');
    try {
      const r = await http.get(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
        { headers: { 'X-Goog-Api-Key': key(), 'X-Goog-FieldMask': FIELDS.map((f) => f.replace('places.', '')).join(',') }, timeout: 15000 });
      return r?.data || null;
    } catch (e) { throw explain(e); }
  }

  // Balayage d'une zone (lot 1) : un cercle, les restaurants au plus près du centre d'abord.
  // Plafond Google : 20 résultats — le quadrillage (geo.splitCircle) découpe les cercles pleins.
  // Les champs dineIn / takeout / delivery placent l'appel dans la tranche de prix la plus haute
  // de Nearby Search ; ils servent le filtre « type de service » du concepteur de routes.
  // `fields` : masque plus léger pour l'inventaire du territoire (sans note ni type de service).
  async function searchNearby(center, radius, types, { fields } = {}) {
    if (!key()) throw new Error('GOOGLE_PLACES_API_KEY absente');
    try {
      const r = await http.post('https://places.googleapis.com/v1/places:searchNearby', {
        includedTypes: types, maxResultCount: 20, rankPreference: 'DISTANCE', languageCode: 'fr', regionCode: 'CA',
        locationRestriction: { circle: { center: { latitude: center[0], longitude: center[1] }, radius: Math.min(50000, Math.max(1, radius)) } },
      }, { headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key(), 'X-Goog-FieldMask': (fields || NEARBY_FIELDS).join(',') }, timeout: 15000 });
      return Array.isArray(r?.data?.places) ? r.data.places : [];
    } catch (e) { throw explain(e); }
  }

  // Fiche complète pour l'écran de l'opener (lot 3) : lue à la demande, JAMAIS stockée en base
  // (conditions Google) — seulement gardée une heure en mémoire par l'appelant.
  async function detailsFull(placeId, lang = 'fr') {
    if (!key()) throw new Error('GOOGLE_PLACES_API_KEY absente');
    try {
      const r = await http.get(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
        { params: { languageCode: lang === 'en' ? 'en' : 'fr', regionCode: 'CA' },
          headers: { 'X-Goog-Api-Key': key(), 'X-Goog-FieldMask': DETAIL_FIELDS.join(',') }, timeout: 15000 });
      return r?.data || null;
    } catch (e) { throw explain(e); }
  }

  return { searchText, details, searchNearby, detailsFull, configured: () => !!key() };
}

const NEARBY_FIELDS = [
  'places.id', 'places.displayName', 'places.location', 'places.formattedAddress', 'places.shortFormattedAddress',
  'places.primaryType', 'places.types', 'places.businessStatus', 'places.rating', 'places.userRatingCount',
  'places.dineIn', 'places.takeout', 'places.delivery',
];
const DETAIL_FIELDS = [
  'id', 'displayName', 'formattedAddress', 'location', 'rating', 'userRatingCount', 'priceLevel',
  'primaryTypeDisplayName', 'types', 'regularOpeningHours', 'currentOpeningHours', 'nationalPhoneNumber',
  'websiteUri', 'googleMapsUri', 'businessStatus', 'dineIn', 'takeout', 'delivery', 'addressComponents',
];

// Type de service déduit des indicateurs Google : sur place → tables, emporter seulement → quick.
function serviceTypeOf(p) {
  if (p?.dineIn === true && (p?.takeout === true || p?.delivery === true)) return 'both';
  if (p?.dineIn === true) return 'tables';
  if (p?.takeout === true || p?.delivery === true) return 'quick';
  return null;
}

// Forme compacte d'un candidat : ce qu'on garde pendant que le magasin attend une décision
// humaine. Effacée dès la décision prise (conditions Google : on ne conserve durablement que
// le place_id et, 30 jours au plus, les coordonnées).
function candidateView(place, scored) {
  return {
    id: place.id,
    googleName: place.displayName?.text || '',  // clé couverte par le mode démo (DEMO_NAME_KEYS)
    address: place.formattedAddress || '',
    lat: place.location?.latitude ?? null,
    lng: place.location?.longitude ?? null,
    closed: place.businessStatus === 'CLOSED_PERMANENTLY',
    score: scored.score,
    parts: scored.parts,
  };
}

module.exports = {
  AUTO, REVIEW, MATCH_VERSION, normName, nameKey, trigramSim, nameSim, nameVariants, isAddressOnly, normPostal, civic, addressQuery,
  scoreCandidate, decide, storeQuery, createGooglePlaces, candidateView, serviceTypeOf, NEARBY_FIELDS, DETAIL_FIELDS,
};
