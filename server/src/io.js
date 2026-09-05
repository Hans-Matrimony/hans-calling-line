// Socket.IO handle shared with routes and the webhook handler without circular imports.
export let io = null;
export const setIo = (instance) => { io = instance; };
export const emitToUser = (userId, event, payload) => io?.to(`user:${userId}`).emit(event, payload);
