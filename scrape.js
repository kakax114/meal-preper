'use strict';

/**
 * scrape.js — URL-list-driven HelloFresh recipe scraper
 *
 * Usage:
 *   node scrape.js [url-list-file]
 *
 * Default file: hellofresh-recipe-urls-1774641958967.txt
 * Expects one full HelloFresh recipe URL per line, e.g.:
 *   https://www.hellofresh.com/recipes/pecan-crusted-chicken-6203c3d357b8e37e4638262a
 *
 * Requires the local server to be running first:
 *   node server.js
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────
const SERVER     = 'http://localhost:3456';
const FETCH_DELAY = 1500;   // ms between recipe detail fetches
const IMG_DELAY   = 700;    // ms between image downloads
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
  gray   : '\x1b[90m',
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

/** Left-pad a number to a given width. */
function rpad(n, width) {
  return String(n).padStart(width, ' ');
}

/** Truncate / right-pad a string to a fixed display width. */
function col(str, len) {
  str = String(str || '');
  return str.length > len ? str.slice(0, len - 1) + '…' : str.padEnd(len, ' ');
}

/** Extract the 24-char hex recipe ID from a HelloFresh recipe URL. */
function extractId(url) {
  const m = url.match(/([a-f0-9]{24})(?:[/?#].*)?$/i);
  return m ? m[1] : null;
}

// ── HTTP helpers ──────────────────────────────────────────────────

/**
 * Extract a human-readable message from any thrown value.
 * Node.js ECONNREFUSED on dual-stack (IPv4+IPv6) comes back as an
 * AggregateError with an empty .message — the real info is in .errors[].
 */
function errMsg(err) {
  if (!err) return 'unknown error';
  // AggregateError: real sub-errors are in .errors[]
  if (err.errors && err.errors.length > 0) {
    const sub = err.errors[0];
    return sub.message || sub.code || String(sub);
  }
  if (err.message) return err.message;
  if (err.code)    return err.code;
  return String(err);
}

function get(urlStr) {
  return new Promise((resolve, reject) => {
    const req = http.get(urlStr, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try {
          resolve({ status: res.statusCode, data: JSON.parse(text) });
        } catch {
          reject(new Error(`JSON parse error (HTTP ${res.statusCode}): ${text.slice(0, 80)}`));
        }
      });
    });
    req.setTimeout(30_000, () => { req.destroy(); reject(new Error('timeout after 30s')); });
    req.on('error', err => reject(new Error(errMsg(err)))); // normalise to plain Error
  });
}

/** Ping the local server; exit with a helpful message if it's not up. */
async function checkServer() {
  try {
    await get(`${SERVER}/api/recipes?cuisine=test&page=0`);
  } catch (err) {
    const msg = errMsg(err);
    console.error(`\n${C.red}${C.bold}Error: cannot reach server at ${SERVER}${C.reset}`);
    console.error(`${C.red}  ${msg}${C.reset}`);
    console.error(`${C.yellow}  → Start it first with: node server.js${C.reset}\n`);
    process.exit(1);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchB64(imgUrl) {
  if (!imgUrl) return '';
  try {
    const r = await get(`${SERVER}/api/img?url=${encodeURIComponent(imgUrl)}`);
    return r.data?.dataUrl || '';
  } catch {
    return '';
  }
}

// ── Logging helpers ───────────────────────────────────────────────

/** Clear the current terminal line (used to wipe the spinner). */
function clearLine() {
  process.stdout.write('\r\x1b[K');
}

let _spinnerTimer = null;
const SPINNER = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
let _spinnerIdx = 0;

function startSpinner(prefix, label) {
  clearLine();
  _spinnerIdx = 0;
  _spinnerTimer = setInterval(() => {
    process.stdout.write(`\r${prefix} ${C.cyan}${SPINNER[_spinnerIdx % SPINNER.length]}${C.reset} ${C.dim}${label}${C.reset}`);
    _spinnerIdx++;
  }, 80);
}

function stopSpinner() {
  if (_spinnerTimer) { clearInterval(_spinnerTimer); _spinnerTimer = null; }
  clearLine();
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  // ── 1. Load URL file ────────────────────────────────────────────
  const urlFile = process.argv[2] || 'hellofresh-recipe-urls-1774641958967.txt';
  const urlFilePath = path.resolve(urlFile);

  if (!fs.existsSync(urlFilePath)) {
    console.error(`${C.red}Error: URL file not found → ${urlFilePath}${C.reset}`);
    process.exit(1);
  }

  const rawLines = fs.readFileSync(urlFilePath, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('https://www.hellofresh.com/recipes/'));

  // Deduplicate URLs
  const allUrls = [...new Set(rawLines)];

  // ── 2. Categorise URLs before we start ─────────────────────────
  if (!fs.existsSync(DETAIL_DIR)) fs.mkdirSync(DETAIL_DIR, { recursive: true });

  const cachedIds = new Set(
    fs.readdirSync(DETAIL_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''))
  );

  const badUrls    = [];   // can't extract ID
  const toSkip     = [];   // already in cache
  const toFetch    = [];   // need to scrape

  for (const url of allUrls) {
    const id = extractId(url);
    if (!id)              { badUrls.push(url); continue; }
    if (cachedIds.has(id)){ toSkip.push({ url, id }); continue; }
    toFetch.push({ url, id });
  }

  // ── 3. Print plan ───────────────────────────────────────────────
  const divider = '─'.repeat(64);
  console.log(`\n${C.bold}  Recipe Scraper — URL-list mode${C.reset}`);
  console.log(divider);
  console.log(`  File    : ${urlFile}`);
  console.log(`  Total   : ${allUrls.length} unique URLs`);
  console.log(`  ${C.green}To fetch${C.reset} : ${toFetch.length}`);
  console.log(`  ${C.dim}Cached${C.reset}   : ${toSkip.length}  (already in detail-cache, will skip)`);
  if (badUrls.length)
    console.log(`  ${C.yellow}Bad URLs${C.reset} : ${badUrls.length}  (cannot extract recipe ID)`);
  console.log(`  Server  : ${SERVER}`);
  console.log(divider + '\n');

  if (badUrls.length) {
    console.log(`${C.yellow}⚠ Bad URLs (no recipe ID found):${C.reset}`);
    for (const u of badUrls) console.log(`  ${C.dim}${u}${C.reset}`);
    console.log();
    fs.appendFileSync(ERROR_LOG, badUrls.map(u => `[BAD-URL] ${u}`).join('\n') + '\n');
  }

  if (toFetch.length === 0) {
    console.log(`${C.green}Nothing to do — all URLs already cached.${C.reset}\n`);
    return;
  }

  // ── 4. Check server is reachable before we start ────────────────
  process.stdout.write(`  Checking server… `);
  await checkServer();
  console.log(`${C.green}OK${C.reset}\n`);

  // ── 5. Scrape loop ──────────────────────────────────────────────
  let saved = 0, failed = 0;
  const startTime  = Date.now();
  const indexWidth = String(toFetch.length).length;

  for (let i = 0; i < toFetch.length; i++) {
    const { url, id } = toFetch[i];
    const prefix = `[${rpad(i + 1, indexWidth)}/${toFetch.length}]`;

    // ── Fetch detail ─────────────────────────────────────────────
    startSpinner(prefix, `fetching ${id}`);
    await sleep(FETCH_DELAY);

    let detail;
    try {
      const r = await get(`${SERVER}/api/recipe/${id}`);
      if (r.status !== 200) {
        throw new Error(`HTTP ${r.status} — ${r.data?.error || 'no error message'}`);
      }
      detail = r.data;
    } catch (err) {
      const reason = errMsg(err);
      stopSpinner();
      console.log(`${prefix} ${C.red}✗ FAIL${C.reset}  ${C.dim}${id}${C.reset}`);
      console.log(`${' '.repeat(indexWidth * 2 + 4)}  ${C.red}└─ ${reason}${C.reset}`);
      failed++;
      fs.appendFileSync(ERROR_LOG, `[FAIL] ${id}\n       URL: ${url}\n       Reason: ${reason}\n\n`);
      continue;
    }

    const name = detail.name || id;

    // ── Download images ──────────────────────────────────────────
    let imgOk = 0, imgFail = 0;

    async function dlImg(urlStr) {
      if (!urlStr) return '';
      await sleep(IMG_DELAY);
      const b64 = await fetchB64(urlStr);
      if (b64) { imgOk++; return b64; }
      imgFail++;
      return urlStr; // keep original URL if download fails
    }

    startSpinner(prefix, `downloading images — ${name}`);

    detail.image = await dlImg(detail.image);

    for (const ing of (detail.ingredients || [])) {
      ing.image = await dlImg(ing.image);
    }
    for (const step of (detail.steps || [])) {
      step.image = await dlImg(step.image);
    }

    // ── Save ─────────────────────────────────────────────────────
    stopSpinner();
    fs.writeFileSync(path.join(DETAIL_DIR, `${id}.json`), JSON.stringify(detail));
    cachedIds.add(id);
    saved++;

    // ── ETA ──────────────────────────────────────────────────────
    const elapsed   = Date.now() - startTime;
    const avgMs     = elapsed / saved;
    const remaining = toFetch.length - saved - failed;
    const eta       = remaining > 0 && saved > 2 ? ` ETA ~${fmt(avgMs * remaining)}` : '';

    // ── Result line ──────────────────────────────────────────────
    const imgNote = imgFail > 0
      ? `${imgOk} imgs, ${C.yellow}${imgFail} failed${C.reset}`
      : `${imgOk} imgs`;

    console.log(
      `${prefix} ${C.green}✓${C.reset} ${col(name, 44)} ${C.dim}${imgNote}${eta}${C.reset}`
    );

    // Every 25 saves, print a mini running total
    if (saved % 25 === 0) {
      console.log(
        `${C.dim}${'·'.repeat(64)}` +
        `  ${saved} saved / ${failed} failed / ${remaining} left${C.reset}`
      );
    }
  }

  // ── 5. Final summary ─────────────────────────────────────────────
  const totalElapsed = Date.now() - startTime;
  const dividerThick = '═'.repeat(64);
  console.log(`\n${dividerThick}`);
  console.log(`  ${C.bold}Done${C.reset} — finished in ${fmt(totalElapsed)}`);
  console.log(`  ${C.green}✓ Saved   :${C.reset}  ${saved}`);
  console.log(`  ${C.dim}○ Cached  :  ${toSkip.length}  (skipped — already existed)${C.reset}`);
  console.log(`  ${C.red}✗ Failed  :  ${failed}${C.reset}`);
  if (badUrls.length)
    console.log(`  ${C.yellow}⚠ Bad URLs:  ${badUrls.length}${C.reset}`);
  if (failed > 0 || badUrls.length > 0)
    console.log(`\n  Full error details → ${ERROR_LOG}`);
  console.log(`${dividerThick}\n`);
}

main().catch(err => {
  console.error(`\n${C.red}Fatal: ${err.message}${C.reset}\n`);
  process.exit(1);
});
