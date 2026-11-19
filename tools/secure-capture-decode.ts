// Decrypt the A_Data_Secure frames of a knxproxy capture log offline.
// Keys come only from the environment, never from a file:
//   KEYS="fdsk=<32 hex>,tool=<32 hex>"   tried in order on every tool-access frame (P2P or to 0/0/0)
//   GROUP_KEYS="2/1/7=<32 hex>,..."       optional, for the other secured group frames
//   bun run tools/secure-capture-decode.ts <capture.log>
import { readFileSync } from "node:fs";
import { gaToNum } from "../packages/knx/src/frame.ts";
import { SecureCaptureDecoder, addKeys, emptyKeys, ga, ia, parseKeyList } from "./secure-capture.ts";

const file = process.argv[2];
if (!file) throw new Error("usage: secure-capture-decode.ts <capture.log>");

const keys = emptyKeys();
addKeys(keys, parseKeyList(process.env.KEYS), parseKeyList(process.env.GROUP_KEYS).map((k) => ({ raw: gaToNum(k.name), key: k })));
const decoder = new SecureCaptureDecoder(keys);

// The bus source of a tunnelled request is the tunnel's IA, which ETS leaves as 0.0.0;
// learn it from the first confirmation that carries it.
let tunnelIa = 0;

for (const line of readFileSync(file, "utf8").split("\n")) {
  const bar = line.lastIndexOf(" | ");
  if (bar < 0 || !line.includes("TUNNELLING_REQ")) continue;
  const f = Buffer.from(line.slice(bar + 3).trim(), "hex");
  const cemi = f.subarray(10);
  const mc = cemi[0];
  const o = 2 + cemi[1];
  if (cemi.length < o + 9) continue;
  const ctrl2 = cemi[o + 1];
  let src = cemi.readUInt16BE(o + 2);
  const dst = cemi.readUInt16BE(o + 4);
  const tpdu = cemi.subarray(o + 7);
  if (mc === 0x2e && src !== 0) tunnelIa = src;
  if (mc === 0x11 && src === 0) src = tunnelIa;
  if (mc === 0x2e) continue; // the confirmation repeats the request
  const isGroup = (ctrl2 & 0x80) !== 0;
  if (tpdu.length < 2 || (tpdu[0] & 0x03) !== 0x03 || tpdu[1] !== 0xf1) continue;

  const ts = line.slice(0, 24);
  // The tool as the proxy named it (PROXY_TOOL), never assumed to be ETS.
  const tool = line.match(/ (\S+)->BRIDGE /)?.[1];
  const dir = tool ? `${tool}>` : "<DEV";
  const where = `${ia(src)}->${isGroup ? ga(dst) : ia(dst)}`;
  const fr = decoder.open(src, dst, isGroup, tpdu);
  const extra = fr.serial ? ` serial=${fr.serial.toString("hex")}` : "";
  const head = `${ts} ${dir} ${where} SCF=${fr.scf.toString(16)} ${fr.service}${extra}`;
  if (fr.noRequest) { console.log(`${ts} ${dir} ${where} SCF=${fr.scf.toString(16)} Sync.res  (no matching Sync.req decrypted)`); continue; }
  if (!fr.opened) { console.log(`${head}  UNDECRYPTED`); continue; }
  console.log(`${head} seq=${fr.opened.seq.toString("hex")} key=${fr.opened.key}  ${fr.opened.plaintext.toString("hex")}`);
}
