// Minimal structured logger. Firm-local only — never ships telemetry off-box.
/* eslint-disable no-console */
type Level = 'debug' | 'info' | 'warn' | 'error';

function log(level: Level, msg: string, meta?: Record<string, unknown>): void {
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
  debug: (msg: string, meta?: Record<string, unknown>) =>
    process.env.DEBUG ? log('debug', msg, meta) : undefined,
  info: (msg: string, meta?: Record<string, unknown>) => log('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => log('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => log('error', msg, meta),
};
