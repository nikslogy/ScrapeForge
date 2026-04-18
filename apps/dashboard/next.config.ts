import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@scrapeforge/shared'],
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
};

export default nextConfig;
