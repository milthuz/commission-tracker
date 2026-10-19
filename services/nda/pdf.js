// ============================================================================
// NDA — rendu PDF : l'entente de confidentialité (gabarit Cluster), la page de signature
// ajoutée au NDA de l'autre partie (mode « PDF téléversé ») et le certificat.
//
// Même habillage que les contrats RH (bandeau noir, filet orange, bande d'identification,
// cartes de signature) : les briques viennent de services/hr/pdf.js (`kit`).
//
// 🔑 UN SEUL RENDU, SIGNÉ OU NON : la version envoyée (cases vides) et la version finale
// (signatures dessinées) sortent du même code et du même instantané figé à l'envoi.
// ============================================================================

const HR = require('../hr/pdf');
const T = require('./text');

const K = HR.kit;
const { M, CW, INK, TEXT, MUTED, ORANGE, PEACH } = K;
const CLUSTER_EMP = { key: 'cluster', legalName: 'Cluster Systems', shortName: 'Cluster', website: 'clustersystems.com' };

const langOf = (snap) => (snap.nda.lang === 'fr' ? 'fr' : 'en');
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
const signerName = (s) => `${s.firstName} ${s.lastName}`.trim();
function addressLines(c) {
  const cityLine = [c.city, [c.province, c.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [c.address, cityLine, c.country].filter(Boolean);
}

// Bandeau + filet + bande d'identification, communs aux deux documents.
function header(doc, f, { title, subtitle, small, fields, values }) {
  const bandH = 64;
  doc.rect(M, M, CW, bandH).fill(INK);
  doc.rect(M + CW * 0.34, M, CW * 0.66, bandH).fill('#262626');
  K.brandMark(doc, CLUSTER_EMP, M + 16, M + 10, CW * 0.3);
  doc.font('Helvetica').fontSize(7.5).fillColor('#a3a3a3').text(CLUSTER_EMP.website, M + 16, M + 48, { lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#ffffff').text(title, M + CW * 0.34, M + 11, { width: CW * 0.66 - 16, align: 'right', height: 15, ellipsis: true });
  doc.font('Helvetica-Bold').fontSize(12).fillColor(ORANGE).text(subtitle, M + CW * 0.34, M + 28, { width: CW * 0.66 - 16, align: 'right', height: 15, ellipsis: true });
  doc.font('Helvetica').fontSize(8).fillColor('#e5e5e5').text(small, M, M + 46, { width: CW - 16, align: 'right' });
  f.st.y = M + bandH + 12;
  doc.rect(M - 2, f.st.y, CW + 38, 1.6).fill(ORANGE);
  f.st.y += 14;
  const colW = CW / 4;
  doc.rect(M, f.st.y, CW, 50).fill('#f4f4f4');
  fields.forEach((label, i) => {
    const x = M + i * colW + 8;
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor(ORANGE).text(label, x, f.st.y + 7, { width: colW - 16, lineBreak: false });
    doc.font('Helvetica').fontSize(8.5).fillColor(TEXT).text(values[i] || '', x, f.st.y + 18, { width: colW - 16, height: 22, ellipsis: true, lineGap: 0 });
    doc.save().moveTo(x, f.st.y + 42).lineTo(x + colW - 16, f.st.y + 42).lineWidth(0.6).strokeColor('#bdbdbd').stroke().restore();
  });
  f.st.y += 66;
}

// Deux cartes de signature côte à côte : l'autre partie, puis Cluster.
function signatureCards(doc, f, L, snap, { partySig, clusterSig }) {
  const lang = langOf(snap);
  const s = snap.nda.signer;
  const c = snap.nda.company;
  const cardW = (CW - 18) / 2;
  const hC = 182;
  f.ensure(hC + 10);
  const cardY = f.st.y;
  const card = (x, role, rows, sig, ts) => {
    doc.save().rect(x, cardY, cardW, hC).lineWidth(0.6).strokeColor('#e0e0e0').stroke().restore();
    doc.rect(x, cardY, 1.8, hC).fill(ORANGE);
    const ix = x + 12;
    const iw = cardW - 24;
    doc.font('Helvetica-Bold').fontSize(7).fillColor(ORANGE).text(role, ix, cardY + 12, { width: iw, height: 9, lineBreak: false, ellipsis: true });
    let y = cardY + 28;
    for (const [label, value] of rows) {
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#444444').text(label, ix, y, { lineBreak: false });
      doc.font('Helvetica').fontSize(9).fillColor(TEXT).text(value || '', ix + 52, y, { width: iw - 52, height: 11, lineBreak: false, ellipsis: true });
      doc.save().moveTo(ix, y + 13).lineTo(ix + iw, y + 13).lineWidth(0.6).strokeColor('#bdbdbd').stroke().restore();
      y += 22;
    }
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#444444').text(L.signature, ix, y + 6);
    const img = K.sigBuffer(sig);
    if (img) { try { doc.image(img, ix + 58, y, { fit: [iw - 62, 36] }); } catch { /* image illisible : case laissée vide */ } }
    doc.save().moveTo(ix, y + 40).lineTo(ix + iw, y + 40).lineWidth(0.6).strokeColor('#bdbdbd').stroke().restore();
    y += 48;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#444444').text(L.date, ix, y);
    if (ts) doc.font('Helvetica').fontSize(9).fillColor(TEXT).text(K.longDate(K.isoDay(ts), lang), ix + 52, y);
    doc.save().moveTo(ix, y + 13).lineTo(ix + iw, y + 13).lineWidth(0.6).strokeColor('#bdbdbd').stroke().restore();
  };
  const cl = snap.clusterSigner;
  card(M, `${L.forParty} ${String(c.legalName).toUpperCase()}`,
    [[L.name, partySig ? partySig.name : signerName(s)], [L.title, partySig && partySig.title ? partySig.title : s.title], [L.company, c.legalName]],
    partySig, partySig && partySig.at);
  card(M + cardW + 18, `${L.forParty} ${T.CLUSTER.legalName.toUpperCase()}`,
    [[L.name, clusterSig ? clusterSig.name : cl.name], [L.title, cl.title], [L.company, 'Cluster Systems']],
    clusterSig, clusterSig && clusterSig.at);
  f.st.y = cardY + hC + 14;
}

// ---------------------------------------------------------------------------
// NDA — gabarit Cluster
// ---------------------------------------------------------------------------
async function renderNda(snap, { partySig = null, clusterSig = null } = {}) {
  const lang = langOf(snap);
  const L = T.NDA[lang];
  const n = snap.nda;
  const c = n.company;
  const date = K.longDate(n.effectiveDate || snap.sentOn || today(), lang);
  const doc = K.newDoc(`${L.docType} — ${c.legalName}`, 'Cluster Systems');
  const out = K.collect(doc);
  const f = K.flow(doc);
  const SIZE = 9.8;

  header(doc, f, {
    title: L.docTypeShort, subtitle: c.legalName, small: L.confidential, fields: L.fields,
    values: [c.legalName, `${signerName(n.signer)}${n.signer.title ? `, ${n.signer.title}` : ''}`, date, snap.ref || '—'],
  });

  doc.font('Helvetica-Bold').fontSize(14).fillColor(INK).text(L.docType.toUpperCase(), M, f.st.y, { width: CW, align: 'center' });
  f.st.y += 26;
  f.para(L.madeAsOf(date), { size: SIZE, font: 'Helvetica-Bold', gap: 12 });

  // ENTRE / ET : deux encadrés pêche avec l'identité et l'adresse de chaque partie.
  const party = (label, name, lines, suffix) => {
    doc.font('Helvetica').fontSize(SIZE);
    const body = [`${L.residing} ${lines.join(', ')}`, suffix].filter(Boolean).join(' ');
    const hh = doc.heightOfString(body, { width: CW - 96, lineGap: 1.5 }) + 30;
    f.ensure(hh + 8);
    doc.rect(M, f.st.y, CW, hh).fill(PEACH);
    doc.rect(M, f.st.y, 2.5, hh).fill(ORANGE);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(ORANGE).text(label, M + 14, f.st.y + 9, { width: 60, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(SIZE + 0.5).fillColor(TEXT).text(name, M + 80, f.st.y + 8, { width: CW - 96 });
    doc.font('Helvetica').fontSize(SIZE).fillColor(TEXT).text(body, M + 80, f.st.y + 22, { width: CW - 96, lineGap: 1.5 });
    f.st.y += hh + 8;
  };
  party(L.between, T.CLUSTER.legalName, [lang === 'fr' ? T.CLUSTER.addressFr : T.CLUSTER.addressEn], L.clusterShort);
  party(L.and, c.legalName, addressLines(c), null);
  f.st.y += 6;

  f.para(L.interpretation, { size: SIZE, gap: 10 });
  f.para(L.whereas(n.purpose || T.DEFAULT_PURPOSE[lang]), { size: SIZE, gap: 10 });
  f.para(L.nowTherefore, { size: SIZE, gap: 14 });

  // Clauses numérotées, numéro orange en marge.
  L.clauses.forEach((text, i) => {
    doc.font('Helvetica').fontSize(SIZE);
    const hh = doc.heightOfString(text, { width: CW - 30, lineGap: 1.5 });
    f.ensure(Math.min(hh, 120));
    doc.font('Helvetica-Bold').fillColor(ORANGE).text(`${i + 1}.`, M, f.st.y, { width: 24, lineBreak: false });
    doc.font('Helvetica').fillColor(TEXT).text(text, M + 30, f.st.y, { width: CW - 30, lineGap: 1.5 });
    f.st.y = doc.y + 9;
  });

  // Signatures : le titre et les cartes partent ensemble.
  f.st.y += 6;
  f.ensure(260);
  doc.rect(M, f.st.y, CW, 40).fill(INK);
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#ffffff').text(L.ackTitle, M, f.st.y + 8, { width: CW, align: 'center' });
  doc.font('Helvetica').fontSize(8).fillColor('#fdba8c').text(L.ackSub, M, f.st.y + 25, { width: CW, align: 'center' });
  f.st.y += 52;
  f.para(L.agreed, { size: SIZE, font: 'Helvetica-Bold', gap: 12 });
  signatureCards(doc, f, L, snap, { partySig, clusterSig });

  K.footer(doc, L.footer, (i, total) => `${c.legalName}   ·   ${L.page(i, total)}`, null, null);
  doc.end();
  return out;
}

// ---------------------------------------------------------------------------
// Page de signature du NDA de l'autre partie. On ne sait pas où signer dans un PDF arbitraire :
// la page NOMME le document (pages + empreinte SHA-256) et porte les deux signatures.
// ---------------------------------------------------------------------------
async function renderUploadSignature(snap, { partySig = null, clusterSig = null } = {}) {
  const lang = langOf(snap);
  const A = T.UPLOAD[lang];
  const L = T.NDA[lang];
  const n = snap.nda;
  const c = n.company;
  const doc = K.newDoc(`${A.kind} — ${c.legalName}`, 'Cluster Systems');
  const out = K.collect(doc);
  const f = K.flow(doc);

  header(doc, f, {
    title: A.kind, subtitle: c.legalName, small: A.confidential, fields: A.fields,
    values: [c.legalName, `${signerName(n.signer)}${n.signer.title ? `, ${n.signer.title}` : ''}`, K.longDate(snap.sentOn || today(), lang), snap.ref || '—'],
  });
  f.para(A.intro(T.CLUSTER.legalName, c.legalName), { gap: 12 });
  for (const a of snap.attachments || []) {
    const label = a.filename.replace(/\.pdf$/i, '');
    const meta = [A.pages(a.pages), `SHA-256 ${String(a.sha256).slice(0, 16)}...`].filter(Boolean).join('  ·  ');
    doc.font('Helvetica-Bold').fontSize(10);
    const hh = doc.heightOfString(label, { width: CW - 30 }) + 16;
    f.ensure(hh + 6);
    doc.rect(M, f.st.y, CW, hh).fill(PEACH);
    doc.rect(M, f.st.y, 2.5, hh).fill(ORANGE);
    doc.fillColor(TEXT).text(label, M + 14, f.st.y + 5, { width: CW - 30 });
    doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(meta, M + 14, f.st.y + hh - 12, { width: CW - 30, lineBreak: false });
    f.st.y += hh + 6;
  }
  f.st.y += 6;
  f.para(A.note, { size: 9, font: 'Helvetica-Oblique', color: '#555555', gap: 16 });
  f.ensure(250);
  doc.rect(M, f.st.y, CW, 40).fill(INK);
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#ffffff').text(A.ackTitle, M, f.st.y + 8, { width: CW, align: 'center' });
  doc.font('Helvetica').fontSize(8).fillColor('#fdba8c').text(A.ackSub, M, f.st.y + 25, { width: CW, align: 'center' });
  f.st.y += 54;
  signatureCards(doc, f, L, snap, { partySig, clusterSig });

  K.footer(doc, A.footer, (i, total) => `${c.legalName}   ·   ${L.page(i, total)}`, null, null);
  doc.end();
  return out;
}

// ---------------------------------------------------------------------------
// Certificat de signature — bilingue, dernière page du NDA signé.
// ---------------------------------------------------------------------------
async function renderCertificate(info) {
  const doc = K.newDoc(`Certificate of completion — ${info.company}`);
  const out = K.collect(doc);
  const f = K.flow(doc);
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
  head(`${info.company} — Other party / Autre partie`);
  kv('Name / Nom', info.party.name);
  kv('Title / Titre', info.party.title);
  kv('Email / Courriel', info.party.email);
  kv('Sent / Envoyé', K.stamp(info.sentAt, 'en'));
  kv('First opened / Ouvert', K.stamp(info.viewedAt, 'en'));
  kv('Signed / Signé', K.stamp(info.party.at, 'en'));
  kv('Typed name / Nom saisi', info.party.typedName);
  kv('IP address / Adresse IP', info.party.ip);
  kv('Browser / Navigateur', info.party.ua);
  kv('Consent / Consentement', 'Agreed to sign electronically / A consenti à signer électroniquement');
  head(T.CLUSTER.legalName);
  kv('Name / Nom', info.cluster.name);
  kv('Title / Titre', info.cluster.title);
  kv('Sales Hub account / Compte', info.cluster.email);
  kv('Countersigned / Contresigné', K.stamp(info.cluster.at, 'en'));
  kv('IP address / Adresse IP', info.cluster.ip);
  kv('Prepared by / Préparé par', info.preparedBy);
  f.st.y += 14;
  f.para('The other party accessed the agreement through a single-use link sent to the email address above, reviewed it, consented to sign electronically and applied a handwritten signature. Cluster countersigned from an authenticated Sales Hub account. The fingerprints (SHA-256) identify the exact unsigned documents that were presented. / L\'autre partie a accédé à l\'entente par un lien à usage unique envoyé à l\'adresse ci-dessus, l\'a consultée, a consenti à signer électroniquement et y a apposé une signature manuscrite. Cluster a contresigné depuis un compte Sales Hub authentifié. Les empreintes (SHA-256) identifient les documents exacts présentés avant signature.', { size: 8.5, color: MUTED });
  K.footer(doc, '  |  Certificate of Completion', info.company, null, null);
  doc.end();
  return out;
}

module.exports = { renderNda, renderUploadSignature, renderCertificate, mergePdfs: HR.mergePdfs, pageCount: HR.pageCount, longDate: K.longDate };
