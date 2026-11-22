'use strict';
/**
 * Configuration is read exclusively from environment variables (§4.5:
 * "use environment variables for secret configuration"). `.env.example`
 * documents every key; `.env` is git-ignored.
 */
const fs = require('fs');
const path = require('path');

/** Load a KEY=VALUE file into process.env without overwriting real env vars. */
function loadEnvFile(file) {
  const p = path.resolve(file);
  if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

loadEnvFile(process.env.COEDIT_ENV_FILE || path.join(__dirname, '../../../.env'));

const num = (k, d) => parseInt(process.env[k] || d, 10);

const config = {
  jwtSecret: process.env.COEDIT_JWT_SECRET || 'dev-only-insecure-secret-change-me',
  internalKey: process.env.COEDIT_INTERNAL_KEY || 'dev-only-internal-key',
  dataDir: process.env.COEDIT_DATA_DIR || path.join(__dirname, '../../../data'),

  directoryUrl: process.env.DIRECTORY_URL || 'http://127.0.0.1:7000',
  storageUrl: process.env.STORAGE_URL || 'http://127.0.0.1:7100',

  directoryPort: num('DIRECTORY_PORT', 7000),
  storagePort: num('STORAGE_PORT', 7100),
  gatewayPort: num('GATEWAY_PORT', 8080),

  // Lease / failure detection (§4.4)
  leaseTtlMs: num('LEASE_TTL_MS', 6000),
  heartbeatMs: num('HEARTBEAT_MS', 2000),
  wsPingMs: num('WS_PING_MS', 5000),
  wsPongTimeoutMs: num('WS_PONG_TIMEOUT_MS', 12000),

  // Durability
  snapshotEveryOps: num('SNAPSHOT_EVERY_OPS', 200),
  persistBatchMs: num('PERSIST_BATCH_MS', 250),

  // Limits (§4.5)
  maxBodyBytes: num('MAX_BODY_BYTES', 1048576),
  maxOpsPerMessage: num('MAX_OPS_PER_MESSAGE', 512),
  maxDocChars: num('MAX_DOC_CHARS', 200000),
  rateLimitOpsPerSec: num('RATE_LIMIT_OPS_PER_SEC', 2000),
};

function requireSecrets(logger) {
  if (config.jwtSecret.startsWith('dev-only') && process.env.NODE_ENV === 'production') {
    throw new Error('COEDIT_JWT_SECRET must be set in production');
  }
  if (logger && config.jwtSecret.startsWith('dev-only')) {
    logger.warn('insecure_secret_in_use', { hint: 'set COEDIT_JWT_SECRET in .env' });
  }
}

module.exports = { config, loadEnvFile, requireSecrets };
