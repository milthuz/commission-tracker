const axios = require('axios');

class ZohoService {
  constructor(pool) {
    this.pool = pool;
    this.tokenCache = new Map();
    this.salespersonCache = new Map(); // Cache salesperson lookups
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
   * Fetch all salespeople and cache them
   */
  async fetchAllSalespeople(email, apiDomain, accessToken) {
    try {
      console.log(`📋 [ZOHO] Fetching all salespersons...`);
      
      const response = await axios.get(
        `${apiDomain}/books/v3/salespersons`,
        {
          params: {
            organization_id: process.env.ZOHO_ORG_ID,
            limit: 200,
          },
          headers: {
            'Authorization': `Zoho-oauthtoken ${accessToken}`,
          },
          timeout: 15000,
        }
      );

      const salespersons = response.data.salespersons || [];
      console.log(`✅ [ZOHO] Fetched ${salespersons.length} salespersons`);

      // Cache all salespersons by ID
      for (const sp of salespersons) {
        const id = sp.salesperson_id;
        const name = sp.salesperson_name || 'Unknown';
        this.salespersonCache.set(id, name);
        console.log(`  ✓ ${id} = ${name}`);
      }

      return salespersons;
    } catch (error) {
      console.error(`⚠️ [ZOHO] Could not fetch salespersons:`, error.message);
      if (error.response?.status === 404) {
        console.error(`⚠️ [ZOHO] Endpoint /salespersons returned 404 - may not be available in your Zoho Books plan`);
      }
      return [];
    }
  }

  /**
   * Get salesperson name by ID (from contacts endpoint)
   */
  async getSalespersonName(salespersonId, apiDomain, accessToken) {
    if (!salespersonId) {
      return null;
    }

    // Check cache first
    if (this.salespersonCache.has(salespersonId)) {
      return this.salespersonCache.get(salespersonId);
    }

    try {
      // Try to get from contacts endpoint
      const response = await axios.get(
        `${apiDomain}/books/v3/contacts/${salespersonId}`,
        {
          params: {
            organization_id: process.env.ZOHO_ORG_ID,
          },
          headers: {
            'Authorization': `Zoho-oauthtoken ${accessToken}`,
          },
          timeout: 10000,
        }
      );

      const contact = response.data.contact;
      const name = contact.contact_name || contact.company_name || contact.salesperson_name || 'Unknown';
      
      // Cache it
      this.salespersonCache.set(salespersonId, name);
      console.log(`  ✓ Fetched contact ${salespersonId} = ${name}`);
      
      return name;
    } catch (error) {
      console.error(`  ⚠️ Could not fetch contact ${salespersonId}:`, error.message);
      return null;
    }
  }

  /**
   * Sync all invoices (paid + overdue)
   */
  async syncAllInvoices(email) {
    try {
      console.log(`🔄 [ZOHO] Starting invoice sync for ${email}`);

      const tokenData = await this.getValidToken(email);
      
      // Fetch all salespeople first and cache them
      await this.fetchAllSalespeople(email, tokenData.api_domain, tokenData.access_token);
      
      const paidInvoices = await this.fetchInvoices(email, 'paid');
      const overdueInvoices = await this.fetchInvoices(email, 'overdue');

      const allInvoices = [
        ...paidInvoices.map(inv => ({ ...inv, status: 'paid' })),
        ...overdueInvoices.map(inv => ({ ...inv, status: 'overdue' })),
      ];

      console.log(`📥 [ZOHO] Total invoices to sync: ${allInvoices.length}`);

      // Debug: Log all fields that might have salesperson info
      if (allInvoices.length > 0) {
        const inv = allInvoices[0];
        console.log(`\n🔍 [ZOHO] Checking all fields in first invoice for salesperson info:`);
        for (const [key, value] of Object.entries(inv)) {
          if (key.toLowerCase().includes('sales') || key.toLowerCase().includes('person') || 
              key.toLowerCase().includes('rep') || key.toLowerCase().includes('employee') ||
              key.toLowerCase().includes('user') || key.toLowerCase().includes('created')) {
            console.log(`  ${key}: ${JSON.stringify(value)}`);
          }
        }
        console.log('');
      }

      // Count invoices with salesperson_id
      const withSalesId = allInvoices.filter(inv => inv.salesperson_id && inv.salesperson_id.trim()).length;
      const withoutSalesId = allInvoices.length - withSalesId;
      
      console.log(`📊 [ZOHO] Invoices WITH salesperson_id: ${withSalesId}`);
      console.log(`📊 [ZOHO] Invoices WITHOUT salesperson_id: ${withoutSalesId}`);

      // Fetch salesperson details for invoices that have IDs
      console.log(`📋 [ZOHO] Fetching salesperson details...`);
      for (let inv of allInvoices) {
        if (inv.salesperson_id && inv.salesperson_id.trim()) {
          const name = await this.getSalespersonName(inv.salesperson_id, tokenData.api_domain, tokenData.access_token);
          if (name) {
            inv.salesperson_name = name;
          }
        }
      }

      if (allInvoices.length > 0) {
        console.log(`📄 [ZOHO] Sample invoice:`, JSON.stringify({
          invoice_number: allInvoices[0].invoice_number,
          salesperson_id: allInvoices[0].salesperson_id,
          salesperson_name: allInvoices[0].salesperson_name,
          total: allInvoices[0].total,
          status: allInvoices[0].status,
        }, null, 2));
      }

      return allInvoices;
    } catch (error) {
      console.error(`❌ [ZOHO] Sync failed:`, error.message);
      throw error;
    }
  }
}

module.exports = ZohoService;
