// Coded errors for the product layer. The `code` is duck-typed by the server's error
// mapper (apps/server errorCode()) into the {error:{code,message}} API shape, and the
// web client localizes it (locales en/de `errors` block). Same pattern as the project
// package's KnxprojError.
export class ProductError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ProductError";
  }
}
