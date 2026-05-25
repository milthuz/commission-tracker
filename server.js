// ============================================================================
// BACKEND API - Express.js Server with PostgreSQL
// File: server.js
// ============================================================================
// Install: npm install express dotenv axios cors body-parser jsonwebtoken pg
// Run: node server.js

const express = require('express');
const dotenv = require('dotenv');
const axios = require('axios');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const { ZohoCRMService, MONTHLY_QUOTA, MONTHLY_BONUS_TIERS, ANNUAL_BONUS_TIERS, PLAN_START_DATE } = require('./services/zohoCRMService');
const { ZentactService } = require('./services/zentactService');

dotenv.config();

const app = express();

// ============================================================================
// DATABASE CONNECTION
// ============================================================================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Initialize database tables
async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_tokens (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        api_domain VARCHAR(255),
        expires_at BIGINT,
        crm_access_token TEXT,
        crm_refresh_token TEXT,
        crm_expires_at BIGINT,
        is_admin BOOLEAN DEFAULT false,
        photo TEXT,
        display_name VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Add columns if they don't exist (for existing tables)
    await pool.query(`ALTER TABLE user_tokens ADD COLUMN IF NOT EXISTS crm_access_token TEXT`);
    await pool.query(`ALTER TABLE user_tokens ADD COLUMN IF NOT EXISTS crm_refresh_token TEXT`);
    await pool.query(`ALTER TABLE user_tokens ADD COLUMN IF NOT EXISTS crm_expires_at BIGINT`);
    await pool.query(`ALTER TABLE user_tokens ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false`);
    await pool.query(`ALTER TABLE user_tokens ADD COLUMN IF NOT EXISTS photo TEXT`);
    await pool.query(`ALTER TABLE user_tokens ADD COLUMN IF NOT EXISTS display_name VARCHAR(255)`);

    // Invoices table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS invoices (
        id SERIAL PRIMARY KEY,
        invoice_number VARCHAR(255) UNIQUE NOT NULL,
        salesperson_name VARCHAR(255),
        customer_name VARCHAR(255),
        total DECIMAL(12,2) DEFAULT 0,
        status VARCHAR(50) DEFAULT 'paid',
        date TIMESTAMP,
        commission DECIMAL(12,2) DEFAULT 0,
        commission_paid BOOLEAN DEFAULT false,
        organization_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_name VARCHAR(255)`);
    await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS commission_paid BOOLEAN DEFAULT false`);

    // User preferences table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_preferences (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        language VARCHAR(10) DEFAULT 'en',
        currency VARCHAR(10) DEFAULT 'CAD',
        date_format VARCHAR(20) DEFAULT 'YYYY-MM-DD',
        timezone VARCHAR(50) DEFAULT 'America/Toronto',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Salespeople table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS salespeople (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        is_active BOOLEAN DEFAULT true,
        commission_rate DECIMAL(5,2) DEFAULT 10.0,
        base_salary DECIMAL(10,2) DEFAULT 0,
        invoice_count INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`ALTER TABLE salespeople ADD COLUMN IF NOT EXISTS invoice_count INT DEFAULT 0`);

    // Excluded customers table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS excluded_customers (
        id SERIAL PRIMARY KEY,
        customer_name VARCHAR(255) NOT NULL,
        excluded_by VARCHAR(255),
        organization_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(customer_name, organization_id)
      );
    `);
    await pool.query(`ALTER TABLE excluded_customers ADD COLUMN IF NOT EXISTS organization_id VARCHAR(255)`);
    await pool.query(`ALTER TABLE excluded_customers ADD COLUMN IF NOT EXISTS excluded_by VARCHAR(255)`);

    // Releases table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS releases (
        id SERIAL PRIMARY KEY,
        version VARCHAR(50) NOT NULL,
        name VARCHAR(255),
        notes TEXT,
        url VARCHAR(500),
        date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Sync log table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sync_log (
        id SERIAL PRIMARY KEY,
        synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        invoice_count INT DEFAULT 0,
        status VARCHAR(50) DEFAULT 'success',
        organization_id VARCHAR(255),
        message TEXT
      );
    `);

    // CRM sold deals — stores the date we first observed each deal as sold.
    // sold_date is immutable once set: future CRM edits don't change it.
    // Historical deals (existing on first sync) use Closing_Date from CRM.
    // New deals use CURRENT_DATE (the date we first see them in "Deposit Information Received").
    await pool.query(`
      CREATE TABLE IF NOT EXISTS crm_sold_deals (
        deal_id       VARCHAR(255) PRIMARY KEY,
        deal_name     VARCHAR(500) DEFAULT '',
        account_name  VARCHAR(500) DEFAULT '',
        owner_name    VARCHAR(255) DEFAULT '',
        lead_source_group VARCHAR(255) DEFAULT '',
        points        INT DEFAULT 1,
        sold_date     DATE NOT NULL,
        closing_date_crm DATE,
        amount        DECIMAL(12,2) DEFAULT 0,
        first_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Zentact merchants — stores all merchant accounts pulled from Zentact API.
    // activated_at is stamped the first time we see status = ACTIVE (never overwritten).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS zentact_merchants (
        id                  SERIAL PRIMARY KEY,
        merchant_account_id VARCHAR(255) UNIQUE NOT NULL,
        organization_id     VARCHAR(255),
        business_name       VARCHAR(500) DEFAULT '',
        invitee_email       VARCHAR(255),
        status              VARCHAR(50)  DEFAULT '',
        sales_rep_email     VARCHAR(255),
        sales_rep_name      VARCHAR(255),
        opportunity_id      VARCHAR(255),
        activated_at        DATE,
        points              INT          DEFAULT 1,
        bonus_amount        DECIMAL(10,2) DEFAULT 100.00,
        raw_attributes      JSONB,
        created_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
        updated_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log('✅ Database tables initialized');
  } catch (error) {
    console.error('Database initialization error:', error);
  }
}

// Initialize DB, then start server
let dbReady = false;
initializeDatabase().then(() => { dbReady = true; });

// ============================================================================
// MIDDLEWARE
// ============================================================================

app.use(cors({
  origin: function(origin, callback) {
    const allowedOrigins = [
      process.env.FRONTEND_URL,
      'http://localhost:3000',
      'http://localhost:3001',
      'https://sparkly-kulfi-c7641a.netlify.app', // Netlify
      'https://commission-tracker-frontend-git-main-david-s-projects-dbd14131.vercel.app', // Vercel (old)
    ].filter(Boolean);
    
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.log('CORS blocked origin:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));
app.use(bodyParser.json());

// JWT middleware
const authenticateToken = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const user = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    req.user = user;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// ============================================================================
// ZOHO OAUTH CONFIG
// ============================================================================

const ZOHO_CONFIG = {
  client_id: process.env.ZOHO_CLIENT_ID,
  client_secret: process.env.ZOHO_CLIENT_SECRET,
  redirect_uri: process.env.ZOHO_REDIRECT_URI || 'http://localhost:5000/api/auth/callback',
  accounts_url: 'https://accounts.zoho.com',
};

// ============================================================================
// AUTH ROUTES
// ============================================================================

// 1. Initiate Zoho OAuth
app.get('/api/auth/zoho', (req, res) => {
  const state = Math.random().toString(36).substring(7);
  
  const authUrl = `${ZOHO_CONFIG.accounts_url}/oauth/v2/auth?` +
    `scope=ZohoBooks.invoices.READ,ZohoBooks.invoices.CREATE,ZohoBooks.invoices.UPDATE,AaaServer.profile.READ` +
    `&client_id=${ZOHO_CONFIG.client_id}` +
    `&response_type=code` +
    `&redirect_uri=${ZOHO_CONFIG.redirect_uri}` +
    `&state=${state}` +
    `&access_type=offline`;

  res.json({ authUrl, state });
});

// 2. Handle OAuth callback
app.get('/api/auth/callback', async (req, res) => {
  const { code, state, location, accounts_server } = req.query;

  if (!code) {
    return res.status(400).json({ error: 'No authorization code' });
  }

  try {
    const accountsUrl = accounts_server || ZOHO_CONFIG.accounts_url;

    console.log('OAuth callback received:');
    console.log('Code:', code.substring(0, 20) + '...');
    console.log('accounts_server from Zoho:', accounts_server || 'NOT PROVIDED');
    console.log('Using accountsUrl:', accountsUrl);
    console.log('redirect_uri being sent:', ZOHO_CONFIG.redirect_uri);
    console.log('Client ID:', ZOHO_CONFIG.client_id ? 'SET' : 'MISSING');
    console.log('Client Secret:', ZOHO_CONFIG.client_secret ? 'SET' : 'MISSING');

    // Exchange code for tokens
    const tokenResponse = await axios.post(
      `${accountsUrl}/oauth/v2/token`,
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: ZOHO_CONFIG.client_id,
        client_secret: ZOHO_CONFIG.client_secret,
        redirect_uri: ZOHO_CONFIG.redirect_uri,
        code,
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    console.log('Token exchange successful!');

    const {
      access_token,
      refresh_token,
      api_domain,
      expires_in,
    } = tokenResponse.data;

    // Fetch actual user information from Zoho
    console.log('📋 Fetching user information from Zoho...');
    const userInfoResponse = await axios.get(
      `${accountsUrl}/oauth/user/info`,
      {
        headers: {
          'Authorization': `Zoho-oauthtoken ${access_token}`,
        },
      }
    );

    const userInfo = userInfoResponse.data;
    // Log the FULL Zoho user info so we can see every available field
    console.log('✅ Full Zoho user info:', JSON.stringify(userInfo, null, 2));

    const userEmail = userInfo.Email;
    const userName = `${userInfo.First_Name || ''} ${userInfo.Last_Name || ''}`.trim() || userEmail;

    console.log('User Email:', userEmail);
    console.log('User Name:', userName);
    // Build photo URL — contacts.zoho.com serves profile photos via browser session cookies.
    // We store the URL directly; the user's browser (already logged into Zoho) loads it automatically.
    const ZUID = userInfo.ZUID;
    let userPhoto = null;
    if (ZUID) {
      userPhoto = `https://contacts.zoho.com/file?t=user&fs=thumb&ID=${ZUID}`;
      console.log(`✅ Profile photo URL stored for ZUID ${ZUID}`);
    } else if (userInfo.profile_photo_url) {
      userPhoto = userInfo.profile_photo_url;
      console.log(`✅ Profile photo URL from user info`);
    } else {
      console.log('⚠️ No ZUID available, no profile photo URL');
    }

    // Store tokens in database with error handling
    try {
      await pool.query(
        `INSERT INTO user_tokens (email, access_token, refresh_token, api_domain, expires_at, photo, display_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (email) DO UPDATE SET
         access_token = $2, refresh_token = $3, api_domain = $4, expires_at = $5,
         photo = $6, display_name = $7, updated_at = CURRENT_TIMESTAMP`,
        [userEmail, access_token, refresh_token, api_domain, Date.now() + expires_in * 1000, userPhoto, userName]
      );
      console.log('✅ Tokens stored in database for:', userEmail);
    } catch (dbError) {
      console.error('❌ Database error:', dbError.message);
      return res.status(500).json({ error: 'Failed to store tokens in database' });
    }

    // Create JWT — photo stored in DB, not JWT (base64 would be too large for URL)
    const jwtToken = jwt.sign(
      {
        email:   userEmail,
        name:    userName,
        zoho_id: userInfo.ZUID,
        isAdmin: true
      },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '7d' }
    );

    console.log('✅ JWT token created');

    // Redirect to frontend with token
    const redirectUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/auth/zoho/callback?token=${jwtToken}`;
    console.log('🔄 Redirecting to:', redirectUrl);
    res.redirect(redirectUrl);
  } catch (error) {
    console.error('OAuth callback error:', error.message);
    console.error('Zoho API response status:', error.response?.status);
    console.error('Zoho API response data:', JSON.stringify(error.response?.data, null, 2));
    
    res.status(500).json({ 
      error: 'Token exchange failed',
      details: error.message,
      status: error.response?.status,
      zohoError: error.response?.data
    });
  }
});

// 3. Get access token
app.get('/api/auth/token', authenticateToken, async (req, res) => {
  const { email } = req.user;

  try {
    const result = await pool.query(
      'SELECT access_token FROM user_tokens WHERE email = $1',
      [email]
    );

    if (!result.rows.length) {
      return res.status(401).json({ error: 'No token found' });
    }

    res.json({ accessToken: result.rows[0].access_token });
  } catch (error) {
    console.error('Token retrieval error:', error);
    res.status(500).json({ error: 'Failed to retrieve token' });
  }
});

// 4. Verify JWT token
app.get('/api/auth/verify', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT photo, display_name, is_admin FROM user_tokens WHERE email = $1',
      [req.user.email]
    );
    const row = result.rows[0] || {};
    res.json({
      valid: true,
      user: {
        email:   req.user.email,
        name:    row.display_name || req.user.name || req.user.email,
        photo:   row.photo || req.user.photo || null,
        zoho_id: req.user.zoho_id || req.user.email,
        isAdmin: row.is_admin != null ? row.is_admin : (req.user.isAdmin || false),
      }
    });
  } catch (error) {
    res.json({
      valid: true,
      user: {
        email:   req.user.email,
        name:    req.user.name  || req.user.email,
        photo:   req.user.photo || null,
        zoho_id: req.user.zoho_id || req.user.email,
        isAdmin: req.user.isAdmin || false,
      }
    });
  }
});

// 5. Force-set profile photo URL from Zoho contacts (no re-login needed)
app.post('/api/auth/refresh-photo', authenticateToken, async (req, res) => {
  try {
    const ZUID = req.user.zoho_id;
    if (!ZUID) {
      return res.status(400).json({ success: false, message: 'No ZUID in token' });
    }

    const photoUrl = `https://contacts.zoho.com/file?t=user&fs=thumb&ID=${ZUID}`;
    await pool.query(
      'UPDATE user_tokens SET photo = $1, updated_at = CURRENT_TIMESTAMP WHERE email = $2',
      [photoUrl, req.user.email]
    );
    console.log(`✅ Photo URL set for ${req.user.email}: ${photoUrl}`);
    res.json({ success: true, photo: photoUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// ZOHO CRM AUTH (separate OAuth flow for CRM)
// ============================================================================

// 1. Initiate CRM OAuth
app.get('/api/auth/zoho-crm', authenticateToken, (req, res) => {
  const state = Math.random().toString(36).substring(7);

  const authUrl = `${ZOHO_CONFIG.accounts_url}/oauth/v2/auth?` +
    `scope=ZohoCRM.modules.ALL,ZohoCRM.settings.ALL,ZohoCRM.coql.READ,ZohoCRM.users.READ` +
    `&client_id=${ZOHO_CONFIG.client_id}` +
    `&response_type=code` +
    `&redirect_uri=${process.env.ZOHO_CRM_REDIRECT_URI || ZOHO_CONFIG.redirect_uri.replace('/callback', '/crm-callback')}` +
    `&state=${state}` +
    `&access_type=offline` +
    `&prompt=consent`;

  res.json({ authUrl, state });
});

// 2. Handle CRM OAuth callback
app.get('/api/auth/crm-callback', async (req, res) => {
  const { code, accounts_server } = req.query;

  if (!code) {
    return res.status(400).json({ error: 'No authorization code' });
  }

  try {
    const accountsUrl = accounts_server || ZOHO_CONFIG.accounts_url;

    const tokenResponse = await axios.post(
      `${accountsUrl}/oauth/v2/token`,
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: ZOHO_CONFIG.client_id,
        client_secret: ZOHO_CONFIG.client_secret,
        redirect_uri: process.env.ZOHO_CRM_REDIRECT_URI || ZOHO_CONFIG.redirect_uri.replace('/callback', '/crm-callback'),
        code,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, refresh_token, expires_in } = tokenResponse.data;

    // Store CRM tokens — find admin user to attach to
    await pool.query(
      `UPDATE user_tokens
       SET crm_access_token = $1, crm_refresh_token = $2, crm_expires_at = $3, updated_at = CURRENT_TIMESTAMP
       WHERE is_admin = true`,
      [access_token, refresh_token, Date.now() + (expires_in * 1000)]
    );

    console.log('✅ CRM tokens stored successfully');

    // Redirect back to admin panel
    const redirectUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/admin/sync?crm=connected`;
    res.redirect(redirectUrl);
  } catch (error) {
    console.error('CRM OAuth callback error:', error.response?.data || error.message);
    res.status(500).json({ error: 'CRM token exchange failed', details: error.message, zohoError: error.response?.data });
  }
});

// 3. Check CRM connection status
app.get('/api/auth/crm-status', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT crm_access_token, crm_expires_at FROM user_tokens WHERE is_admin = true ORDER BY updated_at DESC LIMIT 1'
    );
    const row = result.rows[0];
    const connected = !!(row?.crm_access_token);
    const expired = row?.crm_expires_at ? Date.now() > parseInt(row.crm_expires_at) : true;
    res.json({ connected, expired });
  } catch (error) {
    res.status(500).json({ error: 'Failed to check CRM status' });
  }
});

// ============================================================================
// ZOHO CRM ROUTES
// ============================================================================

// GET /api/crm/deals — fetch all deals from Zoho CRM
app.get('/api/crm/deals', authenticateToken, async (req, res) => {
  try {
    const crmToken = await ensureValidCrmToken();
    const crm = new ZohoCRMService(crmToken);
    const result = await crm.getDeals({ perPage: 200 });
    const deals = (result.data || []).map(d => crm.transformDeal(d));
    res.json({ deals, count: deals.length });
  } catch (error) {
    console.error('CRM deals error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch CRM deals', details: error.message });
  }
});

// GET /api/crm/deals/sold — fetch only SOLD deals (Deposit Information Received)
app.get('/api/crm/deals/sold', authenticateToken, async (req, res) => {
  try {
    const crmToken = await ensureValidCrmToken();
    const crm = new ZohoCRMService(crmToken);
    const result = await crm.getSoldDeals();
    const deals = (result.data || []).map(d => crm.transformDeal(d));
    res.json({ deals, count: deals.length });
  } catch (error) {
    console.error('CRM sold deals error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch sold deals', details: error.message });
  }
});

// GET /api/crm/fields — inspect all Deal field names (useful for setup)
app.get('/api/crm/fields', authenticateToken, async (req, res) => {
  try {
    const crmToken = await ensureValidCrmToken();
    const crm = new ZohoCRMService(crmToken);
    const fields = await crm.getDealFields();
    const simplified = fields.map(f => ({
      api_name: f.api_name,
      label: f.field_label,
      type: f.data_type,
    }));
    res.json({ fields: simplified, count: simplified.length });
  } catch (error) {
    console.error('CRM fields error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch CRM fields', details: error.message });
  }
});

// Background CRM sync — runs at most once every 5 minutes to avoid hammering Zoho
let lastCrmSync = 0;
let crmSyncRunning = false;

function triggerBackgroundCrmSync() {
  const now = Date.now();
  if (crmSyncRunning || now - lastCrmSync < 5 * 60 * 1000) return; // throttle: 5 min
  crmSyncRunning = true;
  (async () => {
    try {
      const crmToken = await ensureValidCrmToken();
      const crm = new ZohoCRMService(crmToken);
      const result = await syncCrmSoldDeals(crm);
      lastCrmSync = Date.now();
      console.log('✅ Background CRM sync complete:', result);
    } catch (err) {
      console.error('❌ Background CRM sync failed:', err.message);
    } finally {
      crmSyncRunning = false;
    }
  })();
}

// GET /api/crm/points — points & quota summary per rep for a given month/year
// Query params: year, month, repName (optional)
app.get('/api/crm/points', authenticateToken, async (req, res) => {
  try {
    const year  = parseInt(req.query.year)  || new Date().getFullYear();
    const month = parseInt(req.query.month) || new Date().getMonth() + 1;
    const repFilter = (req.query.repName || '').trim().toLowerCase();

    // Kick off a background sync (non-blocking) — DB may be up to 5 min stale
    triggerBackgroundCrmSync();

    // Query DB for deals in the requested month using the stable sold_date
    const startDate = new Date(year, month - 1, 1);
    const endDate   = new Date(year, month, 0); // last day of month

    let dealsQuery = `
      SELECT c.deal_id, c.deal_name, c.account_name, c.owner_name, c.lead_source_group, c.points, c.sold_date
      FROM crm_sold_deals c
      WHERE c.sold_date >= $1 AND c.sold_date <= $2
        AND (
          c.owner_name IN (SELECT name FROM salespeople WHERE is_active = true)
          OR c.owner_name IS NULL
        )
    `;
    const dealsParams = [startDate, endDate];

    if (repFilter) {
      dealsQuery += ` AND LOWER(c.owner_name) LIKE $3`;
      dealsParams.push(`%${repFilter}%`);
    }
    dealsQuery += ` ORDER BY c.sold_date DESC`;

    const dealsResult = await pool.query(dealsQuery, dealsParams);
    const deals = dealsResult.rows;

    // Build per-rep summary from CRM deals
    const repMap = {};
    for (const deal of deals) {
      const rep = deal.owner_name || 'Unassigned';
      if (!repMap[rep]) repMap[rep] = { repName: rep, totalPoints: 0, crmPoints: 0, deals: [], zentactMerchants: [] };
      repMap[rep].totalPoints += deal.points;
      repMap[rep].crmPoints   += deal.points;
      repMap[rep].deals.push({
        crm_deal_id:       deal.deal_id,
        deal_name:         deal.deal_name,
        account_name:      deal.account_name,
        lead_source_group: deal.lead_source_group,
        points:            deal.points,
        close_date:        deal.sold_date,
      });
    }

    // Merge Zentact activations for the same month
    const zentactResult = await pool.query(`
      SELECT merchant_account_id, business_name, sales_rep_name, sales_rep_email,
             opportunity_id, points, bonus_amount, activated_at
      FROM zentact_merchants
      WHERE activated_at >= $1 AND activated_at <= $2
        AND status = 'ACTIVE'
        AND (
          sales_rep_name IN (SELECT name FROM salespeople WHERE is_active = true)
          OR sales_rep_name IS NULL
        )
    `, [startDate, endDate]);

    for (const merchant of zentactResult.rows) {
      const rep = merchant.sales_rep_name || 'Unassigned';
      if (!repMap[rep]) repMap[rep] = { repName: rep, totalPoints: 0, crmPoints: 0, deals: [], zentactMerchants: [] };
      const pts = parseInt(merchant.points) || 1;
      repMap[rep].totalPoints += pts;
      repMap[rep].zentactMerchants.push({
        merchant_account_id: merchant.merchant_account_id,
        business_name:       merchant.business_name,
        sales_rep_name:      merchant.sales_rep_name,
        opportunity_id:      merchant.opportunity_id,
        points:              pts,
        bonus_amount:        parseFloat(merchant.bonus_amount) || 100,
        activated_at:        merchant.activated_at,
      });
    }

    let summary = Object.values(repMap).map(rep => {
      const zentactMerchants = rep.zentactMerchants || [];
      const zentactPoints = zentactMerchants.reduce((s, m) => s + (m.points || 1), 0);
      const zentactBonus  = zentactMerchants.reduce((s, m) => s + (m.bonus_amount || 100), 0);
      const quotaMet = rep.totalPoints >= MONTHLY_QUOTA;
      const monthlyBonus = ZohoCRMService.calculateMonthlyBonus(rep.totalPoints);
      return {
        repName:             rep.repName,
        totalPoints:         rep.totalPoints,   // CRM + Zentact combined
        crmPoints:           rep.crmPoints || 0,
        zentactPoints,
        zentactActivations:  zentactMerchants.length,
        zentactBonus,
        quota:               MONTHLY_QUOTA,
        quotaMet,
        pointsToQuota:       Math.max(0, MONTHLY_QUOTA - rep.totalPoints),
        monthlyBonus,
        bonusTier:     MONTHLY_BONUS_TIERS.find(t => rep.totalPoints >= t.points) || null,
        nextBonusTier: MONTHLY_BONUS_TIERS.slice().reverse().find(t => rep.totalPoints < t.points) || null,
        deals:               rep.deals,
        zentactMerchants,
      };
    }).sort((a, b) => b.totalPoints - a.totalPoints);

    // Annual CRM points from PLAN_START_DATE (May 1, 2026)
    const annualResult = await pool.query(`
      SELECT owner_name, SUM(points) AS annual_points
      FROM crm_sold_deals
      WHERE sold_date >= $1
      GROUP BY owner_name
    `, [PLAN_START_DATE]);

    const annualByRep = {};
    for (const row of annualResult.rows) {
      annualByRep[row.owner_name] = parseInt(row.annual_points) || 0;
    }

    // Annual Zentact points from PLAN_START_DATE
    const annualZentactResult = await pool.query(`
      SELECT sales_rep_name,
             SUM(points)  AS zentact_points,
             COUNT(*)     AS activations,
             SUM(bonus_amount) AS zentact_bonus
      FROM zentact_merchants
      WHERE activated_at >= $1 AND status = 'ACTIVE'
      GROUP BY sales_rep_name
    `, [PLAN_START_DATE]);

    const annualZentactByRep = {};
    for (const row of annualZentactResult.rows) {
      annualZentactByRep[row.sales_rep_name] = {
        points:      parseInt(row.zentact_points)  || 0,
        activations: parseInt(row.activations)     || 0,
        bonus:       parseFloat(row.zentact_bonus) || 0,
      };
    }

    summary = summary.map(rep => {
      const crmAnnual     = annualByRep[rep.repName]         || 0;
      const zentactAnnual = annualZentactByRep[rep.repName]  || { points: 0, activations: 0, bonus: 0 };
      const totalAnnual   = crmAnnual + zentactAnnual.points;
      return {
        ...rep,
        annualPoints:             totalAnnual,
        annualBonus:              ZohoCRMService.calculateAnnualBonus(totalAnnual),
        annualZentactActivations: zentactAnnual.activations,
        annualZentactBonus:       zentactAnnual.bonus,
      };
    });

    const totalZentactActivations = zentactResult.rows.length;

    res.json({
      year,
      month,
      quota:                   MONTHLY_QUOTA,
      bonusTiers:              MONTHLY_BONUS_TIERS,
      totalDeals:              deals.length,
      totalZentactActivations,
      reps:                    summary,
    });
  } catch (error) {
    console.error('CRM points error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to calculate points', details: error.message });
  }
});

// ============================================================================
// GET /api/crm/points/annual — full month-by-month points & bonus breakdown for one rep
// Used by Commission Report to show points alongside invoice commissions.
// Query params: year (required), repName (required)
app.get('/api/crm/points/annual', authenticateToken, async (req, res) => {
  try {
    const year    = parseInt(req.query.year)       || new Date().getFullYear();
    const repName = (req.query.repName || '').trim();
    if (!repName) return res.status(400).json({ error: 'repName required' });

    // CRM sold deals grouped by month for this rep & year
    const crmResult = await pool.query(`
      SELECT EXTRACT(MONTH FROM sold_date) AS month,
             SUM(points) AS crm_points
      FROM crm_sold_deals
      WHERE EXTRACT(YEAR FROM sold_date) = $1
        AND LOWER(owner_name) = LOWER($2)
      GROUP BY EXTRACT(MONTH FROM sold_date)
    `, [year, repName]);

    // Zentact activations grouped by month for this rep & year
    const zentactResult = await pool.query(`
      SELECT EXTRACT(MONTH FROM activated_at) AS month,
             SUM(points)       AS zentact_points,
             COUNT(*)          AS activations,
             SUM(bonus_amount) AS zentact_bonus
      FROM zentact_merchants
      WHERE EXTRACT(YEAR FROM activated_at) = $1
        AND LOWER(sales_rep_name) = LOWER($2)
        AND status = 'ACTIVE'
      GROUP BY EXTRACT(MONTH FROM activated_at)
    `, [year, repName]);

    const crmByMonth = {};
    for (const r of crmResult.rows) {
      crmByMonth[parseInt(r.month)] = parseInt(r.crm_points) || 0;
    }
    const zentactByMonth = {};
    for (const r of zentactResult.rows) {
      zentactByMonth[parseInt(r.month)] = {
        points:      parseInt(r.zentact_points)  || 0,
        activations: parseInt(r.activations)     || 0,
        bonus:       parseFloat(r.zentact_bonus) || 0,
      };
    }

    const months = [];
    for (let m = 1; m <= 12; m++) {
      const crmPts  = crmByMonth[m]    || 0;
      const zentact = zentactByMonth[m] || { points: 0, activations: 0, bonus: 0 };
      const total   = crmPts + zentact.points;
      months.push({
        month:             m,
        crmPoints:         crmPts,
        zentactPoints:     zentact.points,
        zentactActivations: zentact.activations,
        zentactBonus:      zentact.bonus,
        totalPoints:       total,
        quotaMet:          total >= MONTHLY_QUOTA,
        monthlyBonus:      ZohoCRMService.calculateMonthlyBonus(total),
      });
    }

    // Annual totals — only from PLAN_START_DATE forward
    const [crmAnn, zentactAnn] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(points), 0) AS pts FROM crm_sold_deals
         WHERE sold_date >= $1 AND LOWER(owner_name) = LOWER($2)`,
        [PLAN_START_DATE, repName]
      ),
      pool.query(
        `SELECT COALESCE(SUM(points), 0) AS pts, COALESCE(COUNT(*), 0) AS acts, COALESCE(SUM(bonus_amount), 0) AS bonus
         FROM zentact_merchants
         WHERE activated_at >= $1 AND LOWER(sales_rep_name) = LOWER($2) AND status = 'ACTIVE'`,
        [PLAN_START_DATE, repName]
      ),
    ]);

    const annualCrm     = parseInt(crmAnn.rows[0]?.pts)       || 0;
    const annualZentact = parseInt(zentactAnn.rows[0]?.pts)    || 0;
    const annualTotal   = annualCrm + annualZentact;
    const annualBonus   = ZohoCRMService.calculateAnnualBonus(annualTotal);
    const nextTier      = ANNUAL_BONUS_TIERS.slice().reverse().find(t => annualTotal < t.points) || null;

    res.json({
      repName,
      year,
      months,
      annual: {
        totalPoints:    annualTotal,
        crmPoints:      annualCrm,
        zentactPoints:  annualZentact,
        zentactBonus:   parseFloat(zentactAnn.rows[0]?.bonus) || 0,
        annualBonus,
        nextTier,
        ptsToNextTier: nextTier ? nextTier.points - annualTotal : 0,
        tiers: ANNUAL_BONUS_TIERS,
      },
    });
  } catch (err) {
    console.error('CRM points/annual error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ZENTACT ROUTES
// ============================================================================

// GET /api/zentact/status — connection health + merchant counts
app.get('/api/zentact/status', authenticateToken, async (req, res) => {
  try {
    const apiKey = process.env.ZENTACT_API_KEY;
    if (!apiKey) {
      return res.json({ connected: false, reason: 'ZENTACT_API_KEY not set' });
    }

    const result = await pool.query(`
      SELECT
        COUNT(*)                                                       AS total,
        COUNT(CASE WHEN status = 'ACTIVE' THEN 1 END)                 AS active,
        COUNT(CASE WHEN sales_rep_email IS NOT NULL THEN 1 END)       AS with_rep_email,
        COUNT(CASE WHEN sales_rep_name  IS NOT NULL THEN 1 END)       AS assigned,
        MAX(updated_at)                                                AS last_sync
      FROM zentact_merchants
    `);
    const row = result.rows[0];

    // Sample 3 merchants to expose their raw_attributes so we can debug field names
    const sampleRes = await pool.query(`
      SELECT merchant_account_id, business_name, sales_rep_email, sales_rep_name,
             raw_attributes
      FROM zentact_merchants
      ORDER BY created_at
      LIMIT 3
    `);

    res.json({
      connected:    true,
      total:        parseInt(row.total)           || 0,
      active:       parseInt(row.active)          || 0,
      withRepEmail: parseInt(row.with_rep_email)  || 0,
      assigned:     parseInt(row.assigned)        || 0,
      lastSync:     row.last_sync                 || null,
      debugSamples: sampleRes.rows,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/zentact/sync — background sync of all merchant accounts
let zentactSyncStatus = { running: false, startedAt: null, result: null, error: null };

app.post('/api/zentact/sync', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  if (zentactSyncStatus.running) {
    return res.status(409).json({ error: 'Sync already in progress', startedAt: zentactSyncStatus.startedAt });
  }

  zentactSyncStatus = { running: true, startedAt: new Date().toISOString(), result: null, error: null };
  res.json({ success: true, message: 'Zentact sync started — poll /api/zentact/sync-status' });

  (async () => {
    try {
      const result = await syncZentactMerchants();
      zentactSyncStatus = { running: false, startedAt: zentactSyncStatus.startedAt, result, error: null };
      console.log('✅ Zentact sync complete:', result);
    } catch (err) {
      zentactSyncStatus = { running: false, startedAt: zentactSyncStatus.startedAt, result: null, error: err.message };
      console.error('❌ Zentact sync failed:', err.message);
    }
  })();
});

// GET /api/zentact/sync-status — poll background sync progress
app.get('/api/zentact/sync-status', authenticateToken, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  res.json(zentactSyncStatus);
});

// GET /api/zentact/attribute-keys — shows what attribute keys are stored in the DB (debug)
app.get('/api/zentact/attribute-keys', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  try {
    // Show distinct attribute keys stored in raw_attributes JSONB
    const keysRes = await pool.query(`
      SELECT DISTINCT jsonb_object_keys(raw_attributes) AS key
      FROM zentact_merchants
      WHERE raw_attributes IS NOT NULL AND raw_attributes <> 'null'::jsonb
      ORDER BY key
    `);
    // Also show a sample merchant's full raw_attributes
    const sampleRes = await pool.query(`
      SELECT merchant_account_id, business_name, sales_rep_email, sales_rep_name,
             raw_attributes
      FROM zentact_merchants
      LIMIT 3
    `);
    res.json({
      attributeKeys: keysRes.rows.map(r => r.key),
      samples: sampleRes.rows,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/zentact/merchants — list all merchants in DB
app.get('/api/zentact/merchants', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  try {
    const result = await pool.query(`
      SELECT merchant_account_id, business_name, status, sales_rep_email,
             sales_rep_name, opportunity_id, activated_at, bonus_amount, points, updated_at
      FROM zentact_merchants
      ORDER BY activated_at DESC NULLS LAST, created_at DESC
    `);
    res.json({ merchants: result.rows, total: result.rows.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PATCH /api/zentact/merchants/:merchantId/rep — manually assign a rep name
app.patch('/api/zentact/merchants/:merchantId/rep', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  const { repName } = req.body;
  if (!repName) return res.status(400).json({ error: 'repName required' });
  try {
    await pool.query(
      `UPDATE zentact_merchants
       SET sales_rep_name = $1, updated_at = CURRENT_TIMESTAMP
       WHERE merchant_account_id = $2`,
      [repName, req.params.merchantId]
    );
    // Ensure the rep is in salespeople table
    await pool.query(
      `INSERT INTO salespeople (name, is_active) VALUES ($1, true) ON CONFLICT (name) DO NOTHING`,
      [repName]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/crm/sync-debug — run getSoldDeals() live and return raw counts + samples
app.get('/api/crm/sync-debug', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  try {
    const crmToken = await ensureValidCrmToken();
    const crm = new ZohoCRMService(crmToken);
    const result = await crm.getSoldDeals();
    const deals = result.data || [];

    const byMonth = {};
    deals.forEach(d => {
      const dep = d.Deposit_Information_Received || null;
      const close = d.Closing_Date || null;
      const date = dep || close || 'NO_DATE';
      const month = date !== 'NO_DATE' ? date.toString().slice(0, 7) : 'NO_DATE';
      if (!byMonth[month]) byMonth[month] = 0;
      byMonth[month]++;
    });

    // Sample of deals missing Deposit_Information_Received
    const missingDateField = deals
      .filter(d => !d.Deposit_Information_Received)
      .slice(0, 10)
      .map(d => ({
        id: d.id,
        name: d.Deal_Name,
        stage: d.Stage,
        closing_date: d.Closing_Date,
        deposit_field: d.Deposit_Information_Received,
        owner: d.Owner?.name || d['Owner.name'] || d.Owner,
      }));

    res.json({
      total: deals.length,
      byMonth,
      sampleMissingDepositField: missingDateField,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/crm/sold-deals-db — show everything in the crm_sold_deals table
// Useful to audit what sold_date each deal was stamped with
app.get('/api/crm/sold-deals-db', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  try {
    const result = await pool.query(`
      SELECT deal_id, deal_name, owner_name, lead_source_group, points,
             sold_date, closing_date_crm, first_seen_at
      FROM crm_sold_deals
      ORDER BY sold_date DESC
    `);

    // Group by month so it's easy to read
    const byMonth = {};
    for (const row of result.rows) {
      const key = row.sold_date ? row.sold_date.toISOString().slice(0, 7) : 'unknown';
      if (!byMonth[key]) byMonth[key] = [];
      byMonth[key].push({
        deal_name:        row.deal_name,
        owner:            row.owner_name,
        lead_source_group: row.lead_source_group,
        points:           row.points,
        sold_date:        row.sold_date,
        closing_date_crm: row.closing_date_crm,
        first_seen_at:    row.first_seen_at,
      });
    }

    res.json({
      total: result.rows.length,
      by_month: byMonth,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/crm/sold-deals-db/reset — wipe the table and re-sync from CRM
// Use this if the initial import landed deals in the wrong months.
// Responds immediately (202) then runs the sync in the background to avoid
// Heroku's 30-second request timeout.
let crmResetStatus = { running: false, startedAt: null, result: null, error: null };

app.post('/api/crm/sold-deals-db/reset', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  if (crmResetStatus.running) {
    return res.status(409).json({ error: 'Reset already in progress', startedAt: crmResetStatus.startedAt });
  }

  // Respond immediately — sync runs in background
  crmResetStatus = { running: true, startedAt: new Date().toISOString(), result: null, error: null };
  res.json({ success: true, message: 'Reset started — poll /api/crm/sold-deals-db/reset-status for result' });

  // Run async without blocking the response
  (async () => {
    try {
      await pool.query('TRUNCATE TABLE crm_sold_deals');
      const crmToken = await ensureValidCrmToken();
      const crm = new ZohoCRMService(crmToken);
      const syncResult = await syncCrmSoldDeals(crm);
      crmResetStatus = { running: false, startedAt: crmResetStatus.startedAt, result: syncResult, error: null };
      console.log('✅ CRM reset complete:', syncResult);
    } catch (err) {
      crmResetStatus = { running: false, startedAt: crmResetStatus.startedAt, result: null, error: err.message };
      console.error('❌ CRM reset failed:', err.message);
    }
  })();
});

// GET /api/crm/sold-deals-db/reset-status — poll for background reset progress
app.get('/api/crm/sold-deals-db/reset-status', authenticateToken, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  res.json(crmResetStatus);
});

// PATCH /api/crm/sold-deals-db/:dealId — manually correct a deal's sold_date
app.patch('/api/crm/sold-deals-db/:dealId', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  const { soldDate } = req.body; // expects "YYYY-MM-DD"
  if (!soldDate) return res.status(400).json({ error: 'soldDate required (YYYY-MM-DD)' });
  try {
    await pool.query(
      'UPDATE crm_sold_deals SET sold_date = $1, updated_at = CURRENT_TIMESTAMP WHERE deal_id = $2',
      [soldDate, req.params.dealId]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/crm/debug — inspect raw deal data to diagnose missing fields / date issues
// Usage: /api/crm/debug?year=2026&month=5
app.get('/api/crm/debug', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  try {
    const year  = parseInt(req.query.year)  || new Date().getFullYear();
    const month = parseInt(req.query.month) || new Date().getMonth() + 1;

    const crmToken = await ensureValidCrmToken();
    const crm = new ZohoCRMService(crmToken);
    const allSold = await crm.getSoldDeals();
    const allDeals = allSold.data || [];

    // Show raw key fields for every deal so we can spot missing data
    const raw = allDeals.map(d => ({
      id:                d.id,
      name:              d.Deal_Name,
      stage:             d.Stage,
      closing_date:      d.Closing_Date      || null,
      modified_time:     d.Modified_Time     || null,
      created_time:      d.Created_Time      || null,
      lead_source_group: d.Lead_Source_Group || null,
      owner:             d.Owner?.name       || null,
    }));

    // Apply the same month filter the points endpoint uses (Modified_Time primary)
    const filtered = raw.filter(d => {
      const dateStr = d.modified_time || d.closing_date;
      if (!dateStr) return false;
      const dt = new Date(dateStr);
      return dt.getFullYear() === year && dt.getMonth() + 1 === month;
    });

    // Count how many are missing Closing_Date or Lead_Source_Group
    const missingCloseDate = raw.filter(d => !d.closing_date).length;
    const missingSourceGroup = raw.filter(d => !d.lead_source_group).length;

    res.json({
      total_sold_all_time: allDeals.length,
      missing_closing_date: missingCloseDate,
      missing_lead_source_group: missingSourceGroup,
      filtered_for_month: filtered.length,
      year,
      month,
      deals_this_month: filtered,
      sample_all_time: raw.slice(0, 10),
    });
  } catch (error) {
    console.error('CRM debug error:', error.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/crm/views — list all custom views for the Deals module
app.get('/api/crm/views', authenticateToken, async (req, res) => {
  try {
    const crmToken = await ensureValidCrmToken();
    const response = await axios.get('https://www.zohoapis.com/crm/v2/Deals/views', {
      headers: { 'Authorization': `Zoho-oauthtoken ${crmToken}` },
    });
    const views = (response.data?.custom_views || []).map(v => ({
      id: v.id,
      name: v.name,
      display_value: v.display_value,
      category: v.category,
    }));
    res.json({ views, count: views.length });
  } catch (error) {
    console.error('CRM views error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch CRM views', details: error.message });
  }
});

// GET /api/crm/reports — list all reports in Zoho CRM
app.get('/api/crm/reports', authenticateToken, async (req, res) => {
  try {
    const crmToken = await ensureValidCrmToken();
    const response = await axios.get('https://www.zohoapis.com/crm/v2/reports', {
      headers: { 'Authorization': `Zoho-oauthtoken ${crmToken}` },
    });
    // Filter by name if query param provided
    const search = (req.query.search || '').toLowerCase();
    let reports = response.data?.reports || [];
    if (search) {
      reports = reports.filter(r => r.name?.toLowerCase().includes(search));
    }
    res.json({ reports: reports.map(r => ({ id: r.id, name: r.name, module: r.module, type: r.report_type })), count: reports.length });
  } catch (error) {
    console.error('CRM reports error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch CRM reports', details: error.message });
  }
});

// ============================================================================
// COMMISSION API ROUTES
// ============================================================================

// ============================================================================
// AUTO-SYNC INVOICES (runs every 4 hours)
// ============================================================================

async function autoSyncInvoices() {
  try {
    console.log('🔄 [AUTO-SYNC] Starting automatic invoice sync...');
    
    // Get the most recent admin user (by updated_at) to use for syncing
    const adminResult = await pool.query(
      'SELECT email, access_token, refresh_token, api_domain, expires_at FROM user_tokens WHERE is_admin = true ORDER BY updated_at DESC LIMIT 1'
    );

    if (!adminResult.rows[0]) {
      console.log('⚠️ [AUTO-SYNC] No admin user found for sync');
      return;
    }

    let admin = adminResult.rows[0];
    console.log(`🔐 [AUTO-SYNC] Using admin: ${admin.email}`);

    // Always refresh token to ensure it's valid
    if (admin.refresh_token) {
      console.log('🔄 [AUTO-SYNC] Refreshing token...');
      
      try {
        const refreshResponse = await axios.post(
          'https://accounts.zoho.com/oauth/v2/token',
          new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: process.env.ZOHO_CLIENT_ID,
            client_secret: process.env.ZOHO_CLIENT_SECRET,
            refresh_token: admin.refresh_token,
          }),
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
          }
        );

        const newAccessToken = refreshResponse.data.access_token;
        const newExpiresIn = parseInt(refreshResponse.data.expires_in) || 3600;
        const newExpiresAt = Date.now() + (newExpiresIn * 1000);

        console.log(`✅ [AUTO-SYNC] Token refreshed (expires in ${newExpiresIn}s)`);

        // Update token in database
        await pool.query(
          `UPDATE user_tokens SET access_token = $1, expires_at = $2, updated_at = CURRENT_TIMESTAMP 
           WHERE email = $3`,
          [newAccessToken, newExpiresAt, admin.email]
        );

        admin.access_token = newAccessToken;
      } catch (error) {
        console.error('❌ [AUTO-SYNC] Token refresh failed:', error.message);
        console.error('Response data:', error.response?.data);
        return;
      }
    }

    // Fetch PAID invoices from Zoho
    console.log(`🔗 [AUTO-SYNC] Fetching paid invoices from: ${admin.api_domain}/books/v3/invoices`);
    const paidResponse = await axios.get(
      `${admin.api_domain}/books/v3/invoices`,
      {
        params: {
          organization_id: process.env.ZOHO_ORG_ID,
          status: 'paid',
          limit: 200,
        },
        headers: {
          'Authorization': `Zoho-oauthtoken ${admin.access_token}`,
        },
      }
    );

    console.log(`✅ [AUTO-SYNC] Paid response status: ${paidResponse.status}`);
    console.log(`📊 [AUTO-SYNC] Paid invoices count: ${paidResponse.data.invoices?.length || 0}`);

    // Fetch OVERDUE invoices from Zoho
    console.log(`🔗 [AUTO-SYNC] Fetching overdue invoices...`);
    const overdueResponse = await axios.get(
      `${admin.api_domain}/books/v3/invoices`,
      {
        params: {
          organization_id: process.env.ZOHO_ORG_ID,
          status: 'overdue',
          limit: 200,
        },
        headers: {
          'Authorization': `Zoho-oauthtoken ${admin.access_token}`,
        },
      }
    );

    console.log(`✅ [AUTO-SYNC] Overdue response status: ${overdueResponse.status}`);
    console.log(`📊 [AUTO-SYNC] Overdue invoices count: ${overdueResponse.data.invoices?.length || 0}`);

    const paidInvoices = (paidResponse.data.invoices || []).map(inv => ({ ...inv, status: 'paid' }));
    const overdueInvoices = (overdueResponse.data.invoices || []).map(inv => ({ ...inv, status: 'overdue' }));
    const allInvoices = [...paidInvoices, ...overdueInvoices];

    if (allInvoices.length > 0) {
      console.log(`📥 [AUTO-SYNC] Sample paid invoice:`, JSON.stringify(paidInvoices[0], null, 2));
      if (overdueInvoices.length > 0) {
        console.log(`📥 [AUTO-SYNC] Sample overdue invoice:`, JSON.stringify(overdueInvoices[0], null, 2));
      }
    } else {
      console.log(`⚠️ [AUTO-SYNC] No invoices returned. Full paid response:`, JSON.stringify(paidResponse.data, null, 2));
      console.log(`⚠️ [AUTO-SYNC] Full overdue response:`, JSON.stringify(overdueResponse.data, null, 2));
    }

    console.log(`📥 [AUTO-SYNC] Fetched ${paidInvoices.length} paid + ${overdueInvoices.length} overdue invoices`);

    // Insert/Update invoices in database (both paid and overdue)
    let syncedCount = 0;
    for (const inv of allInvoices) {
      const salesperson = inv.salesperson_name || 'Unassigned';
      const customerName = inv.customer_name || inv.contact_name || null;
      const total = parseFloat(inv.total) || 0;
      // Commission only for PAID invoices
      const commission = inv.status === 'paid' ? (total * 0.1) : 0;
      const invDate = new Date(inv.date || new Date());

      await pool.query(
        `INSERT INTO invoices
         (invoice_number, salesperson_name, customer_name, total, status, date, commission, organization_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (invoice_number) DO UPDATE SET
         status = $5, total = $4, commission = $7, customer_name = COALESCE($3, invoices.customer_name),
         updated_at = CURRENT_TIMESTAMP`,
        [inv.invoice_number, salesperson, customerName, total, inv.status, invDate, commission, process.env.ZOHO_ORG_ID]
      );
      syncedCount++;
    }

    // Log the sync
    await pool.query(
      `INSERT INTO sync_log (invoice_count, status, organization_id, message)
       VALUES ($1, 'success', $2, $3)`,
      [syncedCount, process.env.ZOHO_ORG_ID, `Synced ${paidInvoices.length} paid + ${overdueInvoices.length} overdue`]
    );

    console.log(`✅ [AUTO-SYNC] Successfully synced ${syncedCount} invoices at ${new Date().toISOString()}`);
    console.log(`💰 [AUTO-SYNC] Commission calculated ONLY on paid invoices`);
  } catch (error) {
    console.error(`❌ [AUTO-SYNC] Sync failed: ${error.message}`);
  }
}

// Schedule auto-sync to run every 4 hours (14400000 ms)
const AUTO_SYNC_INTERVAL         = 4  * 60 * 60 * 1000; // 4 hours  — invoices
const ZENTACT_AUTO_SYNC_INTERVAL = 1 * 60 * 60 * 1000; // 1 hour — Zentact merchants

let syncInterval;
let zentactSyncIntervalHandle;

async function autoSyncZentact() {
  if (!process.env.ZENTACT_API_KEY) return; // skip if not configured
  try {
    console.log('🔄 [AUTO-SYNC] Starting automatic Zentact merchant sync...');
    const result = await syncZentactMerchants();
    console.log(`✅ [AUTO-SYNC] Zentact done: ${result.total} total, ${result.active} active, ${result.newCount} new`);
  } catch (err) {
    console.error('❌ [AUTO-SYNC] Zentact sync error:', err.message);
  }
}

function startAutoSync() {
  console.log('⏰ [AUTO-SYNC] Starting automatic sync scheduler (invoices every 4h, Zentact every 12h)');

  // Invoices — run immediately, then every 4 hours
  autoSyncInvoices();
  syncInterval = setInterval(autoSyncInvoices, AUTO_SYNC_INTERVAL);

  // Zentact — first run after 5 seconds (give DB time to settle), then every 12 hours
  setTimeout(() => {
    autoSyncZentact();
    zentactSyncIntervalHandle = setInterval(autoSyncZentact, ZENTACT_AUTO_SYNC_INTERVAL);
  }, 5 * 1000);
}

function stopAutoSync() {
  if (syncInterval) {
    clearInterval(syncInterval);
    console.log('⏹️ [AUTO-SYNC] Stopped invoice sync scheduler');
  }
  if (zentactSyncIntervalHandle) {
    clearInterval(zentactSyncIntervalHandle);
    console.log('⏹️ [AUTO-SYNC] Stopped Zentact sync scheduler');
  }
}

// ============================================================================
// CRM SOLD DEALS SYNC — stamps each deal with the date we first see it sold
// ============================================================================

async function syncCrmSoldDeals(crm) {
  const allSold = await crm.getSoldDeals();
  const deals = allSold.data || [];
  // userMap is built from Stage search results (which return full Owner {id,name})
  // and used to resolve owner names on COQL deals (which return Owner {id} only)
  const userMap = allSold.userMap || {};
  console.log(`👥 User map has ${Object.keys(userMap).length} entries:`, JSON.stringify(userMap));
  let newCount = 0;

  for (const rawDeal of deals) {
    const deal = crm.transformDeal(rawDeal, userMap);

    // sold_date = Deposit_Information_Received date (the custom CRM field that records
    // exactly when the deal reached that stage). Fall back to Closing_Date, then today.
    const depositDate = rawDeal.Deposit_Information_Received || null;
    const closingDateCrm = rawDeal.Closing_Date || null;
    const soldDateSource = depositDate || closingDateCrm; // preferred → fallback

    const result = await pool.query(`
      INSERT INTO crm_sold_deals
        (deal_id, deal_name, account_name, owner_name, lead_source_group, points, sold_date, closing_date_crm, amount)
      VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::date, CURRENT_DATE), $8::date, $9)
      ON CONFLICT (deal_id) DO UPDATE SET
        deal_name         = EXCLUDED.deal_name,
        account_name      = EXCLUDED.account_name,
        owner_name        = EXCLUDED.owner_name,
        lead_source_group = EXCLUDED.lead_source_group,
        points            = EXCLUDED.points,
        sold_date         = COALESCE(EXCLUDED.sold_date, crm_sold_deals.sold_date),
        closing_date_crm  = EXCLUDED.closing_date_crm,
        amount            = EXCLUDED.amount,
        updated_at        = CURRENT_TIMESTAMP
      RETURNING (xmax = 0) AS inserted
    `, [deal.crm_deal_id, deal.deal_name, deal.account_name, deal.sales_rep_name,
        deal.lead_source_group, deal.points, soldDateSource, closingDateCrm, deal.amount]);

    if (result.rows[0]?.inserted) newCount++;
  }

  // Upsert all unique CRM rep names into salespeople table.
  // New reps default to active=true. Existing reps keep their current is_active status.
  const uniqueReps = [...new Set(deals.map(d => crm.transformDeal(d, userMap).sales_rep_name).filter(n => n && n !== 'Unassigned'))];
  for (const repName of uniqueReps) {
    await pool.query(`
      INSERT INTO salespeople (name, is_active)
      VALUES ($1, true)
      ON CONFLICT (name) DO NOTHING
    `, [repName]);
  }
  console.log(`👥 Upserted ${uniqueReps.length} CRM reps into salespeople table`);

  console.log(`✅ CRM sync: ${deals.length} deals processed, ${newCount} new`);
  return { total: deals.length, newCount };
}

// ============================================================================
// ZENTACT SYNC — pull all merchant accounts, resolve rep names, stamp activated_at
// ============================================================================

async function syncZentactMerchants() {
  const apiKey = process.env.ZENTACT_API_KEY;
  if (!apiKey) throw new Error('ZENTACT_API_KEY env var not set');

  const zentact = new ZentactService(apiKey);

  // One-time cleanup: clear activated_at values that look like a bulk-import stamp
  // (activated_at = created_at, both on today's date) so we can replace them with the
  // real earliest-transaction date.
  const cleaned = await pool.query(`
    UPDATE zentact_merchants
    SET activated_at = NULL
    WHERE activated_at IS NOT NULL
      AND DATE(activated_at) = DATE(created_at)
      AND DATE(activated_at) >= CURRENT_DATE - INTERVAL '7 days'
  `);
  if (cleaned.rowCount > 0) {
    console.log(`🧹 Cleared ${cleaned.rowCount} bulk-import activated_at stamps — will replace with real transaction dates`);
  }

  const rawMerchants = await zentact.getMerchantAccounts();

  let newCount = 0;
  let activatedCount = 0;

  // Log the first merchant's full structure so we can see what fields are available
  if (rawMerchants.length > 0) {
    const sample = rawMerchants[0];
    const attrs = sample.merchantAccountAttributes || sample.customAttributes || sample.attributes || [];
    console.log('🔍 Zentact first merchant keys:', Object.keys(sample).join(', '));
    console.log('🔍 Zentact first merchant attributes:', JSON.stringify(attrs).slice(0, 500));
  }

  for (const raw of rawMerchants) {
    const m = zentact.transformMerchant(raw);

    // --- Rep name resolution ---
    // Zentact uses { name: 'sales_rep', value: 'FirstName' } — match against salespeople table
    let repName = null;
    if (m.sales_rep_raw) {
      // 1. Exact match (handles if Zentact stores full names)
      const exactRes = await pool.query(
        `SELECT name FROM salespeople WHERE LOWER(name) = LOWER($1) LIMIT 1`,
        [m.sales_rep_raw]
      );
      repName = exactRes.rows[0]?.name || null;

      // 2. First-name prefix match — "Dora" → "Dora Smith"
      if (!repName) {
        const firstRes = await pool.query(
          `SELECT name FROM salespeople
           WHERE LOWER(name) ILIKE LOWER($1) || ' %'
              OR LOWER(name) ILIKE '% ' || LOWER($1)
           LIMIT 1`,
          [m.sales_rep_raw]
        );
        repName = firstRes.rows[0]?.name || null;
      }

      // 3. Use the raw value as-is so the merchant is never "Unassigned"
      //    (admin can later merge via Salespeople panel if the name doesn't match)
      if (!repName) repName = m.sales_rep_raw;
    }

    // 4. Fallback: email lookup (legacy / other orgs)
    if (!repName && m.sales_rep_email) {
      const userRes = await pool.query(
        `SELECT display_name FROM user_tokens WHERE LOWER(email) = LOWER($1) LIMIT 1`,
        [m.sales_rep_email]
      );
      repName = userRes.rows[0]?.display_name || null;
    }
    // 5. Fallback: Opportunity_ID → crm_sold_deals.owner_name
    if (!repName && m.opportunity_id) {
      const dealRes = await pool.query(
        `SELECT owner_name FROM crm_sold_deals WHERE deal_id = $1 LIMIT 1`,
        [m.opportunity_id]
      );
      repName = dealRes.rows[0]?.owner_name || null;
    }
    // 6. Fall back to the existing rep name already in DB (don't overwrite with a worse value)

    if (m.status === 'ACTIVE') activatedCount++;

    // For ACTIVE merchants, look up the real activation date from the merchant's
    // earliest payment transaction. We only do this if we don't already have a
    // date in the DB (lookup is expensive — one API call per merchant).
    let activatedAt = null;
    if (m.status === 'ACTIVE') {
      const existing = await pool.query(
        `SELECT activated_at FROM zentact_merchants WHERE merchant_account_id = $1`,
        [m.merchant_account_id]
      );
      const currentDate = existing.rows[0]?.activated_at;

      // Re-lookup the real date if missing OR if the stored date looks like a
      // bulk-import stamp (created_at === activated_at on the same day)
      if (!currentDate) {
        try {
          activatedAt = await zentact.getEarliestTransactionDate(m.merchant_account_id);
        } catch (e) {
          console.warn(`⚠️ Could not fetch earliest tx date for ${m.merchant_account_id}:`, e.message);
        }
        // If no transactions yet, leave NULL — merchant is approved but hasn't processed
      } else {
        activatedAt = currentDate;
      }
    }

    const result = await pool.query(`
      INSERT INTO zentact_merchants
        (merchant_account_id, organization_id, business_name, invitee_email, status,
         sales_rep_email, sales_rep_name, opportunity_id, activated_at, raw_attributes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
      ON CONFLICT (merchant_account_id) DO UPDATE SET
        status          = EXCLUDED.status,
        business_name   = EXCLUDED.business_name,
        sales_rep_email = COALESCE(EXCLUDED.sales_rep_email, zentact_merchants.sales_rep_email),
        sales_rep_name  = COALESCE($7, zentact_merchants.sales_rep_name),
        opportunity_id  = COALESCE(EXCLUDED.opportunity_id,  zentact_merchants.opportunity_id),
        activated_at    = CASE
          -- Keep any existing date (never overwrite a real stamp)
          WHEN zentact_merchants.activated_at IS NOT NULL
            THEN zentact_merchants.activated_at
          -- First time we see this merchant as ACTIVE → stamp today
          WHEN EXCLUDED.status = 'ACTIVE'
            THEN COALESCE(zentact_merchants.activated_at, EXCLUDED.activated_at)
          ELSE NULL
        END,
        raw_attributes  = EXCLUDED.raw_attributes,
        updated_at      = CURRENT_TIMESTAMP
      RETURNING (xmax = 0) AS inserted
    `, [m.merchant_account_id, m.organization_id, m.business_name, m.invitee_email,
        m.status, m.sales_rep_email, repName, m.opportunity_id, activatedAt, m.raw_attributes]);

    if (result.rows[0]?.inserted) newCount++;
  }

  // Upsert resolved rep names into salespeople table so they appear in the tracker
  const activeRepsRes = await pool.query(
    `SELECT DISTINCT sales_rep_name FROM zentact_merchants
     WHERE sales_rep_name IS NOT NULL AND sales_rep_name <> ''`
  );
  for (const row of activeRepsRes.rows) {
    await pool.query(
      `INSERT INTO salespeople (name, is_active) VALUES ($1, true) ON CONFLICT (name) DO NOTHING`,
      [row.sales_rep_name]
    );
  }

  console.log(`✅ Zentact sync: ${rawMerchants.length} total, ${activatedCount} active, ${newCount} new`);
  return { total: rawMerchants.length, active: activatedCount, newCount };
}

// ============================================================================
// TOKEN HELPER - Refresh token if expired
// ============================================================================

async function ensureValidToken(email) {
  const tokenResult = await pool.query(
    'SELECT access_token, refresh_token, api_domain, expires_at FROM user_tokens WHERE email = $1',
    [email]
  );

  if (!tokenResult.rows.length) {
    throw new Error('No token found');
  }

  let tokenData = tokenResult.rows[0];
  const expiresAtMs = tokenData.expires_at ? parseInt(tokenData.expires_at) : null;
  const expiresAt = expiresAtMs ? new Date(expiresAtMs) : null;

  // If token is expired or expires in less than 5 minutes, refresh it
  if (expiresAt && expiresAt < new Date(Date.now() + 5 * 60 * 1000)) {
    if (!tokenData.refresh_token) {
      console.log(`⚠️ Token expired for ${email} but no refresh_token available`);
      return tokenData;
    }

    console.log(`🔄 Refreshing token for ${email}`);
    try {
      const refreshResponse = await axios.post(
        'https://accounts.zoho.com/oauth/v2/token',
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: process.env.ZOHO_CLIENT_ID,
          client_secret: process.env.ZOHO_CLIENT_SECRET,
          refresh_token: tokenData.refresh_token,
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      const newAccessToken = refreshResponse.data.access_token;
      const newExpiresIn = parseInt(refreshResponse.data.expires_in) || 3600;
      const newExpiresAt = Date.now() + (newExpiresIn * 1000);

      await pool.query(
        `UPDATE user_tokens SET access_token = $1, expires_at = $2, updated_at = CURRENT_TIMESTAMP WHERE email = $3`,
        [newAccessToken, newExpiresAt, email]
      );

      tokenData.access_token = newAccessToken;
      console.log(`✅ Token refreshed for ${email}`);
    } catch (error) {
      console.error(`❌ Token refresh failed for ${email}:`, error.message);
    }
  }

  return tokenData;
}

// ============================================================================
// CRM TOKEN HELPER - Get and auto-refresh CRM access token
// ============================================================================

async function ensureValidCrmToken() {
  const result = await pool.query(
    `SELECT crm_access_token, crm_refresh_token, crm_expires_at
     FROM user_tokens WHERE is_admin = true AND crm_access_token IS NOT NULL
     ORDER BY updated_at DESC LIMIT 1`
  );

  if (!result.rows.length) {
    throw new Error('CRM not connected. Please connect Zoho CRM in the Admin Panel.');
  }

  let row = result.rows[0];
  const expiresAt = row.crm_expires_at ? parseInt(row.crm_expires_at) : null;

  // Refresh if: token is expired/expiring within 5 min, OR expiry unknown
  const needsRefresh = !expiresAt || expiresAt < Date.now() + 5 * 60 * 1000;

  if (needsRefresh) {
    if (!row.crm_refresh_token) {
      if (!expiresAt) {
        // No expiry info — assume token is still valid and proceed
        console.log('⚠️ CRM token has no expiry info, proceeding with existing token');
        return row.crm_access_token;
      }
      throw new Error('CRM token expired and no refresh token available. Please reconnect CRM in Admin Panel.');
    }

    console.log('🔄 Refreshing CRM token...');
    try {
      const refreshRes = await axios.post(
        'https://accounts.zoho.com/oauth/v2/token',
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: process.env.ZOHO_CLIENT_ID,
          client_secret: process.env.ZOHO_CLIENT_SECRET,
          refresh_token: row.crm_refresh_token,
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );

      const newToken = refreshRes.data.access_token;
      const newRefreshToken = refreshRes.data.refresh_token || row.crm_refresh_token;
      const newExpiry = Date.now() + (parseInt(refreshRes.data.expires_in) || 3600) * 1000;

      if (!newToken) {
        throw new Error(`Zoho refresh returned no access_token: ${JSON.stringify(refreshRes.data)}`);
      }

      await pool.query(
        `UPDATE user_tokens
         SET crm_access_token = $1, crm_refresh_token = $2, crm_expires_at = $3, updated_at = CURRENT_TIMESTAMP
         WHERE is_admin = true`,
        [newToken, newRefreshToken, newExpiry]
      );

      console.log('✅ CRM token refreshed successfully');
      return newToken;
    } catch (err) {
      console.error('❌ CRM token refresh failed:', err.response?.data || err.message);
      // If we have a non-expired token, use it as fallback; otherwise throw
      if (expiresAt && expiresAt > Date.now()) {
        console.warn('⚠️ Using existing token despite refresh failure (still valid)');
        return row.crm_access_token;
      }
      throw new Error(`CRM token expired and refresh failed: ${err.message}. Please reconnect CRM in Admin Panel.`);
    }
  }

  return row.crm_access_token;
}

// ============================================================================
// SYNC INVOICES FROM ZOHO TO DATABASE
// ============================================================================

app.post('/api/sync/invoices', authenticateToken, async (req, res) => {
  try {
    console.log('🔄 Starting invoice sync from Zoho...');
    const { email, isAdmin } = req.user;

    if (!isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // Get latest access token
    const tokenResult = await pool.query(
      'SELECT access_token, api_domain FROM user_tokens WHERE email = $1',
      [email]
    );

    if (!tokenResult.rows[0]) {
      return res.status(401).json({ error: 'No valid token' });
    }

    const tokenData = tokenResult.rows[0];

    // Fetch PAID invoices from Zoho
    const paidResponse = await axios.get(
      `${tokenData.api_domain}/books/v3/invoices`,
      {
        params: {
          organization_id: process.env.ZOHO_ORG_ID,
          status: 'paid',
        },
        headers: {
          'Authorization': `Zoho-oauthtoken ${tokenData.access_token}`,
        },
      }
    );

    // Fetch OVERDUE invoices from Zoho
    const overdueResponse = await axios.get(
      `${tokenData.api_domain}/books/v3/invoices`,
      {
        params: {
          organization_id: process.env.ZOHO_ORG_ID,
          status: 'overdue',
        },
        headers: {
          'Authorization': `Zoho-oauthtoken ${tokenData.access_token}`,
        },
      }
    );

    const paidInvoices = (paidResponse.data.invoices || []).map(inv => ({ ...inv, status: 'paid' }));
    const overdueInvoices = (overdueResponse.data.invoices || []).map(inv => ({ ...inv, status: 'overdue' }));
    const allInvoices = [...paidInvoices, ...overdueInvoices];

    console.log(`📥 Fetched ${paidInvoices.length} paid and ${overdueInvoices.length} overdue invoices`);

    // Insert invoices into database
    for (const inv of allInvoices) {
      const salesperson = inv.salesperson_name || 'Unassigned';
      const customerName = inv.customer_name || inv.contact_name || null;
      const total = parseFloat(inv.total) || 0;
      const commission = inv.status === 'paid' ? (total * 0.1) : 0;
      const invDate = new Date(inv.date || new Date());

      await pool.query(
        `INSERT INTO invoices
         (invoice_number, salesperson_name, customer_name, total, status, date, commission, organization_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (invoice_number) DO UPDATE SET
         status = $5, total = $4, commission = $7, customer_name = COALESCE($3, invoices.customer_name),
         updated_at = CURRENT_TIMESTAMP`,
        [inv.invoice_number, salesperson, customerName, total, inv.status, invDate, commission, process.env.ZOHO_ORG_ID]
      );
    }

    console.log(`✅ Synced ${allInvoices.length} invoices to database`);
    res.json({ synced: allInvoices.length, paid: paidInvoices.length, overdue: overdueInvoices.length });
  } catch (error) {
    console.error('❌ Sync error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Get commission data
app.get('/api/commissions', authenticateToken, async (req, res) => {
  const { email, isAdmin } = req.user;
  const { start, end, repName } = req.query;

  try {
    // Get token from database
    const tokenResult = await pool.query(
      'SELECT access_token, refresh_token, api_domain, expires_at FROM user_tokens WHERE email = $1',
      [email]
    );

    if (!tokenResult.rows.length) {
      return res.status(401).json({ error: 'No Zoho token found' });
    }

    let tokenData = tokenResult.rows[0];
    let accessToken = tokenData.access_token;

    // Check if token needs refresh
    if (Date.now() >= tokenData.expires_at) {
      console.log('Refreshing expired token...');
      const refreshResponse = await axios.post(
        `${ZOHO_CONFIG.accounts_url}/oauth/v2/token`,
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: ZOHO_CONFIG.client_id,
          client_secret: ZOHO_CONFIG.client_secret,
          refresh_token: tokenData.refresh_token,
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      accessToken = refreshResponse.data.access_token;
      
      // Update token in database
      await pool.query(
        `UPDATE user_tokens SET access_token = $1, expires_at = $2, updated_at = CURRENT_TIMESTAMP 
         WHERE email = $3`,
        [accessToken, Date.now() + refreshResponse.data.expires_in * 1000, email]
      );
    }

    console.log('📊 Fetching commissions from database...');
    console.log('📅 Date range:', start, 'to', end);

    // Parse dates properly - add end of day to end date
    const startDate = new Date(start);
    const endDate = new Date(end);
    endDate.setHours(23, 59, 59, 999); // Set to end of day

    console.log('📅 Parsed dates:', startDate, 'to', endDate);

    // Query database for PAID invoices only
    let query = `
      SELECT 
        salesperson_name,
        COUNT(*) as invoices,
        SUM(commission) as total_commission
      FROM invoices
      WHERE organization_id = $1
      AND status = 'paid'
      AND date >= $2
      AND date <= $3
    `;
    
    const params = [process.env.ZOHO_ORG_ID, startDate, endDate];
    let paramIndex = 4;

    // If not admin, only show their data
    if (!isAdmin) {
      query += ` AND salesperson_name = $${paramIndex}`;
      params.push(repName || email);
      paramIndex++;
    }

    query += ` GROUP BY salesperson_name ORDER BY total_commission DESC`;

    const commResult = await pool.query(query, params);

    // Format commissions response
    const commissions = commResult.rows.map(row => ({
      repName: row.salesperson_name,
      invoices: parseInt(row.invoices),
      commission: parseFloat(row.total_commission) || 0,
      avgPerInvoice: (parseFloat(row.total_commission) / parseInt(row.invoices)) || 0
    }));

    console.log(`✅ Found ${commissions.length} reps with paid invoices`);

    // Get all invoices (for invoices tab)
    let invQuery = `
      SELECT * FROM invoices 
      WHERE organization_id = $1
      AND date BETWEEN $2 AND $3
    `;
    
    const invParams = [process.env.ZOHO_ORG_ID, new Date(start), new Date(end)];
    let invParamIndex = 4;
    
    if (!isAdmin) {
      invQuery += ` AND salesperson_name = $${invParamIndex}`;
      invParams.push(repName || email);
    }
    
    invQuery += ` ORDER BY date DESC`;

    const invResult = await pool.query(invQuery, invParams);

    console.log(`✅ Returning ${invResult.rows.length} invoices`);
    res.json({ 
      commissions,
      invoices: invResult.rows 
    });
  } catch (error) {
    console.error('Commission API error:', error.message);
    console.error('Zoho API response status:', error.response?.status);
    console.error('Zoho API response data:', JSON.stringify(error.response?.data, null, 2));
    
    res.status(500).json({ 
      error: 'Failed to fetch commissions',
      details: error.message,
    });
  }
});

// ============================================================================
// COMMISSION CALCULATION
// ============================================================================

function calculateCommissions(invoices, user, startDate, endDate) {
  const commissionsMap = new Map();
  
  // Parse dates and set time appropriately
  const start = new Date(startDate);
  start.setHours(0, 0, 0, 0); // Start of day
  
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999); // End of day

  console.log(`Filtering invoices from ${start.toISOString()} to ${end.toISOString()}`);

  invoices.forEach((invoice) => {
    const salesRep = invoice.salesperson_name || 'Unassigned';
    
    // Filter by date range
    const invoiceDate = new Date(invoice.date);
    if (invoiceDate < start || invoiceDate > end) {
      console.log(`Skipping invoice ${invoice.invoice_number} - date ${invoiceDate.toISOString()} outside range`);
      return;
    }

    // Get total invoice amount
    const invoiceTotal = parseFloat(invoice.total || 0);
    
    // Calculate 10% commission on total invoice amount
    const commission = invoiceTotal * 0.10;

    console.log(`Invoice: ${invoice.invoice_number}, Rep: ${salesRep}, Total: ${invoiceTotal}, Commission: ${commission}`);

    // Aggregate by sales rep
    if (commissionsMap.has(salesRep)) {
      const existing = commissionsMap.get(salesRep);
      const newTotal = existing.commission + commission;
      commissionsMap.set(salesRep, {
        repName: salesRep,
        invoices: existing.invoices + 1,
        commission: newTotal,
        avgPerInvoice: newTotal / (existing.invoices + 1),
      });
    } else {
      commissionsMap.set(salesRep, {
        repName: salesRep,
        invoices: 1,
        commission: commission,
        avgPerInvoice: commission,
      });
    }
  });

  console.log('Final commissions:', Array.from(commissionsMap.values()));
  return Array.from(commissionsMap.values());
}

// ============================================================================
// INVOICES API ENDPOINT
// ============================================================================

app.get('/api/invoices', authenticateToken, async (req, res) => {
  const { email, isAdmin } = req.user;
  const { start, end, salesperson } = req.query;

  try {
    const startDate = new Date(start || new Date().getFullYear() + '-01-01');
    const endDate = new Date(end || new Date().toISOString().split('T')[0]);
    endDate.setHours(23, 59, 59, 999);

    console.log('📄 Fetching invoices from database...');

    let query = `
      SELECT
        invoice_number,
        salesperson_name,
        customer_name,
        date,
        total,
        commission,
        commission_paid,
        status
      FROM invoices
      WHERE organization_id = $1
      AND date >= $2
      AND date <= $3
    `;

    const params = [process.env.ZOHO_ORG_ID, startDate, endDate];
    let paramIndex = 4;

    // Handle comma-separated salesperson filter
    if (salesperson) {
      const names = salesperson.split(',').map(s => s.trim()).filter(Boolean);
      if (names.length === 1) {
        query += ` AND salesperson_name = $${paramIndex}`;
        params.push(names[0]);
        paramIndex++;
      } else if (names.length > 1) {
        const placeholders = names.map((_, i) => `$${paramIndex + i}`).join(', ');
        query += ` AND salesperson_name IN (${placeholders})`;
        params.push(...names);
        paramIndex += names.length;
      }
    } else if (!isAdmin) {
      // Non-admins only see their own invoices
      const tokenResult = await pool.query('SELECT display_name FROM user_tokens WHERE email = $1', [email]);
      const myName = tokenResult.rows[0]?.display_name || req.user.name;
      if (myName) {
        query += ` AND salesperson_name = $${paramIndex}`;
        params.push(myName);
        paramIndex++;
      }
    }

    query += ` ORDER BY date DESC`;

    const result = await pool.query(query, params);

    const invoices = result.rows.map(row => ({
      invoice_number: row.invoice_number,
      salesperson_name: row.salesperson_name || 'Unassigned',
      customer_name: row.customer_name || '',
      date: row.date,
      total: parseFloat(row.total) || 0,
      commission: parseFloat(row.commission) || 0,
      commissionPaid: row.commission_paid || false,
      status: row.status,
    }));

    console.log(`✅ Found ${invoices.length} invoices`);
    res.json({ invoices, dateRange: { start: startDate, end: endDate } });
  } catch (error) {
    console.error('❌ Error fetching invoices:', error);
    res.status(500).json({ error: 'Failed to fetch invoices', details: error.message });
  }
});

// ============================================================================
// USER PROFILE & PREFERENCES
// ============================================================================

// GET /api/user/profile
app.get('/api/user/profile', authenticateToken, async (req, res) => {
  const { email } = req.user;
  try {
    const tokenResult = await pool.query(
      'SELECT email, photo, display_name, is_admin, created_at FROM user_tokens WHERE email = $1',
      [email]
    );
    const td = tokenResult.rows[0] || {};

    const prefResult = await pool.query(
      'SELECT language, currency, date_format, timezone FROM user_preferences WHERE email = $1',
      [email]
    );
    const prefs = prefResult.rows[0] || {};

    const repName = td.display_name || req.user.name || email;

    const statsResult = await pool.query(
      `SELECT COUNT(*) AS paid_invoices,
              COALESCE(SUM(commission), 0) AS total_commission,
              COALESCE(SUM(total), 0) AS total_revenue
       FROM invoices
       WHERE salesperson_name = $1 AND status = 'paid' AND organization_id = $2`,
      [repName, process.env.ZOHO_ORG_ID]
    );
    const stats = statsResult.rows[0] || {};

    const spResult = await pool.query(
      'SELECT name, is_active, commission_rate FROM salespeople WHERE name = $1',
      [repName]
    );
    const sp = spResult.rows[0];

    res.json({
      email: td.email || email,
      name: td.display_name || req.user.name || email,
      photo: td.photo || req.user.photo || null,
      isAdmin: td.is_admin != null ? td.is_admin : (req.user.isAdmin || false),
      preferences: {
        language:   prefs.language    || 'en',
        currency:   prefs.currency    || 'CAD',
        dateFormat: prefs.date_format || 'YYYY-MM-DD',
        timezone:   prefs.timezone    || 'America/Toronto',
      },
      salesperson: sp ? {
        name:           sp.name,
        isActive:       sp.is_active,
        commissionRate: parseFloat(sp.commission_rate) || 10,
      } : null,
      stats: {
        paidInvoices:    parseInt(stats.paid_invoices)    || 0,
        totalCommission: parseFloat(stats.total_commission) || 0,
        totalRevenue:    parseFloat(stats.total_revenue)   || 0,
      },
      memberSince: td.created_at || null,
    });
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({ error: 'Failed to fetch profile', details: error.message });
  }
});

// PUT /api/user/preferences
app.put('/api/user/preferences', authenticateToken, async (req, res) => {
  const { email } = req.user;
  const { displayName, language, currency, dateFormat, timezone } = req.body;
  try {
    if (displayName !== undefined) {
      await pool.query(
        `UPDATE user_tokens SET display_name = $1, updated_at = CURRENT_TIMESTAMP WHERE email = $2`,
        [displayName, email]
      );
    }
    await pool.query(
      `INSERT INTO user_preferences (email, language, currency, date_format, timezone)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO UPDATE SET
         language = $2, currency = $3, date_format = $4, timezone = $5,
         updated_at = CURRENT_TIMESTAMP`,
      [email, language || 'en', currency || 'CAD', dateFormat || 'YYYY-MM-DD', timezone || 'America/Toronto']
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Preferences error:', error);
    res.status(500).json({ error: 'Failed to save preferences', details: error.message });
  }
});

// ============================================================================
// DASHBOARD
// ============================================================================

// GET /api/dashboard?year=
app.get('/api/dashboard', authenticateToken, async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  try {
    const startDate = new Date(year, 0, 1);
    const endDate   = new Date(year, 11, 31, 23, 59, 59, 999);

    const cardsResult = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'paid'    THEN total ELSE 0 END), 0) AS paid_revenue,
        COALESCE(SUM(CASE WHEN status = 'paid'    THEN commission ELSE 0 END), 0) AS total_commission,
        COUNT(*)                                                               AS total_invoices,
        COALESCE(SUM(CASE WHEN status = 'overdue' THEN total ELSE 0 END), 0) AS overdue_amount,
        COUNT(CASE WHEN status = 'paid'    THEN 1 END)                       AS paid_count,
        COUNT(CASE WHEN status = 'overdue' THEN 1 END)                       AS overdue_count
      FROM invoices
      WHERE organization_id = $1 AND date >= $2 AND date <= $3
    `, [process.env.ZOHO_ORG_ID, startDate, endDate]);

    const monthlyResult = await pool.query(`
      SELECT
        TO_CHAR(date, 'Mon') AS month,
        EXTRACT(MONTH FROM date) AS month_num,
        COALESCE(SUM(CASE WHEN status = 'paid'    THEN total ELSE 0 END), 0) AS revenue,
        COALESCE(SUM(CASE WHEN status = 'overdue' THEN total ELSE 0 END), 0) AS overdue,
        COALESCE(SUM(CASE WHEN status = 'paid'    THEN commission ELSE 0 END), 0) AS commission
      FROM invoices
      WHERE organization_id = $1 AND date >= $2 AND date <= $3
      GROUP BY TO_CHAR(date, 'Mon'), EXTRACT(MONTH FROM date)
      ORDER BY month_num
    `, [process.env.ZOHO_ORG_ID, startDate, endDate]);

    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const mmap = {};
    monthlyResult.rows.forEach(r => { mmap[r.month] = r; });
    const monthlyTrend = MONTHS.map(m => ({
      month:      m,
      revenue:    parseFloat(mmap[m]?.revenue)    || 0,
      overdue:    parseFloat(mmap[m]?.overdue)    || 0,
      commission: parseFloat(mmap[m]?.commission) || 0,
    }));

    const repResult = await pool.query(`
      SELECT salesperson_name AS name,
             COUNT(*) AS invoices,
             COALESCE(SUM(total), 0) AS sales,
             COALESCE(SUM(commission), 0) AS commission
      FROM invoices
      WHERE organization_id = $1 AND status = 'paid' AND date >= $2 AND date <= $3
      GROUP BY salesperson_name ORDER BY commission DESC LIMIT 10
    `, [process.env.ZOHO_ORG_ID, startDate, endDate]);

    const statusResult = await pool.query(`
      SELECT status, COUNT(*) AS count, COALESCE(SUM(total), 0) AS total
      FROM invoices WHERE organization_id = $1 AND date >= $2 AND date <= $3
      GROUP BY status
    `, [process.env.ZOHO_ORG_ID, startDate, endDate]);

    const customerResult = await pool.query(`
      SELECT
        COALESCE(NULLIF(TRIM(customer_name), ''), 'Unknown') AS name,
        COUNT(*) AS invoices,
        COALESCE(SUM(total), 0) AS total
      FROM invoices
      WHERE organization_id = $1 AND status = 'paid' AND date >= $2 AND date <= $3
        AND COALESCE(NULLIF(TRIM(customer_name), ''), '') != ''
      GROUP BY COALESCE(NULLIF(TRIM(customer_name), ''), 'Unknown')
      ORDER BY total DESC LIMIT 10
    `, [process.env.ZOHO_ORG_ID, startDate, endDate]);

    const recentResult = await pool.query(`
      SELECT invoice_number, customer_name, salesperson_name, total, commission, status, date
      FROM invoices
      WHERE organization_id = $1 AND date >= $2 AND date <= $3
      ORDER BY date DESC LIMIT 20
    `, [process.env.ZOHO_ORG_ID, startDate, endDate]);

    const cards = cardsResult.rows[0] || {};
    res.json({
      cards: {
        paidRevenue:     parseFloat(cards.paid_revenue)     || 0,
        totalCommission: parseFloat(cards.total_commission) || 0,
        totalInvoices:   parseInt(cards.total_invoices)     || 0,
        overdueAmount:   parseFloat(cards.overdue_amount)   || 0,
        paidCount:       parseInt(cards.paid_count)         || 0,
        overdueCount:    parseInt(cards.overdue_count)      || 0,
      },
      monthlyTrend,
      commissionsByRep: repResult.rows.map(r => ({
        name:       r.name,
        invoices:   parseInt(r.invoices),
        sales:      parseFloat(r.sales),
        commission: parseFloat(r.commission),
      })),
      statusBreakdown: statusResult.rows.map(r => ({
        status: r.status,
        count:  parseInt(r.count),
        total:  parseFloat(r.total),
      })),
      topCustomers: customerResult.rows.map(r => ({
        name:     r.name,
        invoices: parseInt(r.invoices),
        total:    parseFloat(r.total),
      })),
      recentInvoices: recentResult.rows.map(r => ({
        invoiceNumber: r.invoice_number,
        customer:      r.customer_name || 'Unknown',
        salesperson:   r.salesperson_name || 'Unknown',
        total:         parseFloat(r.total),
        commission:    parseFloat(r.commission),
        status:        r.status,
        date:          r.date,
      })),
      year,
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard data', details: error.message });
  }
});

// ============================================================================
// INVOICES ADDITIONAL ENDPOINTS
// ============================================================================

// GET /api/invoices/stats
app.get('/api/invoices/stats', authenticateToken, async (req, res) => {
  const { start, end, salesperson } = req.query;
  try {
    const startDate = new Date(start || new Date().getFullYear() + '-01-01');
    const endDate   = new Date(end   || new Date().toISOString().split('T')[0]);
    endDate.setHours(23, 59, 59, 999);

    let where = `WHERE organization_id = $1 AND date >= $2 AND date <= $3`;
    const params = [process.env.ZOHO_ORG_ID, startDate, endDate];
    let idx = 4;

    if (salesperson) {
      const names = salesperson.split(',').map(s => s.trim()).filter(Boolean);
      if (names.length === 1) {
        where += ` AND salesperson_name = $${idx}`;
        params.push(names[0]); idx++;
      } else if (names.length > 1) {
        const ph = names.map((_, i) => `$${idx + i}`).join(', ');
        where += ` AND salesperson_name IN (${ph})`;
        params.push(...names); idx += names.length;
      }
    }

    const result = await pool.query(`
      SELECT
        COUNT(*) AS total_invoices,
        COALESCE(SUM(CASE WHEN status = 'paid'    THEN total ELSE 0 END), 0) AS paid_total,
        COALESCE(SUM(CASE WHEN status = 'overdue' THEN total ELSE 0 END), 0) AS overdue_total,
        COALESCE(SUM(total), 0)                                               AS total_amount,
        COALESCE(SUM(CASE WHEN status = 'paid'    THEN commission ELSE 0 END), 0) AS total_commission
      FROM invoices ${where}
    `, params);

    const row = result.rows[0] || {};
    res.json({
      totalInvoices:   parseInt(row.total_invoices)    || 0,
      paidTotal:       parseFloat(row.paid_total)      || 0,
      overdueTotal:    parseFloat(row.overdue_total)   || 0,
      totalAmount:     parseFloat(row.total_amount)    || 0,
      totalCommission: parseFloat(row.total_commission) || 0,
    });
  } catch (error) {
    console.error('Invoices stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats', details: error.message });
  }
});

// POST /api/invoices/sync — admin-triggered sync
app.post('/api/invoices/sync', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  try {
    await autoSyncInvoices();
    res.json({ success: true, message: 'Sync completed' });
  } catch (error) {
    res.status(500).json({ error: 'Sync failed', details: error.message });
  }
});

// POST /api/invoices/incremental-sync
app.post('/api/invoices/incremental-sync', authenticateToken, async (req, res) => {
  try {
    await autoSyncInvoices();
    const countResult = await pool.query(
      'SELECT COUNT(*) AS cnt FROM invoices WHERE organization_id = $1',
      [process.env.ZOHO_ORG_ID]
    );
    res.json({ success: true, totalSynced: parseInt(countResult.rows[0].cnt) || 0, needsBulkImport: false });
  } catch (error) {
    res.status(500).json({ error: 'Incremental sync failed', details: error.message });
  }
});

// POST /api/invoices/bulk-import
app.post('/api/invoices/bulk-import', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  try {
    await autoSyncInvoices();
    const countResult = await pool.query(
      'SELECT COUNT(*) AS cnt FROM invoices WHERE organization_id = $1',
      [process.env.ZOHO_ORG_ID]
    );
    res.json({ success: true, imported: parseInt(countResult.rows[0].cnt) || 0 });
  } catch (error) {
    res.status(500).json({ error: 'Bulk import failed', details: error.message });
  }
});

// GET /api/invoices/:invoiceNumber/pdf
app.get('/api/invoices/:invoiceNumber/pdf', authenticateToken, async (req, res) => {
  res.status(501).json({ error: 'PDF download not yet implemented' });
});

// GET /api/invoices/:invoiceNumber/preview
app.get('/api/invoices/:invoiceNumber/preview', (req, res) => {
  res.status(501).send('<html><body style="font-family:sans-serif;padding:2rem"><p>Preview not yet implemented</p></body></html>');
});

// POST /api/invoices/:invoiceNumber/email
app.post('/api/invoices/:invoiceNumber/email', authenticateToken, async (req, res) => {
  res.status(501).json({ error: 'Email sending not yet implemented' });
});

// ============================================================================
// SALESPEOPLE
// ============================================================================

// GET /api/salespeople — names for dropdown filters
app.get('/api/salespeople', authenticateToken, async (req, res) => {
  try {
    const spResult = await pool.query('SELECT name FROM salespeople ORDER BY name');
    if (spResult.rows.length > 0) {
      return res.json({ salespeople: spResult.rows.map(r => r.name) });
    }
    const invResult = await pool.query(
      `SELECT DISTINCT salesperson_name FROM invoices
       WHERE organization_id = $1 AND salesperson_name IS NOT NULL
         AND salesperson_name != 'Unassigned'
       ORDER BY salesperson_name`,
      [process.env.ZOHO_ORG_ID]
    );
    res.json({ salespeople: invResult.rows.map(r => r.salesperson_name) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch salespeople', details: error.message });
  }
});

// GET /api/salespeople/all — full records with stats (admin)
app.get('/api/salespeople/all', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  try {
    // Auto-register reps from invoices
    await pool.query(`
      INSERT INTO salespeople (name)
      SELECT DISTINCT salesperson_name FROM invoices
      WHERE salesperson_name IS NOT NULL AND salesperson_name != 'Unassigned'
        AND salesperson_name NOT IN (SELECT name FROM salespeople)
      ON CONFLICT (name) DO NOTHING
    `);
    // Update invoice counts
    await pool.query(`
      UPDATE salespeople sp SET invoice_count = (
        SELECT COUNT(*) FROM invoices i
        WHERE i.salesperson_name = sp.name AND i.organization_id = $1 AND i.status = 'paid'
      )
    `, [process.env.ZOHO_ORG_ID]);

    const result = await pool.query(
      `SELECT name, is_active, commission_rate, base_salary, invoice_count
       FROM salespeople ORDER BY name`
    );
    res.json({
      salespeople: result.rows.map(r => ({
        name:           r.name,
        isActive:       r.is_active,
        commissionRate: parseFloat(r.commission_rate) || 10,
        baseSalary:     parseFloat(r.base_salary)     || 0,
        invoiceCount:   parseInt(r.invoice_count)     || 0,
      }))
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch salespeople', details: error.message });
  }
});

// PUT /api/salespeople/:name/status
app.put('/api/salespeople/:name/status', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  const { isActive } = req.body;
  try {
    await pool.query(
      `INSERT INTO salespeople (name, is_active) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET is_active = $2, updated_at = CURRENT_TIMESTAMP`,
      [req.params.name, isActive]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update status', details: error.message });
  }
});

// PUT /api/salespeople/:name/commission-rate
app.put('/api/salespeople/:name/commission-rate', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  const { commissionRate } = req.body;
  try {
    await pool.query(
      `INSERT INTO salespeople (name, commission_rate) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET commission_rate = $2, updated_at = CURRENT_TIMESTAMP`,
      [req.params.name, parseFloat(commissionRate) || 10]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update commission rate', details: error.message });
  }
});

// PUT /api/salespeople/:name/base-salary
app.put('/api/salespeople/:name/base-salary', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  const { baseSalary } = req.body;
  try {
    await pool.query(
      `INSERT INTO salespeople (name, base_salary) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET base_salary = $2, updated_at = CURRENT_TIMESTAMP`,
      [req.params.name, parseFloat(baseSalary) || 0]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update base salary', details: error.message });
  }
});

// ============================================================================
// ADMIN USERS
// ============================================================================

// GET /api/admin/users
app.get('/api/admin/users', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  try {
    const result = await pool.query(
      `SELECT email, is_admin, created_at, updated_at AS last_login
       FROM user_tokens ORDER BY created_at DESC`
    );
    res.json({
      users: result.rows.map(r => ({
        email:     r.email,
        isAdmin:   r.is_admin,
        createdAt: r.created_at,
        lastLogin: r.last_login,
      }))
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch users', details: error.message });
  }
});

// PUT /api/admin/users/:email/admin
app.put('/api/admin/users/:email/admin', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  const targetEmail = decodeURIComponent(req.params.email);
  const { makeAdmin } = req.body;
  if (targetEmail === req.user.email && !makeAdmin) {
    return res.status(400).json({ error: 'Cannot remove your own admin status' });
  }
  try {
    await pool.query(
      `UPDATE user_tokens SET is_admin = $1, updated_at = CURRENT_TIMESTAMP WHERE email = $2`,
      [makeAdmin, targetEmail]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update admin status', details: error.message });
  }
});

// ============================================================================
// EXCLUDED CUSTOMERS
// ============================================================================

// GET /api/excluded-customers
app.get('/api/excluded-customers', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  try {
    const result = await pool.query(
      `SELECT id, customer_name, excluded_by, created_at FROM excluded_customers
       WHERE organization_id = $1 ORDER BY customer_name`,
      [process.env.ZOHO_ORG_ID]
    );
    res.json({ excludedCustomers: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch excluded customers', details: error.message });
  }
});

// POST /api/excluded-customers
app.post('/api/excluded-customers', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  const { customerName } = req.body;
  if (!customerName) return res.status(400).json({ error: 'customerName required' });
  try {
    await pool.query(
      `INSERT INTO excluded_customers (customer_name, excluded_by, organization_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [customerName, req.user.email, process.env.ZOHO_ORG_ID]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to exclude customer', details: error.message });
  }
});

// DELETE /api/excluded-customers/:id
app.delete('/api/excluded-customers/:id', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  try {
    await pool.query(`DELETE FROM excluded_customers WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove exclusion', details: error.message });
  }
});

// GET /api/customers/search?q=
app.get('/api/customers/search', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  const { q } = req.query;
  if (!q || q.length < 2) return res.json({ customers: [] });
  try {
    const result = await pool.query(
      `SELECT
         customer_name AS name,
         COUNT(*) AS invoice_count,
         COALESCE(SUM(total), 0) AS total_spent
       FROM invoices
       WHERE organization_id = $1 AND customer_name ILIKE $2
         AND (customer_name NOT IN (
           SELECT customer_name FROM excluded_customers WHERE organization_id = $1
         ) OR customer_name IS NULL)
       GROUP BY customer_name ORDER BY total_spent DESC LIMIT 20`,
      [process.env.ZOHO_ORG_ID, `%${q}%`]
    );
    res.json({
      customers: result.rows.map(r => ({
        name:         r.name,
        invoiceCount: parseInt(r.invoice_count),
        totalSpent:   parseFloat(r.total_spent),
      }))
    });
  } catch (error) {
    res.status(500).json({ error: 'Customer search failed', details: error.message });
  }
});

// ============================================================================
// SYNC STATUS
// ============================================================================

// GET /api/sync/status
app.get('/api/sync/status', authenticateToken, async (req, res) => {
  try {
    const logResult = await pool.query(
      `SELECT synced_at, invoice_count, status, message FROM sync_log
       WHERE organization_id = $1 ORDER BY synced_at DESC LIMIT 1`,
      [process.env.ZOHO_ORG_ID]
    );
    const countResult = await pool.query(
      `SELECT COUNT(*) AS cnt FROM invoices WHERE organization_id = $1`,
      [process.env.ZOHO_ORG_ID]
    );
    const last = logResult.rows[0];
    res.json({
      lastSyncAt:    last?.synced_at    || null,
      lastSyncCount: last?.invoice_count || 0,
      status:        last?.status        || 'never',
      totalInvoices: parseInt(countResult.rows[0].cnt) || 0,
      message:       last?.message       || null,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get sync status', details: error.message });
  }
});

// ============================================================================
// COMMISSIONS REPORT
// ============================================================================

// GET /api/commissions/report?year=&repName=&month=
app.get('/api/commissions/report', authenticateToken, async (req, res) => {
  const { email, isAdmin, name: jwtName } = req.user;
  const { year, repName, month } = req.query;
  const targetYear = year || new Date().getFullYear().toString();

  try {
    const tokenResult = await pool.query('SELECT display_name FROM user_tokens WHERE email = $1', [email]);
    const myName    = tokenResult.rows[0]?.display_name || jwtName || email;
    const targetRep = isAdmin ? (repName || myName) : myName;

    const spResult = await pool.query('SELECT commission_rate FROM salespeople WHERE name = $1', [targetRep]);
    const commissionRate = parseFloat(spResult.rows[0]?.commission_rate) || 10;

    const startDate = new Date(`${targetYear}-01-01`);
    const endDate   = new Date(`${targetYear}-12-31T23:59:59.999`);

    const monthlyResult = await pool.query(`
      SELECT
        EXTRACT(MONTH FROM date) AS month_num,
        COUNT(*) AS invoices,
        COALESCE(SUM(total), 0) AS revenue,
        COALESCE(SUM(commission), 0) AS commission,
        COALESCE(SUM(CASE WHEN commission_paid THEN commission ELSE 0 END), 0) AS paid_commission,
        COALESCE(SUM(CASE WHEN status = 'paid' THEN total ELSE 0 END), 0) AS paid_revenue,
        COUNT(CASE WHEN commission_paid THEN 1 END) AS commission_paid_count,
        COUNT(CASE WHEN status = 'paid'    THEN 1 END) AS commission_qualifying_count
      FROM invoices
      WHERE salesperson_name = $1 AND organization_id = $2 AND date >= $3 AND date <= $4
      GROUP BY EXTRACT(MONTH FROM date) ORDER BY month_num
    `, [targetRep, process.env.ZOHO_ORG_ID, startDate, endDate]);

    const mMap = {};
    monthlyResult.rows.forEach(r => { mMap[parseInt(r.month_num)] = r; });
    const months = Array.from({ length: 12 }, (_, i) => {
      const m = mMap[i + 1] || {};
      return {
        month:                    i + 1,
        invoices:                 parseInt(m.invoices)                    || 0,
        revenue:                  parseFloat(m.revenue)                  || 0,
        commission:               parseFloat(m.commission)               || 0,
        paidCommission:           parseFloat(m.paid_commission)          || 0,
        paidRevenue:              parseFloat(m.paid_revenue)             || 0,
        commissionPaidCount:      parseInt(m.commission_paid_count)      || 0,
        commissionQualifyingCount: parseInt(m.commission_qualifying_count) || 0,
      };
    });

    const customerResult = await pool.query(`
      SELECT COALESCE(customer_name, 'Unknown') AS customer_name,
             COUNT(*) AS invoices,
             COALESCE(SUM(total), 0) AS revenue,
             COALESCE(SUM(commission), 0) AS commission
      FROM invoices
      WHERE salesperson_name = $1 AND organization_id = $2
        AND date >= $3 AND date <= $4 AND status = 'paid'
      GROUP BY customer_name ORDER BY revenue DESC LIMIT 20
    `, [targetRep, process.env.ZOHO_ORG_ID, startDate, endDate]);

    const currentMonthNum  = new Date().getMonth();  // 0-indexed
    const currentMonthData = months[currentMonthNum];
    const ytdCommission    = months.reduce((s, m) => s + m.commission, 0);
    const ytdRevenue       = months.reduce((s, m) => s + m.revenue,    0);
    const ytdInvoices      = months.reduce((s, m) => s + m.invoices,   0);

    res.json({
      repName: targetRep,
      commissionRate,
      year: targetYear,
      months,
      customers: customerResult.rows.map(r => ({
        customerName: r.customer_name,
        invoices:     parseInt(r.invoices),
        revenue:      parseFloat(r.revenue),
        commission:   parseFloat(r.commission),
      })),
      summary: {
        currentMonth: {
          commission: currentMonthData.commission,
          revenue:    currentMonthData.paidRevenue,
          invoices:   currentMonthData.invoices,
        },
        ytd: { commission: ytdCommission, revenue: ytdRevenue, invoices: ytdInvoices },
      },
    });
  } catch (error) {
    console.error('Commission report error:', error);
    res.status(500).json({ error: 'Failed to fetch commission report', details: error.message });
  }
});

// GET /api/commissions/invoices?repName=&year=&month=
app.get('/api/commissions/invoices', authenticateToken, async (req, res) => {
  const { email, isAdmin, name: jwtName } = req.user;
  const { repName, year, month } = req.query;
  try {
    const tokenResult = await pool.query('SELECT display_name FROM user_tokens WHERE email = $1', [email]);
    const myName    = tokenResult.rows[0]?.display_name || jwtName || email;
    const targetRep = isAdmin ? (repName || myName) : myName;
    const targetYear = year || new Date().getFullYear().toString();

    let startDate, endDate;
    if (month && month !== 'all') {
      startDate = new Date(`${targetYear}-${String(month).padStart(2, '0')}-01`);
      endDate   = new Date(startDate);
      endDate.setMonth(endDate.getMonth() + 1);
    } else {
      startDate = new Date(`${targetYear}-01-01`);
      endDate   = new Date(`${targetYear}-12-31T23:59:59.999`);
    }

    const result = await pool.query(`
      SELECT invoice_number, customer_name, date, total, commission, status, commission_paid
      FROM invoices
      WHERE salesperson_name = $1 AND organization_id = $2 AND date >= $3 AND date < $4
      ORDER BY date DESC
    `, [targetRep, process.env.ZOHO_ORG_ID, startDate, endDate]);

    res.json({
      invoices: result.rows.map(r => ({
        invoiceNumber:  r.invoice_number,
        customerName:   r.customer_name || 'Unknown',
        date:           r.date,
        total:          parseFloat(r.total),
        commission:     parseFloat(r.commission),
        status:         r.status,
        commissionPaid: r.commission_paid || false,
      }))
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch commission invoices', details: error.message });
  }
});

// POST /api/commissions/approve — supports { repName, year, month } OR { invoiceNumbers: [...] }
app.post('/api/commissions/approve', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  const { repName, year, month, invoiceNumbers } = req.body;
  try {
    let result;
    if (Array.isArray(invoiceNumbers) && invoiceNumbers.length > 0) {
      result = await pool.query(
        `UPDATE invoices SET commission_paid = true, updated_at = CURRENT_TIMESTAMP
         WHERE invoice_number = ANY($1) RETURNING invoice_number`,
        [invoiceNumbers]
      );
    } else if (repName && year && month) {
      const startDate = new Date(`${year}-${String(month).padStart(2, '0')}-01`);
      const endDate   = new Date(startDate);
      endDate.setMonth(endDate.getMonth() + 1);
      result = await pool.query(
        `UPDATE invoices SET commission_paid = true, updated_at = CURRENT_TIMESTAMP
         WHERE salesperson_name = $1 AND organization_id = $2
           AND date >= $3 AND date < $4 AND status = 'paid'
         RETURNING invoice_number`,
        [repName, process.env.ZOHO_ORG_ID, startDate, endDate]
      );
    } else {
      return res.status(400).json({ error: 'Provide repName+year+month or invoiceNumbers' });
    }
    res.json({ success: true, invoicesUpdated: result.rowCount });
  } catch (error) {
    res.status(500).json({ error: 'Failed to approve commissions', details: error.message });
  }
});

// POST /api/commissions/unapprove — supports { repName, year, month } OR { invoiceNumbers: [...] }
app.post('/api/commissions/unapprove', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  const { repName, year, month, invoiceNumbers } = req.body;
  try {
    let result;
    if (Array.isArray(invoiceNumbers) && invoiceNumbers.length > 0) {
      result = await pool.query(
        `UPDATE invoices SET commission_paid = false, updated_at = CURRENT_TIMESTAMP
         WHERE invoice_number = ANY($1) RETURNING invoice_number`,
        [invoiceNumbers]
      );
    } else if (repName && year && month) {
      const startDate = new Date(`${year}-${String(month).padStart(2, '0')}-01`);
      const endDate   = new Date(startDate);
      endDate.setMonth(endDate.getMonth() + 1);
      result = await pool.query(
        `UPDATE invoices SET commission_paid = false, updated_at = CURRENT_TIMESTAMP
         WHERE salesperson_name = $1 AND organization_id = $2
           AND date >= $3 AND date < $4
         RETURNING invoice_number`,
        [repName, process.env.ZOHO_ORG_ID, startDate, endDate]
      );
    } else {
      return res.status(400).json({ error: 'Provide repName+year+month or invoiceNumbers' });
    }
    res.json({ success: true, invoicesUpdated: result.rowCount });
  } catch (error) {
    res.status(500).json({ error: 'Failed to unapprove commissions', details: error.message });
  }
});

// Recalculate job state
let recalcJob = { status: 'idle', processed: 0, total: 0, message: '' };

// POST /api/commissions/recalculate
app.post('/api/commissions/recalculate', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  if (recalcJob.status === 'running') return res.status(409).json({ error: 'Already running' });

  recalcJob = { status: 'running', processed: 0, total: 0, message: 'Starting...' };
  res.json({ success: true, message: 'Recalculation started' });

  (async () => {
    try {
      const countRes = await pool.query(
        'SELECT COUNT(*) AS cnt FROM invoices WHERE organization_id = $1',
        [process.env.ZOHO_ORG_ID]
      );
      recalcJob.total = parseInt(countRes.rows[0].cnt) || 0;

      const spRes = await pool.query('SELECT name, commission_rate FROM salespeople');
      const rateMap = {};
      spRes.rows.forEach(r => { rateMap[r.name] = parseFloat(r.commission_rate) || 10; });

      const invRes = await pool.query(
        'SELECT id, salesperson_name, total, status FROM invoices WHERE organization_id = $1',
        [process.env.ZOHO_ORG_ID]
      );
      for (const inv of invRes.rows) {
        if (recalcJob.status === 'stopping') break;
        const rate       = rateMap[inv.salesperson_name] || 10;
        const commission = inv.status === 'paid' ? (parseFloat(inv.total) * rate / 100) : 0;
        await pool.query(
          'UPDATE invoices SET commission = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [commission, inv.id]
        );
        recalcJob.processed++;
        recalcJob.message = `Processed ${recalcJob.processed} of ${recalcJob.total}`;
      }
      recalcJob.status  = recalcJob.status === 'stopping' ? 'stopped' : 'completed';
      recalcJob.message = `Recalculated ${recalcJob.processed} invoices`;
    } catch (error) {
      recalcJob.status  = 'error';
      recalcJob.message = error.message;
    }
  })();
});

// POST /api/commissions/recalculate/stop
app.post('/api/commissions/recalculate/stop', authenticateToken, async (req, res) => {
  if (recalcJob.status === 'running') recalcJob.status = 'stopping';
  res.json({ success: true });
});

// GET /api/commissions/recalculate/status
app.get('/api/commissions/recalculate/status', authenticateToken, async (req, res) => {
  res.json(recalcJob);
});

// ============================================================================
// RELEASES MANAGEMENT
// ============================================================================

// GET /api/releases
app.get('/api/releases', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM releases ORDER BY date DESC LIMIT 50');
    res.json({ releases: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch releases', details: error.message });
  }
});

// GET /api/releases/generate-notes — stub (returns template)
app.get('/api/releases/generate-notes', authenticateToken, async (req, res) => {
  res.json({
    notes: '## ✨ New Features\n- \n\n## 🎨 UI Improvements\n- \n\n## 🔧 Bug Fixes\n- \n',
    commitCount: 0,
    sinceTag: '',
  });
});

// GET /api/releases/workflow-status
app.get('/api/releases/workflow-status', authenticateToken, async (req, res) => {
  res.json({ status: 'completed', conclusion: 'success' });
});

// POST /api/releases/create
app.post('/api/releases/create', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  const { version, releaseNotes } = req.body;
  if (!version) return res.status(400).json({ error: 'Version required' });
  try {
    await pool.query(
      `INSERT INTO releases (version, name, notes, url, date)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`,
      [`v${version}`, `v${version}`, releaseNotes || '', `https://github.com/releases/v${version}`]
    );
    res.json({ success: true, version });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create release', details: error.message });
  }
});

// ============================================================================
// HEALTH CHECK
// ============================================================================

app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// Debug — tests Zoho photo endpoints live and shows full user info
app.get('/api/debug/photo', authenticateToken, async (req, res) => {
  try {
    // Get stored token
    const tokenResult = await pool.query(
      'SELECT access_token, api_domain, LENGTH(photo) as photo_length, photo FROM user_tokens WHERE email = $1',
      [req.user.email]
    );
    const row = tokenResult.rows[0] || {};
    const accessToken = row.access_token;

    // Fetch fresh user info from Zoho Accounts
    let zohoUserInfo = null;
    try {
      const uRes = await axios.get('https://accounts.zoho.com/oauth/user/info', {
        headers: { 'Authorization': `Zoho-oauthtoken ${accessToken}` },
      });
      zohoUserInfo = uRes.data;
    } catch (e) {
      zohoUserInfo = { error: e.message, status: e.response?.status };
    }

    const apiDomain = row.api_domain || 'https://www.zohoapis.com';
    const ZUID = zohoUserInfo?.ZUID;

    // --- IMAGE endpoints (try as binary) ---
    const imageEndpoints = [
      // ✅ Confirmed working pattern
      ZUID ? `https://contacts.zoho.com/file?t=user&fs=thumb&ID=${ZUID}` : null,
      ZUID ? `https://contacts.zoho.com/file?t=user&fs=original&ID=${ZUID}` : null,
      `https://accounts.zoho.com/api/v1/user/${ZUID}/photo`,
      `https://accounts.zoho.com/api/v1/user/self/photo`,
      zohoUserInfo?.profile_photo_url,
    ].filter(Boolean);

    const imageResults = [];
    for (const url of imageEndpoints) {
      try {
        const r = await axios.get(url, {
          headers: { 'Authorization': `Zoho-oauthtoken ${accessToken}` },
          responseType: 'arraybuffer',
          timeout: 5000,
        });
        const ct = r.headers['content-type'] || '';
        imageResults.push({ url, status: r.status, contentType: ct, size: r.data.length, isImage: ct.startsWith('image/') });
      } catch (e) {
        imageResults.push({ url, status: e.response?.status || 'network error', error: e.message });
      }
    }

    // --- JSON endpoints (Books, CRM — may contain photo URL inside JSON) ---
    let booksUser = null;
    try {
      const r = await axios.get(`${apiDomain}/books/v3/users/current?organization_id=${process.env.ZOHO_ORG_ID}`, {
        headers: { 'Authorization': `Zoho-oauthtoken ${accessToken}` },
        timeout: 5000,
      });
      booksUser = r.data;
    } catch (e) {
      booksUser = { error: e.message, status: e.response?.status };
    }

    let crmUser = null;
    try {
      const r = await axios.get(`https://www.zohoapis.com/crm/v2/users?type=CurrentUser`, {
        headers: { 'Authorization': `Zoho-oauthtoken ${accessToken}` },
        timeout: 5000,
      });
      crmUser = r.data;
    } catch (e) {
      crmUser = { error: e.message, status: e.response?.status };
    }

    // --- Try photo URLs extracted from CRM/Books ---
    const extraImageTests = [];
    const crmPhotoUrl = crmUser?.users?.[0]?.full_name ? null : null; // placeholder
    const crmImageLink = crmUser?.users?.[0]?.image_link;
    const booksPhotoUrl = booksUser?.data?.photo_url || booksUser?.user?.photo_url;
    for (const url of [crmImageLink, booksPhotoUrl].filter(Boolean)) {
      try {
        const r = await axios.get(url, {
          headers: { 'Authorization': `Zoho-oauthtoken ${accessToken}` },
          responseType: 'arraybuffer',
          timeout: 5000,
        });
        const ct = r.headers['content-type'] || '';
        extraImageTests.push({ url, status: r.status, contentType: ct, size: r.data.length, isImage: ct.startsWith('image/') });
      } catch (e) {
        extraImageTests.push({ url, status: e.response?.status || 'network error', error: e.message });
      }
    }

    res.json({
      photo_in_db:        !!(row.photo_length > 0),
      photo_size_bytes:   row.photo_length || 0,
      photo_preview:      row.photo ? row.photo.substring(0, 60) : null,
      zoho_user_info:     zohoUserInfo,
      image_endpoint_tests: imageResults,
      books_user_response:  booksUser,
      crm_user_response:    crmUser,
      extra_image_tests:    extraImageTests,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// START SERVER
// ============================================================================

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`✅ Commission Tracker API running on http://localhost:${PORT}`);
  console.log(`📚 Zoho Books Organization ID: ${process.env.ZOHO_ORG_ID}`);
  console.log(`🔐 Frontend redirect: ${process.env.FRONTEND_URL}`);
  console.log(`🗄️  Database connected: ${process.env.DATABASE_URL ? 'Yes' : 'No'}`);

  // Wait for DB to be ready before starting auto-sync (up to 30 seconds)
  const waitForDb = (attempts = 0) => {
    if (dbReady) {
      startAutoSync();
    } else if (attempts < 30) {
      setTimeout(() => waitForDb(attempts + 1), 1000);
    } else {
      console.warn('⚠️ DB not ready after 30s, starting sync anyway');
      startAutoSync();
    }
  };
  waitForDb();
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  stopAutoSync();
  await pool.end();
  process.exit(0);
});
