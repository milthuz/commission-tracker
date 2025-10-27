# 🔑 ZOHO API SETUP - COMPLETE GUIDE

## Creating the Zoho OAuth App

When you go to https://api-console.zoho.com and create a new "Web-based Application", you'll see a form like this:

```
Application Name *
Homepage URL
Authorized Redirect URIs *
```

Here's exactly what to fill in:

---

## STEP 1: Application Name

**What to put:**
```
Cluster Commission Tracker
```

This is just the name of your app. Anything descriptive works.

---

## STEP 2: Homepage URL (Optional but do this)

The "Homepage URL" is where users go to use your app. Since you're just setting up, you have two options:

### Option A: If You Already Have Your Vercel URL
If you already deployed to Vercel and have a URL like `https://commission-tracker-xxxxx.vercel.app`, put that:

```
https://commission-tracker-xxxxx.vercel.app
```

### Option B: If You Don't Have Your Vercel URL Yet
You can use a placeholder for now. Put ANY of these:

```
https://localhost:3000
```
or
```
https://example.com
```
or even just
```
http://localhost:3000
```

**You can change this later!** Don't worry if you don't know it yet.

---

## STEP 3: Authorized Redirect URIs (This is Important!)

This is where Zoho redirects users AFTER they login.

### For Development (Testing Locally)
```
http://localhost:5000/api/auth/callback
```

### For Production (After Deployment)
Add BOTH of these:

```
https://commission-tracker-api.herokuapp.com/api/auth/callback
https://commission-tracker-xxxxx.vercel.app/api/auth/callback
```

Replace:
- `commission-tracker-api` with your Heroku app name
- `commission-tracker-xxxxx` with your actual Vercel domain

---

## COMPLETE EXAMPLE

Here's what a filled-out form looks like:

```
Application Name:
  Cluster Commission Tracker

Homepage URL:
  http://localhost:3000

Authorized Redirect URIs:
  http://localhost:5000/api/auth/callback
```

Then after you deploy:

```
Application Name:
  Cluster Commission Tracker

Homepage URL:
  https://commission-tracker-xxxxx.vercel.app

Authorized Redirect URIs:
  http://localhost:5000/api/auth/callback
  https://commission-tracker-api.herokuapp.com/api/auth/callback
  https://commission-tracker-xxxxx.vercel.app/api/auth/callback
```

---

## STEP-BY-STEP WALKTHROUGH

### 1. Go to Zoho API Console
Open: https://api-console.zoho.com

### 2. Click "Add Client"

### 3. Select "Web-based Application"

### 4. Fill in the form:

**Application Name:**
```
Cluster Commission Tracker
```
(Just hit Tab to move to next field)

**Homepage URL:**
```
http://localhost:3000
```
(This is optional - you can change it later. We'll update it when you deploy.)

**Authorized Redirect URIs:**
```
http://localhost:5000/api/auth/callback
```
(Click "Add" or just press Enter)

### 5. Click "CREATE"

### 6. You'll see your credentials:
- **Client ID** ← Copy this
- **Client Secret** ← Copy this (KEEP SECRET!)

### 7. Also get your Organization ID:
1. Go to https://www.zoho.com/books/
2. Settings → Organization Details
3. Copy Organization ID

---

## WHAT THESE FIELDS DO

### Application Name
- Just a display name
- Zoho uses this to identify your app
- You can change it anytime

### Homepage URL
- Where users see your app normally
- Optional (Zoho doesn't strictly require it)
- You can change it anytime
- Put your Vercel URL here (but you can do this later)

### Authorized Redirect URIs
- **CRITICAL!** This must be exact
- This is where Zoho sends users AFTER login
- Must include `/api/auth/callback` at the end
- You need to add more URIs after you deploy

---

## AFTER YOU DEPLOY

Once you have your Vercel and Heroku URLs, go back and edit the app:

1. Go to: https://api-console.zoho.com
2. Find your app, click "Edit"
3. Update "Homepage URL" to your Vercel URL
4. Add both production Redirect URIs:
   ```
   https://commission-tracker-api.herokuapp.com/api/auth/callback
   https://commission-tracker-xxxxx.vercel.app/api/auth/callback
   ```
5. Click "Save"

---

## COMMON QUESTIONS

### Q: Does Homepage URL have to be exactly right?
**A:** No, it's optional. It's just informational. Put anything or leave blank.

### Q: Can I change these settings later?
**A:** Yes! You can edit the app anytime at https://api-console.zoho.com

### Q: What if I mess up the Redirect URI?
**A:** You'll get a "redirect_uri mismatch" error. Just go back and fix it - edit the app, update the URI, save.

### Q: Do I need both localhost and production URIs?
**A:** Yes! Keep localhost for testing, add production ones after you deploy.

### Q: What if my Vercel URL changes?
**A:** Update it in the Zoho app settings.

---

## QUICK REFERENCE

**Just Starting Out?**
```
Application Name: Cluster Commission Tracker
Homepage URL: http://localhost:3000
Authorized Redirect URIs: http://localhost:5000/api/auth/callback
```

**After Deployment?**
```
Application Name: Cluster Commission Tracker
Homepage URL: https://commission-tracker-xxxxx.vercel.app
Authorized Redirect URIs:
  http://localhost:5000/api/auth/callback
  https://commission-tracker-api.herokuapp.com/api/auth/callback
  https://commission-tracker-xxxxx.vercel.app/api/auth/callback
```

---

## YOUR ZOHO CREDENTIALS CHECKLIST

After creating the app, you should have:

```
☐ Client ID: ________________________
☐ Client Secret: ________________________
☐ Organization ID: ________________________
☐ Accounts URL: https://accounts.zoho.com (or your region)
☐ API URL: https://www.zohoapis.com (or your region)
☐ Region: USA / EU / India / etc
```

**Save these somewhere safe! You'll need them for deployment.**

---

## WHAT YOUR DEPLOYMENT WILL USE

The backend (`server.js`) uses:
- **Client ID** - To identify your app to Zoho
- **Client Secret** - To authenticate your app (KEEP SECRET!)
- **Organization ID** - To know which Zoho Books org to read from
- **Accounts URL** - To send users to login (depends on your region)
- **Redirect URI** - To know where to send users after login

---

## NEXT STEPS

1. ✅ Create the Zoho app (you're doing this now)
2. ✅ Copy Client ID, Client Secret, Org ID
3. ⏭️ Deploy your backend to Heroku (next step)
4. ⏭️ Deploy your frontend to Vercel (after backend)
5. ⏭️ Update Zoho Redirect URIs with production URLs
6. ⏭️ Test everything

---

**Still stuck?** The key fields are:
- **Application Name**: Can be anything (I suggested "Cluster Commission Tracker")
- **Homepage URL**: Put `http://localhost:3000` (you can change this later!)
- **Authorized Redirect URI**: Put `http://localhost:5000/api/auth/callback` (you'll add more later!)

Click CREATE and you're done! Then copy your Client ID and Client Secret.

---

**Good luck! You're almost there!** 🚀
