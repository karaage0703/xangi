/** 応答後にSIGTERMを送り、共通shutdown経路から再起動する。 */
export function requestProcessRestart(delayMs: number): void {
  setTimeout(() => {
    process.kill(process.pid, 'SIGTERM');
  }, delayMs);
}
