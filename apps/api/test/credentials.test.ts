// Request headers and cookies are refused up front when no fetch tier could
// send them (they would make HTTP clients throw and browsers hang).
import { describe, expect, it } from 'vitest';
import { requestCookiesSchema, requestHeadersSchema } from '../src/routes/credentials.js';

describe('request headers', () => {
  it('accepts ordinary headers', () => {
    expect(requestHeadersSchema.safeParse({ Authorization: 'Bearer abc', 'X-Api-Key': 'k', Accept: 'text/html;\tq=0.9' }).success).toBe(true);
  });

  it.each([
    [{ 'X Api Key': 'k' }, /HTTP token/],
    [{ 'X-Key:': 'k' }, /HTTP token/],
    [{ 'X-Key': 'k\r\nInjected: 1' }, /control characters/],
    [{ 'X-Key': 'k\n' }, /control characters/],
    [{ 'X-City': '東京' }, /Latin-1/],
  ])('refuses %j', (headers, message) => {
    const r = requestHeadersSchema.safeParse(headers);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].message).toMatch(message);
  });
});

describe('request cookies', () => {
  it('accepts ordinary cookies', () => {
    expect(requestCookiesSchema.safeParse([{ name: 'sid', value: 'abc=123', domain: '.example.com', path: '/' }]).success).toBe(true);
  });

  it.each([
    [[{ name: 'bad name', value: 'v' }]],
    [[{ name: 'prefs', value: 'a\tb' }]],
    [[{ name: 'prefs', value: 'a\u0001b' }]],
    [[{ name: 'prefs', value: 'a;b' }]],
  ])('refuses %j', (cookies) => {
    expect(requestCookiesSchema.safeParse(cookies).success).toBe(false);
  });
});
