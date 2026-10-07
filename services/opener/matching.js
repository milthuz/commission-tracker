// ============================================================================
// Appariement magasin Kaizen ↔ fiche Google (place_id).
//
// Kaizen ne fournit ni coordonnées ni identifiant Google : seulement un nom et une adresse.
// On interroge Google Places (New) Text Search avec « nom, rue, ville, code postal », puis on
// note chaque candidat :
//   code postal identique ............ +0,50 (même RTA, 3 premiers caractères : +0,20)
//   nom (trigrammes, après nettoyage)  jusqu'à +0,40
//   numéro civique identique ......... +0,10  (à 4 près : 0 ; plus loin : −0,10)
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
//   3 — 2026-10-07, signalé par David (« dans 95 % des cas ça devrait matcher ») : numéro civique
//       à 4 près neutre (« 195 » contre « 194 » coûtait 10 points), nombres en lettres = chiffres
//       (« Pizza 2 Frères » / « Pizza Deux Frères »), suffixe de succursale retiré des DEUX côtés
//       (« — Blainville » côté Google). Les « à confirmer » sont renotés sur leurs candidats déjà
//       gardés, sans nouvelle recherche Google (rescoreStored).
const MATCH_VERSION = 3;

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
// Nombres en lettres → chiffres, des deux côtés (« Pizza Deux Frères » = « Pizza 2 Frères »).
const NUMBERS = { un: 1, une: 1, one: 1, deux: 2, two: 2, trois: 3, three: 3, quatre: 4, four: 4, cinq: 5, five: 5,
  six: 6, sept: 7, seven: 7, huit: 8, eight: 8, neuf: 9, nine: 9, dix: 10, ten: 10 };
const NUMBER_RE = new RegExp(`\\b(${Object.keys(NUMBERS).join('|')})\\b`, 'g');
function nameKey(t) {
  const base = String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(NUMBER_RE, (w) => String(NUMBERS[w]));
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
// Les variantes des DEUX côtés : Google aussi ajoute une succursale (« Pizza Deux Frères — Blainville »).
function nameSim(a, b) {
  const ys = nameVariants(b).map(nameKey);
  return Math.max(0, ...nameVariants(a).flatMap((v) => { const x = nameKey(v); return ys.map((y) => nameSim1(x, y)); }));
}

// Mot DISTINCTIF commun aux deux noms (« Superbol Val D'Or » / « Superbol Abitibi », « Barg Sushi
// Bar » / « Barg bar à sushi ») : un indice fort quand l'adresse est la même. Les mots de métier,
// de lieu et de forme juridique ne comptent pas — « Pizza X » et « Pizza Y » ne se ressemblent pas.
const COMMON_WORDS = new Set(('restaurant restaurants resto bistro cafe coffee bar pub lounge club pizzeria pizza boulangerie bakery '
  + 'brasserie traiteur sushi grill grillades cuisine cantine casse croute depanneur epicerie boutique marche market poulet chicken '
  + 'burger burgers taco tacos thai pho poke bols deli sandwich shawarma kebab patisserie fleuriste gourmet gourmande fine food foods '
  + 'express golf saint sainte ville centre center shopping galerie complexe plaza inc ltee ltd enr compagnie entreprises groupe '
  + 'restobar resto-bar bistrot cremerie creamery bbq smokehouse house maison chez the les des du de la le et and').split(/\s+/));
function tokens(t) {
  return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !COMMON_WORDS.has(w) && !/^\d+$/.test(w));
}
// Distance d'édition bornée à 1 (une lettre ajoutée, retirée ou changée).
function within1(x, y) {
  if (Math.abs(x.length - y.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (x.length > y.length) i++; else if (y.length > x.length) j++; else { i++; j++; }
  }
  return edits + (x.length - i) + (y.length - j) <= 1;
}
// Mot distinctif commun ; à une lettre près pour les mots d'au moins 5 lettres (« boulle » /
// « bulle », « amigrills » / « amigrlls » — fautes de saisie dans Billing ou chez Google).
function sharedToken(a, b) {
  const B = tokens(b);
  for (const w of tokens(a)) {
    if (B.some((v) => v === w || (w.length >= 5 && v.length >= 5 && within1(w, v)))) return w;
  }
  return null;
}

// Nom de rue comparable : sans numéros, mots de type (rue, boul., chemin…), points cardinaux ni
// mentions de local. « 1185 Boul Moody » et « Boulevard Moody » → « moody ».
const STREET_WORDS = /\b(rue|r|boulevard|boul|bd|blvd|avenue|ave|av|chemin|ch|chem|route|rte|rang|street|st|road|rd|drive|dr|place|pl|cote|montee|court|ct|crescent|cres|way|lane|ln|highway|hwy|autoroute|est|ouest|nord|sud|east|west|north|south|o|e|n|s|local|locale|suite|unit|unite|bureau|app|apt)\b/g;
function streetKey(t) {
  return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\d+[a-z]?\b/g, ' ').replace(/\bst[e]?(?:[-. ]+)/g, 'saint ').replace(STREET_WORDS, ' ').replace(/[^a-z]/g, '');
}
// Tous les nombres d'une adresse : « 40-9415 Boul. Leduc », « 136 - 72 boul. X », « Unit 8 Blvd 425 »
// — le local et le numéro civique s'écrivent dans tous les ordres.
const civics = (street) => (String(street || '').match(/\b\d{1,6}\b/g) || []);

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

  const gname = place.displayName?.text || place.displayName || '';
  let ns = nameSim(store.name, gname);
  const tok = sharedToken(store.name, gname);
  if (tok && ns < 0.75) { ns = 0.75; parts.token = tok; }
  score += 0.4 * ns;
  parts.name = Math.round(ns * 100) / 100;

  const sc = civic(store.street);
  const gc = component(place, 'street_number').match(/^\d+/)?.[0] || null;
  // Le numéro Google figure n'importe où dans l'adresse Cluster (local et civique mêlés) → même porte.
  const sameCivic = !!gc && civics(store.street).includes(gc);
  if (sameCivic || (sc && gc)) {
    if (sameCivic) { score += 0.1; parts.civic = 'same'; }
    // À 4 près (« 195 » contre « 194 », le côté d'une rue, une adresse de facturation approximative) :
    // ni bonus ni pénalité. Plus loin, c'est une autre porte.
    else if (Math.abs(Number(sc) - Number(gc)) <= 4) parts.civic = 'near';
    else { score -= 0.1; parts.civic = 'diff'; }
  } else parts.civic = 'unknown';

  // MÊME PORTE (même numéro, même rue) mais code postal approximatif ou absent dans Billing :
  // l'adresse vaut un code postal identique. Sauf si le code postal ET la ville disent ailleurs —
  // « 668 Saint-Joseph » existe à Gatineau ET à Gloucester (Ottawa).
  if (parts.postal !== 'same' && parts.civic === 'same') {
    const ss = trigramSim(streetKey(store.street), streetKey(component(place, 'route')));
    const sameCity = !!store.city && !!component(place, 'locality')
      && normName(store.city) === normName(component(place, 'locality'));
    if (ss >= 0.6 && (parts.postal !== 'diff' || sameCity)) {
      score += 0.45 - (parts.postal === 'fsa' ? 0.2 : 0);
      parts.address = 'same';
    }
  }

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
// Renote un candidat DÉJÀ GARDÉ (vue enregistrée : nom Google, adresse formatée) sans appeler
// Google : le code postal et le numéro civique sont relus dans l'adresse formatée.
function placeFromView(v) {
  const addr = String(v.address || '');
  const pc = addr.match(/[A-Z]\d[A-Z]\s?\d[A-Z]\d/i)?.[0] || '';
  // Le segment qui commence par un numéro (« Galerie de Terrebonne, 1185 Boulevard Moody, … »),
  // puis la ville : le segment qui le suit.
  const segs = addr.split(',').map((s) => s.trim());
  const i = segs.findIndex((s) => /^\d{1,6}\b/.test(s));
  const num = i >= 0 ? segs[i].match(/^(\d{1,6})/)[1] : '';
  const route = i >= 0 ? segs[i].replace(/^\d{1,6}\s*[a-z]?\b/i, '').trim() : '';
  const city = i >= 0 && segs[i + 1] && !/\b[A-Z]{2}\b\s*[A-Z]\d[A-Z]/i.test(segs[i + 1]) ? segs[i + 1] : '';
  return {
    id: v.id, displayName: { text: v.googleName || '' }, formattedAddress: addr,
    location: v.lat != null ? { latitude: v.lat, longitude: v.lng } : undefined,
    businessStatus: v.closed ? 'CLOSED_PERMANENTLY' : 'OPERATIONAL',
    addressComponents: [
      ...(pc ? [{ types: ['postal_code'], shortText: pc.toUpperCase() }] : []),
      ...(num ? [{ types: ['street_number'], shortText: num }] : []),
      ...(route ? [{ types: ['route'], shortText: route }] : []),
      ...(city ? [{ types: ['locality'], shortText: city }] : []),
    ],
  };
}
function rescoreStored(store, views) {
  return (views || []).filter((v) => v && v.id)
    .map((v) => { const p = placeFromView(v); const s = scoreCandidate(store, p); return { id: v.id, score: s.score, view: candidateView(p, s) }; })
    .sort((a, b) => b.score - a.score);
}

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
  rescoreStored, placeFromView,
  scoreCandidate, decide, storeQuery, createGooglePlaces, candidateView, serviceTypeOf, NEARBY_FIELDS, DETAIL_FIELDS,
};
