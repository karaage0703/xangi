// Navigation uses the browser's session history; no parallel URL stack or storage.
export const HISTORY_EVENT = 'xangi:navigation';
type BrowserNavigation = EventTarget & { canGoBack: boolean; canGoForward: boolean };
const navigation = () => (window as Window & { navigation?: BrowserNavigation }).navigation;
let started = false;
export function initializeHistory() {
  if (started) return;
  started = true;
  const update = () => window.dispatchEvent(new Event(HISTORY_EVENT));
  navigation()?.addEventListener('currententrychange', update);
  window.addEventListener('popstate', update);
  window.addEventListener('pageshow', update);
}
export function historyAvailability() {
  const nav = navigation();
  // Older browsers expose no forward-state query. Keep controls usable;
  // History.back/forward are no-ops when there is no destination.
  return { back: nav?.canGoBack ?? true, forward: nav?.canGoForward ?? true };
}
export function goHistory(direction: -1 | 1) {
  if (direction < 0) history.back();
  else history.forward();
}
