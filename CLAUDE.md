# Meal Preper

Node.js web app — personal cookbook with HelloFresh recipes.

## Run locally
```bash
node server.js
# Opens on http://localhost:3456
```
Or double-click `start.command`.

## Live
**https://meal-preper-319921040061.us-central1.run.app** — Google Cloud Run, project `319921040061`.

## Deploy
```bash
gcloud run deploy meal-preper --source . --region us-central1 --allow-unauthenticated
```

## Key decisions
- Default port is 3456 (not 3000 or 8080) — important for app-launcher config
- `chrome-extension/` subfolder is a scraper for pulling recipes from HelloFresh
- `detail-cache/` stores cached recipe detail pages
