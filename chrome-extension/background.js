// Background service worker — stores collected recipe URLs

const RECIPE_PATTERN = /^https:\/\/www\.hellofresh\.com\/recipes\/[a-z0-9-]+-[a-f0-9]+$/i;

// Listen for messages from content scripts or popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ADD_URLS') {
    addUrls(message.urls).then(result => sendResponse(result));
    return true; // keep channel open for async response
  }

  if (message.type === 'GET_URLS') {
    chrome.storage.local.get(['recipeUrls'], data => {
      sendResponse({ urls: data.recipeUrls || [] });
    });
    return true;
  }

  if (message.type === 'CLEAR_URLS') {
    chrome.storage.local.set({ recipeUrls: [] }, () => {
      sendResponse({ success: true });
    });
    return true;
  }
});

async function addUrls(newUrls) {
  return new Promise(resolve => {
    chrome.storage.local.get(['recipeUrls'], data => {
      const existing = new Set(data.recipeUrls || []);
      let added = 0;

      for (const url of newUrls) {
        if (RECIPE_PATTERN.test(url) && !existing.has(url)) {
          existing.add(url);
          added++;
        }
      }

      chrome.storage.local.set({ recipeUrls: [...existing] }, () => {
        resolve({ total: existing.size, added });
      });
    });
  });
}
