import { useCallback, useEffect, useRef, useState } from 'react';
import type { TelnyxRTC, Call, INotification } from '@telnyx/webrtc';

export type SoftphoneStatus = 'off' | 'connecting' | 'ready' | 'in_call' | 'error';

const EVENTS = ['telnyx.ready', 'telnyx.error', 'telnyx.socket.error', 'telnyx.socket.close', 'telnyx.notification'] as const;
const LOGIN_TIMEOUT_MS = 20000;

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
  const connecting = useRef(false); // errors are fatal for connect() only while this is true

  const disconnect = useCallback(() => {
    // The SDK's own disconnect() purges and BYEs every call still live and skips ones the server already
    // ended - so no explicit call.hangup() here: sending our own BYE first made the SDK send a second one
    // and log "telnyx_rtc.bye failed!". Handlers come off first so a torn-down client cannot report back.
    const c = client.current;
    client.current = null; call.current = null; connecting.current = false;
    if (c) {
      for (const ev of EVENTS) { try { c.off(ev); } catch { /* already gone */ } }
      try { c.disconnect(); } catch { /* already gone */ }
    }
    setStatus('off'); setMuted(false);
  }, []);

  const connect = useCallback(async (token: string) => {
    disconnect();
    setStatus('connecting'); setError(null); connecting.current = true;
    // Ask for the mic now so the auto-answer below is never stuck behind a permission prompt.
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((t) => t.stop());
    } catch (e) {
      setStatus('error'); connecting.current = false;
      const why = (e as Error).name === 'NotAllowedError' ? 'Microphone blocked - allow it for this site and try again.' : 'No microphone: ' + (e as Error).message;
      setError(why); throw new Error(why);
    }

    const { TelnyxRTC } = await import('@telnyx/webrtc');
    const c = new TelnyxRTC({ login_token: token });
    c.remoteElement = 'remoteMedia';
    client.current = c;
    const isCurrent = () => client.current === c; // a reconnect swaps the client; the old one's late events are ignored

    await new Promise<void>((resolve, reject) => {
      const fail = (text: string, e?: unknown) => {
        console.warn('[softphone]', text, e ?? '');
        setStatus('error'); setError(text); connecting.current = false; reject(new Error(text));
      };
      // Belt and braces: whatever the SDK's event order, connect() settles, so the UI never wedges on `busy`.
      const timer = setTimeout(() => { if (!isCurrent() || !connecting.current) return; disconnect(); fail('softphone: login timed out after 20s'); }, LOGIN_TIMEOUT_MS);
      // The SDK wraps errors: telnyx.error -> { error: { message, code }, sessionId }. socket.error is a raw Event.
      const describe = (e: unknown) => {
        const inner = (e as { error?: { message?: string; code?: string | number } })?.error ?? (e as { message?: string });
        const code = (inner as { code?: string | number })?.code;
        return inner?.message ? `${inner.message}${code != null ? ' (' + code + ')' : ''}` : 'unknown';
      };
      const onError = (kind: string, e: unknown) => {
        if (!isCurrent()) return;
        const text = `${kind}: ${describe(e)}`;
        if (connecting.current) { clearTimeout(timer); fail(text, e); return; } // login failed: fatal for connect()
        // 44003 "Failed to hang up cleanly": the SDK BYEd a leg the server had already ended (previous lead gone while
        // the rep leg sits parked). The call is over either way and there is nothing for the rep to do - keep it off the screen.
        if (/Failed to hang up cleanly/i.test(text) || /44003/.test(text)) { console.warn('[softphone] benign:', text, e); return; }
        console.warn('[softphone]', text, e); setError(text);           // live client: always surfaced
      };
      c.on('telnyx.ready', () => { if (!isCurrent()) return; clearTimeout(timer); connecting.current = false; setStatus('ready'); resolve(); });
      c.on('telnyx.error', (e: unknown) => onError('softphone error', e));
      c.on('telnyx.socket.error', (e: unknown) => onError('cannot reach rtc.telnyx.com (firewall/VPN?)', e));
      c.on('telnyx.socket.close', () => {
        if (!isCurrent()) return;
        if (connecting.current) { clearTimeout(timer); fail('softphone: connection closed before login'); return; }
        call.current = null; setStatus('off');
      });
      c.on('telnyx.notification', (n: INotification) => {
        if (!isCurrent()) return;
        if (n.type === 'userMediaError') { setStatus('error'); setError('Microphone unavailable: ' + (n.error?.message ?? '')); return; }
        if (n.type !== 'callUpdate' || !n.call) return;
        const k = n.call;
        switch (k.state) {
          case 'ringing': call.current = k; setError(null); k.answer(); break;       // the rep leg: answer, stay on it; a stale error from the last call is history
          case 'active': call.current = k; setError(null); setStatus('in_call'); break;
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
