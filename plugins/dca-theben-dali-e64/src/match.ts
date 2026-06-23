// Module manifest + compatibility evaluation. A DCA-replacement module declares
// which device it replaces (by the identifiers present in the .knxproj) and which
// application versions it was actually built and tested against. The host uses
// this to decide: matched + compatible (use it), matched + incompatible version
// (offer it at the user's own risk), or no match (fall back to the generic notice).

export const MODULE_ID = "theben-dali-e64";

export interface DcaManifest {
  id: string;
  displayName: string;
  /** Short, generic kind shown in the device notice, e.g. "DALI configuration".
   *  Lets the host present what a module is without hardcoding device specifics. */
  category: string;
  /** Application-program id prefix, stable across the version digits, e.g. the
   *  Theben DALI gateway is "M-0048_A-9071" (manufacturer M-0048, app 0x9071). */
  appIdPrefix: string;
  /** The DCA AppId from the bundled AddInManifest.xml, for reference/diagnostics. */
  dcaAppId?: string;
  /** ETS ApplicationVersion values this module was built against and verified on. */
  compatibleAppVersions: number[];
  /** The baggage entry (by name token) this module parses. */
  baggageToken: string;
}

export const manifest: DcaManifest = {
  id: MODULE_ID,
  displayName: "Theben DALI-Gateway KNX plus",
  category: "DALI configuration",
  appIdPrefix: "M-0048_A-9071",
  dcaAppId: "M0048-A00C8",
  compatibleAppVersions: [32], // verified against a device (ApplicationVersion 32)
  baggageToken: "Dalie64",
};

export interface MatchResult { matched: boolean; compatible: boolean }

export function evaluate(appId: string | undefined, appVersion: number): MatchResult {
  const matched = !!appId && appId.startsWith(manifest.appIdPrefix);
  return { matched, compatible: matched && manifest.compatibleAppVersions.includes(appVersion) };
}

// Back-compat helper used by simple call sites.
export const matchesApp = (appId: string | undefined): boolean => evaluate(appId, NaN).matched;
export const BAGGAGE_TOKEN = manifest.baggageToken;
