// ============================================================================
// RH — texte des deux documents.
//
// ⚠️ L'OFFRE D'EMPLOI EST DU TEXTE JURIDIQUE REPRIS MOT POUR MOT du gabarit Word
// « Cluster Offer of Employment - Template.docx », coquilles comprises (« be draft in
// English », « it personnel », « prior your commencement date »…). Ne pas « corriger » ici :
// une retouche au contrat de travail se fait dans le gabarit, validée par qui l'a rédigé, puis
// se recopie. Seuls les champs entre accolades varient, plus trois retraits encadrés dans
// offerSalaryExtra() quand une allocation vaut 0.
//
// Les DEUX documents existent en français et en anglais. La version française de l'offre est
// en bas de ce fichier (OFFER_CLAUSES_FR). Quand un dossier part en anglais, la version
// française est quand même générée et présentée au candidat (Charte, art. 55 : un contrat
// d'adhésion doit d'abord être remis en français) — voir routes.js.
// ============================================================================

const OFFER_CLAUSES = [
  ['1. Supersedes Prior Agreements.', 'You acknowledge and agree that this agreement supersedes and replaces any prior agreement, written or oral, between Cluster and you and that any such prior agreements are hereby effectively terminated and of no further force or effect.'],
  ['2. Commencement Date and Term.', 'Your employment with Cluster will commence on {startDate}, for an indefinite period of time, subject to the provisions related to the termination of employment set out below'],
  ['3. Duties and Responsibilities.', 'You will be reporting to the {reportsToTitle}, {reportsToName}. Your duties and responsibilities shall include, in addition to those inherent to your title, those compatible with your position at the discretion of Cluster.'],
  [null, 'During the term of this agreement, you shall devote your full business time and reasonable commercial efforts, business judgment, skill and knowledge to the advancement of the business and best interests of Cluster, and shall not engage in any other business activity, except as may be expressly approved by Cluster in writing.'],
  ['4. Salary.', "Your starting annual salary will be CAD {annualSalary}, payable in accordance with Cluster's standard payroll practices."],
  [null, '{salaryExtra}'],
  [null, 'All amounts are subject to applicable statutory deductions and withholdings and will be paid in accordance with Cluster’s standard payroll practices. Your salary shall be prorated for any partial year of employment.'],
  [null, 'Your work schedule will be during regular office hours.'],
  ['5. Vacation.', 'You are entitled to {vacationWeeks} weeks of paid vacation, prorated from your start date, to be taken at such times and intervals as mutually agreed upon between Cluster and you. The vacation calendar runs from January 1 to December 31.'],
  ['6. Probation Period.', 'Your initial three (3) months of employment will be probationary during which time Cluster may terminate this agreement without notice. At the end of your probation period, you will receive a performance review. In the event Cluster requires more time to assess your ability to perform the duties of the position and suitability, Cluster may, at its sole discretion, extend the probationary period by three (3) months. Cluster shall notify you in writing that it intends to extend the probationary period prior to the last day of your initial probationary period.'],
  ['7. Benefits.', 'You will become eligible to participate in Cluster’s group insurance program after completing three (3) months of continuous employment, in accordance with the terms, conditions, and eligibility requirements of the program. Cluster reserves the right to modify, replace, or discontinue, in whole or in part, the benefits associated with such program at any time, without notice or compensation whatsoever.'],
  ['8. Confidentiality.', '“Confidential Information” shall mean Cluster’s Intellectual Property, clients, trade secrets, know-how and other proprietary and confidential information, whether technical or non-technical, relating to the present, future and contemplated businesses and operations of Cluster or to any of its clients, suppliers, customers, agents or consultants, including without limitation, security policies, reports, audits, appraisals, evaluations, action plans, products, software programs and source codes, related documentation in hard copy, customer lists, marketing strategies, financial information and business practices, forms, solicitation and renewal letters, rate cards, and other correspondence to customers or potential customers, former customers or potential customers of Cluster, financial information, including tax returns, balance sheets, documents evidencing revenue or expenditure of Cluster, salaries and other benefits of employees or agents of Cluster or of its shareholders, directors, officers or principals, the direct or indirect disclosure of any of which to competitors of Cluster or to the general public would be highly detrimental to the best interests of Cluster or those of its affiliates and the respective shareholders of each of the foregoing legal persons. Nothing herein shall be limited by the fact that some of or all of the materials referenced herein may have been disseminated in whole or in part to the public. You acknowledge that the purpose and intent of the present clause is to limit the use of the Confidential Information for the purposes of harming Cluster and materially benefiting from the use of the said information.'],
  [null, 'You covenant and agree that you will not at any time during the term of this agreement or at any time thereafter, whether directly or indirectly, divulge, publish or communicate, or exploit or utilize for your benefit or any other party, person or entity, any Confidential Information which you have acquired during or as a result of your employment with Cluster.'],
  [null, 'You hereby expressly covenant and agree that you shall, upon written request by Cluster, return all documentation, client lists and files, reports, tools, audits, evaluations, source codes, software, computer programs, object codes or design specifications for any such source code or software developed by Cluster and all other Confidential Information belonging to Cluster. You shall not remove from the premises of Cluster any such materials or any originals except in direct furtherance of the business of Cluster and within the scope of your services to Cluster, unless specifically authorized in writing by Cluster. You agree not to transmit via electronic mail to yourself or to any third party any Confidential Information and shall not employ any external hard drive or media to collect or copy Confidential Information without the express written consent of the Company.'],
  ['9. Intellectual Property.', '“Intellectual Property” shall mean all inventions, discoveries, developments, methods, applications, processes, procedures, compositions, works, trade secrets, know-how, show-how, production methods, designs, concepts, ideas, recipes, formulae, blueprints, product development, copyright, trademarks, trademark applications, patents and patent applications, to the extent: (i) conceived, made, created, developed, reduced to practice or otherwise contributed to by you during or in connection with your employment with Cluster or any affiliate thereof, whether prior to or following the commencement date, whether alone or with others, whether during or outside of normal business hours or on or off the Corporation’s premises; or (ii) resulting from the use of, reliance upon or otherwise incorporating any Confidential Information or any of the equipment or facilities of the Corporation or any affiliate thereof; and all embodiments, improvements, modifications, translations, adaptations, refinements, derivations and combinations thereof, whether or not patentable, copyrightable or otherwise registrable;'],
  [null, 'You hereby assign and agree to assign to Cluster your full right, title and interest in and to all Intellectual Property, whether conceived, made, created, developed, reduced to practice or otherwise contributed to by you prior to, on or following the commencement of your employment at Cluster. You agree to execute any and all applications for domestic and foreign patents, copyrights or other proprietary rights and to do such other acts (including without limitation the execution and delivery of instruments of further assignment, assurance, waiver or confirmation) requested by Cluster to assign the Intellectual Property to Cluster and to permit Cluster to enforce any patents, copyrights or other proprietary rights to the Intellectual Property.'],
  [null, 'All copyrightable works that you may hereafter create or contribute to, or that you created or contributed to prior your commencement date, that relate to Cluster shall be considered “works made for hire” and shall, upon creation and without more, be owned exclusively by Cluster.'],
  [null, 'You hereby irrevocably waive all moral rights and other non-assignable rights that you may now or hereafter possess in any Intellectual Property.'],
  ['10. Non-Compete Covenant.', 'You hereby covenant and agree that, during your employment and thereafter for a period of one year following the termination of your employment, you shall not, within Canada (the “Territory”), directly or indirectly, in any way, whether for your own account or the account of any other individual or entity, individually or in partnership:'],
  ['(a)', 'carry on activities or be employed by or be engaged or have any financial or other interest in or be otherwise commercially involved in the solicitation of merchants for purposes of providing credit card processing services (the “Restricted Business”), whether as principal, agent, shareholder, investor, partner, equity owner, consultant, employee, lender, guarantor or in any other manner or capacity whatsoever; or', 'item'],
  ['(b)', 'provide financial support by way of loan or guarantee or otherwise, or permit his likeness or name or any part thereof to be used or employed by any individual or entity involved with, a Restricted Business,', 'item'],
  [null, 'in each case, without the prior written consent of Cluster, which consent may be withheld for any reason in Cluster’s sole and unfettered discretion.'],
  ['11. Non-Solicit Covenant.', 'You hereby covenant and agree that, during your employment and thereafter for a period of one year following the termination your employment, you shall not, directly or indirectly, in any way, whether for your own account or the account of any other individual or entity, in any manner or capacity whatsoever, solicit or encourage any person having purchased or licensed Cluster’s products or services at any time during the one-year period preceding your termination, to discontinue or reduce the volume of business they do with Cluster or attempt to interfere in any way with Cluster’s relationship with them, without the prior written consent of Cluster, which consent may be withheld for any reason in Cluster’s sole and unfettered discretion.'],
  [null, 'Furthermore, you hereby covenant and agree that, during your employment and thereafter for a period of one year following the termination of your employment, you shall not, directly or indirectly, in any way, whether for your own account or the account of any other individual or entity, in any manner or capacity whatsoever, solicit or encourage any employee or contractor who is employed or retained by Cluster, or offer employment or a service contract to any employee or contractor who is employed or retained by Cluster or any of its affiliates, or encourage any employee or contractor of Cluster or any of its affiliates to terminate his/her employment or relationship with Cluster or any of its affiliates, or otherwise attempt to interfere with the relationship of Cluster or any such affiliate with any such employee or contractor; in each case, without the prior written consent of Cluster, which consent may be withheld for any reason in Cluster’s sole and unfettered discretion.'],
  ['12. Non-disparagement.', 'You acknowledge and agree that Cluster is in the services business and that its reputation is one of its most valuable assets. Accordingly, you undertake and agree that in no event shall you, directly or indirectly, during your employment, or thereafter, in any way disseminate, issue, publish or post in any media, whether digital, written or oral, or telephonically or otherwise, any disparaging comments with respect to Cluster, its operations or it personnel, nor which falsely represent or misrepresent the activities of Cluster nor its products or services, whether for the purposes of obtaining sales or for any other reason whatsoever.'],
  ['13. Termination.', 'You may, at any time, terminate this agreement for any reason whatsoever by giving Cluster written notice at least four weeks before the date of such termination. You may not, however, take vacation leave during this notice period without Cluster’s written consent. Cluster reserves the right to waive this notice, either in whole or in part.'],
  [null, 'Cluster may, at any time, terminate this agreement:'],
  ['(a)', 'during the probation period at any time and in Cluster sole discretion, without prior notice;', 'item'],
  ['(b)', 'for cause without further notice;', 'item'],
  ['(c)', 'without cause, by giving you a written notice in accordance with applicable laws. Cluster may, however, at its sole discretion, replace this written notice in whole or in part by giving you severance pay calculated using your salary equal to the unworked portion of the written notice period; or', 'item'],
  ['(d)', 'automatically upon your death.', 'item'],
  [null, 'Return of Property:', 'sub'],
  [null, 'Upon the termination of employment, whether voluntary or involuntary, the Employee agrees to return all company property, including but not limited to equipment, tools, documents, keys, electronics, intellectual property, and any other assets provided by Cluster during the course of employment.'],
  [null, 'Responsibility for Unreturned or Damaged Property:', 'sub'],
  [null, 'In the event that any company property is not returned or is returned in a damaged condition, the Employee acknowledges and agrees that Cluster may deduct the reasonable value of the unreturned or damaged property from any outstanding wages, including the final paycheck, subject to applicable laws.'],
  [null, 'Value of Unreturned or Damaged Property:', 'sub'],
  [null, 'Cluster shall provide an itemized list of any unreturned or damaged property along with an estimate of its value. The Employee agrees to reimburse Cluster for such property, and Cluster is authorized to make a deduction from the final paycheck, provided that the amount is reasonable and does not exceed the value of the unreturned or damaged property.'],
  [null, 'Agreement to Deductions:', 'sub'],
  [null, 'By signing this Offer of Employment, the Employee acknowledges and agrees that, subject to the terms outlined above, Cluster may deduct any amounts owed for unreturned or damaged property from the final paycheck or any other wages owed, as permitted by applicable law.'],
  ['14. Governing Law and Attornment.', 'This agreement shall be governed by and interpreted and construed in accordance with the laws of the Province of Québec. The parties hereby agree that any legal action or proceeding in respect of all matters arising out of any of the obligations contemplated by this agreement shall be brought exclusively in the competent courts of the Province of Québec, District of Montreal.'],
  ['15. Monetary References.', 'All references in this agreement to “dollars” or to “$” are expressed in Canadian currency.'],
  ['16. Language.', 'You have expressly requested this agreement be draft in English. Vous avez expressément demandé à ce que le présent contrat soit écrit en anglais.'],
];

const OFFER_INTRO = [
  'On behalf of Cluster, I am delighted to offer you the position of {position}. We believe that your skills and dedication will be a tremendous asset to our company, and we are eager to see the impact you will make in this new role.',
  'As an employee of Cluster, we expect personal accountability for all services, actions, advice, and results that you provide throughout the duration of your employment with us. In return, we are committed to providing you with every opportunity to learn and grow to the highest level of your ability and potential.',
  'If you agree to this offer, it will become your employment agreement with Cluster. Please note that this offer is contingent on a cleared background check if required.',
];

const OFFER_CLOSING = [
  'By signing this offer letter, you acknowledge and agree to adhere to all Cluster policies.',
  'We are confident that you will make a significant contribution to the success of our company and look forward to having you join our team!',
  'Best regards,',
];

const OFFER_ACK = 'With your signature below, you acknowledge that you had a reasonable time to read and understand this agreement and had the opportunity to ask all questions you may have, and that you have verified the scope of your rights and obligations and had the opportunity to consult a legal advisor. Furthermore, you accept and understand the employment offered to you upon the terms and conditions set forth herein, including but not limited to those relating to the termination of your employment and restrictive covenants.';

// Clause 4, 2e paragraphe. Avec les valeurs du gabarit (commissions, 6 000 $, 60 $) la phrase
// ressort EXACTEMENT comme dans le Word ; une allocation à 0 retire sa proposition au lieu
// d'écrire « $0 », et un poste sans commission retire la première phrase.
function offerSalaryExtra(terms, money) {
  const parts = [];
  if (terms.commissionEligible) parts.push('In addition, you will be eligible to earn commissions.');
  const car = Number(terms.carAllowance) > 0;
  const phone = Number(terms.phoneAllowance) > 0;
  if (car && phone) {
    parts.push(`You will also receive a car allowance of ${money(terms.carAllowance)} per year, paid in accordance with the Company’s standard payroll practices, as well as a monthly phone allowance of ${money(terms.phoneAllowance)}.`);
  } else if (car) {
    parts.push(`You will also receive a car allowance of ${money(terms.carAllowance)} per year, paid in accordance with the Company’s standard payroll practices.`);
  } else if (phone) {
    parts.push(`You will also receive a monthly phone allowance of ${money(terms.phoneAllowance)}.`);
  }
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Entente de rémunération v7.7 — EN et FR, reprises des PDF signés d'avril 2026. Les valeurs
// chiffrées viennent du plan de l'embauche (p), les montants passent par money() de la langue.
// ---------------------------------------------------------------------------
const AGREEMENT = {
  en: {
    docType: 'Compensation Agreement',
    version: (v) => `Version ${v} FINAL  ·  Confidential`,
    footer: (pos, v) => `  |  ${pos} Compensation Agreement v${v}  |  Confidential`,
    fields: ['EMPLOYEE', 'POSITION', 'SUPERVISOR', 'EFFECTIVE DATE'],
    agreementLabel: 'AGREEMENT',
    agreement: (name, pos) => `This ${pos} Compensation Agreement (the "Agreement") is entered into between Cluster Systems (the "Company") and ${name} (the "Employee"). This Agreement sets out the complete terms of the Employee's variable compensation and supersedes any prior verbal or written discussions on the subject.`,
    agreementNote: 'The Employee acknowledges that compensation under this Agreement is performance-based and contingent upon meeting the conditions set out herein.',
    s1: 'Compensation Overview',
    s1Intro: "The Employee's total compensation package consists of the following components:",
    s1Cols: ['Component', 'Description'],
    s1Rows: [
      ['Base Salary', 'Fixed monthly salary as agreed in the employment contract.'],
      ['Commissions', 'Variable earnings based on completed hardware, SaaS, and payment processing deals.'],
      ['Monthly Bonuses', 'Performance bonuses unlocked upon exceeding monthly quota thresholds.'],
      ['Annual Bonus', 'Year-end bonus based on total annual points accumulated during the calendar year.'],
    ],
    corePrinciple: 'Core Principle:  Quota attainment unlocks core variable compensation (Hardware & SaaS). Failure to meet quota in a given month results in base salary only for that month.',
    s2: 'Monthly Quota',
    s2Intro: (q) => `The Employee agrees to a monthly quota of ${q} sales points. Quota is measured exclusively on SOLD deals, defined as signed and approved deals for which a deposit has been received by the Company.`,
    quotaMet: 'Quota Met',
    quotaMetLines: ['All hardware and SaaS commissions for that month are unlocked.', 'Monthly performance bonuses become payable.'],
    quotaNotMet: 'Quota Not Met',
    quotaNotMetLines: ['No hardware or SaaS commissions are paid for deals that month.', 'No monthly bonuses. Base salary only.'],
    s2Notes: [
      'Payment processing commissions are always paid regardless of whether the monthly quota has been met.',
      'Hardware and SaaS commissions become payable once a deal is fully completed: the solution is activated and installed, the balance is paid in full, and the first SaaS month has been collected.',
    ],
    s3: 'Sales Activity Point System',
    s3Intro: 'Points are earned based on the type of sale completed. Payment Processing attachments can be added on top of any POS sale to increase total points:',
    s3Cols: ['Sales Activity', 'Points', 'Example Total'],
    s3Rows: (p, n) => [
      ['Inbound POS Sale', n(p.pointsInbound), n(p.pointsInbound)],
      ['Outbound POS Sale', n(p.pointsOutbound), n(p.pointsOutbound)],
      ['+ Payment Processing Attachment (add-on)', `+${n(p.pointsProcessing)}`, `${n(p.pointsInbound + p.pointsProcessing)} or ${n(p.pointsOutbound + p.pointsProcessing)}`],
    ],
    s3Note: (p, n) => `An Outbound POS Sale combined with a Payment Processing Attachment yields ${n(p.pointsOutbound + p.pointsProcessing)} points toward monthly quota.`,
    s4: 'Commission Structure',
    s4Intro: 'Subject to quota attainment (where applicable), the Employee is entitled to the following commissions:',
    s4Cols: ['Type', 'Rate', 'Conditions'],
    s4Rows: (p, m, pct) => [
      ['Hardware', `${pct(p.hardwareRate)} of hardware value`, `Reduced to ${pct(p.hardwareReducedRate)} if client discount is ${pct(p.discountThreshold)} or greater.`],
      ['SaaS', `${pct(p.saasFirstMonthPct)} of first month fee`, 'Applies to the first monthly subscription payment collected.'],
      ['Signup Bonus', `${m(p.signupBonus)} flat bonus`, 'Per approved and activated payment processing account.'],
      ['Processing', 'Ongoing — see below', `Always paid. Not gated by quota. Capped at ${m(p.processingCap)} per account.`],
    ],
    biAnnualTitle: 'Bi-Annual Processing Performance Bonus:',
    biAnnual: (p, m) => `In addition to standard processing commissions, the Employee may earn a bi-annual performance bonus based on the cumulative performance of their active merchant accounts. This bonus is paid twice per year, calculated on a trailing 6-month basis. To qualify, accounts must remain active and generate more than ${m(p.biAnnualMinMargin)} in monthly margin/value during the measurement period. The Employee must be actively employed at the time of payout.`,
    s5: 'Monthly Performance Bonuses',
    s5Intro: (q) => `When the monthly quota of ${q} points is met, the Employee becomes eligible for the following additional performance bonuses based on total points achieved for that month:`,
    s5Cols: ['Monthly Points Achieved', 'Bonus Earned'],
    points: (n) => `${n} points`,
    s5Note: 'Bonuses are not cumulative. Only the highest applicable bonus tier is paid for a given month.',
    s6: 'Annual Performance Bonus',
    s6Intro: 'The Employee is eligible for an annual performance bonus based on total points accumulated over the calendar year. Points are calculated using the same activity point system described in Section 3 of this Agreement.',
    s6Cols: ['Annual Points Accumulated', 'Annual Bonus'],
    s6Note: "Annual bonuses are paid on the first pay period following June 1 of the following year. This bonus plan is not guaranteed; targets and payout amounts are reviewed and set at the Company's discretion each year. The plan may be modified or withdrawn at any time.",
    s7: 'Ramp Period & Payment Timing',
    s7Paras: (p) => [
      `A ${p.rampDays}-day introductory ramp period applies from the date of hire. During this period, quota tracking is suspended and no commission eligibility requirements apply. Quota tracking and full plan terms take effect on Day ${p.rampDays + 1} of employment.`,
      "All commissions and bonuses are calculated monthly and paid on the regular pay cycle covering the previous calendar month's completed deals.",
    ],
    s8: 'General Conditions',
    s8Intro: 'The following conditions apply to all compensation described in this Agreement:',
    s8Items: [
      'Only completed, legitimate deals count toward quota and commission calculations. The Company reserves the right to withhold or claw back commissions on deals later found to be fraudulent, cancelled, or non-compliant.',
      'The Employee must be actively employed by the Company at the time any bonus or commission payout is processed in order to be eligible to receive it.',
      'This Agreement, including all quotas, point values, commission rates, and bonus structures, may be amended at any time at the sole discretion of the Company. The Company will provide reasonable advance notice of material changes where possible.',
      "This Agreement does not constitute a guarantee of any minimum earnings beyond the Employee's base salary. Variable compensation is earned solely through performance.",
    ],
    ackTitle: 'Acknowledgment & Agreement',
    ackSub: 'Please read carefully before signing',
    ack: "By signing this Agreement, both parties confirm that the Employee has read, understood, and voluntarily agrees to the compensation terms set out above. This document constitutes the full understanding between the parties regarding the Employee's variable compensation.",
    employee: 'EMPLOYEE',
    supervisor: 'SUPERVISOR',
    fullName: 'Full Name:',
    signature: 'Signature:',
    date: 'Date:',
    confidential: 'This document is confidential and intended solely for the named parties. Unauthorized reproduction or distribution is prohibited.',
  },
  fr: {
    docType: 'Entente de rémunération',
    version: (v) => `Version ${v} FINALE  ·  Confidentiel`,
    footer: (pos, v) => `  |  Entente de rémunération — ${pos} v${v}  |  Confidentiel`,
    fields: ['EMPLOYÉ(E)', 'POSTE', 'SUPERVISEUR', "DATE D'ENTRÉE EN VIGUEUR"],
    agreementLabel: 'ENTENTE',
    agreement: (name) => `La présente entente de rémunération (l'« Entente ») est conclue entre Cluster Systems (la « Société ») et ${name} (l'« Employé(e) »). Cette Entente définit l'ensemble des conditions de rémunération variable de l'Employé(e) et remplace toute discussion antérieure, verbale ou écrite, sur le sujet.`,
    agreementNote: "L'Employé(e) reconnaît que la rémunération prévue à la présente Entente est basée sur la performance et conditionnelle au respect des conditions qui y sont énoncées.",
    s1: 'Aperçu de la rémunération',
    s1Intro: "Le régime de rémunération global de l'Employé(e) comprend les éléments suivants :",
    s1Cols: ['Composante', 'Description'],
    s1Rows: [
      ['Salaire de base', 'Salaire mensuel fixe tel que convenu dans le contrat de travail.'],
      ['Commissions', 'Gains variables basés sur les transactions conclues en matériel, SaaS et traitement des paiements.'],
      ['Primes mensuelles', 'Primes de performance débloquées lors du dépassement des seuils de quota mensuel.'],
      ['Prime annuelle', "Prime de fin d'année basée sur le total des points accumulés au cours de l'année civile."],
    ],
    corePrinciple: "Principe fondamental :  L'atteinte du quota mensuel débloque la rémunération variable principale (matériel et SaaS). En cas de non-atteinte du quota, seul le salaire de base est versé pour ce mois.",
    s2: 'Quota mensuel',
    s2Intro: (q) => `L'Employé(e) s'engage à atteindre un quota mensuel de ${q} points de vente. Le quota est mesuré exclusivement sur les transactions VENDUES, définies comme des transactions signées et approuvées pour lesquelles un dépôt a été reçu par la Société.`,
    quotaMet: 'Quota atteint',
    quotaMetLines: ['Toutes les commissions sur le matériel et le SaaS pour ce mois sont débloquées.', 'Les primes de performance mensuelles deviennent payables.'],
    quotaNotMet: 'Quota non atteint',
    quotaNotMetLines: ["Aucune commission sur le matériel ou le SaaS n'est versée pour les transactions de ce mois.", 'Aucune prime mensuelle. Salaire de base uniquement.'],
    s2Notes: [
      "Les commissions sur le traitement des paiements sont toujours versées, indépendamment de l'atteinte du quota mensuel.",
      'Les commissions sur le matériel et le SaaS sont payables une fois la transaction entièrement complétée : solution activée et installée, solde payé en totalité et premier mois de SaaS encaissé.',
    ],
    s3: "Système de points d'activité de vente",
    s3Intro: 'Les points sont attribués selon le type de vente réalisée. Un ajout de traitement des paiements peut être combiné à toute vente de système de point de vente pour augmenter le total de points :',
    s3Cols: ['Activité de vente', 'Points', 'Total exemple'],
    s3Rows: (p, n) => [
      ['Vente POS entrante', n(p.pointsInbound), n(p.pointsInbound)],
      ['Vente POS sortante', n(p.pointsOutbound), n(p.pointsOutbound)],
      ['+ Ajout traitement des paiements', `+${n(p.pointsProcessing)}`, `${n(p.pointsInbound + p.pointsProcessing)} ou ${n(p.pointsOutbound + p.pointsProcessing)}`],
    ],
    s3Note: (p, n) => `Une vente POS sortante combinée à un ajout de traitement des paiements totalise ${n(p.pointsOutbound + p.pointsProcessing)} points vers le quota mensuel.`,
    s4: 'Structure des commissions',
    s4Intro: "Sous réserve de l'atteinte du quota (le cas échéant), l'Employé(e) a droit aux commissions suivantes :",
    s4Cols: ['Type', 'Taux', 'Conditions'],
    s4Rows: (p, m, pct) => [
      ['Matériel', `${pct(p.hardwareRate)} de la valeur du matériel`, `Réduit à ${pct(p.hardwareReducedRate)} si la remise accordée au client est de ${pct(p.discountThreshold)} ou plus.`],
      ['SaaS', `${pct(p.saasFirstMonthPct)} du premier mois`, "S'applique au premier paiement mensuel d'abonnement encaissé."],
      ["Prime d'activation", `${m(p.signupBonus)} forfaitaire`, 'Par compte de traitement de paiements approuvé et activé.'],
      ['Traitement', 'Continu — voir ci-dessous', `Toujours versé. Non conditionnel au quota. Plafonné à ${m(p.processingCap)} par compte.`],
    ],
    biAnnualTitle: 'Prime de performance semestrielle (traitement des paiements) :',
    biAnnual: (p, m) => `En plus des commissions standard sur le traitement, l'Employé(e) peut obtenir une prime de performance semestrielle basée sur la performance cumulée de ses comptes marchands actifs. Cette prime est versée deux fois par an, calculée sur une base glissante de 6 mois. Pour être admissible, les comptes doivent demeurer actifs et générer plus de ${m(p.biAnnualMinMargin)} en marge/valeur mensuelle pendant la période de mesure. L'Employé(e) doit être en poste au moment du versement.`,
    s5: 'Primes de performance mensuelles',
    s5Intro: (q) => `Lorsque le quota mensuel de ${q} points est atteint, l'Employé(e) devient admissible aux primes de performance supplémentaires suivantes, selon le total de points réalisés ce mois-là :`,
    s5Cols: ['Points mensuels atteints', 'Prime versée'],
    points: (n) => `${n} points`,
    s5Note: 'Les primes ne sont pas cumulatives. Seul le palier le plus élevé atteint est versé pour un mois donné.',
    s6: 'Prime annuelle de performance',
    s6Intro: "L'Employé(e) est admissible à une prime annuelle de performance basée sur le total des points accumulés au cours de l'année civile. Les points sont calculés selon le même système d'activité de vente décrit à la Section 3 de la présente Entente.",
    s6Cols: ['Points annuels accumulés', 'Prime annuelle'],
    s6Note: "Les primes annuelles sont versées lors de la première période de paie suivant le 1er juin de l'année suivante. Ce régime de primes n'est pas garanti ; les cibles et les montants sont révisés et établis à la discrétion de la Société chaque année. Le régime peut être modifié ou retiré en tout temps.",
    s7: "Période d'intégration et calendrier de paiement",
    s7Paras: (p) => [
      `Une période d'intégration de ${p.rampDays} jours s'applique à compter de la date d'embauche. Pendant cette période, le suivi du quota est suspendu et aucune condition d'admissibilité aux commissions ne s'applique. Le suivi du quota et les conditions complètes de l'Entente entrent en vigueur au ${p.rampDays + 1}e jour d'emploi.`,
      'Toutes les commissions et primes sont calculées mensuellement et versées lors du cycle de paie régulier couvrant les transactions complétées du mois civil précédent.',
    ],
    s8: 'Conditions générales',
    s8Intro: 'Les conditions suivantes s\'appliquent à toute rémunération décrite dans la présente Entente :',
    s8Items: [
      'Seules les transactions complètes et légitimes sont comptabilisées dans le calcul du quota et des commissions. La Société se réserve le droit de retenir ou de récupérer les commissions sur des transactions ultérieurement reconnues comme frauduleuses, annulées ou non conformes.',
      "L'Employé(e) doit être activement en poste au sein de la Société au moment du traitement de tout versement de prime ou de commission pour y être admissible.",
      'La présente Entente, incluant tous les quotas, valeurs de points, taux de commission et structures de primes, peut être modifiée en tout temps à la seule discrétion de la Société. La Société fournira un préavis raisonnable pour les changements importants, dans la mesure du possible.',
      "La présente Entente ne constitue pas une garantie d'un revenu minimum au-delà du salaire de base de l'Employé(e). La rémunération variable est gagnée uniquement par la performance.",
    ],
    ackTitle: 'Reconnaissance et acceptation',
    ackSub: 'Veuillez lire attentivement avant de signer',
    ack: "En signant la présente Entente, les deux parties confirment que l'Employé(e) a lu, compris et accepté volontairement les conditions de rémunération qui y sont énoncées. Ce document constitue l'entente complète entre les parties concernant la rémunération variable de l'Employé(e).",
    employee: 'EMPLOYÉ(E)',
    supervisor: 'SUPERVISEUR',
    fullName: 'Nom complet :',
    signature: 'Signature :',
    date: 'Date :',
    confidential: 'Ce document est confidentiel et destiné uniquement aux parties nommées. Toute reproduction ou diffusion non autorisée est interdite.',
  },
};

// ---------------------------------------------------------------------------
// OFFRE D'EMPLOI — VERSION FRANÇAISE (2026-09-23, à la demande de David : « tout doit être dans
// les deux langues »).
//
// ⚠️ TRADUCTION FAITE PAR CLAUDE, NON RÉVISÉE PAR UN JURISTE. Elle suit l'anglais clause par
// clause, même numérotation, même structure ([titre, texte, genre]) pour que les deux versions
// restent superposables. Les coquilles de l'anglais ne sont pas reproduites (« it personnel »
// devient « son personnel ») : une traduction rend le sens, pas les fautes.
//
// Deux écarts VOULUS avec l'anglais :
//   - Clause 3 : l'anglais dit « reporting to the TITLE, NAME » ; le français place le nom en
//     premier (« de NOM, TITRE ») pour éviter l'accord du/de la selon le titre.
//   - Clause 16 : l'anglais constate que l'employé a DEMANDÉ l'anglais. En français, il n'y a
//     rien à demander : la clause constate que le contrat est rédigé en français et qu'une
//     version anglaise peut lui avoir été remise. (Charte de la langue française, art. 41 et 55.)
// ---------------------------------------------------------------------------
const OFFER_CLAUSES_FR = [
  ['1. Primauté sur les ententes antérieures.', 'Vous reconnaissez et convenez que le présent contrat remplace toute entente antérieure, écrite ou verbale, intervenue entre Cluster et vous, et que toute telle entente antérieure est par les présentes résiliée et sans autre force ni effet.'],
  ['2. Date d’entrée en fonction et durée.', 'Votre emploi chez Cluster débutera le {startDate}, pour une durée indéterminée, sous réserve des dispositions relatives à la fin d’emploi énoncées ci-dessous.'],
  ['3. Fonctions et responsabilités.', 'Vous relèverez de {reportsToName}, {reportsToTitle}. Vos fonctions et responsabilités comprendront, en plus de celles inhérentes à votre titre, celles compatibles avec votre poste, à la discrétion de Cluster.'],
  [null, 'Pendant la durée du présent contrat, vous consacrerez tout votre temps de travail ainsi que des efforts commerciaux raisonnables, votre jugement professionnel, vos compétences et vos connaissances à l’avancement des affaires et des meilleurs intérêts de Cluster, et vous ne vous livrerez à aucune autre activité commerciale, sauf approbation expresse et écrite de Cluster.'],
  ['4. Salaire.', 'Votre salaire annuel de départ sera de {annualSalary} CAD, payable conformément aux pratiques de paie habituelles de Cluster.'],
  [null, '{salaryExtra}'],
  [null, 'Tous les montants sont assujettis aux retenues et déductions prévues par la loi et seront versés conformément aux pratiques de paie habituelles de Cluster. Votre salaire sera calculé au prorata pour toute année d’emploi incomplète.'],
  [null, 'Votre horaire de travail correspondra aux heures normales de bureau.'],
  ['5. Vacances.', 'Vous avez droit à {vacationWeeks} semaines de vacances payées, calculées au prorata à compter de votre date d’entrée en fonction, à prendre aux moments et selon les intervalles convenus d’un commun accord entre Cluster et vous. L’année de référence des vacances s’étend du 1er janvier au 31 décembre.'],
  ['6. Période de probation.', 'Vos trois (3) premiers mois d’emploi constitueront une période de probation au cours de laquelle Cluster pourra mettre fin au présent contrat sans préavis. À la fin de votre période de probation, vous ferez l’objet d’une évaluation du rendement. Si Cluster a besoin de plus de temps pour évaluer votre capacité à exercer les fonctions du poste et votre aptitude à l’occuper, Cluster pourra, à sa seule discrétion, prolonger la période de probation de trois (3) mois. Cluster vous avisera par écrit de son intention de prolonger la période de probation avant le dernier jour de votre période de probation initiale.'],
  ['7. Avantages sociaux.', 'Vous deviendrez admissible au régime d’assurance collective de Cluster après avoir complété trois (3) mois d’emploi continu, conformément aux modalités, conditions et exigences d’admissibilité du régime. Cluster se réserve le droit de modifier, de remplacer ou d’abolir, en tout ou en partie, les avantages associés à ce régime en tout temps, sans préavis ni indemnité de quelque nature que ce soit.'],
  ['8. Confidentialité.', 'Les « Renseignements confidentiels » désignent la Propriété intellectuelle, les clients, les secrets commerciaux, le savoir-faire et les autres renseignements exclusifs et confidentiels de Cluster, qu’ils soient de nature technique ou non, se rapportant aux activités et aux affaires actuelles, futures ou envisagées de Cluster ou de l’un de ses clients, fournisseurs, acheteurs, mandataires ou consultants, y compris, sans limitation, les politiques de sécurité, rapports, vérifications, estimations, évaluations, plans d’action, produits, logiciels et codes sources, la documentation connexe sur support papier, les listes de clients, les stratégies de marketing, les renseignements financiers et pratiques commerciales, les formulaires, lettres de sollicitation et de renouvellement, grilles tarifaires et autres correspondances adressées aux clients ou clients potentiels, anciens clients ou clients potentiels de Cluster, les renseignements financiers, y compris les déclarations de revenus, bilans et documents attestant des revenus ou des dépenses de Cluster, les salaires et autres avantages des employés ou mandataires de Cluster ou de ses actionnaires, administrateurs, dirigeants ou mandants, dont la divulgation directe ou indirecte à des concurrents de Cluster ou au grand public serait gravement préjudiciable aux meilleurs intérêts de Cluster ou à ceux des membres de son groupe et des actionnaires respectifs de chacune des personnes morales susmentionnées. Rien aux présentes n’est limité du fait que la totalité ou une partie des éléments mentionnés aux présentes aient pu être diffusés, en tout ou en partie, au public. Vous reconnaissez que la présente clause a pour objet et pour but de limiter l’utilisation des Renseignements confidentiels à des fins de nuire à Cluster et d’en tirer un avantage important.'],
  [null, 'Vous vous engagez et convenez de ne jamais, pendant la durée du présent contrat ou en tout temps par la suite, directement ou indirectement, divulguer, publier ou communiquer, ni exploiter ou utiliser à votre profit ou au profit de toute autre partie, personne ou entité, les Renseignements confidentiels dont vous avez pris connaissance pendant votre emploi chez Cluster ou en raison de celui-ci.'],
  [null, 'Vous vous engagez expressément et convenez, sur demande écrite de Cluster, de remettre toute la documentation, les listes et dossiers de clients, rapports, outils, vérifications, évaluations, codes sources, logiciels, programmes informatiques, codes objets ou spécifications de conception de tels codes sources ou logiciels élaborés par Cluster, ainsi que tous les autres Renseignements confidentiels appartenant à Cluster. Vous ne retirerez des locaux de Cluster aucun de ces éléments ni aucun original, sauf pour faire directement avancer les affaires de Cluster et dans le cadre de vos services auprès de Cluster, à moins d’une autorisation écrite expresse de Cluster. Vous convenez de ne pas transmettre par courrier électronique, à vous-même ou à un tiers, des Renseignements confidentiels, et de ne pas utiliser de disque dur externe ou d’autre support pour recueillir ou copier des Renseignements confidentiels sans le consentement écrit exprès de la Société.'],
  ['9. Propriété intellectuelle.', 'La « Propriété intellectuelle » désigne l’ensemble des inventions, découvertes, développements, méthodes, applications, procédés, procédures, compositions, œuvres, secrets commerciaux, savoir-faire, méthodes de production, dessins, concepts, idées, recettes, formules, plans, développements de produits, droits d’auteur, marques de commerce, demandes d’enregistrement de marques de commerce, brevets et demandes de brevets, dans la mesure où ils sont : (i) conçus, réalisés, créés, développés, mis en pratique ou autrement apportés par vous pendant votre emploi chez Cluster ou l’un des membres de son groupe, ou relativement à cet emploi, que ce soit avant ou après la date d’entrée en fonction, seul ou avec d’autres, pendant ou en dehors des heures normales de travail, dans les locaux de la Société ou ailleurs; ou (ii) issus de l’utilisation de Renseignements confidentiels ou de l’équipement ou des installations de la Société ou de l’un des membres de son groupe, ou qui s’appuient sur ceux-ci ou les intègrent autrement; ainsi que l’ensemble de leurs réalisations, améliorations, modifications, traductions, adaptations, perfectionnements, dérivés et combinaisons, qu’ils soient ou non brevetables, susceptibles de droits d’auteur ou autrement enregistrables;'],
  [null, 'Par les présentes, vous cédez et convenez de céder à Cluster l’intégralité de vos droits, titres et intérêts dans toute la Propriété intellectuelle, qu’elle ait été conçue, réalisée, créée, développée, mise en pratique ou autrement apportée par vous avant, au moment ou après le début de votre emploi chez Cluster. Vous convenez de signer toutes les demandes de brevets, de droits d’auteur ou d’autres droits exclusifs, au pays comme à l’étranger, et d’accomplir tout autre acte (y compris, sans limitation, la signature et la remise d’actes de cession, d’assurance, de renonciation ou de confirmation supplémentaires) demandé par Cluster afin de lui céder la Propriété intellectuelle et de lui permettre de faire valoir tout brevet, droit d’auteur ou autre droit exclusif sur la Propriété intellectuelle.'],
  [null, 'Toutes les œuvres susceptibles de droits d’auteur que vous pourriez créer ou auxquelles vous pourriez contribuer par la suite, ou que vous avez créées ou auxquelles vous avez contribué avant votre date d’entrée en fonction, et qui se rapportent à Cluster, seront considérées comme des « œuvres réalisées dans le cadre d’un emploi » et appartiendront exclusivement à Cluster dès leur création, sans autre formalité.'],
  [null, 'Par les présentes, vous renoncez irrévocablement à tous les droits moraux et autres droits incessibles que vous détenez ou pourriez détenir à l’avenir sur toute Propriété intellectuelle.'],
  ['10. Engagement de non-concurrence.', 'Vous vous engagez et convenez, pendant votre emploi et pour une période d’un an suivant la fin de votre emploi, de ne pas, au Canada (le « Territoire »), directement ou indirectement, de quelque manière que ce soit, pour votre propre compte ou pour le compte de toute autre personne ou entité, seul ou en société :'],
  ['a)', 'exercer des activités, être employé ou engagé, détenir un intérêt financier ou autre, ou participer commercialement de quelque autre façon à la sollicitation de commerçants aux fins de la prestation de services de traitement des paiements par carte de crédit (l’« Entreprise visée »), que ce soit à titre de mandant, de mandataire, d’actionnaire, d’investisseur, d’associé, de détenteur de titres de participation, de consultant, d’employé, de prêteur, de caution ou à quelque autre titre que ce soit; ou', 'item'],
  ['b)', 'fournir un soutien financier, au moyen d’un prêt, d’une garantie ou autrement, ou permettre que votre image ou votre nom, en tout ou en partie, soit utilisé par toute personne ou entité participant à une Entreprise visée,', 'item'],
  [null, 'dans chaque cas, sans le consentement écrit préalable de Cluster, lequel peut être refusé pour quelque motif que ce soit, à l’entière et absolue discrétion de Cluster.'],
  ['11. Engagement de non-sollicitation.', 'Vous vous engagez et convenez, pendant votre emploi et pour une période d’un an suivant la fin de votre emploi, de ne pas, directement ou indirectement, de quelque manière que ce soit, pour votre propre compte ou pour le compte de toute autre personne ou entité, à quelque titre que ce soit, solliciter ou inciter toute personne ayant acheté les produits ou services de Cluster, ou obtenu une licence à leur égard, à quelque moment que ce soit au cours de la période d’un an précédant la fin de votre emploi, à cesser ou à réduire le volume des affaires qu’elle fait avec Cluster, ni tenter de nuire de quelque façon que ce soit à la relation de Cluster avec elle, sans le consentement écrit préalable de Cluster, lequel peut être refusé pour quelque motif que ce soit, à l’entière et absolue discrétion de Cluster.'],
  [null, 'De plus, vous vous engagez et convenez, pendant votre emploi et pour une période d’un an suivant la fin de votre emploi, de ne pas, directement ou indirectement, de quelque manière que ce soit, pour votre propre compte ou pour le compte de toute autre personne ou entité, à quelque titre que ce soit, solliciter ou inciter tout employé ou entrepreneur employé ou engagé par Cluster, ni offrir un emploi ou un contrat de service à tout employé ou entrepreneur employé ou engagé par Cluster ou l’un des membres de son groupe, ni inciter tout employé ou entrepreneur de Cluster ou de l’un des membres de son groupe à mettre fin à son emploi ou à sa relation avec Cluster ou l’un des membres de son groupe, ni tenter autrement de nuire à la relation entre Cluster ou un tel membre de son groupe et un tel employé ou entrepreneur; dans chaque cas, sans le consentement écrit préalable de Cluster, lequel peut être refusé pour quelque motif que ce soit, à l’entière et absolue discrétion de Cluster.'],
  ['12. Non-dénigrement.', 'Vous reconnaissez et convenez que Cluster exerce ses activités dans le domaine des services et que sa réputation constitue l’un de ses actifs les plus précieux. En conséquence, vous vous engagez et convenez de ne jamais, directement ou indirectement, pendant votre emploi ou par la suite, diffuser, émettre, publier ou afficher de quelque manière que ce soit, dans quelque média que ce soit, numérique, écrit ou oral, par téléphone ou autrement, des commentaires dénigrants à l’égard de Cluster, de ses activités ou de son personnel, ni des propos qui présentent faussement ou de manière trompeuse les activités de Cluster ou ses produits ou services, que ce soit dans le but d’obtenir des ventes ou pour toute autre raison.'],
  ['13. Fin d’emploi.', 'Vous pouvez, en tout temps, mettre fin au présent contrat pour quelque motif que ce soit en donnant à Cluster un préavis écrit d’au moins quatre semaines avant la date de cette fin d’emploi. Vous ne pouvez toutefois pas prendre de vacances pendant cette période de préavis sans le consentement écrit de Cluster. Cluster se réserve le droit de renoncer à ce préavis, en tout ou en partie.'],
  [null, 'Cluster peut, en tout temps, mettre fin au présent contrat :'],
  ['a)', 'pendant la période de probation, en tout temps et à la seule discrétion de Cluster, sans préavis;', 'item'],
  ['b)', 'pour un motif sérieux, sans autre préavis;', 'item'],
  ['c)', 'sans motif sérieux, en vous remettant un préavis écrit conforme aux lois applicables. Cluster peut toutefois, à sa seule discrétion, remplacer ce préavis écrit, en tout ou en partie, par une indemnité de départ calculée selon votre salaire et équivalant à la partie non travaillée de la période de préavis; ou', 'item'],
  ['d)', 'automatiquement à votre décès.', 'item'],
  [null, 'Remise des biens :', 'sub'],
  [null, 'À la fin de l’emploi, qu’elle soit volontaire ou non, l’Employé(e) s’engage à remettre tous les biens de l’entreprise, y compris, sans s’y limiter, l’équipement, les outils, les documents, les clés, les appareils électroniques, la propriété intellectuelle et tout autre actif fourni par Cluster au cours de l’emploi.'],
  [null, 'Responsabilité à l’égard des biens non remis ou endommagés :', 'sub'],
  [null, 'Si des biens de l’entreprise ne sont pas remis ou sont remis endommagés, l’Employé(e) reconnaît et convient que Cluster peut déduire la valeur raisonnable des biens non remis ou endommagés de tout salaire dû, y compris la dernière paie, sous réserve des lois applicables.'],
  [null, 'Valeur des biens non remis ou endommagés :', 'sub'],
  [null, 'Cluster fournira une liste détaillée des biens non remis ou endommagés, accompagnée d’une estimation de leur valeur. L’Employé(e) s’engage à rembourser Cluster pour ces biens, et Cluster est autorisée à effectuer une déduction sur la dernière paie, pourvu que le montant soit raisonnable et n’excède pas la valeur des biens non remis ou endommagés.'],
  [null, 'Consentement aux déductions :', 'sub'],
  [null, 'En signant la présente offre d’emploi, l’Employé(e) reconnaît et convient que, sous réserve des modalités énoncées ci-dessus, Cluster peut déduire de la dernière paie ou de tout autre salaire dû toute somme due pour des biens non remis ou endommagés, dans la mesure permise par la loi applicable.'],
  ['14. Droit applicable et élection de for.', 'Le présent contrat est régi par les lois de la province de Québec et doit être interprété conformément à celles-ci. Les parties conviennent que toute action ou procédure judiciaire relative à toute question découlant de l’une ou l’autre des obligations prévues au présent contrat sera intentée exclusivement devant les tribunaux compétents de la province de Québec, district de Montréal.'],
  ['15. Références monétaires.', 'Toutes les mentions de « dollars » ou du symbole « $ » dans le présent contrat désignent la monnaie canadienne.'],
  ['16. Langue.', 'Le présent contrat est rédigé en français. Une version anglaise a pu vous être remise pour votre commodité; en cas de divergence, la version française prévaut. This agreement is drafted in French; an English version may have been provided for convenience.'],
];

const OFFER_INTRO_FR = [
  'Au nom de Cluster, j’ai le plaisir de vous offrir le poste de {position}. Nous sommes convaincus que vos compétences et votre dévouement seront un atout considérable pour notre entreprise, et nous avons hâte de voir l’impact que vous aurez dans ce nouveau rôle.',
  'En tant qu’employé(e) de Cluster, vous êtes personnellement responsable de l’ensemble des services, gestes, conseils et résultats que vous fournirez tout au long de votre emploi chez nous. En retour, nous nous engageons à vous offrir toutes les occasions d’apprendre et de progresser jusqu’au plus haut niveau de vos capacités et de votre potentiel.',
  'Si vous acceptez la présente offre, elle constituera votre contrat de travail avec Cluster. Veuillez noter que cette offre est conditionnelle à une vérification des antécédents satisfaisante, le cas échéant.',
];

const OFFER_CLOSING_FR = [
  'En signant la présente lettre d’offre, vous reconnaissez et acceptez de vous conformer à toutes les politiques de Cluster.',
  'Nous sommes convaincus que vous contribuerez de manière importante au succès de notre entreprise et nous avons hâte de vous accueillir au sein de notre équipe!',
  'Cordialement,',
];

const OFFER_ACK_FR = 'Par votre signature ci-dessous, vous reconnaissez avoir disposé d’un délai raisonnable pour lire et comprendre le présent contrat et avoir eu l’occasion de poser toutes vos questions, avoir vérifié l’étendue de vos droits et obligations et avoir eu la possibilité de consulter un conseiller juridique. De plus, vous acceptez et comprenez l’emploi qui vous est offert selon les modalités et conditions énoncées aux présentes, notamment celles relatives à la fin de votre emploi et aux engagements restrictifs.';

function offerSalaryExtraFr(terms, money) {
  const parts = [];
  if (terms.commissionEligible) parts.push('De plus, vous serez admissible à des commissions.');
  const car = Number(terms.carAllowance) > 0;
  const phone = Number(terms.phoneAllowance) > 0;
  if (car && phone) {
    parts.push(`Vous recevrez également une allocation automobile de ${money(terms.carAllowance)} par année, versée conformément aux pratiques de paie habituelles de la Société, ainsi qu’une allocation mensuelle de téléphone de ${money(terms.phoneAllowance)}.`);
  } else if (car) {
    parts.push(`Vous recevrez également une allocation automobile de ${money(terms.carAllowance)} par année, versée conformément aux pratiques de paie habituelles de la Société.`);
  } else if (phone) {
    parts.push(`Vous recevrez également une allocation mensuelle de téléphone de ${money(terms.phoneAllowance)}.`);
  }
  return parts.join(' ');
}

// Les deux versions de l'offre, sous une même forme, pour que pdf.js n'ait qu'un seul rendu.
const OFFER = {
  en: {
    intro: OFFER_INTRO, clauses: OFFER_CLAUSES, closing: OFFER_CLOSING, ack: OFFER_ACK, salaryExtra: offerSalaryExtra,
    title: 'Offer of Employment', subject: 'Subject: Welcome to Cluster', dear: (n) => `Dear ${n},`,
    blank: '[Remainder of this page intentionally left blank. The next page is the signature page]',
    by: 'By:', manager: 'Manager', name: 'Name', date: 'Date', footer: '  |  Offer of Employment  |  Confidential',
  },
  fr: {
    intro: OFFER_INTRO_FR, clauses: OFFER_CLAUSES_FR, closing: OFFER_CLOSING_FR, ack: OFFER_ACK_FR, salaryExtra: offerSalaryExtraFr,
    title: 'Offre d’emploi', subject: 'Objet : Bienvenue chez Cluster', dear: (n) => `Bonjour ${n},`,
    blank: '[Le reste de cette page est laissé en blanc intentionnellement. La page suivante est la page de signature]',
    by: 'Par :', manager: 'Gestionnaire', name: 'Nom', date: 'Date', footer: '  |  Offre d’emploi  |  Confidentiel',
  },
};

module.exports = { OFFER, OFFER_CLAUSES, OFFER_INTRO, OFFER_CLOSING, OFFER_ACK, offerSalaryExtra, AGREEMENT };
