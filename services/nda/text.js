// ============================================================================
// NDA — texte de l'entente de confidentialité mutuelle de Cluster.
//
// SOURCE : `Downloads/NDA.pdf` (entente Cluster ↔ Calibre Integration du 29 mars 2025, sortie
// d'un formulaire web — wkhtmltopdf), signée par David Lafleur pour Cluster. Reprise clause par
// clause, avec les coquilles du gabarit CORRIGÉES à la demande de David (2026-10-19) :
//   - « the disclosure » (un champ de formulaire jamais rempli) → « the Disclosing Party » ;
//   - « Parties » employé au singulier pour la partie qui reçoit → « the Receiving Party »
//     (accords en conséquence : « Parties agrees » → « the Receiving Party agrees ») ;
//   - doublons (« analyses », « access », « the the ») retirés, « save him harmless » → « it ».
// Pour que ces deux termes aient un sens, le préambule les DÉFINIT (une phrase ajoutée) — c'est
// la seule addition ; aucune obligation n'a été ajoutée, retirée ni déplacée.
//
// Version française : traduction de Claude, NON RÉVISÉE PAR UN JURISTE (comme l'offre RH). La
// clause 19 suit la langue de l'entente (« rédigée en anglais » / « rédigée en français »).
//
// ⚠️ Polices standard pdfkit = WinAnsi : pas de symboles hors Latin-1 (voir services/hr/pdf.js).
// ============================================================================

// Identité de Cluster, telle qu'elle figure au NDA d'origine.
const CLUSTER = {
  legalName: '8897697 Canada Inc. / Cluster Systems',
  addressEn: '8585 Decarie Blvd, Mount Royal, Quebec H4P 2J4',
  addressFr: '8585, boul. Décarie, Mont-Royal (Québec) H4P 2J4',
};

// Objet par défaut, repris du NDA d'origine.
const DEFAULT_PURPOSE = {
  en: 'the development of a software or application',
  fr: 'le développement d’un logiciel ou d’une application',
};

const EN = {
  docType: 'Confidentiality and Non-Disclosure Agreement',
  docTypeShort: 'Non-Disclosure Agreement',
  confidential: 'Confidential',
  fields: ['OTHER PARTY', 'SIGNATORY', 'EFFECTIVE DATE', 'REFERENCE'],
  madeAsOf: (date) => `THIS AGREEMENT is made as of ${date} (the "Agreement")`,
  between: 'BETWEEN',
  and: 'AND',
  residing: 'residing at',
  clusterShort: '("Cluster")',
  interpretation: 'The Parties are sometimes hereinafter referred to individually as a "Party" and collectively as the "Parties". A Party disclosing Confidential Information under this Agreement is referred to as the "Disclosing Party", and the Party receiving it as the "Receiving Party".',
  whereas: (purpose) => `WHEREAS in order for each Party to evaluate its interest in participating in a future business relationship with the other Party specifically related to ${purpose} (the "Purpose"), it appears necessary that the Parties disclose certain confidential and proprietary information to each other; and`,
  nowTherefore: 'NOW THEREFORE, in consideration of the mutual promises, covenants and obligations contained in this Agreement, and for other good and valuable consideration, the receipt and sufficiency of which are hereby acknowledged, the Parties agree as follows:',
  clauses: [
    'For the purposes of this Agreement, the term "Confidential Information" means any information that has been or may hereafter be disclosed, provided or shown, irrespective of the form of communication, including, without limitation, any and all information regarding the Purpose of this Agreement. Confidential Information shall include, without limitation, all notes, analyses, ideas, trade secrets, know-how, designs, compilations, studies, summaries, product samples, product formulations, prototypes, data, processes, formulas, methods, materials, technology, manufacturing techniques, network, pricing, customer information (existing or potential), strategies, business plan, sales and marketing information and other data, whether or not patentable or copyrightable. This Agreement shall govern without regard to the manner of disclosure, transmittal or storage of such Confidential Information, including but not limited to verbal communications, documents, email, physical devices or materials, electronic devices or media, or any other method. The existence and terms of this Agreement and the fact that potential business arrangements are being discussed shall also be considered Confidential Information, and the Parties shall not disclose that Confidential Information has been or will be provided to them. Confidential Information also includes, without limitation, materials derived from other Confidential Information, such as analyses, compilations, data, studies and reports.',
    'The Receiving Party hereby agrees that all Confidential Information constitutes the sole and exclusive property of the Disclosing Party, which the Disclosing Party is entitled to protect. The Receiving Party shall only use the Confidential Information strictly for the Purpose. The Receiving Party shall hold and maintain all Confidential Information in confidence for the Disclosing Party and shall have an obligation to protect the Confidential Information from any harm, tampering, unauthorized access, sabotage, exploitation, manipulation, modification, interference, misuse, misappropriation, copying or disclosure whatsoever, except as specifically authorized by the Disclosing Party in writing. The standard of care for protecting Confidential Information imposed on the Receiving Party will be at least that degree of care the Receiving Party uses to prevent disclosure, publication or dissemination of its own Confidential Information, but in no event less than reasonable care. The Receiving Party will not disclose any of the Confidential Information in any manner whatsoever without the prior written consent of the Disclosing Party. Without limiting the generality of the foregoing, except as permitted herein, the Receiving Party shall not copy, publish, disclose to a third person, reverse-engineer or use the Confidential Information nor claim any intellectual property rights therein. The Receiving Party hereby agrees not to file any patent application or registration or any other intellectual property protection in connection with the Disclosing Party\'s Confidential Information disclosed to the Receiving Party pursuant to this Agreement.',
    'If the Receiving Party becomes legally compelled to disclose any of the Confidential Information, the Receiving Party agrees that it will provide the Disclosing Party with prompt written notice of such request or requirement sufficient to allow the Disclosing Party to seek a protective order or other appropriate remedy. If such protective order or other remedy is not obtained by the Disclosing Party or if the Disclosing Party grants a waiver hereunder, the Receiving Party may disclose such portion of the Confidential Information which it is legally compelled to disclose in the opinion of its counsel and shall obtain confidential treatment for any Confidential Information that it so discloses.',
    'In the event that the business relationship contemplated by the Purpose does not occur, the Receiving Party will not, directly or indirectly, use or permit the use of any Confidential Information of which it is the Receiving Party for its own benefit nor for the benefit of any third party.',
    'Neither this Agreement nor the disclosure of any information to the Receiving Party shall be construed as granting to the Receiving Party any rights in, to or in respect of the Confidential Information. The Receiving Party agrees that the execution of this Agreement does not in any way constitute a binding commitment on the part of the Disclosing Party to disclose Confidential Information, enter into, continue or complete negotiations or any transaction with the Receiving Party, nor to grant to the Receiving Party any license or any other rights.',
    'The Disclosing Party hereby excludes all representations, warranties and conditions, express or implied, including, without limitation, any representations, warranties or conditions of accuracy, sufficiency or suitability with respect to the Confidential Information.',
    'Upon the Disclosing Party\'s request for any reason, the Receiving Party will promptly deliver to the Disclosing Party all documents (and all copies thereof) furnished to the Receiving Party by or on behalf of the Disclosing Party pursuant hereto without retaining a copy thereof. If the Disclosing Party requests, the Receiving Party shall destroy all documents or other matters constituting Confidential Information in its possession, with any such destruction confirmed by the Receiving Party in writing to the Disclosing Party. In the event of such a decision or request, all other Confidential Information prepared by the Receiving Party shall be destroyed and no copy thereof shall be retained. Notwithstanding the return or destruction of the Confidential Information, the Receiving Party will continue to be bound by its obligations of confidentiality and other obligations hereunder.',
    'It is understood and agreed that no failure or delay by the Disclosing Party in exercising any right, power or privilege hereunder shall operate as a waiver thereof, nor shall any single or partial exercise thereof preclude any other or further exercise thereof or the exercise of any right, power or privilege hereunder.',
    'The Receiving Party agrees that any breach of the terms of this Agreement by the Receiving Party will cause the Disclosing Party irreparable harm, and the Disclosing Party shall be entitled to seek specific performance or injunctive relief to enforce the terms of this Agreement in addition to any remedies it may otherwise be entitled to at law or in equity.',
    'The Receiving Party shall indemnify the Disclosing Party, and save it harmless, effective as and from the date hereof, from and against any claims, demands, actions, causes of action, damages, losses, costs, liabilities or expenses which it may suffer or incur, or which may be made or brought against it, as a result of, in respect of, or arising out of, any breach or non-fulfillment of any term or condition of this Agreement by the Receiving Party.',
    'This Agreement will terminate five (5) years after the completion of the Purpose or the Disclosing Party\'s decision to abandon the Purpose. The obligations of the Receiving Party under this Agreement shall survive the expiry of this Agreement.',
    'The rights and obligations of the Parties hereunder shall be governed by and construed in accordance with the laws of the Province of Quebec and the laws of Canada applicable therein, without reference to its choice of law provisions. Each Party hereby irrevocably submits and attorns to the exclusive jurisdiction of the courts of the Province of Quebec, district of Montreal, in any action arising out of or relating to this Agreement.',
    'This Agreement constitutes the entire agreement between the Parties with respect to the subject matter hereof and supersedes and overrides any prior or other agreements, representations, warranties, understandings, negotiations and explanations between the Parties with respect to the subject matter of this Agreement.',
    'This Agreement shall not be amended in any manner except by an instrument in writing that expressly references this Agreement and is signed by both Parties.',
    'Neither Party may assign its rights and obligations under this Agreement without the prior written consent of the other Party.',
    'This Agreement is binding upon and shall enure to the benefit of the Parties hereto and their respective trustees, receivers, heirs, executors, administrators, successors and permitted assigns.',
    'Whenever, by the terms of this Agreement, notice, demand or other communication shall or may be given to either Party, the same shall be in writing and addressed to such Party at its address first set forth above, or to such other address or addresses as shall from time to time be designated by written notice by such Party to the other as herein provided. All notices shall be sent by registered or certified mail, postage prepaid and return receipt requested, or by Federal Express or other comparable courier providing proof of delivery, and shall be deemed duly given and received (i) if mailed, on the third (3rd) business day following the mailing thereof, or (ii) if sent by courier, the date of its receipt (or, if such day is not a business day, the next succeeding business day).',
    'The Parties acknowledge that they had the opportunity to have this Agreement reviewed by their respective legal counsel, and that any rule of construction to the effect that any ambiguity is to be resolved against the drafting Party shall not be applicable in the interpretation of this Agreement.',
    'The Parties have agreed that this Agreement shall be drawn up in English. Les parties ont demandé que cette convention soit rédigée en anglais.',
  ],
  agreed: 'AGREED AND ACCEPTED on the date first written above:',
  ackTitle: 'Signatures',
  ackSub: 'Please read carefully before signing',
  name: 'Name:', title: 'Title:', company: 'Company:', signature: 'Signature:', date: 'Date:',
  forParty: 'FOR',
  footer: '  |  Non-Disclosure Agreement  |  Confidential',
  page: (i, n) => `Page ${i} of ${n}`,
};

const FR = {
  docType: 'Entente de confidentialité et de non-divulgation',
  docTypeShort: 'Entente de confidentialité',
  confidential: 'Confidentiel',
  fields: ['AUTRE PARTIE', 'SIGNATAIRE', 'DATE D’EFFET', 'RÉFÉRENCE'],
  madeAsOf: (date) => `LA PRÉSENTE ENTENTE est conclue en date du ${date} (l'« Entente »)`,
  between: 'ENTRE',
  and: 'ET',
  residing: 'ayant son siège au',
  clusterShort: '(« Cluster »)',
  interpretation: 'Les parties sont parfois désignées ci-après individuellement une « Partie » et collectivement les « Parties ». La Partie qui communique des Renseignements confidentiels aux termes de la présente Entente est désignée la « Partie divulgatrice », et celle qui les reçoit, la « Partie destinataire ».',
  whereas: (purpose) => `ATTENDU QUE, afin que chaque Partie puisse évaluer son intérêt à établir une future relation d'affaires avec l'autre Partie portant précisément sur ${purpose} (l'« Objet »), il apparaît nécessaire que les Parties se communiquent certains renseignements confidentiels et exclusifs;`,
  nowTherefore: 'EN CONSÉQUENCE, en contrepartie des promesses, engagements et obligations réciproques contenus dans la présente Entente, et pour toute autre contrepartie valable dont la réception et la suffisance sont reconnues par les présentes, les Parties conviennent de ce qui suit :',
  clauses: [
    'Aux fins de la présente Entente, l\'expression « Renseignements confidentiels » désigne tout renseignement qui a été ou pourra être communiqué, fourni ou montré, quelle que soit la forme de la communication, y compris, sans limitation, tout renseignement relatif à l\'Objet de la présente Entente. Les Renseignements confidentiels comprennent, sans limitation, l\'ensemble des notes, analyses, idées, secrets commerciaux, savoir-faire, conceptions, compilations, études, résumés, échantillons de produits, formulations de produits, prototypes, données, procédés, formules, méthodes, matériaux, technologies, techniques de fabrication, réseaux, prix, renseignements sur la clientèle (existante ou potentielle), stratégies, plans d\'affaires, renseignements de vente et de marketing et autres données, qu\'ils soient ou non brevetables ou protégeables par le droit d\'auteur. La présente Entente s\'applique sans égard au mode de communication, de transmission ou de conservation des Renseignements confidentiels, y compris, sans s\'y limiter, les communications verbales, les documents, les courriels, les appareils ou supports physiques, les appareils ou supports électroniques ou toute autre méthode. L\'existence et les modalités de la présente Entente, ainsi que le fait que des arrangements d\'affaires potentiels soient discutés, sont aussi considérés comme des Renseignements confidentiels, et les Parties ne doivent pas divulguer que des Renseignements confidentiels leur ont été ou leur seront fournis. Les Renseignements confidentiels comprennent aussi, sans limitation, les éléments dérivés d\'autres Renseignements confidentiels, tels que les analyses, compilations, données, études et rapports.',
    'La Partie destinataire reconnaît que tous les Renseignements confidentiels constituent la propriété unique et exclusive de la Partie divulgatrice, qui a le droit de les protéger. La Partie destinataire n\'utilise les Renseignements confidentiels que strictement aux fins de l\'Objet. La Partie destinataire garde tous les Renseignements confidentiels en toute confidentialité pour la Partie divulgatrice et a l\'obligation de les protéger contre tout dommage, altération, accès non autorisé, sabotage, exploitation, manipulation, modification, interférence, mauvais usage, appropriation illicite, copie ou divulgation quelconque, sauf autorisation expresse et écrite de la Partie divulgatrice. Le degré de diligence imposé à la Partie destinataire pour la protection des Renseignements confidentiels est au moins celui qu\'elle exerce pour empêcher la divulgation, la publication ou la diffusion de ses propres renseignements confidentiels, mais n\'est en aucun cas inférieur à une diligence raisonnable. La Partie destinataire ne divulgue aucun Renseignement confidentiel, de quelque manière que ce soit, sans le consentement écrit préalable de la Partie divulgatrice. Sans restreindre la portée générale de ce qui précède, et sauf ce qui est permis aux présentes, la Partie destinataire ne doit pas copier, publier, divulguer à un tiers, rétroconcevoir ni utiliser les Renseignements confidentiels, ni revendiquer quelque droit de propriété intellectuelle que ce soit à leur égard. La Partie destinataire s\'engage à ne déposer aucune demande de brevet ou d\'enregistrement, ni aucune autre demande de protection de propriété intellectuelle, relativement aux Renseignements confidentiels de la Partie divulgatrice qui lui ont été communiqués aux termes de la présente Entente.',
    'Si la Partie destinataire est légalement contrainte de divulguer des Renseignements confidentiels, elle s\'engage à en aviser promptement par écrit la Partie divulgatrice, dans un délai suffisant pour permettre à celle-ci de demander une ordonnance de protection ou tout autre recours approprié. Si cette ordonnance ou ce recours n\'est pas obtenu par la Partie divulgatrice, ou si celle-ci accorde une renonciation aux termes des présentes, la Partie destinataire peut divulguer la partie des Renseignements confidentiels qu\'elle est, de l\'avis de ses conseillers juridiques, légalement tenue de divulguer, et doit obtenir un traitement confidentiel pour tout Renseignement confidentiel ainsi divulgué.',
    'Si la relation d\'affaires envisagée par l\'Objet ne se concrétise pas, la Partie destinataire ne doit pas, directement ou indirectement, utiliser ni permettre que soit utilisé un Renseignement confidentiel dont elle est la Partie destinataire, à son propre bénéfice ou au bénéfice d\'un tiers.',
    'Ni la présente Entente ni la communication de renseignements à la Partie destinataire ne doivent être interprétées comme conférant à celle-ci quelque droit que ce soit sur les Renseignements confidentiels ou à leur égard. La Partie destinataire reconnaît que la signature de la présente Entente ne constitue en aucune façon un engagement ferme de la Partie divulgatrice de communiquer des Renseignements confidentiels, d\'entamer, de poursuivre ou de conclure des négociations ou une transaction avec la Partie destinataire, ni de lui accorder une licence ou quelque autre droit.',
    'La Partie divulgatrice exclut par les présentes toute déclaration, garantie et condition, expresse ou implicite, y compris, sans limitation, toute déclaration, garantie ou condition quant à l\'exactitude, à la suffisance ou à la pertinence des Renseignements confidentiels.',
    'À la demande de la Partie divulgatrice, pour quelque raison que ce soit, la Partie destinataire lui remet promptement tous les documents (et toutes leurs copies) qui lui ont été fournis par la Partie divulgatrice ou pour son compte aux termes des présentes, sans en conserver de copie. Si la Partie divulgatrice le demande, la Partie destinataire détruit tous les documents ou autres éléments constituant des Renseignements confidentiels en sa possession et confirme cette destruction par écrit à la Partie divulgatrice. En cas d\'une telle décision ou demande, tous les autres Renseignements confidentiels préparés par la Partie destinataire sont détruits et aucune copie n\'en est conservée. Malgré la remise ou la destruction des Renseignements confidentiels, la Partie destinataire demeure liée par ses obligations de confidentialité et ses autres obligations aux termes des présentes.',
    'Il est entendu et convenu qu\'aucun défaut ou retard de la Partie divulgatrice dans l\'exercice d\'un droit, d\'un pouvoir ou d\'un privilège aux termes des présentes ne vaut renonciation à celui-ci, et que l\'exercice unique ou partiel d\'un tel droit, pouvoir ou privilège n\'empêche pas tout autre exercice de celui-ci ni l\'exercice de tout autre droit, pouvoir ou privilège aux termes des présentes.',
    'La Partie destinataire reconnaît que toute violation des modalités de la présente Entente de sa part causera un préjudice irréparable à la Partie divulgatrice, et que celle-ci aura le droit de demander l\'exécution en nature ou une injonction pour faire respecter les modalités de la présente Entente, en plus de tout autre recours dont elle peut disposer en droit ou en équité.',
    'La Partie destinataire indemnise la Partie divulgatrice et la tient indemne, à compter de la date des présentes, de toute réclamation, demande, action, cause d\'action, dommage, perte, coût, responsabilité ou dépense qu\'elle pourrait subir ou engager, ou qui pourrait être faite ou intentée contre elle, en raison ou à la suite de toute violation ou inexécution par la Partie destinataire d\'une modalité ou condition de la présente Entente.',
    'La présente Entente prend fin cinq (5) ans après la réalisation de l\'Objet ou la décision de la Partie divulgatrice d\'abandonner l\'Objet. Les obligations de la Partie destinataire aux termes de la présente Entente survivent à son expiration.',
    'Les droits et obligations des Parties aux termes des présentes sont régis par les lois de la province de Québec et les lois du Canada qui s\'y appliquent, et interprétés conformément à celles-ci, sans égard à leurs règles de conflit de lois. Chaque Partie se soumet irrévocablement à la compétence exclusive des tribunaux de la province de Québec, district de Montréal, pour toute action découlant de la présente Entente ou s\'y rapportant.',
    'La présente Entente constitue l\'intégralité de l\'entente entre les Parties quant à son objet et remplace toute entente, déclaration, garantie, entente tacite, négociation et explication antérieure ou autre entre les Parties à cet égard.',
    'La présente Entente ne peut être modifiée que par un écrit qui y fait expressément référence et qui est signé par les deux Parties.',
    'Aucune Partie ne peut céder ses droits et obligations aux termes de la présente Entente sans le consentement écrit préalable de l\'autre Partie.',
    'La présente Entente lie les Parties et s\'applique à leur bénéfice ainsi qu\'à celui de leurs fiduciaires, séquestres, héritiers, exécuteurs testamentaires, administrateurs, successeurs et ayants droit autorisés respectifs.',
    'Lorsque, aux termes de la présente Entente, un avis, une demande ou une autre communication doit ou peut être donné à une Partie, il doit être fait par écrit et adressé à cette Partie à l\'adresse indiquée en premier lieu ci-dessus, ou à toute autre adresse qu\'elle peut désigner de temps à autre par avis écrit à l\'autre Partie conformément aux présentes. Tous les avis sont envoyés par courrier recommandé ou certifié, port payé, avec accusé de réception, ou par Federal Express ou un autre service de messagerie comparable fournissant une preuve de livraison, et sont réputés dûment donnés et reçus (i) s\'ils sont postés, le troisième (3e) jour ouvrable suivant leur mise à la poste, ou (ii) s\'ils sont envoyés par messagerie, à la date de leur réception (ou, si ce jour n\'est pas un jour ouvrable, le jour ouvrable suivant).',
    'Les Parties reconnaissent avoir eu la possibilité de faire examiner la présente Entente par leurs conseillers juridiques respectifs, et qu\'aucune règle d\'interprétation voulant qu\'une ambiguïté soit résolue à l\'encontre de la Partie rédactrice ne s\'applique à l\'interprétation de la présente Entente.',
    'Les Parties ont exigé que la présente Entente soit rédigée en français. The Parties have required that this Agreement be drawn up in French.',
  ],
  agreed: 'CONVENU ET ACCEPTÉ à la date indiquée en premier lieu ci-dessus :',
  ackTitle: 'Signatures',
  ackSub: 'Veuillez lire attentivement avant de signer',
  name: 'Nom :', title: 'Titre :', company: 'Société :', signature: 'Signature :', date: 'Date :',
  forParty: 'POUR',
  footer: '  |  Entente de confidentialité  |  Confidentiel',
  page: (i, n) => `Page ${i} de ${n}`,
};

// Page de signature ajoutée au NDA DE L'AUTRE PARTIE (mode « PDF téléversé »).
const UPLOAD = {
  en: {
    kind: 'Non-Disclosure Agreement', confidential: 'Confidential', fields: ['OTHER PARTY', 'SIGNATORY', 'DATE SENT', 'REFERENCE'],
    intro: (cluster, other) => `By signing below, ${cluster} ("Cluster") and ${other} confirm that they have read and accept the following non-disclosure agreement:`,
    pages: (n) => (n ? `${n} page${n > 1 ? 's' : ''}` : ''),
    note: 'The fingerprint (SHA-256) identifies the exact document presented for signature. Any signature block within the document itself is deemed signed by the signatures applied on this page.',
    ackTitle: 'Signatures', ackSub: 'Please read carefully before signing',
    footer: '  |  Non-Disclosure Agreement  |  Signature page',
  },
  fr: {
    kind: 'Entente de confidentialité', confidential: 'Confidentiel', fields: ['AUTRE PARTIE', 'SIGNATAIRE', 'DATE D’ENVOI', 'RÉFÉRENCE'],
    intro: (cluster, other) => `En signant ci-dessous, ${cluster} (« Cluster ») et ${other} confirment avoir lu et accepté l'entente de confidentialité suivante :`,
    pages: (n) => (n ? `${n} page${n > 1 ? 's' : ''}` : ''),
    note: 'L’empreinte (SHA-256) identifie le document exact présenté pour signature. Tout bloc de signature figurant dans le document lui-même est réputé signé par les signatures apposées sur la présente page.',
    ackTitle: 'Signatures', ackSub: 'Veuillez lire attentivement avant de signer',
    footer: '  |  Entente de confidentialité  |  Page de signature',
  },
};

module.exports = { CLUSTER, DEFAULT_PURPOSE, NDA: { en: EN, fr: FR }, UPLOAD };
