// services/zohoCRMService.js
const axios = require('axios');

const CRM_BASE_URL = 'https://www.zohoapis.com/crm/v2';

// Comp plan v7.7 effective date — annual points only count from this date forward
const PLAN_START_DATE = new Date('2026-05-01');

// Monthly bonus tiers (not cumulative — highest tier wins)
const MONTHLY_BONUS_TIERS = [
  { points: 30, bonus: 1000 },
  { points: 25, bonus: 500 },
  { points: 20, bonus: 250 },
];

// Annual bonus tiers
const ANNUAL_BONUS_TIERS = [
  { points: 360, bonus: 10000 },
  { points: 300, bonus: 7500 },
  { points: 240, bonus: 5000 },
];

const MONTHLY_QUOTA = 15;

class ZohoCRMService {
  constructor(accessToken) {
    this.accessToken = accessToken;
    this.headers = {
      'Authorization': `Zoho-oauthtoken ${accessToken}`,
    };
  }

  // ============================================================
  // DEALS
  // ============================================================

  // Get all deals
  async getDeals(params = {}) {
    try {
      const response = await axios.get(`${CRM_BASE_URL}/Deals`, {
        headers: this.headers,
        params: {
          per_page: params.perPage || 200,
          page: params.page || 1,
          sort_by: params.sortBy || 'Modified_Time',
          sort_order: params.sortOrder || 'desc',
        },
      });
      return response.data;
    } catch (error) {
      console.error('CRM getDeals error:', error.response?.data || error.message);
      throw error;
    }
  }

  // Get all SOLD deals — any deal that has a Deposit_Information_Received date set,
  // regardless of current stage (deals may have moved past that stage to a final state).
  // Uses COQL (CRM Object Query Language) which supports NULL checks on date fields.
  // Falls back to Stage-based search if COQL fails.
  async getSoldDeals(params = {}) {
    // Step 1: COQL — all deals where Deposit_Information_Received custom field is set.
    // These are historical deals (including ones that moved past the stage).
    const coqlDeals = [];
    try {
      let offset = 0;
      const limit = 200;
      let hasMore = true;

      while (hasMore) {
        const query = `SELECT id, Deal_Name, Stage, Owner, Closing_Date, Deposit_Information_Received, Lead_Source_Group, Account_Name, Amount, Created_Time, Modified_Time FROM Deals WHERE Deposit_Information_Received is not null LIMIT ${limit} OFFSET ${offset}`;

        const response = await axios.post(`${CRM_BASE_URL}/coql`, { select_query: query }, {
          headers: { ...this.headers, 'Content-Type': 'application/json' },
        });

        const deals = response.data?.data || [];
        coqlDeals.push(...deals);

        hasMore = response.data?.info?.more_records === true;
        offset += limit;
      }
      console.log(`✅ COQL: fetched ${coqlDeals.length} deals with Deposit_Information_Received set`);
    } catch (coqlError) {
      const errDetail = coqlError.response?.data || coqlError.message;
      console.warn('⚠️ COQL failed (status:', coqlError.response?.status, '):', JSON.stringify(errDetail));
    }

    // Build a set of IDs already captured by COQL
    const coqlIds = new Set(coqlDeals.map(d => d.id));

    // Step 2: Stage search — deals currently IN "Deposit Information Received" stage.
    // Many of these won't have the custom date field set, so COQL misses them.
    // We use Closing_Date as their sold_date fallback.
    const stageDeals = [];
    try {
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const response = await axios.get(`${CRM_BASE_URL}/Deals/search`, {
          headers: this.headers,
          params: {
            criteria: `(Stage:equals:Deposit Information Received)`,
            per_page: 200,
            page,
            fields: 'Deal_Name,Stage,Owner,Closing_Date,Deposit_Information_Received,Lead_Source_Group,Account_Name,Amount,Created_Time,Modified_Time',
          },
        });

        const deals = response.data?.data || [];
        stageDeals.push(...deals);

        hasMore = response.data?.info?.more_records === true;
        page++;
      }
      console.log(`✅ Stage search: fetched ${stageDeals.length} active deals in stage`);
    } catch (stageError) {
      console.warn('⚠️ Stage search failed:', stageError.response?.data?.message || stageError.message);
    }

    // Step 3: COQL for recently-closed deals that moved PAST the deposit stage
    // without the custom field being set. These are invisible to both queries above.
    // We query deals where Closing_Date is within the last 6 months AND the
    // Deposit_Information_Received field is null — they'll use Closing_Date as sold_date.
    const recentDeals = [];
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const dateStr = sixMonthsAgo.toISOString().slice(0, 10); // YYYY-MM-DD
    try {
      let offset = 0;
      const limit = 200;
      let hasMore = true;
      while (hasMore) {
        const query = `SELECT id, Deal_Name, Stage, Owner, Closing_Date, Deposit_Information_Received, Lead_Source_Group, Account_Name, Amount, Created_Time, Modified_Time FROM Deals WHERE Deposit_Information_Received is null AND Closing_Date >= '${dateStr}' LIMIT ${limit} OFFSET ${offset}`;
        const response = await axios.post(`${CRM_BASE_URL}/coql`, { select_query: query }, {
          headers: { ...this.headers, 'Content-Type': 'application/json' },
        });
        const deals = response.data?.data || [];
        recentDeals.push(...deals);
        hasMore = response.data?.info?.more_records === true;
        offset += limit;
      }
      console.log(`✅ COQL recent: fetched ${recentDeals.length} deals with Closing_Date >= ${dateStr} and no deposit field`);
    } catch (recentError) {
      console.warn('⚠️ COQL recent query failed:', recentError.response?.data?.message || recentError.message);
    }

    // Merge all three sources, deduplicating by ID
    const allIds = new Set(coqlDeals.map(d => d.id));
    const newFromStage = stageDeals.filter(d => !allIds.has(d.id));
    newFromStage.forEach(d => allIds.add(d.id));
    const newFromRecent = recentDeals.filter(d => !allIds.has(d.id));

    console.log(`📊 Final merge: ${coqlDeals.length} COQL + ${newFromStage.length} stage-only + ${newFromRecent.length} recent-closed = ${coqlDeals.length + newFromStage.length + newFromRecent.length} total`);

    return { data: [...coqlDeals, ...newFromStage, ...newFromRecent] };
  }

  // Get SOLD deals filtered by a specific month and year (based on Closing_Date)
  // NOTE: The /api/crm/points endpoint no longer uses this — it queries the
  // crm_sold_deals DB table instead, which stores a stable sold_date per deal.
  async getSoldDealsByMonth(year, month) {
    const allDeals = await this.getSoldDeals();
    return (allDeals.data || []).filter(deal => {
      const closeDate = deal.Closing_Date || deal.Created_Time;
      if (!closeDate) return false;
      const d = new Date(closeDate);
      return d.getFullYear() === year && d.getMonth() + 1 === month;
    });
  }

  // Get a single deal by ID
  async getDeal(dealId) {
    try {
      const response = await axios.get(`${CRM_BASE_URL}/Deals/${dealId}`, {
        headers: this.headers,
      });
      return response.data?.data?.[0] || null;
    } catch (error) {
      console.error('CRM getDeal error:', error.response?.data || error.message);
      throw error;
    }
  }

  // Fetch all CRM users and return a {userId → name} map.
  // Used to resolve owner names when COQL returns Owner as {id} only.
  // Uses COQL (no extra scope needed) with REST API fallback.
  async getCRMUsers() {
    // Try COQL on the Users module first — no extra scope required
    try {
      const query = `SELECT id, Full_Name, Email FROM Users LIMIT 200 OFFSET 0`;
      const response = await axios.post(`${CRM_BASE_URL}/coql`, { select_query: query }, {
        headers: { ...this.headers, 'Content-Type': 'application/json' },
      });
      const users = response.data?.data || [];
      if (users.length > 0) {
        const map = {};
        users.forEach(u => { map[u.id] = u.Full_Name || u.Email || 'Unknown'; });
        console.log(`✅ Fetched ${users.length} CRM users via COQL`);
        return map;
      }
    } catch (coqlErr) {
      console.warn('⚠️ COQL Users query failed, trying REST API:', coqlErr.response?.data?.message || coqlErr.message);
    }

    // Fallback: REST API (requires ZohoCRM.users.READ scope)
    try {
      const response = await axios.get(`${CRM_BASE_URL}/users`, {
        headers: this.headers,
        params: { type: 'AllUsers', per_page: 200 },
      });
      const users = response.data?.users || [];
      const map = {};
      users.forEach(u => { map[u.id] = u.full_name || u.name || u.email || 'Unknown'; });
      console.log(`✅ Fetched ${users.length} CRM users via REST API`);
      return map;
    } catch (restErr) {
      console.warn('⚠️ REST Users API also failed:', restErr.response?.data?.message || restErr.message);
      return {};
    }
  }

  // ============================================================
  // FIELDS METADATA
  // ============================================================

  async getDealFields() {
    try {
      const response = await axios.get(`${CRM_BASE_URL}/settings/fields`, {
        headers: this.headers,
        params: { module: 'Deals' },
      });
      return response.data?.fields || [];
    } catch (error) {
      console.error('CRM getDealFields error:', error.response?.data || error.message);
      throw error;
    }
  }

  // ============================================================
  // POINTS CALCULATION (Comp Plan v7.7)
  // ============================================================

  // Calculate points for a single deal
  // Source: Lead_Source_Group field
  //   Outbound → 2pts
  //   Inbound  → 1pt
  //   Partners → 1pt
  //   +1pt for payment processing (added by Zentact integration later)
  calculatePoints(deal) {
    const sourceGroup = (
      deal.Lead_Source_Group ||
      deal.lead_source_group ||
      ''
    ).toLowerCase().trim();

    // 2pts for any outbound deal
    if (sourceGroup.includes('outbound')) return 2;

    // 1pt for inbound, partner, or anything else
    return 1;
  }

  // Calculate monthly bonus based on total points (not cumulative — highest tier wins)
  static calculateMonthlyBonus(totalPoints) {
    if (totalPoints < MONTHLY_QUOTA) return 0; // quota not met
    for (const tier of MONTHLY_BONUS_TIERS) {
      if (totalPoints >= tier.points) return tier.bonus;
    }
    return 0;
  }

  // Calculate annual bonus based on total annual points
  static calculateAnnualBonus(totalPoints) {
    for (const tier of ANNUAL_BONUS_TIERS) {
      if (totalPoints >= tier.points) return tier.bonus;
    }
    return 0;
  }

  // Transform a raw CRM deal into our app's format.
  // userMap: optional {userId → name} from getCRMUsers(), used to resolve
  // owner names when COQL returns Owner as {id} only (no name property).
  transformDeal(crmDeal, userMap = {}) {
    const points = this.calculatePoints(crmDeal);

    // Owner resolution — try every possible shape Zoho API can return:
    // 1. Object with name: {id, name}  (Stage search API)
    // 2. Object ID-only: {id}          (COQL — resolve via userMap)
    // 3. Plain string                   (unlikely but safe)
    const ownerId = typeof crmDeal.Owner === 'object' ? crmDeal.Owner?.id : null;
    const ownerName =
      (typeof crmDeal.Owner === 'object' && crmDeal.Owner?.name) ||
      (ownerId && userMap[ownerId]) ||
      (typeof crmDeal.Owner === 'string' && crmDeal.Owner) ||
      'Unassigned';

    // Account_Name can be an object {id, name} or a plain string
    const accountName =
      (typeof crmDeal.Account_Name === 'object' && crmDeal.Account_Name?.name) ||
      (typeof crmDeal.Account_Name === 'string' && crmDeal.Account_Name) ||
      '';

    return {
      crm_deal_id:       crmDeal.id,
      deal_name:         crmDeal.Deal_Name || '',
      sales_rep_name:    ownerName,
      stage:             crmDeal.Stage || '',
      lead_source_group: crmDeal.Lead_Source_Group || '',
      points,
      close_date:        crmDeal.Closing_Date || null,
      created_time:      crmDeal.Created_Time || null,
      account_name:      accountName,
      amount:            parseFloat(crmDeal.Amount) || 0,
      is_sold:           (crmDeal.Stage || '').toLowerCase().includes('deposit'),
    };
  }

  // ============================================================
  // POINTS SUMMARY — full breakdown per rep for a given month
  // ============================================================

  buildPointsSummary(deals) {
    const repMap = {};

    for (const rawDeal of deals) {
      const deal = this.transformDeal(rawDeal);
      const rep = deal.sales_rep_name;

      if (!repMap[rep]) {
        repMap[rep] = { repName: rep, totalPoints: 0, deals: [] };
      }

      repMap[rep].totalPoints += deal.points;
      repMap[rep].deals.push(deal);
    }

    return Object.values(repMap).map(rep => {
      const quotaMet = rep.totalPoints >= MONTHLY_QUOTA;
      const monthlyBonus = ZohoCRMService.calculateMonthlyBonus(rep.totalPoints);

      return {
        repName:      rep.repName,
        totalPoints:  rep.totalPoints,
        quota:        MONTHLY_QUOTA,
        quotaMet,
        pointsToQuota: Math.max(0, MONTHLY_QUOTA - rep.totalPoints),
        monthlyBonus,
        bonusTier: MONTHLY_BONUS_TIERS.find(t => rep.totalPoints >= t.points) || null,
        nextBonusTier: MONTHLY_BONUS_TIERS.slice().reverse().find(t => rep.totalPoints < t.points) || null,
        deals: rep.deals,
      };
    }).sort((a, b) => b.totalPoints - a.totalPoints);
  }
}

module.exports = { ZohoCRMService, MONTHLY_QUOTA, MONTHLY_BONUS_TIERS, ANNUAL_BONUS_TIERS, PLAN_START_DATE };
