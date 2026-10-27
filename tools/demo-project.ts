// Build a demo project in a running Busforge instance through its API. Nothing touches a bus:
// placing, linking and parameter edits are model state. Two demos, the same invented kind of
// building, rooms, names, individual and group addresses (docs/demo.md):
//
//   bun run tools/demo-project.ts http://localhost:3000
//   bun run tools/demo-project.ts --openknx <dir> http://localhost:3000
//   bun run tools/demo-project.ts --manufacturers <a.knxprod> [<b.knxprod> ...] http://localhost:3000
//
// The open demo places OpenKNX applications only. Their product data is OpenKNX's own release
// archive, taken from GitHub (or from <dir>, where the archives were downloaded before) and
// checked against the SHA-256 pinned here; the repository carries none of it. The manufacturer
// demo places products of several manufacturers, the ones the device table of docs/status.md
// lists; its product databases are third-party catalogue data the user brings.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { manufacturerId, manufacturerInfo } from "../packages/product/src/manufacturers.ts";
import { readZip } from "../packages/project/src/zip.ts";
import { OPENKNX_RELEASES, type OpenKnxRelease } from "./openknx-releases.ts";

// One HTTP exchange with the instance: the CLI passes fetch against a base URL, the test the
// in-process handler.
export type DemoApi = (path: string, init?: RequestInit) => Promise<Response>;

export interface DemoDevice {
  ia: string;
  name: string;
  room: string;
  appRef: string;
  productRef: string;
  // Parameters to set, in order (a channel's function before what it unlocks): ref id, value.
  params: [string, string][];
  // Com-object ref id and its group addresses, the sending one first.
  links: [string, string[]][];
}

export interface Demo {
  name: string;
  building: string;
  // The space tree: building > floors > rooms. A device sits in one leaf.
  floors: { name: string; rooms: { key: string; name: string; type: string }[] }[];
  // Group addresses, three levels: main > middle > address, with the datapoint type the linked
  // objects carry.
  groups: { main: number; name: string; middles: { mid: number; name: string; addresses: [number, string, string][] }[] }[];
  // Ref ids are the application's own: each device names one application version, and a ref the
  // application does not have makes the build fail at that device.
  devices: DemoDevice[];
}

// A small flat with OpenKNX devices only: a switch actuator for the lights, a presence detector in
// the hall whose movement a logic channel passes on to the hall light outside the night, and a room
// controller measuring the living room.
const SWITCH = "M-00FA_A-A602-03-0000";
const LOGIC = "M-00FA_A-A030-35-0000";
const ROOM = "M-00FA_A-A012-55-0000";
const PRESENCE = "M-00FA_A-A002-36-0000";
// Switch actuator channel n (1-based): its activity, its status and its description unlock and
// name the switching and status objects, nine object numbers per channel from 450.
const switchChannel = (n: number, description: string, gaSwitch: string, gaStatus: string): Pick<DemoDevice, "params" | "links"> => ({
  params: [
    [`${SWITCH}_UP-200${n}002_R-200${n}00201`, "1"],
    [`${SWITCH}_UP-200${n}009_R-200${n}00901`, "1"],
    [`${SWITCH}_P-200${n}001_R-200${n}00101`, description],
  ],
  links: [
    [`${SWITCH}_O-${450 + 9 * (n - 1)}_R-200${n}00101`, [gaSwitch]],
    [`${SWITCH}_O-${451 + 9 * (n - 1)}_R-200${n}00201`, [gaStatus]],
  ],
});
const switchChannels = [
  switchChannel(1, "Wohnen Decke", "1/0/0", "1/0/1"),
  switchChannel(2, "Küche Decke", "1/0/2", "1/0/3"),
  switchChannel(3, "Flur Decke", "1/0/4", "1/0/5"),
  switchChannel(4, "Bad Spiegel", "1/0/6", "1/0/7"),
];

export const OPEN_DEMO: Demo = {
  name: "OpenKNX-Musterwohnung",
  building: "Musterwohnung",
  floors: [{ name: "Erdgeschoss", rooms: [
    { key: "wohnen", name: "Wohnen", type: "Room" },
    { key: "kueche", name: "Küche", type: "Room" },
    { key: "flur", name: "Flur", type: "Corridor" },
    { key: "bad", name: "Bad", type: "Room" },
    { key: "verteiler", name: "Verteiler", type: "DistributionBoard" },
  ] }],
  groups: [
    { main: 0, name: "Zentral", middles: [{ mid: 0, name: "Zeit", addresses: [
      [0, "Datum/Uhrzeit", "DPST-19-1"],
      [1, "Nachtbetrieb", "DPST-1-1"],
    ] }] },
    { main: 1, name: "Beleuchtung", middles: [{ mid: 0, name: "Erdgeschoss", addresses: [
      [0, "Wohnen schalten", "DPST-1-1"], [1, "Wohnen Status", "DPST-1-1"],
      [2, "Küche schalten", "DPST-1-1"], [3, "Küche Status", "DPST-1-1"],
      [4, "Flur schalten", "DPST-1-1"], [5, "Flur Status", "DPST-1-1"],
      [6, "Bad schalten", "DPST-1-1"], [7, "Bad Status", "DPST-1-1"],
    ] }] },
    { main: 2, name: "Raumklima", middles: [{ mid: 0, name: "Wohnen", addresses: [
      [0, "Wohnen Temperatur", "DPST-9-1"],
      [1, "Wohnen Luftfeuchte", "DPST-9-7"],
    ] }] },
    { main: 3, name: "Präsenz", middles: [{ mid: 0, name: "Melder", addresses: [
      [0, "Flur Bewegung", "DPST-1-1"],
    ] }] },
  ],
  devices: [
    { ia: "1.4.1", name: "Schaltaktor Licht", room: "verteiler",
      productRef: "M-00FA_H-0xA602-1_P-OpenKnxSwitchActuator", appRef: "M-00FA_H-0xA602-1_HP-A602-03-0000",
      params: switchChannels.flatMap((c) => c.params),
      links: [...switchChannels.flatMap((c) => c.links), [`${SWITCH}_O-1000002_R-100000202`, ["0/0/0"]]] },
    { ia: "1.4.2", name: "Logikmodul", room: "verteiler",
      productRef: "M-00FA_H-WPKNX101-1_P-OpenKnxLogic", appRef: "M-00FA_H-WPKNX101-1_HP-A030-35-0000",
      params: [
        [`${LOGIC}_UP-1001003_R-100100301`, "1"],
        [`${LOGIC}_UP-1001008_R-100100801`, "1"],
        [`${LOGIC}_UP-1001028_R-100102801`, "2"],
        [`${LOGIC}_P-1001001_R-100100101`, "Flurlicht außer nachts"],
      ],
      links: [
        [`${LOGIC}_O-22_R-100100201`, ["1/0/4"]],
        [`${LOGIC}_O-20_R-100100001`, ["3/0/0"]],
        [`${LOGIC}_O-21_R-100100101`, ["0/0/1"]],
      ] },
    { ia: "1.4.10", name: "Raumcontroller Wohnen", room: "wohnen",
      productRef: "M-00FA_H-0xA012-1_P-OpenKnxRaumController", appRef: "M-00FA_H-0xA012-1_HP-A012-55-0000",
      params: [[`${ROOM}_UP-4000200_R-400020001`, "1"], [`${ROOM}_UP-4000201_R-400020101`, "1"]],
      links: [
        [`${ROOM}_O-45_R-400006001`, ["2/0/0"]],
        [`${ROOM}_O-48_R-400006101`, ["2/0/1"]],
        [`${ROOM}_O-1000002_R-100000202`, ["0/0/0"]],
      ] },
    { ia: "1.4.11", name: "Präsenzmelder Flur", room: "flur",
      productRef: "M-00FA_H-0xA002-1_P-OpenKnxPresenceBig", appRef: "M-00FA_H-0xA002-1_HP-A002-36-0000",
      params: [
        [`${PRESENCE}_UP-2000022_R-200002201`, "1"],
        [`${PRESENCE}_UP-2001008_R-200100801`, "1"],
        [`${PRESENCE}_UP-2001036_R-200103601`, "1"],
        [`${PRESENCE}_P-2001000_R-200100001`, "Flur"],
      ],
      links: [
        [`${PRESENCE}_O-63_R-200101301`, ["3/0/0"]],
        [`${PRESENCE}_O-55_R-200100501`, ["1/0/5"]],
      ] },
  ],
};

export const openKnxReleaseUrl = (r: OpenKnxRelease): string =>
  `https://github.com/OpenKNX/${r.repo}/releases/download/${encodeURIComponent(r.tag)}/${r.asset}`;

export { OPENKNX_RELEASES, type OpenKnxRelease };

export type ProductDb = { name: string; bytes: Uint8Array<ArrayBuffer> };

// The product XML of one OpenKNX release archive. Refuses an archive whose hash is not the pinned
// one and one that does not hold exactly one product XML. The archives name their entries with
// either path separator.
export function openKnxProductDb(release: OpenKnxRelease, archive: Uint8Array): ProductDb {
  const hash = createHash("sha256").update(archive).digest("hex");
  if (hash !== release.sha256) throw new Error(`${release.asset} has SHA-256 ${hash}, not the ${release.sha256} of OpenKNX's release ${release.repo} ${release.tag}`);
  const entries = [...readZip(Buffer.from(archive)).entries()].filter(([name]) => /^data[\\/][^\\/]+\.xml$/.test(name) && !/[\\/]content\.xml$/.test(name));
  if (entries.length !== 1) throw new Error(`${release.asset} holds ${entries.length} product XML files under data/, not one`);
  const [name, bytes] = entries[0];
  return { name: name.split(/[\\/]/).pop()!, bytes: new Uint8Array(bytes) };
}

// One archive is at most 16 MB; ten minutes is a slow line's time for it, not a stalled one's.
const DOWNLOAD_TIMEOUT_MS = 600_000;

// The open demo's product data: each release archive from `dir` where given, else downloaded from
// GitHub.
export async function openKnxProductDbs(dir: string | null, download: typeof fetch = fetch): Promise<ProductDb[]> {
  const dbs: ProductDb[] = [];
  for (const r of OPENKNX_RELEASES) {
    let archive: Uint8Array;
    if (dir) {
      archive = readFileSync(join(dir, r.asset));
    } else {
      const url = openKnxReleaseUrl(r);
      const fail = (why: string) => new Error(`GET ${url} ${why}; download the archive another way and name its directory with --openknx`);
      try {
        const res = await download(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        if (!res.ok) throw fail(`answered ${res.status}`);
        archive = new Uint8Array(await res.arrayBuffer());
      } catch (e) {
        if (e instanceof Error && e.message.startsWith(`GET ${url}`)) throw e;
        throw fail(`failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    dbs.push(openKnxProductDb(r, archive));
  }
  return dbs;
}

// An invented single-family house with products of ten manufacturers, the ones the device table of
// docs/status.md lists. Screenshots and rehearsals use it.
const MANUFACTURER_FLOORS: Demo["floors"] = [
  { name: "Erdgeschoss", rooms: [
    { key: "wohnen", name: "Wohnen/Essen", type: "Room" },
    { key: "kueche", name: "Küche", type: "Room" },
    { key: "flur", name: "Flur", type: "Corridor" },
    { key: "technik", name: "Technik", type: "Room" },
    { key: "verteiler", name: "Verteiler EG", type: "DistributionBoard" },
  ] },
  { name: "Obergeschoss", rooms: [
    { key: "schlafen", name: "Schlafen", type: "Room" },
    { key: "kind", name: "Kind", type: "Room" },
    { key: "bad", name: "Bad", type: "Room" },
  ] },
  { name: "Außen", rooms: [{ key: "dach", name: "Dach", type: "Room" }] },
];

const MANUFACTURER_GROUPS: Demo["groups"] = [
  { main: 0, name: "Zentral", middles: [
    { mid: 0, name: "Zeit und Wetter", addresses: [
      [0, "Datum/Uhrzeit", "DPST-19-1"],
      [1, "Uhrzeit", "DPST-10-1"],
      [2, "Datum", "DPST-11-1"],
      [3, "Regen", "DPST-1-1"],
      [4, "Außentemperatur", "DPST-9-1"],
      [5, "Helligkeit Süd", "DPST-9-4"],
    ] },
    { mid: 1, name: "Technik", addresses: [
      [0, "Netzteil Heartbeat", "DPST-1-17"],
      [1, "DALI Nachtbetrieb", "DPST-1-10"],
    ] },
  ] },
  { main: 1, name: "Beleuchtung", middles: [
    { mid: 0, name: "Erdgeschoss", addresses: [
      [0, "Wohnen Decke schalten", "DPST-1-1"], [1, "Wohnen Decke Status", "DPST-1-1"],
      [2, "Küche schalten", "DPST-1-1"], [3, "Küche Status", "DPST-1-1"],
      [4, "Flur schalten", "DPST-1-1"], [5, "Flur Status", "DPST-1-1"],
    ] },
    { mid: 1, name: "Obergeschoss", addresses: [
      [0, "Schlafen schalten", "DPST-1-1"], [1, "Schlafen Status", "DPST-1-1"],
      [2, "Bad schalten", "DPST-1-1"], [3, "Bad Status", "DPST-1-1"],
      [4, "Kind schalten", "DPST-1-1"], [5, "Kind Status", "DPST-1-1"],
    ] },
    { mid: 2, name: "Außen", addresses: [
      [0, "Terrasse schalten", "DPST-1-1"], [1, "Terrasse Status", "DPST-1-1"],
      [2, "Eingang schalten", "DPST-1-1"], [3, "Eingang Status", "DPST-1-1"],
    ] },
  ] },
  { main: 2, name: "Jalousien", middles: [
    { mid: 0, name: "Erdgeschoss", addresses: [
      [0, "Wohnen Auf/Ab", "DPST-1-8"], [1, "Wohnen Stopp/Lamelle", "DPST-1-7"],
      [2, "Wohnen Position", "DPST-5-1"], [3, "Wohnen Position Status", "DPST-5-1"],
      [4, "Küche Auf/Ab", "DPST-1-8"], [5, "Küche Stopp/Lamelle", "DPST-1-7"],
    ] },
    { mid: 1, name: "Obergeschoss", addresses: [
      [0, "Schlafen Auf/Ab", "DPST-1-8"], [1, "Schlafen Stopp/Lamelle", "DPST-1-7"],
      [2, "Kind Auf/Ab", "DPST-1-8"], [3, "Kind Stopp/Lamelle", "DPST-1-7"],
    ] },
  ] },
  { main: 3, name: "Heizung", middles: [
    { mid: 0, name: "Stellgrößen", addresses: [
      [0, "Wohnen Stellgröße", "DPST-5-1"], [1, "Küche Stellgröße", "DPST-5-1"],
      [2, "Schlafen Stellgröße", "DPST-5-1"], [3, "Bad Stellgröße", "DPST-5-1"],
    ] },
  ] },
  { main: 4, name: "Präsenz", middles: [
    { mid: 0, name: "Melder", addresses: [
      [0, "Flur Bewegung", "DPST-1-1"], [1, "Küche Präsenz", "DPST-1-1"], [2, "Bad Präsenz", "DPST-1-1"],
    ] },
  ] },
];

const MIX2 = "M-0048_A-493B-21-B471";
const MANUFACTURER_DEVICES: DemoDevice[] = [
  { ia: "1.3.1", name: "Spannungsversorgung", room: "verteiler",
    productRef: "M-0162_H-KNX.2D40E.2D1280D-1_P-KNX.2D40E.2D1280D", appRef: "M-0162_H-KNX.2D40E.2D1280D-1_HP-0004-11-F245",
    params: [], links: [["M-0162_A-0004-11-F245_O-1_R-1", ["0/1/0"]]] },
  { ia: "1.3.2", name: "IP-Schnittstelle mit Zeitserver", room: "technik",
    productRef: "M-0083_H-135-3_P-SCN.2DIP000.2E03", appRef: "M-0083_H-135-3_HP-0137-20-7EB2",
    params: [], links: [
      ["M-0083_A-0137-20-7EB2_O-4_R-32", ["0/0/0"]],
      ["M-0083_A-0137-20-7EB2_O-2_R-31", ["0/0/1"]],
      ["M-0083_A-0137-20-7EB2_O-3_R-47", ["0/0/2"]],
    ] },
  { ia: "1.3.10", name: "Schaltaktor Licht", room: "verteiler",
    productRef: "M-0048_H-4930200-2_P-4930200", appRef: "M-0048_H-4930200-2_HP-493B-21-B471",
    params: [[`${MIX2}_P-57_R-57`, "2"]], links: [
      [`${MIX2}_MD-14_M-40_MI-1_O-2-0_R-5`, ["1/0/0"]], [`${MIX2}_MD-14_M-40_MI-1_O-2-5_R-19`, ["1/0/1"]],
      [`${MIX2}_MD-14_M-41_MI-1_O-2-0_R-5`, ["1/0/2", "4/0/1"]], [`${MIX2}_MD-14_M-41_MI-1_O-2-5_R-19`, ["1/0/3"]],
      [`${MIX2}_MD-14_M-42_MI-1_O-2-0_R-5`, ["1/0/4", "4/0/0"]], [`${MIX2}_MD-14_M-42_MI-1_O-2-5_R-19`, ["1/0/5"]],
      [`${MIX2}_MD-14_M-43_MI-1_O-2-0_R-5`, ["1/1/0"]], [`${MIX2}_MD-14_M-43_MI-1_O-2-5_R-19`, ["1/1/1"]],
      [`${MIX2}_MD-14_M-44_MI-1_O-2-0_R-5`, ["1/1/2", "4/0/2"]], [`${MIX2}_MD-14_M-44_MI-1_O-2-5_R-19`, ["1/1/3"]],
      [`${MIX2}_MD-14_M-45_MI-1_O-2-0_R-5`, ["1/1/4"]], [`${MIX2}_MD-14_M-45_MI-1_O-2-5_R-19`, ["1/1/5"]],
    ] },
  { ia: "1.3.11", name: "Jalousieaktor", room: "verteiler",
    productRef: "M-0048_H-4930250-2_P-4930250", appRef: "M-0048_H-4930250-2_HP-493B-21-B471",
    params: [[`${MIX2}_P-57_R-57`, "5"]], links: [
      [`${MIX2}_MD-6_M-16_MI-1_O-2-0_R-21`, ["2/0/0"]], [`${MIX2}_MD-6_M-16_MI-1_O-2-1_R-22`, ["2/0/1"]],
      [`${MIX2}_MD-6_M-16_MI-1_O-2-2_R-23`, ["2/0/2"]], [`${MIX2}_MD-6_M-16_MI-1_O-2-13_R-4`, ["2/0/3"]],
      [`${MIX2}_MD-6_M-16_MI-2_O-2-0_R-21`, ["2/0/4"]], [`${MIX2}_MD-6_M-16_MI-2_O-2-1_R-22`, ["2/0/5"]],
      [`${MIX2}_MD-6_M-16_MI-3_O-2-0_R-21`, ["2/1/0"]], [`${MIX2}_MD-6_M-16_MI-3_O-2-1_R-22`, ["2/1/1"]],
      [`${MIX2}_O-249_R-178`, ["0/0/3"]],
    ] },
  { ia: "1.3.12", name: "Heizungsaktor", room: "verteiler",
    productRef: "M-0048_H-4930240-2_P-4930240", appRef: "M-0048_H-4930240-2_HP-493B-21-B471",
    params: [[`${MIX2}_P-57_R-57`, "6"]], links: [
      [`${MIX2}_MD-7_M-19_MI-1_O-2-0_R-1`, ["3/0/0"]], [`${MIX2}_MD-7_M-19_MI-2_O-2-0_R-1`, ["3/0/1"]],
      [`${MIX2}_MD-7_M-19_MI-3_O-2-0_R-1`, ["3/0/2"]], [`${MIX2}_MD-7_M-19_MI-4_O-2-0_R-1`, ["3/0/3"]],
    ] },
  { ia: "1.3.13", name: "Multifunktionsaktor Außen", room: "verteiler",
    productRef: "M-0085_H-AM22AA-16_P-AMMA.2D04.2F06.2ES", appRef: "M-0085_H-AM22AA-16_HP-0072-30-69AA",
    params: [
      ["M-0085_A-0072-30-69AA_P-20_R-20", "1"], ["M-0085_A-0072-30-69AA_UP-142_R-142", "1"],
      ["M-0085_A-0072-30-69AA_UP-143_R-143", "1"], ["M-0085_A-0072-30-69AA_P-9_R-9", "2"],
    ], links: [
      ["M-0085_A-0072-30-69AA_O-2_R-3", ["1/2/0"]], ["M-0085_A-0072-30-69AA_O-3_R-4", ["1/2/1"]],
      ["M-0085_A-0072-30-69AA_O-11_R-12", ["1/2/2"]], ["M-0085_A-0072-30-69AA_O-12_R-13", ["1/2/3"]],
      ["M-0085_A-0072-30-69AA_O-20_R-264", ["2/1/2"]], ["M-0085_A-0072-30-69AA_O-21_R-263", ["2/1/3"]],
    ] },
  { ia: "1.3.14", name: "DALI-Gateway", room: "verteiler",
    productRef: "M-0048_H-9070929-1-O00EF_P-9070929", appRef: "M-0048_H-9070929-1-O00EF_HP-9071-20-F258-O00EF",
    params: [], links: [
      ["M-0048_A-9071-20-F258-O00EF_O-30_R-39", ["0/0/1"]], ["M-0048_A-9071-20-F258-O00EF_O-31_R-40", ["0/0/2"]],
      ["M-0048_A-9071-20-F258-O00EF_O-10_R-45", ["0/1/1"]],
    ] },
  { ia: "1.3.20", name: "Tastsensor Wohnen", room: "wohnen",
    productRef: "M-0008_H-8.20.2F.2F.20zxy3.20xx-1_P-5133.2000", appRef: "M-0008_H-8.20.2F.2F.20zxy3.20xx-1_HP-10D7-11-2783-O000A",
    params: [], links: [
      ["M-0008_A-10D7-11-2783-O000A_O-0_R-1662", ["1/0/0"]],
      ["M-0008_A-10D7-11-2783-O000A_O-2_R-6027", ["1/0/2"]],
      ["M-0008_A-10D7-11-2783-O000A_O-4_R-3038", ["1/2/0"]],
    ] },
  { ia: "1.3.21", name: "Raumcontroller Wohnen", room: "wohnen",
    productRef: "M-00FA_H-0xA012-1_P-OpenKnxRaumController", appRef: "M-00FA_H-0xA012-1_HP-A012-55-E5F5",
    params: [], links: [["M-00FA_A-A012-55-E5F5_O-1000002_R-100000202", ["0/0/0"]]] },
  { ia: "1.3.22", name: "Tasterschnittstelle Küche", room: "kueche",
    productRef: "M-0083_H-180-0_P-BE.2D06001.2E02", appRef: "M-0083_H-180-0_HP-00B4-32-3919",
    params: [], links: [
      ["M-0083_A-00B4-32-3919_MD-2_M-2_MI-1_O-3-0_R-11", ["1/0/2"]],
      ["M-0083_A-00B4-32-3919_MD-2_M-3_MI-1_O-3-0_R-11", ["1/0/0"]],
    ] },
  { ia: "1.3.23", name: "Präsenzmelder Küche", room: "kueche",
    productRef: "M-008E_H-4007841056339-1_P-4007841056339", appRef: "M-008E_H-4007841056339-1_HP-7079-10-9C41",
    params: [], links: [["M-008E_A-7079-10-9C41_O-82_R-83", ["4/0/1"]]] },
  { ia: "1.3.24", name: "Tasterschnittstelle Flur", room: "flur",
    productRef: "M-0083_H-182-0_P-BE.2D02001.2E02", appRef: "M-0083_H-182-0_HP-00B6-32-9642",
    params: [], links: [
      ["M-0083_A-00B6-32-9642_MD-2_M-2_MI-1_O-3-0_R-11", ["1/0/4"]],
      ["M-0083_A-00B6-32-9642_MD-2_M-3_MI-1_O-3-0_R-11", ["1/2/2"]],
    ] },
  { ia: "1.3.25", name: "Bewegungsmelder Flur", room: "flur",
    productRef: "M-0048_H-1019610-1_P-1019610", appRef: "M-0048_H-1019610-1_HP-107E-12-5B58",
    params: [], links: [
      ["M-0048_A-107E-12-5B58_O-6_R-429", ["4/0/0"]],
      ["M-0048_A-107E-12-5B58_O-0_R-230", ["0/0/1"]],
    ] },
  { ia: "1.3.30", name: "Tasterschnittstelle Schlafen", room: "schlafen",
    productRef: "M-0004_H-4.20.2F.2F.20400021SE-0-O000A_P-400021SE", appRef: "M-0004_H-4.20.2F.2F.20400021SE-0-O000A_HP-7072-21-99A7-O000A",
    params: [], links: [
      ["M-0004_A-7072-21-99A7-O000A_MD-1_M-100_MI-1_O-2-0_R-1", ["1/1/0"]],
      ["M-0004_A-7072-21-99A7-O000A_MD-1_M-100_MI-1_O-2-1_R-2", ["1/1/1"]],
      ["M-0004_A-7072-21-99A7-O000A_MD-1_M-200_MI-1_O-2-0_R-1", ["1/1/4"]],
      ["M-0004_A-7072-21-99A7-O000A_MD-1_M-200_MI-1_O-2-1_R-2", ["1/1/5"]],
    ] },
  { ia: "1.3.31", name: "Universalschnittstelle Bad", room: "bad",
    productRef: "M-0002_H-2.20.2F.2F.20GHQ.20631.200070-1_P-GH.20Q631.200070.20R0111", appRef: "M-0002_H-2.20.2F.2F.20GHQ.20631.200070-1_HP-A001-13-63C2",
    params: [["M-0002_A-A001-13-63C2_P-9_R-9", "1"]], links: [["M-0002_A-A001-13-63C2_O-1_R-24", ["1/1/2"]]] },
  { ia: "1.3.32", name: "Präsenzmelder Bad", room: "bad",
    productRef: "M-0081_H-GeneratedNumber.2D22017-0_P-180.2D02", appRef: "M-0081_H-GeneratedNumber.2D22017-0_HP-FE01-11-75D9",
    params: [], links: [["M-0081_A-FE01-11-75D9_O-0_R-63", ["4/0/2"]]] },
  { ia: "1.3.40", name: "Wetterstation", room: "dach",
    productRef: "M-0048_H-1409208-1_P-1409201", appRef: "M-0048_H-1409208-1_HP-140C-14-EB70",
    params: [], links: [
      ["M-0048_A-140C-14-EB70_O-0_R-230", ["0/0/5"]], ["M-0048_A-140C-14-EB70_O-4_R-2", ["0/0/4"]],
      ["M-0048_A-140C-14-EB70_O-6_R-4", ["0/0/3"]], ["M-0048_A-140C-14-EB70_O-8_R-242", ["0/0/1"]],
      ["M-0048_A-140C-14-EB70_O-9_R-243", ["0/0/2"]],
    ] },
];

export const MANUFACTURER_DEMO: Demo = {
  name: "Musterhaus Sonnenweg",
  building: "Musterhaus",
  floors: MANUFACTURER_FLOORS,
  groups: MANUFACTURER_GROUPS,
  devices: MANUFACTURER_DEVICES,
};

export const gaRaw = (ga: string): number => {
  const [main, mid, sub] = ga.split("/").map(Number);
  return (main << 11) | (mid << 8) | sub;
};

interface Node { id: string; name: string; type?: string; children: Node[] }
interface ConfigView { blocks: { items: ({ kind: "comObject"; comObject: { refId: string; gaRaws: number[] } } | { kind: "param"; param: { refId: string; value: string } } | { kind: string })[] }[] }

export interface DemoSummary {
  projectId: string;
  name: string;
  devices: { ia: string; name: string; manufacturer: string; product: string; room: string; links: number }[];
  groupAddresses: number;
  links: number;
}

// Build a demo project. Refuses when the instance already holds a project of that name, when a
// product is missing from the catalogue after the import, and when any write does not read back
// as written.
export async function buildDemoProject(api: DemoApi, demo: Demo, productDbs: ProductDb[]): Promise<DemoSummary> {
  const call: Call = async <T>(method: string, path: string, body?: unknown, form?: FormData): Promise<T> => {
    const r = await api(path, {
      method,
      body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
      headers: form || body === undefined ? undefined : { "content-type": "application/json" },
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path} answered ${r.status}: ${text}`);
    return JSON.parse(text) as T;
  };

  const existing = await call<{ name: string }[]>("GET", "/api/projects");
  if (existing.some((p) => p.name === demo.name)) {
    throw new Error(`the instance already holds a project named "${demo.name}"; build the demo into a fresh instance or delete that project first`);
  }

  for (const db of productDbs) {
    const form = new FormData();
    form.set("file", new Blob([db.bytes]), db.name);
    await call("POST", "/api/catalog/import", undefined, form);
  }
  const catalogue = await call<CatalogueProduct[]>("GET", "/api/catalog/products");
  const products = new Map(catalogue.map((p) => [`${p.appRef} ${p.productRef}`, p]));
  const missing = demo.devices.filter((d) => !products.has(`${d.appRef} ${d.productRef}`));
  if (missing.length) throw new Error(`the product databases lack ${missing.map((d) => `${d.productRef} with application ${d.appRef}`).join(", ")}`);

  const project = await call<{ id: string }>("POST", "/api/projects", { name: demo.name });
  try {
    return await fillDemoProject(call, demo, project.id, products);
  } catch (e) {
    throw new Error(`the demo project ${project.id} is left half-built and has to be deleted before the next run: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

type Call = <T>(method: string, path: string, body?: unknown, form?: FormData) => Promise<T>;
type CatalogueProduct = { appRef: string; productRef: string; manufacturer: number; name: string };

async function fillDemoProject(call: Call, demo: Demo, projectId: string, products: Map<string, CatalogueProduct>): Promise<DemoSummary> {
  const base = `/api/projects/${projectId}`;

  // Spaces: each POST answers with the whole project; the new node is found by name under its parent.
  type Tree = { locations: Node[]; groupRanges: (Node & { rangeStart: number })[] };
  const child = (nodes: Node[], name: string): Node => {
    const n = nodes.find((x) => x.name === name);
    if (!n) throw new Error(`"${name}" is not in the tree the instance answered with`);
    return n;
  };
  let tree = await call<Tree>("POST", `${base}/spaces`, { parentId: null, type: "Building", name: demo.building });
  const building = child(tree.locations, demo.building);
  const roomIds = new Map<string, number>();
  for (const floor of demo.floors) {
    tree = await call<Tree>("POST", `${base}/spaces`, { parentId: Number(building.id), type: "Floor", name: floor.name });
    const floorId = Number(child(child(tree.locations, demo.building).children, floor.name).id);
    for (const room of floor.rooms) {
      tree = await call<Tree>("POST", `${base}/spaces`, { parentId: floorId, type: room.type, name: room.name });
      const node = child(child(child(tree.locations, demo.building).children, floor.name).children, room.name);
      roomIds.set(room.key, Number(node.id));
    }
  }

  let gaCount = 0;
  for (const main of demo.groups) {
    tree = await call<Tree>("POST", `${base}/group-ranges`, { parentId: null, name: main.name, number: main.main });
    const mainId = Number(child(tree.groupRanges, main.name).id);
    for (const mid of main.middles) {
      tree = await call<Tree>("POST", `${base}/group-ranges`, { parentId: mainId, name: mid.name, number: mid.mid });
      const midId = Number(child(child(tree.groupRanges, main.name).children, mid.name).id);
      for (const [sub, name, dpt] of mid.addresses) {
        await call("POST", `${base}/group-addresses`, { rangeId: midId, sub, name, dpt });
        gaCount++;
      }
    }
  }

  const summary: DemoSummary = { projectId, name: demo.name, devices: [], groupAddresses: gaCount, links: 0 };
  for (const d of demo.devices) {
    const placed = await call<{ id: string }>("POST", `${base}/devices`, { appRef: d.appRef, productRef: d.productRef, name: d.name });
    const dev = `${base}/devices/${encodeURIComponent(placed.id)}`;
    await call("PUT", `${dev}/address`, { ia: d.ia });
    const spaceId = roomIds.get(d.room);
    if (spaceId === undefined) throw new Error(`${d.name}: room ${d.room} was not built`);
    await call("PUT", `${dev}/space`, { spaceId });
    for (const [paramRefId, value] of d.params) await call("PUT", `${dev}/params`, { paramRefId, value });
    for (const [comObjRefId, gas] of d.links) await call("PUT", `${dev}/links`, { comObjRefId, gaRaws: gas.map(gaRaw) });

    // Read the device back: every parameter and link must stand as written.
    const view = await call<ConfigView>("GET", `${dev}/config`);
    const params = new Map<string, string>();
    const links = new Map<string, number[]>();
    for (const b of view.blocks) for (const it of b.items) {
      if (it.kind === "param" && "param" in it) params.set(it.param.refId, it.param.value);
      if (it.kind === "comObject" && "comObject" in it) links.set(it.comObject.refId, it.comObject.gaRaws);
    }
    for (const [ref, value] of d.params) {
      if (params.get(ref) !== value) throw new Error(`${d.name}: parameter ${ref} reads ${params.get(ref) ?? "nothing"}, not ${value}`);
    }
    for (const [ref, gas] of d.links) {
      const got = links.get(ref);
      if (!got || got.join(",") !== gas.map(gaRaw).join(",")) throw new Error(`${d.name}: object ${ref} links ${got?.join(",") ?? "nothing"}, not ${gas.join(", ")}`);
    }
    const p = products.get(`${d.appRef} ${d.productRef}`)!;
    const room = demo.floors.flatMap((f) => f.rooms).find((r) => r.key === d.room)!.name;
    const manufacturer = manufacturerInfo(manufacturerId(p.manufacturer))?.name ?? manufacturerId(p.manufacturer);
    summary.devices.push({ ia: d.ia, name: d.name, manufacturer, product: p.name, room, links: d.links.length });
    summary.links += d.links.length;
  }
  // Read the project back: every device on its address and in its room.
  const stored = await call<{ devices: { id: string; ia: string; name: string }[]; locations: (Node & { deviceIds: string[] })[] }>("GET", base);
  const roomOf = new Map<string, number>();
  const walk = (n: Node & { deviceIds: string[] }) => { for (const id of n.deviceIds) roomOf.set(id, Number(n.id)); n.children.forEach((c) => walk(c as typeof n)); };
  stored.locations.forEach(walk);
  for (const d of demo.devices) {
    const dev = stored.devices.find((x) => x.name === d.name);
    if (!dev || dev.ia !== d.ia) throw new Error(`${d.name}: the project holds ${dev?.ia ?? "no such device"}, not ${d.ia}`);
    if (roomOf.get(dev.id) !== roomIds.get(d.room)) throw new Error(`${d.name}: not in room ${d.room}`);
  }
  await call("POST", `${base}/snapshots`, { label: "Demo-Ausgangszustand" });
  return summary;
}

// The command line: the open demo by default, the manufacturer demo from the product databases named.
export function parseDemoArgs(argv: string[]): { baseUrl: string; openKnxDir: string | null; manufacturerDbs: string[] | null } {
  const usage = "usage: bun run tools/demo-project.ts [--openknx <dir> | --manufacturers <file.knxprod> ...] <base-url>";
  const baseUrl = argv.at(-1);
  const options = argv.slice(0, -1);
  if (!baseUrl || !/^https?:\/\//.test(baseUrl)) throw new Error(usage);
  const values = options.slice(1);
  const plain = values.length > 0 && values.every((v) => !v.startsWith("--"));
  let openKnxDir: string | null = null;
  let manufacturerDbs: string[] | null = null;
  if (options[0] === "--openknx" && plain && values.length === 1) openKnxDir = values[0];
  else if (options[0] === "--manufacturers" && plain) manufacturerDbs = values;
  else if (options.length > 0) throw new Error(usage);
  return { baseUrl: baseUrl.replace(/\/+$/, ""), openKnxDir, manufacturerDbs };
}

if (import.meta.main) {
  let args: ReturnType<typeof parseDemoArgs>;
  try {
    args = parseDemoArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  const { baseUrl, openKnxDir, manufacturerDbs } = args;
  const demo = manufacturerDbs ? MANUFACTURER_DEMO : OPEN_DEMO;
  const dbs = manufacturerDbs
    ? manufacturerDbs.map((f) => ({ name: basename(f), bytes: new Uint8Array(readFileSync(f)) }))
    : await openKnxProductDbs(openKnxDir);
  const summary = await buildDemoProject((path, init) => fetch(`${baseUrl}${path}`, init), demo, dbs);
  console.log(`${summary.name}: ${summary.devices.length} devices, ${summary.groupAddresses} group addresses, ${summary.links} linked objects (project ${summary.projectId})`);
  for (const d of summary.devices) console.log(`  ${d.ia.padEnd(7)} ${d.name.padEnd(30)} ${d.room.padEnd(13)} ${d.manufacturer}: ${d.product}`);
}
