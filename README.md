# Meal Preper

A personal cookbook web app populated with HelloFresh recipes. Browse recipes, view ingredients, and plan your meals.

---

## Requirements

- Node.js 18+

---

## Install

```bash
git clone https://github.com/kakax114/meal-preper.git
cd meal-preper
npm install
```

---

## Run

```bash
npm start
```

Then open **http://localhost:3000** (or whichever port the server logs).

Or double-click **`start.command`** in Finder.

---

## Files

| File | Purpose |
|---|---|
| `server.js` | Express server |
| `index.html` | Frontend |
| `recipe-index.json` | Recipe metadata index |
| `db.json` | Recipe data |
| `chrome-extension/` | Browser extension for scraping HelloFresh recipe pages |

---

## Scraping new recipes

Use the Chrome extension in `chrome-extension/` to scrape recipe data directly from HelloFresh.

---

## Live

**https://meal-preper-319921040061.us-central1.run.app**

---

## Deploy to Google Cloud Run

The app is hosted on Google Cloud Run. To deploy a new version:

```bash
gcloud run deploy meal-preper \
  --source . \
  --region us-central1 \
  --project 319921040061 \
  --allow-unauthenticated
```

### First-time setup

```bash
# Authenticate
gcloud auth login

# Set your project
gcloud config set project 319921040061

# Enable required APIs
gcloud services enable run.googleapis.com cloudbuild.googleapis.com

# Deploy
gcloud run deploy meal-preper \
  --source . \
  --region us-central1 \
  --allow-unauthenticated
```

### Docker (local test before deploying)

```bash
docker build -t meal-preper .
docker run -p 8080:8080 meal-preper
```
