// The request's own headers and cookies, as every fetch tier can send them.
// A header name that is not a token, or a value with a control character,
// makes HTTP clients throw and browsers hang; such input is refused here
// with a 400 rather than failing (or being dropped) at fetch time.

import { z } from 'zod';

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// Header values are Latin-1 (what HTTP clients can send) without control
// characters; tab is allowed (RFC 9110), not in cookie values.
const HEADER_VALUE_CTL = /[\x00-\x08\x0a-\x1f\x7f]/;
const HEADER_VALUE_NON_LATIN1 = /[^\x00-\xff]/;
const COOKIE_VALUE_UNSAFE = /[\x00-\x1f\x7f;]/;

export const MAX_REQUEST_HEADERS = 50;
export const MAX_REQUEST_COOKIES = 100;

export const requestHeadersSchema = z
  .record(z.string())
  .superRefine((headers, ctx) => {
    const entries = Object.entries(headers);
    if (entries.length > MAX_REQUEST_HEADERS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `at most ${MAX_REQUEST_HEADERS} headers` });
    }
    for (const [name, value] of entries) {
      if (!TOKEN.test(name)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: 'header name must be an HTTP token (no spaces or separators)' });
      else if (HEADER_VALUE_CTL.test(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: 'header value must not contain control characters (CR, LF, ...)' });
      else if (HEADER_VALUE_NON_LATIN1.test(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: 'header value must be Latin-1; percent-encode other characters' });
    }
  });

export const requestCookiesSchema = z
  .array(
    z.object({
      name: z.string().regex(TOKEN, 'cookie name must be an HTTP token'),
      value: z.string().refine((v) => !COOKIE_VALUE_UNSAFE.test(v), 'cookie value must not contain ";" or control characters'),
      domain: z.string().optional(),
      path: z.string().optional(),
    }),
  )
  .max(MAX_REQUEST_COOKIES);
