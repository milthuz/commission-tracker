# 🪟 WINDOWS - HEROKU INSTALLATION & DEPLOYMENT GUIDE

Complete step-by-step guide for Windows users to deploy the backend to Heroku.

---

## ✅ WHAT YOU NEED FIRST (Windows Prerequisites)

Before installing Heroku, make sure you have:

- [ ] **Git** - Download from: https://git-scm.com/download/win
- [ ] **Node.js** - Download from: https://nodejs.org/ (LTS version)
- [ ] **Heroku CLI** - We'll install this below
- [ ] **Heroku Account** - Sign up at: https://www.heroku.com/
- [ ] **Your code** - Ready to deploy

---

## 📥 STEP 1: INSTALL HEROKU CLI ON WINDOWS

### Option A: Download Installer (Easiest)

1. Go to: https://devcenter.heroku.com/articles/heroku-cli
2. Click **"Windows"** download link
3. Download the `.exe` file (looks like: `heroku-x64.exe`)
4. Double-click to run the installer
5. Click through the installation (just keep clicking "Next")
6. When asked "Add to PATH", **KEEP THIS CHECKED** ✅
7. Click "Install"
8. Wait for installation to complete (might take 1-2 minutes)
9. Click "Finish"

### Option B: Using Chocolatey (If you have it)

If you have Chocolatey installed:

```bash
choco install heroku-cli
```

---

## 🔍 STEP 2: VERIFY HEROKU IS INSTALLED

Open **Command Prompt** or **PowerShell**:

1. Press `Windows Key + R`
2. Type `cmd` and press Enter
3. In the black window, type:
   ```
   heroku --version
   ```
4. You should see something like: `heroku/7.x.x`

If you get "command not found" error:
- Close and reopen Command Prompt
- Make sure installation completed
- Try restarting your computer

---

## 🔑 STEP 3: LOGIN TO HEROKU

In Command Prompt or PowerShell, type:

```bash
heroku login
```

This will:
1. Open your browser
2. Take you to Heroku login page
3. Ask for your email and password
4. Show "Authorization Successful"
5. Come back to Command Prompt and it's done ✅

---

## 📁 STEP 4: NAVIGATE TO YOUR PROJECT

In Command Prompt, navigate to where your code is:

```bash
# Example: If your code is on Desktop
cd Desktop\commission-tracker

# Or if it's in Documents
cd Documents\commission-tracker

# Or if it's in C:\Users\YourName\Projects
cd C:\Users\YourName\Projects\commission-tracker
```

**Verify you're in the right place:**
- You should see `server.js` in the folder
- Type `dir` to see the files
- You should see: `server.js`, `package.json`, etc.

---

## 🚀 STEP 5: CREATE HEROKU APP

Still in Command Prompt, type:

```bash
heroku create commission-tracker-api
```

**Copy this URL that appears:**
```
https://commission-tracker-api.herokuapp.com
```

(Your backend will be at this URL after deployment)

---

## 🔐 STEP 6: SET YOUR ZOHO CREDENTIALS

Replace the XXX values with YOUR actual credentials from Zoho:

```bash
heroku config:set ZOHO_CLIENT_ID="XXX_YOUR_CLIENT_ID"
heroku config:set ZOHO_CLIENT_SECRET="XXX_YOUR_CLIENT_SECRET"
heroku config:set ZOHO_ORG_ID="XXX_YOUR_ORG_ID"
heroku config:set ZOHO_ACCOUNTS_URL="https://accounts.zoho.com"
heroku config:set ZOHO_API_URL="https://www.zohoapis.com"
heroku config:set JWT_SECRET="$(openssl rand -base64 32)"
heroku config:set NODE_ENV="production"
```

**Note:** If the `$(openssl rand -base64 32)` command doesn't work on Windows, use this instead:

```bash
heroku config:set JWT_SECRET="your-secret-key-here-make-it-long-and-random"
```

(Just type a random long string for the JWT_SECRET)

---

## 📄 STEP 7: CREATE PROCFILE

In your project folder, create a new file called `Procfile` (no extension!).

**How to create it on Windows:**

### Method 1: Using Notepad
1. Right-click in your project folder
2. Click "New" → "Text Document"
3. Name it `Procfile` (delete the `.txt` extension)
4. Right-click → "Open with" → Notepad
5. Type exactly:
   ```
   web: node server.js
   ```
6. Save (Ctrl+S)
7. Close

### Method 2: Using Command Prompt
In Command Prompt (in your project folder), type:

```bash
echo web: node server.js > Procfile
```

This creates the file automatically.

**Verify it was created:**
```bash
type Procfile
```

Should display:
```
web: node server.js
```

---

## 📤 STEP 8: DEPLOY TO HEROKU

Still in Command Prompt, in your project folder:

```bash
# Add the Procfile to git
git add Procfile

# Commit it
git commit -m "Add Procfile for Heroku"

# Push to Heroku (this deploys your code)
git push heroku main
```

**Note:** If your branch is called `master` instead of `main`, use:
```bash
git push heroku master
```

**Wait for deployment to finish** - you'll see lots of text scrolling. Look for:
- "Building..."
- "Running migrations..."
- "Deployed to Heroku"

This takes 1-3 minutes.

---

## 📊 STEP 9: CHECK IF IT WORKED

### View the Logs

```bash
heroku logs --tail -a commission-tracker-api
```

You should see lines like:
```
2025-10-27T12:34:56.000000+00:00 app[web.1]: listening on port 3000
```

Press `Ctrl+C` to stop viewing logs.

### Test Your Backend

Open Command Prompt and type:

```bash
curl https://commission-tracker-api.herokuapp.com/api/health
```

You should get back:
```json
{"status":"ok","timestamp":"2025-10-27T..."}
```

**If curl doesn't work**, open this URL in your browser instead:
```
https://commission-tracker-api.herokuapp.com/api/health
```

You should see the JSON response.

---

## ✅ YOUR BACKEND IS NOW LIVE! 🎉

Your backend API is running at:
```
https://commission-tracker-api.herokuapp.com
```

---

## 🔧 USEFUL WINDOWS COMMANDS

Save these for later:

```bash
# View your app details
heroku apps:info -a commission-tracker-api

# View your environment variables
heroku config -a commission-tracker-api

# View logs
heroku logs --tail -a commission-tracker-api

# Redeploy (if you make changes)
git push heroku main

# Open your app in browser
heroku open -a commission-tracker-api

# Restart your app
heroku restart -a commission-tracker-api

# Stop viewing logs
# Press Ctrl+C
```

---

## 🆘 TROUBLESHOOTING FOR WINDOWS

### Problem: "heroku command not found"
**Solution:**
1. Restart your computer
2. Re-open Command Prompt
3. If still doesn't work, reinstall Heroku from: https://devcenter.heroku.com/articles/heroku-cli

### Problem: "Permission denied" when creating Procfile
**Solution:**
Use the Command Prompt method:
```bash
echo web: node server.js > Procfile
```

### Problem: "git: command not found"
**Solution:**
Install Git from: https://git-scm.com/download/win

### Problem: "Deployment failed"
**Solution:**
1. Check the logs:
   ```bash
   heroku logs --tail -a commission-tracker-api
   ```
2. Look for the error message
3. Common issues:
   - Missing dependencies: Run `npm install` locally first
   - Wrong node version: Check package.json
   - Port issues: Make sure code uses PORT env variable

### Problem: "Procfile not found" error during deploy
**Solution:**
Make sure the Procfile exists:
```bash
dir
```
Should show `Procfile` in the list

### Problem: App crashes after deployment
**Solution:**
Check logs for errors:
```bash
heroku logs --tail -a commission-tracker-api
```

---

## 📋 WINDOWS DEPLOYMENT CHECKLIST

- [ ] Git installed and working
- [ ] Node.js installed and working
- [ ] Heroku CLI installed
- [ ] Heroku account created and logged in
- [ ] Code is in a folder
- [ ] Git is initialized in that folder (`git init`)
- [ ] Code is committed to git
- [ ] Heroku app created (`commission-tracker-api`)
- [ ] Environment variables set
- [ ] Procfile created with `web: node server.js`
- [ ] Procfile added to git and committed
- [ ] Code pushed to Heroku (`git push heroku main`)
- [ ] Backend is running (`curl https://commission-tracker-api.herokuapp.com/api/health`)

---

## 📱 NEXT STEPS

Once your backend is running:

1. ✅ Backend is deployed
2. ⏭️ Deploy frontend to Vercel (see COPY-PASTE-DEPLOYMENT.md)
3. ⏭️ Connect them together
4. ⏭️ Update Zoho OAuth settings
5. ⏭️ Test everything

---

## 💡 WINDOWS COMMAND PROMPT TIPS

- **Copy**: Right-click and select "Paste" (Ctrl+V doesn't work in older versions)
- **Go back to home folder**: Type `cd %userprofile%`
- **List files**: Type `dir`
- **Create folder**: Type `mkdir foldername`
- **Go to a folder**: Type `cd foldername`
- **Go up one level**: Type `cd ..`
- **Clear screen**: Type `cls`

---

## 🎯 QUICK WINDOWS DEPLOYMENT SUMMARY

```bash
# 1. Install Heroku CLI from https://devcenter.heroku.com/articles/heroku-cli

# 2. Open Command Prompt and navigate to your project
cd path\to\your\commission-tracker

# 3. Login to Heroku
heroku login

# 4. Create app
heroku create commission-tracker-api

# 5. Set environment variables (replace XXX with your values)
heroku config:set ZOHO_CLIENT_ID="XXX" ZOHO_CLIENT_SECRET="XXX" ZOHO_ORG_ID="XXX" ZOHO_ACCOUNTS_URL="https://accounts.zoho.com" ZOHO_API_URL="https://www.zohoapis.com" JWT_SECRET="random-secret-key" NODE_ENV="production"

# 6. Create Procfile
echo web: node server.js > Procfile

# 7. Deploy
git add Procfile
git commit -m "Add Procfile"
git push heroku main

# 8. Check logs
heroku logs --tail

# 9. Test
curl https://commission-tracker-api.herokuapp.com/api/health
```

---

**Done! Your backend is now live on Heroku!** 🚀

---

**Questions?** See:
- [COPY-PASTE-DEPLOYMENT.md](computer:///mnt/user-data/outputs/COPY-PASTE-DEPLOYMENT.md) for the full deployment guide
- [DEPLOYMENT-ZOHO-GUIDE.md](computer:///mnt/user-data/outputs/DEPLOYMENT-ZOHO-GUIDE.md) for detailed reference

**Ready for the next step?** Deploy your frontend to Vercel!
