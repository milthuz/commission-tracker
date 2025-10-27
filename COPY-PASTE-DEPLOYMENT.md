# 🎯 DEPLOYMENT ASSISTANT - Copy & Paste Commands

This is a simple guide where you just copy and paste commands. No complicated setup!

---

## ✅ BEFORE YOU START

Make sure you have:
- [ ] Zoho credentials (Client ID, Secret, Org ID) - Get from https://api-console.zoho.com
- [ ] GitHub account with your code pushed
- [ ] Heroku account (free at heroku.com)
- [ ] Vercel account (free at vercel.com)

---

## 🔑 STEP 1: GET YOUR ZOHO CREDENTIALS

### 1a. Create Zoho App
1. Go to: https://api-console.zoho.com
2. Click "Add Client" → "Web-based Application"
3. Fill in:
   - Name: `Cluster Commission Tracker`
   - Redirect URI: `http://localhost:5000/api/auth/callback`
4. Click CREATE

### 1b. Copy These Values
After creation, you'll see:
```
Client ID = ________________
Client Secret = ________________
Organization ID = ________________
```

### 1c. Find Your Region
Check your Zoho account URL:
- accounts.zoho.com → USA
- accounts.zoho.eu → EU
- accounts.zoho.in → India
- accounts.zoho.com.au → Australia
- accounts.zoho.jp → Japan
- accounts.zoho.ca → Canada

**Your Region:** ________________

---

## 💻 STEP 2: DEPLOY BACKEND (HEROKU)

### 2a. Install Heroku CLI

**macOS:**
```bash
brew tap heroku/brew && brew install heroku
```

**Linux:**
```bash
curl https://cli-assets.heroku.com/install.sh | sh
```

**Windows:**
Download from: https://devcenter.heroku.com/articles/heroku-cli

### 2b. Login to Heroku
```bash
heroku login
```
This opens your browser to login. Do that, then come back.

### 2c. Create Heroku App
```bash
heroku create commission-tracker-api
```

**Important**: Copy the URL you get back, it looks like:
```
https://commission-tracker-api.herokuapp.com
```

**Save your backend URL here:** 
```
https://commission-tracker-api.herokuapp.com
```

### 2d. Set Environment Variables

Copy this and replace the XXX values with YOUR credentials:

```bash
heroku config:set \
  ZOHO_CLIENT_ID="XXX_YOUR_CLIENT_ID" \
  ZOHO_CLIENT_SECRET="XXX_YOUR_CLIENT_SECRET" \
  ZOHO_ORG_ID="XXX_YOUR_ORG_ID" \
  ZOHO_ACCOUNTS_URL="https://accounts.zoho.com" \
  ZOHO_API_URL="https://www.zohoapis.com" \
  JWT_SECRET="$(openssl rand -base64 32)" \
  NODE_ENV="production"
```

### 2e. Create Procfile

In your project directory, create a file named `Procfile` (no extension):

```
web: node server.js
```

### 2f. Deploy to Heroku

```bash
git add Procfile
git commit -m "Add Procfile for Heroku"
git push heroku main
```

(Or `git push heroku master` if your branch is master)

### 2g. Check It's Running

```bash
heroku logs --tail
```

You should see the app starting up. If it says "listening on port 3000" or similar, it's working!

Test with:
```bash
curl https://commission-tracker-api.herokuapp.com/api/health
```

---

## ⚛️ STEP 3: DEPLOY FRONTEND (VERCEL)

### 3a. Push Code to GitHub
```bash
git push origin main
```
(Or `git push origin master`)

### 3b. Deploy on Vercel

1. Go to: https://vercel.com/
2. Click "Add New..." → "Project"
3. Click "Import Git Repository"
4. Paste your GitHub repository URL
5. Click "Continue"
6. It will show your project
7. Scroll down to "Environment Variables"

### 3c. Add Environment Variables

Add these TWO variables:

**Variable 1:**
```
Name:  REACT_APP_API_URL
Value: https://commission-tracker-api.herokuapp.com
```
(Or your custom backend URL)

**Variable 2:**
```
Name:  REACT_APP_ZOHO_ORG_ID
Value: [YOUR_ORG_ID]
```

### 3d. Click Deploy

Vercel will build and deploy your app. This takes about 1-2 minutes.

When done, you'll get a URL like:
```
https://commission-tracker-xxxxxxxx.vercel.app
```

**Save your frontend URL here:**
```
https://commission-tracker-xxxxxxxx.vercel.app
```

---

## 🔗 STEP 4: CONNECT EVERYTHING

### 4a. Tell Backend About Frontend

```bash
heroku config:set FRONTEND_URL="https://commission-tracker-xxxxxxxx.vercel.app" -a commission-tracker-api
```

(Replace with YOUR Vercel URL)

### 4b. Update Zoho OAuth Settings

1. Go to: https://api-console.zoho.com
2. Find your app and click Edit
3. Go to "Redirect URIs"
4. Add these TWO URIs:
   ```
   https://commission-tracker-api.herokuapp.com/api/auth/callback
   https://commission-tracker-xxxxxxxx.vercel.app/api/auth/callback
   ```
5. Click Save

---

## 🧪 STEP 5: TEST EVERYTHING

### 5a. Test Backend
```bash
curl https://commission-tracker-api.herokuapp.com/api/health
```

Should return:
```json
{"status":"ok","timestamp":"2025-10-27T..."}
```

### 5b. Test Frontend

1. Open your Vercel URL in browser
2. You should see a login page

### 5c. Try Demo Login

1. Email: `demo@example.com`
2. Password: `pass123`
3. Should see dashboard with mock commissions

### 5d. Try Zoho OAuth

1. On the dashboard, look for "Connect with Zoho" button
2. Click it
3. Login with your Zoho account
4. Should redirect back to app

### 5e. Create Test Invoice

1. Go to Zoho Books: https://www.zoho.com/books/
2. Create new invoice:
   - Customer: Test
   - Amount: $1000
   - Line item: Product - $1000
   - Mark as PAID
   - Sales Rep: Your Name

3. Back in your app, refresh the page
4. You should see $100 commission (10% of $1000)

---

## 🎉 YOU'RE LIVE!

If all tests pass:
✅ Your backend is online
✅ Your frontend is online
✅ Zoho is connected
✅ Commissions are calculating

---

## 📱 SHARE WITH YOUR TEAM

Send them:
```
Your Commission Tracker is ready!

Access here: https://commission-tracker-xxxxxxxx.vercel.app

How to use:
1. Click "Sign In"
2. Click "Connect with Zoho" 
3. Login with your Zoho account
4. See your commissions!
```

---

## 🆘 TROUBLESHOOTING

### "Redirect URI mismatch" error
- Go to https://api-console.zoho.com
- Make sure the redirect URIs EXACTLY match your deployment URLs
- No extra spaces, trailing slashes, or typos

### "Can't connect to API" error
- Check backend URL is correct in REACT_APP_API_URL
- Make sure backend is running: `heroku logs --tail -a commission-tracker-api`
- Wait a few seconds and try again

### "No commissions showing" 
- Make sure invoice is PAID status in Zoho
- Make sure salesperson is assigned
- Try refreshing the page

### "Heroku costs too much"
- Free tier is available
- Upgrade to Paid Dynos ($7/month) when ready
- Or switch to DigitalOcean ($5/month)

---

## 📊 COMMAND SUMMARY

Save these commands for later:

```bash
# Check backend logs
heroku logs --tail -a commission-tracker-api

# Check backend health
curl https://commission-tracker-api.herokuapp.com/api/health

# Redeploy backend
git push heroku main

# View Heroku config
heroku config -a commission-tracker-api

# View backend details
heroku apps:info -a commission-tracker-api

# Scale backend (if you upgrade)
heroku ps:scale web=2 -a commission-tracker-api
```

---

## ✅ FINAL CHECKLIST

- [ ] Zoho app created
- [ ] Backend deployed to Heroku
- [ ] Frontend deployed to Vercel
- [ ] Environment variables set
- [ ] Zoho OAuth URIs updated
- [ ] Backend health check works
- [ ] Frontend loads
- [ ] Demo login works
- [ ] Zoho OAuth works
- [ ] Real commissions show
- [ ] Team has access

---

**You did it!** 🎉

Your commission tracker is now live and tracking commissions automatically from Zoho Books!

---

**Need help?** See the main deployment guides:
- HOW-TO-GO-LIVE.md (step-by-step)
- DEPLOYMENT-ZOHO-GUIDE.md (detailed)
- DEPLOYMENT-QUICK-CHECKLIST.md (full checklist)
