# 🚀 QUICK DEPLOYMENT CHECKLIST

Complete this checklist to get your Commission Tracker online with Zoho in 30-60 minutes.

---

## PHASE 1: ZOHO SETUP (10 minutes)

### ☐ Create Zoho Developer App
- [ ] Go to: https://api-console.zoho.com
- [ ] Login to Zoho account
- [ ] Click "Add Client" → "Web-based Application"
- [ ] Name: "Cluster Commission Tracker"
- [ ] Homepage: (can update later)
- [ ] Redirect URI: http://localhost:5000/api/auth/callback
- [ ] Click CREATE

### ☐ Save Credentials (IMPORTANT!)
Copy and save these securely:
- [ ] **Client ID** = ________________
- [ ] **Client Secret** = ________________
- [ ] **Organization ID** = ________________
- [ ] **Region** (EU/US/IN/etc) = ________________

### ☐ Verify Your Region
Your Zoho account URL tells you the region:
- [ ] .com → USA (https://accounts.zoho.com)
- [ ] .eu → EU (https://accounts.zoho.eu)
- [ ] .in → India (https://accounts.zoho.in)
- [ ] .com.au → Australia
- [ ] .jp → Japan
- [ ] .ca → Canada

---

## PHASE 2: CHOOSE DEPLOYMENT (2 minutes)

### Pick ONE Option:

#### Option A: Heroku (Easiest) ✅ RECOMMENDED
- [ ] Requires: Heroku CLI + GitHub account
- [ ] Time: 15 minutes
- [ ] Cost: Free or $7/month
- [ ] Pros: Simple, automatic deploys
- [ ] Go to: Phase 3A

#### Option B: DigitalOcean (Most Control)
- [ ] Requires: DigitalOcean account + $5+/month
- [ ] Time: 45-60 minutes
- [ ] Cost: $5-20/month
- [ ] Pros: Full control, scalable
- [ ] Go to: Phase 3B

#### Option C: Vercel + Heroku (Hybrid)
- [ ] Frontend on Vercel (free)
- [ ] Backend on Heroku (free)
- [ ] Go to: Phase 3A & 4A

---

## PHASE 3A: DEPLOY TO HEROKU (15 minutes)

### ☐ Install Heroku CLI
- [ ] Download: https://devcenter.heroku.com/articles/heroku-cli
- [ ] Open terminal, verify: `heroku --version`

### ☐ Deploy Backend
```bash
# In your project directory
heroku login
heroku create commission-tracker-api

# Get your Heroku URL (will look like https://commission-tracker-api.herokuapp.com)
# Copy it: _________________________________

# Set environment variables
heroku config:set ZOHO_CLIENT_ID="[PASTE YOUR CLIENT ID]"
heroku config:set ZOHO_CLIENT_SECRET="[PASTE YOUR CLIENT SECRET]"
heroku config:set ZOHO_ORG_ID="[PASTE YOUR ORG ID]"
heroku config:set ZOHO_ACCOUNTS_URL="https://accounts.zoho.com"  # (adjust for your region)
heroku config:set ZOHO_API_URL="https://www.zohoapis.com"         # (adjust for your region)
heroku config:set FRONTEND_URL="[YOU'LL FILL THIS IN PHASE 4]"
heroku config:set JWT_SECRET="$(openssl rand -base64 32)"
heroku config:set NODE_ENV="production"

# Create Procfile
echo "web: node server.js" > Procfile

# Deploy
git add .
git commit -m "Deploy to Heroku"
git push heroku main

# Check it's running
heroku logs --tail
```

### ☐ Update Zoho Redirect URIs
- [ ] Go to: https://api-console.zoho.com
- [ ] Edit your app
- [ ] Update Authorized Redirect URIs to:
  ```
  https://commission-tracker-api.herokuapp.com/api/auth/callback
  ```
- [ ] Save

### ☐ Test Backend
```bash
curl https://commission-tracker-api.herokuapp.com/api/health
# Should return: {"status":"ok","timestamp":"..."}
```

Your Backend URL: `https://commission-tracker-api.herokuapp.com`

---

## PHASE 3B: DEPLOY TO DIGITALOCEAN (45-60 minutes)

### ☐ Create Server
- [ ] Go to: https://www.digitalocean.com/
- [ ] Create new Droplet
- [ ] Choose: Ubuntu 24 LTS
- [ ] Size: $5/month basic
- [ ] Copy your IP address: _________________

### ☐ SSH into Server
```bash
ssh root@[YOUR_IP]
```

### ☐ Install Software
```bash
# Update system
apt update && apt upgrade -y

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
apt install -y nodejs

# Install PM2
npm install -g pm2

# Install Nginx
apt install -y nginx

# Install Certbot (for HTTPS)
apt install -y certbot python3-certbot-nginx
```

### ☐ Deploy Application
```bash
cd /var/www
git clone [YOUR_REPO_URL]
cd commission-tracker
npm install

# Create .env
nano .env
# Paste this and fill in YOUR values:
NODE_ENV=production
PORT=3000
ZOHO_CLIENT_ID=YOUR_CLIENT_ID
ZOHO_CLIENT_SECRET=YOUR_CLIENT_SECRET
ZOHO_ORG_ID=YOUR_ORG_ID
ZOHO_ACCOUNTS_URL=https://accounts.zoho.com
ZOHO_API_URL=https://www.zohoapis.com
FRONTEND_URL=[YOU'LL SET THIS IN PHASE 4]
JWT_SECRET=$(openssl rand -base64 32)
# Press Ctrl+X, then Y, then Enter to save

# Start with PM2
pm2 start server.js --name "commission-tracker"
pm2 startup
pm2 save
```

### ☐ Setup Domain & HTTPS
```bash
# Update your domain to point to this IP address (in your domain registrar)
# Then:

sudo nano /etc/nginx/sites-available/commission-tracker
# Add this:
/*
server {
    listen 80;
    server_name your-domain.com;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
*/

# Enable
sudo ln -s /etc/nginx/sites-available/commission-tracker /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx

# Get HTTPS certificate
sudo certbot --nginx -d your-domain.com
```

Your Backend URL: `https://your-domain.com`

---

## PHASE 4A: DEPLOY FRONTEND TO VERCEL (5 minutes)

### ☐ Push to GitHub
```bash
git add .
git commit -m "Ready for deployment"
git push origin main
```

### ☐ Import to Vercel
- [ ] Go to: https://vercel.com/
- [ ] Click "Import Project"
- [ ] Select GitHub and your repository
- [ ] Click "Import"

### ☐ Set Environment Variables
- [ ] In Vercel dashboard → Settings → Environment Variables
- [ ] Add:
  ```
  REACT_APP_API_URL = [YOUR BACKEND URL from Phase 3]
  REACT_APP_ZOHO_ORG_ID = [YOUR ORG ID]
  ```
- [ ] Click "Deploy"

### ☐ Update Zoho Settings
- [ ] Go to: https://api-console.zoho.com
- [ ] Edit your app
- [ ] Add to Redirect URIs:
  ```
  https://[your-vercel-app].vercel.app/api/auth/callback
  ```
- [ ] Save

Your Frontend URL: `https://[your-app].vercel.app` (Vercel shows this)

---

## PHASE 4B: DEPLOY FRONTEND TO DIGITALOCEAN (20 minutes)

### ☐ Setup React Build
```bash
cd /var/www/commission-tracker
npm run build
```

### ☐ Configure Nginx for React
```bash
sudo nano /etc/nginx/sites-available/commission-tracker-frontend

# Add:
/*
server {
    listen 80;
    server_name your-frontend-domain.com;
    
    root /var/www/commission-tracker/build;
    index index.html;
    
    location / {
        try_files $uri /index.html;
    }
    
    location /api {
        proxy_pass https://your-backend-domain.com;
    }
}
*/

sudo systemctl restart nginx
```

### ☐ Get HTTPS Certificate
```bash
sudo certbot --nginx -d your-frontend-domain.com
```

Your Frontend URL: `https://your-frontend-domain.com`

---

## PHASE 5: TESTING (10 minutes)

### ☐ Test Backend Health
```bash
curl https://[YOUR_BACKEND_URL]/api/health
# Should return: {"status":"ok","timestamp":"..."}
```

### ☐ Test Frontend
- [ ] Open your frontend URL in browser
- [ ] You should see login page

### ☐ Test Demo Login
- [ ] Email: `demo@example.com`
- [ ] Password: `pass123`
- [ ] Should see dashboard with mock data

### ☐ Test Zoho OAuth
- [ ] Click "Connect with Zoho" button (if available)
- [ ] Login with your Zoho account
- [ ] Should redirect back to app

### ☐ Create Test Invoice in Zoho
- [ ] Go to: https://www.zoho.com/books/
- [ ] Create new invoice
- [ ] Amount: $1000
- [ ] Status: PAID
- [ ] Sales Rep: (assign to yourself)
- [ ] Line item: Name "TEST PRODUCT", Price $1000

### ☐ Check Commission Shows
- [ ] Go back to your app
- [ ] Refresh the page
- [ ] Should see commission: $100 (10% of $1000)

---

## PHASE 6: FINAL SETUP (5 minutes)

### ☐ Setup Monitoring (Optional)
- [ ] Go to: https://uptimerobot.com/
- [ ] Add your backend URL
- [ ] Get alerts if it goes down

### ☐ Document URLs
Save these somewhere safe:

```
PRODUCTION URLS
═══════════════════════════════════════════
Frontend:      https://[YOUR_FRONTEND_URL]
Backend API:   https://[YOUR_BACKEND_URL]
Zoho Org ID:   [YOUR_ORG_ID]
Region:        [YOUR_REGION]
```

### ☐ Security Checklist
- [ ] Never commit .env file
- [ ] Use strong JWT_SECRET
- [ ] Keep Client Secret safe
- [ ] Enable HTTPS only
- [ ] Test logout works
- [ ] Test error handling

---

## ✅ FINAL CHECKLIST

- [ ] Zoho app created and credentials saved
- [ ] Backend deployed and running
- [ ] Frontend deployed and running
- [ ] Zoho redirect URIs updated
- [ ] Backend health check passes
- [ ] Demo login works
- [ ] Zoho OAuth works
- [ ] Test invoice shows commission
- [ ] Monitoring setup (optional)
- [ ] Documentation saved

---

## 🎉 YOU'RE LIVE!

Your Commission Tracker is now:
✅ Online and accessible
✅ Connected to Zoho Books
✅ Ready for your sales team
✅ Automatically tracking commissions

---

## 📊 NEXT STEPS

1. **Tell your sales team**: Send them the frontend URL
2. **Invite team members**: Each person logs in and connects Zoho
3. **Monitor**: Check logs regularly for issues
4. **Maintain**: Keep dependencies updated, backup data
5. **Scale**: Upgrade as traffic grows

---

## 🆘 QUICK TROUBLESHOOTING

| Problem | Solution |
|---------|----------|
| Backend won't deploy | Check logs: `heroku logs --tail` |
| "Redirect URI mismatch" | Update in Zoho API Console |
| No invoices showing | Check they're PAID status in Zoho |
| Can't login | Clear browser cache, try again |
| App is slow | Upgrade hosting plan |
| Lost credentials | Check .env file or cloud provider settings |

---

## 📚 RESOURCES

- Zoho API Docs: https://www.zoho.com/books/api/
- Heroku Docs: https://devcenter.heroku.com/
- DigitalOcean Docs: https://docs.digitalocean.com/
- React Docs: https://react.dev/
- Vercel Docs: https://vercel.com/docs

---

**Time Estimate**: 30-60 minutes total
**Cost**: Free-$20/month depending on platform
**Difficulty**: Beginner-friendly (step-by-step)

**Status**: Ready to Deploy! 🚀
