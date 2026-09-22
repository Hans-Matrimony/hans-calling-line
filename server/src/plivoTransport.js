import plivo from 'plivo';
export const need = (key) => {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(key + ' is not set (server/.env)');
  return value;
};
export const publicUrl = () => need('PUBLIC_URL').replace(/\/$/, '');
export const callbackUrl = (path, id, extra = {}) => publicUrl() + '/webhooks/plivo/' + path +
  (id ? '?' + new URLSearchParams({ id, ...extra }) : '');
export const encodeState = (state) => Buffer.from(JSON.stringify(state)).toString('base64');
export const decodeState = (value) => { try { return JSON.parse(Buffer.from(value, 'base64').toString()); } catch { return null; } };
export const authHeader = () => 'Basic ' + Buffer.from(need('PLIVO_AUTH_ID') + ':' + need('PLIVO_AUTH_TOKEN')).toString('base64');

export async function plivoRequest(path, method = 'GET', body) {
  const url = 'https://api.plivo.com/v1/Account/' + encodeURIComponent(need('PLIVO_AUTH_ID')) + '/' + path;
  const response = await fetch(url, {
    method, headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000),
  });
  const text = response.status === 204 ? '' : await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text.slice(0, 200) }; }
  if (!response.ok) {
    const error = new Error(typeof data.error === 'string' ? data.error : data.message ?? 'Plivo request failed (' + response.status + ')');
    error.status = response.status;
    throw error;
  }
  return data;
}
export function validWebhook(req) {
  const signature = req.get('X-Plivo-Signature-V3');
  const nonce = req.get('X-Plivo-Signature-V3-Nonce');
  if (!signature || !nonce || !process.env.PLIVO_AUTH_TOKEN) return false;
  // Reconstruct from the configured public URL, never untrusted Host / forwarded headers.
  const url = publicUrl() + req.originalUrl;
  return plivo.validateV3Signature(req.method, url, nonce, need('PLIVO_AUTH_TOKEN'), signature, req.body ?? {});
}
