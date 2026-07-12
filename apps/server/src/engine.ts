/**
 * Public engine surface for embedding the apply pipeline inside another dev
 * server (bundler plugins) instead of running the standalone Fastify server.
 * Everything here is Fastify-decoupled: pure functions plus a connect-style
 * middleware. Import via `@dev-sync/server/engine`.
 */
export { applyPayload, describeTemplate } from "./apply.js";
export { verifyChecks } from "./verify.js";
export { createApplyMiddleware } from "./middleware.js";
export type { ConnectMiddleware } from "./middleware.js";
export { configFromRoot } from "./config.js";
export type { Config } from "./config.js";
