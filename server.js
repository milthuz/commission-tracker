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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Database tables initialized');
  } catch (error) {
    console.error('Database initialization error:', error);
  }
}

// Initialize on startup
initializeDatabase();

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
    `&access_type=offline` +
    `&prompt=login`;

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
    let userEmail, userName, userPhoto, zohoUserId;
    
    try {
      const userInfoResponse = await axios.get(
        `${accountsUrl}/oauth/user/info`,
        {
          headers: {
            'Authorization': `Zoho-oauthtoken ${access_token}`,
          },
        }
      );

      const userInfo = userInfoResponse.data;
      userEmail = userInfo.Email;
      userName = `${userInfo.First_Name || ''} ${userInfo.Last_Name || ''}`.trim() || userEmail;
      userPhoto = userInfo.profile_photo_url || null;
      zohoUserId = userInfo.ZUID;
      
      console.log('✅ User info retrieved:', {
        email: userEmail,
        name: userName,
      });
    } catch (userInfoError) {
      console.error('⚠️ Failed to fetch Zoho user info, using fallback:', userInfoError.message);
      // Fallback to MD5 hash if Zoho user API fails
      const crypto = require('crypto');
      userEmail = crypto.createHash('md5').update(access_token).digest('hex');
      userName = 'Zoho User';
      userPhoto = null;
      zohoUserId = userEmail;
    }

    console.log('User Email:', userEmail);
    console.log('User Name:', userName);

    // Store tokens in database with error handling
    try {
      await pool.query(
        `INSERT INTO user_tokens (email, access_token, refresh_token, api_domain, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (email) DO UPDATE SET
         access_token = $2, refresh_token = $3, api_domain = $4, expires_at = $5, updated_at = CURRENT_TIMESTAMP`,
        [userEmail, access_token, refresh_token, api_domain, Date.now() + expires_in * 1000]
      );
      console.log('✅ Tokens stored in database for:', userEmail);
    } catch (dbError) {
      console.error('❌ Database error:', dbError.message);
      return res.status(500).json({ error: 'Failed to store tokens in database' });
    }

    // Create JWT token
    const jwtToken = jwt.sign(
      { 
        email: userEmail, 
        name: userName,
        photo: userPhoto,
        zoho_id: zohoUserId,
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
app.get('/api/auth/verify', authenticateToken, (req, res) => {
  // If authenticateToken middleware passes, token is valid
  res.json({ 
    valid: true, 
    user: {
      email: req.user.email,
      name: req.user.name || req.user.email,
      photo: req.user.photo || null,
      zoho_id: req.user.zoho_id || req.user.email
    }
  });
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
      const total = parseFloat(inv.total) || 0;
      // Commission only for PAID invoices
      const commission = inv.status === 'paid' ? (total * 0.1) : 0;
      const invDate = new Date(inv.date || new Date());

      await pool.query(
        `INSERT INTO invoices 
         (invoice_number, salesperson_name, total, status, date, commission, organization_id) 
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (invoice_number) DO UPDATE SET
         status = $4, total = $3, commission = $6, updated_at = CURRENT_TIMESTAMP`,
        [inv.invoice_number, salesperson, total, inv.status, invDate, commission, process.env.ZOHO_ORG_ID]
      );
      syncedCount++;
    }

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
      const total = parseFloat(inv.total) || 0;
      const commission = (total * 0.1); // 10% commission
      const invDate = new Date(inv.date || new Date());

      await pool.query(
        `INSERT INTO invoices 
         (invoice_number, salesperson_name, total, status, date, commission, organization_id) 
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (invoice_number) DO UPDATE SET
         status = $4, total = $3, commission = $6, updated_at = CURRENT_TIMESTAMP`,
        [inv.invoice_number, salesperson, total, inv.status, invDate, commission, process.env.ZOHO_ORG_ID]
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
    // Parse dates properly - add end of day to end date
    const startDate = new Date(start);
    const endDate = new Date(end);
    endDate.setHours(23, 59, 59, 999); // Set to end of day

    console.log('📄 Fetching invoices from database...');
    console.log('📅 Date range:', startDate, 'to', endDate);

    // Query database for all invoices
    let query = `
      SELECT 
        invoice_number,
        salesperson_name,
        date,
        total,
        commission,
        status,
        organization_id
      FROM invoices
      WHERE organization_id = $1
      AND date >= $2
      AND date <= $3
      AND status = 'paid'
    `;
    
    const params = [process.env.ZOHO_ORG_ID, startDate, endDate];
    let paramIndex = 4;

    // If salesperson filter provided
    if (salesperson) {
      query += ` AND salesperson_name = $${paramIndex}`;
      params.push(salesperson);
      paramIndex++;
    }

    query += ` ORDER BY date DESC`;

    const result = await pool.query(query, params);

    const invoices = result.rows.map(row => ({
      invoice_number: row.invoice_number,
      salesperson_name: row.salesperson_name || 'Unassigned',
      date: row.date,
      total: row.total,
      commission: row.commission,
      status: row.status,
    }));

    console.log(`✅ Found ${invoices.length} invoices`);

    res.json({ 
      invoices,
      dateRange: { start: startDate, end: endDate }
    });
  } catch (error) {
    console.error('❌ Error fetching invoices:', error);
    res.status(500).json({ error: 'Failed to fetch invoices', details: error.message });
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
  
  // Start automatic invoice sync
  startAutoSync();
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  stopAutoSync();
  await pool.end();
  process.exit(0);
});
