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
const multer = require('multer');
const xlsx = require('xlsx');
const AdmZip = require('adm-zip');
const PDFDocument = require('pdfkit');
const { Pool } = require('pg');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const nodemailer = require('nodemailer');
const QRCode = require('qrcode');
const Anthropic = require('@anthropic-ai/sdk');
const { ZohoCRMService, MONTHLY_QUOTA, MONTHLY_BONUS_TIERS, ANNUAL_BONUS_TIERS, PLAN_START_DATE } = require('./services/zohoCRMService');
const { ZentactService } = require('./services/zentactService');
const { ZohoBillingService } = require('./services/zohoBillingService');
const { computeSavings: computeSavingsEngine } = require('./services/savingsCalc');

dotenv.config();

// ============================================================================
// JWT secret — REQUIRED, no fallback.
// The old hardcoded default ('your-secret-key') let anyone forge a valid token,
// including an admin token (the Zoho JWT carries isAdmin). We now fail closed:
// the server refuses to start unless JWT_SECRET is set — in every environment.
// We deliberately don't auto-detect prod vs dev (NODE_ENV is not reliably set
// on Railway), so there is no environment where an insecure default can slip
// through. Local dev sets JWT_SECRET in .env alongside the other required vars.
// NOTE: changing JWT_SECRET invalidates ALL existing sessions (Zoho SSO + local
// email/password) — every user must log in again.
// ============================================================================
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ FATAL: JWT_SECRET is not set. Refusing to start (no insecure default). Set a strong random JWT_SECRET.');
  process.exit(1);
}

const app = express();

// ============================================================================
// PERMISSION CATALOG — all features that can be gated via roles
// ============================================================================
const PERMISSION_CATALOG = [
  // Commission Tracker
  { key: 'tracker:view_own',           label: 'View own row in Commission Tracker',          category: 'Commission Tracker' },
  { key: 'tracker:view_all_totals',    label: 'View all reps totals (no details)',           category: 'Commission Tracker' },
  { key: 'tracker:view_all_details',   label: 'View all reps deals + merchants details',     category: 'Commission Tracker' },
  { key: 'tracker:assign_merchants',   label: 'Assign unassigned Zentact merchants to reps', category: 'Commission Tracker' },

  // Commission Report
  { key: 'report:view_own',            label: 'View own commission report',                  category: 'Commission Report' },
  { key: 'report:view_others',         label: "View other reps' commission reports",         category: 'Commission Report' },
  { key: 'report:approve',             label: 'Approve / unapprove commissions',             category: 'Commission Report' },
  { key: 'report:mark_paid',           label: 'Mark approved commissions as paid to rep',    category: 'Commission Report' },
  { key: 'report:view_paystub',        label: 'View pay stubs (own + per role)',             category: 'Commission Report' },
  { key: 'report:view_salary',         label: 'View base salary & total compensation',       category: 'Commission Report' },

  // Dashboard
  { key: 'dashboard:view_admin',       label: 'View the Admin dashboard (company finance + action items)', category: 'Dashboard' },
  { key: 'dashboard:view_own',         label: 'View the personal Sales Rep dashboard (home)',              category: 'Dashboard' },

  // Invoices
  { key: 'invoices:view_own',          label: 'View own invoices',                           category: 'Invoices' },
  { key: 'invoices:view_all',          label: "View all reps' invoices",                     category: 'Invoices' },
  { key: 'invoices:send_email',        label: 'Email invoices to customers',                 category: 'Invoices' },

  // Admin Panel
  { key: 'admin:access',               label: 'Access the Admin Panel',                      category: 'Admin Panel' },
  { key: 'admin:integrations',         label: 'Manage Zoho / Zentact integrations',          category: 'Admin Panel' },
  { key: 'admin:salespeople',          label: 'Manage salespeople (commission %, aliases)',  category: 'Admin Panel' },
  { key: 'admin:customers',            label: 'Manage customer exclusions',                  category: 'Admin Panel' },
  { key: 'admin:users',                label: 'Manage admin user access',                    category: 'Admin Panel' },
  { key: 'admin:roles',                label: 'Manage roles and permissions',                category: 'Admin Panel' },
  { key: 'admin:releases',             label: 'Push new app releases',                       category: 'Admin Panel' },
  { key: 'admin:impersonate',          label: 'Use impersonation mode',                      category: 'Admin Panel' },
  { key: 'admin:data_health',          label: 'View the "Needs attention" data-health page', category: 'Admin Panel' },

  // Syncs
  { key: 'sync:books',                 label: 'Trigger Zoho Books sync manually',            category: 'Syncs' },
  { key: 'sync:crm',                   label: 'Trigger Zoho CRM sync manually',              category: 'Syncs' },
  { key: 'sync:zentact',               label: 'Trigger Zentact merchant sync manually',      category: 'Syncs' },
  { key: 'sync:recalc',                label: 'Recalculate all commissions',                 category: 'Syncs' },

  // Reseller
  { key: 'reseller:view',              label: 'View the Reseller section (POS activations + residual payments)', category: 'Reseller' },
  { key: 'reseller:manage',           label: 'Manage resellers (names, emails, Zentact key, active)',           category: 'Reseller' },

  // Revenue (Zentact transaction profit)
  { key: 'revenue:view',               label: 'View merchant revenue (Transaction Profit by rep / reseller)',    category: 'Revenue' },

  // Resources (sales document library)
  { key: 'resources:view',             label: 'View the Resources library (sales documents)',                   category: 'Resources' },
  { key: 'resources:manage',           label: 'Add, edit and delete resources',                                 category: 'Resources' },

  // Demo (AppStream-streamed Kaizen POS for sales demos)
  { key: 'demo:kaizen',                label: 'Access the Kaizen POS demo (streamed POS)',                      category: 'Demo' },

  // Proposals (build + send a client proposal from a Zoho Books estimate)
  { key: 'proposals:send',             label: 'Build & send client proposals (from Zoho estimates)',            category: 'Proposals' },

  // Rate / Savings calculator (analyze a competitor merchant statement → savings offer)
  { key: 'savings:use',                label: 'Use the payment savings calculator',                             category: 'Rate Calculator' },
  { key: 'savings:manage_pricing',     label: 'Manage pricing templates + assign them to reps',                 category: 'Rate Calculator' },
];

// Returns the effective permission set for a user (union of all their roles)
async function getUserPermissions(email) {
  if (!email) return new Set();
  try {
    const result = await pool.query(
      `SELECT r.permissions FROM roles r
       JOIN user_roles ur ON ur.role_id = r.id
       WHERE LOWER(ur.user_email) = LOWER($1)`,
      [email]
    );
    const set = new Set();
    for (const row of result.rows) {
      const perms = Array.isArray(row.permissions) ? row.permissions : [];
      for (const p of perms) set.add(p);
    }
    return set;
  } catch {
    return new Set();
  }
}

// Load bonus tiers from DB into the in-memory arrays the (sync) calculate*Bonus + tier-find
// code uses. Kept fresh on a 60s interval so edits propagate across both web dynos.
async function refreshBonusTiers() {
  try {
    const rows = (await pool.query(`SELECT kind, points, bonus FROM bonus_tiers ORDER BY points DESC`)).rows;
    const monthly = rows.filter(r => r.kind === 'monthly').map(r => ({ points: parseInt(r.points), bonus: parseFloat(r.bonus) }));
    const annual  = rows.filter(r => r.kind === 'annual').map(r => ({ points: parseInt(r.points), bonus: parseFloat(r.bonus) }));
    if (monthly.length) { MONTHLY_BONUS_TIERS.length = 0; MONTHLY_BONUS_TIERS.push(...monthly); }
    if (annual.length)  { ANNUAL_BONUS_TIERS.length = 0;  ANNUAL_BONUS_TIERS.push(...annual); }
  } catch (e) { /* keep last-known tiers on error */ }
}
setInterval(() => { refreshBonusTiers(); }, 60000);

// Team ids a (manager) user oversees. Empty array = manages no team.
async function getManagedTeamIds(email) {
  if (!email) return [];
  try {
    const r = await pool.query(`SELECT team_id FROM team_managers WHERE LOWER(user_email) = LOWER($1)`, [email]);
    return r.rows.map(x => parseInt(x.team_id)).filter(Number.isFinite);
  } catch { return []; }
}

// Salesperson names in the team(s) a manager oversees (who they may view reports for).
async function getManagedRepNames(email) {
  const ids = await getManagedTeamIds(email);
  if (!ids.length) return [];
  try {
    const r = await pool.query(`SELECT name FROM salespeople WHERE team_id = ANY($1::int[])`, [ids]);
    return r.rows.map(x => x.name);
  } catch { return []; }
}

// Resolve which rep's data a viewer may read for a rep-scoped endpoint:
//   • Admin            → any requested rep
//   • Manager (report:view_others) → self, or a rep in their managed team(s)
//   • else             → self only (a disallowed request silently falls back to self)
async function resolveTargetRep(req, requestedRep, myName) {
  if (req.user.isAdmin === true) return requestedRep || myName;
  const requested = String(requestedRep || '').trim();
  if (!requested || requested.toLowerCase() === String(myName).toLowerCase()) return myName;
  const perms = await getUserPermissions(req.user.email);
  if (userHasPermission(perms, 'report:view_others')) {
    const allowed = await getManagedRepNames(req.user.email);
    if (allowed.some(n => n.toLowerCase() === requested.toLowerCase())) return requested;
  }
  return myName;
}

// Endpoint-level helper: resolve current user, check perm, respond 403 if missing.
// Returns true if allowed (and you should proceed), false if it sent a 403 response.
// Admins always pass. While impersonating, the request is evaluated as the
// impersonated user (their own permissions) — the admin's powers do NOT carry over.
async function requirePerm(req, res, perm) {
  if (req.user.isAdmin === true) return true;
  const email = req.user.email;
  if (!email) {
    res.status(403).json({ error: `Permission required: ${perm}` });
    return false;
  }
  const perms = await getUserPermissions(email);
  if (!userHasPermission(perms, perm)) {
    res.status(403).json({ error: `Permission required: ${perm}` });
    return false;
  }
  return true;
}

// Check helper: wildcards (*) grant all
function userHasPermission(permSet, requiredPerm) {
  if (!permSet) return false;
  if (permSet.has('*')) return true;
  if (permSet.has(requiredPerm)) return true;
  // Also support category wildcards like "admin:*"
  const colon = requiredPerm.indexOf(':');
  if (colon > 0) {
    const wildcard = requiredPerm.slice(0, colon) + ':*';
    if (permSet.has(wildcard)) return true;
  }
  return false;
}

// ============================================================================
// DATABASE CONNECTION
// ============================================================================

// DB is on Railway, reached over its PUBLIC TCP proxy (proxy.rlwy.net) — i.e. cross-cloud
// from the Heroku dynos. Every round-trip pays ~30-100ms of public-internet latency, so we
// bound connections and fail fast instead of hanging into the Heroku 30s H12 timeout.
const isWorker = process.env.ROLE === 'worker';
// SSL: the Railway PUBLIC proxy (proxy.rlwy.net, used from Heroku) requires SSL; the Railway
// PRIVATE network (*.railway.internal, used once the app runs ON Railway) speaks plaintext and
// REJECTS an SSL handshake. Detect the internal host so the Heroku→Railway cutover doesn't fail
// on "The server does not support SSL connections".
const _dbInternal = /\.railway\.internal\b/.test(process.env.DATABASE_URL || '');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: _dbInternal ? false : { rejectUnauthorized: false },
  max: isWorker ? 5 : 10,         // worker = batch séquentiel ; web = HTTP concurrent (Railway = 100 conn. dispo)
  connectionTimeoutMillis: 10000, // échoue proprement en 10s si le pool est saturé, au lieu de pendre → fini le H12 muet
  idleTimeoutMillis: 30000,
  keepAlive: true,                // le proxy TCP Railway coupe les connexions idle — keepAlive évite les resets
  query_timeout: 25000,           // borne client-side une requête lente sous le timeout routeur Heroku (30s)
});

// Split an array into fixed-size chunks (used to batch multi-row INSERT/UPDATE statements
// so we issue one query per chunk instead of one per row over the cross-cloud link).
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

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
    // Enriched fields for the new commission workflow (hardware/SaaS classification)
    await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS line_items JSONB DEFAULT '[]'::jsonb`);
    await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS hardware_amount DECIMAL(12,2) DEFAULT 0`);
    await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS saas_amount DECIMAL(12,2) DEFAULT 0`);
    await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS subscription_activation_date DATE`);
    await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS paid_date DATE`);
    await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS commission_payable_date DATE`);
    await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS commission_status VARCHAR(50) DEFAULT 'calculated'`);
    // commission_status values: calculated | pending_payment | pending_saas | eligible | approved | paid

    // Phase 2 — approval workflow columns. Separate from commission_status (which is computed
    // from invoice data) so manager approvals are independent of the classification engine.
    //   approval_status: 'pending' (default) | 'approved' | 'paid' | 'rejected'
    //   approved_*  → who locked the commission for payout
    //   payout_*    → who confirmed the commission was actually paid to the rep
    await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) DEFAULT 'pending'`);
    await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS approved_by VARCHAR(255)`);
    await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payout_paid_by VARCHAR(255)`);
    await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payout_paid_at TIMESTAMPTZ`);
    // One-time backfill: any invoice previously flipped to commission_paid=true counts as already paid
    await pool.query(`
      UPDATE invoices
      SET approval_status = 'paid',
          payout_paid_at = COALESCE(payout_paid_at, updated_at, CURRENT_TIMESTAMP),
          approved_at    = COALESCE(approved_at, updated_at, CURRENT_TIMESTAMP)
      WHERE commission_paid = true AND approval_status = 'pending'
    `);

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

    // App-wide settings (key → JSONB). First use: disabled_report_years.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
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
    await pool.query(`ALTER TABLE salespeople ADD COLUMN IF NOT EXISTS aliases JSONB DEFAULT '[]'::jsonb`);
    // Per-salesperson signup-bonus config (amount per Zentact activation + on/off toggle).
    await pool.query(`ALTER TABLE salespeople ADD COLUMN IF NOT EXISTS signup_bonus_amount DECIMAL(10,2) DEFAULT 100`);
    await pool.query(`ALTER TABLE salespeople ADD COLUMN IF NOT EXISTS signup_bonus_enabled BOOLEAN DEFAULT true`);

    // Teams — group salespeople. Quota target = monthly_quota_override when set, else
    // MONTHLY_QUOTA × number of counting members. counts_toward_quota=false → the team's reps
    // are still tracked but excluded from team/company quota aggregates.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS teams (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        monthly_quota_override INT,
        counts_toward_quota BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`ALTER TABLE salespeople ADD COLUMN IF NOT EXISTS team_id INT REFERENCES teams(id) ON DELETE SET NULL`);
    // Per-team: which point sources count toward the team quota (default both, = current behaviour).
    await pool.query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS include_deals BOOLEAN DEFAULT true`);
    await pool.query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS include_payments BOOLEAN DEFAULT true`);
    // Manual display order (drives ordering in admin + the commission tracker).
    await pool.query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS sort_order INT DEFAULT 0`);
    // Per-salesperson monthly quota override (NULL = use the default MONTHLY_QUOTA).
    await pool.query(`ALTER TABLE salespeople ADD COLUMN IF NOT EXISTS monthly_quota INT`);
    // Rep's login email — lets role pre-assignment + impersonation work BEFORE their
    // first Zoho login (user_tokens has no row yet). Must match their Zoho account email.
    await pool.query(`ALTER TABLE salespeople ADD COLUMN IF NOT EXISTS email VARCHAR(255)`);
    // Per-month quota waivers — admin decision to pay a rep's commissions for a month
    // even though they missed quota (plan v7.7 exception, "payer quand même").
    await pool.query(`
      CREATE TABLE IF NOT EXISTS quota_month_waivers (
        rep_name   VARCHAR(255) NOT NULL,
        period     DATE NOT NULL,
        created_by VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (rep_name, period)
      );
    `);
    // Manually-added bonuses on a rep's monthly pay stub (free-text description + amount).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS manual_bonuses (
        id          SERIAL PRIMARY KEY,
        rep_name    VARCHAR(255) NOT NULL,
        period      DATE NOT NULL,
        amount      NUMERIC(12,2) NOT NULL,
        description TEXT DEFAULT '',
        created_by  VARCHAR(255),
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_manual_bonus_period ON manual_bonuses(rep_name, period)`);
    // Commission adjustments: carry an unpaid/missed commission from a past month forward to
    // a chosen target pay period (e.g. pay a missed March invoice in May). Creating one marks
    // the source invoice settled (clears the radar) and adds an "adjustment" line to the
    // target month's stub / payroll / commit. Deleting one re-opens the source invoice.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS commission_adjustments (
        id             SERIAL PRIMARY KEY,
        rep_name       VARCHAR(255) NOT NULL,
        target_period  DATE NOT NULL,            -- 1st of the target pay month
        invoice_number VARCHAR(100),             -- source invoice (null = free adjustment)
        customer       VARCHAR(255),
        amount         NUMERIC(12,2) NOT NULL,
        source_period  DATE,                     -- original unlock month (reference)
        description    TEXT DEFAULT '',
        created_by     VARCHAR(255),
        created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_adjustment_target ON commission_adjustments(rep_name, target_period)`);
    // Payroll send log: one row per (rep, pay month) each time payroll is emailed, so the
    // preview can show a "Sent" badge. Latest sent_at per rep+period is what's displayed.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS payroll_sends (
        id        SERIAL PRIMARY KEY,
        rep_name  VARCHAR(255) NOT NULL,
        period    DATE NOT NULL,
        sent_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        sent_to   TEXT,
        sent_by   VARCHAR(255)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_payroll_sends ON payroll_sends(period, rep_name)`);
    // Record the $ amount sent per rep so the send-history can show totals as they were at send time.
    await pool.query(`ALTER TABLE payroll_sends ADD COLUMN IF NOT EXISTS total NUMERIC`);
    // Comp plan v7.7: hire_date drives the 90-day ramp (quota gate waived);
    // quota_gate_enabled=false exempts a rep from the gate entirely (house
    // accounts, resellers, execs not on the rep plan).
    await pool.query(`ALTER TABLE salespeople ADD COLUMN IF NOT EXISTS hire_date DATE`);
    await pool.query(`ALTER TABLE salespeople ADD COLUMN IF NOT EXISTS quota_gate_enabled BOOLEAN DEFAULT true`);
    // processing_bonus_enabled=false excludes an ACTIVE rep from the bi-annual processing/volume
    // bonus (e.g. someone not entitled to it). Inactive reps are already excluded entirely.
    await pool.query(`ALTER TABLE salespeople ADD COLUMN IF NOT EXISTS processing_bonus_enabled BOOLEAN DEFAULT true`);
    // annual_bonus_enabled=false excludes a rep from the year-end annual points bonus.
    await pool.query(`ALTER TABLE salespeople ADD COLUMN IF NOT EXISTS annual_bonus_enabled BOOLEAN DEFAULT true`);
    // Configurable bonus tiers (monthly + annual). Seeded once from the code defaults; editable in
    // Admin → Salespeople → Bonuses. calculate*Bonus read the in-memory arrays kept in sync below.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bonus_tiers (
        id     SERIAL PRIMARY KEY,
        kind   VARCHAR(10) NOT NULL,
        points INT NOT NULL,
        bonus  NUMERIC NOT NULL
      );
    `);
    const tierCount = (await pool.query(`SELECT COUNT(*)::int AS c FROM bonus_tiers`)).rows[0].c;
    if (tierCount === 0) {
      for (const t of MONTHLY_BONUS_TIERS) await pool.query(`INSERT INTO bonus_tiers (kind, points, bonus) VALUES ('monthly', $1, $2)`, [t.points, t.bonus]);
      for (const t of ANNUAL_BONUS_TIERS)  await pool.query(`INSERT INTO bonus_tiers (kind, points, bonus) VALUES ('annual',  $1, $2)`, [t.points, t.bonus]);
    }
    await refreshBonusTiers();
    // Sales resources library — documents uploaded by admins, stored in-DB (bytea). file_data is
    // only ever fetched on the download endpoint; listings select metadata columns only.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS resources (
        id          SERIAL PRIMARY KEY,
        title       VARCHAR(300) NOT NULL,
        description TEXT,
        category    VARCHAR(150) DEFAULT '',
        tags        TEXT[] DEFAULT '{}',
        file_name   VARCHAR(400) NOT NULL,
        mime_type   VARCHAR(150),
        file_size   INT,
        file_data   BYTEA NOT NULL,
        uploaded_by VARCHAR(255),
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_resources_category ON resources(category)`);
    // owner_email: NULL = the shared/common library; non-NULL = that user's private "My files" zone.
    await pool.query(`ALTER TABLE resources ADD COLUMN IF NOT EXISTS owner_email VARCHAR(255)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_resources_owner ON resources(owner_email)`);
    // Nested folder paths (e.g. "A/B/C") can exceed the original 150 chars — widen the path columns.
    await pool.query(`ALTER TABLE resources ALTER COLUMN category TYPE VARCHAR(500)`);
    // Generic app settings (key/value). Used for the configurable resources storage quota.
    await pool.query(`CREATE TABLE IF NOT EXISTS app_settings (key VARCHAR(100) PRIMARY KEY, value TEXT, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await pool.query(`INSERT INTO app_settings (key, value) VALUES ('resources_storage_limit_bytes', '5368709120') ON CONFLICT DO NOTHING`); // default 5 GB
    // Per-user storage quota for resources (by uploader email). No row = no personal limit.
    await pool.query(`CREATE TABLE IF NOT EXISTS user_storage_limits (email VARCHAR(255) PRIMARY KEY, limit_bytes BIGINT NOT NULL, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    // Proposals sent to clients (status board: who sent what; live status read from Zoho).
    await pool.query(`CREATE TABLE IF NOT EXISTS proposals_sent (
      id SERIAL PRIMARY KEY,
      estimate_id VARCHAR(64) NOT NULL,
      estimate_number VARCHAR(100),
      customer_name VARCHAR(300),
      rep_email VARCHAR(255),
      to_email VARCHAR(255),
      lang VARCHAR(5),
      sent_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    // Email open-tracking (pixel): a per-send token + when/how often the client opened the email.
    await pool.query(`ALTER TABLE proposals_sent ADD COLUMN IF NOT EXISTS track_token VARCHAR(64)`);
    await pool.query(`ALTER TABLE proposals_sent ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE proposals_sent ADD COLUMN IF NOT EXISTS open_count INT DEFAULT 0`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_proposals_sent_token ON proposals_sent(track_token)`);
    // Accept-link CLICK tracking (reliable, unlike the open pixel): the stored Zoho accept URL
    // we redirect to + when/how often the client clicked through.
    await pool.query(`ALTER TABLE proposals_sent ADD COLUMN IF NOT EXISTS accept_url TEXT`);
    await pool.query(`ALTER TABLE proposals_sent ADD COLUMN IF NOT EXISTS click_count INT DEFAULT 0`);
    await pool.query(`ALTER TABLE proposals_sent ADD COLUMN IF NOT EXISTS first_click_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE proposals_sent ADD COLUMN IF NOT EXISTS last_click_at TIMESTAMPTZ`);
    // Admin-managed category structure for the resources library.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS resource_categories (
        id         SERIAL PRIMARY KEY,
        name       VARCHAR(150) UNIQUE NOT NULL,
        sort_order INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`ALTER TABLE resource_categories ALTER COLUMN name TYPE VARCHAR(500)`);
    // Categories belong to a zone too: NULL owner = shared library folder; set = that user's personal folder.
    await pool.query(`ALTER TABLE resource_categories ADD COLUMN IF NOT EXISTS owner_email VARCHAR(255)`);
    // Drop the old UNIQUE(name) so the same folder name can exist in shared + a user's personal zone;
    // uniqueness is now per (owner, name).
    await pool.query(`ALTER TABLE resource_categories DROP CONSTRAINT IF EXISTS resource_categories_name_key`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_resource_categories_owner_name ON resource_categories ((COALESCE(owner_email,'')), name)`);
    // Audit journal — one row per resource added or deleted (who, what, when).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS resource_audit (
        id          SERIAL PRIMARY KEY,
        action      VARCHAR(20) NOT NULL,
        resource_id INT,
        title       VARCHAR(300),
        file_name   VARCHAR(400),
        category    VARCHAR(150),
        actor       VARCHAR(255),
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    // Invoice-level (entity) discount facts — captured by enrich from the Zoho detail.
    // Comp plan v7.7: commission base = pre-tax value AFTER discount; hardware rate
    // halves (10%→5%) when the discount is ≥ 25%. NULL = not captured yet.
    await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sub_total NUMERIC(12,2)`);
    await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS discount_total NUMERIC(12,2)`);
    // Adjustment carry-forward: when set, the commission's "unlock month" is forced to this date
    // (recalc honors it instead of recomputing), so the invoice appears in the target month's
    // report/stub/payroll as a normal commission line. Cleared on undo. See commission_adjustments.
    await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payable_override DATE`);
    // Admin manually refused commission on this invoice → recalc forces commission 0 / status
    // 'excluded'. Reversible (clear the flag). Per-invoice override of the model.
    await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS commission_excluded BOOLEAN DEFAULT false`);
    // One-time migration: convert OLD-style adjustments (source invoice marked paid in its
    // original month) to the new re-home model (move the unlock month to the target, keep
    // pending). Idempotent — after conversion the payout note is cleared so it won't re-match.
    await pool.query(`
      UPDATE invoices i
         SET payable_override = ca.target_period,
             commission_payable_date = ca.target_period,
             approval_status = 'pending', commission_paid = false,
             payout_paid_by = NULL, payout_paid_at = NULL,
             updated_at = CURRENT_TIMESTAMP
        FROM commission_adjustments ca
       WHERE i.invoice_number = ca.invoice_number
         AND i.payout_paid_by LIKE 'adjustment:%'
         AND i.payable_override IS NULL
    `);
    // Sum of ALL line amounts (hw + saas + noncommission), pre-discount. The discount factor
    // = (sub_total - discount_total) / gross_line_total, because Zoho sometimes bakes the
    // discount into sub_total (discount_total=0, sub_total < line sum) and sometimes reports it
    // separately — dividing the real net pre-tax by our gross line sum handles both.
    await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS gross_line_total NUMERIC(12,2)`);
    // Manual override of a deal's lead source group. Sync only writes lead_source_group, so this
    // override survives re-syncs. Effective source = COALESCE(override, lead_source_group).
    await pool.query(`ALTER TABLE crm_sold_deals ADD COLUMN IF NOT EXISTS lead_source_group_override VARCHAR(255)`);
    // Configurable points per deal type (lead source group). When a deal's effective source has a
    // mapping here, its point value comes from this table; otherwise the synced deal points stand.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deal_source_points (
        source_group VARCHAR(255) PRIMARY KEY,
        points INT NOT NULL DEFAULT 1,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // ROLES & PERMISSIONS — RBAC system
    await pool.query(`
      CREATE TABLE IF NOT EXISTS roles (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(100) UNIQUE NOT NULL,
        description TEXT DEFAULT '',
        permissions JSONB DEFAULT '[]'::jsonb,
        is_system   BOOLEAN DEFAULT false,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_roles (
        user_email  VARCHAR(255) NOT NULL,
        role_id     INT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_email, role_id)
      );
    `);
    // Per-role storage quota for the resources library. A user's effective cap is their
    // explicit per-user limit if set, else the most generous limit among their roles.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS role_storage_limits (
        role_id     INT PRIMARY KEY REFERENCES roles(id) ON DELETE CASCADE,
        limit_bytes BIGINT NOT NULL,
        updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    // Team-scoped managers: which team(s) a (manager) user oversees. Many-to-many — a manager
    // can manage several teams and a team can have several managers. Drives the Manager dashboard
    // + /api/crm/points visibility (they see ONLY their assigned teams, with full detail).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS team_managers (
        user_email VARCHAR(255) NOT NULL,
        team_id    INT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        PRIMARY KEY (user_email, team_id)
      );
    `);
    // User-submitted reports (missing commission / missing points). Reps flag a gap from the
    // Commission Report / Commission Tracker; admins see open ones in the "À corriger" page
    // (and still get the email). 'open' until an admin resolves it.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_reports (
        id             SERIAL PRIMARY KEY,
        report_type    VARCHAR(30) NOT NULL,
        reporter_email VARCHAR(255),
        reporter_name  VARCHAR(255),
        reference      VARCHAR(80),
        period         VARCHAR(20),
        message        TEXT NOT NULL,
        status         VARCHAR(20) NOT NULL DEFAULT 'open',
        created_at     TIMESTAMPTZ DEFAULT NOW(),
        resolved_at    TIMESTAMPTZ,
        resolved_by    VARCHAR(255)
      );
    `);
    // Rate/Savings calculator: pricing templates (Cluster rates + internal costs), per-rep
    // assignment, and saved analyses. See services/savingsCalc.js for the model.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pricing_templates (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(120) NOT NULL,
        is_default  BOOLEAN DEFAULT false,
        active      BOOLEAN DEFAULT true,
        config      JSONB NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pricing_template_assignments (
        rep_email   VARCHAR(255) PRIMARY KEY,
        template_id INT NOT NULL REFERENCES pricing_templates(id) ON DELETE CASCADE,
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS savings_analyses (
        id           SERIAL PRIMARY KEY,
        rep_email    VARCHAR(255),
        rep_name     VARCHAR(255),
        merchant_name VARCHAR(255),
        template_id  INT,
        inputs       JSONB NOT NULL,
        results      JSONB NOT NULL,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    // Seed a default pricing template from the Excel's Cluster values (only if none exists).
    {
      const has = (await pool.query(`SELECT 1 FROM pricing_templates LIMIT 1`)).rows.length;
      if (!has) {
        const cfg = {
          rates: { debit:{rate:0,perTrx:0.05}, credit:{rate:0.0015,perTrx:0.05}, amex:{rate:0.0015,perTrx:0.05} },
          fixedUnit: { terminalS1F2:25, terminalWired:25, pci:7.5, acctOnFile:9, batch:7, lte:0 },
          costs: { perTrx:0.035, discountRate:0.0005, t1Rate:0.0001, monthlyFixed:5.5, terminalS1F2:34.72, terminalWired:27.5 },
        };
        await pool.query(
          `INSERT INTO pricing_templates (name, is_default, active, config) VALUES ($1, true, true, $2::jsonb)`,
          ['Standard Cluster', JSON.stringify(cfg)]
        );
      }
    }
    // Seed preset roles (only inserted once if name not already present)
    await pool.query(`
      INSERT INTO roles (name, description, permissions, is_system)
      VALUES
        ('Sales Rep', 'Standard salesperson — sees own data only',
         '["tracker:view_own","tracker:view_all_totals","report:view_own","invoices:view_own"]'::jsonb, false),
        ('Manager', 'Team manager — full team visibility, can approve commissions',
         '["tracker:view_own","tracker:view_all_totals","tracker:view_all_details","tracker:assign_merchants","report:view_own","report:view_others","report:approve","invoices:view_own","invoices:view_all","invoices:send_email"]'::jsonb, false),
        ('Administrator', 'Full access to everything',
         '["*"]'::jsonb, true)
      ON CONFLICT (name) DO NOTHING;
    `);
    // Ensure the 'Sales Rep' role can view its own pay stub (permission added after the
    // role was first seeded). Idempotent — only appends if missing.
    await pool.query(`
      UPDATE roles SET permissions = permissions || '["report:view_paystub"]'::jsonb
      WHERE name = 'Sales Rep' AND NOT (permissions ? 'report:view_paystub')
    `);
    // Resources library can be viewed by Sales Rep + Manager out of the box (admins adjust per role).
    await pool.query(`
      UPDATE roles SET permissions = permissions || '["resources:view"]'::jsonb
      WHERE name IN ('Sales Rep', 'Manager') AND NOT (permissions ? 'resources:view')
    `);
    // The personal home dashboard is on by default for Sales Rep + Manager (added after seed).
    await pool.query(`
      UPDATE roles SET permissions = permissions || '["dashboard:view_own"]'::jsonb
      WHERE name IN ('Sales Rep', 'Manager') AND NOT (permissions ? 'dashboard:view_own')
    `);
    // Auto-assign 'Administrator' role to existing is_admin users
    await pool.query(`
      INSERT INTO user_roles (user_email, role_id)
      SELECT u.email, r.id
      FROM user_tokens u CROSS JOIN roles r
      WHERE u.is_admin = true AND r.name = 'Administrator'
      ON CONFLICT DO NOTHING;
    `);

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
    // Backfill legacy exclusions saved with a NULL org (Adyen, First Data, UEAT, …): the org-scoped
    // GET + dashboard filter query `organization_id = $org`, so NULL-org rows were invisible — the
    // list showed empty and the dashboard never excluded them. Single-org app → safe to claim them.
    if (process.env.ZOHO_ORG_ID) {
      await pool.query(`UPDATE excluded_customers SET organization_id = $1 WHERE organization_id IS NULL`, [process.env.ZOHO_ORG_ID]);
    }
    await pool.query(`DELETE FROM excluded_customers WHERE customer_name = '__probe__'`);

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
    // One-time migration: fix broken release URLs from the old buggy format
    {
      const owner = process.env.GITHUB_OWNER || 'milthuz';
      const repo  = process.env.GITHUB_PRIMARY_REPO || 'commission-tracker';
      const fix = await pool.query(
        `UPDATE releases
         SET url = 'https://github.com/${owner}/${repo}/releases/tag/' || version
         WHERE url LIKE 'https://github.com/releases/%' OR url IS NULL OR url = ''`
      );
      if (fix.rowCount > 0) {
        console.log(`🔧 Repaired ${fix.rowCount} release URLs (legacy/empty)`);
      }
    }

    // Generic key-value sync state table — used to track last delta sync timestamps,
    // last webhook event seen, etc. Avoids creating one column per piece of state.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sync_state (
        key VARCHAR(100) PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Commission payment imports — each .xlsx import lands a summary row here,
    // with related signup/monthly bonuses going into commission_bonuses (FK link).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS commission_payment_imports (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(500) NOT NULL,
        rep_name VARCHAR(255) NOT NULL,
        paid_for_period DATE NOT NULL,
        imported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        imported_by VARCHAR(255),
        invoices_marked INT DEFAULT 0,
        invoices_skipped INT DEFAULT 0,
        invoices_not_found INT DEFAULT 0,
        signup_bonuses_count INT DEFAULT 0,
        signup_bonuses_amount NUMERIC(12,2) DEFAULT 0,
        monthly_bonus_amount NUMERIC(12,2) DEFAULT 0,
        total_amount NUMERIC(12,2) DEFAULT 0,
        raw_summary JSONB
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cp_imports_period ON commission_payment_imports(paid_for_period DESC, rep_name)`);

    // Tracks which "new feature" announcements each user has seen (per-user, cross-device).
    // The feature catalog itself lives in the frontend; we just store seen feature_ids here.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_seen_features (
        user_key   VARCHAR(255) NOT NULL,
        feature_id VARCHAR(255) NOT NULL,
        seen_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_key, feature_id)
      );
    `);

    // External (non-Zoho) users: invited by an admin, log in with email+password and
    // MANDATORY TOTP 2FA. Tokens (invite/reset) are stored as sha256 hashes, single-use,
    // expiring. Permissions come from the existing roles system (user_roles by email).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS local_users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        display_name VARCHAR(255),
        password_hash VARCHAR(255),
        totp_secret VARCHAR(64),
        totp_enabled BOOLEAN DEFAULT false,
        status VARCHAR(20) DEFAULT 'invited',
        invite_token_hash VARCHAR(64),
        invite_expires_at TIMESTAMP,
        reset_token_hash VARCHAR(64),
        reset_expires_at TIMESTAMP,
        invited_by VARCHAR(255),
        last_login_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Resellers — third-party companies that resell licenses. POS activations come from a
    // Zoho Form; residual payments come from Zentact. Linked by reseller name for now.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS resellers (
        id         SERIAL PRIMARY KEY,
        name       VARCHAR(255) UNIQUE NOT NULL,
        email      VARCHAR(255),
        active     BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    // Reseller identity resolution: associated form emails + a Zentact key (residuals).
    await pool.query(`ALTER TABLE resellers ADD COLUMN IF NOT EXISTS emails JSONB DEFAULT '[]'::jsonb`);
    await pool.query(`ALTER TABLE resellers ADD COLUMN IF NOT EXISTS zentact_key VARCHAR(255)`);
    // Name aliases: other names the same reseller is known by in the Zoho form / Zentact
    // (e.g. "Lirette" for a reseller renamed "Lirette MG"). Lowercased; used to roll up
    // activations/residuals that don't match the canonical name exactly.
    await pool.query(`ALTER TABLE resellers ADD COLUMN IF NOT EXISTS name_aliases JSONB DEFAULT '[]'::jsonb`);
    // Per-reseller logo, stored in-DB as bytea (mirrors the Resources library — no object storage).
    await pool.query(`ALTER TABLE resellers ADD COLUMN IF NOT EXISTS logo_data BYTEA`);
    await pool.query(`ALTER TABLE resellers ADD COLUMN IF NOT EXISTS logo_mime_type VARCHAR(150)`);
    await pool.query(`ALTER TABLE resellers ADD COLUMN IF NOT EXISTS logo_file_name VARCHAR(400)`);
    await pool.query(`ALTER TABLE resellers ADD COLUMN IF NOT EXISTS logo_updated_at TIMESTAMP`);
    await pool.query(`UPDATE resellers SET emails = jsonb_build_array(LOWER(email))
                      WHERE (emails IS NULL OR emails = '[]'::jsonb) AND email IS NOT NULL AND email <> ''`);

    // "What's New" catalog — backend-driven so admins choose what's new when publishing a
    // release (no code deploy). The per-user "seen" state lives in user_seen_features (by feature_id).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS new_features (
        id          SERIAL PRIMARY KEY,
        feature_id  VARCHAR(255) UNIQUE NOT NULL,
        path        VARCHAR(255) NOT NULL,
        title       TEXT,
        description TEXT,
        since       DATE DEFAULT CURRENT_DATE,
        days        INT  DEFAULT 7,
        release_id  INT,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    // Migrate the one entry that used to live in the frontend registry (keeps its dot/seen state).
    await pool.query(`
      INSERT INTO new_features (feature_id, path, title, description, since, days)
      VALUES ('admin-data-tools-2026-06', '/admin/sync',
              'Invoice Enrichment & Recalculation',
              'New tools to enrich invoices (classify hardware/SaaS) and recalculate commissions.',
              '2026-06-04', 7)
      ON CONFLICT (feature_id) DO NOTHING
    `);

    // POS license activations — submissions from the resellers' Zoho order form (via webhook).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS reseller_pos_activations (
        id            SERIAL PRIMARY KEY,
        reseller_name VARCHAR(255),
        license_type  VARCHAR(255),
        quantity      INT DEFAULT 1,
        customer_name VARCHAR(255),
        submitted_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        raw           JSONB,
        created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pos_activations_reseller ON reseller_pos_activations(reseller_name)`);
    // Resellers are identified by EMAIL (the form's reseller-name field is often blank).
    await pool.query(`ALTER TABLE reseller_pos_activations ADD COLUMN IF NOT EXISTS reseller_email VARCHAR(255)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS commission_bonuses (
        id SERIAL PRIMARY KEY,
        import_id INT REFERENCES commission_payment_imports(id) ON DELETE CASCADE,
        rep_name VARCHAR(255) NOT NULL,
        bonus_type VARCHAR(50) NOT NULL,
        merchant_name VARCHAR(255),
        matched_zentact_id VARCHAR(255),
        amount NUMERIC(12,2) NOT NULL,
        paid_for_period DATE,
        report_date DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cbonus_period ON commission_bonuses(paid_for_period DESC, rep_name)`);

    // Per-invoice payment lines for each import (a pay stub's detail). paid_amount = the amount
    // FROM the imported file (faithful to what was actually paid); app_commission = the app's
    // computed value at import time (for app-vs-file discrepancy auditing).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS commission_payment_lines (
        id SERIAL PRIMARY KEY,
        import_id INT REFERENCES commission_payment_imports(id) ON DELETE CASCADE,
        invoice_number VARCHAR(255) NOT NULL,
        customer VARCHAR(255),
        paid_amount NUMERIC(12,2) NOT NULL,
        app_commission NUMERIC(12,2),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cplines_import ON commission_payment_lines(import_id)`);
    // Lines paid per the file but whose invoice is NOT in our DB (pre-2025, out of sync scope).
    // Stored anyway so the pay stub reflects the FULL real payout; flagged for display.
    await pool.query(`ALTER TABLE commission_payment_lines ADD COLUMN IF NOT EXISTS not_in_db BOOLEAN DEFAULT false`);

    // Webhook activity log — every call to our webhook endpoints lands a row here
    // so we can audit/debug who fired what without needing Heroku log access.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS webhook_log (
        id SERIAL PRIMARY KEY,
        received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        endpoint VARCHAR(200),
        invoice_number VARCHAR(100),
        event VARCHAR(50),
        action VARCHAR(50),
        result VARCHAR(50),
        user_agent TEXT,
        source_ip VARCHAR(64),
        body JSONB
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_webhook_log_received_at ON webhook_log(received_at DESC)`);

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

    // Zoho Billing plans — used to classify Books invoice line items as SaaS vs Hardware
    // The plan_code is matched against the line item's SKU (item_code) on Books invoices.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS zoho_plans (
        plan_code        VARCHAR(255) PRIMARY KEY,
        name             VARCHAR(500) DEFAULT '',
        description      TEXT DEFAULT '',
        recurring_price  DECIMAL(12,2) DEFAULT 0,
        interval         VARCHAR(50) DEFAULT '',
        interval_unit    VARCHAR(50) DEFAULT '',
        currency_code    VARCHAR(10) DEFAULT '',
        product_id       VARCHAR(255) DEFAULT '',
        product_name     VARCHAR(500) DEFAULT '',
        status           VARCHAR(50) DEFAULT '',
        is_saas          BOOLEAN DEFAULT true,
        raw              JSONB,
        created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
        reseller_attribute  VARCHAR(255),
        activated_at        DATE,
        points              INT          DEFAULT 1,
        bonus_amount        DECIMAL(10,2) DEFAULT 100.00,
        stores              JSONB,
        raw_attributes      JSONB,
        created_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
        updated_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
      );
    `);
    // Zentact "Reseller" custom attribute — added after the table shipped, so
    // ensure it exists on the live table too (CREATE TABLE IF NOT EXISTS is a no-op there).
    await pool.query(`ALTER TABLE zentact_merchants ADD COLUMN IF NOT EXISTS reseller_attribute VARCHAR(255)`);
    // Stores (locations) nested under a merchant account — added after the table shipped.
    await pool.query(`ALTER TABLE zentact_merchants ADD COLUMN IF NOT EXISTS stores JSONB`);

    // Per-merchant monthly revenue from Zentact's transaction-profitability report.
    // All monetary fields are in MINOR UNITS (cents). transaction_profit_cents = the
    // report's `totalRevenue` (collectedFees - processingCost) = Cluster's margin.
    // other_revenue_cents (recurring/fixed fees) is reserved for Phase 2 (PDF parsing).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS zentact_merchant_revenue (
        id                       SERIAL PRIMARY KEY,
        merchant_account_id      VARCHAR(255) NOT NULL,
        year                     INT NOT NULL,
        month                    INT NOT NULL,
        currency                 VARCHAR(8),
        total_volume_cents       BIGINT DEFAULT 0,
        payments_count           INT    DEFAULT 0,
        processing_cost_cents    BIGINT DEFAULT 0,
        collected_fees_cents     BIGINT DEFAULT 0,
        gateway_fee_cents        BIGINT DEFAULT 0,
        transaction_profit_cents BIGINT DEFAULT 0,
        other_revenue_cents      BIGINT,
        raw                      JSONB,
        synced_at                TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (merchant_account_id, year, month)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_merch_revenue_period ON zentact_merchant_revenue(year, month)`);

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
      'https://sparkly-kulfi-c7641a.netlify.app', // Netlify (default)
      'https://saleshub.clusterpos.com', // custom domain
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
app.use(bodyParser.json({
  // Capture the raw body so webhook HMAC signatures can be verified
  verify: (req, _res, buf) => { req.rawBody = buf; },
  limit: '10mb',
}));

// JWT middleware — also supports admin impersonation via X-Impersonate-As header.
// When an admin sends X-Impersonate-As: <salesperson_name>, the request is treated
// as if it came from that salesperson (isAdmin=false, name=impersonated). Useful
// for testing what regular users see without logging out.
const authenticateToken = async (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const user = jwt.verify(token, JWT_SECRET);
    req.user = user;

    // SECURITY: the Zoho-login JWT is signed isAdmin:true for everyone (legacy). NEVER trust
    // that flag — re-resolve the REAL admin status from user_tokens on every request. Without
    // this, any logged-in rep is treated as a full admin server-side (requirePerm auto-passes,
    // /api/crm/points returns everyone's deals, etc.). Local (external) users aren't in
    // user_tokens → resolves false, which is correct (they're never admins).
    let realIsAdmin = false;
    if (user.email) {
      try {
        const r = await pool.query('SELECT is_admin FROM user_tokens WHERE LOWER(email) = LOWER($1) LIMIT 1', [user.email]);
        realIsAdmin = r.rows[0]?.is_admin === true;
      } catch { /* default false */ }
    }
    req.user.isAdmin = realIsAdmin;

    const impersonateVal = req.headers['x-impersonate-as'];
    if (impersonateVal && realIsAdmin) {
      const v = String(impersonateVal).trim();
      let adoptEmail = null, adoptName = null;
      if (v.includes('@')) {
        // Email-based (works for ANY user — Zoho, external, or role-only): adopt this
        // email's identity so their own permissions apply. Display name resolved from
        // whichever table knows them, else the email itself.
        const r = await pool.query(
          `SELECT COALESCE(
             (SELECT display_name FROM user_tokens WHERE LOWER(email) = LOWER($1) LIMIT 1),
             (SELECT display_name FROM local_users WHERE LOWER(email) = LOWER($1) LIMIT 1),
             (SELECT name FROM salespeople WHERE LOWER(email) = LOWER($1) LIMIT 1),
             $1
           ) AS name`, [v]
        );
        adoptEmail = v.toLowerCase();
        adoptName  = r.rows[0].name;
      } else {
        // Legacy name-based: match a salesperson, adopt their login account (or card email).
        const result = await pool.query('SELECT name FROM salespeople WHERE LOWER(name) = LOWER($1) LIMIT 1', [v]);
        if (result.rows.length > 0) {
          adoptName = result.rows[0].name;
          const acct = await pool.query(
            `SELECT COALESCE(
               (SELECT email FROM user_tokens WHERE LOWER(display_name) = LOWER($1) LIMIT 1),
               (SELECT email FROM salespeople WHERE LOWER(name) = LOWER($1) LIMIT 1)
             ) AS email`, [adoptName]
          );
          adoptEmail = acct.rows[0]?.email || null;
        }
      }
      if (adoptName !== null) {
        req.user.realAdminEmail = user.email;
        req.user.realAdminName  = user.name;
        req.user.name           = adoptName;
        req.user.isAdmin        = false;               // never admin while impersonating
        req.user.impersonating  = true;
        req.user.email          = adoptEmail;          // their own perms (or none)
      }
    }
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

  // Only force the Zoho consent screen when explicitly RECONNECTING (?reconsent=1).
  // Zoho re-issues a refresh_token on consent; a normal login doesn't need a new one
  // (the callback preserves the stored refresh_token via COALESCE), so forcing consent
  // on every login just made every user re-approve each time. Omitting prompt lets Zoho
  // silently redirect returning users who already granted access. First-time users (and
  // an explicit reconnect to repair a broken refresh_token) still get the consent screen.
  const forceConsent = req.query.reconsent === '1' || req.query.prompt === 'consent';

  const authUrl = `${ZOHO_CONFIG.accounts_url}/oauth/v2/auth?` +
    `scope=ZohoBooks.invoices.READ,ZohoBooks.invoices.CREATE,ZohoBooks.invoices.UPDATE,ZohoBooks.estimates.READ,ZohoBooks.contacts.READ,ZohoSubscriptions.plans.READ,ZohoSubscriptions.products.READ,ZohoSubscriptions.subscriptions.READ,AaaServer.profile.READ` +
    `&client_id=${ZOHO_CONFIG.client_id}` +
    `&response_type=code` +
    `&redirect_uri=${ZOHO_CONFIG.redirect_uri}` +
    `&state=${state}` +
    `&access_type=offline` +
    (forceConsent ? `&prompt=consent` : ``);

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
         access_token = $2,
         -- NEVER wipe an existing refresh_token: Zoho only returns one on consent, so a
         -- normal login (no refresh_token in the response) must preserve what we already have.
         -- Overwriting with NULL here is exactly what broke the admin's Books sync.
         refresh_token = COALESCE(NULLIF($3, ''), user_tokens.refresh_token),
         api_domain = $4, expires_at = $5,
         photo = $6, display_name = $7, updated_at = CURRENT_TIMESTAMP`,
        [userEmail, access_token, refresh_token, api_domain, Date.now() + expires_in * 1000, userPhoto, userName]
      );
      console.log('✅ Tokens stored in database for:', userEmail);
    } catch (dbError) {
      console.error('❌ Database error:', dbError.message);
      return res.status(500).json({ error: 'Failed to store tokens in database' });
    }

    // Auto-assign the default 'Sales Rep' role IF this login is an ACTIVE salesperson and
    // has no roles yet (so new reps get access without manual setup — but NOT every new
    // user: admins/non-reps are unaffected since they don't match an active salesperson).
    // Match by EITHER the Zoho display name = salesperson name, OR the login email = the
    // salesperson's "Courriel de connexion" (card email) — the email match is robust to
    // name/accents/format mismatches between Zoho and the salespeople table.
    try {
      await pool.query(
        `INSERT INTO user_roles (user_email, role_id)
         SELECT $1, r.id FROM roles r
         WHERE r.name = 'Sales Rep'
           AND EXISTS (SELECT 1 FROM salespeople s WHERE s.is_active = true
                       AND (LOWER(s.name) = LOWER($2) OR LOWER(s.email) = LOWER($1)))
           AND NOT EXISTS (SELECT 1 FROM user_roles ur WHERE LOWER(ur.user_email) = LOWER($1))
         ON CONFLICT DO NOTHING`,
        [userEmail, userName]
      );
    } catch (_e) { /* non-fatal — role can be assigned manually */ }

    // Create JWT — photo stored in DB, not JWT (base64 would be too large for URL)
    const jwtToken = jwt.sign(
      {
        email:   userEmail,
        name:    userName,
        zoho_id: userInfo.ZUID,
        isAdmin: true
      },
      JWT_SECRET,
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
    // When impersonating, req.user.email is cleared — skip the lookup
    const row = req.user.impersonating
      ? {}
      : (await pool.query(
          'SELECT photo, display_name, is_admin FROM user_tokens WHERE email = $1',
          [req.user.email]
        )).rows[0] || {};

    // Effective permissions = those of the current identity. While impersonating,
    // req.user.email is the impersonated user's own account (or null → no perms),
    // so this returns exactly what that user would see — never the admin's perms.
    const permSet = await getUserPermissions(req.user.email);
    // Super-admins always get the full set (wildcard)
    const isAdmin = row.is_admin != null ? row.is_admin : (req.user.isAdmin || false);
    const permissions = isAdmin ? ['*'] : [...permSet];

    // Is the current user actually an active salesperson? (used by Commission Report
    // to decide whether to show 'My Report' option — admins who aren't reps shouldn't see it)
    const displayName = row.display_name || req.user.name || req.user.email;
    let isSalesperson = false;
    try {
      const sp = await pool.query(
        'SELECT 1 FROM salespeople WHERE LOWER(name) = LOWER($1) AND is_active = true LIMIT 1',
        [displayName]
      );
      isSalesperson = sp.rows.length > 0;
    } catch { /* ignore — default false */ }

    res.json({
      valid: true,
      user: {
        email:   req.user.email,
        name:    displayName,
        photo:   row.photo || req.user.photo || null,
        zoho_id: req.user.zoho_id || req.user.email,
        isAdmin,
        isSalesperson,
        permissions,
        impersonating:   req.user.impersonating || false,
        realAdminEmail:  req.user.realAdminEmail || null,
        realAdminName:   req.user.realAdminName  || null,
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

// ============================================================================
// LOCAL (EXTERNAL) USERS — email+password login, MANDATORY TOTP 2FA, invitations
// ============================================================================
// Flow: admin invites (email sent or link copied) → user sets password → scans the
// TOTP QR and confirms a code → account active. Login = password + 6-digit code.
// Permissions come from the existing roles system (assign roles to their email in
// Admin → Roles). JWTs are signed with isAdmin:false — never admin by default.

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newRawToken = () => crypto.randomBytes(32).toString('hex');
authenticator.options = { window: 1 }; // tolerate ±30s clock drift

// SMTP mailer — Heroku config vars: SMTP_HOST, SMTP_PORT (465=TLS), SMTP_USER,
// SMTP_PASS, SMTP_FROM. Unconfigured → emails are skipped and the API returns the
// link so the admin can send it manually.
function getMailer() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  const port = parseInt(process.env.SMTP_PORT) || 465;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST, port, secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}
async function sendMail(to, subject, html, opts = {}) {
  const t = getMailer();
  if (!t) return { sent: false, reason: 'smtp_not_configured' };
  try {
    const msg = { from: opts.from || process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, html };
    if (opts.replyTo) msg.replyTo = opts.replyTo;
    if (opts.cc) msg.cc = opts.cc;
    if (opts.attachments) msg.attachments = opts.attachments; // [{ filename, content(Buffer), contentType }]
    await t.sendMail(msg);
    return { sent: true };
  } catch (e) {
    console.warn('[MAIL] send failed:', e.message);
    return { sent: false, reason: e.message };
  }
}
// Shared branded email chrome: dark header with the Cluster logo, orange accent bar,
// white content card, and a bilingual footer. `inner` is arbitrary trusted HTML (already
// escaped by the caller). Every transactional email funnels through here so they all look
// identical — pay stubs and payroll included.
function mailChrome(inner, preheaderRaw) {
  const year = new Date().getFullYear();
  const base = process.env.FRONTEND_URL || 'https://saleshub.clusterpos.com';
  const preheader = String(preheaderRaw || '').replace(/<[^>]+>/g, '');
  return `<!doctype html><html lang="fr"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light">
  </head>
  <body style="margin:0;padding:0;background:#eef1f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#eef1f6;font-size:1px;line-height:1px">${preheader}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f6;padding:32px 12px">
      <tr><td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(16,23,34,.08),0 10px 28px rgba(16,23,34,.07)">
          <tr><td style="background:#0f1722;padding:22px 36px">
            <table role="presentation" cellpadding="0" cellspacing="0"><tr>
              <td style="padding-right:12px;vertical-align:middle">
                <img src="${base}/cluster-favicon-256.png" width="36" height="36" alt="Cluster" style="display:block;border:0;border-radius:9px">
              </td>
              <td style="vertical-align:middle">
                <span style="color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-.3px">Sales&nbsp;Hub</span><span style="color:#f97316;font-size:22px;font-weight:700">.</span>
                <span style="display:block;color:#8a99af;font-size:12px;margin-top:2px;letter-spacing:.2px">by Cluster Systems</span>
              </td>
            </tr></table>
          </td></tr>
          <tr><td style="height:4px;background:#f97316;font-size:0;line-height:0">&nbsp;</td></tr>
          <tr><td style="padding:34px 36px 6px">${inner}</td></tr>
          <tr><td style="padding:26px 36px 0"><div style="border-top:1px solid #eef1f6;font-size:0;line-height:0">&nbsp;</div></td></tr>
          <tr><td style="padding:16px 36px 30px">
            <p style="margin:0;color:#94a3b8;font-size:12px;line-height:1.7">
              Une question ? / Questions? <a href="mailto:saleshub@clustersystems.com" style="color:#3c50e0;text-decoration:none">saleshub@clustersystems.com</a><br>
              © ${year} Cluster Systems — <a href="${base}" style="color:#94a3b8;text-decoration:none">saleshub.clusterpos.com</a>
            </p>
          </td></tr>
        </table>
        <p style="color:#aab4c4;font-size:11px;margin:18px 0 0">Sales Hub · Cluster Systems</p>
      </td></tr>
    </table>
  </body></html>`;
}
// Convenience wrapper for the common "heading + paragraph + optional CTA" email.
function mailShell(title, intro, ctaLabel, ctaUrl) {
  const inner = `<h1 style="margin:0 0 14px;color:#0f1722;font-size:20px;font-weight:700;line-height:1.3">${title}</h1>
            <div style="color:#475569;font-size:14.5px;line-height:1.65">${intro}</div>
            ${(ctaUrl && ctaLabel) ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 4px"><tr><td style="border-radius:9px;background:#3c50e0">
              <a href="${ctaUrl}" style="display:inline-block;padding:13px 30px;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;border-radius:9px">${ctaLabel}</a>
            </td></tr></table>
            <p style="margin:18px 0 0;color:#94a3b8;font-size:12px;line-height:1.6">Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :<br>
            If the button doesn't work, copy this link into your browser:<br>
            <a href="${ctaUrl}" style="color:#3c50e0;word-break:break-all">${ctaUrl}</a></p>` : ''}`;
  return mailChrome(inner, title);
}

// Simple in-memory rate limiter for credential endpoints (per dyno — good enough).
const authAttempts = new Map();
function rateLimited(key, max = 8, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const e = authAttempts.get(key);
  if (!e || now > e.resetAt) { authAttempts.set(key, { count: 1, resetAt: now + windowMs }); return false; }
  e.count++;
  return e.count > max;
}

const signLocalJwt = (u) => jwt.sign(
  { email: u.email, name: u.display_name || u.email, isAdmin: false, userType: 'local' },
  JWT_SECRET, { expiresIn: '7d' }
);
const signMfaJwt = (email, purpose) => jwt.sign(
  { email, purpose }, JWT_SECRET, { expiresIn: '15m' }
);
function verifyMfaJwt(token, purpose) {
  try {
    const p = jwt.verify(token, JWT_SECRET);
    return p.purpose === purpose ? p : null;
  } catch { return null; }
}

// --- Admin: invitations & external-user management (gate: admin:users) ---

// POST /api/admin/local-users/invite { email, name } → creates/refreshes the invite + emails it
app.post('/api/admin/local-users/invite', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'admin:users'))) return;
  const email = String(req.body.email || '').trim().toLowerCase();
  const name  = String(req.body.name || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Invalid email' });
  try {
    const raw = newRawToken();
    const expires = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    const actor = req.user.realAdminEmail || req.user.email || 'unknown';
    const existing = (await pool.query(`SELECT id, status FROM local_users WHERE email = $1`, [email])).rows[0];
    if (existing && existing.status === 'active') {
      return res.status(409).json({ error: 'User already active' });
    }
    await pool.query(
      `INSERT INTO local_users (email, display_name, status, invite_token_hash, invite_expires_at, invited_by)
       VALUES ($1, $2, 'invited', $3, $4, $5)
       ON CONFLICT (email) DO UPDATE SET
         display_name = $2, status = 'invited', invite_token_hash = $3,
         invite_expires_at = $4, invited_by = $5, updated_at = CURRENT_TIMESTAMP`,
      [email, name || null, sha256hex(raw), expires, actor]
    );
    const base = process.env.FRONTEND_URL || 'https://saleshub.clusterpos.com';
    const inviteUrl = `${base}/accept-invite?token=${raw}`;
    const mail = await sendMail(
      email,
      'Invitation — Sales Hub / You are invited to Sales Hub',
      mailShell(
        'Vous êtes invité à Sales Hub · You are invited to Sales Hub',
        `${name ? name + ', ' : ''}un compte vous a été préparé sur Sales Hub (suivi des ventes et commissions de Cluster Systems). Cliquez ci-dessous pour choisir votre mot de passe et activer la vérification en deux étapes. Le lien expire dans 7 jours.<br><br>An account has been prepared for you on Sales Hub (Cluster Systems' sales & commission portal). Click below to set your password and enable two-step verification. The link expires in 7 days.`,
        'Activer mon compte / Activate my account',
        inviteUrl
      )
    );
    res.json({ success: true, inviteUrl, emailSent: mail.sent, emailError: mail.sent ? null : mail.reason });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/local-users/test-email — send a test message to the calling admin
// so SMTP config (Google Workspace app password etc.) can be verified in one click.
app.post('/api/admin/local-users/test-email', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'admin:users'))) return;
  const to = req.user.realAdminEmail || req.user.email;
  if (!to) return res.status(400).json({ error: 'No email on the current session' });
  const mail = await sendMail(
    to,
    'Test — Sales Hub email configuration',
    mailShell(
      'Configuration courriel OK · Email configuration works',
      `Ce message confirme que l'envoi de courriels de Sales Hub fonctionne (SMTP ${process.env.SMTP_HOST || '?'}).<br><br>This message confirms Sales Hub outbound email is working.`,
      'Ouvrir Sales Hub / Open Sales Hub',
      process.env.FRONTEND_URL || 'https://saleshub.clusterpos.com'
    )
  );
  res.json({ sent: mail.sent, to, error: mail.sent ? null : mail.reason });
});

// ── Email template preview & test (admin:users) ─────────────────────────────
// Render each transactional email with sample data so an admin can see the look
// & feel in the panel and send a test copy. Mirrors the real builders so the
// preview reflects exactly what recipients get.
const EMAIL_TEMPLATE_TYPES = ['invitation', 'reset', 'paystub', 'payroll', 'feature_request', 'missing_commission', 'missing_points'];
function sampleEmail(type, lang) {
  const base = process.env.FRONTEND_URL || 'https://saleshub.clusterpos.com';
  const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  switch (type) {
    case 'reset':
      return { subject: 'Réinitialisation du mot de passe — Sales Hub / Password reset',
        html: mailShell('Réinitialiser votre mot de passe · Reset your password',
          `Une réinitialisation du mot de passe a été demandée pour votre compte Sales Hub. Le lien expire dans 1 heure.<br><br>A password reset was requested for your Sales Hub account. The link expires in 1 hour.`,
          'Réinitialiser / Reset password', `${base}/reset-password?token=SAMPLE`) };
    case 'paystub': {
      const sectionLabel = (txt) => `<p style="margin:18px 0 6px;color:#94a3b8;font-size:11px;text-transform:uppercase;font-weight:700;letter-spacing:.4px">${txt}</p>`;
      const lineRows = [['INV-001', 'Café du Coin', 420.00], ['INV-002', 'Boutique Émilie', 180.50]]
        .map(([inv, cust, amt]) => `<tr><td style="padding:6px 10px;border-top:1px solid #eef1f6;font-family:monospace">${inv}</td><td style="padding:6px 10px;border-top:1px solid #eef1f6">${cust}</td><td style="padding:6px 10px;border-top:1px solid #eef1f6;text-align:right">${money(amt)}</td></tr>`).join('');
      const bonusRows = `<tr><td style="padding:6px 10px;border-top:1px solid #eef1f6">Bonus mensuel</td><td style="padding:6px 10px;border-top:1px solid #eef1f6">—</td><td style="padding:6px 10px;border-top:1px solid #eef1f6;text-align:right">${money(150)}</td></tr>`;
      const inner = `<h1 style="margin:0 0 4px;color:#0f1722;font-size:20px;font-weight:700;line-height:1.3">Amy Spicer</h1>
            <p style="margin:0 0 4px;color:#64748b;font-size:13px">Bulletin de paie / Pay Stub · 2026-05</p>
            <p style="margin:0;color:#64748b;font-size:13px">En attente d'approbation / Pending approval</p>
            ${sectionLabel('Commissions')}<table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#1c2434;border-collapse:collapse">${lineRows}</table>
            ${sectionLabel('Bonus')}<table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#1c2434;border-collapse:collapse">${bonusRows}</table>
            <table width="100%" style="margin-top:20px;border-top:2px solid #0f1722"><tr><td style="padding-top:12px;font-size:14px;font-weight:700;color:#0f1722">Total</td><td style="padding-top:12px;text-align:right;font-size:20px;font-weight:700;color:#f97316">${money(750.50)}</td></tr></table>
            <p style="margin:18px 0 0;color:#94a3b8;font-size:11px">Montants bruts, avant impôts et retenues. / Gross amounts, before tax and withholdings.</p>`;
      return { subject: 'Bulletin de paie / Pay Stub — Amy Spicer · 2026-05', html: mailChrome(inner, 'Bulletin de paie / Pay Stub') };
    }
    case 'payroll': {
      const T = payrollI18n(lang);
      const rows = [['Amy Spicer', 750.50], ['Gabriella Daly', 1240.00], ['Sophie Tremblay', 430.25]];
      const grand = rows.reduce((s, r) => s + r[1], 0);
      const rowsHtml = rows.map(([rep, tot]) => `<tr><td style="padding:6px 10px;border-top:1px solid #eef1f6">${rep}</td><td style="padding:6px 10px;border-top:1px solid #eef1f6;text-align:right">${money(tot)}</td></tr>`).join('');
      const inner = `<h1 style="margin:0 0 14px;color:#0f1722;font-size:20px;font-weight:700;line-height:1.3">${T.emailSubject} — 2026-05</h1>
            <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#1c2434;border-collapse:collapse">
              <tr><th style="text-align:left;padding:6px 10px;color:#94a3b8;font-size:11px;letter-spacing:.4px">${T.rep}</th><th style="text-align:right;padding:6px 10px;color:#94a3b8;font-size:11px;letter-spacing:.4px">${T.amount}</th></tr>
              ${rowsHtml}
              <tr><td style="padding:10px;border-top:2px solid #0f1722;font-weight:700">${T.totalPaid}</td><td style="padding:10px;border-top:2px solid #0f1722;text-align:right;font-weight:700;color:#f97316">${money(grand)}</td></tr>
            </table>
            <p style="margin:18px 0 0;color:#94a3b8;font-size:11px">${T.emailFooter}</p>`;
      return { subject: `${T.emailSubject} — 2026-05`, html: mailChrome(inner, T.emailSubject) };
    }
    case 'feature_request':
      return { subject: 'Demande de fonctionnalité — Amy Spicer',
        html: mailShell('Demande de fonctionnalité / Feature request',
          `<strong>Amy Spicer</strong> (amy@example.com) propose / suggests:<br><br>Ajouter un export Excel sur la page des commissions.`, null, null) };
    case 'missing_points':
      return { subject: 'Points manquants — Amy Spicer',
        html: mailShell('Signalement de points manquants / Missing points report',
          `<strong>Amy Spicer</strong> (amy@example.com) signale des points possiblement manquants / reports possibly missing points.<br><br><strong>Marchand / dossier · Merchant :</strong> Café du Coin<br><strong>Période · Period :</strong> 2026-05<br><strong>Message :</strong><br>Le marchand n'apparaît pas dans mes points.`, null, null) };
    case 'missing_commission':
      return { subject: 'Commission manquante — Amy Spicer',
        html: mailShell('Signalement de commission manquante / Missing commission report',
          `<strong>Amy Spicer</strong> (amy@example.com) signale une commission possiblement manquante / reports a possibly missing commission.<br><br><strong>Facture · Invoice :</strong> INV-001<br><strong>Période · Period :</strong> 2026-05<br><strong>Message :</strong><br>Cette facture devrait m'être attribuée.`, null, null) };
    case 'invitation':
    default:
      return { subject: 'Invitation — Sales Hub / You are invited to Sales Hub',
        html: mailShell('Vous êtes invité à Sales Hub · You are invited to Sales Hub',
          `Marie, un compte vous a été préparé sur Sales Hub. Cliquez ci-dessous pour choisir votre mot de passe et activer la vérification en deux étapes. Le lien expire dans 7 jours.<br><br>An account has been prepared for you on Sales Hub. Click below to set your password and enable two-step verification. The link expires in 7 days.`,
          'Activer mon compte / Activate my account', `${base}/accept-invite?token=SAMPLE`) };
  }
}

// GET /api/admin/email-preview?type=&lang= → { type, subject, html } for the preview iframe.
app.get('/api/admin/email-preview', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'admin:users'))) return;
  const type = EMAIL_TEMPLATE_TYPES.includes(req.query.type) ? req.query.type : 'invitation';
  res.json({ type, types: EMAIL_TEMPLATE_TYPES, ...sampleEmail(type, req.query.lang) });
});

// POST /api/admin/email-preview/send { type, lang, to } → email a sample (defaults to the admin).
app.post('/api/admin/email-preview/send', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'admin:users'))) return;
  const type = EMAIL_TEMPLATE_TYPES.includes(req.body.type) ? req.body.type : 'invitation';
  const to = String(req.body.to || req.user.realAdminEmail || req.user.email || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return res.status(400).json({ error: 'valid recipient email required' });
  const s = sampleEmail(type, req.body.lang);
  const mail = await sendMail(to, `[TEST] ${s.subject}`, s.html);
  res.json({ sent: mail.sent, to, error: mail.sent ? null : mail.reason });
});

// GET /api/admin/local-users — list external users (no secrets)
app.get('/api/admin/local-users', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'admin:users'))) return;
  try {
    const rows = (await pool.query(
      `SELECT id, email, display_name, status, totp_enabled,
              invite_expires_at, invited_by, last_login_at, created_at
       FROM local_users ORDER BY created_at DESC`
    )).rows;
    res.json({ users: rows, smtpConfigured: !!getMailer() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/admin/local-users/:id/status { status: 'active' | 'disabled' }
app.put('/api/admin/local-users/:id/status', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'admin:users'))) return;
  const status = req.body.status === 'disabled' ? 'disabled' : 'active';
  try {
    const r = await pool.query(
      `UPDATE local_users SET status = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND password_hash IS NOT NULL RETURNING email`,
      [parseInt(req.params.id), status]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'User not found (or invite not yet accepted)' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/admin/local-users/:id — remove an external user / pending invite
app.delete('/api/admin/local-users/:id', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'admin:users'))) return;
  try {
    const r = await pool.query(`DELETE FROM local_users WHERE id = $1 RETURNING email`, [parseInt(req.params.id)]);
    if (!r.rowCount) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Public: invite acceptance + 2FA enrollment ---

// GET /api/auth/invite-info?token= — validate an invite link before showing the form
app.get('/api/auth/invite-info', async (req, res) => {
  const raw = String(req.query.token || '');
  if (!raw) return res.status(400).json({ error: 'Missing token' });
  try {
    const u = (await pool.query(
      `SELECT email, display_name, invite_expires_at, status FROM local_users WHERE invite_token_hash = $1`,
      [sha256hex(raw)]
    )).rows[0];
    if (!u || u.status !== 'invited') return res.status(404).json({ error: 'Invalid invitation' });
    if (new Date(u.invite_expires_at) < new Date()) return res.status(410).json({ error: 'Invitation expired' });
    res.json({ valid: true, email: u.email, name: u.display_name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/invite/accept { token, password } → stores the password, returns the
// TOTP enrollment payload (QR + secret) and a short-lived setup token.
app.post('/api/auth/invite/accept', async (req, res) => {
  const raw = String(req.body.token || '');
  const password = String(req.body.password || '');
  if (rateLimited(`accept:${req.ip}`)) return res.status(429).json({ error: 'Too many attempts — try again later' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  try {
    const u = (await pool.query(
      `SELECT id, email, display_name, invite_expires_at, status FROM local_users WHERE invite_token_hash = $1`,
      [sha256hex(raw)]
    )).rows[0];
    if (!u || u.status !== 'invited') return res.status(404).json({ error: 'Invalid invitation' });
    if (new Date(u.invite_expires_at) < new Date()) return res.status(410).json({ error: 'Invitation expired' });

    const secret = authenticator.generateSecret();
    await pool.query(
      `UPDATE local_users SET password_hash = $2, totp_secret = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [u.id, await bcrypt.hash(password, 10), secret]
    );
    const otpauth = authenticator.keyuri(u.email, 'Sales Hub', secret);
    const qrDataUrl = await QRCode.toDataURL(otpauth, { margin: 1, width: 220 });
    res.json({ success: true, qrDataUrl, secret, setupToken: signMfaJwt(u.email, '2fa-setup') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/invite/verify-2fa { setupToken, code } → activates the account, logs in
app.post('/api/auth/invite/verify-2fa', async (req, res) => {
  const p = verifyMfaJwt(String(req.body.setupToken || ''), '2fa-setup');
  if (!p) return res.status(401).json({ error: 'Setup session expired — restart from the invite link' });
  if (rateLimited(`setup2fa:${p.email}`)) return res.status(429).json({ error: 'Too many attempts — try again later' });
  try {
    const u = (await pool.query(`SELECT * FROM local_users WHERE email = $1`, [p.email])).rows[0];
    if (!u || !u.totp_secret) return res.status(404).json({ error: 'Invalid state' });
    if (!authenticator.check(String(req.body.code || ''), u.totp_secret)) {
      return res.status(401).json({ error: 'Invalid code' });
    }
    await pool.query(
      `UPDATE local_users SET totp_enabled = true, status = 'active', invite_token_hash = NULL,
              invite_expires_at = NULL, last_login_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`, [u.id]
    );
    res.json({ success: true, token: signLocalJwt(u) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Public: email+password login (step 1) + TOTP (step 2) ---

app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (rateLimited(`login:${email}`) || rateLimited(`loginip:${req.ip}`, 20)) {
    return res.status(429).json({ error: 'Too many attempts — try again later' });
  }
  try {
    const u = (await pool.query(`SELECT * FROM local_users WHERE email = $1`, [email])).rows[0];
    // Uniform error → no user enumeration
    const fail = () => res.status(401).json({ error: 'Invalid email or password' });
    if (!u || !u.password_hash || u.status === 'disabled') return fail();
    if (!(await bcrypt.compare(password, u.password_hash))) return fail();
    if (u.status !== 'active' || !u.totp_enabled) {
      return res.status(403).json({ error: 'Account setup incomplete — use your invitation link' });
    }
    res.json({ mfaRequired: true, mfaToken: signMfaJwt(u.email, '2fa-login') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login/verify-2fa', async (req, res) => {
  const p = verifyMfaJwt(String(req.body.mfaToken || ''), '2fa-login');
  if (!p) return res.status(401).json({ error: 'Session expired — log in again' });
  if (rateLimited(`2fa:${p.email}`)) return res.status(429).json({ error: 'Too many attempts — try again later' });
  try {
    const u = (await pool.query(`SELECT * FROM local_users WHERE email = $1 AND status = 'active'`, [p.email])).rows[0];
    if (!u) return res.status(401).json({ error: 'Invalid state' });
    if (!authenticator.check(String(req.body.code || ''), u.totp_secret)) {
      return res.status(401).json({ error: 'Invalid code' });
    }
    await pool.query(`UPDATE local_users SET last_login_at = CURRENT_TIMESTAMP WHERE id = $1`, [u.id]);
    res.json({ success: true, token: signLocalJwt(u) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Public: password reset ---

app.post('/api/auth/forgot-password', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (rateLimited(`forgot:${req.ip}`)) return res.status(429).json({ error: 'Too many attempts — try again later' });
  try {
    const u = (await pool.query(
      `SELECT id, display_name FROM local_users WHERE email = $1 AND status = 'active'`, [email]
    )).rows[0];
    if (u) {
      const raw = newRawToken();
      await pool.query(
        `UPDATE local_users SET reset_token_hash = $2, reset_expires_at = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [u.id, sha256hex(raw), new Date(Date.now() + 3600 * 1000)]
      );
      const base = process.env.FRONTEND_URL || 'https://saleshub.clusterpos.com';
      await sendMail(
        email,
        'Réinitialisation du mot de passe — Sales Hub / Password reset',
        mailShell(
          'Réinitialiser votre mot de passe · Reset your password',
          `Une réinitialisation du mot de passe a été demandée pour votre compte Sales Hub. Le lien expire dans 1 heure. Si vous n'êtes pas à l'origine de cette demande, ignorez ce courriel.<br><br>A password reset was requested for your Sales Hub account. The link expires in 1 hour. If you didn't request this, you can ignore this email.`,
          'Réinitialiser / Reset password',
          `${base}/reset-password?token=${raw}`
        )
      );
    }
    // Always OK → no user enumeration
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  const raw = String(req.body.token || '');
  const password = String(req.body.password || '');
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  try {
    const u = (await pool.query(
      `SELECT id, reset_expires_at FROM local_users WHERE reset_token_hash = $1`, [sha256hex(raw)]
    )).rows[0];
    if (!u) return res.status(404).json({ error: 'Invalid link' });
    if (new Date(u.reset_expires_at) < new Date()) return res.status(410).json({ error: 'Link expired' });
    await pool.query(
      `UPDATE local_users SET password_hash = $2, reset_token_hash = NULL, reset_expires_at = NULL,
              updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [u.id, await bcrypt.hash(password, 10)]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================================
// AI ASSISTANT — in-app help chatbot (Claude API)
// ============================================================================
// POST /api/assistant/chat — authenticated users only. The frontend sends the
// conversation history; we answer from a system prompt describing the app.
// Requires Heroku config var ANTHROPIC_API_KEY; returns 503 when unset.

let _anthropic = null;
function getAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

const ASSISTANT_SYSTEM = `You are the in-app assistant for "Sales Hub", the sales & commission portal of Cluster Systems (a restaurant POS company). Your job: help users understand and navigate the app, in a friendly, concise way.

LANGUAGE: Always reply in the user's language (most users speak Québec French; others use English).

THE APP'S SECTIONS (left sidebar):
- Dashboard: overview KPIs (revenue, commissions) with a year selector.
- Commission Tracker: monthly sales points per rep. Points come from CRM sold deals and Zentact merchant activations. Each rep has a monthly quota (default 15 points). Reps are grouped into Teams, each with a progress bar; you see your own team.
- Commission Report: a rep's commissions month by month for a year. Months show EARNED commission grouped by "Unlock Month" (when the commission becomes payable). The "Pay stub / Bulletin de paie" button shows the pay stub for the selected month: invoices paid, bonuses, total. A "Total Compensation" banner shows base salary accrued by pay period (26 bi-weekly periods/year) + YTD commission + annual bonus + signup payments.
- Reseller Activation: POS activations attributed to external resellers.
- Processing Revenue (Revenus de paiements): monthly payment-processing revenue per rep/reseller (transaction profit + other revenue).
- What each user sees depends on their permissions — some sections may not be visible to everyone.

THE COMMISSION MODEL:
- SaaS (subscription) first month: 100% of the SaaS amount, with a floor at the plan's monthly price (so a prorated first invoice still pays the full plan value). Renewals: 0% (the activation already paid it).
- ANNUAL subscriptions (billed yearly, e.g. integration annual fees): 10% of the first year's invoice, 0% on annual renewals.
- Monthly add-ons sold to an EXISTING customer: 0% — add-ons only pay when they are part of the initial sale (on the activation invoice).
- Hardware: 10% of the hardware amount, only if paid within 6 months of the customer's first paid SaaS. Commission is computed on the discounted pre-tax value; if the client's invoice discount is 25% or more, the hardware rate drops to 5%.
- Commission base amounts are PRE-TAX.
- "Unlock Month" = when the commission becomes payable (SaaS: when the first invoice is paid; hardware: when both hardware and first SaaS are paid).
- Once a commission is marked PAID it stays as paid — history doesn't change.
- Signup payment: a bonus (typically $100) for each Zentact merchant activation. Never gated by quota.
- QUOTA GATE (from May 2026): the monthly quota (default 15 points) must be met for hardware/SaaS commissions to be paid that month — otherwise base salary only. New hires have a 90-day ramp with no quota requirement.
- Monthly performance bonus (from May 2026): 20 points = $250, 25 = $500, 30 = $1,000 (highest tier only).
- Processing bonus: paid ONCE per merchant account, at the June or December payout after the account's first 6 months are complete (the 6-month window is anchored to the account's activation date — e.g. an account activated in November is paid the following June). The monthly average of (transaction profit + other revenue) over that window (needs revenue in at least 3 of the 6 months) minus the first $100, capped at $400. Always paid (not gated by quota).

LOGIN & ACCOUNTS:
- Internal users sign in with Zoho (SSO button). External users are invited by email, set a password, and MUST set up two-step verification (authenticator app, 6-digit codes).
- Password reset: "Forgot password?" on the login page (external accounts only).

RULES:
- Be concise. Use short paragraphs or bullets. No headers unless really useful.
- Only discuss Sales Hub and how to use it. For anything else (general questions, other software, personal advice), politely decline and steer back to the app.
- You CANNOT see the user's data (numbers, invoices, commissions). Never invent figures. For data questions, tell the user where in the app to look.
- If you don't know or the question needs a human (billing disputes, account issues, bugs), direct them to saleshub@clustersystems.com.`;

// Appended ONLY for administrators — regular users must not be walked through admin features.
const ASSISTANT_SYSTEM_ADMIN = `
ADMINISTRATOR CONTEXT — this user IS an administrator, so you may also explain admin features:
- Admin Panel sections: Integrations (Zoho Books/CRM/Zentact syncs, manual full import/enrich/recalc), Salespeople (commission %, base salary, signup payment toggle+amount, team, monthly quota, active toggle), Teams (quota override, counts-toward-quota, quota sources, display order), Customers (exclusions), Releases (publish what's-new), Manage users (admin access, impersonation, External users: email invitations + 2FA + enable/disable), Roles & permissions (RBAC: create roles, assign permissions, assign roles to user emails), Import Commissions, Resellers.
- Commission workflow: in Commission Report, admins Approve a month, then Mark Paid. The pay stub of an app-generated period (May 2026+) has a "Mark this period paid" commit button.
- Import Commissions: drag historical Excel pay files (one per rep per month, up to April 2026 — the files are the source of truth; from May 2026 the app generates pay stubs). The import marks invoices paid and stores the stub detail; re-importing the same file replaces it. The Coverage & Reconciliation matrix at the bottom shows one cell per rep per month: green check = paid via file, blue check = paid via the app, orange dot = earned but unpaid; cells open the pay stub. Pay stubs also show an "Earned this period but NOT paid" radar for invoices no payment covers.
- Impersonation ("view as") lets an admin see the app exactly as a chosen salesperson, without admin powers.`;

// Instruction appended for NON-admins.
const ASSISTANT_SYSTEM_NONADMIN = `
IMPORTANT — this user is NOT an administrator. Do not describe, explain, or walk them through admin-only features (the Admin Panel, imports, approving/marking commissions paid, managing salespeople/teams/roles/users, impersonation, configuration). If they ask about those, briefly say that it's handled by administrators and suggest contacting their administrator or saleshub@clustersystems.com — without detailing how the admin feature works.`;

// Recently published release notes, fed to Cleo so it AUTOMATICALLY learns about new
// features the moment an admin publishes a release — no prompt edits needed. Cached in
// memory for a few minutes (releases change rarely) to avoid a DB hit on every message.
let _assistantUpdatesCache = { text: '', at: 0 };
async function getAssistantUpdatesContext() {
  const now = Date.now();
  if (_assistantUpdatesCache.text !== null && now - _assistantUpdatesCache.at < 5 * 60 * 1000) {
    return _assistantUpdatesCache.text;
  }
  try {
    const rows = (await pool.query(
      `SELECT version, name, date, notes FROM releases ORDER BY date DESC LIMIT 12`
    )).rows;
    if (!rows.length) { _assistantUpdatesCache = { text: '', at: now }; return ''; }
    const lines = rows.map(r => {
      const d = r.date ? new Date(r.date).toISOString().slice(0, 10) : '';
      const notes = String(r.notes || '').replace(/\s+/g, ' ').trim().slice(0, 600);
      return `- v${r.version}${r.name ? ` "${r.name}"` : ''}${d ? ` (${d})` : ''}: ${notes || '(no notes)'}`;
    });
    let text = `RECENT UPDATES — the app's published release notes, newest first. Treat these as authoritative for which features exist and what changed recently. If the user asks "what's new", what changed, or about a recently added capability, answer from this list (in the user's language). Don't read them out verbatim unless asked; summarize what's relevant.\n${lines.join('\n')}`;
    if (text.length > 7000) text = text.slice(0, 7000);
    _assistantUpdatesCache = { text, at: now };
    return text;
  } catch (e) {
    console.warn('[ASSISTANT] updates context error:', e.message);
    return _assistantUpdatesCache.text || '';
  }
}

app.post('/api/assistant/chat', authenticateToken, async (req, res) => {
  const client = getAnthropic();
  if (!client) return res.status(503).json({ error: 'assistant_not_configured' });
  const userKey = req.user.email || req.user.name || req.ip;
  if (rateLimited(`assistant:${userKey}`, 30)) {
    return res.status(429).json({ error: 'Too many messages — try again in a few minutes' });
  }
  // App UI language (FR/EN) so replies follow the user's chosen language, not just what they type.
  const uiLang = String(req.body.lang || '').toLowerCase().startsWith('fr') ? 'French' : 'English';
  // Sanitize the client-sent history: cap turns and length, force roles.
  const raw = Array.isArray(req.body.messages) ? req.body.messages : [];
  const history = raw.slice(-12)
    .map(m => ({
      role: m && m.role === 'assistant' ? 'assistant' : 'user',
      content: String((m && m.content) || '').slice(0, 4000),
    }))
    .filter(m => m.content.trim());
  while (history.length && history[0].role !== 'user') history.shift();
  if (!history.length || history[history.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'messages must end with a user message' });
  }
  try {
    // EFFECTIVE admin status: like /api/auth/verify, trust user_tokens.is_admin over the
    // JWT flag (the OAuth JWT carries isAdmin for every Zoho user; impersonation clears it).
    let isAdmin = false;
    if (!req.user.impersonating && req.user.email) {
      const row = (await pool.query(
        'SELECT is_admin FROM user_tokens WHERE email = $1', [req.user.email]
      )).rows[0];
      isAdmin = row && row.is_admin != null ? !!row.is_admin : !!req.user.isAdmin && !!row;
    }

    const updates = await getAssistantUpdatesContext();
    const response = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 1024,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
      system: [
        { type: 'text', text: ASSISTANT_SYSTEM + (isAdmin ? ASSISTANT_SYSTEM_ADMIN : ASSISTANT_SYSTEM_NONADMIN) },
        ...(updates ? [{ type: 'text', text: updates }] : []),
        { type: 'text', text: `Current user: ${req.user.name || req.user.email || 'unknown'}${isAdmin ? ' (administrator)' : ' (regular user, not an administrator)'}.` },
        { type: 'text', text: `The user's app language is set to ${uiLang}. Reply in ${uiLang} unless the user clearly writes in another language.` },
      ],
      messages: history,
    });
    const reply = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    res.json({ reply });
  } catch (e) {
    console.warn('[ASSISTANT] error:', e.message);
    res.status(502).json({ error: 'assistant_error' });
  }
});

// ============================================================================
// KAIZEN POS DEMO — AppStream 2.0 streamed POS for sales reps
// Requires Heroku config vars: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
// AWS_REGION (default us-east-1), APPSTREAM_STACK, APPSTREAM_FLEET, and
// optionally APPSTREAM_APP_ID (the app Name from Image Assistant, to auto-launch it).
// Returns 503 'demo_not_configured' until those are set.
// ============================================================================
let _appstream = null;
function getAppStream() {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY ||
      !process.env.APPSTREAM_STACK || !process.env.APPSTREAM_FLEET) return null;
  if (!_appstream) {
    const { AppStreamClient } = require('@aws-sdk/client-appstream');
    _appstream = new AppStreamClient({
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
  }
  return _appstream;
}
// A stable AppStream UserId per Sales Hub user (charset [\w+=,.@-], 2-32 chars).
function appstreamUserId(req) {
  const raw = (req.user.realAdminEmail || req.user.email || req.user.name || 'demo-user').toLowerCase();
  const clean = raw.replace(/[^\w+=,.@-]/g, '-').slice(0, 32);
  return clean.length >= 2 ? clean : 'demo-user';
}

// POST /api/demo/kaizen-url — mint a temporary AppStream streaming URL (embedded in an iframe client-side).
app.post('/api/demo/kaizen-url', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'demo:kaizen'))) return;
  const client = getAppStream();
  if (!client) return res.status(503).json({ error: 'demo_not_configured' });
  try {
    const { CreateStreamingURLCommand } = require('@aws-sdk/client-appstream');
    const params = {
      StackName: process.env.APPSTREAM_STACK,
      FleetName: process.env.APPSTREAM_FLEET,
      UserId: appstreamUserId(req),
      Validity: 3600, // the URL must be USED within 60 min; the session itself lasts per the fleet config
    };
    if (process.env.APPSTREAM_APP_ID) params.ApplicationId = process.env.APPSTREAM_APP_ID; // auto-launch the POS
    const out = await client.send(new CreateStreamingURLCommand(params));
    res.json({ url: out.StreamingURL });
  } catch (e) {
    console.warn('[DEMO] createStreamingURL error:', e.name, e.message);
    // Fleet stopped (off-hours auto-stop) → a friendly "operating hours" message client-side.
    if (e.name === 'ResourceNotAvailableException' || /not running/i.test(e.message || '')) {
      return res.status(503).json({ error: 'fleet_stopped' });
    }
    res.status(502).json({ error: 'demo_error', detail: e.message });
  }
});

// GET /api/demo/kaizen-capacity — fleet state + capacity + who's currently streaming.
// Diagnoses "No streaming resources are available" (fleet running but no free instance,
// or still scaling up) vs "fleet_stopped". User identities are revealed only to admins.
app.get('/api/demo/kaizen-capacity', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'demo:kaizen'))) return;
  const client = getAppStream();
  if (!client) return res.status(503).json({ error: 'demo_not_configured' });
  try {
    const { DescribeFleetsCommand, DescribeSessionsCommand } = require('@aws-sdk/client-appstream');

    // Effective admin (like /api/auth/verify) — gates seeing other reps' identities.
    let isAdmin = false;
    if (!req.user.impersonating && req.user.email) {
      const row = (await pool.query('SELECT is_admin FROM user_tokens WHERE email = $1', [req.user.email])).rows[0];
      isAdmin = row && row.is_admin != null ? !!row.is_admin : !!req.user.isAdmin && !!row;
    }
    const myUserId = appstreamUserId(req);

    const [fleetsOut, sessionsOut] = await Promise.all([
      client.send(new DescribeFleetsCommand({ Names: [process.env.APPSTREAM_FLEET] })),
      client.send(new DescribeSessionsCommand({
        StackName: process.env.APPSTREAM_STACK,
        FleetName: process.env.APPSTREAM_FLEET,
        Limit: 50,
      })),
    ]);

    const f = (fleetsOut.Fleets || [])[0] || {};
    const cap = f.ComputeCapacityStatus || {};
    const sessions = (sessionsOut.Sessions || []).map((s) => {
      const mine = s.UserId === myUserId;
      return {
        // Only admins (or the user themselves) see the real userId; others are anonymised.
        userId: isAdmin || mine ? s.UserId : null,
        mine,
        state: s.State,                       // ACTIVE | PENDING | EXPIRED
        connectionState: s.ConnectionState,   // CONNECTED | NOT_CONNECTED
        startTime: s.StartTime || null,
      };
    });

    res.json({
      fleet: {
        state: f.State || 'UNKNOWN',          // RUNNING | STOPPED | STARTING | STOPPING
        type: f.FleetType || null,            // ALWAYS_ON | ON_DEMAND
        maxUserDurationSec: f.MaxUserDurationInSeconds || null,
        idleDisconnectSec: f.IdleDisconnectTimeoutInSeconds || null,
      },
      capacity: {
        desired: cap.Desired ?? null,         // instances the fleet is asked to run
        running: cap.Running ?? null,         // instances powered on
        inUse: cap.InUse ?? null,             // instances with a live session
        available: cap.Available ?? null,     // ready & free to take a new session
      },
      sessions,
      isAdmin,
    });
  } catch (e) {
    console.warn('[DEMO] capacity error:', e.name, e.message);
    res.status(502).json({ error: 'demo_error', detail: e.message });
  }
});

// GET /api/admin/pos-activations-recent?secret=  — diagnostic: latest reseller POS
// activations, to confirm the Zoho Form webhook is landing rows (and spot test/blank rows).
app.get('/api/admin/pos-activations-recent', async (req, res) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (!process.env.ZOHO_WEBHOOK_SECRET || provided !== process.env.ZOHO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid secret' });
  }
  try {
    // Optional cleanup: ?delete=<id> removes one activation row (e.g. a blank test row).
    let deleted = null;
    const delId = parseInt(req.query.delete);
    if (delId) {
      const d = await pool.query(`DELETE FROM reseller_pos_activations WHERE id = $1 RETURNING id`, [delId]);
      deleted = d.rowCount ? delId : 'not_found';
    }
    const rows = (await pool.query(
      `SELECT id, reseller_name, customer_name, quantity, submitted_at,
              EXTRACT(EPOCH FROM (NOW() - submitted_at))/60 AS age_min
       FROM reseller_pos_activations ORDER BY submitted_at DESC LIMIT 8`
    )).rows.map(r => ({ ...r, age_min: Math.round(r.age_min) }));
    res.json({ deleted, count: rows.length, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/sync-health?secret=  — diagnostic: how recently did the WORKER run its
// scheduled jobs? Reads timestamps the worker writes to the (shared) DB, so it works even
// though the worker has no HTTP. Used to confirm the Railway worker is alive after the move.
app.get('/api/admin/sync-health', async (req, res) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (!process.env.ZOHO_WEBHOOK_SECRET || provided !== process.env.ZOHO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid secret' });
  }
  try {
    const now = (await pool.query(`SELECT NOW() AS now`)).rows[0].now;
    const lastSync = (await pool.query(
      `SELECT synced_at, status, invoice_count FROM sync_log ORDER BY synced_at DESC LIMIT 1`
    )).rows[0] || null;
    const merch = (await pool.query(
      `SELECT MAX(updated_at) AS last_merchant_update FROM zentact_merchants`
    )).rows[0] || null;
    const ageMin = (ts) => ts ? Math.round((new Date(now) - new Date(ts)) / 60000) : null;
    res.json({
      server_now: now,
      role_serving_this: process.env.ROLE || 'all',   // which service answered (web)
      last_invoice_sync: lastSync ? { ...lastSync, age_min: ageMin(lastSync.synced_at) } : null,
      last_merchant_update: merch?.last_merchant_update || null,
      last_merchant_update_age_min: ageMin(merch?.last_merchant_update),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/kaizen-capacity-raw?secret=  — diagnostic: confirms the AWS creds can
// call DescribeFleets/DescribeSessions (distinct IAM actions from CreateStreamingURL).
app.get('/api/admin/kaizen-capacity-raw', async (req, res) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (!process.env.ZOHO_WEBHOOK_SECRET || provided !== process.env.ZOHO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid secret' });
  }
  const client = getAppStream();
  if (!client) return res.status(503).json({ error: 'demo_not_configured' });
  try {
    const { DescribeFleetsCommand, DescribeSessionsCommand } = require('@aws-sdk/client-appstream');
    const [fleetsOut, sessionsOut] = await Promise.all([
      client.send(new DescribeFleetsCommand({ Names: [process.env.APPSTREAM_FLEET] })),
      client.send(new DescribeSessionsCommand({ StackName: process.env.APPSTREAM_STACK, FleetName: process.env.APPSTREAM_FLEET, Limit: 50 })),
    ]);
    const f = (fleetsOut.Fleets || [])[0] || {};
    res.json({
      fleetState: f.State, fleetType: f.FleetType, capacity: f.ComputeCapacityStatus || null,
      timeouts: {
        disconnectTimeoutSec:     f.DisconnectTimeoutInSeconds ?? null,     // disconnected session kept this long before terminating
        idleDisconnectTimeoutSec: f.IdleDisconnectTimeoutInSeconds ?? null, // idle → disconnect
        maxUserDurationSec:       f.MaxUserDurationInSeconds ?? null,       // hard cap on a session
      },
      sessionCount: (sessionsOut.Sessions || []).length,
      sessions: (sessionsOut.Sessions || []).map(s => ({ userId: s.UserId, state: s.State, connectionState: s.ConnectionState, startTime: s.StartTime })),
    });
  } catch (e) {
    res.status(502).json({ error: e.name, detail: e.message });
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

    // Store CRM tokens. Attach to the most recently-active admin user
    // (the one who just clicked 'Connect CRM').
    // Updating only ONE row (by email) avoids race conditions / overwrites
    // when there are multiple admins.
    const adminEmailRes = await pool.query(
      `SELECT email FROM user_tokens WHERE is_admin = true
       ORDER BY updated_at DESC LIMIT 1`
    );
    const adminEmail = adminEmailRes.rows[0]?.email;
    if (!adminEmail) {
      return res.status(500).json({ error: 'No admin user found to attach CRM token to' });
    }
    await pool.query(
      `UPDATE user_tokens
       SET crm_access_token = $1, crm_refresh_token = $2, crm_expires_at = $3, updated_at = CURRENT_TIMESTAMP
       WHERE email = $4`,
      [access_token, refresh_token, Date.now() + (expires_in * 1000), adminEmail]
    );

    console.log(`✅ CRM tokens stored for ${adminEmail}, expires at ${new Date(Date.now() + expires_in * 1000).toISOString()}`);

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
      SELECT c.deal_id, c.deal_name, c.account_name, c.owner_name,
             COALESCE(c.lead_source_group_override, c.lead_source_group) AS lead_source_group,
             c.lead_source_group AS synced_source, c.lead_source_group_override AS source_override,
             c.points, c.sold_date
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

    // Points per deal are driven by the deal's TYPE (effective lead source group), so every deal
    // of a type is worth the same — matching the "Points by deal type" admin card exactly:
    //   1) custom configured value for the type, else
    //   2) the type's representative synced value (most frequent points among that type's deals),
    //   3) finally the deal's own synced points (only if the type has no deals at all — shouldn't happen).
    const dealSourcePoints = new Map(
      (await pool.query(`SELECT source_group, points FROM deal_source_points`)).rows
        .map(r => [String(r.source_group).toLowerCase(), parseInt(r.points)])
    );
    const repByGroup = new Map();
    for (const r of (await pool.query(`
      SELECT COALESCE(lead_source_group_override, lead_source_group) AS g, points, COUNT(*)::int AS c
      FROM crm_sold_deals
      WHERE COALESCE(lead_source_group_override, lead_source_group) IS NOT NULL
        AND COALESCE(lead_source_group_override, lead_source_group) <> ''
      GROUP BY g, points
    `)).rows) {
      const cur = repByGroup.get(r.g);
      if (!cur || r.c > cur.c) repByGroup.set(r.g, { points: parseInt(r.points) || 0, c: r.c });
    }
    const pointsForDeal = (deal) => {
      const g = String(deal.lead_source_group || '');
      const mapped = dealSourcePoints.get(g.toLowerCase());
      if (mapped != null) return mapped;
      const rep = repByGroup.get(g);
      if (rep != null) return rep.points;
      return parseInt(deal.points) || 0;
    };

    // Build per-rep summary from CRM deals
    const repMap = {};
    for (const deal of deals) {
      const rep = deal.owner_name || 'Unassigned';
      if (!repMap[rep]) repMap[rep] = { repName: rep, totalPoints: 0, crmPoints: 0, deals: [], zentactMerchants: [] };
      const pts = pointsForDeal(deal);
      repMap[rep].totalPoints += pts;
      repMap[rep].crmPoints   += pts;
      repMap[rep].deals.push({
        crm_deal_id:       deal.deal_id,
        deal_name:         deal.deal_name,
        account_name:      deal.account_name,
        lead_source_group: deal.lead_source_group,
        source_overridden: !!(deal.source_override && String(deal.source_override).trim()),
        synced_source:     deal.synced_source || null,
        points:            pts,
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
        -- Reseller-boarded merchants are NOT internal-vendor activations: they
        -- earn no $100 signup bonus and belong in Reseller → Payments instead.
        AND (reseller_attribute IS NULL OR reseller_attribute = '')
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

    // Per-salesperson signup-bonus config (amount per activation + on/off). Default $100, on.
    const spCfgRows = (await pool.query(`SELECT name, signup_bonus_amount, signup_bonus_enabled, monthly_quota, annual_bonus_enabled FROM salespeople`)).rows;
    const signupByRep = new Map(spCfgRows.map(s => [String(s.name).toLowerCase(), {
      amount: s.signup_bonus_amount == null ? 100 : parseFloat(s.signup_bonus_amount),
      enabled: s.signup_bonus_enabled !== false,
    }]));
    const signupFor = (name) => signupByRep.get(String(name || '').toLowerCase()) || { amount: 100, enabled: true };
    // Per-rep annual-bonus on/off (default on).
    const annualEnabledByRep = new Map(spCfgRows.map(s => [String(s.name).toLowerCase(), s.annual_bonus_enabled !== false]));
    const annualEnabledFor = (name) => annualEnabledByRep.get(String(name || '').toLowerCase()) !== false;
    // Per-rep monthly quota (override or default).
    const quotaByRep = new Map(spCfgRows.map(s => [String(s.name).toLowerCase(), s.monthly_quota == null ? MONTHLY_QUOTA : parseInt(s.monthly_quota)]));
    const quotaFor = (name) => quotaByRep.get(String(name || '').toLowerCase()) || MONTHLY_QUOTA;

    // Team assignment per rep (for quota grouping). rep name → team or null.
    const teamRows = (await pool.query(`
      SELECT s.name AS rep, t.id AS team_id, t.name AS team_name,
             t.monthly_quota_override AS override, t.counts_toward_quota AS counts,
             t.include_deals, t.include_payments
      FROM salespeople s LEFT JOIN teams t ON t.id = s.team_id
    `)).rows;
    const teamByRep = new Map(teamRows.map(r => [String(r.rep).toLowerCase(), r.team_id ? {
      id: r.team_id, name: r.team_name,
      override: r.override == null ? null : parseInt(r.override),
      countsTowardQuota: r.counts !== false,
      includeDeals: r.include_deals !== false,
      includePayments: r.include_payments !== false,
    } : null]));
    const teamFor = (name) => teamByRep.get(String(name || '').toLowerCase()) || null;

    let summary = Object.values(repMap).map(rep => {
      const zentactMerchants = rep.zentactMerchants || [];
      const zentactPoints = zentactMerchants.reduce((s, m) => s + (m.points || 1), 0);
      const cfg = signupFor(rep.repName);
      const zentactBonus  = cfg.enabled ? zentactMerchants.length * cfg.amount : 0;
      // Reflect the rep's signup config on each merchant row too (0 when disabled).
      const zentactMerchantsOut = zentactMerchants.map(m => ({ ...m, bonus_amount: cfg.enabled ? cfg.amount : 0 }));
      const repQuota = quotaFor(rep.repName);
      const team = teamFor(rep.repName);
      // The rep's team can exclude a point source (e.g. "Payment conversion" counts payments
      // only). Honour it at the REP level too — not just in the team card — so the rep's points,
      // quota badge, and bonus reflect only the sources that count for them.
      const includeDeals    = team ? team.includeDeals    : true;
      const includePayments = team ? team.includePayments : true;
      const effectivePoints = (includeDeals ? (rep.crmPoints || 0) : 0) + (includePayments ? zentactPoints : 0);
      const quotaMet = effectivePoints >= repQuota;
      const monthlyBonus = ZohoCRMService.calculateMonthlyBonus(effectivePoints);
      return {
        repName:             rep.repName,
        team:                team ? { id: team.id, name: team.name } : null,
        countsTowardQuota:   team ? team.countsTowardQuota : true,
        includeDeals,        // false → this rep's CRM deals are shown but don't count
        includePayments,     // false → this rep's payment activations don't count
        totalPoints:         effectivePoints,   // only the sources that count for this rep
        crmPoints:           rep.crmPoints || 0,   // RAW (team card applies its own include flags)
        zentactPoints,                             // RAW (idem)
        zentactActivations:  zentactMerchants.length,
        zentactBonus,
        quota:               repQuota,
        quotaMet,
        pointsToQuota:       Math.max(0, repQuota - effectivePoints),
        monthlyBonus,
        bonusTier:     MONTHLY_BONUS_TIERS.find(t => effectivePoints >= t.points) || null,
        nextBonusTier: MONTHLY_BONUS_TIERS.slice().reverse().find(t => effectivePoints < t.points) || null,
        dealsCount:          rep.deals.length,  // survives privacy stripping
        deals:               rep.deals,
        zentactMerchants:    zentactMerchantsOut,
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
      // Same source-inclusion rules as the monthly view.
      const totalAnnual   = (rep.includeDeals ? crmAnnual : 0) + (rep.includePayments ? zentactAnnual.points : 0);
      const cfg           = signupFor(rep.repName);
      return {
        ...rep,
        annualPoints:             totalAnnual,
        annualBonus:              annualEnabledFor(rep.repName) ? ZohoCRMService.calculateAnnualBonus(totalAnnual) : 0,
        annualBonusEnabled:       annualEnabledFor(rep.repName),
        annualZentactActivations: zentactAnnual.activations,
        annualZentactBonus:       cfg.enabled ? zentactAnnual.activations * cfg.amount : 0,
      };
    });

    const totalZentactActivations = zentactResult.rows.length;

    // PRIVACY: non-admin users can see all reps' TOTALS but only the
    // line-item details of their OWN row. Strip deals[] and zentactMerchants[]
    // from other reps' rows.
    const isAdmin = req.user.isAdmin === true;
    // Visibility tiers (no admin EDIT controls leak — those are frontend-gated on the real
    // isAdmin from /api/auth/verify, which stays false for non-admins):
    //   • Admin            → ALL teams (canViewAll)
    //   • Team manager     → ONLY their assigned team(s), with full detail (managedTeamIds)
    //   • Rep (else)       → own team only, teammates' line-items stripped
    const canViewAll = isAdmin;
    const managedTeamIds = (!isAdmin && req.user.email) ? await getManagedTeamIds(req.user.email) : [];
    const isManagerScoped = managedTeamIds.length > 0;
    let viewerName = (req.user.name || '').trim().toLowerCase();
    // Resolve viewer's salesperson name via user_tokens.display_name (in case
    // the JWT name differs from the CRM display name)
    if (req.user.email) {
      try {
        const r = await pool.query(
          `SELECT display_name FROM user_tokens WHERE LOWER(email) = LOWER($1) LIMIT 1`,
          [req.user.email]
        );
        const display = r.rows[0]?.display_name;
        if (display) viewerName = display.trim().toLowerCase();
      } catch { /* ignore */ }
    }

    // Team membership + meta from DB (ACTIVE members per team). Drives the auto quota target so a
    // team's target reflects ALL its members, not only those who happened to sell this month.
    let teamMetaRows = (await pool.query(`
      SELECT t.id, t.name, t.monthly_quota_override AS override, t.counts_toward_quota AS counts,
             t.include_deals, t.include_payments, t.sort_order,
             COUNT(s.id) FILTER (WHERE s.is_active) AS member_count,
             COALESCE(SUM(COALESCE(s.monthly_quota, ${MONTHLY_QUOTA})) FILTER (WHERE s.is_active), 0) AS members_quota_sum
      FROM teams t LEFT JOIN salespeople s ON s.team_id = t.id
      GROUP BY t.id
      ORDER BY t.sort_order, t.name
    `)).rows;

    // PRIVACY. Admins (canViewAll) skip all of this and see every team with full detail.
    // Team managers see ONLY their assigned team(s), with full detail. Reps see only their own
    // team, with teammates' line-items stripped. Enforced server-side so out-of-scope data
    // never leaves the API.
    if (canViewAll) {
      /* no restriction */
    } else if (isManagerScoped) {
      const set = new Set(managedTeamIds);
      summary = summary.filter(rep => { const rt = teamFor(rep.repName); return !!rt && set.has(rt.id); });
      teamMetaRows = teamMetaRows.filter(tr => set.has(tr.id));
    } else {
      const myTeam = teamFor(viewerName);
      const myTeamId = myTeam ? myTeam.id : null;
      summary = summary
        .filter(rep => {
          const rt = teamFor(rep.repName);
          if (myTeamId) return !!rt && rt.id === myTeamId;
          return rep.repName.trim().toLowerCase() === viewerName; // no team → only self
        })
        .map(rep => {
          const isOwnRow = rep.repName.trim().toLowerCase() === viewerName;
          return isOwnRow ? rep : { ...rep, deals: [], zentactMerchants: [], restricted: true };
        });
      teamMetaRows = myTeamId ? teamMetaRows.filter(tr => tr.id === myTeamId) : [];
    }

    // Per-team points respect each team's configured sources: include CRM deal points and/or
    // Zentact payment-activation points (both on by default = previous behaviour).
    const teams = teamMetaRows.map(tr => {
      const includeDeals = tr.include_deals !== false;
      const includePayments = tr.include_payments !== false;
      let totalPoints = 0, membersMet = 0;
      for (const rep of summary) {
        const tm = teamFor(rep.repName);
        if (!tm || tm.id !== tr.id) continue;
        totalPoints += (includeDeals ? (rep.crmPoints || 0) : 0) + (includePayments ? (rep.zentactPoints || 0) : 0);
        if (rep.quotaMet) membersMet += 1;
      }
      const memberCount = parseInt(tr.member_count) || 0;
      const override = tr.override == null ? null : parseInt(tr.override);
      // Auto target = sum of members' individual quotas (each defaults to MONTHLY_QUOTA).
      const quotaTarget = override != null ? override : (parseInt(tr.members_quota_sum) || 0);
      return {
        teamId: tr.id, name: tr.name, countsTowardQuota: tr.counts !== false,
        includeDeals, includePayments,
        memberCount, membersMet, totalPoints,
        quotaTarget, quotaMet: totalPoints >= quotaTarget,
      };
    }); // order preserved from teamMetaRows (manual sort_order)

    // Company/scope totals: admins + managers exclude non-counting teams across their visible
    // set; a restricted rep just sees their own team (already the only team in `teams`).
    const countingTeams = (canViewAll || isManagerScoped) ? teams.filter(t => t.countsTowardQuota) : teams;
    const companyPoints = countingTeams.reduce((s, t) => s + t.totalPoints, 0);
    const companyTarget = countingTeams.reduce((s, t) => s + t.quotaTarget, 0);

    // Distinct lead-source groups (effective) — drives the deal source-override dropdown.
    const leadSourceGroups = (await pool.query(`
      SELECT DISTINCT COALESCE(lead_source_group_override, lead_source_group) AS g
      FROM crm_sold_deals
      WHERE COALESCE(lead_source_group_override, lead_source_group) IS NOT NULL
        AND COALESCE(lead_source_group_override, lead_source_group) <> ''
      ORDER BY g
    `)).rows.map(r => r.g);

    res.json({
      year,
      month,
      quota:                   MONTHLY_QUOTA,
      bonusTiers:              MONTHLY_BONUS_TIERS,
      totalDeals:              deals.length,
      totalZentactActivations,
      isAdmin,
      canViewAll,
      viewerName,
      reps:                    summary,
      teams,
      companyPoints,
      companyTarget,
      companyQuotaMet:         companyTarget > 0 && companyPoints >= companyTarget,
      leadSourceGroups,
    });
  } catch (error) {
    console.error('CRM points error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to calculate points', details: error.message });
  }
});

// PUT /api/crm/deals/:dealId/source — manually override a deal's lead source group.
// Empty/null clears the override (reverts to the CRM-synced value). Survives re-syncs.
app.put('/api/crm/deals/:dealId/source', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  const src = (req.body.source == null ? '' : String(req.body.source)).trim();
  try {
    const r = await pool.query(
      `UPDATE crm_sold_deals SET lead_source_group_override = $1 WHERE deal_id = $2 RETURNING deal_id`,
      [src === '' ? null : src, req.params.dealId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Deal not found' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to override deal source', details: error.message });
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
    const annualEnabled = (await pool.query(`SELECT annual_bonus_enabled FROM salespeople WHERE LOWER(name) = LOWER($1)`, [repName])).rows[0]?.annual_bonus_enabled !== false;
    const annualBonus   = annualEnabled ? ZohoCRMService.calculateAnnualBonus(annualTotal) : 0;
    const nextTier      = annualEnabled ? (ANNUAL_BONUS_TIERS.slice().reverse().find(t => annualTotal < t.points) || null) : null;

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
        annualBonusEnabled: annualEnabled,
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
// POST /api/zentact/webhook — receives Zentact "Merchant Account Status Updates"
// Track webhook activity for diagnostic purposes
const webhookStats = {
  received_total:           0,
  received_active:          0,
  received_other:           0,
  invalid_signature_count:  0,
  missing_signature_count:  0,
  last_received_at:         null,
  last_event:               null,
  recent_events:            [], // last 20 events
};

// GET /api/zentact/webhook-status — check if webhook is configured and receiving traffic
app.get('/api/zentact/webhook-status', authenticateToken, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  res.json({
    secret_configured: !!process.env.ZENTACT_WEBHOOK_SECRET,
    webhook_url: `${req.protocol}://${req.get('host')}/api/zentact/webhook`,
    stats: webhookStats,
  });
});

// Configure in Zentact dashboard → Configure → Webhooks with this URL and a shared
// secret. Save the secret to Heroku env var ZENTACT_WEBHOOK_SECRET.
app.post('/api/zentact/webhook', async (req, res) => {
  const crypto = require('crypto');
  const secret = process.env.ZENTACT_WEBHOOK_SECRET;
  const signature = req.headers['x-hmac-signature'];

  // Signature verification (only enforced if secret is set)
  if (secret) {
    if (!signature || !req.rawBody) {
      webhookStats.missing_signature_count++;
      console.warn('⚠️ Zentact webhook: missing signature or raw body');
      return res.status(401).json({ error: 'Missing signature' });
    }
    const expected = crypto.createHmac('sha256', secret).update(req.rawBody).digest('base64');
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      webhookStats.invalid_signature_count++;
      console.warn('⚠️ Zentact webhook: signature mismatch');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  const evt = req.body || {};
  const merchantId = evt.merchantAccountId;
  const status = evt.status;
  const createdAtUnix = evt.createdAt;

  if (!merchantId || !status) {
    return res.status(400).json({ error: 'Missing merchantAccountId or status' });
  }

  // Convert Unix timestamp → ISO date (YYYY-MM-DD)
  const eventDate = createdAtUnix
    ? new Date(createdAtUnix * 1000).toISOString().split('T')[0]
    : new Date().toISOString().split('T')[0];

  try {
    // If status is ACTIVE → set activated_at to the event date (only if NULL,
    // so we never overwrite a confirmed date with a later status change).
    // For any status change, update the status itself.
    await pool.query(`
      INSERT INTO zentact_merchants (merchant_account_id, status, activated_at)
      VALUES ($1, $2, CASE WHEN $2 = 'ACTIVE' THEN $3::date ELSE NULL END)
      ON CONFLICT (merchant_account_id) DO UPDATE SET
        status = EXCLUDED.status,
        activated_at = CASE
          WHEN EXCLUDED.status = 'ACTIVE' AND zentact_merchants.activated_at IS NULL
            THEN $3::date
          ELSE zentact_merchants.activated_at
        END,
        updated_at = CURRENT_TIMESTAMP
    `, [merchantId, status, eventDate]);

    // Update webhook stats
    webhookStats.received_total++;
    if (status === 'ACTIVE') webhookStats.received_active++; else webhookStats.received_other++;
    webhookStats.last_received_at = new Date().toISOString();
    webhookStats.last_event = { merchantId, status, eventDate };
    webhookStats.recent_events.unshift({
      received_at: webhookStats.last_received_at,
      merchantId, status, eventDate,
    });
    if (webhookStats.recent_events.length > 20) webhookStats.recent_events.length = 20;

    console.log(`📡 Zentact webhook: ${merchantId} → ${status} (${eventDate})`);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('❌ Zentact webhook error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/zentact/import-assignments — bulk update sales_rep_name + activated_at
// Body: { rows: [{ merchant: 'Business Name', salesRep: 'Rep Name', activatedAt: 'YYYY-MM-DD' }] }
// Matches merchants by business_name (case-insensitive, trimmed).
app.post('/api/zentact/import-assignments', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  const { rows, dryRun } = req.body || {};
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows must be an array' });

  // Load all merchants once and build a name → ID map (lowercase, trimmed)
  const allMerchants = await pool.query(
    `SELECT merchant_account_id, business_name, sales_rep_name, activated_at FROM zentact_merchants`
  );
  const byName = new Map();
  for (const m of allMerchants.rows) {
    if (m.business_name) byName.set(m.business_name.trim().toLowerCase(), m);
  }

  const results = { matched: [], unmatched: [], updated: 0 };
  for (const row of rows) {
    const merchantName = (row.merchant || '').trim();
    const salesRep     = (row.salesRep || '').trim() || null;
    const activatedAt  = (row.activatedAt || '').trim() || null;

    if (!merchantName) {
      results.unmatched.push({ ...row, reason: 'empty merchant name' });
      continue;
    }
    const found = byName.get(merchantName.toLowerCase());
    if (!found) {
      results.unmatched.push({ ...row, reason: 'business_name not found in DB' });
      continue;
    }

    results.matched.push({
      merchant_account_id: found.merchant_account_id,
      merchant: found.business_name,
      newSalesRep: salesRep,
      newActivatedAt: activatedAt,
      oldSalesRep: found.sales_rep_name,
      oldActivatedAt: found.activated_at,
    });

    if (!dryRun) {
      await pool.query(`
        UPDATE zentact_merchants
        SET sales_rep_name = COALESCE($1, sales_rep_name),
            activated_at  = COALESCE($2::date, activated_at),
            updated_at    = CURRENT_TIMESTAMP
        WHERE merchant_account_id = $3
      `, [salesRep, activatedAt, found.merchant_account_id]);
      results.updated++;
    }
  }

  res.json(results);
});

// GET /api/zentact/raw-sample — fetches one merchant LIVE from Zentact and returns
// the complete raw response. Useful to discover undocumented date fields.
app.get('/api/zentact/raw-sample', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  try {
    const apiKey = process.env.ZENTACT_API_KEY;
    if (!apiKey) return res.status(400).json({ error: 'ZENTACT_API_KEY not set' });

    const baseUrl = process.env.ZENTACT_API_URL || 'https://api.zentact.com/api/v1';
    const headers = { 'X-API-Key': apiKey, 'Content-Type': 'application/json' };

    // Fetch a few merchants in the list view
    const listResp = await axios.get(`${baseUrl}/merchant-accounts`, {
      headers, params: { pageSize: 3, pageIndex: 0 },
    });
    const inner = listResp.data?.data || {};
    const rows = inner.rows || listResp.data?.rows || [];

    // Also fetch a single merchant by ID (the single-GET endpoint sometimes
    // returns more fields than the list endpoint)
    let singleMerchant = null;
    if (rows[0]?.merchantAccountId) {
      try {
        const single = await axios.get(
          `${baseUrl}/merchant-accounts/${rows[0].merchantAccountId}`,
          { headers }
        );
        singleMerchant = single.data;
      } catch (e) {
        singleMerchant = { error: e.response?.data?.message || e.message };
      }
    }

    res.json({
      listSample: rows.slice(0, 3),
      singleSample: singleMerchant,
      hint: 'Look for date/timestamp fields anywhere in the JSON (createdAt, updatedAt, activatedAt, statusChangedAt, etc.)',
    });
  } catch (error) {
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

// DELETE /api/zentact/flush — wipes all Zentact merchants from DB
// Next auto-sync (within 1h) will re-pull everything fresh from Zentact.
// Requires admin + an explicit ?confirm=YES query param so this can't fire by accident.
app.delete('/api/zentact/flush', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  if (req.query.confirm !== 'YES') {
    return res.status(400).json({
      error: 'Add ?confirm=YES to confirm. This will delete ALL Zentact merchants from the DB.',
    });
  }
  try {
    const before = await pool.query('SELECT COUNT(*) AS n FROM zentact_merchants');
    const beforeCount = parseInt(before.rows[0].n) || 0;
    await pool.query('DELETE FROM zentact_merchants');
    console.log(`🗑️  Zentact flush: deleted ${beforeCount} merchants. Next sync will refetch.`);
    res.json({
      success: true,
      deleted: beforeCount,
      note: 'All merchants will be re-synced from Zentact on the next auto-sync (every hour) or you can trigger one manually.',
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/zentact/probe/:merchantId — probes undocumented Zentact endpoints to find the
// "Boarded" date. Tries several URL patterns and returns whatever responds with 200.
app.get('/api/zentact/probe/:merchantId', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  const apiKey = process.env.ZENTACT_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'ZENTACT_API_KEY not set' });

  const baseV1 = process.env.ZENTACT_API_URL || 'https://api.zentact.com/api/v1';
  const baseV2 = baseV1.replace('/v1', '/v2');
  const baseDashboard = baseV1.replace('/api/v1', '/api');
  const headers = { 'X-API-Key': apiKey, 'Content-Type': 'application/json' };
  const id = req.params.merchantId;

  const endpoints = [
    `${baseV1}/merchant-accounts/${id}/events`,
    `${baseV1}/merchant-accounts/${id}/activity`,
    `${baseV1}/merchant-accounts/${id}/timeline`,
    `${baseV1}/merchant-accounts/${id}/history`,
    `${baseV1}/merchant-accounts/${id}/audit`,
    `${baseV1}/merchant-accounts/${id}/audit-log`,
    `${baseV1}/merchant-accounts/${id}/log`,
    `${baseV1}/merchant-accounts/${id}/status-history`,
    `${baseV1}/merchant-accounts/${id}/lifecycle`,
    `${baseV1}/merchant-accounts/${id}/onboarding`,
    `${baseV1}/merchant-accounts/${id}/status-updates`,
    `${baseV1}/events?merchantAccountId=${id}`,
    `${baseV1}/activity?merchantAccountId=${id}`,
    `${baseV1}/audit?merchantAccountId=${id}`,
    `${baseV1}/audit-events?merchantAccountId=${id}`,
    `${baseV1}/merchant-account-events?merchantAccountId=${id}`,
    `${baseV1}/dashboard/merchant-accounts/${id}/timeline`,
    `${baseV1}/dashboard/merchant-accounts/${id}/events`,
    `${baseV2}/merchant-accounts/${id}/events`,
    `${baseV2}/merchant-accounts/${id}/activity`,
    `${baseV2}/audit-events?merchantAccountId=${id}`,
  ];

  const results = [];
  for (const url of endpoints) {
    try {
      const r = await axios.get(url, { headers, timeout: 5000, validateStatus: () => true });
      results.push({
        url,
        status: r.status,
        ok: r.status >= 200 && r.status < 300,
        sample: r.status === 200 ? JSON.stringify(r.data).slice(0, 500) : (r.data?.message || r.data?.error || null),
      });
    } catch (e) {
      results.push({ url, error: e.message });
    }
  }

  // Return only successes first, then errors
  const success = results.filter(r => r.ok);
  const fail = results.filter(r => !r.ok);
  res.json({ merchantId: id, hits: success, misses: fail.length, all: results });
});

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
// Query params: ?unassigned=true to only return merchants without a rep
//               ?active=true to only return ACTIVE merchants
app.get('/api/zentact/merchants', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  try {
    const where = [];
    if (req.query.unassigned === 'true') {
      where.push(`(sales_rep_name IS NULL OR sales_rep_name = '')`);
      // Reseller-boarded merchants aren't "unassigned internal vendors" — they
      // belong to a reseller (see Reseller → Payments), so keep them out of the
      // rep-assignment tool.
      where.push(`(reseller_attribute IS NULL OR reseller_attribute = '')`);
    }
    if (req.query.active === 'true') {
      where.push(`status = 'ACTIVE'`);
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const result = await pool.query(`
      SELECT merchant_account_id, business_name, status, sales_rep_email,
             sales_rep_name, opportunity_id, reseller_attribute, activated_at, bonus_amount, points,
             raw_attributes, updated_at
      FROM zentact_merchants
      ${whereSql}
      ORDER BY activated_at DESC NULLS LAST, created_at DESC
    `);
    res.json({ merchants: result.rows, total: result.rows.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/zentact/merchants/backfill-activation — stamp today's date on all
// ACTIVE merchants that currently have NULL activated_at. Fixes merchants that
// activated in Zentact but never processed payments (so statement/transaction
// lookups returned nothing). Returns the list of merchants that got updated.
app.post('/api/zentact/merchants/backfill-activation', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  try {
    const result = await pool.query(`
      UPDATE zentact_merchants
      SET activated_at = CURRENT_DATE, updated_at = CURRENT_TIMESTAMP
      WHERE status = 'ACTIVE' AND activated_at IS NULL
      RETURNING merchant_account_id, business_name, sales_rep_name
    `);
    res.json({
      success: true,
      stamped: result.rowCount,
      merchants: result.rows,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PATCH /api/zentact/merchants/:merchantId/activated-at — manually set the activation date
app.patch('/api/zentact/merchants/:merchantId/activated-at', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  const { activatedAt } = req.body; // ISO date string YYYY-MM-DD or null to clear
  try {
    await pool.query(
      `UPDATE zentact_merchants
       SET activated_at = $1, updated_at = CURRENT_TIMESTAMP
       WHERE merchant_account_id = $2`,
      [activatedAt || null, req.params.merchantId]
    );
    res.json({ success: true });
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

// GET /api/admin/impersonation-debug?secret=&name=<rep>  — why does impersonating <rep> show
// (or not show) menus? Mirrors the impersonation email-resolution + returns the effective perms.
app.get('/api/admin/impersonation-debug', async (req, res) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (!process.env.ZOHO_WEBHOOK_SECRET || provided !== process.env.ZOHO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid secret' });
  }
  const name = String(req.query.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const sp = (await pool.query(`SELECT name, email, is_active FROM salespeople WHERE LOWER(name) = LOWER($1) LIMIT 1`, [name])).rows[0]
      || (await pool.query(`SELECT name, email, is_active FROM salespeople WHERE name ILIKE '%'||$1||'%' LIMIT 1`, [name])).rows[0];
    if (!sp) return res.json({ found: false, note: 'no salesperson matches that name' });
    const tokenByDisplay = (await pool.query(`SELECT email, display_name, is_admin FROM user_tokens WHERE LOWER(display_name) = LOWER($1) LIMIT 1`, [sp.name])).rows[0] || null;
    const resolvedEmail = tokenByDisplay?.email || sp.email || null;
    const perms = resolvedEmail ? [...(await getUserPermissions(resolvedEmail))] : [];
    const roles = resolvedEmail ? (await pool.query(`SELECT r.name FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE LOWER(ur.user_email) = LOWER($1)`, [resolvedEmail])).rows.map(r => r.name) : [];
    // Any token whose display_name merely contains the name (to spot a casing/format mismatch)
    const tokenLike = (await pool.query(`SELECT email, display_name FROM user_tokens WHERE display_name ILIKE '%'||$1||'%'`, [name.split(' ')[0]])).rows;
    res.json({
      salesperson: { name: sp.name, card_email: sp.email, is_active: sp.is_active },
      token_exact_display_match: tokenByDisplay,
      resolved_email: resolvedEmail,
      roles, permissions: perms,
      would_see_menus: perms.length > 0,
      tokens_matching_first_name: tokenLike,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/zoho-account-raw?secret=&id=&q=  — dump all fields of a Zoho Account record
// (by id, real-time) or accounts matching a name, to find where the Adyen ID lives.
app.get('/api/admin/zoho-account-raw', async (req, res) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (!process.env.ZOHO_WEBHOOK_SECRET || provided !== process.env.ZOHO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid secret' });
  }
  const id = String(req.query.id || '').trim();
  const q = String(req.query.q || '').trim();
  if (!id && !q) return res.status(400).json({ error: 'id or q required' });
  try {
    const crmToken = await ensureValidCrmToken();
    if (!crmToken) return res.status(400).json({ error: 'CRM not connected' });
    const url = id
      ? `https://www.zohoapis.com/crm/v2/Accounts/${encodeURIComponent(id)}`
      : `https://www.zohoapis.com/crm/v2/Accounts/search?criteria=(Account_Name:starts_with:${encodeURIComponent(q)})`;
    const r = await axios.get(url, { headers: { Authorization: `Zoho-oauthtoken ${crmToken}` }, validateStatus: () => true });
    const accounts = (r.data?.data || []).map(a => {
      const nonNull = {};
      Object.keys(a).forEach(k => { if (a[k] !== null && a[k] !== '' && !k.startsWith('$')) nonNull[k] = a[k]; });
      return { id: a.id, Account_Name: a.Account_Name, fields: nonNull };
    });
    res.json({ status: r.status, accounts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/zentact-raw?secret=  — dump the FULL raw merchant object from the Zentact API
// (top-level fields, not just custom attributes) to find an Adyen/PSP identifier.
app.get('/api/admin/zentact-raw', async (req, res) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (!process.env.ZOHO_WEBHOOK_SECRET || provided !== process.env.ZOHO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid secret' });
  }
  try {
    const zentact = new ZentactService(process.env.ZENTACT_API_KEY);
    const merchants = await zentact.getMerchantAccounts({ status: 'ACTIVE' });
    const allKeys = [...new Set(merchants.flatMap(m => Object.keys(m || {})))].sort();
    // Optional ?name= filter — inspect a specific merchant's stores[] structure.
    const q = String(req.query.name || '').trim().toLowerCase();
    if (q) {
      const matches = merchants
        .filter(m => String(m.businessName || '').toLowerCase().includes(q))
        .map(m => ({ businessName: m.businessName, merchantAccountId: m.merchantAccountId,
                     storeCount: Array.isArray(m.stores) ? m.stores.length : 0, stores: m.stores || [] }));
      return res.json({ count: merchants.length, query: q, matchCount: matches.length, matches });
    }
    res.json({ count: merchants.length, allKeys, sample: merchants.slice(0, 2) });
  } catch (e) { res.status(500).json({ error: e.message, detail: e.response?.data }); }
});

// GET /api/admin/zentact-store-raw?secret=&storeId=&merchantAccountId=  — probe Zentact's
// dedicated /stores endpoint to discover whether it returns a human "Store Name" (the
// merchant-accounts stores[] array only has storeId/storeReferenceId, no name).
app.get('/api/admin/zentact-store-raw', async (req, res) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (!process.env.ZOHO_WEBHOOK_SECRET || provided !== process.env.ZOHO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid secret' });
  }
  const axios = require('axios');
  const base = process.env.ZENTACT_API_URL || 'https://api.zentact.com/api/v1';
  const headers = { 'X-API-Key': process.env.ZENTACT_API_KEY };
  const storeId = req.query.storeId;
  const mid = req.query.merchantAccountId;
  const tries = [
    ['GET /merchant-accounts/{mid}', `${base}/merchant-accounts/${mid}`, undefined],
    ['GET /merchant-accounts/{mid}/stores', `${base}/merchant-accounts/${mid}/stores`, undefined],
    ['GET /merchant-accounts?include=stores', `${base}/merchant-accounts`, { merchantAccountId: mid }],
  ];
  const out = {};
  for (const [label, url, params] of tries) {
    try {
      const r = await axios.get(url, { headers, params, validateStatus: () => true, timeout: 15000 });
      out[label] = { status: r.status, data: r.data };
    } catch (e) { out[label] = { error: e.message }; }
  }
  res.json(out);
});

// GET /api/admin/zentact-attrs?secret=  — distinct custom-attribute keys across all Zentact
// merchants + a sample, to find which attribute holds the Adyen ID.
app.get('/api/admin/zentact-attrs', async (req, res) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (!process.env.ZOHO_WEBHOOK_SECRET || provided !== process.env.ZOHO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid secret' });
  }
  try {
    // raw_attributes is a JSONB array of objects; surface each object's keys + the 'name' values.
    const keyRows = (await pool.query(`
      SELECT DISTINCT elem->>'name' AS attr_name
        FROM zentact_merchants, jsonb_array_elements(raw_attributes) AS elem
       WHERE raw_attributes IS NOT NULL AND jsonb_typeof(raw_attributes) = 'array'
       ORDER BY 1`)).rows.map(r => r.attr_name).filter(Boolean);
    const sample = (await pool.query(`
      SELECT merchant_account_id, business_name, raw_attributes
        FROM zentact_merchants
       WHERE raw_attributes IS NOT NULL AND jsonb_typeof(raw_attributes) = 'array'
         AND jsonb_array_length(raw_attributes) > 0
       ORDER BY updated_at DESC LIMIT 3`)).rows;
    res.json({ attributeNames: keyRows, sampleMerchants: sample });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/resources-count?secret=  — confirm the library + key tables are intact (diagnostic).
app.get('/api/admin/resources-count', async (req, res) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (!process.env.ZOHO_WEBHOOK_SECRET || provided !== process.env.ZOHO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid secret' });
  }
  try {
    const resources = (await pool.query(`SELECT COUNT(*)::int c, COALESCE(SUM(file_size),0)::bigint bytes FROM resources`)).rows[0];
    const byCat = (await pool.query(`SELECT COALESCE(NULLIF(category,''),'(none)') cat, COUNT(*)::int c FROM resources GROUP BY 1 ORDER BY c DESC LIMIT 30`)).rows;
    const others = {
      invoices: (await pool.query(`SELECT COUNT(*)::int c FROM invoices`)).rows[0].c,
      salespeople: (await pool.query(`SELECT COUNT(*)::int c FROM salespeople`)).rows[0].c,
      crm_deals: (await pool.query(`SELECT COUNT(*)::int c FROM crm_sold_deals`)).rows[0].c,
    };
    res.json({ resources: resources.c, totalBytes: Number(resources.bytes), byCategory: byCat, otherTables: others });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/customer-lookup?secret=&q=  — distinct customer names matching q, with
// invoice count + whether they're in excluded_customers (diagnose exact-match exclusion).
app.get('/api/admin/customer-lookup', async (req, res) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (!process.env.ZOHO_WEBHOOK_SECRET || provided !== process.env.ZOHO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid secret' });
  }
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q required' });
  try {
    const rows = (await pool.query(`
      SELECT i.customer_name,
             COUNT(*)::int AS invoices,
             COALESCE(SUM(i.total),0)::float AS total,
             EXISTS (SELECT 1 FROM excluded_customers e
                     WHERE e.organization_id = $2 AND e.customer_name = i.customer_name) AS excluded
        FROM invoices i
       WHERE i.organization_id = $2 AND i.customer_name ILIKE '%'||$1||'%'
       GROUP BY i.customer_name ORDER BY total DESC`, [q, process.env.ZOHO_ORG_ID])).rows;
    const excludedRows = (await pool.query(
      `SELECT customer_name FROM excluded_customers WHERE organization_id = $1 AND customer_name ILIKE '%'||$2||'%'`,
      [process.env.ZOHO_ORG_ID, q])).rows.map(r => r.customer_name);
    res.json({ matches: rows, excludedEntries: excludedRows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/exclude-add?secret=&name=  — replicate the exclude-customer INSERT at the DB
// level (diagnose why the UI add doesn't persist) AND actually exclude the customer.
app.get('/api/admin/exclude-add', async (req, res) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (!process.env.ZOHO_WEBHOOK_SECRET || provided !== process.env.ZOHO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid secret' });
  }
  const name = String(req.query.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const orgId = process.env.ZOHO_ORG_ID || null;
    const before = (await pool.query(`SELECT COUNT(*)::int AS c FROM excluded_customers`)).rows[0].c;
    const ins = await pool.query(
      `INSERT INTO excluded_customers (customer_name, excluded_by, organization_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id`,
      [name, 'diagnostic', orgId]
    );
    const all = (await pool.query(
      `SELECT id, customer_name, organization_id FROM excluded_customers ORDER BY id DESC LIMIT 20`
    )).rows;
    res.json({ orgIdUsed: orgId, before, insertedRowCount: ins.rowCount, insertedId: ins.rows[0]?.id || null, rows: all });
  } catch (e) { res.status(500).json({ error: e.message, code: e.code, detail: e.detail }); }
});

// GET /api/admin/rep-commission-debug?secret=&name=&year=  — explain a rep's dashboard money:
// payable commission per month, what's pending (not yet unlocked), and this-month invoices.
app.get('/api/admin/rep-commission-debug', async (req, res) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (!process.env.ZOHO_WEBHOOK_SECRET || provided !== process.env.ZOHO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid secret' });
  }
  const name = String(req.query.name || '').trim();
  const year = parseInt(req.query.year) || new Date().getFullYear();
  if (!name) return res.status(400).json({ error: 'name required' });
  const org = process.env.ZOHO_ORG_ID;
  try {
    const payableByMonth = (await pool.query(`
      SELECT EXTRACT(MONTH FROM commission_payable_date)::int AS m,
             COUNT(*)::int AS invoices, COALESCE(SUM(commission),0)::float AS commission
        FROM invoices
       WHERE salesperson_name = $1 AND organization_id = $2
         AND commission_payable_date >= $3 AND commission_payable_date <= $4
       GROUP BY m ORDER BY m`,
      [name, org, new Date(year,0,1), new Date(year,11,31,23,59,59)])).rows;
    const pending = (await pool.query(`
      SELECT commission_status, COUNT(*)::int AS invoices,
             COALESCE(SUM(commission),0)::float AS commission,
             COALESCE(SUM(hardware_amount),0)::float AS hardware_amount
        FROM invoices
       WHERE salesperson_name = $1 AND organization_id = $2
         AND commission_status IN ('pending_saas','pending_payment')
       GROUP BY commission_status`, [name, org])).rows;
    const thisMonthInvoices = (await pool.query(`
      SELECT invoice_number, customer_name, date::date AS date, total::float,
             commission::float, commission_status, status,
             commission_payable_date::date AS payable_date
        FROM invoices
       WHERE salesperson_name = $1 AND organization_id = $2
         AND date >= $3 AND date < $4
       ORDER BY date DESC LIMIT 40`,
      [name, org, new Date(year, new Date().getMonth(), 1), new Date(year, new Date().getMonth()+1, 1)])).rows;
    res.json({ name, year, payableByMonth, pending, thisMonthInvoices });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/rep-config?secret=&name=  — a rep's toggles + team settings (diagnostic).
app.get('/api/admin/rep-config', async (req, res) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (!process.env.ZOHO_WEBHOOK_SECRET || provided !== process.env.ZOHO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid secret' });
  }
  const name = String(req.query.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const rows = (await pool.query(`
      SELECT s.name, s.is_active, s.team_id, s.monthly_quota, s.quota_gate_enabled,
             s.processing_bonus_enabled, s.signup_bonus_enabled,
             t.name AS team_name, t.counts_toward_quota, t.include_deals, t.include_payments,
             t.monthly_quota_override
        FROM salespeople s LEFT JOIN teams t ON t.id = s.team_id
       WHERE s.name ILIKE '%'||$1||'%'`, [name])).rows;
    res.json({ rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/payroll-sends-dump?secret=  — raw rows from payroll_sends (diagnostic).
app.get('/api/admin/payroll-sends-dump', async (req, res) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (!process.env.ZOHO_WEBHOOK_SECRET || provided !== process.env.ZOHO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid secret' });
  }
  try {
    const rows = (await pool.query(
      `SELECT id, rep_name, period::date AS period, sent_at, sent_by, sent_to, total
         FROM payroll_sends ORDER BY sent_at DESC LIMIT 200`
    )).rows;
    res.json({ count: rows.length, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/zoho-deal-raw?secret=&q=<name>  — current RAW Zoho deal(s) matching a name,
// exposing every source/lead field + the stored value, to diagnose a stale lead source.
app.get('/api/admin/zoho-deal-raw', async (req, res) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (!process.env.ZOHO_WEBHOOK_SECRET || provided !== process.env.ZOHO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid secret' });
  }
  const q = String(req.query.q || '').trim();
  const byId = String(req.query.id || '').trim();
  if (!q && !byId) return res.status(400).json({ error: 'q or id required' });
  try {
    const crmToken = await ensureValidCrmToken();
    if (!crmToken) return res.status(400).json({ error: 'CRM not connected' });
    // Direct GET by id is REAL-TIME; Zoho's /search endpoint is an index that lags edits by minutes.
    const url = byId
      ? `https://www.zohoapis.com/crm/v2/Deals/${encodeURIComponent(byId)}`
      : `https://www.zohoapis.com/crm/v2/Deals/search?criteria=(Deal_Name:starts_with:${encodeURIComponent(q)})`;
    const crmRes = await axios.get(url, {
      headers: { Authorization: `Zoho-oauthtoken ${crmToken}` }, validateStatus: () => true,
    });
    const showAll = req.query.all === '1' || req.query.all === 'true';
    const fieldRe = req.query.field ? new RegExp(String(req.query.field), 'i') : /source|lead/i;
    const raw = (crmRes.data?.data || []).map(d => {
      const fields = {};
      Object.keys(d).filter(k => showAll || fieldRe.test(k)).forEach(k => { fields[k] = d[k]; });
      return { id: d.id, Deal_Name: d.Deal_Name, Stage: d.Stage, Modified_Time: d.Modified_Time, source_lead_fields: fields };
    });
    const stored = (await pool.query(
      byId
        ? `SELECT deal_id, deal_name, lead_source_group, lead_source_group_override, updated_at FROM crm_sold_deals WHERE deal_id = $1`
        : `SELECT deal_id, deal_name, lead_source_group, lead_source_group_override, updated_at FROM crm_sold_deals WHERE deal_name ILIKE '%'||$1||'%'`,
      [byId || q]
    )).rows;
    res.json({ zoho_status: crmRes.status, zoho: raw, stored });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/crm-deals?secret=&q=<name>  — stored CRM deals matching a name (diagnostic).
app.get('/api/admin/crm-deals', async (req, res) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (!process.env.ZOHO_WEBHOOK_SECRET || provided !== process.env.ZOHO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid secret' });
  }
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q required' });
  try {
    const rows = (await pool.query(
      `SELECT deal_id, deal_name, account_name, owner_name, lead_source_group,
              lead_source_group_override, points, sold_date::date AS sold_date,
              closing_date_crm::date AS closing_date_crm, amount::float AS amount, first_seen_at
       FROM crm_sold_deals WHERE deal_name ILIKE '%'||$1||'%' OR account_name ILIKE '%'||$1||'%'
       ORDER BY sold_date DESC, deal_id`,
      [q]
    )).rows;
    res.json({ count: rows.length, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/prune-deleted-deal?secret=&q=<name>  — remove stored CRM deals (matching q)
// that NO LONGER exist in Zoho (deleted there). The regular sync only upserts, so a deal deleted
// in Zoho lingers as a stale row + phantom point. This prunes ONLY the gone ones (preserves
// lead-source overrides on everything else, unlike the full TRUNCATE reset).
app.post('/api/admin/prune-deleted-deal', async (req, res) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (!process.env.ZOHO_WEBHOOK_SECRET || provided !== process.env.ZOHO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid secret' });
  }
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q required' });
  try {
    const crmToken = await ensureValidCrmToken();
    if (!crmToken) return res.status(400).json({ error: 'CRM not connected' });
    const searchUrl = `https://www.zohoapis.com/crm/v2/Deals/search?criteria=(Deal_Name:starts_with:${encodeURIComponent(q)})`;
    const crmRes = await axios.get(searchUrl, {
      headers: { Authorization: `Zoho-oauthtoken ${crmToken}` }, validateStatus: () => true,
    });
    const zohoIds = new Set((crmRes.data?.data || []).map(d => String(d.id)));
    // Safety: if Zoho returned nothing (search hiccup), don't delete anything.
    if (zohoIds.size === 0) return res.status(409).json({ error: 'Zoho returned 0 deals for that query — aborting to avoid wrong deletes', zohoCount: 0 });
    const stored = (await pool.query(
      `SELECT deal_id, deal_name FROM crm_sold_deals WHERE deal_name ILIKE '%'||$1||'%' OR account_name ILIKE '%'||$1||'%'`,
      [q]
    )).rows;
    const toDelete = stored.filter(r => !zohoIds.has(String(r.deal_id)));
    for (const r of toDelete) await pool.query(`DELETE FROM crm_sold_deals WHERE deal_id = $1`, [r.deal_id]);
    res.json({ zohoDeals: zohoIds.size, storedMatched: stored.length, pruned: toDelete.length, prunedIds: toDelete.map(r => r.deal_id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
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

// GET /api/crm/deal-by-name?q=Ivona — find a deal by name and return BOTH the raw
// Zoho CRM response AND what we stored in our DB. Useful for diagnosing missing fields.
app.get('/api/crm/deal-by-name', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.status(400).json({ error: 'q param required' });
  try {
    const crmToken = await ensureValidCrmToken();
    if (!crmToken) return res.status(400).json({ error: 'CRM not connected' });
    const crm = new ZohoCRMService(crmToken);

    // Search CRM for deals matching the name
    const searchUrl = `https://www.zohoapis.com/crm/v2/Deals/search?criteria=(Deal_Name:starts_with:${encodeURIComponent(q)})`;
    const crmRes = await axios.get(searchUrl, {
      headers: { Authorization: `Zoho-oauthtoken ${crmToken}` },
      validateStatus: () => true,
    });
    const rawDeals = crmRes.data?.data || [];

    // Look up what we have stored in our DB
    const dbRes = await pool.query(
      `SELECT deal_id, deal_name, account_name, owner_name, lead_source_group, points,
              sold_date, closing_date_crm, amount, first_seen_at, updated_at
       FROM crm_sold_deals
       WHERE deal_name ILIKE $1 OR account_name ILIKE $1`,
      [`%${q}%`]
    );

    // For each raw deal, expose all keys containing "source" / "lead" to make it
    // easy to spot which field has the value.
    const rawSummary = rawDeals.map(d => {
      const sourceKeys = Object.keys(d).filter(k => /source|lead/i.test(k));
      const sourceFields = {};
      sourceKeys.forEach(k => sourceFields[k] = d[k]);
      return {
        id: d.id,
        Deal_Name: d.Deal_Name,
        Stage: d.Stage,
        Account_Name: typeof d.Account_Name === 'object' ? d.Account_Name?.name : d.Account_Name,
        Owner: typeof d.Owner === 'object' ? d.Owner?.name : d.Owner,
        Closing_Date: d.Closing_Date,
        Modified_Time: d.Modified_Time,
        sourceFields,
        all_keys: Object.keys(d),
      };
    });

    res.json({
      query: q,
      crm_raw_count: rawDeals.length,
      crm_summary: rawSummary,
      db_count: dbRes.rows.length,
      db_rows: dbRes.rows,
    });
  } catch (error) {
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

// GET /api/crm/account/:id — fetch an Account from Zoho CRM (for diagnostic)
app.get('/api/crm/account/:id', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  try {
    const crmToken = await ensureValidCrmToken();
    if (!crmToken) return res.status(400).json({ error: 'CRM not connected' });
    const crm = new ZohoCRMService(crmToken);
    const account = await crm.getAccount(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    // Highlight source-related fields
    const sourceKeys = Object.keys(account).filter(k => /source|lead/i.test(k));
    const sourceFields = {};
    sourceKeys.forEach(k => sourceFields[k] = account[k]);

    res.json({
      id: account.id,
      Account_Name: account.Account_Name,
      sourceFields,
      all_keys: Object.keys(account),
    });
  } catch (error) {
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

// POST /api/crm/sync — non-destructive manual CRM sync (upserts, preserves sold_date)
// Runs in background to avoid Heroku 30-sec timeout.
let crmSyncStatus = { running: false, startedAt: null, result: null, error: null };

app.post('/api/crm/sync', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  if (crmSyncStatus.running) {
    return res.status(409).json({ error: 'CRM sync already in progress', startedAt: crmSyncStatus.startedAt });
  }

  crmSyncStatus = { running: true, startedAt: new Date().toISOString(), result: null, error: null };
  res.json({ success: true, message: 'CRM sync started — poll /api/crm/sync-status for result' });

  (async () => {
    try {
      const crmToken = await ensureValidCrmToken();
      if (!crmToken) throw new Error('CRM not connected — please reconnect Zoho CRM');
      const crm = new ZohoCRMService(crmToken);
      const result = await syncCrmSoldDeals(crm);
      crmSyncStatus = { running: false, startedAt: crmSyncStatus.startedAt, result, error: null };
      console.log('✅ Manual CRM sync complete:', result);
    } catch (err) {
      crmSyncStatus = { running: false, startedAt: crmSyncStatus.startedAt, result: null, error: err.message };
      console.error('❌ Manual CRM sync failed:', err.message);
    }
  })();
});

// GET /api/crm/sync-status — poll manual sync progress
app.get('/api/crm/sync-status', authenticateToken, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  res.json(crmSyncStatus);
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

// Tracked in memory so /api/sync/status can show 'syncing' in real time
let invoiceSyncRunning = false;
let invoiceSyncStartedAt = null;

async function autoSyncInvoices() {
  invoiceSyncRunning = true;
  invoiceSyncStartedAt = new Date().toISOString();
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

    // Sync invoices only from this date onward (configurable via env var).
    // Default Jan 1, 2026. Saves ~50K legacy invoices from being re-pulled.
    const dateStart = process.env.INVOICES_SYNC_FROM_DATE || '2026-01-01';

    // Helper: paginated fetch by status with date_start filter
    async function fetchAllByStatus(status) {
      const all = [];
      let page = 1;
      let hasMore = true;
      while (hasMore) {
        const r = await axios.get(`${admin.api_domain}/books/v3/invoices`, {
          params: {
            organization_id: process.env.ZOHO_ORG_ID,
            status,
            date_start: dateStart,
            per_page: 200,
            page,
          },
          headers: { 'Authorization': `Zoho-oauthtoken ${admin.access_token}` },
          validateStatus: () => true,
        });
        if (r.status !== 200) {
          console.warn(`⚠️ [AUTO-SYNC] ${status} page ${page} returned ${r.status}:`, JSON.stringify(r.data).slice(0, 200));
          break;
        }
        const rows = r.data?.invoices || [];
        all.push(...rows);
        hasMore = r.data?.page_context?.has_more_page === true;
        console.log(`  [AUTO-SYNC] ${status} page ${page}: +${rows.length} (total ${all.length})`);
        page++;
      }
      return all;
    }

    console.log(`🔗 [AUTO-SYNC] Fetching invoices from ${dateStart}+ paginated...`);
    // Fetch every status that can affect commissions / show up in the tracker.
    // 'void' is critical: an invoice that was paid then cancelled in Zoho should
    // flip to commission=0 in our DB — without syncing void we'd never see the change.
    // 'partially_paid' is included so we surface payments-in-progress; recalc-v2
    // still treats them as 'pending_payment' (commission only fires when fully paid).
    const paidInvoicesRaw      = await fetchAllByStatus('paid');
    const overdueInvoicesRaw   = await fetchAllByStatus('overdue');
    const partialInvoicesRaw   = await fetchAllByStatus('partially_paid');
    const voidInvoicesRaw      = await fetchAllByStatus('void');
    const paidInvoices    = paidInvoicesRaw.map(inv => ({ ...inv, status: 'paid' }));
    const overdueInvoices = overdueInvoicesRaw.map(inv => ({ ...inv, status: 'overdue' }));
    const partialInvoices = partialInvoicesRaw.map(inv => ({ ...inv, status: 'partially_paid' }));
    const voidInvoices    = voidInvoicesRaw.map(inv => ({ ...inv, status: 'void' }));
    console.log(`📊 [AUTO-SYNC] Total: ${paidInvoices.length} paid + ${overdueInvoices.length} overdue + ${partialInvoices.length} partial + ${voidInvoices.length} void`);
    const allInvoices = [...paidInvoices, ...overdueInvoices, ...partialInvoices, ...voidInvoices];

    if (allInvoices.length > 0) {
      console.log(`📥 [AUTO-SYNC] Sample paid invoice:`, JSON.stringify(paidInvoices[0], null, 2).slice(0, 500));
    }

    // Insert/Update invoices in database (paid + overdue + void).
    // Build the rows first, de-duplicating by invoice_number (last wins — mirrors the old
    // sequential loop) so a multi-row ON CONFLICT batch never tries to touch the same row
    // twice (Postgres errors on that). Then upsert in chunks: one query per ~200 rows instead
    // of one cross-cloud round-trip per invoice.
    const upsertByNumber = new Map();
    for (const inv of allInvoices) {
      const salesperson = inv.salesperson_name || 'Unassigned';
      const customerName = inv.customer_name || inv.contact_name || null;
      const total = parseFloat(inv.total) || 0;
      // recalc-v2 is the SOLE authority on `commission` — do NOT write a flat 10% baseline
      // here. It used to clobber recalc-v2's per-model values on every sync. New rows start
      // at 0; the post-sync recalc-v2 fills the real value.
      const commission = 0;
      const invDate = new Date(inv.date || new Date());
      upsertByNumber.set(inv.invoice_number, [
        inv.invoice_number, salesperson, customerName, total, inv.status, invDate, commission, process.env.ZOHO_ORG_ID,
      ]);
    }
    // Now UPDATEs salesperson_name and date too — previously a rep reassignment or a date
    // change in Zoho would not sync back to us. EXCLUDED.* refers to the row being inserted,
    // so the conflict-update semantics are identical to the old positional version.
    let syncedCount = 0;
    for (const part of chunk([...upsertByNumber.values()], 200)) {
      const vals = [];
      const tuples = part.map((row, k) => {
        const b = k * 8;
        vals.push(...row);
        return `($${b+1}, $${b+2}, $${b+3}, $${b+4}, $${b+5}, $${b+6}, $${b+7}, $${b+8})`;
      });
      await pool.query(
        `INSERT INTO invoices
         (invoice_number, salesperson_name, customer_name, total, status, date, commission, organization_id)
         VALUES ${tuples.join(', ')}
         ON CONFLICT (invoice_number) DO UPDATE SET
           salesperson_name = EXCLUDED.salesperson_name,
           customer_name    = COALESCE(EXCLUDED.customer_name, invoices.customer_name),
           total            = EXCLUDED.total,
           status           = EXCLUDED.status,
           date             = EXCLUDED.date,
           updated_at       = CURRENT_TIMESTAMP`,
        vals
      );
      syncedCount += part.length;
    }

    // ------------------------------------------------------------------
    // Reconcile deletions — anything in our DB with date >= sync_from_date
    // that Zoho doesn't have any of these statuses for anymore is
    // assumed deleted (or moved to a status we don't sync, e.g. draft).
    // Mark them 'deleted' so recalc-v2 / commission queries can exclude
    // them. We don't physically DELETE the row to preserve history.
    // ------------------------------------------------------------------
    const liveInvoiceNumbers = allInvoices.map(i => i.invoice_number).filter(Boolean);
    let deletedCount = 0;
    // Safety: count how many invoices we *expect* to have for this period.
    // If Zoho returned <50% of that, something is wrong (rate limit, partial
    // failure, etc.) — skip reconciliation rather than nuke real data.
    const expected = (await pool.query(
      `SELECT COUNT(*)::int AS c FROM invoices
       WHERE organization_id = $1 AND date >= $2::date
         AND status IN ('paid', 'overdue', 'partially_paid', 'void')`,
      [process.env.ZOHO_ORG_ID, dateStart]
    )).rows[0]?.c || 0;
    const safe = expected === 0 || liveInvoiceNumbers.length >= Math.floor(expected * 0.5);
    if (!safe) {
      console.warn(`⚠️ [AUTO-SYNC] Skipping deletion reconcile — Zoho returned ${liveInvoiceNumbers.length} but DB has ${expected}. Possible partial fetch.`);
    }
    if (safe && liveInvoiceNumbers.length > 0) {
      const deletedRes = await pool.query(
        `UPDATE invoices
         SET status = 'deleted', commission = 0, updated_at = CURRENT_TIMESTAMP
         WHERE organization_id = $1
           AND date >= $2::date
           AND status IN ('paid', 'overdue', 'partially_paid', 'void')   -- only the ones we'd expect Zoho to return
           AND invoice_number <> ALL($3::text[])
         RETURNING invoice_number`,
        [process.env.ZOHO_ORG_ID, dateStart, liveInvoiceNumbers]
      );
      deletedCount = deletedRes.rowCount || 0;
      if (deletedCount > 0) {
        console.log(`🗑️  [AUTO-SYNC] Marked ${deletedCount} invoices as deleted (no longer in Zoho)`);
      }
    }

    // Log the sync
    await pool.query(
      `INSERT INTO sync_log (invoice_count, status, organization_id, message)
       VALUES ($1, 'success', $2, $3)`,
      [syncedCount, process.env.ZOHO_ORG_ID,
       `Synced ${paidInvoices.length} paid + ${overdueInvoices.length} overdue + ${partialInvoices.length} partial + ${voidInvoices.length} void` +
       (deletedCount > 0 ? `, marked ${deletedCount} as deleted` : '')]
    );

    console.log(`✅ [AUTO-SYNC] Successfully synced ${syncedCount} invoices, ${deletedCount} deleted at ${new Date().toISOString()}`);

    // Auto-pipeline: sync → enrich-missing → recalc-v2
    // This runs ONLY in the worker dyno (Procfile: ROLE=worker), so even if it
    // OOMs, the web dyno keeps serving HTTP. Each step has a 'already running'
    // guard so overlap is safe.
    if (typeof runEnrichInvoices === 'function' && typeof runRecalcV2 === 'function') {
      (async () => {
        try {
          await runEnrichInvoices({ onlyMissing: true, source: 'post-sync' });
          await runRecalcV2('post-sync');
        } catch (e) {
          console.warn('[AUTO-SYNC] post-sync enrich+recalc failed:', e.message);
        }
      })();
    }
  } catch (error) {
    console.error(`❌ [AUTO-SYNC] Sync failed: ${error.message}`);
  } finally {
    invoiceSyncRunning = false;
  }
}

// Schedule auto-sync intervals
const AUTO_SYNC_INTERVAL         = 1 * 60 * 60 * 1000; // 1 hour   — Books full reconcile (handles deletions)
const DELTA_SYNC_INTERVAL        = 5 * 60 * 1000;       // 5 min    — Books delta poll (webhook safety net)
const ZENTACT_AUTO_SYNC_INTERVAL = 1 * 60 * 60 * 1000; // 1 hour   — Zentact merchants
const CRM_AUTO_SYNC_INTERVAL     = 1 * 60 * 60 * 1000; // 1 hour   — CRM sold deals
const RECALC_INTERVAL            = 6 * 60 * 60 * 1000; // 6 hours  — periodic recalc-v2 (independent of sync to avoid OOM)

let syncInterval;
let zentactSyncIntervalHandle;
let crmSyncIntervalHandle;

async function autoSyncZentact() {
  if (!process.env.ZENTACT_API_KEY) return; // skip if not configured
  try {
    console.log('🔄 [AUTO-SYNC] Starting automatic Zentact merchant sync...');
    const result = await syncZentactMerchants();
    console.log(`✅ [AUTO-SYNC] Zentact done: ${result.total} total, ${result.active} active, ${result.newCount} new`);
    // Chain a revenue refresh for the most recent 2 months (statements get restated).
    await syncZentactRevenue(recentPeriods(2));
  } catch (err) {
    console.error('❌ [AUTO-SYNC] Zentact sync error:', err.message);
  }
}

// ============================================================================
// ZENTACT REVENUE — per-merchant monthly Transaction Profit (totalRevenue) from
// the transaction-profitability report. Synced per ORGANIZATION (one call returns
// all the org's merchants) × MONTH (the report window is capped at 31 days).
// ============================================================================
const PSP_NAME = process.env.ZENTACT_PSP_NAME || 'ClusterPOS_POS';
let revenueSyncJob = { running: false, startedAt: null, periods: 0, orgs: 0, calls: 0, upserts: 0, errors: 0, doneAt: null };

// Build [{year, month}] for the last N calendar months (incl. current), most recent first.
function recentPeriods(n) {
  const out = [];
  const d = new Date();
  for (let i = 0; i < n; i++) {
    out.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
    d.setMonth(d.getMonth() - 1);
  }
  return out;
}

// Build [{year, month}] spanning from {fromY,fromM} to {toY,toM} inclusive.
function rangePeriods(fromY, fromM, toY, toM) {
  const out = [];
  let y = fromY, m = fromM;
  while (y < toY || (y === toY && m <= toM)) {
    out.push({ year: y, month: m });
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

// opts.resume = skip (org, month) pairs already imported, so a re-trigger after a
// deploy/restart continues where it left off instead of redoing everything. The
// worker's recent-month refresh passes resume=false (recent statements get restated).
async function syncZentactRevenue(periods, opts = {}) {
  const resume = !!opts.resume;
  if (!process.env.ZENTACT_API_KEY) return { skipped: true };
  if (!periods || periods.length === 0) return { skipped: true, reason: 'no periods' };
  const zentact = new ZentactService(process.env.ZENTACT_API_KEY);
  // org → its merchant ids (one report call per org returns all its merchants).
  const orgToMerchants = new Map();
  for (const r of (await pool.query(
    `SELECT merchant_account_id, organization_id FROM zentact_merchants WHERE organization_id IS NOT NULL AND organization_id <> ''`
  )).rows) {
    if (!orgToMerchants.has(r.organization_id)) orgToMerchants.set(r.organization_id, []);
    orgToMerchants.get(r.organization_id).push(r.merchant_account_id);
  }
  const orgs = [...orgToMerchants.keys()];

  // For resume: which (merchant, year, month) rows already exist in the requested window.
  const done = new Set();
  if (resume) {
    const yms = periods.map((p) => p.year * 100 + p.month);
    for (const r of (await pool.query(
      `SELECT merchant_account_id, year, month FROM zentact_merchant_revenue WHERE (year*100+month) = ANY($1)`,
      [yms]
    )).rows) {
      done.add(`${r.merchant_account_id}|${r.year}|${r.month}`);
    }
  }

  revenueSyncJob = { running: true, resume, startedAt: new Date().toISOString(), periods: periods.length, orgs: orgs.length, calls: 0, upserts: 0, skipped: 0, errors: 0, doneAt: null };
  console.log(`💰 [REVENUE] Sync start: ${periods.length} month(s) × ${orgs.length} org(s)${resume ? ' (resume)' : ''}`);

  for (const p of periods) {
    const mm = String(p.month).padStart(2, '0');
    const lastDay = new Date(p.year, p.month, 0).getDate();
    const fromDate = `${p.year}-${mm}-01T00:00:00Z`;
    const toDate = `${p.year}-${mm}-${String(lastDay).padStart(2, '0')}T23:59:59Z`;
    for (const org of orgs) {
      // Resume: skip this org+month if we already have data for any of its merchants.
      if (resume && (orgToMerchants.get(org) || []).some((mid) => done.has(`${mid}|${p.year}|${p.month}`))) {
        revenueSyncJob.skipped++;
        continue;
      }
      let rows = [];
      try {
        rows = await zentact.getTransactionProfitability({ organizationId: org, pspMerchantAccountName: PSP_NAME, fromDate, toDate });
        revenueSyncJob.calls++;
      } catch (e) {
        revenueSyncJob.errors++;
        continue;
      }
      for (const row of rows) {
        if (!row.merchantAccountId) continue;
        try {
          await pool.query(
            `INSERT INTO zentact_merchant_revenue
               (merchant_account_id, year, month, currency, total_volume_cents, payments_count,
                processing_cost_cents, collected_fees_cents, gateway_fee_cents, transaction_profit_cents, raw, synced_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb, CURRENT_TIMESTAMP)
             ON CONFLICT (merchant_account_id, year, month) DO UPDATE SET
               currency                 = EXCLUDED.currency,
               total_volume_cents       = EXCLUDED.total_volume_cents,
               payments_count           = EXCLUDED.payments_count,
               processing_cost_cents    = EXCLUDED.processing_cost_cents,
               collected_fees_cents     = EXCLUDED.collected_fees_cents,
               gateway_fee_cents        = EXCLUDED.gateway_fee_cents,
               transaction_profit_cents = EXCLUDED.transaction_profit_cents,
               raw                      = EXCLUDED.raw,
               synced_at                = CURRENT_TIMESTAMP`,
            [
              row.merchantAccountId, p.year, p.month, row.currency || null,
              Math.round(row.totalVolume || 0), Math.round(row.totalPaymentsCount || 0),
              Math.round(row.processingCost || 0), Math.round(row.collectedFees || 0),
              Math.round(row.gatewayFee || 0), Math.round(row.totalRevenue || 0),
              JSON.stringify(row),
            ]
          );
          revenueSyncJob.upserts++;
        } catch (e) {
          revenueSyncJob.errors++;
        }
      }
    }
  }
  revenueSyncJob.running = false;
  revenueSyncJob.doneAt = new Date().toISOString();
  console.log(`✅ [REVENUE] Sync done: ${revenueSyncJob.calls} calls, ${revenueSyncJob.upserts} upserts, ${revenueSyncJob.errors} errors`);
  return revenueSyncJob;
}

// ============================================================================
// ZENTACT OTHER REVENUE — recurring + terminal fees (pre-tax), parsed from each
// merchant's monthly statement PDF (the only source). Per MERCHANT × month, so
// heavier than the profit sync. Resumable: skips merchant-months already parsed.
// ============================================================================
let otherRevJob = { running: false, startedAt: null, periods: 0, merchants: 0, fetched: 0, statements: 0, upserts: 0, skipped: 0, errors: 0, doneAt: null };

async function syncZentactOtherRevenue(periods, opts = {}) {
  const resume = !!opts.resume;
  if (!process.env.ZENTACT_API_KEY) return { skipped: true };
  if (!periods || periods.length === 0) return { skipped: true, reason: 'no periods' };
  const zentact = new ZentactService(process.env.ZENTACT_API_KEY);
  const merchants = (await pool.query(
    `SELECT merchant_account_id FROM zentact_merchants WHERE merchant_account_id IS NOT NULL`
  )).rows.map((r) => r.merchant_account_id);

  const done = new Set();
  if (resume) {
    const yms = periods.map((p) => p.year * 100 + p.month);
    for (const r of (await pool.query(
      `SELECT merchant_account_id, year, month FROM zentact_merchant_revenue
       WHERE other_revenue_cents IS NOT NULL AND (year*100+month) = ANY($1)`,
      [yms]
    )).rows) {
      done.add(`${r.merchant_account_id}|${r.year}|${r.month}`);
    }
  }

  otherRevJob = { running: true, resume, startedAt: new Date().toISOString(), periods: periods.length, merchants: merchants.length, fetched: 0, statements: 0, upserts: 0, skipped: 0, errors: 0, doneAt: null };
  console.log(`🧾 [OTHER-REV] Sync start: ${periods.length} month(s) × ${merchants.length} merchant(s)${resume ? ' (resume)' : ''}`);

  for (const p of periods) {
    for (const mid of merchants) {
      if (resume && done.has(`${mid}|${p.year}|${p.month}`)) { otherRevJob.skipped++; continue; }
      let res;
      try {
        res = await zentact.getStatementOtherRevenue({ merchantAccountId: mid, calMonth: p.month, year: p.year, pspMerchantAccountName: PSP_NAME });
        otherRevJob.fetched++;
      } catch (e) {
        otherRevJob.errors++;
        continue;
      }
      if (!res) continue; // no statement for this merchant/month
      otherRevJob.statements++;
      try {
        await pool.query(
          `INSERT INTO zentact_merchant_revenue (merchant_account_id, year, month, other_revenue_cents, synced_at)
           VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP)
           ON CONFLICT (merchant_account_id, year, month) DO UPDATE SET
             other_revenue_cents = EXCLUDED.other_revenue_cents, synced_at = CURRENT_TIMESTAMP`,
          [mid, res.year, res.month, res.otherRevenueCents]
        );
        otherRevJob.upserts++;
      } catch (e) {
        otherRevJob.errors++;
      }
    }
  }
  otherRevJob.running = false;
  otherRevJob.doneAt = new Date().toISOString();
  console.log(`✅ [OTHER-REV] Sync done: ${otherRevJob.fetched} fetched, ${otherRevJob.statements} statements, ${otherRevJob.upserts} upserts, ${otherRevJob.errors} errors`);
  return otherRevJob;
}

async function autoSyncCrm() {
  try {
    console.log('🔄 [AUTO-SYNC] Starting automatic CRM sold-deals sync...');
    const crmToken = await ensureValidCrmToken();
    if (!crmToken) {
      console.log('⚠️ [AUTO-SYNC] CRM not connected — skipping');
      return;
    }
    const crm = new ZohoCRMService(crmToken);
    const result = await syncCrmSoldDeals(crm);
    console.log(`✅ [AUTO-SYNC] CRM done: ${result.total} deals processed, ${result.newCount} new`);
  } catch (err) {
    console.error('❌ [AUTO-SYNC] CRM sync error:', err.message);
  }
}

function startAutoSync() {
  console.log('⏰ [AUTO-SYNC] Starting automatic sync scheduler (Books 4h, Zentact 1h, CRM 1h)');

  // Invoices — full reconcile run immediately, then every hour (handles deletions).
  // Delta poll runs every 5 min as the webhook safety net.
  autoSyncInvoices();
  syncInterval = setInterval(autoSyncInvoices, AUTO_SYNC_INTERVAL);
  setTimeout(deltaSyncInvoices, 60 * 1000); // first delta after 1 min
  setInterval(deltaSyncInvoices, DELTA_SYNC_INTERVAL);

  // Recalc-v2 — runs on its own 6h cadence, offset 30 min from sync to avoid
  // overlapping with the heavy sync window. Skips if already running (guard
  // in runRecalcV2). Light job: just reads invoices + writes commission cols.
  setTimeout(() => {
    if (typeof runRecalcV2 === 'function') {
      runRecalcV2('scheduled').catch(e => console.warn('[SCHEDULED-RECALC] failed:', e.message));
      setInterval(() => {
        runRecalcV2('scheduled').catch(e => console.warn('[SCHEDULED-RECALC] failed:', e.message));
      }, RECALC_INTERVAL);
    }
  }, 30 * 60 * 1000); // first scheduled recalc 30 min after boot

  // Zentact — first run after 5 seconds, then every 1 hour
  setTimeout(() => {
    autoSyncZentact();
    zentactSyncIntervalHandle = setInterval(autoSyncZentact, ZENTACT_AUTO_SYNC_INTERVAL);
  }, 5 * 1000);

  // CRM — first run after 10 seconds (stagger from Zentact), then every 1 hour
  setTimeout(() => {
    autoSyncCrm();
    crmSyncIntervalHandle = setInterval(autoSyncCrm, CRM_AUTO_SYNC_INTERVAL);
  }, 10 * 1000);

  // Other Revenue (statement PDFs) — per-merchant, so DAILY not hourly. resume=true
  // skips months already parsed → effectively a monthly refresh as new statements
  // appear. First run 2 min after boot (stagger from the merchant sync).
  setTimeout(() => {
    const runOtherRev = () =>
      syncZentactOtherRevenue(recentPeriods(2), { resume: true })
        .catch((e) => console.error('❌ [OTHER-REV] auto sync error:', e.message));
    runOtherRev();
    setInterval(runOtherRev, 24 * 60 * 60 * 1000);
  }, 2 * 60 * 1000);
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
  if (crmSyncIntervalHandle) {
    clearInterval(crmSyncIntervalHandle);
    console.log('⏹️ [AUTO-SYNC] Stopped CRM sync scheduler');
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
  let additionalLocationResolved = 0;

  // Cache accounts within this sync to avoid re-fetching the same one for multiple deals
  const accountCache = new Map();

  for (const rawDeal of deals) {
    // SPECIAL CASE: "Additional Location" deals don't carry their own lead source —
    // the real source is on the parent Account (it's a new branch of an existing client).
    const ls = (rawDeal.Lead_Source || '').toLowerCase().trim();
    if (ls === 'additional location') {
      const accountId =
        rawDeal.Account_ID ||
        (typeof rawDeal.Account_Name === 'object' ? rawDeal.Account_Name?.id : null);
      if (accountId) {
        let account = accountCache.get(accountId);
        if (account === undefined) {
          account = await crm.getAccount(accountId);
          accountCache.set(accountId, account);
        }
        if (account) {
          const acctSource = account.Lead_Source || null;
          const acctGroup  = account.Lead_Source_Group || null;
          if (acctSource || acctGroup) {
            // Override the deal's source values with the parent Account's
            if (acctSource) rawDeal.Lead_Source = acctSource;
            if (acctGroup)  rawDeal.Lead_Source_Group = acctGroup;
            additionalLocationResolved++;
            console.log(
              `📍 Deal ${rawDeal.id} '${rawDeal.Deal_Name}' (Additional Location) → ` +
              `using Account ${accountId} source: '${acctSource}' / group: '${acctGroup}'`
            );
          }
        }
      }
    }

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
  // New auto-detected reps default to INACTIVE (admin activates the real ones); existing
  // reps keep their current is_active status (DO NOTHING never flips it).
  const uniqueReps = [...new Set(deals.map(d => crm.transformDeal(d, userMap).sales_rep_name).filter(n => n && n !== 'Unassigned'))];
  for (const repName of uniqueReps) {
    await pool.query(`
      INSERT INTO salespeople (name, is_active)
      VALUES ($1, false)
      ON CONFLICT (name) DO NOTHING
    `, [repName]);
  }
  console.log(`👥 Upserted ${uniqueReps.length} CRM reps into salespeople table`);

  console.log(`✅ CRM sync: ${deals.length} deals processed, ${newCount} new, ${additionalLocationResolved} 'Additional Location' resolved via Account`);
  return { total: deals.length, newCount, additionalLocationResolved };
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

  // Preload lookup tables ONCE instead of issuing up to 5 queries per merchant against a
  // cross-cloud DB (was the dominant cost / connection-hog of this sync). We match in memory
  // below, preserving the exact resolution precedence: exact > alias > prefix > raw > email > deal.
  const spAll = await pool.query(`SELECT name, is_active, aliases FROM salespeople`);
  const activeExactByName = new Map(); // lower(name) -> canonical name (ACTIVE reps only)
  const aliasToName       = new Map(); // lower(alias) -> canonical name (any rep)
  const allRepNames       = [];        // for first-name prefix matching (any rep)
  for (const r of spAll.rows) {
    allRepNames.push(r.name);
    const lname = r.name.toLowerCase();
    if (r.is_active && !activeExactByName.has(lname)) activeExactByName.set(lname, r.name);
    let aliases = r.aliases;
    if (typeof aliases === 'string') { try { aliases = JSON.parse(aliases); } catch { aliases = []; } }
    if (Array.isArray(aliases)) {
      for (const a of aliases) {
        if (a == null) continue;
        const key = String(a).toLowerCase();
        if (!aliasToName.has(key)) aliasToName.set(key, r.name);
      }
    }
  }
  const tokensRes = await pool.query(`SELECT email, display_name FROM user_tokens WHERE email IS NOT NULL`);
  const displayNameByEmail = new Map(tokensRes.rows.map(t => [t.email.toLowerCase(), t.display_name]));
  const dealsRes = await pool.query(`SELECT deal_id, owner_name FROM crm_sold_deals WHERE deal_id IS NOT NULL`);
  const ownerByDealId = new Map(dealsRes.rows.map(d => [String(d.deal_id), d.owner_name]));
  const existingZentact = await pool.query(`SELECT merchant_account_id, activated_at FROM zentact_merchants`);
  const activatedByMerchant = new Map(existingZentact.rows.map(z => [z.merchant_account_id, z.activated_at]));

  for (const raw of rawMerchants) {
    const m = zentact.transformMerchant(raw);

    // --- Rep name resolution (all in-memory against the preloaded maps) ---
    // Zentact uses { name: 'sales_rep', value: 'FirstName' } — match against salespeople table
    let repName = null;
    if (m.sales_rep_raw) {
      const rawLower = m.sales_rep_raw.toLowerCase();
      // 1. Exact match — only against ACTIVE salespeople so deactivated
      //    standalone first-name records (e.g. lone "Erika") never beat the
      //    canonical full-name rep that has the alias set.
      repName = activeExactByName.get(rawLower) || null;

      // 2. Alias match — admin-configured nicknames ("Gaby" → "Gabriella Daly")
      if (!repName) repName = aliasToName.get(rawLower) || null;

      // 3. First-name prefix match — "Dora" → "Dora Smith"
      if (!repName) {
        repName = allRepNames.find(n => {
          const ln = n.toLowerCase();
          return ln.startsWith(rawLower + ' ') || ln.endsWith(' ' + rawLower);
        }) || null;
      }

      // 4. Use the raw value as-is so the merchant is never "Unassigned"
      //    (admin can later add it as an alias via Salespeople panel)
      if (!repName) repName = m.sales_rep_raw;
    }

    // 5. Fallback: email lookup (legacy / other orgs)
    if (!repName && m.sales_rep_email) {
      repName = displayNameByEmail.get(m.sales_rep_email.toLowerCase()) || null;
    }
    // 6. Fallback: Opportunity_ID → crm_sold_deals.owner_name
    if (!repName && m.opportunity_id) {
      repName = ownerByDealId.get(String(m.opportunity_id)) || null;
    }
    // 6. Fall back to the existing rep name already in DB (don't overwrite with a worse value)

    if (m.status === 'ACTIVE') activatedCount++;

    // For ACTIVE merchants, look up the real activation date. Best historical
    // proxy = earliest billing statement month (if a merchant was billed in
    // March, they were boarded by then). Fall back to first transaction date
    // if no statements yet. If neither exists (newly activated, no transactions
    // yet) → stamp today's date so the merchant shows up in the current month
    // instead of being invisible forever.
    let activatedAt = null;
    if (m.status === 'ACTIVE') {
      const currentDate = activatedByMerchant.get(m.merchant_account_id);

      if (!currentDate) {
        try {
          // 1. Earliest statement month (best boarded-date proxy)
          activatedAt = await zentact.getEarliestStatementDate(m.merchant_account_id);
          // 2. Fall back to first transaction if no statements
          if (!activatedAt) {
            activatedAt = await zentact.getEarliestTransactionDate(m.merchant_account_id);
          }
        } catch (e) {
          console.warn(`⚠️ Could not fetch activation date for ${m.merchant_account_id}:`, e.message);
        }
        // 3. Final fallback: today's date so the merchant is visible in the
        //    tracker. Webhook will overwrite with exact date when status
        //    transition actually happened (future events only).
        if (!activatedAt) {
          activatedAt = new Date().toISOString().split('T')[0];
          console.log(`📅 No Zentact billing/transaction history for ${m.merchant_account_id} — stamping today (${activatedAt})`);
        }
      } else {
        activatedAt = currentDate;
      }
    }

    const result = await pool.query(`
      INSERT INTO zentact_merchants
        (merchant_account_id, organization_id, business_name, invitee_email, status,
         sales_rep_email, sales_rep_name, opportunity_id, reseller_attribute, activated_at, stores, raw_attributes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb)
      ON CONFLICT (merchant_account_id) DO UPDATE SET
        status            = EXCLUDED.status,
        business_name     = EXCLUDED.business_name,
        sales_rep_email   = COALESCE(EXCLUDED.sales_rep_email, zentact_merchants.sales_rep_email),
        sales_rep_name    = COALESCE($7, zentact_merchants.sales_rep_name),
        opportunity_id    = COALESCE(EXCLUDED.opportunity_id,  zentact_merchants.opportunity_id),
        reseller_attribute = COALESCE(EXCLUDED.reseller_attribute, zentact_merchants.reseller_attribute),
        activated_at    = CASE
          -- Keep any existing date (never overwrite a real stamp)
          WHEN zentact_merchants.activated_at IS NOT NULL
            THEN zentact_merchants.activated_at
          -- First time we see this merchant as ACTIVE → stamp today
          WHEN EXCLUDED.status = 'ACTIVE'
            THEN COALESCE(zentact_merchants.activated_at, EXCLUDED.activated_at)
          ELSE NULL
        END,
        stores          = EXCLUDED.stores,
        raw_attributes  = EXCLUDED.raw_attributes,
        updated_at      = CURRENT_TIMESTAMP
      RETURNING (xmax = 0) AS inserted
    `, [m.merchant_account_id, m.organization_id, m.business_name, m.invitee_email,
        m.status, m.sales_rep_email, repName, m.opportunity_id, m.reseller_attribute, activatedAt,
        JSON.stringify(m.stores || []), m.raw_attributes]);

    if (result.rows[0]?.inserted) newCount++;
  }

  // Upsert resolved rep names into salespeople table. New auto-detected reps default to
  // INACTIVE (admin activates the real ones); existing reps keep their status (DO NOTHING).
  const activeRepsRes = await pool.query(
    `SELECT DISTINCT sales_rep_name FROM zentact_merchants
     WHERE sales_rep_name IS NOT NULL AND sales_rep_name <> ''`
  );
  const repNamesToUpsert = activeRepsRes.rows.map(r => r.sales_rep_name);
  if (repNamesToUpsert.length) {
    const valuesSql = repNamesToUpsert.map((_, i) => `($${i + 1}, false)`).join(', ');
    await pool.query(
      `INSERT INTO salespeople (name, is_active) VALUES ${valuesSql} ON CONFLICT (name) DO NOTHING`,
      repNamesToUpsert
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
    `SELECT email, crm_access_token, crm_refresh_token, crm_expires_at
     FROM user_tokens WHERE crm_refresh_token IS NOT NULL
     ORDER BY updated_at DESC LIMIT 1`
  );

  if (!result.rows.length) {
    // Try fallback: any admin with crm_access_token (legacy rows without refresh_token)
    const fallback = await pool.query(
      `SELECT email, crm_access_token, crm_refresh_token, crm_expires_at
       FROM user_tokens WHERE is_admin = true AND crm_access_token IS NOT NULL
       ORDER BY updated_at DESC LIMIT 1`
    );
    if (!fallback.rows.length) {
      throw new Error('CRM not connected. Please connect Zoho CRM in the Admin Panel.');
    }
    result.rows[0] = fallback.rows[0];
  }

  let row = result.rows[0];
  const expiresAt = row.crm_expires_at ? parseInt(row.crm_expires_at) : null;

  // Proactive refresh: refresh if expiring within 10 min (was 5) for safety margin
  const needsRefresh = !expiresAt || expiresAt < Date.now() + 10 * 60 * 1000;

  if (needsRefresh && row.crm_refresh_token) {
    console.log(`🔄 Refreshing CRM token (current expiry: ${expiresAt ? new Date(expiresAt).toISOString() : 'unknown'})...`);
    try {
      const refreshRes = await axios.post(
        'https://accounts.zoho.com/oauth/v2/token',
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: process.env.ZOHO_CLIENT_ID,
          client_secret: process.env.ZOHO_CLIENT_SECRET,
          refresh_token: row.crm_refresh_token,
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, validateStatus: () => true }
      );

      const newToken = refreshRes.data?.access_token;
      const newRefreshToken = refreshRes.data?.refresh_token || row.crm_refresh_token;
      const newExpiry = Date.now() + (parseInt(refreshRes.data?.expires_in) || 3600) * 1000;

      if (!newToken) {
        console.error('❌ CRM refresh returned no access_token:', JSON.stringify(refreshRes.data));
        // Don't throw if existing token is still valid
        if (expiresAt && expiresAt > Date.now()) {
          console.warn('⚠️ Using existing token despite refresh failure');
          return row.crm_access_token;
        }
        throw new Error(`CRM token refresh failed: ${JSON.stringify(refreshRes.data).slice(0, 200)}`);
      }

      // Update the SPECIFIC row (by email) to avoid touching other admins' rows
      await pool.query(
        `UPDATE user_tokens
         SET crm_access_token = $1, crm_refresh_token = $2, crm_expires_at = $3, updated_at = CURRENT_TIMESTAMP
         WHERE email = $4`,
        [newToken, newRefreshToken, newExpiry, row.email]
      );

      console.log(`✅ CRM token refreshed (new expiry: ${new Date(newExpiry).toISOString()})`);
      return newToken;
    } catch (err) {
      console.error('❌ CRM token refresh failed:', err.response?.data || err.message);
      // If existing token is still valid, use it; never silently disconnect
      if (expiresAt && expiresAt > Date.now()) {
        console.warn('⚠️ Using existing CRM token despite refresh failure (still valid)');
        return row.crm_access_token;
      }
      throw new Error(`CRM token expired and refresh failed: ${err.message}`);
    }
  }

  // No refresh needed or no refresh_token available — use current
  if (!row.crm_access_token) {
    throw new Error('CRM not connected. Please connect Zoho CRM in the Admin Panel.');
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
      // recalc-v2 owns `commission` — never overwrite it from a sync (was a flat 10% clobber).
      const commission = 0;
      const invDate = new Date(inv.date || new Date());

      await pool.query(
        `INSERT INTO invoices
         (invoice_number, salesperson_name, customer_name, total, status, date, commission, organization_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (invoice_number) DO UPDATE SET
         status = $5, total = $4, customer_name = COALESCE($3, invoices.customer_name),
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

    // Assigned RBAC role names (for the read-only "Role" field on the profile).
    const roleRows = (await pool.query(
      `SELECT r.name FROM roles r JOIN user_roles ur ON ur.role_id = r.id
       WHERE LOWER(ur.user_email) = LOWER($1) ORDER BY r.name`, [email]
    )).rows;

    res.json({
      roles: roleRows.map(r => r.name),
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
  // Company-wide invoice/revenue stats. Allowed for admins, the company-invoices perm,
  // OR the dedicated Admin-dashboard perm (so a non-admin "Management" role can see it).
  let perms = null;
  if (req.user.isAdmin !== true) {
    perms = await getUserPermissions(req.user.email);
    if (!userHasPermission(perms, 'invoices:view_all') && !userHasPermission(perms, 'dashboard:view_admin')) {
      return res.status(403).json({ error: 'Permission required: dashboard:view_admin' });
    }
  }
  // Payment (Zentact) revenue is normally gated by revenue:view — only include the
  // "payment revenue per client" section for admins or users who hold that permission.
  const canRevenue = req.user.isAdmin === true || (perms && userHasPermission(perms, 'revenue:view'));
  const year = parseInt(req.query.year) || new Date().getFullYear();
  try {
    const startDate = new Date(year, 0, 1);
    const endDate   = new Date(year, 11, 31, 23, 59, 59, 999);
    // Drop admin-excluded customers (e.g. Adyen payout pseudo-customers) from every figure.
    // NULL-named invoices are kept (they aren't a named, excludable customer).
    const excl = `AND (customer_name IS NULL OR customer_name NOT IN (SELECT customer_name FROM excluded_customers WHERE organization_id = $1))`;

    const cardsResult = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'paid'    THEN total ELSE 0 END), 0) AS paid_revenue,
        COALESCE(SUM(CASE WHEN status = 'paid'    THEN commission ELSE 0 END), 0) AS total_commission,
        COUNT(*)                                                               AS total_invoices,
        COALESCE(SUM(CASE WHEN status = 'overdue' THEN total ELSE 0 END), 0) AS overdue_amount,
        COUNT(CASE WHEN status = 'paid'    THEN 1 END)                       AS paid_count,
        COUNT(CASE WHEN status = 'overdue' THEN 1 END)                       AS overdue_count
      FROM invoices
      WHERE organization_id = $1 AND date >= $2 AND date <= $3 ${excl}
    `, [process.env.ZOHO_ORG_ID, startDate, endDate]);

    const monthlyResult = await pool.query(`
      SELECT
        TO_CHAR(date, 'Mon') AS month,
        EXTRACT(MONTH FROM date) AS month_num,
        COALESCE(SUM(CASE WHEN status = 'paid'    THEN total ELSE 0 END), 0) AS revenue,
        COALESCE(SUM(CASE WHEN status = 'overdue' THEN total ELSE 0 END), 0) AS overdue,
        COALESCE(SUM(CASE WHEN status = 'paid'    THEN commission ELSE 0 END), 0) AS commission
      FROM invoices
      WHERE organization_id = $1 AND date >= $2 AND date <= $3 ${excl}
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
      WHERE organization_id = $1 AND status = 'paid' AND date >= $2 AND date <= $3 ${excl}
      GROUP BY salesperson_name ORDER BY commission DESC LIMIT 10
    `, [process.env.ZOHO_ORG_ID, startDate, endDate]);

    const statusResult = await pool.query(`
      SELECT status, COUNT(*) AS count, COALESCE(SUM(total), 0) AS total
      FROM invoices WHERE organization_id = $1 AND date >= $2 AND date <= $3 ${excl}
      GROUP BY status
    `, [process.env.ZOHO_ORG_ID, startDate, endDate]);

    const customerResult = await pool.query(`
      SELECT
        COALESCE(NULLIF(TRIM(customer_name), ''), 'Unknown') AS name,
        COUNT(*) AS invoices,
        COALESCE(SUM(total), 0) AS total
      FROM invoices
      WHERE organization_id = $1 AND status = 'paid' AND date >= $2 AND date <= $3 ${excl}
        AND COALESCE(NULLIF(TRIM(customer_name), ''), '') != ''
      GROUP BY COALESCE(NULLIF(TRIM(customer_name), ''), 'Unknown')
      ORDER BY total DESC LIMIT 10
    `, [process.env.ZOHO_ORG_ID, startDate, endDate]);

    // Board metrics use a MONTHLY run-rate: total ÷ months elapsed in the period ÷ units, so a
    // partial current year isn't understated (full past year = 12 months; current year = months
    // so far). Mixes monthly- and annual-billed clients onto a comparable per-month figure.
    const nowD = new Date();
    const monthsInPeriod = year < nowD.getFullYear() ? 12 : (year > nowD.getFullYear() ? 0 : (nowD.getMonth() + 1));
    const perMonth = (total, units) => (monthsInPeriod > 0 && units > 0) ? (total / monthsInPeriod / units) : 0;

    // AVERAGE monthly SaaS revenue per client (SH-8): total paid SaaS subtotal ÷ months ÷ clients
    // that have any SaaS revenue.
    const saasAvgRes = await pool.query(`
      SELECT
        COALESCE(SUM(saas_amount), 0) AS total,
        COUNT(DISTINCT CASE WHEN saas_amount > 0 THEN COALESCE(NULLIF(TRIM(customer_name), ''), 'Unknown') END) AS clients
      FROM invoices
      WHERE organization_id = $1 AND status = 'paid' AND date >= $2 AND date <= $3 ${excl}
    `, [process.env.ZOHO_ORG_ID, startDate, endDate]);
    const sa = saasAvgRes.rows[0] || {};
    const saasTotal = parseFloat(sa.total) || 0, saasClients = parseInt(sa.clients) || 0;
    const avgSaas = { total: saasTotal, clients: saasClients, monthly: perMonth(saasTotal, saasClients) };

    // AVERAGE monthly processing profit per merchant (SH-9) + combined revenue per merchant.
    // Revenue-gated (admins / revenue:view).
    let avgProcessing = null, avgRevenuePerMerchant = null;
    if (canRevenue) {
      const procAvgRes = await pool.query(`
        SELECT
          COALESCE(SUM(profit) FILTER (WHERE profit > 0), 0) AS total,
          COUNT(*) FILTER (WHERE profit > 0) AS clients
        FROM (
          SELECT merchant_account_id, SUM(transaction_profit_cents) / 100.0 AS profit
          FROM zentact_merchant_revenue WHERE year = $1 GROUP BY merchant_account_id
        ) m
      `, [year]);
      const pa = procAvgRes.rows[0] || {};
      const procTotal = parseFloat(pa.total) || 0, procMerchants = parseInt(pa.clients) || 0;
      avgProcessing = { total: procTotal, clients: procMerchants, monthly: perMonth(procTotal, procMerchants) };
      // Combined SaaS + processing revenue, averaged per merchant per month. NOTE: SaaS is keyed
      // by Zoho customer and merchants by Zentact account — this is a BLENDED figure (total ÷
      // merchant count), not a true per-merchant join (that needs SH-14, the CRM↔Zentact link).
      avgRevenuePerMerchant = {
        total:    saasTotal + procTotal,
        merchants: procMerchants,
        monthly:  perMonth(saasTotal + procTotal, procMerchants),
      };
    }

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
      avgSaas,
      avgProcessing,
      avgRevenuePerMerchant,
      monthsInPeriod,
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

// ============================================================================
// Invoice PDF helpers — fetch the rendered PDF from Zoho Books.
//   /preview: token comes in via ?token=... query string (iframe can't set headers),
//             Content-Disposition: inline so the browser renders in-place.
//   /pdf:     standard Authorization header (axios fetches as blob),
//             Content-Disposition: attachment for download.
// Both go through the most-recently-used admin token (auto-refreshed if expired).
// ============================================================================

// Returns a fresh admin access_token + api_domain. Auto-refreshes if expired.
async function getAdminBooksAuth() {
  const admin = (await pool.query(
    'SELECT email, access_token, refresh_token, api_domain, expires_at FROM user_tokens WHERE is_admin = true ORDER BY updated_at DESC LIMIT 1'
  )).rows[0];
  if (!admin) throw new Error('No admin Zoho account connected');
  // Refresh if token expired (or within 60s of expiry)
  if (admin.refresh_token && (!admin.expires_at || Date.now() > admin.expires_at - 60_000)) {
    const r = await axios.post(
      'https://accounts.zoho.com/oauth/v2/token',
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: process.env.ZOHO_CLIENT_ID,
        client_secret: process.env.ZOHO_CLIENT_SECRET,
        refresh_token: admin.refresh_token,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const newToken = r.data.access_token;
    const newExpires = Date.now() + ((parseInt(r.data.expires_in) || 3600) * 1000);
    await pool.query(
      `UPDATE user_tokens SET access_token = $1, expires_at = $2, updated_at = CURRENT_TIMESTAMP WHERE email = $3`,
      [newToken, newExpires, admin.email]
    );
    admin.access_token = newToken;
  }
  return { accessToken: admin.access_token, apiDomain: admin.api_domain };
}

// ============================================================================
// ZOHO BILLING — board SaaS metrics (MRR / ARPU / active subs / churn / LTV)
// aggregated across the company's billing organizations (one Zoho account, many
// orgs). Reuses the admin Zoho token; scope ZohoSubscriptions.subscriptions.READ
// is already in the login consent. Org IDs via env (default = the 3 known orgs).
// ============================================================================
const ZOHO_BILLING_ORG_IDS = (process.env.ZOHO_BILLING_ORG_IDS || '697704869,802470810,905113716')
  .split(',').map(s => s.trim()).filter(Boolean);
// Display names for the per-org breakdown shown when a dashboard tile is clicked.
const ZOHO_BILLING_ORG_NAMES = { '697704869': 'Cluster Canada', '802470810': 'Cluster USA', '905113716': 'Xperio POS' };

// Normalize a subscription's recurring charge to a MONTHLY amount for MRR.
function subMonthlyAmount(amount, interval, intervalUnit) {
  const a = Number(amount) || 0;
  const iv = Math.max(1, parseInt(interval) || 1);
  const unit = String(intervalUnit || 'months').toLowerCase();
  if (unit.startsWith('year')) return a / (iv * 12);
  if (unit.startsWith('week')) return (a / iv) * (52 / 12);
  if (unit.startsWith('day'))  return (a / iv) * (365 / 12);
  return a / iv; // months
}

// List every subscription of a status for one billing org (paginated).
async function fetchBillingSubs(apiDomain, accessToken, orgId, filterBy) {
  const base = (apiDomain || 'https://www.zohoapis.com').replace(/\/$/, '');
  const out = [];
  for (let page = 1; page <= 100; page++) {
    const r = await axios.get(`${base}/billing/v1/subscriptions`, {
      params: { filter_by: filterBy, page, per_page: 200 },
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        'X-com-zoho-subscriptions-organizationid': orgId,
      },
      validateStatus: () => true, timeout: 25000,
    });
    if (r.status !== 200) {
      const msg = typeof r.data === 'object' ? JSON.stringify(r.data).slice(0, 220) : String(r.data).slice(0, 220);
      throw new Error(`org ${orgId} ${filterBy} HTTP ${r.status}: ${msg}`);
    }
    out.push(...(r.data?.subscriptions || []));
    if (!r.data?.page_context?.has_more_page) break;
  }
  return out;
}

// Status → metric mapping, reverse-engineered to match the Zoho Billing dashboard exactly
// (validated against org 697704869: MRR/active/ARPU/churn/LTV all matched to the cent):
//  • MRR = monthly sub_total (PRE-TAX) of live + non_renewing + dunning + unpaid
//  • Active subscriptions = those four PLUS paused (paused counts but contributes $0 MRR)
//  • Churn % = subscriptions cancelled this month ÷ active ; LTV = ARPU ÷ churn%
const MRR_STATUSES    = new Set(['live', 'non_renewing', 'dunning', 'unpaid']);
const ACTIVE_STATUSES = new Set(['live', 'non_renewing', 'dunning', 'unpaid', 'paused']);

let _billingCache = { at: 0, data: null };
async function computeBillingMetrics() {
  const { accessToken, apiDomain } = await getAdminBooksAuth();
  let mrr = 0, activeSubs = 0, churnedThisMonth = 0;
  const perOrg = [];
  for (const orgId of ZOHO_BILLING_ORG_IDS) {
    // One "All" pass → bucket by status for MRR + active; a CANCELLED_THIS_MONTH pass for churn
    // (cancelled-this-month isn't a distinct status value, only a filter).
    const all       = await fetchBillingSubs(apiDomain, accessToken, orgId, 'SubscriptionStatus.All');
    const cancelled = await fetchBillingSubs(apiDomain, accessToken, orgId, 'SubscriptionStatus.CANCELLED_THIS_MONTH');
    let orgMrr = 0, orgActive = 0;
    for (const s of all) {
      const st = String(s.status || '').toLowerCase();
      if (ACTIVE_STATUSES.has(st)) orgActive++;
      if (MRR_STATUSES.has(st)) {
        orgMrr += subMonthlyAmount(s.sub_total != null ? s.sub_total : s.amount, s.interval, s.interval_unit);
      }
    }
    mrr += orgMrr;
    activeSubs += orgActive;
    churnedThisMonth += cancelled.length;
    const rr = (n) => Math.round(n * 100) / 100;
    const oArpu  = orgActive > 0 ? orgMrr / orgActive : 0;
    const oChurn = orgActive > 0 ? (cancelled.length / orgActive) * 100 : 0;
    const oLtv   = oChurn > 0 ? oArpu / (oChurn / 100) : 0;
    perOrg.push({
      orgId, name: ZOHO_BILLING_ORG_NAMES[orgId] || orgId,
      mrr: rr(orgMrr), arr: rr(orgMrr * 12), activeSubs: orgActive,
      arpu: rr(oArpu), churned: cancelled.length, churnRate: rr(oChurn), ltv: rr(oLtv),
    });
  }
  const arpu      = activeSubs > 0 ? mrr / activeSubs : 0;
  const churnRate = activeSubs > 0 ? (churnedThisMonth / activeSubs) * 100 : 0;
  const ltv       = churnRate > 0 ? arpu / (churnRate / 100) : 0;
  const r2 = (n) => Math.round(n * 100) / 100;
  return {
    mrr: r2(mrr), arr: r2(mrr * 12), activeSubs,
    arpu: r2(arpu), churnedThisMonth, churnRate: r2(churnRate), ltv: r2(ltv),
    perOrg, orgCount: ZOHO_BILLING_ORG_IDS.length, generatedAt: new Date().toISOString(),
  };
}

// GET /api/billing/metrics — board SaaS metrics (admins / dashboard:view_admin). Cached 30 min
// (heavy: paginated subscriptions across every billing org).
app.get('/api/billing/metrics', authenticateToken, async (req, res) => {
  if (req.user.isAdmin !== true) {
    const perms = await getUserPermissions(req.user.email);
    if (!userHasPermission(perms, 'invoices:view_all') && !userHasPermission(perms, 'dashboard:view_admin')) {
      return res.status(403).json({ error: 'Permission required: dashboard:view_admin' });
    }
  }
  try {
    if (req.query.fresh !== '1' && _billingCache.data && (Date.now() - _billingCache.at) < 30 * 60 * 1000) {
      return res.json({ ..._billingCache.data, cached: true });
    }
    const data = await computeBillingMetrics();
    _billingCache = { at: Date.now(), data };
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'billing_fetch_failed', detail: e.message });
  }
});

// Secret diagnostic: raw billing metrics so the numbers can be validated against the
// Zoho Billing dashboard before wiring the UI. GET /api/admin/billing-metrics-raw?secret=
app.get('/api/admin/billing-metrics-raw', async (req, res) => {
  if (req.query.secret !== (process.env.ZOHO_WEBHOOK_SECRET || '')) return res.status(401).json({ error: 'bad secret' });
  try {
    const data = await computeBillingMetrics();
    _billingCache = { at: Date.now(), data }; // warm the shared cache so the dashboard is instant
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'billing_fetch_failed', detail: e.message });
  }
});

// Keep the billing cache hot so the board dashboard never pays the ~30s cold-fetch. Web role
// only; initial warm shortly after boot, then refresh just under the 30-min cache TTL.
async function warmBillingCache() {
  try { _billingCache = { at: Date.now(), data: await computeBillingMetrics() }; }
  catch (e) { console.warn('[billing] cache warm failed:', e.message); }
}
if (process.env.ROLE !== 'worker') {
  setTimeout(warmBillingCache, 20000);
  setInterval(warmBillingCache, 25 * 60 * 1000);
}

// Secret calibration diagnostic: per-status breakdown for ONE org (count + MRR via `amount`
// vs `sub_total`) + the subscription field keys, to nail the exact MRR/active definition that
// matches the Zoho dashboard. GET /api/admin/billing-debug?secret=&org=
app.get('/api/admin/billing-debug', async (req, res) => {
  if (req.query.secret !== (process.env.ZOHO_WEBHOOK_SECRET || '')) return res.status(401).json({ error: 'bad secret' });
  const orgId = String(req.query.org || ZOHO_BILLING_ORG_IDS[0]);
  try {
    const { accessToken, apiDomain } = await getAdminBooksAuth();
    const all = await fetchBillingSubs(apiDomain, accessToken, orgId, 'SubscriptionStatus.All');
    const r2 = (n) => Math.round(n * 100) / 100;
    const byStatus = {};
    for (const s of all) {
      const st = s.status || 'unknown';
      (byStatus[st] ||= { count: 0, mrrAmount: 0, mrrSubTotal: 0 });
      byStatus[st].count++;
      byStatus[st].mrrAmount   += subMonthlyAmount(s.amount, s.interval, s.interval_unit);
      byStatus[st].mrrSubTotal += subMonthlyAmount(s.sub_total != null ? s.sub_total : s.amount, s.interval, s.interval_unit);
    }
    for (const k of Object.keys(byStatus)) { byStatus[k].mrrAmount = r2(byStatus[k].mrrAmount); byStatus[k].mrrSubTotal = r2(byStatus[k].mrrSubTotal); }
    const sample = all[0] || null;
    res.json({ org: orgId, total: all.length, byStatus, sampleKeys: sample ? Object.keys(sample) : [],
      sampleAmounts: sample ? { amount: sample.amount, sub_total: sample.sub_total, interval: sample.interval, interval_unit: sample.interval_unit, status: sample.status } : null });
  } catch (e) {
    res.status(502).json({ error: 'billing_debug_failed', detail: e.message });
  }
});

// SH-14 feasibility diagnostic: how well do Zentact merchants join to SaaS subscriptions?
// Tests the CRM-Deal-ID bridge (merchant.opportunity_id == subscription.zcrm_potential_id)
// plus a name-match fallback. GET /api/admin/merchant-saas-link-debug?secret=
app.get('/api/admin/merchant-saas-link-debug', async (req, res) => {
  if (req.query.secret !== (process.env.ZOHO_WEBHOOK_SECRET || '')) return res.status(401).json({ error: 'bad secret' });
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  try {
    const { accessToken, apiDomain } = await getAdminBooksAuth();
    const byPotential = new Map(); // zcrm_potential_id → monthly SaaS MRR
    const byName = new Map();      // normalized customer_name → monthly SaaS MRR
    let totalActiveSubs = 0, subsWithPotential = 0;
    for (const orgId of ZOHO_BILLING_ORG_IDS) {
      const all = await fetchBillingSubs(apiDomain, accessToken, orgId, 'SubscriptionStatus.All');
      for (const s of all) {
        if (!ACTIVE_STATUSES.has(String(s.status || '').toLowerCase())) continue;
        totalActiveSubs++;
        const m = subMonthlyAmount(s.sub_total != null ? s.sub_total : s.amount, s.interval, s.interval_unit);
        const pid = String(s.zcrm_potential_id || '').trim();
        if (pid) { subsWithPotential++; byPotential.set(pid, (byPotential.get(pid) || 0) + m); }
        const nn = norm(s.customer_name); if (nn) byName.set(nn, (byName.get(nn) || 0) + m);
      }
    }
    const merchants = (await pool.query(`SELECT merchant_account_id, business_name, opportunity_id FROM zentact_merchants`)).rows;
    let withOpp = 0, oppMatched = 0, nameOnlyMatched = 0, matchedSaasMrr = 0;
    const sampleUnmatched = [];
    for (const mch of merchants) {
      const opp = String(mch.opportunity_id || '').trim();
      const oppHit = opp && byPotential.has(opp);
      if (opp) withOpp++;
      if (oppHit) { oppMatched++; matchedSaasMrr += byPotential.get(opp); }
      else if (byName.has(norm(mch.business_name))) nameOnlyMatched++;
      else if (sampleUnmatched.length < 8) sampleUnmatched.push({ name: mch.business_name, opp: opp || null });
    }
    res.json({
      billing: { totalActiveSubs, subsWithPotential, distinctPotentials: byPotential.size },
      zentact: { totalMerchants: merchants.length, withOpportunityId: withOpp },
      join: { viaCrmDealId: oppMatched, viaNameFallback: nameOnlyMatched, totalMatched: oppMatched + nameOnlyMatched, matchedSaasMrr: Math.round(matchedSaasMrr * 100) / 100 },
      sampleUnmatched,
    });
  } catch (e) {
    res.status(502).json({ error: 'link_debug_failed', detail: e.message });
  }
});

// Look up Zoho's internal invoice_id from our local invoice_number by asking
// the Zoho Books API directly.
// Uses `search_text` — the documented general search param — and then picks the
// row whose invoice_number matches exactly. The previously-used `invoice_number`
// filter param isn't actually documented and is silently ignored by Zoho, which
// caused this helper to always return the most-recent invoice regardless of the
// query (or nothing if the response page didn't contain a match).
async function resolveInvoiceIdViaZoho(invoiceNumber, accessToken, apiDomain) {
  const r = await axios.get(`${apiDomain}/books/v3/invoices`, {
    params: {
      organization_id: process.env.ZOHO_ORG_ID,
      search_text: invoiceNumber,
      per_page: 50,
    },
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    validateStatus: () => true,
  });
  if (r.status !== 200) {
    console.warn(`Zoho invoice search for ${invoiceNumber} → HTTP ${r.status}`,
      typeof r.data === 'string' ? r.data.slice(0, 200) : JSON.stringify(r.data).slice(0, 200));
    return null;
  }
  const invoices = r.data?.invoices || [];
  const exact = invoices.find(i => (i.invoice_number || '').trim() === invoiceNumber.trim());
  if (!exact) {
    console.warn(`Invoice ${invoiceNumber} not found in Zoho — search_text returned ${invoices.length} rows, none matched exactly`);
    return null;
  }
  return exact.invoice_id || null;
}

// Fetch the rendered PDF bytes from Zoho Books for a given invoice number.
async function fetchInvoicePdfBytes(invoiceNumber) {
  const { accessToken, apiDomain } = await getAdminBooksAuth();
  const zohoId = await resolveInvoiceIdViaZoho(invoiceNumber, accessToken, apiDomain);
  if (!zohoId) return { error: 'not_found', status: 404 };
  // Zoho Books returns the PDF when the request is for /invoices/{id} with accept=pdf
  const r = await axios.get(`${apiDomain}/books/v3/invoices/${zohoId}`, {
    params: { organization_id: process.env.ZOHO_ORG_ID, accept: 'pdf' },
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    responseType: 'arraybuffer',
    validateStatus: () => true,
  });
  if (r.status !== 200) {
    const text = Buffer.isBuffer(r.data) ? r.data.toString('utf8').slice(0, 500) : JSON.stringify(r.data).slice(0, 500);
    return { error: 'zoho_error', status: r.status, body: text };
  }
  return { buffer: Buffer.from(r.data), contentType: r.headers['content-type'] || 'application/pdf' };
}

// Fetch the rendered PDF bytes of a Zoho Books ESTIMATE (devis) by its id.
async function fetchEstimatePdfBytes(estimateId) {
  const { accessToken, apiDomain } = await getAdminBooksAuth();
  const r = await axios.get(`${apiDomain}/books/v3/estimates/${estimateId}`, {
    params: { organization_id: process.env.ZOHO_ORG_ID, accept: 'pdf' },
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    responseType: 'arraybuffer',
    validateStatus: () => true,
  });
  if (r.status !== 200) {
    const text = Buffer.isBuffer(r.data) ? r.data.toString('utf8').slice(0, 500) : JSON.stringify(r.data).slice(0, 500);
    return { error: 'zoho_error', status: r.status, body: text };
  }
  return { buffer: Buffer.from(r.data), contentType: r.headers['content-type'] || 'application/pdf' };
}

// GET /api/proposals/estimates?q= — list recent Zoho Books estimates (devis) for the rep to pick from.
// (Phase 1 of the proposal builder.) Returns light metadata; the PDF + customer email are fetched at prepare time.
app.get('/api/proposals/estimates', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'proposals:send'))) return;
  try {
    const { accessToken, apiDomain } = await getAdminBooksAuth();
    const params = { organization_id: process.env.ZOHO_ORG_ID, sort_column: 'date', sort_order: 'D', per_page: 50 };
    const q = String(req.query.q || '').trim();
    if (q) params.search_text = q;
    // Scoping: admins see ALL estimates; reps see only their own (by Zoho Books salesperson name).
    // Effective admin is resolved from user_tokens.is_admin (not the JWT flag; impersonation = not admin).
    let effAdmin = false;
    if (!req.user.impersonating && req.user.email) {
      const row = (await pool.query('SELECT is_admin FROM user_tokens WHERE email = $1', [req.user.email])).rows[0];
      effAdmin = row ? !!row.is_admin : false;
    }
    if (!effAdmin && req.user.name) { params.salesperson_name = req.user.name; params.per_page = 200; }
    const r = await axios.get(`${apiDomain}/books/v3/estimates`, {
      params, headers: { Authorization: `Zoho-oauthtoken ${accessToken}` }, validateStatus: () => true,
    });
    if (r.status !== 200) {
      const detail = typeof r.data === 'string' ? r.data.slice(0, 300) : JSON.stringify(r.data).slice(0, 300);
      return res.status(502).json({ error: 'zoho_error', detail });
    }
    let estimates = (r.data.estimates || []).map(e => ({
      estimateId: e.estimate_id,
      number: e.estimate_number,
      customerName: e.customer_name,
      total: e.total,
      currency: e.currency_code,
      date: e.date,
      status: e.status,
      salesperson: e.salesperson_name || '',
      reference: e.reference_number || '',
    }));
    // Zoho Books doesn't reliably honor the salesperson_name filter param, so enforce
    // scoping server-side: a non-admin (incl. impersonated rep) sees ONLY their own estimates.
    if (!effAdmin) {
      const me = (req.user.name || '').trim().toLowerCase();
      estimates = estimates.filter(e => e.salesperson.trim().toLowerCase() === me);
    }
    res.json({ estimates });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== Proposal builder (Phase 2): generated cover + fixed company deck + Zoho estimate, merged =====
const PROPOSAL_ASSETS = require('path').join(__dirname, 'assets', 'proposals');
// Keep text WinAnsi-safe for pdf-lib standard fonts (strip emoji / smart-quote → ascii).
const winAnsiSafe = (s) => String(s || '')
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
  .replace(/[\x80-\x9F]/g, '').replace(/[^\x09\x0A\x0D\x20-\xFF]/g, '');
function wrapPdfLines(font, text, size, maxWidth) {
  const words = winAnsiSafe(text).split(/\s+/).filter(Boolean);
  const lines = []; let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (font.widthOfTextAtSize(test, size) > maxWidth && cur) { lines.push(cur); cur = w; } else cur = test;
  }
  if (cur) lines.push(cur);
  return lines;
}

// Build the personalized cover page (792×612 landscape, matching the company deck pages).
async function addProposalCover(doc, { lang, clientName, repName, title, dateStr, photoBytes, logoBytes, brandLogoBytes }) {
  const { rgb, StandardFonts } = require('pdf-lib');
  const W = 792, H = 612, padX = 46;
  const page = doc.addPage([W, H]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvB = await doc.embedFont(StandardFonts.HelveticaBold);
  const navy = rgb(0x1c / 255, 0x24 / 255, 0x34 / 255);
  const bandc = rgb(0x12 / 255, 0x19 / 255, 0x26 / 255);
  const orange = rgb(0xfe / 255, 0x65 / 255, 0x23 / 255);
  const white = rgb(1, 1, 1);
  const grey = rgb(0xc7 / 255, 0xcf / 255, 0xdb / 255);
  const greyD = rgb(0x9f / 255, 0xb0 / 255, 0xc4 / 255);
  page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: navy });

  // Right-side Cluster product screenshot, in a thin orange frame (undistorted)
  let photoX = W - padX;
  try {
    const img = await doc.embedPng(photoBytes);
    const pw = 330, ph = Math.round(pw * (img.height / img.width));
    photoX = W - padX - pw;
    const py = Math.round((H - ph) / 2) + 8;
    page.drawRectangle({ x: photoX - 3, y: py - 3, width: pw + 6, height: ph + 6, color: orange });
    page.drawImage(img, { x: photoX, y: py, width: pw, height: ph });
  } catch (_e) { photoX = W - padX; }

  const colW = photoX - 24 - padX;

  // Cluster brand logo, top-left
  let y = H - 34;
  try {
    const bl = await doc.embedPng(brandLogoBytes);
    const lw = 168, lh = Math.round(lw * (bl.height / bl.width));
    page.drawImage(bl, { x: padX, y: y - lh, width: lw, height: lh });
    y -= (lh + 26);
  } catch (_e) { y -= 16; }

  page.drawText(lang === 'en' ? 'IN PARTNERSHIP WITH' : 'EN PARTENARIAT AVEC', { x: padX, y, size: 9, font: helvB, color: greyD });
  // optional client logo under the label
  if (logoBytes) {
    try {
      let lg; try { lg = await doc.embedPng(logoBytes); } catch { lg = await doc.embedJpg(logoBytes); }
      let lw = 110, lh = Math.round(lw * (lg.height / lg.width));
      if (lh > 46) { lh = 46; lw = Math.round(lh * (lg.width / lg.height)); }
      page.drawImage(lg, { x: padX, y: y - 10 - lh, width: lw, height: lh });
      y -= (lh + 18);
    } catch (_e) { /* skip */ }
  }
  y -= 22;
  page.drawText(winAnsiSafe(lang === 'en' ? 'Proudly Canadian since 2009' : 'Fièrement canadien depuis 2009'), { x: padX, y, size: 11, font: helv, color: grey });
  y -= 34;
  const headline = (title && title.trim()) || (lang === 'en' ? 'The POS built for the restaurants of tomorrow.' : 'Le PDV conçu pour la restauration de demain.');
  for (const line of wrapPdfLines(helvB, headline, 28, colW)) { page.drawText(line, { x: padX, y, size: 28, font: helvB, color: white }); y -= 32; }
  y -= 8;
  const sub = lang === 'en'
    ? `A smooth, high-performance platform for ${clientName}, across Canada.`
    : `Une plateforme fluide et performante pour ${clientName}, partout au Canada.`;
  for (const line of wrapPdfLines(helv, sub, 13, colW)) { page.drawText(line, { x: padX, y, size: 13, font: helv, color: grey }); y -= 18; }

  // meta row
  const metaY = 96;
  const cols = [
    [lang === 'en' ? 'Prepared for' : 'Préparé pour', clientName],
    [lang === 'en' ? 'By' : 'Par', repName],
    ['Date', dateStr],
  ];
  let mx = padX;
  for (const [lab, val] of cols) {
    page.drawText(winAnsiSafe(lab), { x: mx, y: metaY + 14, size: 8.5, font: helv, color: greyD });
    page.drawText(winAnsiSafe(val || '-'), { x: mx, y: metaY, size: 12, font: helvB, color: white });
    mx += Math.max(150, helvB.widthOfTextAtSize(winAnsiSafe(val || '-'), 12) + 40);
  }

  // bottom stats band
  const bandH = 46;
  page.drawRectangle({ x: 0, y: 0, width: W, height: bandH, color: bandc });
  page.drawCircle({ x: padX + 6, y: bandH / 2, size: 6, color: orange });
  let bx = padX + 24;
  const stats = lang === 'en'
    ? [['3,800+', 'Merchants served'], ['5,500+', 'POS systems'], ['16+', 'Years of innovation']]
    : [['3 800+', 'Marchands servis'], ['5 500+', 'Systèmes PDV'], ['16+', "Ans d'innovation"]];
  for (const [n, l] of stats) {
    page.drawText(winAnsiSafe(n), { x: bx, y: bandH / 2 + 1, size: 13, font: helvB, color: white });
    page.drawText(winAnsiSafe(l), { x: bx, y: bandH / 2 - 12, size: 8, font: helv, color: greyD });
    bx += Math.max(120, helvB.widthOfTextAtSize(winAnsiSafe(n), 13) + 70);
  }
  page.drawText('clusterpos.com', { x: W - padX - 150, y: bandH / 2 - 3, size: 10, font: helvB, color: rgb(0xff / 255, 0xb3 / 255, 0x8f / 255) });
  page.drawText(lang === 'en' ? 'Confidential' : 'Confidentiel', { x: W - padX - 70, y: bandH / 2 - 3, size: 8, font: helv, color: greyD });
}


// Render the Claude Design proposal document (personalized) via the external Puppeteer service.
// Returns a PDF Buffer, or null if the service isn't configured / fails (caller falls back).
async function fetchRenderedPresentation(clientName, lang, logoDataUrl, pages) {
  const url = process.env.PROPOSAL_RENDER_URL;
  if (!url) return null;
  try {
    // POST (not GET) so a client-logo data URL fits in the body.
    const r = await axios.post(url, {
      clientName: clientName || '', lang, token: process.env.PROPOSAL_RENDER_TOKEN || '',
      logo: (typeof logoDataUrl === 'string' && logoDataUrl.startsWith('data:image')) ? logoDataUrl : undefined,
      pages: (Array.isArray(pages) && pages.length) ? pages : undefined, // design pages to keep (renumbered by the service)
    }, {
      responseType: 'arraybuffer', timeout: 90000, validateStatus: () => true,
    });
    if (r.status === 200 && r.data && r.data.byteLength > 1000) return Buffer.from(r.data);
    console.warn('[proposal] render service returned', r.status);
  } catch (e) { console.warn('[proposal] render service failed:', e.message); }
  return null;
}

// Merge: the proposal presentation + the Zoho estimate PDF → one PDF (Uint8Array).
// Presentation source, in order of preference: (1) the rendered Claude Design document from the
// Puppeteer service (PROPOSAL_RENDER_URL) — personalized + branded, REPLACES cover+deck;
// (2) generated pdf-lib cover + in-app custom deck; (3) cover + committed company_{lang}.pdf.
// Returns { bytes, presentationPageCount, estimatePageCount }.
// selectedPages: optional 1-based indices into the PRESENTATION to include (null/empty = all).
// includeEstimate: append the Zoho estimate PDF (default true).
async function buildProposalPdf({ estimateId, lang, clientName, repName, title, logoBytes, logoDataUrl, selectedPages, includeEstimate = true }) {
  const fs = require('fs');
  const { PDFDocument } = require('pdf-lib');
  const out = await PDFDocument.create();

  // (1) Build the presentation. When the render service is used it already drops the unselected
  // design pages AND renumbers the footers, so we must NOT re-filter it with pdf-lib afterwards.
  const wantPages = (Array.isArray(selectedPages) && selectedPages.length) ? selectedPages.map(Number).filter(n => n > 0) : undefined;
  let presDoc = null, fromService = false;
  const rendered = await fetchRenderedPresentation(clientName, lang, logoDataUrl, wantPages);
  if (rendered) {
    try { presDoc = await PDFDocument.load(rendered); fromService = true; }
    catch (e) { console.warn('[proposal] rendered presentation load failed, falling back:', e.message); }
  }
  if (!presDoc) {
    // Fallback (render service unavailable): pdf-lib cover + committed company deck.
    presDoc = await PDFDocument.create();
    const dateStr = new Date().toLocaleDateString(lang === 'en' ? 'en-CA' : 'fr-CA', { year: 'numeric', month: 'long', day: 'numeric' });
    const photoBytes = fs.readFileSync(require('path').join(PROPOSAL_ASSETS, 'product_shot.png'));
    let brandLogoBytes = null;
    try { brandLogoBytes = fs.readFileSync(require('path').join(PROPOSAL_ASSETS, 'cluster_logo.png')); } catch (_e) { /* optional */ }
    await addProposalCover(presDoc, { lang, clientName, repName, title, dateStr, photoBytes, logoBytes, brandLogoBytes });
    const compBytes = fs.readFileSync(require('path').join(PROPOSAL_ASSETS, lang === 'en' ? 'company_en.pdf' : 'company_fr.pdf'));
    const comp = await PDFDocument.load(compBytes);
    (await presDoc.copyPages(comp, comp.getPageIndices())).forEach(p => presDoc.addPage(p));
  }

  const presentationPageCount = presDoc.getPageCount();
  // The service already applied the page selection (+ renumbered). Only the pdf-lib fallback
  // needs to filter here (it can't renumber, but at least drops the unselected pages).
  let idxs = presDoc.getPageIndices();
  if (!fromService && wantPages) {
    const want = new Set(wantPages.map(n => n - 1));
    const filtered = idxs.filter(i => want.has(i));
    if (filtered.length) idxs = filtered;
  }
  (await out.copyPages(presDoc, idxs)).forEach(p => out.addPage(p));

  // (2) The Zoho estimate (best-effort), unless the rep excluded it.
  let estimatePageCount = 0;
  if (includeEstimate && estimateId) {
    const est = await fetchEstimatePdfBytes(estimateId);
    if (est && est.buffer) {
      try { const ed = await PDFDocument.load(est.buffer); estimatePageCount = ed.getPageCount(); (await out.copyPages(ed, ed.getPageIndices())).forEach(p => out.addPage(p)); }
      catch (e) { console.warn('[proposal] estimate PDF merge skipped:', e.message); }
    }
  }
  return { bytes: await out.save(), presentationPageCount, estimatePageCount };
}

// Customer name + email for an estimate (used to prefill the email draft).
async function getEstimateDetail(estimateId) {
  const { accessToken, apiDomain } = await getAdminBooksAuth();
  const r = await axios.get(`${apiDomain}/books/v3/estimates/${estimateId}`, {
    params: { organization_id: process.env.ZOHO_ORG_ID },
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` }, validateStatus: () => true,
  });
  if (r.status !== 200) return null;
  const e = r.data.estimate || {};
  let email = e.email || '';
  if (!email && Array.isArray(e.contact_persons)) { const cp = e.contact_persons.find(c => c.email); email = cp ? cp.email : ''; }
  // The estimate object rarely carries the email — fall back to the CUSTOMER (contact) record,
  // which holds the real billing email + its contact persons. This makes the prefill reliable.
  if (!email && e.customer_id) {
    try {
      const c = await axios.get(`${apiDomain}/books/v3/contacts/${e.customer_id}`, {
        params: { organization_id: process.env.ZOHO_ORG_ID },
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` }, validateStatus: () => true,
      });
      if (c.status === 200) {
        const ct = c.data.contact || {};
        email = ct.email || '';
        if (!email && Array.isArray(ct.contact_persons)) {
          const cp = ct.contact_persons.find(p => p.email) || ct.contact_persons.find(p => p.is_primary_contact && p.email);
          email = cp ? cp.email : '';
        }
      }
    } catch (err) { console.warn('[proposal] contact email lookup:', err.message); }
  }
  // Failover to the CRM: Books contacts are often created without an email, but the CRM
  // (Account → Contact) usually has it. Look it up by customer name.
  if (!email && e.customer_name) {
    email = (await findCrmEmailByName(e.customer_name)) || '';
  }
  return { customerName: e.customer_name || '', email, number: e.estimate_number || '', salesperson: e.salesperson_name || '' };
}

// Find a client email in Zoho CRM by customer name (Books → CRM failover). Tries the contact(s)
// linked to an Account of that name, then a full-text contact search, then the Account record.
async function findCrmEmailByName(name) {
  const q = String(name || '').trim();
  if (!q) return null;
  try {
    const crmToken = await ensureValidCrmToken();
    if (!crmToken) return null;
    const headers = { Authorization: `Zoho-oauthtoken ${crmToken}` };
    const enc = encodeURIComponent(q);
    const urls = [
      `https://www.zohoapis.com/crm/v2/Contacts/search?criteria=(Account_Name:equals:${enc})`,
      `https://www.zohoapis.com/crm/v2/Contacts/search?word=${enc}`,
      `https://www.zohoapis.com/crm/v2/Accounts/search?criteria=(Account_Name:equals:${enc})`,
    ];
    for (const url of urls) {
      const r = await axios.get(url, { headers, validateStatus: () => true });
      if (r.status !== 200) continue; // 204 = no match
      for (const rec of (r.data?.data || [])) {
        const em = rec.Email || rec.Secondary_Email || rec.email || null;
        if (em) return em;
      }
    }
  } catch (e) { console.warn('[proposal] CRM email lookup:', e.message); }
  return null;
}

// Ownership guard: non-admins (incl. impersonated reps) may only act on THEIR OWN estimates.
// Returns true if allowed, else sends a 403 and returns false. `det` = getEstimateDetail result.
async function assertEstimateOwnership(req, res, det) {
  let effAdmin = false;
  if (!req.user.impersonating && req.user.email) {
    const row = (await pool.query('SELECT is_admin FROM user_tokens WHERE email = $1', [req.user.email])).rows[0];
    effAdmin = row ? !!row.is_admin : false;
  }
  if (effAdmin) return true;
  const me = (req.user.name || '').trim().toLowerCase();
  const owner = (det?.salesperson || '').trim().toLowerCase();
  if (!me || owner !== me) { res.status(403).json({ error: 'not_your_estimate' }); return false; }
  return true;
}

// Mark an estimate "sent" in Zoho (activates client tracking + acceptance). Best-effort.
async function markEstimateSent(estimateId) {
  try {
    const { accessToken, apiDomain } = await getAdminBooksAuth();
    await axios.post(`${apiDomain}/books/v3/estimates/${estimateId}/status/sent`, null, {
      params: { organization_id: process.env.ZOHO_ORG_ID },
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` }, validateStatus: () => true,
    });
  } catch (e) { console.warn('[proposal] markSent:', e.message); }
}

// Best-effort accept/portal URL for an estimate. Zoho doesn't document a single field, so we scan
// the estimate detail for a url-ish field, then the composed email content for a books.zoho link.
async function getEstimateAcceptUrl(estimateId) {
  try {
    const { accessToken, apiDomain } = await getAdminBooksAuth();
    const headers = { Authorization: `Zoho-oauthtoken ${accessToken}` };
    const params = { organization_id: process.env.ZOHO_ORG_ID };
    const det = await axios.get(`${apiDomain}/books/v3/estimates/${estimateId}`, { params, headers, validateStatus: () => true });
    const e = det.status === 200 ? (det.data.estimate || {}) : {};
    for (const k of Object.keys(e)) {
      if (/url|link/i.test(k) && typeof e[k] === 'string' && /^https?:\/\//.test(e[k])) return e[k];
    }
    const em = await axios.get(`${apiDomain}/books/v3/estimates/${estimateId}/email`, { params, headers, validateStatus: () => true });
    const blob = JSON.stringify(em.data || '');
    const m = blob.match(/https:\\?\/\\?\/[^"'\\ ]*(?:accept|secure|portal|ShowEstimate|estimates)[^"'\\ ]*/i);
    if (m) return m[0].replace(/\\\//g, '/');
  } catch (e) { console.warn('[proposal] acceptUrl:', e.message); }
  return null;
}

// Live status of an estimate for the sent-proposals board.
async function getEstimateStatus(estimateId) {
  try {
    const { accessToken, apiDomain } = await getAdminBooksAuth();
    const r = await axios.get(`${apiDomain}/books/v3/estimates/${estimateId}`, {
      params: { organization_id: process.env.ZOHO_ORG_ID },
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` }, validateStatus: () => true,
    });
    if (r.status !== 200) return null;
    const e = r.data.estimate || {};
    return {
      status: e.status || '', viewed: !!e.is_viewed_by_client, viewedTime: e.client_viewed_time || '',
      acceptedDate: e.accepted_date || '', declinedDate: e.declined_date || '', total: e.total, currency: e.currency_code,
    };
  } catch { return null; }
}

const proposalFileName = (clientName) => `Proposition_ClusterPOS_${String(clientName || 'client').replace(/[^a-z0-9]+/gi, '_').slice(0, 40)}.pdf`;
const logoFromBody = (b) => (b ? Buffer.from(String(b).replace(/^data:[^,]+,/, ''), 'base64') : null);

// GET /api/admin/proposal-email-debug?secret=[&estimateId=]  — diagnose client-email prefill.
// No id → list a few recent estimates (id/number/customer). With id → run getEstimateDetail +
// report the raw contacts-call HTTP status (401 = missing ZohoBooks.contacts.READ scope).
app.get('/api/admin/proposal-email-debug', async (req, res) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (!process.env.ZOHO_WEBHOOK_SECRET || provided !== process.env.ZOHO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid secret' });
  }
  try {
    // Direct CRM-failover test: ?crmName=Benedetta → what email the CRM lookup returns.
    const crmName = String(req.query.crmName || '').trim();
    if (crmName) return res.json({ crmName, crmEmail: await findCrmEmailByName(crmName) });
    const { accessToken, apiDomain } = await getAdminBooksAuth();
    const headers = { Authorization: `Zoho-oauthtoken ${accessToken}` };
    const params = { organization_id: process.env.ZOHO_ORG_ID };
    const eid = String(req.query.estimateId || '').trim();
    if (!eid) {
      const r = await axios.get(`${apiDomain}/books/v3/estimates`, { params: { ...params, per_page: 5 }, headers, validateStatus: () => true });
      return res.json({ status: r.status, estimates: (r.data.estimates || []).map(e => ({ id: e.estimate_id, number: e.estimate_number, customer: e.customer_name })) });
    }
    const det = await getEstimateDetail(eid);
    const e = ((await axios.get(`${apiDomain}/books/v3/estimates/${eid}`, { params, headers, validateStatus: () => true })).data || {}).estimate || {};
    let contactCallStatus = null, contactEmail = null, contactErr = null;
    if (e.customer_id) {
      const c = await axios.get(`${apiDomain}/books/v3/contacts/${e.customer_id}`, { params, headers, validateStatus: () => true });
      contactCallStatus = c.status;
      if (c.status === 200) {
        const ct = c.data.contact || {};
        contactEmail = ct.email || ((ct.contact_persons || []).find(p => p.email) || {}).email || null;
      } else { contactErr = c.data?.message || null; }
    }
    res.json({ resolvedEmail: det?.email || '', estimateEmail: e.email || '', customer_id: e.customer_id || null, contactCallStatus, contactEmail, contactErr });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/mail-test?secret=[&to=]  — diagnose SMTP/SendGrid: config presence, a live
// transporter.verify() (auth check), and an optional real send to `to`.
app.get('/api/admin/mail-test', async (req, res) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (!process.env.ZOHO_WEBHOOK_SECRET || provided !== process.env.ZOHO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid secret' });
  }
  const cfg = {
    host: process.env.SMTP_HOST || null, port: process.env.SMTP_PORT || null,
    user: process.env.SMTP_USER ? '(set)' : null, pass: process.env.SMTP_PASS ? '(set)' : null,
    from: process.env.SMTP_FROM || null,
  };
  const t = getMailer();
  if (!t) return res.json({ configured: false, cfg });
  let verify = null;
  try { await t.verify(); verify = 'ok'; } catch (e) { verify = e.message; }
  // Show the verified-sender-domain config + what From a proposal would use for ?repEmail=.
  const verifiedDomains = (process.env.VERIFIED_SENDER_DOMAINS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  const repEmail = String(req.query.repEmail || '').trim();
  let proposalFromForRep = null;
  if (repEmail) {
    const repDomain = repEmail.includes('@') ? repEmail.split('@')[1].toLowerCase() : '';
    proposalFromForRep = (repEmail && verifiedDomains.includes(repDomain)) ? repEmail : (process.env.SMTP_FROM || process.env.SMTP_USER);
  }
  const to = String(req.query.to || '').trim();
  let send = null;
  if (to) send = await sendMail(to, 'Sales Hub — test SMTP', '<p>Test SMTP depuis Railway. Si tu reçois ceci, l\'envoi fonctionne. ✅</p>');
  res.json({ configured: true, cfg, verify, verifiedDomains, proposalFromForRep, sentTo: to || null, send });
});

// POST /api/proposals/prepare — build the merged PDF + a prefilled email draft (rep reviews before sending).
app.post('/api/proposals/prepare', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'proposals:send'))) return;
  const lang = String(req.body.lang || 'fr').toLowerCase() === 'en' ? 'en' : 'fr';
  const estimateId = String(req.body.estimateId || '').trim();
  const title = String(req.body.title || '').trim();
  if (!estimateId) return res.status(400).json({ error: 'estimateId required' });
  try {
    const det = await getEstimateDetail(estimateId);
    if (!(await assertEstimateOwnership(req, res, det))) return;
    const clientName = (req.body.clientName || '').trim() || (det && det.customerName) || (lang === 'en' ? 'your business' : 'votre entreprise');
    const repName = req.user.name || req.user.email || '';
    const selectedPages = Array.isArray(req.body.selectedPages) ? req.body.selectedPages.map(Number).filter(Boolean) : null;
    const includeEstimate = req.body.includeEstimate !== false;
    const built = await buildProposalPdf({ estimateId, lang, clientName, repName, title, logoBytes: logoFromBody(req.body.logoBase64), logoDataUrl: req.body.logoBase64, selectedPages, includeEstimate });
    const subject = lang === 'en' ? `Cluster POS proposal — ${clientName}` : `Proposition Cluster POS — ${clientName}`;
    const body = lang === 'en'
      ? `Hello,\n\nThank you for your interest in Cluster POS. Please find attached our proposal prepared for ${clientName}, including your quote.\n\nI'd be glad to walk you through it — just reply to this email.\n\nBest regards,\n${repName}\nCluster Systems`
      : `Bonjour,\n\nMerci de votre intérêt envers Cluster POS. Vous trouverez ci-joint notre proposition préparée pour ${clientName}, incluant votre soumission.\n\nJe me ferai un plaisir de vous la présenter — répondez simplement à ce courriel.\n\nCordialement,\n${repName}\nCluster Systems`;
    res.json({
      pdfBase64: Buffer.from(built.bytes).toString('base64'), fileName: proposalFileName(clientName),
      presentationPageCount: built.presentationPageCount, estimatePageCount: built.estimatePageCount,
      email: { to: (det && det.email) || '', subject, body },
    });
  } catch (e) { console.warn('[proposal/prepare]', e.message); res.status(500).json({ error: e.message }); }
});

// POST /api/proposals/send — rebuild + email the proposal to the client (rep-reviewed fields).
app.post('/api/proposals/send', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'proposals:send'))) return;
  const lang = String(req.body.lang || 'fr').toLowerCase() === 'en' ? 'en' : 'fr';
  const estimateId = String(req.body.estimateId || '').trim();
  const title = String(req.body.title || '').trim();
  const to = String(req.body.to || '').trim();
  const subject = String(req.body.subject || '').trim();
  const bodyText = String(req.body.body || '');
  if (!estimateId || !to || !subject) return res.status(400).json({ error: 'estimateId, to and subject are required' });
  try {
    const det = await getEstimateDetail(estimateId);
    if (!(await assertEstimateOwnership(req, res, det))) return;
    const clientName = (req.body.clientName || '').trim() || (det && det.customerName) || '';
    const repName = req.user.name || req.user.email || '';
    const selectedPages = Array.isArray(req.body.selectedPages) ? req.body.selectedPages.map(Number).filter(Boolean) : null;
    const includeEstimate = req.body.includeEstimate !== false;
    const built = await buildProposalPdf({ estimateId, lang, clientName, repName, title, logoBytes: logoFromBody(req.body.logoBase64), logoDataUrl: req.body.logoBase64, selectedPages, includeEstimate });
    const pdf = built.bytes;
    // Mark the estimate "sent" in Zoho (enables client acceptance + viewed/accepted tracking),
    // then try to surface its accept link to add as a button in our email.
    await markEstimateSent(estimateId);
    const acceptUrl = await getEstimateAcceptUrl(estimateId);
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // A unique token per send drives both the open pixel and the accept-link click redirect.
    const trackToken = require('crypto').randomUUID().replace(/-/g, '');
    const apiBase = process.env.PUBLIC_API_URL || `https://${req.get('host')}`;
    // Route the accept button through our backend so every click is logged (reliable repeat
    // counting), then 302s to the Zoho accept URL stored against this send.
    const acceptBtn = acceptUrl
      ? `<div style="margin:22px 0"><a href="${apiBase}/api/proposals/click/${trackToken}" style="display:inline-block;background:#fe6523;color:#fff;text-decoration:none;font-weight:700;font-family:Arial,Helvetica,sans-serif;font-size:14px;padding:13px 26px;border-radius:8px">${lang === 'en' ? 'Review & accept the quote online →' : 'Voir et accepter le devis en ligne →'}</a></div>`
      : '';
    // Open-tracking pixel: the /track endpoint logs the open when the client's mail client loads
    // this 1×1 image. (Imperfect — Gmail/Outlook proxy-cache images, so opens under-count.)
    const pixel = `<img src="${apiBase}/api/proposals/track/${trackToken}.gif" width="1" height="1" alt="" style="display:none;width:1px;height:1px;border:0;max-height:0;overflow:hidden">`;
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1c2434;line-height:1.5"><div style="white-space:pre-wrap">${esc(bodyText)}</div>${acceptBtn}</div>${pixel}`;

    // From: send AS the Sales Hub rep when their email domain is SendGrid-authenticated
    // (env VERIFIED_SENDER_DOMAINS, comma-list). Until the domain is verified, keep the verified
    // saleshub@ address but show the rep's NAME and set Reply-To = rep so replies reach them.
    const repEmail = (req.user.email || '').trim();
    const verifiedDomains = (process.env.VERIFIED_SENDER_DOMAINS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
    const repDomain = repEmail.includes('@') ? repEmail.split('@')[1].toLowerCase() : '';
    const fromAddr = (repEmail && verifiedDomains.includes(repDomain)) ? repEmail : (process.env.SMTP_FROM || process.env.SMTP_USER);
    const r = await sendMail(to, subject, html, {
      from: { name: repName || 'Cluster Systems', address: fromAddr },
      replyTo: repEmail || undefined,
      cc: req.body.cc ? String(req.body.cc).trim() : undefined,
      attachments: [{ filename: proposalFileName(clientName), content: Buffer.from(pdf), contentType: 'application/pdf' }],
    });
    if (!r.sent) return res.status(502).json({ error: r.reason === 'smtp_not_configured' ? 'smtp_not_configured' : 'mail_failed', reason: r.reason });
    // Record the send for the status board (best-effort).
    try {
      await pool.query(
        `INSERT INTO proposals_sent (estimate_id, estimate_number, customer_name, rep_email, to_email, lang, track_token, accept_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [estimateId, (det && det.number) || '', clientName, (req.user.realAdminEmail || req.user.email || ''), to, lang, trackToken, acceptUrl || null]);
    } catch (e) { console.warn('[proposal/send] record:', e.message); }
    res.json({ success: true, acceptLinkIncluded: !!acceptUrl, sentFrom: fromAddr });
  } catch (e) { console.warn('[proposal/send]', e.message); res.status(500).json({ error: e.message }); }
});

// GET /api/proposals/track/:token(.gif) — email open-tracking pixel. NO auth (the client's mail
// client loads it). Logs the open against proposals_sent and returns a 1×1 transparent GIF.
const TRACK_PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
app.get('/api/proposals/track/:token', (req, res) => {
  const token = String(req.params.token || '').replace(/\.gif$/i, '');
  if (token) {
    pool.query(
      `UPDATE proposals_sent SET opened_at = COALESCE(opened_at, NOW()), open_count = COALESCE(open_count,0) + 1 WHERE track_token = $1`,
      [token]
    ).catch(() => { /* never fail the pixel */ });
  }
  res.set('Content-Type', 'image/gif');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.end(TRACK_PIXEL);
});

// GET /api/proposals/click/:token — accept-link click tracking. Logs the click (count + first/
// last timestamps), then 302s to the stored Zoho accept URL. NO auth (the client clicks from
// their email). Reliable repeat counting — unlike the open pixel, links aren't proxy-cached.
app.get('/api/proposals/click/:token', async (req, res) => {
  const token = String(req.params.token || '');
  let url = '';
  try {
    const r = await pool.query(
      `UPDATE proposals_sent SET click_count = COALESCE(click_count,0) + 1,
              first_click_at = COALESCE(first_click_at, NOW()), last_click_at = NOW()
       WHERE track_token = $1 RETURNING accept_url`,
      [token]
    );
    url = r.rows[0]?.accept_url || '';
  } catch (e) { /* never block the redirect */ }
  res.redirect(302, url || (process.env.FRONTEND_URL || 'https://saleshub.clusterpos.com'));
});

// GET /api/proposals/sent — status board: proposals this user (or all, for admins) has sent,
// enriched with the live Zoho estimate status (sent / viewed / accepted / declined).
app.get('/api/proposals/sent', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'proposals:send'))) return;
  try {
    let effAdmin = false;
    if (!req.user.impersonating && req.user.email) {
      const row = (await pool.query('SELECT is_admin FROM user_tokens WHERE email = $1', [req.user.email])).rows[0];
      effAdmin = row ? !!row.is_admin : false;
    }
    const me = (req.user.realAdminEmail || req.user.email || '').toLowerCase();
    const rows = effAdmin
      ? (await pool.query(`SELECT * FROM proposals_sent ORDER BY sent_at DESC LIMIT 100`)).rows
      : (await pool.query(`SELECT * FROM proposals_sent WHERE LOWER(rep_email) = $1 ORDER BY sent_at DESC LIMIT 100`, [me])).rows;
    const out = [];
    for (const r0 of rows.slice(0, 40)) {
      const st = await getEstimateStatus(r0.estimate_id);
      out.push({
        id: r0.id, estimateId: r0.estimate_id, number: r0.estimate_number, customerName: r0.customer_name,
        repEmail: r0.rep_email, toEmail: r0.to_email, sentAt: r0.sent_at,
        status: (st && st.status) || '', viewed: (st && st.viewed) || false, viewedTime: (st && st.viewedTime) || '',
        acceptedDate: (st && st.acceptedDate) || '', declinedDate: (st && st.declinedDate) || '',
        emailOpened: !!r0.opened_at, emailOpenedAt: r0.opened_at || '', emailOpenCount: r0.open_count || 0,
        linkClickCount: r0.click_count || 0, linkFirstClickAt: r0.first_click_at || '', linkLastClickAt: r0.last_click_at || '',
      });
    }
    res.json({ proposals: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/proposals/sent/:id — remove a sent-proposal record from the board. ADMIN ONLY.
// (Only deletes our tracking record; does not touch the Zoho estimate.)
app.delete('/api/proposals/sent/:id', authenticateToken, async (req, res) => {
  let effAdmin = false;
  if (!req.user.impersonating && req.user.email) {
    const row = (await pool.query('SELECT is_admin FROM user_tokens WHERE email = $1', [req.user.email])).rows[0];
    effAdmin = row ? !!row.is_admin : false;
  }
  if (!effAdmin) return res.status(403).json({ error: 'Admin required' });
  try {
    await pool.query('DELETE FROM proposals_sent WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// GET /api/invoices/:invoiceNumber/pdf — download
app.get('/api/invoices/:invoiceNumber/pdf', authenticateToken, async (req, res) => {
  try {
    const result = await fetchInvoicePdfBytes(req.params.invoiceNumber);
    if (result.error) return res.status(result.status).json({ error: result.error, details: result.body });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.invoiceNumber}.pdf"`);
    return res.send(result.buffer);
  } catch (e) {
    console.error('Invoice PDF error:', e.message);
    return res.status(500).json({ error: 'Failed to fetch invoice PDF', details: e.message });
  }
});

// GET /api/invoices/:invoiceNumber/preview?token=... — inline render for iframe
app.get('/api/invoices/:invoiceNumber/preview', async (req, res) => {
  // iframes can't set Authorization headers, so we accept the JWT via query string
  const token = req.query.token;
  if (!token) return res.status(401).send('Missing token');
  try {
    jwt.verify(String(token), JWT_SECRET);
  } catch {
    return res.status(401).send('Invalid token');
  }
  try {
    const result = await fetchInvoicePdfBytes(req.params.invoiceNumber);
    if (result.error === 'not_found') {
      return res.status(404).send(`<html><body style="font-family:sans-serif;padding:2rem;color:#333"><h3>Invoice ${req.params.invoiceNumber} not found in Zoho Books</h3><p>This invoice exists in our local database but Zoho Books couldn't find it when we searched by its number. Possible causes:</p><ul><li>The invoice was deleted from Zoho Books after we synced it</li><li>The invoice number has changed in Zoho</li><li>The Zoho admin account no longer has access to this organization</li></ul></body></html>`);
    }
    if (result.error) {
      return res.status(result.status).send(`<html><body style="font-family:sans-serif;padding:2rem;color:#333"><h3>Could not fetch this invoice from Zoho Books</h3><pre style="font-size:11px;color:#888;white-space:pre-wrap">${result.body || ''}</pre></body></html>`);
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${req.params.invoiceNumber}.pdf"`);
    return res.send(result.buffer);
  } catch (e) {
    console.error('Invoice preview error:', e.message);
    return res.status(500).send(`<html><body style="font-family:sans-serif;padding:2rem"><p>Error loading preview: ${e.message}</p></body></html>`);
  }
});

// ============================================================================
// REAL-TIME INVOICE SYNC — webhook + 5-min delta poll + 1h full reconcile
// ============================================================================
// Architecture:
//   - Webhook (POST /api/webhooks/zoho-books/invoice): Zoho Books calls us on
//     every invoice event. We fetch the full invoice and upsert immediately.
//   - Delta poll (every 5 min): safety net — fetches invoices modified since
//     the last delta sync. Catches anything the webhook missed.
//   - Full sync (every 1h): re-fetches everything to handle status changes we
//     don't get webhooks for + detects deleted invoices (reconciliation).
// ============================================================================

// Upsert a single invoice row from a Zoho payload — shared between webhook and
// delta poll so behaviour stays identical.
async function upsertInvoiceFromZoho(inv) {
  const salesperson  = inv.salesperson_name || 'Unassigned';
  const customerName = inv.customer_name || inv.contact_name || null;
  const total        = parseFloat(inv.total) || 0;
  const status       = inv.status || 'paid';
  // recalc-v2 is the SOLE authority on `commission`. Sync must NOT write a flat 10% here —
  // doing so clobbered recalc-v2's per-model values (first-month 100%, renewals 0%, etc.)
  // on every 5-min delta poll / webhook. New rows start at 0; recalc-v2 fills the real value.
  const commission   = 0;
  const invDate      = new Date(inv.date || new Date());
  await pool.query(
    `INSERT INTO invoices
       (invoice_number, salesperson_name, customer_name, total, status, date, commission, organization_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (invoice_number) DO UPDATE SET
       salesperson_name = $2,
       customer_name    = COALESCE($3, invoices.customer_name),
       total            = $4,
       status           = $5,
       date             = $6,
       updated_at       = CURRENT_TIMESTAMP`,
    [inv.invoice_number, salesperson, customerName, total, status, invDate, commission, process.env.ZOHO_ORG_ID]
  );
}

// POST /api/webhooks/zoho-books/invoice
// Zoho Books → workflow webhook → us. Configure in Zoho Books:
//   Settings → Automation → Workflow Rules → Create rule (entity: Invoice,
//   trigger: Created/Edited/Deleted/Status Change) → Action: Webhook.
//   URL: https://<our-host>/api/webhooks/zoho-books/invoice?secret=<env>
//   Body (raw JSON):
//     {"invoice_number": "${invoice_number}", "event": "updated"}
// Note: we deliberately re-fetch the full invoice from Zoho rather than trust
// the webhook body — keeps our logic robust if Zoho changes payload format.
app.post('/api/webhooks/zoho-books/invoice', async (req, res) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  const expected = process.env.ZOHO_WEBHOOK_SECRET;
  // Log every call (even rejected ones) — gives us a trail of who fired what,
  // including the User-Agent and source IP so we can tell Zoho's calls apart
  // from curl/manual tests.
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 500);
  const sourceIp  = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 64);
  const logAttempt = async (action, result) => {
    try {
      await pool.query(
        `INSERT INTO webhook_log (endpoint, invoice_number, event, action, result, user_agent, source_ip, body)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        ['/api/webhooks/zoho-books/invoice',
          req.body?.invoice_number || req.body?.InvoiceNumber || req.body?.invoiceNumber || null,
          req.body?.event || null,
          action, result, userAgent, sourceIp,
          JSON.stringify(req.body || {})]
      );
    } catch (_e) { /* don't fail the request just because logging failed */ }
  };

  if (!expected) {
    await logAttempt(null, 'not_configured');
    return res.status(503).json({ error: 'webhook not configured (ZOHO_WEBHOOK_SECRET unset)' });
  }
  if (provided !== expected) {
    await logAttempt(null, 'bad_secret');
    console.warn('🚫 Webhook rejected — bad secret', { providedLen: (provided || '').length });
    return res.status(401).json({ error: 'invalid secret' });
  }

  const invoiceNumber = req.body?.invoice_number || req.body?.InvoiceNumber || req.body?.invoiceNumber;
  const event = (req.body?.event || 'updated').toLowerCase();
  const debug = req.query.debug === '1';
  if (!invoiceNumber) {
    await logAttempt(event, 'missing_invoice_number');
    return res.status(400).json({ error: 'missing invoice_number in payload' });
  }

  try {
    if (event === 'deleted' || event === 'delete') {
      const r = await pool.query(
        `UPDATE invoices SET status = 'deleted', commission = 0, updated_at = CURRENT_TIMESTAMP
         WHERE invoice_number = $1 AND organization_id = $2 RETURNING invoice_number`,
        [invoiceNumber, process.env.ZOHO_ORG_ID]
      );
      console.log(`🔔 Webhook: ${invoiceNumber} deleted (${r.rowCount} row affected)`);
      await logAttempt(event, 'deleted');
      return res.json({ ok: true, action: 'deleted', invoice: invoiceNumber });
    }

    // For any other event (created / updated / status_change / payment_made / void),
    // fetch the full invoice from Zoho Books and upsert.
    const { accessToken, apiDomain } = await getAdminBooksAuth();

    // Debug mode — dump the raw Zoho search response so we can see what's happening
    if (debug) {
      // Try 3 different query shapes side-by-side to isolate the issue.
      const calls = [
        { label: 'autoSync-style (status=paid)', params: { organization_id: process.env.ZOHO_ORG_ID, status: 'paid', per_page: 5 } },
        { label: 'search_text',                  params: { organization_id: process.env.ZOHO_ORG_ID, search_text: invoiceNumber, per_page: 50 } },
        { label: 'invoice_number filter',        params: { organization_id: process.env.ZOHO_ORG_ID, invoice_number: invoiceNumber, per_page: 50 } },
      ];
      const results = [];
      for (const c of calls) {
        const dbg = await axios.get(`${apiDomain}/books/v3/invoices`, {
          params: c.params,
          headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
          validateStatus: () => true,
        });
        results.push({
          label: c.label,
          http: dbg.status,
          returned: dbg.data?.invoices?.length || 0,
          first_few_invoice_numbers: (dbg.data?.invoices || []).slice(0, 3).map(i => i.invoice_number),
          error_body: dbg.status !== 200 ? (typeof dbg.data === 'string' ? dbg.data.slice(0, 300) : JSON.stringify(dbg.data).slice(0, 300)) : null,
        });
      }
      return res.json({
        debug: true,
        searched_for: invoiceNumber,
        api_domain: apiDomain,
        org_id_in_use: process.env.ZOHO_ORG_ID,
        access_token_tail: (accessToken || '').slice(-8),
        results,
      });
    }

    const zohoId = await resolveInvoiceIdViaZoho(invoiceNumber, accessToken, apiDomain);
    if (!zohoId) {
      // Invoice exists in webhook but not searchable in Zoho — odd, but log & ack.
      console.warn(`🔔 Webhook: ${invoiceNumber} not found in Zoho — ignoring`);
      await logAttempt(event, 'skipped_not_found');
      return res.json({ ok: true, action: 'skipped', reason: 'not_found_in_zoho' });
    }
    const r = await axios.get(`${apiDomain}/books/v3/invoices/${zohoId}`, {
      params: { organization_id: process.env.ZOHO_ORG_ID },
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
      validateStatus: () => true,
    });
    if (r.status !== 200) {
      console.warn(`🔔 Webhook fetch ${invoiceNumber} → HTTP ${r.status}`);
      return res.status(502).json({ error: 'failed to fetch invoice from zoho', zohoStatus: r.status });
    }
    await upsertInvoiceFromZoho(r.data.invoice);
    console.log(`🔔 Webhook: ${invoiceNumber} ${event} → upserted`);
    await logAttempt(event, 'upserted');
    return res.json({ ok: true, action: 'upserted', invoice: invoiceNumber });
  } catch (e) {
    console.error('Webhook error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/db-stats?secret=<shared>
// Returns row counts per table + invoice breakdown by status. Gated by the
// same shared secret as the webhook so we don't need a JWT to query it.
// GET /api/admin/unassigned-invoices?secret=<shared>
// Full dump of every "Unassigned" earned-commission invoice (no salesperson on the Zoho
// invoice), with a SUGGESTED rep where the customer name matches a Zentact merchant that
// has one. Working list for fixing attribution IN ZOHO (sync overwrites local edits).
app.get('/api/admin/unassigned-invoices', async (req, res) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (!process.env.ZOHO_WEBHOOK_SECRET || provided !== process.env.ZOHO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid secret' });
  }
  try {
    const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const [invRes, sameCustRes, crmRes, zenRes] = await Promise.all([
      pool.query(
        `SELECT invoice_number, date::date AS invoice_date, customer_name,
                total::float AS total, commission::float AS commission,
                commission_status, status, approval_status
         FROM invoices
         WHERE salesperson_name = 'Unassigned' AND commission > 0
         ORDER BY commission DESC`
      ),
      // Strongest signal: the SAME customer's other invoices that DO have a salesperson.
      pool.query(
        `SELECT customer_name, salesperson_name, COUNT(*)::int AS cnt
         FROM invoices
         WHERE salesperson_name <> 'Unassigned' AND salesperson_name IS NOT NULL
           AND customer_name IN (SELECT DISTINCT customer_name FROM invoices
                                 WHERE salesperson_name = 'Unassigned' AND commission > 0)
         GROUP BY 1, 2`
      ),
      pool.query(
        `SELECT deal_name, account_name, owner_name FROM crm_sold_deals
         WHERE owner_name IS NOT NULL AND owner_name <> ''`
      ),
      pool.query(
        `SELECT business_name, sales_rep_name FROM zentact_merchants
         WHERE business_name IS NOT NULL AND business_name <> ''
           AND sales_rep_name IS NOT NULL AND sales_rep_name <> ''`
      ),
    ]);

    // customer_name → most-frequent rep among their assigned invoices
    const sameCust = new Map();
    for (const r of sameCustRes.rows) {
      const cur = sameCust.get(r.customer_name);
      if (!cur || r.cnt > cur.cnt) sameCust.set(r.customer_name, { rep: r.salesperson_name, cnt: r.cnt });
    }
    // normalized CRM account/deal name → owner
    const crmMap = new Map();
    for (const d of crmRes.rows) {
      for (const n of [d.account_name, d.deal_name]) {
        const k = norm(n);
        if (k && !crmMap.has(k)) crmMap.set(k, d.owner_name);
      }
    }
    const zenMap = new Map();
    for (const m of zenRes.rows) {
      const k = norm(m.business_name);
      if (k && !zenMap.has(k)) zenMap.set(k, m.sales_rep_name);
    }
    // Substring fallback (either direction), min 6 chars to avoid junk matches.
    const crmList = [...crmMap.entries()].filter(([k]) => k.length >= 6);
    const zenList = [...zenMap.entries()].filter(([k]) => k.length >= 6);
    const fuzzy = (k, list) => {
      if (k.length < 6) return null;
      for (const [n, rep] of list) {
        if (n.includes(k) || k.includes(n)) return rep;
      }
      return null;
    };

    const rows = invRes.rows.map(r => {
      const k = norm(r.customer_name);
      let suggested_rep = null, suggestion_source = null;
      const sc = sameCust.get(r.customer_name);
      if (sc) { suggested_rep = sc.rep; suggestion_source = 'autres factures du client'; }
      else if (crmMap.has(k)) { suggested_rep = crmMap.get(k); suggestion_source = 'deal CRM'; }
      else if (zenMap.has(k)) { suggested_rep = zenMap.get(k); suggestion_source = 'Zentact'; }
      else {
        const f = fuzzy(k, crmList);
        if (f) { suggested_rep = f; suggestion_source = 'deal CRM (partiel)'; }
        else {
          const z = fuzzy(k, zenList);
          if (z) { suggested_rep = z; suggestion_source = 'Zentact (partiel)'; }
        }
      }
      return { ...r, suggested_rep, suggestion_source };
    });

    res.json({ count: rows.length, total_commission: rows.reduce((a, r) => a + (r.commission || 0), 0), rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/rep-customers?secret=<shared>&rep=<name-or-part>&from=YYYY-MM-DD&to=YYYY-MM-DD
// Distinct customers (accounts) on a rep's commission invoices, with activity stats and
// whether the account was a NEW activation (has a saas_first invoice) in the window.
app.get('/api/admin/rep-customers', async (req, res) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (!process.env.ZOHO_WEBHOOK_SECRET || provided !== process.env.ZOHO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid secret' });
  }
  const rep = String(req.query.rep || '').trim();
  if (!rep) return res.status(400).json({ error: 'rep required' });
  const from = req.query.from || '2025-01-01';
  const to = req.query.to || '2099-01-01';
  try {
    const reps = (await pool.query(
      `SELECT DISTINCT salesperson_name FROM invoices
       WHERE LOWER(salesperson_name) LIKE '%' || LOWER($1) || '%'`, [rep]
    )).rows.map(r => r.salesperson_name);
    const rows = (await pool.query(
      `SELECT customer_name,
              COUNT(*)::int AS invoices,
              MIN(date)::date AS first_invoice,
              MAX(date)::date AS last_invoice,
              COALESCE(SUM(total), 0)::float AS revenue,
              COALESCE(SUM(commission), 0)::float AS commission,
              BOOL_OR(commission_status = 'saas_first') AS new_activation,
              MIN(date) FILTER (WHERE commission_status = 'saas_first')::date AS activation_date
       FROM invoices
       WHERE LOWER(salesperson_name) LIKE '%' || LOWER($1) || '%'
         AND organization_id = $2
         AND date >= $3::date AND date < $4::date
       GROUP BY customer_name
       ORDER BY MIN(date)`,
      [rep, process.env.ZOHO_ORG_ID, from, to]
    )).rows;
    res.json({ matched_reps: reps, count: rows.length, rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/invoice-lookup?secret=<shared>&numbers=INV-1,INV-2
// Debug helper: full commission-relevant state for specific invoices.
app.get('/api/admin/invoice-lookup', async (req, res) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (!process.env.ZOHO_WEBHOOK_SECRET || provided !== process.env.ZOHO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid secret' });
  }
  const numbers = String(req.query.numbers || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!numbers.length) return res.status(400).json({ error: 'numbers required (comma-separated)' });
  try {
    const rows = (await pool.query(
      `SELECT invoice_number, salesperson_name, date::date AS date, paid_date::date AS paid_date,
              status, approval_status, commission::float AS commission, commission_status,
              commission_payable_date::date AS commission_payable_date,
              total::float AS total, saas_amount::float AS saas_amount, hardware_amount::float AS hardware_amount,
              sub_total::float AS sub_total, discount_total::float AS discount_total,
              gross_line_total::float AS gross_line_total,
              subscription_activation_date::date AS subscription_activation_date, line_items
       FROM invoices WHERE invoice_number = ANY($1)`,
      [numbers]
    )).rows;
    const found = new Set(rows.map(r => r.invoice_number));
    res.json({ rows, not_in_db: numbers.filter(n => !found.has(n)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/annual-audit?secret=  — every saas_annual invoice still paying 10%, flagged
// with whether the customer had an EARLIER SaaS invoice (had_prior_saas=true ⇒ should be 0%).
app.get('/api/admin/annual-audit', async (req, res) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (!process.env.ZOHO_WEBHOOK_SECRET || provided !== process.env.ZOHO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid secret' });
  }
  try {
    const rows = (await pool.query(
      `WITH first_saas AS (
         SELECT i.customer_name, MIN(i.date) AS first_date
         FROM invoices i CROSS JOIN LATERAL jsonb_array_elements(i.line_items) li
         WHERE i.organization_id = $1 AND i.line_items IS NOT NULL AND i.status NOT IN ('void','deleted')
           AND li->>'type' = 'saas'
         GROUP BY i.customer_name
       )
       SELECT inv.invoice_number, inv.customer_name, inv.date::date AS date, inv.commission::float AS commission,
              inv.subscription_activation_date::date AS sub_activation, fs.first_date::date AS first_saas,
              (fs.first_date < inv.date) AS had_prior_saas
       FROM invoices inv JOIN first_saas fs ON fs.customer_name = inv.customer_name
       WHERE inv.organization_id = $1 AND inv.commission_status = 'saas_annual' AND inv.commission > 0
       ORDER BY had_prior_saas DESC, inv.commission DESC`,
      [process.env.ZOHO_ORG_ID]
    )).rows;
    const leaks = rows.filter(r => r.had_prior_saas);
    res.json({
      total_paying_annual: rows.length,
      total_amount: Math.round(rows.reduce((s, r) => s + r.commission, 0) * 100) / 100,
      potential_leaks: leaks.length,
      leaks,
      all: rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/customer-invoices?secret=&q=<name>  — all invoices for customers matching q,
// oldest first, with annual-plan line names. Used to check whether an "annual sub (10%)" is a
// genuine first occurrence or a renewal that should be 0%.
app.get('/api/admin/customer-invoices', async (req, res) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (!process.env.ZOHO_WEBHOOK_SECRET || provided !== process.env.ZOHO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid secret' });
  }
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q (customer name) required' });
  try {
    const rows = (await pool.query(
      `SELECT invoice_number, customer_name, salesperson_name, date::date AS date,
              status, approval_status, commission::float AS commission, commission_status,
              subscription_activation_date::date AS sub_activation,
              (SELECT string_agg(li->>'name', ' | ') FROM jsonb_array_elements(line_items) li
                WHERE li->>'name' ~* 'year|annual|annuel') AS annual_lines
       FROM invoices WHERE organization_id = $1 AND customer_name ILIKE '%' || $2 || '%'
       ORDER BY customer_name, date`,
      [process.env.ZOHO_ORG_ID, q]
    )).rows;
    res.json({ count: rows.length, rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/backfill-subtotals?secret=<shared>&from=YYYY-MM-DD
// Maintenance: fetch sub_total/discount_total from Zoho for paid invoices that don't
// have them yet (column added 2026-06-11). 2 Zoho calls/invoice — scoped by `from`
// (default 2026-04-01: the report era ≤ Apr 2026 is frozen history anyway).
// Fire-and-forget; poll progress via ?status=1 (rows remaining).
let subtotalBackfill = { status: 'idle', processed: 0, total: 0, errors: 0 };
app.post('/api/admin/backfill-subtotals', async (req, res) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (!process.env.ZOHO_WEBHOOK_SECRET || provided !== process.env.ZOHO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid secret' });
  }
  if (req.query.status) return res.json(subtotalBackfill);
  if (subtotalBackfill.status === 'running') return res.status(409).json({ error: 'already running', ...subtotalBackfill });
  const from = req.query.from || '2026-04-01';
  res.json({ started: true, from });
  (async () => {
    subtotalBackfill = { status: 'running', processed: 0, total: 0, errors: 0, from };
    try {
      const adminResult = await pool.query(
        'SELECT email, api_domain FROM user_tokens WHERE is_admin = true ORDER BY updated_at DESC LIMIT 1'
      );
      const admin = adminResult.rows[0];
      const tokenData = await ensureValidToken(admin.email);
      const accessToken = typeof tokenData === 'string' ? tokenData : tokenData?.access_token;
      const orgId = process.env.ZOHO_ORG_ID;

      // Pre-step (no Zoho): populate gross_line_total from already-stored line_items. Instant.
      await pool.query(
        `UPDATE invoices SET gross_line_total = sub.s
         FROM (
           SELECT id, ROUND(SUM((li->>'amount')::numeric), 2) AS s
           FROM invoices, jsonb_array_elements(line_items) li
           WHERE line_items IS NOT NULL AND jsonb_typeof(line_items) = 'array'
           GROUP BY id
         ) sub
         WHERE invoices.id = sub.id AND invoices.gross_line_total IS DISTINCT FROM sub.s`
      );

      const rows = (await pool.query(
        `SELECT invoice_number FROM invoices
         WHERE organization_id = $1 AND status = 'paid' AND sub_total IS NULL AND date >= $2::date
         ORDER BY date DESC`,
        [orgId, from]
      )).rows;
      subtotalBackfill.total = rows.length;
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      let curToken = accessToken;
      const getWithRetry = async (url, params) => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const res = await axios.get(url, { params, headers: { Authorization: `Zoho-oauthtoken ${curToken}` }, validateStatus: () => true });
          if (res.status === 200) return res;
          if (res.status === 401) { // token expired mid-run → refresh and retry
            const td = await ensureValidToken(admin.email);
            curToken = typeof td === 'string' ? td : td?.access_token;
            continue;
          }
          if (res.status === 429 || res.status >= 500) { await sleep(2000 * (attempt + 1)); continue; } // rate limit / transient
          return res; // 4xx other than 401/429 → don't retry
        }
        return null;
      };
      let i = 0;
      for (const row of rows) {
        try {
          await sleep(120); // throttle to stay under Zoho's burst limit
          if (++i % 400 === 0) { // proactively refresh the token on long runs (tokens ~1h)
            const td = await ensureValidToken(admin.email);
            curToken = typeof td === 'string' ? td : td?.access_token;
          }
          const searchRes = await getWithRetry(`${admin.api_domain}/books/v3/invoices`, { organization_id: orgId, invoice_number: row.invoice_number });
          const stubInv = searchRes?.data?.invoices?.[0];
          if (!stubInv) { subtotalBackfill.errors++; subtotalBackfill.processed++; continue; }
          const detRes = await getWithRetry(`${admin.api_domain}/books/v3/invoices/${stubInv.invoice_id}`, { organization_id: orgId });
          const det = detRes?.data?.invoice;
          if (!det) { subtotalBackfill.errors++; subtotalBackfill.processed++; continue; }
          const subTotal  = parseFloat(det.sub_total) || 0;
          const discTotal = det.discount_type === 'item_level' ? 0 : (parseFloat(det.discount_total) || 0);
          await pool.query(
            `UPDATE invoices SET sub_total = $1, discount_total = $2, updated_at = CURRENT_TIMESTAMP
             WHERE invoice_number = $3 AND organization_id = $4`,
            [subTotal || null, discTotal, row.invoice_number, orgId]
          );
          subtotalBackfill.processed++;
        } catch (_e) { subtotalBackfill.errors++; subtotalBackfill.processed++; }
      }
      subtotalBackfill.status = 'completed';
      console.log(`[SUBTOTAL-BACKFILL] done: ${subtotalBackfill.processed}/${subtotalBackfill.total} (${subtotalBackfill.errors} errors)`);
    } catch (e) {
      subtotalBackfill.status = 'error';
      subtotalBackfill.message = e.message;
      console.error('[SUBTOTAL-BACKFILL]', e.message);
    }
  })();
});

// POST /api/admin/reclassify-noncommission?secret=<shared>
// Maintenance: flip STORED hardware lines whose name matches the noncommission rules
// (shipping/livraison/freight — classifyLineType already excludes them going forward)
// and recompute hardware_amount on the touched invoices. Idempotent; run recalc-v2 after.
app.post('/api/admin/reclassify-noncommission', async (req, res) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (!process.env.ZOHO_WEBHOOK_SECRET || provided !== process.env.ZOHO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid secret' });
  }
  try {
    const flip = await pool.query(`
      WITH affected AS (
        SELECT id FROM invoices
        WHERE line_items IS NOT NULL AND jsonb_typeof(line_items) = 'array'
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(line_items) li
            WHERE li->>'type' = 'hardware' AND li->>'name' ~* '\\m(shipping|livraison|freight)'
          )
      )
      UPDATE invoices i SET
        line_items = (
          SELECT jsonb_agg(
            CASE WHEN li->>'type' = 'hardware' AND li->>'name' ~* '\\m(shipping|livraison|freight)'
                 THEN jsonb_set(li, '{type}', '"noncommission"')
                 ELSE li END)
          FROM jsonb_array_elements(i.line_items) li
        ),
        updated_at = CURRENT_TIMESTAMP
      WHERE i.id IN (SELECT id FROM affected)
      RETURNING i.id
    `);
    const ids = flip.rows.map(r => r.id);
    if (ids.length) {
      await pool.query(`
        UPDATE invoices i SET hardware_amount = COALESCE((
          SELECT SUM((li->>'amount')::numeric)
          FROM jsonb_array_elements(i.line_items) li
          WHERE li->>'type' = 'hardware'
        ), 0)
        WHERE i.id = ANY($1)
      `, [ids]);
    }
    res.json({ invoices_updated: ids.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/db-stats', async (req, res) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (!process.env.ZOHO_WEBHOOK_SECRET || provided !== process.env.ZOHO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid secret' });
  }
  try {
    const counts = {};
    const tables = [
      'invoices', 'salespeople', 'crm_sold_deals', 'zentact_merchants',
      'zoho_plans', 'user_tokens', 'roles', 'user_roles', 'releases',
      'sync_log', 'webhook_log', 'sync_state',
    ];
    for (const t of tables) {
      try {
        const r = await pool.query(`SELECT COUNT(*)::int AS c FROM ${t}`);
        counts[t] = r.rows[0].c;
      } catch { counts[t] = 'n/a'; }
    }

    // Invoice breakdown
    const byStatus = (await pool.query(
      `SELECT status, COUNT(*)::int AS count, COALESCE(SUM(total), 0)::float AS total_revenue,
              COALESCE(SUM(commission), 0)::float AS total_commission
       FROM invoices GROUP BY status ORDER BY count DESC`
    )).rows;

    const byCommissionStatus = (await pool.query(
      `SELECT COALESCE(commission_status, 'unknown') AS commission_status, COUNT(*)::int AS count
       FROM invoices GROUP BY commission_status ORDER BY count DESC`
    )).rows;

    // Drift diagnostic: invoices marked paid/approved (approval_status) that are no longer
    // commission-qualifying (commission_status NOT IN hardware/saas_first). This is what makes
    // the report's STATUS pill show e.g. "0/0/15" — paid count > qualifying count.
    const driftBreakdown = (await pool.query(
      `SELECT approval_status,
              COALESCE(commission_status, 'unknown') AS commission_status,
              COUNT(*)::int AS count,
              COALESCE(SUM(commission), 0)::float AS commission
       FROM invoices
       WHERE approval_status IN ('paid','approved')
       GROUP BY approval_status, commission_status
       ORDER BY approval_status, count DESC`
    )).rows;

    const driftRows = (await pool.query(
      `SELECT invoice_number, salesperson_name, status, approval_status,
              COALESCE(commission_status, 'unknown') AS commission_status,
              commission::float AS commission, date::date AS date,
              commission_payable_date::date AS payable_date
       FROM invoices
       WHERE approval_status IN ('paid','approved')
         AND (commission_status IS NULL OR commission_status NOT IN ('hardware','saas_first','saas_annual'))
       ORDER BY salesperson_name, date
       LIMIT 200`
    )).rows;

    // Inverse drift: commission earned (commission > 0) but NOT yet paid out to the rep
    // (approval_status is not 'paid'). The "overdue" subset has a commission_payable_date
    // in the past — those are earned commissions that arguably should already be paid.
    const earnedUnpaidBreakdown = (await pool.query(
      `SELECT COALESCE(approval_status, 'none') AS approval_status,
              COALESCE(commission_status, 'unknown') AS commission_status,
              COUNT(*)::int AS count,
              COALESCE(SUM(commission), 0)::float AS commission
       FROM invoices
       WHERE commission > 0 AND (approval_status IS NULL OR approval_status <> 'paid')
       GROUP BY approval_status, commission_status
       ORDER BY commission DESC`
    )).rows;

    const earnedUnpaidRows = (await pool.query(
      `SELECT invoice_number, salesperson_name, status,
              COALESCE(approval_status, 'none') AS approval_status,
              COALESCE(commission_status, 'unknown') AS commission_status,
              commission::float AS commission, date::date AS date,
              commission_payable_date::date AS payable_date,
              (commission_payable_date IS NOT NULL AND commission_payable_date < CURRENT_DATE) AS overdue
       FROM invoices
       WHERE commission > 0 AND (approval_status IS NULL OR approval_status <> 'paid')
       ORDER BY commission_payable_date NULLS LAST, salesperson_name
       LIMIT 300`
    )).rows;

    // Accurate (uncapped) totals for the earned-but-unpaid pool, split by overdue vs not-yet-due.
    const earnedUnpaidTotals = (await pool.query(
      `SELECT
         COUNT(*)::int AS total_count,
         COALESCE(SUM(commission), 0)::float AS total_commission,
         COUNT(*) FILTER (WHERE commission_payable_date IS NOT NULL AND commission_payable_date < CURRENT_DATE)::int AS overdue_count,
         COALESCE(SUM(commission) FILTER (WHERE commission_payable_date IS NOT NULL AND commission_payable_date < CURRENT_DATE), 0)::float AS overdue_commission,
         MIN(commission_payable_date) FILTER (WHERE commission_payable_date IS NOT NULL AND commission_payable_date < CURRENT_DATE)::date AS oldest_overdue
       FROM invoices
       WHERE commission > 0 AND (approval_status IS NULL OR approval_status <> 'paid')`
    )).rows[0];

    // For comparison: how many invoices have EVER been marked paid (approval workflow usage).
    const everPaid = (await pool.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(commission),0)::float AS commission
       FROM invoices WHERE approval_status = 'paid'`
    )).rows[0];

    // Per-rep: earned-unpaid vs paid. Reveals whether the remaining pending pool is reps with
    // NO reports imported (paid=0) vs reps whose reports don't cover all app-eligible invoices.
    const earnedUnpaidByRep = (await pool.query(
      `SELECT COALESCE(salesperson_name, '(none)') AS rep,
              COUNT(*) FILTER (WHERE commission > 0 AND (approval_status IS NULL OR approval_status <> 'paid'))::int AS unpaid_count,
              COALESCE(SUM(commission) FILTER (WHERE commission > 0 AND (approval_status IS NULL OR approval_status <> 'paid')), 0)::float AS unpaid_commission,
              COUNT(*) FILTER (WHERE commission > 0 AND approval_status = 'paid')::int AS paid_count,
              COALESCE(SUM(commission) FILTER (WHERE commission > 0 AND approval_status = 'paid'), 0)::float AS paid_commission
       FROM invoices
       GROUP BY salesperson_name
       HAVING COUNT(*) FILTER (WHERE commission > 0 AND (approval_status IS NULL OR approval_status <> 'paid')) > 0
       ORDER BY unpaid_commission DESC`
    )).rows;

    // "Unassigned" (no salesperson on the Zoho invoice) earned-commission invoices, grouped by
    // customer — reveals whether the pool is concentrated on a few accounts that are easy to reattribute.
    const unassignedByCustomer = (await pool.query(
      `SELECT COALESCE(customer_name, '(none)') AS customer,
              COUNT(*)::int AS count,
              COALESCE(SUM(commission), 0)::float AS commission,
              MIN(date)::date AS first_invoice,
              MAX(date)::date AS last_invoice
       FROM invoices
       WHERE salesperson_name = 'Unassigned' AND commission > 0
       GROUP BY customer_name
       ORDER BY commission DESC
       LIMIT 100`
    )).rows;
    const unassignedTotal = (await pool.query(
      `SELECT COUNT(*)::int AS count, COUNT(DISTINCT customer_name)::int AS customers,
              COALESCE(SUM(commission), 0)::float AS commission
       FROM invoices WHERE salesperson_name = 'Unassigned' AND commission > 0`
    )).rows[0];

    // How many "Unassigned" customers could be auto-attributed by matching their name to a
    // zentact_merchants row that HAS a sales_rep_name? Same normalization as buildZentactMatcher
    // (lowercase, strip non-alphanumerics). EXACT-normalized match only — a conservative lower bound
    // (the runtime matcher also does substring includes, which would catch a few more).
    const UN_CTE = `
      WITH un AS (
        SELECT customer_name,
               regexp_replace(lower(customer_name), '[^a-z0-9]', '', 'g') AS norm,
               COUNT(*)::int AS cnt, SUM(commission)::float AS commission
        FROM invoices
        WHERE salesperson_name = 'Unassigned' AND commission > 0 AND customer_name IS NOT NULL
        GROUP BY customer_name
      ),
      zm AS (
        SELECT regexp_replace(lower(business_name), '[^a-z0-9]', '', 'g') AS norm,
               MIN(sales_rep_name) AS rep
        FROM zentact_merchants
        WHERE business_name IS NOT NULL AND business_name <> ''
          AND sales_rep_name IS NOT NULL AND sales_rep_name <> ''
        GROUP BY 1
      )`;
    const unassignedMatch = (await pool.query(`${UN_CTE}
      SELECT COUNT(*)::int AS total_customers,
             COALESCE(SUM(un.commission), 0)::float AS total_commission,
             COUNT(zm.rep)::int AS matched_customers,
             COALESCE(SUM(un.commission) FILTER (WHERE zm.rep IS NOT NULL), 0)::float AS matched_commission
      FROM un LEFT JOIN zm ON zm.norm = un.norm`)).rows[0];
    const unassignedMatchByRep = (await pool.query(`${UN_CTE}
      SELECT zm.rep, COUNT(*)::int AS customers, COALESCE(SUM(un.commission), 0)::float AS commission
      FROM un JOIN zm ON zm.norm = un.norm
      GROUP BY zm.rep ORDER BY commission DESC LIMIT 50`)).rows;

    const dateRange = (await pool.query(
      `SELECT MIN(date)::date AS oldest, MAX(date)::date AS newest FROM invoices`
    )).rows[0];

    const lastSync = (await pool.query(
      `SELECT synced_at, invoice_count, status, message FROM sync_log
       ORDER BY synced_at DESC LIMIT 1`
    )).rows[0] || null;

    const lastWebhook = (await pool.query(
      `SELECT received_at, invoice_number, event, result, user_agent FROM webhook_log
       WHERE user_agent LIKE 'ZohoBooks%' OR user_agent LIKE 'Zoho%'
       ORDER BY received_at DESC LIMIT 1`
    )).rows[0] || null;

    res.json({
      generated_at: new Date().toISOString(),
      row_counts: counts,
      invoices_by_status: byStatus,
      invoices_by_commission_status: byCommissionStatus,
      paid_approved_drift: { breakdown: driftBreakdown, rows: driftRows },
      earned_unpaid: { totals: earnedUnpaidTotals, ever_paid: everPaid, by_rep: earnedUnpaidByRep, breakdown: earnedUnpaidBreakdown, rows: earnedUnpaidRows },
      unassigned: { total: unassignedTotal, by_customer: unassignedByCustomer,
                    auto_match: unassignedMatch, auto_match_by_rep: unassignedMatchByRep },
      invoice_date_range: dateRange,
      last_sync_log: lastSync,
      last_zoho_webhook: lastWebhook,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Trigger a revenue sync/backfill. Secret-gated so it can run without a session
// (and from a cron). Fire-and-forget (the job can take minutes); poll the summary.
//   ?from=YYYY-MM&to=YYYY-MM  → backfill a range
//   ?monthsBack=N             → last N months (default 2)
app.get('/api/admin/zentact-revenue-sync', async (req, res) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (!process.env.ZOHO_WEBHOOK_SECRET || provided !== process.env.ZOHO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid secret' });
  }
  if (revenueSyncJob.running) return res.json({ alreadyRunning: true, job: revenueSyncJob });
  let periods, resume;
  if (req.query.from && req.query.to) {
    const [fy, fm] = String(req.query.from).split('-').map(Number);
    const [ty, tm] = String(req.query.to).split('-').map(Number);
    periods = rangePeriods(fy, fm, ty, tm);
    resume = req.query.force !== '1'; // backfill resumes by default; &force=1 re-does everything
  } else {
    periods = recentPeriods(parseInt(req.query.monthsBack) || 2);
    resume = false; // recent months get restated → always refresh
  }
  // Fire-and-forget — don't await (avoids H12; progress visible via summary).
  syncZentactRevenue(periods, { resume }).catch((e) => console.error('❌ [REVENUE] sync error:', e.message));
  res.json({ started: true, resume, periods: periods.length, first: periods[0], last: periods[periods.length - 1] });
});

// Trigger the OTHER-REVENUE backfill (statement PDFs → recurring/terminal fees).
//   ?from=YYYY-MM&to=YYYY-MM (resumes by default; &force=1 re-does) | ?monthsBack=N
app.get('/api/admin/zentact-otherrev-sync', async (req, res) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (!process.env.ZOHO_WEBHOOK_SECRET || provided !== process.env.ZOHO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid secret' });
  }
  if (otherRevJob.running) return res.json({ alreadyRunning: true, job: otherRevJob });
  let periods, resume;
  if (req.query.from && req.query.to) {
    const [fy, fm] = String(req.query.from).split('-').map(Number);
    const [ty, tm] = String(req.query.to).split('-').map(Number);
    periods = rangePeriods(fy, fm, ty, tm);
    resume = req.query.force !== '1';
  } else {
    periods = recentPeriods(parseInt(req.query.monthsBack) || 2);
    resume = req.query.force !== '1';
  }
  syncZentactOtherRevenue(periods, { resume }).catch((e) => console.error('❌ [OTHER-REV] sync error:', e.message));
  res.json({ started: true, resume, periods: periods.length, first: periods[0], last: periods[periods.length - 1] });
});

// Other-revenue progress + totals.
app.get('/api/admin/zentact-otherrev-summary', async (req, res) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (!process.env.ZOHO_WEBHOOK_SECRET || provided !== process.env.ZOHO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid secret' });
  }
  try {
    const t = (await pool.query(
      `SELECT COUNT(*) FILTER (WHERE other_revenue_cents IS NOT NULL)::int AS rows_with_other,
              ROUND(COALESCE(SUM(other_revenue_cents),0)/100.0, 2) AS other_revenue,
              MIN(year*100+month) FILTER (WHERE other_revenue_cents IS NOT NULL) AS first_period,
              MAX(year*100+month) FILTER (WHERE other_revenue_cents IS NOT NULL) AS last_period
       FROM zentact_merchant_revenue`
    )).rows[0];
    const byPeriod = (await pool.query(
      `SELECT year, month, COUNT(*) FILTER (WHERE other_revenue_cents IS NOT NULL)::int AS statements,
              ROUND(COALESCE(SUM(other_revenue_cents),0)/100.0, 2) AS other_revenue
       FROM zentact_merchant_revenue
       WHERE other_revenue_cents IS NOT NULL
       GROUP BY year, month ORDER BY year, month`
    )).rows;
    res.json({ job: otherRevJob, totals: t, byPeriod });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Revenue summary — row counts + totals (cents) by salesperson and by reseller.
// Used to verify the import and to feed the eventual UI.
app.get('/api/admin/zentact-revenue-summary', async (req, res) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (!process.env.ZOHO_WEBHOOK_SECRET || provided !== process.env.ZOHO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid secret' });
  }
  try {
    const totals = (await pool.query(
      `SELECT COUNT(*)::int AS rows, COUNT(DISTINCT merchant_account_id)::int AS merchants,
              MIN(year*100+month) AS first_period, MAX(year*100+month) AS last_period,
              ROUND(SUM(transaction_profit_cents)/100.0, 2) AS transaction_profit,
              ROUND(SUM(total_volume_cents)/100.0, 2) AS volume
       FROM zentact_merchant_revenue`
    )).rows[0];
    const byRep = (await pool.query(
      `SELECT COALESCE(zm.sales_rep_name, '(unassigned)') AS rep,
              ROUND(SUM(r.transaction_profit_cents)/100.0, 2) AS transaction_profit,
              COUNT(DISTINCT r.merchant_account_id)::int AS merchants
       FROM zentact_merchant_revenue r
       LEFT JOIN zentact_merchants zm ON zm.merchant_account_id = r.merchant_account_id
       GROUP BY 1 ORDER BY transaction_profit DESC NULLS LAST LIMIT 100`
    )).rows;
    res.json({ job: revenueSyncJob, totals, byRep });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================================
// COMMISSION REPORT IMPORT — parse an Excel pay-report and mark invoices
// as approval_status='paid' + record signup/monthly bonuses.
// ============================================================================
// File naming convention: Eligible_Invoices_for_Commission_<MonthAbbr>_<YY>_<RepFirstName>.xlsx
//   e.g. Eligible_Invoices_for_Commission_Jan_26_Amy.xlsx
// Structure (single sheet, no fixed row positions — we scan):
//   - Header row contains "Invoice Number" and "Commissions Amount" cell labels
//   - Data rows: rows where col[4] starts with "INV-"
//   - "Payment :" marker indicates the start of the bonus section
//   - Signup commission rows: col[6] === "Signup commission", merchant in col[8], amount in col[13]
//   - Monthly bonus row: col[6] matches "<MONTH> BONUS", amount in col[13]
// ============================================================================

const MONTH_ABBR_TO_NUM = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };

// Parse the filename to extract month/year + rep name. Tolerant of token ORDER
// (Mon_YY_Rep or Rep_Mon_YYYY) and 2- or 4-digit years — we just locate a month
// token and a year token anywhere, and treat the remainder as the rep name.
//   Eligible_Invoices_for_Commission_Feb_26_Amy.xlsx   ✓
//   Eligible_Invoices_for_Commission_Amy_Feb_2026.xlsx ✓
function parseImportFilename(filename) {
  if (!/\.xlsx$/i.test(filename)) return null;
  const norm = filename.replace(/\.xlsx$/i, '').replace(/_/g, ' ');
  // Accept both abbreviated ("Mar") and full ("March") month names. The capture group
  // keeps the 3-letter prefix so MONTH_ABBR_TO_NUM still resolves it; [a-z]* eats the rest.
  const mMatch = norm.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b/i);
  const yMatch = norm.match(/\b(20\d{2}|\d{2})\b/);
  if (!mMatch || !yMatch) return null;
  const month = MONTH_ABBR_TO_NUM[mMatch[1].toLowerCase()];
  let year = parseInt(yMatch[1], 10);
  if (year < 100) year += 2000;
  const repFirstName = norm
    .replace(/Eligible Invoices for Commission/i, '')
    .replace(mMatch[0], ' ')
    .replace(yMatch[0], ' ')
    .replace(/add[\s_-]?ons?/i, ' ')   // drop the "Addon" tag from e.g. "Nov_2025_Liz_Addon"
    .replace(/\s+/g, ' ')
    .trim() || null;
  return { month, year, repFirstName, periodDate: `${year}-${String(month).padStart(2, '0')}-01` };
}

// Parse a money cell tolerant of "$7,298.30" (US) and "638,90" (EU comma-decimal).
function parseMoneyCell(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  let s = String(v).replace(/[^0-9.,\-]/g, '');      // strip $, spaces, letters
  if (s.includes(',') && !s.includes('.')) s = s.replace(',', '.');  // EU decimal comma
  else s = s.replace(/,/g, '');                       // commas are thousands separators
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// Read the workbook and return a structured payload — invoices, signup bonuses, monthly bonus.
// Supports two layouts:
//   • Standard "Eligible Invoices for Commission" report — header row has an exact
//     "Invoice Number" cell, plus "Commissions Amount" / "Lead Source" (bonuses).
//   • "Addon" report — header row (not necessarily at the top) has "INVOICE" + "COMMISSION"
//     columns, plus TYPE / STATUS / OWED NOW / COMING SOON. Tracks partial payouts; we treat
//     a listed invoice as fully settled (mark paid) UNLESS it still carries a COMING SOON amount.
// Header text with ALL whitespace removed + uppercased. Tolerates in-cell line breaks
// (e.g. a cell that displays "COMMIS↵SION" but should match "COMMISSION").
function tightHdr(c) { return c == null ? '' : String(c).replace(/\s+/g, '').toUpperCase(); }

// Header matchers — different reports label the same column differently:
//   "Invoice #", "Invoice Number", "INVOICE", "Inv #"  → invoice column
//   "Commission", "Commissions Amount"                  → commission column
function isInvoiceHdr(t)    { return /^INV(OICE)?(#|NO\.?|NUMBER|NUM)?$/.test(t); }
function isCommissionHdr(t) { return /^COMMISSIONS?(AMOUNT)?$/.test(t); }

function parseCommissionReportXlsx(buffer) {
  const wb = xlsx.read(buffer, { type: 'buffer', cellDates: true });

  // The table isn't always on the first sheet — scan every sheet and use the first that
  // carries a recognizable header.
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: null });
    if (!rows.length) continue;

    // Standard report: identified by an exact "Invoice Number" header (it carries Lead Source
    // bonus rows). Checked FIRST so bonus-bearing reports route here, not to the Addon parser.
    const stdHeaderIdx = rows.findIndex(r => r.some(c => tightHdr(c) === 'INVOICENUMBER'));
    if (stdHeaderIdx >= 0) return parseStandardReport(rows, stdHeaderIdx);

    // Addon-style report: any header row carrying both an invoice column and a commission column,
    // however they're labelled ("Invoice #"/"INVOICE"/..., "Commission"/"Commissions Amount").
    const addonHeaderIdx = rows.findIndex(r => {
      const cells = r.map(tightHdr);
      return cells.some(isInvoiceHdr) && cells.some(isCommissionHdr);
    });
    if (addonHeaderIdx >= 0) return parseAddonReport(rows, addonHeaderIdx);
  }

  throw new Error("Unrecognized layout — no 'Invoice Number' header (standard report) or 'INVOICE'/'COMMISSION' headers (Addon report) found on any sheet");
}

// Standard "Eligible Invoices for Commission" layout.
function parseStandardReport(rows, headerIdx) {
  const header = rows[headerIdx].map(tightHdr);
  const col = (name) => header.indexOf(tightHdr(name));

  const idxInvoiceNumber = col('Invoice Number');
  const idxRep           = col('Sales Person Name');
  const idxCustomer      = col('Customer Name');
  const idxCommission    = col('Commissions Amount');
  const idxPaymentDate   = col('Payment Date');
  const idxLeadSource    = col('Lead Source');

  const invoices = [];
  let i = headerIdx + 1;
  // Eat data rows until we hit a fully-blank row (signals end of invoice block)
  for (; i < rows.length; i++) {
    const r = rows[i];
    const inv = r[idxInvoiceNumber];
    if (inv && typeof inv === 'string' && inv.startsWith('INV-')) {
      const commission = parseFloat(r[idxCommission]) || 0;
      invoices.push({
        invoice_number: inv.trim(),
        rep: r[idxRep] ? String(r[idxRep]).trim() : null,
        customer: r[idxCustomer] ? String(r[idxCustomer]).trim() : null,
        commission,
        payment_date: r[idxPaymentDate] || null,
      });
    }
  }

  // Now scan everything below for bonus rows. The "Lead Source" column tags the type:
  //   "Signup commission"  → per-merchant signup bonus
  //   "Volume Bonus"/"Volume Commission"/"Processing Bonus"/... → per-merchant PROCESSING bonus
  //     (historical payouts; recorded per account so the automated bi-annual payout excludes them
  //     — "paid once").
  //   anything else ending in "BONUS" → a generic monthly bonus (summed).
  // Volume/Processing is checked FIRST (it can also end in "BONUS").
  const signupBonuses = [];
  const volumeBonuses = [];
  let monthlyBonus = 0;
  for (i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const tag = r[idxLeadSource] ? String(r[idxLeadSource]).trim() : '';
    const amount = parseFloat(r[idxCommission]) || 0;
    if (/^Signup commission$/i.test(tag) && amount > 0) {
      signupBonuses.push({
        merchant: r[idxCustomer] ? String(r[idxCustomer]).trim() : null,
        amount,
        date: r[0] || null,
      });
    } else if (/(volume|processing)\s*(bonus|commission)/i.test(tag) && amount > 0) {
      volumeBonuses.push({
        merchant: r[idxCustomer] ? String(r[idxCustomer]).trim() : null,
        amount,
        date: r[0] || null,
      });
    } else if (/BONUS$/i.test(tag) && amount > 0) {
      monthlyBonus += amount;
    }
  }

  return { invoices, signupBonuses, volumeBonuses, monthlyBonus };
}

// "Addon" layout: columns [account/customer], INVOICE, SUB-TOTAL, COMMISSION, TYPE, STATUS,
// OWED NOW, COMING SOON. No bonus rows. Rep comes from the filename, not the sheet.
function parseAddonReport(rows, headerIdx) {
  const header = rows[headerIdx].map(tightHdr);
  const col = (name) => header.indexOf(tightHdr(name));

  const idxInvoice    = header.findIndex(isInvoiceHdr);
  const idxCommission = header.findIndex(isCommissionHdr);
  const idxComingSoon = col('COMING SOON'); // -1 when absent (simpler layouts) → guard skipped
  const idxCustomer   = 0; // first column holds the account/customer name

  const invoices = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const invRaw = r[idxInvoice];
    // Skip the totals row and any non-invoice rows.
    if (!invRaw || typeof invRaw !== 'string' || !/^INV-/i.test(invRaw.trim())) continue;
    // Defensive: a non-empty COMING SOON means part of this commission is still deferred —
    // don't mark it fully paid. Skip so it surfaces as "not imported" rather than over-paid.
    if (idxComingSoon >= 0 && parseMoneyCell(r[idxComingSoon]) > 0) continue;
    invoices.push({
      invoice_number: invRaw.trim(),
      rep: null, // filename supplies the rep for this format
      customer: r[idxCustomer] ? String(r[idxCustomer]).trim() : null,
      commission: parseMoneyCell(r[idxCommission]),
      payment_date: null,
    });
  }

  return { invoices, signupBonuses: [], volumeBonuses: [], monthlyBonus: 0 };
}

// Normalize a merchant name for fuzzy comparison: strip ACCENTS/diacritics, lowercase,
// drop spaces/punctuation. Shared by the Zentact matcher and the processing-bonus exclusion
// so "Café Gentile" and "Cafe Gentile" compare equal. (Accent-stripping added 2026-06-15 —
// without it, an account paid as "Café…" wasn't excluded from the bi-annual "Cafe…" row.)
function normMerchant(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[\s\-_'.,&]+/g, '');
}

// Load zentact_merchants ONCE and return a fuzzy matcher — case-insensitive, ignores
// accents/spaces/hyphens. Avoids the full-table scan per bonus that previously serialized into
// the Heroku 30s request timeout (H12) on large reports.
async function buildZentactMatcher() {
  const all = await pool.query(`SELECT merchant_account_id, business_name FROM zentact_merchants WHERE business_name IS NOT NULL AND business_name <> ''`);
  const candidates = all.rows.map(row => ({
    id: row.merchant_account_id,
    norm: normMerchant(row.business_name),
  }));
  return (name) => {
    if (!name) return null;
    const norm = normMerchant(name);
    for (const c of candidates) {
      if (c.norm === norm) return c.id;
      if (c.norm.includes(norm) || norm.includes(c.norm)) return c.id;
    }
    return null;
  };
}

// In-memory upload (small files, fine in RAM)
const uploadXlsx = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
});

// POST /api/admin/commission-import/preview
// Returns what WOULD happen if we committed — no DB changes.
// POST /api/admin/commission-import/commit
// Same parsing, but applies changes (transactional).
async function importCommissionReport(req, res, { commit }) {
  if (!(await requirePerm(req, res, 'report:mark_paid'))) return;
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No file uploaded (multipart field "file" expected)' });

  const meta = parseImportFilename(file.originalname);
  if (!meta) {
    return res.status(400).json({
      error: 'Filename does not match expected pattern',
      expected: 'Eligible_Invoices_for_Commission_<Mon>_<YY>_<RepFirstName>.xlsx',
    });
  }

  let parsed;
  try {
    parsed = parseCommissionReportXlsx(file.buffer);
  } catch (e) {
    return res.status(400).json({ error: 'Failed to parse spreadsheet', details: e.message });
  }

  // Use the full rep name from the data rows when available (so we get "Amy Spicer"
  // instead of just "Amy" from the filename).
  const repFullName = parsed.invoices.find(i => i.rep)?.rep || meta.repFirstName;

  // For each invoice with commission > 0, check whether it exists in our DB and is markable.
  // Single batched lookup (was N sequential queries — root cause of the H12 timeout on big reports).
  const eligibleInvoices = parsed.invoices.filter(i => i.commission > 0);
  const skipped = parsed.invoices.filter(i => i.commission === 0).map(i => i.invoice_number);
  const matched = [];
  const notFoundRows = [];   // full file rows (number, customer, commission) — paid for real, just not in our DB
  if (eligibleInvoices.length) {
    const numbers = eligibleInvoices.map(i => i.invoice_number);
    const rows = (await pool.query(
      `SELECT invoice_number, salesperson_name, total, status, approval_status, commission
       FROM invoices WHERE invoice_number = ANY($1)`,
      [numbers]
    )).rows;
    const byNumber = new Map(rows.map(r => [r.invoice_number, r]));
    for (const inv of eligibleInvoices) {
      const row = byNumber.get(inv.invoice_number);
      if (!row) {
        notFoundRows.push(inv);
      } else {
        matched.push({ ...inv, current_status: row.status, current_approval: row.approval_status, app_commission: parseFloat(row.commission) || 0 });
      }
    }
  }
  const notFound = notFoundRows.map(i => i.invoice_number);
  const notFoundAmount = notFoundRows.reduce((s, i) => s + i.commission, 0);

  // Match each signup bonus to a Zentact merchant (matcher loads the table once, matches in memory).
  const matchZentact = await buildZentactMatcher();
  const bonusesWithMatch = parsed.signupBonuses.map(b => ({
    ...b,
    matched_zentact_id: matchZentact(b.merchant),
  }));
  // Volume/processing bonuses → per-account 'processing' bonuses (matched so the automated
  // bi-annual payout excludes these already-paid accounts).
  const volumeBonusesWithMatch = (parsed.volumeBonuses || []).map(b => ({
    ...b,
    matched_zentact_id: matchZentact(b.merchant),
  }));
  const volumeBonusAmount = volumeBonusesWithMatch.reduce((s, b) => s + b.amount, 0);

  const summary = {
    filename:               file.originalname,
    rep_name:               repFullName,
    paid_for_period:        meta.periodDate,
    invoices_to_mark:       matched.length,
    invoices_skipped_zero:  skipped.length,
    invoices_not_found:     notFound.length,
    not_found_amount:       Math.round(notFoundAmount * 100) / 100,
    signup_bonuses_count:   bonusesWithMatch.length,
    signup_bonuses_amount:  bonusesWithMatch.reduce((s, b) => s + b.amount, 0),
    monthly_bonus_amount:   parsed.monthlyBonus,
    volume_bonuses_count:   volumeBonusesWithMatch.length,
    volume_bonuses_amount:  Math.round(volumeBonusAmount * 100) / 100,
    // The FULL amount the file paid out — including invoices not in our DB (pre-2025).
    // The user's pay reports are the source of truth; the stub total must match the file.
    total_to_pay:           matched.reduce((s, i) => s + i.commission, 0)
                            + notFoundAmount
                            + bonusesWithMatch.reduce((s, b) => s + b.amount, 0)
                            + volumeBonusAmount
                            + parsed.monthlyBonus,
  };

  if (!commit) {
    return res.json({
      preview: true,
      summary,
      matched,
      skipped_zero: skipped,
      not_found: notFound,
      bonuses: bonusesWithMatch,
      volume_bonuses: volumeBonusesWithMatch,
    });
  }

  // Commit — wrap in transaction
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const actor = req.user.realAdminEmail || req.user.email || 'unknown';

    // 0. Idempotent re-import: drop any prior import for the same file/rep/period
    //    (cascades to its payment_lines + bonuses) so re-uploading replaces instead of duplicating.
    await client.query(
      `DELETE FROM commission_payment_imports WHERE filename = $1 AND rep_name = $2 AND paid_for_period = $3::date`,
      [file.originalname, repFullName, meta.periodDate]
    );

    // 1. Insert the import summary
    const importRow = (await client.query(
      `INSERT INTO commission_payment_imports
         (filename, rep_name, paid_for_period, imported_by,
          invoices_marked, invoices_skipped, invoices_not_found,
          signup_bonuses_count, signup_bonuses_amount, monthly_bonus_amount,
          total_amount, raw_summary)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
       RETURNING id`,
      [file.originalname, repFullName, meta.periodDate, actor,
       summary.invoices_to_mark, summary.invoices_skipped_zero, summary.invoices_not_found,
       summary.signup_bonuses_count, summary.signup_bonuses_amount, summary.monthly_bonus_amount,
       summary.total_to_pay, JSON.stringify(summary)]
    )).rows[0];

    // 2. Mark each invoice as paid + record the pay-stub line (faithful to the file amount,
    //    plus the app-computed value for discrepancy auditing).
    for (const inv of matched) {
      await client.query(
        `UPDATE invoices SET
           approval_status = 'paid',
           commission_paid = true,
           approved_by    = COALESCE(approved_by, $2),
           approved_at    = COALESCE(approved_at, $3::date),
           payout_paid_by = COALESCE(payout_paid_by, $4),
           payout_paid_at = $3::date,
           updated_at     = CURRENT_TIMESTAMP
         WHERE invoice_number = $1`,
        [inv.invoice_number, actor, meta.periodDate, `import:${file.originalname}`]
      );
      await client.query(
        `INSERT INTO commission_payment_lines (import_id, invoice_number, customer, paid_amount, app_commission)
         VALUES ($1, $2, $3, $4, $5)`,
        [importRow.id, inv.invoice_number, inv.customer || null, inv.commission, inv.app_commission ?? null]
      );
    }

    // 2b. Record the file's not-in-DB lines too (pre-2025 invoices): no invoice row to mark,
    //     but they WERE paid — the stub must show the full payout. app_commission stays NULL.
    for (const inv of notFoundRows) {
      await client.query(
        `INSERT INTO commission_payment_lines (import_id, invoice_number, customer, paid_amount, app_commission, not_in_db)
         VALUES ($1, $2, $3, $4, NULL, true)`,
        [importRow.id, inv.invoice_number, inv.customer || null, inv.commission]
      );
    }

    // 3. Insert signup bonuses
    for (const b of bonusesWithMatch) {
      await client.query(
        `INSERT INTO commission_bonuses
           (import_id, rep_name, bonus_type, merchant_name, matched_zentact_id, amount, paid_for_period, report_date)
         VALUES ($1, $2, 'signup', $3, $4, $5, $6::date, $7::date)`,
        [importRow.id, repFullName, b.merchant, b.matched_zentact_id, b.amount, meta.periodDate, b.date || null]
      );
    }

    // 4. Insert monthly bonus if any
    if (parsed.monthlyBonus > 0) {
      await client.query(
        `INSERT INTO commission_bonuses
           (import_id, rep_name, bonus_type, amount, paid_for_period)
         VALUES ($1, $2, 'monthly', $3, $4::date)`,
        [importRow.id, repFullName, parsed.monthlyBonus, meta.periodDate]
      );
    }

    // 5. Volume/processing bonuses → per-account 'processing' rows. matched_zentact_id makes
    //    the automated bi-annual payout treat these accounts as already paid ("paid once").
    for (const b of volumeBonusesWithMatch) {
      await client.query(
        `INSERT INTO commission_bonuses
           (import_id, rep_name, bonus_type, merchant_name, matched_zentact_id, amount, paid_for_period, report_date)
         VALUES ($1, $2, 'processing', $3, $4, $5, $6::date, $7::date)`,
        [importRow.id, repFullName, b.merchant, b.matched_zentact_id, b.amount, meta.periodDate, b.date || null]
      );
    }

    await client.query('COMMIT');
    return res.json({ committed: true, import_id: importRow.id, summary });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('commission import commit error:', e);
    return res.status(500).json({ error: 'Failed to commit import', details: e.message });
  } finally {
    client.release();
  }
}

// importCommissionReport is async and the preview path isn't fully wrapped in try/catch, so
// any rejection (DB error, query_timeout, pool connect timeout, ...) would otherwise escape as
// an unhandledRejection — which our global handler only LOGS, leaving the HTTP request hanging
// forever → the frontend shows "Network Error". This wrapper guarantees a response is always
// sent and surfaces the real error message instead of a silent hang.
const importHandler = (commit) => async (req, res) => {
  try {
    await importCommissionReport(req, res, { commit });
  } catch (e) {
    console.error(`commission-import ${commit ? 'commit' : 'preview'} error:`, e);
    if (!res.headersSent) res.status(500).json({ error: 'Import failed', details: e.message });
  }
};
app.post('/api/admin/commission-import/preview', authenticateToken, uploadXlsx.single('file'), importHandler(false));
app.post('/api/admin/commission-import/commit', authenticateToken, uploadXlsx.single('file'), importHandler(true));

// ============================================================================
// "What's New" — per-user tracking of which new-feature announcements were seen.
// The feature catalog lives in the frontend; here we just persist seen ids per user.
// ============================================================================
const seenFeatureKey = (req) => req.user.email || req.user.realAdminEmail || req.user.name || 'unknown';

// GET /api/features/seen — list feature ids the current user has already seen
app.get('/api/features/seen', authenticateToken, async (req, res) => {
  try {
    const r = await pool.query('SELECT feature_id FROM user_seen_features WHERE user_key = $1', [seenFeatureKey(req)]);
    res.json({ seen: r.rows.map(x => x.feature_id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/features/seen — mark a feature id as seen for the current user
app.post('/api/features/seen', authenticateToken, async (req, res) => {
  const featureId = (req.body?.featureId || '').toString().trim();
  if (!featureId) return res.status(400).json({ error: 'featureId required' });
  try {
    await pool.query(
      `INSERT INTO user_seen_features (user_key, feature_id) VALUES ($1, $2)
       ON CONFLICT (user_key, feature_id) DO NOTHING`,
      [seenFeatureKey(req), featureId]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/features/new — active "new feature" announcements (within their since+days window).
// Drives the sidebar dot/badge + on-page banner. Authed (any user); per-user seen state is
// tracked separately via /api/features/seen.
app.get('/api/features/new', authenticateToken, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT feature_id AS id, path, title, description, since, days
      FROM new_features
      WHERE CURRENT_DATE <= since + (days * INTERVAL '1 day')
      ORDER BY since DESC
    `);
    res.json({ features: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin: list ALL new-feature entries (active or expired) — for management in the Releases panel.
app.get('/api/admin/new-features', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'admin:releases'))) return;
  try {
    const r = await pool.query(`SELECT id, feature_id, path, title, description, since, days, release_id FROM new_features ORDER BY since DESC`);
    res.json({ features: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin: remove a new-feature tag early.
app.delete('/api/admin/new-features/:id', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'admin:releases'))) return;
  try {
    await pool.query('DELETE FROM new_features WHERE id = $1', [parseInt(req.params.id)]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================================
// RESELLERS — third-party license resellers. POS activations (Zoho Form) + residual
// payments (Zentact). Phase 1 = scaffolding; data sources wired in later phases.
// ============================================================================

// GET /api/resellers — list resellers with resolved activation stats (locations + licenses)
app.get('/api/resellers', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'reseller:view'))) return;
  try {
    const r = await pool.query(`
      SELECT rs.id, rs.name, rs.active, rs.zentact_key,
             COALESCE(rs.emails, '[]'::jsonb) AS emails,
             COALESCE(rs.name_aliases, '[]'::jsonb) AS name_aliases,
             (rs.logo_data IS NOT NULL) AS has_logo,
             EXTRACT(EPOCH FROM rs.logo_updated_at)::bigint AS logo_updated_at,
             COALESCE(a.locations, 0) AS locations,
             COALESCE(a.licenses, 0) AS licenses
      FROM resellers rs
      LEFT JOIN LATERAL (
        SELECT COUNT(DISTINCT customer_name)::int AS locations, COALESCE(SUM(quantity),0)::int AS licenses
        FROM reseller_pos_activations a
        WHERE rs.emails @> to_jsonb(LOWER(a.reseller_email))
      ) a ON true
      ORDER BY rs.name
    `);
    res.json({ resellers: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/resellers — create a reseller
app.post('/api/resellers', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'reseller:manage'))) return;
  const name = (req.body?.name || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const r = await pool.query(
      `INSERT INTO resellers (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING id`,
      [name]
    );
    res.json({ success: true, id: r.rows[0]?.id || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/resellers/:id — update name / active / emails / zentact_key
app.put('/api/resellers/:id', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'reseller:manage'))) return;
  const { name, active, emails, zentact_key, name_aliases } = req.body || {};
  // Normalize emails / name aliases to lowercased, de-duped arrays.
  const cleanEmails = Array.isArray(emails)
    ? [...new Set(emails.map(e => (e || '').toString().trim().toLowerCase()).filter(Boolean))]
    : null;
  const cleanAliases = Array.isArray(name_aliases)
    ? [...new Set(name_aliases.map(e => (e || '').toString().trim().toLowerCase()).filter(Boolean))]
    : null;
  try {
    await pool.query(
      `UPDATE resellers SET
         name         = COALESCE($2, name),
         active       = COALESCE($3, active),
         emails       = COALESCE($4::jsonb, emails),
         zentact_key  = $5,
         name_aliases = COALESCE($6::jsonb, name_aliases),
         updated_at   = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [parseInt(req.params.id),
       name != null ? String(name).trim() : null,
       typeof active === 'boolean' ? active : null,
       cleanEmails ? JSON.stringify(cleanEmails) : null,
       zentact_key != null ? String(zentact_key).trim() || null : null,
       cleanAliases ? JSON.stringify(cleanAliases) : null]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/resellers/:id
app.delete('/api/resellers/:id', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'reseller:manage'))) return;
  try {
    await pool.query('DELETE FROM resellers WHERE id = $1', [parseInt(req.params.id)]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Reseller logos are small images — 2 MB cap, kept in memory then written to bytea.
const uploadResellerLogo = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

// POST /api/resellers/:id/logo — upload/replace a reseller's logo (multipart field "file").
app.post('/api/resellers/:id/logo', authenticateToken, uploadResellerLogo.single('file'), async (req, res) => {
  if (!(await requirePerm(req, res, 'reseller:manage'))) return;
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'file required (multipart field "file")' });
  if (!/^image\//.test(file.mimetype)) return res.status(400).json({ error: 'logo must be an image' });
  try {
    const r = await pool.query(
      `UPDATE resellers SET logo_data = $2, logo_mime_type = $3, logo_file_name = $4,
              logo_updated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING id`,
      [parseInt(req.params.id), file.buffer, file.mimetype, file.originalname]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'reseller not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/resellers/:id/logo — clear a reseller's logo.
app.delete('/api/resellers/:id/logo', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'reseller:manage'))) return;
  try {
    await pool.query(
      `UPDATE resellers SET logo_data = NULL, logo_mime_type = NULL, logo_file_name = NULL,
              logo_updated_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [parseInt(req.params.id)]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/resellers/:id/logo — serve the logo image. Intentionally UNAUTHENTICATED: a
// reseller logo is a public brand asset, and serving it without a token lets the frontend
// render it directly in <img src> tags (which can't send an Authorization header) across the
// admin table, the portal lists, and the hero. No sensitive data is exposed.
app.get('/api/resellers/:id/logo', async (req, res) => {
  try {
    const r = (await pool.query(
      `SELECT logo_data, logo_mime_type FROM resellers WHERE id = $1`, [parseInt(req.params.id)]
    )).rows[0];
    if (!r || !r.logo_data) return res.status(404).end();
    res.setHeader('Content-Type', r.logo_mime_type || 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(r.logo_data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/resellers/unassigned-emails — reseller emails seen in activations but not mapped to any reseller
app.get('/api/resellers/unassigned-emails', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'reseller:view'))) return;
  try {
    const r = await pool.query(`
      SELECT LOWER(a.reseller_email) AS email,
             COUNT(DISTINCT a.customer_name)::int AS locations,
             COALESCE(SUM(a.quantity),0)::int AS licenses
      FROM reseller_pos_activations a
      WHERE a.reseller_email IS NOT NULL AND a.reseller_email <> ''
        AND NOT EXISTS (SELECT 1 FROM resellers rs WHERE rs.emails @> to_jsonb(LOWER(a.reseller_email)))
      GROUP BY 1 ORDER BY licenses DESC
    `);
    res.json({ emails: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/webhooks/zoho-form/license-order — receives a reseller's license-order form
// submission from Zoho Forms (Integrations → Webhooks). Secret-gated via ?secret=.
// Configure the form's webhook to send JSON mapping fields → keys:
//   reseller_name (required, link key), license_type, quantity, customer_name, submitted_at
app.post('/api/webhooks/zoho-form/license-order',
  bodyParser.urlencoded({ extended: true }), // also accept form-encoded payloads
  async (req, res) => {
    const expected = process.env.ZOHO_FORM_WEBHOOK_SECRET || process.env.ZOHO_WEBHOOK_SECRET;
    if (!expected || req.query.secret !== expected) {
      return res.status(401).json({ error: 'Invalid webhook secret' });
    }
    try {
      const b = req.body || {};
      // Tolerate both payload shapes: the clean keys the current form sends
      // (reseller_name/customer_name/quantity) AND the full Zoho form's French field labels.
      const resellerName  = (b.reseller_name || b.resellerName || b.reseller || b['Nom du revendeur (reseller)'] || '').toString().trim() || null;
      const resellerEmail = (b.reseller_email || b.resellerEmail || b.email || b['Courriel du demandeur (revendeur)'] || '').toString().trim().toLowerCase() || null;
      const licenseType  = (b.license_type || b.licenseType || b.license || '').toString().trim() || null;
      const quantity     = parseInt(b.quantity || b.qty || b['Nombre de Licenses requises'] || 1) || 1;
      const customerName = (b.customer_name || b.customerName || b.customer || b['Nom Entreprise'] || '').toString().trim() || null;
      // Submission date: use the mapped form value if it parses, else now (the webhook fires
      // at submit time, so "now" is the submission moment). Parsed in JS to tolerate any format.
      let submittedDate = new Date();
      const rawDate = b.submitted_at || b.submittedAt || b.date || b.added_time || b['Added Time'];
      if (rawDate) { const d = new Date(rawDate); if (!isNaN(d.getTime())) submittedDate = d; }

      await pool.query(
        `INSERT INTO reseller_pos_activations (reseller_name, reseller_email, license_type, quantity, customer_name, submitted_at, raw)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [resellerName, resellerEmail, licenseType, quantity, customerName, submittedDate, JSON.stringify(b)]
      );
      // Auto-register the reseller (keyed by name when present, else email) so it appears in the list.
      const resellerKey = resellerName || resellerEmail;
      if (resellerKey) {
        await pool.query(
          `INSERT INTO resellers (name, email) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`,
          [resellerKey, resellerEmail]
        );
      }
      console.log(`🔔 POS activation: ${resellerKey || '(no reseller)'} — ${customerName || '?'} x${quantity}`);
      res.json({ success: true });
    } catch (e) {
      console.error('zoho-form webhook error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

// GET /api/resellers/pos-activations — POS license activations from the Zoho order form.
app.get('/api/resellers/pos-activations', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'reseller:view'))) return;
  try {
    // Resolve each activation to a managed reseller by EMAIL (emails mapping) OR by NAME
    // (the form now sends reseller_name, e.g. "Lirette"). Fall back to the raw captured name,
    // then the raw email, then "(unassigned)". The LATERAL picks ONE reseller (email match
    // preferred) so an OR-match never duplicates/inflates aggregate counts.
    const RESELLER_JOIN = `
       LEFT JOIN LATERAL (
         SELECT r.name FROM resellers r
         WHERE r.emails @> to_jsonb(LOWER(a.reseller_email))
            OR LOWER(r.name) = LOWER(NULLIF(a.reseller_name, ''))
            OR r.name_aliases @> to_jsonb(LOWER(NULLIF(a.reseller_name, '')))
         ORDER BY (r.emails @> to_jsonb(LOWER(a.reseller_email))) DESC
         LIMIT 1
       ) rs ON true`;
    const RESELLER_LABEL = `COALESCE(rs.name, NULLIF(a.reseller_name, ''), NULLIF(a.reseller_email, ''), '(unassigned)')`;
    const rows = (await pool.query(
      `SELECT a.id, ${RESELLER_LABEL} AS reseller_name,
              a.reseller_email, a.quantity, a.customer_name, a.submitted_at
       FROM reseller_pos_activations a${RESELLER_JOIN}
       ORDER BY a.submitted_at DESC LIMIT 2000`
    )).rows;
    const byReseller = (await pool.query(
      `SELECT ${RESELLER_LABEL} AS reseller_name,
              COUNT(DISTINCT a.customer_name)::int AS locations,
              COALESCE(SUM(a.quantity),0)::int AS licenses,
              COUNT(*)::int AS submissions
       FROM reseller_pos_activations a${RESELLER_JOIN}
       GROUP BY 1 ORDER BY licenses DESC`
    )).rows;
    res.json({ connected: true, source: 'zoho_forms', activations: rows, byReseller });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================================
// RATE / SAVINGS CALCULATOR — analyze a competitor merchant statement → savings offer.
// Pricing templates (Cluster rates + costs) are admin-managed and assignable per rep;
// reps use their template's prices (locked), an admin can override prices per deal.
// Engine = services/savingsCalc.js (validated against the source Excel).
// ============================================================================
async function getEffectiveTemplate(email) {
  let row = email ? (await pool.query(
    `SELECT t.* FROM pricing_template_assignments a JOIN pricing_templates t ON t.id = a.template_id
     WHERE LOWER(a.rep_email) = LOWER($1) AND t.active = true`, [email])).rows[0] : null;
  if (!row) row = (await pool.query(`SELECT * FROM pricing_templates WHERE is_default = true AND active = true LIMIT 1`)).rows[0];
  if (!row) row = (await pool.query(`SELECT * FROM pricing_templates WHERE active = true ORDER BY id LIMIT 1`)).rows[0];
  return row || null;
}
// Build the engine's `cluster` object from a template config + per-deal quantities (+ admin overrides).
function buildClusterForEngine(config, qty, currentInterchange, overrides) {
  const cfg = JSON.parse(JSON.stringify(config));
  if (overrides) {
    if (overrides.rates) for (const k of ['debit','credit','amex']) if (overrides.rates[k]) Object.assign(cfg.rates[k], overrides.rates[k]);
    if (overrides.fixedUnit) Object.assign(cfg.fixedUnit, overrides.fixedUnit);
    if (overrides.costs) Object.assign(cfg.costs, overrides.costs);
  }
  const q = qty || {};
  const u = cfg.fixedUnit;
  return {
    rates: cfg.rates,
    interchange: (overrides && overrides.interchange != null) ? overrides.interchange : currentInterchange,
    fixed: {
      terminalS1F2: { qty: q.terminalS1F2 || 0, unit: u.terminalS1F2 || 0 },
      terminalWired: { qty: q.terminalWired || 0, unit: u.terminalWired || 0 },
      pci:        { qty: q.pci || 0,        unit: u.pci || 0 },
      acctOnFile: { qty: q.acctOnFile || 0, unit: u.acctOnFile || 0 },
      batch:      { qty: q.batch || 0,      unit: u.batch || 0 },
      lte:        { qty: q.lte || 0,        unit: u.lte || 0 },
    },
    costs: cfg.costs,
  };
}

// --- Pricing templates (admin) ---
app.get('/api/savings/templates', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'savings:manage_pricing'))) return;
  try {
    const rows = (await pool.query(`SELECT id, name, is_default, active, config, updated_at FROM pricing_templates ORDER BY is_default DESC, name`)).rows;
    res.json({ templates: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/savings/templates', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'savings:manage_pricing'))) return;
  const name = String(req.body.name || '').trim();
  const config = req.body.config;
  if (!name || !config || !config.rates || !config.fixedUnit || !config.costs) return res.status(400).json({ error: 'name + valid config required' });
  try {
    if (req.body.isDefault) await pool.query(`UPDATE pricing_templates SET is_default = false`);
    const row = (await pool.query(
      `INSERT INTO pricing_templates (name, is_default, active, config) VALUES ($1, $2, true, $3::jsonb) RETURNING id`,
      [name, !!req.body.isDefault, JSON.stringify(config)])).rows[0];
    res.json({ id: row.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/savings/templates/:id', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'savings:manage_pricing'))) return;
  const id = parseInt(req.params.id, 10);
  try {
    if (req.body.isDefault) await pool.query(`UPDATE pricing_templates SET is_default = false`);
    const sets = ['updated_at = NOW()']; const params = []; let i = 1;
    if (req.body.name !== undefined) { sets.push(`name = $${i++}`); params.push(String(req.body.name).trim()); }
    if (req.body.config !== undefined) { sets.push(`config = $${i++}::jsonb`); params.push(JSON.stringify(req.body.config)); }
    if (req.body.active !== undefined) { sets.push(`active = $${i++}`); params.push(!!req.body.active); }
    if (req.body.isDefault !== undefined) { sets.push(`is_default = $${i++}`); params.push(!!req.body.isDefault); }
    params.push(id);
    await pool.query(`UPDATE pricing_templates SET ${sets.join(', ')} WHERE id = $${i}`, params);
    res.json({ updated: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/savings/templates/:id', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'savings:manage_pricing'))) return;
  try { await pool.query(`DELETE FROM pricing_templates WHERE id = $1`, [parseInt(req.params.id, 10)]); res.json({ deleted: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// --- Assignments (admin) ---
app.get('/api/savings/assignments', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'savings:manage_pricing'))) return;
  try { res.json({ assignments: (await pool.query(`SELECT rep_email, template_id FROM pricing_template_assignments ORDER BY rep_email`)).rows }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/savings/assignments', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'savings:manage_pricing'))) return;
  const repEmail = String(req.body.repEmail || '').trim().toLowerCase();
  const templateId = req.body.templateId;
  if (!repEmail) return res.status(400).json({ error: 'repEmail required' });
  try {
    if (templateId == null) { await pool.query(`DELETE FROM pricing_template_assignments WHERE LOWER(rep_email) = $1`, [repEmail]); }
    else {
      await pool.query(
        `INSERT INTO pricing_template_assignments (rep_email, template_id, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (rep_email) DO UPDATE SET template_id = EXCLUDED.template_id, updated_at = NOW()`,
        [repEmail, parseInt(templateId, 10)]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// --- Rep: the pricing template to prefill the Cluster side ---
app.get('/api/savings/my-template', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'savings:use'))) return;
  try {
    const t = await getEffectiveTemplate(req.user.email);
    if (!t) return res.status(404).json({ error: 'no_template' });
    res.json({ templateId: t.id, name: t.name, config: t.config, canOverride: req.user.isAdmin === true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// --- Compute (server recomputes; reps can't change prices, admins may override) ---
app.post('/api/savings/calculate', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'savings:use'))) return;
  try {
    const { volumes, current, clusterQty } = req.body;
    if (!volumes || !current || !current.rates) return res.status(400).json({ error: 'volumes + current required' });
    let t = null;
    if (req.user.isAdmin && req.body.templateId) t = (await pool.query(`SELECT * FROM pricing_templates WHERE id = $1`, [parseInt(req.body.templateId, 10)])).rows[0];
    if (!t) t = await getEffectiveTemplate(req.user.email);
    if (!t) return res.status(404).json({ error: 'no_template' });
    const overrides = req.user.isAdmin === true ? req.body.overrides : null; // price overrides = admin only
    const cluster = buildClusterForEngine(t.config, clusterQty, current.interchange || 0, overrides);
    const results = computeSavingsEngine({ volumes, current, cluster });
    res.json({ templateId: t.id, templateName: t.name, clusterResolved: cluster, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// --- Phase 2: AI statement parsing (upload a competitor PDF → prefill the form) ---
const uploadStatement = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const STATEMENT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    merchantName: { type: 'string' },
    currency: { type: 'string' },
    period: { type: 'string' },
    volumes: {
      type: 'object', additionalProperties: false,
      properties: {
        debit:  { type: 'object', additionalProperties: false, properties: { trx: { type: 'number' }, amount: { type: 'number' } }, required: ['trx', 'amount'] },
        credit: { type: 'object', additionalProperties: false, properties: { trx: { type: 'number' }, amount: { type: 'number' } }, required: ['trx', 'amount'] },
        amex:   { type: 'object', additionalProperties: false, properties: { trx: { type: 'number' }, amount: { type: 'number' } }, required: ['trx', 'amount'] },
      }, required: ['debit', 'credit', 'amex'],
    },
    currentRates: {
      type: 'object', additionalProperties: false,
      properties: {
        debit:  { type: 'object', additionalProperties: false, properties: { ratePct: { type: 'number' }, perTrx: { type: 'number' } }, required: ['ratePct', 'perTrx'] },
        credit: { type: 'object', additionalProperties: false, properties: { ratePct: { type: 'number' }, perTrx: { type: 'number' } }, required: ['ratePct', 'perTrx'] },
        amex:   { type: 'object', additionalProperties: false, properties: { ratePct: { type: 'number' }, perTrx: { type: 'number' } }, required: ['ratePct', 'perTrx'] },
      }, required: ['debit', 'credit', 'amex'],
    },
    interchange: { type: 'number' },
    totalTransactionCharge: { type: 'number' },
    currentFixed: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { label: { type: 'string' }, qty: { type: 'number' }, unit: { type: 'number' } }, required: ['label', 'qty', 'unit'] } },
    statementTotalMonthly: { type: 'number' },
    notes: { type: 'string' },
  },
  required: ['merchantName', 'currency', 'period', 'volumes', 'currentRates', 'interchange', 'totalTransactionCharge', 'currentFixed', 'statementTotalMonthly', 'notes'],
};
const STATEMENT_PROMPT = `You are extracting data from a competitor merchant payment-processing statement (relevé marchand) to feed a savings calculator. The statement may be in French or English, from a Canadian/Québec processor (Moneris, Global Payments, Chase, TD, Square, Stripe, Elavon, Desjardins, etc.).

Extract, as JSON matching the schema:
- merchantName: the business name on the statement.
- currency: e.g. "CAD".
- period: the statement period (e.g. "2026-05" or "May 2026"), as text.
- volumes: monthly transaction COUNT (trx) and dollar AMOUNT for three buckets. BUCKET BY HOW THE CARD IS PRICED, not by card category:
    • debit = ONLY flat per-transaction Interac debit (labels: "Interac", "Interac Flash"/"IF", "IDEBT"). These are charged a flat $/transaction, 0%.
    • credit = Visa + Mastercard + Visa Debit (VCDBT) + UnionPay — i.e. every card charged a PERCENTAGE discount rate. ⚠️ "Visa Debit"/"VCDBT" is a debit card but is charged the % rate, so it goes in CREDIT, never in debit.
    • amex = American Express + Discover.
- currentRates: the processor's MARKUP per bucket from the discount-rate / "Taux d'escompte" table — ratePct = percentage markup AS A PERCENT NUMBER (e.g. 0.15 means 0.15%), perTrx = per-transaction fee in dollars. For debit this is typically 0% + a flat $/trx (e.g. 0.04); for credit/amex typically a % + 0$.
- totalTransactionCharge: the statement's TOTAL card-processing charge that bundles the markup AND interchange together — e.g. the "Frais de service" / "Service charge" / total "discount" amount (as a positive number). MANY statements (Clover, Commerce Control, Global, TD) report the separate "Frais d'interchange"/"Interchange" line as 0 and put everything in this one bundled total. When that is the case, fill totalTransactionCharge with that bundled total and set interchange to 0 — the app derives interchange = totalTransactionCharge − markup, so do NOT also report the bundled total as interchange (that would double-count the markup).
- interchange: ONLY use this when the statement genuinely lists a SEPARATE interchange/card-brand pass-through amount distinct from the markup. Otherwise set 0 and use totalTransactionCharge instead.
- currentFixed: list of fixed/recurring monthly fees (terminal/equipment rental, monthly/statement fee, PCI, account/admin fee) — each {label, qty, unit price}. Capture ALL of them (often under "Autres frais"/"Other fees"); do NOT include per-transaction interchange line items here.
- statementTotalMonthly: the statement's grand total of all fees/charges for the period if shown (for cross-check).
- notes: what you could not determine, assumptions made, and your confidence (write in the statement's language).

Rules: numbers only (no $ or % signs, no minus signs — use positive magnitudes). Use 0 for anything you genuinely cannot find — do NOT invent values.`;

// POST /api/savings/parse-statement — upload a competitor PDF → Claude extracts the inputs.
app.post('/api/savings/parse-statement', authenticateToken, uploadStatement.single('file'), async (req, res) => {
  if (!(await requirePerm(req, res, 'savings:use'))) return;
  if (!req.file) return res.status(400).json({ error: 'file required' });
  const client = getAnthropic();
  if (!client) return res.status(503).json({ error: 'ai_not_configured' });
  try {
    const resp = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 3000,
      thinking: { type: 'adaptive' },
      output_config: { format: { type: 'json_schema', schema: STATEMENT_SCHEMA }, effort: 'medium' },
      messages: [{ role: 'user', content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: req.file.buffer.toString('base64') } },
        { type: 'text', text: STATEMENT_PROMPT },
      ] }],
    });
    if (resp.stop_reason === 'refusal') return res.status(422).json({ error: 'refused' });
    const text = (resp.content.find(b => b.type === 'text') || {}).text || '{}';
    let data; try { data = JSON.parse(text); } catch { return res.status(502).json({ error: 'parse_failed' }); }
    // Derive interchange deterministically when the statement bundles it into a single total
    // charge (e.g. Clover "Frais de service"): interchange = totalTransactionCharge − markup,
    // so markup + interchange equals the real charge instead of double-counting the markup.
    try {
      const v = data.volumes || {}, r = data.currentRates || {};
      const part = (vol, rate) => ((vol?.trx || 0) * (rate?.perTrx || 0)) + ((vol?.amount || 0) * ((rate?.ratePct || 0) / 100));
      const markup = part(v.debit, r.debit) + part(v.credit, r.credit) + part(v.amex, r.amex);
      const total = data.totalTransactionCharge || 0;
      if (total > 0 && total >= markup) {
        data.interchange = Math.round((total - markup) * 100) / 100;
        data.interchangeDerived = true;
      }
    } catch { /* leave model's interchange as-is */ }
    res.json({ extracted: data });
  } catch (e) {
    console.warn('[savings/parse-statement]', e.name, e.message);
    res.status(502).json({ error: 'ai_error', detail: e.message });
  }
});

// --- Saved analyses ---
app.post('/api/savings/analyses', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'savings:use'))) return;
  try {
    const row = (await pool.query(
      `INSERT INTO savings_analyses (rep_email, rep_name, merchant_name, template_id, inputs, results)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb) RETURNING id`,
      [req.user.realAdminEmail || req.user.email || null, req.user.name || null,
       String(req.body.merchantName || '').slice(0, 255), req.body.templateId || null,
       JSON.stringify(req.body.inputs || {}), JSON.stringify(req.body.results || {})])).rows[0];
    res.json({ id: row.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/savings/analyses', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'savings:use'))) return;
  try {
    const all = req.user.isAdmin === true;
    const rows = (await pool.query(
      `SELECT id, rep_email, rep_name, merchant_name, template_id, results, created_at FROM savings_analyses
       ${all ? '' : 'WHERE LOWER(rep_email) = LOWER($1)'} ORDER BY created_at DESC LIMIT 100`,
      all ? [] : [req.user.email || ''])).rows;
    res.json({ analyses: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/savings/analyses/:id', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'savings:use'))) return;
  try {
    const r = (await pool.query(`SELECT * FROM savings_analyses WHERE id = $1`, [parseInt(req.params.id, 10)])).rows[0];
    if (!r) return res.status(404).json({ error: 'not_found' });
    if (req.user.isAdmin !== true && (r.rep_email || '').toLowerCase() !== (req.user.email || '').toLowerCase()) return res.status(403).json({ error: 'forbidden' });
    res.json({ analysis: r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Standalone branded savings offer PDF (client-facing). pdfkit, one page, bilingual.
function buildSavingsPdf({ merchant, lang, results, dateStr }) {
  const fr = lang !== 'en';
  const fmt = new Intl.NumberFormat(fr ? 'fr-CA' : 'en-CA', { style: 'currency', currency: 'CAD' });
  const $ = (n) => fmt.format(n || 0);
  const T = fr ? {
    title: "Analyse d'économies — paiements", prepared: 'Préparé pour', save: "VOS ÉCONOMIES ESTIMÉES", mo: 'par mois', yr: 'par année',
    comp: 'Comparaison mensuelle', cur: 'Processeur actuel', cl: 'Avec Cluster', txn: 'Frais de transaction', fix: 'Frais fixes', tax: 'Taxe', tot: 'Total mensuel',
    disc: "Estimations basées sur le relevé fourni, avant taxes applicables sur certains frais. Montants indicatifs.",
  } : {
    title: 'Payment savings analysis', prepared: 'Prepared for', save: 'YOUR ESTIMATED SAVINGS', mo: 'per month', yr: 'per year',
    comp: 'Monthly comparison', cur: 'Current processor', cl: 'With Cluster', txn: 'Transaction fees', fix: 'Fixed fees', tax: 'Tax', tot: 'Monthly total',
    disc: 'Estimates based on the statement provided, before applicable taxes on certain fees. Indicative figures.',
  };
  const doc = new PDFDocument({ size: 'LETTER', margin: 0 });
  const W = 612, M = 56;
  // Header
  doc.rect(0, 0, W, 92).fill('#0f1722');
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(22).text('Sales Hub', M, 30, { continued: true }).fillColor('#f97316').text('.');
  doc.fillColor('#8a99af').font('Helvetica').fontSize(10).text('by Cluster Systems', M, 60);
  doc.rect(0, 92, W, 4).fill('#f97316');
  // Title + merchant
  doc.fillColor('#0f1722').font('Helvetica-Bold').fontSize(18).text(T.title, M, 124);
  doc.fillColor('#475569').font('Helvetica').fontSize(11).text(`${T.prepared}: ${merchant || '—'}   ·   ${dateStr}`, M, 150);
  // Savings hero
  const hy = 184;
  doc.roundedRect(M, hy, W - 2 * M, 104, 10).fill('#e8f6ef');
  doc.fillColor('#0f6e56').font('Helvetica-Bold').fontSize(11).text(T.save, M, hy + 16, { width: W - 2 * M, align: 'center' });
  doc.fillColor('#0f6e56').font('Helvetica-Bold').fontSize(34).text($(results.savings.monthly), M, hy + 34, { width: W - 2 * M, align: 'center' });
  doc.fillColor('#0f6e56').font('Helvetica').fontSize(12).text(`${T.mo}  ·  ${$(results.savings.yearly)} ${T.yr}`, M, hy + 76, { width: W - 2 * M, align: 'center' });
  // Comparison table
  let y = hy + 140;
  doc.fillColor('#0f1722').font('Helvetica-Bold').fontSize(13).text(T.comp, M, y); y += 26;
  const c1 = M, c2 = 320, c3 = 470, rowH = 26;
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#94a3b8');
  doc.text('', c1, y); doc.text(T.cur, c2, y, { width: 120, align: 'right' }); doc.text(T.cl, c3, y, { width: W - M - c3, align: 'right' });
  y += 20;
  const row = (label, a, b, bold) => {
    doc.moveTo(M, y - 4).lineTo(W - M, y - 4).strokeColor('#eef1f6').stroke();
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 11).fillColor(bold ? '#0f1722' : '#475569');
    doc.text(label, c1, y); doc.text($(a), c2, y, { width: 120, align: 'right' }); doc.text($(b), c3, y, { width: W - M - c3, align: 'right' });
    y += rowH;
  };
  row(T.txn, results.current.txnFees, results.cluster.txnFees);
  row(T.fix, results.current.fixed, results.cluster.fixed);
  row(T.tax, results.current.tax, results.cluster.tax);
  row(T.tot, results.current.total, results.cluster.total, true);
  // Footer
  doc.font('Helvetica').fontSize(9).fillColor('#94a3b8').text(T.disc, M, 720, { width: W - 2 * M });
  doc.fillColor('#94a3b8').fontSize(9).text('saleshub@clustersystems.com  ·  clusterpos.com', M, 752, { width: W - 2 * M, align: 'center' });
  return new Promise((resolve, reject) => { const ch = []; doc.on('data', d => ch.push(d)); doc.on('end', () => resolve(Buffer.concat(ch))); doc.on('error', reject); doc.end(); });
}
// POST /api/savings/pdf — recompute server-side + return the branded offer PDF.
app.post('/api/savings/pdf', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'savings:use'))) return;
  try {
    const { volumes, current, clusterQty, lang } = req.body;
    if (!volumes || !current || !current.rates) return res.status(400).json({ error: 'volumes + current required' });
    let t = null;
    if (req.user.isAdmin && req.body.templateId) t = (await pool.query(`SELECT * FROM pricing_templates WHERE id = $1`, [parseInt(req.body.templateId, 10)])).rows[0];
    if (!t) t = await getEffectiveTemplate(req.user.email);
    if (!t) return res.status(404).json({ error: 'no_template' });
    const overrides = req.user.isAdmin === true ? req.body.overrides : null;
    const cluster = buildClusterForEngine(t.config, clusterQty, current.interchange || 0, overrides);
    const results = computeSavingsEngine({ volumes, current, cluster });
    const buf = await buildSavingsPdf({
      merchant: String(req.body.merchantName || ''), lang,
      results, dateStr: new Date().toLocaleDateString(lang === 'en' ? 'en-CA' : 'fr-CA'),
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="savings-${String(req.body.merchantName || 'offer').replace(/[^a-z0-9]+/gi, '-').slice(0, 40) || 'offer'}.pdf"`);
    res.send(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================================
// DATA HEALTH — "Needs attention" (À corriger): aggregated, count-only signals of
// data that an admin should review/fix (unassigned activations/invoices/merchants,
// reps with no role, unmapped reseller emails). Cached 60s to spare the (remote) DB.
// ============================================================================
let _dataHealthCache = { at: 0, data: null };
async function computeDataHealth() {
  const [resAct, unInv, zenMerch, repsNoRole, unEmails, openReports, unInvList] = await Promise.all([
    // 1. Reseller POS activations resolving to "(unassigned)" — no managed match, no name, no email.
    pool.query(`
      SELECT COUNT(*)::int AS count
      FROM reseller_pos_activations a
      LEFT JOIN LATERAL (
        SELECT r.name FROM resellers r
        WHERE r.emails @> to_jsonb(LOWER(a.reseller_email))
           OR LOWER(r.name) = LOWER(NULLIF(a.reseller_name, ''))
        LIMIT 1
      ) rs ON true
      WHERE COALESCE(rs.name, NULLIF(a.reseller_name, ''), NULLIF(a.reseller_email, '')) IS NULL`),
    // 2. Invoices with commission but salesperson = 'Unassigned' (from 2026-01-01 onward).
    pool.query(`
      SELECT COUNT(*)::int AS count, COALESCE(SUM(commission), 0)::float AS total_commission
      FROM invoices WHERE salesperson_name = 'Unassigned' AND commission > 0
        AND date >= '2026-01-01'`),
    // 3. Active Zentact merchants with no rep and not reseller-boarded.
    pool.query(`
      SELECT COUNT(*)::int AS count FROM zentact_merchants
      WHERE status = 'ACTIVE'
        AND (sales_rep_name IS NULL OR sales_rep_name = '')
        AND (reseller_attribute IS NULL OR reseller_attribute = '')`),
    // 4. Active salespeople with no resolvable role (no login email, or email with no role).
    pool.query(`
      WITH rep_email AS (
        SELECT s.name,
               COALESCE((SELECT email FROM user_tokens WHERE LOWER(display_name) = LOWER(s.name) LIMIT 1), s.email) AS email
        FROM salespeople s WHERE s.is_active = true
      )
      SELECT COUNT(*)::int AS count, COALESCE(json_agg(name ORDER BY name), '[]'::json) AS names
      FROM rep_email re
      WHERE (re.email IS NULL OR re.email = '')
         OR NOT EXISTS (SELECT 1 FROM user_roles ur WHERE LOWER(ur.user_email) = LOWER(re.email))`),
    // 5. Reseller emails seen in activations but not mapped to any managed reseller.
    pool.query(`
      SELECT COUNT(DISTINCT LOWER(a.reseller_email))::int AS count
      FROM reseller_pos_activations a
      WHERE a.reseller_email IS NOT NULL AND a.reseller_email <> ''
        AND NOT EXISTS (SELECT 1 FROM resellers rs WHERE rs.emails @> to_jsonb(LOWER(a.reseller_email)))`),
    // 6. Open user-submitted reports (missing commission / missing points) — full list so
    //    the page can show + resolve them inline.
    pool.query(`
      SELECT id, report_type, reporter_email, reporter_name, reference, period, message, created_at
      FROM user_reports WHERE status = 'open' ORDER BY created_at DESC LIMIT 100`),
    // 7. The actual unassigned-invoice rows (so the page can list them, not just count).
    pool.query(`
      SELECT invoice_number, customer_name, commission::float AS commission, date::date AS date
      FROM invoices WHERE salesperson_name = 'Unassigned' AND commission > 0 AND date >= '2026-01-01'
      ORDER BY commission DESC LIMIT 100`),
  ]);
  const issues = {
    unassignedResellerActivations: resAct.rows[0].count,
    unassignedInvoices: { count: unInv.rows[0].count, totalCommission: unInv.rows[0].total_commission, items: unInvList.rows },
    unassignedZentactMerchants: zenMerch.rows[0].count,
    repsNoRole: { count: repsNoRole.rows[0].count, names: repsNoRole.rows[0].names },
    unmappedResellerEmails: unEmails.rows[0].count,
    userReports: { count: openReports.rows.length, items: openReports.rows },
  };
  const totalIssues = issues.unassignedResellerActivations + issues.unassignedInvoices.count
    + issues.unassignedZentactMerchants + issues.repsNoRole.count + issues.unmappedResellerEmails
    + issues.userReports.count;
  return { totalIssues, issues, generatedAt: new Date().toISOString() };
}
// GET /api/admin/data-health — the "À corriger" aggregate (?fresh=1 bypasses the 60s cache).
app.get('/api/admin/data-health', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'admin:data_health'))) return;
  try {
    if (req.query.fresh !== '1' && _dataHealthCache.data && (Date.now() - _dataHealthCache.at) < 60000) {
      return res.json({ ..._dataHealthCache.data, cached: true });
    }
    const data = await computeDataHealth();
    _dataHealthCache = { at: Date.now(), data };
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Recipients for the missing-commission / missing-points notification emails. Configured in
// app_settings key 'report_recipients'; empty → falls back to all admins (+ SMTP_FROM).
async function getReportRecipients() {
  try {
    const r = await pool.query(`SELECT value FROM app_settings WHERE key = 'report_recipients'`);
    const v = r.rows[0]?.value;
    return Array.isArray(v) ? v.filter(e => typeof e === 'string') : [];
  } catch { return []; }
}
// GET /api/admin/report-recipients — the configured recipient list (empty = all admins).
app.get('/api/admin/report-recipients', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'admin:data_health'))) return;
  try { res.json({ recipients: await getReportRecipients() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// PUT /api/admin/report-recipients { emails:[...] } — set who gets missing commission/points emails.
app.put('/api/admin/report-recipients', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'admin:data_health'))) return;
  const emails = Array.isArray(req.body?.emails) ? req.body.emails.map(e => String(e).trim().toLowerCase()).filter(Boolean) : null;
  if (!emails) return res.status(400).json({ error: 'emails array required' });
  if (emails.some(e => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))) return res.status(400).json({ error: 'invalid email' });
  try {
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('report_recipients', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify(emails)]
    );
    res.json({ recipients: emails });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/user-reports/:id/resolve — mark a user report (missing commission/points) resolved.
app.post('/api/admin/user-reports/:id/resolve', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'admin:data_health'))) return;
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    await pool.query(
      `UPDATE user_reports SET status = 'resolved', resolved_at = NOW(), resolved_by = $2 WHERE id = $1`,
      [id, req.user.email || req.user.name || 'admin']
    );
    _dataHealthCache = { at: 0, data: null };
    res.json({ resolved: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Build a lowercased key → canonical-reseller-name map from [{name, zentact_key, name_aliases}].
// A Zentact merchant's sales_rep_name / "Reseller" attribute matches a reseller by any of its
// zentact_key(s), its own name, OR any configured name alias (e.g. "Lirette" → "Lirette MG").
function buildResellerKeyMap(resellers) {
  const map = new Map();
  for (const rs of resellers) {
    for (const k of String(rs.zentact_key || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)) {
      map.set(k, rs.name);
    }
    const nk = String(rs.name || '').trim().toLowerCase();
    if (nk && !map.has(nk)) map.set(nk, rs.name);
    for (const al of (Array.isArray(rs.name_aliases) ? rs.name_aliases : [])) {
      const ak = String(al || '').trim().toLowerCase();
      if (ak && !map.has(ak)) map.set(ak, rs.name);
    }
  }
  return map;
}

// GET /api/resellers/residuals — a reseller's Zentact SALES (merchants they activated),
// matched by the reseller's zentact_key against zentact_merchants.sales_rep_name
// (comma-separated, case-insensitive). Resellers don't get bonuses — this is their sales.
app.get('/api/resellers/residuals', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'reseller:view'))) return;
  try {
    // All resellers: matched by their zentact_key (sales_rep_name) AND/OR by name
    // against the Zentact "Reseller" custom attribute, so a reseller links even
    // before an admin sets its zentact_key.
    const resellers = (await pool.query(`SELECT name, zentact_key, name_aliases FROM resellers`)).rows;
    const merchants = (await pool.query(
      `SELECT zm.business_name, zm.status, zm.activated_at,
              LOWER(zm.sales_rep_name)     AS rep,
              LOWER(zm.reseller_attribute) AS reseller_attr,
              COALESCE(rev.profit_cents, 0) AS profit_cents
       FROM zentact_merchants zm
       LEFT JOIN (
         SELECT merchant_account_id, SUM(transaction_profit_cents) AS profit_cents
         FROM zentact_merchant_revenue GROUP BY merchant_account_id
       ) rev ON rev.merchant_account_id = zm.merchant_account_id
       WHERE (zm.sales_rep_name IS NOT NULL AND zm.sales_rep_name <> '')
          OR (zm.reseller_attribute IS NOT NULL AND zm.reseller_attribute <> '')`
    )).rows;

    // Match by sales_rep_name / "Reseller" attribute → canonical reseller (zentact_key, name, or alias).
    const keyToReseller = buildResellerKeyMap(resellers);

    const detail = [];
    const agg = new Map(); // reseller → { merchants, active, profit_cents }
    for (const m of merchants) {
      // Match by sales_rep_name first, then by the Reseller custom attribute.
      const reseller = keyToReseller.get(m.rep) || keyToReseller.get(m.reseller_attr);
      if (!reseller) continue; // not linked to a managed reseller (internal vendor / unmapped)
      const profit = Number(m.profit_cents) / 100;
      detail.push({ reseller_name: reseller, business_name: m.business_name, status: m.status, activated_at: m.activated_at, transaction_profit: profit });
      const a = agg.get(reseller) || { merchants: 0, active: 0, profit_cents: 0 };
      a.merchants++; if (m.status === 'ACTIVE') a.active++; a.profit_cents += Number(m.profit_cents) || 0;
      agg.set(reseller, a);
    }
    const byReseller = [...agg.entries()].map(([reseller_name, v]) => ({
      reseller_name, merchants: v.merchants, active: v.active, transaction_profit: v.profit_cents / 100,
    })).sort((a, b) => b.merchants - a.merchants);
    detail.sort((a, b) => new Date(b.activated_at || 0) - new Date(a.activated_at || 0));

    res.json({ connected: true, source: 'zentact', byReseller, sales: detail.slice(0, 2000), linkedResellers: resellers.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/zentact/revenue?year=YYYY — per-merchant monthly Transaction Profit for a
// year, with the salesperson and resolved reseller attached. Feeds the Revenus page
// (client filters by month + aggregates by rep / reseller).
app.get('/api/zentact/revenue', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'revenue:view'))) return;
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    // Reseller resolution map (same rules as /api/resellers/residuals).
    const resellers = (await pool.query(`SELECT name, zentact_key, name_aliases FROM resellers`)).rows;
    const keyToReseller = buildResellerKeyMap(resellers);
    const rows = (await pool.query(
      `SELECT r.merchant_account_id, r.month, r.transaction_profit_cents, r.total_volume_cents,
              r.other_revenue_cents, r.payments_count, r.currency, zm.business_name, zm.sales_rep_name,
              zm.stores, LOWER(zm.sales_rep_name) AS rep_l, LOWER(zm.reseller_attribute) AS reseller_attr_l
       FROM zentact_merchant_revenue r
       LEFT JOIN zentact_merchants zm ON zm.merchant_account_id = r.merchant_account_id
       WHERE r.year = $1`,
      [year]
    )).rows;
    const out = rows.map((r) => ({
      merchant_account_id: r.merchant_account_id,
      business_name: r.business_name || r.merchant_account_id,
      sales_rep_name: r.sales_rep_name || null,
      reseller_name: keyToReseller.get(r.rep_l) || keyToReseller.get(r.reseller_attr_l) || null,
      month: r.month,
      transaction_profit: Number(r.transaction_profit_cents) / 100,
      other_revenue: r.other_revenue_cents == null ? 0 : Number(r.other_revenue_cents) / 100,
      volume: Number(r.total_volume_cents) / 100,
      payments_count: r.payments_count,
      currency: r.currency,
      // Stores (locations) under this merchant — { storeId, storeReferenceId }.
      // Revenue is merchant-level (no per-store breakdown from Zentact); this is
      // for display so a multi-location merchant shows all its store names.
      stores: Array.isArray(r.stores)
        ? r.stores.map((s) => ({ storeId: s.storeId, storeReferenceId: s.storeReferenceId }))
        : [],
    }));
    const years = (await pool.query(`SELECT DISTINCT year FROM zentact_merchant_revenue ORDER BY year DESC`)).rows.map((x) => x.year);
    res.json({ year, years, rows: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/resellers/zentact-names — distinct Zentact sales_rep_names (+ merchant counts) to
// help the admin pick a reseller's zentact_key in the management tool.
app.get('/api/resellers/zentact-names', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'reseller:view'))) return;
  try {
    const r = await pool.query(
      `SELECT sales_rep_name AS name, COUNT(*)::int AS merchants
       FROM zentact_merchants WHERE sales_rep_name IS NOT NULL AND sales_rep_name <> ''
       GROUP BY 1 ORDER BY merchants DESC`
    );
    res.json({ names: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/commission-imports — history of all imports
app.get('/api/admin/commission-imports', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'report:mark_paid'))) return;
  try {
    const r = await pool.query(
      `SELECT * FROM commission_payment_imports ORDER BY imported_at DESC LIMIT 200`
    );
    res.json({ imports: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/commission-imports/:id — full pay-stub detail (invoice lines + bonuses).
app.get('/api/admin/commission-imports/:id', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'report:mark_paid'))) return;
  const id = parseInt(req.params.id);
  try {
    const imp = (await pool.query(`SELECT * FROM commission_payment_imports WHERE id = $1`, [id])).rows[0];
    if (!imp) return res.status(404).json({ error: 'Import not found' });
    const lines = (await pool.query(
      `SELECT invoice_number, customer, paid_amount::float AS paid_amount, app_commission::float AS app_commission, not_in_db
       FROM commission_payment_lines WHERE import_id = $1 ORDER BY not_in_db ASC, paid_amount DESC`,
      [id]
    )).rows;
    const bonuses = (await pool.query(
      `SELECT bonus_type, merchant_name, amount::float AS amount, report_date::date AS report_date
       FROM commission_bonuses WHERE import_id = $1 ORDER BY bonus_type, amount DESC`,
      [id]
    )).rows;
    res.json({ import: imp, lines, bonuses });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Disabled report years ──────────────────────────────────────────────────
// Admin can hide past years (e.g. 2025) from the Commission Report — the year
// dropdown and the coverage matrix drop them. Cached 60s per dyno (Railway RTT).
let _disabledYearsCache = { at: 0, years: [] };
async function getDisabledReportYears() {
  if (Date.now() - _disabledYearsCache.at < 60_000) return _disabledYearsCache.years;
  let years = [];
  try {
    const r = await pool.query(`SELECT value FROM app_settings WHERE key = 'disabled_report_years'`);
    const v = r.rows[0]?.value;
    if (Array.isArray(v)) years = v.map(Number).filter(Number.isInteger);
  } catch (_e) { /* table may not exist yet on first boot — treat as none */ }
  _disabledYearsCache = { at: Date.now(), years };
  return years;
}

// Visible to any authenticated user — the report UI hides these years.
app.get('/api/settings/report-years', authenticateToken, async (_req, res) => {
  res.json({ disabledYears: await getDisabledReportYears() });
});

// PUT {disabledYears:[2025]} — toggle lives in Admin → Import Commissions.
app.put('/api/admin/report-years', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'report:mark_paid'))) return;
  const input = req.body?.disabledYears;
  if (!Array.isArray(input)) return res.status(400).json({ error: 'disabledYears array required' });
  const years = [...new Set(input.map(Number))].sort();
  if (years.some(y => !Number.isInteger(y) || y < 2025 || y > 2100)) {
    return res.status(400).json({ error: 'invalid year' });
  }
  if (years.includes(new Date().getFullYear())) {
    return res.status(400).json({ error: 'cannot disable the current year' });
  }
  try {
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ('disabled_report_years', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify(years)]
    );
    _disabledYearsCache = { at: Date.now(), years };
    res.json({ disabledYears: years });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/commission-imports/coverage/matrix — rep × month reconciliation grid.
// For every month since Jan 2025: what was paid via imports (file or app-generated commit)
// and how much earned commission is still UNPAID per the app's model. Lets the user spot
// at a glance which pay files are missing (report era ≤ Apr 2026) and which platform
// periods (May 2026+) haven't been committed yet.
app.get('/api/admin/commission-imports/coverage/matrix', (req, res, next) => {
  // Shared-secret bypass (same as rep-customers/db-stats) so reconciliation state
  // can be audited without a session.
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (process.env.ZOHO_WEBHOOK_SECRET && provided === process.env.ZOHO_WEBHOOK_SECRET) {
    req.viaSecret = true;
    return next();
  }
  return authenticateToken(req, res, next);
}, async (req, res) => {
  if (!req.viaSecret && !(await requirePerm(req, res, 'report:mark_paid'))) return;
  try {
    // Months from 2025-01 through the current month (minus admin-disabled years)
    const disabledYears = await getDisabledReportYears();
    const months = [];
    const now = new Date();
    for (let d = new Date('2025-01-01T00:00:00Z'); d <= now; d.setUTCMonth(d.getUTCMonth() + 1)) {
      if (!disabledYears.includes(d.getUTCFullYear())) months.push(d.toISOString().slice(0, 7));
    }

    const [repsRes, importsRes, unpaidRes] = await Promise.all([
      pool.query(
        `SELECT DISTINCT name FROM (
           SELECT name FROM salespeople WHERE is_active = true
           UNION SELECT DISTINCT rep_name FROM commission_payment_imports
         ) t ORDER BY name`
      ),
      pool.query(
        `SELECT rep_name, to_char(paid_for_period, 'YYYY-MM') AS ym,
                SUM(total_amount)::float AS total,
                SUM(invoices_marked)::int AS invoices,
                BOOL_OR(filename NOT LIKE 'app-generated%') AS has_file,
                BOOL_OR(filename LIKE 'app-generated%')     AS has_app
         FROM commission_payment_imports GROUP BY 1, 2`
      ),
      pool.query(
        `SELECT salesperson_name AS rep, to_char(commission_payable_date, 'YYYY-MM') AS ym,
                COUNT(*)::int AS cnt, COALESCE(SUM(commission), 0)::float AS amt
         FROM invoices
         WHERE organization_id = $1 AND commission > 0
           AND commission_status IN ('hardware','saas_first','saas_annual')
           AND approval_status <> 'paid'
           AND commission_payable_date >= '2025-01-01'::date
         GROUP BY 1, 2`,
        [process.env.ZOHO_ORG_ID]
      ),
    ]);

    const impMap = new Map(importsRes.rows.map(r => [`${r.rep_name}|${r.ym}`, r]));
    const unpMap = new Map(unpaidRes.rows.map(r => [`${r.rep}|${r.ym}`, r]));

    const rows = [];
    for (const { name } of repsRes.rows) {
      const cells = {};
      let totalPaid = 0, totalUnpaid = 0, hasAny = false;
      for (const ym of months) {
        const imp = impMap.get(`${name}|${ym}`);
        const unp = unpMap.get(`${name}|${ym}`);
        const cell = {
          importTotal: imp ? imp.total : null,
          source:      imp ? (imp.has_file && imp.has_app ? 'both' : (imp.has_app ? 'app' : 'file')) : null,
          unpaid:      unp ? unp.amt : 0,
          unpaidCount: unp ? unp.cnt : 0,
        };
        if (imp || (unp && unp.amt > 0)) hasAny = true;
        totalPaid   += imp ? imp.total : 0;
        totalUnpaid += unp ? unp.amt : 0;
        cells[ym] = cell;
      }
      // Skip all-empty rows (active reps with no imports and nothing earned-unpaid)
      if (!hasAny) continue;
      rows.push({
        rep: name,
        cells,
        totalPaid:   Math.round(totalPaid * 100) / 100,
        totalUnpaid: Math.round(totalUnpaid * 100) / 100,
      });
    }
    // Biggest reconciliation gaps first
    rows.sort((a, b) => b.totalUnpaid - a.totalUnpaid);

    res.json({ months, rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/webhooks/log?secret=<shared>&invoice=<optional>&limit=<optional>
// Returns the last N rows of webhook_log so we can audit incoming calls without
// needing Heroku log access. Gated by the same shared secret as the webhook.
app.get('/api/webhooks/log', async (req, res) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (!process.env.ZOHO_WEBHOOK_SECRET || provided !== process.env.ZOHO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid secret' });
  }
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const invoice = (req.query.invoice || '').trim() || null;
  try {
    const rows = invoice
      ? (await pool.query(
          `SELECT id, received_at, invoice_number, event, action, result, user_agent, source_ip
           FROM webhook_log WHERE invoice_number = $1
           ORDER BY received_at DESC LIMIT $2`,
          [invoice, limit]
        )).rows
      : (await pool.query(
          `SELECT id, received_at, invoice_number, event, action, result, user_agent, source_ip
           FROM webhook_log
           ORDER BY received_at DESC LIMIT $1`,
          [limit]
        )).rows;
    return res.json({ count: rows.length, rows });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Delta poll — fetch invoices modified since the last delta sync.
// We rely on sorting by last_modified_time DESC and walking pages until we hit
// invoices older than our cutoff. That works regardless of which filter param
// Zoho's API version exposes for the timestamp.
async function deltaSyncInvoices() {
  try {
    // Read last sync time. Default to now - 10 min on first run so we catch
    // anything recent without trying to backfill the whole history.
    const lastRow = (await pool.query(
      `SELECT value FROM sync_state WHERE key = 'invoices_delta_last_sync'`
    )).rows[0];
    const cutoff = lastRow?.value
      ? new Date(lastRow.value)
      : new Date(Date.now() - 10 * 60 * 1000);

    const adminResult = await pool.query(
      'SELECT email, access_token, refresh_token, api_domain, expires_at FROM user_tokens WHERE is_admin = true ORDER BY updated_at DESC LIMIT 1'
    );
    let admin = adminResult.rows[0];
    if (!admin) return; // no admin connected → skip silently
    // Refresh token if expired
    if (admin.refresh_token && (!admin.expires_at || Date.now() > admin.expires_at - 60_000)) {
      try {
        const r = await axios.post(
          'https://accounts.zoho.com/oauth/v2/token',
          new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: process.env.ZOHO_CLIENT_ID,
            client_secret: process.env.ZOHO_CLIENT_SECRET,
            refresh_token: admin.refresh_token,
          }),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
        admin.access_token = r.data.access_token;
        await pool.query(
          `UPDATE user_tokens SET access_token = $1, expires_at = $2, updated_at = CURRENT_TIMESTAMP WHERE email = $3`,
          [admin.access_token, Date.now() + (parseInt(r.data.expires_in) || 3600) * 1000, admin.email]
        );
      } catch (e) {
        console.warn('[DELTA] token refresh failed:', e.message);
        return;
      }
    }

    // Walk pages sorted by last_modified_time DESC; stop as soon as a page
    // contains an invoice older than the cutoff.
    let page = 1;
    let processed = 0;
    let done = false;
    const newest = { time: cutoff }; // track newest seen so we can update cutoff
    while (!done && page < 10) { // hard cap pages to avoid runaway
      const r = await axios.get(`${admin.api_domain}/books/v3/invoices`, {
        params: {
          organization_id: process.env.ZOHO_ORG_ID,
          per_page: 50,
          page,
          sort_column: 'last_modified_time',
          sort_order: 'D',
        },
        headers: { Authorization: `Zoho-oauthtoken ${admin.access_token}` },
        validateStatus: () => true,
      });
      if (r.status !== 200) {
        console.warn(`[DELTA] page ${page} → HTTP ${r.status}`);
        break;
      }
      const rows = r.data?.invoices || [];
      for (const inv of rows) {
        const mt = new Date(inv.last_modified_time || inv.last_modified_date || 0);
        if (mt > newest.time) newest.time = mt;
        if (mt <= cutoff) { done = true; break; }
        // Only sync statuses we care about — skip drafts / sent
        if (['paid', 'overdue', 'partially_paid', 'void'].includes(inv.status)) {
          await upsertInvoiceFromZoho(inv);
          processed++;
        }
      }
      if (rows.length < 50) break; // no more pages
      if (!r.data?.page_context?.has_more_page) break;
      page++;
    }

    // Persist cutoff for next run
    await pool.query(
      `INSERT INTO sync_state (key, value, updated_at) VALUES ('invoices_delta_last_sync', $1, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = CURRENT_TIMESTAMP`,
      [newest.time.toISOString()]
    );

    if (processed > 0) {
      console.log(`[DELTA] synced ${processed} modified invoices (cutoff: ${cutoff.toISOString()})`);
    }
  } catch (e) {
    console.error('[DELTA] error:', e.message);
  }
}

// POST /api/invoices/:invoiceNumber/email
// Body: { recipientEmail, subject?, body? }
// Sends the invoice (with the org-default PDF attached) to the given email
// address via Zoho Books' built-in invoice email endpoint.
app.post('/api/invoices/:invoiceNumber/email', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'invoices:send_email'))) return;
  const { recipientEmail, subject, body } = req.body;
  if (!recipientEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
    return res.status(400).json({ error: 'Valid recipientEmail required' });
  }
  try {
    const { accessToken, apiDomain } = await getAdminBooksAuth();
    const zohoId = await resolveInvoiceIdViaZoho(req.params.invoiceNumber, accessToken, apiDomain);
    if (!zohoId) return res.status(404).json({ error: 'Invoice not found in Zoho Books' });

    const r = await axios.post(
      `${apiDomain}/books/v3/invoices/${zohoId}/email`,
      {
        send_from_org_email_id: true,
        to_mail_ids: [recipientEmail],
        subject: subject || `Invoice ${req.params.invoiceNumber}`,
        body: body || `Hello,\n\nPlease find attached invoice ${req.params.invoiceNumber}.\n\nThank you.`,
      },
      {
        params: { organization_id: process.env.ZOHO_ORG_ID },
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          'Content-Type': 'application/json',
        },
        validateStatus: () => true,
      }
    );
    if (r.status >= 200 && r.status < 300) {
      return res.json({ success: true, sentTo: recipientEmail });
    }
    console.warn(`Zoho email send → HTTP ${r.status}:`, JSON.stringify(r.data).slice(0, 300));
    return res.status(r.status).json({
      error: 'Zoho rejected the email request',
      details: r.data?.message || r.data,
    });
  } catch (e) {
    console.error('Invoice email error:', e.message);
    res.status(500).json({ error: 'Failed to send invoice email', details: e.message });
  }
});

// ============================================================================
// SALESPEOPLE
// ============================================================================

// GET /api/salespeople — names for dropdown filters
app.get('/api/salespeople', authenticateToken, async (req, res) => {
  // By default returns ACTIVE salespeople only. Add ?includeInactive=true to get all.
  const includeInactive = req.query.includeInactive === 'true';
  try {
    const where = includeInactive ? '' : 'WHERE is_active = true';
    const spResult = await pool.query(`SELECT name FROM salespeople ${where} ORDER BY name`);
    if (spResult.rows.length > 0) {
      return res.json({ salespeople: spResult.rows.map(r => r.name) });
    }
    // Fallback: pull from invoices if salespeople table is empty
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
    // Auto-register reps from invoices as INACTIVE (admin activates the real ones).
    await pool.query(`
      INSERT INTO salespeople (name, is_active)
      SELECT DISTINCT salesperson_name, false FROM invoices
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
      `SELECT s.name, s.is_active, s.commission_rate, s.base_salary, s.invoice_count, s.aliases,
              s.signup_bonus_amount, s.signup_bonus_enabled, s.monthly_quota, s.team_id, s.email,
              s.hire_date, s.quota_gate_enabled, s.processing_bonus_enabled, s.annual_bonus_enabled, t.name AS team_name,
              (SELECT ut.email FROM user_tokens ut WHERE LOWER(ut.display_name) = LOWER(s.name) LIMIT 1) AS resolved_login_email
       FROM salespeople s LEFT JOIN teams t ON t.id = s.team_id
       ORDER BY s.name`
    );
    res.json({
      salespeople: result.rows.map(r => ({
        name:               r.name,
        email:              r.email || null,
        isActive:           r.is_active,
        commissionRate:     parseFloat(r.commission_rate) || 10,
        baseSalary:         parseFloat(r.base_salary)     || 0,
        invoiceCount:       parseInt(r.invoice_count)     || 0,
        aliases:            Array.isArray(r.aliases) ? r.aliases : [],
        signupBonusAmount:  r.signup_bonus_amount == null ? 100 : parseFloat(r.signup_bonus_amount),
        signupBonusEnabled: r.signup_bonus_enabled !== false,
        monthlyQuota:       r.monthly_quota == null ? null : parseInt(r.monthly_quota),
        hireDate:           r.hire_date ? new Date(r.hire_date).toISOString().slice(0, 10) : null,
        quotaGateEnabled:   r.quota_gate_enabled !== false,
        processingBonusEnabled: r.processing_bonus_enabled !== false,
        annualBonusEnabled: r.annual_bonus_enabled !== false,
        resolvedLoginEmail: r.resolved_login_email || null,  // actual Zoho login (by name) when no manual override
        teamId:             r.team_id || null,
        teamName:           r.team_name || null,
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

// PUT /api/salespeople/:name/quota — set a per-rep monthly quota (null/empty = use default)
app.put('/api/salespeople/:name/quota', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  const q = req.body.quota == null || req.body.quota === '' ? null : parseInt(req.body.quota);
  try {
    const r = await pool.query(
      `UPDATE salespeople SET monthly_quota = $1, updated_at = CURRENT_TIMESTAMP WHERE name = $2 RETURNING name`,
      [q, req.params.name]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Salesperson not found' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update quota', details: error.message });
  }
});

// PUT /api/salespeople/:name/hire-date — drives the 90-day quota-gate ramp (null clears).
app.put('/api/salespeople/:name/hire-date', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  const raw = (req.body.hireDate || '').trim();
  if (raw && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return res.status(400).json({ error: 'Invalid date (YYYY-MM-DD)' });
  try {
    const r = await pool.query(
      `UPDATE salespeople SET hire_date = $1::date, updated_at = CURRENT_TIMESTAMP WHERE name = $2 RETURNING name`,
      [raw || null, req.params.name]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Salesperson not found' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update hire date', details: error.message });
  }
});

// PUT /api/salespeople/:name/quota-gate — exempt a rep from the plan v7.7 quota gate.
app.put('/api/salespeople/:name/quota-gate', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  const enabled = req.body.enabled !== false;
  try {
    const r = await pool.query(
      `UPDATE salespeople SET quota_gate_enabled = $1, updated_at = CURRENT_TIMESTAMP WHERE name = $2 RETURNING name`,
      [enabled, req.params.name]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Salesperson not found' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update quota gate', details: error.message });
  }
});

// PUT /api/salespeople/:name/processing-bonus — exclude an active rep from the bi-annual
// processing/volume bonus (enabled=false). Inactive reps are already excluded entirely.
app.put('/api/salespeople/:name/processing-bonus', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  const enabled = req.body.enabled !== false;
  try {
    const r = await pool.query(
      `UPDATE salespeople SET processing_bonus_enabled = $1, updated_at = CURRENT_TIMESTAMP WHERE name = $2 RETURNING name`,
      [enabled, req.params.name]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Salesperson not found' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update processing bonus', details: error.message });
  }
});

// PUT /api/salespeople/:name/annual-bonus — exclude a rep from the year-end annual bonus.
app.put('/api/salespeople/:name/annual-bonus', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  const enabled = req.body.enabled !== false;
  try {
    const r = await pool.query(
      `UPDATE salespeople SET annual_bonus_enabled = $1, updated_at = CURRENT_TIMESTAMP WHERE name = $2 RETURNING name`,
      [enabled, req.params.name]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Salesperson not found' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update annual bonus', details: error.message });
  }
});

// GET /api/bonus-tiers — current monthly + annual bonus tiers (config).
app.get('/api/bonus-tiers', authenticateToken, async (req, res) => {
  try {
    const rows = (await pool.query(`SELECT kind, points::int, bonus::float FROM bonus_tiers ORDER BY points DESC`)).rows;
    res.json({
      monthly: rows.filter(r => r.kind === 'monthly').map(r => ({ points: r.points, bonus: r.bonus })),
      annual:  rows.filter(r => r.kind === 'annual').map(r => ({ points: r.points, bonus: r.bonus })),
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// PUT /api/bonus-tiers { monthly:[{points,bonus}], annual:[...] } — replace all tiers (admin).
app.put('/api/bonus-tiers', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  const clean = (arr) => (Array.isArray(arr) ? arr : [])
    .map(t => ({ points: parseInt(t.points), bonus: parseFloat(t.bonus) }))
    .filter(t => Number.isFinite(t.points) && Number.isFinite(t.bonus) && t.points > 0 && t.bonus >= 0);
  const monthly = clean(req.body.monthly), annual = clean(req.body.annual);
  try {
    await pool.query('BEGIN');
    await pool.query(`DELETE FROM bonus_tiers`);
    for (const t of monthly) await pool.query(`INSERT INTO bonus_tiers (kind, points, bonus) VALUES ('monthly', $1, $2)`, [t.points, t.bonus]);
    for (const t of annual)  await pool.query(`INSERT INTO bonus_tiers (kind, points, bonus) VALUES ('annual',  $1, $2)`, [t.points, t.bonus]);
    await pool.query('COMMIT');
    await refreshBonusTiers();
    res.json({ success: true, monthly: monthly.length, annual: annual.length });
  } catch (error) {
    await pool.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// RESOURCES — sales document library (files stored in-DB, RBAC-gated)
// ============================================================================
const uploadResource = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } }); // 25 MB

const parseTags = (raw) => {
  if (Array.isArray(raw)) return raw.map(s => String(s).trim()).filter(Boolean);
  return String(raw || '').split(',').map(s => s.trim()).filter(Boolean);
};

const logResourceAudit = async (action, r, actor) => {
  try {
    await pool.query(
      `INSERT INTO resource_audit (action, resource_id, title, file_name, category, actor) VALUES ($1,$2,$3,$4,$5,$6)`,
      [action, r.id || null, r.title || null, r.file_name || null, r.category || null, actor]);
  } catch (_e) { /* never block the main action on logging */ }
};

// Configurable storage quota for the resources library.
async function getResourcesLimit() {
  try {
    const v = parseInt((await pool.query(`SELECT value FROM app_settings WHERE key = 'resources_storage_limit_bytes'`)).rows[0]?.value);
    return Number.isFinite(v) && v > 0 ? v : null; // null = unlimited
  } catch { return null; }
}
async function getResourcesUsed() {
  return parseInt((await pool.query(`SELECT COALESCE(SUM(file_size),0)::bigint AS b FROM resources`)).rows[0].b) || 0;
}
async function getUserStorageLimit(email) {
  if (!email) return null;
  try {
    const v = (await pool.query(`SELECT limit_bytes FROM user_storage_limits WHERE LOWER(email)=LOWER($1)`, [email])).rows[0]?.limit_bytes;
    const n = parseInt(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}
// Most generous storage limit among the email's assigned roles (null = no role cap).
async function getRoleStorageLimit(email) {
  if (!email) return null;
  try {
    const v = (await pool.query(`
      SELECT MAX(rsl.limit_bytes) AS b
        FROM user_roles ur
        JOIN role_storage_limits rsl ON rsl.role_id = ur.role_id
       WHERE LOWER(ur.user_email) = LOWER($1)`, [email])).rows[0]?.b;
    const n = parseInt(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}
// A user's effective personal cap: explicit per-user limit wins, else the role-derived cap.
async function getEffectiveUserLimit(email) {
  const u = await getUserStorageLimit(email);
  if (u != null) return u;
  return await getRoleStorageLimit(email);
}
async function getUserStorageUsed(email) {
  if (!email) return 0;
  return parseInt((await pool.query(`SELECT COALESCE(SUM(file_size),0)::bigint AS b FROM resources WHERE LOWER(uploaded_by)=LOWER($1)`, [email])).rows[0].b) || 0;
}
const GB_ = 1073741824;
// Returns true if the upload fits BOTH the global cap and the uploader's personal cap;
// otherwise sends a 413 and returns false.
async function ensureResourceRoom(res, addBytes, uploaderEmail) {
  const limit = await getResourcesLimit();
  if (limit != null && (await getResourcesUsed()) + addBytes > limit) {
    res.status(413).json({ error: `Library storage limit reached (${(limit / GB_).toFixed(1)} GB cap). Delete files or raise the limit in Admin → Resources.` });
    return false;
  }
  const userLimit = await getEffectiveUserLimit(uploaderEmail);
  if (userLimit != null && (await getUserStorageUsed(uploaderEmail)) + addBytes > userLimit) {
    res.status(413).json({ error: `Your personal storage limit is reached (${(userLimit / GB_).toFixed(1)} GB). Ask an admin to raise it.` });
    return false;
  }
  return true;
}

// Two zones: the shared/common library (owner_email IS NULL) and each user's private
// "My files" (owner_email = their email). Helpers below keep the scoping in one place.
const resourceZone = (req) => (String(req.query.zone || req.body?.zone || 'shared').toLowerCase() === 'personal' ? 'personal' : 'shared');
const resourceMe = (req) => (req.user.realAdminEmail || req.user.email || '').toLowerCase() || null;

// GET /api/resources?q=&zone= — metadata only (never the blob). Returns the distinct categories too.
app.get('/api/resources', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'resources:view'))) return;
  const q = String(req.query.q || '').trim();
  const zone = resourceZone(req);
  const me = resourceMe(req);
  try {
    const where = [], params = [];
    // Zone scope. Personal = ONLY my own files (private); shared = the common library.
    if (zone === 'personal') { params.push(me || ''); where.push(`LOWER(owner_email) = $${params.length}`); }
    else { where.push(`owner_email IS NULL`); }
    if (q) { params.push(`%${q}%`); where.push(`(title ILIKE $${params.length} OR description ILIKE $${params.length} OR array_to_string(tags, ',') ILIKE $${params.length})`); }
    const sql = `
      SELECT id, title, description, category, tags, file_name, mime_type, file_size, uploaded_by, created_at, updated_at
        FROM resources WHERE ${where.join(' AND ')}
       ORDER BY category NULLS LAST, title`;
    const rows = (await pool.query(sql, params)).rows;
    // Managed/empty folders for this zone (resource_categories) + categories actually in use by files,
    // so freshly-created empty folders show up too.
    let managed, used;
    if (zone === 'personal') {
      managed = (await pool.query(`SELECT name FROM resource_categories WHERE LOWER(owner_email)=$1 ORDER BY sort_order, name`, [me || ''])).rows.map(r => r.name);
      used = (await pool.query(`SELECT DISTINCT category FROM resources WHERE LOWER(owner_email)=$1 AND COALESCE(category,'')<>'' ORDER BY category`, [me || ''])).rows.map(r => r.category);
    } else {
      managed = (await pool.query(`SELECT name FROM resource_categories WHERE owner_email IS NULL ORDER BY sort_order, name`)).rows.map(r => r.name);
      used = (await pool.query(`SELECT DISTINCT category FROM resources WHERE owner_email IS NULL AND COALESCE(category,'')<>'' ORDER BY category`)).rows.map(r => r.category);
    }
    const categories = Array.from(new Set([...managed, ...used]));
    res.json({ resources: rows, categories, zone });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Resolve the write zone + enforce its permission. Shared needs resources:manage; personal only
// needs resources:view (it's the user's own space). Returns {zone, owner} or null (403 already sent).
async function resolveResourceWrite(req, res) {
  const zone = resourceZone(req);
  const me = resourceMe(req);
  if (zone === 'personal') {
    if (!me) { res.status(400).json({ error: 'no user identity' }); return null; }
    if (!(await requirePerm(req, res, 'resources:view'))) return null;
    return { zone, owner: me };
  }
  if (!(await requirePerm(req, res, 'resources:manage'))) return null;
  return { zone, owner: null };
}

// GET /api/resources/storage — current usage + configured limit.
app.get('/api/resources/storage', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'resources:view'))) return;
  try {
    res.json({ used: await getResourcesUsed(), limit: await getResourcesLimit() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/resources/storage { limitBytes } — set the quota (admin only; null/0 = unlimited).
app.put('/api/resources/storage', authenticateToken, async (req, res) => {
  if (!(req.user.isAdmin === true && !req.user.impersonating)) return res.status(403).json({ error: 'Admin required' });
  const raw = req.body.limitBytes;
  const limit = (raw == null || raw === '' || Number(raw) <= 0) ? 0 : Math.round(Number(raw));
  if (!Number.isFinite(limit)) return res.status(400).json({ error: 'invalid limit' });
  try {
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('resources_storage_limit_bytes', $1, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = CURRENT_TIMESTAMP`, [String(limit)]);
    res.json({ success: true, limit: limit > 0 ? limit : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/resources/user-storage — per-user usage + limits (admin). Lists everyone who has
// uploaded, has a limit, or holds a role — each row carries its role(s), explicit per-user
// limit, role-derived limit and the resulting effective cap, so the table can be edited inline.
app.get('/api/resources/user-storage', authenticateToken, async (req, res) => {
  if (!(req.user.isAdmin === true && !req.user.impersonating)) return res.status(403).json({ error: 'Admin required' });
  try {
    // Usage by uploader.
    const usedRows = (await pool.query(`SELECT LOWER(uploaded_by) AS email, SUM(file_size)::bigint AS used FROM resources WHERE uploaded_by IS NOT NULL GROUP BY 1`)).rows;
    const usedByEmail = Object.fromEntries(usedRows.map(r => [r.email, parseInt(r.used) || 0]));
    // Explicit per-user limits.
    const userLimitRows = (await pool.query(`SELECT LOWER(email) AS email, limit_bytes FROM user_storage_limits`)).rows;
    const userLimitByEmail = Object.fromEntries(userLimitRows.map(r => [r.email, parseInt(r.limit_bytes) || null]));
    // Roles + role limits per user. roleLimit = most generous limit among the user's roles.
    const roleRows = (await pool.query(`
      SELECT LOWER(ur.user_email) AS email, r.name AS role_name, rsl.limit_bytes
        FROM user_roles ur
        JOIN roles r ON r.id = ur.role_id
        LEFT JOIN role_storage_limits rsl ON rsl.role_id = r.id`)).rows;
    const rolesByEmail = {};   // email -> [role names]
    const roleLimitByEmail = {}; // email -> max role limit
    for (const r of roleRows) {
      (rolesByEmail[r.email] = rolesByEmail[r.email] || []).push(r.role_name);
      const lim = parseInt(r.limit_bytes);
      if (Number.isFinite(lim) && lim > 0) roleLimitByEmail[r.email] = Math.max(roleLimitByEmail[r.email] || 0, lim);
    }
    // Union of every known email so the list is auto-populated.
    const knownRows = (await pool.query(`
      SELECT LOWER(email) AS email FROM user_tokens WHERE email IS NOT NULL
      UNION SELECT LOWER(email) FROM salespeople WHERE email IS NOT NULL
      UNION SELECT LOWER(email) FROM local_users WHERE email IS NOT NULL`)).rows.map(r => r.email);
    const emails = [...new Set([...knownRows, ...Object.keys(usedByEmail), ...Object.keys(userLimitByEmail), ...Object.keys(rolesByEmail)])].filter(Boolean);
    const users = emails.map(email => {
      const userLimit = userLimitByEmail[email] || null;
      const roleLimit = roleLimitByEmail[email] || null;
      const effective = userLimit != null ? userLimit : roleLimit;
      return {
        email,
        used: usedByEmail[email] || 0,
        roles: rolesByEmail[email] || [],
        userLimit,
        roleLimit,
        effectiveLimit: effective,
        source: userLimit != null ? 'user' : (roleLimit != null ? 'role' : 'none'),
      };
    }).sort((a, b) => b.used - a.used || a.email.localeCompare(b.email));
    res.json({ users });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/resources/role-storage — every role with its configured storage cap (admin).
app.get('/api/resources/role-storage', authenticateToken, async (req, res) => {
  if (!(req.user.isAdmin === true && !req.user.impersonating)) return res.status(403).json({ error: 'Admin required' });
  try {
    const rows = (await pool.query(`
      SELECT r.id, r.name, r.is_system, rsl.limit_bytes
        FROM roles r
        LEFT JOIN role_storage_limits rsl ON rsl.role_id = r.id
       ORDER BY r.is_system DESC, r.name`)).rows;
    res.json({ roles: rows.map(r => ({ id: r.id, name: r.name, isSystem: r.is_system, limit: r.limit_bytes ? parseInt(r.limit_bytes) : null })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/resources/role-storage { roleId, limitBytes } — set/clear a role's quota (admin; 0 = clear).
app.put('/api/resources/role-storage', authenticateToken, async (req, res) => {
  if (!(req.user.isAdmin === true && !req.user.impersonating)) return res.status(403).json({ error: 'Admin required' });
  const roleId = parseInt(req.body.roleId);
  if (!Number.isFinite(roleId)) return res.status(400).json({ error: 'roleId required' });
  const bytes = (req.body.limitBytes == null || Number(req.body.limitBytes) <= 0) ? 0 : Math.round(Number(req.body.limitBytes));
  try {
    if (bytes > 0) {
      await pool.query(`INSERT INTO role_storage_limits (role_id, limit_bytes, updated_at) VALUES ($1,$2,CURRENT_TIMESTAMP)
                        ON CONFLICT (role_id) DO UPDATE SET limit_bytes=$2, updated_at=CURRENT_TIMESTAMP`, [roleId, bytes]);
    } else {
      await pool.query(`DELETE FROM role_storage_limits WHERE role_id=$1`, [roleId]);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/resources/user-storage { email, limitBytes } — set/clear a user's quota (admin; 0 = clear).
app.put('/api/resources/user-storage', authenticateToken, async (req, res) => {
  if (!(req.user.isAdmin === true && !req.user.impersonating)) return res.status(403).json({ error: 'Admin required' });
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email required' });
  const bytes = (req.body.limitBytes == null || Number(req.body.limitBytes) <= 0) ? 0 : Math.round(Number(req.body.limitBytes));
  try {
    if (bytes > 0) {
      await pool.query(`INSERT INTO user_storage_limits (email, limit_bytes, updated_at) VALUES ($1,$2,CURRENT_TIMESTAMP)
                        ON CONFLICT (email) DO UPDATE SET limit_bytes=$2, updated_at=CURRENT_TIMESTAMP`, [email, bytes]);
    } else {
      await pool.query(`DELETE FROM user_storage_limits WHERE LOWER(email)=LOWER($1)`, [email]);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/resources/:id/download — stream the file inline (view perm is enough to download).
app.get('/api/resources/:id/download', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'resources:view'))) return;
  try {
    const r = (await pool.query(`SELECT file_name, mime_type, file_data FROM resources WHERE id = $1`, [req.params.id])).rows[0];
    if (!r) return res.status(404).json({ error: 'not found' });
    res.setHeader('Content-Type', r.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(r.file_name)}"`);
    res.send(r.file_data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/resources — upload a new resource (multipart: file + title/description/category/tags).
app.post('/api/resources', authenticateToken, uploadResource.single('file'), async (req, res) => {
  const w = await resolveResourceWrite(req, res); if (!w) return;
  const file = req.file;
  const title = String(req.body.title || '').trim();
  if (!file) return res.status(400).json({ error: 'file required (multipart field "file")' });
  if (!title) return res.status(400).json({ error: 'title required' });
  if (!(await ensureResourceRoom(res, file.size, req.user.realAdminEmail || req.user.email))) return;
  try {
    const actor = req.user.realAdminEmail || req.user.email || 'unknown';
    const category = String(req.body.category || '').trim();
    const r = await pool.query(
      `INSERT INTO resources (title, description, category, tags, file_name, mime_type, file_size, file_data, uploaded_by, owner_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [title, String(req.body.description || '').trim(), category,
       parseTags(req.body.tags), file.originalname, file.mimetype, file.size, file.buffer, actor, w.owner]
    );
    await logResourceAudit('add', { id: r.rows[0].id, title, file_name: file.originalname, category }, actor);
    res.json({ success: true, id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/resources/bulk — upload many files at once (shared category/tags; title = file name).
app.post('/api/resources/bulk', authenticateToken, uploadResource.array('files', 50), async (req, res) => {
  const w = await resolveResourceWrite(req, res); if (!w) return;
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'files required (multipart field "files")' });
  if (!(await ensureResourceRoom(res, files.reduce((s, f) => s + f.size, 0), req.user.realAdminEmail || req.user.email))) return;
  const actor = req.user.realAdminEmail || req.user.email || 'unknown';
  const category = String(req.body.category || '').trim();
  const tags = parseTags(req.body.tags);
  try {
    let added = 0;
    for (const f of files) {
      const title = f.originalname.replace(/\.[^.]+$/, '');
      const r = await pool.query(
        `INSERT INTO resources (title, description, category, tags, file_name, mime_type, file_size, file_data, uploaded_by, owner_email)
         VALUES ($1, '', $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [title, category, tags, f.originalname, f.mimetype, f.size, f.buffer, actor, w.owner]);
      await logResourceAudit('add', { id: r.rows[0].id, title, file_name: f.originalname, category }, actor);
      added++;
    }
    res.json({ success: true, added });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/resources/import-zip — unzip an uploaded archive into resources. Each file's FULL
// folder path becomes its category (browsed as nested folders in the UI); each file becomes a
// resource (title = file name). Files >25MB and junk (__MACOSX, .DS_Store, dotfiles) are skipped.
const EXT_MIME = {
  pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv', ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', txt: 'text/plain', mp4: 'video/mp4', zip: 'application/zip',
};
// 60 MB archive cap. The whole zip sits in RAM and adm-zip decompresses into RAM too; on a ~512 MB
// dyno a bigger archive can blow the memory quota (R14) and take the whole app down. Keep it small
// and split large sets into several imports.
const MAX_ZIP_FILES = 400;
const uploadZip = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });
// Wrap multer so its errors (esp. file-too-large) come back as clear JSON instead of a generic 500.
const zipUpload = (req, res, next) => uploadZip.single('file')(req, res, (err) => {
  if (err) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'ZIP too large (max 60 MB). Split it into smaller archives.' });
    return res.status(400).json({ error: 'Upload error: ' + err.message });
  }
  next();
});
app.post('/api/resources/import-zip', authenticateToken, zipUpload, async (req, res) => {
  const w = await resolveResourceWrite(req, res); if (!w) return;
  if (!req.file) return res.status(400).json({ error: 'file required (a .zip)' });
  const actor = req.user.realAdminEmail || req.user.email || 'unknown';
  let entries;
  try { entries = new AdmZip(req.file.buffer).getEntries(); }
  catch (e) { return res.status(400).json({ error: 'Not a valid .zip file.' }); }

  // Candidate files (cheap name filter only — defer getData() to the background loop).
  const candidates = entries.filter(e => {
    if (e.isDirectory) return false;
    const path = e.entryName.replace(/\\/g, '/');
    const base = path.split('/').pop() || '';
    return !(path.includes('__MACOSX/') || base === '.DS_Store' || base.startsWith('.') || !base);
  }).slice(0, MAX_ZIP_FILES); // bound the work so one import can't run away

  // Enforce the storage quota upfront using uncompressed sizes (header.size) before we commit.
  const incoming = candidates.reduce((s, e) => s + (e.header?.size || 0), 0);
  if (!(await ensureResourceRoom(res, incoming, req.user.realAdminEmail || req.user.email))) return;

  // Respond immediately, then import in the background — avoids Heroku's 30s request timeout on
  // large archives (each bytea INSERT to Railway is slow cross-cloud). Files appear as they land;
  // every add is in the Journal.
  res.json({ success: true, queued: candidates.length, background: true });
  (async () => {
    const seenCats = new Set();
    let i = 0;
    for (const entry of candidates) {
      // Yield every 10 files so the import never monopolises the event loop / DB pool (keeps the
      // rest of the app responsive during a big import).
      if (++i % 10 === 0) await new Promise(r => setTimeout(r, 30));
      try {
        const path = entry.entryName.replace(/\\/g, '/');
        const base = path.split('/').pop() || '';
        const parts = path.split('/').filter(Boolean);
        // Keep the FULL folder path (all segments except the file) as the category, so the zip's
        // nested structure is preserved (browsed as nested folders in the UI), not flattened to top-level.
        const category = parts.slice(0, -1).join('/');
        const data = entry.getData();
        if (!data || data.length === 0 || data.length > 25 * 1024 * 1024) continue; // skip empty / >25MB
        const ext = (base.split('.').pop() || '').toLowerCase();
        const title = base.replace(/\.[^.]+$/, '');
        const r = await pool.query(
          `INSERT INTO resources (title, description, category, tags, file_name, mime_type, file_size, file_data, uploaded_by, owner_email)
           VALUES ($1, '', $2, '{}', $3, $4, $5, $6, $7, $8) RETURNING id`,
          [title, category, base, EXT_MIME[ext] || 'application/octet-stream', data.length, data, actor, w.owner]);
        await logResourceAudit('add', { id: r.rows[0].id, title, file_name: base, category }, actor);
        // Register the managed category in the zone it was imported into.
        if (category && !seenCats.has(category)) {
          seenCats.add(category);
          await pool.query(
            `INSERT INTO resource_categories (name, owner_email, sort_order)
             SELECT $1, $2, COALESCE((SELECT MAX(sort_order)+1 FROM resource_categories),0)
             WHERE NOT EXISTS (SELECT 1 FROM resource_categories WHERE name=$1 AND COALESCE(owner_email,'')=COALESCE($2,''))`,
            [category, w.owner]);
        }
      } catch (e) { console.warn('[import-zip] entry failed:', entry.entryName, e.message); }
    }
    console.log(`[import-zip] done — processed ${candidates.length} candidate file(s) for ${actor}`);
  })().catch(e => console.warn('[import-zip] background error:', e.message));
});

// Load a resource and authorize a mutation on it. Personal files (owner_email set) can only be
// touched by their owner (private). Shared files require `sharedPerm` ('resources:manage' or the
// literal 'admin'). Returns the row, or null after sending the right 403/404.
async function authorizeResourceMutation(req, res, sharedPerm) {
  const me = resourceMe(req);
  const row = (await pool.query(`SELECT id, title, file_name, category, owner_email FROM resources WHERE id=$1`, [req.params.id])).rows[0];
  if (!row) { res.status(404).json({ error: 'not found' }); return null; }
  const owner = (row.owner_email || '').toLowerCase();
  if (owner) {
    if (owner !== me) { res.status(403).json({ error: 'forbidden' }); return null; } // someone else's private file
    return row;
  }
  if (sharedPerm === 'admin') {
    if (!(req.user.isAdmin === true && !req.user.impersonating)) { res.status(403).json({ error: 'Admin required' }); return null; }
    return row;
  }
  if (!(await requirePerm(req, res, sharedPerm))) return null;
  return row;
}

// PUT /api/resources/:id — edit metadata; optionally replace the file.
app.put('/api/resources/:id', authenticateToken, uploadResource.single('file'), async (req, res) => {
  if (!(await authorizeResourceMutation(req, res, 'resources:manage'))) return;
  try {
    const sets = ['title = $2', 'description = $3', 'category = $4', 'tags = $5', 'updated_at = CURRENT_TIMESTAMP'];
    const params = [req.params.id, String(req.body.title || '').trim(), String(req.body.description || '').trim(),
                    String(req.body.category || '').trim(), parseTags(req.body.tags)];
    if (req.file) {
      params.push(req.file.originalname, req.file.mimetype, req.file.size, req.file.buffer);
      sets.push(`file_name = $${params.length - 3}`, `mime_type = $${params.length - 2}`, `file_size = $${params.length - 1}`, `file_data = $${params.length}`);
    }
    const r = await pool.query(`UPDATE resources SET ${sets.join(', ')} WHERE id = $1 RETURNING id`, params);
    if (!r.rowCount) return res.status(404).json({ error: 'not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/resources/:id — shared library = ADMIN ONLY; personal file = its owner. Audited.
app.delete('/api/resources/:id', authenticateToken, async (req, res) => {
  if (!(await authorizeResourceMutation(req, res, 'admin'))) return;
  try {
    const r = (await pool.query(`DELETE FROM resources WHERE id = $1 RETURNING id, title, file_name, category`, [req.params.id])).rows[0];
    if (!r) return res.status(404).json({ error: 'not found' });
    await logResourceAudit('delete', r, req.user.realAdminEmail || req.user.email || 'unknown');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/resources/delete-all — wipe the SHARED library (files + categories). ADMIN ONLY.
// Personal "My files" zones are NOT touched. Requires { confirm: 'DELETE ALL' } as a safety latch.
app.post('/api/resources/delete-all', authenticateToken, async (req, res) => {
  if (!(req.user.isAdmin === true && !req.user.impersonating)) {
    return res.status(403).json({ error: 'Admin required' });
  }
  if (req.body.confirm !== 'DELETE ALL') return res.status(400).json({ error: 'confirmation phrase required' });
  try {
    const n = (await pool.query(`SELECT COUNT(*)::int c FROM resources WHERE owner_email IS NULL`)).rows[0].c;
    await pool.query(`DELETE FROM resources WHERE owner_email IS NULL`);
    await pool.query(`DELETE FROM resource_categories WHERE owner_email IS NULL`);
    await logResourceAudit('delete_all', { title: `ALL SHARED RESOURCES (${n})`, file_name: '', category: '' }, req.user.realAdminEmail || req.user.email || 'unknown');
    res.json({ success: true, deleted: n });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/resources/folder/rename { zone, path, newName } — rename a folder (its last segment),
// re-pathing every file beneath it. Shared = resources:manage; personal = owner only.
app.post('/api/resources/folder/rename', authenticateToken, async (req, res) => {
  const w = await resolveResourceWrite(req, res); if (!w) return;
  const path = String(req.body.path || '').trim().replace(/^\/+|\/+$/g, '');
  const newName = String(req.body.newName || '').trim();
  if (!path) return res.status(400).json({ error: 'path required' });
  if (!newName || newName.includes('/')) return res.status(400).json({ error: 'invalid folder name' });
  const parent = path.split('/').slice(0, -1).join('/');
  const newPath = parent ? `${parent}/${newName}` : newName;
  if (newPath === path) return res.json({ success: true, updated: 0 });
  const lenPlus1 = path.length + 1; // integer (derived from input length) — safe to inline
  const params = [newPath, path];
  let ownerCond = `owner_email IS NULL`;
  if (w.owner) { params.push(w.owner); ownerCond = `LOWER(owner_email) = $3`; }
  try {
    // Re-path the folder + everything under it. SUBSTRING keeps each row's trailing remainder
    // ('' for the folder itself, '/sub/file' for descendants).
    const upd = await pool.query(
      `UPDATE resources SET category = $1 || SUBSTRING(category FROM ${lenPlus1}), updated_at = CURRENT_TIMESTAMP
        WHERE (category = $2 OR category LIKE $2 || '/%') AND ${ownerCond}`, params);
    // Keep the managed-category names in sync within the same zone (best-effort).
    try {
      await pool.query(`UPDATE resource_categories SET name = $1 || SUBSTRING(name FROM ${lenPlus1}) WHERE (name = $2 OR name LIKE $2 || '/%') AND COALESCE(owner_email,'') = COALESCE($3,'')`, [newPath, path, w.owner]);
    } catch (e) { console.warn('[folder/rename] category sync skipped:', e.message); }
    await logResourceAudit('rename_folder', { title: `${path} → ${newPath}`, file_name: '', category: newPath }, req.user.realAdminEmail || req.user.email || 'unknown');
    res.json({ success: true, updated: upd.rowCount, newPath });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/resources/folder/delete { zone, path } — delete a folder + everything under it.
// Shared = resources:manage; personal = owner only. Audited (one summary row).
app.post('/api/resources/folder/delete', authenticateToken, async (req, res) => {
  const w = await resolveResourceWrite(req, res); if (!w) return;
  const path = String(req.body.path || '').trim().replace(/^\/+|\/+$/g, '');
  if (!path) return res.status(400).json({ error: 'path required' });
  const params = [path];
  let ownerCond = `owner_email IS NULL`;
  if (w.owner) { params.push(w.owner); ownerCond = `LOWER(owner_email) = $2`; }
  try {
    const del = await pool.query(
      `DELETE FROM resources WHERE (category = $1 OR category LIKE $1 || '/%') AND ${ownerCond} RETURNING id`, params);
    await pool.query(`DELETE FROM resource_categories WHERE (name = $1 OR name LIKE $1 || '/%') AND COALESCE(owner_email,'') = COALESCE($2,'')`, [path, w.owner]);
    await logResourceAudit('delete_folder', { title: `${path} (${del.rowCount})`, file_name: '', category: path }, req.user.realAdminEmail || req.user.email || 'unknown');
    res.json({ success: true, deleted: del.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/resources/folder/move { zone, path, destParent } — move a folder (and its subtree)
// under another parent ('' = root), re-pathing everything. Shared = resources:manage; personal = owner.
app.post('/api/resources/folder/move', authenticateToken, async (req, res) => {
  const w = await resolveResourceWrite(req, res); if (!w) return;
  const path = String(req.body.path || '').trim().replace(/^\/+|\/+$/g, '');
  const dest = String(req.body.destParent || '').trim().replace(/^\/+|\/+$/g, ''); // '' = root
  if (!path) return res.status(400).json({ error: 'path required' });
  const name = path.split('/').pop();
  const newPath = dest ? `${dest}/${name}` : name;
  if (newPath === path) return res.json({ success: true, updated: 0, newPath }); // already there
  if (dest === path || dest.startsWith(path + '/')) return res.status(400).json({ error: 'cannot move a folder into itself' });
  const lenPlus1 = path.length + 1;
  const params = [newPath, path];
  let ownerCond = `owner_email IS NULL`;
  if (w.owner) { params.push(w.owner); ownerCond = `LOWER(owner_email) = $3`; }
  try {
    const upd = await pool.query(
      `UPDATE resources SET category = $1 || SUBSTRING(category FROM ${lenPlus1}), updated_at = CURRENT_TIMESTAMP
        WHERE (category = $2 OR category LIKE $2 || '/%') AND ${ownerCond}`, params);
    try { await pool.query(`UPDATE resource_categories SET name = $1 || SUBSTRING(name FROM ${lenPlus1}) WHERE (name = $2 OR name LIKE $2 || '/%') AND COALESCE(owner_email,'') = COALESCE($3,'')`, [newPath, path, w.owner]); }
    catch (e) { console.warn('[folder/move] category sync skipped:', e.message); }
    await logResourceAudit('move_folder', { title: `${path} → ${newPath}`, file_name: '', category: newPath }, req.user.realAdminEmail || req.user.email || 'unknown');
    res.json({ success: true, updated: upd.rowCount, newPath });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/resources/folder/create { zone, path, name } — create an empty folder at `path` (a managed
// category in that zone). Shared = resources:manage; personal = owner. Idempotent.
app.post('/api/resources/folder/create', authenticateToken, async (req, res) => {
  const w = await resolveResourceWrite(req, res); if (!w) return;
  const parent = String(req.body.path || '').trim().replace(/^\/+|\/+$/g, '');
  const name = String(req.body.name || '').trim();
  if (!name || name.includes('/')) return res.status(400).json({ error: 'invalid folder name' });
  const full = parent ? `${parent}/${name}` : name;
  try {
    await pool.query(
      `INSERT INTO resource_categories (name, owner_email, sort_order)
       SELECT $1, $2, COALESCE((SELECT MAX(sort_order)+1 FROM resource_categories),0)
       WHERE NOT EXISTS (SELECT 1 FROM resource_categories WHERE name=$1 AND COALESCE(owner_email,'')=COALESCE($2,''))`,
      [full, w.owner]);
    res.json({ success: true, path: full });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Category structure (admin-managed) ---
app.get('/api/resource-categories', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'resources:view'))) return;
  try {
    const rows = (await pool.query(`SELECT id, name, sort_order FROM resource_categories WHERE owner_email IS NULL ORDER BY sort_order, name`)).rows;
    res.json({ categories: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/resource-categories', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'resources:manage'))) return;
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const r = await pool.query(
      `INSERT INTO resource_categories (name, owner_email, sort_order)
       SELECT $1, NULL, COALESCE((SELECT MAX(sort_order)+1 FROM resource_categories), 0)
       WHERE NOT EXISTS (SELECT 1 FROM resource_categories WHERE name=$1 AND owner_email IS NULL)
       RETURNING id`, [name]);
    res.json({ success: true, id: r.rows[0]?.id || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Delete a category (admin only). Resources keep their category string; they just become "uncategorized" in the managed list.
app.delete('/api/resource-categories/:id', authenticateToken, async (req, res) => {
  if (!(req.user.isAdmin === true && !req.user.impersonating)) return res.status(403).json({ error: 'Admin required' });
  try {
    await pool.query(`DELETE FROM resource_categories WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/resources/audit — the add/delete journal (admin only).
app.get('/api/resources/audit', authenticateToken, async (req, res) => {
  if (!(req.user.isAdmin === true && !req.user.impersonating)) return res.status(403).json({ error: 'Admin required' });
  try {
    const rows = (await pool.query(
      `SELECT id, action, resource_id, title, file_name, category, actor, created_at
         FROM resource_audit ORDER BY created_at DESC LIMIT 200`)).rows;
    res.json({ events: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/salespeople/:name/email — the rep's Zoho login email (null/empty clears it).
// Used by role pre-assignment + impersonation before the rep's first login.
app.put('/api/salespeople/:name/email', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  const raw = (req.body.email || '').trim().toLowerCase();
  if (raw && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid email' });
  }
  try {
    const r = await pool.query(
      `UPDATE salespeople SET email = $1, updated_at = CURRENT_TIMESTAMP WHERE name = $2 RETURNING name`,
      [raw || null, req.params.name]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Salesperson not found' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update email', details: error.message });
  }
});

// PUT /api/salespeople/:name/team — assign a rep to a team (teamId null = remove from team)
app.put('/api/salespeople/:name/team', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  const teamId = req.body.teamId == null ? null : parseInt(req.body.teamId);
  try {
    const r = await pool.query(
      `UPDATE salespeople SET team_id = $1, updated_at = CURRENT_TIMESTAMP WHERE name = $2 RETURNING name`,
      [teamId, req.params.name]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Salesperson not found' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to assign team', details: error.message });
  }
});

// ============================================================================
// TEAMS — group salespeople for quota tracking
// ============================================================================
// GET /api/teams — list teams with member counts
app.get('/api/teams', authenticateToken, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT t.id, t.name, t.monthly_quota_override, t.counts_toward_quota,
             t.include_deals, t.include_payments,
             COUNT(s.id)::int AS member_count
      FROM teams t LEFT JOIN salespeople s ON s.team_id = t.id
      GROUP BY t.id ORDER BY t.sort_order, t.name
    `);
    res.json({
      teams: r.rows.map(t => ({
        id:                  t.id,
        name:                t.name,
        monthlyQuotaOverride: t.monthly_quota_override == null ? null : parseInt(t.monthly_quota_override),
        countsTowardQuota:   t.counts_toward_quota !== false,
        includeDeals:        t.include_deals !== false,
        includePayments:     t.include_payments !== false,
        memberCount:         t.member_count,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch teams', details: error.message });
  }
});

// PUT /api/teams/reorder — set display order from an ordered list of team ids
app.put('/api/teams/reorder', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  const ids = Array.isArray(req.body.orderedIds) ? req.body.orderedIds.map(Number).filter(n => !isNaN(n)) : [];
  if (!ids.length) return res.status(400).json({ error: 'orderedIds required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < ids.length; i++) {
      await client.query(`UPDATE teams SET sort_order = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [i, ids[i]]);
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Failed to reorder teams', details: error.message });
  } finally {
    client.release();
  }
});

// POST /api/teams — create a team
app.post('/api/teams', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Team name required' });
  const override = req.body.monthlyQuotaOverride == null || req.body.monthlyQuotaOverride === ''
    ? null : parseInt(req.body.monthlyQuotaOverride);
  const counts = req.body.countsTowardQuota !== false;
  const includeDeals = req.body.includeDeals !== false;
  const includePayments = req.body.includePayments !== false;
  try {
    const r = await pool.query(
      `INSERT INTO teams (name, monthly_quota_override, counts_toward_quota, include_deals, include_payments)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [name, override, counts, includeDeals, includePayments]
    );
    res.json({ success: true, id: r.rows[0].id });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'A team with that name already exists' });
    res.status(500).json({ error: 'Failed to create team', details: error.message });
  }
});

// PUT /api/teams/:id — update name / quota override / counts toward quota
app.put('/api/teams/:id', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  const id = parseInt(req.params.id);
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Team name required' });
  const override = req.body.monthlyQuotaOverride == null || req.body.monthlyQuotaOverride === ''
    ? null : parseInt(req.body.monthlyQuotaOverride);
  const counts = req.body.countsTowardQuota !== false;
  const includeDeals = req.body.includeDeals !== false;
  const includePayments = req.body.includePayments !== false;
  try {
    const r = await pool.query(
      `UPDATE teams SET name = $1, monthly_quota_override = $2, counts_toward_quota = $3,
              include_deals = $4, include_payments = $5, updated_at = CURRENT_TIMESTAMP
       WHERE id = $6 RETURNING id`,
      [name, override, counts, includeDeals, includePayments, id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Team not found' });
    res.json({ success: true });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'A team with that name already exists' });
    res.status(500).json({ error: 'Failed to update team', details: error.message });
  }
});

// DELETE /api/teams/:id — delete a team (members' team_id set to NULL via FK)
app.delete('/api/teams/:id', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  try {
    const r = await pool.query(`DELETE FROM teams WHERE id = $1 RETURNING id`, [parseInt(req.params.id)]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Team not found' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete team', details: error.message });
  }
});

// ============================================================================
// DEAL SOURCE POINTS — configurable point value per deal type (lead source group)
// ============================================================================
// GET /api/deal-source-points — configured mappings + all source groups present in the data
app.get('/api/deal-source-points', authenticateToken, async (req, res) => {
  try {
    const configured = new Map(
      (await pool.query(`SELECT source_group, points FROM deal_source_points`)).rows
        .map(r => [r.source_group, parseInt(r.points)])
    );
    // Representative synced value per source group = its most frequent deal points value.
    const rows = (await pool.query(`
      SELECT COALESCE(lead_source_group_override, lead_source_group) AS g, points, COUNT(*)::int AS c
      FROM crm_sold_deals
      WHERE COALESCE(lead_source_group_override, lead_source_group) IS NOT NULL
        AND COALESCE(lead_source_group_override, lead_source_group) <> ''
      GROUP BY g, points
    `)).rows;
    const rep = new Map();
    for (const r of rows) {
      const cur = rep.get(r.g);
      if (!cur || r.c > cur.c) rep.set(r.g, { points: parseInt(r.points) || 0, c: r.c });
    }
    const groupNames = new Set([...rep.keys(), ...configured.keys()]);
    const groups = [...groupNames].sort().map(g => ({
      sourceGroup: g,
      points: configured.has(g) ? configured.get(g) : (rep.get(g)?.points ?? 0),
      isCustom: configured.has(g),
    }));
    res.json({ groups });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch deal source points', details: error.message });
  }
});

// PUT /api/deal-source-points — upsert a source group's point value
app.put('/api/deal-source-points', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  const sourceGroup = (req.body.sourceGroup || '').trim();
  const points = parseInt(req.body.points);
  if (!sourceGroup) return res.status(400).json({ error: 'sourceGroup required' });
  if (isNaN(points)) return res.status(400).json({ error: 'points must be a number' });
  try {
    await pool.query(
      `INSERT INTO deal_source_points (source_group, points) VALUES ($1, $2)
       ON CONFLICT (source_group) DO UPDATE SET points = $2, updated_at = CURRENT_TIMESTAMP`,
      [sourceGroup, points]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save deal source points', details: error.message });
  }
});

// DELETE /api/deal-source-points/:sourceGroup — remove a mapping (deals revert to synced points)
app.delete('/api/deal-source-points/:sourceGroup', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  try {
    await pool.query(`DELETE FROM deal_source_points WHERE source_group = $1`, [req.params.sourceGroup]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete deal source points', details: error.message });
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

// PUT /api/salespeople/:name/signup-bonus — set the per-activation signup-bonus amount
// + on/off toggle for this rep. Drives the Zentact signup bonus in the Commission Tracker.
app.put('/api/salespeople/:name/signup-bonus', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  const { amount, enabled } = req.body;
  const amt = amount == null ? 100 : Math.max(0, parseFloat(amount) || 0);
  const en = enabled !== false;
  try {
    await pool.query(
      `INSERT INTO salespeople (name, signup_bonus_amount, signup_bonus_enabled) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET signup_bonus_amount = $2, signup_bonus_enabled = $3, updated_at = CURRENT_TIMESTAMP`,
      [req.params.name, amt, en]
    );
    res.json({ success: true, signupBonusAmount: amt, signupBonusEnabled: en });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update signup bonus', details: error.message });
  }
});

// PUT /api/salespeople/:name/aliases — set the list of alias names (e.g. ["Gaby","Gabi"])
app.put('/api/salespeople/:name/aliases', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  const raw = req.body?.aliases;
  if (!Array.isArray(raw)) return res.status(400).json({ error: 'aliases must be an array of strings' });
  // Clean: strings only, trimmed, deduped (case-insensitive), drop empties
  const seen = new Set();
  const clean = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push(trimmed);
  }
  try {
    const result = await pool.query(
      `UPDATE salespeople SET aliases = $1::jsonb, updated_at = CURRENT_TIMESTAMP
       WHERE name = $2
       RETURNING name, aliases`,
      [JSON.stringify(clean), req.params.name]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Salesperson not found' });

    let deactivatedStandalones = [];
    let mergedMerchants = 0;
    if (clean.length > 0) {
      const aliasesLower = clean.map(a => a.toLowerCase());

      // 1. Re-link existing zentact_merchants whose sales_rep_name matches one
      //    of these aliases (case-insensitive) to the canonical name.
      const linkRes = await pool.query(
        `UPDATE zentact_merchants
         SET sales_rep_name = $1, updated_at = CURRENT_TIMESTAMP
         WHERE sales_rep_name IS NOT NULL
           AND LOWER(sales_rep_name) = ANY($2::text[])`,
        [req.params.name, aliasesLower]
      );
      mergedMerchants = linkRes.rowCount;

      // 2. Auto-deactivate any STANDALONE salespeople records whose name matches
      //    an alias of this rep (excluding the canonical rep itself).
      //    This prevents the sync's exact-match step from re-assigning merchants
      //    to the standalone "Erika" instead of falling through to the alias match.
      const deactRes = await pool.query(
        `UPDATE salespeople
         SET is_active = false, updated_at = CURRENT_TIMESTAMP
         WHERE is_active = true
           AND LOWER(name) = ANY($1::text[])
           AND LOWER(name) <> LOWER($2)
         RETURNING name`,
        [aliasesLower, req.params.name]
      );
      deactivatedStandalones = deactRes.rows.map(r => r.name);
    }
    res.json({
      success: true,
      aliases: result.rows[0].aliases,
      mergedMerchants,
      deactivatedStandalones,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update aliases', details: error.message });
  }
});

// ============================================================================
// ROLES & PERMISSIONS (RBAC)
// ============================================================================

// GET /api/permissions/catalog — list all available permissions
app.get('/api/permissions/catalog', authenticateToken, (req, res) => {
  res.json({ catalog: PERMISSION_CATALOG });
});

// GET /api/roles — list all roles
app.get('/api/roles', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  try {
    const result = await pool.query(`
      SELECT r.id, r.name, r.description, r.permissions, r.is_system, r.created_at, r.updated_at,
             COUNT(ur.user_email) AS user_count
      FROM roles r
      LEFT JOIN user_roles ur ON ur.role_id = r.id
      GROUP BY r.id
      ORDER BY r.is_system DESC, r.name ASC
    `);
    res.json({
      roles: result.rows.map(r => ({
        id:           r.id,
        name:         r.name,
        description:  r.description,
        permissions:  Array.isArray(r.permissions) ? r.permissions : [],
        isSystem:     r.is_system,
        userCount:    parseInt(r.user_count) || 0,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/roles — create a new role
app.post('/api/roles', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  const { name, description, permissions } = req.body || {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name required' });
  const perms = Array.isArray(permissions) ? permissions : [];
  try {
    const result = await pool.query(
      `INSERT INTO roles (name, description, permissions, is_system)
       VALUES ($1, $2, $3::jsonb, false)
       RETURNING id, name, description, permissions, is_system`,
      [name.trim(), description || '', JSON.stringify(perms)]
    );
    res.json({ success: true, role: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'A role with that name already exists' });
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/roles/:id — update an existing role (name, description, permissions)
app.put('/api/roles/:id', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  const { name, description, permissions } = req.body || {};
  const perms = Array.isArray(permissions) ? permissions : null;
  try {
    // System roles can have their permissions edited but not be renamed/deleted? Allow rename here for flexibility.
    const sets = [];
    const params = [];
    let paramIdx = 1;
    if (name !== undefined) { sets.push(`name = $${paramIdx++}`); params.push(name.trim()); }
    if (description !== undefined) { sets.push(`description = $${paramIdx++}`); params.push(description); }
    if (perms !== null) { sets.push(`permissions = $${paramIdx++}::jsonb`); params.push(JSON.stringify(perms)); }
    sets.push(`updated_at = CURRENT_TIMESTAMP`);
    params.push(req.params.id);

    const result = await pool.query(
      `UPDATE roles SET ${sets.join(', ')} WHERE id = $${paramIdx} RETURNING id, name, description, permissions, is_system`,
      params
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Role not found' });
    res.json({ success: true, role: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'A role with that name already exists' });
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/roles/:id — delete a custom role (system roles can't be deleted)
app.delete('/api/roles/:id', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  try {
    const check = await pool.query('SELECT is_system FROM roles WHERE id = $1', [req.params.id]);
    if (check.rowCount === 0) return res.status(404).json({ error: 'Role not found' });
    if (check.rows[0].is_system) return res.status(400).json({ error: 'Cannot delete a system role' });
    await pool.query('DELETE FROM roles WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/admin/assign-default-rep-role — give the 'Sales Rep' role to every ACTIVE
// salesperson who doesn't already have a role. Resolves each rep's email via their login
// account (user_tokens.display_name) or the "Courriel de connexion" on their card. Reps
// with neither are returned in `noEmail` so the admin can set their email. Idempotent.
app.post('/api/admin/assign-default-rep-role', (req, res, next) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (process.env.ZOHO_WEBHOOK_SECRET && provided === process.env.ZOHO_WEBHOOK_SECRET) { req.viaSecret = true; return next(); }
  return authenticateToken(req, res, next);
}, async (req, res) => {
  if (!req.viaSecret && !req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  try {
    const role = (await pool.query(`SELECT id FROM roles WHERE name = 'Sales Rep' LIMIT 1`)).rows[0];
    if (!role) return res.status(500).json({ error: "'Sales Rep' role not found" });
    const reps = (await pool.query(`
      SELECT s.name,
             COALESCE(
               (SELECT email FROM user_tokens WHERE LOWER(display_name) = LOWER(s.name) LIMIT 1),
               s.email
             ) AS email
      FROM salespeople s WHERE s.is_active = true
    `)).rows;
    let assigned = 0, alreadyHad = 0;
    const noEmail = [];
    for (const r of reps) {
      if (!r.email) { noEmail.push(r.name); continue; }
      const has = (await pool.query(
        `SELECT 1 FROM user_roles WHERE LOWER(user_email) = LOWER($1) LIMIT 1`, [r.email]
      )).rows.length > 0;
      if (has) { alreadyHad++; continue; }
      await pool.query(
        `INSERT INTO user_roles (user_email, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [r.email, role.id]
      );
      assigned++;
    }
    res.json({ assigned, alreadyHad, noEmail });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/users/:email/roles — list roles assigned to a user
app.get('/api/users/:email/roles', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  try {
    const result = await pool.query(`
      SELECT r.id, r.name, r.description, r.permissions, r.is_system
      FROM roles r
      JOIN user_roles ur ON ur.role_id = r.id
      WHERE LOWER(ur.user_email) = LOWER($1)
      ORDER BY r.is_system DESC, r.name ASC
    `, [req.params.email]);
    res.json({ roles: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/users/:email/roles — set the user's full list of roles (replaces existing)
// Body: { roleIds: [1, 2, 3] }
app.put('/api/users/:email/roles', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  const roleIds = Array.isArray(req.body?.roleIds) ? req.body.roleIds.map(Number).filter(n => !isNaN(n)) : null;
  if (roleIds === null) return res.status(400).json({ error: 'roleIds array required' });
  const email = req.params.email;
  try {
    await pool.query('BEGIN');
    await pool.query('DELETE FROM user_roles WHERE LOWER(user_email) = LOWER($1)', [email]);
    for (const roleId of roleIds) {
      await pool.query(
        'INSERT INTO user_roles (user_email, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [email, roleId]
      );
    }
    await pool.query('COMMIT');
    res.json({ success: true, assigned: roleIds.length });
  } catch (error) {
    await pool.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  }
});

// GET /api/users/:email/managed-teams — team ids this (manager) user oversees.
app.get('/api/users/:email/managed-teams', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  try {
    res.json({ teamIds: await getManagedTeamIds(req.params.email) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/users/:email/managed-teams { teamIds:[..] } — replace the user's managed-team set.
app.put('/api/users/:email/managed-teams', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  const teamIds = Array.isArray(req.body?.teamIds) ? req.body.teamIds.map(Number).filter(n => !isNaN(n)) : null;
  if (teamIds === null) return res.status(400).json({ error: 'teamIds array required' });
  const email = req.params.email;
  try {
    await pool.query('BEGIN');
    await pool.query('DELETE FROM team_managers WHERE LOWER(user_email) = LOWER($1)', [email]);
    for (const teamId of teamIds) {
      await pool.query(
        'INSERT INTO team_managers (user_email, team_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [email, teamId]
      );
    }
    await pool.query('COMMIT');
    res.json({ success: true, assigned: teamIds.length });
  } catch (error) {
    await pool.query('ROLLBACK');
    res.status(500).json({ error: error.message });
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
      `SELECT email, display_name, is_admin, created_at, updated_at AS last_login
       FROM user_tokens ORDER BY created_at DESC`
    );
    // Batch-fetch roles per user
    const rolesByUser = {};
    const rolesRes = await pool.query(`
      SELECT ur.user_email, r.id, r.name
      FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
    `);
    for (const row of rolesRes.rows) {
      const key = row.user_email.toLowerCase();
      if (!rolesByUser[key]) rolesByUser[key] = [];
      rolesByUser[key].push({ id: row.id, name: row.name });
    }
    // Merge in EXTERNAL users (local_users) and role-assigned emails that have never
    // logged in yet ('pending') — so roles can be managed for everyone in one place,
    // including reps BEFORE their first Zoho login.
    const seen = new Set(result.rows.map(r => r.email.toLowerCase()));
    const users = result.rows.map(r => ({
      email:     r.email,
      displayName: r.display_name || null,
      isAdmin:   r.is_admin,
      createdAt: r.created_at,
      lastLogin: r.last_login,
      userType:  'zoho',
      roles:     rolesByUser[r.email.toLowerCase()] || [],
    }));
    const localRes = await pool.query(
      `SELECT email, display_name, status, created_at, last_login_at AS last_login FROM local_users ORDER BY created_at DESC`
    );
    for (const r of localRes.rows) {
      if (seen.has(r.email.toLowerCase())) continue;
      seen.add(r.email.toLowerCase());
      users.push({
        email:     r.email,
        displayName: r.display_name || null,
        isAdmin:   false,
        createdAt: r.created_at,
        lastLogin: r.last_login,
        userType:  'external',
        roles:     rolesByUser[r.email.toLowerCase()] || [],
      });
    }
    for (const email of Object.keys(rolesByUser)) {
      if (seen.has(email)) continue;
      seen.add(email);
      users.push({
        email,
        isAdmin:   false,
        createdAt: null,
        lastLogin: null,
        userType:  'pending',
        roles:     rolesByUser[email] || [],
      });
    }
    res.json({ users });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch users', details: error.message });
  }
});

// DELETE /api/admin/users/:email — remove a user's app access: their Zoho token,
// external account, role assignments, managed teams and preferences. Does NOT touch the
// salespeople table (commission data). A Zoho user can log back in (recreates a token).
app.delete('/api/admin/users/:email', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  const email = String(req.params.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email required' });
  if (email === String(req.user.email || '').toLowerCase()) {
    return res.status(400).json({ error: 'cannot_delete_self' });
  }
  try {
    const tok = await pool.query('DELETE FROM user_tokens WHERE LOWER(email) = $1', [email]);
    const loc = await pool.query('DELETE FROM local_users WHERE LOWER(email) = $1', [email]);
    await pool.query('DELETE FROM user_roles WHERE LOWER(user_email) = $1', [email]);
    await pool.query('DELETE FROM team_managers WHERE LOWER(user_email) = $1', [email]);
    await pool.query('DELETE FROM user_preferences WHERE LOWER(email) = $1', [email]);
    res.json({ deleted: true, hadToken: tok.rowCount > 0, hadLocal: loc.rowCount > 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
    const invoiceCount = parseInt(countResult.rows[0].cnt) || 0;
    // Live in-memory state takes precedence over last completed sync_log entry
    const liveSyncStatus = invoiceSyncRunning ? 'syncing'
                         : (last?.status === 'success' ? 'idle' : (last?.status || 'never'));
    // Return BOTH the legacy field names the UI expects AND the new ones
    res.json({
      // Legacy fields (used by AdminPanel Books UI)
      syncStatus:         liveSyncStatus,
      syncRunning:        invoiceSyncRunning,
      syncStartedAt:      invoiceSyncStartedAt,
      totalInvoicesInDb:  invoiceCount,
      lastIncrementalSync: last?.synced_at || null,
      lastFullSync:        last?.synced_at || null,
      // New fields
      lastSyncAt:    last?.synced_at     || null,
      lastSyncCount: last?.invoice_count || 0,
      status:        last?.status        || 'never',
      totalInvoices: invoiceCount,
      message:       last?.message       || null,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get sync status', details: error.message });
  }
});

// GET /api/sync/all-status — unified "last updated" info for every integration
// Used by the global header widget to show data freshness at a glance.
// ============================================================================
// ZOHO BILLING — plans (used to identify SaaS line items vs hardware)
// ============================================================================

// GET /api/billing/status — connection + plan counts
app.get('/api/billing/status', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT COUNT(*) AS total,
             COUNT(CASE WHEN status = 'active' THEN 1 END) AS active,
             MAX(updated_at) AS last_sync
      FROM zoho_plans
    `);
    const row = result.rows[0];
    res.json({
      total:    parseInt(row.total)  || 0,
      active:   parseInt(row.active) || 0,
      lastSync: row.last_sync        || null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/billing/plans — list all plans we've cached
app.get('/api/billing/plans', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  try {
    const result = await pool.query(`
      SELECT plan_code, name, description, recurring_price, interval, interval_unit,
             currency_code, product_name, status, is_saas, updated_at
      FROM zoho_plans
      ORDER BY status ASC, plan_code ASC
    `);
    res.json({ plans: result.rows, total: result.rows.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/billing/probe — try multiple Billing API URLs and report which one responds
// Useful to diagnose region/scope/auth issues.
app.get('/api/billing/probe', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  try {
    const adminResult = await pool.query(
      'SELECT email, access_token, api_domain, expires_at FROM user_tokens WHERE is_admin = true ORDER BY updated_at DESC LIMIT 1'
    );
    const admin = adminResult.rows[0];
    if (!admin) return res.status(400).json({ error: 'No admin token' });

    const tokenData = await ensureValidToken(admin.email);
    const token = typeof tokenData === 'string' ? tokenData : tokenData?.access_token;
    if (!token) return res.status(400).json({ error: 'No access_token in token data', tokenData });
    const orgId = process.env.ZOHO_ORG_ID;
    const headers = {
      Authorization: `Zoho-oauthtoken ${token}`,
      'X-com-zoho-subscriptions-organizationid': orgId,
    };

    // Try every plausible URL variant
    const baseDomain = (admin.api_domain || '').replace(/\/$/, '');
    const variants = [
      // Variants WITH the api_domain (matches user's region)
      `${baseDomain}/billing/v1/plans`,
      `${baseDomain}/subscriptions/v1/plans`,
      // Direct subscriptions domain (older URL, still works)
      'https://subscriptions.zoho.com/api/v1/plans',
      'https://www.zohoapis.com/billing/v1/plans',
      'https://www.zohoapis.com/subscriptions/v1/plans',
      'https://www.zohoapis.ca/billing/v1/plans',
      'https://www.zohoapis.eu/billing/v1/plans',
    ];

    const results = [];
    for (const url of variants) {
      // Try with and without organization_id in query
      for (const useOrgParam of [true, false]) {
        // Try with org_id in header AND in query, then no header
        for (const useOrgHeader of [true, false]) {
          const params = useOrgParam ? { per_page: 1, organization_id: orgId } : { per_page: 1 };
          const reqHeaders = useOrgHeader ? headers : { Authorization: headers.Authorization };
          try {
            const r = await axios.get(url, { headers: reqHeaders, params, validateStatus: () => true, timeout: 8000 });
            results.push({
              url,
              orgParam: useOrgParam,
              orgHeader: useOrgHeader,
              status: r.status,
              ok: r.status >= 200 && r.status < 300,
              snippet: typeof r.data === 'object' ? JSON.stringify(r.data).slice(0, 200) : String(r.data).slice(0, 200),
            });
            // Early exit if we found one that works
            if (r.status >= 200 && r.status < 300) {
              return res.json({
                success: true,
                workingUrl: url,
                orgParam: useOrgParam,
                orgHeader: useOrgHeader,
                allResults: results,
              });
            }
          } catch (e) {
            results.push({ url, orgParam: useOrgParam, orgHeader: useOrgHeader, error: e.message });
          }
        }
      }
    }

    res.json({
      success: false,
      adminEmail: admin.email,
      apiDomain: admin.api_domain,
      orgId,
      tokenPrefix: typeof token === 'string' ? token.slice(0, 15) + '...' : String(token).slice(0, 50),
      tokenType: typeof token,
      tokenExpiresIn: admin.expires_at ? Math.round((parseInt(admin.expires_at) - Date.now()) / 1000) + 's' : 'unknown',
      results,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/invoices/debug-customer — full enriched data for a customer
app.get('/api/invoices/debug-customer', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  const search = (req.query.q || '').trim();
  if (!search) return res.status(400).json({ error: 'q parameter required' });
  try {
    const result = await pool.query(`
      SELECT invoice_number, customer_name, salesperson_name, status, date,
             paid_date, total, commission, commission_status,
             hardware_amount, saas_amount, subscription_activation_date,
             commission_payable_date,
             jsonb_array_length(line_items) AS line_items_count
      FROM invoices
      WHERE organization_id = $1 AND customer_name ILIKE $2
      ORDER BY date ASC
    `, [process.env.ZOHO_ORG_ID, `%${search}%`]);
    res.json({
      count: result.rows.length,
      invoices: result.rows,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/invoices/flush — wipes all invoices from our DB so the next
// sync only pulls from INVOICES_SYNC_FROM_DATE forward (default 2026-01-01).
// Requires ?confirm=YES to prevent accidental wipes.
app.delete('/api/invoices/flush', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  if (req.query.confirm !== 'YES') {
    return res.status(400).json({ error: 'Add ?confirm=YES to confirm. This deletes ALL invoices from our DB.' });
  }
  try {
    const before = await pool.query('SELECT COUNT(*) AS n FROM invoices');
    const beforeCount = parseInt(before.rows[0].n) || 0;
    await pool.query('DELETE FROM invoices');
    console.log(`🗑️  Invoices flush: deleted ${beforeCount} rows`);
    res.json({
      success: true,
      deleted: beforeCount,
      note: 'Next auto-sync (or manual /api/invoices/sync) will repopulate from INVOICES_SYNC_FROM_DATE.',
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// PHASE 1b — Batch invoice enrichment (classify + link + store)
// ============================================================================

// Normalize a line-item / plan name for matching: lowercase, strip leading '*', collapse spaces.
function normalizePlanName(s) {
  return (s || '').toLowerCase().replace(/^\*+/, '').replace(/\s+/g, ' ').trim();
}

// Classify a single line item → 'saas' | 'hardware' | 'noncommission'. Business rules:
//   - Residuals / referral payouts earn nothing.
//   - Matches a Zoho plan (sku or name) OR is an "...Integration" add-on (Datacandy, MEV-WEB,
//     Payment Processing Integration, ...) → SaaS (first month 100%, renewals 0%).
//   - Everything else (POS, printers, installation/labor services, ...) → hardware (10%).
// noncommission amounts are excluded from BOTH saas_amount and hardware_amount, so they pay $0.
function classifyLineType(name, sku, planCodes, planNames) {
  const n = normalizePlanName(name);
  // Non-commissionable: residuals, referral payouts, fees, and shipping earn nothing
  // (shipping excluded per user decision 2026-06-11 — old reports never paid on it).
  if (/\b(residual|referral|fee|frais|shipping|livraison|freight)/.test(n)) return 'noncommission';
  // SaaS: matches a Zoho plan, OR a recurring software product/add-on by keyword.
  if (sku && planCodes.has(String(sku).toLowerCase().trim())) return 'saas';
  if (n && planNames.has(n)) return 'saas';
  if (/integration|online ordering|qr table|delivery|bundle|cluster os|add-?on|saas/.test(n)) return 'saas';
  // Everything else (POS, printers, terminals, installation/labor/shipping services) → hardware.
  return 'hardware';
}

let enrichJob = {
  status:   'idle',  // idle | running | stopping | stopped | completed | error
  startedAt: null,
  processed: 0,
  total:     0,
  message:   '',
  stats:     { saas: 0, hardware: 0, unknown: 0, eligible: 0, pending_payment: 0, pending_saas: 0 },
};

async function fetchSubActivation(subscriptionId, apiDomain, accessToken, cache) {
  if (!subscriptionId) return null;
  if (cache.has(subscriptionId)) return cache.get(subscriptionId);
  try {
    const r = await axios.get(
      `${apiDomain}/billing/v1/subscriptions/${subscriptionId}`,
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          'X-com-zoho-subscriptions-organizationid': process.env.ZOHO_ORG_ID,
        },
        validateStatus: () => true,
      }
    );
    const sub = r.data?.subscription;
    if (!sub) { cache.set(subscriptionId, null); return null; }
    const raw = sub.activated_at || sub.current_term_starts_at || sub.start_date;
    if (!raw) { cache.set(subscriptionId, null); return null; }
    let d;
    if (typeof raw === 'number' || /^\d+$/.test(String(raw))) d = new Date(parseInt(raw) * 1000);
    else d = new Date(raw);
    const iso = !isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null;
    cache.set(subscriptionId, iso);
    return iso;
  } catch (_e) {
    cache.set(subscriptionId, null);
    return null;
  }
}

// POST /api/invoices/enrich/start — runs batch enrichment in background
// Query params:
//   onlyMissing=true (default) — skip invoices already enriched (line_items populated)
//   onlyMissing=false          — re-enrich everything
// Shared enrich routine — runs the background enrichment job. Used by both the
// HTTP endpoint and the post-sync auto-trigger.
async function runEnrichInvoices({ onlyMissing = true, source = 'manual', extraWhere = '' } = {}) {
  if (enrichJob.status === 'running') {
    return { skipped: true, reason: 'already_running' };
  }
  enrichJob = {
    status: 'running', startedAt: new Date().toISOString(),
    processed: 0, total: 0, message: `Starting (${source})...`,
    onlyMissing, source, extraWhere,
    stats: { saas: 0, hardware: 0, unknown: 0, eligible: 0, pending_payment: 0, pending_saas: 0, skipped: 0 },
  };
  try {
      const adminResult = await pool.query(
        'SELECT email, access_token, api_domain FROM user_tokens WHERE is_admin = true ORDER BY updated_at DESC LIMIT 1'
      );
      const admin = adminResult.rows[0];
      if (!admin) throw new Error('No admin Zoho token');
      const tokenData = await ensureValidToken(admin.email);
      const accessToken = typeof tokenData === 'string' ? tokenData : tokenData?.access_token;
      const apiDomain = admin.api_domain;
      const orgId = process.env.ZOHO_ORG_ID;

      // Load plan catalog for classification
      const plansRes = await pool.query('SELECT plan_code, name FROM zoho_plans');
      const planCodes = new Set(plansRes.rows.map(r => (r.plan_code || '').toLowerCase().trim()));
      const normalizeName = (s) => (s || '').toLowerCase().replace(/^\*+/, '').replace(/\s+/g, ' ').trim();
      const planNames = new Map();
      for (const p of plansRes.rows) { const k = normalizeName(p.name); if (k) planNames.set(k, p.plan_code); }

      // Get all PAID invoices from our local DB (we only enrich paid ones — others don't earn commission yet)
      // When onlyMissing=true, skip those already enriched (line_items populated).
      const skipFilter = enrichJob.onlyMissing
        ? `AND (line_items IS NULL OR line_items = '[]'::jsonb)` : '';
      // Optional targeted filter (e.g. re-enrich only phantom-discount invoices). Trusted —
      // built server-side, never from user input.
      const extra = enrichJob.extraWhere ? ` ${enrichJob.extraWhere}` : '';
      const invRes = await pool.query(
        `SELECT invoice_number FROM invoices
         WHERE organization_id = $1 AND status = 'paid'
         ${skipFilter}${extra}
         ORDER BY date DESC`,
        [orgId]
      );
      enrichJob.total = invRes.rows.length;
      enrichJob.message = `Enriching ${enrichJob.total} paid invoices${enrichJob.onlyMissing ? ' (missing only)' : ''}...`;

      // Pass 1: fetch all invoice details from Zoho, classify, gather customer → first SaaS map
      const subCache = new Map();  // subscription_id → activation iso string (reused across invoices)
      let enrichZohoErrors = 0;    // Zoho calls that came back non-200 (rate limit / auth / etc.)
      let enrichErrLogged = false; // log the first error verbatim so we can see WHY (then suppress spam)

      for (const row of invRes.rows) {
        if (enrichJob.status === 'stopping') break;

        // Lookup invoice in Zoho Books by number
        const searchRes = await axios.get(
          `${apiDomain}/books/v3/invoices`,
          {
            params: { organization_id: orgId, invoice_number: row.invoice_number },
            headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
            validateStatus: () => true,
          }
        );
        if (searchRes.status !== 200) {
          enrichZohoErrors++;
          if (!enrichErrLogged) {
            console.warn(`⚠️ [ENRICH] Zoho search ${row.invoice_number} → HTTP ${searchRes.status}: ${JSON.stringify(searchRes.data).slice(0, 300)}`);
            enrichErrLogged = true;
          }
          enrichJob.processed++; continue;
        }
        const stub = searchRes.data?.invoices?.[0];
        if (!stub) { enrichJob.processed++; continue; }

        const detRes = await axios.get(
          `${apiDomain}/books/v3/invoices/${stub.invoice_id}`,
          {
            params: { organization_id: orgId },
            headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
            validateStatus: () => true,
          }
        );
        if (detRes.status !== 200) {
          enrichZohoErrors++;
          if (!enrichErrLogged) {
            console.warn(`⚠️ [ENRICH] Zoho detail ${row.invoice_number} → HTTP ${detRes.status}: ${JSON.stringify(detRes.data).slice(0, 300)}`);
            enrichErrLogged = true;
          }
          enrichJob.processed++; continue;
        }
        const det = detRes.data?.invoice;
        if (!det) { enrichJob.processed++; continue; }

        // Classify line items (3-way: saas / hardware / noncommission)
        let saasLines = 0, hardwareLines = 0;
        const classified = (det.line_items || []).map(li => {
          const sku = String(li.sku || li.item_code || '').trim();
          const lineType = classifyLineType(li.name, sku, planCodes, planNames);
          if (lineType === 'saas') saasLines++; else if (lineType === 'hardware') hardwareLines++;
          const matchedBySku = sku && planCodes.has(sku.toLowerCase());
          // Use Zoho's net line item_total when present — INCLUDING 0 (a 100%-discounted/free
          // line). The old `parseFloat(item_total) || rate*qty` treated 0 as missing and fell
          // back to rate*qty, storing a free line at full price → phantom invoice-level discount
          // that wrongly halved the hardware rate on the OTHER (full-price) lines.
          const it = parseFloat(li.item_total);
          const amount = Number.isFinite(it) ? it : ((parseFloat(li.rate) * parseInt(li.quantity)) || 0);
          return {
            name: li.name, sku, quantity: li.quantity, rate: li.rate,
            amount,
            type: lineType,
            plan_code: matchedBySku ? sku : (planNames.get(normalizeName(li.name)) || null),
          };
        });
        const type = saasLines > hardwareLines ? 'saas'
                   : hardwareLines > saasLines ? 'hardware'
                   : (saasLines > 0 ? 'saas' : 'unknown');
        // hardware_amount = hardware lines ONLY (noncommission lines excluded from both → pay $0)
        const saasAmount = classified.filter(l => l.type === 'saas').reduce((s, l) => s + l.amount, 0);
        const hardwareAmount = classified.filter(l => l.type === 'hardware').reduce((s, l) => s + l.amount, 0);
        const grossLineTotal = classified.reduce((s, l) => s + (parseFloat(l.amount) || 0), 0); // incl. noncommission
        const totalAmount = saasAmount + hardwareAmount;
        const paidDate = det.last_payment_date || (det.status === 'paid' ? det.date : null);

        // Fetch SaaS activation if this is a SaaS invoice
        let subActivation = null;
        if (type === 'saas' && det.recurring_invoice_id) {
          subActivation = await fetchSubActivation(det.recurring_invoice_id, apiDomain, accessToken, subCache);
        }

        // Invoice-level (entity) discount only — item-level discounts are already net in
        // each line's item_total, so counting them here would double-discount.
        const subTotal  = parseFloat(det.sub_total) || 0;
        const discTotal = det.discount_type === 'item_level' ? 0 : (parseFloat(det.discount_total) || 0);

        // Write this invoice's enriched facts IMMEDIATELY — incremental so progress is saved
        // continuously (resumable across restarts/OOM, no big in-memory accumulation, and the
        // count climbs visibly). commission_status / commission_payable_date are owned by
        // recalc-v2, which runs right after enrich (post-sync chain) and on schedule.
        await pool.query(`
          UPDATE invoices SET
            line_items = $1::jsonb,
            hardware_amount = $2,
            saas_amount = $3,
            subscription_activation_date = $4::date,
            paid_date = $5::date,
            sub_total = $6,
            discount_total = $7,
            gross_line_total = $8,
            updated_at = CURRENT_TIMESTAMP
          WHERE invoice_number = $9 AND organization_id = $10
        `, [JSON.stringify(classified), hardwareAmount, saasAmount, subActivation, paidDate,
            subTotal || null, discTotal, Math.round(grossLineTotal * 100) / 100, det.invoice_number, orgId]);

        enrichJob.processed++;
        enrichJob.stats[type] = (enrichJob.stats[type] || 0) + 1;
        enrichJob.message = `Enriched ${enrichJob.processed} of ${enrichJob.total}`;
      }

      enrichJob.status = enrichJob.status === 'stopping' ? 'stopped' : 'completed';
      enrichJob.zohoErrors = enrichZohoErrors;
      enrichJob.message = `Done (${source}) — ${enrichJob.processed} invoices processed`
        + (enrichZohoErrors ? ` — ⚠️ ${enrichZohoErrors} Zoho errors (rate limit / auth?)` : '');
      console.log(`[ENRICH] ${enrichJob.message}`);
      return enrichJob;
    } catch (error) {
      enrichJob.status = 'error';
      enrichJob.message = error.message;
      console.error('enrich error:', error);
      return enrichJob;
    }
}

// HTTP endpoint — fire-and-forget wrapper around runEnrichInvoices
app.post('/api/invoices/enrich/start', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  if (enrichJob.status === 'running') {
    return res.status(409).json({ error: 'Already running', startedAt: enrichJob.startedAt });
  }
  const onlyMissing = req.query.onlyMissing !== 'false'; // default true
  res.json({ success: true, message: `Enrichment started (onlyMissing=${onlyMissing}) — poll /api/invoices/enrich/status` });
  runEnrichInvoices({ onlyMissing, source: 'manual' }).catch(e => console.error('enrich bg error:', e));
});

// GET /api/invoices/enrich/status — poll progress
app.get('/api/invoices/enrich/status', authenticateToken, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  res.json(enrichJob);
});

// POST /api/invoices/enrich/stop — request a graceful stop
app.post('/api/invoices/enrich/stop', authenticateToken, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  if (enrichJob.status === 'running') enrichJob.status = 'stopping';
  res.json({ success: true });
});

// GET /api/admin/zoho-invoice-raw?secret=&number=INV-xxxx  — raw Zoho line items for one invoice
// (item_total, discount per line + invoice discount fields). Diagnostic to see how Zoho records
// a discount (free line item_total=0 vs entity-level discount).
app.get('/api/admin/zoho-invoice-raw', async (req, res) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (!process.env.ZOHO_WEBHOOK_SECRET || provided !== process.env.ZOHO_WEBHOOK_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const number = String(req.query.number || '').trim();
  if (!number) return res.status(400).json({ error: 'number required' });
  try {
    const admin = (await pool.query(
      'SELECT email, api_domain FROM user_tokens WHERE is_admin = true ORDER BY updated_at DESC LIMIT 1'
    )).rows[0];
    if (!admin) return res.status(400).json({ error: 'No admin Zoho token' });
    const tokenData = await ensureValidToken(admin.email);
    const accessToken = typeof tokenData === 'string' ? tokenData : tokenData?.access_token;
    const search = await axios.get(`${admin.api_domain}/books/v3/invoices`, {
      params: { organization_id: process.env.ZOHO_ORG_ID, invoice_number: number },
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` }, validateStatus: () => true,
    });
    const found = search.data?.invoices?.[0];
    if (!found) return res.status(404).json({ error: 'Not found in Zoho' });
    const detail = await axios.get(`${admin.api_domain}/books/v3/invoices/${found.invoice_id}`, {
      params: { organization_id: process.env.ZOHO_ORG_ID },
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` }, validateStatus: () => true,
    });
    const inv = detail.data?.invoice;
    if (!inv) return res.status(500).json({ error: 'No detail', body: detail.data });
    res.json({
      invoice_number: inv.invoice_number,
      sub_total: inv.sub_total, total: inv.total, discount: inv.discount,
      discount_total: inv.discount_total, discount_type: inv.discount_type, is_discount_before_tax: inv.is_discount_before_tax,
      line_items: (inv.line_items || []).map(li => ({
        name: li.name, rate: li.rate, quantity: li.quantity,
        item_total: li.item_total, discount: li.discount, discount_amount: li.discount_amount,
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/reclassify-saas?secret=&count=  — re-classify STORED line_items so lines named
// "...saas..." that were mislabeled 'hardware' become 'saas' (classifier now matches "saas").
// Recomputes hardware_amount/saas_amount/type per invoice (no Zoho), then auto-recalcs.
app.post('/api/admin/reclassify-saas', async (req, res) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (!process.env.ZOHO_WEBHOOK_SECRET || provided !== process.env.ZOHO_WEBHOOK_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const orgId = process.env.ZOHO_ORG_ID;
  // Affected = a stored line currently typed 'hardware' whose name contains "saas".
  const findSql = `
    SELECT i.invoice_number, i.line_items FROM invoices i
    WHERE i.organization_id = $1 AND i.line_items IS NOT NULL AND jsonb_typeof(i.line_items) = 'array'
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(i.line_items) li
        WHERE COALESCE(li->>'type','') = 'hardware' AND lower(li->>'name') LIKE '%saas%'
      )`;
  try {
    if (req.query.count === '1') {
      const c = (await pool.query(`SELECT COUNT(*)::int AS n FROM (${findSql}) x`, [orgId])).rows[0].n;
      return res.json({ wouldReclassify: c });
    }
    const plansRes = await pool.query('SELECT plan_code, name FROM zoho_plans');
    const planCodes = new Set(plansRes.rows.map(r => (r.plan_code || '').toLowerCase().trim()));
    const normName = (s) => (s || '').toLowerCase().replace(/^\*+/, '').replace(/\s+/g, ' ').trim();
    const planNames = new Map();
    for (const p of plansRes.rows) { const k = normName(p.name); if (k) planNames.set(k, p.plan_code); }

    const rows = (await pool.query(findSql, [orgId])).rows;
    let updated = 0;
    for (const r of rows) {
      const lines = Array.isArray(r.line_items) ? r.line_items : [];
      const reclassified = lines.map(li => ({ ...li, type: classifyLineType(li.name, String(li.sku || li.item_code || '').trim(), planCodes, planNames) }));
      const saasAmount = reclassified.filter(l => l.type === 'saas').reduce((s, l) => s + (parseFloat(l.amount) || 0), 0);
      const hardwareAmount = reclassified.filter(l => l.type === 'hardware').reduce((s, l) => s + (parseFloat(l.amount) || 0), 0);
      await pool.query(
        `UPDATE invoices SET line_items = $1::jsonb, saas_amount = $2, hardware_amount = $3, updated_at = CURRENT_TIMESTAMP
         WHERE invoice_number = $4 AND organization_id = $5`,
        [JSON.stringify(reclassified), saasAmount, hardwareAmount, r.invoice_number, orgId]
      );
      updated++;
    }
    res.json({ success: true, reclassified: updated, note: 'recalc-v2 starting' });
    runRecalcV2('reclassify-saas').catch(e => console.error('reclassify-saas recalc error:', e));
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/reenrich-invoices?secret=&numbers=INV-1,INV-2  — SYNCHRONOUS re-enrich of a
// small list of invoices (re-fetch from Zoho, re-store line_items/hardware/saas/gross with the
// fixed item_total=0 parse). Bypasses the flaky in-memory enrichJob (2 web dynos) so a targeted
// fix is reliable. Keep the list small (<= ~20) to stay under the 30s request limit.
app.post('/api/admin/reenrich-invoices', async (req, res) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (!process.env.ZOHO_WEBHOOK_SECRET || provided !== process.env.ZOHO_WEBHOOK_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const numbers = String(req.query.numbers || req.body?.numbers || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!numbers.length) return res.status(400).json({ error: 'numbers required (comma-separated)' });
  try {
    const admin = (await pool.query(
      'SELECT email, api_domain FROM user_tokens WHERE is_admin = true ORDER BY updated_at DESC LIMIT 1'
    )).rows[0];
    if (!admin) return res.status(400).json({ error: 'No admin Zoho token' });
    const tokenData = await ensureValidToken(admin.email);
    const accessToken = typeof tokenData === 'string' ? tokenData : tokenData?.access_token;
    const apiDomain = admin.api_domain, orgId = process.env.ZOHO_ORG_ID;
    const plansRes = await pool.query('SELECT plan_code, name FROM zoho_plans');
    const planCodes = new Set(plansRes.rows.map(r => (r.plan_code || '').toLowerCase().trim()));
    const normName = (s) => (s || '').toLowerCase().replace(/^\*+/, '').replace(/\s+/g, ' ').trim();
    const planNames = new Map();
    for (const p of plansRes.rows) { const k = normName(p.name); if (k) planNames.set(k, p.plan_code); }

    const out = [];
    for (const number of numbers) {
      const search = await axios.get(`${apiDomain}/books/v3/invoices`, {
        params: { organization_id: orgId, invoice_number: number },
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` }, validateStatus: () => true,
      });
      const found = search.data?.invoices?.[0];
      if (!found) { out.push({ number, error: 'not found in Zoho' }); continue; }
      const detail = await axios.get(`${apiDomain}/books/v3/invoices/${found.invoice_id}`, {
        params: { organization_id: orgId },
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` }, validateStatus: () => true,
      });
      const det = detail.data?.invoice;
      if (!det) { out.push({ number, error: 'no detail' }); continue; }
      const classified = (det.line_items || []).map(li => {
        const sku = String(li.sku || li.item_code || '').trim();
        const lineType = classifyLineType(li.name, sku, planCodes, planNames);
        const matchedBySku = sku && planCodes.has(sku.toLowerCase());
        const it = parseFloat(li.item_total);
        const amount = Number.isFinite(it) ? it : ((parseFloat(li.rate) * parseInt(li.quantity)) || 0);
        return { name: li.name, sku, quantity: li.quantity, rate: li.rate, amount, type: lineType,
          plan_code: matchedBySku ? sku : (planNames.get(normName(li.name)) || null) };
      });
      const saasAmount = classified.filter(l => l.type === 'saas').reduce((s, l) => s + l.amount, 0);
      const hardwareAmount = classified.filter(l => l.type === 'hardware').reduce((s, l) => s + l.amount, 0);
      const grossLineTotal = classified.reduce((s, l) => s + (parseFloat(l.amount) || 0), 0);
      const subTotal  = parseFloat(det.sub_total) || 0;
      const discTotal = det.discount_type === 'item_level' ? 0 : (parseFloat(det.discount_total) || 0);
      await pool.query(
        `UPDATE invoices SET line_items = $1::jsonb, hardware_amount = $2, saas_amount = $3,
           sub_total = $4, discount_total = $5, gross_line_total = $6, updated_at = CURRENT_TIMESTAMP
         WHERE invoice_number = $7 AND organization_id = $8`,
        [JSON.stringify(classified), hardwareAmount, saasAmount, subTotal || null, discTotal,
         Math.round(grossLineTotal * 100) / 100, number, orgId]
      );
      out.push({ number, hardware_amount: hardwareAmount, saas_amount: saasAmount, gross: Math.round(grossLineTotal * 100) / 100, sub_total: subTotal });
    }
    res.json({ reenriched: out.length, results: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/reenrich-discounted?secret=&count=  — re-enrich ONLY "phantom discount"
// invoices (sub_total < gross_line_total) so 100%-discounted/free lines, which the old parser
// stored at full price (item_total=0 fell back to rate*qty), get their correct net amount (0).
// Bounded re-fetch from Zoho, then auto-recalc. ?count=1 reports how many would be processed.
app.post('/api/admin/reenrich-discounted', async (req, res) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (!process.env.ZOHO_WEBHOOK_SECRET || provided !== process.env.ZOHO_WEBHOOK_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const where = `AND sub_total IS NOT NULL AND gross_line_total IS NOT NULL AND sub_total < gross_line_total - 0.01`;
  try {
    if (req.query.count === '1') {
      const c = (await pool.query(
        `SELECT COUNT(*)::int AS n FROM invoices WHERE organization_id = $1 AND status = 'paid' ${where}`,
        [process.env.ZOHO_ORG_ID]
      )).rows[0].n;
      return res.json({ wouldReenrich: c });
    }
    if (req.query.list === '1') {
      const rows = (await pool.query(
        `SELECT invoice_number FROM invoices WHERE organization_id = $1 AND status = 'paid' ${where} ORDER BY invoice_number`,
        [process.env.ZOHO_ORG_ID]
      )).rows.map(r => r.invoice_number);
      return res.json({ count: rows.length, numbers: rows });
    }
    if (enrichJob.status === 'running') return res.status(409).json({ error: 'Enrich already running' });
    res.json({ success: true, message: 'Re-enrich of phantom-discount invoices started; recalc-v2 runs after.' });
    runEnrichInvoices({ onlyMissing: false, source: 'reenrich-discounted', extraWhere: where })
      .then(() => runRecalcV2('reenrich-discounted'))
      .catch(e => console.error('reenrich-discounted bg error:', e));
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// GET /api/invoices/enrich-preview/:invoiceNumber — fetches ONE invoice from Zoho Books
// with full line items, classifies it as hardware OR SaaS via cached plan_codes,
// and computes commission_payable_date with customer-level linking.
//
// Rules (per user spec):
//   - Invoices are PURE: either 100% hardware or 100% SaaS (never mixed)
//   - SaaS invoice payable when: status=paid AND subscription_activation_date set
//   - Hardware invoice payable when: status=paid AND the same customer has at least
//     ONE paid SaaS invoice with subscription_activation_date set
app.get('/api/invoices/enrich-preview/:invoiceNumber', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  try {
    const adminResult = await pool.query(
      'SELECT email, access_token, api_domain FROM user_tokens WHERE is_admin = true ORDER BY updated_at DESC LIMIT 1'
    );
    const admin = adminResult.rows[0];
    if (!admin) return res.status(400).json({ error: 'No admin Zoho token' });
    const tokenData = await ensureValidToken(admin.email);
    const accessToken = typeof tokenData === 'string' ? tokenData : tokenData?.access_token;

    // 1. Find the invoice ID
    const searchRes = await axios.get(
      `${admin.api_domain}/books/v3/invoices`,
      {
        params: { organization_id: process.env.ZOHO_ORG_ID, invoice_number: req.params.invoiceNumber },
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
        validateStatus: () => true,
      }
    );
    const found = searchRes.data?.invoices?.[0];
    if (!found) return res.status(404).json({ error: 'Invoice not found in Zoho' });

    // 2. Fetch full invoice details
    const detailRes = await axios.get(
      `${admin.api_domain}/books/v3/invoices/${found.invoice_id}`,
      {
        params: { organization_id: process.env.ZOHO_ORG_ID },
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
        validateStatus: () => true,
      }
    );
    const inv = detailRes.data?.invoice;
    if (!inv) return res.status(500).json({ error: 'Failed to fetch invoice details', body: detailRes.data });

    // 3. Load cached plan_codes AND plan names (for fallback when SKU is empty)
    const plansRes = await pool.query('SELECT plan_code, name FROM zoho_plans');
    const planCodes = new Set(plansRes.rows.map(r => (r.plan_code || '').toLowerCase().trim()));
    // Normalize plan name: lowercase, trim, strip leading "**", collapse whitespace
    const normalizeName = (s) => (s || '')
      .toLowerCase()
      .replace(/^\*+/, '')   // strip leading asterisks
      .replace(/\s+/g, ' ')
      .trim();
    const planNames = new Map();
    for (const p of plansRes.rows) {
      const key = normalizeName(p.name);
      if (key) planNames.set(key, p.plan_code);
    }

    // 4. Classify line items: SKU match first, then name match as fallback
    const matchPlan = (sku, name) => {
      const s = (sku || '').toLowerCase().trim();
      if (s && planCodes.has(s)) return { matched: true, by: 'sku', code: sku };
      const n = normalizeName(name);
      if (n && planNames.has(n)) return { matched: true, by: 'name', code: planNames.get(n) };
      return { matched: false };
    };

    let saasLineCount = 0;
    let hardwareLineCount = 0;
    let earliestSubActivation = null;
    const classified = (inv.line_items || []).map(li => {
      const sku = String(li.sku || li.item_code || '').trim();
      const m = matchPlan(sku, li.name);
      // Stored line carries the net `amount` already (incl. 0 for free lines) — prefer it;
      // fall back to item_total / rate*qty only when absent. Treats 0 as a valid amount.
      const stored = parseFloat(li.amount);
      const it = parseFloat(li.item_total);
      const amount = Number.isFinite(stored) ? stored
                   : Number.isFinite(it) ? it
                   : ((parseFloat(li.rate) * parseInt(li.quantity)) || 0);
      if (m.matched) saasLineCount++; else hardwareLineCount++;
      const subDate = li.subscription_activation_date || li.start_date || null;
      if (subDate) {
        const d = new Date(subDate);
        if (!earliestSubActivation || d < earliestSubActivation) earliestSubActivation = d;
      }
      return {
        name: li.name, sku, quantity: li.quantity, rate: li.rate, amount,
        type: m.matched ? 'saas' : 'hardware',
        plan_matched: m.matched,
        matched_by:   m.matched ? m.by   : null,
        plan_code:    m.matched ? m.code : null,
        subscription_activation_date: subDate,
      };
    });
    // Invoice type: majority of lines determines it (user said they're pure anyway)
    const invoiceType = saasLineCount > hardwareLineCount ? 'saas'
                      : hardwareLineCount > saasLineCount ? 'hardware'
                      : (saasLineCount > 0 ? 'saas' : 'unknown');

    // 5. Detect paid date + invoice-level activation
    const paidDate = inv.last_payment_date || (inv.status === 'paid' ? inv.date : null);
    let subActivation = earliestSubActivation
      ? earliestSubActivation.toISOString().slice(0, 10)
      : (inv.cf_subscription_activation_date || inv.subscription_activation_date || null);

    // Zoho Books doesn't put a subscription_activation_date directly on invoices.
    // The recurring_invoice_id on Books invoices is actually a Zoho Billing
    // subscription ID. We try both endpoints to find the activation date.
    let recurringInvoiceDebug = null;
    if (!subActivation && inv.recurring_invoice_id) {
      // Try 1: Zoho Billing subscription (most likely the case for SaaS invoices)
      try {
        const subRes = await axios.get(
          `${admin.api_domain}/billing/v1/subscriptions/${inv.recurring_invoice_id}`,
          {
            headers: {
              Authorization: `Zoho-oauthtoken ${accessToken}`,
              'X-com-zoho-subscriptions-organizationid': process.env.ZOHO_ORG_ID,
            },
            validateStatus: () => true,
          }
        );
        const sub = subRes.data?.subscription;
        if (sub) {
          // Billing subscription fields: activated_at (timestamp), current_term_starts_at,
          // last_billing_at, created_time. activated_at is the first activation.
          const activatedRaw = sub.activated_at || sub.current_term_starts_at || sub.start_date;
          if (activatedRaw) {
            // activated_at can be unix timestamp (seconds) or ISO. Normalize to YYYY-MM-DD.
            let d = null;
            if (typeof activatedRaw === 'number' || /^\d+$/.test(activatedRaw)) {
              d = new Date(parseInt(activatedRaw) * 1000);
            } else {
              d = new Date(activatedRaw);
            }
            if (d && !isNaN(d.getTime())) subActivation = d.toISOString().slice(0, 10);
          }
          recurringInvoiceDebug = {
            source: 'billing_subscription',
            subscription_id: sub.subscription_id,
            status:          sub.status,
            activated_at:    sub.activated_at,
            current_term_starts_at: sub.current_term_starts_at,
            last_billing_at: sub.last_billing_at,
            created_time:    sub.created_time,
            plan:            sub.plan?.plan_code,
          };
        } else {
          recurringInvoiceDebug = {
            source: 'billing_subscription',
            error_status: subRes.status,
            error_body:   typeof subRes.data === 'object' ? JSON.stringify(subRes.data).slice(0, 300) : String(subRes.data).slice(0, 300),
          };
        }
      } catch (e) {
        recurringInvoiceDebug = { source: 'billing_subscription', exception: e.message };
      }

      // Try 2: Zoho Books recurring invoice (fallback if Billing didn't work)
      if (!subActivation) {
        try {
          const recRes = await axios.get(
            `${admin.api_domain}/books/v3/recurringinvoices/${inv.recurring_invoice_id}`,
            {
              params: { organization_id: process.env.ZOHO_ORG_ID },
              headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
              validateStatus: () => true,
            }
          );
          const rec = recRes.data?.recurring_invoice;
          if (rec) {
            subActivation = rec.start_date || null;
            if (subActivation) {
              recurringInvoiceDebug = {
                ...recurringInvoiceDebug,
                fallback_books_recurring: {
                  recurring_invoice_id: rec.recurring_invoice_id,
                  start_date: rec.start_date,
                  status: rec.status,
                },
              };
            }
          }
        } catch (_e) { /* keep null */ }
      }
    }

    // 6. Customer linking: for HARDWARE invoices, find this customer's first paid SaaS
    //    invoice (with subscription_activation_date) to determine when SaaS started.
    let firstSaasInvoice = null;
    if (invoiceType === 'hardware' && inv.customer_id) {
      const custInvRes = await axios.get(
        `${admin.api_domain}/books/v3/invoices`,
        {
          params: {
            organization_id: process.env.ZOHO_ORG_ID,
            customer_id: inv.customer_id,
            status: 'paid',
            sort_column: 'date',
            sort_order: 'A',
            per_page: 50,
          },
          headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
          validateStatus: () => true,
        }
      );
      const customerInvoices = (custInvRes.data?.invoices || [])
        .filter(ci => ci.invoice_id !== inv.invoice_id); // skip self
      // Walk the customer's paid invoices (already sorted ascending by date) and find the
      // FIRST one that has any SaaS line item. Detail calls go out in bounded-concurrency
      // batches instead of one sequential Zoho round-trip per invoice (the old loop could
      // blow past Heroku's 30s H12 timeout for customers with many paid invoices). We stop
      // launching batches as soon as an earlier batch yields a match, so we never over-call
      // Zoho — and picking the first match *in original order* preserves "earliest SaaS".
      let firstSaasDet = null;
      const DETAIL_CONCURRENCY = 6;
      for (let start = 0; start < customerInvoices.length && !firstSaasDet; start += DETAIL_CONCURRENCY) {
        const batch = customerInvoices.slice(start, start + DETAIL_CONCURRENCY);
        const dets = await Promise.all(batch.map(ci =>
          axios.get(
            `${admin.api_domain}/books/v3/invoices/${ci.invoice_id}`,
            {
              params: { organization_id: process.env.ZOHO_ORG_ID },
              headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
              validateStatus: () => true,
            }
          ).then(r => r.data?.invoice || null).catch(() => null)
        ));
        for (const det_inv of dets) {
          if (!det_inv) continue;
          const hasSaas = (det_inv.line_items || []).some(li => {
            const sku = (li.sku || li.item_code || '').toLowerCase().trim();
            if (sku && planCodes.has(sku)) return true;
            const n = normalizeName(li.name);
            return !!(n && planNames.has(n));
          });
          if (hasSaas) { firstSaasDet = det_inv; break; }
        }
      }

      if (firstSaasDet) {
        const det_inv = firstSaasDet;
        // Get subscription activation: line items first, then recurring template start_date
        const subDateFromLines = (det_inv.line_items || [])
          .map(li => li.subscription_activation_date || li.start_date)
          .filter(Boolean)
          .map(d => new Date(d))
          .sort((a, b) => a - b)[0];
        let activationDate = subDateFromLines
          ? subDateFromLines.toISOString().slice(0, 10)
          : (det_inv.cf_subscription_activation_date || null);

        // Fall back to the Billing subscription's activated_at (or Books recurring invoice)
        if (!activationDate && det_inv.recurring_invoice_id) {
          try {
            const subRes = await axios.get(
              `${admin.api_domain}/billing/v1/subscriptions/${det_inv.recurring_invoice_id}`,
              {
                headers: {
                  Authorization: `Zoho-oauthtoken ${accessToken}`,
                  'X-com-zoho-subscriptions-organizationid': process.env.ZOHO_ORG_ID,
                },
                validateStatus: () => true,
              }
            );
            const sub = subRes.data?.subscription;
            if (sub) {
              const activatedRaw = sub.activated_at || sub.current_term_starts_at || sub.start_date;
              if (activatedRaw) {
                let d = null;
                if (typeof activatedRaw === 'number' || /^\d+$/.test(activatedRaw)) {
                  d = new Date(parseInt(activatedRaw) * 1000);
                } else {
                  d = new Date(activatedRaw);
                }
                if (d && !isNaN(d.getTime())) activationDate = d.toISOString().slice(0, 10);
              }
            }
          } catch (_e) { /* keep null */ }
        }

        firstSaasInvoice = {
          invoice_number: det_inv.invoice_number,
          invoice_id: det_inv.invoice_id,
          date: det_inv.date,
          last_payment_date: det_inv.last_payment_date,
          recurring_invoice_id: det_inv.recurring_invoice_id || null,
          subscription_activation_date: activationDate,
        };
      }
    }

    // 7. Compute commission_payable_date based on invoice type
    let payableDate = null;
    let commissionStatus = 'calculated';
    if (inv.status !== 'paid') {
      commissionStatus = 'pending_payment';
    } else if (invoiceType === 'saas') {
      // SaaS invoice: paid + activation date on the invoice itself
      if (subActivation) {
        payableDate = paidDate > subActivation ? paidDate : subActivation;
        commissionStatus = 'eligible';
      } else {
        commissionStatus = 'pending_saas';
      }
    } else if (invoiceType === 'hardware') {
      // Hardware invoice: paid + customer has paid SaaS with activation
      if (firstSaasInvoice && firstSaasInvoice.subscription_activation_date) {
        const saasDate = firstSaasInvoice.subscription_activation_date;
        payableDate = paidDate > saasDate ? paidDate : saasDate;
        commissionStatus = 'eligible';
      } else {
        commissionStatus = 'pending_saas';
      }
    }

    // DEBUG: surface every field on the invoice + first line item that could be
    // a subscription/activation date so we can identify what Zoho actually calls it.
    const invKeys = Object.keys(inv);
    const dateOrSubKeys = invKeys.filter(k => /subscript|activ|start|date|recurr|period|cf_/i.test(k));
    const debugInvFields = {};
    for (const k of dateOrSubKeys) debugInvFields[k] = inv[k];
    const debugCustomFields = inv.custom_fields || inv.custom_field_hash || null;
    const firstLineKeys = inv.line_items?.[0] ? Object.keys(inv.line_items[0]) : [];
    const firstLineDateKeys = firstLineKeys.filter(k => /subscript|activ|start|date|recurr|period|cf_/i.test(k));
    const debugFirstLineFields = {};
    if (inv.line_items?.[0]) {
      for (const k of firstLineDateKeys) debugFirstLineFields[k] = inv.line_items[0][k];
    }

    res.json({
      invoice_number: inv.invoice_number,
      customer_name:  inv.customer_name,
      customer_id:    inv.customer_id,
      status:         inv.status,
      total:          inv.total,
      balance:        inv.balance,
      date:           inv.date,
      paid_date:      paidDate,
      invoice_type:   invoiceType,
      subscription_activation_date: subActivation,
      first_saas_invoice: firstSaasInvoice,
      commission_payable_date: payableDate,
      commission_status: commissionStatus,
      classified_line_items: classified,
      _debug: {
        invoice_date_fields: debugInvFields,
        invoice_custom_fields: debugCustomFields,
        first_line_item_date_fields: debugFirstLineFields,
        recurring_invoice_id: inv.recurring_invoice_id,
        recurring_invoice_template: recurringInvoiceDebug,
        invoice_all_keys: invKeys,
        first_line_item_all_keys: firstLineKeys,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message, body: error.response?.data });
  }
});

// POST /api/billing/sync — fetch all plans from Zoho Billing and upsert into our DB
app.post('/api/billing/sync', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  try {
    // Use the most recent admin's Zoho token (same pattern as autoSyncInvoices)
    const adminResult = await pool.query(
      'SELECT email, access_token, api_domain, expires_at FROM user_tokens WHERE is_admin = true ORDER BY updated_at DESC LIMIT 1'
    );
    if (!adminResult.rows[0]) return res.status(400).json({ error: 'No admin Zoho token available' });
    const admin = adminResult.rows[0];

    // Ensure token is valid — ensureValidToken returns the full row, we need just access_token
    const tokenData = await ensureValidToken(admin.email);
    const token = typeof tokenData === 'string' ? tokenData : tokenData?.access_token;
    if (!token) return res.status(400).json({ error: 'Could not refresh Zoho token' });

    const orgId = process.env.ZOHO_ORG_ID;
    const billing = new ZohoBillingService(token, admin.api_domain, orgId);

    // Quick connection test first
    const conn = await billing.testConnection();
    if (!conn.ok) {
      return res.status(400).json({
        error: 'Zoho Billing connection failed',
        status: conn.status,
        body: conn.body,
        hint: 'You may need to re-authorize Zoho with the ZohoSubscriptions scope (ZohoSubscriptions.plans.READ).',
      });
    }

    const result = await billing.getPlans();
    if (!result.ok) {
      return res.status(500).json({ error: 'Failed to fetch plans', details: result.error });
    }

    let upserted = 0;
    for (const p of result.plans) {
      await pool.query(`
        INSERT INTO zoho_plans (
          plan_code, name, description, recurring_price, interval, interval_unit,
          currency_code, product_id, product_name, status, raw, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, CURRENT_TIMESTAMP)
        ON CONFLICT (plan_code) DO UPDATE SET
          name             = EXCLUDED.name,
          description      = EXCLUDED.description,
          recurring_price  = EXCLUDED.recurring_price,
          interval         = EXCLUDED.interval,
          interval_unit    = EXCLUDED.interval_unit,
          currency_code    = EXCLUDED.currency_code,
          product_id       = EXCLUDED.product_id,
          product_name     = EXCLUDED.product_name,
          status           = EXCLUDED.status,
          raw              = EXCLUDED.raw,
          updated_at       = CURRENT_TIMESTAMP
      `, [
        p.plan_code,
        p.name || '',
        p.description || '',
        parseFloat(p.recurring_price) || 0,
        p.interval || '',
        p.interval_unit || '',
        p.currency_code || '',
        p.product_id || '',
        p.product_name || '',
        p.status || '',
        JSON.stringify(p),
      ]);
      upserted++;
    }

    res.json({ success: true, fetched: result.plans.length, upserted });
  } catch (error) {
    console.error('billing sync error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/sync/all-status', authenticateToken, async (req, res) => {
  try {
    // Books — most recent successful sync_log entry
    const booksRes = await pool.query(
      `SELECT synced_at, invoice_count, status FROM sync_log
       WHERE organization_id = $1 ORDER BY synced_at DESC LIMIT 1`,
      [process.env.ZOHO_ORG_ID]
    );
    const booksCount = await pool.query(
      `SELECT COUNT(*) AS cnt FROM invoices WHERE organization_id = $1`,
      [process.env.ZOHO_ORG_ID]
    );

    // CRM — most recent updated_at on the deals table
    const crmRes = await pool.query(
      `SELECT MAX(updated_at) AS last_at, COUNT(*) AS cnt FROM crm_sold_deals`
    );

    // Zentact — most recent updated_at + webhook stats (in-memory)
    const zentRes = await pool.query(
      `SELECT MAX(updated_at) AS last_at, COUNT(*) AS cnt,
              COUNT(CASE WHEN status = 'ACTIVE' THEN 1 END) AS active
       FROM zentact_merchants`
    );

    res.json({
      books: {
        lastSyncAt:    booksRes.rows[0]?.synced_at  || null,
        invoiceCount:  parseInt(booksCount.rows[0]?.cnt) || 0,
        status:        booksRes.rows[0]?.status     || 'never',
        autoSyncEvery: '4h',
      },
      crm: {
        lastSyncAt:  crmRes.rows[0]?.last_at || null,
        dealCount:   parseInt(crmRes.rows[0]?.cnt) || 0,
        autoSyncEvery: '1h',
      },
      zentact: {
        lastSyncAt:    zentRes.rows[0]?.last_at || null,
        merchantCount: parseInt(zentRes.rows[0]?.cnt)    || 0,
        activeCount:   parseInt(zentRes.rows[0]?.active) || 0,
        autoSyncEvery: '1h',
        webhookConfigured: !!process.env.ZENTACT_WEBHOOK_SECRET,
        webhookLastReceivedAt: webhookStats.last_received_at,
        webhookTotalReceived:  webhookStats.received_total,
      },
      serverTime: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get all-status', details: error.message });
  }
});

// ============================================================================
// COMMISSIONS REPORT
// ============================================================================

// GET /api/commissions/viewable-reps — rep names the viewer may open a report for.
// Admin → all active reps; manager (report:view_others) → their managed team(s); else → just self.
app.get('/api/commissions/viewable-reps', authenticateToken, async (req, res) => {
  const { email, isAdmin, name: jwtName } = req.user;
  try {
    if (isAdmin) {
      const r = await pool.query(`SELECT name FROM salespeople WHERE is_active = true ORDER BY name`);
      return res.json({ reps: r.rows.map(x => x.name), canViewOthers: true });
    }
    const tokenResult = await pool.query('SELECT display_name FROM user_tokens WHERE email = $1', [email]);
    const myName = tokenResult.rows[0]?.display_name || jwtName || email;
    const perms = await getUserPermissions(email);
    if (userHasPermission(perms, 'report:view_others')) {
      const names = await getManagedRepNames(email);
      const set = new Set(names.map(n => n.toLowerCase()));
      set.add(String(myName).toLowerCase());
      const reps = [...new Set([myName, ...names])].sort((a, b) => a.localeCompare(b));
      return res.json({ reps, canViewOthers: reps.length > 1 });
    }
    return res.json({ reps: [myName], canViewOthers: false });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/commissions/report?year=&repName=&month=
app.get('/api/commissions/report', authenticateToken, async (req, res) => {
  const { email, isAdmin, name: jwtName } = req.user;
  const { year, repName, month } = req.query;
  const targetYear = year || new Date().getFullYear().toString();

  if ((await getDisabledReportYears()).includes(parseInt(targetYear, 10))) {
    return res.status(403).json({ error: 'This report year is disabled', code: 'year_disabled' });
  }

  try {
    const tokenResult = await pool.query('SELECT display_name FROM user_tokens WHERE email = $1', [email]);
    const myName    = tokenResult.rows[0]?.display_name || jwtName || email;
    const targetRep = await resolveTargetRep(req, repName, myName);

    // Salary/total-compensation is gated: visible to admins, to a rep viewing their OWN report,
    // or to anyone with report:view_salary. A team manager without it sees commissions but not pay.
    const isOwnReport = String(targetRep).toLowerCase() === String(myName).toLowerCase();
    let canViewSalary = isAdmin || isOwnReport;
    if (!canViewSalary) canViewSalary = userHasPermission(await getUserPermissions(email), 'report:view_salary');

    const spResult = await pool.query('SELECT commission_rate, base_salary FROM salespeople WHERE name = $1', [targetRep]);
    const commissionRate = parseFloat(spResult.rows[0]?.commission_rate) || 10;
    const baseSalary = canViewSalary ? (parseFloat(spResult.rows[0]?.base_salary) || 0) : null; // annual base salary (null = hidden)

    const startDate = new Date(`${targetYear}-01-01`);
    const endDate   = new Date(`${targetYear}-12-31T23:59:59.999`);

    // groupBy=payable (default, new behaviour) → bucket invoices by commission_payable_date.
    //   That's the month the rep "unlocks" the commission (paid SaaS first month / hardware
    //   within 6-month window). Invoices with NULL payable_date are not yet earned and
    //   are surfaced separately (see pending stats below).
    // groupBy=invoice → legacy: bucket by invoice date.
    const groupBy = (req.query.groupBy || 'payable').toString();
    const dateCol = groupBy === 'invoice' ? 'date' : 'commission_payable_date';

    const monthlyResult = await pool.query(`
      SELECT
        EXTRACT(MONTH FROM ${dateCol}) AS month_num,
        COUNT(*) AS invoices,
        COALESCE(SUM(total), 0) AS revenue,
        COALESCE(SUM(commission), 0) AS commission,
        COALESCE(SUM(CASE WHEN commission_paid THEN commission ELSE 0 END), 0) AS paid_commission,
        COALESCE(SUM(CASE WHEN status = 'paid' THEN total ELSE 0 END), 0) AS paid_revenue,
        -- All three counts share the same base: invoices that actually EARN commission
        -- (commission > 0). Previously paid/approved counted ANY approval_status (incl. $0
        -- too_late invoices) while qualifying required commission_status IN (hardware,saas_first)
        -- — which missed mixed invoices bucketed 'saas_renewal' that still carry hardware
        -- commission. That mismatch let paid/approved exceed qualifying → the misleading
        -- "0/0/15" orange pill. Aligning on commission > 0 guarantees paid,approved ⊆ qualifying.
        COUNT(CASE WHEN commission > 0 AND approval_status = 'paid' THEN 1 END) AS commission_paid_count,
        COUNT(CASE WHEN commission > 0 AND approval_status = 'approved' THEN 1 END) AS commission_approved_count,
        COUNT(CASE WHEN commission > 0 THEN 1 END) AS commission_qualifying_count,
        COALESCE(SUM(CASE WHEN approval_status = 'approved' THEN commission ELSE 0 END), 0) AS approved_commission
      FROM invoices
      WHERE salesperson_name = $1 AND organization_id = $2
        AND ${dateCol} >= $3 AND ${dateCol} <= $4
      GROUP BY EXTRACT(MONTH FROM ${dateCol}) ORDER BY month_num
    `, [targetRep, process.env.ZOHO_ORG_ID, startDate, endDate]);

    // Pending stats — invoices with commission > 0 but no payable date yet (waiting for SaaS / payment)
    const pendingResult = await pool.query(`
      SELECT
        COUNT(*) AS pending_count,
        COALESCE(SUM(CASE WHEN hardware_amount > 0 THEN hardware_amount * ($5::numeric / 100.0) ELSE 0 END), 0) AS pending_commission
      FROM invoices
      WHERE salesperson_name = $1 AND organization_id = $2
        AND date >= $3 AND date <= $4
        AND commission_status IN ('pending_saas','pending_payment')
    `, [targetRep, process.env.ZOHO_ORG_ID, startDate, endDate, commissionRate]);

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
        commissionPaidCount:       parseInt(m.commission_paid_count)        || 0,
        commissionApprovedCount:   parseInt(m.commission_approved_count)    || 0,
        commissionQualifyingCount: parseInt(m.commission_qualifying_count)  || 0,
        approvedCommission:        parseFloat(m.approved_commission)        || 0,
      };
    });

    // Customers — only invoices with earned commission (hardware or saas_first with commission > 0).
    // Scope to the selected month (when given) so it matches the subtitle + the drill-down; else YTD.
    let custStart = startDate, custEnd = endDate, custEndOp = '<=';
    if (month && month !== 'all') {
      custStart = new Date(`${targetYear}-${String(month).padStart(2, '0')}-01`);
      custEnd = new Date(custStart); custEnd.setMonth(custEnd.getMonth() + 1); custEndOp = '<';
    }
    const customerResult = await pool.query(`
      SELECT COALESCE(customer_name, 'Unknown') AS customer_name,
             COUNT(*) AS invoices,
             COALESCE(SUM(total), 0) AS revenue,
             COALESCE(SUM(commission), 0) AS commission
      FROM invoices
      WHERE salesperson_name = $1 AND organization_id = $2
        AND ${dateCol} >= $3 AND ${dateCol} ${custEndOp} $4
        AND commission > 0 AND commission_status IN ('hardware','saas_first','saas_annual')
      GROUP BY customer_name ORDER BY commission DESC LIMIT 50
    `, [targetRep, process.env.ZOHO_ORG_ID, custStart, custEnd]);

    const currentMonthNum  = new Date().getMonth();  // 0-indexed
    const currentMonthData = months[currentMonthNum];
    const ytdCommission    = months.reduce((s, m) => s + m.commission, 0);
    const ytdRevenue       = months.reduce((s, m) => s + m.revenue,    0);
    const ytdInvoices      = months.reduce((s, m) => s + m.invoices,   0);

    const pendingRow = pendingResult.rows[0] || {};
    res.json({
      repName: targetRep,
      commissionRate,
      baseSalary,
      canViewSalary,
      year: targetYear,
      groupBy,
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
        pending: {
          count:      parseInt(pendingRow.pending_count) || 0,
          commission: parseFloat(pendingRow.pending_commission) || 0,
        },
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
    const targetRep = await resolveTargetRep(req, repName, myName);
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

    // groupBy=payable (default) → group by commission_payable_date when month filter is provided
    // groupBy=invoice → legacy mode: group by invoice date
    const groupBy = (req.query.groupBy || 'payable').toString();
    const dateCol = groupBy === 'invoice' ? 'date' : 'commission_payable_date';

    // When grouping by payable, NULL commission_payable_date rows are not yet payable — exclude
    // unless caller is asking for the whole year (no specific month).
    const whereDate = (month && month !== 'all')
      ? `${dateCol} >= $3 AND ${dateCol} < $4`
      : (groupBy === 'payable'
          ? `(${dateCol} IS NULL OR (${dateCol} >= $3 AND ${dateCol} <= $4))`
          : `${dateCol} >= $3 AND ${dateCol} <= $4`);

    // Optional customer filter — used by the "Commission by customer" drill-down so it shows
    // ONLY that customer's invoices (previously this param was ignored → it returned everyone's).
    const customer = (req.query.customer || '').toString().trim();
    // Optional free-text search (?q=) — partial match on customer name OR invoice number, so a
    // rep can find a specific client/invoice across the whole period (used with month omitted).
    const q = (req.query.q || '').toString().trim();
    const result = await pool.query(`
      SELECT invoice_number, customer_name, date, total, commission, status,
             commission_paid, commission_status, commission_payable_date,
             hardware_amount, saas_amount, subscription_activation_date, paid_date,
             approval_status, approved_by, approved_at, payout_paid_by, payout_paid_at
      FROM invoices
      WHERE salesperson_name = $1 AND organization_id = $2 AND ${whereDate}
        AND ($5::text IS NULL OR COALESCE(customer_name, 'Unknown') = $5)
        AND ($6::text IS NULL OR customer_name ILIKE '%'||$6||'%' OR invoice_number ILIKE '%'||$6||'%')
      ORDER BY COALESCE(commission_payable_date, date) DESC, date DESC
    `, [targetRep, process.env.ZOHO_ORG_ID, startDate, endDate, customer || null, q || null]);

    res.json({
      invoices: result.rows.map(r => ({
        invoiceNumber:              r.invoice_number,
        customerName:               r.customer_name || 'Unknown',
        date:                       r.date,
        total:                      parseFloat(r.total),
        commission:                 parseFloat(r.commission),
        status:                     r.status,
        commissionPaid:             r.commission_paid || false,
        commissionStatus:           r.commission_status || null,
        commissionPayableDate:      r.commission_payable_date || null,
        hardwareAmount:             parseFloat(r.hardware_amount) || 0,
        saasAmount:                 parseFloat(r.saas_amount) || 0,
        subscriptionActivationDate: r.subscription_activation_date || null,
        paidDate:                   r.paid_date || null,
        approvalStatus:             r.approval_status || 'pending',
        approvedBy:                 r.approved_by || null,
        approvedAt:                 r.approved_at || null,
        payoutPaidBy:               r.payout_paid_by || null,
        payoutPaidAt:               r.payout_paid_at || null,
      }))
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch commission invoices', details: error.message });
  }
});

// GET /api/commissions/my-processing — a rep's PAYMENT (Zentact) merchants with their processing
// revenue (transaction profit + other revenue, all-time) and the bi-annual "processing bonus"
// commission paid on each. Rep-scoped via resolveTargetRep (a salesperson sees only their own;
// an admin/manager can pass ?repName=).
app.get('/api/commissions/my-processing', authenticateToken, async (req, res) => {
  const { email, name: jwtName } = req.user;
  try {
    const tokenResult = await pool.query('SELECT display_name FROM user_tokens WHERE email = $1', [email]);
    const myName = tokenResult.rows[0]?.display_name || jwtName || email;
    const targetRep = await resolveTargetRep(req, req.query.repName, myName);

    const merchants = (await pool.query(`
      SELECT zm.merchant_account_id, zm.business_name, zm.status, zm.activated_at,
             COALESCE(SUM(r.transaction_profit_cents),0)::bigint AS profit_cents,
             COALESCE(SUM(r.other_revenue_cents),0)::bigint     AS other_cents
      FROM zentact_merchants zm
      LEFT JOIN zentact_merchant_revenue r ON r.merchant_account_id = zm.merchant_account_id
      WHERE LOWER(zm.sales_rep_name) = LOWER($1)
      GROUP BY zm.merchant_account_id, zm.business_name, zm.status, zm.activated_at
      ORDER BY (COALESCE(SUM(r.transaction_profit_cents),0)+COALESCE(SUM(r.other_revenue_cents),0)) DESC
    `, [targetRep])).rows;

    // Processing bonuses already paid/committed to this rep (one per merchant account).
    const bonuses = (await pool.query(`
      SELECT merchant_name, matched_zentact_id, amount::float AS amount, report_date, paid_for_period
      FROM commission_bonuses WHERE LOWER(rep_name) = LOWER($1) AND bonus_type = 'processing'
    `, [targetRep])).rows;
    const bonusByMid = new Map(), bonusByName = new Map();
    for (const b of bonuses) {
      if (b.matched_zentact_id) bonusByMid.set(b.matched_zentact_id, b);
      if (b.merchant_name) bonusByName.set(b.merchant_name.toLowerCase(), b);
    }

    // Reps see only their merchants + the commission paid — NOT the underlying processing
    // revenue (business-sensitive), so it's intentionally omitted from the response.
    const out = merchants.map(m => {
      const b = bonusByMid.get(m.merchant_account_id) || bonusByName.get((m.business_name || '').toLowerCase()) || null;
      return {
        merchantId: m.merchant_account_id, name: m.business_name || m.merchant_account_id,
        status: m.status, activatedAt: m.activated_at,
        bonusPaid: !!b, bonusAmount: b ? b.amount : 0, bonusDate: b ? (b.report_date || b.paid_for_period) : null,
      };
    });
    const totals = { bonus: out.reduce((a, m) => a + m.bonusAmount, 0) };
    res.json({ rep: targetRep, merchants: out, totals });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/commissions/approve — supports { repName, year, month } OR { invoiceNumbers: [...] }
// Locks a commission for payroll: sets approval_status='approved' (does NOT mark as paid).
// Use /mark-paid afterwards to record actual rep payout.
app.post('/api/commissions/approve', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'report:approve'))) return;
  const { repName, year, month, invoiceNumbers } = req.body;
  const approverEmail = req.user.realAdminEmail || req.user.email || 'unknown';
  try {
    let result;
    if (Array.isArray(invoiceNumbers) && invoiceNumbers.length > 0) {
      result = await pool.query(
        `UPDATE invoices
         SET approval_status = 'approved',
             approved_by    = $2,
             approved_at    = CURRENT_TIMESTAMP,
             updated_at     = CURRENT_TIMESTAMP
         WHERE invoice_number = ANY($1)
           AND commission > 0 AND commission_status IN ('hardware','saas_first','saas_annual')
           AND approval_status = 'pending'
         RETURNING invoice_number`,
        [invoiceNumbers, approverEmail]
      );
    } else if (repName && year && month) {
      const startDate = new Date(`${year}-${String(month).padStart(2, '0')}-01`);
      const endDate   = new Date(startDate);
      endDate.setMonth(endDate.getMonth() + 1);
      // Approve only invoices whose commission was actually EARNED (hardware or saas_first),
      // whose unlock month falls in the chosen month, and that are still pending.
      result = await pool.query(
        `UPDATE invoices
         SET approval_status = 'approved',
             approved_by    = $5,
             approved_at    = CURRENT_TIMESTAMP,
             updated_at     = CURRENT_TIMESTAMP
         WHERE salesperson_name = $1 AND organization_id = $2
           AND commission_payable_date >= $3 AND commission_payable_date < $4
           AND commission > 0 AND commission_status IN ('hardware','saas_first','saas_annual')
           AND approval_status = 'pending'
         RETURNING invoice_number`,
        [repName, process.env.ZOHO_ORG_ID, startDate, endDate, approverEmail]
      );
    } else {
      return res.status(400).json({ error: 'Provide repName+year+month or invoiceNumbers' });
    }
    res.json({ success: true, invoicesUpdated: result.rowCount });
  } catch (error) {
    res.status(500).json({ error: 'Failed to approve commissions', details: error.message });
  }
});

// POST /api/commissions/unapprove — revert approved/paid back to pending.
// Caller needs report:approve (an approver can undo their own + mark_paid actions too).
app.post('/api/commissions/unapprove', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'report:approve'))) return;
  const { repName, year, month, invoiceNumbers } = req.body;
  try {
    let result;
    if (Array.isArray(invoiceNumbers) && invoiceNumbers.length > 0) {
      result = await pool.query(
        `UPDATE invoices
         SET approval_status = 'pending',
             approved_by = NULL, approved_at = NULL,
             payout_paid_by = NULL, payout_paid_at = NULL,
             commission_paid = false,
             updated_at = CURRENT_TIMESTAMP
         WHERE invoice_number = ANY($1)
         RETURNING invoice_number`,
        [invoiceNumbers]
      );
    } else if (repName && year && month) {
      const startDate = new Date(`${year}-${String(month).padStart(2, '0')}-01`);
      const endDate   = new Date(startDate);
      endDate.setMonth(endDate.getMonth() + 1);
      result = await pool.query(
        `UPDATE invoices
         SET approval_status = 'pending',
             approved_by = NULL, approved_at = NULL,
             payout_paid_by = NULL, payout_paid_at = NULL,
             commission_paid = false,
             updated_at = CURRENT_TIMESTAMP
         WHERE salesperson_name = $1 AND organization_id = $2
           AND commission_payable_date >= $3 AND commission_payable_date < $4
         RETURNING invoice_number`,
        [repName, process.env.ZOHO_ORG_ID, startDate, endDate]
      );
      // Also remove the app-generated pay-stub record for the period (created by Mark Paid /
      // commit) so undo is clean — never deletes a real imported pay file.
      await pool.query(
        `DELETE FROM commission_payment_imports
         WHERE rep_name = $1 AND paid_for_period = $2::date AND filename LIKE 'app-generated%'`,
        [repName, `${year}-${String(month).padStart(2, '0')}-01`]
      );
    } else {
      return res.status(400).json({ error: 'Provide repName+year+month or invoiceNumbers' });
    }
    res.json({ success: true, invoicesUpdated: result.rowCount });
  } catch (error) {
    res.status(500).json({ error: 'Failed to unapprove commissions', details: error.message });
  }
});

// POST /api/commissions/invoice/:number/commission-excluded { excluded } — refuse/restore
// commission on ONE invoice. excluded=true: flag it + immediately zero (status 'excluded').
// excluded=false: clear the flag + recompute (background recalc) so its commission comes back.
// Admin / report:mark_paid. Refuses if the invoice is already paid (unapprove it first).
app.post('/api/commissions/invoice/:number/commission-excluded', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'report:mark_paid'))) return;
  const number = req.params.number;
  const excluded = req.body.excluded !== false;
  try {
    const inv = (await pool.query(
      `SELECT approval_status FROM invoices WHERE invoice_number = $1 AND organization_id = $2`,
      [number, process.env.ZOHO_ORG_ID]
    )).rows[0];
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    if (inv.approval_status === 'paid') return res.status(409).json({ error: 'Invoice is already paid — unapprove it first' });
    if (excluded) {
      await pool.query(
        `UPDATE invoices SET commission_excluded = true, commission = 0, commission_status = 'excluded',
           commission_payable_date = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE invoice_number = $1 AND organization_id = $2`,
        [number, process.env.ZOHO_ORG_ID]
      );
      return res.json({ success: true, excluded: true });
    }
    // Restore: clear the flag, then a background recalc recomputes the real commission.
    await pool.query(
      `UPDATE invoices SET commission_excluded = false, updated_at = CURRENT_TIMESTAMP
       WHERE invoice_number = $1 AND organization_id = $2`,
      [number, process.env.ZOHO_ORG_ID]
    );
    runRecalcV2('exclude-restore').catch(e => console.error('exclude-restore recalc error:', e));
    res.json({ success: true, excluded: false, note: 'recalc-v2 starting — commission recomputes in ~1-3 min' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update commission exclusion', details: error.message });
  }
});

// POST /api/commissions/mark-paid — final step in the workflow.
// Flips approval_status 'approved' → 'paid' and stamps payout actor + timestamp.
// Also flips legacy commission_paid=true for backward-compatibility with any code
// still reading that column.
// Body: { repName, year, month } OR { invoiceNumbers: [...] }
// Snapshot an app-generated pay-stub import for a rep+period from the invoices already marked
// PAID there (+ signup/perf/manual bonuses), so the period shows as a proper "imported"/paid pay
// stub and lands in payroll. Idempotent (replaces any prior app-generated import). Skips if a real
// imported pay file covers the period. Called after the report's "Mark Paid" so that action and the
// pay-stub "commit" converge on the same record.
async function snapshotAppGeneratedStub(repName, year, month, actor) {
  const mm = String(month).padStart(2, '0');
  const periodStart = new Date(`${year}-${mm}-01`);
  const periodEnd = new Date(periodStart); periodEnd.setMonth(periodEnd.getMonth() + 1);
  const periodDate = `${year}-${mm}-01`;
  const orgId = process.env.ZOHO_ORG_ID;
  const real = (await pool.query(
    `SELECT 1 FROM commission_payment_imports WHERE rep_name = $1 AND paid_for_period >= $2::date
       AND paid_for_period < $3::date AND filename NOT LIKE 'app-generated%' LIMIT 1`,
    [repName, periodStart, periodEnd])).rows[0];
  if (real) return null; // a real pay file is the source of truth — don't overwrite
  const invRows = (await pool.query(
    `SELECT invoice_number, customer_name, commission::float AS commission FROM invoices
     WHERE salesperson_name = $1 AND organization_id = $2 AND commission_payable_date >= $3
       AND commission_payable_date < $4 AND commission > 0
       AND commission_status IN ('hardware','saas_first','saas_annual') AND approval_status = 'paid'
     ORDER BY commission DESC`,
    [repName, orgId, periodStart, periodEnd])).rows;
  const bonusRows = (await pool.query(
    `SELECT merchant_account_id, business_name, bonus_amount::float AS bonus_amount, activated_at::date AS activated_at
     FROM zentact_merchants WHERE LOWER(sales_rep_name) = LOWER($1) AND status = 'ACTIVE'
       AND activated_at >= $2 AND activated_at < $3`,
    [repName, periodStart, periodEnd])).rows;
  if (!invRows.length && !bonusRows.length) return null; // nothing to record
  const bonusTotal = bonusRows.reduce((a, r) => a + (r.bonus_amount || 0), 0);
  let perfBonus = 0, perfPts = 0;
  if (periodStart >= PLAN_START_DATE) {
    const ptsMap = await getMonthlyPointsByRep(periodStart);
    perfPts = ptsMap.get(`${repName}|${year}-${mm}`) || 0;
    const spQ = await pool.query(`SELECT monthly_quota FROM salespeople WHERE name = $1`, [repName]);
    const quota = spQ.rows[0]?.monthly_quota == null ? MONTHLY_QUOTA : parseInt(spQ.rows[0].monthly_quota);
    perfBonus = perfPts >= quota ? ZohoCRMService.calculateMonthlyBonus(perfPts) : 0;
  }
  const manualRows = (await pool.query(
    `SELECT amount::float AS amount, description FROM manual_bonuses WHERE rep_name = $1 AND period = $2::date`,
    [repName, periodDate])).rows;
  const manualTotal = manualRows.reduce((a, m) => a + (m.amount || 0), 0);
  const total = invRows.reduce((a, r) => a + (r.commission || 0), 0) + bonusTotal + perfBonus + manualTotal;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM commission_payment_imports WHERE rep_name = $1 AND paid_for_period = $2::date AND filename LIKE 'app-generated%'`,
      [repName, periodDate]);
    const filename = `app-generated:${repName}:${year}-${mm}`;
    const imp = (await client.query(
      `INSERT INTO commission_payment_imports
         (filename, rep_name, paid_for_period, imported_by, invoices_marked, invoices_skipped,
          invoices_not_found, signup_bonuses_count, signup_bonuses_amount, monthly_bonus_amount, total_amount, raw_summary)
       VALUES ($1, $2, $3::date, $4, $5, 0, 0, $6, $7, $8, $9, $10::jsonb) RETURNING id`,
      [filename, repName, periodDate, actor, invRows.length, bonusRows.length, bonusTotal, perfBonus + manualTotal, total,
       JSON.stringify({ source: 'app-generated', via: 'mark-paid', period: `${year}-${mm}`, performance_points: perfPts })])).rows[0];
    for (const r of invRows) {
      await client.query(`INSERT INTO commission_payment_lines (import_id, invoice_number, customer, paid_amount, app_commission) VALUES ($1,$2,$3,$4,$4)`,
        [imp.id, r.invoice_number, r.customer_name || null, r.commission || 0]);
    }
    for (const b of bonusRows) {
      await client.query(`INSERT INTO commission_bonuses (import_id, rep_name, bonus_type, merchant_name, matched_zentact_id, amount, paid_for_period, report_date) VALUES ($1,$2,'signup',$3,$4,$5,$6::date,$7::date)`,
        [imp.id, repName, b.business_name || null, b.merchant_account_id || null, b.bonus_amount || 0, periodDate, b.activated_at || null]);
    }
    if (perfBonus > 0) await client.query(`INSERT INTO commission_bonuses (import_id, rep_name, bonus_type, merchant_name, amount, paid_for_period) VALUES ($1,$2,'monthly_performance',$3,$4,$5::date)`,
      [imp.id, repName, `${perfPts} pts`, perfBonus, periodDate]);
    for (const m of manualRows) await client.query(`INSERT INTO commission_bonuses (import_id, rep_name, bonus_type, merchant_name, amount, paid_for_period) VALUES ($1,$2,'manual',$3,$4,$5::date)`,
      [imp.id, repName, m.description || null, m.amount, periodDate]);
    await client.query('COMMIT');
    return { importId: imp.id, total, invoices: invRows.length };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

app.post('/api/commissions/mark-paid', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'report:mark_paid'))) return;
  const { repName, year, month, invoiceNumbers } = req.body;
  const payerEmail = req.user.realAdminEmail || req.user.email || 'unknown';
  try {
    let result;
    if (Array.isArray(invoiceNumbers) && invoiceNumbers.length > 0) {
      result = await pool.query(
        `UPDATE invoices
         SET approval_status = 'paid',
             commission_paid = true,
             payout_paid_by  = $2,
             payout_paid_at  = CURRENT_TIMESTAMP,
             updated_at      = CURRENT_TIMESTAMP
         WHERE invoice_number = ANY($1) AND approval_status = 'approved'
         RETURNING invoice_number`,
        [invoiceNumbers, payerEmail]
      );
    } else if (repName && year && month) {
      const startDate = new Date(`${year}-${String(month).padStart(2, '0')}-01`);
      const endDate   = new Date(startDate);
      endDate.setMonth(endDate.getMonth() + 1);
      result = await pool.query(
        `UPDATE invoices
         SET approval_status = 'paid',
             commission_paid = true,
             payout_paid_by  = $5,
             payout_paid_at  = CURRENT_TIMESTAMP,
             updated_at      = CURRENT_TIMESTAMP
         WHERE salesperson_name = $1 AND organization_id = $2
           AND commission_payable_date >= $3 AND commission_payable_date < $4
           AND approval_status = 'approved'
         RETURNING invoice_number`,
        [repName, process.env.ZOHO_ORG_ID, startDate, endDate, payerEmail]
      );
      // Record the pay stub so the period shows as paid AND lands in payroll (converges with
      // the pay-stub "commit"). Best-effort — marking paid already succeeded.
      try { await snapshotAppGeneratedStub(repName, parseInt(year), parseInt(month), payerEmail); }
      catch (e) { console.error('snapshotAppGeneratedStub error:', e.message); }
    } else {
      return res.status(400).json({ error: 'Provide repName+year+month or invoiceNumbers' });
    }
    res.json({ success: true, invoicesUpdated: result.rowCount });
  } catch (error) {
    res.status(500).json({ error: 'Failed to mark commissions as paid', details: error.message });
  }
});

// GET /api/commissions/pay-stub?repName=&year=&month=
// A unified pay stub for one rep + one month. Two sources, picked automatically:
//   - 'imported': a commission_payment_imports row exists for (rep, period) → the historical
//     pay file is the source of truth (faithful paid amounts + bonuses + total). If that import
//     predates per-line storage (2026-06-09) its lines table is empty → linesStored=false and we
//     attach APP-GENERATED lines as a fallback so the stub is never blank (the file total stays
//     authoritative).
//   - 'generated': no import for that period (the app's own model) → invoice commissions whose
//     Unlock Month (commission_payable_date) falls in the period + signup bonuses from Zentact
//     activations in the period.
// Access: admins see any rep; non-admins need report:view_paystub and (by rep resolution) only
// ever see their OWN stub. Read-only — no DB writes here.
app.get('/api/commissions/pay-stub', authenticateToken, async (req, res) => {
  const { email, isAdmin, name: jwtName } = req.user;
  const { repName, year, month } = req.query;
  if (!year || !month || month === 'all') {
    return res.status(400).json({ error: 'year and a specific month are required' });
  }
  try {
    // Non-admins must hold the dedicated permission; rep resolution below pins them to self.
    // canAudit gates the model-vs-paid comparison (App calc. + missed radar) — payroll
    // admins only. Reps must not see how the app's numbers compare to what was paid.
    let canAudit = !!isAdmin;
    if (!isAdmin) {
      const perms = await getUserPermissions(email);
      if (!userHasPermission(perms, 'report:view_paystub')) {
        return res.status(403).json({ error: 'Permission required: report:view_paystub' });
      }
      canAudit = userHasPermission(perms, 'report:mark_paid');
    }
    const tokenResult = await pool.query('SELECT display_name FROM user_tokens WHERE email = $1', [email]);
    const myName    = tokenResult.rows[0]?.display_name || jwtName || email;
    const targetRep = isAdmin ? (repName || myName) : myName;

    const mm          = String(month).padStart(2, '0');
    const periodStart = new Date(`${year}-${mm}-01`);
    const periodEnd   = new Date(periodStart); periodEnd.setMonth(periodEnd.getMonth() + 1);

    // App-generated invoice lines: commissions that UNLOCKED in this period.
    // Each line carries approval_status so callers can split paid vs unpaid.
    const genLines = async () => {
      const rows = (await pool.query(
        `SELECT invoice_number, customer_name, commission::float AS commission, approval_status
         FROM invoices
         WHERE salesperson_name = $1 AND organization_id = $2
           AND commission_payable_date >= $3 AND commission_payable_date < $4
           AND commission > 0 AND commission_status IN ('hardware','saas_first','saas_annual')
         ORDER BY commission DESC`,
        [targetRep, process.env.ZOHO_ORG_ID, periodStart, periodEnd]
      )).rows;
      return rows.map(r => ({
        invoice_number: r.invoice_number,
        customer:       r.customer_name || null,
        paid_amount:    r.commission || 0,
        app_commission: r.commission || 0,
        approval_status: r.approval_status || 'pending',
      }));
    };
    // Committed bi-annual processing bonuses (platform commit = import_id NULL) whose payout
    // period is this month. Shows on the June/December stub once the bi-annual payout is
    // ACCEPTED via the Processing-bonus card commit. Read-only here (the card owns the rows),
    // so it never double-counts. Empty for non-June/December months (no such rows exist).
    const committedProcessing = async () => {
      const rows = (await pool.query(
        `SELECT merchant_name, amount::float AS amount, report_date::date AS report_date
           FROM commission_bonuses
          WHERE rep_name = $1 AND bonus_type = 'processing' AND import_id IS NULL
            AND paid_for_period >= $2::date AND paid_for_period < $3::date
          ORDER BY amount DESC`,
        [targetRep, periodStart, periodEnd]
      )).rows;
      return rows.map(r => ({ bonus_type: 'processing', merchant_name: r.merchant_name, amount: r.amount, report_date: r.report_date }));
    };

    // App-generated signup bonuses: Zentact merchants this rep activated in the period.
    const genBonuses = async () => {
      const rows = (await pool.query(
        `SELECT business_name AS merchant_name, bonus_amount::float AS bonus_amount, activated_at::date AS activated_at
         FROM zentact_merchants
         WHERE LOWER(sales_rep_name) = LOWER($1) AND status = 'ACTIVE'
           AND activated_at >= $2 AND activated_at < $3`,
        [targetRep, periodStart, periodEnd]
      )).rows;
      const bonuses = rows.map(r => ({
        bonus_type:    'signup',
        merchant_name: r.merchant_name || null,
        amount:        r.bonus_amount || 0,
        report_date:   r.activated_at || null,
      }));
      // Monthly performance bonus (plan v7.7 §5): when the month's quota is met, the
      // highest tier reached pays (20→$250, 25→$500, 30→$1000, non-cumulative).
      // Platform era only — historical (imported) periods carried it inside the file.
      if (periodStart >= PLAN_START_DATE) {
        const ptsMap = await getMonthlyPointsByRep(periodStart);
        const ym = `${periodStart.getFullYear()}-${String(periodStart.getMonth() + 1).padStart(2, '0')}`;
        const pts = ptsMap.get(`${targetRep}|${ym}`) || 0;
        const spQ = await pool.query(
          `SELECT monthly_quota FROM salespeople WHERE name = $1`, [targetRep]
        );
        const quota = spQ.rows[0]?.monthly_quota == null ? MONTHLY_QUOTA : parseInt(spQ.rows[0].monthly_quota);
        const bonus = pts >= quota ? ZohoCRMService.calculateMonthlyBonus(pts) : 0;
        if (bonus > 0) {
          bonuses.push({
            bonus_type:    'monthly_performance',
            merchant_name: `${pts} pts`,
            amount:        bonus,
            report_date:   null,
          });
        }
      }
      // NOTE: the bi-annual PROCESSING bonus is intentionally NOT added here. It is managed
      // entirely separately via the "Processing Bonus (bi-annual)" card (Admin → Import
      // Commissions) so it never clutters the monthly pay stub (user decision 2026-06-15).
      // Manually-added bonuses (admin-curated, free-text) for this rep + period.
      const manual = (await pool.query(
        `SELECT amount::float AS amount, description FROM manual_bonuses
         WHERE rep_name = $1 AND period = $2::date ORDER BY created_at`,
        [targetRep, periodStart]
      )).rows;
      for (const m of manual) {
        bonuses.push({ bonus_type: 'manual', merchant_name: m.description || null, amount: m.amount, report_date: null });
      }
      // Accepted bi-annual processing payout for this month (June/December).
      bonuses.push(...(await committedProcessing()));
      return bonuses;
    };

    // Prefer a historical import for this rep+period when one exists.
    const imp = (await pool.query(
      `SELECT * FROM commission_payment_imports
       WHERE rep_name = $1 AND paid_for_period >= $2::date AND paid_for_period < $3::date
       ORDER BY imported_at DESC LIMIT 1`,
      [targetRep, periodStart, periodEnd]
    )).rows[0];

    if (imp) {
      const lines = (await pool.query(
        `SELECT invoice_number, customer, paid_amount::float AS paid_amount, app_commission::float AS app_commission, not_in_db
         FROM commission_payment_lines WHERE import_id = $1 ORDER BY not_in_db ASC, paid_amount DESC`,
        [imp.id]
      )).rows;
      const bonuses = (await pool.query(
        `SELECT bonus_type, merchant_name, amount::float AS amount, report_date::date AS report_date
         FROM commission_bonuses WHERE import_id = $1 ORDER BY bonus_type, amount DESC`,
        [imp.id]
      )).rows;
      // An accepted bi-annual processing payout (import_id NULL) for June/December isn't linked
      // to this import row, but still belongs on the period's stub — append it + add to total.
      const procExtra = await committedProcessing();
      bonuses.push(...procExtra);
      const procExtraTotal = procExtra.reduce((a, b) => a + b.amount, 0);
      const linesStored = lines.length > 0;
      // "Missed" = earned (unlocked) in this period per the app's model but still NOT paid —
      // i.e. invoices the pay file didn't cover. This is the user's forgot-to-pay radar.
      const appLines = await genLines();
      const missed   = appLines.filter(l => l.approval_status !== 'paid')
        .map(l => ({ invoice_number: l.invoice_number, customer: l.customer, app_commission: l.app_commission }));
      const outLines = (linesStored ? lines : appLines)
        .map(l => canAudit ? l : { ...l, app_commission: null });
      return res.json({
        source:      'imported',
        linesStored,
        repName:     targetRep,
        period:      `${year}-${mm}`,
        importId:    imp.id,
        filename:    imp.filename,
        appGenerated: String(imp.filename || '').startsWith('app-generated'),  // undoable via uncommit
        lines:       outLines,
        bonuses,
        total:       (parseFloat(imp.total_amount) || 0) + procExtraTotal,
        missed:      canAudit ? missed : [],
        missedTotal: canAudit ? missed.reduce((a, l) => a + l.app_commission, 0) : 0,
      });
    }

    // No import → app generates the stub from its own model: UNPAID unlocked commissions only
    // (what you'd pay now — matches what the commit endpoint would mark). Already-paid lines
    // are excluded so the stub total = the amount actually owed.
    const lines   = (await genLines()).filter(l => l.approval_status !== 'paid');
    const bonuses = await genBonuses();
    const total   = lines.reduce((a, l) => a + l.paid_amount, 0) + bonuses.reduce((a, b) => a + b.amount, 0);

    // Quota-gate context for payroll admins (plan v7.7 §2): lets the modal show
    // "quota non atteint (X/15 pts)" + the per-month "payer quand même" override.
    let quota = null;
    if (canAudit && periodStart >= PLAN_START_DATE) {
      const sp = (await pool.query(
        `SELECT monthly_quota, quota_gate_enabled, hire_date FROM salespeople WHERE name = $1`, [targetRep]
      )).rows[0];
      if (sp && sp.quota_gate_enabled !== false) {
        const ptsMap = await getMonthlyPointsByRep(periodStart);
        const points = ptsMap.get(`${targetRep}|${year}-${mm}`) || 0;
        const required = sp.monthly_quota == null ? MONTHLY_QUOTA : parseInt(sp.monthly_quota);
        const ramp = sp.hire_date && (periodStart.getTime() - new Date(sp.hire_date).getTime()) < 90 * 86400000;
        const waived = (await pool.query(
          `SELECT 1 FROM quota_month_waivers WHERE rep_name = $1 AND period = $2::date`,
          [targetRep, `${year}-${mm}-01`]
        )).rows.length > 0;
        quota = { points, required, met: points >= required, ramp: !!ramp, waived };
      }
    }

    return res.json({
      source:      'generated',
      linesStored: true,
      repName:     targetRep,
      period:      `${year}-${mm}`,
      lines,
      bonuses,
      total,
      quota,
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to build pay stub', details: e.message });
  }
});

// POST /api/commissions/pay-stub/email — email a branded copy of a pay stub.
// Body: { repName, period, to, lines[], bonuses[], total, source }. Gated by report:view_paystub
// (admins pass). The stub content is rendered server-side into the branded mail shell.
app.post('/api/commissions/pay-stub/email', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'report:view_paystub'))) return;
  const { repName, period, to, lines = [], bonuses = [], total = 0, source } = req.body || {};
  const recipient = String(to || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient)) return res.status(400).json({ error: 'valid recipient email required' });
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  try {
    const lineRows = (lines || []).map(l =>
      `<tr><td style="padding:6px 10px;border-top:1px solid #eef1f6;font-family:monospace">${esc(l.invoice_number)}</td>
           <td style="padding:6px 10px;border-top:1px solid #eef1f6">${esc(l.customer) || '—'}</td>
           <td style="padding:6px 10px;border-top:1px solid #eef1f6;text-align:right">${money(l.paid_amount)}</td></tr>`).join('');
    const bonusRows = (bonuses || []).map(b => {
      const label = b.bonus_type === 'signup' ? 'Bonus d\'inscription'
        : (b.bonus_type === 'monthly' || b.bonus_type === 'monthly_performance') ? 'Bonus mensuel'
        : b.bonus_type === 'processing' ? 'Bonus de paiement'
        : b.bonus_type === 'adjustment' ? 'Ajustement' : esc(b.bonus_type);
      return `<tr><td style="padding:6px 10px;border-top:1px solid #eef1f6">${label}</td>
           <td style="padding:6px 10px;border-top:1px solid #eef1f6">${esc(b.merchant_name) || '—'}</td>
           <td style="padding:6px 10px;border-top:1px solid #eef1f6;text-align:right">${money(b.amount)}</td></tr>`;
    }).join('');
    const statusLabel = source === 'imported' ? 'Payé / Paid' : 'En attente d\'approbation / Pending approval';
    const sectionLabel = (txt) => `<p style="margin:18px 0 6px;color:#94a3b8;font-size:11px;text-transform:uppercase;font-weight:700;letter-spacing:.4px">${txt}</p>`;
    const inner = `<h1 style="margin:0 0 4px;color:#0f1722;font-size:20px;font-weight:700;line-height:1.3">${esc(repName)}</h1>
            <p style="margin:0 0 4px;color:#64748b;font-size:13px">Bulletin de paie / Pay Stub · ${esc(period)}</p>
            <p style="margin:0;color:#64748b;font-size:13px">${statusLabel}</p>
            ${lineRows ? sectionLabel('Commissions') + `<table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#1c2434;border-collapse:collapse">${lineRows}</table>` : ''}
            ${bonusRows ? sectionLabel('Bonus') + `<table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#1c2434;border-collapse:collapse">${bonusRows}</table>` : ''}
            <table width="100%" style="margin-top:20px;border-top:2px solid #0f1722"><tr>
              <td style="padding-top:12px;font-size:14px;font-weight:700;color:#0f1722">Total</td>
              <td style="padding-top:12px;text-align:right;font-size:20px;font-weight:700;color:#f97316">${money(total)}</td></tr></table>
            <p style="margin:18px 0 0;color:#94a3b8;font-size:11px">Montants bruts, avant impôts et retenues. / Gross amounts, before tax and withholdings.</p>`;
    const html = mailChrome(inner, `Bulletin de paie / Pay Stub — ${esc(repName)} · ${esc(period)}`);
    const r = await sendMail(recipient, `Bulletin de paie / Pay Stub — ${repName} · ${period}`, html);
    if (!r.sent) return res.status(502).json({ error: r.reason || 'send failed' });
    res.json({ sent: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create a Jira issue via the Cloud REST API (best-effort; never throws). Requires env
// JIRA_BASE_URL (e.g. https://clusterpos.atlassian.net), JIRA_EMAIL, JIRA_API_TOKEN.
// Optional: JIRA_PROJECT_KEY (default SH), JIRA_ISSUE_TYPE (default Task). Returns
// { created, key } or { created:false, reason } so callers can degrade gracefully.
async function createJiraIssue({ summary, descriptionText, labels = [] }) {
  const base = (process.env.JIRA_BASE_URL || '').replace(/\/+$/, '');
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  if (!base || !email || !token) return { created: false, reason: 'jira_not_configured' };
  const auth = Buffer.from(`${email}:${token}`).toString('base64');
  const body = {
    fields: {
      project: { key: process.env.JIRA_PROJECT_KEY || 'SH' },
      summary: String(summary || 'Feature request').slice(0, 250),
      issuetype: { name: process.env.JIRA_ISSUE_TYPE || 'Task' },
      labels: (labels || []).map(l => String(l).replace(/\s+/g, '-')),
      description: {
        type: 'doc', version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: String(descriptionText || '').slice(0, 30000) }] }],
      },
    },
  };
  try {
    const resp = await fetch(`${base}/rest/api/3/issue`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return { created: false, reason: `jira_${resp.status}: ${(await resp.text()).slice(0, 300)}` };
    const data = await resp.json();
    return { created: true, key: data.key };
  } catch (e) {
    return { created: false, reason: e.message };
  }
}

// POST /api/feedback/feature-request — any authenticated user suggests a feature. Persists it
// to the "À corriger" dashboard (user_reports), auto-creates a Jira ticket in the backlog,
// and emails admins.
app.post('/api/feedback/feature-request', authenticateToken, async (req, res) => {
  const { email, name: jwtName } = req.user;
  const message = (req.body.message || '').toString().trim().slice(0, 4000);
  if (!message) return res.status(400).json({ error: 'message required' });
  try {
    const tok = await pool.query('SELECT display_name FROM user_tokens WHERE email = $1', [email]);
    const who = tok.rows[0]?.display_name || jwtName || email || 'Unknown user';
    const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // 1) Persist → shows in the admin "À corriger" dashboard (report_type 'feature_request').
    await pool.query(
      `INSERT INTO user_reports (report_type, reporter_email, reporter_name, message)
       VALUES ('feature_request', $1, $2, $3)`,
      [email || null, who, message]
    );
    _dataHealthCache = { at: 0, data: null }; // bust the 60s cache so the badge updates now
    // 2) Auto-create a Jira ticket in the backlog (best-effort — needs JIRA_* env vars).
    const firstLine = message.split('\n')[0].slice(0, 120);
    const jira = await createJiraIssue({
      summary: `Feature request: ${firstLine}`,
      descriptionText: `Submitted by ${who} (${email || '—'}) via Sales Hub.\n\n${message}`,
      labels: ['feature-request', 'sales-hub-intake'],
    });
    // 3) Email admins (existing behaviour), noting the Jira ticket if one was created.
    const admins = (await pool.query('SELECT email FROM user_tokens WHERE is_admin = true AND email IS NOT NULL')).rows.map(r => r.email);
    const recipients = [...new Set([...admins, process.env.SMTP_FROM || process.env.SMTP_USER].filter(Boolean))];
    const jiraLine = jira.created
      ? `<br><br><strong>JIRA:</strong> ${esc(jira.key)}${process.env.JIRA_BASE_URL ? ` — <a href="${process.env.JIRA_BASE_URL.replace(/\/+$/, '')}/browse/${esc(jira.key)}">${esc(jira.key)}</a>` : ''}`
      : '';
    const html = mailShell(
      'Demande de fonctionnalité / Feature request',
      `<strong>${esc(who)}</strong> (${esc(email || '—')}) propose / suggests:<br><br>${esc(message).replace(/\n/g, '<br>')}${jiraLine}`,
      null, null
    );
    const r = await sendMail(recipients.join(','), `Demande de fonctionnalité — ${who}`, html);
    res.json({ sent: r.sent, reason: r.reason, saved: true, jira });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Shared handler: a rep flags a missing commission OR missing points. Persists the report
// to user_reports (so it shows in the admin "À corriger" page) AND emails all admins.
// reportType: 'missing_commission' | 'missing_points'.
async function handleUserReport(reportType, req, res) {
  const isPoints = reportType === 'missing_points';
  const { email, name: jwtName } = req.user;
  const reference = (req.body.reference || req.body.invoiceNumber || req.body.merchant || '').toString().trim().slice(0, 80);
  const period    = (req.body.period || '').toString().trim().slice(0, 20);
  const message   = (req.body.message || '').toString().trim().slice(0, 2000);
  if (!message) return res.status(400).json({ error: 'message required' });
  try {
    const tok = await pool.query('SELECT display_name FROM user_tokens WHERE email = $1', [email]);
    const repName = tok.rows[0]?.display_name || jwtName || email || 'Unknown rep';
    // Persist so admins see it in the data-health page.
    await pool.query(
      `INSERT INTO user_reports (report_type, reporter_email, reporter_name, reference, period, message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [reportType, email || null, repName, reference || null, period || null, message]
    );
    _dataHealthCache = { at: 0, data: null }; // bust the 60s cache so the badge updates now
    // Email ONLY the configured recipient list. If none is set, the report lives in the
    // "À corriger" dashboard only — no email is sent (per admin's choice).
    const recipients = [...new Set(await getReportRecipients())];
    if (recipients.length === 0) {
      return res.json({ saved: true, sent: false, reason: 'no_recipients_configured', recipients: 0 });
    }
    const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const refLabel = isPoints ? 'Marchand / dossier · Merchant' : 'Facture · Invoice';
    const html = mailShell(
      isPoints ? 'Signalement de points manquants / Missing points report' : 'Signalement de commission manquante / Missing commission report',
      `<strong>${esc(repName)}</strong> (${esc(email || '—')}) ${isPoints ? 'signale des points possiblement manquants / reports possibly missing points' : 'signale une commission possiblement manquante / reports a possibly missing commission'}.<br><br>`
      + (reference ? `<strong>${refLabel} :</strong> ${esc(reference)}<br>` : '')
      + (period ? `<strong>Période · Period :</strong> ${esc(period)}<br>` : '')
      + `<strong>Message :</strong><br>${esc(message).replace(/\n/g, '<br>')}`,
      null, null
    );
    const subject = isPoints ? `Points manquants — ${repName}` : `Commission manquante — ${repName}`;
    const r = await sendMail(recipients.join(','), subject, html);
    res.json({ saved: true, sent: r.sent, reason: r.reason, recipients: recipients.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
// POST /api/commissions/missing-report — flag a missing commission (Commission Report page).
// Body: { invoiceNumber?|reference?, period?, message }.
app.post('/api/commissions/missing-report', authenticateToken, (req, res) => handleUserReport('missing_commission', req, res));
// POST /api/commissions/missing-points-report — flag missing points (Commission Tracker page).
// Body: { reference?|merchant?, period?, message }.
app.post('/api/commissions/missing-points-report', authenticateToken, (req, res) => handleUserReport('missing_points', req, res));

// POST /api/commissions/quota-waiver — admin decision: pay a rep's month DESPITE the
// missed quota (plan v7.7 exception). Body: { repName, year, month, waived }. Setting or
// removing a waiver kicks a recalc so the month's forfeited commissions come back (or
// get re-gated) — allow ~2 minutes before reopening the stub.
// ── Manual bonuses ──────────────────────────────────────────────────────────
// Add/list/delete a free-text bonus on a rep's monthly pay stub (admin-curated).
// GET ?year=&month= → all manual bonuses for that period (optionally ?repName=).
app.get('/api/commissions/manual-bonus', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'report:mark_paid'))) return;
  const select = `SELECT id, rep_name, period::date AS period, amount::float AS amount, description, created_by, created_at FROM manual_bonuses`;
  try {
    // history mode (?all=true): every manual bonus across all periods (admin console history),
    // optionally filtered by rep. Otherwise: just the requested year+month period.
    if (req.query.all === 'true' || req.query.all === '1') {
      const params = [];
      let where = '';
      if (req.query.repName) { params.push(req.query.repName); where = ` WHERE rep_name = $1`; }
      const rows = (await pool.query(`${select}${where} ORDER BY period DESC, created_at DESC`, params)).rows;
      return res.json({ bonuses: rows });
    }
    const year = parseInt(req.query.year), month = parseInt(req.query.month);
    if (!year || month < 1 || month > 12) return res.status(400).json({ error: 'year + month required' });
    const period = `${year}-${String(month).padStart(2, '0')}-01`;
    const params = [period];
    let where = 'period = $1::date';
    if (req.query.repName) { params.push(req.query.repName); where += ` AND rep_name = $2`; }
    const rows = (await pool.query(`${select} WHERE ${where} ORDER BY created_at DESC`, params)).rows;
    res.json({ bonuses: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/commissions/manual-bonus', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'report:mark_paid'))) return;
  const { repName, year, month, amount, description } = req.body;
  const amt = parseFloat(amount);
  if (!repName || !year || !month || isNaN(amt)) return res.status(400).json({ error: 'repName, year, month, amount required' });
  const period = `${year}-${String(month).padStart(2, '0')}-01`;
  const actor = req.user.realAdminEmail || req.user.email || 'unknown';
  try {
    const r = (await pool.query(
      `INSERT INTO manual_bonuses (rep_name, period, amount, description, created_by)
       VALUES ($1, $2::date, $3, $4, $5) RETURNING id`,
      [repName, period, Math.round(amt * 100) / 100, (description || '').toString().slice(0, 500), actor]
    )).rows[0];
    res.json({ success: true, id: r.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/commissions/manual-bonus/:id', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'report:mark_paid'))) return;
  try {
    await pool.query(`DELETE FROM manual_bonuses WHERE id = $1`, [parseInt(req.params.id)]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Commission adjustments (carry an unpaid commission forward to a target pay month) ──────

// GET /api/commissions/unpaid-commissions?repName=  — a rep's earned-but-unpaid commission
// invoices (the radar across all months), eligible to be carried forward as an adjustment.
app.get('/api/commissions/unpaid-commissions', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'report:mark_paid'))) return;
  const rep = req.query.repName;
  if (!rep) return res.status(400).json({ error: 'repName required' });
  try {
    const rows = (await pool.query(
      `SELECT invoice_number, customer_name AS customer, commission::float AS commission,
              commission_status, commission_payable_date::date AS payable_date
       FROM invoices
       WHERE salesperson_name = $1 AND organization_id = $2
         AND commission > 0 AND commission_status IN ('hardware','saas_first','saas_annual')
         AND approval_status <> 'paid'
       ORDER BY commission_payable_date, invoice_number`,
      [rep, process.env.ZOHO_ORG_ID]
    )).rows;
    res.json({ rep, invoices: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/commissions/adjustments?repName=&year=&month=  (or ?all=true) — list adjustments.
app.get('/api/commissions/adjustments', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'report:mark_paid'))) return;
  const sel = `SELECT id, rep_name, target_period::date AS target_period, invoice_number, customer,
                      amount::float AS amount, source_period::date AS source_period, description, created_by, created_at
               FROM commission_adjustments`;
  try {
    if (req.query.all === 'true' || req.query.all === '1') {
      const params = []; let where = '';
      if (req.query.repName) { params.push(req.query.repName); where = ' WHERE rep_name = $1'; }
      const rows = (await pool.query(`${sel}${where} ORDER BY target_period DESC, created_at DESC`, params)).rows;
      return res.json({ adjustments: rows });
    }
    const year = parseInt(req.query.year), month = parseInt(req.query.month);
    if (!year || month < 1 || month > 12) return res.status(400).json({ error: 'year+month or all=true required' });
    const period = `${year}-${String(month).padStart(2, '0')}-01`;
    const params = [period]; let where = ' WHERE target_period = $1::date';
    if (req.query.repName) { params.push(req.query.repName); where += ' AND rep_name = $2'; }
    const rows = (await pool.query(`${sel}${where} ORDER BY created_at DESC`, params)).rows;
    res.json({ adjustments: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/commissions/adjustments  body { repName, year, month, invoiceNumbers[], description? }
// Carries the selected invoices' commissions to the (year,month) target pay period by forcing
// their unlock month (commission_payable_date + payable_override) to that month. The invoice
// LEAVES its original month and appears in the target month's report/stub/payroll as a normal
// (still-pending) commission line. recalc honors payable_override; undo clears it.
app.post('/api/commissions/adjustments', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'report:mark_paid'))) return;
  const { repName, year, month, invoiceNumbers, description } = req.body;
  if (!repName || !year || !month || !Array.isArray(invoiceNumbers) || !invoiceNumbers.length) {
    return res.status(400).json({ error: 'repName, year, month, invoiceNumbers[] required' });
  }
  const target = `${year}-${String(month).padStart(2, '0')}-01`;
  const actor = req.user.realAdminEmail || req.user.email || 'unknown';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const created = [];
    for (const num of invoiceNumbers) {
      const inv = (await client.query(
        `SELECT invoice_number, customer_name, commission::float AS commission,
                commission_payable_date::date AS payable_date, approval_status
         FROM invoices WHERE invoice_number = $1 AND organization_id = $2`,
        [num, process.env.ZOHO_ORG_ID]
      )).rows[0];
      if (!inv || !(inv.commission > 0) || inv.approval_status === 'paid') continue; // skip missing/paid
      await client.query(
        `INSERT INTO commission_adjustments
           (rep_name, target_period, invoice_number, customer, amount, source_period, description, created_by)
         VALUES ($1, $2::date, $3, $4, $5, $6::date, $7, $8)`,
        [repName, target, inv.invoice_number, inv.customer_name || null, inv.commission,
         inv.payable_date, (description || '').toString().slice(0, 300), actor]
      );
      // Move the unlock month to the target (kept pending; paid when the target month is paid).
      await client.query(
        `UPDATE invoices SET commission_payable_date = $2::date, payable_override = $2::date,
           updated_at = CURRENT_TIMESTAMP
         WHERE invoice_number = $1 AND organization_id = $3`,
        [inv.invoice_number, target, process.env.ZOHO_ORG_ID]
      );
      created.push({ invoice_number: inv.invoice_number, amount: inv.commission });
    }
    await client.query('COMMIT');
    res.json({ success: true, created: created.length, total: Math.round(created.reduce((a, c) => a + c.amount, 0) * 100) / 100, items: created });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// DELETE /api/commissions/adjustments/:id  — undo: move the invoice back to its original month.
app.delete('/api/commissions/adjustments/:id', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'report:mark_paid'))) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const adj = (await client.query(`SELECT invoice_number, source_period::date AS source_period FROM commission_adjustments WHERE id = $1`, [parseInt(req.params.id)])).rows[0];
    if (adj && adj.invoice_number) {
      await client.query(
        `UPDATE invoices SET payable_override = NULL, commission_payable_date = COALESCE($3::date, commission_payable_date),
           updated_at = CURRENT_TIMESTAMP
         WHERE invoice_number = $1 AND organization_id = $2 AND payable_override IS NOT NULL`,
        [adj.invoice_number, process.env.ZOHO_ORG_ID, adj.source_period]
      );
    }
    await client.query(`DELETE FROM commission_adjustments WHERE id = $1`, [parseInt(req.params.id)]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

app.post('/api/commissions/quota-waiver', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'report:mark_paid'))) return;
  const { repName, year, month, waived } = req.body;
  if (!repName || !year || !month) return res.status(400).json({ error: 'repName, year, month required' });
  const period = `${year}-${String(month).padStart(2, '0')}-01`;
  const actor = req.user.realAdminEmail || req.user.email || 'unknown';
  try {
    if (waived === false) {
      await pool.query(`DELETE FROM quota_month_waivers WHERE rep_name = $1 AND period = $2::date`, [repName, period]);
    } else {
      await pool.query(
        `INSERT INTO quota_month_waivers (rep_name, period, created_by)
         VALUES ($1, $2::date, $3) ON CONFLICT (rep_name, period) DO NOTHING`,
        [repName, period, actor]
      );
    }
    res.json({ success: true, waived: waived !== false, recalc: 'started' });
    runRecalcV2('quota-waiver').catch(e => console.error('waiver recalc error:', e.message));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/commissions/pay-stub/commit — Étape 3 "commit": pay a period's APP-GENERATED stub.
// Marks the period's unlocked-but-unpaid commissions (Unlock Month in period, hardware/saas_first,
// not already paid) as paid, AND records the stub as an 'app-generated' import so it appears in
// history and re-opens as an imported stub. Refuses if a real imported pay file already covers the
// period (those are the source of truth pre-May-2026 — don't double-pay/clobber). Idempotent: a
// prior app-generated stub for the same rep+period is replaced. Admin / report:mark_paid only.
app.post('/api/commissions/pay-stub/commit', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'report:mark_paid'))) return;
  const { repName, year, month } = req.body;
  if (!repName || !year || !month) return res.status(400).json({ error: 'repName, year, month required' });
  const actor       = req.user.realAdminEmail || req.user.email || 'unknown';
  const mm          = String(month).padStart(2, '0');
  const periodStart = new Date(`${year}-${mm}-01`);
  const periodEnd   = new Date(periodStart); periodEnd.setMonth(periodEnd.getMonth() + 1);
  const periodDate  = `${year}-${mm}-01`;
  const client = await pool.connect();
  try {
    // Guard: a real imported pay file for this period wins — refuse to generate over it.
    const existing = (await client.query(
      `SELECT filename FROM commission_payment_imports
       WHERE rep_name = $1 AND paid_for_period >= $2::date AND paid_for_period < $3::date
         AND filename NOT LIKE 'app-generated%' LIMIT 1`,
      [repName, periodStart, periodEnd]
    )).rows[0];
    if (existing) {
      return res.status(409).json({ error: 'An imported pay file already covers this period', filename: existing.filename });
    }

    await client.query('BEGIN');

    const invRows = (await client.query(
      `SELECT invoice_number, customer_name, commission::float AS commission
       FROM invoices
       WHERE salesperson_name = $1 AND organization_id = $2
         AND commission_payable_date >= $3 AND commission_payable_date < $4
         AND commission > 0 AND commission_status IN ('hardware','saas_first','saas_annual')
         AND approval_status <> 'paid'
       ORDER BY commission DESC`,
      [repName, process.env.ZOHO_ORG_ID, periodStart, periodEnd]
    )).rows;
    const bonusRows = (await client.query(
      `SELECT merchant_account_id, business_name, bonus_amount::float AS bonus_amount, activated_at::date AS activated_at
       FROM zentact_merchants
       WHERE LOWER(sales_rep_name) = LOWER($1) AND status = 'ACTIVE'
         AND activated_at >= $2 AND activated_at < $3`,
      [repName, periodStart, periodEnd]
    )).rows;

    const bonusTotal = bonusRows.reduce((a, r) => a + (r.bonus_amount || 0), 0);

    // Monthly performance bonus (plan v7.7 §5) — same computation as the generated stub.
    let perfBonus = 0, perfPts = 0;
    if (periodStart >= PLAN_START_DATE) {
      const ptsMap = await getMonthlyPointsByRep(periodStart);
      perfPts = ptsMap.get(`${repName}|${year}-${mm}`) || 0;
      const spQ = await client.query(`SELECT monthly_quota FROM salespeople WHERE name = $1`, [repName]);
      const quota = spQ.rows[0]?.monthly_quota == null ? MONTHLY_QUOTA : parseInt(spQ.rows[0].monthly_quota);
      perfBonus = perfPts >= quota ? ZohoCRMService.calculateMonthlyBonus(perfPts) : 0;
    }

    // Bi-annual processing bonus (June/December only) — same computation as the stub.
    // Bi-annual processing bonus is managed separately (its own card) — never part of the
    // monthly stub commit (user decision 2026-06-15).
    const procAccounts = [];
    // Manual bonuses for this rep + period (snapshot into the committed stub).
    const manualRows = (await client.query(
      `SELECT amount::float AS amount, description FROM manual_bonuses
       WHERE rep_name = $1 AND period = $2::date ORDER BY created_at`,
      [repName, periodDate]
    )).rows;
    const manualTotal = manualRows.reduce((a, m) => a + (m.amount || 0), 0);
    const total      = invRows.reduce((a, r) => a + (r.commission || 0), 0) + bonusTotal + perfBonus + manualTotal;

    // Idempotent re-commit: drop any prior app-generated stub for this rep+period (cascades).
    await client.query(
      `DELETE FROM commission_payment_imports
       WHERE rep_name = $1 AND paid_for_period = $2::date AND filename LIKE 'app-generated%'`,
      [repName, periodDate]
    );

    const filename = `app-generated:${repName}:${year}-${mm}`;
    const imp = (await client.query(
      `INSERT INTO commission_payment_imports
         (filename, rep_name, paid_for_period, imported_by, invoices_marked, invoices_skipped,
          invoices_not_found, signup_bonuses_count, signup_bonuses_amount, monthly_bonus_amount,
          total_amount, raw_summary)
       VALUES ($1, $2, $3::date, $4, $5, 0, 0, $6, $7, $8, $9, $10::jsonb)
       RETURNING id`,
      [filename, repName, periodDate, actor, invRows.length, bonusRows.length, bonusTotal, perfBonus, total,
       JSON.stringify({ source: 'app-generated', period: `${year}-${mm}`, performance_points: perfPts })]
    )).rows[0];

    for (const r of invRows) {
      await client.query(
        `UPDATE invoices SET
           approval_status = 'paid', commission_paid = true,
           approved_by    = COALESCE(approved_by, $2),
           approved_at    = COALESCE(approved_at, $3::date),
           payout_paid_by = $4, payout_paid_at = $3::date,
           updated_at     = CURRENT_TIMESTAMP
         WHERE invoice_number = $1`,
        [r.invoice_number, actor, periodDate, `paystub:${filename}`]
      );
      await client.query(
        `INSERT INTO commission_payment_lines (import_id, invoice_number, customer, paid_amount, app_commission)
         VALUES ($1, $2, $3, $4, $4)`,
        [imp.id, r.invoice_number, r.customer_name || null, r.commission || 0]
      );
    }
    for (const b of bonusRows) {
      await client.query(
        `INSERT INTO commission_bonuses
           (import_id, rep_name, bonus_type, merchant_name, matched_zentact_id, amount, paid_for_period, report_date)
         VALUES ($1, $2, 'signup', $3, $4, $5, $6::date, $7::date)`,
        [imp.id, repName, b.business_name || null, b.merchant_account_id || null, b.bonus_amount || 0, periodDate, b.activated_at || null]
      );
    }
    if (perfBonus > 0) {
      await client.query(
        `INSERT INTO commission_bonuses
           (import_id, rep_name, bonus_type, merchant_name, amount, paid_for_period)
         VALUES ($1, $2, 'monthly_performance', $3, $4, $5::date)`,
        [imp.id, repName, `${perfPts} pts`, perfBonus, periodDate]
      );
    }
    for (const m of manualRows) {
      await client.query(
        `INSERT INTO commission_bonuses
           (import_id, rep_name, bonus_type, merchant_name, amount, paid_for_period)
         VALUES ($1, $2, 'manual', $3, $4, $5::date)`,
        [imp.id, repName, m.description || null, m.amount, periodDate]
      );
    }
    for (const a of procAccounts) {
      await client.query(
        `INSERT INTO commission_bonuses
           (import_id, rep_name, bonus_type, merchant_name, matched_zentact_id, amount, paid_for_period)
         VALUES ($1, $2, 'processing', $3, $4, $5, $6::date)`,
        [imp.id, repName, `${a.business_name} (${a.activeMonths} mo · ~$${a.avg.toFixed(0)}/mo)`, a.merchant_account_id || null, a.bonus, periodDate]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, invoicesMarked: invRows.length, bonuses: bonusRows.length, total });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'Failed to commit pay stub', details: e.message });
  } finally {
    client.release();
  }
});

// POST /api/commissions/pay-stub/uncommit — UNDO a "mark paid" (app-generated commit) for a
// rep+period: revert the invoices it marked paid back to pending and delete the app-generated
// import (cascades its lines + bonuses). Only touches app-generated stubs — never a real
// imported pay file. Admin / report:mark_paid only.
app.post('/api/commissions/pay-stub/uncommit', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'report:mark_paid'))) return;
  const { repName, year, month } = req.body;
  if (!repName || !year || !month) return res.status(400).json({ error: 'repName, year, month required' });
  const periodDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const imp = (await client.query(
      `SELECT id FROM commission_payment_imports
       WHERE rep_name = $1 AND paid_for_period = $2::date AND filename LIKE 'app-generated%'
       ORDER BY imported_at DESC LIMIT 1`,
      [repName, periodDate]
    )).rows[0];
    if (!imp) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No app-generated payment to undo for this rep/period' });
    }
    // Revert the invoices this commit marked paid (its payment lines) back to pending.
    const reverted = await client.query(
      `UPDATE invoices SET approval_status = 'pending', commission_paid = false,
         approved_by = NULL, approved_at = NULL, payout_paid_by = NULL, payout_paid_at = NULL,
         updated_at = CURRENT_TIMESTAMP
       WHERE organization_id = $1
         AND invoice_number IN (SELECT invoice_number FROM commission_payment_lines WHERE import_id = $2)`,
      [process.env.ZOHO_ORG_ID, imp.id]
    );
    // Delete the import row → cascades commission_payment_lines + commission_bonuses.
    await client.query(`DELETE FROM commission_payment_imports WHERE id = $1`, [imp.id]);
    await client.query('COMMIT');
    res.json({ success: true, reverted: reverted.rowCount });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'Failed to undo pay stub', details: e.message });
  } finally {
    client.release();
  }
});

// ============================================================================
// PAYROLL SEND — compile all active reps' pay for a month and email it to payroll
// ============================================================================
// Bi-weekly pay calendar (user-provided 2026). Each entry: [periodStart, periodEnd,
// commissionDueBy] in YYYY-MM-DD. "Commission due by" = the deadline to send to payroll.
const PAY_CALENDAR = [
  ['2025-12-28','2026-01-10','2026-01-13'],['2026-01-11','2026-01-24','2026-01-27'],
  ['2026-01-25','2026-02-07','2026-02-10'],['2026-02-08','2026-02-21','2026-02-24'],
  ['2026-02-22','2026-03-07','2026-03-10'],['2026-03-08','2026-03-21','2026-03-24'],
  ['2026-03-22','2026-04-04','2026-04-07'],['2026-04-05','2026-04-18','2026-04-21'],
  ['2026-04-19','2026-05-02','2026-05-05'],['2026-05-03','2026-05-16','2026-05-19'],
  ['2026-05-17','2026-05-30','2026-06-02'],['2026-05-31','2026-06-13','2026-06-16'],
  ['2026-06-14','2026-06-27','2026-06-30'],['2026-06-28','2026-07-11','2026-07-14'],
  ['2026-07-12','2026-07-25','2026-07-28'],['2026-07-26','2026-08-08','2026-08-11'],
  ['2026-08-09','2026-08-22','2026-08-25'],['2026-08-23','2026-09-05','2026-09-08'],
  ['2026-09-06','2026-09-19','2026-09-22'],['2026-09-20','2026-10-03','2026-10-06'],
  ['2026-10-04','2026-10-17','2026-10-20'],['2026-10-18','2026-10-31','2026-11-03'],
  ['2026-11-01','2026-11-14','2026-11-17'],['2026-11-15','2026-11-28','2026-12-01'],
  ['2026-11-29','2026-12-12','2026-12-15'],['2026-12-13','2026-12-26','2026-12-29'],
];

async function getPayrollRecipients() {
  try {
    const r = await pool.query(`SELECT value FROM app_settings WHERE key = 'payroll_recipients'`);
    const v = r.rows[0]?.value;
    return Array.isArray(v) ? v.filter(e => typeof e === 'string') : [];
  } catch { return []; }
}

// Per-rep pay for a month: committed import total if present, else the generated model
// (unpaid qualifying commissions + signup + monthly-performance + processing bonuses).
async function payrollDataForMonth(year, month) {
  const mm = String(month).padStart(2, '0');
  const periodStart = new Date(`${year}-${mm}-01`);
  const periodEnd = new Date(periodStart); periodEnd.setMonth(periodEnd.getMonth() + 1);
  const orgId = process.env.ZOHO_ORG_ID;
  const platform = periodStart >= PLAN_START_DATE;
  const ptsMap = platform ? await getMonthlyPointsByRep(periodStart) : new Map();

  const reps = (await pool.query(`SELECT name, monthly_quota FROM salespeople WHERE is_active = true ORDER BY name`)).rows;
  const out = [];
  for (const sp of reps) {
    const rep = sp.name;
    const imp = (await pool.query(
      `SELECT id, total_amount FROM commission_payment_imports
       WHERE rep_name = $1 AND paid_for_period >= $2::date AND paid_for_period < $3::date
       ORDER BY imported_at DESC LIMIT 1`, [rep, periodStart, periodEnd]
    )).rows[0];
    // Accepted bi-annual processing payout (platform commit = import_id NULL) for this month.
    // Added to BOTH stub branches so the June/December payroll matches the on-screen stub.
    const committedProc = (await pool.query(
      `SELECT merchant_name, amount::float AS amount FROM commission_bonuses
        WHERE rep_name = $1 AND bonus_type = 'processing' AND import_id IS NULL
          AND paid_for_period >= $2::date AND paid_for_period < $3::date`,
      [rep, periodStart, periodEnd]
    )).rows.map(p => ({ bonus_type: 'processing', merchant_name: p.merchant_name, amount: p.amount }));
    const committedProcTotal = committedProc.reduce((s, b) => s + b.amount, 0);
    let lines = [], bonuses = [], total = 0, source;
    if (imp) {
      source = 'imported';
      lines = (await pool.query(
        `SELECT invoice_number, customer, paid_amount::float AS paid_amount FROM commission_payment_lines
         WHERE import_id = $1 ORDER BY paid_amount DESC`, [imp.id])).rows;
      bonuses = (await pool.query(
        `SELECT bonus_type, merchant_name, amount::float AS amount FROM commission_bonuses
         WHERE import_id = $1 ORDER BY bonus_type`, [imp.id])).rows;
      bonuses.push(...committedProc);
      total = (parseFloat(imp.total_amount) || 0) + committedProcTotal;
    } else {
      source = 'generated';
      lines = (await pool.query(
        `SELECT invoice_number, customer_name AS customer, commission::float AS paid_amount FROM invoices
         WHERE salesperson_name = $1 AND organization_id = $2
           AND commission_payable_date >= $3 AND commission_payable_date < $4
           AND commission > 0 AND commission_status IN ('hardware','saas_first','saas_annual')
           AND approval_status <> 'paid' ORDER BY commission DESC`,
        [rep, orgId, periodStart, periodEnd])).rows;
      const signups = (await pool.query(
        `SELECT business_name AS merchant_name, bonus_amount::float AS amount FROM zentact_merchants
         WHERE LOWER(sales_rep_name) = LOWER($1) AND status = 'ACTIVE' AND activated_at >= $2 AND activated_at < $3`,
        [rep, periodStart, periodEnd])).rows;
      bonuses = signups.map(b => ({ bonus_type: 'signup', merchant_name: b.merchant_name, amount: b.amount }));
      if (platform) {
        const pts = ptsMap.get(`${rep}|${year}-${mm}`) || 0;
        const quota = sp.monthly_quota == null ? MONTHLY_QUOTA : parseInt(sp.monthly_quota);
        const mb = pts >= quota ? ZohoCRMService.calculateMonthlyBonus(pts) : 0;
        if (mb > 0) bonuses.push({ bonus_type: 'monthly_performance', merchant_name: `${pts} pts`, amount: mb });
      }
      const manual = (await pool.query(
        `SELECT amount::float AS amount, description FROM manual_bonuses
         WHERE rep_name = $1 AND period = $2::date`, [rep, periodStart]
      )).rows;
      for (const m of manual) bonuses.push({ bonus_type: 'manual', merchant_name: m.description, amount: m.amount });
      // Accepted bi-annual processing payout (June/December) — same rows the stub shows.
      bonuses.push(...committedProc);
      total = lines.reduce((s, l) => s + (l.paid_amount || 0), 0) + bonuses.reduce((s, b) => s + (b.amount || 0), 0);
    }
    total = Math.round(total * 100) / 100;
    if (total > 0 || lines.length || bonuses.length) out.push({ rep, source, lines, bonuses, total });
  }
  return out;
}

// All payroll email + PDF labels, by language. lang follows the admin's UI at send time;
// anything other than 'en' falls back to French (the default).
function payrollI18n(lang) {
  const en = String(lang || '').toLowerCase().startsWith('en');
  return en ? {
    emailSubject: 'Commissions payable', emailFooter: 'Detailed pay stubs attached (PDF). Gross amounts, before taxes and deductions.',
    payStubTitle: 'PAY STUB', rep: 'REP', period: 'PERIOD', status: 'STATUS', paid: 'Paid', pending: 'Pending approval',
    commissions: 'COMMISSIONS', invoice: 'INVOICE', customer: 'CUSTOMER', amount: 'AMOUNT', subtotalCommissions: 'Commissions subtotal',
    bonus: 'BONUSES', type: 'TYPE', detail: 'DETAIL', subtotalBonus: 'Bonus subtotal',
    totalPaid: 'TOTAL PAID', grossNote: 'Gross amounts, before taxes and deductions.',
    blSignup: 'Signup bonus', blMonthly: 'Monthly bonus', blProcessing: 'Processing bonus', blAdjustment: 'Adjustment',
  } : {
    emailSubject: 'Commissions à verser', emailFooter: 'Bulletins détaillés en pièce jointe (PDF). Montants bruts, avant impôts et retenues.',
    payStubTitle: 'BULLETIN DE PAIE', rep: 'VENDEUR', period: 'PÉRIODE', status: 'STATUT', paid: 'Payé', pending: "En attente d'approbation",
    commissions: 'COMMISSIONS', invoice: 'FACTURE', customer: 'CLIENT', amount: 'MONTANT', subtotalCommissions: 'Sous-total commissions',
    bonus: 'BONUS', type: 'TYPE', detail: 'DÉTAIL', subtotalBonus: 'Sous-total bonus',
    totalPaid: 'TOTAL VERSÉ', grossNote: 'Montants bruts, avant impôts et retenues.',
    blSignup: "Bonus d'inscription", blMonthly: 'Bonus mensuel', blProcessing: 'Bonus de processing', blAdjustment: 'Ajustement',
  };
}

// Build a single combined PDF (one rep per page) with pdfkit. Returns a Buffer.
function buildPayrollPdf(periodLabel, reps, lang) {
  const T = payrollI18n(lang);
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'LETTER', margin: 40 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const bl = (t) => t === 'signup' ? T.blSignup : (t === 'monthly' || t === 'monthly_performance') ? T.blMonthly : t === 'processing' ? T.blProcessing : t === 'adjustment' ? T.blAdjustment : t;
      const L = 40, R = 572, W = R - L, AMT_X = R - 96;     // content area + amount column
      const C = { dark: '#1c2434', orange: '#f2682c', gray: '#475569', light: '#94a3b8', zebra: '#fafbfd', line: '#e8edf3' };
      const ensure = (h) => { if (doc.y + h > 748) doc.addPage(); };

      const header = (r) => {
        doc.rect(0, 0, 612, 6).fill(C.orange);
        doc.rect(0, 6, 612, 74).fill(C.dark);
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(21).text('Sales Hub', L, 24);
        doc.fillColor('#8a99af').font('Helvetica').fontSize(9).text('by Cluster Systems', L, 50);
        doc.fillColor(C.orange).font('Helvetica-Bold').fontSize(9).text(T.payStubTitle, L, 26, { width: W, align: 'right', characterSpacing: 1.5 });
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(17).text(periodLabel, L, 42, { width: W, align: 'right' });
        // meta row
        const my = 96;
        const meta = [[T.rep, r.rep], [T.period, periodLabel], [T.status, r.source === 'imported' ? T.paid : T.pending]];
        const cw = W / 3;
        meta.forEach((m, i) => {
          const x = L + i * cw;
          doc.fillColor(C.light).font('Helvetica-Bold').fontSize(7).text(m[0], x, my, { characterSpacing: 1 });
          doc.fillColor(C.dark).font('Helvetica-Bold').fontSize(11).text(m[1], x, my + 11, { width: cw - 8 });
        });
        doc.y = my + 40;
        doc.moveTo(L, doc.y).lineTo(R, doc.y).strokeColor(C.line).lineWidth(1).stroke();
        doc.y += 16;
      };

      const sectionHead = (title, c0, c1) => {
        ensure(46);
        doc.fillColor(C.orange).font('Helvetica-Bold').fontSize(9).text(title, L, doc.y, { characterSpacing: 1.5 });
        doc.y += 15;
        const hy = doc.y;
        doc.fillColor(C.light).font('Helvetica-Bold').fontSize(7);
        doc.text(c0, L + 2, hy, { characterSpacing: 0.5 });
        doc.text(c1, L + 130, hy, { characterSpacing: 0.5 });
        doc.text(T.amount, AMT_X, hy, { width: 92, align: 'right', characterSpacing: 0.5 });
        doc.y = hy + 11;
        doc.moveTo(L, doc.y).lineTo(R, doc.y).strokeColor(C.dark).lineWidth(1).stroke();
        doc.y += 5;
      };
      const row = (c0, c1, amt, i) => {
        ensure(18);
        const y = doc.y;
        if (i % 2) doc.rect(L, y - 3, W, 17).fill(C.zebra);
        doc.fillColor(C.dark).font('Helvetica').fontSize(9).text(String(c0 || ''), L + 2, y, { width: 122, ellipsis: true });
        doc.fillColor(C.gray).text(String(c1 || '—'), L + 130, y, { width: AMT_X - (L + 130) - 8, ellipsis: true });
        doc.fillColor(C.dark).font('Helvetica-Bold').text(amt, AMT_X, y, { width: 92, align: 'right' });
        doc.y = y + 17;
      };
      const subtotal = (label, amt) => {
        doc.moveTo(L, doc.y).lineTo(R, doc.y).strokeColor(C.dark).lineWidth(1).stroke();
        doc.y += 5;
        const y = doc.y;
        doc.fillColor(C.gray).font('Helvetica-Bold').fontSize(8).text(label.toUpperCase(), L, y, { width: AMT_X - L - 8, align: 'right', characterSpacing: 0.5 });
        doc.fillColor(C.dark).fontSize(10).text(amt, AMT_X, y - 1, { width: 92, align: 'right' });
        doc.y = y + 18;
      };

      reps.forEach((r, idx) => {
        if (idx > 0) doc.addPage();
        header(r);
        if (r.lines.length) {
          sectionHead(T.commissions, T.invoice, T.customer);
          r.lines.forEach((l, i) => row(l.invoice_number, l.customer, money(l.paid_amount), i));
          subtotal(T.subtotalCommissions, money(r.lines.reduce((s, l) => s + (l.paid_amount || 0), 0)));
        }
        if (r.bonuses.length) {
          doc.y += 8;
          sectionHead(T.bonus, T.type, T.detail);
          r.bonuses.forEach((b, i) => row(bl(b.bonus_type), b.merchant_name, money(b.amount), i));
          subtotal(T.subtotalBonus, money(r.bonuses.reduce((s, b) => s + (b.amount || 0), 0)));
        }
        // TOTAL box
        ensure(60);
        doc.y += 12;
        const by = doc.y, bx = R - 268;
        doc.roundedRect(bx, by, 268, 40, 9).fillAndStroke('#fff4ec', '#f7c8ab');
        doc.fillColor(C.orange).font('Helvetica-Bold').fontSize(9).text(T.totalPaid, bx + 16, by + 15, { characterSpacing: 1 });
        doc.fillColor(C.dark).font('Helvetica-Bold').fontSize(18).text(money(r.total), bx + 16, by + 11, { width: 236, align: 'right' });
        doc.y = by + 56;
        doc.fillColor(C.light).font('Helvetica-Oblique').fontSize(7.5).text(T.grossNote, L, doc.y, { continued: true })
          .font('Helvetica').text('     Sales Hub · saleshub.clusterpos.com', { align: 'left' });
      });
      doc.end();
    } catch (e) { reject(e); }
  });
}

// GET /api/commissions/payroll/preview?year=&month= — per-rep totals + the calendar deadline.
app.get('/api/commissions/payroll/preview', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'report:mark_paid'))) return;
  const year = parseInt(req.query.year), month = parseInt(req.query.month);
  if (!year || month < 1 || month > 12) return res.status(400).json({ error: 'year + month required' });
  try {
    const reps = await payrollDataForMonth(year, month);
    const mm = String(month).padStart(2, '0');
    // Deadline = the "commission due by" of the LAST pay period whose end falls in the month.
    const inMonth = PAY_CALENDAR.filter(p => p[1].startsWith(`${year}-${mm}`));
    const dueBy = inMonth.length ? inMonth[inMonth.length - 1][2] : null;
    // Latest payroll-send timestamp per rep for this period (for the "Sent" badge).
    const sentMap = new Map(
      (await pool.query(
        `SELECT rep_name, MAX(sent_at) AS sent_at FROM payroll_sends WHERE period = $1::date GROUP BY rep_name`,
        [`${year}-${mm}-01`]
      )).rows.map(r => [r.rep_name, r.sent_at])
    );
    res.json({
      year, month, dueBy,
      recipients: await getPayrollRecipients(),
      grandTotal: Math.round(reps.reduce((s, r) => s + r.total, 0) * 100) / 100,
      reps: reps.map(r => ({ rep: r.rep, source: r.source, total: r.total, lineCount: r.lines.length, bonusCount: r.bonuses.length, sentAt: sentMap.get(r.rep) || null })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/commissions/payroll/recipients — the saved payroll recipient list.
app.get('/api/commissions/payroll/recipients', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'report:mark_paid'))) return;
  try {
    res.json({ recipients: await getPayrollRecipients() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/commissions/payroll/recipients { emails:[...] }
app.put('/api/commissions/payroll/recipients', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'report:mark_paid'))) return;
  const emails = Array.isArray(req.body?.emails) ? req.body.emails.map(e => String(e).trim().toLowerCase()).filter(Boolean) : null;
  if (!emails) return res.status(400).json({ error: 'emails array required' });
  if (emails.some(e => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))) return res.status(400).json({ error: 'invalid email' });
  try {
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('payroll_recipients', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify(emails)]
    );
    res.json({ recipients: emails });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/commissions/payroll/send { year, month } — email payroll the month's commissions:
// a summary table in the body + one combined PDF (all reps, one per page).
app.post('/api/commissions/payroll/send', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'report:mark_paid'))) return;
  const year = parseInt(req.body.year), month = parseInt(req.body.month);
  if (!year || month < 1 || month > 12) return res.status(400).json({ error: 'year + month required' });
  try {
    const recipients = await getPayrollRecipients();
    if (!recipients.length) return res.status(400).json({ error: 'no payroll recipients configured' });
    let reps = await payrollDataForMonth(year, month);
    // Optional multi-select: send only the chosen reps (default = all).
    const repFilter = Array.isArray(req.body.reps) ? req.body.reps.map(s => String(s)) : null;
    if (repFilter && repFilter.length) reps = reps.filter(r => repFilter.includes(r.rep));
    if (!reps.length) return res.status(400).json({ error: 'nothing to send for this period' });
    const mm = String(month).padStart(2, '0');
    const periodLabel = `${year}-${mm}`;
    const T = payrollI18n(req.body.lang);   // language follows the admin's UI at send time
    const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const grand = Math.round(reps.reduce((s, r) => s + r.total, 0) * 100) / 100;
    const rowsHtml = reps.map(r =>
      `<tr><td style="padding:6px 10px;border-top:1px solid #eef1f6">${r.rep}</td>
           <td style="padding:6px 10px;border-top:1px solid #eef1f6;text-align:right">${money(r.total)}</td></tr>`).join('');
    const inner = `<h1 style="margin:0 0 14px;color:#0f1722;font-size:20px;font-weight:700;line-height:1.3">${T.emailSubject} — ${periodLabel}</h1>
            <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#1c2434;border-collapse:collapse">
              <tr><th style="text-align:left;padding:6px 10px;color:#94a3b8;font-size:11px;letter-spacing:.4px">${T.rep}</th><th style="text-align:right;padding:6px 10px;color:#94a3b8;font-size:11px;letter-spacing:.4px">${T.amount}</th></tr>
              ${rowsHtml}
              <tr><td style="padding:10px;border-top:2px solid #0f1722;font-weight:700">${T.totalPaid}</td><td style="padding:10px;border-top:2px solid #0f1722;text-align:right;font-weight:700;color:#f97316">${money(grand)}</td></tr>
            </table>
            <p style="margin:18px 0 0;color:#94a3b8;font-size:11px">${T.emailFooter}</p>`;
    const html = mailChrome(inner, `${T.emailSubject} — ${periodLabel}`);
    const pdf = await buildPayrollPdf(periodLabel, reps, req.body.lang);
    const t = getMailer();
    if (!t) return res.status(502).json({ error: 'smtp_not_configured' });
    await t.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: recipients.join(','),
      subject: `${T.emailSubject} — ${periodLabel}`,
      html,
      attachments: [{ filename: `Commissions_${periodLabel}.pdf`, content: pdf }],
    });
    // Log the send per rep so the preview can show a "Sent" badge + the history can list batches.
    // Single multi-row INSERT → all rows share one CURRENT_TIMESTAMP, so a batch groups cleanly by sent_at.
    const periodDate = `${year}-${mm}-01`;
    const sentBy = req.user.realAdminEmail || req.user.email || 'unknown';
    const sentTo = recipients.join(', ');
    const values = [], params = [];
    reps.forEach((r, i) => {
      const b = i * 5;
      values.push(`($${b + 1}, $${b + 2}::date, $${b + 3}, $${b + 4}, $${b + 5})`);
      params.push(r.rep, periodDate, sentTo, sentBy, Math.round((Number(r.total) || 0) * 100) / 100);
    });
    await pool.query(
      `INSERT INTO payroll_sends (rep_name, period, sent_to, sent_by, total) VALUES ${values.join(', ')}`,
      params
    );
    res.json({ sent: true, recipients: recipients.length, reps: reps.length, grandTotal: grand });
  } catch (e) {
    res.status(500).json({ error: 'Failed to send payroll', details: e.message });
  }
});

// GET /api/commissions/payroll/sends — history of payroll send batches (most recent first).
// One batch = all rows that share (period, sent_at, sent_by) from a single multi-row insert.
app.get('/api/commissions/payroll/sends', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'report:mark_paid'))) return;
  try {
    const rows = (await pool.query(`
      SELECT period::date AS period, sent_at, sent_by, sent_to,
             COUNT(*)::int AS rep_count,
             COALESCE(SUM(total), 0)::float AS total,
             ARRAY_AGG(rep_name ORDER BY rep_name) AS reps,
             ARRAY_AGG(id) AS ids
        FROM payroll_sends
       GROUP BY period, sent_at, sent_by, sent_to
       ORDER BY sent_at DESC
       LIMIT 200
    `)).rows;
    const sends = rows.map(r => ({
      period: r.period,                              // YYYY-MM-01 (the pay month)
      year: new Date(r.period).getUTCFullYear(),
      month: new Date(r.period).getUTCMonth() + 1,
      sentAt: r.sent_at,
      sentBy: r.sent_by,
      recipients: (r.sent_to || '').split(',').map(s => s.trim()).filter(Boolean),
      repCount: r.rep_count,
      total: r.total,
      reps: r.reps || [],
      ids: r.ids || [],                              // row ids of this batch (for delete)
    }));
    res.json({ sends });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load payroll history', details: e.message });
  }
});

// DELETE /api/commissions/payroll/sends { ids: [..] } — remove one send-history batch.
// Deletes only the given payroll_sends rows (a batch = the rep rows from one send).
// This only erases the history entry; it does NOT un-send the email already delivered.
app.delete('/api/commissions/payroll/sends', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'report:mark_paid'))) return;
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(n => parseInt(n)).filter(Number.isFinite) : [];
  if (!ids.length) return res.status(400).json({ error: 'ids required' });
  try {
    const result = await pool.query(`DELETE FROM payroll_sends WHERE id = ANY($1::int[])`, [ids]);
    res.json({ deleted: result.rowCount });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete payroll history', details: e.message });
  }
});

// Recalculate job state
let recalcJob = { status: 'idle', processed: 0, total: 0, message: '' };

// POST /api/commissions/recalculate
// ============================================================================
// PHASE 1c — Recalculate commissions using enriched data
// ============================================================================
// New rules (applied per eligible invoice):
//   Hardware           → hardware_amount × rep_rate%
//   SaaS first month   → 100% of MAX(billed SaaS, plan recurring_price × qty) per line —
//                        the plan price floor fills in prorated first invoices (2026-06-10)
//   SaaS renewal       → 0 (already paid on activation)
//   ANNUAL sub lines   → 10% of the customer's FIRST invoice per plan, 0 on annual renewals
//   Not eligible       → 0
//
// "First month" detection (2026-06-11): only the customer's INITIAL sale group — the
// activation group of their earliest monthly-SaaS invoice — qualifies for the 100%.
// Monthly add-ons sold later to an existing customer are renewals (0).
// Invoices with approval_status='paid' are FROZEN — recalc never rewrites them.

let recalcV2Job = {
  status: 'idle', processed: 0, total: 0, message: '',
  stats: { hardware: 0, saas_first: 0, saas_renewal: 0, not_eligible: 0, total_commission: 0 },
};

// Shared recalc routine — used both by the HTTP endpoint and by post-sync auto-trigger.
// Returns the final recalcV2Job state. Caller decides whether to await or fire-and-forget.
// Monthly sales points per rep — same rules as /api/crm/points (deal-type points for
// CRM deals by sold_date + Zentact activation points, reseller-boarded excluded).
// Used by the QUOTA GATE in recalc-v2 and the monthly performance bonus in pay stubs.
// Returns Map('Rep Name|YYYY-MM' → points).
// PROCESSING bonus (comp plan, user-refined 2026-06-12). Paid ONCE per account: the
// 6-month measurement window is anchored to the account's ACTIVATION month, and the
// account must have a COMPLETE 6-month window (be active >= 6 months) before it's paid.
// The payout happens at the next bi-annual date (June or December) on/after the window
// completes — so e.g. an account activated in November (window Nov→Apr) is paid in June.
// Per account: monthly avg = SUM(transaction_profit + other_revenue) over its window /
// (# months with revenue, must be >= 3); bonus = clamp(avg - 100, 0, 400). Attributed to
// the account's rep — ACTIVE reps only, reseller-boarded excluded. Accounts already paid a
// processing bonus (a committed 'processing' commission_bonuses row) are excluded so each
// account is paid exactly once. Returns { byRep: Map(rep -> { accounts:[...], total }) }.
const PROCESSING_THRESHOLD = 100;   // first $100/mo of average earns nothing
const PROCESSING_CAP       = 400;   // max bonus per account
async function computeProcessingBonuses(payoutYear, payoutMonth) {
  if (payoutMonth !== 6 && payoutMonth !== 12) return null;
  // payoutCutoff = first day of the payout month; an account qualifies when its window
  // (activation month + 6 months) has completed on/before this date.
  const rows = (await pool.query(
    `WITH eligible AS (
       SELECT m.merchant_account_id, m.business_name, m.sales_rep_name AS rep,
              date_trunc('month', m.activated_at)::date AS win_start
       FROM zentact_merchants m
       WHERE m.activated_at IS NOT NULL
         AND m.sales_rep_name IS NOT NULL AND m.sales_rep_name <> ''
         AND (m.reseller_attribute IS NULL OR m.reseller_attribute = '')
         AND m.sales_rep_name IN (SELECT name FROM salespeople WHERE is_active = true AND processing_bonus_enabled IS NOT FALSE)
         AND date_trunc('month', m.activated_at) + interval '6 months' <= make_date($1, $2, 1)
         AND NOT EXISTS (
           SELECT 1 FROM commission_bonuses cb
           WHERE cb.bonus_type = 'processing' AND cb.matched_zentact_id = m.merchant_account_id
         )
     )
     SELECT e.merchant_account_id, e.business_name, e.rep, e.win_start,
            SUM(r.transaction_profit_cents + COALESCE(r.other_revenue_cents,0))::bigint AS total_cents,
            COUNT(*) FILTER (WHERE (r.transaction_profit_cents + COALESCE(r.other_revenue_cents,0)) > 0)::int AS active_months
     FROM eligible e
     JOIN zentact_merchant_revenue r ON r.merchant_account_id = e.merchant_account_id
       AND make_date(r.year, r.month, 1) >= e.win_start
       AND make_date(r.year, r.month, 1) < e.win_start + interval '6 months'
     GROUP BY e.merchant_account_id, e.business_name, e.rep, e.win_start`,
    [payoutYear, payoutMonth]
  )).rows;
  // Accounts already paid a processing/volume bonus via import must NEVER re-enter the bi-annual
  // payout. The SQL NOT EXISTS above covers rows matched to a merchant_account_id; imported lines
  // whose Zentact name-match failed (matched_zentact_id NULL) are caught here by a fuzzy
  // business-name comparison using the SAME normalization as buildZentactMatcher. We err toward
  // EXCLUSION (loose substring match) — per requirement, a paid account must not come back.
  const paidProcNames = (await pool.query(
    `SELECT DISTINCT merchant_name FROM commission_bonuses
      WHERE bonus_type = 'processing' AND merchant_name IS NOT NULL AND merchant_name <> ''`
  )).rows;
  const normName = normMerchant;  // accent-insensitive (see normMerchant)
  const paidNorms = paidProcNames.map(r => normName(r.merchant_name)).filter(Boolean);
  const alreadyPaidByName = (business) => {
    const n = normName(business);
    if (!n) return false;
    return paidNorms.some(p => p === n || p.includes(n) || n.includes(p));
  };

  const fmtYM = (d) => { const x = new Date(d); return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}`; };
  const byRep = new Map();
  for (const r of rows) {
    if (alreadyPaidByName(r.business_name)) continue;     // already paid via import (name fallback)
    const activeMonths = parseInt(r.active_months) || 0;
    if (activeMonths < 3) continue;                       // need revenue in >= 3 of the 6 window months
    const avg = (Number(r.total_cents) / 100) / activeMonths;
    if (avg < PROCESSING_THRESHOLD) continue;             // below $100/mo average → nothing
    const bonus = Math.min(Math.round((avg - PROCESSING_THRESHOLD) * 100) / 100, PROCESSING_CAP);
    if (bonus <= 0) continue;
    const ws = new Date(r.win_start);
    const we = new Date(Date.UTC(ws.getUTCFullYear(), ws.getUTCMonth() + 5, 1));
    if (!byRep.has(r.rep)) byRep.set(r.rep, { accounts: [], total: 0 });
    const e = byRep.get(r.rep);
    e.accounts.push({
      merchant_account_id: r.merchant_account_id,
      business_name: r.business_name,
      windowStart: fmtYM(ws), windowEnd: fmtYM(we),
      avg: Math.round(avg * 100) / 100,
      activeMonths, bonus,
    });
    e.total = Math.round((e.total + bonus) * 100) / 100;
  }
  return { byRep };
}

// GET /api/admin/processing-bonus?secret=&year=&month=  — preview the bi-annual bonus
// (month must be 6 or 12). Without secret, falls back to JWT report:mark_paid.
app.get('/api/admin/processing-bonus', (req, res, next) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (process.env.ZOHO_WEBHOOK_SECRET && provided === process.env.ZOHO_WEBHOOK_SECRET) { req.viaSecret = true; return next(); }
  return authenticateToken(req, res, next);
}, async (req, res) => {
  if (!req.viaSecret && !(await requirePerm(req, res, 'report:mark_paid'))) return;
  const year = parseInt(req.query.year), month = parseInt(req.query.month);
  if (!year || (month !== 6 && month !== 12)) return res.status(400).json({ error: 'year + month (6 or 12) required' });
  try {
    const result = await computeProcessingBonuses(year, month);
    const reps = [...result.byRep.entries()].map(([rep, v]) => ({ rep, total: v.total, accounts: v.accounts }))
      .sort((a, b) => b.total - a.total);
    // Already-committed (platform payout) for this period: bonus_type='processing', import_id NULL
    // (imports carry an import_id), paid_for_period = the payout month.
    const period = `${year}-${String(month).padStart(2, '0')}-01`;
    const committed = (await pool.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(amount),0)::float AS total
         FROM commission_bonuses
        WHERE bonus_type = 'processing' AND import_id IS NULL AND paid_for_period = $1::date`,
      [period]
    )).rows[0];
    res.json({
      year, month,
      grandTotal: Math.round(reps.reduce((a, r) => a + r.total, 0) * 100) / 100,
      reps,
      committed: { count: committed.count, total: Math.round(committed.total * 100) / 100 },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/commissions/processing-bonus/commit  body { year, month }
// Records the current bi-annual payout as PAID: inserts a 'processing' bonus row per eligible
// account (with matched_zentact_id), which keeps the history AND excludes those accounts from
// all future bi-annual computations ("paid once"). computeProcessingBonuses already skips
// already-recorded accounts, so re-committing only adds newly-eligible ones (idempotent).
app.post('/api/commissions/processing-bonus/commit', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'report:mark_paid'))) return;
  const year = parseInt(req.body.year), month = parseInt(req.body.month);
  if (!year || (month !== 6 && month !== 12)) return res.status(400).json({ error: 'year + month (6 or 12) required' });
  const period = `${year}-${String(month).padStart(2, '0')}-01`;
  const client = await pool.connect();
  try {
    const result = await computeProcessingBonuses(year, month);
    await client.query('BEGIN');
    let count = 0, total = 0;
    for (const [rep, v] of result.byRep.entries()) {
      for (const a of v.accounts) {
        await client.query(
          `INSERT INTO commission_bonuses
             (import_id, rep_name, bonus_type, merchant_name, matched_zentact_id, amount, paid_for_period, report_date)
           VALUES (NULL, $1, 'processing', $2, $3, $4, $5::date, $5::date)`,
          [rep, a.business_name, a.merchant_account_id, a.bonus, period]
        );
        count++; total += a.bonus;
      }
    }
    await client.query('COMMIT');
    res.json({ committed: true, accounts: count, total: Math.round(total * 100) / 100 });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// POST /api/commissions/processing-bonus/uncommit  body { year, month }
// Reverses a platform commit for the period (deletes the import_id-NULL 'processing' rows
// for that paid_for_period), making those accounts eligible again. Does NOT touch imported
// (import_id NOT NULL) processing bonuses.
app.post('/api/commissions/processing-bonus/uncommit', authenticateToken, async (req, res) => {
  if (!(await requirePerm(req, res, 'report:mark_paid'))) return;
  const year = parseInt(req.body.year), month = parseInt(req.body.month);
  if (!year || (month !== 6 && month !== 12)) return res.status(400).json({ error: 'year + month (6 or 12) required' });
  const period = `${year}-${String(month).padStart(2, '0')}-01`;
  try {
    const r = await pool.query(
      `DELETE FROM commission_bonuses
        WHERE bonus_type = 'processing' AND import_id IS NULL AND paid_for_period = $1::date`,
      [period]
    );
    res.json({ uncommitted: r.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/processing-bonus/debug?secret=&q=<merchant name>
// Diagnostic: why is (or isn't) an account excluded from the bi-annual payout?
// Returns the matching Zentact merchants + every recorded 'processing' bonus matching q,
// and whether the fuzzy name-exclusion in computeProcessingBonuses would catch it.
app.get('/api/admin/processing-bonus/debug', (req, res, next) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (process.env.ZOHO_WEBHOOK_SECRET && provided === process.env.ZOHO_WEBHOOK_SECRET) { req.viaSecret = true; return next(); }
  return authenticateToken(req, res, next);
}, async (req, res) => {
  if (!req.viaSecret && !(await requirePerm(req, res, 'report:mark_paid'))) return;
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q (merchant name) required' });
  const normName = normMerchant;  // accent-insensitive (see normMerchant)
  try {
    const merchants = (await pool.query(
      `SELECT merchant_account_id, business_name, sales_rep_name, activated_at
         FROM zentact_merchants WHERE business_name ILIKE '%' || $1 || '%' ORDER BY business_name`,
      [q]
    )).rows;
    const bonuses = (await pool.query(
      `SELECT cb.merchant_name, cb.matched_zentact_id, cb.amount::float AS amount,
              cb.paid_for_period, cb.report_date, i.filename, i.rep_name
         FROM commission_bonuses cb
         LEFT JOIN commission_payment_imports i ON i.id = cb.import_id
        WHERE cb.bonus_type = 'processing' AND cb.merchant_name ILIKE '%' || $1 || '%'
        ORDER BY cb.paid_for_period DESC NULLS LAST`,
      [q]
    )).rows;
    // All recorded processing-bonus names (for the fuzzy-exclusion check the payout uses).
    const paidNorms = (await pool.query(
      `SELECT DISTINCT merchant_name FROM commission_bonuses
        WHERE bonus_type = 'processing' AND merchant_name IS NOT NULL AND merchant_name <> ''`
    )).rows.map(r => normName(r.merchant_name)).filter(Boolean);
    const wouldExclude = (business) => {
      const n = normName(business);
      if (!n) return false;
      return paidNorms.some(p => p === n || p.includes(n) || n.includes(p));
    };
    res.json({
      q,
      merchants: merchants.map(m => ({
        ...m,
        excluded_by_id: bonuses.some(b => b.matched_zentact_id === m.merchant_account_id),
        excluded_by_name: wouldExclude(m.business_name),
      })),
      recorded_processing_bonuses: bonuses,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/processing-bonus/audit?secret=
// Lists every recorded 'processing' bonus with matched_zentact_id NULL and, for each, whether
// the fuzzy matcher (accent/space-insensitive) can still find a Zentact merchant by name.
// `unmatched` rows match NOTHING → potential silent leaks into the bi-annual (typos to relink).
app.get('/api/admin/processing-bonus/audit', (req, res, next) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (process.env.ZOHO_WEBHOOK_SECRET && provided === process.env.ZOHO_WEBHOOK_SECRET) { req.viaSecret = true; return next(); }
  return authenticateToken(req, res, next);
}, async (req, res) => {
  if (!req.viaSecret && !(await requirePerm(req, res, 'report:mark_paid'))) return;
  try {
    const matchZentact = await buildZentactMatcher();
    const candidates = (await pool.query(
      `SELECT merchant_account_id, business_name FROM zentact_merchants
        WHERE business_name IS NOT NULL AND business_name <> ''`
    )).rows;
    const nameById = new Map(candidates.map(c => [c.merchant_account_id, c.business_name]));
    const nullRows = (await pool.query(
      `SELECT cb.id, cb.merchant_name, cb.amount::float AS amount, cb.paid_for_period,
              i.filename, i.rep_name
         FROM commission_bonuses cb
         LEFT JOIN commission_payment_imports i ON i.id = cb.import_id
        WHERE cb.bonus_type = 'processing' AND cb.matched_zentact_id IS NULL
        ORDER BY i.rep_name, cb.merchant_name`
    )).rows;
    const matched = [], unmatched = [];
    for (const r of nullRows) {
      const id = matchZentact(r.merchant_name);
      if (id) matched.push({ ...r, fuzzy_zentact_id: id, fuzzy_business_name: nameById.get(id) || null });
      else unmatched.push(r);
    }
    res.json({
      total_null_id: nullRows.length,
      fuzzy_matched_count: matched.length,   // excluded by name already — safe, no action
      unmatched_count: unmatched.length,     // match nothing → potential leak, needs relink
      unmatched,
      fuzzy_matched: matched,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/processing-bonus/relink?secret=  body { match, zentactId, dryRun? }
// Manually re-link recorded 'processing' bonuses to a Zentact merchant when the imported
// name had a typo the fuzzy matcher couldn't catch (e.g. "Arkhavan" vs "Akhavan"). Sets
// matched_zentact_id + rewrites merchant_name to the canonical Zentact business_name so the
// account is then excluded from the bi-annual payout. `match` is an ILIKE substring of the
// CURRENT (mistyped) merchant_name. dryRun=true previews without writing.
app.post('/api/admin/processing-bonus/relink', (req, res, next) => {
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (process.env.ZOHO_WEBHOOK_SECRET && provided === process.env.ZOHO_WEBHOOK_SECRET) { req.viaSecret = true; return next(); }
  return authenticateToken(req, res, next);
}, async (req, res) => {
  if (!req.viaSecret && !(await requirePerm(req, res, 'report:mark_paid'))) return;
  const match = String(req.body.match || '').trim();
  const zentactId = String(req.body.zentactId || '').trim();
  const dryRun = req.body.dryRun === true;
  if (!match || !zentactId) return res.status(400).json({ error: 'match (current merchant_name substring) and zentactId required' });
  try {
    const merchant = (await pool.query(
      `SELECT merchant_account_id, business_name FROM zentact_merchants WHERE merchant_account_id = $1`,
      [zentactId]
    )).rows[0];
    if (!merchant) return res.status(404).json({ error: `No Zentact merchant with id ${zentactId}` });

    const targets = (await pool.query(
      `SELECT id, merchant_name, matched_zentact_id, amount::float AS amount, import_id
         FROM commission_bonuses
        WHERE bonus_type = 'processing' AND merchant_name ILIKE '%' || $1 || '%'`,
      [match]
    )).rows;
    if (!targets.length) return res.json({ updated: 0, note: `No processing bonus matched '%${match}%'`, targets: [] });

    if (dryRun) {
      return res.json({ dryRun: true, wouldUpdate: targets.length, to: merchant, targets });
    }
    const upd = await pool.query(
      `UPDATE commission_bonuses
          SET matched_zentact_id = $1, merchant_name = $2
        WHERE bonus_type = 'processing' AND merchant_name ILIKE '%' || $3 || '%'
        RETURNING id, merchant_name, matched_zentact_id, amount::float AS amount`,
      [merchant.merchant_account_id, merchant.business_name, match]
    );
    res.json({ updated: upd.rowCount, to: merchant, rows: upd.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function getMonthlyPointsByRep(fromDate) {
  const dealSourcePoints = new Map(
    (await pool.query(`SELECT source_group, points FROM deal_source_points`)).rows
      .map(r => [String(r.source_group).toLowerCase(), parseInt(r.points)])
  );
  const repByGroup = new Map();
  for (const r of (await pool.query(`
    SELECT COALESCE(lead_source_group_override, lead_source_group) AS g, points, COUNT(*)::int AS c
    FROM crm_sold_deals
    WHERE COALESCE(lead_source_group_override, lead_source_group) IS NOT NULL
      AND COALESCE(lead_source_group_override, lead_source_group) <> ''
    GROUP BY g, points
  `)).rows) {
    const cur = repByGroup.get(r.g);
    if (!cur || r.c > cur.c) repByGroup.set(r.g, { points: parseInt(r.points) || 0, c: r.c });
  }
  const map = new Map();
  const add = (rep, ym, pts) => { const k = `${rep}|${ym}`; map.set(k, (map.get(k) || 0) + pts); };
  for (const r of (await pool.query(`
    SELECT owner_name AS rep, to_char(sold_date, 'YYYY-MM') AS ym,
           COALESCE(lead_source_group_override, lead_source_group) AS g,
           points, COUNT(*)::int AS c
    FROM crm_sold_deals
    WHERE sold_date >= $1 AND owner_name IS NOT NULL
    GROUP BY 1, 2, 3, 4
  `, [fromDate])).rows) {
    const g = String(r.g || '');
    const mapped = dealSourcePoints.get(g.toLowerCase());
    const pts = mapped != null ? mapped : (repByGroup.get(g) ? repByGroup.get(g).points : (parseInt(r.points) || 0));
    add(r.rep, r.ym, pts * r.c);
  }
  for (const r of (await pool.query(`
    SELECT sales_rep_name AS rep, to_char(activated_at, 'YYYY-MM') AS ym,
           SUM(COALESCE(points, 1))::int AS pts
    FROM zentact_merchants
    WHERE status = 'ACTIVE' AND activated_at >= $1 AND sales_rep_name IS NOT NULL
      AND (reseller_attribute IS NULL OR reseller_attribute = '')
    GROUP BY 1, 2
  `, [fromDate])).rows) add(r.rep, r.ym, parseInt(r.pts) || 0);
  return map;
}

async function runRecalcV2(source = 'manual') {
  if (recalcV2Job.status === 'running') {
    return { skipped: true, reason: 'already_running' };
  }
  recalcV2Job = {
    status: 'running',
    startedAt: new Date().toISOString(),
    source,
    processed: 0, total: 0,
    message: `Starting (${source})...`,
    stats: { hardware: 0, saas_first: 0, saas_annual: 0, saas_renewal: 0, too_late: 0, pending_saas: 0, pending_payment: 0, not_eligible: 0, quota_not_met: 0, excluded: 0, frozen_paid: 0, total_commission: 0 },
  };
  try {
      // Load rep rates + quota-gate config (plan v7.7)
      const spRes = await pool.query(
        'SELECT name, commission_rate, monthly_quota, hire_date, quota_gate_enabled FROM salespeople'
      );
      const rateMap = {};
      const spInfo = new Map();
      spRes.rows.forEach(r => {
        rateMap[r.name] = parseFloat(r.commission_rate) || 10;
        spInfo.set(r.name, {
          quota:    r.monthly_quota == null ? MONTHLY_QUOTA : parseInt(r.monthly_quota),
          hireDate: r.hire_date ? new Date(r.hire_date) : null,
          gated:    r.quota_gate_enabled !== false,
        });
      });

      // QUOTA GATE (plan v7.7 §2, platform era only): a month where the rep missed their
      // monthly quota pays NO hardware/SaaS commissions ("base salary only"). Signup
      // bonuses are never gated. 90-day ramp from hire_date waives the gate (§7);
      // quota_gate_enabled=false exempts the rep entirely.
      const pointsByRepMonth = await getMonthlyPointsByRep(PLAN_START_DATE);
      // Per-month admin waivers ("payer quand même") override the gate for that rep+month.
      const waivers = new Set(
        (await pool.query(`SELECT rep_name, to_char(period, 'YYYY-MM') AS ym FROM quota_month_waivers`))
          .rows.map(r => `${r.rep_name}|${r.ym}`)
      );
      const RAMP_MS = 90 * 86400000;
      const quotaGatePasses = (rep, payDate) => {
        const sp = spInfo.get(rep);
        if (!sp || !sp.gated) return true;
        if (sp.hireDate && (payDate.getTime() - sp.hireDate.getTime()) < RAMP_MS) return true; // ramp
        const ym = `${payDate.getUTCFullYear()}-${String(payDate.getUTCMonth() + 1).padStart(2, '0')}`;
        if (waivers.has(`${rep}|${ym}`)) return true; // admin month waiver
        return (pointsByRepMonth.get(`${rep}|${ym}`) || 0) >= sp.quota;
      };

      // Load all invoices (paid + not paid) with enriched data
      const invRes = await pool.query(`
        SELECT id, invoice_number, salesperson_name, customer_name, total,
               hardware_amount, saas_amount, subscription_activation_date,
               paid_date, commission_status, status, approval_status, commission,
               sub_total, discount_total, gross_line_total, payable_override, commission_excluded
        FROM invoices
        WHERE organization_id = $1
        ORDER BY date ASC
      `, [process.env.ZOHO_ORG_ID]);
      recalcV2Job.total = invRes.rows.length;

      // Helpers — always work with Date objects to avoid string-vs-Date comparison bugs
      const toDate = (d) => {
        if (!d) return null;
        if (d instanceof Date) return d;
        return new Date(d);
      };
      const monthsLater = (d, n) => {
        const x = new Date(d.getTime());
        x.setMonth(x.getMonth() + n);
        return x;
      };

      // PASS 1: first paid SaaS per customer (anchors the hardware 6-month window).
      // First-month/activation detection moved to PASS 1d (needs the annual-line map).
      const firstSaasPaidByCustomer = new Map();
      for (const inv of invRes.rows) {
        const isSaaS = parseFloat(inv.saas_amount) > 0;
        if (!isSaaS) continue;
        const paid = toDate(inv.paid_date);
        if (inv.status === 'paid' && paid) {
          const cur = firstSaasPaidByCustomer.get(inv.customer_name);
          if (!cur || paid < cur.paidDate) {
            firstSaasPaidByCustomer.set(inv.customer_name, {
              paidDate: paid,
              invoiceId: inv.id,
            });
          }
        }
      }

      // PASS 1b: Activation commission base = PLAN PRICE, not the (often prorated) first
      // invoice amount (user decision 2026-06-10: "an activation is an activation, whatever
      // the day of the month"). For each first-month invoice, per SaaS line take
      // MAX(billed amount, plan recurring_price × quantity) — fills in proration without
      // ever reducing an invoice that billed more (e.g. prepaid periods). Falls back to
      // saas_amount when line_items/plan are unavailable.
      const planPrices = new Map();
      (await pool.query(
        `SELECT plan_code, recurring_price::float AS price FROM zoho_plans WHERE recurring_price > 0`
      )).rows.forEach(p => planPrices.set(String(p.plan_code).toLowerCase(), p.price));

      const annualPlanCodes = new Set(
        (await pool.query(
          `SELECT LOWER(plan_code) AS code FROM zoho_plans WHERE interval_unit ILIKE 'year%'`
        )).rows.map(r => r.code)
      );
      const ANNUAL_NAME_RE = /annual|annuel|yearly|par ann/i;
      const isAnnualLine = (li) =>
        (li.plan_code && annualPlanCodes.has(String(li.plan_code).toLowerCase().trim())) ||
        ANNUAL_NAME_RE.test(String(li.name || ''));

      // Earliest SaaS invoice date per customer (ANY SaaS — monthly OR annual). The annual 10%
      // only goes to a customer's genuinely FIRST SaaS invoice; if the customer already had ANY
      // SaaS before (a prior monthly, or a prior annual sub, or another annual add-on), the new
      // annual is an upgrade/add-on to an EXISTING customer → 0% (user rule 2026-06-17).
      const firstSaasByCustomer = new Map(); // customer_name → earliest SaaS invoice date (ms)
      {
        const saasRows = (await pool.query(
          `SELECT i.customer_name, MIN(i.date) AS first_date
           FROM invoices i CROSS JOIN LATERAL jsonb_array_elements(i.line_items) AS li
           WHERE i.organization_id = $1 AND i.line_items IS NOT NULL AND i.status NOT IN ('void','deleted')
             AND li->>'type' = 'saas'
           GROUP BY i.customer_name`,
          [process.env.ZOHO_ORG_ID]
        )).rows;
        for (const r of saasRows) if (r.first_date) firstSaasByCustomer.set(r.customer_name, new Date(r.first_date).getTime());
      }
      // Data floor = earliest invoice date we have. A sub activated BEFORE it means its first
      // annual cycle (and commission) predate our data → any in-DB annual = renewal → 0%.
      const dataFloor = (await pool.query(`SELECT MIN(date) AS d FROM invoices WHERE organization_id = $1`, [process.env.ZOHO_ORG_ID])).rows[0]?.d;
      const dataFloorTs = dataFloor ? new Date(dataFloor).getTime() : 0;

      const annualByInvoice = new Map(); // invoice id → { total, firstTotal }
      {
        const annualRows = (await pool.query(
          `SELECT i.id, i.customer_name, i.date, i.subscription_activation_date,
                  LOWER(COALESCE(NULLIF(TRIM(li->>'plan_code'), ''), TRIM(li->>'name'), '')) AS line_key,
                  COALESCE((li->>'amount')::float, 0) AS amount
           FROM invoices i
           CROSS JOIN LATERAL jsonb_array_elements(i.line_items) AS li
           WHERE i.organization_id = $1
             AND i.line_items IS NOT NULL AND i.saas_amount > 0
             AND i.status NOT IN ('void', 'deleted')
             AND li->>'type' = 'saas'
             AND (
               LOWER(TRIM(li->>'plan_code')) IN (SELECT LOWER(plan_code) FROM zoho_plans WHERE interval_unit ILIKE 'year%')
               OR li->>'name' ~* '(annual|annuel|yearly|par ann)'
             )
           ORDER BY i.date ASC, i.id ASC`,
          [process.env.ZOHO_ORG_ID]
        )).rows;
        const claimedBy = new Map(); // customer|line_key → first invoice id (claims the 10%)
        for (const r of annualRows) {
          const rec = annualByInvoice.get(r.id) || { total: 0, firstTotal: 0 };
          rec.total += r.amount;
          const key = `${r.customer_name}|${r.line_key}`;
          if (!claimedBy.has(key)) claimedBy.set(key, r.id);
          if (claimedBy.get(key) === r.id) {
            // Grant the 10% "first annual" ONLY when it's truly a NEW annual sale:
            //   (a) it's the customer's FIRST SaaS invoice (no prior SaaS of any kind — a prior
            //       monthly, a prior annual sub, or an earlier annual add-on all disqualify it:
            //       an existing customer adding/switching to annual is not a new sale → 0%), and
            //   (b) the annual sub wasn't activated long before this invoice (>~9 months ⇒ a
            //       renewal cycle whose real first + commission predate our data — e.g. activated
            //       in 2024, first in-DB annual invoice 2025).
            const firstSaas = firstSaasByCustomer.get(r.customer_name);
            const annualDate = r.date ? new Date(r.date).getTime() : Infinity;
            const act = r.subscription_activation_date ? new Date(r.subscription_activation_date).getTime() : null;
            const hadPriorSaas = firstSaas && firstSaas < annualDate;
            // Pre-existing sub: activated before our data floor (its first cycle/commission is
            // out-of-system, e.g. 2024) OR activated >~9 months before this invoice (renewal cycle).
            const preExistingSub = act != null && ((dataFloorTs && act < dataFloorTs) || (annualDate - act) > 270 * 86400000);
            if (!hadPriorSaas && !preExistingSub) rec.firstTotal += r.amount;
          }
          annualByInvoice.set(r.id, rec);
        }
      }

      // PASS 1d: first-month detection — ONLY the customer's INITIAL sale unlocks the 100%
      // activation commission (user rule 2026-06-11: a monthly add-on sold to an EXISTING
      // customer pays 0 — it only pays when part of the initial sale/activation invoice).
      // The initial group = the activation group of the customer's earliest monthly-SaaS
      // invoice. Later subscription activations (add-ons) are renewals. Pure-annual invoices
      // neither claim nor define groups (they follow the annual 10% rule); void/deleted
      // invoices can't claim a group either.
      const firstMonthByGroup = new Map();
      const initialGroupByCustomer = new Map();
      for (const inv of invRes.rows) {
        if (inv.status === 'void' || inv.status === 'deleted') continue;
        const saasAmt = parseFloat(inv.saas_amount) || 0;
        const annualTot = annualByInvoice.get(inv.id)?.total || 0;
        if (saasAmt - annualTot <= 0.005) continue; // no monthly-SaaS portion
        if (inv.subscription_activation_date) {
          const key = `${inv.customer_name}|${inv.subscription_activation_date}`;
          if (!firstMonthByGroup.has(key)) firstMonthByGroup.set(key, inv.id);
          if (!initialGroupByCustomer.has(inv.customer_name)) initialGroupByCustomer.set(inv.customer_name, key);
        }
      }

      // Invoice-level discount factor: scale billed amounts to what the customer actually
      // pays pre-tax (comp plan v7.7 — commission on discounted value). The plan-price
      // floor below is applied AFTER the factor, so a discounted/prorated activation
      // still pays at least the full plan value.
      // factor = real net pre-tax / our gross line sum. Zoho may bake the discount into
      // sub_total (discount_total=0, sub_total < gross) or report it separately — both handled.
      const discountFactorOf = (subTotal, discTotal, grossLineTotal) => {
        const st = parseFloat(subTotal) || 0;
        const dt = parseFloat(discTotal) || 0;
        const gross = parseFloat(grossLineTotal) || 0;
        if (st <= 0 || gross <= 0) return 1;            // no captured discount info → full value
        const net = st - dt;
        if (net <= 0 || net >= gross) return 1;          // no discount (or data noise)
        return net / gross;
      };

      const saasFirstBase = new Map();
      const firstIds = [...new Set(firstMonthByGroup.values())];
      if (firstIds.length && planPrices.size) {
        const liRows = (await pool.query(
          `SELECT id, line_items, sub_total, discount_total, gross_line_total FROM invoices WHERE id = ANY($1) AND line_items IS NOT NULL`,
          [firstIds]
        )).rows;
        for (const row of liRows) {
          const items = Array.isArray(row.line_items) ? row.line_items : [];
          const factor = discountFactorOf(row.sub_total, row.discount_total, row.gross_line_total);
          let base = 0, sawSaas = false;
          for (const li of items) {
            if (li.type !== 'saas') continue;
            if (isAnnualLine(li)) continue; // annual subs follow their own 10%-first-year rule
            sawSaas = true;
            const amt   = (parseFloat(li.amount) || 0) * factor;
            const qty   = parseInt(li.quantity) || 1;
            const price = li.plan_code ? (planPrices.get(String(li.plan_code).toLowerCase()) || 0) : 0;
            base += Math.max(amt, price * qty);
          }
          if (sawSaas) saasFirstBase.set(row.id, Math.round(base * 100) / 100);
        }
      }

      // Batched persistence for PASS 2: buffer the per-invoice writes and flush them in
      // chunks (one UPDATE ... FROM (VALUES ...) per ~500 rows) instead of one cross-cloud
      // round-trip per invoice. Flushing per chunk keeps progress + stoppability intact.
      const recalcUpdates = [];
      const RECALC_UPDATE_CHUNK = 500;
      const flushRecalcUpdates = async () => {
        for (const part of chunk(recalcUpdates, RECALC_UPDATE_CHUNK)) {
          const vals = [];
          const tuples = part.map((u, k) => {
            const b = k * 4;
            vals.push(u.id, u.commission, u.bucket, u.payableDate);
            return `($${b+1}::int, $${b+2}::numeric, $${b+3}::text, $${b+4}::date)`;
          });
          await pool.query(
            `UPDATE invoices AS i SET
               commission = v.commission,
               commission_status = v.bucket,
               commission_payable_date = v.payable_date,
               updated_at = CURRENT_TIMESTAMP
             FROM (VALUES ${tuples.join(', ')}) AS v(id, commission, bucket, payable_date)
             WHERE i.id = v.id`,
            vals
          );
        }
        recalcUpdates.length = 0;
      };

      // PASS 2: Compute commission per invoice using the new rules
      for (const inv of invRes.rows) {
        if (recalcV2Job.status === 'stopping') break;

        const rate = rateMap[inv.salesperson_name] || 10;
        // Invoice-level discount (plan v7.7): bases are scaled to the discounted pre-tax
        // value, and the HARDWARE rate halves (10%→5%) when the discount is ≥ 25%.
        const factor = discountFactorOf(inv.sub_total, inv.discount_total, inv.gross_line_total);
        const discountPct = 1 - factor;   // effective discount (0 when no discount captured)
        const hwRate = discountPct >= 0.25 ? rate / 2 : rate;
        const hardwareAmount = (parseFloat(inv.hardware_amount) || 0) * factor;
        const saasAmount     = parseFloat(inv.saas_amount)     || 0;
        const annualInfo = annualByInvoice.get(inv.id);
        const annualAmount      = annualInfo ? annualInfo.total : 0;
        const annualFirstAmount = annualInfo ? annualInfo.firstTotal : 0;
        // Monthly-SaaS portion only — annual lines follow their own 10% rule (block below).
        const monthlySaas = Math.max(0, saasAmount - annualAmount);
        const invPaidDate    = toDate(inv.paid_date);
        let commission = 0;
        let bucket = 'not_eligible';
        // payableDate = when the commission "unlocks" for the rep. NULL when no commission earned.
        // SaaS first month → invoice paid_date (rep unlocks the moment the SaaS gets paid)
        // Hardware       → max(hardware paid_date, first SaaS paid_date) — if HW was paid
        //                   before the SaaS, the unlock still has to wait for SaaS to be paid.
        let payableDate = null;

        // Voided/deleted invoices: never eligible. Catch this BEFORE the
        // generic 'pending_payment' branch so we don't mislabel them.
        if (inv.status === 'void' || inv.status === 'deleted') {
          bucket = 'not_eligible';
        } else if (inv.status !== 'paid' || !invPaidDate) {
          bucket = 'pending_payment';
        } else if (monthlySaas > 0 && hardwareAmount === 0) {
          // Pure monthly SaaS — first month gets 100% (of the PLAN price when known), renewals get 0
          const key = `${inv.customer_name}|${inv.subscription_activation_date}`;
          // 100% activation only on the INITIAL sale's group — later add-ons are renewals.
          const isFirstMonth = firstMonthByGroup.get(key) === inv.id
            && initialGroupByCustomer.get(inv.customer_name) === key;
          if (isFirstMonth) {
            commission = saasFirstBase.get(inv.id) ?? monthlySaas;
            bucket = 'saas_first';
            payableDate = invPaidDate;
          } else {
            commission = 0;
            bucket = 'saas_renewal';
          }
        } else if (hardwareAmount > 0 && monthlySaas === 0) {
          // Pure hardware — eligible if paid before OR within 6 months after first SaaS
          const firstSaasPaid = firstSaasPaidByCustomer.get(inv.customer_name);
          if (!firstSaasPaid) {
            bucket = 'pending_saas';
          } else {
            const windowEnd = monthsLater(firstSaasPaid.paidDate, 6);
            if (invPaidDate <= windowEnd) {
              commission = hardwareAmount * (hwRate / 100);
              bucket = 'hardware';
              payableDate = invPaidDate > firstSaasPaid.paidDate ? invPaidDate : firstSaasPaid.paidDate;
            } else {
              bucket = 'too_late';
            }
          }
        } else if (hardwareAmount > 0 && monthlySaas > 0) {
          // Mixed — monthly-SaaS portion follows first-month rule, hardware portion needs window
          const key = `${inv.customer_name}|${inv.subscription_activation_date}`;
          // 100% activation only on the INITIAL sale's group — later add-ons are renewals.
          const isFirstMonth = firstMonthByGroup.get(key) === inv.id
            && initialGroupByCustomer.get(inv.customer_name) === key;
          const firstSaasPaid = firstSaasPaidByCustomer.get(inv.customer_name);
          if (isFirstMonth) {
            commission += saasFirstBase.get(inv.id) ?? monthlySaas;
            bucket = 'saas_first';
            payableDate = invPaidDate;
          } else {
            bucket = 'saas_renewal';
          }
          if (firstSaasPaid) {
            const windowEnd = monthsLater(firstSaasPaid.paidDate, 6);
            if (invPaidDate <= windowEnd) {
              commission += hardwareAmount * (hwRate / 100);
              // If the SaaS portion didn't already set a payable date (renewal w/ HW), use the
              // later of this invoice's paid_date and the first-SaaS paid_date.
              if (!payableDate) {
                payableDate = invPaidDate > firstSaasPaid.paidDate ? invPaidDate : firstSaasPaid.paidDate;
              }
            }
          }
        } else if (annualAmount > 0) {
          // Pure annual-subscription invoice — the annual block below pays the first year.
          bucket = 'saas_renewal';
        }

        // ANNUAL subscriptions: 10% (rep rate) of the first year's annual lines (after the
        // invoice-level discount), unlocked when the invoice is paid. Annual renewals earn
        // nothing (annualFirstAmount = 0 for them).
        if (annualFirstAmount > 0 && inv.status === 'paid' && invPaidDate) {
          commission += annualFirstAmount * factor * (rate / 100);
          if (bucket !== 'saas_first' && bucket !== 'hardware') bucket = 'saas_annual';
          if (!payableDate) payableDate = invPaidDate;
        }

        // ZERO-REVENUE GUARD: a $0 invoice total (fully discounted / comped) earns no
        // commission, even when it carries hardware/SaaS lines. `total` is Zoho's actual
        // invoice total (after discount, incl. tax), so total<=0 means nothing was billed.
        // Catches cases the discount factor misses (e.g. sub_total never backfilled).
        if (commission > 0 && (parseFloat(inv.total) || 0) <= 0) {
          commission = 0;
          bucket = 'not_eligible';
          payableDate = null;
        }

        // QUOTA GATE: from the platform era (PLAN_START_DATE), commissions whose unlock
        // month missed the rep's quota are forfeited (plan v7.7 §2 — base salary only).
        // Carried-forward adjustments (payable_override) are NOT re-gated — already earned.
        if (commission > 0 && payableDate && payableDate >= PLAN_START_DATE
            && !inv.payable_override && !quotaGatePasses(inv.salesperson_name, payableDate)) {
          commission = 0;
          bucket = 'quota_not_met';
          payableDate = null;
        }

        // ADJUSTMENT CARRY-FORWARD: force the unlock month to the override (so the invoice lands
        // in the target month's report/stub/payroll). Only when it still earns a commission.
        if (commission > 0 && inv.payable_override) {
          payableDate = toDate(inv.payable_override);
        }

        // EXCLUDED: admin manually refused commission on this invoice → force 0. Wins over
        // everything (always last before freeze).
        if (inv.commission_excluded) {
          commission = 0;
          bucket = 'excluded';
          payableDate = null;
        }

        // FREEZE: once a commission has been PAID (import or mark-paid/pay-stub commit), the
        // user's pay records are the source of truth — recalc must never rewrite its
        // commission/status/payable_date. PASS 1 above still SEES paid invoices (first-month
        // detection needs them); we only skip the write. Unapprove unfreezes (status leaves 'paid').
        if (inv.approval_status === 'paid') {
          recalcV2Job.stats.frozen_paid = (recalcV2Job.stats.frozen_paid || 0) + 1;
          recalcV2Job.stats.total_commission += parseFloat(inv.commission) || 0;
          recalcV2Job.processed++;
          recalcV2Job.message = `Processed ${recalcV2Job.processed} of ${recalcV2Job.total}`;
          continue;
        }

        recalcV2Job.stats[bucket]++;
        recalcV2Job.stats.total_commission += commission;

        // Buffer the write (commission + commission_status + commission_payable_date);
        // flushed in chunks below so report endpoints still get the same persisted values.
        recalcUpdates.push({ id: inv.id, commission, bucket, payableDate });
        recalcV2Job.processed++;
        recalcV2Job.message = `Processed ${recalcV2Job.processed} of ${recalcV2Job.total}`;
        if (recalcUpdates.length >= RECALC_UPDATE_CHUNK) await flushRecalcUpdates();
      }
      await flushRecalcUpdates();

      recalcV2Job.status  = recalcV2Job.status === 'stopping' ? 'stopped' : 'completed';
      recalcV2Job.stats.total_commission = Math.round(recalcV2Job.stats.total_commission * 100) / 100;
      recalcV2Job.message = `Done (${source}) — total commissions: $${recalcV2Job.stats.total_commission.toLocaleString()}`;
      console.log(`[RECALC] ${recalcV2Job.message} (processed ${recalcV2Job.processed})`);
      return recalcV2Job;
    } catch (error) {
      recalcV2Job.status  = 'error';
      recalcV2Job.message = error.message;
      console.error('recalc-v2 error:', error);
      return recalcV2Job;
    }
}

// HTTP endpoint — fire-and-forget wrapper around runRecalcV2
app.post('/api/commissions/recalc-v2/start', (req, res, next) => {
  // Shared-secret bypass (same as db-stats) so a recalc can be kicked off without a session.
  const provided = req.query.secret || req.headers['x-cluster-webhook-secret'];
  if (process.env.ZOHO_WEBHOOK_SECRET && provided === process.env.ZOHO_WEBHOOK_SECRET) {
    req.viaSecret = true;
    return next();
  }
  return authenticateToken(req, res, next);
}, async (req, res) => {
  if (!req.viaSecret && !req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  if (recalcV2Job.status === 'running') {
    return res.status(409).json({ error: 'Already running' });
  }
  res.json({ success: true, message: 'Recalc v2 started — poll /api/commissions/recalc-v2/status' });
  // Don't await — run in background
  runRecalcV2('manual').catch(e => console.error('recalc bg error:', e));
});

app.get('/api/commissions/recalc-v2/status', authenticateToken, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  res.json(recalcV2Job);
});

app.post('/api/commissions/recalc-v2/stop', authenticateToken, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  if (recalcV2Job.status === 'running') recalcV2Job.status = 'stopping';
  res.json({ success: true });
});

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
    const owner = process.env.GITHUB_OWNER || 'milthuz';
    const repo  = process.env.GITHUB_PRIMARY_REPO || 'commission-tracker';
    // Repair any broken legacy URLs on the fly so the frontend always gets a valid link
    const releases = result.rows.map(r => {
      let url = r.url;
      if (!url || url === '' || /^https:\/\/github\.com\/releases\//.test(url)) {
        url = `https://github.com/${owner}/${repo}/releases/tag/${r.version}`;
      }
      return { ...r, url };
    });
    res.json({ releases });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch releases', details: error.message });
  }
});

// GET /api/releases/latest — most recent release version (public, no auth needed for login screen)
app.get('/api/releases/latest', async (req, res) => {
  try {
    const result = await pool.query('SELECT version, name, date FROM releases ORDER BY date DESC LIMIT 1');
    const r = result.rows[0];
    res.json({
      version: r?.version || null,
      name:    r?.name    || null,
      date:    r?.date    || null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/releases/generate-notes — generates release notes from GitHub commits
// since the last published tag. Categorizes by prefix (feat/fix/style/etc).
app.get('/api/releases/generate-notes', authenticateToken, async (req, res) => {
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER || 'milthuz';
  // Pull notes from BOTH frontend + backend repos so a release covers all commits
  const repos = (process.env.GITHUB_REPOS || 'commission-tracker,commission-tracker-frontend')
    .split(',').map(s => s.trim()).filter(Boolean);

  if (!token) {
    return res.json({
      notes: '## ✨ New Features\n- \n\n## 🎨 UI Improvements\n- \n\n## 🔧 Bug Fixes\n- \n',
      commitCount: 0,
      sinceTag: '',
      warning: 'GITHUB_TOKEN env var not set — returning empty template. Add it to Heroku Config Vars to enable auto-generation.',
    });
  }

  const ghHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'commission-tracker',
  };

  // Pull commits since the last release tag from one repo
  async function commitsSinceLatestTag(repo) {
    // 1. Get latest tag (or fall back to no tag → all commits, up to 100)
    let sinceDate = null;
    let sinceTag  = null;
    try {
      const tagsRes = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}/tags?per_page=1`,
        { headers: ghHeaders, validateStatus: () => true }
      );
      if (tagsRes.status === 200 && Array.isArray(tagsRes.data) && tagsRes.data[0]) {
        sinceTag = tagsRes.data[0].name;
        // Get the commit date of that tag
        const tagSha = tagsRes.data[0].commit?.sha;
        if (tagSha) {
          const commitRes = await axios.get(
            `https://api.github.com/repos/${owner}/${repo}/commits/${tagSha}`,
            { headers: ghHeaders, validateStatus: () => true }
          );
          if (commitRes.status === 200) {
            sinceDate = commitRes.data?.commit?.committer?.date || null;
          }
        }
      }
    } catch (_e) { /* ignore */ }

    // 2. List commits since that date (or last 100 if no tag)
    const params = new URLSearchParams({ per_page: '100' });
    if (sinceDate) params.set('since', sinceDate);
    const commitsRes = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/commits?${params.toString()}`,
      { headers: ghHeaders, validateStatus: () => true }
    );
    if (commitsRes.status !== 200 || !Array.isArray(commitsRes.data)) return { commits: [], sinceTag };
    return {
      commits: commitsRes.data.map(c => ({
        sha:     c.sha?.slice(0, 7),
        message: (c.commit?.message || '').split('\n')[0], // first line only
        date:    c.commit?.committer?.date,
        url:     c.html_url,
        repo,
      })),
      sinceTag,
    };
  }

  try {
    const results = await Promise.all(repos.map(commitsSinceLatestTag));
    const allCommits = results.flatMap(r => r.commits);
    const sinceTag = results.find(r => r.sinceTag)?.sinceTag || '';

    // Filter out merge commits and Claude co-author footers
    const filtered = allCommits.filter(c => {
      const m = c.message.toLowerCase();
      if (m.startsWith('merge ')) return false;
      if (m.startsWith('co-authored-by')) return false;
      return true;
    });

    // Categorize by prefix (conventional commits + common keywords)
    const categories = {
      features:  [],
      ui:        [],
      fixes:     [],
      improvements: [],
      other:     [],
    };
    for (const c of filtered) {
      const m = c.message.toLowerCase();
      // Skip co-author and "fix typo" type commits
      if (/^(chore|ci|docs|test|build|deps?):/i.test(c.message)) continue;
      if (/^(feat|add|new):/i.test(c.message) || /\b(add|new feature|implement)/i.test(m)) {
        categories.features.push(c);
      } else if (/^(fix|bug)/i.test(c.message) || /\b(fix|resolve|repair)/i.test(m)) {
        categories.fixes.push(c);
      } else if (/^(style|ui|design):/i.test(c.message) || /\b(ui|design|layout|visual)/i.test(m)) {
        categories.ui.push(c);
      } else if (/^(refactor|perf|improve)/i.test(c.message) || /\b(improve|refactor|update|enhance)/i.test(m)) {
        categories.improvements.push(c);
      } else {
        categories.other.push(c);
      }
    }

    // AUTO "What's New": which menu sections got a NEW feature (feat) this release?
    // Map conventional-commit scopes → sidebar paths. Only feat(<scope>) earns a badge
    // (fixes/chores/ui don't). The admin can still tweak the pre-filled list.
    const SCOPE_TO_PATH = {
      reseller:             { path: '/reseller',            title: 'Resellers' },
      revenue:              { path: '/revenue',             title: 'Processing Revenue' },
      'commission-tracker': { path: '/commission-tracker',  title: 'Commission Tracker' },
      tracker:              { path: '/commission-tracker',  title: 'Commission Tracker' },
      'commission-report':  { path: '/commission-report',   title: 'Commission Report' },
      report:               { path: '/commission-report',   title: 'Commission Report' },
      salespeople:          { path: '/admin/salespeople',   title: 'Salespeople' },
      roles:                { path: '/admin/roles',         title: 'Roles & Permissions' },
    };
    const suggestedMap = new Map();
    for (const c of filtered) {
      const m = c.message.match(/^feat\(([^)]+)\)\s*:/i); // feat(scope): subject
      if (!m) continue;
      const target = SCOPE_TO_PATH[m[1].toLowerCase().trim()];
      if (!target || suggestedMap.has(target.path)) continue;
      const subject = c.message.replace(/^feat\([^)]+\)\s*:\s*/i, '').trim();
      suggestedMap.set(target.path, { path: target.path, title: target.title, description: subject, days: 7 });
    }
    const suggestedFeatures = [...suggestedMap.values()];

    // Build markdown notes
    const formatCommit = (c) => `- ${c.message}`;
    const sections = [];
    if (categories.features.length)     sections.push('## ✨ New Features\n' + categories.features.map(formatCommit).join('\n'));
    if (categories.ui.length)           sections.push('## 🎨 UI Improvements\n' + categories.ui.map(formatCommit).join('\n'));
    if (categories.fixes.length)        sections.push('## 🔧 Bug Fixes\n' + categories.fixes.map(formatCommit).join('\n'));
    if (categories.improvements.length) sections.push('## 🚀 Improvements\n' + categories.improvements.map(formatCommit).join('\n'));
    if (categories.other.length)        sections.push('## 📝 Other Changes\n' + categories.other.map(formatCommit).join('\n'));

    const notes = sections.length > 0
      ? sections.join('\n\n')
      : '## ✨ New Features\n- \n\n## 🎨 UI Improvements\n- \n\n## 🔧 Bug Fixes\n- \n';

    res.json({
      notes,
      commitCount: filtered.length,
      sinceTag,
      suggestedFeatures,
      categories: {
        features:     categories.features.length,
        ui:           categories.ui.length,
        fixes:        categories.fixes.length,
        improvements: categories.improvements.length,
        other:        categories.other.length,
      },
    });
  } catch (error) {
    console.error('generate-notes error:', error.message);
    res.status(500).json({
      notes: '## ✨ New Features\n- \n\n## 🎨 UI Improvements\n- \n\n## 🔧 Bug Fixes\n- \n',
      commitCount: 0,
      sinceTag: '',
      error: error.message,
    });
  }
});

// GET /api/releases/workflow-status
app.get('/api/releases/workflow-status', authenticateToken, async (req, res) => {
  res.json({ status: 'completed', conclusion: 'success' });
});

// POST /api/releases/create — create a real GitHub release on the primary repo
// AND store the record in our releases table. The 'View' button on the
// frontend uses the stored URL, which now points to the actual GitHub release.
app.post('/api/releases/create', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  const { version, releaseNotes, newFeatures } = req.body;
  if (!version) return res.status(400).json({ error: 'Version required' });

  const token   = process.env.GITHUB_TOKEN;
  const owner   = process.env.GITHUB_OWNER || 'milthuz';
  // Primary repo is where the GitHub release lives. Defaults to the backend repo.
  const repo    = process.env.GITHUB_PRIMARY_REPO || 'commission-tracker';
  const tagName = `v${String(version).replace(/^v/, '')}`;

  let releaseUrl = `https://github.com/${owner}/${repo}/releases/tag/${tagName}`;
  let warning   = null;

  // If GITHUB_TOKEN is set, create a real GitHub release via the API.
  // Otherwise fall back to a constructed URL (which may 404 until the user
  // manually creates the release on GitHub).
  if (token) {
    try {
      const ghRes = await axios.post(
        `https://api.github.com/repos/${owner}/${repo}/releases`,
        {
          tag_name:         tagName,
          name:             tagName,
          body:             releaseNotes || '',
          target_commitish: 'main',
          draft:            false,
          prerelease:       false,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept:        'application/vnd.github+json',
            'User-Agent':  'commission-tracker',
          },
          validateStatus: () => true,
        }
      );
      if (ghRes.status >= 200 && ghRes.status < 300 && ghRes.data?.html_url) {
        releaseUrl = ghRes.data.html_url;
      } else if (ghRes.status === 422) {
        // Tag already exists on GitHub — link to it anyway
        warning = `GitHub tag ${tagName} already exists; using existing release URL.`;
      } else {
        warning = `GitHub release creation returned ${ghRes.status}: ${JSON.stringify(ghRes.data).slice(0, 200)}`;
        console.warn('⚠️ GitHub release create:', warning);
      }
    } catch (e) {
      warning = `Could not call GitHub API: ${e.message}`;
      console.warn('⚠️ GitHub release create error:', e.message);
    }
  } else {
    warning = 'GITHUB_TOKEN not set — release recorded in DB only, no GitHub release created.';
  }

  try {
    const rel = await pool.query(
      `INSERT INTO releases (version, name, notes, url, date)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP) RETURNING id`,
      [tagName, tagName, releaseNotes || '', releaseUrl]
    );
    const releaseId = rel.rows[0].id;

    // "What's New" menu tags chosen at publish time → drive the sidebar dot/badge + banner.
    if (Array.isArray(newFeatures)) {
      for (const f of newFeatures) {
        if (!f || !f.path) continue;
        const featureId = `${tagName}:${f.path}`;
        await pool.query(
          `INSERT INTO new_features (feature_id, path, title, description, since, days, release_id)
           VALUES ($1, $2, $3, $4, CURRENT_DATE, $5, $6)
           ON CONFLICT (feature_id) DO UPDATE SET
             title = EXCLUDED.title, description = EXCLUDED.description,
             since = CURRENT_DATE, days = EXCLUDED.days, release_id = EXCLUDED.release_id`,
          [featureId, f.path, f.title || null, f.description || null, parseInt(f.days) || 7, releaseId]
        );
      }
    }
    res.json({ success: true, version: tagName, url: releaseUrl, warning });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save release record', details: error.message });
  }
});

// PATCH /api/releases/fix-urls — admin tool to bulk-fix broken release URLs
// stored under the old buggy format (https://github.com/releases/vX.X.X)
app.patch('/api/releases/fix-urls', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  const owner = process.env.GITHUB_OWNER || 'milthuz';
  const repo  = process.env.GITHUB_PRIMARY_REPO || 'commission-tracker';
  try {
    const result = await pool.query(
      `UPDATE releases
       SET url = 'https://github.com/${owner}/${repo}/releases/tag/' || version
       WHERE url LIKE 'https://github.com/releases/%'
       RETURNING version, url`
    );
    res.json({ success: true, fixed: result.rowCount, releases: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
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

// ROLE-based startup so a single codebase can boot as either:
//   - 'web'    (default): serves HTTP, no scheduled jobs
//   - 'worker':           runs the periodic sync/recalc/enrich jobs only, no HTTP
//   - 'all':              both (legacy single-process mode — useful for local dev)
// Procfile: `web: ROLE=web node server.js` and `worker: ROLE=worker node server.js`
const ROLE = (process.env.ROLE || 'all').toLowerCase();

// Wait for the DB schema migrations to finish, then run the given callback.
const waitForDb = (onReady, attempts = 0) => {
  if (dbReady) onReady();
  else if (attempts < 30) setTimeout(() => waitForDb(onReady, attempts + 1), 1000);
  else { console.warn('⚠️ DB not ready after 30s, proceeding anyway'); onReady(); }
};

if (ROLE === 'web' || ROLE === 'all') {
  app.listen(PORT, () => {
    console.log(`✅ Commission Tracker API running on http://localhost:${PORT} [role=${ROLE}]`);
    console.log(`📚 Zoho Books Organization ID: ${process.env.ZOHO_ORG_ID}`);
    console.log(`🔐 Frontend redirect: ${process.env.FRONTEND_URL}`);
    console.log(`🗄️  Database connected: ${process.env.DATABASE_URL ? 'Yes' : 'No'}`);
    // In 'all' mode the web process also runs scheduled jobs (legacy behaviour).
    if (ROLE === 'all') waitForDb(startAutoSync);
  });
}

if (ROLE === 'worker') {
  // Worker has no HTTP listener — just the scheduled jobs. Wait for the
  // schema migrations to finish (they run in initializeDatabase() at module
  // load) before kicking off the first sync.
  console.log(`🛠  Worker process starting [role=worker]`);
  console.log(`📚 Zoho Books Organization ID: ${process.env.ZOHO_ORG_ID}`);
  console.log(`🗄️  Database connected: ${process.env.DATABASE_URL ? 'Yes' : 'No'}`);
  waitForDb(startAutoSync);
}

// ============================================================================
// GLOBAL CRASH HANDLERS
// ============================================================================
// Modern Node crashes the process on unhandled promise rejections by default.
// In our app, that means a single bad request or background job kills the dyno
// and forces a 30-60 sec reboot — repeated crashes look like a memory issue
// but are really one async path nobody caught. Logging them and continuing keeps
// the process alive and tells us EXACTLY what's wrong via Heroku logs.

process.on('unhandledRejection', (reason, promise) => {
  const msg = reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason);
  console.error('🔥 UNHANDLED PROMISE REJECTION:', msg);
  console.error('   Promise:', promise);
  // Stay alive — log and move on.
});

process.on('uncaughtException', (err) => {
  console.error('🔥 UNCAUGHT EXCEPTION:', err.message);
  console.error('   Stack:', err.stack);
  // Stay alive — log and move on.
});

// Periodic memory snapshot for visibility (every 5 min). Heroku tier limits:
//   Standard-1X = 512 MB,  Standard-2X = 1 GB,  Perf-M = 2.5 GB.
// If RSS climbs past 80% of the limit, we'll see it here BEFORE the OOM kill.
setInterval(() => {
  const m = process.memoryUsage();
  const fmt = (b) => `${(b / 1024 / 1024).toFixed(0)}MB`;
  console.log(`📊 [${ROLE}] mem rss=${fmt(m.rss)} heap=${fmt(m.heapUsed)}/${fmt(m.heapTotal)} ext=${fmt(m.external)}`);
}, 5 * 60 * 1000);

// Lightweight health check that touches nothing (no DB, no Zoho) — for Heroku's
// load balancer + uptime checks. Always returns 200 if the process is alive.
app.get('/api/_health', (req, res) => {
  const m = process.memoryUsage();
  res.json({
    ok:        true,
    role:      ROLE,
    uptime_s:  Math.round(process.uptime()),
    pid:       process.pid,
    node:      process.version,
    has_global_crypto: typeof globalThis.crypto?.getRandomValues === 'function',
    memory_mb: { rss: Math.round(m.rss / 1024 / 1024), heap_used: Math.round(m.heapUsed / 1024 / 1024) },
  });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  if (typeof stopAutoSync === 'function') stopAutoSync();
  await pool.end();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down...');
  if (typeof stopAutoSync === 'function') stopAutoSync();
  await pool.end();
  process.exit(0);
});
