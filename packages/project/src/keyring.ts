import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { KnxprojError } from "./errors.ts";

// The ETS keyring (.knxkeys): an XML file in namespace http://knx.org/xml/keyring/1 carrying the KNX
// Data Secure keys of a project, every key AES-128-CBC encrypted under a key derived from the keyring
// password, the whole file signed with a hash over its element tree and that key. Format as ETS 5/6
// writes it and as Calimero (io.calimero.secure.Keyring) and xknx (xknx/secure/keyring.py) read it;
// the known-answer files in test/fixtures/knxkeys are real ETS exports.

export const KEYRING_NAMESPACE = "http://knx.org/xml/keyring/1";

export interface KeyringDevice {
  individualAddress: string;  // "a.l.d"
  toolKey?: Uint8Array;       // 16 bytes
  sequenceNumber?: bigint;    // the device's own sending counter as last seen
  serialNumber?: Uint8Array;  // 6 bytes, written as 12 hex digits
  fdsk?: Uint8Array;          // 16 bytes, the factory key from the device certificate
}
export interface KeyringGroup { address: number; key: Uint8Array; } // raw 16-bit group address
// A tunnelling interface (channel) and the secured addresses assigned to it, each with the other
// individual addresses that send there. Written without host, user id or passwords (no KNX IP Secure).
export interface KeyringInterface { individualAddress: string; groups: { address: number; senders: string[] }[]; }
export interface Keyring {
  project?: string;
  createdBy?: string;
  created: string; // "YYYY-MM-DDTHH:MM:SS"; the IV of every encrypted value is derived from this exact string
  devices: KeyringDevice[];
  groups: KeyringGroup[];
  interfaces?: KeyringInterface[];
}

// A generic element: attributes in document order, child elements in document order. The signature
// is defined over this tree, so writing and verifying share it.
interface El { name: string; attrs: [string, string][]; children: El[]; }

function passwordKey(password: string): Buffer {
  // Calimero reads the password as US-ASCII, xknx as UTF-8: only ASCII means the same key to both.
  if (!password || !/^[\x20-\x7e]+$/.test(password)) throw new KnxprojError("KEYRING_PASSWORD_INVALID", "a keyring password must be non-empty printable ASCII");
  return pbkdf2Sync(Buffer.from(password, "ascii"), Buffer.from("1.keyring.ets.knx.org"), 65536, 16, "sha256");
}
const ivOf = (created: string) => createHash("sha256").update(created, "utf8").digest().subarray(0, 16);

function encryptKey(key: Uint8Array, pwKey: Buffer, iv: Buffer): string {
  if (key.length !== 16) throw new KnxprojError("KEYRING_KEY_INVALID", `a keyring key must be 16 bytes, got ${key.length}`);
  const c = createCipheriv("aes-128-cbc", pwKey, iv).setAutoPadding(false);
  return Buffer.concat([c.update(key), c.final()]).toString("base64");
}
function decryptKey(b64: string, pwKey: Buffer, iv: Buffer, what: string): Uint8Array {
  const data = Buffer.from(b64, "base64");
  if (data.length !== 16) throw new KnxprojError("KEYRING_MALFORMED", `${what} is not one 16-byte block`);
  const d = createDecipheriv("aes-128-cbc", pwKey, iv).setAutoPadding(false);
  return Buffer.concat([d.update(data), d.final()]);
}

// SHA-256 over: per element 0x01, its local name, its attributes sorted by name (xmlns and Signature
// left out) as name/value pairs, its child elements, 0x02; every string preceded by its length in one
// byte; then the base64 of the password key, length-prefixed. The signature is the first 16 bytes.
function signature(root: El, pwKey: Buffer): string {
  const out: number[] = [];
  const str = (s: string) => {
    const b = Buffer.from(s, "utf8");
    if (b.length > 255) throw new KnxprojError("KEYRING_MALFORMED", `keyring value over 255 bytes: ${s.slice(0, 40)}...`);
    out.push(b.length, ...b);
  };
  const el = (e: El) => {
    out.push(0x01);
    str(e.name);
    const attrs = e.attrs.filter(([n]) => n !== "xmlns" && n !== "Signature").sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [n, v] of attrs) { str(n); str(v); }
    for (const c of e.children) el(c);
    out.push(0x02);
  };
  el(root);
  str(pwKey.toString("base64"));
  return createHash("sha256").update(Buffer.from(out)).digest().subarray(0, 16).toString("base64");
}

const IA = /^(\d{1,2})\.(\d{1,2})\.(\d{1,3})$/;
function checkIa(ia: string): string {
  const m = IA.exec(ia);
  if (!m || Number(m[1]) > 15 || Number(m[2]) > 15 || Number(m[3]) > 255 || ia === "0.0.0") throw new KnxprojError("KEYRING_MALFORMED", `${ia} is not an individual address`);
  return ia;
}

// Tab, line feed and carriage return go out as character references: a conforming parser turns them
// into spaces when written raw, and would then sign a different value than we did. Other control
// characters have no place in XML 1.0.
function escapeAttr(v: string): string {
  const control = (i: number) => { const c = v.charCodeAt(i); return c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d; };
  if (Array.from({ length: v.length }, (_, i) => i).some(control)) throw new KnxprojError("KEYRING_MALFORMED", "a keyring value contains a control character");
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    .replace(/\t/g, "&#9;").replace(/\n/g, "&#10;").replace(/\r/g, "&#13;");
}
function toXml(e: El, indent: string): string {
  const attrs = e.attrs.map(([n, v]) => ` ${n}="${escapeAttr(v)}"`).join("");
  if (e.children.length === 0) return `${indent}<${e.name}${attrs} />`;
  return [`${indent}<${e.name}${attrs}>`, ...e.children.map((c) => toXml(c, indent + "  ")), `${indent}</${e.name}>`].join("\r\n");
}

// The keyring as ETS writes it: UTF-8 with BOM, CRLF line ends, the Signature on the root (as the ETS
// 5.7 export in Calimero's test/resources/KeyringTest.knxkeys has it; xknx's copy is normalized to LF).
export function writeKeyring(k: Keyring, password: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(k.created)) throw new KnxprojError("KEYRING_MALFORMED", `Created ${k.created} is not YYYY-MM-DDTHH:MM:SS`);
  const pwKey = passwordKey(password);
  const iv = ivOf(k.created);
  const children: El[] = [];
  const checkGa = (g: number) => {
    if (!Number.isInteger(g) || g < 1 || g > 0xffff) throw new KnxprojError("KEYRING_MALFORMED", `${g} is not a group address`);
  };
  const interfaceIas = new Set<string>();
  for (const itf of k.interfaces ?? []) {
    const ia = checkIa(itf.individualAddress);
    if (interfaceIas.has(ia)) throw new KnxprojError("KEYRING_MALFORMED", `interface ${ia} listed twice`);
    interfaceIas.add(ia);
    children.push({
      name: "Interface", attrs: [["Type", "Tunneling"], ["IndividualAddress", ia]],
      children: [...itf.groups].sort((a, b) => a.address - b.address).map((g) => {
        checkGa(g.address);
        const senders = g.senders.map(checkIa);
        return { name: "Group", attrs: senders.length ? [["Address", String(g.address)], ["Senders", senders.join(" ")]] : [["Address", String(g.address)]], children: [] };
      }),
    });
  }
  if (k.groups.length > 0) {
    const seen = new Set<number>();
    children.push({
      name: "GroupAddresses", attrs: [], children: [...k.groups].sort((a, b) => a.address - b.address).map((g) => {
        checkGa(g.address);
        if (seen.has(g.address)) throw new KnxprojError("KEYRING_MALFORMED", `group address ${g.address} listed twice`);
        seen.add(g.address);
        return { name: "Group", attrs: [["Address", String(g.address)], ["Key", encryptKey(g.key, pwKey, iv)]], children: [] };
      }),
    });
  }
  if (k.devices.length > 0) {
    const seen = new Set<string>();
    children.push({
      name: "Devices", attrs: [], children: k.devices.map((d) => {
        const ia = checkIa(d.individualAddress);
        if (seen.has(ia)) throw new KnxprojError("KEYRING_MALFORMED", `device ${ia} listed twice`);
        seen.add(ia);
        const attrs: [string, string][] = [["IndividualAddress", ia]];
        if (d.toolKey) attrs.push(["ToolKey", encryptKey(d.toolKey, pwKey, iv)]);
        if (d.sequenceNumber !== undefined) {
          if (d.sequenceNumber < 0n || d.sequenceNumber >= 2n ** 48n) throw new KnxprojError("KEYRING_MALFORMED", `sequence number of ${ia} out of range`);
          attrs.push(["SequenceNumber", d.sequenceNumber.toString()]);
        }
        if (d.serialNumber) {
          if (d.serialNumber.length !== 6) throw new KnxprojError("KEYRING_MALFORMED", `serial number of ${ia} must be 6 bytes`);
          attrs.push(["SerialNumber", Buffer.from(d.serialNumber).toString("hex").toUpperCase()]);
        }
        if (d.fdsk) attrs.push(["FDSK", encryptKey(d.fdsk, pwKey, iv)]);
        return { name: "Device", attrs, children: [] };
      }),
    });
  }
  const rootAttrs: [string, string][] = [];
  if (k.project !== undefined) rootAttrs.push(["Project", k.project]);
  if (k.createdBy !== undefined) rootAttrs.push(["CreatedBy", k.createdBy]);
  rootAttrs.push(["Created", k.created]);
  const root: El = { name: "Keyring", attrs: rootAttrs, children };
  root.attrs.push(["Signature", signature(root, pwKey)], ["xmlns", KEYRING_NAMESPACE]);
  return "﻿" + `<?xml version="1.0" encoding="utf-8"?>\r\n` + toXml(root, "") + "\r\n";
}

// fast-xml-parser's ordered form: one object per node, keyed by tag name, attributes under ":@".
type Ordered = Record<string, unknown> & { ":@"?: Record<string, string> };
function toEl(node: Ordered): El | null {
  const name = Object.keys(node).find((k) => k !== ":@");
  if (!name || name.startsWith("#") || name.startsWith("?")) return null;
  const attrs = Object.entries(node[":@"] ?? {}).map(([n, v]) => [n.replace(/^@_/, ""), String(v)] as [string, string]);
  const children = ((node[name] as Ordered[] | undefined) ?? []).map(toEl).filter((c): c is El => c !== null);
  return { name: name.replace(/^.*:/, ""), attrs, children };
}

// Read a keyring and check its signature against the password: a wrong password or an altered file
// is refused, never half-read. Interfaces and the backbone are read only as far as the signature needs.
export function readKeyring(xml: string, password: string): Keyring {
  const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "@_", parseAttributeValue: false, trimValues: false, htmlEntities: true });
  const doc = parser.parse(xml.replace(/^﻿/, "")) as Ordered[];
  const root = doc.map(toEl).find((e): e is El => e !== null);
  const attr = (e: El, n: string) => e.attrs.find(([k]) => k === n)?.[1];
  if (!root || root.name !== "Keyring" || attr(root, "xmlns") !== KEYRING_NAMESPACE) throw new KnxprojError("KEYRING_MALFORMED", "not a KNX keyring (http://knx.org/xml/keyring/1)");
  const created = attr(root, "Created");
  const sig = attr(root, "Signature");
  if (!created || !sig) throw new KnxprojError("KEYRING_MALFORMED", "keyring without Created or Signature");
  const pwKey = passwordKey(password);
  if (signature(root, pwKey) !== sig) throw new KnxprojError("KEYRING_SIGNATURE_MISMATCH", "the keyring's signature does not match: wrong password or an altered file");
  const iv = ivOf(created);
  const devices: KeyringDevice[] = [];
  const groups: KeyringGroup[] = [];
  const interfaces: KeyringInterface[] = [];
  for (const c of root.children) {
    if (c.name === "Interface") {
      interfaces.push({
        individualAddress: checkIa(attr(c, "IndividualAddress") ?? ""),
        groups: c.children.filter((x) => x.name === "Group").map((g) => ({
          address: Number(attr(g, "Address")),
          senders: (attr(g, "Senders") ?? "").split(/\s+/).filter(Boolean).map(checkIa),
        })),
      });
    } else if (c.name === "GroupAddresses") {
      for (const g of c.children.filter((x) => x.name === "Group")) {
        const address = Number(attr(g, "Address"));
        const key = attr(g, "Key");
        if (!Number.isInteger(address) || !key) throw new KnxprojError("KEYRING_MALFORMED", "a group without Address or Key");
        groups.push({ address, key: decryptKey(key, pwKey, iv, `key of group ${address}`) });
      }
    } else if (c.name === "Devices") {
      for (const d of c.children.filter((x) => x.name === "Device")) {
        const ia = checkIa(attr(d, "IndividualAddress") ?? "");
        const tk = attr(d, "ToolKey");
        const seq = attr(d, "SequenceNumber");
        const sn = attr(d, "SerialNumber");
        const fdsk = attr(d, "FDSK");
        if (seq !== undefined && !/^\d+$/.test(seq)) throw new KnxprojError("KEYRING_MALFORMED", `sequence number of ${ia} is not a number`);
        if (sn !== undefined && !/^[0-9A-Fa-f]{12}$/.test(sn)) throw new KnxprojError("KEYRING_MALFORMED", `serial number of ${ia} is not 12 hex digits`);
        devices.push({
          individualAddress: ia,
          ...(tk ? { toolKey: decryptKey(tk, pwKey, iv, `tool key of ${ia}`) } : {}),
          ...(seq !== undefined ? { sequenceNumber: BigInt(seq) } : {}),
          ...(sn !== undefined ? { serialNumber: Buffer.from(sn, "hex") } : {}),
          ...(fdsk ? { fdsk: decryptKey(fdsk, pwKey, iv, `FDSK of ${ia}`) } : {}),
        });
      }
    }
  }
  return { project: attr(root, "Project"), createdBy: attr(root, "CreatedBy"), created, devices, groups, interfaces };
}
