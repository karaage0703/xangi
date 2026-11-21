import { AsyncLocalStorage } from 'node:async_hooks';
import { secretFilterFromEnv } from './secret-filter.js';
const scope = new AsyncLocalStorage<boolean>();
export function isPrivateExecution(): boolean {
  return scope.getStore() === true;
}
export function withPrivateDiagnostics<T>(enabled: boolean, fn: () => T): T {
  return scope.run(enabled, fn);
}
/** Used by AI runners: stderr/tool arguments can contain conversation text. */
export const privacyConsole = {
  log: (...args: unknown[]) => {
    if (!scope.getStore()) globalThis.console.log(...secretFilterFromEnv().redactValue(args));
  },
  warn: (...args: unknown[]) => {
    if (!scope.getStore()) globalThis.console.warn(...secretFilterFromEnv().redactValue(args));
  },
  error: (...args: unknown[]) => {
    if (!scope.getStore()) globalThis.console.error(...secretFilterFromEnv().redactValue(args));
  },
  debug: (...args: unknown[]) => {
    if (!scope.getStore()) globalThis.console.debug(...secretFilterFromEnv().redactValue(args));
  },
  info: (...args: unknown[]) => {
    if (!scope.getStore()) globalThis.console.info(...secretFilterFromEnv().redactValue(args));
  },
};
