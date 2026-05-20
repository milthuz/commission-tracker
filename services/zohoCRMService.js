// services/zohoCRMService.js
const axios = require('axios');

const CRM_BASE_URL = 'https://www.zohoapis.com/crm/v2';

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

  // Get all deals (optionally filter by stage)
  async getDeals(params = {}) {
    try {
      const response = await axios.get(`${CRM_BASE_URL}/Deals`, {
        headers: this.headers,
        params: {
          per_page: params.perPage || 200,
          page: params.page || 1,
          sort_by: params.sortBy || 'Modified_Time',
          sort_order: params.sortOrder || 'desc',
          ...params,
        },
      });

      return response.data;
    } catch (error) {
      console.error('CRM getDeals error:', error.response?.data || error.message);
      throw error;
    }
  }

  // Get deals with "Deposit Information Received" stage (SOLD deals)
  async getSoldDeals(params = {}) {
    try {
      // Use search criteria to filter by stage
      const response = await axios.get(`${CRM_BASE_URL}/Deals/search`, {
        headers: this.headers,
        params: {
          criteria: `(Stage:equals:Deposit Information Received)`,
          per_page: params.perPage || 200,
          page: params.page || 1,
        },
      });

      return response.data;
    } catch (error) {
      console.error('CRM getSoldDeals error:', error.response?.data || error.message);
      throw error;
    }
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

  // Get all field definitions for the Deals module
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
  // TRANSFORM
  // ============================================================

  // Calculate points for a deal based on comp plan rules
  calculatePoints(deal) {
    const dealType = (deal.Deal_Type || deal.deal_type || '').toLowerCase();
    const hasPaymentProcessing =
      deal.Payment_Processing_Attachment === true ||
      deal.Payment_Processing_Attachment === 'true' ||
      deal.hasPaymentProcessing === true;

    let points = 0;

    if (dealType.includes('outbound')) {
      points = 2;
    } else if (dealType.includes('inbound')) {
      points = 1;
    } else {
      points = 1; // default to inbound if unknown
    }

    if (hasPaymentProcessing) {
      points += 1;
    }

    return points;
  }

  // Transform a raw CRM deal into our app's format
  transformDeal(crmDeal) {
    const points = this.calculatePoints(crmDeal);

    return {
      crm_deal_id: crmDeal.id,
      deal_name: crmDeal.Deal_Name || '',
      sales_rep_name: crmDeal.Owner?.name || crmDeal.owner_name || 'Unassigned',
      stage: crmDeal.Stage || '',
      deal_type: crmDeal.Deal_Type || 'inbound',
      has_payment_processing:
        crmDeal.Payment_Processing_Attachment === true ||
        crmDeal.Payment_Processing_Attachment === 'true',
      points,
      close_date: crmDeal.Closing_Date || crmDeal.Modified_Time || null,
      created_time: crmDeal.Created_Time || null,
      modified_time: crmDeal.Modified_Time || null,
      account_name: crmDeal.Account_Name?.name || crmDeal.Account_Name || '',
      amount: parseFloat(crmDeal.Amount) || 0,
      is_sold: (crmDeal.Stage || '').toLowerCase().includes('deposit'),
    };
  }
}

module.exports = ZohoCRMService;
