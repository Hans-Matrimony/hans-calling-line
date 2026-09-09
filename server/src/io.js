// Socket.IO handle shared with routes and the webhook handler without circular imports.
export let io = null;
export const setIo = (instance) => { io = instance; };
export const emitToUser = (userId, event, payload) => io?.to(`user:${userId}`).emit(event, payload);
export const emitToAdmins = (event, payload) => io?.to('admin').emit(event, payload);
// A burst of webhooks (answered, bridged, hangup, cost) becomes ONE 'admin:poke' so the dashboard
// refetches once, not five times. Kinds are informational.
let pokeTimer = null; const pokeKinds = new Set();
export const pokeAdmins = (kind) => {
  pokeKinds.add(kind);
  if (pokeTimer) return;
  pokeTimer = setTimeout(() => { emitToAdmins('admin:poke', { kinds: [...pokeKinds] }); pokeKinds.clear(); pokeTimer = null; }, 400);
};
