// ============================================================================
// Crédits de compensation marchand — génération des PDF.
//
// On part des DEUX formulaires fournis par David (assets/credits/form_fr.pdf et form_en.pdf, le
// même document en deux langues, 8 champs AcroForm identiques). On ne redessine rien : on
// remplit ses champs, puis on les APLATIT (le texte devient partie du dessin, plus modifiable).
//
//   renderUnsigned — ce que le client lit avant de signer : infos du marchand + montant remplis,
//                    zone de signature vide.
//   renderSigned   — la même page avec nom, titre, date et l'image de la signature, suivie d'un
//                    certificat de signature (horodatage, adresse IP, empreinte du document lu).
//
// ⚠️ pdf-lib écrit en Helvetica (WinAnsi) : un caractère hors de cet alphabet (guillemet courbe,
// emoji…) fait LEVER une exception au remplissage. safe() les remplace avant.
// ============================================================================

const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const ASSETS = path.join(__dirname, '..', '..', 'assets', 'credits');
const TEMPLATE = { fr: 'form_fr.pdf', en: 'form_en.pdf' };

// Zone de la signature, en points depuis le BAS de la page (repère pdf-lib). La ligne
// « Signature autorisée » est à 711,1 pt du haut en FR et 723,1 pt en EN (mesuré sur les
// gabarits) ; l'étiquette occupe x 44–125, on signe donc à sa droite, posé sur la ligne.
const SIG_BOX = {
  fr: { x: 130, y: 792 - 711.1 + 1, w: 245, h: 24 },
  en: { x: 135, y: 792 - 723.1 + 1, w: 240, h: 24 },
};

const WINANSI_MAP = { '’': "'", '‘': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...', ' ': ' ', ' ': ' ' };
function safe(s) {
  return String(s == null ? '' : s)
    .replace(/[‘’“”–—…  ]/g, (c) => WINANSI_MAP[c])
    // tout ce qui reste hors Latin-1 imprimable disparaît plutôt que de faire échouer le PDF
    .replace(/[^\x20-\x7e\xa0-\xff]/g, '')
    .slice(0, 200);
}

// Montant tel qu'imprimé dans la case « $ CAD » du formulaire.
function formatAmount(amount, lang) {
  const v = Number(amount);
  return lang === 'en'
    ? v.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : v.toLocaleString('fr-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/[  ]/g, ' ');
}

function formatDate(d, lang) {
  const dt = new Date(d);
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${dt.getFullYear()}`; // les deux gabarits demandent JJ/MM/AAAA
}

async function loadTemplate(lang) {
  const file = path.join(ASSETS, TEMPLATE[lang === 'en' ? 'en' : 'fr']);
  return PDFDocument.load(fs.readFileSync(file));
}

async function fill(doc, values) {
  const form = doc.getForm();
  for (const [name, value] of Object.entries(values)) {
    try { form.getTextField(name).setText(safe(value)); } catch { /* champ absent : ignoré */ }
  }
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  form.updateFieldAppearances(helv);
  form.flatten();
}

function merchantFields(c) {
  return {
    legal_business_name: c.legal_name,
    contact_person: c.contact_person,
    phone_number: c.phone,
    email_address: c.email,
    credit_amount: formatAmount(c.amount, c.lang),
  };
}

// PDF lu par le client avant de signer — ancien gabarit (secours).
async function templateUnsigned(c) {
  const doc = await loadTemplate(c.lang);
  await fill(doc, merchantFields(c));
  doc.setTitle(c.lang === 'en' ? 'Merchant Compensation Credit' : 'Crédit de compensation marchand');
  return Buffer.from(await doc.save());
}

const CERT = {
  fr: {
    title: 'Certificat de signature électronique', ref: 'Référence', merchant: 'Marchand', amount: 'Montant du crédit',
    recipient: 'Envoyé à', sentAt: 'Envoyé le', viewedAt: 'Consulté le', signedAt: 'Signé le', signer: 'Signataire',
    ip: 'Adresse IP', ua: 'Navigateur', sha: 'Empreinte SHA-256 du document présenté au signataire',
    consent: 'Le signataire a coché : « J\'ai lu et j\'accepte les modalités et conditions, et j\'accepte de signer électroniquement. »',
    note: 'La signature électronique a été apposée au moyen d\'un lien personnel et unique envoyé à l\'adresse ci-dessus.',
  },
  en: {
    title: 'Electronic Signature Certificate', ref: 'Reference', merchant: 'Merchant', amount: 'Credit amount',
    recipient: 'Sent to', sentAt: 'Sent', viewedAt: 'Viewed', signedAt: 'Signed', signer: 'Signer',
    ip: 'IP address', ua: 'Browser', sha: 'SHA-256 fingerprint of the document presented to the signer',
    consent: 'The signer checked: "I have read and accept the terms and conditions, and I agree to sign electronically."',
    note: 'The electronic signature was applied through a personal, unique link sent to the address above.',
  },
};

function stamp(d, lang) {
  if (!d) return '—';
  return new Date(d).toLocaleString(lang === 'en' ? 'en-CA' : 'fr-CA', { timeZone: 'America/Toronto', dateStyle: 'long', timeStyle: 'medium' }) + ' (HE)';
}

async function addCertificate(doc, c, sig, unsignedSha) {
  const L = CERT[c.lang === 'en' ? 'en' : 'fr'];
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const orange = rgb(0xfe / 255, 0x65 / 255, 0x23 / 255);
  const ink = rgb(0.1, 0.1, 0.1);
  const grey = rgb(0.42, 0.42, 0.42);
  page.drawRectangle({ x: 0, y: 786, width: 612, height: 6, color: orange });
  let y = 740;
  page.drawText(safe(L.title), { x: 48, y, size: 18, font: bold, color: ink });
  y -= 36;
  const row = (k, v) => {
    page.drawText(safe(k), { x: 48, y, size: 9, font: bold, color: grey });
    // valeurs longues (navigateur) : coupées proprement sur plusieurs lignes
    const text = safe(v);
    const max = 60;
    for (let i = 0; i < text.length || i === 0; i += max) {
      page.drawText(text.slice(i, i + max), { x: 210, y, size: 9.5, font, color: ink });
      y -= 15;
      if (i + max >= text.length) break;
    }
    y -= 4;
  };
  row(L.ref, c.ref);
  row(L.merchant, c.legal_name);
  row(L.amount, `${formatAmount(c.amount, c.lang)} $ CAD`);
  row(L.recipient, c.email);
  row(L.sentAt, stamp(c.sent_at, c.lang));
  row(L.viewedAt, stamp(c.viewed_at, c.lang));
  row(L.signedAt, stamp(sig.at, c.lang));
  row(L.signer, `${sig.name}${sig.title ? ' — ' + sig.title : ''}`);
  row(L.ip, sig.ip || '—');
  row(L.ua, sig.ua || '—');
  y -= 6;
  page.drawText(safe(L.sha), { x: 48, y, size: 9, font: bold, color: grey });
  y -= 15;
  page.drawText(unsignedSha, { x: 48, y, size: 8.5, font, color: ink });
  y -= 30;
  for (const para of [L.consent, L.note]) {
    const words = safe(para).split(' ');
    let lineTxt = '';
    for (const w of words) {
      const next = lineTxt ? `${lineTxt} ${w}` : w;
      if (font.widthOfTextAtSize(next, 9) > 516) { page.drawText(lineTxt, { x: 48, y, size: 9, font, color: grey }); y -= 13; lineTxt = w; }
      else lineTxt = next;
    }
    if (lineTxt) { page.drawText(lineTxt, { x: 48, y, size: 9, font, color: grey }); y -= 13; }
    y -= 8;
  }
}

// PDF signé : formulaire rempli + signature + certificat — ancien gabarit (secours).
// sig = { name, title, at, ip, ua, image (data:image/png;base64,…) }
async function templateSigned(c, sig, unsignedSha) {
  const doc = await loadTemplate(c.lang);
  await fill(doc, {
    ...merchantFields(c),
    print_name: sig.name,
    title_role: sig.title,
    date: formatDate(sig.at, c.lang),
  });
  const png = await doc.embedPng(Buffer.from(String(sig.image).split(',')[1], 'base64'));
  const box = SIG_BOX[c.lang === 'en' ? 'en' : 'fr'];
  const k = Math.min(box.w / png.width, box.h / png.height);
  doc.getPage(0).drawImage(png, { x: box.x, y: box.y, width: png.width * k, height: png.height * k });
  await addCertificate(doc, c, sig, unsignedSha);
  doc.setTitle(c.lang === 'en' ? 'Merchant Compensation Credit — signed' : 'Crédit de compensation marchand — signé');
  return Buffer.from(await doc.save());
}

// ── Document v2 (2026-09-30) : même présentation que la page de signature ──
// Rendu HTML → PDF par le service Chromium des propositions. S'il est absent ou en panne, on
// retombe sur l'ancien gabarit : une signature client ne doit JAMAIS échouer pour une question de
// mise en page. Le document rendu est de toute façon celui qu'on fige et qu'on hache.
const axios = require('axios');
const { renderCreditHtml } = require('./html');
const { renderHtmlUrl } = require('../revenueModel/chainProposal');

let htmlRenderer = async (html) => {
  const url = renderHtmlUrl();
  if (!url) throw new Error('render_not_configured');
  const r = await axios.post(url, { html, token: process.env.PROPOSAL_RENDER_TOKEN || '' }, {
    responseType: 'arraybuffer', timeout: 45000, validateStatus: () => true,
  });
  if (r.status !== 200 || !r.data || r.data.byteLength < 1000) throw new Error(`render_failed_${r.status}`);
  return Buffer.from(r.data);
};
// Tests : remplacer le service de rendu (null = retour au vrai).
function setHtmlRenderer(fn) { htmlRenderer = fn; }

async function viaHtml(html, fallback) {
  try { return await htmlRenderer(html); } catch (e) {
    if (!/not_configured/.test(e.message)) console.warn('[credits] rendu HTML indisponible, ancien gabarit utilisé :', e.message);
    return fallback();
  }
}

// opts : { docs: [noms des pièces jointes], commitmentMonths }
async function renderUnsigned(c, opts = {}) {
  return viaHtml(renderCreditHtml(c, { docs: opts.docs || [], commitmentMonths: opts.commitmentMonths }), () => templateUnsigned(c));
}

async function renderSigned(c, sig, unsignedSha, opts = {}) {
  return viaHtml(renderCreditHtml(c, { sig, sha: unsignedSha, docs: opts.docs || [], commitmentMonths: opts.commitmentMonths }), () => templateSigned(c, sig, unsignedSha));
}

module.exports = { renderUnsigned, renderSigned, templateUnsigned, templateSigned, setHtmlRenderer, formatAmount, safe, SIG_BOX };
