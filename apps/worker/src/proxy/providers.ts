import type { ProxyConfig } from '@scrapeforge/shared';

export interface ProxyProvider {
  name: string;
  tier: 'datacenter' | 'residential' | 'mobile';
  costPer: string;
  buildUrl(options?: { country?: string; session?: string }): string;
  isConfigured(): boolean;
}

function env(key: string): string | undefined {
  return process.env[key];
}

export const providers: ProxyProvider[] = [
  {
    name: 'webshare-dc',
    tier: 'datacenter',
    costPer: '$0.035/IP',
    buildUrl({ country, session } = {}) {
      const key = env('WEBSHARE_API_KEY')!;
      const base = `http://${key}:render=false@proxy.webshare.io:80`;
      return base;
    },
    isConfigured: () => !!env('WEBSHARE_API_KEY'),
  },
  {
    name: 'iproyal-dc',
    tier: 'datacenter',
    costPer: '$0.035/IP',
    buildUrl({ country, session } = {}) {
      const key = env('IPROYAL_API_KEY')!;
      const cc = country || 'us';
      const sess = session || Math.random().toString(36).slice(2, 10);
      return `http://${key}_country-${cc}_session-${sess}:${key}@geo.iproyal.com:12321`;
    },
    isConfigured: () => !!env('IPROYAL_API_KEY'),
  },
  {
    name: 'iproyal-res',
    tier: 'residential',
    costPer: '$2.50/GB',
    buildUrl({ country, session } = {}) {
      const key = env('IPROYAL_API_KEY')!;
      const cc = country || 'us';
      const sess = session || Math.random().toString(36).slice(2, 10);
      return `http://${key}_country-${cc}_session-${sess}_streaming-1:${key}@geo.iproyal.com:12321`;
    },
    isConfigured: () => !!env('IPROYAL_API_KEY'),
  },
  {
    name: 'dataimpulse-res',
    tier: 'residential',
    costPer: '$3.00/GB',
    buildUrl({ country } = {}) {
      const key = env('DATAIMPULSE_API_KEY')!;
      const cc = country || '';
      return `http://user:${key}${cc ? `_country-${cc}` : ''}@gw.dataimpulse.com:823`;
    },
    isConfigured: () => !!env('DATAIMPULSE_API_KEY'),
  },
  {
    name: 'massive-mobile',
    tier: 'mobile',
    costPer: '$5.00/GB',
    buildUrl({ country } = {}) {
      const key = env('MASSIVE_API_KEY')!;
      const cc = country || 'us';
      return `http://user-${key}-country-${cc}:${key}@mobile.massive.io:9090`;
    },
    isConfigured: () => !!env('MASSIVE_API_KEY'),
  },
];

export function getProvidersByTier(tier: 'datacenter' | 'residential' | 'mobile'): ProxyProvider[] {
  return providers.filter(p => p.tier === tier && p.isConfigured());
}

export function hasAnyProxy(): boolean {
  return providers.some(p => p.isConfigured());
}

export function toProxyConfig(provider: ProxyProvider, url: string): ProxyConfig {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || '80'),
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    protocol: (parsed.protocol.replace(':', '') as 'http' | 'https' | 'socks5') || 'http',
    provider: provider.name,
    tier: provider.tier,
  };
}
