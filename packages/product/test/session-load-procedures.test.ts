import { test, expect } from "bun:test";
import type { KnxDevice } from "@busforge/knx";
import { parseAppConfig, classify, activeColorValues } from "../src/index.ts";
import { catalogueXml } from "../../../tools/corpus.ts";
import { corpusDescribe } from "../../../tools/corpus-test.ts";

// A write runs inside an open device session, on a tunnel that must keep answering its gateway: over
// KNXnet/IP UDP every tunnelling request the gateway sends has to be acknowledged within 1 s, and a
// gateway closes a channel whose client misses that twice (Busforge's own bridge does). Parsing an
// application program blocks the process for as long as it takes, a second and more for a large one,
// several on a slow host. So a write takes the load procedures from the application its profile was
// classified from, parsed before the session opened, and never parses the XML again inside it.
//
// Here every write gets XML that cannot be parsed. A write that still parsed it would fail on the parser;
// one that does not gets as far as its own first refusal or its first use of the device.
const UNPARSEABLE = "<";
const untouched = new Proxy({}, { get: (_t, k) => () => { throw new Error(`the device was used: ${String(k)}`); } }) as unknown as KnxDevice;
const failure = (p: Promise<unknown>) => p.then(() => null, (x: unknown) => x as { code?: string; message?: string });

// The XML is read inside the corpus-guarded suite, never while this module loads.
const cases = [
  // Theben DALI-Gateway KNX plus, System B: "Colour Control Type" (P-53) = 2 puts a colour in use.
  { family: "System B", xml: () => catalogueXml("M-0048_A-9071-20-F258-O00EF.xml.gz"), colourType: ["M-0048_A-9071-20-F258-O00EF_P-53_R-41", "2"] as const },
  // MDT BE-06001.02, System 7, with "Time for long keypress" (P-8) declared an RGB colour.
  {
    family: "System 7",
    xml: () => catalogueXml("M-0083_A-00B4-32-3919.xml.gz").replace(
      'ParameterType="M-0083_A-00B4-32-3919_PT-TimeforLongSwitch0.2C1.2D30s" Text="Time for long keypress (Basic setting)"',
      'ParameterType="M-0083_A-00B4-32-3919_PT-RGBColor" Text="Time for long keypress (Basic setting)"'),
    colourType: ["M-0083_A-00B4-32-3919_P-8_R-7", "#000000"] as const,
  },
];

for (const c of cases) {
  corpusDescribe(`${c.family}: a write takes its load procedures from the application parsed before the session`, () => {
    const cfg = parseAppConfig(c.xml());
    const profile = classify(cfg);
    const base = new Map<string, string>([c.colourType]);
    const [colourRef] = [...activeColorValues(cfg, base, [])].map(([ref]) => ref);
    const ctx = { deviceId: "d", ia: "1.1.1", appXml: UNPARSEABLE, params: new Map(base).set(colourRef, "#102030"), baseParams: base, links: [], moduleInstances: [], dryRun: false, persistBackups: () => "backup" };

    test("the parameter flash", async () => {
      expect((await failure(profile.flashParameters(untouched, cfg.mask, ctx)))?.code).toBe("PARAM_COLOR_UNSUPPORTED");
    });

    test("the structural flash", async () => {
      expect(profile.capabilities().structuralFlash).toBe(true);
      expect((await failure(profile.flashStructure(untouched, cfg.mask, ctx)))?.code).toBe("PARAM_COLOR_UNSUPPORTED");
    });

    test("the full download", async () => {
      expect(profile.capabilities().fullDownload).toBe(true);
      expect((await failure(profile.downloadFull(untouched, cfg.mask, { ...ctx, params: new Map() })))?.message).toStartWith("the device was used");
    });
  });
}
