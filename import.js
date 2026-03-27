'use strict';

/**
 * import.js — Standalone HelloFresh URL importer
 *
 * 1. Put one HelloFresh recipe URL per line in urls.txt
 * 2. Run: node import.js
 * 3. Recipe JSONs (with all images as base64) saved to detail-cache/
 *
 * No server needed. Fetches HF token automatically.
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const DETAIL_DIR  = path.join(__dirname, 'detail-cache');
const URLS_FILE   = path.join(__dirname, 'urls.txt');
const API_BASE    = 'https://gw.hellofresh.com/api';
const IMG_BASE    = 'https://img.hellofresh.com/hellofresh_s3/image/upload';
const DELAY_MS    = 1500;   // between requests — be polite

// ── HTTP helper ───────────────────────────────────────────────────
function hfetch(targetUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const opts = {
      hostname: u.hostname,
      path:     u.pathname + u.search,
      headers: {
        'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        ...headers,
      },
    };
    const req = https.get(opts, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        const loc = res.headers.location.startsWith('http')
          ? res.headers.location
          : `https://${u.hostname}${res.headers.location}`;
        return hfetch(loc, headers).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status:      res.statusCode,
        contentType: res.headers['content-type'] || '',
        buffer:      Buffer.concat(chunks),
        text()      { return this.buffer.toString('utf8'); },
        json()      { return JSON.parse(this.text()); },
      }));
    });
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Token ─────────────────────────────────────────────────────────
let _token = null;
async function getToken() {
  if (_token) return _token;
  process.stdout.write('Fetching HelloFresh token…');
  const res  = await hfetch('https://www.hellofresh.com');
  const m    = res.text().match(/"access_token":"([^"]+)"/);
  if (!m) throw new Error('Could not extract access token from hellofresh.com');
  _token = m[1];
  process.stdout.write(' done.\n');
  return _token;
}

// ── Image → base64 ────────────────────────────────────────────────
async function toB64(imagePath, width = 800) {
  if (!imagePath) return '';
  const url = `${IMG_BASE}/f_auto,fl_lossy,q_auto,w_${width}/${imagePath}`;
  try {
    const r    = await hfetch(url);
    const mime = r.contentType.split(';')[0] || 'image/jpeg';
    return `data:${mime};base64,${r.buffer.toString('base64')}`;
  } catch { return ''; }
}

// ── Normalise ─────────────────────────────────────────────────────
function parseDuration(iso) {
  if (!iso) return '';
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return '';
  const h = parseInt(m[1]||0), min = parseInt(m[2]||0);
  return h > 0 ? `${h}h ${min}m` : `${min} min`;
}

function diffLabel(d) {
  if (!d) return 'Easy';
  if (typeof d === 'string') return d.charAt(0).toUpperCase() + d.slice(1);
  return ({0:'Easy',1:'Easy',2:'Medium',3:'Hard'})[d] || 'Easy';
}

function normDetail(r) {
  const cuisine =
    (r.cuisines && r.cuisines[0] && r.cuisines[0].name) ||
    (r.tags && (r.tags.find(t => t.type === 'cuisine')||{}).name) ||
    'World';

  return {
    id:         r.id,
    name:       r.name,
    headline:   r.headline    || '',
    image:      '',           // filled below
    cuisine,
    difficulty: diffLabel(r.difficulty),
    totalTime:  parseDuration(r.totalTime),
    prepTime:   parseDuration(r.prepTime),
    servings:   r.servingSize || 2,
    rating:     r.averageRating ? r.averageRating.toFixed(1) : null,
    tags:       (r.tags||[]).map(t => t.name).slice(0,6),
    ingredients: (r.ingredients||[]).map(ing => ({
      id:     ing.id,
      name:   ing.name,
      amount: ing.amount || '',
      unit:   (ing.unit && (ing.unit.name || ing.unit)) || '',
      imagePath: ing.imagePath || '',
      image:  '',  // filled below
    })),
    steps: (r.steps||[]).map((s, i) => ({
      index:        s.index || i + 1,
      instructions: s.instructions || '',
      imagePath:    (s.images && s.images[0]) ? s.images[0].path : '',
      image:        '',  // filled below
    })),
    nutrition: (r.nutrition||[]).map(n => ({
      name:   n.name || n.type || '',
      amount: Math.round(n.amount||0),
      unit:   n.unit || '',
    })),
    _imagePath: r.imagePath || '',
  };
}

// ── Extract ID from HF URL ────────────────────────────────────────
// HF URLs look like: /recipes/some-name-slug-5f3a2b1c9df18165854cdd72
// The API wants just the 24-char hex MongoDB ObjectID at the end.
function idFromUrl(rawUrl) {
  try {
    const u    = new URL(rawUrl.trim());
    const slug = u.pathname.split('/').filter(Boolean).pop() || '';
    // Try to pull out a 24-char hex ID at the end of the slug
    const m = slug.match(/([a-f0-9]{24})$/i);
    return m ? m[1] : slug;  // fall back to full slug if no hex ID found
  } catch { return ''; }
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(DETAIL_DIR)) fs.mkdirSync(DETAIL_DIR);
  if (!fs.existsSync(URLS_FILE)) {
    console.error(`urls.txt not found — create it with one HelloFresh URL per line`);
    process.exit(1);
  }

  const urls = fs.readFileSync(URLS_FILE, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));

  if (urls.length === 0) {
    console.log('urls.txt is empty — add some HelloFresh recipe URLs and rerun.');
    return;
  }

  console.log(`Found ${urls.length} URL(s) to import.\n`);
  const token = await getToken();

  let ok = 0, skip = 0, fail = 0;

  for (let i = 0; i < urls.length; i++) {
    const rawUrl = urls[i];
    const id = idFromUrl(rawUrl);
    if (!id) { console.log(`  [${i+1}] SKIP — bad URL: ${rawUrl}`); skip++; continue; }

    const outFile = path.join(DETAIL_DIR, `${id}.json`);
    if (fs.existsSync(outFile)) {
      console.log(`  [${i+1}] SKIP — already cached: ${id}`);
      skip++;
      continue;
    }

    process.stdout.write(`  [${i+1}/${urls.length}] ${id}\n`);

    try {
      await sleep(DELAY_MS);
      const apiRes = await hfetch(
        `${API_BASE}/recipes/${id}?country=US&locale=en-US`,
        { Authorization: `Bearer ${token}` },
      );

      if (apiRes.status !== 200) {
        console.log(`    FAIL — API returned ${apiRes.status}`);
        fail++;
        continue;
      }

      const recipe = normDetail(apiRes.json());

      // Hero image
      process.stdout.write(`    hero image…`);
      await sleep(DELAY_MS);
      recipe.image = await toB64(recipe._imagePath, 800);
      delete recipe._imagePath;
      process.stdout.write(` done\n`);

      // Ingredient images
      for (const ing of recipe.ingredients) {
        if (!ing.imagePath) { delete ing.imagePath; continue; }
        await sleep(600);
        ing.image = await toB64(ing.imagePath, 200);
        delete ing.imagePath;
      }
      process.stdout.write(`    ${recipe.ingredients.length} ingredient images done\n`);

      // Step images
      for (const step of recipe.steps) {
        if (!step.imagePath) { delete step.imagePath; continue; }
        process.stdout.write(`    step ${step.index} image…`);
        await sleep(DELAY_MS);
        step.image = await toB64(step.imagePath, 700);
        delete step.imagePath;
        process.stdout.write(` done\n`);
      }

      fs.writeFileSync(outFile, JSON.stringify(recipe));
      console.log(`    Saved: ${recipe.name}`);
      ok++;

    } catch (err) {
      console.log(`    FAIL — ${err.message}`);
      fail++;
    }
  }

  console.log(`\nDone. Saved: ${ok}  Skipped: ${skip}  Failed: ${fail}`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
