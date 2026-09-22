// Test-only replacement: never requests microphone access or imports the Telnyx SDK.
const { useState } = require('react');
exports.useSoftphone = function useSoftphone() {
  const [status, setStatus] = useState(new URLSearchParams(location.search).get('audio') === 'off' ? 'off' : 'in_call');
  const [muted, setMuted] = useState(false);
  window.testAudio = setStatus;
  return { status, muted, error: null, connect: async () => { if (window.testAudioFailure) throw new Error('Microphone blocked. Allow it for this site and try again.'); setStatus('ready'); }, disconnect: () => setStatus('off'), toggleMute: () => setMuted((v) => !v) };
};
