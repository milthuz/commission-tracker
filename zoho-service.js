const axios = require('axios');

class ZohoService {
  constructor(pool) {
    this.pool = pool;
    this.tokenCache = new Map();
  }

  /**
   * Get valid token - refresh if needed
   */
  async getValidToken(email) {
    try {
      const tokenResult = await this.pool.query(
        'SELECT access_token, refresh_token, api_domain, expires_at FROM user_tokens WHERE email = $1',
        [email]
      );

      if (!tokenResult.rows.length) {
        throw new Error(`No token found for ${email}`);
      }

      let tokenData = tokenResult.rows[0];
      const expiresAtMs = parseInt(tokenData.expires_at) || 0;
      const now = Date.now();

      // Refresh if expired or expiring soon (within 5 minutes)
      if (expiresAtMs - now < 5 * 60 * 1000) {
        if (!tokenData.refresh_token) {
          throw new Error(`Token expired for ${email} - no refresh token available`);
        }

        console.log(`🔄 [ZOHO] Refreshing token for ${email}`);
        tokenData = await this.refreshToken(email, tokenData.refresh_token, tokenData.api_domain);
      }

      return tokenData;
    } catch (error) {
      console.error(`❌ [ZOHO] Error getting valid token:`, error.message);
      throw error;
    }
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshToken(email, refreshToken, apiDomain) {
    try {
      const response = await axios.post(
        'https://accounts.zoho.com/oauth/v2/token',
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: process.env.ZOHO_CLIENT_ID,
          client_secret: process.env.ZOHO_CLIENT_SECRET,
          refresh_token: refreshToken,
        }),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 10000,
        }
      );

      const newAccessToken = response.data.access_token;
      const newExpiresIn = parseInt(response.data.expires_in) || 3600;
      const newExpiresAt = Date.now() + (newExpiresIn * 1000);

      // Update database
      await this.pool.query(
        `UPDATE user_tokens 
         SET access_token = $1, expires_at = $2, updated_at = CURRENT_TIMESTAMP 
         WHERE email = $3`,
        [newAccessToken, newExpiresAt, email]
      );

      console.log(`✅ [ZOHO] Token refreshed for ${email}`);

      return {
        access_token: newAccessToken,
        refresh_token: refreshToken,
        api_domain: apiDomain,
        expires_at: newExpiresAt,
      };
    } catch (error) {
      console.error(`❌ [ZOHO] Token refresh failed:`, error.message);
      throw error;
    }
  }

  /**
   * Fetch invoices with retry logic
   */
  async fetchInvoices(email, status, maxRetries = 3) {
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const tokenData = await this.getValidToken(email);

        console.log(`📤 [ZOHO] Fetching ${status} invoices (attempt ${attempt}/${maxRetries})`);

        const response = await axios.get(
          `${tokenData.api_domain}/books/v3/invoices`,
          {
            params: {
              organization_id: process.env.ZOHO_ORG_ID,
              status: status,
              limit: 200,
              sort_column: 'date',
            },
            headers: {
              'Authorization': `Zoho-oauthtoken ${tokenData.access_token}`,
              'User-Agent': 'Commission-Tracker/1.0',
            },
            timeout: 15000,
          }
        );

        const invoices = response.data.invoices || [];
        console.log(`✅ [ZOHO] Fetched ${invoices.length} ${status} invoices`);

        return invoices;
      } catch (error) {
        lastError = error;
        console.error(`❌ [ZOHO] Attempt ${attempt} failed:`, error.message);

        if (attempt < maxRetries) {
          const waitMs = Math.pow(2, attempt) * 1000; // Exponential backoff
          console.log(`⏳ [ZOHO] Retrying in ${waitMs}ms...`);
          await new Promise(resolve => setTimeout(resolve, waitMs));
        }
      }
    }

    throw lastError;
  }

  /**
   * Sync all invoices (paid + overdue)
   */
  async syncAllInvoices(email) {
    try {
      console.log(`🔄 [ZOHO] Starting invoice sync for ${email}`);

      const paidInvoices = await this.fetchInvoices(email, 'paid');
      const overdueInvoices = await this.fetchInvoices(email, 'overdue');

      const allInvoices = [
        ...paidInvoices.map(inv => ({ ...inv, status: 'paid' })),
        ...overdueInvoices.map(inv => ({ ...inv, status: 'overdue' })),
      ];

      console.log(`📥 [ZOHO] Total invoices to sync: ${allInvoices.length}`);

      if (allInvoices.length > 0) {
        console.log(`📄 [ZOHO] Sample invoice:`, JSON.stringify(allInvoices[0], null, 2));
      }

      return allInvoices;
    } catch (error) {
      console.error(`❌ [ZOHO] Sync failed:`, error.message);
      throw error;
    }
  }
}

module.exports = ZohoService;
