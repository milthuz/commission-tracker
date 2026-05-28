// services/zohoBillingService.js
// Zoho Billing (formerly Zoho Subscriptions) API client.
// We use this to fetch plan_codes so we can classify Books invoice line items
// as SaaS (matches a known plan_code) vs Hardware (everything else).

const axios = require('axios');

// Zoho Billing API base — same regional pattern as Books/CRM:
//   .com  → US
//   .ca   → Canada
//   .eu   → EU
//   .com.au → Australia
// We pass api_domain dynamically from the stored user_tokens.
function billingBaseUrl(apiDomain) {
  // apiDomain is like 'https://www.zohoapis.com'. Billing endpoint:
  return `${apiDomain.replace(/\/$/, '')}/billing/v1`;
}

class ZohoBillingService {
  constructor(accessToken, apiDomain, orgId) {
    this.accessToken = accessToken;
    this.apiDomain   = apiDomain || 'https://www.zohoapis.com';
    this.orgId       = orgId;
    this.headers = {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      'Content-Type': 'application/json',
      // Required by Zoho Billing — without this header we get 401
      'X-com-zoho-subscriptions-organizationid': orgId,
    };
  }

  // List all plans. Paginated; we collect them all.
  async getPlans(filters = {}) {
    const base = billingBaseUrl(this.apiDomain);
    const all = [];
    let page = 1;
    const per_page = 200;
    let hasMore = true;

    while (hasMore) {
      const params = {
        per_page,
        page,
        organization_id: this.orgId,
        ...filters,
      };
      try {
        const res = await axios.get(`${base}/plans`, {
          headers: this.headers,
          params,
          validateStatus: () => true,
        });
        if (res.status !== 200) {
          console.warn(`⚠️ Zoho Billing getPlans page ${page} returned ${res.status}:`,
            JSON.stringify(res.data).slice(0, 300));
          return { ok: false, status: res.status, error: res.data, plans: all };
        }
        const plans = res.data?.plans || [];
        all.push(...plans);
        hasMore = res.data?.page_context?.has_more_page === true && plans.length > 0;
        page++;
      } catch (err) {
        console.error('❌ Zoho Billing getPlans error:', err.response?.data || err.message);
        return { ok: false, error: err.message, plans: all };
      }
    }
    return { ok: true, plans: all };
  }

  // Connection test — fetches just one plan to verify scope/credentials work
  async testConnection() {
    const base = billingBaseUrl(this.apiDomain);
    try {
      const res = await axios.get(`${base}/plans`, {
        headers: this.headers,
        params: { per_page: 1, organization_id: this.orgId },
        validateStatus: () => true,
      });
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        body: res.data,
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // Static helper — find a plan_code in a list of plans (case-insensitive)
  static matchPlan(plans, sku) {
    if (!sku) return null;
    const key = String(sku).trim().toLowerCase();
    return plans.find(p => (p.plan_code || '').trim().toLowerCase() === key) || null;
  }
}

module.exports = { ZohoBillingService };
