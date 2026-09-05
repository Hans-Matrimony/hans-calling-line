// Per-process session state. One rep in the MVP; after a server restart he just clicks Connect me again.
export const repUp = new Set();        // userIds whose phone leg is answered
export const activeBurst = new Map();  // userId -> burstId currently in flight (cleared by disposition or no-answer)
