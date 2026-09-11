export { rehydrate } from './core/rehydrate.js';
// DEFAULT_CONFIDENCE is exported because the rule-pack docs name it as the
// score an unscored finding receives — a pack author should be able to import
// it rather than hardcode 0.5 and hope it never moves.
export { DEFAULT_CONFIDENCE, scrub } from './core/scrub.js';
export { SessionManager } from './session/session-manager.js';
export * from './types/index.js';
