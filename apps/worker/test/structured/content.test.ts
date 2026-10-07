import { describe, expect, it } from 'vitest';
import { extractFromStructuredData } from '../../src/extract/structured/index.js';
import { ld, makeDoc, makeSchema, meta, og, raws } from './helpers.js';

describe('Book', () => {
  const book = {
    '@context': 'https://schema.org',
    '@type': 'Book',
    name: 'The Left Hand of Darkness',
    author: { '@type': 'Person', name: 'Ursula K. Le Guin' },
    isbn: '978-0-441-47812-5',
    numberOfPages: 304,
    bookFormat: 'https://schema.org/Paperback',
    inLanguage: 'en',
    publisher: { '@type': 'Organization', name: 'Ace Books' },
    datePublished: '1969-03-01',
    genre: ['Science fiction', 'Feminist fiction'],
    offers: { '@type': 'Offer', price: '9.99', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
  };

  it('maps book fields, including identifiers checked for shape', () => {
    const res = extractFromStructuredData(
      makeDoc({
        text: 'The Left Hand of Darkness\n\nby Ursula K. Le Guin\n\nPaperback, 304 pages\n\nPublished March 1969 by Ace Books\n\n$9.99',
        items: [ld(book)],
      }),
      makeSchema([
        'title',
        'author',
        'isbn',
        { name: 'pages', type: 'integer' },
        'format',
        'publisher',
        'publicationDate',
        { name: 'genres', type: 'array', itemType: 'string' },
        'genre',
        { name: 'price', type: 'number' },
        'language',
      ]),
    );
    expect(raws(res.records[0])).toEqual({
      title: 'The Left Hand of Darkness',
      author: 'Ursula K. Le Guin',
      isbn: '978-0-441-47812-5',
      pages: 304,
      format: 'https://schema.org/Paperback',
      publisher: 'Ace Books',
      publicationDate: '1969-03-01',
      genres: ['Science fiction', 'Feminist fiction'],
      genre: 'Science fiction, Feminist fiction',
      price: '9.99',
      language: 'en',
    });
    expect(res.records[0].author.pointer).toBe('/author/name');
    expect(res.records[0].format.visibleInPage).toBe(true);
    expect(res.records[0].pages.visibleInPage).toBe(true);
  });

  it('rejects an isbn that is not one', () => {
    const res = extractFromStructuredData(makeDoc({ items: [ld({ ...book, isbn: 'n/a' })] }), makeSchema(['title', 'isbn']));
    expect(raws(res.records[0])).toEqual({ title: 'The Left Hand of Darkness' });
  });
});

describe('NewsArticle', () => {
  const article = {
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    headline: 'Rivers Rise Across the Valley',
    description: 'Heavy rain pushed rivers to record levels.',
    image: [{ '@type': 'ImageObject', url: 'https://news.example.com/img/flood.jpg', width: 1200 }],
    datePublished: '2024-03-01T08:30:00+00:00',
    dateModified: '2024-03-02T10:00:00+00:00',
    author: [
      { '@type': 'Person', name: 'Jane Doe', url: 'https://news.example.com/staff/jane' },
      { '@type': 'Person', name: 'John Roe' },
    ],
    publisher: { '@type': 'NewsMediaOrganization', name: 'Valley News', logo: { '@type': 'ImageObject', url: 'https://news.example.com/logo.png' } },
    articleSection: 'Weather',
    keywords: 'flood, rain, rivers',
  };
  const text =
    'Weather\n\nRivers Rise Across the Valley\n\nBy Jane Doe and John Roe\n\nMarch 1, 2024\n\nHeavy rain pushed rivers to record levels on Friday, officials said.';

  it('maps headline, authors (array and joined), dates, publisher, section and tags', () => {
    const res = extractFromStructuredData(
      makeDoc({ text, items: [ld(article)], attrs: [{ src: 'https://news.example.com/img/flood.jpg' }] }),
      makeSchema([
        'title',
        { name: 'authors', type: 'array', itemType: 'string' },
        'author',
        'publishedAt',
        'updatedAt',
        'publisher',
        'section',
        { name: 'tags', type: 'array', itemType: 'string' },
        'image',
        'summary',
      ]),
    );
    const rec = res.records[0];
    expect(raws(rec)).toEqual({
      title: 'Rivers Rise Across the Valley',
      authors: ['Jane Doe', 'John Roe'],
      author: 'Jane Doe, John Roe',
      publishedAt: '2024-03-01T08:30:00+00:00',
      updatedAt: '2024-03-02T10:00:00+00:00',
      publisher: 'Valley News',
      section: 'Weather',
      tags: ['flood', 'rain', 'rivers'],
      image: 'https://news.example.com/img/flood.jpg',
      summary: 'Heavy rain pushed rivers to record levels.',
    });
    expect(rec.title.pointer).toBe('/headline');
    expect(rec.authors.pointer).toBe('/author');
    expect(rec.image.pointer).toBe('/image/0/url');
    // "March 1, 2024" on the page is the ISO date.
    expect(rec.publishedAt.visibleInPage).toBe(true);
    expect(rec.updatedAt.visibleInPage).toBe(false);
    expect(rec.authors.visibleInPage).toBe(true);
    expect(rec.image.visibleInPage).toBe(true);
    // Long text compared by overlap: the page adds a few words.
    expect(rec.summary.visibleInPage).toBe(true);
  });

  it('meta author completes an article without one, never a product', () => {
    const schema = makeSchema(['headline', 'author']);
    const noAuthor = { '@type': 'NewsArticle', headline: 'Rivers Rise', url: 'https://news.example.com/rivers' };
    const res = extractFromStructuredData(
      makeDoc({ url: 'https://news.example.com/rivers', text: 'Rivers Rise\n\nBy Jane Doe', items: [ld(noAuthor), meta({ author: 'Jane Doe', canonical: 'https://news.example.com/rivers' })] }),
      schema,
    );
    expect(raws(res.records[0])).toEqual({ headline: 'Rivers Rise', author: 'Jane Doe' });
    expect(res.records[0].author.structuredId).toBe('sd1');

    const product = extractFromStructuredData(
      makeDoc({ url: 'https://shop.example.com/p', items: [ld({ '@type': 'Product', name: 'Kettle', url: 'https://shop.example.com/p' }), meta({ author: 'Shop Inc' })] }),
      makeSchema(['name', 'author']),
    );
    expect(raws(product.records[0])).toEqual({ name: 'Kettle' });
  });

  it('OpenGraph article:author given as a profile URL is not a name', () => {
    const res = extractFromStructuredData(
      makeDoc({ items: [og({ 'og:type': 'article', 'og:title': 'Rivers Rise', 'article:author': 'https://facebook.com/janedoe', 'article:published_time': '2024-03-01' })] }),
      makeSchema(['title', 'author', 'datePublished']),
    );
    expect(raws(res.records[0])).toEqual({ title: 'Rivers Rise', datePublished: '2024-03-01' });
  });
});

describe('Yoast-style @graph with @id references', () => {
  const graph = [
    { '@type': 'WebPage', '@id': 'https://blog.example.com/post/#webpage', url: 'https://blog.example.com/post/', name: 'My Post - Blog' },
    {
      '@type': 'Article',
      '@id': 'https://blog.example.com/post/#article',
      headline: 'My Post',
      isPartOf: { '@id': 'https://blog.example.com/post/#webpage' },
      author: { '@id': 'https://blog.example.com/#/schema/person/1' },
      publisher: { '@id': 'https://blog.example.com/#organization' },
      mainEntityOfPage: { '@id': 'https://blog.example.com/post/#webpage' },
      datePublished: '2023-11-05T09:00:00+00:00',
    },
    { '@type': 'Person', '@id': 'https://blog.example.com/#/schema/person/1', name: 'Sam Writer' },
    { '@type': 'Organization', '@id': 'https://blog.example.com/#organization', name: 'Example Blog', logo: { '@type': 'ImageObject', url: 'https://blog.example.com/logo.png' } },
  ];

  it('follows references into other items and reports their item and pointer', () => {
    const res = extractFromStructuredData(
      makeDoc({ url: 'https://blog.example.com/post/', text: 'My Post\n\nSam Writer\n\nNovember 5, 2023', items: graph.map(ld) }),
      makeSchema(['title', 'author', 'publisher', 'publisherLogo', 'date']),
    );
    expect(raws(res.records[0])).toEqual({
      title: 'My Post',
      author: 'Sam Writer',
      publisher: 'Example Blog',
      publisherLogo: 'https://blog.example.com/logo.png',
      date: '2023-11-05T09:00:00+00:00',
    });
    expect(res.records[0].publisherLogo).toMatchObject({ structuredId: 'sd3', pointer: '/logo/url' });
    expect(res.records[0].title.structuredId).toBe('sd1');
    expect(res.records[0].author).toMatchObject({ structuredId: 'sd2', pointer: '/name', visibleInPage: true });
    expect(res.records[0].publisher).toMatchObject({ structuredId: 'sd3', pointer: '/name' });
  });

  it('reference cycles terminate', () => {
    const cyclic = [
      { '@type': 'Article', '@id': '#a', headline: 'Loop', author: { '@id': '#b' } },
      { '@type': 'Person', '@id': '#b', name: { '@id': '#c' } },
      { '@type': 'Thing', '@id': '#c', name: { '@id': '#b' } },
    ];
    const res = extractFromStructuredData(makeDoc({ items: cyclic.map(ld) }), makeSchema(['headline', 'author']));
    expect(raws(res.records[0])).toEqual({ headline: 'Loop' });
  });
});

describe('JobPosting', () => {
  const job = {
    '@context': 'https://schema.org/',
    '@type': 'JobPosting',
    title: 'Senior Backend Engineer',
    description: '<p>Build <b>reliable</b> APIs &amp; data pipelines.</p>',
    datePosted: '2024-05-10',
    validThrough: '2024-06-30T23:59',
    employmentType: ['FULL_TIME', 'CONTRACTOR'],
    hiringOrganization: { '@type': 'Organization', name: 'Globex', sameAs: 'https://globex.example.com', logo: 'https://globex.example.com/logo.png' },
    jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'Austin', addressRegion: 'TX', addressCountry: 'US' } },
    baseSalary: { '@type': 'MonetaryAmount', currency: 'USD', value: { '@type': 'QuantitativeValue', minValue: 120000, maxValue: 150000, unitText: 'YEAR' } },
  };
  const text = 'Senior Backend Engineer\n\nGlobex · Austin, TX\n\n$120,000 – $150,000 a year\n\nFull-time\n\nBuild reliable APIs & data pipelines.';

  it('maps title, company, location and a salary range (bounds only, no guessed single salary)', () => {
    const res = extractFromStructuredData(
      makeDoc({ text, items: [ld(job)] }),
      makeSchema([
        'jobTitle',
        'company',
        'location',
        'region',
        'country',
        { name: 'salary', type: 'number' },
        { name: 'salaryMin', type: 'number' },
        { name: 'salaryMax', type: 'number' },
        'salaryCurrency',
        'currency',
        'salaryPeriod',
        { name: 'employmentType', type: 'array', itemType: 'string' },
        'datePosted',
        'deadline',
        'description',
        'companyLogo',
      ]),
    );
    const rec = res.records[0];
    expect(raws(rec)).toEqual({
      jobTitle: 'Senior Backend Engineer',
      company: 'Globex',
      location: 'Austin',
      region: 'TX',
      country: 'US',
      salaryMin: 120000,
      salaryMax: 150000,
      salaryCurrency: 'USD',
      currency: 'USD',
      salaryPeriod: 'YEAR',
      employmentType: ['FULL_TIME', 'CONTRACTOR'],
      datePosted: '2024-05-10',
      deadline: '2024-06-30T23:59',
      description: '<p>Build <b>reliable</b> APIs &amp; data pipelines.</p>',
      companyLogo: 'https://globex.example.com/logo.png',
    });
    expect(rec.companyLogo.pointer).toBe('/hiringOrganization/logo');
    expect(rec.salaryMin.pointer).toBe('/baseSalary/value/minValue');
    expect(rec.location.pointer).toBe('/jobLocation/address/addressLocality');
    expect(rec.salaryMin.visibleInPage).toBe(true);
    // Markup inside JSON-LD text is ignored for visibility only; raw is untouched.
    expect(rec.description.visibleInPage).toBe(true);
    expect(res.filledFields).not.toContain('salary');
  });

  it('a single salary value fills salary', () => {
    const single = { ...job, baseSalary: { '@type': 'MonetaryAmount', currency: 'EUR', value: { '@type': 'QuantitativeValue', value: 65000, unitText: 'YEAR' } } };
    const res = extractFromStructuredData(makeDoc({ items: [ld(single)] }), makeSchema([{ name: 'salary', type: 'number' }, 'currency', { name: 'salaryMax', type: 'number' }]));
    expect(raws(res.records[0])).toEqual({ salary: 65000, currency: 'EUR' });
    expect(res.records[0].salary.pointer).toBe('/baseSalary/value/value');
  });

  it('a job page with an employer Organization still picks the posting', () => {
    const res = extractFromStructuredData(
      makeDoc({ text, items: [ld({ '@type': 'Organization', name: 'Globex Careers', address: { addressLocality: 'Springfield' } }), ld(job)] }),
      makeSchema(['title', 'company', 'location']),
    );
    expect(raws(res.records[0])).toEqual({ title: 'Senior Backend Engineer', company: 'Globex', location: 'Austin' });
  });
});

describe('Event, Recipe, LocalBusiness, SoftwareApplication', () => {
  it('Event: dates, venue, organizer, ticket price', () => {
    const res = extractFromStructuredData(
      makeDoc({
        text: 'Jazz Night\n\nSat, June 15, 2024 · 8:00 PM\n\nBlue Room, Kansas City\n\nTickets $25',
        items: [
          ld({
            '@type': 'MusicEvent',
            name: 'Jazz Night',
            startDate: '2024-06-15T20:00:00-05:00',
            endDate: '2024-06-15T23:00:00-05:00',
            location: { '@type': 'Place', name: 'Blue Room', address: { '@type': 'PostalAddress', addressLocality: 'Kansas City' } },
            organizer: { '@type': 'Organization', name: 'KC Jazz' },
            performer: [{ '@type': 'MusicGroup', name: 'The Quartet' }],
            eventStatus: 'https://schema.org/EventScheduled',
            offers: { '@type': 'Offer', price: '25', priceCurrency: 'USD' },
          }),
        ],
      }),
      makeSchema(['eventName', 'date', 'startDate', 'endDate', 'venue', 'city', 'organizer', 'performers', { name: 'price', type: 'number' }, 'eventStatus']),
    );
    expect(raws(res.records[0])).toEqual({
      eventName: 'Jazz Night',
      date: '2024-06-15T20:00:00-05:00',
      startDate: '2024-06-15T20:00:00-05:00',
      endDate: '2024-06-15T23:00:00-05:00',
      venue: 'Blue Room',
      city: 'Kansas City',
      organizer: 'KC Jazz',
      performers: 'The Quartet',
      price: '25',
      eventStatus: 'https://schema.org/EventScheduled',
    });
    expect(res.records[0].startDate.visibleInPage).toBe(true);
    expect(res.records[0].eventStatus.visibleInPage).toBe(false);
  });

  it('Recipe: ingredients, HowToSection steps flattened, durations matched to display forms', () => {
    const res = extractFromStructuredData(
      makeDoc({
        text: 'Pancakes\n\nPrep 10 mins · Cook 1 hr 5 mins\n\nServes 4\n\n2 eggs\n\n1 cup flour\n\nWhisk eggs.\n\nAdd flour.\n\nFry.',
        items: [
          ld({
            '@type': 'Recipe',
            name: 'Pancakes',
            recipeIngredient: ['2 eggs', '1 cup flour'],
            recipeInstructions: [
              { '@type': 'HowToSection', name: 'Batter', itemListElement: [{ '@type': 'HowToStep', text: 'Whisk eggs.' }, { '@type': 'HowToStep', text: 'Add flour.' }] },
              { '@type': 'HowToStep', text: 'Fry.' },
            ],
            prepTime: 'PT10M',
            cookTime: 'PT1H5M',
            recipeYield: ['4', '4 servings'],
            nutrition: { '@type': 'NutritionInformation', calories: '240 calories' },
          }),
        ],
      }),
      makeSchema([
        'name',
        { name: 'ingredients', type: 'array', itemType: 'string' },
        { name: 'steps', type: 'array', itemType: 'string' },
        'instructions',
        'prepTime',
        'cookTime',
        { name: 'servings', type: 'integer' },
        { name: 'calories', type: 'number' },
      ]),
    );
    const rec = res.records[0];
    expect(raws(rec)).toEqual({
      name: 'Pancakes',
      ingredients: ['2 eggs', '1 cup flour'],
      steps: ['Whisk eggs.', 'Add flour.', 'Fry.'],
      instructions: 'Whisk eggs.\nAdd flour.\nFry.',
      prepTime: 'PT10M',
      cookTime: 'PT1H5M',
      servings: '4',
      calories: '240 calories',
    });
    expect(rec.prepTime.visibleInPage).toBe(true);
    expect(rec.cookTime.visibleInPage).toBe(true);
    expect(rec.steps.visibleInPage).toBe(true);
  });

  it('LocalBusiness: address parts, phone, hours, price range, rating', () => {
    const res = extractFromStructuredData(
      makeDoc({
        items: [
          ld({
            '@type': ['Restaurant', 'LocalBusiness'],
            name: 'Trattoria Roma',
            telephone: '+1-555-0100',
            priceRange: '$$',
            servesCuisine: ['Italian', 'Pizza'],
            openingHours: ['Mo-Fr 11:00-22:00', 'Sa 12:00-23:00'],
            address: { '@type': 'PostalAddress', streetAddress: '1 Main St', addressLocality: 'Springfield', postalCode: '12345', addressCountry: { '@type': 'Country', name: 'US' } },
            aggregateRating: { ratingValue: 4.5, ratingCount: 210 },
          }),
        ],
      }),
      makeSchema(['name', 'phone', 'priceRange', 'cuisine', 'hours', 'street', 'city', 'zip', 'country', 'address', { name: 'rating', type: 'number' }, { name: 'reviewCount', type: 'integer' }]),
    );
    expect(raws(res.records[0])).toEqual({
      name: 'Trattoria Roma',
      phone: '+1-555-0100',
      priceRange: '$$',
      cuisine: 'Italian, Pizza',
      hours: 'Mo-Fr 11:00-22:00, Sa 12:00-23:00',
      street: '1 Main St',
      city: 'Springfield',
      zip: '12345',
      country: 'US',
      rating: 4.5,
      reviewCount: 210,
    });
    // A PostalAddress object is not a raw string address: left for later stages.
    expect(res.filledFields).not.toContain('address');
  });

  it('SoftwareApplication: os, category, free price', () => {
    const res = extractFromStructuredData(
      makeDoc({
        items: [
          ld({
            '@type': 'SoftwareApplication',
            name: 'Notes Pro',
            operatingSystem: 'Android, iOS',
            applicationCategory: 'ProductivityApplication',
            offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
            aggregateRating: { ratingValue: '4.8', ratingCount: '15000' },
            softwareVersion: '3.2.1',
          }),
        ],
      }),
      makeSchema(['name', 'os', 'applicationCategory', { name: 'price', type: 'number' }, 'rating', 'ratings', 'version']),
    );
    expect(raws(res.records[0])).toEqual({
      name: 'Notes Pro',
      os: 'Android, iOS',
      applicationCategory: 'ProductivityApplication',
      price: '0',
      rating: '4.8',
      ratings: '15000',
      version: '3.2.1',
    });
  });
});
