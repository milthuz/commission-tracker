// ============================================================================
// IC+ fee-comparison calculator — the two PDF exports (§6).
//
// ⚠️ NO BUSINESS LOGIC LIVES HERE. Both exporters take the ALREADY-COMPUTED output of
// calc.recalc() and render it. §6 is explicit that the export is "pure presentation" and
// re-computes nothing — a PDF that derives its own numbers can disagree with the screen the
// rep just approved, which is the one thing a client-facing document must never do.
//
// WHY pdfkit RATHER THAN RASTERIZING THE PAGE. The reference tool builds these by screen-
// shotting a hidden DOM template, which is why §6 has to warn about re-syncing live input
// values onto a DOM clone and about page breaks landing inside collapsed panels. Rendering
// server-side from the computed result removes both problems rather than working around
// them, keeps the text selectable and searchable, and lets the same code emit either
// language. It also matches how every other PDF in this app is produced.
//
// ⚠️ TAXES ARE DELIBERATELY ABSENT FROM THE CLIENT PDF. §6 records this as a design
// decision, not an oversight: the client-facing document shows PRE-TAX figures only, even
// though the tax is computed and sits right there in the result. Changing that should be a
// signed-off decision, not a tidy-up. The detailed internal PDF does show tax.
// ============================================================================

const PDFDocument = require('pdfkit');
const N = require('./notes');
const { STATUS } = require('./classify');
const { auditTotals } = require('./calc');

// Sales Hub brand.
const INK = '#0f1722';
const ORANGE = '#f97316';
const MUTED = '#64748b';
const RULE = '#cbd5e1';
const PANEL = '#f8fafc';
const GOOD = '#15803d';
const BAD = '#b91c1c';

const PAGE = { size: 'LETTER', margin: 40 };

// PDF chrome, in both languages. Same reasoning as the parser notes: this text is produced
// server-side and consumed by a server-generated document, so splitting it into the
// frontend's i18n files would leave the PDFs with no source of text at all.
const LABELS = {
  clientTitle:    { fr: 'Comparatif de frais de traitement', en: 'Payment processing fee comparison' },
  detailTitle:    { fr: 'Analyse détaillée (interne)', en: 'Detailed analysis (internal)' },
  preparedFor:    { fr: 'Préparé pour', en: 'Prepared for' },
  preparedBy:     { fr: 'Préparé par', en: 'Prepared by' },
  preparedOn:     { fr: 'Date', en: 'Date' },
  validUntil:     { fr: 'Valide jusqu\'au', en: 'Valid until' },
  savingsMonthly: { fr: 'Économies par mois', en: 'Monthly savings' },
  savingsAnnual:  { fr: 'Économies par année', en: 'Annual savings' },
  volumeTitle:    { fr: 'Volume mensuel traité', en: 'Monthly processing volume' },
  cardType:       { fr: 'Type de carte', en: 'Card type' },
  count:          { fr: 'Transactions', en: 'Transactions' },
  amount:         { fr: 'Montant', en: 'Amount' },
  debit:          { fr: 'Débit Interac', en: 'Interac debit' },
  visa:           { fr: 'Visa', en: 'Visa' },
  mc:             { fr: 'Mastercard', en: 'Mastercard' },
  amex:           { fr: 'Amex / Discover', en: 'Amex / Discover' },
  total:          { fr: 'Total', en: 'Total' },
  currentSide:    { fr: 'Processeur actuel', en: 'Current processor' },
  clusterSide:    { fr: 'Nouveau — Cluster IC+', en: 'New — Cluster IC+' },
  txnFees:        { fr: 'Frais de transaction', en: 'Transaction fees' },
  markup:         { fr: 'Majoration', en: 'Markup' },
  interchange:    { fr: 'Interchange et frais réseau', en: 'Interchange and network fees' },
  fixedFees:      { fr: 'Frais fixes', en: 'Fixed fees' },
  pretaxTotal:    { fr: 'Total avant taxes', en: 'Total before tax' },
  tax:            { fr: 'Taxes', en: 'Tax' },
  grandTotal:     { fr: 'Total', en: 'Total' },
  notes:          { fr: 'Notes', en: 'Notes' },
  footer:         { fr: 'Cluster Systems · Cette analyse est fondée sur le relevé fourni et ne constitue pas une offre contractuelle.',
                    en: 'Cluster Systems · This analysis is based on the statement provided and is not a contractual offer.' },
  auditTitle:     { fr: 'Vérification ligne par ligne', en: 'Line-by-line audit' },
  auditInterchange:{ fr: 'Interchange', en: 'Interchange' },
  auditBrand:     { fr: 'Frais de marque et réseau', en: 'Brand and network fees' },
  auditInterac:   { fr: 'Interac', en: 'Interac' },
  colDesc:        { fr: 'Description', en: 'Description' },
  colApplied:     { fr: 'Taux facturé', en: 'Applied rate' },
  colPublished:   { fr: 'Taux publié', en: 'Published rate' },
  colTotal:       { fr: 'Montant', en: 'Amount' },
  colStatus:      { fr: 'Statut', en: 'Status' },
  marginTitle:    { fr: 'Rentabilité interne', en: 'Internal margin' },
  colBilled:      { fr: 'Facturé', en: 'Billed' },
  colCost:        { fr: 'Coût', en: 'Cost' },
  colRevenue:     { fr: 'Revenu', en: 'Revenue' },
  hiddenBumps:    { fr: 'Frais suspects (déjà inclus ci-dessus)', en: 'Suspect fees (already included above)' },
  noSavings:      { fr: 'Aucune économie sur ce volume — voir le détail ci-dessous.', en: 'No savings at this volume — see the detail below.' },
  internalOnly:   { fr: 'USAGE INTERNE — NE PAS REMETTRE AU CLIENT', en: 'INTERNAL USE — DO NOT GIVE TO THE CLIENT' },
};

const t = (key, lang) => (LABELS[key] || {})[lang] || (LABELS[key] || {}).fr || key;
const money = (v, lang) => N.fmtMoney(v || 0, lang);
const pct = (v, lang, d = 4) => (v == null ? '—' : N.fmtPct(v, lang, d));

// ---------------------------------------------------------------------------
// Filenames
//
// The merchant name drives both the "Prepared for" banner and the downloaded filename, so
// it has to survive being typed freely: strip the characters Windows and macOS reject,
// collapse whitespace, and cap the length before anything reaches the filesystem.
// ---------------------------------------------------------------------------
function sanitizeName(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function pdfFilename({ merchantName, date, salesperson, detailed, lang = 'fr' }) {
  const parts = [sanitizeName(merchantName) || (lang === 'en' ? 'Merchant' : 'Marchand'), ymd(date)];
  const who = sanitizeName(salesperson);
  if (who) parts.push(who);
  // A distinct suffix so the internal document can never overwrite the client one when both
  // are saved to the same folder.
  const suffix = detailed ? (lang === 'en' ? ' (detailed)' : ' (détaillé)') : '';
  return `${parts.join(' - ')}${suffix}.pdf`;
}

function ymd(d) {
  const dt = d instanceof Date ? d : new Date(d || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

function addDays(d, n) {
  const dt = new Date(d instanceof Date ? d.getTime() : Date.now());
  dt.setDate(dt.getDate() + n);
  return dt;
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------
function header(doc, { title, subtitle, lang }) {
  const w = doc.page.width;
  doc.rect(0, 0, w, 74).fill(INK);
  doc.rect(0, 74, w, 4).fill(ORANGE);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(17).text(title, 40, 24, { width: w - 80 });
  if (subtitle) doc.font('Helvetica').fontSize(9).fillColor('#cbd5e1').text(subtitle, 40, 48, { width: w - 80 });
  doc.fillColor(INK);
  doc.y = 100;
}

function sectionTitle(doc, label) {
  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(label, 40);
  doc.moveTo(40, doc.y + 2).lineTo(doc.page.width - 40, doc.y + 2).strokeColor(RULE).lineWidth(0.5).stroke();
  doc.moveDown(0.5);
}

function keyValueRow(doc, x, y, w, label, value, opts = {}) {
  doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.size || 9)
     .fillColor(opts.color || INK);
  doc.text(label, x, y, { width: w * 0.62, ellipsis: true });
  doc.text(value, x + w * 0.62, y, { width: w * 0.38, align: 'right' });
}

function footer(doc, lang) {
  const y = doc.page.height - 34;
  doc.moveTo(40, y - 8).lineTo(doc.page.width - 40, y - 8).strokeColor(RULE).lineWidth(0.5).stroke();
  doc.font('Helvetica').fontSize(7).fillColor(MUTED)
     .text(t('footer', lang), 40, y, { width: doc.page.width - 80, align: 'center' });
}

function ensureRoom(doc, needed) {
  if (doc.y + needed > doc.page.height - 60) { doc.addPage(PAGE); doc.y = 50; return true; }
  return false;
}

// ===========================================================================
// CLIENT-FACING SUMMARY PDF
//
// Pre-tax figures only. The hero banner appears ONLY when Cluster is genuinely cheaper.
// ===========================================================================
function buildClientPdf({ state, result, options = {} }) {
  const lang = options.lang === 'en' ? 'en' : 'fr';
  const doc = new PDFDocument(PAGE);
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const prepared = options.date ? new Date(options.date) : new Date();
  const expiry = addDays(prepared, options.validDays || 30);

  header(doc, {
    title: t('clientTitle', lang),
    subtitle: `${t('preparedFor', lang)} : ${state.merchantName || '—'}`,
    lang,
  });

  // ---- meta line
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED);
  const meta = [
    `${t('preparedOn', lang)} : ${ymd(prepared)}`,
    `${t('validUntil', lang)} : ${ymd(expiry)}`,
  ];
  if (options.salesperson) meta.splice(1, 0, `${t('preparedBy', lang)} : ${options.salesperson}`);
  doc.text(meta.join('     ·     '), 40, doc.y, { width: doc.page.width - 80 });
  doc.moveDown(0.8);

  // ---- savings hero.
  //
  // ⚠️ Shown ONLY when Cluster is actually cheaper. §6 is explicit: a red or zero "savings"
  // claim on a client document is worse than no banner at all, so the whole block is
  // omitted rather than rendered in a negative colour.
  if (result.savings.clusterIsCheaper) {
    const h = 62;
    const w = doc.page.width - 80;
    doc.roundedRect(40, doc.y, w, h, 6).fill(ORANGE);
    const saveM = Math.abs(result.savings.monthly);
    const saveY = Math.abs(result.savings.annual);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(22)
       .text(money(saveM, lang), 56, doc.y - h + 12, { width: w / 2 - 24 });
    doc.font('Helvetica').fontSize(9).text(t('savingsMonthly', lang), 56, doc.y + 2, { width: w / 2 - 24 });
    doc.font('Helvetica-Bold').fontSize(22)
       .text(money(saveY, lang), 40 + w / 2, doc.y - 26, { width: w / 2 - 16, align: 'right' });
    doc.font('Helvetica').fontSize(9)
       .text(t('savingsAnnual', lang), 40 + w / 2, doc.y + 2, { width: w / 2 - 16, align: 'right' });
    doc.fillColor(INK);
    doc.y += 18;
  }

  // ---- monthly volume
  sectionTitle(doc, t('volumeTitle', lang));
  const v = state.volume;
  const volRows = [
    [t('debit', lang), v.debit_count, v.debit_amt],
    [t('visa', lang), v.visa_count, v.visa_amt],
    [t('mc', lang), v.mc_count, v.mc_amt],
    [t('amex', lang), v.amex_count, v.amex_amt],
  ];
  const w3 = (doc.page.width - 80) / 3;
  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED);
  doc.text(t('cardType', lang), 40, doc.y, { width: w3, continued: false });
  doc.text(t('count', lang), 40 + w3, doc.y - 10, { width: w3, align: 'right' });
  doc.text(t('amount', lang), 40 + 2 * w3, doc.y - 10, { width: w3, align: 'right' });
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(9).fillColor(INK);
  for (const [label, c, a] of volRows) {
    const y = doc.y;
    doc.text(label, 40, y, { width: w3 });
    doc.text(String(c || 0), 40 + w3, y, { width: w3, align: 'right' });
    doc.text(money(a, lang), 40 + 2 * w3, y, { width: w3, align: 'right' });
    doc.moveDown(0.15);
  }
  const yTot = doc.y;
  doc.moveTo(40, yTot).lineTo(doc.page.width - 40, yTot).strokeColor(RULE).lineWidth(0.5).stroke();
  doc.moveDown(0.25);
  doc.font('Helvetica-Bold').fontSize(9);
  const y2 = doc.y;
  doc.text(t('total', lang), 40, y2, { width: w3 });
  doc.text(String(result.volume.totalCount || 0), 40 + w3, y2, { width: w3, align: 'right' });
  doc.text(money(result.volume.totalVolume, lang), 40 + 2 * w3, y2, { width: w3, align: 'right' });
  doc.moveDown(1);

  // ---- the two side-by-side cards.
  //
  // ⚠️ Both cards' rows must stay visually aligned. The reference tool does this by
  // inserting an invisible placeholder of matching height on the Cluster side whenever the
  // current side carries an extra note. Rendering directly, the same goal is met by driving
  // BOTH columns off one row list and advancing a single shared Y — the two sides cannot
  // drift apart because there is only one cursor.
  const gap = 16;
  const cardW = (doc.page.width - 80 - gap) / 2;
  const leftX = 40;
  const rightX = 40 + cardW + gap;

  const bumps = result.current.hiddenBumps || 0;
  const notesUnderCurrent = [];
  if (bumps > 0) notesUnderCurrent.push(`${t('hiddenBumps', lang)} : ${money(bumps, lang)}`);
  if (state.volumeNote) notesUnderCurrent.push(N.render(state.volumeNote, lang));

  const rows = [
    ['section', t('txnFees', lang), null, null],
    ['row', t('markup', lang), result.current.markup, result.cluster.markup],
    ['row', t('interchange', lang), result.current.interchange, result.cluster.interchange],
    ['section', t('fixedFees', lang), null, null],
    ['row', t('fixedFees', lang), result.current.fixed, result.cluster.fixed],
    ['rule', null, null, null],
    // ⚠️ PRE-TAX ONLY. Tax and grand total exist in `result` and are deliberately not
    // rendered here — see the file header.
    ['total', t('pretaxTotal', lang), result.current.pretax, result.cluster.pretax],
  ];

  const cardTop = doc.y;
  let cardH = 30;
  for (const [kind] of rows) cardH += kind === 'rule' ? 8 : (kind === 'section' ? 18 : 16);
  const notesH = notesUnderCurrent.length ? notesUnderCurrent.length * 22 + 6 : 0;
  ensureRoom(doc, cardH + notesH + 30);

  const top = doc.y;
  for (const [x, title, accent] of [[leftX, t('currentSide', lang), MUTED], [rightX, t('clusterSide', lang), ORANGE]]) {
    doc.roundedRect(x, top, cardW, cardH + notesH, 6).fillAndStroke(PANEL, RULE);
    doc.fillColor(accent).font('Helvetica-Bold').fontSize(9.5).text(title, x + 12, top + 10, { width: cardW - 24 });
  }

  let y = top + 30;
  for (const [kind, label, curVal, cluVal] of rows) {
    if (kind === 'rule') {
      doc.moveTo(leftX + 12, y + 2).lineTo(leftX + cardW - 12, y + 2).strokeColor(RULE).lineWidth(0.5).stroke();
      doc.moveTo(rightX + 12, y + 2).lineTo(rightX + cardW - 12, y + 2).strokeColor(RULE).lineWidth(0.5).stroke();
      y += 8;
      continue;
    }
    if (kind === 'section') {
      doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED);
      doc.text(label, leftX + 12, y, { width: cardW - 24 });
      doc.text(label, rightX + 12, y, { width: cardW - 24 });
      y += 18;
      continue;
    }
    const bold = kind === 'total';
    keyValueRow(doc, leftX + 12, y, cardW - 24, label, money(curVal, lang), { bold, size: bold ? 10 : 9 });
    keyValueRow(doc, rightX + 12, y, cardW - 24, label, money(cluVal, lang), { bold, size: bold ? 10 : 9, color: bold ? ORANGE : INK });
    y += 16;
  }

  // The notes sit under the CURRENT card only; the Cluster card's matching space is already
  // reserved by cardH + notesH above, so the two boxes end level.
  if (notesUnderCurrent.length) {
    doc.font('Helvetica').fontSize(7).fillColor(MUTED);
    doc.text(notesUnderCurrent.join('\n'), leftX + 12, y + 4, { width: cardW - 24 });
  }

  doc.y = top + cardH + notesH + 16;

  if (!result.savings.clusterIsCheaper) {
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
       .text(t('noSavings', lang), 40, doc.y, { width: doc.page.width - 80 });
    doc.moveDown(0.6);
  }

  // ---- optional free-text notes
  if (options.notes && String(options.notes).trim()) {
    ensureRoom(doc, 60);
    sectionTitle(doc, t('notes', lang));
    doc.font('Helvetica').fontSize(8.5).fillColor(INK)
       .text(String(options.notes).trim(), 40, doc.y, { width: doc.page.width - 80 });
  }

  footer(doc, lang);
  doc.end();
  return done;
}

// ===========================================================================
// DETAILED INTERNAL PDF
//
// Everything the client PDF omits: tax, the internal margin panel, and the complete
// line-by-line audit tables.
// ===========================================================================
function buildDetailedPdf({ state, result, options = {} }) {
  const lang = options.lang === 'en' ? 'en' : 'fr';
  const doc = new PDFDocument(PAGE);
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  header(doc, {
    title: t('detailTitle', lang),
    subtitle: `${state.merchantName || '—'}${state.processor ? ` · ${state.processor}` : ''}`,
    lang,
  });

  doc.font('Helvetica-Bold').fontSize(8).fillColor(BAD)
     .text(t('internalOnly', lang), 40, doc.y, { width: doc.page.width - 80 });
  doc.moveDown(0.8);

  // ---- totals, WITH tax and grand total.
  sectionTitle(doc, t('pretaxTotal', lang));
  const colW = (doc.page.width - 80) / 3;
  const totRows = [
    [t('markup', lang), result.current.markup, result.cluster.markup],
    [t('interchange', lang), result.current.interchange, result.cluster.interchange],
    [t('fixedFees', lang), result.current.fixed, result.cluster.fixed],
    [t('pretaxTotal', lang), result.current.pretax, result.cluster.pretax],
    [t('tax', lang), result.current.tax, result.cluster.tax],
    [t('grandTotal', lang), result.current.grand, result.cluster.grand],
  ];
  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED);
  let hy = doc.y;
  doc.text('', 40, hy, { width: colW });
  doc.text(t('currentSide', lang), 40 + colW, hy, { width: colW, align: 'right' });
  doc.text(t('clusterSide', lang), 40 + 2 * colW, hy, { width: colW, align: 'right' });
  doc.moveDown(0.4);
  for (const [label, a, b] of totRows) {
    const bold = /total/i.test(label);
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(INK);
    const ry = doc.y;
    doc.text(label, 40, ry, { width: colW });
    doc.text(money(a, lang), 40 + colW, ry, { width: colW, align: 'right' });
    doc.text(money(b, lang), 40 + 2 * colW, ry, { width: colW, align: 'right' });
    doc.moveDown(0.2);
  }
  doc.moveDown(0.3);
  const diff = result.savings.monthly;
  doc.font('Helvetica-Bold').fontSize(10).fillColor(diff < 0 ? GOOD : BAD)
     .text(`${t('savingsMonthly', lang)} : ${money(Math.abs(diff), lang)}${diff < 0 ? '' : ' (+)'}   ·   ${t('savingsAnnual', lang)} : ${money(Math.abs(result.savings.annual), lang)}`,
       40, doc.y, { width: doc.page.width - 80 });
  doc.moveDown(0.6);

  // ---- the audit tables, in full.
  const buckets = [
    ['auditInterchange', state.lineAudit.interchange],
    ['auditBrand', state.lineAudit.brand],
    ['auditInterac', state.lineAudit.interac],
  ];
  const anyRows = buckets.some(([, rows]) => (rows || []).length);
  if (anyRows) {
    sectionTitle(doc, t('auditTitle', lang));
    for (const [key, rows] of buckets) {
      if (!rows || !rows.length) continue;   // a bucket with no data is omitted entirely
      ensureRoom(doc, 60);
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text(t(key, lang), 40, doc.y);
      doc.moveDown(0.25);
      auditTable(doc, rows, lang);
      const tot = auditTotals(rows);
      doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
         .text(`${tot.count} · ${money(tot.total, lang)}${tot.suspectCount ? `   ·   SUSPECT ${tot.suspectCount} — ${money(tot.suspectTotal, lang)} / ${money(tot.suspectAnnual, lang)} ${lang === 'en' ? 'per year' : 'par année'}` : ''}`,
           40, doc.y + 2, { width: doc.page.width - 80 });
      doc.moveDown(0.7);
    }
  }

  // ---- internal margin panel.
  if (result.margin && result.margin.rows.length) {
    ensureRoom(doc, 90);
    sectionTitle(doc, t('marginTitle', lang));
    const mw = (doc.page.width - 80) / 4;
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED);
    const my = doc.y;
    doc.text('', 40, my, { width: mw });
    doc.text(t('colBilled', lang), 40 + mw, my, { width: mw, align: 'right' });
    doc.text(t('colCost', lang), 40 + 2 * mw, my, { width: mw, align: 'right' });
    doc.text(t('colRevenue', lang), 40 + 3 * mw, my, { width: mw, align: 'right' });
    doc.moveDown(0.4);
    doc.font('Helvetica').fontSize(8.5).fillColor(INK);
    for (const row of result.margin.rows) {
      const ry = doc.y;
      doc.text(row.key, 40, ry, { width: mw });
      doc.text(money(row.billed, lang), 40 + mw, ry, { width: mw, align: 'right' });
      doc.text(money(row.cost, lang), 40 + 2 * mw, ry, { width: mw, align: 'right' });
      doc.text(money(row.revenue, lang), 40 + 3 * mw, ry, { width: mw, align: 'right' });
      doc.moveDown(0.15);
    }
    doc.font('Helvetica-Bold').fontSize(9).fillColor(ORANGE);
    const fy = doc.y + 2;
    doc.text(t('total', lang), 40, fy, { width: mw });
    doc.text(money(result.margin.totalBilled, lang), 40 + mw, fy, { width: mw, align: 'right' });
    doc.text(money(result.margin.totalCost, lang), 40 + 2 * mw, fy, { width: mw, align: 'right' });
    doc.text(money(result.margin.revenue, lang), 40 + 3 * mw, fy, { width: mw, align: 'right' });
    doc.moveDown(0.8);
  }

  // ---- parser notes, verbatim.
  if ((state.notes || []).length) {
    ensureRoom(doc, 60);
    sectionTitle(doc, t('notes', lang));
    doc.font('Helvetica').fontSize(8).fillColor(INK);
    for (const n of state.notes) {
      const text = typeof n === 'string' ? n : N.render(n, lang);
      if (!text) continue;
      ensureRoom(doc, 26);
      doc.text(`• ${text}`, 40, doc.y, { width: doc.page.width - 80 });
      doc.moveDown(0.25);
    }
  }

  footer(doc, lang);
  doc.end();
  return done;
}

function auditTable(doc, rows, lang) {
  const x = 40;
  const w = doc.page.width - 80;
  const cols = [0.44, 0.13, 0.13, 0.15, 0.15];
  const head = [t('colDesc', lang), t('colApplied', lang), t('colPublished', lang), t('colTotal', lang), t('colStatus', lang)];

  const drawHead = () => {
    doc.font('Helvetica-Bold').fontSize(7).fillColor(MUTED);
    let cx = x;
    head.forEach((h, i) => {
      doc.text(h, cx, doc.y, { width: w * cols[i], align: i === 0 ? 'left' : 'right' });
      cx += w * cols[i];
    });
    doc.moveDown(0.3);
  };
  drawHead();

  for (const r of rows) {
    if (ensureRoom(doc, 16)) drawHead();
    const y = doc.y;
    const colour = r.status === STATUS.SUSPECT ? BAD : (r.status === STATUS.CONFORME ? GOOD : INK);
    doc.font('Helvetica').fontSize(7.5).fillColor(INK);
    let cx = x;
    doc.text(String(r.desc || '').slice(0, 70), cx, y, { width: w * cols[0], ellipsis: true });
    cx += w * cols[0];
    doc.text(pct(r.rate, lang), cx, y, { width: w * cols[1], align: 'right' });
    cx += w * cols[1];
    doc.text(pct(r.publishedRate, lang), cx, y, { width: w * cols[2], align: 'right' });
    cx += w * cols[2];
    doc.text(money(r.total, lang), cx, y, { width: w * cols[3], align: 'right' });
    cx += w * cols[3];
    doc.fillColor(colour).font(r.status === STATUS.SUSPECT ? 'Helvetica-Bold' : 'Helvetica')
       .text(r.status || '—', cx, y, { width: w * cols[4], align: 'right' });
    doc.fillColor(INK);
    doc.moveDown(0.12);
  }
}

module.exports = { buildClientPdf, buildDetailedPdf, pdfFilename, sanitizeName, LABELS };
