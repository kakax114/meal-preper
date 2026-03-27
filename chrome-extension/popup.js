const countEl = document.getElementById('count');
const listEl = document.getElementById('url-list');
const statusEl = document.getElementById('status');

function renderUrls(urls) {
  countEl.textContent = urls.length;
  listEl.innerHTML = '';
  urls.forEach(url => {
    const slug = url.split('/recipes/')[1] || url;
    const item = document.createElement('div');
    item.className = 'url-item';
    item.innerHTML = `<span class="dot"></span><a href="${url}" target="_blank" title="${url}">${slug}</a>`;
    listEl.appendChild(item);
  });
  // Scroll to bottom so newest entries are visible
  listEl.scrollTop = listEl.scrollHeight;
}

function load() {
  chrome.runtime.sendMessage({ type: 'GET_URLS' }, response => {
    renderUrls(response?.urls || []);
  });
}

document.getElementById('btn-export').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'GET_URLS' }, response => {
    const urls = response?.urls || [];
    if (urls.length === 0) {
      statusEl.textContent = 'Nothing to export yet.';
      return;
    }
    const blob = new Blob([urls.join('\n')], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `hellofresh-recipe-urls-${Date.now()}.txt`;
    a.click();
    statusEl.textContent = `Exported ${urls.length} URLs.`;
  });
});

document.getElementById('btn-clear').addEventListener('click', () => {
  if (!confirm(`Clear all collected URLs?`)) return;
  chrome.runtime.sendMessage({ type: 'CLEAR_URLS' }, () => {
    renderUrls([]);
    statusEl.textContent = 'Cleared.';
  });
});

// Auto-refresh while popup is open (picks up new URLs from content script)
load();
setInterval(load, 2000);
