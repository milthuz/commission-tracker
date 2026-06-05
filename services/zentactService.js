// services/zentactService.js
const axios = require('axios');

// Base URL is configurable via env var — swap to production by setting ZENTACT_API_URL
const ZENTACT_BASE_URL = process.env.ZENTACT_API_URL || 'https://api.zentact.com/api/v1';

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
    return attr?.value || null;
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
    const resellerAttr  = ZentactService.getAttribute(attrs, 'Reseller')
                       || ZentactService.getAttribute(attrs, 'reseller_name')
                       || null;

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
