// Realistic page fixtures for recipe tests (books.toscrape-style markup).

export const BASE_URL = 'https://books.example.com/catalogue/page-1.html';

const TITLES = [
  'A Light in the Attic', 'Tipping the Velvet', 'Soumission', 'Sharp Objects', 'Sapiens: A Brief History of Humankind',
  'The Requiem Red', 'The Dirty Little Secrets of Getting Your Dream Job', 'The Coming Woman', 'The Boys in the Boat',
  'The Black Maria', 'Starving Hearts', "Shakespeare's Sonnets", 'Set Me Free', "Scott Pilgrim's Precious Little Life",
  'Rip it Up and Start Again', 'Our Band Could Be Your Life', 'Olio', 'Mesaerion: The Best Science Fiction Stories',
  'Libertarianism for Beginners', "It's Only the Himalayas",
];
const RATINGS = ['Three', 'One', 'One', 'Four', 'Five', 'One', 'Four', 'Three', 'Four', 'One', 'Two', 'Four', 'Five', 'Five', 'Five', 'Three', 'One', 'One', 'Two', 'Two'];

export interface Book {
  title: string;
  short: string;
  price: string;
  rating: string;
  href: string;
  img: string;
  inStock: boolean;
}

export function books(n = 20): Book[] {
  return Array.from({ length: n }, (_, i) => {
    const title = TITLES[i % TITLES.length] + (i >= TITLES.length ? ` ${Math.floor(i / TITLES.length) + 1}` : '');
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return {
      title,
      short: title.length > 30 ? `${title.slice(0, 27)}...` : title,
      price: `£${(10 + ((i * 7.31) % 50)).toFixed(2)}`,
      rating: RATINGS[i % RATINGS.length],
      href: `${slug}_${1000 - i}/index.html`,
      img: `../media/cache/${(i * 2654435761 % 0xffffff).toString(16)}/${slug}.jpg`,
      inStock: i % 7 !== 3,
    };
  });
}

/** Listing page: 20 product cards inside ol.row > li, plus page chrome. */
export function listingHtml(items: Book[] = books()): string {
  const cards = items
    .map(
      (b) => `
      <li class="col-xs-6 col-sm-4 col-md-3 col-lg-3">
        <article class="product_pod">
          <div class="image_container">
            <a href="${b.href}"><img src="${b.img}" alt="${b.title}" class="thumbnail"></a>
          </div>
          <p class="star-rating ${b.rating}">
            <i class="icon-star"></i><i class="icon-star"></i><i class="icon-star"></i>
          </p>
          <h3><a href="${b.href}" title="${b.title}">${b.short}</a></h3>
          <div class="product_price">
            <p class="price_color">${b.price}</p>
            <p class="${b.inStock ? 'instock' : 'outofstock'} availability">
              <i class="icon-${b.inStock ? 'ok' : 'remove'}"></i>
              ${b.inStock ? 'In stock' : 'Out of stock'}
            </p>
            <form><button type="submit" class="btn btn-primary btn-block" data-loading-text="Adding...">Add to basket</button></form>
          </div>
        </article>
      </li>`,
    )
    .join('');
  return `<!DOCTYPE html>
<html lang="en-us">
<head>
  <title>All products | Books to Scrape - Sandbox</title>
  <meta name="description" content="">
  <link rel="stylesheet" href="../static/oscar/css/styles.css">
  <script>var x = "£51.77 A Light in the Attic";</script>
</head>
<body id="default" class="default">
  <header class="header container-fluid">
    <div class="page_inner"><div class="row"><div class="col-sm-8 h1"><a href="../index.html">Books to Scrape</a></div></div></div>
  </header>
  <div class="container-fluid page">
    <div class="page_inner">
      <ul class="breadcrumb"><li><a href="../index.html">Home</a></li><li class="active">All products</li></ul>
      <div class="row">
        <aside class="sidebar col-sm-4 col-md-3"><div class="side_categories"><ul class="nav nav-list"><li><a href="category/books_1/index.html">Books</a></li></ul></div></aside>
        <div class="col-sm-8 col-md-9">
          <div class="page-header action"><h1>All products</h1></div>
          <form method="get" class="form-horizontal"><strong>1000</strong> results - showing <strong>1</strong> to <strong>${items.length}</strong>.</form>
          <section>
            <div><ol class="row">${cards}
            </ol>
            <div><ul class="pager"><li class="current">Page 1 of 50</li><li class="next"><a href="page-2.html">next</a></li></ul></div>
            </div>
          </section>
        </div>
      </div>
    </div>
  </div>
  <footer class="footer container-fluid"><p>Footer £51.77</p></footer>
</body>
</html>`;
}

/** Raw values a grounded extraction would report for a listing card. */
export function listingSample(b: Book, base = BASE_URL): Record<string, string | null> {
  return {
    title: b.title,
    price: b.price,
    availability: b.inStock ? 'In stock' : 'Out of stock',
    rating: b.rating,
    url: new URL(b.href, base).href,
  };
}

export const PDP_URL = 'https://books.example.com/catalogue/a-light-in-the-attic_1000/index.html';

/** Product detail page. Price only appears inside "Price: £51.77"; rating only as a class token. */
export function pdpHtml(opts: { title?: string; price?: string; rating?: string; upc?: string; stock?: number } = {}): string {
  const title = opts.title ?? 'A Light in the Attic';
  const price = opts.price ?? '£51.77';
  const rating = opts.rating ?? 'Three';
  const upc = opts.upc ?? 'a897fe39b1053632';
  const stock = opts.stock ?? 22;
  return `<!DOCTYPE html>
<html lang="en-us">
<head>
  <title>${title} | Books to Scrape - Sandbox</title>
  <meta property="og:title" content="${title}">
  <script type="application/ld+json">{"@type":"Product","name":"${title}"}</script>
</head>
<body id="default" class="default">
  <header class="header container-fluid"><div class="col-sm-8 h1"><a href="../../index.html">Books to Scrape</a></div></header>
  <div class="container-fluid page">
    <div class="page_inner">
      <ul class="breadcrumb">
        <li><a href="../../index.html">Home</a></li>
        <li><a href="../category/books/poetry_23/index.html">Poetry</a></li>
        <li class="active">${title}</li>
      </ul>
      <article class="product_page">
        <div class="row">
          <div class="col-sm-6"><div id="product_gallery" class="carousel"><div class="thumbnail"><div class="carousel-inner"><div class="item active"><img src="../../media/cache/fe/72/fe72f0532301ec28892ae79a629a293c.jpg" alt="${title}"></div></div></div></div></div>
          <div class="col-sm-6 product_main">
            <h1>${title}</h1>
            <p class="price">Price: ${price}</p>
            <p class="instock availability"><i class="icon-ok"></i> In stock (${stock} available)</p>
            <p class="star-rating ${rating}"><i class="icon-star"></i><i class="icon-star"></i></p>
          </div>
        </div>
        <div id="product_description" class="sub-header"><h2>Product Description</h2></div>
        <p>It's hard to imagine a world without ${title}. This now-classic collection of poetry and drawings is a treasure.</p>
        <div class="sub-header"><h2>Product Information</h2></div>
        <table class="table table-striped">
          <tr><th>UPC</th><td>${upc}</td></tr>
          <tr><th>Product Type</th><td>Books</td></tr>
          <tr><th>Tax</th><td>£0.00</td></tr>
          <tr><th>Number of reviews</th><td>0</td></tr>
        </table>
      </article>
    </div>
  </div>
</body>
</html>`;
}

export function pdpSample(opts: { title?: string; price?: string; rating?: string; upc?: string; stock?: number } = {}): Record<string, string | null> {
  const title = opts.title ?? 'A Light in the Attic';
  return {
    title,
    price: opts.price ?? '£51.77',
    rating: opts.rating ?? 'Three',
    upc: opts.upc ?? 'a897fe39b1053632',
    stock: String(opts.stock ?? 22),
    description: `It's hard to imagine a world without ${title}. This now-classic collection of poetry and drawings is a treasure.`,
  };
}
