import { AsyncLocalStorage } from 'node:async_hooks';
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
    if (!scope.getStore()) globalThis.console.log(...args);
  },
  warn: (...args: unknown[]) => {
    if (!scope.getStore()) globalThis.console.warn(...args);
  },
  error: (...args: unknown[]) => {
    if (!scope.getStore()) globalThis.console.error(...args);
  },
  debug: (...args: unknown[]) => {
    if (!scope.getStore()) globalThis.console.debug(...args);
  },
  info: (...args: unknown[]) => {
    if (!scope.getStore()) globalThis.console.info(...args);
  },
};
