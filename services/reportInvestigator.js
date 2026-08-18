// ============================================================================
// Report investigator — answers "why is my commission / point missing?" without
// a human having to run the same eight queries every time.
//
// Layer 1 is deterministic: a closed decision tree over invoices, zentact_merchants
// and crm_sold_deals. It returns one verdict from VERDICTS plus the evidence it used,
// so an admin can CHECK the answer instead of trusting it. The UI keys its quick replies
// on the verdict, so the resolve note starts from the answer that fits THAT case.
//
// Layer 2 only runs when layer 1 says `inconclusive`: Claude reads the evidence layer 1
// already gathered plus the rep's free text (things like "point for WF" that no query
// can resolve) and drafts a note. It is READ-ONLY — it never touches money tables, and
// its output is a suggestion for a human, never an action.
// ============================================================================

// Every verdict layer 1 can return. The UI keys its quick replies on the verdict itself
// (dataHealth.reports.verdictReplies.<verdict>), so nothing here needs to name one.
// `resolved` is the triage signal: true = we believe nothing is actually missing.
const VERDICTS = {
  // ---- shared
  not_found:             { resolved: false },
  inconclusive:          { resolved: false },
  // Estimate resolved to a customer, but nothing has followed it yet — no deal, no
  // activation, no invoice. The honest answer to "where is my point": not sold yet.
  estimate_no_sale_yet:  { resolved: false },
  // ---- points
  points_present:        { resolved: true  },
  points_arrived_since:  { resolved: true  },
  deal_wrong_rep:        { resolved: false },
  merchant_wrong_rep:    { resolved: false },
  merchant_trade_name:   { resolved: true  },
  merchant_not_active:   { resolved: false },
  per_store_unit_owed:   { resolved: false },
  // ---- commission
  commission_present:    { resolved: true  },
  reference_is_estimate: { resolved: false },
  invoice_not_found:     { resolved: false },
  invoice_wrong_rep:     { resolved: false },
  invoice_void:          { resolved: false },
  invoice_frozen:        { resolved: false },
  invoice_renewal:       { resolved: true  },
  awaiting_first_saas:   { resolved: true  },
  invoice_not_paid:      { resolved: true  },
  pre_platform_sale:     { resolved: true  },
  quota_gate:            { resolved: true  },
  rep_inactive:          { resolved: false },
};

// The per-location rule ("une succursale = une vente") only applies from this date on;
// merchants activated earlier still count as a single unit unless someone grants the rest
// by hand. Keep in sync with the recalc-side rule.
const PER_STORE_RULE_START = '2026-08-01';

const isInvoiceRef  = (r) => /^INV-/i.test(r || '');
const isEstimateRef = (r) => /^EST-/i.test(r || '');

// The `reference` field is free text and reps do not always put a reference in it — one real
// report carried "STILL MISSING" there with the actual EST-017147 buried in the message. So
// every INV-/EST- number found in the message is tried too, most specific first.
function candidateRefs(report) {
  const out = [];
  const fromMessage = String(report.message || '').match(/\b(?:INV|EST)-\d+\b/gi) || [];
  for (const m of fromMessage) if (!out.some(x => x.toLowerCase() === m.toLowerCase())) out.push(m);
  const ref = String(report.reference || '').trim();
  if (ref && !out.some(x => x.toLowerCase() === ref.toLowerCase())) out.push(ref);
  return out;
}

// A verdict worth stopping on — anything else means "keep trying the other candidates".
const isConclusive = (v) => v !== 'not_found' && v !== 'inconclusive';

// ILIKE pattern that tolerates the punctuation drift between what a rep types and what
// Zoho/Zentact store ("Familia Ti-Will" vs "La Familia à Ti-Will").
function loosePattern(name) {
  const core = String(name || '').trim().replace(/[%_]/g, '').replace(/\s+/g, ' ');
  if (core.length < 3) return null;
  return `%${core}%`;
}

// The most distinctive word in a name — used as a fallback when the full string finds
// nothing, since reps rarely type the legal name in full.
function longestToken(name) {
  const tokens = String(name || '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(t => t.length >= 4 && !/^(the|les|des|and|pour|inc|ltd|resto|cafe|café)$/i.test(t));
  if (!tokens.length) return null;
  return `%${tokens.sort((a, b) => b.length - a.length)[0]}%`;
}

async function findMerchant(pool, ref) {
  const patterns = [loosePattern(ref), longestToken(ref)].filter(Boolean);
  for (const p of patterns) {
    const { rows } = await pool.query(
      `SELECT merchant_account_id, business_name, status, sales_rep_name, invitee_email,
              activated_at::date AS activated_at, points, bonus_amount::float AS bonus_amount,
              (SELECT COUNT(DISTINCT s->>'balanceAccountId')
                 FROM jsonb_array_elements(COALESCE(stores,'[]'::jsonb)) s)::int AS balance_accounts,
              (SELECT string_agg(DISTINCT s->>'storeReferenceId', ', ')
                 FROM jsonb_array_elements(COALESCE(stores,'[]'::jsonb)) s) AS store_names
         FROM zentact_merchants
        WHERE business_name ILIKE $1
           OR invitee_email ILIKE $1
           OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(stores,'[]'::jsonb)) s
                       WHERE REPLACE(s->>'storeReferenceId', '_', ' ') ILIKE $1)
        ORDER BY (status = 'ACTIVE') DESC, activated_at DESC NULLS LAST
        LIMIT 1`,
      [p]
    );
    if (rows[0]) return { ...rows[0], matched_on: p };
  }
  return null;
}

async function findDeal(pool, ref) {
  const patterns = [loosePattern(ref), longestToken(ref)].filter(Boolean);
  for (const p of patterns) {
    const { rows } = await pool.query(
      `SELECT deal_id, deal_name, account_name, owner_name, points,
              sold_date::date AS sold_date, amount::float AS amount
         FROM crm_sold_deals
        WHERE deal_name ILIKE $1 OR account_name ILIKE $1
        ORDER BY sold_date DESC NULLS LAST LIMIT 1`,
      [p]
    );
    if (rows[0]) return { ...rows[0], matched_on: p };
  }
  return null;
}

const sameRep = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

// ---------------------------------------------------------------------------
// Layer 1 — points
// ---------------------------------------------------------------------------
async function investigatePoints(pool, report, rep, ref) {
  if (!ref) return { verdict: 'inconclusive', evidence: { why: 'no reference on the report' } };
  // Points come from sold deals and Zentact activations — an estimate means the sale has not
  // closed yet, which is an answer in itself rather than a dead end.
  if (isEstimateRef(ref)) {
    return { verdict: 'reference_is_estimate', evidence: { reference: ref, note: 'an estimate is not a sale yet; points follow the deal or the Zentact activation' } };
  }

  const deal = await findDeal(pool, ref);
  if (deal) {
    const ev = { deal_name: deal.deal_name, owner: deal.owner_name, points: deal.points, sold_date: deal.sold_date };
    if (!sameRep(deal.owner_name, rep)) return { verdict: 'deal_wrong_rep', evidence: ev };
    // Landed after the report was filed → the rep flagged it before the deposit reached Zoho.
    if (deal.sold_date && report.created_at && new Date(deal.sold_date) >= new Date(new Date(report.created_at).toDateString())) {
      return { verdict: 'points_arrived_since', evidence: ev };
    }
    if (deal.points > 0) return { verdict: 'points_present', evidence: ev };
  }

  const m = await findMerchant(pool, ref);
  if (m) {
    const ev = {
      merchant_account_id: m.merchant_account_id, business_name: m.business_name,
      status: m.status, rep_on_record: m.sales_rep_name, activated_at: m.activated_at,
      balance_accounts: m.balance_accounts, stores: m.store_names, points: m.points,
    };
    if (!sameRep(m.sales_rep_name, rep)) return { verdict: 'merchant_wrong_rep', evidence: ev };
    if (m.status !== 'ACTIVE') return { verdict: 'merchant_not_active', evidence: ev };

    // Extra balance accounts on a merchant activated before the cutoff: units the
    // per-location rule would grant today but did not back then.
    if (m.balance_accounts > 1 && m.activated_at && String(m.activated_at) < PER_STORE_RULE_START) {
      const granted = (await pool.query(
        `SELECT COUNT(*)::int AS c FROM zentact_merchants
          WHERE is_manual = true AND sales_rep_name = $1
            AND activated_at >= $2::date - INTERVAL '60 days'`,
        [rep, m.activated_at]
      )).rows[0].c;
      return {
        verdict: 'per_store_unit_owed',
        evidence: { ...ev, extra_units: m.balance_accounts - 1, manual_units_already_granted: granted },
      };
    }
    // Found, but under a name the rep would not have searched for.
    if (loosePattern(ref) && !new RegExp(String(ref).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(m.business_name || '')) {
      return { verdict: 'merchant_trade_name', evidence: ev };
    }
    return { verdict: 'points_present', evidence: ev };
  }

  return { verdict: 'not_found', evidence: { searched: ref } };
}

// ---------------------------------------------------------------------------
// Layer 1 — commission
// ---------------------------------------------------------------------------
async function investigateCommission(pool, report, rep, orgId, ref) {
  if (!ref) return { verdict: 'inconclusive', evidence: { why: 'no reference on the report' } };
  if (isEstimateRef(ref)) {
    return { verdict: 'reference_is_estimate', evidence: { reference: ref, note: 'estimates are not invoices; the tracker holds no estimates' } };
  }

  const where = isInvoiceRef(ref) ? 'invoice_number ILIKE $1' : 'customer_name ILIKE $1';
  const pattern = isInvoiceRef(ref) ? `%${String(ref).trim()}%` : (loosePattern(ref) || `%${ref}%`);
  const { rows } = await pool.query(
    `SELECT invoice_number, customer_name, salesperson_name, status, date::date AS date,
            total::float AS total, commission::float AS commission, commission_status,
            commission_payable_date::date AS payable_date, approval_status, commission_paid,
            hardware_amount::float AS hardware_amount, saas_amount::float AS saas_amount,
            quota_forfeited_amount::float AS quota_forfeited_amount
       FROM invoices
      WHERE ${where} AND organization_id = $2
      ORDER BY date DESC LIMIT 25`,
    [pattern, orgId]
  );
  if (!rows.length) return { verdict: 'invoice_not_found', evidence: { searched: ref } };

  // Prefer the rep's own invoices; if none are theirs, that IS the finding.
  const mine = rows.filter(r => sameRep(r.salesperson_name, rep));
  if (!mine.length) {
    const r = rows[0];
    return {
      verdict: 'invoice_wrong_rep',
      evidence: { invoice: r.invoice_number, customer: r.customer_name, rep_on_record: r.salesperson_name, date: r.date },
    };
  }

  if (mine.some(r => r.commission > 0)) {
    const r = mine.find(x => x.commission > 0);
    return {
      verdict: 'commission_present',
      evidence: { invoice: r.invoice_number, commission: r.commission, payable_date: r.payable_date, commission_status: r.commission_status },
    };
  }

  // All at zero — say WHY, using the most relevant invoice (largest, then newest).
  const r = mine.sort((a, b) => (b.total || 0) - (a.total || 0))[0];
  const ev = {
    invoice: r.invoice_number, customer: r.customer_name, date: r.date, status: r.status,
    commission_status: r.commission_status, approval_status: r.approval_status,
    hardware_amount: r.hardware_amount, saas_amount: r.saas_amount, invoices_examined: mine.length,
  };

  if (r.status === 'void' || r.status === 'deleted')          return { verdict: 'invoice_void', evidence: ev };
  if (r.approval_status === 'paid' && r.commission === 0)     return { verdict: 'invoice_frozen', evidence: ev };
  if (r.quota_forfeited_amount > 0)                           return { verdict: 'quota_gate', evidence: { ...ev, forfeited: r.quota_forfeited_amount } };
  if (r.commission_status === 'rep_inactive')                 return { verdict: 'rep_inactive', evidence: ev };
  if (r.commission_status === 'saas_renewal')                 return { verdict: 'invoice_renewal', evidence: ev };
  if (r.commission_status === 'pending_saas')                 return { verdict: 'awaiting_first_saas', evidence: ev };
  if (r.commission_status === 'pending_payment' || r.status !== 'paid') return { verdict: 'invoice_not_paid', evidence: ev };
  if (r.commission_status === 'too_late')                     return { verdict: 'pre_platform_sale', evidence: ev };

  return { verdict: 'inconclusive', evidence: ev };
}

// ---------------------------------------------------------------------------
// Layer 2 — Claude, only for what layer 1 could not settle. Read-only.
// ---------------------------------------------------------------------------
async function askClaude(anthropic, report, rep, layer1) {
  const prompt = [
    `Un représentant de Sales Hub signale un problème. Le diagnostic automatique n'a pas conclu.`,
    ``,
    `Représentant : ${rep}`,
    `Type : ${report.report_type}`,
    `Référence fournie : ${report.reference || '(aucune)'}`,
    `Période : ${report.period || '(aucune)'}`,
    `Son message : ${report.message}`,
    ``,
    `Ce que le diagnostic a trouvé : ${JSON.stringify(layer1.evidence)}`,
    ``,
    `En 3 phrases maximum, en français : dis à l'administrateur ce qui est le plus probable`,
    `et OÙ vérifier exactement (quelle page, quelle donnée). N'invente aucun chiffre ni aucun`,
    `nom qui ne figure pas ci-dessus. Si le message du rep contient une abréviation que tu ne`,
    `peux pas résoudre, dis-le franchement au lieu de deviner.`,
  ].join('\n');

  const msg = await anthropic.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  });
  return (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

/**
 * Investigate one user report. Never writes to business tables — it only reads.
 * @returns {{verdict:string, evidence:object, aiNote:string|null, likelyResolved:boolean}}
 */
async function investigateReport(pool, report, opts = {}) {
  const rep = report.reporter_name || report.reporter_email || '';
  const orgId = opts.orgId || process.env.ZOHO_ORG_ID;

  // Try each candidate reference and keep the first conclusive answer; if none conclude,
  // report the first attempt so the evidence shows what was actually searched.
  let result = null;
  try {
    const refs = candidateRefs(report);
    if (!refs.length) {
      result = { verdict: 'inconclusive', evidence: { why: 'no reference on the report and none found in the message' } };
    }
    const runPath = (ref) => report.report_type === 'missing_points'
      ? investigatePoints(pool, report, rep, ref)
      : investigateCommission(pool, report, rep, orgId, ref);

    for (const ref of refs) {
      let attempt = await runPath(ref);

      // An estimate is a starting point, not a dead end. We keep no estimates locally, so
      // resolve the number against Zoho Books, take the customer off it, and run the same
      // tree again on that name — the deal or the activation is filed under the customer,
      // never under the estimate number the rep quotes.
      if (attempt.verdict === 'reference_is_estimate' && opts.lookupEstimate) {
        const est = await opts.lookupEstimate(ref);
        if (est && est.customerName) {
          const chained = await runPath(est.customerName);
          const evidence = {
            ...chained.evidence,
            via_estimate: est.number,
            estimate_customer: est.customerName,
            estimate_status: est.status,
            estimate_date: est.date,
          };
          attempt = isConclusive(chained.verdict)
            ? { verdict: chained.verdict, evidence }
            : { verdict: 'estimate_no_sale_yet', evidence };
        }
      }

      if (!result) result = attempt;
      if (isConclusive(attempt.verdict)) { result = attempt; break; }
    }
  } catch (e) {
    result = { verdict: 'inconclusive', evidence: { error: e.message } };
  }

  const meta = VERDICTS[result.verdict] || VERDICTS.inconclusive;
  let aiNote = null;
  // Layer 2 fires only where layer 1 gave up, so a normal report costs nothing.
  if ((result.verdict === 'inconclusive' || result.verdict === 'not_found') && opts.anthropic) {
    try { aiNote = await askClaude(opts.anthropic, report, rep, result); }
    catch (e) { aiNote = null; }
  }

  return {
    verdict: result.verdict,
    evidence: result.evidence || {},
    aiNote,
    likelyResolved: meta.resolved,
  };
}

module.exports = { investigateReport, VERDICTS, PER_STORE_RULE_START };
