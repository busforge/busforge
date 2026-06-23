// Server-side registry of busforge-native DCA-replacement modules. Each entry
// knows which device it replaces and which application versions it supports; the
// server resolves a device to a module (with compatibility) so the UI can offer
// the native view instead of the manufacturer's Windows-only ETS DCA. The module's
// UI is lazy-loaded on the web side by `id`; here we only need its manifest+match.
import type { DcaModuleInfo } from "@busforge/product";
import { manifest as thebenDaliE64, evaluate as evalThebenDaliE64 } from "@busforge/dca-theben-dali-e64";

const REGISTRY = [{ manifest: thebenDaliE64, evaluate: evalThebenDaliE64 }];

// Resolve the best module for a device's application program, or undefined.
export function resolveDcaModule(appId: string, appVersion: number): DcaModuleInfo | undefined {
  for (const m of REGISTRY) {
    const r = m.evaluate(appId, appVersion);
    if (r.matched) {
      return {
        id: m.manifest.id,
        displayName: m.manifest.displayName,
        category: m.manifest.category,
        compatible: r.compatible,
        deviceVersion: appVersion,
        supportedVersions: m.manifest.compatibleAppVersions,
      };
    }
  }
  return undefined;
}
