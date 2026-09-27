# KNX Data Secure

How Busforge reads and programs **KNX Data Secure** devices: devices that accept management
telegrams only when each one is authenticated and encrypted with a device-specific key.

What is proven, what is only wired and what is not implemented lives in
[status.md](status.md); this page describes the mechanism.

## Scope: Data Secure, not IP Secure

KNX Secure is **two independent mechanisms**. Busforge builds one and deliberately skips the other.

| | KNX Data Secure | KNX IP Secure |
|---|---|---|
| Layer | application APDU, end to end, medium-independent | KNXnet/IP transport, client to interface |
| Secures | each management or group telegram | the tunnel or routing connection |
| Key | per-device **tool key**, per-address group key | per-interface device authentication code and user password |
| In scope | **yes** | no |

They are orthogonal: the tunnel to the interface stays plain, and only the telegrams to a secure
device change. A device that is Data Secure commissioned refuses a plain device-descriptor read and
answers `0xFFFF`. **That `0xFFFF` is a locked door, not a different memory model**, which is worth
saying because it is easy to mistake for an unknown mask.

**The boundary, stated honestly:** Busforge re-configures devices that were already commissioned
with a tool key, imported from the project file. Writing a device's tool key from its factory key
(from-scratch provisioning) is not built.

## Where the secure layer sits

A clean seam already existed. `KnxDevice` builds every management APDU and hands plain cEMI to a
`KnxTransport`. Data Secure slots in as a **transparent envelope between the two**, so it is
medium-independent (IP or USB) and no flashing code changes.

```
  KnxDevice                SecureSession                  KnxTransport
  builds A_Memory_Read  →  wrap: SCF + seq + CCM(inner) →  sendCemi (plain tunnel)
  parses A_Memory_Resp  ←  unwrap: verify + decrypt     ←  onCemi
                           │
                           └── key and live sequence from the key store + Sync
```

`SecureSession` owns the tool key, the live tool-access sequence counter obtained by a Sync at
session start, and the CCM wrap and unwrap. `KnxDevice` keeps building exactly the same inner APDUs
it always did; they become the plaintext payload. A non-secure device keeps the direct path
untouched: the session is inserted only when a device is known to be secure.

**Everything is wrapped, verbatim.** Device descriptor read, memory read and write, property read
and write, restart, the load state machine writes: each is built as usual and carried as the inner
APDU. The load procedures in [load-procedures.md](load-procedures.md) run unchanged inside the
envelope.

## The protocol

The reference is the pair of interoperating open implementations (Calimero and thelsing/knx), which
agree byte for byte. The KNX application note itself is paywalled; two implementations that
interoperate are the authoritative open source of truth.

### The secure APDU

A secure APDU is itself a normal connection-oriented, numbered APDU with `APCI = 0x3F1`. The
plaintext inner APDU becomes the encrypted payload.

| offset | len | field |
|---|---|---|
| 0 | 1 | `TPCI \| 0x03` (numbered T_Data_Connected, top two APCI bits folded in) |
| 1 | 1 | `0xF1` (APCI low byte) |
| 2 | 1 | **SCF**, the security control field |
| 3 | 6 | **sequence number** (48-bit big-endian) |
| 9 | N | **encrypted inner APDU** |
| 9+N | 4 | **encrypted MAC** (truncated CCM tag, after the payload) |

For a Sync request a 6-byte serial number is inserted at offset 9, before the payload.

**SCF**, one byte, `T A A A B S S S`: bit 7 tool access, bits 6-4 the algorithm, bit 3 system
broadcast, bits 2-0 the service. A normal secure management write is therefore `0x90` (tool access,
CCM with authentication and confidentiality, service S-A_Data); a Sync request is `0x92`. Tool
access *requires* authentication plus confidentiality and an individual-address destination.

### AES-128-CCM, exactly as KNX builds it

**Not RFC 3610.** KNX's block layout has no flags octet and bakes the length into a fixed position,
so a generic CCM library is the wrong tool regardless of what a runtime happens to offer. The two
16-byte blocks are built by hand, then AES-CBC produces the MAC and AES-CTR the encryption.

**B0** (the CBC-MAC initial block):

| offset | len | field |
|---|---|---|
| 0 | 6 | sequence number |
| 6 | 2 | source individual address |
| 8 | 2 | destination address |
| 10 | 1 | `0x00` |
| 11 | 1 | `0x00` for point-to-point tool access, `0x80` if the destination is a group |
| 12 | 1 | TPCI byte |
| 13 | 1 | `0xF1` |
| 14 | 1 | `0x00` |
| 15 | 1 | **length of the plaintext inner APDU** |

**Ctr0**: `seq(6) | src(2) | dst(2) | 00 00 00 00 | 01 | 00`. Byte 15 is the per-block counter.

**AAD** (authenticated, not encrypted): the SCF alone for S-A_Data; the SCF plus the 6-byte target
serial for a Sync request.

**MAC and encryption.** The tag is the first 4 bytes of the *last* CBC output block over
`len16(AAD) || AAD || innerAPDU`, with B0 processed first as the IV block and a single pad at the
end. The CTR pass then encrypts the contiguous buffer `T(4) || innerAPDU` starting from Ctr0, so the
first payload bytes share Ctr0's keystream with the MAC; the payload is **not** re-aligned to Ctr1.
On the wire the encrypted payload comes first and the encrypted 4-byte MAC last.

The receive path detects an incoming secure APDU, verifies the MAC in constant time, decrypts, and
only then parses the recovered inner APDU. **A frame that fails its MAC is dropped, never returned
as data.** A replayed frame is transport-acknowledged but not delivered.

### Sequence numbers and Sync

There are **two independent 48-bit counters** per peer, tool access and data/group. Each side rejects
any frame whose sequence is not strictly greater than the last it accepted.

**The project file's `SequenceNumber` is the data/group counter, not tool access.** For programming,
a stored tool-access value is never trusted; it is obtained live:

1. At session start, send an S-A_Sync_Req: the payload is a random 48-bit challenge, the target's
   6-byte serial goes in the body and in the AAD, and the sequence slot carries the current counter.
2. The device replies with an S-A_Sync_Rsp whose sequence slot is `random XOR challenge`; recover
   `random` and use it as the sequence input for the blocks. The 12-byte payload is
   `deviceNextSeq(6) || ourNextSeq(6)`.
3. Adopt `ourNextSeq` and send every further tool-access frame with a strictly increasing value.

This repairs a stale or unknown counter in one round trip, and it is the first thing a secure session
does. A failed Sync is a coded refusal (`SECURE_SYNC_FAILED`), never a blind retry.

## The key store

Tool keys live in a first-class Busforge store, not in an ETS keyring.

**Where they come from.** Inside the password-protected project file (the same `0.xml` Busforge
already decrypts to parse), every secure device carries a `<Security>` element with a base64 16-byte
tool key and a sequence number. No `.knxkeys` import and no keyring parser are needed. The device's
serial number, needed for the Sync request, comes from the same device instance.

Today **import is the only population path**. The store's schema anticipates manually deposited and
provisioned keys, but there is no endpoint for either.

| Column | Notes |
|---|---|
| `project_id`, `device_id` | owner, matching the parser's device id |
| `tool_key` | 16-byte AES-128 key, **sealed at rest** |
| `serial_number` | 6-byte device serial, needed for the Sync request |
| `seq_group` | the project's group/data counter, kept for future secure group communication; **not** the tool-access counter |
| `source` | `import`, `manual` or `provisioned` |

A key that is not 16 bytes, or a serial that is not 6, is refused (`SECURE_KEY_BAD`) rather than
stored. Tool keys are never returned to the client and never logged.

### At rest, in restore points, in exports

**At rest.** The tool key is sealed with AES-256-GCM under an installation **master key** held
outside the database (`BUSFORGE_MASTER_KEY`, or `data/master.key` created with owner-only
permissions on first use), so the database file alone never reveals a key. The master key is an
installation secret, not project data. **The server refuses to start** when the database holds sealed
keys and no master key is available, rather than generating a fresh one that cannot open them.

**Restore points never roll a key back.** A restore point is a configuration checkpoint and
deliberately excludes device-commissioning state, exactly as it excludes the programmed baselines. A
tool key is commissioning state, so it is not in the payload and a restore never rewrites it. The
consequence is the safe one: you can never lose access to a device by undoing a configuration edit,
and a key rotated on the device is never silently replaced by a stale value.

**Exports always carry the keys, and warn.** A project must never be separated from the keys that let
it talk to its own devices, so the `.busforge` archive always includes them, unsealed. The container
is encrypted only when an export password is set, so an unencrypted archive contains device keys in
the clear, and the export dialog warns about exactly that before writing one. On import the keys are
re-sealed under the importing installation's master key. See [export-format.md](export-format.md).

## Using it

There is no secure-specific code path in the operations. `withDeviceSession` takes optional
credentials, and read-back, parameter flash, group-address flash and full download all pass the
device's stored key, so a device with a key on file is driven securely automatically. A device
recognised as secure gets a badge in the device list.

One dedicated endpoint exists, `secure-identify`: it opens a secure session with no mask gate (the
identification is what learns the mask) and returns the real device descriptor and serial. It is the
proof that the envelope works against a device that answers `0xFFFF` to everything plain. It is
reachable over the API and has no button in the UI today.

**Individual-address assignment has no secure path.** It is a broadcast operation and cannot go
through the session at all.

## The gap

Both directions of the secure channel are proven on real hardware: a secure descriptor and property
read, and a reversible secure property write. **A parameter flash over the secure channel is wired
and reachable, but has never been driven** (see [status.md](status.md)).

**The GA flash and the full download refuse a secure device** (`SECURE_TABLES_UNSUPPORTED`). A
Data Secure device keeps its group keys and per-object security flags in its security interface
object (object type 17), and its group key table is indexed by the position of each group address
in the address table. ETS loads that object with every GA or full download. Busforge does not yet,
so rewriting the group tables would leave the keys pointing at the wrong addresses, and a full
download would leave the old security configuration in place. The refusal covers addressing the device
(the first step of commissioning) and a parameter change that would need the com-object table
rewritten as well, instead of offering the usual full download; the device page offers none of them.
"Secure device" here means a device with a stored tool key, the only kind Busforge talks to
securely.

Driving a secure parameter flash needs a secure device a parameter flash can actually target, and
two common classes of secure device cannot serve:

- **A secure IP interface has no parameter image.** It is a `DefaultProcedure` device with **zero
  parameter segments**, configured through properties rather than a parameter image, so a parameter
  flash has nothing to write. Supporting it means building a property-based configuration path, a
  separate unimplemented capability, not "adding DefaultProcedure".
- **A device that is itself the bus gateway cannot be flashed over its own connection.** The flash
  restarts it, which drops the connection carrying the flash.

**The bench has a suitable device.** The Jung 400021SE (`M-0004_A-7072-21`) declares
`IsSecureEnabled="true"` in its application program, has a parameter image and is not the
interface. In both ETS captures of it (`tools/fixtures/jung-400021se-ets-fulldownload.log`, the
`A_FunctionPropertyExtState_Read` of object type 17, PID 51, near the start) ETS reads its security
mode and the device answers `00`, security off: it is secure-capable and currently runs plain.
Switching it to secure mode needs its factory key (FDSK, on the device certificate) and takes it off
the plain bench runs until a master reset. Jung's product documentation describes one (start in
safe state with the programming button held, then hold it longer than 5 s; this restores the FDSK
and wipes the configuration and address); it has not been tried on the bench. That is a user
decision, not yet taken.

So a secure parameter flash counts as supported only once it is byte-verified on a **suitable**
secure device, and the GA flash and full download only once the security object download exists
and is checked against an ETS capture of the same device.

**Provisioning from a factory key is not built.** Writing a tool key into a factory device is
hard to reverse (a wrong or half-completed write locks the device out, recoverable only through the
factory key or a factory reset), so it needs a sacrificial device to develop and verify against, plus
explicit sign-off and a recovery procedure. It is on [roadmap.md](roadmap.md), and no partial version
of it ships.

## The honesty bar for this area

- **CCM correctness is the central risk.** It is pinned two ways: known-answer vectors from the two
  reference implementations as the unit oracle, and the live secure read as the end-to-end oracle.
  Green unit tests alone never carry the claim.
- **Sequence staleness:** always Sync before tool-access traffic, and answer a "sequence too low"
  rejection by re-syncing, never by blindly retrying.
- **Key handling:** sealed at rest, never logged, never sent to the client.
- **No silent skip.** A device that cannot be reached securely (missing key, failed Sync) is
  reported as exactly that. It is never skipped, and it is never quietly retried in the clear.
