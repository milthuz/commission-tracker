// ============================================================================
// RH — courriels. Constructeurs purs (sujet + HTML), partagés entre l'envoi réel et l'outil
// d'aperçu d'Admin → Notifications (sampleEmail dans server.js), pour que l'aperçu montre
// exactement ce qui part.
//
// Le candidat reçoit la marque CLUSTER sans « Sales Hub » ni portail partenaire
// (`cluster-plain`) : il fait affaire avec son futur employeur, pas avec un outil interne.
// Les avis internes gardent la marque Sales Hub et sont bilingues.
// ============================================================================

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// d = { firstName, name, position, link, expiresDays, lang }
function signRequestEmail(mailShell, d) {
  const fr = d.lang === 'fr';
  const subject = fr
    ? 'Votre offre d’emploi chez Cluster — à consulter et signer'
    : 'Your offer of employment from Cluster — please review and sign';
  const intro = fr
    ? `<p style="margin:0 0 12px">Bonjour ${esc(d.firstName)},</p>
       <p style="margin:0 0 12px">Nous sommes ravis de vous offrir le poste de <b>${esc(d.position)}</b> chez Cluster. Votre offre d’emploi et votre entente de rémunération sont prêtes.</p>
       <p style="margin:0 0 12px">Le bouton ci-dessous ouvre les documents : lisez-les, puis signez directement à l’écran. Aucun logiciel ni compte n’est nécessaire.</p>
       <p style="margin:0">Ce lien vous est personnel et expire dans ${esc(d.expiresDays)} jours. Ne le transférez pas.</p>`
    : `<p style="margin:0 0 12px">Hi ${esc(d.firstName)},</p>
       <p style="margin:0 0 12px">We are delighted to offer you the position of <b>${esc(d.position)}</b> at Cluster. Your offer of employment and compensation agreement are ready.</p>
       <p style="margin:0 0 12px">The button below opens the documents: read them, then sign right on screen. No software or account is needed.</p>
       <p style="margin:0">This link is personal to you and expires in ${esc(d.expiresDays)} days. Please do not forward it.</p>`;
  return {
    subject,
    html: mailShell(fr ? 'Votre offre d’emploi' : 'Your offer of employment', intro,
      fr ? 'Consulter et signer' : 'Review and sign', d.link, fr ? 'fr' : 'en', 'cluster-plain'),
  };
}

// d = { name, position, link }
function countersignEmail(mailShell, d) {
  const subject = `✍️ ${d.name} — contresignature requise / countersignature needed`;
  const intro = `<p style="margin:0 0 12px"><b>${esc(d.name)}</b> (${esc(d.position)}) a signé son offre d’emploi et son entente de rémunération. Il reste à les contresigner pour Cluster.</p>
    <p style="margin:0;color:#64748b"><b>${esc(d.name)}</b> (${esc(d.position)}) signed their offer of employment and compensation agreement. They now need Cluster’s countersignature.</p>`;
  return { subject, html: mailShell('Contresignature requise · Countersignature needed', intro, 'Ouvrir / Open', d.link) };
}

// Au candidat, dossier signé en pièce jointe. d = { firstName, lang, startDate }
function completedEmployeeEmail(mailShell, d) {
  const fr = d.lang === 'fr';
  const subject = fr ? 'Bienvenue chez Cluster — vos documents signés' : 'Welcome to Cluster — your signed documents';
  const intro = fr
    ? `<p style="margin:0 0 12px">Bonjour ${esc(d.firstName)},</p>
       <p style="margin:0 0 12px">C’est officiel : votre offre d’emploi et votre entente de rémunération sont signées par les deux parties. Vous trouverez le dossier complet en pièce jointe — conservez-le.</p>
       <p style="margin:0">Au plaisir de vous accueillir le ${esc(d.startDate)} !</p>`
    : `<p style="margin:0 0 12px">Hi ${esc(d.firstName)},</p>
       <p style="margin:0 0 12px">It’s official: your offer of employment and compensation agreement are signed by both parties. The complete signed package is attached — please keep it for your records.</p>
       <p style="margin:0">We look forward to welcoming you on ${esc(d.startDate)}!</p>`;
  return { subject, html: mailShell(fr ? 'Bienvenue chez Cluster' : 'Welcome to Cluster', intro, null, null, fr ? 'fr' : 'en', 'cluster-plain') };
}

// Interne, dossier en pièce jointe. d = { name, position, startDate, link }
function completedInternalEmail(mailShell, d) {
  const subject = `✅ ${d.name} — contrat signé / contract signed`;
  const intro = `<p style="margin:0 0 12px">Le dossier d’embauche de <b>${esc(d.name)}</b> (${esc(d.position)}, entrée en fonction le ${esc(d.startDate)}) est signé par les deux parties. Il est joint à ce courriel et reste disponible dans Sales Hub → RH.</p>
    <p style="margin:0;color:#64748b">The hiring package for <b>${esc(d.name)}</b> (${esc(d.position)}, starting ${esc(d.startDate)}) is fully signed. It is attached and remains available in Sales Hub → HR.</p>`;
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
