// ============================================================================
// RH — rendu PDF de l'offre d'emploi, de l'entente de rémunération et du certificat.
//
// pdfkit côté serveur, comme tous les autres PDF de l'application (voir services/icplus/pdf.js
// pour le pourquoi). La mise en page de l'entente reproduit celle des PDF v7.7 d'avril 2026 :
// bandeau noir, filet orange, bande d'identification, tableaux à en-tête pêche.
//
// 🔑 UN SEUL RENDU PAR DOCUMENT, SIGNÉ OU NON. Le même code produit la version envoyée (cases
// de signature vides) et la version finale (signatures dessinées dedans) à partir du même
// instantané figé à l'envoi — le texte signé ne peut donc pas différer du texte lu.
//
// ⚠️ Polices standard pdfkit = encodage WinAnsi. L'espace fine insécable que toLocaleString
// ('fr-CA') met dans « 1 000 $ » (U+202F) n'y existe pas et sortirait en charabia : money()
// la remplace par une espace ordinaire. Même raison pour éviter ≥, ✓ et autres symboles.
// ============================================================================

const PDFDocument = require('pdfkit');
const { PDFDocument: LibDoc } = require('pdf-lib');
const T = require('./text');
const EMP = require('./employers');

const INK = '#1f1f1f';
const TEXT = '#222222';
const MUTED = '#6b7280';
const ORANGE = '#f26b21';
const PEACH = '#fdf0e6';
const ZEBRA = '#f5f5f5';
const RULE = '#d4d4d4';
const GREEN = '#15803d';
const GREEN_BG = '#effaf2';
const RED = '#c2410c';
const RED_BG = '#fff4f1';

const W = 612;
const H = 792;
const M = 54;
const CW = W - 2 * M;
const BOTTOM = H - 64; // réserve pour le pied de page

const clean = (s) => String(s == null ? '' : s).replace(/\u202f/g, '\u00a0');

function money(n, lang) {
  const v = Number(n) || 0;
  const frac = Math.round(v * 100) % 100 !== 0 ? 2 : 0;
  if (lang === 'fr') return clean(v.toLocaleString('fr-CA', { minimumFractionDigits: frac, maximumFractionDigits: frac })) + '\u00a0$';
  return '$' + v.toLocaleString('en-CA', { minimumFractionDigits: frac, maximumFractionDigits: frac });
}
const pct = (n, lang) => (lang === 'fr' ? `${clean(Number(n).toLocaleString('fr-CA'))}\u00a0%` : `${Number(n)}%`);
const numTxt = (n, lang) => clean(Number(n).toLocaleString(lang === 'fr' ? 'fr-CA' : 'en-CA'));

// « September 23, 2026 » / « 23 septembre 2026 », sans passer par un Date en UTC (un
// `new Date('2026-09-23')` affiché à Montréal serait le 22).
const MONTHS = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
};
function longDate(iso, lang) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return '';
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return lang === 'fr' ? `${d === 1 ? '1er' : d} ${MONTHS.fr[mo - 1]} ${y}` : `${MONTHS.en[mo - 1]} ${d}, ${y}`;
}
// Horodatage d'une signature, heure de Montréal.
function stamp(ts, lang) {
  if (!ts) return '';
  return clean(new Date(ts).toLocaleString(lang === 'fr' ? 'fr-CA' : 'en-CA', {
    timeZone: 'America/Toronto', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }));
}
const isoDay = (ts) => {
  if (!ts) return '';
  // Jour civil à Montréal, pas en UTC (une signature à 22 h serait datée du lendemain).
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
};

function sigBuffer(sig) {
  if (!sig || !sig.image) return null;
  const m = /^data:image\/png;base64,(.+)$/.exec(sig.image);
  return m ? Buffer.from(m[1], 'base64') : null;
}

function collect(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

function newDoc(title, author = 'Cluster Systems') {
  return new PDFDocument({
    size: 'LETTER', margins: { top: M, bottom: H - BOTTOM, left: M, right: M }, bufferPages: true,
    info: { Title: title, Author: author, Producer: 'Sales Hub' },
  });
}

// Mot-symbole « cluster » : c orange + « luster ». En texte plutôt qu'en image : net à tout
// agrandissement et identique au logo des PDF v7.7.
function wordmark(doc, x, y, size, rest) {
  doc.font('Helvetica').fontSize(size).fillColor(ORANGE).text('c', x, y, { lineBreak: false, continued: true })
    .fillColor(rest).text('luster', { lineBreak: false });
}

function brandMark(doc, emp, x, y, maxW) {
  if (!emp || emp.key === 'cluster') { wordmark(doc, x, y + 2, 26, '#ffffff'); return; }
  const logo = EMP.logoBuffer(emp);
  if (logo) {
    try {
      doc.save().roundedRect(x - 6, y - 4, maxW + 12, 36, 4).fill('#ffffff').restore();
      doc.image(logo.buf, x, y - 1, { fit: [maxW, 30], align: 'left', valign: 'center' });
      return;
    } catch { /* logo illisible : on retombe sur le nom */ }
  }
  doc.font('Helvetica-Bold').fontSize(20).fillColor('#ffffff').text(emp.shortName, x, y + 4, { width: maxW, lineBreak: false, ellipsis: true });
}

// En-têtes et pieds dessinés APRÈS coup, page par page (bufferPages). Les dessiner sur
// l'événement pageAdded dérègle la police et la position d'un paragraphe `continued` coupé
// par le saut de page — c'est ce qui chevauchait le texte de l'offre.
function footer(doc, left, right, header, emp) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    if (header) header();
    const y = H - 48;
    doc.save().moveTo(M, y - 6).lineTo(W - M, y - 6).lineWidth(0.5).strokeColor('#e5e5e5').stroke().restore();
    const saved = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    if (emp && emp.key !== 'cluster') {
      doc.font('Helvetica-Bold').fontSize(8).fillColor(ORANGE).text(emp.shortName, M, y, { lineBreak: false, continued: true })
        .font('Helvetica').fillColor(MUTED).text(EMP.applyEmployer(left, emp), { lineBreak: false, width: CW - 160 });
    } else {
      doc.font('Helvetica-Bold').fontSize(8).fillColor(ORANGE).text('c', M, y, { lineBreak: false, continued: true })
        .font('Helvetica').fillColor(MUTED).text(`luster${left}`, { lineBreak: false, width: CW - 160 });
    }
    const r = typeof right === 'function' ? right(i - range.start + 1, range.count) : right;
    if (r) doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(r, W - M - 220, y, { width: 220, align: 'right', lineBreak: false });
    doc.page.margins.bottom = saved;
  }
}

// ---------------------------------------------------------------------------
// Primitives de mise en page (curseur vertical explicite, saut de page contrôlé).
// ---------------------------------------------------------------------------
function flow(doc) {
  const st = { y: M };
  const ensure = (h) => { if (st.y + h > BOTTOM) { doc.addPage(); st.y = M; } };
  const para = (text, { size = 10, font = 'Helvetica', color = TEXT, gap = 8, x = M, width = CW, align = 'left' } = {}) => {
    doc.font(font).fontSize(size);
    const h = doc.heightOfString(text, { width, lineGap: 1.5 });
    ensure(h);
    doc.fillColor(color).text(text, x, st.y, { width, lineGap: 1.5, align });
    st.y += h + gap;
  };
  return { st, ensure, para };
}

function table(doc, f, cols, rows, { firstBold = true, align = [] } = {}) {
  const pad = 7;
  const totalW = cols.reduce((a, c) => a + c.w, 0);
  const scale = CW / totalW;
  const widths = cols.map((c) => c.w * scale);
  const rowH = (cells, bold) => Math.max(...cells.map((c, i) => {
    doc.font(bold || (firstBold && i === 0) ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5);
    return doc.heightOfString(String(c), { width: widths[i] - 2 * pad, lineGap: 1 });
  })) + 2 * pad;
  const drawRow = (cells, { header = false, zebra = false } = {}) => {
    const h = rowH(cells, header);
    f.ensure(h);
    const y = f.st.y;
    doc.save().rect(M, y, CW, h).fill(header ? PEACH : (zebra ? ZEBRA : '#ffffff')).restore();
    if (header) doc.save().moveTo(M, y + h).lineTo(M + CW, y + h).lineWidth(0.8).strokeColor('#f3c9a8').stroke().restore();
    let x = M;
    cells.forEach((c, i) => {
      doc.font(header || (firstBold && i === 0) ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5).fillColor(TEXT)
        .text(String(c), x + pad, y + pad, { width: widths[i] - 2 * pad, lineGap: 1, align: align[i] || 'left' });
      if (i > 0) doc.save().moveTo(x, y).lineTo(x, y + h).lineWidth(0.4).strokeColor('#e8e8e8').stroke().restore();
      x += widths[i];
    });
    f.st.y += h;
  };
  // L'en-tête ne reste jamais seul en bas de page : il part avec sa première ligne.
  f.ensure(rowH(cols.map((c) => c.label), true) + (rows[0] ? rowH(rows[0], false) : 0));
  drawRow(cols.map((c) => c.label), { header: true });
  rows.forEach((r, i) => drawRow(r, { zebra: i % 2 === 1 }));
  doc.save().rect(M, f.st.y - 0.5, CW, 0.5).fill('#e5e5e5').restore();
  f.st.y += 12;
}

// ---------------------------------------------------------------------------
// Entente de rémunération
// ---------------------------------------------------------------------------
async function renderAgreement(snap, { employeeSig = null, companySig = null, lang: forced = null } = {}) {
  const lang = (forced || snap.hire.agreementLang) === 'fr' ? 'fr' : 'en';
  const L = T.AGREEMENT[lang];
  const p = snap.plan;
  const name = `${snap.hire.firstName} ${snap.hire.lastName}`;
  const position = lang === 'fr' ? snap.hire.positionFr : snap.hire.position;
  const emp = snap.employer || EMP.CLUSTER;
  const m = (n) => money(n, lang);
  const pc = (n) => pct(n, lang);
  const n = (v) => numTxt(v, lang);

  const doc = newDoc(`${L.docType} — ${name}`, emp.legalName);
  const out = collect(doc);
  const f = flow(doc);

  // Bandeau
  const bandH = 64;
  doc.rect(M, M, CW, bandH).fill(INK);
  doc.rect(M + CW * 0.34, M, CW * 0.66, bandH).fill('#262626');
  brandMark(doc, emp, M + 16, M + 10, CW * 0.3);
  doc.font('Helvetica').fontSize(7.5).fillColor('#a3a3a3').text(emp.website || '', M + 16, M + 48, { lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#ffffff').text(position, M, M + 11, { width: CW - 16, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(13).fillColor(ORANGE).text(L.docType, M, M + 28, { width: CW - 16, align: 'right' });
  doc.font('Helvetica').fontSize(8).fillColor('#e5e5e5').text(L.version(p.version), M, M + 46, { width: CW - 16, align: 'right' });
  f.st.y = M + bandH + 12;
  doc.rect(0 + M - 2, f.st.y, CW + 38, 1.6).fill(ORANGE);
  f.st.y += 14;

  // Bande d'identification
  const values = [name, position, snap.hire.supervisorName, longDate(snap.hire.startDate, lang)];
  const colW = CW / 4;
  doc.rect(M, f.st.y, CW, 50).fill('#f4f4f4');
  L.fields.forEach((label, i) => {
    const x = M + i * colW + 8;
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor(ORANGE).text(label, x, f.st.y + 7, { width: colW - 16, lineBreak: false });
    doc.font('Helvetica').fontSize(8.5).fillColor(TEXT).text(values[i] || '', x, f.st.y + 18, { width: colW - 16, height: 22, ellipsis: true, lineGap: 0 });
    doc.save().moveTo(x, f.st.y + 42).lineTo(x + colW - 16, f.st.y + 42).lineWidth(0.6).strokeColor('#bdbdbd').stroke().restore();
  });
  f.st.y += 66;

  f.para(L.agreementLabel, { size: 8.5, font: 'Helvetica-Bold', color: ORANGE, gap: 3 });
  f.para(EMP.applyEmployer(L.agreement(name, position), emp), { gap: 3 });
  f.para(L.agreementNote, { font: 'Helvetica-Oblique', color: '#555555', gap: 14 });

  let sec = 0;
  const section = (title) => {
    sec += 1;
    f.ensure(60);
    doc.font('Helvetica-Bold').fontSize(12.5).fillColor(INK).text(`${sec}.  ${title}`, M, f.st.y);
    f.st.y += 19;
    doc.rect(M, f.st.y, CW, 1.2).fill(ORANGE);
    f.st.y += 10;
  };

  section(L.s1);
  f.para(L.s1Intro, { gap: 10 });
  table(doc, f, [{ label: L.s1Cols[0], w: 1 }, { label: L.s1Cols[1], w: 3 }], L.s1Rows);
  // Encadré « principe fondamental »
  {
    doc.font('Helvetica').fontSize(10);
    const h = doc.heightOfString(L.corePrinciple, { width: CW - 22, lineGap: 1.5 }) + 16;
    f.ensure(h);
    doc.rect(M, f.st.y, CW, h).fill(PEACH);
    doc.rect(M, f.st.y, 2.5, h).fill(ORANGE);
    doc.fillColor(TEXT).text(L.corePrinciple, M + 12, f.st.y + 8, { width: CW - 22, lineGap: 1.5 });
    f.st.y += h + 16;
  }

  section(L.s2);
  f.para(L.s2Intro(p.monthlyQuota), { gap: 10 });
  {
    const half = (CW - 6) / 2;
    doc.font('Helvetica').fontSize(9);
    const bodyH = (lines) => lines.reduce((a, l) => a + doc.heightOfString(l, { width: half - 18 }) + 3, 0);
    const h = Math.max(bodyH(L.quotaMetLines), bodyH(L.quotaNotMetLines)) + 30;
    f.ensure(h);
    const box = (x, title, lines, color, bg) => {
      doc.rect(x, f.st.y, half, h).fill(bg);
      doc.rect(x, f.st.y, 2, h).fill(color);
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(color).text(title, x + 10, f.st.y + 8);
      let y = f.st.y + 24;
      for (const l of lines) {
        doc.font('Helvetica').fontSize(9).fillColor(TEXT).text(l, x + 10, y, { width: half - 18 });
        y += doc.heightOfString(l, { width: half - 18 }) + 3;
      }
    };
    box(M, L.quotaMet, L.quotaMetLines, GREEN, GREEN_BG);
    box(M + half + 6, L.quotaNotMet, L.quotaNotMetLines, RED, RED_BG);
    f.st.y += h + 12;
  }
  for (const note of L.s2Notes) f.para(note, { size: 8.5, font: 'Helvetica-Oblique', color: '#555555', gap: 2 });
  f.st.y += 12;

  section(L.s3);
  f.para(L.s3Intro, { gap: 10 });
  table(doc, f, [{ label: L.s3Cols[0], w: 3 }, { label: L.s3Cols[1], w: 1 }, { label: L.s3Cols[2], w: 1.2 }], L.s3Rows(p, n),
    { firstBold: false, align: ['left', 'center', 'center'] });
  f.para(L.s3Note(p, n), { size: 9, font: 'Helvetica-Oblique', color: '#555555', gap: 14 });

  section(L.s4);
  f.para(L.s4Intro, { gap: 10 });
  table(doc, f, [{ label: L.s4Cols[0], w: 1 }, { label: L.s4Cols[1], w: 1.4 }, { label: L.s4Cols[2], w: 1.9 }], L.s4Rows(p, m, pc));
  f.para(L.biAnnualTitle, { font: 'Helvetica-Bold', gap: 3 });
  f.para(L.biAnnual(p, m), { gap: 14 });

  section(L.s5);
  f.para(L.s5Intro(p.monthlyQuota), { gap: 10 });
  table(doc, f, [{ label: L.s5Cols[0], w: 1 }, { label: L.s5Cols[1], w: 1 }],
    p.monthlyTiers.map((t) => [L.points(n(t.points)), m(t.bonus)]), { firstBold: false });
  f.para(L.s5Note, { size: 9, font: 'Helvetica-Oblique', color: '#555555', gap: 14 });

  section(L.s6);
  f.para(L.s6Intro, { gap: 10 });
  table(doc, f, [{ label: L.s6Cols[0], w: 1 }, { label: L.s6Cols[1], w: 1 }],
    p.annualTiers.map((t) => [L.points(n(t.points)), m(t.bonus)]), { firstBold: false });
  f.para(L.s6Note, { size: 8.5, font: 'Helvetica-Oblique', color: '#555555', gap: 14 });

  section(L.s7);
  for (const para of L.s7Paras(p)) f.para(para);
  f.st.y += 6;

  section(L.s8);
  f.para(L.s8Intro, { gap: 8 });
  L.s8Items.forEach((item, i) => {
    const label = `(${String.fromCharCode(97 + i)})`;
    doc.font('Helvetica').fontSize(10);
    const h = doc.heightOfString(item, { width: CW - 28, lineGap: 1.5 });
    f.ensure(h);
    doc.fillColor(TEXT).text(label, M + 4, f.st.y, { lineBreak: false });
    doc.text(item, M + 28, f.st.y, { width: CW - 28, lineGap: 1.5 });
    f.st.y += h + 6;
  });

  // Page de signature
  doc.addPage();
  f.st.y = M;
  doc.rect(M, M, CW, 46).fill(INK);
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#ffffff').text(L.ackTitle, M, M + 10, { width: CW, align: 'center' });
  doc.font('Helvetica').fontSize(8.5).fillColor('#fdba8c').text(L.ackSub, M, M + 29, { width: CW, align: 'center' });
  f.st.y = M + 58;
  doc.rect(M - 2, f.st.y, CW + 38, 1.6).fill(ORANGE);
  f.st.y += 20;
  f.para(L.ack, { gap: 18 });

  const cardW = (CW - 18) / 2;
  const cardY = f.st.y;
  const card = (x, role, fullName, sig, ts) => {
    const h = 148;
    doc.save().rect(x, cardY, cardW, h).lineWidth(0.6).strokeColor('#e0e0e0').stroke().restore();
    doc.rect(x, cardY, 1.8, h).fill(ORANGE);
    const ix = x + 12;
    const iw = cardW - 24;
    doc.font('Helvetica-Bold').fontSize(7).fillColor(ORANGE).text(role, ix, cardY + 12);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#444444').text(L.fullName, ix, cardY + 30);
    doc.font('Helvetica').fontSize(9).fillColor(TEXT).text(fullName || '', ix, cardY + 41, { width: iw });
    doc.save().moveTo(ix, cardY + 54).lineTo(ix + iw, cardY + 54).lineWidth(0.6).strokeColor('#bdbdbd').stroke().restore();
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#444444').text(L.signature, ix, cardY + 64);
    const img = sigBuffer(sig);
    if (img) { try { doc.image(img, ix + 50, cardY + 58, { fit: [iw - 54, 34] }); } catch { /* image illisible : case laissée vide */ } }
    doc.save().moveTo(ix, cardY + 96).lineTo(ix + iw, cardY + 96).lineWidth(0.6).strokeColor('#bdbdbd').stroke().restore();
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#444444').text(L.date, ix, cardY + 106);
    if (ts) doc.font('Helvetica').fontSize(9).fillColor(TEXT).text(longDate(isoDay(ts), lang), ix + 40, cardY + 106);
    doc.save().moveTo(ix, cardY + 132).lineTo(ix + iw, cardY + 132).lineWidth(0.6).strokeColor('#bdbdbd').stroke().restore();
  };
  card(M, L.employee, name, employeeSig, employeeSig && employeeSig.at);
  card(M + cardW + 18, L.supervisor, snap.hire.supervisorName, companySig, companySig && companySig.at);
  f.st.y = cardY + 168;
  f.para(L.confidential, { size: 7.5, font: 'Helvetica-Oblique', color: MUTED, align: 'center' });

  footer(doc, L.footer(position, p.version), (i, n) => `${name}   ·   ${i} / ${n}`, null, emp);
  doc.end();
  return out;
}

// ---------------------------------------------------------------------------
// Offre d'emploi — FR ou EN (voir text.js). `lang` force une langue (versions de référence).
//
// Mise en page refaite le 2026-09-23 (demande de David : « plus beau ») dans le vocabulaire
// visuel de l'entente v7.7 : bandeau noir, filet orange, bande d'identification, titres de
// clause numérotés en orange, page d'acceptation en deux cartes. ⚠️ Le TEXTE juridique ne
// change pas : seuls sa présentation et l'identification des signataires ont bougé.
// ---------------------------------------------------------------------------
async function renderOffer(snap, { employeeSig = null, companySig = null, lang: forced = null } = {}) {
  const h = snap.hire;
  const lang = (forced || h.agreementLang) === 'fr' ? 'fr' : 'en';
  const O = T.OFFER[lang];
  const name = `${h.firstName} ${h.lastName}`;
  const m = (v) => money(v, lang);
  const position = lang === 'fr' ? (h.positionFr || h.position) : h.position;
  const managerTitle = lang === 'fr' ? (h.reportsToTitleFr || h.reportsToTitle) : h.reportsToTitle;
  const vars = {
    startDate: longDate(h.startDate, lang),
    reportsToTitle: managerTitle,
    reportsToName: h.reportsToName,
    annualSalary: m(h.annualSalary),
    vacationWeeks: String(snap.terms.vacationWeeks),
    position,
    salaryExtra: O.salaryExtra(snap.terms, m),
  };
  const emp = snap.employer || EMP.CLUSTER;
  // Variables d'abord, puis l'employeur (« Cluster » → nom court, « Cluster Systems » → nom légal).
  const fill = (s) => EMP.applyEmployer(s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : '')), emp);

  const doc = newDoc(`${O.title} — ${name}`, emp.legalName);
  const out = collect(doc);
  const f = flow(doc);
  const SIZE = 9.8;
  const GAP = 7;

  // --- Bandeau (même construction que l'entente) ---
  const bandH = 64;
  doc.rect(M, M, CW, bandH).fill(INK);
  doc.rect(M + CW * 0.34, M, CW * 0.66, bandH).fill('#262626');
  brandMark(doc, emp, M + 16, M + 10, CW * 0.3);
  doc.font('Helvetica').fontSize(7.5).fillColor('#a3a3a3').text(emp.website || '', M + 16, M + 48, { lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#ffffff').text(O.title, M, M + 11, { width: CW - 16, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(13).fillColor(ORANGE).text(position, M, M + 28, { width: CW - 16, align: 'right' });
  doc.font('Helvetica').fontSize(8).fillColor('#e5e5e5').text(O.confidential, M, M + 46, { width: CW - 16, align: 'right' });
  f.st.y = M + bandH + 12;
  doc.rect(M - 2, f.st.y, CW + 38, 1.6).fill(ORANGE);
  f.st.y += 14;

  // --- Bande d'identification ---
  const fields = [
    [O.fields[0], name],
    [O.fields[1], position],
    [O.fields[2], longDate(h.startDate, lang)],
    [O.fields[3], h.reportsToName + (managerTitle ? `, ${managerTitle}` : '')],
  ];
  const colW = CW / 4;
  doc.rect(M, f.st.y, CW, 50).fill('#f4f4f4');
  fields.forEach(([label, value], i) => {
    const x = M + i * colW + 8;
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor(ORANGE).text(label, x, f.st.y + 7, { width: colW - 16, lineBreak: false });
    doc.font('Helvetica').fontSize(8.5).fillColor(TEXT).text(value || '', x, f.st.y + 18, { width: colW - 16, height: 22, ellipsis: true, lineGap: 0 });
    doc.save().moveTo(x, f.st.y + 42).lineTo(x + colW - 16, f.st.y + 42).lineWidth(0.6).strokeColor('#bdbdbd').stroke().restore();
  });
  f.st.y += 66;

  // --- En-tête de lettre : date à droite, destinataire à gauche ---
  const top = f.st.y;
  doc.font('Helvetica').fontSize(SIZE).fillColor(MUTED).text(longDate(h.offerDate, lang), M, top, { width: CW, align: 'right' });
  const addrCity = [h.city, [h.province, h.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  let ay = top;
  for (const [i, line] of [name, h.addressLine1, addrCity, h.country].filter(Boolean).entries()) {
    doc.font(i === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(SIZE).fillColor(TEXT).text(line, M, ay, { width: CW * 0.6 });
    ay += 13;
  }
  f.st.y = ay + 12;
  f.para(fill(O.subject), { size: SIZE + 0.5, font: 'Helvetica-Bold', gap: 12 });
  f.para(O.dear(h.firstName), { size: SIZE, gap: GAP + 2 });
  for (const p of O.intro) f.para(fill(p), { size: SIZE, gap: GAP + 2 });
  f.st.y += 6;

  // --- Clauses : numéro orange + titre, filet léger, texte dessous ---
  for (const [title, body, kind] of O.clauses) {
    const text = fill(body);
    if (!text.trim()) continue;
    if (kind === 'item') {
      doc.font('Helvetica').fontSize(SIZE);
      const hh = doc.heightOfString(text, { width: CW - 44, lineGap: 1.5 });
      f.ensure(hh);
      doc.font('Helvetica-Bold').fillColor(ORANGE).text(title, M + 16, f.st.y, { lineBreak: false });
      doc.font('Helvetica').fillColor(TEXT).text(text, M + 44, f.st.y, { width: CW - 44, lineGap: 1.5 });
      f.st.y += hh + GAP;
      continue;
    }
    if (kind === 'sub') {
      f.st.y += 2;
      f.para(text, { size: SIZE + 0.2, font: 'Helvetica-Bold', color: TEXT, gap: 3 });
      continue;
    }
    if (!title) { f.para(text, { size: SIZE, gap: GAP + 1 }); continue; }
    const mm = /^(\d+)\.\s*(.*?)\.?$/.exec(title);
    const num = mm ? mm[1] : '';
    const label = mm ? mm[2] : title;
    // Même style que les sections de l'entente v7.7 (« 1.  Titre », filet orange pleine largeur),
    // pour que les deux documents se lisent comme un seul dossier. Le titre ne reste jamais seul
    // en bas de page : il part avec les premières lignes du texte.
    doc.font('Helvetica').fontSize(SIZE);
    // f.para() ne coupe pas un paragraphe : s'il ne tient pas, il part ENTIER à la page suivante.
    // Le titre doit donc réserver la hauteur du paragraphe complet (sinon « 8. Confidentialité »
    // restait seul en bas de page), sauf paragraphe plus haut qu'une page.
    const ph = doc.heightOfString(text, { width: CW, lineGap: 1.5 });
    f.ensure(36 + (ph < BOTTOM - M - 60 ? ph : 40));
    f.st.y += 8;
    doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text(`${num}.  ${label}`, M, f.st.y, { width: CW });
    f.st.y += 18;
    doc.rect(M, f.st.y, CW, 1.2).fill(ORANGE);
    f.st.y += 9;
    f.para(text, { size: SIZE, gap: GAP + 1 });
  }

  // --- Formule de politesse, signée par le gestionnaire ---
  // Formule + signature d'un seul bloc : la signature ne doit jamais partir seule en page suivante.
  f.st.y += 4;
  doc.font('Helvetica').fontSize(SIZE);
  f.ensure(O.closing.reduce((a, p) => a + doc.heightOfString(p, { width: CW, lineGap: 1.5 }) + GAP + 2, 0) + 70);
  for (const p of O.closing) f.para(fill(p), { size: SIZE, gap: GAP + 2 });
  f.para(h.reportsToName, { size: SIZE, font: 'Helvetica-Bold', gap: 1 });
  if (managerTitle) f.para(managerTitle, { size: SIZE, color: MUTED, gap: 1 });
  f.para(emp.legalName, { size: SIZE, color: MUTED, gap: 12 });
  f.para(O.blank, { size: 8.5, font: 'Helvetica-Oblique', color: MUTED, align: 'center' });

  // --- Page d'acceptation ---
  doc.addPage();
  doc.rect(M, M, CW, 46).fill(INK);
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#ffffff').text(O.ackTitle, M, M + 10, { width: CW, align: 'center' });
  doc.font('Helvetica').fontSize(8.5).fillColor('#fdba8c').text(O.ackSub, M, M + 29, { width: CW, align: 'center' });
  f.st.y = M + 58;
  doc.rect(M - 2, f.st.y, CW + 38, 1.6).fill(ORANGE);
  f.st.y += 20;
  f.para(O.ack, { size: SIZE, gap: 18 });

  // Le signataire pour Cluster : la personne qui a contresigné, sinon le gestionnaire du poste
  // (nom imprimé dès l'envoi — demande de David, 2026-09-23). Son titre n'est repris que si
  // c'est bien le gestionnaire du poste : on ne prête pas un titre à quelqu'un d'autre.
  const companyName = companySig ? companySig.name : h.reportsToName;
  const companyTitle = companyName === h.reportsToName ? managerTitle : '';
  const cardW = (CW - 18) / 2;
  const cardY = f.st.y;
  const card = (x, role, fullName, subtitle, sig, ts) => {
    const hC = 170;
    doc.save().rect(x, cardY, cardW, hC).lineWidth(0.6).strokeColor('#e0e0e0').stroke().restore();
    doc.rect(x, cardY, 1.8, hC).fill(ORANGE);
    const ix = x + 12;
    const iw = cardW - 24;
    doc.font('Helvetica-Bold').fontSize(7).fillColor(ORANGE).text(role, ix, cardY + 12);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#444444').text(O.fullName, ix, cardY + 30);
    doc.font('Helvetica').fontSize(9).fillColor(TEXT).text(fullName || '', ix, cardY + 41, { width: iw });
    if (subtitle) doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(subtitle, ix, cardY + 53, { width: iw, lineBreak: false, ellipsis: true });
    doc.save().moveTo(ix, cardY + 66).lineTo(ix + iw, cardY + 66).lineWidth(0.6).strokeColor('#bdbdbd').stroke().restore();
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#444444').text(O.signature, ix, cardY + 76);
    const img = sigBuffer(sig);
    if (img) { try { doc.image(img, ix + 58, cardY + 70, { fit: [iw - 62, 40] }); } catch { /* image illisible : case laissée vide */ } }
    doc.save().moveTo(ix, cardY + 114).lineTo(ix + iw, cardY + 114).lineWidth(0.6).strokeColor('#bdbdbd').stroke().restore();
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#444444').text(O.date, ix, cardY + 124);
    if (ts) doc.font('Helvetica').fontSize(9).fillColor(TEXT).text(longDate(isoDay(ts), lang), ix + 40, cardY + 124);
    doc.save().moveTo(ix, cardY + 152).lineTo(ix + iw, cardY + 152).lineWidth(0.6).strokeColor('#bdbdbd').stroke().restore();
  };
  card(M, `${emp.legalName.toUpperCase()} — ${O.manager.toUpperCase()}`, companyName, companyTitle, companySig, companySig && companySig.at);
  card(M + cardW + 18, O.employee, employeeSig ? employeeSig.name : name, position, employeeSig, employeeSig && employeeSig.at);
  f.st.y = cardY + 190;
  f.para(O.confidentialNote, { size: 7.5, font: 'Helvetica-Oblique', color: MUTED, align: 'center' });

  footer(doc, O.footer, (i, n) => `${name}   ·   ${O.page(i, n)}`, null, emp);
  doc.end();
  return out;
}

// ---------------------------------------------------------------------------
// Certificat de signature — dernière page du dossier signé. Bilingue : il sert de preuve aux
// deux parties, quelle que soit la langue de l'entente.
// ---------------------------------------------------------------------------
async function renderCertificate(info) {
  const doc = newDoc(`Certificate of completion — ${info.name}`);
  const out = collect(doc);
  const f = flow(doc);
  doc.rect(M, M, CW, 46).fill(INK);
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#ffffff').text('Certificate of Completion  ·  Certificat de signature', M, M + 10, { width: CW, align: 'center' });
  doc.font('Helvetica').fontSize(8.5).fillColor('#fdba8c').text(`${info.ref}  ·  Sales Hub e-signature`, M, M + 29, { width: CW, align: 'center' });
  f.st.y = M + 66;

  const kv = (k, v) => {
    doc.font('Helvetica').fontSize(9);
    const hh = Math.max(doc.heightOfString(String(v || '—'), { width: CW - 170 }), doc.font('Helvetica-Bold').heightOfString(k, { width: 165 }), 11);
    f.ensure(hh + 4);
    doc.font('Helvetica-Bold').fillColor('#444444').text(k, M, f.st.y, { width: 165 });
    doc.font('Helvetica').fillColor(TEXT).text(String(v || '—'), M + 170, f.st.y, { width: CW - 170 });
    f.st.y += hh + 5;
  };
  const head = (t) => { f.st.y += 8; f.ensure(30); doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(t, M, f.st.y); f.st.y += 16; doc.rect(M, f.st.y, CW, 1).fill(ORANGE); f.st.y += 8; };

  head('Documents');
  for (const d of info.documents) kv(d.title, `SHA-256 ${d.sha256}${d.pages ? `  ·  ${d.pages} p.` : ''}`);
  head('Employee / Employé(e)');
  kv('Name / Nom', info.employee.name);
  kv('Email / Courriel', info.employee.email);
  kv('Sent / Envoyé', stamp(info.sentAt, 'en'));
  kv('First opened / Ouvert', stamp(info.viewedAt, 'en'));
  kv('Signed / Signé', stamp(info.employee.at, 'en'));
  kv('Typed name / Nom saisi', info.employee.typedName);
  kv('IP address / Adresse IP', info.employee.ip);
  kv('Browser / Navigateur', info.employee.ua);
  kv('Consent / Consentement', 'Agreed to sign electronically / A consenti à signer électroniquement');
  head(info.employer ? info.employer.legalName : 'Cluster Systems');
  kv('Name / Nom', info.company.name);
  kv('Sales Hub account / Compte', info.company.email);
  kv('Countersigned / Contresigné', stamp(info.company.at, 'en'));
  kv('IP address / Adresse IP', info.company.ip);
  f.st.y += 14;
  f.para('The employee accessed the documents through a single-use link sent to the email address above, reviewed them, consented to sign electronically and applied a handwritten signature. The fingerprints (SHA-256) identify the exact unsigned documents that were presented. / L\'employé(e) a accédé aux documents par un lien à usage unique envoyé à l\'adresse ci-dessus, les a consultés, a consenti à signer électroniquement et y a apposé une signature manuscrite. Les empreintes (SHA-256) identifient les documents exacts présentés avant signature.', { size: 8.5, color: MUTED });
  footer(doc, '  |  Certificate of Completion', info.name, null, info.employer);
  doc.end();
  return out;
}

// Fusionne plusieurs PDF (Buffers) en un seul dossier. Une pièce jointe illisible est sautée
// plutôt que de faire échouer tout le dossier — le certificat en garde quand même l'empreinte.
async function mergePdfs(buffers) {
  const outDoc = await LibDoc.create();
  for (const buf of buffers) {
    if (!buf) continue;
    try {
      const src = await LibDoc.load(buf, { ignoreEncryption: true });
      const pages = await outDoc.copyPages(src, src.getPageIndices());
      pages.forEach((pg) => outDoc.addPage(pg));
    } catch (e) {
      console.warn('[HR] merge: skipped an unreadable PDF:', e.message);
    }
  }
  return Buffer.from(await outDoc.save());
}

async function pageCount(buf) {
  try { return (await LibDoc.load(buf, { ignoreEncryption: true })).getPageCount(); } catch { return null; }
}

module.exports = { renderAgreement, renderOffer, renderCertificate, mergePdfs, pageCount, money, longDate };
