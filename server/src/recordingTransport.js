import { authHeader } from './plivoTransport.js';
export async function fetchRecording(url, headers = {}) {
  const target = new URL(url);
  if (target.protocol !== 'https:') throw new Error('Recording URL must use HTTPS');
  const trusted = target.hostname === 'plivo.com' || target.hostname.endsWith('.plivo.com');
  let response = await fetch(url, { headers: { ...headers, ...(trusted ? { Authorization: authHeader() } : {}) }, redirect: 'manual', signal: AbortSignal.timeout(20000) });
  for (let attempt = 0; response.status >= 300 && response.status < 400 && attempt < 3; attempt++) {
    const location = response.headers.get('location');
    if (!location) break;
    url = new URL(location, url).href;
    if (new URL(url).protocol !== 'https:') throw new Error('Recording redirect must use HTTPS');
    response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(20000) });
  }
  return response;
}
