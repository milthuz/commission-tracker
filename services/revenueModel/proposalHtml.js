// ============================================================================
// Proposition de chaîne — pages de TARIFICATION client, en HTML (rendu PDF par Chromium).
//
// Ces pages remplacent le devis Zoho dans la proposition d'une chaîne : la couverture et les
// pages Cluster restent celles de la présentation habituelle, puis viennent ces pages-ci.
// Style calqué sur la présentation (lettre portrait 612×792 pt, Satoshi, fond crème, petit titre
// orange, cartes blanches, pied « clusterpos.com · Confidentiel · 0N »).
//
// ⚠️ DOCUMENT CLIENT. On n'y met QUE ce que le client paie : prix SaaS, location, frais par
// emplacement, matériel, installation, majoration et frais de paiement. JAMAIS un coût de
// Cluster (réseau, achat des terminaux, garantie, prix d'achat du matériel, coût d'installation),
// ni une marge, ni une commission. La liste blanche PRICE_KEYS est la SEULE porte d'entrée :
// buildPricing() ne lit rien d'autre du scénario, et le test le vérifie.
// ============================================================================

const fs = require('fs');
const path = require('path');

// Les seuls champs du scénario qui atteignent le document client.
const PRICE_KEYS = [
  'merchantName', 'numLocs', 'termsPerLoc',
  'gmvCredit', 'gmvInterac',
  'saasPerLoc', 'markupRate', 'txnFeeCredit', 'txnFeeInterac',
  'termRentalRev', 'aofRev', 'pciRev', 'bankRev', 'hwPrice', 'instPrice',
];

// Chiffres du document, calculés UNIQUEMENT à partir des champs de prix.
function buildPricing(scenario) {
  const i = {};
  for (const k of PRICE_KEYS) i[k] = k === 'merchantName' ? String(scenario[k] || '') : Number(scenario[k] || 0);

  const monthly = [
    { key: 'saas', amount: i.saasPerLoc },
    { key: 'rental', amount: i.termsPerLoc * i.termRentalRev, qty: i.termsPerLoc, unit: i.termRentalRev },
    { key: 'aof', amount: i.aofRev },
    { key: 'pci', amount: i.pciRev },
    { key: 'bank', amount: i.bankRev },
  ].filter((l) => l.amount > 0 || l.key === 'saas');
  const monthlyPerLoc = monthly.reduce((a, l) => a + l.amount, 0);

  const oneTime = [
    { key: 'hardware', amount: i.hwPrice },
    { key: 'install', amount: i.instPrice },
  ].filter((l) => l.amount > 0);
  const oneTimePerLoc = oneTime.reduce((a, l) => a + l.amount, 0);

  // ⛔ Volontairement ABSENTS (décision de David, 2026-09-24 : « pas trop de détail ») :
  // l'estimation des frais de paiement sur le volume du marchand et le total sur 5 ans.
  return {
    i, monthly, monthlyPerLoc, monthlyChain: monthlyPerLoc * i.numLocs,
    oneTime, oneTimePerLoc, oneTimeChain: oneTimePerLoc * i.numLocs,
  };
}

const COPY = {
  fr: {
    eyebrow1: 'Votre tarification', title1: 'Une offre pensée pour vos {n} emplacements.',
    lead1: 'Un prix clair par emplacement, le même partout dans votre réseau. Voici ce que représente le déploiement de Cluster pour {name}.',
    stats: { locs: 'Emplacements', terms: 'Terminaux de paiement', volume: 'Volume de paiement annuel' },
    monthlyTitle: 'Mensuel, par emplacement', oneTimeTitle: 'Unique, par emplacement',
    lines: {
      saas: 'Logiciel PDV Cluster', rental: 'Location des terminaux de paiement',
      rentalDetail: '{qty} × {unit} par mois', aof: 'Account on file', pci: 'Frais PCI', bank: 'Virement bancaire',
      hardware: 'Matériel PDV', install: 'Installation et mise en service',
    },
    perLoc: 'Total par emplacement', perLocMonth: 'Total mensuel par emplacement',
    chain: 'Pour les {n} emplacements', perMonth: '/ mois',
    rates: 'Paiements — Interchange+', markup: 'Majoration sur les transactions crédit',
    feeCredit: 'Frais par transaction — crédit', feeInterac: 'Frais par transaction — Interac',
    ratesNote: 'L’interchange des réseaux vous est refacturé au coût réel, sans majoration cachée.',
    validity: 'Prix en dollars canadiens, taxes en sus. Proposition valable 30 jours.',
    confidential: 'Confidentiel',
  },
  en: {
    eyebrow1: 'Your pricing', title1: 'An offer built for your {n} locations.',
    lead1: 'One clear price per location, the same across your whole network. Here is what rolling out Cluster represents for {name}.',
    stats: { locs: 'Locations', terms: 'Payment terminals', volume: 'Annual payment volume' },
    monthlyTitle: 'Monthly, per location', oneTimeTitle: 'One-time, per location',
    lines: {
      saas: 'Cluster POS software', rental: 'Payment terminal rental',
      rentalDetail: '{qty} × {unit} per month', aof: 'Account on file', pci: 'PCI fee', bank: 'Bank transfer',
      hardware: 'POS hardware', install: 'Installation and go-live',
    },
    perLoc: 'Total per location', perLocMonth: 'Monthly total per location',
    chain: 'For all {n} locations', perMonth: '/ month',
    rates: 'Payments — Interchange+', markup: 'Markup on credit transactions',
    feeCredit: 'Per-transaction fee — credit', feeInterac: 'Per-transaction fee — Interac',
    ratesNote: 'Card-network interchange is passed through at actual cost, with no hidden markup.',
    validity: 'Prices in Canadian dollars, taxes extra. Proposal valid for 30 days.',
    confidential: 'Confidential',
  },
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? '' : vars[k]));

// Satoshi embarquée en data URL : le HTML se rend seul, sans fichier à côté.
let FONT_CSS = null;
function fontCss() {
  if (FONT_CSS !== null) return FONT_CSS;
  const dir = path.join(__dirname, '..', '..', 'assets', 'fonts');
  const faces = [['Regular', 400], ['Medium', 500], ['Bold', 700], ['Black', 900]];
  FONT_CSS = faces.map(([w, n]) => {
    try {
      const b64 = fs.readFileSync(path.join(dir, `Satoshi-${w}.woff2`)).toString('base64');
      return `@font-face{font-family:'Satoshi';font-weight:${n};src:url(data:font/woff2;base64,${b64}) format('woff2');}`;
    } catch { return ''; }
  }).join('');
  return FONT_CSS;
}

// lang : 'fr' | 'en'. startPage : numéro de la première page (suit la présentation).
function renderPricingHtml(scenario, { lang = 'fr', startPage = 1 } = {}) {
  const L = COPY[lang === 'en' ? 'en' : 'fr'];
  const loc = lang === 'en' ? 'en-CA' : 'fr-CA';
  const d = buildPricing(scenario);
  const { i } = d;
  const money = (v, dec) => {
    const frac = dec != null ? dec : (Number.isInteger(Math.round(v * 100) / 100) ? 0 : 2);
    return Number(v).toLocaleString(loc, { style: 'currency', currency: 'CAD', currencyDisplay: 'narrowSymbol', minimumFractionDigits: frac, maximumFractionDigits: frac });
  };
  const n = (v, dec = 0) => Number(v).toLocaleString(loc, { maximumFractionDigits: dec });
  const big = (v) => (v >= 1e6
    ? (lang === 'en' ? `$${n(v / 1e6, 2)}M` : `${n(v / 1e6, 2)} M$`)
    : money(v, 0));
  // Frais par transaction : jusqu'à 6 décimales (0,0365 $ reste 0,0365 $).
  const fee = (v) => (lang === 'en' ? `$${n(v, 6)}` : `${n(v, 6)} $`);
  const page = (k) => String(startPage + k).padStart(2, '0');
  const name = esc(i.merchantName || (lang === 'en' ? 'your chain' : 'votre chaîne'));

  const line = (label, detail, amount) => `
    <div class="line"><div><div class="l-label">${label}</div>${detail ? `<div class="l-detail">${detail}</div>` : ''}</div>
    <div class="l-amount">${amount}</div></div>`;

  const monthlyLines = d.monthly.map((l) => line(
    esc(L.lines[l.key]),
    l.key === 'rental' ? esc(fill(L.lines.rentalDetail, { qty: n(l.qty), unit: money(l.unit) })) : '',
    money(l.amount),
  )).join('');
  const oneTimeLines = d.oneTime.map((l) => line(esc(L.lines[l.key]), '', money(l.amount))).join('');

  const footer = (k) => `<div class="footer"><span>clusterpos.com</span><span>${L.confidential} · ${page(k)}</span></div>`;

  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><style>
${fontCss()}
@page { size: 612pt 792pt; margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { background: #F7F6F3; }
body { font-family: 'Satoshi', system-ui, sans-serif; color: #111; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.page { width: 612pt; height: 792pt; padding: 34pt 36pt 0; position: relative; overflow: hidden; page-break-after: always; background: #F7F6F3; }
.page:last-child { page-break-after: auto; }
.eyebrow { color: #FE6523; font-size: 7pt; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; }
h1 { font-size: 25pt; font-weight: 700; line-height: 1.08; letter-spacing: -.01em; margin-top: 8pt; max-width: 470pt; }
.lead { font-size: 8.6pt; color: #555; line-height: 1.5; margin-top: 10pt; max-width: 440pt; }
.stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 9pt; margin-top: 18pt; }
.stat { background: #fff; border: .6pt solid #E6E3DD; border-radius: 7pt; padding: 11pt 13pt; }
.stat.accent { background: #FE6523; border-color: #FE6523; color: #fff; }
.stat .v { font-size: 17pt; font-weight: 700; }
.stat .k { font-size: 7pt; margin-top: 2pt; opacity: .75; }
.card { background: #fff; border: .6pt solid #E6E3DD; border-radius: 8pt; padding: 14pt 16pt; margin-top: 12pt; }
.card h2 { font-size: 7pt; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: #8A867E; margin-bottom: 6pt; }
.line { display: flex; justify-content: space-between; align-items: baseline; gap: 12pt; padding: 7pt 0; border-bottom: .6pt solid #F0EEEA; }
.l-label { font-size: 9pt; font-weight: 500; }
.l-detail { font-size: 7pt; color: #8A867E; margin-top: 1.5pt; }
.l-amount { font-size: 9.5pt; font-weight: 500; white-space: nowrap; font-variant-numeric: tabular-nums; }
.sub { display: flex; justify-content: space-between; align-items: baseline; padding-top: 9pt; }
.sub .k { font-size: 9pt; font-weight: 700; }
.sub .v { font-size: 12pt; font-weight: 700; white-space: nowrap; }
.chain { display: flex; justify-content: space-between; align-items: center; margin-top: 10pt; background: #1B1B1D; color: #fff; border-radius: 6pt; padding: 10pt 13pt; }
.chain .k { font-size: 8pt; opacity: .8; }
.chain .v { font-size: 14pt; font-weight: 700; color: #FE8A55; white-space: nowrap; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 10pt; }
.note { font-size: 6.8pt; color: #8A867E; margin-top: 8pt; line-height: 1.45; }
.footer { position: absolute; left: 36pt; right: 36pt; bottom: 22pt; display: flex; justify-content: space-between; font-size: 6.5pt; color: #A5A19A; }
</style></head><body>

<section class="page">
  <div class="eyebrow">${esc(L.eyebrow1)}</div>
  <h1>${esc(fill(L.title1, { n: n(i.numLocs) }))}</h1>
  <p class="lead">${fill(esc(L.lead1), { name })}</p>
  <div class="stats">
    <div class="stat accent"><div class="v">${n(i.numLocs)}</div><div class="k">${esc(L.stats.locs)}</div></div>
    <div class="stat"><div class="v">${n(i.numLocs * i.termsPerLoc)}</div><div class="k">${esc(L.stats.terms)}</div></div>
    <div class="stat"><div class="v">${big(i.gmvCredit + i.gmvInterac)}</div><div class="k">${esc(L.stats.volume)}</div></div>
  </div>
  <div class="card">
    <h2>${esc(L.monthlyTitle)}</h2>
    ${monthlyLines}
    <div class="sub"><span class="k">${esc(L.perLocMonth)}</span><span class="v">${money(d.monthlyPerLoc)} ${esc(L.perMonth)}</span></div>
    <div class="chain"><span class="k">${esc(fill(L.chain, { n: n(i.numLocs) }))}</span><span class="v">${money(d.monthlyChain, 0)} ${esc(L.perMonth)}</span></div>
  </div>
  <div class="cols">
    <div class="card">
      <h2>${esc(L.oneTimeTitle)}</h2>
      ${oneTimeLines}
      <div class="sub"><span class="k">${esc(L.perLoc)}</span><span class="v">${money(d.oneTimePerLoc)}</span></div>
      <div class="chain"><span class="k">${esc(fill(L.chain, { n: n(i.numLocs) }))}</span><span class="v">${money(d.oneTimeChain, 0)}</span></div>
    </div>
    <div class="card">
      <h2>${esc(L.rates)}</h2>
      ${line(esc(L.markup), '', `${n(i.markupRate, 6)} %`)}
      ${line(esc(L.feeCredit), '', fee(i.txnFeeCredit))}
      ${line(esc(L.feeInterac), '', fee(i.txnFeeInterac))}
      <div class="note">${esc(L.ratesNote)}</div>
    </div>
  </div>
  <p class="note" style="margin-top:12pt">${esc(L.validity)}</p>
  ${footer(0)}
</section>
</body></html>`;
}

module.exports = { renderPricingHtml, buildPricing, PRICE_KEYS };
