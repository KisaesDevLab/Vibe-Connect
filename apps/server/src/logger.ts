// Minimal structured logger. Firm-local only — never ships telemetry off-box.
/* eslint-disable no-console */
type Level = 'debug' | 'info' | 'warn' | 'error';

// Numeric thresholds so the runtime gate is a single integer compare. The
// gate is read ONCE at module import; flipping LOG_LEVEL mid-process has no
// effect, which matches every other env-driven knob in env.ts.
const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const DEFAULT_LEVEL: Level = process.env.NODE_ENV === 'test' ? 'warn' : 'info';
const rawLevel = (process.env.LOG_LEVEL ?? DEFAULT_LEVEL).toLowerCase() as Level;
// Reject typos at boot rather than silently demoting to a default — a noisy
// log is recoverable; an accidentally-silent error log is not.
const threshold: number =
  rawLevel in LEVELS
    ? LEVELS[rawLevel]
    : (() => {
        throw new Error(
          `Invalid LOG_LEVEL=${rawLevel}; expected one of ${Object.keys(LEVELS).join(', ')}`,
        );
      })();

function log(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    msg,
    ...(meta ?? {}),
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
}

export const logger = {
  // DEBUG kept as a separate boolean for backwards compatibility with the
  // legacy contract — process.env.DEBUG=1 still flips debug logs on regardless
  // of LOG_LEVEL, so an operator chasing a one-shot bug doesn't need to know
  // both knobs.
  debug: (msg: string, meta?: Record<string, unknown>) =>
    process.env.DEBUG ? log('debug', msg, meta) : undefined,
  info: (msg: string, meta?: Record<string, unknown>) => log('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => log('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => log('error', msg, meta),
};
