// Coded errors for the hardware/bus layer. The `code` is duck-typed by the server's
// error mapper (apps/server errorCode()) into the {error:{code,message}} API shape and
// localized by the web client (locales en/de `errors` block). Same pattern as the
// project package's KnxprojError and the product package's ProductError.
//
// These wrap the failures that a normal bus operation actually hits (a gateway that
// stops ACKing, a device that goes quiet mid-flash, a read-back mismatch), so the UI
// shows a translated, actionable message instead of a raw 500 INTERNAL. Pure internal
// invariants / API misuse (a payload that is too long, a wrong-length key) stay as plain
// Error: they are programmer errors, not conditions a user can act on.
export class KnxError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "KnxError";
  }
}
