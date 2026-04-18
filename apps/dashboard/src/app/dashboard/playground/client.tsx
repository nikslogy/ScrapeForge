'use client';

import { useState, useRef, useCallback, useMemo } from 'react';
import { Card } from '@/components/card';

type Mode = 'scrape' | 'extract';
type Format = 'markdown' | 'text' | 'html';
type ContentTab = 'preview' | 'raw';

interface SseEvent {
  event: string;
  data: unknown;
  ts: number;
}

interface KeyOption {
  id: string;
  prefix: string;
  name: string;
}

const MIME: Record<string, string> = {
  markdown: 'text/markdown;charset=utf-8',
  text: 'text/plain;charset=utf-8',
  html: 'text/html;charset=utf-8',
  json: 'application/json;charset=utf-8',
};

const EXT: Record<string, string> = {
  markdown: 'md',
  text: 'txt',
  html: 'html',
  json: 'json',
};

function safeSlug(u: string) {
  try {
    const url = new URL(u);
    return (
      url.hostname.replace(/^www\./, '').replace(/[^a-z0-9]/gi, '-') +
      '-' +
      url.pathname.replace(/[^a-z0-9]/gi, '-').slice(0, 32).replace(/-+$/, '')
    ).replace(/-+/g, '-').replace(/-$/, '') || 'scrape';
  } catch {
    return 'scrape';
  }
}

function download(name: string, mime: string, contents: string | Blob) {
  const blob =
    typeof contents === 'string' ? new Blob([contents], { type: mime }) : contents;
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1_000);
}

function base64ToBlob(b64: string, mime = 'image/png') {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export function PlaygroundClient({ apiKeyPrefixes: _apiKeyPrefixes }: { apiKeyPrefixes: KeyOption[] }) {
  const [mode, setMode] = useState<Mode>('scrape');
  const [url, setUrl] = useState('https://example.com');
  const [format, setFormat] = useState<Format>('markdown');
  const [screenshot, setScreenshot] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [proxy, setProxy] = useState('auto');
  const [waitFor, setWaitFor] = useState('');
  const [blockResources, setBlockResources] = useState(true);
  const [cacheTtl, setCacheTtl] = useState(0);
  const [extractSchema, setExtractSchema] = useState(
    '{\n  "properties": {\n    "title": { "type": "string" },\n    "description": { "type": "string" }\n  }\n}',
  );
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [sseEvents, setSseEvents] = useState<SseEvent[]>([]);
  const [sseActive, setSseActive] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [activeTab, setActiveTab] = useState<'content' | 'json' | 'sse' | 'shot' | 'curl'>('content');
  const [contentTab, setContentTab] = useState<ContentTab>('preview');
  const [copyMsg, setCopyMsg] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const connectSse = useCallback(
    (jobId: string) => {
      setSseEvents([]);
      setSseActive(true);
      const es = new EventSource(
        `http://localhost:3000/v1/scrape/stream?jobId=${jobId}`,
      );
      eventSourceRef.current = es;

      const handler = (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          setSseEvents((prev) => [
            ...prev,
            { event: e.type, data, ts: Date.now() },
          ]);
          if (e.type === 'complete' || e.type === 'error') {
            es.close();
            setSseActive(false);
          }
        } catch {}
      };

      for (const evt of ['started', 'headers', 'content', 'extraction', 'complete', 'error']) {
        es.addEventListener(evt, handler);
      }
      es.onerror = () => {
        es.close();
        setSseActive(false);
      };
    },
    [],
  );

  const requestBody = useMemo(() => {
    const formats: string[] = [format];
    if (screenshot) formats.push('screenshot');

    const body: Record<string, unknown> = {
      url,
      formats,
      screenshot,
      mobile,
      proxy,
      blockResources,
      cacheTtl,
    };
    if (waitFor.trim()) body.waitFor = waitFor.trim();

    if (mode === 'extract') {
      try {
        body.schema = JSON.parse(extractSchema);
      } catch {
        body.schema = '<invalid-json>';
      }
    }
    return body;
  }, [format, screenshot, url, mobile, proxy, blockResources, cacheTtl, waitFor, mode, extractSchema]);

  const curlCommand = useMemo(() => {
    const endpoint =
      mode === 'extract'
        ? 'http://localhost:3000/v1/extract'
        : 'http://localhost:3000/v1/scrape';
    const json = JSON.stringify(requestBody, null, 2);
    return `curl -X POST ${endpoint} \\
  -H "Authorization: Bearer ${apiKey || 'sf_live_YOUR_KEY'}" \\
  -H "Content-Type: application/json" \\
  -d '${json.replace(/'/g, `'\\''`)}'`;
  }, [mode, requestBody, apiKey]);

  async function handleSend() {
    if (!apiKey.trim()) {
      setError('Paste your full API key (sf_live_...) to make requests.');
      return;
    }
    setLoading(true);
    setResult(null);
    setError(null);
    setSseEvents([]);
    if (eventSourceRef.current) eventSourceRef.current.close();

    const start = Date.now();
    try {
      const endpoint =
        mode === 'extract'
          ? 'http://localhost:3000/v1/extract'
          : 'http://localhost:3000/v1/scrape';

      if (mode === 'extract' && requestBody.schema === '<invalid-json>') {
        setError('Invalid JSON schema. Check your syntax.');
        setLoading(false);
        return;
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
      });

      const data = await res.json();
      setElapsed(Date.now() - start);

      if (!res.ok) {
        setError(data.error || `HTTP ${res.status}`);
        if (data.jobId) connectSse(data.jobId);
      } else {
        setResult(data);
        if (data.jobId) connectSse(data.jobId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setLoading(false);
    }
  }

  function flash(msg: string) {
    setCopyMsg(msg);
    setTimeout(() => setCopyMsg(null), 1500);
  }

  async function copy(text: string, label = 'copied') {
    try {
      await navigator.clipboard.writeText(text);
      flash(label);
    } catch {
      flash('copy failed');
    }
  }

  const hasContent = result?.content;
  const slug = useMemo(() => safeSlug(url), [url]);
  const contentText =
    hasContent?.[format] ||
    hasContent?.markdown ||
    hasContent?.text ||
    (hasContent?.json ? JSON.stringify(hasContent.json, null, 2) : null) ||
    (hasContent ? JSON.stringify(hasContent, null, 2) : '');

  const availableFormats: Array<{ key: Format | 'json' | 'html'; label: string; present: boolean }> = [
    { key: 'markdown', label: 'MD',   present: !!hasContent?.markdown },
    { key: 'text',     label: 'TXT',  present: !!hasContent?.text },
    { key: 'html',     label: 'HTML', present: !!hasContent?.html },
    { key: 'json',     label: 'JSON', present: !!hasContent?.json },
  ];

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* ── Request panel ────────────────────────────── */}
      <Card>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-medium text-charcoal-500">Request</h2>
          {copyMsg && (
            <span className="text-[11px] font-medium text-emerald-400">{copyMsg}</span>
          )}
        </div>
        <div className="space-y-3">
          {/* Mode tabs */}
          <div className="flex gap-1 rounded-md bg-charcoal-800 p-0.5">
            {(['scrape', 'extract'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                  mode === m
                    ? 'bg-amber-500/15 text-amber-400'
                    : 'text-charcoal-500 hover:text-white'
                }`}
              >
                {m === 'scrape' ? '/v1/scrape' : '/v1/extract'}
              </button>
            ))}
          </div>

          {/* API Key */}
          <div>
            <label className="mb-1 block text-xs text-charcoal-500">API Key</label>
            <input
              type="password"
              placeholder="sf_live_..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="w-full rounded-md border border-charcoal-700 bg-charcoal-800 px-3 py-2 font-[family-name:var(--font-mono)] text-sm text-white placeholder-charcoal-600 outline-none focus:border-amber-500/50"
            />
          </div>

          {/* URL */}
          <div>
            <label className="mb-1 block text-xs text-charcoal-500">URL</label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="w-full rounded-md border border-charcoal-700 bg-charcoal-800 px-3 py-2 font-[family-name:var(--font-mono)] text-sm text-white outline-none focus:border-amber-500/50"
            />
          </div>

          {/* Format + toggles row */}
          <div className="grid grid-cols-4 gap-2">
            <div>
              <label className="mb-1 block text-xs text-charcoal-500">Format</label>
              <select
                value={format}
                onChange={(e) => setFormat(e.target.value as Format)}
                className="w-full rounded-md border border-charcoal-700 bg-charcoal-800 px-2 py-2 text-xs text-white outline-none"
              >
                <option value="markdown">Markdown</option>
                <option value="text">Text</option>
                <option value="html">HTML</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-charcoal-500">Proxy</label>
              <select
                value={proxy}
                onChange={(e) => setProxy(e.target.value)}
                className="w-full rounded-md border border-charcoal-700 bg-charcoal-800 px-2 py-2 text-xs text-white outline-none"
              >
                <option value="auto">Auto</option>
                <option value="none">None</option>
                <option value="datacenter">Datacenter</option>
                <option value="residential">Residential</option>
                <option value="mobile">Mobile</option>
              </select>
            </div>
            <label className="flex items-end gap-1.5 pb-2">
              <input type="checkbox" checked={screenshot} onChange={(e) => setScreenshot(e.target.checked)} className="accent-amber-500" />
              <span className="text-xs text-charcoal-500">Screenshot</span>
            </label>
            <label
              className="flex items-end gap-1.5 pb-2"
              title="Mobile emulation: uses iPhone user-agent and 390×844 viewport. Forces a real browser (Tier 4) so JS-rendered mobile layouts work."
            >
              <input type="checkbox" checked={mobile} onChange={(e) => setMobile(e.target.checked)} className="accent-amber-500" />
              <span className="text-xs text-charcoal-500">Mobile</span>
            </label>
          </div>

          {/* Advanced toggle */}
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="text-xs text-charcoal-600 hover:text-charcoal-500"
          >
            {showAdvanced ? '− Hide advanced' : '+ Show advanced'}
          </button>

          {showAdvanced && (
            <div className="space-y-3 rounded-md border border-charcoal-800 bg-charcoal-800/30 p-3">
              <div>
                <label className="mb-1 block text-xs text-charcoal-500">
                  Wait for selector <span className="text-charcoal-600">(CSS)</span>
                </label>
                <input
                  type="text"
                  placeholder="#main-content, .product-list"
                  value={waitFor}
                  onChange={(e) => setWaitFor(e.target.value)}
                  className="w-full rounded-md border border-charcoal-700 bg-charcoal-800 px-3 py-1.5 font-[family-name:var(--font-mono)] text-xs text-white placeholder-charcoal-600 outline-none focus:border-amber-500/50"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-charcoal-500">
                  Cache TTL <span className="text-charcoal-600">(seconds, 0 = no cache)</span>
                </label>
                <input
                  type="number"
                  min={0}
                  max={86400}
                  value={cacheTtl}
                  onChange={(e) => setCacheTtl(Number(e.target.value) || 0)}
                  className="w-full rounded-md border border-charcoal-700 bg-charcoal-800 px-3 py-1.5 font-[family-name:var(--font-mono)] text-xs text-white outline-none focus:border-amber-500/50"
                />
              </div>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={blockResources} onChange={(e) => setBlockResources(e.target.checked)} className="accent-amber-500" />
                <span className="text-xs text-charcoal-500">Block fonts/media/tracking</span>
              </label>
            </div>
          )}

          {/* Extract schema */}
          {mode === 'extract' && (
            <div>
              <label className="mb-1 block text-xs text-charcoal-500">
                Extraction Schema <span className="text-charcoal-600">(JSON)</span>
              </label>
              <textarea
                value={extractSchema}
                onChange={(e) => setExtractSchema(e.target.value)}
                rows={6}
                className="w-full rounded-md border border-charcoal-700 bg-charcoal-800 px-3 py-2 font-[family-name:var(--font-mono)] text-xs text-white outline-none focus:border-amber-500/50"
              />
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={handleSend}
              disabled={loading}
              className="flex-1 rounded-md bg-amber-500 px-4 py-2.5 text-sm font-semibold text-charcoal-950 transition-colors hover:bg-amber-400 disabled:opacity-50"
            >
              {loading
                ? mode === 'extract'
                  ? 'Extracting...'
                  : 'Scraping...'
                : mode === 'extract'
                  ? 'Extract Data'
                  : 'Send Request'}
            </button>
            <button
              onClick={() => copy(curlCommand, 'curl copied')}
              title="Copy cURL command"
              className="rounded-md border border-charcoal-700 px-3 text-xs font-medium text-charcoal-500 transition-colors hover:border-charcoal-600 hover:text-white"
            >
              cURL
            </button>
            <button
              onClick={() =>
                copy(JSON.stringify(requestBody, null, 2), 'body copied')
              }
              title="Copy request body as JSON"
              className="rounded-md border border-charcoal-700 px-3 text-xs font-medium text-charcoal-500 transition-colors hover:border-charcoal-600 hover:text-white"
            >
              JSON
            </button>
          </div>
        </div>
      </Card>

      {/* ── Response panel ───────────────────────────── */}
      <Card>
        {/* Header bar */}
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium text-charcoal-500">Response</h2>
          {result && (
            <div className="flex flex-wrap justify-end gap-2 text-xs text-charcoal-500">
              <Badge>Tier {result.metadata?.tierUsed}</Badge>
              <Badge>{elapsed}ms</Badge>
              <Badge>Q {result.metadata?.qualityScore}</Badge>
              {result.metadata?.cached && <Badge tone="emerald">cached</Badge>}
              {result.metadata?.proxyTier && result.metadata.proxyTier !== 'none' && (
                <Badge>Proxy: {result.metadata.proxyTier}</Badge>
              )}
              {result.metadata?.extractionMethod && (
                <Badge tone="sky">{result.metadata.extractionMethod}</Badge>
              )}
            </div>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="mb-3 rounded-md border border-rose-500/20 bg-rose-500/5 p-3 text-sm text-rose-400">
            {error}
          </div>
        )}

        {result && (
          <div className="space-y-3">
            {/* Cost breakdown */}
            {result.metadata?.costBreakdown && (
              <div className="flex flex-wrap items-center gap-3 rounded-md bg-charcoal-800 px-3 py-2 text-xs">
                <CostItem label="Compute" value={result.metadata.costBreakdown.compute} />
                <CostItem label="Proxy" value={result.metadata.costBreakdown.proxy} />
                <CostItem label="LLM" value={result.metadata.costBreakdown.llm} />
                <CostItem label="CAPTCHA" value={result.metadata.costBreakdown.captcha} />
                <span className="ml-auto text-charcoal-500">
                  Total:{' '}
                  <span className="font-medium text-amber-400">
                    ${result.metadata.costBreakdown.total?.toFixed(6)}
                  </span>
                </span>
              </div>
            )}

            {/* Tabs */}
            <div className="flex gap-1 rounded-md bg-charcoal-800 p-0.5">
              {(
                [
                  { key: 'content', label: 'Content' },
                  { key: 'json', label: 'Raw JSON' },
                  ...(result.content?.screenshot ? [{ key: 'shot' as const, label: 'Screenshot' }] : []),
                  { key: 'sse', label: `SSE (${sseEvents.length})` },
                  { key: 'curl', label: 'cURL' },
                ] as const
              ).map((t) => (
                <button
                  key={t.key}
                  onClick={() => setActiveTab(t.key)}
                  className={`flex-1 rounded px-2 py-1 text-xs font-medium transition-colors ${
                    activeTab === t.key
                      ? 'bg-charcoal-700 text-white'
                      : 'text-charcoal-500 hover:text-charcoal-400'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* Content tab */}
            {activeTab === 'content' && (
              <>
                {/* Download toolbar */}
                <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-charcoal-800 bg-charcoal-800/30 px-2 py-1.5 text-xs">
                  <span className="text-charcoal-600">Download:</span>
                  {availableFormats.map((f) => (
                    <button
                      key={f.key}
                      disabled={!f.present}
                      onClick={() => {
                        const body =
                          f.key === 'json'
                            ? JSON.stringify(hasContent.json, null, 2)
                            : (hasContent?.[f.key] as string);
                        if (!body) return;
                        download(
                          `${slug}.${EXT[f.key]}`,
                          MIME[f.key],
                          body,
                        );
                      }}
                      className="rounded border border-charcoal-700 px-2 py-0.5 text-[11px] text-charcoal-500 transition-colors hover:border-amber-500/50 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      {f.label}
                    </button>
                  ))}
                  <button
                    onClick={() =>
                      download(
                        `${slug}-full.json`,
                        MIME.json,
                        JSON.stringify(result, null, 2),
                      )
                    }
                    className="rounded border border-charcoal-700 px-2 py-0.5 text-[11px] text-charcoal-500 transition-colors hover:border-amber-500/50 hover:text-white"
                  >
                    Full
                  </button>
                  <span className="ml-auto text-charcoal-600">
                    {(contentText || '').length.toLocaleString()} chars
                  </span>
                  <button
                    onClick={() => copy(contentText || '', 'content copied')}
                    className="rounded border border-charcoal-700 px-2 py-0.5 text-[11px] text-charcoal-500 transition-colors hover:border-amber-500/50 hover:text-white"
                  >
                    Copy
                  </button>
                </div>

                {/* Preview / Raw toggle for markdown + html */}
                {(format === 'markdown' || format === 'html') && (
                  <div className="flex gap-1 text-[11px]">
                    {(['preview', 'raw'] as const).map((v) => (
                      <button
                        key={v}
                        onClick={() => setContentTab(v)}
                        className={`rounded px-2 py-0.5 ${
                          contentTab === v
                            ? 'bg-amber-500/15 text-amber-400'
                            : 'text-charcoal-600 hover:text-charcoal-400'
                        }`}
                      >
                        {v === 'preview' ? 'Preview' : 'Raw'}
                      </button>
                    ))}
                  </div>
                )}

                {/* Extracted JSON (from AI) */}
                {result.content?.json && (
                  <div>
                    <div className="mb-1 flex items-center justify-between">
                      <p className="text-xs font-medium text-amber-400">Extracted Data (AI)</p>
                      <button
                        onClick={() =>
                          copy(JSON.stringify(hasContent.json, null, 2), 'json copied')
                        }
                        className="text-[10px] text-charcoal-500 hover:text-white"
                      >
                        copy
                      </button>
                    </div>
                    <pre className="max-h-[200px] overflow-auto rounded-md bg-charcoal-950 p-3 font-[family-name:var(--font-mono)] text-xs text-emerald-400">
                      {JSON.stringify(result.content.json, null, 2)}
                    </pre>
                  </div>
                )}

                {/* Preview rendered HTML in sandboxed iframe */}
                {contentTab === 'preview' && format === 'html' && hasContent?.html && (
                  <iframe
                    sandbox=""
                    className="h-[400px] w-full rounded-md border border-charcoal-800 bg-white"
                    srcDoc={hasContent.html}
                    title="HTML preview"
                  />
                )}

                {/* Rendered markdown (simple) */}
                {contentTab === 'preview' && format === 'markdown' && contentText && (
                  <div className="max-h-[400px] overflow-auto rounded-md border border-charcoal-800 bg-charcoal-950 p-4 text-sm text-charcoal-300">
                    <MarkdownView md={contentText} />
                  </div>
                )}

                {/* Raw text content (always shown for text; shown as raw for md/html when toggled) */}
                {(contentTab === 'raw' || format === 'text') && (
                  <div className="max-h-[400px] overflow-auto rounded-md bg-charcoal-950 p-3">
                    <pre className="whitespace-pre-wrap font-[family-name:var(--font-mono)] text-xs text-charcoal-500">
                      {contentText}
                    </pre>
                  </div>
                )}
              </>
            )}

            {/* Screenshot tab */}
            {activeTab === 'shot' && result.content?.screenshot && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs">
                  <button
                    onClick={() =>
                      download(
                        `${slug}.png`,
                        'image/png',
                        base64ToBlob(result.content.screenshot),
                      )
                    }
                    className="rounded border border-charcoal-700 px-2 py-0.5 text-[11px] text-charcoal-500 hover:border-amber-500/50 hover:text-white"
                  >
                    Download PNG
                  </button>
                  <span className="text-charcoal-600">
                    {((result.content.screenshot.length * 0.75) / 1024).toFixed(1)} KB (base64 decoded)
                  </span>
                </div>
                <img
                  src={`data:image/png;base64,${result.content.screenshot}`}
                  alt="Screenshot"
                  className="w-full rounded border border-charcoal-800"
                />
              </div>
            )}

            {/* Raw JSON tab */}
            {activeTab === 'json' && (
              <div className="space-y-2">
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => copy(JSON.stringify(result, null, 2), 'json copied')}
                    className="rounded border border-charcoal-700 px-2 py-0.5 text-[11px] text-charcoal-500 hover:border-amber-500/50 hover:text-white"
                  >
                    Copy
                  </button>
                  <button
                    onClick={() =>
                      download(
                        `${slug}-response.json`,
                        MIME.json,
                        JSON.stringify(result, null, 2),
                      )
                    }
                    className="rounded border border-charcoal-700 px-2 py-0.5 text-[11px] text-charcoal-500 hover:border-amber-500/50 hover:text-white"
                  >
                    Download
                  </button>
                </div>
                <pre className="max-h-[450px] overflow-auto rounded-md bg-charcoal-950 p-3 font-[family-name:var(--font-mono)] text-xs text-charcoal-500">
                  {JSON.stringify(result, null, 2)}
                </pre>
              </div>
            )}

            {/* SSE tab */}
            {activeTab === 'sse' && (
              <div className="max-h-[450px] space-y-1.5 overflow-auto">
                {sseEvents.length === 0 && (
                  <p className="py-4 text-center text-xs text-charcoal-600">
                    {sseActive
                      ? 'Waiting for events...'
                      : 'SSE events appear here during async jobs.'}
                  </p>
                )}
                {sseEvents.map((evt, i) => (
                  <div
                    key={i}
                    className="rounded-md border border-charcoal-800 bg-charcoal-800/30 p-2"
                  >
                    <div className="mb-1 flex items-center gap-2">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                          evt.event === 'complete'
                            ? 'bg-emerald-500/10 text-emerald-400'
                            : evt.event === 'error'
                              ? 'bg-rose-500/10 text-rose-400'
                              : 'bg-sky-500/10 text-sky-400'
                        }`}
                      >
                        {evt.event}
                      </span>
                      <span className="text-[10px] text-charcoal-600">
                        {new Date(evt.ts).toLocaleTimeString()}
                      </span>
                    </div>
                    <pre className="font-[family-name:var(--font-mono)] text-[10px] text-charcoal-500">
                      {JSON.stringify(evt.data, null, 2).slice(0, 400)}
                    </pre>
                  </div>
                ))}
                {sseActive && (
                  <div className="flex items-center gap-2 py-2 text-xs text-amber-400">
                    <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
                    Streaming...
                  </div>
                )}
              </div>
            )}

            {/* cURL tab */}
            {activeTab === 'curl' && (
              <div className="space-y-2">
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => copy(curlCommand, 'curl copied')}
                    className="rounded border border-charcoal-700 px-2 py-0.5 text-[11px] text-charcoal-500 hover:border-amber-500/50 hover:text-white"
                  >
                    Copy
                  </button>
                </div>
                <pre className="max-h-[300px] overflow-auto rounded-md bg-charcoal-950 p-3 font-[family-name:var(--font-mono)] text-xs text-emerald-400">
                  {curlCommand}
                </pre>
              </div>
            )}
          </div>
        )}

        {!result && !error && (
          <div className="flex h-[200px] items-center justify-center text-sm text-charcoal-600">
            Send a request to see results here.
          </div>
        )}
      </Card>
    </div>
  );
}

function CostItem({ label, value }: { label: string; value?: number }) {
  if (!value) return null;
  return (
    <span className="text-charcoal-500">
      {label}: <span className="text-white">${value.toFixed(6)}</span>
    </span>
  );
}

function Badge({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'emerald' | 'sky';
}) {
  const cls =
    tone === 'emerald'
      ? 'bg-emerald-500/10 text-emerald-400'
      : tone === 'sky'
        ? 'bg-sky-500/10 text-sky-400'
        : 'bg-charcoal-800 text-charcoal-500';
  return <span className={`rounded px-1.5 py-0.5 ${cls}`}>{children}</span>;
}

/**
 * Minimal zero-dependency markdown renderer for the playground preview.
 * Good enough for scraped content; does NOT execute any code or load remote resources.
 */
function MarkdownView({ md }: { md: string }) {
  const html = useMemo(() => mdToHtml(md), [md]);
  return (
    <div
      className="prose-like space-y-2 [&_a]:text-amber-400 [&_a]:underline [&_code]:rounded [&_code]:bg-charcoal-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs [&_h1]:text-lg [&_h1]:font-semibold [&_h1]:text-white [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-white [&_h3]:text-sm [&_h3]:font-medium [&_h3]:text-white [&_img]:max-w-full [&_img]:rounded [&_li]:ml-5 [&_li]:list-disc [&_p]:text-sm [&_p]:leading-relaxed [&_pre]:overflow-auto [&_pre]:rounded [&_pre]:bg-charcoal-900 [&_pre]:p-2 [&_strong]:font-semibold [&_strong]:text-white"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function mdToHtml(md: string): string {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let inCode = false;
  let codeBuf: string[] = [];

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCode) {
        out.push(`<pre>${escapeHtml(codeBuf.join('\n'))}</pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    if (/^\s*$/.test(line)) {
      out.push('');
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${escapeInline(h[2])}</h${level}>`);
      continue;
    }
    const li = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (li) {
      out.push(`<li>${escapeInline(li[1])}</li>`);
      continue;
    }
    out.push(`<p>${escapeInline(line)}</p>`);
  }
  if (inCode && codeBuf.length) {
    out.push(`<pre>${escapeHtml(codeBuf.join('\n'))}</pre>`);
  }
  return out.join('\n');
}

function escapeInline(s: string): string {
  // Images first, then links
  let out = escapeHtml(s);
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, href) => {
    if (href.startsWith('data:') || href.startsWith('javascript:')) return '';
    return `<img alt="${alt}" src="${href}" loading="lazy" />`;
  });
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, href) => {
    if (href.startsWith('javascript:')) return text;
    return `<a href="${href}" target="_blank" rel="noreferrer">${text}</a>`;
  });
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return out;
}
