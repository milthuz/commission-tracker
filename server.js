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
const ZohoCRMService = require('./services/zohoCRMService');

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
    console.log('✅ User info retrieved:', {
      email: userInfo.Email,
      firstName: userInfo.First_Name,
      lastName: userInfo.Last_Name,
    });

    const userEmail = userInfo.Email;
    const userName = `${userInfo.First_Name || ''} ${userInfo.Last_Name || ''}`.trim() || userEmail;

    console.log('User Email:', userEmail);
    console.log('User Name:', userName);
    console.log('Profile photo URL from Zoho:', userInfo.profile_photo_url || 'NOT PROVIDED');

    // Zoho profile photo URLs require auth — download and store as base64 data URI
    let userPhoto = null;
    if (userInfo.profile_photo_url) {
      try {
        const photoResponse = await axios.get(userInfo.profile_photo_url, {
          headers: { 'Authorization': `Zoho-oauthtoken ${access_token}` },
          responseType: 'arraybuffer',
          timeout: 5000,
        });
        const contentType = photoResponse.headers['content-type'] || 'image/jpeg';
        const base64 = Buffer.from(photoResponse.data).toString('base64');
        userPhoto = `data:${contentType};base64,${base64}`;
        console.log('✅ Profile photo downloaded and encoded as base64');
      } catch (photoErr) {
        console.warn('⚠️ Could not download profile photo:', photoErr.message);
      }
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

    // Create JWT token — keep it small, photo is fetched from DB separately
    const jwtToken = jwt.sign(
      {
        email: userEmail,
        name: userName,
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

// 4. Verify JWT token — fetches photo and display_name from DB so JWT stays small
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
        photo:   row.photo        || null,
        zoho_id: req.user.zoho_id || req.user.email,
        isAdmin: row.is_admin     != null ? row.is_admin : req.user.isAdmin,
      }
    });
  } catch (error) {
    // Fallback: return JWT data if DB lookup fails
    res.json({
      valid: true,
      user: {
        email:   req.user.email,
        name:    req.user.name  || req.user.email,
        photo:   null,
        zoho_id: req.user.zoho_id || req.user.email,
        isAdmin: req.user.isAdmin || false,
      }
    });
  }
});

// ============================================================================
// ZOHO CRM AUTH (separate OAuth flow for CRM)
// ============================================================================

// 1. Initiate CRM OAuth
app.get('/api/auth/zoho-crm', authenticateToken, (req, res) => {
  const state = Math.random().toString(36).substring(7);

  const authUrl = `${ZOHO_CONFIG.accounts_url}/oauth/v2/auth?` +
    `scope=ZohoCRM.modules.ALL,ZohoCRM.settings.ALL` +
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
    const { email } = req.user;
    const tokenData = await ensureValidToken(email);
    const crm = new ZohoCRMService(tokenData.access_token);
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
    const { email } = req.user;
    const tokenData = await ensureValidToken(email);
    const crm = new ZohoCRMService(tokenData.access_token);
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
    const { email } = req.user;
    const tokenData = await ensureValidToken(email);
    const crm = new ZohoCRMService(tokenData.access_token);
    const fields = await crm.getDealFields();
    // Return just name + label + data_type for readability
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
const AUTO_SYNC_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours

let syncInterval;

function startAutoSync() {
  console.log('⏰ [AUTO-SYNC] Starting automatic sync scheduler (every 4 hours)');
  
  // Run sync immediately on startup
  autoSyncInvoices();
  
  // Then run every 4 hours
  syncInterval = setInterval(autoSyncInvoices, AUTO_SYNC_INTERVAL);
}

function stopAutoSync() {
  if (syncInterval) {
    clearInterval(syncInterval);
    console.log('⏹️ [AUTO-SYNC] Stopped automatic sync scheduler');
  }
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
