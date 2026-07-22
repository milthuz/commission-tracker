// services/zentactService.js
const axios = require('axios');
const pdfParse = require('pdf-parse');

const STMT_MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

// Base URL is configurable via env var — swap to production by setting ZENTACT_API_URL
const ZENTACT_BASE_URL = process.env.ZENTACT_API_URL || 'https://api.zentact.com/api/v1';

// Zentact "Reseller" values that are actually OUR OWN divisions, not third-party
// resellers. Merchants tagged with one of these are internal-vendor activations:
// the tag is dropped at capture so the rep keeps the signup bonus/points and the
// deal never routes to Reseller → Payments. Compared lowercased/trimmed.
const INTERNAL_RESELLER_TAGS = ['xperio'];

// Merchant account statuses
const MERCHANT_STATUS = {
  INITIATED: 'INITIATED',
  INVITED: 'INVITED',
  INVITE_ACCEPTED: 'INVITE_ACCEPTED',
  APPLICATION_IN_PROGRESS: 'APPLICATION_IN_PROGRESS',
  ACTIVE: 'ACTIVE',
  REJECTED: 'REJECTED',
  CLOSED: 'CLOSED',
};

class ZentactService {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.headers = {
      'X-API-Key': apiKey,
      'Content-Type': 'application/json',
    };
  }

  // ============================================================
  // HELPER — extract a value from merchantAccountAttributes[]
  // Zentact stores custom fields as [{key: 'Salesrep_email', value: '...'}]
  // ============================================================
  static getAttribute(attributes = [], key) {
    const attr = (attributes || []).find(a => {
      // Zentact uses { name, value } — also guard against { key, value } just in case
      const attrKey = a.name ?? a.key ?? '';
      return attrKey === key || attrKey.toLowerCase() === key.toLowerCase();
    });
    // Trim — Zentact values sometimes carry stray whitespace (e.g. "Yannick "),
    // which breaks exact name/alias matching and creates duplicate reps.
    const v = attr?.value;
    return (v == null ? null : String(v).trim()) || null;
  }

  // ============================================================
  // MERCHANT ACCOUNTS
  // ============================================================

  // Fetch all merchant accounts with pagination
  async getMerchantAccounts(filterParams = {}) {
    const merchants = [];
    let pageIndex = 0;
    const pageSize = 1000; // Zentact max
    let hasMore = true;

    while (hasMore) {
      try {
        const response = await axios.get(`${ZENTACT_BASE_URL}/merchant-accounts`, {
          headers: this.headers,
          params: {
            pageSize,
            pageIndex,
            ...filterParams,
          },
        });

        const data = response.data;

        // Log the raw response shape on the first page so we can see the real structure
        if (pageIndex === 0) {
          console.log('📦 Zentact raw response shape:', JSON.stringify(
            Array.isArray(data)
              ? { isArray: true, length: data.length, sample: data[0] }
              : { keys: Object.keys(data || {}), sample: JSON.stringify(data).slice(0, 300) }
          ));
        }

        // Safely extract an array from whatever shape the API returns.
        // We only assign a value to `items` if it's actually an array.
        let items = [];
        let totalCount = 0;

        if (Array.isArray(data)) {
          // Top-level array
          items = data;
          totalCount = data.length;
          hasMore = false;
        } else if (data && typeof data === 'object') {
          // Paginated envelope — find the first key that holds an array.
          // Zentact uses: { status: 'ok', data: { pagination: {...}, rows: [...] } }
          const inner = data.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data : null;
          const arrayVal = (
            (inner && Array.isArray(inner.rows)          && inner.rows)          ||
            (inner && Array.isArray(inner.items)         && inner.items)         ||
            (inner && Array.isArray(inner.data)          && inner.data)          ||
            (Array.isArray(data.items)                   && data.items)          ||
            (Array.isArray(data.data)                    && data.data)           ||
            (Array.isArray(data.merchantAccounts)        && data.merchantAccounts) ||
            (Array.isArray(data.records)                 && data.records)        ||
            (Array.isArray(data.results)                 && data.results)        ||
            []
          );
          items = arrayVal;
          const pagination = inner?.pagination || {};
          totalCount = (
            pagination.total  || data.totalCount || data.total ||
            data.totalRecords || data.count      || items.length
          );
          // Use hasNextPage from pagination envelope if available, otherwise estimate
          if (typeof pagination.hasNextPage === 'boolean') {
            hasMore = pagination.hasNextPage;
          } else {
            const fetched = (pageIndex + 1) * pageSize;
            hasMore = items.length > 0 && items.length === pageSize && fetched < totalCount;
          }
        } else {
          // Unexpected response — stop and log
          console.warn('⚠️ Zentact: unexpected response type, stopping pagination. data =', data);
          hasMore = false;
        }

        if (items.length > 0) merchants.push(...items);
        console.log(`✅ Zentact page ${pageIndex}: ${items.length} merchants (total so far: ${merchants.length} / ${totalCount})`);
        pageIndex++;
      } catch (error) {
        const errDetail = error.response?.data || error.message;
        console.error('❌ Zentact getMerchantAccounts error (page', pageIndex, '):', JSON.stringify(errDetail));
        throw error;
      }
    }

    return merchants;
  }

  // Get only ACTIVE merchants
  async getActiveMerchants() {
    return this.getMerchantAccounts({ status: MERCHANT_STATUS.ACTIVE });
  }

  // ============================================================
  // TRANSFORM — raw Zentact merchant → our internal format
  // ============================================================
  transformMerchant(merchant) {
    const attrs = merchant.merchantAccountAttributes || merchant.customAttributes || merchant.attributes || [];

    // Zentact stores the rep as { name: 'sales_rep', value: 'FirstName' }
    // Also keep Salesrep_email as a fallback in case it's configured on some accounts
    const salesRepRaw   = ZentactService.getAttribute(attrs, 'sales_rep')
                       || ZentactService.getAttribute(attrs, 'Salesrep_email')
                       || null;
    const opportunityId = ZentactService.getAttribute(attrs, 'Opportunity_ID')
                       || ZentactService.getAttribute(attrs, 'opportunity_id')
                       || null;
    // Custom attribute "Reseller" — set in Zentact on merchants boarded by a
    // third-party reseller (e.g. "Lirette"). getAttribute is case-insensitive,
    // so 'Reseller' also matches 'reseller'. Try a couple of likely key names.
    let resellerAttr    = ZentactService.getAttribute(attrs, 'Reseller')
                       || ZentactService.getAttribute(attrs, 'reseller_name')
                       || null;
    // Internal divisions tagged as "Reseller" in Zentact are not real resellers —
    // drop the tag so the merchant counts as an internal activation.
    if (resellerAttr && INTERNAL_RESELLER_TAGS.includes(resellerAttr.trim().toLowerCase())) {
      resellerAttr = null;
    }

    return {
      merchant_account_id: merchant.merchantAccountId,
      organization_id:     merchant.organizationId  || null,
      business_name:       merchant.businessName    || '',
      invitee_email:       merchant.inviteeEmail    || null,
      status:              merchant.status          || '',
      sales_rep_raw:       salesRepRaw,   // raw value from Zentact (e.g. "Dora", "Jay")
      sales_rep_email:     null,          // not used by this org — kept for schema compat
      opportunity_id:      opportunityId,
      reseller_attribute:  resellerAttr,  // Zentact "Reseller" custom attribute, if present
      // Stores (locations) under this merchant account. Zentact nests multiple
      // physical locations in a `stores[]` array — each { storeId, storeReferenceId,
      // balanceAccountId, splitConfigurationId }. There is NO per-store name field;
      // storeReferenceId is a slug derived from the location name (e.g.
      // "Cantine_Des_Sources") and is the only human-readable identifier.
      // NOTE: revenue/profitability is reported by Zentact at the MERCHANT level
      // only (no per-store breakdown), so this is for display/transparency.
      stores:              Array.isArray(merchant.stores) ? merchant.stores : [],
      raw_attributes:      JSON.stringify(attrs),
    };
  }

  // ============================================================
  // EARLIEST TRANSACTION DATE — proxy for the activation date
  // Zentact doesn't expose an activatedAt field on merchants, so we
  // query /v2/transactions for the merchant and return the earliest createdAt.
  // ============================================================
  async getEarliestTransactionDate(merchantAccountId, lookbackYears = 5) {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setFullYear(endDate.getFullYear() - lookbackYears);

    const fmt = d => d.toISOString().split('T')[0]; // YYYY-MM-DD

    let earliest = null;
    let pageIndex = 0;
    const pageSize = 100;
    let hasMore = true;
    let pagesFetched = 0;
    const MAX_PAGES = 50; // safety cap (5000 transactions per merchant)

    while (hasMore && pagesFetched < MAX_PAGES) {
      try {
        const response = await axios.get(`${ZENTACT_BASE_URL}/transactions`, {
          headers: this.headers,
          params: {
            merchantAccountId,
            startDate: fmt(startDate),
            endDate:   fmt(endDate),
            pageSize,
            pageIndex,
          },
        });

        const data = response.data;
        const inner = data?.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data : null;
        const rows = (inner?.rows) || (Array.isArray(data?.data) ? data.data : []) || (Array.isArray(data) ? data : []);

        for (const tx of rows) {
          const created = tx.createdAt || tx.created_at;
          if (created) {
            const d = new Date(created);
            if (!isNaN(d) && (earliest === null || d < earliest)) {
              earliest = d;
            }
          }
        }

        const pagination = inner?.pagination || {};
        if (typeof pagination.hasNextPage === 'boolean') {
          hasMore = pagination.hasNextPage;
        } else {
          hasMore = rows.length === pageSize;
        }
        pageIndex++;
        pagesFetched++;
      } catch (error) {
        const status = error.response?.status;
        // 404 / no transactions → just stop
        if (status === 404) return null;
        console.warn(`⚠️ Zentact tx lookup failed for ${merchantAccountId} (page ${pageIndex}):`, error.response?.data?.message || error.message);
        break;
      }
    }

    return earliest ? earliest.toISOString().split('T')[0] : null;
  }

  // ============================================================
  // EARLIEST STATEMENT MONTH — better activation proxy than first transaction
  // Returns the first day of the merchant's earliest billing statement month.
  // ============================================================
  async getEarliestStatementDate(merchantAccountId) {
    let earliest = null; // {year, month}
    let pageIndex = 0;
    const pageSize = 100;
    let hasMore = true;
    let pagesFetched = 0;
    const MAX_PAGES = 20;

    while (hasMore && pagesFetched < MAX_PAGES) {
      try {
        const response = await axios.get(`${ZENTACT_BASE_URL}/reports/statements`, {
          headers: this.headers,
          params: { merchantAccountId, pageSize, pageIndex },
        });

        const data = response.data;
        const inner = data?.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data : null;
        const rows = (inner?.rows) || (Array.isArray(data?.data) ? data.data : []) || (Array.isArray(data) ? data : []);

        for (const stmt of rows) {
          const y = parseInt(stmt.year);
          const m = parseInt(stmt.month);
          if (!y || !m) continue;
          if (!earliest || y < earliest.year || (y === earliest.year && m < earliest.month)) {
            earliest = { year: y, month: m };
          }
        }

        const pagination = inner?.pagination || {};
        if (typeof pagination.hasNextPage === 'boolean') {
          hasMore = pagination.hasNextPage;
        } else {
          hasMore = rows.length === pageSize;
        }
        pageIndex++;
        pagesFetched++;
      } catch (error) {
        const status = error.response?.status;
        if (status === 404) return null;
        console.warn(`⚠️ Zentact statements lookup failed for ${merchantAccountId}:`, error.response?.data?.message || error.message);
        break;
      }
    }

    if (!earliest) return null;
    const mm = String(earliest.month).padStart(2, '0');
    return `${earliest.year}-${mm}-01`;
  }

  // ============================================================
  // TRANSACTION PROFITABILITY — per-merchant revenue for a date window.
  // Zentact requires type, organizationId, pspMerchantAccountName, and a
  // window of at most 31 days, with full ISO-8601 'Z' dates (no millis).
  // Returns the raw rows; monetary fields are in MINOR UNITS (cents).
  // ============================================================
  async getTransactionProfitability({ organizationId, pspMerchantAccountName, fromDate, toDate }) {
    const r = await axios.get(`${ZENTACT_BASE_URL}/reports/transaction-profitability`, {
      headers: this.headers,
      params: { type: 'merchants', organizationId, pspMerchantAccountName, fromDate, toDate },
      timeout: 30000,
    });
    const data = r.data;
    const inner = data?.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data : null;
    return (inner?.rows) || (Array.isArray(data?.data) ? data.data : []) || [];
  }

  // ============================================================
  // STATEMENT PDF — "Other Revenue" (recurring + terminal fees, PRE-TAX).
  // These figures live only in the monthly statement PDF (no JSON report).
  // ============================================================

  // Statement billing period from the PDF header (e.g. "May 01 – May 31, 2026").
  static parseStatementPeriod(text) {
    const m = text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b[^\n]*?\b(20\d{2})\b/i);
    if (!m) return null;
    return { month: STMT_MONTHS[m[1].toLowerCase()], year: parseInt(m[2], 10) };
  }

  // Sum of pre-tax fee amounts from the Recurring Fees + Terminal Fees tables.
  // Each fee row's pre-tax = Total − Tax (Tax may be "N/A" = 0). Returns cents.
  static parseStatementOtherRevenueCents(text) {
    let lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !/^\(GST/i.test(l));
    // Merge money-only lines (the Total often lands on its own line) into the previous row.
    const merged = [];
    for (const l of lines) {
      if (/^CA\$[\d,]+\.\d{2}$/.test(l) && merged.length) merged[merged.length - 1] += l;
      else merged.push(l);
    }
    const start = merged.findIndex((l) => /^Recurring Fees$/i.test(l));
    if (start < 0) return 0; // no fee section → nothing billed
    const num = (s) => (s === 'N/A' ? 0 : parseFloat(s.replace(/[^\d.]/g, '')) || 0);
    let cents = 0;
    for (let i = start; i < merged.length; i++) {
      if (!/^\d{2}\/\d{4}/.test(merged[i])) continue; // only fee data rows (billing month MM/YYYY)
      const toks = merged[i].match(/CA\$[\d,]+\.\d{2}|N\/A/g);
      if (!toks || toks.length < 2) continue;
      const total = num(toks[toks.length - 1]);
      const tax = num(toks[toks.length - 2]);
      cents += Math.round((total - tax) * 100);
    }
    return cents;
  }

  // Download a statement PDF (signed URL → bytes). monthParam is the API's month
  // index (calendar month − 1). Returns a Buffer, or null if no statement exists.
  async getStatementPdf({ merchantAccountId, monthParam, year, pspMerchantAccountName }) {
    const urlResp = await axios.get(`${ZENTACT_BASE_URL}/statements/file-download-url`, {
      headers: this.headers,
      params: { pspMerchantAccountName, merchantAccountId, month: monthParam, year },
      timeout: 15000,
      validateStatus: () => true,
    });
    const url = urlResp.data?.data?.url;
    if (!url) return null;
    const pdfResp = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000, validateStatus: () => true });
    if (pdfResp.status < 200 || pdfResp.status >= 300) return null;
    return Buffer.from(pdfResp.data);
  }

  // Fetch + parse one merchant/month statement → { month, year, otherRevenueCents } or null.
  async getStatementOtherRevenue({ merchantAccountId, calMonth, year, pspMerchantAccountName }) {
    const buf = await this.getStatementPdf({ merchantAccountId, monthParam: calMonth - 1, year, pspMerchantAccountName });
    if (!buf) return null;
    const { text } = await pdfParse(buf);
    const period = ZentactService.parseStatementPeriod(text) || { month: calMonth, year };
    return { month: period.month, year: period.year, otherRevenueCents: ZentactService.parseStatementOtherRevenueCents(text) };
  }

  // ============================================================
  // CONNECTION TEST
  // ============================================================
  async testConnection() {
    try {
      const response = await axios.get(`${ZENTACT_BASE_URL}/merchant-accounts`, {
        headers: this.headers,
        params: { pageSize: 1, pageIndex: 0 },
      });
      return { ok: true, status: response.status };
    } catch (error) {
      return {
        ok: false,
        status: error.response?.status,
        message: error.response?.data?.message || error.message,
      };
    }
  }
}

module.exports = { ZentactService, ZENTACT_BASE_URL, MERCHANT_STATUS };
