import type { NextConfig } from 'next';

// Static export: the built site in client/out is served by the Express server in production
// (one origin, no CORS). `next dev` is unaffected.
const nextConfig: NextConfig = { output: 'export', reactStrictMode: true };
export default nextConfig;
