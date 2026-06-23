import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import { parseDaliStore, BAGGAGE_TOKEN, MODULE_ID } from "@busforge/dca-theben-dali-e64";

// Client-side registry of native DCA-replacement modules, keyed by the module id
// the server resolves (see apps/server/src/dca.ts). Each entry knows how to parse
// its device's config baggage and lazily provides its read-only UI, so a module's
// code is only fetched when that device is opened.
export interface DcaModuleClient {
  parse: (bytes: Uint8Array) => unknown;
  baggageToken: string; // baggage entry name (substring) this module consumes
  View: LazyExoticComponent<ComponentType<{ model: any }>>;
}

export const dcaModules: Record<string, DcaModuleClient> = {
  [MODULE_ID]: {
    parse: (bytes) => parseDaliStore(bytes),
    baggageToken: BAGGAGE_TOKEN,
    View: lazy(() => import("@busforge/dca-theben-dali-e64/view")),
  },
};

// Decode a base64 baggage entry to bytes.
export function decodeBaggage(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
