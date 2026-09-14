// Test-only replacement: never requests microphone access or imports the Telnyx SDK.
const { useState } = require('react');
exports.useSoftphone = function useSoftphone() {
  const [status, setStatus] = useState('ready');
  const [muted, setMuted] = useState(false);
  window.testAudio = setStatus;
  return { status, muted, error: null, connect: async () => setStatus('ready'), disconnect: () => setStatus('off'), toggleMute: () => setMuted((v) => !v) };
};
