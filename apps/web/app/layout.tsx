import type { Metadata } from 'next';

import './globals.css';
import AgentActivity from '@/components/AgentActivity';
import ConfirmOverlay from '@/components/ConfirmOverlay';
import ModelContextBridge from '@/components/ModelContextBridge';
import SiteNav from '@/components/SiteNav';

export const metadata: Metadata = {
  title: 'RotaProof',
  description:
    'Plans a week of café shifts in the browser with an exact solver, and proves why a week is impossible when it is.',
};

/**
 * The response header is the primary route for the origin trial; the meta tag is the
 * fallback for hosts that strip response headers.
 */
const ORIGIN_TRIAL_TOKEN = process.env.WEBMCP_ORIGIN_TRIAL_TOKEN;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {ORIGIN_TRIAL_TOKEN ? <meta httpEquiv="origin-trial" content={ORIGIN_TRIAL_TOKEN} /> : null}
      </head>
      <body className="mx-auto max-w-5xl px-4 pb-24 pt-4 text-sm">
        <a
          href="#main"
          className="absolute left-[-9999px] focus:static focus:inline-block focus:p-2 focus:underline"
        >
          Skip to main content
        </a>

        {/* Registers the tool surface for every route. Renders nothing. */}
        <ModelContextBridge />

        <SiteNav />

        <main id="main">{children}</main>

        {/* Both live in the layout: an agent can call a tool while the human is anywhere. */}
        <AgentActivity />
        <ConfirmOverlay />
      </body>
    </html>
  );
}
