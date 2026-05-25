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
    const attrs = merchant.merchantAccountAttributes || merchant.customAttributes || [];

    const salesRepEmail = ZentactService.getAttribute(attrs, 'Salesrep_email');
    const opportunityId = ZentactService.getAttribute(attrs, 'Opportunity_ID');

    return {
      merchant_account_id: merchant.merchantAccountId,
      organization_id:     merchant.organizationId  || null,
      business_name:       merchant.businessName    || '',
      invitee_email:       merchant.inviteeEmail    || null,
      status:              merchant.status          || '',
      sales_rep_email:     salesRepEmail,
      opportunity_id:      opportunityId,
      raw_attributes:      JSON.stringify(attrs),
    };
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
