// Géométrie du module Opener.   node services/opener/__tests__/geo.test.js
const assert = require('assert');
const G = require('../geo');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ✓', name); };

// Un carré d'environ 1 km de côté sur le Plateau.
const sq = [[45.520, -73.590], [45.520, -73.577], [45.529, -73.577], [45.529, -73.590]];

t('haversine : ~1 km entre deux coins du carré', () => {
  const d = G.haversine(sq[0], sq[1]);
  assert.ok(d > 950 && d < 1080, String(d));
});

t('point dans le polygone', () => {
  assert.ok(G.pointInPolygon([45.524, -73.583], sq));
  assert.ok(!G.pointInPolygon([45.535, -73.583], sq));
});

t('polygone nettoyé : formats [lat,lng] et {lat,lng}, rejet des absurdités', () => {
  assert.deepStrictEqual(G.cleanPolygon([{ lat: 1, lng: 2 }, [3, 4], ['5', '6']]), [[1, 2], [3, 4], [5, 6]]);
  assert.strictEqual(G.cleanPolygon([[1, 2], [3, 4]]), null);
  assert.strictEqual(G.cleanPolygon([[1, 2], [3, 4], [95, 0]]), null);
  assert.strictEqual(G.cleanPolygon('x'), null);
});

t('surface ≈ 1 km²', () => {
  const a = G.areaM2(sq);
  assert.ok(a > 0.85e6 && a < 1.15e6, String(a));
});

t('couverture : tout point de la zone est dans au moins un cercle de départ', () => {
  const circles = G.coverCircles(sq, 300);
  assert.ok(circles.length > 0);
  for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) {
    const p = [45.520 + (0.009 * i) / 10, -73.590 + (0.013 * j) / 10];
    assert.ok(circles.some((c) => G.haversine(c.center, p) <= c.radius + 1), `trou en ${p}`);
  }
});

t('découpage : les 4 sous-cercles couvrent le carré du cercle parent', () => {
  const parent = { center: [45.5245, -73.5835], radius: 400 };
  const kids = G.splitCircle(parent);
  assert.strictEqual(kids.length, 4);
  assert.ok(kids.every((k) => k.radius === 200));
  // Carré couvert par le parent : demi-côté ρ√2/2.
  const half = (400 * Math.SQRT2) / 2;
  for (let i = -5; i <= 5; i++) for (let j = -5; j <= 5; j++) {
    const p = [parent.center[0] + ((half * i) / 5) / 111320, parent.center[1] + ((half * j) / 5) / (111320 * Math.cos((45.5245 * Math.PI) / 180))];
    assert.ok(kids.some((k) => G.haversine(k.center, p) <= k.radius + 1), `trou en ${i},${j}`);
  }
});

t('ordre de visite : un zigzag est remis en ligne, le départ est respecté', () => {
  // Points alignés est-ouest donnés dans le désordre.
  const pts = [0, 4, 1, 3, 2].map((k) => [45.52, -73.59 + k * 0.002]);
  const order = G.optimizeOrder(pts, [45.52, -73.592]);
  const lngs = order.map((i) => pts[i][1]);
  assert.deepStrictEqual(lngs, [...lngs].sort((a, b) => a - b));
  assert.ok(G.pathLength(order.map((i) => pts[i])) < G.pathLength(pts));
});

console.log(`geo : ${n} tests OK`);
