// Decrypt the A_Data_Secure frames of a knxproxy capture log offline.
// Keys come only from the environment, never from a file:
//   KEYS="fdsk=<32 hex>,tool=<32 hex>"   tried in order on every secured P2P frame
//   GROUP_KEYS="2/1/7=<32 hex>,..."       optional, for secured group frames
//   bun run tools/secure-capture-decode.ts <capture.log>
import { readFileSync } from "node:fs";
import { secureDecode } from "../packages/knx/src/secure.ts";

const file = process.argv[2];
if (!file) throw new Error("usage: secure-capture-decode.ts <capture.log>");

const parseKeys = (s: string | undefined) =>
  (s ?? "").split(",").filter(Boolean).map((kv) => {
    const [name, hex] = kv.split("=");
    const key = Buffer.from(hex.trim(), "hex");
    if (key.length !== 16) throw new Error(`key ${name} is not 16 bytes`);
    return { name: name.trim(), key };
  });
const keys = parseKeys(process.env.KEYS);
const groupKeys = new Map(parseKeys(process.env.GROUP_KEYS).map((k) => [k.name, k.key]));

const ia = (n: number) => `${(n >> 12) & 0xf}.${(n >> 8) & 0xf}.${n & 0xff}`;
const ga = (n: number) => `${(n >> 11) & 0x1f}/${(n >> 8) & 0x7}/${n & 0xff}`;

const SCF_SERVICE: Record<number, string> = { 0: "S-A_Data", 2: "Sync.req", 3: "Sync.res" };

// The bus source of a tunnelled request is the tunnel's IA, which ETS leaves as 0.0.0;
// learn it from the first confirmation that carries it.
let tunnelIa = 0;
const challenges = new Map<string, Buffer>(); // "src>dst" of the Sync.req -> plaintext challenge

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
  const dir = line.includes("ETS->BRIDGE") ? "ETS>" : "<DEV";
  const outerTpci = tpdu[0];
  let body = tpdu.subarray(2);
  const scf = body[0];
  const service = scf & 0x07;
  const where = `${ia(src)}->${isGroup ? ga(dst) : ia(dst)}`;
  let aadFor = (s: number) => Buffer.from([s]);
  let extra = "";

  if (service === 2) {
    // Sync.req carries the target serial in clear after the sequence, and in the AAD.
    const serial = body.subarray(7, 13);
    aadFor = (s) => Buffer.concat([Buffer.from([s]), serial]);
    body = Buffer.concat([body.subarray(0, 7), body.subarray(13)]);
    extra = ` serial=${serial.toString("hex")}`;
  } else if (service === 3) {
    // Sync.res: the sequence slot is random XOR the requester's challenge.
    const ch = challenges.get(`${ia(dst)}>${ia(src)}`);
    if (!ch) { console.log(`${ts} ${dir} ${where} SCF=${scf.toString(16)} Sync.res  (no matching Sync.req decrypted)`); continue; }
    const r = Buffer.alloc(6);
    for (let i = 0; i < 6; i++) r[i] = body[1 + i] ^ ch[i];
    body = Buffer.concat([body.subarray(0, 1), r, body.subarray(7)]);
  }

  const candidates = isGroup ? (groupKeys.has(ga(dst)) ? [{ name: ga(dst), key: groupKeys.get(ga(dst))! }] : []) : keys;
  let hit: { name: string; plaintext: Buffer; seq: Buffer } | null = null;
  for (const k of candidates) {
    const r = secureDecode(body, { key: k.key, src, dst, dstIsGroup: isGroup, tpci: outerTpci, aadFor });
    if (r) { hit = { name: k.name, ...r }; break; }
  }
  const head = `${ts} ${dir} ${where} SCF=${scf.toString(16)} ${SCF_SERVICE[service] ?? `svc${service}`}${extra}`;
  if (!hit) { console.log(`${head}  UNDECRYPTED`); continue; }
  if (service === 2) challenges.set(`${ia(src)}>${ia(dst)}`, hit.plaintext);
  console.log(`${head} seq=${hit.seq.toString("hex")} key=${hit.name}  ${hit.plaintext.toString("hex")}`);
}
