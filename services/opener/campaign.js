// ============================================================================
// Campagne de couverture : découpe un territoire en ROUTES D'UNE JOURNÉE (aucun appel externe).
//
// Demande de David (2026-10-07) : couvrir Montréal, la Rive-Nord et la Rive-Sud en quelques
// semaines, avec des routes qui « apparaissent déjà » — compactes, sans chevauchement, aucun
// restaurant oublié, à pied en ville et en voiture en banlieue, pensées pour 5 h de terrain.
//
// Méthode :
//   1. Par RÉGION (une rivière ne se traverse pas dans une journée).
//   2. Chaque restaurant est « à pied » s'il a assez de voisins proches, sinon « en voiture » :
//      les deux familles se découpent séparément.
//   3. Découpage par BISECTION RÉCURSIVE (le long de l'axe le plus long) en k parts de même
//      charge, k étant estimé par la loi de Beardwood–Halton–Hammersley (longueur d'une tournée
//      ≈ 0,7124·√(n·A)). Chaque part est ensuite routée pour de vrai ; trop longue, elle est
//      re-découpée. Résultat : des zones contiguës, en pavés, qui ne se recoupent pas.
//   4. Ordre de visite : départ à une extrémité, plus proche voisin, 2-opt puis Or-opt.
//   5. Distance À PIED sur l'île de Montréal : « en rues », alignée sur le quadrillage de la
//      ville (incliné d'environ 55° par rapport au nord vrai) ; ailleurs, vol d'oiseau × 1,3.
//   6. Les routes sont numérotées dans l'ordre d'une courbe de Hilbert : deux numéros qui se
//      suivent sont des voisins — une semaine de 5 routes consécutives reste dans un secteur.
// ============================================================================

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;

const DEFAULTS = {
  minutes: 300,          // 5 h de terrain
  fill: 0.92,            // on vise 92 % de la journée (imprévus, pauses)
  walkStopMin: 12,       // minutes par arrêt à pied
  carStopMin: 16,        // en voiture : arrêt + stationnement
  walkSpeed: 75,         // m/min
  carSpeed: 380,         // m/min (~23 km/h en ville, feux compris)
  walkNeighborM: 400,    // voisin « proche » pour être à pied
  walkNeighbors: 3,      // nombre de voisins proches pour être à pied
  maxStops: 40,
  gridAngleDeg: 55,      // inclinaison du quadrillage de Montréal (approx.)
};

// Projection locale (mètres) autour d'une latitude de référence.
function projector(lat0) {
  const k = Math.cos(rad(lat0));
  return (p) => [rad(p.lng) * R * k, rad(p.lat) * R];
}

// Métrique de marche.
function walkDistFactory(region, angleDeg) {
  if (region === 'montreal') {
    const a = rad(angleDeg);
    const ca = Math.cos(a), sa = Math.sin(a);
    // Distance « en rues » : L1 dans le repère du quadrillage.
    return (p, q) => {
      const dx = q.x - p.x, dy = q.y - p.y;
      return Math.abs(dx * ca - dy * sa) + Math.abs(dx * sa + dy * ca);
    };
  }
  return (p, q) => Math.hypot(q.x - p.x, q.y - p.y) * 1.3;
}
const carDist = (p, q) => Math.hypot(q.x - p.x, q.y - p.y) * 1.35;

// ---------------------------------------------------------------------------
// Ordre de visite d'un petit ensemble (≤ ~60) : départ à une extrémité, PPV, 2-opt, Or-opt.
// ---------------------------------------------------------------------------
function orderTour(pts, dist) {
  const n = pts.length;
  if (n <= 2) return pts.map((_, i) => i);
  // Départ : l'extrémité de l'axe le plus long (on ne commence pas au milieu).
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const spanX = Math.max(...xs) - Math.min(...xs), spanY = Math.max(...ys) - Math.min(...ys);
  let start = 0;
  pts.forEach((p, i) => { if ((spanX >= spanY ? p.x < pts[start].x : p.y < pts[start].y)) start = i; });
  const D = (i, j) => dist(pts[i], pts[j]);
  const left = new Set(pts.map((_, i) => i));
  left.delete(start);
  const order = [start];
  let cur = start;
  while (left.size) {
    let best = -1, bd = Infinity;
    left.forEach((i) => { const d = D(cur, i); if (d < bd) { bd = d; best = i; } });
    order.push(best); left.delete(best); cur = best;
  }
  const len = () => order.reduce((s, v, i) => (i ? s + D(order[i - 1], v) : 0), 0);
  let improved = true;
  for (let pass = 0; improved && pass < 40; pass++) {
    improved = false;
    // 2-opt (chemin ouvert)
    for (let i = 0; i < n - 2; i++) for (let k = i + 1; k < n - 1; k++) {
      const a = order[i], b = order[i + 1], c = order[k], e = order[k + 1];
      if (D(a, c) + D(b, e) < D(a, b) + D(c, e) - 0.5) { order.splice(i + 1, k - i, ...order.slice(i + 1, k + 1).reverse()); improved = true; }
    }
    // 2-opt sur la fin (inverser la queue du chemin ouvert)
    for (let i = 0; i < n - 2; i++) {
      const a = order[i], b = order[i + 1], z = order[n - 1];
      if (D(a, z) < D(a, b) - 0.5) { order.splice(i + 1, n - i - 1, ...order.slice(i + 1).reverse()); improved = true; }
    }
    // Or-opt : déplacer un segment de 1 à 3 arrêts ailleurs dans le chemin.
    for (let seg = 1; seg <= 3; seg++) {
      for (let i = 0; i + seg <= n; i++) {
        const before = len();
        const piece = order.slice(i, i + seg);
        const rest = order.slice(0, i).concat(order.slice(i + seg));
        let bestPos = -1, bestLen = before - 0.5;
        for (let j = 0; j <= rest.length; j++) {
          for (const p of [piece, [...piece].reverse()]) {
            const cand = rest.slice(0, j).concat(p, rest.slice(j));
            const l = cand.reduce((s, v, x) => (x ? s + D(cand[x - 1], v) : 0), 0);
            if (l < bestLen) { bestLen = l; bestPos = j; piece.__rev = p !== piece; }
          }
        }
        if (bestPos >= 0) {
          const p = piece.__rev ? [...piece].reverse() : piece;
          order.splice(0, n, ...rest.slice(0, bestPos).concat(p, rest.slice(bestPos)));
          improved = true;
        }
      }
    }
  }
  return order;
}

function routeStats(pts, mode, o, dist) {
  const order = orderTour(pts, dist);
  const meters = order.reduce((s, v, i) => (i ? s + dist(pts[order[i - 1]], pts[v]) : 0), 0);
  const speed = mode === 'walk' ? o.walkSpeed : o.carSpeed;
  const stop = mode === 'walk' ? o.walkStopMin : o.carStopMin;
  return { order, meters: Math.round(meters), minutes: Math.round(meters / speed + pts.length * stop) };
}

// Estimation rapide du temps d'une grande part (BHH), sans router.
function estimateMinutes(pts, mode, o) {
  if (pts.length <= 1) return pts.length * (mode === 'walk' ? o.walkStopMin : o.carStopMin);
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const area = Math.max(1, (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)));
  const L = 0.7124 * Math.sqrt(pts.length * area) * (mode === 'walk' ? 1.27 : 1.35);
  return L / (mode === 'walk' ? o.walkSpeed : o.carSpeed) + pts.length * (mode === 'walk' ? o.walkStopMin : o.carStopMin);
}

// Coupe en k parts de charge égale, par bisection récursive le long de l'axe le plus long.
function bisect(pts, k) {
  if (k <= 1 || pts.length <= 1) return [pts];
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const axis = (Math.max(...xs) - Math.min(...xs)) >= (Math.max(...ys) - Math.min(...ys)) ? 'x' : 'y';
  const sorted = [...pts].sort((a, b) => a[axis] - b[axis]);
  const k1 = Math.floor(k / 2);
  const cut = Math.round((sorted.length * k1) / k);
  return [...bisect(sorted.slice(0, cut), k1), ...bisect(sorted.slice(cut), k - k1)];
}

function splitToFit(pts, mode, o, dist, out) {
  if (!pts.length) return;
  const target = o.minutes * o.fill;
  if (pts.length <= 60) {
    const st = routeStats(pts, mode, o, dist);
    if ((st.minutes <= o.minutes && pts.length <= o.maxStops) || pts.length === 1) {
      out.push({ pts, mode, ...st });
      return;
    }
  }
  const est = pts.length <= 60 ? routeStats(pts, mode, o, dist).minutes : estimateMinutes(pts, mode, o);
  const k = Math.max(2, Math.ceil(est / target), Math.ceil(pts.length / o.maxStops));
  for (const part of bisect(pts, k)) splitToFit(part, mode, o, dist, out);
}

// Indice de Hilbert (ordre 16) d'un point normalisé dans [0, 1)².
function hilbert(x, y) {
  const n = 1 << 16;
  let rx, ry, d = 0;
  let X = Math.floor(Math.min(0.999999, Math.max(0, x)) * n), Y = Math.floor(Math.min(0.999999, Math.max(0, y)) * n);
  for (let s = n >> 1; s > 0; s >>= 1) {
    rx = (X & s) > 0 ? 1 : 0;
    ry = (Y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) { if (rx === 1) { X = s - 1 - X; Y = s - 1 - Y; } const t = X; X = Y; Y = t; }
  }
  return d;
}

function convexHull(pts) {
  const p = [...pts].sort((a, b) => a.lng - b.lng || a.lat - b.lat);
  if (p.length < 3) return p.map((q) => [q.lat, q.lng]);
  const cross = (o, a, b) => (a.lng - o.lng) * (b.lat - o.lat) - (a.lat - o.lat) * (b.lng - o.lng);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (const q of [...p].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)].map((q) => [q.lat, q.lng]);
}

// places : [{ placeId, lat, lng, region }]. Retourne les routes, numérotées dans l'ordre de Hilbert.
function planCampaign(places, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const valid = places.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (!valid.length) return [];
  const lat0 = valid.reduce((s, p) => s + p.lat, 0) / valid.length;
  const proj = projector(lat0);
  const routes = [];
  const byRegion = new Map();
  for (const p of valid) {
    const [x, y] = proj(p);
    const q = { ...p, x, y };
    const r = p.region || 'other';
    if (!byRegion.has(r)) byRegion.set(r, []);
    byRegion.get(r).push(q);
  }
  for (const [region, pts] of byRegion) {
    const walkDist = walkDistFactory(region, o.gridAngleDeg);
    // Densité locale : nombre de voisins à moins de walkNeighborM (grille de seaux).
    const cell = o.walkNeighborM;
    const buckets = new Map();
    const key = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
    for (const p of pts) { const k = key(p.x, p.y); if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(p); }
    const walk = [], car = [];
    for (const p of pts) {
      const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell);
      let n = 0;
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        for (const q of buckets.get(`${cx + i},${cy + j}`) || []) if (q !== p && Math.hypot(q.x - p.x, q.y - p.y) <= cell) n++;
      }
      (n >= o.walkNeighbors ? walk : car).push(p);
    }
    const out = [];
    splitToFit(walk, 'walk', o, walkDist, out);
    splitToFit(car, 'car', o, carDist, out);
    for (const r of out) {
      const ordered = r.order.map((i) => r.pts[i]);
      routes.push({
        region, mode: r.mode, minutes: r.minutes, meters: r.meters,
        placeIds: ordered.map((p) => p.placeId),
        centroid: [ordered.reduce((s, p) => s + p.lat, 0) / ordered.length, ordered.reduce((s, p) => s + p.lng, 0) / ordered.length],
        hull: convexHull(ordered),
      });
    }
  }
  // Numérotation : courbe de Hilbert sur l'ensemble du territoire.
  const lats = routes.map((r) => r.centroid[0]), lngs = routes.map((r) => r.centroid[1]);
  const [aLat, bLat, aLng, bLng] = [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)];
  routes.forEach((r) => { r.h = hilbert((r.centroid[1] - aLng) / Math.max(1e-9, bLng - aLng), (r.centroid[0] - aLat) / Math.max(1e-9, bLat - aLat)); });
  routes.sort((a, b) => a.h - b.h);
  routes.forEach((r, i) => { r.seq = i + 1; delete r.h; });
  return routes;
}

// Semaines nécessaires (et openers nécessaires pour une échéance).
function eta(routesLeft, openers, daysPerWeek = 5) {
  if (!routesLeft) return 0;
  return Math.ceil(routesLeft / Math.max(1, openers * daysPerWeek));
}
const openersFor = (routesLeft, weeks, daysPerWeek = 5) => (routesLeft ? Math.ceil(routesLeft / Math.max(1, weeks * daysPerWeek)) : 0);

module.exports = { planCampaign, orderTour, eta, openersFor, DEFAULTS, hilbert, walkDistFactory };
