// Découpage du territoire en routes d'une journée.   node services/opener/__tests__/campaign.test.js
const assert = require('assert');
const C = require('../campaign');

let n = 0;
const t = (name, fn) => { const t0 = Date.now(); fn(); n++; console.log('  ✓', name, `(${Date.now() - t0} ms)`); };

// Générateur déterministe.
let seed = 42;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

// Un quartier dense (Plateau, ~600 restaurants sur ~3 km²) et une banlieue clairsemée (Rive-Sud,
// ~120 restaurants sur ~60 km²).
const dense = Array.from({ length: 600 }, (_, i) => ({ placeId: `D${i}`, region: 'montreal', lat: 45.515 + rnd() * 0.02, lng: -73.595 + rnd() * 0.025 }));
const sparse = Array.from({ length: 120 }, (_, i) => ({ placeId: `S${i}`, region: 'rive-sud', lat: 45.45 + rnd() * 0.08, lng: -73.48 + rnd() * 0.1 }));
const routes = C.planCampaign([...dense, ...sparse]);

t('chaque restaurant est dans UNE et une seule route (aucun oublié, aucun doublon)', () => {
  const all = routes.flatMap((r) => r.placeIds);
  assert.strictEqual(all.length, 720);
  assert.strictEqual(new Set(all).size, 720);
});

t('chaque route tient dans 5 h et ≤ 40 arrêts', () => {
  for (const r of routes) {
    assert.ok(r.minutes <= 300, `${r.minutes} min`);
    assert.ok(r.placeIds.length <= 40);
  }
});

t('les journées sont bien remplies (pas une poussière de petites routes)', () => {
  const walk = routes.filter((r) => r.mode === 'walk');
  const avg = walk.reduce((s, r) => s + r.minutes, 0) / walk.length;
  assert.ok(avg >= 200, `remplissage moyen à pied : ${Math.round(avg)} min`);
  const small = walk.filter((r) => r.minutes < 120).length;
  assert.ok(small <= Math.ceil(walk.length * 0.1), `${small} routes à pied de moins de 2 h sur ${walk.length}`);
});

t('à pied en ville, en voiture en banlieue clairsemée', () => {
  const dm = routes.filter((r) => r.region === 'montreal');
  const sm = routes.filter((r) => r.region === 'rive-sud');
  assert.ok(dm.filter((r) => r.mode === 'walk').length >= dm.length * 0.8);
  assert.ok(sm.filter((r) => r.mode === 'car').length >= sm.length * 0.8);
});

t('une route ne traverse jamais une rivière (une seule région par route)', () => {
  const regionOf = new Map([...dense, ...sparse].map((p) => [p.placeId, p.region]));
  for (const r of routes) assert.strictEqual(new Set(r.placeIds.map((id) => regionOf.get(id))).size, 1);
});

t('les zones ne se chevauchent pas (chaque restaurant est hors de l\'enveloppe des autres routes)', () => {
  const pos = new Map([...dense, ...sparse].map((p) => [p.placeId, p]));
  const inside = (pt, poly) => {
    let ins = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [yi, xi] = poly[i], [yj, xj] = poly[j];
      if ((yi > pt.lat) !== (yj > pt.lat) && pt.lng < ((xj - xi) * (pt.lat - yi)) / (yj - yi) + xi) ins = !ins;
    }
    return ins;
  };
  let intrusions = 0, checked = 0;
  for (const r of routes.filter((x) => x.region === 'montreal' && x.hull.length >= 3)) {
    for (const o of routes.filter((x) => x !== r && x.region === 'montreal')) {
      for (const id of o.placeIds) { checked++; if (inside(pos.get(id), r.hull)) intrusions++; }
    }
  }
  assert.ok(intrusions / checked < 0.002, `${intrusions} intrusions sur ${checked}`);
});

t('les numéros se suivent géographiquement (une semaine de 5 routes reste groupée)', () => {
  const m = routes.filter((r) => r.region === 'montreal');
  const d = (a, b) => Math.hypot((a.centroid[0] - b.centroid[0]) * 111, (a.centroid[1] - b.centroid[1]) * 78);
  let sum = 0;
  for (let i = 1; i < m.length; i++) sum += d(m[i - 1], m[i]);
  const avgStep = sum / (m.length - 1);
  // Comparaison avec un ordre aléatoire : la courbe doit faire au moins 2× mieux.
  const shuffled = [...m].sort(() => rnd() - 0.5);
  let sumR = 0;
  for (let i = 1; i < shuffled.length; i++) sumR += d(shuffled[i - 1], shuffled[i]);
  assert.ok(avgStep * 2 < sumR / (shuffled.length - 1), `pas moyen ${avgStep.toFixed(2)} km`);
});

t('ordre de visite : pas de croisement sur un quadrillage (rangée parcourue d\'un bout à l\'autre)', () => {
  const row = Array.from({ length: 10 }, (_, i) => ({ x: (i % 2 ? 9 - i : i) * 80, y: 0 }));
  const order = C.orderTour(row, (p, q) => Math.abs(p.x - q.x) + Math.abs(p.y - q.y));
  const xs = order.map((i) => row[i].x);
  const sortedAsc = [...xs].sort((a, b) => a - b), sortedDesc = [...sortedAsc].reverse();
  assert.ok(JSON.stringify(xs) === JSON.stringify(sortedAsc) || JSON.stringify(xs) === JSON.stringify(sortedDesc), xs.join(','));
});

t('estimation de fin : semaines selon les openers, openers selon l\'échéance', () => {
  assert.strictEqual(C.eta(100, 2), 10);
  assert.strictEqual(C.eta(0, 2), 0);
  assert.strictEqual(C.openersFor(100, 5), 4);
});

t('grand territoire (12 000 restaurants) découpé en moins de 15 s', () => {
  const big = Array.from({ length: 12000 }, (_, i) => ({ placeId: `B${i}`, region: i % 3 ? 'montreal' : 'laval', lat: 45.45 + rnd() * 0.25, lng: -73.9 + rnd() * 0.4 }));
  const t0 = Date.now();
  const r = C.planCampaign(big);
  assert.strictEqual(r.flatMap((x) => x.placeIds).length, 12000);
  assert.ok(Date.now() - t0 < 15000, `${Date.now() - t0} ms`);
});

console.log(`campaign : ${n} tests OK — exemple : ${routes.length} routes pour 720 restaurants (${routes.filter((r) => r.mode === 'walk').length} à pied, ${routes.filter((r) => r.mode === 'car').length} en voiture)`);
