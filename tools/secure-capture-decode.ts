// Decrypt the A_Data_Secure frames of a knxproxy capture log offline.
// Keys come only from the environment, never from a file:
//   KEYS="fdsk=<32 hex>,tool=<32 hex>"   tried on every tool-access frame (P2P or to 0/0/0)
//   GROUP_KEYS="2/1/7=<32 hex>,..."       optional, for the other secured group frames (three-level addresses)
//   bun run tools/secure-capture-decode.ts <capture.log>
import { readFileSync } from "node:fs";
import { numToGa as ga, numToIa as ia } from "../packages/knx/src/frame.ts";
import { SecureCaptureDecoder, addKeys, emptyKeys, parseKeyList } from "./secure-capture.ts";

const file = process.argv[2];
if (!file) throw new Error("usage: secure-capture-decode.ts <capture.log>");

const keys = emptyKeys();
// A group key's name is its three-level address; anything else is refused rather than tried on another address.
function groupAddress(name: string): number {
  const m = name.match(/^(\d+)\/(\d+)\/(\d+)$/);
  const [main, mid, sub] = m ? m.slice(1).map(Number) : [];
  if (!m || main > 31 || mid > 7 || sub > 255) throw new Error(`GROUP_KEYS: ${name} is not a three-level group address`);
  return (main << 11) | (mid << 8) | sub;
}
addKeys(keys, parseKeyList(process.env.KEYS), parseKeyList(process.env.GROUP_KEYS).map((k) => ({ raw: groupAddress(k.name), key: k })));
const decoder = new SecureCaptureDecoder(keys);

// The bus source of a tunnelled request is the tunnel's IA, which ETS leaves as 0.0.0 and the confirmation that
// follows carries: such a request waits and is printed at the next tunnel frame or the file's end, after a
// confirmation has set the address.
let tunnelIa = 0;
let pending: (() => void) | null = null;
const flush = () => { const p = pending; pending = null; p?.(); };

function print(ts: string, dir: string, src: number, dst: number, isGroup: boolean, tpdu: Buffer): void {
  const where = `${ia(src)}->${isGroup ? ga(dst) : ia(dst)}`;
  const fr = decoder.open(src, dst, isGroup, tpdu);
  const extra = fr.serial ? ` serial=${fr.serial.toString("hex")}` : "";
  const head = `${ts} ${dir} ${where} SCF=${fr.scf.toString(16)} ${fr.service}${extra}`;
  if (fr.truncated) { console.log(`${head}  TRUNCATED`); return; }
  if (fr.noRequest) { console.log(`${ts} ${dir} ${where} SCF=${fr.scf.toString(16)} Sync.res  (no matching Sync.req decrypted)`); return; }
  if (!fr.opened) { console.log(`${head}  UNDECRYPTED`); return; }
  console.log(`${head} seq=${fr.opened.seq.toString("hex")} key=${fr.opened.key}  ${fr.opened.plaintext.toString("hex")}`);
}

for (const line of readFileSync(file, "utf8").split("\n")) {
  const bar = line.lastIndexOf(" | ");
  if (bar < 0 || !line.includes("TUNNELLING_REQ")) continue;
  const f = Buffer.from(line.slice(bar + 3).trim(), "hex");
  const cemi = f.subarray(10);
  const mc = cemi[0];
  const o = 2 + cemi[1];
  // an L_Data frame with at least one TPDU octet, as the capture index reads it
  if (cemi.length < o + 8) continue;
  const ctrl2 = cemi[o + 1];
  const src = cemi.readUInt16BE(o + 2);
  const dst = cemi.readUInt16BE(o + 4);
  const tpdu = cemi.subarray(o + 7);
  if (mc === 0x2e && src !== 0) tunnelIa = src;
  flush();
  if (mc === 0x2e) continue; // the confirmation repeats the request
  const isGroup = (ctrl2 & 0x80) !== 0;
  if (tpdu.length < 2 || (tpdu[0] & 0x03) !== 0x03 || tpdu[1] !== 0xf1) continue;

  const ts = line.slice(0, 24);
  // The tool as the proxy named it (PROXY_TOOL), never assumed to be ETS.
  const tool = line.match(/ (\S+)->BRIDGE /)?.[1];
  const dir = tool ? `${tool}>` : "<DEV";
  if (mc === 0x11 && src === 0) pending = () => print(ts, dir, tunnelIa, dst, isGroup, tpdu);
  else print(ts, dir, src, dst, isGroup, tpdu);
}
flush();
