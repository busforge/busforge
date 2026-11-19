import { expect, test } from "bun:test";
import { ApiError, Client } from "./client.ts";

test("ensureGa refuses an address outside the three-level ranges before any request", async () => {
  const client = new Client("http://unreachable.invalid");
  for (const bad of ["40/9/300", "32/0/0", "0/8/0", "0/0/256", "1/2", "a/b/c", ""]) {
    const err = await client.ensureGa("p", bad).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("GA_BAD");
  }
});
