import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Hanken_Grotesk, Saira_Semi_Condensed, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';
import './admin.css';
import './workspace.css';

// Three voices (call-card v2 polish). Hanken Grotesk: the humanist-grotesque workhorse for all UI and
// body — calm and razor-legible at 12-15px through an 8-hour shift, and distinctly not Inter/Roboto.
// IBM Plex Mono: every piece of live data (phone numbers, the call timer, stats, counts, feed/queue
// times) so numerics are tabular by construction. Saira SemiCondensed: reserved for the two brand-
// signage moments (the Eazybe wordmark and the campaign hero). Variables are named per family; the
// role tokens (--font-ui / --font-display / --font-mono) compose them in globals.css :root so there is
// no cascade collision. Self-hosted at build time.
const ui = Hanken_Grotesk({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-hanken', display: 'swap' });
const display = Saira_Semi_Condensed({ subsets: ['latin'], weight: ['600', '700'], variable: '--font-saira', display: 'swap' });
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-plex-mono', display: 'swap' });

export const metadata: Metadata = { title: 'Eazybe Dialer' };
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#1e5eff' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${ui.variable} ${display.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
