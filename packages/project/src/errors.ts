// Coded errors for the .knxproj load path. The `code` is surfaced by the API
// server (which reads it duck-typed) so the web client can localize it. `message`
// is the English fallback.
export class KnxprojError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "KnxprojError";
  }
}
