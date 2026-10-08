// Local pages for the browser readiness tests and the fetch-path bench.
// Each page carries a marker that only appears once its dynamic content has
// been rendered, so a test can tell "captured" from "returned too early".
// Scripts assemble markers from two halves so the page source never contains
// the marker itself.

export const MARKERS = {
  static: 'STATIC-CONTENT-OK',
  delayed: 'DELAYED-CONTENT-OK',
  lazy: 'LAZY-BATCH-2-OK',
  lazyImage: 'data-loaded-src',
  challenge: 'CHALLENGE-PASSED-OK',
  fetched: 'FETCHED-CONTENT-OK',
} as const;

/** JS expression that evaluates to `marker` without containing it literally. */
function split(marker: string): string {
  const mid = Math.floor(marker.length / 2);
  return `${JSON.stringify(marker.slice(0, mid))} + ${JSON.stringify(marker.slice(mid))}`.replace(/"/g, "'");
}

/** A small static page with no scripts: nothing can change after parsing. */
export function staticPage(): string {
  return (
    '<!doctype html><html lang="en"><head><title>Static</title>' +
    '<style>body{font-family:sans-serif;margin:4em auto;width:40em}</style></head><body>' +
    '<h1>Static page</h1><p>This page is fully rendered by the server and ships no scripts at all, ' +
    `so a browser has nothing left to wait for once the document is parsed. ${MARKERS.static}</p>` +
    '</body></html>'
  );
}

/**
 * An app shell: "Loading…" until a timer fires `delayMs` after parsing, then
 * the real content replaces it. No network activity is involved, so only the
 * DOM itself shows that the page is not done yet.
 */
export function delayedPage(delayMs = 800): string {
  return (
    '<!doctype html><html lang="en"><head><title>Delayed</title></head><body>' +
    '<div id="app"><span class="spinner"></span>Loading…</div>' +
    '<script>setTimeout(function () {' +
    "  document.getElementById('app').innerHTML = '<h1>Delayed content</h1><p>Rendered by a timer " +
    `long after DOMContentLoaded. ' + ${split(MARKERS.delayed)} + '</p>';` +
    `}, ${delayMs});</script></body></html>`
  );
}

/**
 * A long page whose second batch of items is only appended when an infinite
 * scroll sentinel at the bottom becomes visible, with lazily loaded images
 * (data-src swapped in by an IntersectionObserver).
 */
export function lazyPage(): string {
  const items = Array.from(
    { length: 12 },
    (_, i) =>
      `<article style="height:400px"><h2>Item ${i + 1}</h2><p>Description of item ${i + 1} in the first batch.</p>` +
      `<img data-src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="item ${i + 1}" width="1" height="1"></article>`,
  ).join('');
  return (
    '<!doctype html><html lang="en"><head><title>Lazy</title></head><body>' +
    `<main id="list">${items}</main><div id="sentinel" class="infinite-scroll-sentinel" style="height:10px"></div>` +
    '<script>' +
    'var imgObs = new IntersectionObserver(function (entries) { entries.forEach(function (e) {' +
    "  if (e.isIntersecting && e.target.dataset.src) { e.target.src = e.target.dataset.src; e.target.setAttribute('data-loaded-src', '1'); imgObs.unobserve(e.target); }" +
    '}); });' +
    "document.querySelectorAll('img[data-src]').forEach(function (img) { imgObs.observe(img); });" +
    'var loaded = false;' +
    'new IntersectionObserver(function (entries) {' +
    '  if (loaded || !entries.some(function (e) { return e.isIntersecting; })) return;' +
    '  loaded = true;' +
    "  var list = document.getElementById('list');" +
    `  for (var i = 0; i < 5; i++) { var a = document.createElement('article'); a.innerHTML = '<h2>More ' + i + '</h2><p>Second batch. ' + ${split(MARKERS.lazy)} + '</p>'; list.appendChild(a); }` +
    "}).observe(document.getElementById('sentinel'));" +
    '</script></body></html>'
  );
}

/**
 * A non-interactive JS challenge interstitial: "Just a moment...", then a
 * script-driven navigation to the real page after `delayMs`.
 */
export function jsChallengePage(target: string, delayMs = 1200): string {
  return (
    '<!doctype html><html lang="en"><head><title>Just a moment...</title></head><body>' +
    '<div id="challenge-running"><h1>Checking your browser before accessing the site.</h1>' +
    '<p>This process is automatic. Your browser will redirect to your requested content shortly.</p></div>' +
    `<script>setTimeout(function () { location.replace(${JSON.stringify(target)}); }, ${delayMs});</script>` +
    '</body></html>'
  );
}

export function challengeTargetPage(): string {
  return (
    '<!doctype html><html lang="en"><head><title>Real page</title></head><body>' +
    `<h1>Real content</h1><p>The challenge resolved itself and the browser landed here. ${MARKERS.challenge}</p>` +
    '</body></html>'
  );
}

/** Skeleton that fills itself from an API call answered after `delayMs`. */
export function fetchingPage(apiPath: string): string {
  return (
    '<!doctype html><html lang="en"><head><title>Fetching</title></head><body>' +
    '<h1>Dashboard</h1><p>Static header text that is long enough not to look like an empty app shell on its own.</p>' +
    '<div id="data" aria-busy="true"></div>' +
    `<script>fetch(${JSON.stringify(apiPath)}).then(function (r) { return r.text(); }).then(function (t) {` +
    "  var d = document.getElementById('data'); d.textContent = t; d.removeAttribute('aria-busy'); });</script>" +
    '</body></html>'
  );
}

export const FETCHED_BODY = `Data from the API. ${MARKERS.fetched}`;
