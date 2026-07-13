import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import { parseDaliStore, BAGGAGE_TOKEN, MODULE_ID } from "@busforge/dca-theben-dali-e64";

// Client-side registry of native DCA-replacement modules, keyed by the module id
// the server resolves (see apps/server/src/dca.ts). Each entry knows how to parse
// its device's config baggage and lazily provides its read-only UI, so a module's
// code is only fetched when that device is opened.
export interface DcaModuleClient<M = unknown> {
  parse: (bytes: Uint8Array) => M;
  baggageToken: string; // baggage entry name (substring) this module consumes
  View: LazyExoticComponent<ComponentType<{ model: M }>>;
}

// Every module has its OWN model type, so the registry cannot be typed in the model and has to
// store them erased. `dcaModule` is the one place that erasure happens, and it earns it: the parser
// and the view are checked against each other HERE, which is exactly the check the `any` that used
// to sit on `View` skipped — nothing stopped a view being paired with a parser that produced
// something else entirely. The erasure is sound because DcaModuleDialog only ever hands a view the
// value that same module's parse() returned.
const dcaModule = <M,>(m: DcaModuleClient<M>): DcaModuleClient => m as DcaModuleClient;

export const dcaModules: Record<string, DcaModuleClient> = {
  [MODULE_ID]: dcaModule({
    parse: (bytes: Uint8Array) => parseDaliStore(bytes),
    baggageToken: BAGGAGE_TOKEN,
    View: lazy(() => import("@busforge/dca-theben-dali-e64/view")),
  }),
};

// Decode a base64 baggage entry to bytes.
export function decodeBaggage(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
