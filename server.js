'use strict';

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT        = 3456;
const API_BASE    = 'https://gw.hellofresh.com/api';
const IMG_BASE    = 'https://img.hellofresh.com/hellofresh_s3/image/upload';
const DETAIL_DIR  = path.join(__dirname, 'detail-cache');

// ── Token cache ────────────────────────────────────────────────
let _token       = null;
let _tokenExpiry = 0;

// ── Image cache (base64) ───────────────────────────────────────
const imgCache = new Map();

// ── Featured recipes cache ─────────────────────────────────────
let _featuredCache   = null;
let _featuredExpiry  = 0;
let _featuredPending = null; // in-flight Promise to avoid stampede

// ── Local detail-cache index (browse without hitting HF API) ───
let _localIndex = [];

function buildLocalIndex() {
  if (!fs.existsSync(DETAIL_DIR)) return;
  const files = fs.readdirSync(DETAIL_DIR).filter(f => f.endsWith('.json'));
  const all = files.map(f => {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(DETAIL_DIR, f), 'utf8'));
      return {
        id:         d.id,
        name:       d.name,
        headline:   d.headline,
        image:      d.image,
        imageThumb: d.image,
        cuisine:    d.cuisine,
        difficulty: d.difficulty,
        totalTime:  d.totalTime,
        prepTime:   d.prepTime,
        servings:   d.servings,
        rating:     d.rating,
        tags:       d.tags,
      };
    } catch { return null; }
  }).filter(Boolean);

  // Deduplicate by name — keep last scraped (files sorted by mtime)
  const seen = new Map();
  for (const r of all) seen.set(r.name.trim().toLowerCase(), r);
  _localIndex = [...seen.values()];
  console.log(`[local] Loaded ${_localIndex.length} unique recipes from ${all.length} files`);
}

// ── Generic HTTPS fetch (follows one redirect) ─────────────────
function hfetch(targetUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        ...headers,
      },
    };

    const req = https.get(opts, res => {
      // Follow redirect once
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
        text()      { return this.buffer.toString('utf8'); },
        json()      { return JSON.parse(this.text()); },
      }));
    });

    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
  });
}

// ── Fetch HelloFresh bearer token ──────────────────────────────
async function getToken() {
  if (_token && Date.now() < _tokenExpiry) return _token;

  console.log('[token] Fetching HelloFresh bearer token…');
  const res = await hfetch('https://www.hellofresh.com');
  const html = res.text();

  const m = html.match(/"access_token":"([^"]+)"/);
  if (!m) throw new Error('Could not extract HelloFresh access token from page HTML');

  _token       = m[1];
  _tokenExpiry = Date.now() + 45 * 60 * 1000; // refresh every 45 min
  console.log('[token] Token obtained');
  return _token;
}

// ── Helpers ────────────────────────────────────────────────────
function imgUrl(imagePath, w = 600) {
  if (!imagePath) return '';
  return `${IMG_BASE}/f_auto,fl_lossy,q_auto,w_${w}/${imagePath}`;
}

function diffLabel(d) {
  if (!d) return 'Easy';
  if (typeof d === 'string') return d.charAt(0).toUpperCase() + d.slice(1);
  const map = { 0: 'Easy', 1: 'Easy', 2: 'Medium', 3: 'Hard' };
  return map[d] || 'Easy';
}

function parseDuration(iso) {
  if (!iso) return '';
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return '';
  const h = parseInt(m[1] || 0), min = parseInt(m[2] || 0);
  return h > 0 ? `${h}h ${min}m` : `${min} min`;
}

function normRecipe(r) {
  const cuisine =
    (r.cuisines && r.cuisines[0] && r.cuisines[0].name) ||
    (r.tags && (r.tags.find(t => t.type === 'cuisine') || {}).name) ||
    'World';

  return {
    id:          r.id,
    name:        r.name,
    headline:    r.headline    || '',
    image:       r.imagePath ? imgUrl(r.imagePath, 800) : (r.image || ''),
    imageThumb:  r.imagePath ? imgUrl(r.imagePath, 400) : (r.imageThumb || r.image || ''),
    cuisine,
    difficulty:  diffLabel(r.difficulty),
    totalTime:   parseDuration(r.totalTime),
    prepTime:    parseDuration(r.prepTime),
    servings:    r.servingSize || 2,
    rating:      r.averageRating ? r.averageRating.toFixed(1) : null,
    tags:        (r.tags || []).map(t => t.name).slice(0, 6),
  };
}

function normDetail(r) {
  const base = normRecipe(r);

  const ingredients = (r.ingredients || []).map(ing => ({
    id:     ing.id,
    name:   ing.name,
    amount: ing.amount || '',
    unit:   (ing.unit && (ing.unit.name || ing.unit)) || '',
    image:  imgUrl(ing.imagePath, 200),
  }));

  const steps = (r.steps || []).map((s, i) => ({
    index:        s.index || i + 1,
    instructions: s.instructions || '',
    image:        s.images && s.images[0] ? imgUrl(s.images[0].path, 700) : '',
  }));

  const nutrition = (r.nutrition || []).map(n => ({
    name:   n.name || n.type || '',
    amount: Math.round(n.amount || 0),
    unit:   n.unit || '',
  }));

  return { ...base, ingredients, steps, nutrition };
}

function jsonReply(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type':  'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

// ── Build featured recipes (one per cuisine, scraped from HF pages) ─
const FEATURED_SLUGS = [
  ['american-recipes',       'American'],
  ['italian-recipes',        'Italian'],
  ['mexican-recipes',        'Mexican'],
  ['asian-recipes',          'Asian'],
  ['mediterranean-recipes',  'Mediterranean'],
  ['indian-recipes',         'Indian'],
  ['chinese-recipes',        'Chinese'],
  ['japanese-recipes',       'Japanese'],
  ['korean-recipes',         'Korean'],
  ['thai-recipes',           'Thai'],
  ['french-recipes',         'French'],
  ['spanish-recipes',        'Spanish'],
  ['vietnamese-recipes',     'Vietnamese'],
  ['middle-eastern-recipes', 'Middle Eastern'],
  ['african-recipes',        'African'],
  ['cuban-recipes',          'Cuban'],
  ['latin-american-recipes', 'Latin American'],
  ['hawaiian-recipes',       'Hawaiian'],
  ['cajun-recipes',          'Cajun'],
  ['stir-fry-recipes',       'Stir Fry'],
];

function scrapeFirstRecipe(html, cuisineLabel) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/);
  if (!m) return null;
  try {
    const queries = JSON.parse(m[1])?.props?.pageProps?.ssrPayload?.dehydratedState?.queries || [];
    const rq = queries.find(q => {
      const d = q?.state?.data;
      return d?.items && d.items.length > 0 && d.items[0]?.id;
    });
    if (!rq) return null;
    const recipe = normRecipe(rq.state.data.items[0]);
    recipe.cuisine = cuisineLabel;
    return recipe;
  } catch { return null; }
}

async function buildFeatured() {
  console.log('[featured] Building featured recipes from HF pages…');
  // Fetch sequentially in small batches to avoid rate-limits
  const items = [];
  for (let i = 0; i < FEATURED_SLUGS.length; i += 5) {
    const batch = FEATURED_SLUGS.slice(i, i + 5);
    const results = await Promise.all(batch.map(async ([slug, label]) => {
      try {
        const r = await hfetch(`https://www.hellofresh.com/recipes/${slug}`);
        return r.status === 200 ? scrapeFirstRecipe(r.text(), label) : null;
      } catch { return null; }
    }));
    items.push(...results.filter(Boolean));
    console.log(`[featured] batch ${i/5+1}/4 done — ${items.length} recipes so far`);
  }
  const result = { items, total: items.length };
  _featuredCache  = result;
  _featuredExpiry = Date.now() + 60 * 60 * 1000; // cache 1 hour
  _featuredPending = null;
  console.log(`[featured] Done — ${items.length} recipes cached`);
  return result;
}

// ── Request handler ────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const query    = parsed.query;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {

    // ── /api/hf-categories  — scrape category list from main HF page ─
    if (pathname === '/api/hf-categories') {
      const pageRes = await hfetch('https://www.hellofresh.com/recipes');
      const html = pageRes.text();
      // Extract all /recipes/ links from HTML
      const links = [...html.matchAll(/href="\/recipes\/([^"?#]+)"/g)]
        .map(m => m[1])
        .filter(l => l.includes('-recipes') && !l.startsWith('http'))
        .filter((v,i,a) => a.indexOf(v) === i);  // dedupe
      jsonReply(res, 200, { links });
      return;
    }

    // ── /api/hf-page?path=italian-recipes  (debug scrape) ─────
    if (pathname === '/api/hf-page') {
      const pagePath = query.path || '';
      const pageRes = await hfetch(`https://www.hellofresh.com/recipes/${pagePath}`);
      const html = pageRes.text();
      const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/);
      if (!m) { jsonReply(res, 500, { error: 'No __NEXT_DATA__ found' }); return; }
      const nextData = JSON.parse(m[1]);
      const ssrPayload = nextData?.props?.pageProps?.ssrPayload;
      const queries = ssrPayload?.dehydratedState?.queries || [];
      // Find the query that has recipe items
      const recipeQuery = queries.find(q => {
        const data = q?.state?.data;
        return data?.items && Array.isArray(data.items) && data.items.length > 0 && data.items[0]?.id;
      });
      if (!recipeQuery) {
        // Show query keys to help debug
        const info = queries.map(q => ({ hash: q.queryHash, dataKeys: Object.keys(q?.state?.data||{}) }));
        jsonReply(res, 200, { found: false, queries: info });
        return;
      }
      jsonReply(res, 200, { found: true, total: recipeQuery.state.data.total, sample: recipeQuery.state.data.items.slice(0,2).map(r => ({ id:r.id, name:r.name, totalTime:r.totalTime, imagePath:r.imagePath })) });
      return;
    }

    // ── /api/featured — one recipe per cuisine page ────────────
    if (pathname === '/api/featured') {
      if (_featuredCache && Date.now() < _featuredExpiry) {
        jsonReply(res, 200, _featuredCache);
        return;
      }
      if (!_featuredPending) _featuredPending = buildFeatured();
      const result = await _featuredPending;
      jsonReply(res, 200, result);
      return;
    }


    // ── /api/recipes?cuisine=X&page=N ─────────────────────────
    if (pathname === '/api/recipes') {
      const cuisine = query.cuisine || '';
      const page    = Math.max(0, parseInt(query.page) || 0);

      // Serve from detail-cache index if populated
      if (_localIndex.length > 0) {
        let items = _localIndex;
        if (cuisine && cuisine !== 'All') {
          const q = cuisine.toLowerCase();
          items = items.filter(r =>
            (r.cuisine||'').toLowerCase().includes(q) ||
            (r.name||'').toLowerCase().includes(q) ||
            (r.tags||[]).some(t => t.toLowerCase().includes(q))
          );
        }
        const slice = items.slice(page * 20, page * 20 + 20);
        jsonReply(res, 200, { items: slice, total: items.length, page });
        return;
      }

      const token = await getToken();
      const limit = 20;

      const params = new URLSearchParams({
        country: 'US',
        locale:  'en-US',
        limit:   200,
        skip:    page * 20,
      });
      if (cuisine && cuisine !== 'All') params.set('q', cuisine);

      const apiRes = await hfetch(
        `${API_BASE}/recipes/search?${params}`,
        { Authorization: `Bearer ${token}` },
      );

      if (apiRes.status !== 200) {
        jsonReply(res, apiRes.status, { error: 'HelloFresh API error', status: apiRes.status });
        return;
      }

      const data  = apiRes.json();
      const items = (data.items || [])
        .filter(r => {
          // Drop pre-made/supplement products
          const tags = (r.tags || []).map(t => (t.name || '').toLowerCase());
          if (tags.includes('ineligible-reco')) return false;
          // Drop bulk items (pre-packaged — absurd serving counts)
          if ((r.servingSize || 0) > 10) return false;
          // Drop anything with no real cook time (supplements, salad kits)
          const prep = r.prepTime || ''; const total = r.totalTime || '';
          const mins = m => { const x = m.match(/PT(?:(\d+)H)?(?:(\d+)M)?/); if(!x) return 0; return parseInt(x[1]||0)*60+parseInt(x[2]||0); };
          if (mins(total) < 15) return false;  // drop <15 min items (supplements, dinner bars)
          return true;
        })
        .map(normRecipe);

      jsonReply(res, 200, { items, total: items.length, page });
      return;
    }

    // ── /api/recipe/:id ───────────────────────────────────────
    const detailMatch = pathname.match(/^\/api\/recipe\/([^/]+)$/);
    if (detailMatch) {
      const id = detailMatch[1];

      // Serve from detail-cache if available
      const cached = path.join(DETAIL_DIR, `${id}.json`);
      if (fs.existsSync(cached)) {
        const data = JSON.parse(fs.readFileSync(cached, 'utf8'));
        jsonReply(res, 200, data);
        return;
      }

      const token = await getToken();

      const apiRes = await hfetch(
        `${API_BASE}/recipes/${id}?country=US&locale=en-US`,
        { Authorization: `Bearer ${token}` },
      );

      if (apiRes.status !== 200) {
        jsonReply(res, apiRes.status, { error: 'Recipe not found' });
        return;
      }

      jsonReply(res, 200, normDetail(apiRes.json()));
      return;
    }

    // ── /api/img?url=... → base64 data URL ────────────────────
    if (pathname === '/api/img') {
      const src = query.url;
      if (!src || !src.startsWith('https://img.hellofresh.com')) {
        res.writeHead(400); res.end('Invalid image URL'); return;
      }

      if (imgCache.has(src)) {
        jsonReply(res, 200, { dataUrl: imgCache.get(src) });
        return;
      }

      const imgRes  = await hfetch(src);
      const mime    = imgRes.contentType.split(';')[0] || 'image/jpeg';
      const dataUrl = `data:${mime};base64,${imgRes.buffer.toString('base64')}`;

      imgCache.set(src, dataUrl);
      // Keep cache below 200 entries
      if (imgCache.size > 200) imgCache.delete(imgCache.keys().next().value);

      jsonReply(res, 200, { dataUrl });
      return;
    }

    // ── Static files ──────────────────────────────────────────
    let filePath = pathname === '/' ? '/index.html' : pathname;
    filePath = path.join(__dirname, filePath.replace(/\.\./g, '')); // basic traversal guard

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext   = path.extname(filePath).toLowerCase();
      const mimes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
      res.writeHead(200, { 'Content-Type': mimes[ext] || 'application/octet-stream' });
      res.end(fs.readFileSync(filePath));
    } else {
      res.writeHead(404); res.end('Not found');
    }

  } catch (err) {
    console.error('[error]', err.message);
    jsonReply(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`\nMy Cookbook → http://localhost:${PORT}\n`);
  buildLocalIndex(); // load detail-cache into memory
  getToken().catch(e => console.warn('[token] Warm-up failed:', e.message));
  // Pre-warm featured cache only if no local recipes yet
  if (_localIndex.length === 0) setTimeout(() => { _featuredPending = buildFeatured(); }, 1000);
});
