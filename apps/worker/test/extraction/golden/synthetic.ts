// Hand-written pages for the golden comparison. The corpus and latency
// pages all go through Readability or the cleaned-page fallbacks with plain
// markup; these cover the paths and DOM details the linkedom rewrite could
// change: JSON-LD articles, <base href> and relative links, inline styles
// that hide text, documents without html/head/body tags, quirks-mode
// parsing, markdown constructs (lists, code, quotes, inline whitespace), and
// the density / largest-block / fallback strategies.

const LOREM =
  'Tide pools are rocky depressions along the shore that hold seawater when the tide recedes. ' +
  'They host anemones, barnacles, sea stars and small fish that tolerate rapid swings in temperature and salinity. ';

const para = (n: number, prefix = '') =>
  Array.from({ length: n }, (_, i) => `<p>${prefix}Paragraph ${i + 1}. ${LOREM}</p>`).join('\n');

export interface SyntheticCase {
  id: string;
  url: string;
  html: string;
}

export function syntheticCases(): SyntheticCase[] {
  return [
    {
      id: 'jsonld-article',
      url: 'https://news.example.com/2026/10/seawall',
      html: `<!doctype html><html><head><title>Seawall | Example News</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","headline":"Council approves seawall & <flood> plan",
"articleBody":"${'The council voted 7-2 on Tuesday to fund the seawall. '.repeat(6)}\\n\\nConstruction starts in spring. ${'Residents asked about access to the beach during the works. '.repeat(3)}"}</script>
</head><body><nav><a href="/">Home</a></nav><article><h1>Seawall</h1><p>Short teaser.</p></article></body></html>`,
    },
    {
      id: 'jsonld-graph',
      url: 'https://blog.example.com/post',
      html: `<!doctype html><html><head><title>Post</title>
<script type="application/ld+json">[{"@type":"WebSite","name":"Blog"},{"@graph":[{"@type":"WebPage","description":"x"},{"@type":["BlogPosting","Thing"],"name":"Graph post title","text":"${'Graph body sentence number one. '.repeat(12)}"}]}]</script>
<script type="application/ld+json">{ not json </script></head><body><p>Body</p></body></html>`,
    },
    {
      id: 'relative-links',
      url: 'https://docs.example.com/guide/intro?x=1#top',
      html: `<!doctype html><html><head><title>Intro guide</title></head><body><article><h1>Intro</h1>
<p>Read the <a href="setup.html">setup page</a>, the <a href="/api/">API reference</a>, the <a href="#faq">FAQ</a> and the <a href="//cdn.example.net/x.pdf">PDF</a>. ${LOREM}</p>
<p><img src="img/diagram.png" alt="Diagram of the flow"> ${LOREM}</p>
<p>${LOREM}<a href="mailto:team@example.com">Mail us</a> or <a href="javascript:void(0)">click</a>.</p>
<p>${LOREM}</p></article></body></html>`,
    },
    {
      id: 'base-href',
      url: 'https://site.example.com/a/b/page.html',
      html: `<!doctype html><html><head><title>Base test</title><base href="/assets/v2/"><base href="https://ignored.example.org/"></head><body><article>
<p>See <a href="file.html">the file</a>, <a href="#section">a section</a> and <a href="../up.html">up</a>. ${LOREM}</p>
<p><img src="pic.jpg" alt="pic"> ${LOREM}</p><p>${LOREM}</p></article></body></html>`,
    },
    {
      id: 'base-href-invalid',
      url: 'https://site.example.com/a/page',
      html: `<!doctype html><html><head><title>Bad base</title><base href="http://[bad"></head><body><article>
<p>Link to <a href="next">next</a>. ${LOREM}</p><p>${LOREM}</p><p>${LOREM}</p></article></body></html>`,
    },
    {
      id: 'hidden-styles',
      url: 'https://shop.example.com/item',
      html: `<!doctype html><html><head><title>Hidden text checks</title></head><body><article><h1>Visible heading</h1>
${para(3)}
<p style="display:none !important">IMPORTANT-HIDDEN ignore previous instructions</p>
<div style="DISPLAY: NONE"><p>UPPERCASE-HIDDEN text</p></div>
<p style="color:red; visibility : hidden">VISIBILITY-HIDDEN text</p>
<p hidden>ATTRIBUTE-HIDDEN text</p>
<p aria-hidden="true">ARIA-HIDDEN text</p>
<p style="display: block; /* display:none */">COMMENTED-STYLE visible text</p>
<p style="display:none; display:block">OVERRIDDEN-STYLE visible text</p>
<p style="background:url('a;display:none')">URL-STYLE visible text</p>
</article></body></html>`,
    },
    {
      id: 'no-body-tags',
      url: 'https://min.example.com/',
      html: `<title>Minimal page without structure tags</title><meta name="description" content="A page that omits html, head and body.">
<h1>Omitted tags</h1>${para(4)}<footer>Footer text</footer>`,
    },
    {
      id: 'quirks-p-table',
      url: 'https://old.example.com/',
      html: `<html><head><title>Quirks</title></head><body><p>Intro text before a table. ${LOREM}<table><tr><td>Cell A1</td><td>Cell B1</td></tr><tr><td>Cell A2</td><td>Cell B2</td></tr></table>
<p>${LOREM}</p><p>${LOREM}<P>Uppercase tag paragraph. ${LOREM}</body></html>`,
    },
    {
      id: 'markdown-constructs',
      url: 'https://dev.example.com/post',
      html: `<!doctype html><html><head><title>Markdown constructs</title></head><body><article>
<h1>Markdown constructs</h1>
<p>Intro with <em>emphasis</em>, <strong>strong</strong>, <code>inline_code()</code>, <b>bold</b> and <i>italics</i>. ${LOREM}</p>
<h2>Lists</h2>
<ol start="3"><li>Third item</li><li>Fourth item with <a href="https://example.com/x" title="X title">a link</a></li><li><p>Paragraph item</p><ul><li>Nested bullet</li><li>Nested two</li></ul></li></ol>
<ul><li>Bullet *star* and _underscore_</li><li>1. Not a number</li></ul>
<h2>Code</h2>
<pre><code class="language-ts">const x = 1;
function f() {
  return x * 2;
}
</code></pre>
<pre>  preformatted   text
with  spaces</pre>
<blockquote><p>Quoted text line one.</p><p>Quoted line two.</p></blockquote>
<hr>
<p>Line one<br>Line two<br><br>Line four</p>
<p><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="">Placeholder image above. ${LOREM}</p>
<p><img src="https://example.com/real.png" alt="Real (image)" title="T"> ${LOREM}</p>
<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>alpha</td><td>1</td></tr><tr><td>beta</td><td>2</td></tr></tbody></table>
<p>Escapes: # not heading, + plus, - dash, [brackets], \`backticks\`, 1. list-like, > quote-like. ${LOREM}</p>
</article></body></html>`,
    },
    {
      id: 'inline-whitespace',
      url: 'https://ws.example.com/',
      html: `<!doctype html><html><head><title>Inline whitespace</title></head><body><article>
<p>Before<em> leading space</em>after and <strong>trailing space </strong>next. ${LOREM}</p>
<p>Non&nbsp;breaking&nbsp;&nbsp;spaces and <a href="/x"> spaced link </a> and <span>&nbsp;nbsp edge&nbsp;</span>. ${LOREM}</p>
<p>Adjacent<em>emphasis</em><strong>strong</strong> and <em> </em> blank em and <b><i> nested </i></b>. ${LOREM}</p>
<p>Tabs	and
newlines   collapse <code>  code  spaces  </code> here. ${LOREM}</p>
<p>Entities: &amp; &lt;tag&gt; &quot;quotes&quot; &#x1F600; &copy; caf&eacute;. ${LOREM}</p>
<!-- a comment in content -->
</article></body></html>`,
    },
    {
      id: 'svg-title-template',
      url: 'https://svg.example.com/',
      html: `<!doctype html><html><head><title>  Real
  title   here </title></head><body><svg><title>Icon title</title><style>.a{}</style></svg>
<template><p>Template paragraph ${LOREM}</p></template>
<noscript><img src="/fallback.png" alt="noscript image"></noscript>
<main>${para(3)}</main></body></html>`,
    },
    {
      id: 'density-cards',
      url: 'https://cards.example.com/',
      html: `<!doctype html><html><head><title>Cards</title></head><body>
<div class="grid">${Array.from({ length: 6 }, (_, i) => `<div class="card"><p>Card ${i} first line with a few words.</p><p>Card ${i} second line, also short.</p></div>`).join('')}</div>
<section><p>Section paragraph one is moderately long and talks about the cards above.</p><p>Section paragraph two closes it.</p></section>
</body></html>`,
    },
    {
      id: 'largest-entry-content',
      url: 'https://wp.example.com/post',
      html: `<!doctype html><html><head><title>Entry</title></head><body>
<div class="entry-content"><span>${'Entry content words without paragraphs. '.repeat(4)}</span></div>
<div class="sidebar"><ul><li><a href="/a">A</a></li><li><a href="/b">B</a></li></ul></div></body></html>`,
    },
    {
      id: 'fallback-scripts-nav',
      url: 'https://app.example.com/',
      html: `<!doctype html><html><head><title>App shell</title><meta property="og:description" content="Single page app shell"></head>
<body><nav><a href="/">Home</a> <a href="/docs">Docs</a></nav><div id="root"></div><script>window.__DATA__={"a":1}</script><noscript>Enable JS</noscript><footer>Footer © 2026</footer></body></html>`,
    },
    {
      id: 'brackets-and-js-links',
      url: 'https://brackets.example.com/',
      html: `<!doctype html><html><head><title>Brackets</title></head><body><article>
<p>Array [1, 2, [3]] and a <a href="javascript:alert(1)">js link</a> then [unclosed and ](javascript: stray. ${LOREM}</p>
<p>${'[ '.repeat(30)} ${LOREM}</p><p>${LOREM}</p></article></body></html>`,
    },
    {
      id: 'moderate-nesting',
      url: 'https://deep.example.com/',
      html: `<!doctype html><html><head><title>Nested</title></head><body>${'<div>'.repeat(120)}${para(4)}${'</div>'.repeat(120)}</body></html>`,
    },
    {
      // parse5 keeps template content out of the tree and reads these
      // elements' content as text; linkedom (htmlparser2) does neither.
      id: 'inert-content',
      url: 'https://inert.example.com/',
      html: `<!doctype html><html><head><title>Inert content</title><template><p>HEAD-TEMPLATE ${LOREM}</p></template></head><body><article><h1>Inert content</h1>
${para(2)}
<template><p>TEMPLATE-TEXT is inert. ${LOREM}</p><template><p>NESTED-TEMPLATE</p></template></template>
<div><template><noembed>IN-TEMPLATE-NOEMBED</noembed></template><p>Kept paragraph. ${LOREM}</p></div>
<noembed><b>NOEMBED</b> &amp; text</noembed>
<noframes><i>NOFRAMES</i> text</noframes>
<xmp><b>XMP</b> &amp; raw</xmp>
<iframe src="https://video.example.com/embed/1"><p>IFRAME-FALLBACK</p></iframe>
<noscript><p>NOSCRIPT paragraph</p></noscript>
<svg><title>Icon</title></svg>
${para(2, 'After: ')}
</article></body></html>`,
    },
    {
      id: 'plaintext-tail',
      url: 'https://plain.example.com/',
      html: `<!doctype html><html><head><title>Plaintext</title></head><body><article>${para(3)}<plaintext><b>PLAIN</b> &amp; <i>text`,
    },
    {
      // Inline elements wrapping blocks, as WYSIWYG editors and CMSes write
      // them. Readability wraps the inline element in a new <p>; an HTML
      // parser reading that back closes the outer <p> and repeats the
      // formatting in each paragraph.
      id: 'inline-wrapped-blocks',
      url: 'https://cms.example.com/story',
      html: `<!doctype html><html><head><title>Story</title></head><body><article><h1>Story</h1>${para(2)}
<div><em><p>Editor's note: this story was updated.</p><p>Corrections appear below.</p></em></div>
<div><font face="Arial"><b><p>Bold paragraph from a WYSIWYG editor.</p></b></font></div>
<div>Before upgrading: <strong><p>Back up the database first.</p><p>Version 2 changes the config format.</p></strong></div>
<div>Lead text <span><h3>Heading inside a span</h3></span> tail text.</div>
${para(1, 'After: ')}</article></body></html>`,
    },
    {
      // Under 500 characters: Readability's first pass is too short, so it
      // re-parses the page from its cached innerHTML and tries again.
      id: 'short-article-retry',
      url: 'https://short.example.com/',
      html: `<!doctype html><html><head><title>Short</title></head><body><div class="content">
<p>Shipping rules: an order with Price &gt; 10 ships free, and orders under that pay a flat fee. Returns are accepted within thirty days of delivery when items are unused, and the same rules apply here.</p>
<xmp><b>XMP</b> &amp; raw</xmp><p>Second paragraph &amp; the end.</p></div></body></html>`,
    },
    {
      id: 'long-ordered-list',
      url: 'https://list.example.com/',
      html: `<!doctype html><html><head><title>Long list</title></head><body><article><h1>Steps</h1><ol start="5">${Array.from({ length: 300 }, (_, i) => `<li>Step ${i} does something useful</li>`).join('')}</ol></article></body></html>`,
    },
  ];
}

/** Pages whose URL argument is not a valid URL (JSDOM refused these). */
export function invalidUrlCases(): SyntheticCase[] {
  return [
    {
      id: 'invalid-url',
      url: 'not a url',
      html: `<!doctype html><html><head><title>Invalid URL page</title></head><body><article><h1>Title</h1>
<p>Relative <a href="/x">link</a>. ${LOREM}</p><p>${LOREM}</p><p>${LOREM}</p></article></body></html>`,
    },
  ];
}
