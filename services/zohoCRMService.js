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

  // Get all SOLD deals — any deal that has a Deposit_Information_Received date set.
  // We search by this custom date field (not Stage) because deals often move past
  // "Deposit Information Received" to a final closed stage, which would exclude them
  // from a Stage-based filter.
  // Fetches all pages to handle large datasets.
  async getSoldDeals(params = {}) {
    try {
      const allDeals = [];
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const response = await axios.get(`${CRM_BASE_URL}/Deals/search`, {
          headers: this.headers,
          params: {
            criteria: `(Deposit_Information_Received:greater_than:2020-01-01)`,
            per_page: 200,
            page,
            fields: 'Deal_Name,Stage,Owner,Closing_Date,Deposit_Information_Received,Lead_Source_Group,Account_Name,Amount,Created_Time,Modified_Time',
          },
        });

        const deals = response.data?.data || [];
        allDeals.push(...deals);

        hasMore = response.data?.info?.more_records === true;
        page++;
      }

      return { data: allDeals };
    } catch (error) {
      console.error('CRM getSoldDeals error:', error.response?.data || error.message);
      throw error;
    }
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

  // Transform a raw CRM deal into our app's format
  transformDeal(crmDeal) {
    const points = this.calculatePoints(crmDeal);

    return {
      crm_deal_id:      crmDeal.id,
      deal_name:        crmDeal.Deal_Name || '',
      sales_rep_name:   crmDeal.Owner?.name || 'Unassigned',
      stage:            crmDeal.Stage || '',
      lead_source_group: crmDeal.Lead_Source_Group || '',
      points,
      close_date:       crmDeal.Closing_Date || null,
      created_time:     crmDeal.Created_Time || null,
      account_name:     crmDeal.Account_Name?.name || crmDeal.Account_Name || '',
      amount:           parseFloat(crmDeal.Amount) || 0,
      is_sold:          (crmDeal.Stage || '').toLowerCase().includes('deposit'),
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
