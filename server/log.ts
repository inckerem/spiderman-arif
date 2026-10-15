/** Minimal levelled logger: one line per entry on stdout/stderr (Docker collects them). */
import type { LogLevel } from './config';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export interface Log {
  debug(msg: string, data?: object): void;
  info(msg: string, data?: object): void;
  warn(msg: string, data?: object): void;
  error(msg: string, data?: object): void;
}

export function createLog(level: LogLevel): Log {
  const min = ORDER[level];
  const write = (lvl: Exclude<LogLevel, 'silent'>, msg: string, data?: object): void => {
    if (ORDER[lvl] < min) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase()} ${msg}${data ? ' ' + JSON.stringify(data) : ''}`;
    if (ORDER[lvl] >= ORDER.warn) console.error(line);
    else console.log(line);
  };
  return {
    debug: (m, d) => write('debug', m, d),
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
  };
}

export const silentLog: Log = { debug() {}, info() {}, warn() {}, error() {} };
