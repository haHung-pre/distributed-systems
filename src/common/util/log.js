'use strict';
/**
 * Structured JSON-line logger.
 * Every record carries: ts, node (unique identity), level, event, corr
 * (correlation id) and free-form fields — satisfying §4.1 "logs showing
 * nodes, timestamps, event types and processing results".
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const COLORS = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
const RESET = '\x1b[0m';

function createLogger(node, opts = {}) {
  const min = LEVELS[process.env.LOG_LEVEL] || LEVELS[opts.level || 'info'];
  const pretty = process.env.LOG_FORMAT !== 'json';
  function emit(level, event, fields) {
    if (LEVELS[level] < min) return;
    const rec = { ts: new Date().toISOString(), node, level, event, ...fields };
    if (pretty) {
      const { ts, ...rest } = rec;
      delete rest.node; delete rest.level; delete rest.event;
      const extra = Object.keys(rest).length ? ' ' + JSON.stringify(rest) : '';
      process.stdout.write(`${COLORS[level]}${ts} [${node}] ${level.toUpperCase().padEnd(5)} ${event}${RESET}${extra}\n`);
    } else {
      process.stdout.write(JSON.stringify(rec) + '\n');
    }
  }
  return {
    debug: (e, f) => emit('debug', e, f),
    info: (e, f) => emit('info', e, f),
    warn: (e, f) => emit('warn', e, f),
    error: (e, f) => emit('error', e, f),
    child: (suffix) => createLogger(`${node}/${suffix}`, opts),
  };
}

module.exports = { createLogger };
