import type { DeviceSpec } from "../spec.ts";

// The same bench Jung 400021SE as jung-400021se.ts, in KNX Data Secure mode: ETS 6 commissioned it from
// its certificate (last on 2026-10-01, after a master reset) with one secured group address, 0/0/1 on
// K1's "Ausgang" (#253, read + transmit), and 1.1.100 (the bench bridge's tunnel address) assigned as a
// sender of 0/0/1, so the device's security table lists it beside the GVS AMMA, which transmits on 0/0/1
// too (docs/findings.md §22). The plain spec cannot drive it any more:
// its keys exist only in that ETS project, so this spec imports the project file (the export is kept
// outside the repository because it holds the keys; its password comes from
// BUSFORGE_SMOKE_KNXPROJ_PASSWORD) and runs every bus operation through a secure session.
//
// Behaviours: K1's secured object answers a secured read from the witness, after this run's full
// download wrote and verified the security object (key table, flags, and 1.1.100 in the sender
// table); the answer alone does not tell that write from ETS's identical one, the download's verify
// does. K2's plain object answers a plain read on a fresh address. The run ends with the Data Secure
// robustness checks and a restore to the project file's configuration (docs/testing.md).
export const jung400021seSecure: DeviceSpec = {
  id: "jung-400021se-secure",
  device: {
    appRef: "M-0004_H-4.20.2F.2F.20400021SE-0-O000A_HP-7072-21-99A7-O000A",
    productRef: "M-0004_H-4.20.2F.2F.20400021SE-0-O000A_P-400021SE",
    ia: "1.1.204",
    mask: "MV-07B0",
    knxprod: "scratchpad/bench-jung-ets-20261001.knxproj",
  },
  provision: "import-knxproj",
  configure: [
    { set: { paramRefId: "M-0004_A-7072-21-99A7-O000A_MD-1_M-100_MI-1_P-2_R-2", value: "0" } },
    { set: { paramRefId: "M-0004_A-7072-21-99A7-O000A_MD-1_M-200_MI-1_P-2_R-2", value: "0" } },
  ],
  behaviours: [
    { kind: "securedOutput", label: "K1 answers a secured read on 0/0/1", ga: "0/0/1" },
    { kind: "output", label: "K2 contact answers a read", comObjRefId: "M-0004_A-7072-21-99A7-O000A_MD-1_M-200_MI-1_O-2-0_R-1" },
  ],
  structuralTrigger: { paramRefId: "M-0004_A-7072-21-99A7-O000A_MD-1_M-200_MI-1_P-2_R-2", value: "1" },
  // K1's "Ausgang" sits on the secured 0/0/1: a second, plain link on it would need one object flag
  // for both (SECURE_LINK_MIXED), so the generated links leave it alone.
  fuzz: {
    gaRange: { main: 1, mid: 6, subStart: 2 },
    excludeParams: ["_P-2_R-2"],
    excludeComObjects: ["MD-1_M-100_MI-1_O-2-0_R-1"],
    paramSweepRounds: 3,
  },
};
