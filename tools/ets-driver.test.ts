import { expect, test } from "bun:test";
import { benchSimArgs, editDistance, expanderOpen, LINE_11, nextBatchSize, oneRowSelected, pcapOf, pickCatalogueRow, selectedSamples, simStartScript, writtenRowKind } from "./ets-driver.ts";

test("a catalogue batch halves after a refusal and grows from the last size that loaded", () => {
  const walk = (outcomes: ("loaded" | "refused" | "skipped")[], max = 150) => {
    let size = max;
    return outcomes.map((o) => (size = nextBatchSize(size, o, max)));
  };
  // Refused down to 19 rows, which load: the next batches grow from 19, not from 150.
  expect(walk(["refused", "refused", "refused", "loaded", "loaded", "loaded"])).toEqual([75, 38, 19, 24, 30, 38]);
  // A row refused alone stays one row until one loads, then grows by at least a row.
  expect(walk(["refused", "refused", "refused", "refused", "refused", "refused", "refused", "refused", "refused", "loaded", "loaded"])).toEqual([75, 38, 19, 10, 5, 3, 2, 1, 1, 2, 3]);
  // Batches of loaded rows keep the size; growth stops at the maximum.
  expect(walk(["refused", "skipped", "loaded", "loaded", "loaded", "loaded"])).toEqual([75, 75, 94, 118, 148, 150]);
});

test("the grid's selection read from magick's samples of its rows' background", () => {
  // magick's txt: output of ETS 6.4.1's colours: white, stripe grey #FBFBFB, row under the mouse #EAEAEA, selected #DBEAFF.
  const txt = (pixels: string[]) => ["# ImageMagick pixel enumeration: 1,4,0,255,srgb", ...pixels.map((p, y) => `0,${y}: ${p}`), ""].join("\n");
  const white = "(255,255,255)  #FFFFFF  white", stripe = "(251,251,251)  #FBFBFB  srgb(251,251,251)";
  const hover = "(234,234,234)  #EAEAEA  srgb(234,234,234)", selected = "(219,234,255)  #DBEAFF  srgb(219,234,255)";
  expect(selectedSamples(txt([white, selected, selected, stripe]))).toBe("0110");
  // The row under the mouse reads unselected, so the mouse is moved aside before the grid is read.
  expect(selectedSamples(txt([white, hover, selected, stripe]))).toBe("0010");
  expect(() => selectedSamples(txt(["(255)  #FFFFFF  gray(255)"]))).toThrow("no pixel in magick's line");
});

test("one row selected: one run of selected samples, a row high at most", () => {
  expect(oneRowSelected("0000111100000")).toBe(true);
  expect(oneRowSelected("0000111110000")).toBe(true);
  // Two rows, or two runs, or nothing.
  expect(oneRowSelected("00001111111100")).toBe(false);
  expect(oneRowSelected("0011000011000")).toBe(false);
  expect(oneRowSelected("0000000000000")).toBe(false);
  // A run at the grid's edge may be the visible end of a longer selection.
  expect(oneRowSelected("1111000000000")).toBe(false);
  expect(oneRowSelected("0000000001111")).toBe(false);
});

test("the catalogue row inserted: the one whose read application is the row's, whatever else the search lists", () => {
  const e = (orderNumber: string, deviceType: string, version: string, fingerprint: string, y: number) => ({ orderNumber, deviceType, version, fingerprint, y });
  const pick = (entries: ReturnType<typeof e>[], orderNumber: string, application: string) => {
    const r = pickCatalogueRow(entries, orderNumber, application);
    return "refused" in r ? r : { row: entries.indexOf(r.hit), rows: r.rows, exact: r.exact };
  };
  // ETS's search for TB/U1 lists both ABB brands' rows at 1.3 and 1.7 and the TB/U12.7 ones, as on the bench host; the
  // two 1.3 fingerprints are the list's (6B9E read in ETS's properties panel), the others stand in for any. Each
  // application by its fingerprint.
  const tbu1 = [e("TB/U1", "$4201", "1.3", "D98E", 731), e("TB/U1", "$4201", "1.7", "2C3A", 751), e("TB/U12.7", "$4202", "1.3", "11AF", 771),
    e("TB/U1", "$4201", "1.3", "6B9E", 873), e("TB/U1", "$4201", "1.7", "88D1", 893)];
  expect(pick(tbu1, "TB/U1", "M-0002_A-4201-13-6B9E-O0007")).toEqual({ row: 3, rows: 1, exact: true });
  expect(pick(tbu1, "TB/U1", "M-0007_A-4201-13-D98E")).toEqual({ row: 0, rows: 1, exact: true });
  // Fingerprints OCR misread (as OCR reads them on the bench host): the one row at the type and version, and
  // one application in two catalogue items read alike, are taken, not exact (the insert is checked on the export).
  expect(pick([e("4093KRMTSD", "$1471", "1.2", "1634", 700)], "4093KRMTSD", "M-0004_A-1471-12-163A-O00F4")).toEqual({ row: 0, rows: 1, exact: false });
  expect(pick([e("75314019", "$20B3", "1.1", "DCc3s0", 700), e("75314019", "$20B3", "1.1", "DCc3s0", 720)], "75314019", "M-0006_A-20B3-11-DC90-O000A")).toEqual({ row: 0, rows: 2, exact: false });
  // Two applications at one type and version, one fingerprint misread: the closer reading; two readings as close
  // are refused.
  expect(pick([e("TB/U1", "$4201", "1.3", "D9BE", 731), e("TB/U1", "$4201", "1.3", "6B93E", 873)], "TB/U1", "M-0002_A-4201-13-6B9E-O0007")).toEqual({ row: 1, rows: 1, exact: false });
  expect(pick([e("X", "$4201", "1.3", "6B0E", 731), e("X", "$4201", "1.3", "6B9F", 873)], "X", "M-0002_A-4201-13-6B9E-O0007")).toEqual({ refused: "2 catalogue rows with order number X at $4201 1.3 read no fingerprint closest to 6B9E alone (read: X $4201 1.3 6B0E; X $4201 1.3 6B9F)" });
  // The order number a row reads is not what tells it apart (OCR reads GW90883 as "Gws308s3");
  // order numbers that differ only where OCR confuses letters are told apart by the application, and OCR's "S" for the
  // device type's "$" and O for 0 are read as meant.
  expect(pick([e("Gws308s3", "$5222", "1.2", "B809", 700)], "GW90883", "M-0019_A-5222-12-B809-O00C9")).toEqual({ row: 0, rows: 1, exact: true });
  const folded = [e("GH Q631 0070 RO111", "S0A01", "1.3", "1111", 700), e("GH Q631 0070 R0111", "$A001", "1.3", "63C2", 720)];
  expect(pick(folded, "GH Q631 0070 R0111", "M-0002_A-A001-13-63C2")).toEqual({ row: 1, rows: 1, exact: true });
  // A version or device type that differs is never taken.
  expect("refused" in pickCatalogueRow([e("X1", "$A0B1", "1.2", "1234", 700), e("X1", "$A0B2", "1.1", "1234", 720)], "X1", "M-00FA_A-A0B1-11-1234")).toBe(true);
  expect(editDistance("DC390", "DC90")).toBe(1);
  expect(editDistance("", "6B9E")).toBe(4);
});

test("line 1.1's row of the topology tree, as OCR reads the tree's rows", () => {
  // Recorded on the bench host: line 1.1 plain, selected ("111P Line"), and the rows around it.
  for (const line of ["v EE 11 TP Linie", "v EB 11TP Linie", "v ES 111P Line"]) expect(LINE_11.test(line)).toBe(true);
  for (const other of ["TIT 0.0 IP Backbone-Linie", "v [&] 1.0 IP Hauptiinie", "Y [J LO IP Hauptiinie", "BS © Keiner Linie zugewiesen", "BS 1 Programmieren notwendig",
    "J 1.1.1 6108/06-BS-500 Tasterankopplung 2-fa", "{J 1.1.1TB/U1 Tacteo Bedienelement 1-fach"]) expect(LINE_11.test(other)).toBe(false);
  // A device whose name ends as a line's does: its address says it is a device.
  expect(LINE_11.test("{J 1.1.20 KNX Line")).toBe(false);
});

test("a catalogue group's expander read open or closed from its arrow's pixels", () => {
  // The dark pixels of the two arrows as magick printed them from the bench host's screen (grey, 20 px square at the
  // group row's start), on the expander's light background.
  const txt = (dark: [number, number, number][]) => ["# ImageMagick pixel enumeration: 20,20,0,255,gray", ...Array.from({ length: 400 }, (_, i) => {
    const [x, y] = [i % 20, Math.floor(i / 20)], v = dark.find((d) => d[0] === x && d[1] === y)?.[2] ?? 0xe5;
    const h = v.toString(16).toUpperCase().padStart(2, "0");
    return `${x},${y}: (${v})  #${h}${h}${h}  gray(${v})`;
  })].join("\n");
  const closed: [number, number, number][] = [[7, 8, 0x48], [13, 8, 0x48], [7, 9, 0x16], [8, 9, 0x24], [12, 9, 0x24], [13, 9, 0x0b], [8, 10, 0x16], [9, 10, 0x24], [11, 10, 0x24], [12, 10, 0x0b], [9, 11, 0x16], [10, 11, 0x00], [11, 11, 0x0b], [10, 12, 0x20]];
  const open: [number, number, number][] = [[10, 8, 0x39], [9, 9, 0x24], [10, 9, 0x00], [11, 9, 0x16], [8, 10, 0x24], [9, 10, 0x16], [11, 10, 0x16], [12, 10, 0x16], [7, 11, 0x24], [8, 11, 0x16], [12, 11, 0x16], [13, 11, 0x16], [7, 12, 0x2b], [13, 12, 0x2b]];
  expect(expanderOpen(txt(closed))).toBe(false);
  expect(expanderOpen(txt(open))).toBe(true);
  // The closed expander's box border (#989898) is no arrow; nothing dark is no expander.
  expect(expanderOpen(txt([[19, 1, 0x98], [19, 2, 0x98]]))).toBeNull();
});

test("a written row ends sim-refused where the unit refused first, ETS's message beside the refusal", () => {
  // The simulator's lines of rows ETS failed on with "Das Gerät antwortet nicht", as recorded on the bench host.
  const ets = { kind: "ets-failed" as const, why: "ETS's load task failed: Knx.Ets.Hawk.DeviceManagementException: Das Gerät antwortet nicht." };
  const segment = "sim-refused A_PropertyValue_Write 3/5 030b0000096e00000000: 2414 bytes at 0x1c06 reach into the segment of object 4; where the unit places them then is not known";
  const order = "sim-refused A_PropertyValue_Write 4/27 0000080000320000: element 2 before element 1";
  const sim = (refusal: string) => ["2026-11-25T14:57:56.745Z catalogue unit of …", `2026-11-25T14:58:25.751Z ${refusal}`, `2026-11-25T14:58:30.987Z ${refusal}`].join("\n");
  expect(writtenRowKind(ets, sim(segment), "", "1.1.20", "MV-07B0")).toEqual({ kind: "sim-refused", why: `the simulator refused 2: ${segment}; ETS: ${ets.why}` });
  expect(writtenRowKind(ets, sim(order), "", "1.1.20", "MV-07B0")).toEqual({ kind: "sim-refused", why: `the simulator refused 2: ${order}; ETS: ${ets.why}` });
  // Nothing refused: ETS's outcome as it is.
  expect(writtenRowKind(ets, "2026-11-25T14:57:56.745Z catalogue unit of …", "", "1.1.20", "MV-07B0")).toEqual({ kind: "ets-failed", why: ets.why });
  expect(writtenRowKind({ kind: "completed" }, "", "", "1.1.20", "MV-07B0")).toEqual({ kind: "completed" });
  // A refusal after the unit's restart that leaves the comparison whole (ETS's T_Disconnect after the restart, confirmed
  // negatively on the line): ETS's outcome stays, the refusal named.
  const dev = 0x110a, tool = 0x11ff;
  const frame = (tpdu: string, code: number, src: number, dst: number) => {
    const t = Buffer.from(tpdu, "hex");
    const cemi = Buffer.concat([Buffer.from([code, 0x00, 0xb0, 0x60, src >> 8, src & 0xff, dst >> 8, dst & 0xff, t.length - 1]), t]);
    return Buffer.concat([Buffer.from([0x06, 0x10, 0x04, 0x20, 0x00, 10 + cemi.length, 0x04, 0x01, 0x00, 0x00]), cemi]).toString("hex");
  };
  const sent = (tpdu: string) => `2026-01-01T00:00:00.000Z ETS->BRIDGE TUNNELLING_REQ  | ${frame(tpdu, 0x11, tool, dev)}`;
  const capture = [sent("80"), sent("4282400001"), sent("4780"), sent("81"), `2026-01-01T00:00:00.000Z BRIDGE->ETS TUNNELLING_REQ CON-NEG  | ${frame("81", 0x2e, tool, dev)}`].join("\n");
  const after = "sim-refused 81 1275 ms after the restart: whether the unit acknowledges a frame then is not shown";
  expect(writtenRowKind({ kind: "completed" }, ["connected to 1.1.255", "restart", `2026-01-01T00:00:01.000Z ${after}`].join("\n"), capture, "1.1.10", "MV-07B0"))
    .toEqual({ kind: "completed", why: `the simulator refused 1 after the restart, the comparison whole: ${after}` });
});

test("of rows at one application number and version, the row's manufacturer's where OCR cannot tell the fingerprints apart", () => {
  const e = (manufacturer: string, fingerprint: string, y: number) => ({ orderNumber: "TB/U1", deviceType: "$4201", version: "1.3", fingerprint, manufacturer, y });
  // Both read alike: without a manufacturer the first, with it the one whose manufacturer reads as the row's.
  const alike = [e("ABB AG - BUSCH-JAEGER", "6B8E", 731), e("ABB AG - STOTZ-KONTAKT", "6B8E", 873)];
  expect(pickCatalogueRow(alike, "TB/U1", "M-0002_A-4201-13-6B9E-O0007")).toMatchObject({ hit: alike[0] });
  expect(pickCatalogueRow(alike, "TB/U1", "M-0002_A-4201-13-6B9E-O0007", "ABB AG - STOTZ-KONTAKT")).toMatchObject({ hit: alike[1], rows: 1 });
  // A manufacturer no row reads as narrows nothing: the insert is checked afterwards.
  expect(pickCatalogueRow(alike, "TB/U1", "M-0002_A-4201-13-6B9E-O0007", "Siemens")).toMatchObject({ hit: alike[0] });
});

test("the simulator's files on the bench host: the product and each learned ETS6.log copied beside its logs, in order", () => {
  const unit = ["M-0007_A-A0B3-12-7C29-O0002", "--product", "/tmp/p/M-0007.knxproj", "--donor", "openknx-raumcontroller", "--learned-from", "/rows/a/1/ets6.log.txt", "--learned-from", "/rows/a/2/ets6.log.txt"];
  const { args, uploads } = benchSimArgs(unit, "/h/sim-3701");
  expect(args).toEqual(["M-0007_A-A0B3-12-7C29-O0002", "--product", "/h/sim-3701/in-0-M-0007.knxproj", "--donor", "openknx-raumcontroller", "--learned-from", "/h/sim-3701/in-1-ets6.log.txt", "--learned-from", "/h/sim-3701/in-2-ets6.log.txt"]);
  expect(uploads).toEqual([["/tmp/p/M-0007.knxproj", "/h/sim-3701/in-0-M-0007.knxproj"], ["/rows/a/1/ets6.log.txt", "/h/sim-3701/in-1-ets6.log.txt"], ["/rows/a/2/ets6.log.txt", "/h/sim-3701/in-2-ets6.log.txt"]]);
  expect(benchSimArgs(["meanwell-knx40e"], "/h/sim-3701")).toEqual({ args: ["meanwell-knx40e"], uploads: [] });
});

test("the simulator starts on the bench host with its proxy on the row's port, and its capture on loopback, both recorded by PID", () => {
  const script = simStartScript({ code: "/h/code", corpus: "/h/corpus", dir: "/h/sim-3701", state: "/h", pids: "sim-3701.pids", args: ["meanwell-knx40e"], log: "ets.log", port: 3701, advertise: "127.0.0.1", overrides: ["0/78=", "it's"] });
  expect(script).toContain("BUSFORGE_CORPUS='/h/corpus' setsid nohup 'bun' 'run' 'tools/sim-unit-serve.ts' 'meanwell-knx40e' '--tool' 'ETS' '--log' '/h/sim-3701/ets.log' '--port' '3700' '--proxy-port' '3701' '--advertise' '127.0.0.1' '--override' '0/78=' '--override' 'it'\\''s'");
  expect(script).toContain(`echo "sim $! $(st $!)" > '/h/sim-3701.pids'`);
  expect(script).toContain("dumpcap -q -i lo -f 'tcp port 3701' -w '/h/sim-3701/ets.pcapng'");
  expect(script).toContain(`echo "dumpcap $! $(st $!)" >> '/h/sim-3701.pids'`);
  expect(pcapOf("/rows/x/defaults/ets.log")).toBe("/rows/x/defaults/ets.pcapng");
  expect(pcapOf("/rows/x/defaults/wrong-interface.log")).toBe("/rows/x/defaults/wrong-interface.pcapng");
});

