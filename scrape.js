'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────
const SERVER     = 'http://localhost:3456';
const TARGET     = 1000;
const DELAY_MS   = 2500;   // between image downloads
const BATCH_DELAY= 4000;   // between recipe list fetches
const DETAIL_DIR = path.join(__dirname, 'detail-cache');
const LOG_SIZE   = 8;      // skip log lines shown

const CATEGORIES = [
  'American','Italian','Mexican','Asian','Mediterranean',
  'Indian','Chinese','Japanese','Korean','Thai',
  'French','Spanish','Vietnamese','Middle Eastern','African',
  'Cuban','Latin American','Hawaiian','Cajun','Greek',
  'Turkish','Moroccan','Portuguese','Russian','Jamaican',
  'British','German','Swedish','Lebanese','Peruvian',
];

// ── State ────────────────────────────────────────────────────────
let pass = 0, fail = 0, cached = 0, dup = 0;
let statusMsg = 'Initializing…';
const seenIds = new Set();
const startTime = Date.now();
let displayReady = false;
const skipLog = [];   // circular log of recent skip events

// ── Terminal helpers ─────────────────────────────────────────────
const W = 56;
// 9 status lines + 1 header + LOG_SIZE log lines + 1 bottom div = 9 + 2 + LOG_SIZE
const NLINES = 11 + LOG_SIZE;

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function bar(pct, width = 26) {
  const f = Math.round(Math.min(pct, 1) * width);
  return '[' + '█'.repeat(f) + '░'.repeat(width - f) + ']';
}

function pad(str, len) {
  str = String(str);
  return str.length >= len ? str.slice(0, len) : str + ' '.repeat(len - str.length);
}

function logSkip(reason, name) {
  const label = reason === 'id'   ? 'cached-id  '
              : reason === 'name' ? 'dup-name   '
              :                     'unknown    ';
  skipLog.unshift(`  [${label}] ${name.slice(0, W - 16)}`);
  if (skipLog.length > LOG_SIZE) skipLog.pop();
}

function render() {
  const pct     = Math.min((cached + pass) / TARGET, 1);
  const elapsed = Date.now() - startTime;
  const eta     = pass > 0 ? (elapsed / pass) * (TARGET - cached - pass) : 0;
  const div     = '─'.repeat(W);

  // Pad log to fixed height so cursor math stays correct
  const logLines = [...skipLog];
  while (logLines.length < LOG_SIZE) logLines.push('');

  const lines = [
    div,
    `  My Cookbook — Recipe Scraper`,
    div,
    `  ${bar(pct)} ${String(Math.round(pct * 100)).padStart(3)}%`,
    `  Total : ${cached + pass} / ${TARGET}   (${TARGET - cached - pass} remaining)`,
    `  New: ${pass}   Cached: ${cached}   Fail: ${fail}   Dup: ${dup}`,
    `  Elapsed: ${fmt(elapsed)}   ETA: ${pass > 5 ? fmt(eta) : '—'}`,
    `  ${pad(statusMsg, W - 2)}`,
    div,
    `  Recent skips:`,
    ...logLines.map(l => pad(l, W)),
    div,
  ];

  if (displayReady) process.stdout.write(`\x1B[${NLINES}A\r`);
  process.stdout.write(lines.join('\n') + '\n');
  displayReady = true;
}

// ── HTTP helper ──────────────────────────────────────────────────
function get(urlStr) {
  return new Promise((resolve, reject) => {
    const req = http.get(urlStr, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(new Error('JSON parse error')); }
      });
    });
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchB64(imgUrl) {
  if (!imgUrl) return '';
  try {
    const d = await get(`${SERVER}/api/img?url=${encodeURIComponent(imgUrl)}`);
    return d.dataUrl || '';
  } catch { return ''; }
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(DETAIL_DIR)) fs.mkdirSync(DETAIL_DIR);

  // Resume: load already-scraped IDs and names from detail-cache
  const seenNames = new Set();
  fs.readdirSync(DETAIL_DIR).filter(f => f.endsWith('.json')).forEach(f => {
    const id = f.replace('.json', '');
    seenIds.add(id);
    try {
      const d = JSON.parse(fs.readFileSync(path.join(DETAIL_DIR, f), 'utf8'));
      if (d.name) seenNames.add(d.name.trim().toLowerCase());
    } catch {}
  });
  cached = seenIds.size;
  render();

  outer:
  for (const cuisine of CATEGORIES) {
    let page = 0;

    while (true) {
      if (cached + pass >= TARGET) break outer;

      statusMsg = `Fetching ${cuisine} (page ${page + 1})…`;
      render();

      let items;
      try {
        const enc  = encodeURIComponent(cuisine);
        const data = await get(`${SERVER}/api/recipes?cuisine=${enc}&page=${page}`);
        items = data.items || [];
      } catch (err) {
        fail++;
        const errLine = `[LIST-FAIL] ${cuisine} page ${page} — ${err.message}`;
        statusMsg = errLine.slice(0, W - 2);
        fs.appendFileSync(path.join(__dirname, 'scrape-errors.log'), errLine + '\n');
        render();
        await sleep(BATCH_DELAY * 2);
        break; // next cuisine
      }

      if (items.length === 0) break; // no more pages for this cuisine

      for (const recipe of items) {
        if (cached + pass >= TARGET) break outer;
        const recipeName = (recipe.name || '').trim().toLowerCase();

        if (seenIds.has(recipe.id)) {
          dup++;
          logSkip('id', recipe.name || recipe.id);
          render();
          continue;
        }
        if (seenNames.has(recipeName)) {
          dup++;
          logSkip('name', recipe.name || recipeName);
          render();
          continue;
        }

        try {
          // ── Detail + hero image (same image used for card) ────
          statusMsg = `[${cached + pass + 1}/${TARGET}] Detail: ${recipe.name.slice(0, 34)}`;
          render();
          await sleep(DELAY_MS);
          const detail = await get(`${SERVER}/api/recipe/${recipe.id}`);

          // ── Hero image (reused as card thumbnail) ──────────────
          if (detail.image) {
            await sleep(DELAY_MS);
            detail.image = await fetchB64(detail.image);
          }
          // ── Ingredient images ──────────────────────────────────
          for (const ing of (detail.ingredients || [])) {
            if (!ing.image) continue;
            await sleep(800);
            ing.image = await fetchB64(ing.image);
          }

          // ── Step images ────────────────────────────────────────
          for (const step of (detail.steps || [])) {
            if (!step.image) continue;
            statusMsg = `[${cached + pass + 1}/${TARGET}] Step img: ${recipe.name.slice(0, 30)}`;
            render();
            await sleep(DELAY_MS);
            step.image = await fetchB64(step.image);
          }

          // ── Save detail cache ──────────────────────────────────
          fs.writeFileSync(
            path.join(DETAIL_DIR, `${recipe.id}.json`),
            JSON.stringify(detail)
          );

          seenIds.add(recipe.id);
          seenNames.add(recipeName);
          pass++;
          render();

        } catch (err) {
          fail++;
          const errLine = `[FAIL] ${recipe.name || recipe.id} — ${err.message}`;
          statusMsg = errLine.slice(0, W - 2);
          fs.appendFileSync(path.join(__dirname, 'scrape-errors.log'), errLine + '\n');
          render();
        }

        await sleep(BATCH_DELAY);
      }

      page++;
      await sleep(BATCH_DELAY);
    }
  }

  statusMsg = `Done! ${pass} new, ${cached} pre-cached — ${seenIds.size} total in detail-cache/`;
  render();
  process.stdout.write('\n');
}

main().catch(err => {
  process.stdout.write('\n');
  console.error('Fatal:', err.message);
  process.exit(1);
});
