// Content script — scans the page for HelloFresh recipe URLs and reports them

const RECIPE_PATTERN = /^https:\/\/www\.hellofresh\.com\/recipes\/[a-z0-9-]+-[a-f0-9]+$/i;

// Track every URL this tab has already sent — never send the same URL twice
const sent = new Set();

function scanAndSend() {
  const newUrls = [];

  const candidates = [];
  if (RECIPE_PATTERN.test(window.location.href)) candidates.push(window.location.href);
  document.querySelectorAll('a[href]').forEach(a => candidates.push(a.href));

  for (const url of candidates) {
    if (RECIPE_PATTERN.test(url) && !sent.has(url)) {
      sent.add(url);
      newUrls.push(url);
    }
  }

  if (newUrls.length === 0) return;

  chrome.runtime.sendMessage({ type: 'ADD_URLS', urls: newUrls }, response => {
    if (chrome.runtime.lastError) return;
    if (response && response.added > 0) {
      console.log(`[Recipe Collector] +${response.added} new (total: ${response.total})`);
    }
  });
}

// Initial scan on page load
scanAndSend();

// Watch for dynamic content (SPA navigation / lazy-loaded recipe cards)
const observer = new MutationObserver(scanAndSend);
observer.observe(document.body, { childList: true, subtree: true });

// Re-scan on SPA route changes
let lastHref = window.location.href;
setInterval(() => {
  if (window.location.href !== lastHref) {
    lastHref = window.location.href;
    scanAndSend();
  }
}, 1000);
