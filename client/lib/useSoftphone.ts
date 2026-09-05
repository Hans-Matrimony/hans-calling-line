import { useCallback, useEffect, useRef, useState } from 'react';
import type { TelnyxRTC, Call, INotification } from '@telnyx/webrtc';

export type SoftphoneStatus = 'off' | 'connecting' | 'ready' | 'in_call' | 'error';

/**
 * Browser audio (plan s9). Logs the Telnyx WebRTC client in with a short-lived JWT and auto-answers
 * the rep leg the server dials to sip:<sip_username>@sip.telnyx.com. The leg stays open all session;
 * beep, bridge and hangups are driven by Call Control on the server exactly as in phone mode.
 * The SDK is imported lazily: the page is a static export and the package touches `window`.
 */
export function useSoftphone() {
  const [status, setStatus] = useState<SoftphoneStatus>('off');
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const client = useRef<TelnyxRTC | null>(null);
  const call = useRef<Call | null>(null);

  const disconnect = useCallback(() => {
    try { call.current?.hangup(); } catch { /* already gone */ }
    try { client.current?.disconnect(); } catch { /* already gone */ }
    call.current = null; client.current = null;
    setStatus('off'); setMuted(false);
  }, []);

  const connect = useCallback(async (token: string) => {
    disconnect();
    setStatus('connecting'); setError(null);
    // Ask for the mic now so the auto-answer below is never stuck behind a permission prompt.
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((t) => t.stop());
    } catch (e) {
      setStatus('error');
      const why = (e as Error).name === 'NotAllowedError' ? 'microphone blocked - allow it for this site and try again' : 'no microphone: ' + (e as Error).message;
      setError(why); throw new Error(why);
    }

    const { TelnyxRTC } = await import('@telnyx/webrtc');
    const c = new TelnyxRTC({ login_token: token });
    c.remoteElement = 'remoteMedia';
    client.current = c;

    await new Promise<void>((resolve, reject) => {
      // The SDK wraps errors: telnyx.error -> { error: { message, code }, sessionId }.
      const fail = (kind: string, e: unknown) => {
        const inner = (e as { error?: { message?: string; code?: string | number } })?.error ?? (e as { message?: string });
        const msg = `${kind}: ${inner?.message ?? 'unknown'}${(inner as { code?: string | number })?.code != null ? ' (' + (inner as { code?: string | number }).code + ')' : ''}`;
        console.error('[softphone]', kind, e);
        setStatus('error'); setError(msg); reject(new Error(msg));
      };
      c.on('telnyx.ready', () => { setStatus('ready'); resolve(); });
      c.on('telnyx.error', (e: unknown) => fail('softphone error', e));
      c.on('telnyx.socket.error', (e: unknown) => fail('cannot reach rtc.telnyx.com (firewall/VPN?)', e));
      c.on('telnyx.socket.close', () => { call.current = null; setStatus('off'); });
      c.on('telnyx.notification', (n: INotification) => {
        if (n.type === 'userMediaError') { setStatus('error'); setError('microphone unavailable: ' + (n.error?.message ?? '')); return; }
        if (n.type !== 'callUpdate' || !n.call) return;
        const k = n.call;
        switch (k.state) {
          case 'ringing': call.current = k; k.answer(); break;       // the rep leg: answer, stay on it
          case 'active': call.current = k; setStatus('in_call'); break;
          case 'hangup': case 'destroy': call.current = null; setMuted(false); setStatus((s) => (s === 'off' ? s : 'ready')); break;
        }
      });
      c.connect();
    });
  }, [disconnect]);

  const toggleMute = useCallback(() => {
    const k = call.current; if (!k) return;
    if (muted) k.unmuteAudio(); else k.muteAudio();
    setMuted(!muted);
  }, [muted]);

  useEffect(() => () => disconnect(), [disconnect]);

  return { status, muted, error, connect, disconnect, toggleMute };
}
