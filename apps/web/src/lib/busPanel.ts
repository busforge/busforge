// Opens the bus popover in the header (connection choice, connect, the bus queue) from anywhere on
// the page: an empty monitor or a flash that has no connection to use leads the user there.
const EVENT = "busforge:open-bus-panel";

export function openBusPanel(): void {
  window.dispatchEvent(new Event(EVENT));
}

export function onOpenBusPanel(handler: () => void): () => void {
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
