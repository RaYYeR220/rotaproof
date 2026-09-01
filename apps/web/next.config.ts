import path from 'node:path';
import type { NextConfig } from 'next';

/**
 * `Origin-Agent-Cluster: ?1` opts the origin into an origin-keyed agent cluster, and
 * `Permissions-Policy: tools=(self)` is the policy-controlled feature gating WebMCP. The
 * `Origin-Trial` header is the response-header form of the token, used on deployments
 * where stable Chrome has no command-line switch to fall back on.
 */
const ORIGIN_TRIAL_TOKEN = process.env.WEBMCP_ORIGIN_TRIAL_TOKEN;

/** Nothing above this directory is compiled, and pnpm links `next` from the store here. */
const workspaceRoot = path.resolve(import.meta.dirname, '../..');

const nextConfig: NextConfig = {
  // The workspace packages ship raw TypeScript from `src/`, so Next has to compile them.
  transpilePackages: ['@rotaproof/core', '@rotaproof/registry'],

  // Turbopack walks up looking for a lockfile and can latch onto the wrong directory,
  // which breaks file tracing. The root has to be the workspace root rather than this
  // package: pnpm links `next` from the store above, and nothing outside the root is
  // compiled.
  turbopack: {
    root: workspaceRoot,
    rules: {
      '**/packages/*/src/**/*.ts': {
        loaders: [path.join(import.meta.dirname, 'scripts', 'workspace-esm-loader.cjs')],
        as: '*.ts',
      },
    },
  },

  reactStrictMode: true,

  // Next drops its own framework orientation files into the package on every run. The
  // repo already carries orientation written for this project, so the generated pair is
  // turned off rather than left to overwrite it.
  agentRules: false,

  /**
   * Built as a static export for deployment.
   *
   * There is no server in this project — no route handlers, no server actions, no outbound
   * request — so a static export is not a limitation, it is the honest shape. Exporting
   * makes "the roster never leaves your browser" true of the deployment as well as of the
   * code. It is behind an environment variable because `next start` refuses to run against
   * an export, and the browser test harness needs a real server locally.
   *
   * The one thing an export cannot carry is `headers()`, so the two headers WebMCP needs
   * are set in `vercel.json` instead. They are asserted by `tests/webmcp.harness.mjs`
   * against whatever is actually serving.
   */
  ...(process.env.NEXT_EXPORT === '1' ? { output: 'export' as const } : {}),

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
