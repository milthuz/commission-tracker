// ============================================================================
// Crédits de compensation marchand — le document, version 2 (HTML → PDF).
//
// Demande de David (2026-09-30) : l'aperçu montrait encore l'ANCIEN formulaire (le gabarit
// AcroForm), alors que la page de signature a été refaite. Le document reprend donc la page
// section par section, à la marque Cluster : en-tête sombre, infos du marchand, clauses 1 à 4,
// reconnaissance et signature ; en page 2 du document signé, le certificat de signature.
//
// Rendu par le MÊME service Chromium que les propositions (/render-html : JavaScript coupé,
// seules les ressources data: passent) — d'où la police Satoshi et le logo embarqués ici.
// Le texte des clauses est celui des deux PDF de David, mot pour mot.
//
// ⚠️ Tout ce qui vient du rep ou du client passe par esc() : c'est du HTML.
// ============================================================================

const fs = require('fs');
const path = require('path');

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let ASSETS = null;
function assets() {
  if (ASSETS) return ASSETS;
  const fonts = path.join(__dirname, '..', '..', 'assets', 'fonts');
  const faces = [['Regular', 400], ['Medium', 500], ['Bold', 700]].map(([w, n]) => {
    try {
      const b64 = fs.readFileSync(path.join(fonts, `Satoshi-${w}.woff2`)).toString('base64');
      return `@font-face{font-family:'Satoshi';font-weight:${n};src:url(data:font/woff2;base64,${b64}) format('woff2');}`;
    } catch { return ''; }
  }).join('');
  let logo = '';
  try { logo = 'data:image/svg+xml;base64,' + fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'credits', 'cluster-wordmark-on-dark.svg')).toString('base64'); } catch { /* texte en secours */ }
  ASSETS = { faces, logo };
  return ASSETS;
}

const COPY = {
  fr: {
    title: 'Crédit de compensation marchand', sub: 'Programme incitatif de transfert · Modalités et conditions',
    intro: "Dans le cadre de notre engagement à rendre votre transition vers Cluster <b>simple et sans risque</b>, nous avons le plaisir de vous offrir un <b>crédit de compensation</b> pour couvrir toute pénalité de résiliation anticipée imposée par votre processeur de paiement actuel. Veuillez lire attentivement toutes les conditions avant de signer.",
    info: 'Informations sur le marchand', legal: "Nom légal de l'entreprise", contact: 'Personne-ressource', phone: 'Numéro de téléphone', email: 'Adresse courriel',
    s1: 'Admissibilité',
    s1a: 'Le marchand doit être une entreprise active actuellement liée par un contrat avec un autre processeur de paiement.',
    s1b: "Le marchand doit avoir été facturé d'une <b>pénalité de résiliation anticipée ou d'annulation</b> par son processeur de paiement actuel, directement en raison de son passage à Cluster.",
    s2: 'Montant du crédit de compensation', amount: 'Montant du crédit offert',
    s2b: "Le crédit sera appliqué au compte Cluster du marchand dans les <b>30 jours ouvrables</b> suivant la réception et la vérification de tous les documents requis. Le crédit est non transférable et n'a aucune valeur monétaire.",
    s3: 'Reprise du crédit',
    s3b: "Si le marchand résilie son entente avec Cluster <b>avant la fin de la Période d'engagement de {m} mois</b>, Cluster se réserve le droit de <b>reprendre le crédit de compensation intégral</b>. Le montant dû deviendra immédiatement exigible et payable.",
    s4: 'Documents requis',
    s4a: 'Facture, relevé ou confirmation écrite du montant de la pénalité ou des frais imposés.',
    s4b: 'Preuve de paiement de ladite pénalité (relevé bancaire ou reçu).',
    s4c: 'Les documents doivent être remis à votre représentant Cluster ou joints à l’entente en ligne.',
    docs: 'Documents joints', ack: 'Reconnaissance et signature du marchand',
    ackb: "En signant ci-dessous, le marchand confirme avoir lu, compris et accepté l'ensemble des modalités et conditions de la présente entente.",
    name: 'Nom en lettres moulées', role: 'Titre / Fonction', sig: 'Signature autorisée', date: 'Date (JJ/MM/AAAA)',
    unsignedNote: 'Aperçu — non signé',
    footer: 'Ce document est confidentiel et destiné uniquement au marchand désigné.', rights: 'Cluster Systems Inc. Tous droits réservés.',
    cert: 'Certificat de signature électronique', ref: 'Référence', merchant: 'Marchand', amountK: 'Montant du crédit',
    recipient: 'Envoyé à', sentAt: 'Envoyé le', viewedAt: 'Consulté le', signedAt: 'Signé le', signer: 'Signataire',
    ip: 'Adresse IP', ua: 'Navigateur', sha: 'Empreinte SHA-256 du document présenté au signataire',
    consent: 'Le signataire a coché : « J\'ai lu et j\'accepte les modalités et conditions, et j\'accepte de signer électroniquement. »',
    certNote: 'La signature électronique a été apposée au moyen d\'un lien personnel et unique envoyé à l\'adresse ci-dessus.',
  },
  en: {
    title: 'Merchant Compensation Credit', sub: 'Switching Incentive Program · Terms & Conditions',
    intro: 'As part of our commitment to making your transition to Cluster <b>seamless and risk-free</b>, we are pleased to offer a <b>Compensation Credit</b> to offset any early-termination penalty charged by your current payment processor. Please read all conditions carefully before signing.',
    info: 'Merchant information', legal: 'Legal Business Name', contact: 'Contact Person', phone: 'Phone Number', email: 'Email Address',
    s1: 'Eligibility',
    s1a: 'The merchant must be an active business currently under a contract with another payment processor.',
    s1b: 'The merchant must have been assessed an <b>early-termination or cancellation penalty</b> by their existing payment processor as a direct result of switching to Cluster.',
    s2: 'Compensation Credit Amount', amount: 'Credit Amount Offered',
    s2b: "The credit will be applied to the merchant's Cluster account within <b>30 business days</b> of receiving and verifying all required documentation. The credit is non-transferable and has no cash value.",
    s3: 'Credit Clawback',
    s3b: 'If the merchant terminates their agreement with Cluster <b>before the end of the {m}-month Commitment Period</b>, Cluster reserves the right to <b>reclaim the full Compensation Credit</b>. The outstanding amount will become immediately due and payable.',
    s4: 'Required Documentation',
    s4a: 'Invoice, statement, or written confirmation of the penalty or fee amount charged.',
    s4b: 'Proof of payment of such penalty (bank statement or receipt).',
    s4c: 'Documents must be submitted to your Cluster representative or attached to the agreement online.',
    docs: 'Attached documents', ack: 'Merchant Acknowledgement & Signature',
    ackb: 'By signing below, the merchant confirms they have read, understood, and agreed to all terms and conditions of this Merchant Compensation Credit agreement.',
    name: 'Print Name', role: 'Title / Role', sig: 'Authorized Signature', date: 'Date (DD/MM/YYYY)',
    unsignedNote: 'Preview — not signed',
    footer: 'This document is confidential and intended solely for the named merchant.', rights: 'Cluster Systems Inc. All rights reserved.',
    cert: 'Electronic Signature Certificate', ref: 'Reference', merchant: 'Merchant', amountK: 'Credit amount',
    recipient: 'Sent to', sentAt: 'Sent', viewedAt: 'Viewed', signedAt: 'Signed', signer: 'Signer',
    ip: 'IP address', ua: 'Browser', sha: 'SHA-256 fingerprint of the document presented to the signer',
    consent: 'The signer checked: "I have read and accept the terms and conditions, and I agree to sign electronically."',
    certNote: 'The electronic signature was applied through a personal, unique link sent to the address above.',
  },
};

function money(amount, lang) {
  const v = Number(amount) || 0;
  return lang === 'en'
    ? `$${v.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `${v.toLocaleString('fr-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/[  ]/g, ' ')} $`;
}

function ddmmyyyy(d) {
  const x = new Date(d);
  return `${String(x.getDate()).padStart(2, '0')}/${String(x.getMonth() + 1).padStart(2, '0')}/${x.getFullYear()}`;
}

function stamp(d, lang) {
  if (!d) return '—';
  return new Date(d).toLocaleString(lang === 'en' ? 'en-CA' : 'fr-CA', { timeZone: 'America/Toronto', dateStyle: 'long', timeStyle: 'medium' }) + ' (HE)';
}

const CSS = `
@page { size: 612pt 792pt; margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { background: #fff; }
body { font-family: 'Satoshi', system-ui, sans-serif; color: #1a1a1a; font-size: 8.6pt; line-height: 1.42; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
b { font-weight: 700; }
.page { width: 612pt; height: 792pt; position: relative; overflow: hidden; page-break-after: always; background: #F6F5F3; }
.page:last-child { page-break-after: auto; }
.top { background: #1F1F1F; padding: 16pt 40pt; display: flex; align-items: center; justify-content: space-between; }
.top img { height: 19pt; }
.top .wm { color: #fff; font-size: 17pt; font-weight: 700; }
.top .ref { color: rgba(255,255,255,.6); font-size: 7pt; letter-spacing: .08em; }
.bar { height: 3pt; background: #F26B21; }
.body { padding: 16pt 40pt 0; }
.eyebrow { color: #F26B21; font-size: 6.8pt; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; }
h1 { font-size: 19pt; font-weight: 700; letter-spacing: -.01em; margin-top: 2pt; }
.intro { color: #555; margin-top: 5pt; }
.card { background: #fff; border: .75pt solid #E6E3DE; border-radius: 9pt; padding: 10pt 13pt; margin-top: 8pt; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 8pt; margin-top: 8pt; }
.two .card { margin-top: 0; }
.card.info { border-left: 3pt solid #F26B21; }
.card h2 { font-size: 9.4pt; font-weight: 700; display: flex; align-items: center; gap: 7pt; margin-bottom: 5pt; }
.card.info h2 { color: #F26B21; font-size: 7pt; letter-spacing: .12em; text-transform: uppercase; }
.num { width: 15pt; height: 15pt; border-radius: 50%; background: #F26B21; color: #fff; font-size: 8pt; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6pt 12pt; }
.grid.three { grid-template-columns: 1fr 1fr 1fr; }
.f .k { font-size: 6.8pt; color: #6b6b6b; font-weight: 500; }
.f .v { margin-top: 1.5pt; border: .75pt solid #DCD8D2; border-radius: 5pt; padding: 4pt 7pt; min-height: 17pt; font-size: 9pt; font-weight: 500; background: #fff; overflow-wrap: anywhere; }
ul { list-style: none; }
li { display: flex; gap: 6pt; margin-top: 2.5pt; color: #333; }
li:before { content: ''; width: 3.5pt; height: 3.5pt; border-radius: 50%; background: #F26B21; margin-top: 4pt; flex-shrink: 0; }
.amount { display: flex; justify-content: space-between; align-items: baseline; background: #FFF4EC; border-radius: 6pt; padding: 6pt 10pt; margin-bottom: 5pt; }
.amount .k { font-weight: 500; color: #444; }
.amount .v { font-size: 15pt; font-weight: 700; color: #F26B21; }
.amount .v small { font-size: 8pt; color: #444; font-weight: 700; margin-left: 2pt; }
.claw { background: #FFF4EC; border: .75pt solid #F9C9A8; border-radius: 6pt; padding: 6pt 10pt; color: #222; }
.muted { color: #666; margin-top: 4pt; font-size: 7.8pt; }
.docs { margin-top: 4pt; font-size: 7.6pt; color: #333; }
.sigbox { margin-top: 1.5pt; border: .75pt dashed #CFCAC3; border-radius: 5pt; height: 44pt; background: #fff; display: flex; align-items: center; justify-content: center; }
.sigbox img { max-height: 40pt; max-width: 95%; }
.sigbox .ph { color: #B0AAA2; font-size: 7.5pt; letter-spacing: .06em; text-transform: uppercase; }
.foot { position: absolute; left: 40pt; right: 40pt; bottom: 14pt; display: flex; justify-content: space-between; color: #9A958E; font-size: 6.4pt; }
.cert .row { display: grid; grid-template-columns: 150pt 1fr; gap: 10pt; padding: 5pt 0; border-bottom: .75pt solid #EEEBE6; }
.cert .row:last-child { border-bottom: 0; }
.cert .row .k { color: #777; font-weight: 700; font-size: 7.6pt; }
.cert .row .v { overflow-wrap: anywhere; }
.mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 7.6pt; }
`;

// c : la ligne merchant_credits (ou ses valeurs fusionnées avec la saisie du client).
// opts : { sig: {name,title,at,ip,ua,image} | null, sha: empreinte du document présenté, docs: [noms], commitmentMonths }
function renderCreditHtml(c, { sig = null, sha = null, docs = [], commitmentMonths = 36 } = {}) {
  const lang = c.lang === 'en' ? 'en' : 'fr';
  const L = COPY[lang];
  const { faces, logo } = assets();
  const field = (k, v) => `<div class="f"><div class="k">${esc(k)}</div><div class="v">${esc(v || '')}</div></div>`;
  const year = new Date(sig ? sig.at : Date.now()).getFullYear();
  const sigImg = sig && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(String(sig.image || ''))
    ? `<img src="${sig.image}" alt="">` : `<span class="ph">${esc(sig ? '' : L.unsignedNote)}</span>`;
  const header = `<div class="top">${logo ? `<img src="${logo}" alt="Cluster">` : '<span class="wm">cluster</span>'}<span class="ref">${esc(c.ref || '')}</span></div><div class="bar"></div>`;
  const foot = (n) => `<div class="foot"><span>${esc(L.footer)} © ${year} ${esc(L.rights)}</span><span>clusterpos.com · ${n}</span></div>`;
  const docLine = docs.length ? `<div class="docs"><b>${esc(L.docs)} :</b> ${docs.map(esc).join(' · ')}</div>` : '';

  const page1 = `<section class="page">${header}<div class="body">
    <div class="eyebrow">${esc(L.sub)}</div>
    <h1>${esc(L.title)}</h1>
    <p class="intro">${L.intro}</p>
    <div class="card info"><h2>${esc(L.info)}</h2>
      <div class="grid">${field(L.legal, c.legal_name)}${field(L.contact, c.contact_person)}${field(L.phone, c.phone)}${field(L.email, c.email)}</div>
    </div>
    <div class="two">
    <div class="card"><h2><span class="num">1</span>${esc(L.s1)}</h2><ul><li><span>${L.s1a}</span></li><li><span>${L.s1b}</span></li></ul></div>
    <div class="card"><h2><span class="num">2</span>${esc(L.s2)}</h2>
      <div class="amount"><span class="k">${esc(L.amount)}</span><span class="v">${esc(money(c.amount, lang))}<small>CAD</small></span></div>
      <div>${L.s2b}</div></div>
    <div class="card"><h2><span class="num">3</span>${esc(L.s3)}</h2><div class="claw">${L.s3b.replace('{m}', String(Number(commitmentMonths) || 36))}</div></div>
    <div class="card"><h2><span class="num">4</span>${esc(L.s4)}</h2><ul><li><span>${L.s4a}</span></li><li><span>${L.s4b}</span></li></ul>
      <div class="muted">${esc(L.s4c)}</div>${docLine}</div>
    </div>
    <div class="card"><h2>${esc(L.ack)}</h2><div style="color:#333;margin-bottom:6pt">${esc(L.ackb)}</div>
      <div class="grid three">${field(L.name, sig && sig.name)}${field(L.role, sig && sig.title)}${field(L.date, sig ? ddmmyyyy(sig.at) : '')}</div>
      <div class="f" style="margin-top:6pt"><div class="k">${esc(L.sig)}</div><div class="sigbox">${sigImg}</div></div>
    </div>
  </div>${foot(1)}</section>`;

  const page2 = sig ? `<section class="page">${header}<div class="body">
    <div class="eyebrow">${esc(L.title)}</div><h1>${esc(L.cert)}</h1>
    <div class="card cert">
      ${[[L.ref, c.ref], [L.merchant, c.legal_name], [L.amountK, `${money(c.amount, lang)} CAD`], [L.recipient, c.email],
    [L.sentAt, stamp(c.sent_at, lang)], [L.viewedAt, stamp(c.viewed_at, lang)], [L.signedAt, stamp(sig.at, lang)],
    [L.signer, `${sig.name}${sig.title ? ' — ' + sig.title : ''}`], [L.ip, sig.ip || '—'], [L.ua, sig.ua || '—']]
      .map(([k, v]) => `<div class="row"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('')}
      <div class="row"><div class="k">${esc(L.sha)}</div><div class="v mono">${esc(sha || '—')}</div></div>
    </div>
    <p class="muted" style="margin-top:10pt">${esc(L.consent)}</p>
    <p class="muted">${esc(L.certNote)}</p>
  </div>${foot(2)}</section>` : '';

  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><style>${faces}${CSS}</style></head><body>${page1}${page2}</body></html>`;
}

module.exports = { renderCreditHtml, COPY };
