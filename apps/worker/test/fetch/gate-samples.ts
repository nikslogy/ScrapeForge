// Hand-labelled small responses for the T1 acceptance gate (isValidContent +
// calculateQualityScore, combined by router.ts assessTier). "accept" means a
// browser tier could not do better: the page is complete as served.
// "reject" means the response is a block page, challenge, stub or app shell
// that a browser (or nothing) must replace.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compactPage, smallPage } from '../../../../tests/latency/lib/fixtures.js';

export interface GateSample {
  id: string;
  label: 'accept' | 'reject';
  html: string;
  status?: number;
  /** Defaults to https://example.org/page */
  url?: string;
  why: string;
}

const challengePage = readFileSync(
  fileURLToPath(new URL('../../../../tests/fixtures/extraction/challenge-page/page.html', import.meta.url)),
  'utf8',
);

/** Pads with an HTML comment to exactly `bytes` characters (comments are invisible). */
function padTo(html: string, bytes: number): string {
  if (html.length > bytes) throw new Error(`sample longer than ${bytes}: ${html.length}`);
  const filler = bytes - html.length;
  if (filler === 0) return html;
  if (filler < 7) return html + ' '.repeat(filler);
  return html.replace('</head>', `<!--${'x'.repeat(filler - 7)}--></head>`);
}

const CSS = '<style>body{font-family:system-ui,sans-serif;margin:3em auto;max-width:42em;color:#222}' +
  'h1{font-size:1.6em}a{color:#36c}footer{color:#777;font-size:.8em}</style>';

function navItems(count: number): string {
  return Array.from(
    { length: count },
    (_, i) => `<li class="nav-item nav-item--level-1"><a class="nav-link" href="/c/${i}" data-track="nav-${i}">Dept ${i}</a></li>`,
  ).join('');
}

const NAV_ITEMS = navItems(120);

// Placeholder blocks of a skeleton screen: kilobytes of markup, no text.
const SKELETON = '<div class="Skeleton_block__k2P9d" aria-busy="true"><div class="Skeleton_line__w9E8r"></div></div>'.repeat(60);

// A product page's server-rendered state (~1.7 KB), as __NEXT_DATA__ ships it.
const NEXT_DATA = JSON.stringify({
  props: {
    pageProps: {
      product: {
        id: 'prod_8KfQ2mZx',
        name: 'Trail Tent 2',
        sku: 'TT2-GRN',
        price: { amount: 199, currency: 'USD', formatted: '$199.00' },
        images: Array.from({ length: 6 }, (_, i) => ({ src: `/media/tt2/${i}.jpg`, alt: `Trail Tent 2, view ${i + 1}`, width: 1600, height: 1200 })),
        variants: Array.from({ length: 6 }, (_, i) => ({ sku: `TT2-GRN-${i}`, size: `${i + 1}P`, available: i % 2 === 0 })),
        description: 'A two-person, three-season backpacking tent with two doors, two vestibules and a 1.4 kg trail weight.',
      },
    },
  },
  page: '/products/[handle]',
  buildId: 'k2Xq9mZ7pL4vB8nR1tY6w',
});

// Site-wide Organization markup, as many retailers ship on every page (~1.1 KB).
const ORG_JSONLD = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'Target',
  url: 'https://www.target.com',
  logo: 'https://www.target.com/logo.png',
  sameAs: Array.from({ length: 12 }, (_, i) => `https://social-network-${i}.example.com/target-official-account`),
  contactPoint: { '@type': 'ContactPoint', telephone: '+1-800-440-0680', contactType: 'customer service' },
});

export const GATE_SAMPLES: GateSample[] = [
  // ── accept ────────────────────────────────────────────
  { id: 'example-classic', label: 'accept', html: smallPage(), why: 'classic 1,256 B example.com: 190 chars of prose, CSS-heavy' },
  { id: 'example-compact', label: 'accept', html: compactPage(), why: 'compact example.com' },
  {
    id: 'example-japanese',
    label: 'accept',
    html: `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>例のドメイン</title>${CSS}</head><body><div><h1>例のドメイン</h1><p>このドメインは、文書の例示として使用するためのものです。事前の許可なく文献で使用できます。</p><p><a href="https://www.iana.org/domains/example">詳細情報…</a></p></div></body></html>`,
    why: 'short CJK page: few "words", but full sentences',
  },
  {
    id: 'personal-homepage',
    label: 'accept',
    html: `<!doctype html><html><head><title>Ada Lovelace</title>${CSS}</head><body><h1>Ada Lovelace</h1><p>I write about analytical engines, mathematics and poetry. I am currently working on notes for a translation of a paper on the engine.</p><ul><li><a href="/notes">Notes</a></li><li><a href="/contact">Contact</a></li></ul></body></html>`,
    why: 'tiny personal page',
  },
  {
    id: 'coming-soon',
    label: 'accept',
    html: `<!doctype html><html><head><title>Coming soon</title>${CSS}</head><body><main><h1>Coming soon</h1><p>We are launching our new online store this spring. Check back for updates.</p></main></body></html>`,
    why: 'placeholder site: thin but complete',
  },
  {
    id: 'apache-404',
    label: 'accept',
    status: 404,
    html: '<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN"><html><head><title>404 Not Found</title></head><body><h1>Not Found</h1><p>The requested URL was not found on this server.</p><hr><address>Apache/2.4.41 (Ubuntu) Server at example.org Port 443</address></body></html>',
    why: 'a real 404: a browser gets the same page',
  },
  {
    id: 'docs-snippet',
    label: 'accept',
    html: `<!doctype html><html><head><title>CLI reference: init</title>${CSS}</head><body><article><h1>init</h1><p>Creates a new project in the current directory.</p><pre><code>tool init --template minimal my-project</code></pre><h2>Options</h2><ul><li><code>--template</code> name of the starter template</li></ul></article></body></html>`,
    why: 'short reference page with code',
  },
  {
    id: 'with-analytics',
    label: 'accept',
    html: `<!doctype html><html><head><title>Opening hours</title>${CSS}<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXX"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','G-XXXX',{page_location:location.href});if(location.href===document.referrer){gtag('event','reload')}</script></head><body><h1>Opening hours</h1><p>Monday to Friday 9:00 to 17:30, Saturday 10:00 to 14:00. Closed on public holidays.</p></body></html>`,
    why: 'analytics scripts that read (not assign) location',
  },
  {
    id: 'mentions-challenge',
    label: 'accept',
    html: `<!doctype html><html><head><title>Weekly coding challenge #12</title>${CSS}</head><body><h1>Weekly coding challenge #12</h1><p>This week: write a function that merges overlapping intervals. Submissions close on Friday at noon.</p></body></html>`,
    why: 'the word "challenge" in prose is not a bot wall',
  },
  {
    id: 'jsonld-short',
    label: 'accept',
    html: `<!doctype html><html><head><title>Blue Mug</title><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Blue Mug","offers":{"price":"12.00","priceCurrency":"EUR","url":"https://example.org/mug"}}</script>${CSS}</head><body><h1>Blue Mug</h1><p>Stoneware mug, 350 ml, dishwasher safe.</p><p>Price: 12.00 EUR</p></body></html>`,
    why: 'structured-data script is data, not a redirect',
  },
  {
    id: 'facebook-pixel-noscript',
    label: 'accept',
    html: `<!doctype html><html><head><title>Bakery</title>${CSS}<noscript><img height="1" width="1" src="https://www.facebook.com/tr?id=1&ev=PageView&noscript=1"></noscript></head><body><h1>Corner Bakery</h1><p>Fresh sourdough every morning from seven. Order cakes two days in advance.</p></body></html>`,
    why: 'tracking pixel in noscript',
  },
  {
    id: 'json-body',
    label: 'accept',
    html: '{"status":"ok","items":[1,2,3]}',
    why: 'not HTML: a short JSON document is complete',
  },
  {
    id: 'plain-text-body',
    label: 'accept',
    html: 'User-agent: *\nDisallow: /admin\nSitemap: https://example.org/sitemap.xml\n',
    why: 'not HTML: robots.txt-like text',
  },
  {
    id: 'unclosed-header-link',
    label: 'accept',
    html: `<!doctype html><html><head><title>Opening times</title>${CSS}</head><body><header><a href="/">Town Library</header><main><h1>Opening times</h1><p>The library is open Tuesday to Saturday from ten until six, and until eight on Thursdays.</p></main></body></html>`,
    why: 'a sloppy unclosed <a> must not turn the page into "link text"',
  },
  {
    id: 'medium-article',
    label: 'accept',
    html: `<!doctype html><html><head><title>Notes</title>${CSS}</head><body><article><h1>Release notes 2.4</h1>${'<p>Fixed a crash when opening very large files, improved start-up time and reduced memory use on older devices. </p>'.repeat(14)}</article></body></html>`,
    why: '1.6 KB of text: plainly fine',
  },

  {
    id: 'next-skeleton-with-data',
    label: 'accept',
    html: `<!doctype html><html><head><title>Trail Tent 2</title><script src="/_next/static/chunks/main.js" defer></script></head><body><div id="__next">${SKELETON}<h1>Trail Tent 2</h1><p class="price">$199.00 — free shipping on orders over $50</p>${SKELETON}<footer><p>© 2026 Ridgeline Outdoor Co. Free returns within 60 days.</p></footer></div><noscript>You need to enable JavaScript to run this app.</noscript><script id="__NEXT_DATA__" type="application/json">${NEXT_DATA}</script></body></html>`,
    why: 'pre-hydration Next.js skeleton: little text, but the page data is server-rendered JSON',
  },
  {
    id: 'nuxt-data-short',
    label: 'accept',
    html: `<!doctype html><html><head><title>Opening hours</title></head><body><div id="__nuxt"><main><h1>Opening hours</h1><p>Monday to Friday from nine until half past five.</p></main></div><script type="application/json" id="__NUXT_DATA__" data-ssr="true">${NEXT_DATA}</script><script type="module" src="/_nuxt/entry.js"></script></body></html>`,
    why: 'server-rendered Nuxt page with its payload',
  },
  {
    id: 'captcha-key-in-page-data',
    label: 'accept',
    html: `<!doctype html><html><head><title>Contact</title></head><body><div id="__next"><main><h1>Contact us</h1><p>Write to hello@example.org and we answer within one working day.</p></main></div><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"recaptchaSiteKey":"6Lc_x","captchaEnabled":false}},"page":"/contact"}</script></body></html>`,
    why: 'a "captcha" config key inside JSON page data is not a captcha wall',
  },
  {
    id: 'ssr-react-with-noscript-notice',
    label: 'accept',
    html: `<!doctype html><html><head><title>Changelog</title><script defer src="/static/js/main.js"></script></head><body><noscript>You need to enable JavaScript to run this app.</noscript><div id="root"><main><h1>Changelog</h1><p>Version 3.2 adds dark mode, faster search and offline drafts for every workspace.</p></main></div></body></html>`,
    why: 'server-rendered React page: the standard noscript notice is not a block',
  },
  {
    id: 'article-hidden-browser-banner',
    label: 'accept',
    html: `<!doctype html><html><head><title>Pitching a tent in the rain</title>${CSS}</head><body><div id="browser-warning" style="display:none"><p>You are using an unsupported browser. Please update your browser for the best experience.</p></div><main><article><h1>Pitching a tent in the rain</h1>${'<p>Keep the inner tent packed inside the fly while you stake out the corners, then tension the guylines so water runs off.</p>'.repeat(14)}</article></main></body></html>`,
    why: 'a hidden browser-warning banner is not what the page says',
  },

  // ── reject ────────────────────────────────────────────
  {
    id: 'csr-shell-with-page-data',
    label: 'reject',
    html: `<!doctype html><html><head><title>Shop</title><script src="/_next/static/chunks/main.js" defer></script></head><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">${NEXT_DATA}</script></body></html>`,
    why: 'empty mount point: the data is there, but nothing was rendered (a browser renders it)',
  },
  {
    id: 'cloaked-nav-with-jsonld',
    label: 'reject',
    html: `<!doctype html><html><head><title>Target</title><script type="application/ld+json">${ORG_JSONLD}</script></head><body><header><nav><ul>${navItems(50)}</ul></nav></header><main id="mainContainer"></main><footer><p>© 2026 Target Brands, Inc. All rights reserved worldwide.</p></footer></body></html>`,
    why: 'site-wide JSON-LD does not rescue navigation around an empty main',
  },
  {
    id: 'visible-js-notice-with-data',
    label: 'reject',
    html: `<!doctype html><html><head><title>App</title></head><body><div class="notice"><h2>Please enable JavaScript to use this application.</h2><p>It will not work without it, sorry about that.</p></div><script type="application/json" id="config">${NEXT_DATA}</script></body></html>`,
    why: 'the visible text is only a JavaScript-required notice',
  },
  { id: 'cloudflare-challenge', label: 'reject', html: challengePage, why: '"Just a moment..." managed challenge (fixture)' },
  {
    id: 'cloudflare-blocked',
    label: 'reject',
    html: `<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title>${CSS}</head><body><div id="cf-wrapper"><h1>Sorry, you have been blocked</h1><h2>You are unable to access example.org</h2><p>This website is using a security service to protect itself from online attacks.</p><p>Cloudflare Ray ID: 8c2f1a9e4b7d3f21</p></div></body></html>`,
    why: 'Cloudflare WAF block',
  },
  {
    id: 'akamai-access-denied',
    label: 'reject',
    html: '<HTML><HEAD>\n<TITLE>Access Denied</TITLE>\n</HEAD><BODY>\n<H1>Access Denied</H1>\n \nYou don\'t have permission to access "http&#58;&#47;&#47;www&#46;example&#46;org&#47;" on this server.<P>\nReference&#32;&#35;18&#46;5f2e3b17&#46;1728304459&#46;2a1b3c4d\n</BODY>\n</HTML>\n',
    why: 'Akamai edge block at HTTP 200',
  },
  {
    id: 'walmart-stub-walmart-url',
    label: 'reject',
    url: 'https://www.walmart.com/ip/123',
    html: padTo(
      '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Walmart.com</title></head><body><script>window.location.replace("/blocked?url=L2lwLzEyMw==&uuid=9f1c2a7e&vid=&g=b")</script></body></html>',
      423,
    ),
    why: '423-char cloaked stub on a content-heavy domain',
  },
  {
    id: 'walmart-stub-other-url',
    label: 'reject',
    html: padTo(
      '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Shop</title></head><body><script>window.location.replace("/blocked?url=L2lwLzEyMw==&uuid=9f1c2a7e&vid=&g=b")</script></body></html>',
      423,
    ),
    why: 'same stub shape on an unknown domain: no text, navigates away',
  },
  {
    id: 'cra-shell',
    label: 'reject',
    html: '<!doctype html><html lang="en"><head><meta charset="utf-8"/><title>React App</title><script defer="defer" src="/static/js/main.4f8a1b2c.js"></script><link href="/static/css/main.9d8e7f6a.css" rel="stylesheet"></head><body><noscript>You need to enable JavaScript to run this app.</noscript><div id="root"></div></body></html>',
    why: 'empty create-react-app shell',
  },
  {
    id: 'vue-shell-with-chrome',
    label: 'reject',
    html: `<!doctype html><html><head><title>Shop</title>${CSS}<script type="module" src="/assets/index-3f2a1b.js"></script></head><body><header><a href="/">Acme Outdoor Supply Company</a></header><div id="app"></div><footer>© 2026 Acme Outdoor Supply Company. All rights reserved.</footer></body></html>`,
    why: 'SPA shell with header/footer text around an empty mount point',
  },
  {
    id: 'loading-shell',
    label: 'reject',
    html: '<!doctype html><html><head><title>Dashboard</title><script src="/app.js" defer></script></head><body><div class="app"><div class="spinner"></div><p>Loading…</p></div></body></html>',
    why: 'app shell showing a spinner',
  },
  {
    id: 'datadome-captcha',
    label: 'reject',
    html: `<html><head><title>example.org</title><style>#cmsg{animation: A 1.5s;}@keyframes A{0%{opacity:0;}99%{opacity:0;}100%{opacity:1;}}</style></head><body style="margin:0"><p id="cmsg">Please enable JS and disable any ad blocker</p><script data-cfasync="false">var dd={'rt':'c','cid':'AHrlqAAAAAMA1x2y3z','hsh':'2211F522B61E269B869FA6EAFFB5E1','t':'fe','s':17434,'e':'abc','host':'geo.captcha-delivery.com'}</script><script data-cfasync="false" src="https://ct.captcha-delivery.com/c.js"></script></body></html>`,
    why: 'DataDome interstitial',
  },
  {
    id: 'perimeterx-press-hold',
    label: 'reject',
    html: `<!DOCTYPE html><html lang="en"><head><title>Access to this page has been denied.</title>${CSS}</head><body><div class="px-container"><h1>Before we continue...</h1><p>Press &amp; Hold to confirm you are a human (and not a bot).</p><div id="px-captcha"></div></div><script src="/px/client/main.min.js"></script></body></html>`,
    why: 'PerimeterX press-and-hold',
  },
  {
    id: 'amazon-captcha',
    label: 'reject',
    html: `<!doctype html><html><head><title>Amazon.com</title>${CSS}</head><body><div class="a-container"><h4>Enter the characters you see below</h4><p class="a-last">Sorry, we just need to make sure you're not a robot. For best results, please make sure your browser is accepting cookies.</p><form method="get" action="/errors/validateCaptcha" name=""><input type=hidden name="amzn" value="abc"><img src="https://images-na.ssl-images-amazon.com/captcha/xyz/Captcha_abc.jpg"><input autocomplete="off" spellcheck="false" placeholder="Type characters" id="captchacharacters" name="field-keywords" type="text"><button type="submit">Continue shopping</button></form></div></body></html>`,
    why: 'Amazon robot check',
  },
  {
    id: 'google-sorry',
    label: 'reject',
    html: `<html><head><meta http-equiv="content-type" content="text/html; charset=utf-8"><title>https://www.google.com/search?q=x</title></head><body><div><b>About this page</b><br><br>Our systems have detected unusual traffic from your computer network. This page checks to see if it's really you sending the requests, and not a robot.<br><br><div id="infoDiv0">This page appears when Google automatically detects requests coming from your computer network which appear to be in violation of the Terms of Service.</div></div></body></html>`,
    why: 'Google "unusual traffic" sorry page',
  },
  {
    id: 'incapsula-stub',
    label: 'reject',
    html: '<html style="height:100%"><head><META NAME="ROBOTS" CONTENT="NOINDEX, NOFOLLOW"><meta name="format-detection" content="telephone=no"><meta name="viewport" content="initial-scale=1.0"><meta http-equiv="X-UA-Compatible" content="IE=edge,chrome=1"><script type="text/javascript" src="/_Incapsula_Resource?SWJIYLWA=5074a744e2e3d891814e9a2dace20bd4,719d34d31c8e3a6e6fffd425f7e032f3"></script></head><body style="margin:0px;height:100%"><iframe id="main-iframe" src="/_Incapsula_Resource?CWUDNSAI=9&xinfo=1-2-3" frameborder=0 width="100%" height="100%" marginheight="0px" marginwidth="0px">Request unsuccessful. Incapsula incident ID: 1234</iframe></body></html>',
    why: 'Imperva/Incapsula iframe stub',
  },
  {
    id: 'distil-pardon',
    label: 'reject',
    html: `<!DOCTYPE html><html><head><title>Pardon Our Interruption</title>${CSS}</head><body><div class="container"><h1>Pardon Our Interruption</h1><p>As you were browsing something about your browser made us think you were a bot. There are a few reasons this might happen.</p></div></body></html>`,
    why: 'Distil/Imperva bot wall',
  },
  {
    id: 'meta-refresh-challenge',
    label: 'reject',
    html: '<!doctype html><html><head><meta http-equiv="refresh" content="0; url=/challenge?token=a1b2c3"><title>Redirecting</title></head><body><p>Redirecting…</p></body></html>',
    why: 'instant meta refresh to a challenge',
  },
  {
    id: 'cookie-reload-stub',
    label: 'reject',
    html: '<!doctype html><html><head><title>Please wait</title></head><body><p>One moment while we check your connection to the site, please wait.</p><script>document.cookie="bm_sv=7f3a9c; path=/";location.reload();</script></body></html>',
    why: 'sets a cookie and reloads (sensor/challenge stub)',
  },
  {
    id: 'aws-waf-challenge',
    label: 'reject',
    html: '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title></title><script type="text/javascript" src="https://a1b2c3.edge.sdk.awswaf.com/a1b2c3/challenge.js"></script></head><body><div id="challenge-container"></div><script>AwsWafIntegration.checkForceRefresh().then(function(){AwsWafIntegration.getToken().then(function(){window.location.reload(true)})})</script><noscript><h1>JavaScript is disabled</h1>In order to continue, we need to verify that you\'re not a robot.</noscript></body></html>',
    why: 'AWS WAF JS challenge',
  },
  {
    id: 'akamai-sec-cpt',
    label: 'reject',
    html: '<!DOCTYPE html><html lang="en"><head><title>Please wait</title><script src="/_sec/cp_challenge/sec-cpt-int-4-3.js" async defer></script></head><body><div id="sec-if-cpt-container"><div class="sec-container"><p>Please wait while we verify your browser.</p></div></div></body></html>',
    why: 'Akamai sec-cpt interstitial',
  },
  {
    id: 'kasada-empty',
    label: 'reject',
    html: '<!DOCTYPE html><html><head><script src="/149e9513-01fa-4fb0-aad4-566afd725d1b/2d206a39-8ed7-437e-a3be-862e0f06eea3/ips.js?tkrm_alpekz_s1.3=0abc" async></script></head><body></body></html>',
    why: 'empty body + bot script',
  },
  {
    id: 'rate-limited-429',
    label: 'reject',
    status: 429,
    html: '<!doctype html><html><head><title>Too Many Requests</title></head><body><h1>Too Many Requests</h1><p>You have sent too many requests in a given amount of time.</p></body></html>',
    why: 'HTTP 429',
  },
  {
    id: 'service-unavailable-503',
    label: 'reject',
    status: 503,
    html: '<!doctype html><html><head><title>Service Unavailable</title></head><body><h1>Service Unavailable</h1><p>The server is temporarily unable to service your request due to maintenance downtime or capacity problems.</p></body></html>',
    why: 'HTTP 503',
  },
  { id: 'whitespace-body', label: 'reject', html: '   \n\t  \r\n ', why: 'nothing but whitespace' },
  { id: 'empty-body', label: 'reject', html: '', why: 'empty response' },
  {
    id: 'cloaked-nav-footer',
    label: 'reject',
    html: `<!doctype html><html><head><title>Target : Expect More. Pay Less.</title>${CSS}</head><body><header><nav><ul>${NAV_ITEMS}</ul></nav></header><main id="mainContainer" class="h-padding-h-default"></main><footer><p>© 2026 Target Brands, Inc. Target, the Bullseye Design and Bullseye Dog are trademarks of Target Brands, Inc.</p></footer></body></html>`,
    why: '18 KB of navigation around an empty main: cloaked 200-OK',
  },
  {
    id: 'unsupported-browser',
    label: 'reject',
    html: `<!doctype html><html><head><title>Unsupported browser</title>${CSS}</head><body><h1>Your browser is not supported</h1><p>Please update your browser to the latest version of Chrome, Firefox, Safari or Edge to continue.</p></body></html>`,
    why: 'served to unknown TLS/UA fingerprints; a real browser gets the site',
  },
  {
    id: 'bot-stub-enable-js',
    label: 'reject',
    html: `<!doctype html><html><head><title>Shop</title>${CSS}</head><body><h1>Please enable JavaScript to view the page content.</h1><p>Your support ID is: 12345678901234567890.</p></body></html>`,
    why: '"please enable javascript" stub',
  },
  {
    id: 'spa-shell-custom-mount-with-chrome',
    label: 'reject',
    html: `<!doctype html><html lang="en"><head><title>Trail Tent 2 – Acme Outdoor</title>${CSS}<script type="module" crossorigin src="/assets/index-3f2a1b.js"></script></head><body><header class="site-header"><a class="logo" href="/">Acme Outdoor Supply Company</a><nav><a href="/tents">Tents</a><a href="/packs">Packs</a><a href="/sale">Sale</a></nav></header><div id="product-app"></div><footer class="site-footer"><p>© 2026 Acme Outdoor Supply Company. All rights reserved.</p></footer></body></html>`,
    why: 'only header/footer text around a mount point the scorer does not know by name',
  },
  {
    id: 'spa-shell-spinner-in-root',
    label: 'reject',
    html: `<!doctype html><html lang="en"><head><title>Acme Outdoor</title>${CSS}<script defer src="/static/js/main.js"></script></head><body><header><a href="/">Acme Outdoor Supply Company</a></header><div id="root"><div class="spinner" role="progressbar"></div></div><footer>© 2026 Acme Outdoor Supply Company. All rights reserved.</footer></body></html>`,
    why: 'SPA mount point showing a spinner, chrome around it',
  },
  {
    id: 'tr-csr-shell-dotted-capital-i',
    label: 'reject',
    html: `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>İstanbul Mağaza</title><script>window.__APP_CONFIG__ = ${JSON.stringify({ api: 'https://api.magaza.example/v2', locale: 'tr-TR', features: Array.from({ length: 40 }, (_, i) => `feature_flag_number_${i}`) })};</script><script src="/static/js/main.js" defer></script></head><body><noscript>Bu uygulamayı çalıştırmak için JavaScript'i etkinleştirmeniz gerekir.</noscript><div id="root"></div></body></html>`,
    why: '"İ" lower-cases to two characters; the scanner must not misplace the script ends',
  },
];
