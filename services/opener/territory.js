// ============================================================================
// Territoire de la campagne Opener : les régions à couvrir (demande de David, 2026-10-07 :
// « la ville de Montréal au complet, la Rive-Nord et la Rive-Sud »).
//
// Polygones APPROXIMATIFS (à ~500 m près), tracés le long des rives. Ils peuvent déborder un
// peu sur l'eau : un cercle de balayage sur l'eau ne rend rien et ne coûte qu'un appel. Chaque
// restaurant trouvé est rattaché à la région qui le contient ; une route ne mélange jamais deux
// régions (une rivière ne se traverse pas dans une journée).
// ============================================================================

const REGIONS = [
  {
    key: 'montreal', fr: 'Île de Montréal', en: 'Island of Montreal',
    polygon: [[45.703, -73.476], [45.672, -73.540], [45.648, -73.575], [45.611, -73.615], [45.575, -73.648], [45.548, -73.680],
      [45.525, -73.735], [45.510, -73.790], [45.500, -73.860], [45.478, -73.930], [45.445, -73.975], [45.405, -73.955],
      [45.420, -73.880], [45.428, -73.800], [45.425, -73.730], [45.425, -73.670], [45.440, -73.610], [45.455, -73.560],
      [45.495, -73.545], [45.530, -73.535], [45.560, -73.520], [45.600, -73.500], [45.640, -73.485], [45.675, -73.470]],
  },
  {
    key: 'laval', fr: 'Laval', en: 'Laval',
    polygon: [[45.672, -73.555], [45.640, -73.590], [45.600, -73.640], [45.565, -73.680], [45.540, -73.720], [45.520, -73.790],
      [45.515, -73.860], [45.540, -73.880], [45.580, -73.860], [45.615, -73.820], [45.640, -73.770], [45.665, -73.700], [45.690, -73.620]],
  },
  {
    key: 'rive-sud', fr: 'Rive-Sud', en: 'South Shore',
    polygon: [[45.615, -73.455], [45.590, -73.380], [45.540, -73.340], [45.470, -73.380], [45.420, -73.420], [45.375, -73.490],
      [45.385, -73.545], [45.425, -73.525], [45.465, -73.520], [45.505, -73.515], [45.545, -73.505], [45.580, -73.480]],
  },
  {
    key: 'rive-nord', fr: 'Rive-Nord', en: 'North Shore',
    polygon: [[45.555, -73.920], [45.600, -73.860], [45.630, -73.800], [45.660, -73.740], [45.690, -73.660], [45.710, -73.560],
      [45.715, -73.470], [45.760, -73.420], [45.790, -73.470], [45.780, -73.600], [45.740, -73.700], [45.700, -73.800],
      [45.680, -73.900], [45.620, -73.950], [45.570, -73.960]],
  },
];
const REGION_KEYS = REGIONS.map((r) => r.key);

function pointInPolygon([y, x], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i], [yj, xj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const regionOf = (lat, lng) => (REGIONS.find((r) => pointInPolygon([lat, lng], r.polygon)) || null)?.key || null;

// Catégorie d'un établissement d'après son type principal Google (même règle que le frontend,
// src/pages/Opener/geo.ts → kindOf).
function kindOf(primaryType) {
  const t = String(primaryType || '').toLowerCase();
  if (/fast_food|meal_takeaway|meal_delivery/.test(t)) return 'takeout';
  if (/bakery|pastry|dessert|donut|ice_cream|confectioner|chocolate/.test(t)) return 'bakery';
  if (/cafe|coffee|tea_house|juice/.test(t)) return 'cafe';
  if (/(^|_)bar($|_)|pub|night_club|wine|brewery|lounge/.test(t)) return 'bar';
  if (/restaurant|diner|food_court|steak|sushi|pizza|brunch|bistro/.test(t)) return 'restaurant';
  return 'other';
}

module.exports = { REGIONS, REGION_KEYS, regionOf, pointInPolygon, kindOf };
