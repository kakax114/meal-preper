// Content script — scans the page for HelloFresh recipe URLs and reports them

const RECIPE_PATTERN = /^https:\/\/www\.hellofresh\.com\/recipes\/[a-z0-9-]+-[a-f0-9]+$/i;

function collectRecipeUrls() {
  const found = new Set();

  // Check current page URL
  if (RECIPE_PATTERN.test(window.location.href)) {
    found.add(window.location.href);
  }

  // Scan all anchor tags on the page
  document.querySelectorAll('a[href]').forEach(a => {
    const url = a.href;
    if (RECIPE_PATTERN.test(url)) {
      found.add(url);
    }
  });

  return [...found];
}

function sendUrls(urls) {
  if (urls.length === 0) return;
  chrome.runtime.sendMessage({ type: 'ADD_URLS', urls }, response => {
    if (chrome.runtime.lastError) return; // popup closed, ignore
    if (response && response.added > 0) {
      console.log(`[Recipe Collector] +${response.added} new (total: ${response.total})`);
    }
  });
}

// Initial scan on page load
sendUrls(collectRecipeUrls());

// Watch for dynamic content (SPA navigation / lazy-loaded recipe cards)
const observer = new MutationObserver(() => {
  sendUrls(collectRecipeUrls());
});

observer.observe(document.body, { childList: true, subtree: true });

// Also re-scan on SPA route changes (pushState / replaceState)
let lastHref = window.location.href;
setInterval(() => {
  if (window.location.href !== lastHref) {
    lastHref = window.location.href;
    sendUrls(collectRecipeUrls());
  }
}, 1000);
