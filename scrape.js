'use strict';

/**
 * scrape.js — standalone URL-list-driven HelloFresh recipe scraper
 *
 * Usage:
 *   node scrape.js [url-list-file]
 *
 * Default file: hellofresh-recipe-urls-1774641958967.txt
 * Expects one full HelloFresh recipe URL per line, e.g.:
 *   https://www.hellofresh.com/recipes/pecan-crusted-chicken-6203c3d357b8e37e4638262a
 *
 * No other process needed — runs standalone.
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── Config ──────────────────────────────────────────────────────
const API_BASE   = 'https://gw.hellofresh.com/api';
const IMG_BASE   = 'https://img.hellofresh.com/hellofresh_s3/image/upload';
const FETCH_DELAY = 1500;  // ms between recipe fetches
const IMG_DELAY   = 700;   // ms between image downloads
const DETAIL_DIR  = path.join(__dirname, 'detail-cache');
const ERROR_LOG   = path.join(__dirname, 'scrape-errors.log');

// ── ANSI colours ─────────────────────────────────────────────────
const C = {
  reset  : '\x1b[0m',
  bold   : '\x1b[1m',
  dim    : '\x1b[2m',
  green  : '\x1b[32m',
  red    : '\x1b[31m',
  yellow : '\x1b[33m',
  cyan   : '\x1b[36m',
};

// ── Helpers ───────────────────────────────────────────────────────
function fmt(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function col(str, len) {
  str = String(str || '');
  return str.length > len ? str.slice(0, len - 1) + '…' : str.padEnd(len, ' ');
}

function extractId(url) {
  const m = url.match(/([a-f0-9]{24})(?:[/?#].*)?$/i);
  return m ? m[1] : null;
}

function errMsg(err) {
  if (!err) return 'unknown error';
  if (err.errors && err.errors.length > 0) {
    const sub = err.errors[0];
    return sub.message || sub.code || String(sub);
  }
  return err.message || err.code || String(err);
}

// ── HTTPS fetch (follows one redirect) ───────────────────────────
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
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const loc = res.headers.location.startsWith('http')
          ? res.headers.location
          : `https://${u.hostname}${res.headers.location}`;
        return hfetch(loc, headers).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status:      res.statusCode,
        contentType: res.headers['content-type'] || 'application/octet-stream',
        buffer:      Buffer.concat(chunks),
        text()  { return this.buffer.toString('utf8'); },
        json()  { return JSON.parse(this.text()); },
      }));
    });
    req.setTimeout(30_000, () => { req.destroy(); reject(new Error('timeout after 30s')); });
    req.on('error', err => reject(new Error(errMsg(err))));
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Bearer token ─────────────────────────────────────────────────
let _token = null;
let _tokenExpiry = 0;

async function getToken() {
  if (_token && Date.now() < _tokenExpiry) return _token;
  process.stdout.write(`  Fetching HF token… `);
  const res  = await hfetch('https://www.hellofresh.com');
  const html = res.text();
  const m    = html.match(/"access_token":"([^"]+)"/);
  if (!m) throw new Error('Could not extract HelloFresh access token from page HTML');
  _token       = m[1];
  _tokenExpiry = Date.now() + 45 * 60 * 1000;
  console.log(`${C.green}OK${C.reset}`);
  return _token;
}

// ── HF API ───────────────────────────────────────────────────────
function imgUrl(p, w = 600) {
  return p ? `${IMG_BASE}/f_auto,fl_lossy,q_auto,w_${w}/${p}` : '';
}

function diffLabel(d) {
  if (!d) return 'Easy';
  if (typeof d === 'string') return d.charAt(0).toUpperCase() + d.slice(1);
  return { 0: 'Easy', 1: 'Easy', 2: 'Medium', 3: 'Hard' }[d] || 'Easy';
}

function parseDuration(iso) {
  if (!iso) return '';
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return '';
  const h = parseInt(m[1] || 0), min = parseInt(m[2] || 0);
  return h > 0 ? `${h}h ${min}m` : `${min} min`;
}

function normDetail(r) {
  const cuisine =
    (r.cuisines?.[0]?.name) ||
    (r.tags?.find(t => t.type === 'cuisine')?.name) ||
    'World';

  return {
    id:          r.id,
    name:        r.name,
    headline:    r.headline    || '',
    image:       r.imagePath   ? imgUrl(r.imagePath, 800)  : (r.image || ''),
    imageThumb:  r.imagePath   ? imgUrl(r.imagePath, 400)  : (r.imageThumb || r.image || ''),
    cuisine,
    difficulty:  diffLabel(r.difficulty),
    totalTime:   parseDuration(r.totalTime),
    prepTime:    parseDuration(r.prepTime),
    servings:    r.servingSize || 2,
    rating:      r.averageRating ? r.averageRating.toFixed(1) : null,
    tags:        (r.tags || []).map(t => t.name).slice(0, 6),
    ingredients: (r.ingredients || []).map(ing => ({
      id:     ing.id,
      name:   ing.name,
      amount: ing.amount || '',
      unit:   (ing.unit && (ing.unit.name || ing.unit)) || '',
      image:  imgUrl(ing.imagePath, 200),
    })),
    steps: (r.steps || []).map((s, i) => ({
      index:        s.index || i + 1,
      instructions: s.instructions || '',
      image:        s.images?.[0] ? imgUrl(s.images[0].path, 700) : '',
    })),
    nutrition: (r.nutrition || []).map(n => ({
      name:   n.name || n.type || '',
      amount: Math.round(n.amount || 0),
      unit:   n.unit || '',
    })),
  };
}

async function fetchRecipe(id) {
  const token = await getToken();
  const res = await hfetch(
    `${API_BASE}/recipes/${id}?country=US&locale=en-US`,
    { Authorization: `Bearer ${token}` },
  );
  if (res.status === 401) {
    // Token expired mid-run — force refresh once
    _token = null;
    const token2 = await getToken();
    const res2 = await hfetch(
      `${API_BASE}/recipes/${id}?country=US&locale=en-US`,
      { Authorization: `Bearer ${token2}` },
    );
    if (res2.status !== 200) throw new Error(`HTTP ${res2.status}`);
    return normDetail(res2.json());
  }
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  return normDetail(res.json());
}

async function fetchImgB64(imageUrl) {
  if (!imageUrl || !imageUrl.startsWith('https://img.hellofresh.com')) return '';
  try {
    const res  = await hfetch(imageUrl);
    const mime = res.contentType.split(';')[0] || 'image/jpeg';
    return `data:${mime};base64,${res.buffer.toString('base64')}`;
  } catch {
    return '';
  }
}

// ── Spinner ───────────────────────────────────────────────────────
const SPINNER = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
let _spinnerTimer = null, _spinnerIdx = 0;

function startSpinner(prefix, label) {
  process.stdout.write('\r\x1b[K');
  _spinnerIdx = 0;
  _spinnerTimer = setInterval(() => {
    process.stdout.write(`\r${prefix} ${C.cyan}${SPINNER[_spinnerIdx++ % SPINNER.length]}${C.reset} ${C.dim}${label}${C.reset}`);
  }, 80);
}

function stopSpinner() {
  if (_spinnerTimer) { clearInterval(_spinnerTimer); _spinnerTimer = null; }
  process.stdout.write('\r\x1b[K');
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  // ── 1. Load URL file ────────────────────────────────────────────
  const urlFile     = process.argv[2] || 'hellofresh-recipe-urls-1774641958967.txt';
  const urlFilePath = path.resolve(urlFile);

  if (!fs.existsSync(urlFilePath)) {
    console.error(`${C.red}Error: URL file not found → ${urlFilePath}${C.reset}`);
    process.exit(1);
  }

  const allUrls = [...new Set(
    fs.readFileSync(urlFilePath, 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('https://www.hellofresh.com/recipes/')),
  )];

  // ── 2. Categorise ────────────────────────────────────────────────
  if (!fs.existsSync(DETAIL_DIR)) fs.mkdirSync(DETAIL_DIR, { recursive: true });

  const cachedIds = new Set(
    fs.readdirSync(DETAIL_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', '')),
  );

  const badUrls = [], toSkip = [], toFetch = [];
  for (const url of allUrls) {
    const id = extractId(url);
    if (!id)               { badUrls.push(url); continue; }
    if (cachedIds.has(id)) { toSkip.push({ url, id }); continue; }
    toFetch.push({ url, id });
  }

  // ── 3. Plan ──────────────────────────────────────────────────────
  const div = '─'.repeat(64);
  console.log(`\n${C.bold}  Recipe Scraper${C.reset}`);
  console.log(div);
  console.log(`  File    : ${urlFile}`);
  console.log(`  Total   : ${allUrls.length} unique URLs`);
  console.log(`  ${C.green}To fetch${C.reset} : ${toFetch.length}`);
  console.log(`  ${C.dim}Cached${C.reset}   : ${toSkip.length}  (already in detail-cache, will skip)`);
  if (badUrls.length)
    console.log(`  ${C.yellow}Bad URLs${C.reset} : ${badUrls.length}  (cannot extract recipe ID)`);
  console.log(div + '\n');

  if (badUrls.length) {
    console.log(`${C.yellow}⚠ Bad URLs (no recipe ID found):${C.reset}`);
    badUrls.forEach(u => console.log(`  ${C.dim}${u}${C.reset}`));
    console.log();
    fs.appendFileSync(ERROR_LOG, badUrls.map(u => `[BAD-URL] ${u}`).join('\n') + '\n');
  }

  if (toFetch.length === 0) {
    console.log(`${C.green}Nothing to do — all URLs already cached.${C.reset}\n`);
    return;
  }

  // ── 4. Warm up token ─────────────────────────────────────────────
  await getToken();

  // ── 5. Scrape loop ───────────────────────────────────────────────
  let saved = 0, failed = 0;
  const startTime  = Date.now();
  const indexWidth = String(toFetch.length).length;

  for (let i = 0; i < toFetch.length; i++) {
    const { url, id } = toFetch[i];
    const prefix = `[${String(i + 1).padStart(indexWidth)}/${toFetch.length}]`;

    // ── Fetch detail ─────────────────────────────────────────────
    startSpinner(prefix, `fetching ${id}`);
    await sleep(FETCH_DELAY);

    let detail;
    try {
      detail = await fetchRecipe(id);
    } catch (err) {
      const reason = errMsg(err);
      stopSpinner();
      console.log(`${prefix} ${C.red}✗ FAIL${C.reset}  ${C.dim}${id}${C.reset}`);
      console.log(`${''.padEnd(indexWidth * 2 + 5)}${C.red}└─ ${reason}${C.reset}`);
      failed++;
      fs.appendFileSync(ERROR_LOG, `[FAIL] ${id}\n       URL: ${url}\n       Reason: ${reason}\n\n`);
      continue;
    }

    const name = detail.name || id;

    // ── Download images ──────────────────────────────────────────
    let imgOk = 0, imgFail = 0;

    async function dlImg(imgSrc) {
      if (!imgSrc) return '';
      await sleep(IMG_DELAY);
      const b64 = await fetchImgB64(imgSrc);
      if (b64) { imgOk++; return b64; }
      imgFail++;
      return imgSrc; // keep URL if download fails
    }

    startSpinner(prefix, `images — ${name}`);
    detail.image = await dlImg(detail.image);
    for (const ing of (detail.ingredients || [])) ing.image = await dlImg(ing.image);
    for (const step of (detail.steps     || [])) step.image = await dlImg(step.image);

    // ── Save ─────────────────────────────────────────────────────
    stopSpinner();
    fs.writeFileSync(path.join(DETAIL_DIR, `${id}.json`), JSON.stringify(detail));
    cachedIds.add(id);
    saved++;

    const elapsed   = Date.now() - startTime;
    const remaining = toFetch.length - saved - failed;
    const eta       = saved > 2 && remaining > 0 ? ` ETA ~${fmt((elapsed / saved) * remaining)}` : '';
    const imgNote   = imgFail > 0 ? `${imgOk} imgs, ${C.yellow}${imgFail} failed${C.reset}` : `${imgOk} imgs`;

    console.log(`${prefix} ${C.green}✓${C.reset} ${col(name, 44)} ${C.dim}${imgNote}${eta}${C.reset}`);

    if (saved % 25 === 0) {
      console.log(`${C.dim}${'·'.repeat(64)}  ${saved} saved / ${failed} failed / ${remaining} left${C.reset}`);
    }
  }

  // ── 6. Summary ───────────────────────────────────────────────────
  const totalElapsed = Date.now() - startTime;
  const thick = '═'.repeat(64);
  console.log(`\n${thick}`);
  console.log(`  ${C.bold}Done${C.reset} — ${fmt(totalElapsed)}`);
  console.log(`  ${C.green}✓ Saved   :${C.reset}  ${saved}`);
  console.log(`  ${C.dim}○ Cached  :  ${toSkip.length}  (skipped — already existed)${C.reset}`);
  console.log(`  ${C.red}✗ Failed  :  ${failed}${C.reset}`);
  if (badUrls.length) console.log(`  ${C.yellow}⚠ Bad URLs:  ${badUrls.length}${C.reset}`);
  if (failed > 0 || badUrls.length > 0) console.log(`\n  Full error details → ${ERROR_LOG}`);
  console.log(`${thick}\n`);
}

main().catch(err => {
  console.error(`\n${C.red}Fatal: ${errMsg(err)}${C.reset}\n`);
  process.exit(1);
});
