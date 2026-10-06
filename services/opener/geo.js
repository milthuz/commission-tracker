// ============================================================================
// Géométrie du module Opener : distances, zone dessinée, quadrillage du balayage, ordre de visite.
// Tout en degrés décimaux [lat, lng] ; distances en mètres. Aucune dépendance.
// ============================================================================

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;

function haversine(a, b) {
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Polygone valide : 3 à 200 sommets, coordonnées plausibles. Retourne [[lat,lng], …] ou null.
function cleanPolygon(raw) {
  if (!Array.isArray(raw) || raw.length < 3 || raw.length > 200) return null;
  const out = [];
  for (const p of raw) {
    const lat = Number(Array.isArray(p) ? p[0] : p?.lat);
    const lng = Number(Array.isArray(p) ? p[1] : p?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 85 || Math.abs(lng) > 180) return null;
    out.push([lat, lng]);
  }
  return out;
}

// Lancer de rayon (lng = x, lat = y). Assez juste à l'échelle d'un quartier.
function pointInPolygon(pt, poly) {
  const [y, x] = pt;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i];
    const [yj, xj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function bbox(poly) {
  let s = 90, w = 180, n = -90, e = -180;
  for (const [lat, lng] of poly) { s = Math.min(s, lat); n = Math.max(n, lat); w = Math.min(w, lng); e = Math.max(e, lng); }
  return { s, w, n, e };
}

// Surface approximative (m²), projection équirectangulaire locale. Sert à refuser une zone
// démesurée avant de dépenser des appels Google.
function areaM2(poly) {
  const lat0 = rad(poly.reduce((a, p) => a + p[0], 0) / poly.length);
  const xy = poly.map(([lat, lng]) => [rad(lng) * R * Math.cos(lat0), rad(lat) * R]);
  let s = 0;
  for (let i = 0, j = xy.length - 1; i < xy.length; j = i++) s += xy[j][0] * xy[i][1] - xy[i][0] * xy[j][1];
  return Math.abs(s / 2);
}

// Distance d'un point à un segment (m), projection locale.
function distToSegment(p, a, b) {
  const lat0 = rad(p[0]);
  const P = (q) => [rad(q[1]) * R * Math.cos(lat0), rad(q[0]) * R];
  const [px, py] = P(p), [ax, ay] = P(a), [bx, by] = P(b);
  const dx = bx - ax, dy = by - ay;
  const L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Un cercle (centre, rayon) touche-t-il le polygone ?
function circleTouchesPolygon(center, radius, poly) {
  if (pointInPolygon(center, poly)) return true;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (distToSegment(center, poly[j], poly[i]) <= radius) return true;
  }
  return false;
}

// Cercles de départ couvrant la zone : grille carrée de pas r·√2 (le cercle de rayon r couvre
// alors entièrement sa case), seulement ceux qui touchent le polygone.
function coverCircles(poly, radius) {
  const b = bbox(poly);
  const latStep = (radius * Math.SQRT2) / 111320;
  const midLat = (b.s + b.n) / 2;
  const lngStep = (radius * Math.SQRT2) / (111320 * Math.cos(rad(midLat)));
  const out = [];
  for (let lat = b.s + latStep / 2; lat < b.n + latStep / 2; lat += latStep) {
    for (let lng = b.w + lngStep / 2; lng < b.e + lngStep / 2; lng += lngStep) {
      if (circleTouchesPolygon([lat, lng], radius, poly)) out.push({ center: [lat, lng], radius });
    }
  }
  return out;
}

// Les 4 sous-cercles d'un cercle plein (Nearby Search plafonne à 20 résultats). Un cercle de
// rayon ρ couvre un carré de côté ρ√2 ; ses 4 quarts (côté ρ√2/2, centres à ±ρ√2/4) sont
// couverts chacun par un cercle de rayon ρ/2.
function splitCircle({ center, radius }) {
  const off = (radius * Math.SQRT2) / 4;
  const dLat = off / 111320;
  const dLng = off / (111320 * Math.cos(rad(center[0])));
  return [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([a, b]) => ({
    center: [center[0] + a * dLat, center[1] + b * dLng], radius: radius / 2,
  }));
}

// Ordre de visite : plus proche voisin depuis le départ, puis 2-opt. À vol d'oiseau — une
// tournée à pied de 10 à 20 arrêts n'a pas besoin de mieux, et ça ne coûte aucun appel.
function optimizeOrder(points, start = null) {
  const n = points.length;
  if (n < 3) return points.map((_, i) => i);
  const d = (i, j) => haversine(points[i], points[j]);
  const left = new Set(points.map((_, i) => i));
  let cur;
  if (start) {
    cur = [...left].reduce((best, i) => (haversine(start, points[i]) < haversine(start, points[best]) ? i : best), 0);
  } else cur = 0;
  const order = [cur];
  left.delete(cur);
  while (left.size) {
    let best = null;
    for (const i of left) if (best === null || d(cur, i) < d(cur, best)) best = i;
    order.push(best); left.delete(best); cur = best;
  }
  // 2-opt sur un chemin ouvert (on ne revient pas au départ).
  let improved = true;
  for (let pass = 0; improved && pass < 50; pass++) {
    improved = false;
    for (let i = 0; i < n - 2; i++) {
      for (let k = i + 1; k < n - 1; k++) {
        const a = order[i], b = order[i + 1], c = order[k], e = order[k + 1];
        if (d(a, c) + d(b, e) < d(a, b) + d(c, e) - 0.5) {
          order.splice(i + 1, k - i, ...order.slice(i + 1, k + 1).reverse());
          improved = true;
        }
      }
    }
  }
  return order;
}

// Longueur d'un chemin (m).
const pathLength = (pts) => pts.reduce((s, p, i) => (i ? s + haversine(pts[i - 1], p) : 0), 0);

module.exports = { haversine, cleanPolygon, pointInPolygon, bbox, areaM2, circleTouchesPolygon, coverCircles, splitCircle, optimizeOrder, pathLength };
