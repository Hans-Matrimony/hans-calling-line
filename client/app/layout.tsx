import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Barlow, Barlow_Condensed, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';

// Type roles: Barlow Condensed for the state word and the timer (reads at a glance from arm's length),
// Barlow for UI, IBM Plex Mono for numbers, times and the activity feed. Self-hosted at build time.
const ui = Barlow({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-ui' });
const display = Barlow_Condensed({ subsets: ['latin'], weight: ['500', '600', '700'], variable: '--font-display' });
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-mono' });

export const metadata: Metadata = { title: 'Eazybe Dialer' };
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#1e5eff' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${ui.variable} ${display.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
