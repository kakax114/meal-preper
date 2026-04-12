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
