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

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Les courriels au CANDIDAT sont bilingues, français d'abord (demande de David, 2026-09-23 :
// « tout doit être dans les deux langues »). Séparateur visuel entre les deux blocs.
const SEP = '<hr style="border:none;border-top:1px solid #e2e8f0;margin:22px 0">';
const EN_BLOCK = (html) => `<div lang="en" style="color:#64748b">${html}</div>`;

// d = { firstName, positionFr, positionEn, link, expiresDays }
function signRequestEmail(mailShell, d) {
  const subject = 'Votre offre d’emploi chez Cluster / Your offer of employment from Cluster';
  const intro = `<p style="margin:0 0 12px">Bonjour ${esc(d.firstName)},</p>
       <p style="margin:0 0 12px">Nous sommes ravis de vous offrir le poste de <b>${esc(d.positionFr)}</b> chez Cluster. Votre offre d’emploi et votre entente de rémunération sont prêtes.</p>
       <p style="margin:0 0 12px">Le bouton ci-dessous ouvre les documents : lisez-les, puis signez directement à l’écran. Aucun logiciel ni compte n’est nécessaire.</p>
       <p style="margin:0">Ce lien vous est personnel et expire dans ${esc(d.expiresDays)} jours. Ne le transférez pas.</p>
    ${SEP}${EN_BLOCK(`<p style="margin:0 0 12px">Hi ${esc(d.firstName)},</p>
       <p style="margin:0 0 12px">We are delighted to offer you the position of <b>${esc(d.positionEn)}</b> at Cluster. Your offer of employment and compensation agreement are ready.</p>
       <p style="margin:0 0 12px">The button below opens the documents: read them, then sign right on screen. No software or account is needed.</p>
       <p style="margin:0">This link is personal to you and expires in ${esc(d.expiresDays)} days. Please do not forward it.</p>`)}`;
  return {
    subject,
    html: mailShell('Votre offre d’emploi · Your offer of employment', intro,
      'Consulter et signer · Review and sign', d.link, undefined, 'cluster-plain'),
  };
}

// d = { name, positionFr, positionEn, link }
function countersignEmail(mailShell, d) {
  const subject = `✍️ ${d.name} — contresignature requise / countersignature needed`;
  const intro = `<p style="margin:0 0 12px"><b>${esc(d.name)}</b> (${esc(d.positionFr)}) a signé son offre d’emploi et son entente de rémunération. Il reste à les contresigner pour Cluster.</p>
    <p style="margin:0;color:#64748b"><b>${esc(d.name)}</b> (${esc(d.positionEn)}) signed their offer of employment and compensation agreement. They now need Cluster’s countersignature.</p>`;
  return { subject, html: mailShell('Contresignature requise · Countersignature needed', intro, 'Ouvrir / Open', d.link) };
}

// Au candidat, dossier signé en pièce jointe. d = { firstName, startDateFr, startDateEn }
function completedEmployeeEmail(mailShell, d) {
  const subject = 'Bienvenue chez Cluster — vos documents signés / Welcome to Cluster — your signed documents';
  const intro = `<p style="margin:0 0 12px">Bonjour ${esc(d.firstName)},</p>
       <p style="margin:0 0 12px">C’est officiel : votre offre d’emploi et votre entente de rémunération sont signées par les deux parties. Vous trouverez le dossier complet en pièce jointe — conservez-le.</p>
       <p style="margin:0">Au plaisir de vous accueillir le ${esc(d.startDateFr)} !</p>
    ${SEP}${EN_BLOCK(`<p style="margin:0 0 12px">Hi ${esc(d.firstName)},</p>
       <p style="margin:0 0 12px">It’s official: your offer of employment and compensation agreement are signed by both parties. The complete signed package is attached — please keep it for your records.</p>
       <p style="margin:0">We look forward to welcoming you on ${esc(d.startDateEn)}!</p>`)}`;
  return { subject, html: mailShell('Bienvenue chez Cluster · Welcome to Cluster', intro, null, null, undefined, 'cluster-plain') };
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

module.exports = { signRequestEmail, countersignEmail, completedEmployeeEmail, completedInternalEmail, declinedEmail, esc };
