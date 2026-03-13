# Deploy Special Orders Pro to Railway — Detailed Guide

Follow these steps in order. Do not skip steps.

---

## Before You Start

You need:
- Your project code in a **GitHub repository**
- A **Railway account** (free at [railway.app](https://railway.app))
- **Shopify CLI** installed and logged in (`shopify auth login` if needed)
- **Terminal** open in your project folder: `special-orders-pro`

---

## Part 1: Push Your Code to GitHub

### 1.1 Open Terminal in your project folder

```bash
cd /Users/masonkharufa/shopify-apps/special-orders-pro
```

### 1.2 Check if you have a GitHub remote

```bash
git remote -v
```

- If you see `origin` pointing to a GitHub URL → you're good, go to 1.4
- If you see nothing or an error → you need to create a repo first

### 1.3 Create a GitHub repo (if you don't have one)

1. Go to [github.com/new](https://github.com/new)
2. Repository name: `special-orders-pro`
3. Leave it **empty** (no README, no .gitignore)
4. Click **Create repository**
5. Copy the repo URL (e.g. `https://github.com/yourusername/special-orders-pro.git`)
6. In terminal, run:

```bash
git remote add origin https://github.com/YOUR_USERNAME/special-orders-pro.git
```

Replace `YOUR_USERNAME` with your GitHub username.

### 1.4 Push your code

```bash
git add .
git status
```

You should see your files listed. Then:

```bash
git commit -m "Configure for Railway deployment"
git branch -M main
git push -u origin main
```

If it asks for GitHub credentials, use a Personal Access Token (Settings → Developer settings → Personal access tokens).

---

## Part 2: Create Project on Railway

### 2.1 Go to Railway

1. Open [railway.app](https://railway.app) in your browser
2. Click **Login** (top right)
3. Sign in with **GitHub** (recommended)

### 2.2 Create a new project

1. Click **New Project** (or the **+** button)
2. Select **Deploy from GitHub repo**
3. If prompted, click **Configure GitHub App** and authorize Railway to access your repos
4. In the list, find **special-orders-pro** and click it
5. Click **Deploy Now**

Railway will start building. You'll see a build log. **Wait for the build to finish** (can take 2–5 minutes).

### 2.3 Check the build result

- **Build succeeded** → You'll see a green checkmark. Go to Part 3.
- **Build failed** → Click the failed build and look at the error. Common issues:
  - Missing `DATABASE_URL` → Add PostgreSQL first (Part 3).
  - npm errors → Check logs for the exact error.

---

## Part 3: Add PostgreSQL Database

### 3.1 Add the database

1. On your Railway project dashboard, click **+ New** (top right)
2. Click **Database**
3. Click **PostgreSQL**

A new PostgreSQL service will appear. Railway will automatically:
- Create a Postgres database
- Link it to your app service
- Set `DATABASE_URL` on your app

### 3.2 Verify the link

1. Click your **web service** (the one with your app name, not "PostgreSQL")
2. Click the **Variables** tab
3. You should see `DATABASE_URL` with a value like `postgresql://postgres:xxx@xxx.railway.app:5432/railway`

If you don't see `DATABASE_URL`, click **+ New Variable** → **Add Reference** → select the PostgreSQL variable `DATABASE_URL`.

---

## Part 4: Generate a Public URL

### 4.1 Generate domain

1. Click your **web service** (the app, not the database)
2. Click the **Settings** tab (gear icon)
3. Scroll to **Networking**
4. Under **Public Networking**, click **Generate Domain**

Railway will create a URL like:
- `special-orders-pro-production.up.railway.app`
- or `special-orders-pro-production-xxxx.up.railway.app`

### 4.2 Copy the URL

1. Copy the full URL (including `https://`)
2. Example: `https://special-orders-pro-production.up.railway.app`
3. **Save it somewhere** — you'll need it in the next steps

---

## Part 5: Get Shopify Environment Variables

### 5.1 Open terminal in your project

```bash
cd /Users/masonkharufa/shopify-apps/special-orders-pro
```

### 5.2 Run the Shopify env command

```bash
shopify app env show
```

### 5.3 Copy the output

You'll see something like:

```
SHOPIFY_API_KEY=7449d0eb28cab43135c401964353eef4
SHOPIFY_API_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
SCOPES=write_products,write_metaobject_definitions,write_metaobjects,read_orders,read_draft_orders,read_customers,write_draft_orders,write_orders
```

**Copy each value** — you'll paste them into Railway in the next step.

---

## Part 6: Add All Environment Variables to Railway

### 6.1 Open Variables

1. In Railway, click your **web service**
2. Click the **Variables** tab

### 6.2 Add each variable

Click **+ New Variable** and add these **one by one**:

| Variable Name | Value |
|---------------|-------|
| `SHOPIFY_API_KEY` | Paste the value from `shopify app env show` |
| `SHOPIFY_API_SECRET` | Paste the value from `shopify app env show` |
| `SCOPES` | Paste the value from `shopify app env show` |
| `SHOPIFY_APP_URL` | Your Railway URL (e.g. `https://special-orders-pro-production.up.railway.app`) |

**Important:**

- For `SHOPIFY_APP_URL`, use the full URL you copied in Part 4
- Include `https://` in the URL
- No trailing slash

### 6.3 Save and redeploy

After adding variables, Railway may auto-redeploy. If not, click **Deploy** → **Redeploy** (or push a new commit to trigger a deploy).

---

## Part 7: Update shopify.app.toml

### 7.1 Open the file

Open `shopify.app.toml` in your project (in Cursor or any editor).

### 7.2 Replace the URLs

Find these lines and replace `example.com` with your Railway domain in **all** of them:

**Before:**
```toml
application_url = "https://example.com"

[auth]
redirect_urls = [
  "https://example.com/auth/callback",
  "https://example.com/auth/shopify/callback",
  "https://example.com/api/auth/callback"
]
```

**After** (example with `special-orders-pro-production.up.railway.app`):
```toml
application_url = "https://special-orders-pro-production.up.railway.app"

[auth]
redirect_urls = [
  "https://special-orders-pro-production.up.railway.app/auth/callback",
  "https://special-orders-pro-production.up.railway.app/auth/shopify/callback",
  "https://special-orders-pro-production.up.railway.app/api/auth/callback"
]
```

### 7.3 Save the file

Save `shopify.app.toml` with your Railway domain in all 4 places.

---

## Part 8: Deploy Config to Shopify

### 8.1 Open terminal

```bash
cd /Users/masonkharufa/shopify-apps/special-orders-pro
```

### 8.2 Run deploy

```bash
shopify app deploy --allow-updates
```

### 8.3 Confirm

- If prompted, confirm the deployment
- Wait for the command to finish
- You should see: `New version released to users`

### 8.4 Push your config changes

```bash
git add shopify.app.toml
git commit -m "Update app URLs for production"
git push
```

Railway will auto-redeploy when it detects the push.

---

## Part 9: Install the App on Your Store

### 9.1 Uninstall the old version (if installed)

1. In your Shopify admin, go to **Settings** → **Apps and sales channels**
2. Find **Special Orders Pro**
3. Click **Uninstall** (if it shows "Example Domain")

### 9.2 Get the install link

1. Go to [partners.shopify.com](https://partners.shopify.com)
2. Click **Apps** in the left sidebar
3. Click **Special Orders Pro**
4. Click **App setup** (or **Distribution**)
5. Under **Installation**, find **Install link** or **Development store**
6. Copy the install link or click **Select store** to install on a development store

### 9.3 Install the app

1. Open the install link (or select your store)
2. Click **Install app** when prompted
3. Approve the permissions
4. The app should load from your Railway URL

### 9.4 Verify

- The app should open in the Shopify admin
- The URL bar should show your Railway domain (e.g. `special-orders-pro-production.up.railway.app`)
- You should see the Special Orders Pro home page

---

## Checklist: Did You Do Everything?

- [ ] Pushed code to GitHub
- [ ] Created Railway project from GitHub repo
- [ ] Added PostgreSQL database
- [ ] Generated a public domain
- [ ] Added SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SCOPES, SHOPIFY_APP_URL
- [ ] Updated shopify.app.toml with your Railway URL (4 places)
- [ ] Ran `shopify app deploy --allow-updates`
- [ ] Pushed shopify.app.toml changes to GitHub
- [ ] Uninstalled old app (if any)
- [ ] Installed app from Partner Dashboard

---

## Troubleshooting

### "Example Domain" still shows

- `shopify.app.toml` still has the wrong URL. Replace **every** `example.com` with your Railway domain.
- Run `shopify app deploy --allow-updates` again.
- Uninstall and reinstall the app.

### Build fails on Railway

- Check that you added the PostgreSQL database.
- Check that `DATABASE_URL` appears in Variables.
- Look at the build logs for the exact error.

### "Redirect URI mismatch" or OAuth error

- `redirect_urls` in `shopify.app.toml` must exactly match your Railway URL.
- Use `https://` (not `http://`).
- No trailing slash.
- Run `shopify app deploy --allow-updates` after updating.

### App loads but shows errors

- Check Railway logs: click your service → **Deployments** → select latest → **View Logs**.
- Ensure all 4 env vars are set (SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SCOPES, SHOPIFY_APP_URL).

---

## Need Help?

- Railway docs: [docs.railway.app](https://docs.railway.app)
- Shopify app deployment: [shopify.dev/docs/apps/launch/deployment](https://shopify.dev/docs/apps/launch/deployment)
