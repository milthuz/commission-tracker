// ============================================================================
// RH — courriels. Constructeurs purs (sujet + HTML), partagés entre l'envoi réel et l'outil
// d'aperçu d'Admin → Notifications (sampleEmail dans server.js), pour que l'aperçu montre
// exactement ce qui part.
//
// Le candidat reçoit la marque CLUSTER sans « Sales Hub » ni portail partenaire
// (`cluster-plain`) : il fait affaire avec son futur employeur, pas avec un outil interne.
// Les avis internes gardent la marque Sales Hub. TOUS les courriels sont bilingues, français
// d'abord.
// ============================================================================

const EMP = require('./employers');

// Enveloppe des courriels au CANDIDAT. Cluster : l'enveloppe Cluster de l'application. Autre
// employeur (OSP…) : une enveloppe sobre à son nom et à son logo — le candidat ne doit voir que
// son futur employeur. `logoUrl` pointe vers /api/public/hr-employer-logo/:key.
function candidateShell(mailShell, emp, logoUrl, title, intro, ctaLabel, ctaUrl) {
  if (!emp || emp.key === 'cluster') return mailShell(title, intro, ctaLabel, ctaUrl, undefined, 'cluster-plain');
  const head = emp.logo && logoUrl
    ? `<img src="${esc(logoUrl)}" alt="${esc(emp.shortName)}" style="max-height:44px;max-width:220px;display:block">`
    : `<span style="font-size:22px;font-weight:700;color:#0f1722">${esc(emp.shortName)}</span>`;
  const cta = ctaUrl && ctaLabel
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 4px"><tr><td style="border-radius:9px;background:#f26b21"><a href="${esc(ctaUrl)}" style="display:inline-block;padding:13px 30px;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;border-radius:9px">${esc(ctaLabel)}</a></td></tr></table>
       <p style="margin:18px 0 0;color:#94a3b8;font-size:12px;line-height:1.6">Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :<br>If the button doesn't work, copy this link into your browser:<br><a href="${esc(ctaUrl)}" style="color:#f26b21;word-break:break-all">${esc(ctaUrl)}</a></p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:28px 12px"><tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden">
    <tr><td style="padding:22px 32px;border-bottom:3px solid #f26b21">${head}</td></tr>
    <tr><td style="padding:28px 32px"><h1 style="margin:0 0 14px;color:#0f1722;font-size:20px;font-weight:700;line-height:1.3">${esc(title)}</h1>
      <div style="color:#475569;font-size:14.5px;line-height:1.65">${intro}</div>${cta}</td></tr>
    <tr><td style="padding:16px 32px;background:#f8fafc;color:#94a3b8;font-size:12px">© ${new Date().getFullYear()} ${esc(emp.legalName)}${emp.website ? ` · ${esc(emp.website)}` : ''}</td></tr>
  </table></td></tr></table></body></html>`;
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Les courriels au CANDIDAT sont bilingues, français d'abord (demande de David, 2026-09-23 :
// « tout doit être dans les deux langues »). Séparateur visuel entre les deux blocs.
const SEP = '<hr style="border:none;border-top:1px solid #e2e8f0;margin:22px 0">';
const EN_BLOCK = (html) => `<div lang="en" style="color:#64748b">${html}</div>`;

// d = { firstName, positionFr, positionEn, link, expiresDays }
function signRequestEmail(mailShell, d) {
  const emp = d.employer || EMP.CLUSTER;
  const subject = `Votre offre d’emploi chez ${emp.shortName} / Your offer of employment from ${emp.shortName}`;
  const intro = `<p style="margin:0 0 12px">Bonjour ${esc(d.firstName)},</p>
       <p style="margin:0 0 12px">Nous sommes ravis de vous offrir le poste de <b>${esc(d.positionFr)}</b> chez ${esc(emp.shortName)}. Votre offre d’emploi et votre entente de rémunération sont prêtes.</p>
       <p style="margin:0 0 12px">Le bouton ci-dessous ouvre les documents : lisez-les, puis signez directement à l’écran. Aucun logiciel ni compte n’est nécessaire.</p>
       <p style="margin:0">Ce lien vous est personnel et expire dans ${esc(d.expiresDays)} jours. Ne le transférez pas.</p>
    ${SEP}${EN_BLOCK(`<p style="margin:0 0 12px">Hi ${esc(d.firstName)},</p>
       <p style="margin:0 0 12px">We are delighted to offer you the position of <b>${esc(d.positionEn)}</b> at ${esc(emp.shortName)}. Your offer of employment and compensation agreement are ready.</p>
       <p style="margin:0 0 12px">The button below opens the documents: read them, then sign right on screen. No software or account is needed.</p>
       <p style="margin:0">This link is personal to you and expires in ${esc(d.expiresDays)} days. Please do not forward it.</p>`)}`;
  return {
    subject,
    html: candidateShell(mailShell, emp, d.logoUrl, 'Votre offre d’emploi · Your offer of employment', intro,
      'Consulter et signer · Review and sign', d.link),
  };
}

// d = { name, positionFr, positionEn, link }
function countersignEmail(mailShell, d) {
  const subject = `✍️ ${d.name} — contresignature requise / countersignature needed`;
  const co = esc((d.employer || EMP.CLUSTER).shortName);
  const intro = d.docTitleFr
    ? `<p style="margin:0 0 12px"><b>${esc(d.name)}</b> a signé l’addenda « ${esc(d.docTitleFr)} ». Il reste à le contresigner pour ${co}.</p>
    <p style="margin:0;color:#64748b"><b>${esc(d.name)}</b> signed the addendum “${esc(d.docTitleEn)}”. It now needs ${co}’s countersignature.</p>`
    : `<p style="margin:0 0 12px"><b>${esc(d.name)}</b> (${esc(d.positionFr)}) a signé son offre d’emploi et son entente de rémunération. Il reste à les contresigner pour ${co}.</p>
    <p style="margin:0;color:#64748b"><b>${esc(d.name)}</b> (${esc(d.positionEn)}) signed their offer of employment and compensation agreement. They now need ${co}’s countersignature.</p>`;
  return { subject, html: mailShell('Contresignature requise · Countersignature needed', intro, 'Ouvrir / Open', d.link) };
}

// Au candidat, dossier signé en pièce jointe. d = { firstName, startDateFr, startDateEn }
function completedEmployeeEmail(mailShell, d) {
  const emp = d.employer || EMP.CLUSTER;
  const subject = `Bienvenue chez ${emp.shortName} — vos documents signés / Welcome to ${emp.shortName} — your signed documents`;
  const intro = `<p style="margin:0 0 12px">Bonjour ${esc(d.firstName)},</p>
       <p style="margin:0 0 12px">C’est officiel : votre offre d’emploi et votre entente de rémunération sont signées par les deux parties. Vous trouverez le dossier complet en pièce jointe — conservez-le.</p>
       <p style="margin:0">Au plaisir de vous accueillir le ${esc(d.startDateFr)} !</p>
    ${SEP}${EN_BLOCK(`<p style="margin:0 0 12px">Hi ${esc(d.firstName)},</p>
       <p style="margin:0 0 12px">It’s official: your offer of employment and compensation agreement are signed by both parties. The complete signed package is attached — please keep it for your records.</p>
       <p style="margin:0">We look forward to welcoming you on ${esc(d.startDateEn)}!</p>`)}`;
  return { subject, html: candidateShell(mailShell, emp, d.logoUrl, `Bienvenue chez ${emp.shortName} · Welcome to ${emp.shortName}`, intro, null, null) };
}

// Interne, dossier en pièce jointe. d = { name, positionFr, positionEn, startDateFr, startDateEn, link }
function completedInternalEmail(mailShell, d) {
  const subject = `✅ ${d.name} — contrat signé / contract signed`;
  const intro = `<p style="margin:0 0 12px">Le dossier d’embauche de <b>${esc(d.name)}</b> (${esc(d.positionFr)}, entrée en fonction le ${esc(d.startDateFr)}) est signé par les deux parties. Il est joint à ce courriel et reste disponible dans Sales Hub → Embauches.</p>
    <p style="margin:0;color:#64748b">The hiring package for <b>${esc(d.name)}</b> (${esc(d.positionEn)}, starting ${esc(d.startDateEn)}) is fully signed. It is attached and remains available in Sales Hub → Hiring.</p>`;
  return { subject, html: mailShell('Contrat signé · Contract signed', intro, 'Ouvrir / Open', d.link) };
}

// d = { name, reason, link }
function declinedEmail(mailShell, d) {
  const subject = `⛔ ${d.name} — offre refusée / offer declined`;
  const reason = d.reason ? `<p style="margin:0 0 12px;padding:10px 14px;background:#f8fafc;border-left:3px solid #cbd5e1">${esc(d.reason)}</p>` : '';
  const intro = `<p style="margin:0 0 12px"><b>${esc(d.name)}</b> a refusé l’offre d’emploi. / declined the offer of employment.</p>${reason}`;
  return { subject, html: mailShell('Offre refusée · Offer declined', intro, 'Ouvrir / Open', d.link) };
}

// ---------------------------------------------------------------------------
// ADDENDA — mêmes enveloppes et même bilinguisme, mais on parle d'un DOCUMENT à signer, pas
// d'une offre d'emploi (l'employé est déjà en poste).
// ---------------------------------------------------------------------------
// d = { firstName, docTitleFr, docTitleEn, link, expiresDays, employer, logoUrl }
function addendumRequestEmail(mailShell, d) {
  const emp = d.employer || EMP.CLUSTER;
  const subject = `Document à signer : ${d.docTitleFr} / Document to sign: ${d.docTitleEn}`;
  const intro = `<p style="margin:0 0 12px">Bonjour ${esc(d.firstName)},</p>
       <p style="margin:0 0 12px">${esc(emp.shortName)} vous transmet un addenda à votre contrat de travail : <b>${esc(d.docTitleFr)}</b>.</p>
       <p style="margin:0 0 12px">Le bouton ci-dessous ouvre le document : lisez-le, puis signez directement à l’écran.</p>
       <p style="margin:0">Ce lien vous est personnel et expire dans ${esc(d.expiresDays)} jours. Ne le transférez pas.</p>
    ${SEP}${EN_BLOCK(`<p style="margin:0 0 12px">Hi ${esc(d.firstName)},</p>
       <p style="margin:0 0 12px">${esc(emp.shortName)} is sending you an addendum to your employment agreement: <b>${esc(d.docTitleEn)}</b>.</p>
       <p style="margin:0 0 12px">The button below opens the document: read it, then sign right on screen.</p>
       <p style="margin:0">This link is personal to you and expires in ${esc(d.expiresDays)} days. Please do not forward it.</p>`)}`;
  return { subject, html: candidateShell(mailShell, emp, d.logoUrl, 'Document à signer · Document to sign', intro, 'Consulter et signer · Review and sign', d.link) };
}

// À l'employé, document signé en pièce jointe. d = { firstName, docTitleFr, docTitleEn, employer, logoUrl }
function addendumCompletedEmployeeEmail(mailShell, d) {
  const emp = d.employer || EMP.CLUSTER;
  const subject = `Document signé : ${d.docTitleFr} / Signed document: ${d.docTitleEn}`;
  const intro = `<p style="margin:0 0 12px">Bonjour ${esc(d.firstName)},</p>
       <p style="margin:0">L’addenda « ${esc(d.docTitleFr)} » est signé par les deux parties. Vous trouverez le document signé en pièce jointe — conservez-le avec votre contrat.</p>
    ${SEP}${EN_BLOCK(`<p style="margin:0 0 12px">Hi ${esc(d.firstName)},</p>
       <p style="margin:0">The addendum “${esc(d.docTitleEn)}” is signed by both parties. The signed document is attached — please keep it with your employment agreement.</p>`)}`;
  return { subject, html: candidateShell(mailShell, emp, d.logoUrl, 'Document signé · Signed document', intro, null, null) };
}

// Interne. d = { name, docTitleFr, docTitleEn, link }
function addendumCompletedInternalEmail(mailShell, d) {
  const subject = `✅ ${d.name} — addenda signé / addendum signed : ${d.docTitleFr}`;
  const intro = `<p style="margin:0 0 12px">L’addenda « ${esc(d.docTitleFr)} » de <b>${esc(d.name)}</b> est signé par les deux parties. Il est joint à ce courriel et reste disponible dans Sales Hub → Embauches.</p>
    <p style="margin:0;color:#64748b">The addendum “${esc(d.docTitleEn)}” for <b>${esc(d.name)}</b> is fully signed. It is attached and remains available in Sales Hub → Hiring.</p>`;
  return { subject, html: mailShell('Addenda signé · Addendum signed', intro, 'Ouvrir / Open', d.link) };
}

module.exports = { signRequestEmail, countersignEmail, completedEmployeeEmail, completedInternalEmail, declinedEmail, addendumRequestEmail, addendumCompletedEmployeeEmail, addendumCompletedInternalEmail, esc };
