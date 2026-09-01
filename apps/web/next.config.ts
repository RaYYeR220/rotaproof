import path from 'node:path';
import type { NextConfig } from 'next';

/**
 * `Origin-Agent-Cluster: ?1` opts the origin into an origin-keyed agent cluster, and
 * `Permissions-Policy: tools=(self)` is the policy-controlled feature gating WebMCP. The
 * `Origin-Trial` header is the response-header form of the token, used on deployments
 * where stable Chrome has no command-line switch to fall back on.
 */
const ORIGIN_TRIAL_TOKEN = process.env.WEBMCP_ORIGIN_TRIAL_TOKEN;

const nextConfig: NextConfig = {
  // The workspace packages ship raw TypeScript from `src/`, so Next has to compile them.
  transpilePackages: ['@rotaproof/core', '@rotaproof/registry'],

  // Turbopack walks up looking for a lockfile and in a monorepo can latch onto the wrong
  // directory, which breaks file tracing. Pinning the root removes the guess.
  turbopack: { root: path.resolve(process.cwd()) },

  reactStrictMode: true,

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Origin-Agent-Cluster', value: '?1' },
          { key: 'Permissions-Policy', value: 'tools=(self)' },
          ...(ORIGIN_TRIAL_TOKEN ? [{ key: 'Origin-Trial', value: ORIGIN_TRIAL_TOKEN }] : []),
        ],
      },
    ];
  },
};

export default nextConfig;
