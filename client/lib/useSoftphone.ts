import { useCallback, useEffect, useRef, useState } from 'react';
import type { Client } from 'plivo-browser-sdk/client';

export type SoftphoneStatus = 'off' | 'connecting' | 'ready' | 'in_call' | 'error';
type CallInfo = { callUUID?: string };
const LOGIN_TIMEOUT_MS = 20000;

/** The SDK is loaded only in the browser. Account credentials and SIP passwords never enter it. */
export function useSoftphone() {
  const [status, setStatus] = useState<SoftphoneStatus>('off');
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const client = useRef<Client | null>(null);
  const activeCall = useRef<string | null>(null);
  const generation = useRef(0);
  const pending = useRef<{ reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null>(null);

  const disconnect = useCallback(() => {
    generation.current++;
    const waiting = pending.current; pending.current = null;
    if (waiting) { clearTimeout(waiting.timer); waiting.reject(new Error('Audio connection cancelled')); }
    const c = client.current; client.current = null;
    if (c) {
      c.removeAllListeners();
      try { if (activeCall.current) c.hangup(); } catch { /* already ended */ }
      try { c.logout(); } catch { /* already disconnected */ }
    }
    activeCall.current = null;
    setStatus('off'); setMuted(false);
  }, []);

  const connect = useCallback(async (token: string) => {
    disconnect();
    const current = generation.current;
    const isCurrent = () => generation.current === current;
    setStatus('connecting'); setError(null);
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Browser audio needs HTTPS or localhost and a microphone.');
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach(track => track.stop());
      if (!isCurrent()) throw new Error('Audio connection cancelled');
      const { default: Plivo } = await import('plivo-browser-sdk');
      if (!isCurrent()) throw new Error('Audio connection cancelled');
      const c = new Plivo({ debug: 'ERROR', permOnClick: true, enableTracking: false, closeProtection: false }).client;
      c.setRingTone(false); c.setConnectTone(false);
      client.current = c;
      await new Promise<void>((resolve, reject) => {
        const fail = (message: string) => {
          if (!isCurrent()) return;
          const waiting = pending.current; pending.current = null;
          if (waiting) { clearTimeout(waiting.timer); waiting.reject(new Error(message)); }
          setError(message); setStatus('error');
        };
        const timer = setTimeout(() => fail('Audio login timed out after 20 seconds.'), LOGIN_TIMEOUT_MS);
        pending.current = { reject, timer };
        c.on('onLogin', () => {
          console.log('[softphone] onLogin');
          if (!isCurrent()) return;
          clearTimeout(timer); pending.current = null; setStatus('ready'); setError(null); resolve();
        });
        c.on('onLoginFailed', (code: number) => { console.log('[softphone] onLoginFailed', code); fail(c.getErrorStringByErrorCodes(code) || 'Plivo audio login failed.'); });
        c.on('onConnectionChange', (info: { state?: string }) => {
          console.log('[softphone] onConnectionChange', info?.state);
          if (!isCurrent() || info.state !== 'disconnected') return;
          fail('Audio connection lost. Press Connect to reconnect.');
        });
        c.on('onIncomingCall', (_caller: string, _headers: unknown, info: CallInfo) => {
          console.log('[softphone] onIncomingCall', info?.callUUID);
          if (!isCurrent() || !info?.callUUID) return;
          if (activeCall.current) { c.reject(info.callUUID); return; }
          activeCall.current = info.callUUID;
          if (!c.answer(info.callUUID, 'reject')) { activeCall.current = null; fail('Could not answer the audio connection.'); }
        });
        c.on('onCallAnswered', (info: CallInfo) => {
          if (!isCurrent() || info?.callUUID !== activeCall.current) return;
          setStatus('in_call'); setError(null);
        });
        const ended = (info: CallInfo) => {
          if (!isCurrent() || info?.callUUID !== activeCall.current) return;
          activeCall.current = null; setMuted(false); setStatus('ready');
        };
        c.on('onCallTerminated', (_cause: unknown, info: CallInfo) => ended(info));
        c.on('onIncomingCallCanceled', ended);
        c.on('onCallFailed', (cause: string, info: CallInfo) => { ended(info); if (isCurrent()) setError(String(cause || 'Audio call failed.')); });
        c.on('onMediaPermission', (event: { status?: string; error?: string }) => {
          if (event.status === 'failure') fail('Microphone unavailable: ' + (event.error || 'check browser permission'));
        });
        c.on('onWebrtcNotSupported', () => fail('This browser does not support audio calling.'));
        if (!c.loginWithAccessToken(token)) fail('Plivo rejected the audio login request.');
      });
    } catch (cause) {
      if (isCurrent()) {
        disconnect();
        const message = (cause as Error).name === 'NotAllowedError'
          ? 'Microphone blocked. Allow it for this site and try again.' : (cause as Error).message;
        setStatus('error'); setError(message);
      }
      throw cause;
    }
  }, [disconnect]);

  const toggleMute = useCallback(() => {
    const c = client.current;
    if (!c || !activeCall.current) return;
    if (muted) c.unmute(); else c.mute();
    setMuted(!muted);
  }, [muted]);
  useEffect(() => () => disconnect(), [disconnect]);
  return { status, muted, error, connect, disconnect, toggleMute };
}
