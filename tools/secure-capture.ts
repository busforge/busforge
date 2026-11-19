// Opening the A_Data_Secure telegrams of a capture offline. Keys are held in memory only: they come from the
// environment or from the private corpus's project archives and keyrings, never from a file of their own, and
// nothing here writes a key or a plaintext anywhere. tools/secure-capture-decode.ts prints one capture's
// telegrams with it; tools/capture-index.ts counts the services inside them.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { numToGa, numToIa } from "../packages/knx/src/frame.ts";
import { loadKnxproj } from "../packages/project/src/knxproj.ts";
import { readKeyring } from "../packages/project/src/keyring.ts";
import { SECURE_APDU_OVERHEAD, secureDecode } from "../packages/knx/src/secure.ts";
import { NEEDS_PASSWORD, NOT_THIS_PASSWORD, codeOf, describeFailure } from "./corpus-archives.ts";

export interface NamedKey { name: string; key: Buffer }
// Device keys (tool keys and FDSKs) are tried on every tool-access telegram; a group key only on telegrams to its
// group address (raw 16-bit).
export interface SecureKeys { device: NamedKey[]; group: Map<number, NamedKey[]> }

export const emptyKeys = (): SecureKeys => ({ device: [], group: new Map() });
export const groupKeyCount = (keys: SecureKeys) => [...keys.group.values()].reduce((n, l) => n + l.length, 0);

// "name=<32 hex>,..." as the environment gives keys.
export function parseKeyList(s: string | undefined): NamedKey[] {
  return (s ?? "").split(",").filter((kv) => kv.trim() !== "").map((kv, i) => {
    const at = kv.indexOf("=");
    if (at < 0) throw new Error(`key entry ${i + 1} is not name=<32 hex>`);
    const name = kv.slice(0, at).trim();
    const hex = kv.slice(at + 1).trim();
    if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error(`key ${name} is not 16 bytes of hex`);
    return { name, key: Buffer.from(hex, "hex") };
  });
}

// Adds a key unless the same key bytes are already there, so the first source that holds it names it.
function addDevice(keys: SecureKeys, k: NamedKey): void {
  if (!keys.device.some((d) => d.key.equals(k.key))) keys.device.push(k);
}
function addGroup(keys: SecureKeys, raw: number, k: NamedKey): void {
  const list = keys.group.get(raw) ?? [];
  if (!list.some((g) => g.key.equals(k.key))) list.push(k);
  keys.group.set(raw, list);
}
export function addKeys(keys: SecureKeys, device: NamedKey[], group: { raw: number; key: NamedKey }[] = []): void {
  for (const k of device) addDevice(keys, k);
  for (const g of group) addGroup(keys, g.raw, g.key);
}

// ── keys from the corpus ─────────────────────────────────────────────────────

// `omitted` names the keys a source holds but did not give: Busforge's project reader takes only the first
// installation and no tool key of a device without a serial, and a key that is not 16 bytes is left out.
export interface KeySource { file: string; deviceKeys: number; groupKeys: number; omitted: string[] }
export interface KeyLoad { keys: SecureKeys; read: KeySource[]; notRead: { file: string; reason: string }[] }

// The tool keys and group keys of every ETS project (`.knxproj`) and the tool keys, FDSKs and group keys of
// every ETS keyring (`.knxkeys`) among `files` (relative to `root`). A project is tried without a password and
// with each of `passwords`, a keyring with each of `passwords`; one none opens, or one that cannot be read, is
// listed with the reason, never skipped. A key is named by its file and the device's address or the group
// address, the first file that holds it.
export function corpusKeys(root: string, files: string[], passwords: string[]): KeyLoad {
  const load: KeyLoad = { keys: emptyKeys(), read: [], notRead: [] };
  for (const file of files) {
    const keyring = /\.knxkeys$/i.test(file);
    let bytes: Buffer;
    try { bytes = readFileSync(join(root, file)); }
    catch (e) { load.notRead.push({ file, reason: `unreadable: ${describeFailure(e)}` }); continue; }
    let lastRefusal = keyring && passwords.length === 0 ? "a keyring, and no password given" : "";
    let opened = false;
    for (const pw of keyring ? passwords : [undefined, ...passwords]) {
      const before = { d: load.keys.device.length, g: groupKeyCount(load.keys) };
      let omitted: string[] = [];
      try {
        if (keyring) keyringKeys(load.keys, file, bytes.toString("utf8"), pw!);
        else omitted = projectKeys(load.keys, file, bytes, pw);
      } catch (e) {
        lastRefusal = describeFailure(e);
        // A keyring's wrong password shows as a signature that does not verify; a malformed keyring opens with none.
        const code = codeOf(e) ?? "";
        if (keyring ? code === "KEYRING_SIGNATURE_MISMATCH" : NEEDS_PASSWORD.has(code) || NOT_THIS_PASSWORD.has(code)) continue;
        break;
      }
      load.read.push({ file, deviceKeys: load.keys.device.length - before.d, groupKeys: groupKeyCount(load.keys) - before.g, omitted });
      opened = true;
      break;
    }
    if (!opened) load.notRead.push({ file, reason: lastRefusal });
  }
  return load;
}

// Returns what the project holds that it did not give.
function projectKeys(keys: SecureKeys, file: string, bytes: Buffer, password: string | undefined): string[] {
  const p = loadKnxproj(bytes, password, file);
  const omitted: string[] = [];
  if (p.skippedInstallations) omitted.push(`${p.skippedInstallations} installation(s) after the first, not read`);
  if (p.secureDevicesWithoutSerial) omitted.push(`the tool keys of ${p.secureDevicesWithoutSerial} device(s) without a serial`);
  const key = (what: string, b64: string) => {
    const k = Buffer.from(b64, "base64");
    if (k.length !== 16) omitted.push(`${what}: ${k.length} bytes, not 16`);
    return k.length === 16 ? k : null;
  };
  const address = new Map(p.devices.map((d) => [d.id, d.ia]));
  for (const s of p.deviceSecurity) {
    const name = `tool key ${address.get(s.deviceId) ?? s.deviceId}`;
    const k = key(name, s.toolKey);
    if (k) addDevice(keys, { name: `${file} ${name}`, key: k });
  }
  for (const g of p.groupKeys) {
    const name = `group key ${numToGa(g.raw)}`;
    const k = key(name, g.key);
    if (k) addGroup(keys, g.raw, { name: `${file} ${name}`, key: k });
  }
  return omitted;
}

function keyringKeys(keys: SecureKeys, file: string, xml: string, password: string): void {
  const k = readKeyring(xml, password);
  for (const d of k.devices) {
    if (d.toolKey) addDevice(keys, { name: `${file} tool key ${d.individualAddress}`, key: Buffer.from(d.toolKey) });
    if (d.fdsk) addDevice(keys, { name: `${file} FDSK ${d.individualAddress}`, key: Buffer.from(d.fdsk) });
  }
  for (const g of k.groups) addGroup(keys, g.address, { name: `${file} group key ${numToGa(g.address)}`, key: Buffer.from(g.key) });
}

// ── one telegram ─────────────────────────────────────────────────────────────

export const SCF_SERVICE: Record<number, string> = { 0: "S-A_Data", 2: "Sync.req", 3: "Sync.res" };
// The shortest body of each service behind the A_Data_Secure APCI: SCF, sequence and MAC, then an S-A_Data's inner
// APDU (2 octets at least), a Sync.req's serial and 6-octet challenge, a Sync.res's 12-octet answer.
const FRAMING = SECURE_APDU_OVERHEAD - 2;
const MIN_BODY: Record<number, number> = { 0: FRAMING + 2, 2: FRAMING + 6 + 6, 3: FRAMING + 12 };

export interface SecureFrame {
  scf: number;
  // S-A_Data, Sync.req, Sync.res, or "svc<n>" for a service the SCF names that KNX does not define.
  service: string;
  // SCF bit 7: the tool key or FDSK of a device, whatever the destination.
  toolAccess: boolean;
  // A body shorter than its service's layout: no key was tried.
  truncated?: boolean;
  // A Sync.req's target serial, in clear.
  serial?: Buffer;
  // The key that authenticated the telegram, its sequence (a Sync.res: random XOR challenge, recovered) and the
  // plaintext: the inner APDU of an S-A_Data, the challenge or answer of a Sync.
  opened?: { key: string; seq: Buffer; plaintext: Buffer };
  // A Sync.res with no opened Sync.req to answer: its sequence field cannot be recovered.
  noRequest?: boolean;
}

// The decoder of one capture: it keeps the Sync challenges it has opened, to open their answers, and the key
// that last opened a pair's telegrams, to try it first.
export class SecureCaptureDecoder {
  // The plaintext challenges of the Sync.reqs, by "tool -> device", the latest one for a point-to-point Sync.
  // A broadcast Sync (to 0/0/0) is answered by whichever device holds the serial, from an address the request
  // does not name, and to 0/0/0 again: all of them are kept under "* -> 0/0/0", and an answer is tried against
  // each until one authenticates.
  private readonly challenges = new Map<string, Buffer[]>();
  private readonly lastKey = new Map<string, NamedKey>();

  constructor(private readonly keys: SecureKeys) {}

  // `tpdu` is the A_Data_Secure TPDU: its TPCI/APCI pair, then the SCF and the rest.
  open(src: number, dst: number, isGroup: boolean, tpdu: Buffer): SecureFrame {
    const outerTpci = tpdu[0];
    const body = tpdu.subarray(2);
    const scf = body[0] ?? 0;
    const service = scf & 0x07;
    const toolAccess = (scf & 0x80) !== 0;
    const frame: SecureFrame = { scf, service: SCF_SERVICE[service] ?? `svc${service}`, toolAccess };
    if (body.length < (MIN_BODY[service] ?? MIN_BODY[0])) { frame.truncated = true; return frame; }
    let aadFor = (s: number) => Buffer.from([s]);
    let bodies = [body];

    if (service === 2) {
      // Sync.req carries the target serial in clear after the sequence, and in the AAD.
      const serial = Buffer.from(body.subarray(7, 13));
      frame.serial = serial;
      aadFor = (s) => Buffer.concat([Buffer.from([s]), serial]);
      bodies = [Buffer.concat([body.subarray(0, 7), body.subarray(13)])];
    } else if (service === 3) {
      // Sync.res: the sequence slot is random XOR the requester's challenge.
      const chs = this.challenges.get(isGroup ? `* -> ${numToGa(dst)}` : `${numToIa(dst)} -> ${numToIa(src)}`);
      if (!chs) { frame.noRequest = true; return frame; }
      bodies = chs.map((ch) => {
        const r = Buffer.alloc(6);
        for (let i = 0; i < 6; i++) r[i] = body[1 + i] ^ ch[i];
        return Buffer.concat([body.subarray(0, 1), r, body.subarray(7)]);
      });
    }

    // Tool access runs under a device's tool key or FDSK whatever the destination: ETS assigns a secure device's
    // address by serial with tool-access telegrams to the broadcast 0/0/0.
    const all = isGroup && !toolAccess ? (this.keys.group.get(dst) ?? []) : this.keys.device;
    const pair = [src, dst].sort((a, b) => a - b).join(isGroup ? "/" : ".");
    const last = this.lastKey.get(pair);
    const candidates = last && all.includes(last) ? [last, ...all.filter((k) => k !== last)] : all;
    for (const b of bodies) {
      for (const k of candidates) {
        const r = secureDecode(b, { key: k.key, src, dst, dstIsGroup: isGroup, tpci: outerTpci, aadFor });
        if (!r) continue;
        this.lastKey.set(pair, k);
        frame.opened = { key: k.name, seq: Buffer.from(r.seq), plaintext: Buffer.from(r.plaintext) };
        if (service === 2) {
          const at = isGroup ? `* -> ${numToGa(dst)}` : `${numToIa(src)} -> ${numToIa(dst)}`;
          this.challenges.set(at, isGroup ? [...(this.challenges.get(at) ?? []), frame.opened.plaintext] : [frame.opened.plaintext]);
        }
        return frame;
      }
    }
    return frame;
  }
}
