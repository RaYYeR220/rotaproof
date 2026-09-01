import type { Metadata } from 'next';
import { JetBrains_Mono, Outfit } from 'next/font/google';

import './globals.css';
import AgentActivity from '@/components/AgentActivity';
import ConfirmOverlay from '@/components/ConfirmOverlay';
import ModelContextBridge from '@/components/ModelContextBridge';
import SiteNav from '@/components/SiteNav';

/**
 * Outfit carries the display and the prose; JetBrains Mono carries anything a machine
 * produced — rule ids, latencies, hashes, objective figures. Loaded through `next/font`
 * so the files are served from this origin: the roster never leaves the browser, and a
 * font request to a third party would be the only thing on the page that did.
 */
const outfit = Outfit({
  subsets: ['latin'],
  weight: ['300', '500', '600'],
  variable: '--font-outfit',
  display: 'swap',
});

const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400'],
  variable: '--font-mono-face',
  display: 'swap',
});

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
    <html lang="en" className={`${outfit.variable} ${jetbrains.variable}`}>
      <head>
        {ORIGIN_TRIAL_TOKEN ? <meta httpEquiv="origin-trial" content={ORIGIN_TRIAL_TOKEN} /> : null}
      </head>
      <body>
        <a href="#main" className="skip">
          Skip to main content
        </a>

        {/* Registers the tool surface for every route. Renders nothing. */}
        <ModelContextBridge />

        <div className="shell">
          <SiteNav />

          <main id="main">{children}</main>

          {/* Both live in the layout: an agent can call a tool while the human is anywhere. */}
          <AgentActivity />
        </div>

        <ConfirmOverlay />
      </body>
    </html>
  );
}
