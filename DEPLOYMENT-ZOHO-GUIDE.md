# 🚀 DEPLOYMENT & ZOHO INTEGRATION GUIDE

Complete step-by-step instructions to deploy the Cluster POS Commission Tracker online with Zoho Books integration.

---

## 📋 Table of Contents

1. [Zoho Books Setup](#zoho-books-setup) ⭐ DO THIS FIRST
2. [Choose Hosting Platform](#choose-hosting-platform)
3. [Deploy Backend (API Server)](#deploy-backend)
4. [Deploy Frontend (React App)](#deploy-frontend)
5. [Connect Everything](#connect-everything)
6. [Testing](#testing)
7. [Troubleshooting](#troubleshooting)

---

## 🔑 ZOHO BOOKS SETUP (Step 1 - CRITICAL!)

### 1.1 Create Zoho Developer Account

1. Go to: https://api-console.zoho.com
2. Login with your Zoho account (or create one at https://www.zoho.com/en-us/signup/)
3. Click **"Add Client"**
4. Select **"Web-based Application"**
5. Fill in:
   - **Client Name**: `Cluster Commission Tracker`
   - **Homepage URL**: (leave for now, update later)
   - **Authorized Redirect URIs**: `http://localhost:5000/api/auth/callback` (for testing)
6. Click **CREATE**

### 1.2 Get Your Credentials

After creation, you'll see:
- **Client ID** ← Copy this
- **Client Secret** ← Copy this (keep SECRET!)

### 1.3 Get Organization ID

1. Login to your Zoho Books account: https://www.zoho.com/books/
2. Go to **Settings** → **Organization Details**
3. Copy your **Organization ID**

### 1.4 Determine Your Region

Zoho has different domains based on region:

```
Region              Accounts URL                API URL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
USA (Default)       https://accounts.zoho.com   https://www.zohoapis.com
EU                  https://accounts.zoho.eu   https://www.zohoapis.eu
India               https://accounts.zoho.in   https://www.zohoapis.in
Australia           https://accounts.zoho.com.au https://www.zohoapis.com.au
Japan               https://accounts.zoho.jp   https://www.zohoapis.jp
Canada              https://accounts.zoho.ca   https://www.zohoapis.ca
```

Check your Zoho account URL to find your region.

### 1.5 Save Your Zoho Credentials

Create a secure document with:
```
Zoho Credentials
═══════════════════════════════════════════
Client ID:          [YOUR_CLIENT_ID]
Client Secret:      [YOUR_CLIENT_SECRET]
Organization ID:    [YOUR_ORG_ID]
Accounts URL:       [https://accounts.zoho.com]
API URL:            [https://www.zohoapis.com]
Region:             [Your Region]
```

**⚠️ KEEP THESE SECRET! Do not commit to GitHub!**

---

## 🏠 CHOOSE HOSTING PLATFORM

### Option 1: Heroku (Easiest for Beginners) ✅ RECOMMENDED
- Cost: Free tier available ($7-14/month for production)
- Setup time: 15 minutes
- Pros: Automatic deploys, easy scaling
- Cons: Slightly slower cold starts

### Option 2: Docker + Cloud Provider (Most Flexible)
- Platforms: AWS, Azure, Google Cloud, DigitalOcean
- Cost: $5-20/month (very scalable)
- Setup time: 30-60 minutes
- Pros: Full control, unlimited scale
- Cons: More configuration

### Option 3: Vercel (Frontend Only)
- Cost: Free tier available
- Setup time: 5 minutes
- Pros: Extremely fast, automatic deploys
- Cons: Backend must be elsewhere

**For this guide, I'll show both Heroku (easiest) and DigitalOcean (flexible).**

---

## 🚀 DEPLOY BACKEND (API Server)

### Method 1: Deploy to Heroku (EASIEST)

#### 1. Install Heroku CLI

Download from: https://devcenter.heroku.com/articles/heroku-cli

Verify installation:
```bash
heroku --version
```

#### 2. Create Heroku App

```bash
heroku login
heroku create commission-tracker-api
```

This creates your app and gives you a URL like:
```
https://commission-tracker-api.herokuapp.com
```

#### 3. Update OAuth Redirect URI

Go to https://api-console.zoho.com and update:
- **Authorized Redirect URIs**: `https://commission-tracker-api.herokuapp.com/api/auth/callback`

#### 4. Deploy Backend

```bash
# In your project directory with server.js

# Add Procfile
echo "web: node server.js" > Procfile

# Set environment variables on Heroku
heroku config:set ZOHO_CLIENT_ID="your_client_id"
heroku config:set ZOHO_CLIENT_SECRET="your_client_secret"
heroku config:set ZOHO_ORG_ID="your_org_id"
heroku config:set ZOHO_ACCOUNTS_URL="https://accounts.zoho.com"
heroku config:set ZOHO_API_URL="https://www.zohoapis.com"
heroku config:set FRONTEND_URL="https://your-frontend-url.vercel.app"
heroku config:set JWT_SECRET="your-super-secret-key-change-this"
heroku config:set NODE_ENV="production"

# Deploy
git add .
git commit -m "Deploy to Heroku"
git push heroku main

# View logs
heroku logs --tail
```

**Your API is now live at:** `https://commission-tracker-api.herokuapp.com`

#### 5. Verify Backend is Running

```bash
curl https://commission-tracker-api.herokuapp.com/api/health

# Should return:
# {"status":"ok","timestamp":"2025-10-27T..."}
```

---

### Method 2: Deploy to DigitalOcean (Most Control)

#### 1. Create DigitalOcean Account

1. Sign up: https://www.digitalocean.com/
2. Create a new App or Droplet
3. Choose Ubuntu 24 as OS

#### 2. SSH into Your Server

```bash
ssh root@your_server_ip
```

#### 3. Install Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo apt-get install -y npm
```

#### 4. Install PM2 (Process Manager)

```bash
sudo npm install -g pm2
```

#### 5. Clone Your Repository

```bash
cd /var/www
git clone https://github.com/your-username/commission-tracker.git
cd commission-tracker
```

#### 6. Install Dependencies & Configure

```bash
npm install

# Create .env file with your credentials
nano .env
```

Add:
```env
NODE_ENV=production
PORT=3000
ZOHO_CLIENT_ID=your_client_id
ZOHO_CLIENT_SECRET=your_client_secret
ZOHO_ORG_ID=your_org_id
ZOHO_ACCOUNTS_URL=https://accounts.zoho.com
ZOHO_API_URL=https://www.zohoapis.com
FRONTEND_URL=https://your-frontend-domain.com
JWT_SECRET=your-super-secret-key
```

#### 7. Start with PM2

```bash
pm2 start server.js --name "commission-tracker"
pm2 startup
pm2 save
```

#### 8. Setup Nginx Reverse Proxy

```bash
sudo apt-get install nginx

# Create Nginx config
sudo nano /etc/nginx/sites-available/commission-tracker
```

Add:
```nginx
server {
    listen 80;
    server_name your-api-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
# Enable config
sudo ln -s /etc/nginx/sites-available/commission-tracker /etc/nginx/sites-enabled/

# Test and restart
sudo nginx -t
sudo systemctl restart nginx
```

#### 9. Setup SSL (HTTPS)

```bash
sudo apt-get install certbot python3-certbot-nginx
sudo certbot --nginx -d your-api-domain.com
```

**Your API is now live at:** `https://your-api-domain.com`

---

## ⚛️ DEPLOY FRONTEND (React App)

### Method 1: Deploy to Vercel (EASIEST)

#### 1. Push to GitHub

```bash
# Initialize git (if not already)
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/your-username/commission-tracker-frontend.git
git push -u origin main
```

#### 2. Connect to Vercel

1. Go to: https://vercel.com/
2. Click **"Import Project"**
3. Select **"Import Git Repository"**
4. Paste your GitHub URL
5. Click **Import**

#### 3. Configure Environment Variables

In Vercel dashboard:
1. Go to **Settings** → **Environment Variables**
2. Add:
```
REACT_APP_API_URL    = https://commission-tracker-api.herokuapp.com
REACT_APP_ZOHO_ORG_ID = your_org_id
```

#### 4. Deploy

Click **Deploy** and wait (usually 2-3 minutes)

**Your frontend is now live at:** `https://your-app.vercel.app`

---

### Method 2: Deploy to DigitalOcean App Platform

#### 1. Create App on DigitalOcean

1. Go to: https://cloud.digitalocean.com/apps/
2. Click **"Create Apps"**
3. Select **"GitHub"**
4. Select your repository
5. Choose **"React"** as framework

#### 2. Set Build Command

```
npm install && npm run build
```

#### 3. Set Environment Variables

```
REACT_APP_API_URL=https://your-api-domain.com
REACT_APP_ZOHO_ORG_ID=your_org_id
```

#### 4. Deploy

Click **"Deploy"** and wait

**Your frontend is now live at:** `https://your-app.ondigitalocean.app`

---

### Method 3: Deploy to Netlify

#### 1. Connect GitHub

1. Go to: https://www.netlify.com/
2. Click **"Add new site"** → **"Import an existing project"**
3. Select GitHub repository

#### 2. Configure Build

Build command: `npm run build`
Publish directory: `build`

#### 3. Set Environment Variables

Environment variables → Add:
```
REACT_APP_API_URL = https://your-api-domain.com
REACT_APP_ZOHO_ORG_ID = your_org_id
```

#### 4. Deploy

Click **Deploy site**

**Your frontend is now live at:** `https://your-app.netlify.app`

---

## 🔗 CONNECT EVERYTHING

### Update Zoho OAuth Settings

1. Go to: https://api-console.zoho.com
2. Find your app, click **"Edit"**
3. Update **Authorized Redirect URIs** to:
```
https://your-frontend-domain.com/api/auth/callback
https://commission-tracker-api.herokuapp.com/api/auth/callback
```

### Update Frontend Configuration

In your React app (after deployment), update the environment variable:

```
REACT_APP_API_URL = https://commission-tracker-api.herokuapp.com
```

### Update Backend Configuration

Make sure your backend knows about frontend:

```env
FRONTEND_URL = https://your-frontend-domain.com
```

### Create .env for Local Development

```env
# Backend .env
NODE_ENV=development
PORT=5000
ZOHO_CLIENT_ID=your_client_id
ZOHO_CLIENT_SECRET=your_client_secret
ZOHO_ORG_ID=your_org_id
ZOHO_ACCOUNTS_URL=https://accounts.zoho.com
ZOHO_API_URL=https://www.zohoapis.com
FRONTEND_URL=http://localhost:3000
JWT_SECRET=your-secret-key-for-dev
```

---

## 🧪 TESTING

### Test 1: Backend Health Check

```bash
curl https://your-api.herokuapp.com/api/health

# Expected response:
# {"status":"ok","timestamp":"2025-10-27T..."}
```

### Test 2: Test Demo Login

1. Open your deployed frontend
2. Use demo credentials:
   - Email: `demo@example.com`
   - Password: `pass123`
3. You should see the dashboard

### Test 3: Test Zoho OAuth

1. Click **"Connect with Zoho"** (if available)
2. You'll be redirected to Zoho login
3. Login with your Zoho account
4. You should see your commissions from Zoho Books

### Test 4: Real Data Test

1. Create a test invoice in Zoho Books:
   - Amount: $1000
   - Status: PAID
   - Sales Rep: (your name)
   - Line item: Regular product (10% commission = $100)

2. Wait a few minutes
3. Refresh the app
4. You should see the commission

---

## 🐛 TROUBLESHOOTING

### Problem: "Redirect URI mismatch"

**Fix:**
1. Check Zoho API Console has correct redirect URI
2. Make sure it matches exactly (including https://)
3. Verify no trailing slashes

### Problem: "Cannot connect to API"

**Fix:**
1. Check API is actually running: `curl https://your-api.com/api/health`
2. Verify CORS is enabled in backend
3. Check environment variables are set
4. Look at backend logs for errors

### Problem: "No invoices showing"

**Fix:**
1. Make sure you're logged in with Zoho
2. Verify invoices exist in Zoho Books
3. Make sure invoices have status = PAID
4. Check salesperson is assigned
5. Check date range includes the invoices

### Problem: "Token expired"

**Fix:**
1. This is normal - token refresh should handle it
2. If problem persists, logout and login again
3. Check backend logs for token refresh errors

### Problem: "Mobile app not working"

**Fix:**
1. Check responsive design is working
2. Verify all assets are loading
3. Test on different browsers
4. Check browser console for errors

### Problem: "Slow performance"

**Fix:**
1. Check API response times
2. Verify database queries are optimized
3. Consider upgrading hosting plan
4. Enable caching

---

## 📊 MONITORING & MAINTENANCE

### Monitor Backend Logs

**Heroku:**
```bash
heroku logs --tail
```

**DigitalOcean:**
```bash
pm2 logs commission-tracker
```

### Monitor Uptime

Use free services:
- https://uptimerobot.com/
- https://www.statuspage.io/

### Regular Backups

**For Database:**
```bash
# Export Zoho data regularly
# (Zoho automatically backs up, but good practice)
```

### Update Dependencies

```bash
npm outdated          # See what's outdated
npm update            # Update packages
npm audit             # Check for vulnerabilities
```

---

## 🔒 SECURITY CHECKLIST

- ☐ Never commit .env file
- ☐ Use strong JWT_SECRET
- ☐ Keep Client Secret safe
- ☐ Use HTTPS only
- ☐ Enable CORS on backend (restrict to your domain)
- ☐ Regular security updates
- ☐ Monitor for suspicious activity
- ☐ Backup data regularly

---

## 📈 SCALING

### When Traffic Grows

**Heroku:**
```bash
heroku ps:scale web=2  # Scale to 2 dynos
```

**DigitalOcean:**
- Upgrade droplet size
- Add load balancer
- Use database cluster

### Database Optimization

```sql
-- Add indexes for faster queries
CREATE INDEX idx_commission_history_user_id ON commission_history(user_id);
CREATE INDEX idx_commission_history_period ON commission_history(period_start, period_end);
```

---

## 📞 SUPPORT RESOURCES

### Heroku
- Docs: https://devcenter.heroku.com/
- Status: https://status.heroku.com/

### Zoho Books
- API Docs: https://www.zoho.com/books/api/
- Support: https://www.zoho.com/support/

### React/Vercel
- Docs: https://react.dev/
- Vercel: https://vercel.com/docs

### DigitalOcean
- Community: https://www.digitalocean.com/community/
- Docs: https://docs.digitalocean.com/

---

## ✅ DEPLOYMENT CHECKLIST

- ☐ Create Zoho Developer App
- ☐ Get Client ID, Client Secret, Organization ID
- ☐ Choose hosting platform
- ☐ Deploy backend API
- ☐ Deploy frontend React app
- ☐ Update Zoho OAuth redirect URIs
- ☐ Test demo login
- ☐ Test Zoho OAuth
- ☐ Test with real invoices
- ☐ Setup monitoring
- ☐ Setup backups
- ☐ Document deployment

---

## 🎉 You're Live!

Congratulations! Your Commission Tracker is now:
✅ Deployed online
✅ Connected to Zoho Books
✅ Accessible from anywhere
✅ Ready for your sales team

---

**Deployment Status**: Production Ready
**Last Updated**: October 2025
**Support**: See resources section above

**Questions?** Check the specific platform's documentation or contact their support.
