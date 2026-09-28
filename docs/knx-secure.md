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

**Group keys** come from the same file: a secured group address carries its 16-byte key in the
`Key` attribute of its `<GroupAddress>`. They live in `group_keys` (`project_id`, `raw`, `key`,
`source`), sealed like the tool keys, and are parsed apart from the address model so a key never
travels with an address to the client. Neither deleting an address nor a restore point touches its
key, so an address that comes back (by a restore, or recreated on the same value) is secured again,
never silently plain. Exports carry them next to the tool keys.

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
reachable over the API and has no button in the UI today. It also reports the device's security
mode (PID 51 of the security interface object, through `A_FunctionPropertyExtState_Read`), or that
the device did not answer it; it never guesses "off".

**A secured frame is 13 octets longer than the plain one it carries** (its own TPCI/APCI pair, SCF,
sequence and MAC). Every per-request data size therefore shrinks by 13 inside a session
(`transferChunks` in `packages/knx/src/device.ts`), and a request the framing leaves no room in is
refused (`SECURE_APDU_TOO_SHORT`), as is any secured memory request to a device that declares no
maximum APDU length. Shown for reads: a 48-byte extended read, the most the bench's USB path carries
in plain, got no answer from the secured Jung, 35 bytes did (sizes in between not tried). A secured
write is held to the 40 octets ETS sends on that path: 22-byte memory writes and 18-byte property
elements, which is what Busforge's own secured download of the Jung wrote and the device answered.
The extended property services carry 4 octets more than the extended memory ones, so their element
data per request is 4 less (`propRead`, `propWrite`).

**Every numbered service goes through the session**, the restart and the master reset included. A
device in secure mode acknowledges a plain A_Restart on the transport layer and then ignores it (the
Jung, 2026-09-28), which the restart check reports as `RESTART_IGNORED`.

**Individual-address assignment has no secure path.** It is a broadcast operation and cannot go
through the session at all.

## The gap

Both directions of the secure channel are proven on real hardware: a secure descriptor and property
read, a reversible secure property write, and a **secured full download** of the Jung (below).

### The security object

A Data Secure device keeps its group keys and per-object security flags in its security interface
object (object type 17), which ETS loads with every download of the group tables. On System B
Busforge does the same (`planSecurityObjectLoad` in `packages/knx/src/flash.ts`, built by
`buildSecurityObject` in `packages/product/src/securityobject.ts`):

| Property | What is written |
|---|---|
| PID 5 | the load state, driven with `A_FunctionPropertyExtCommand` (unload with the other objects, then load and load completed after all memory) |
| PID 54 | element 0 (the count of the individual-address table) set to 0 |
| PID 53 | the group key table: one 18-byte entry per secured address the device is linked to, the address's 1-based position in the device's address table then the key, ascending |
| PID 61 | one flag byte per group object from object 1: `0x03` (authentication and confidentiality) for an object on a secured address, `0x00` otherwise |

An object linked to both secured and plain addresses is refused (`SECURE_LINK_MIXED`): it has one
flag for all its links. The dry-run diff and the verify both read the object back (the device
returns its group keys only inside the session). Other memory models refuse a secure device's GA
flash and full download (`SECURE_TABLES_UNSUPPORTED`); addressing a secure device is refused
(`SECURE_ADDRESSING_UNSUPPORTED`).

**Shown on the Jung, 2026-09-28:** a dry-run GA flash found the object ETS had loaded equal to the one
Busforge builds from the project; Busforge's secured full download then wrote it (all 158
security-object frames, requests and answers, byte-identical to ETS's decrypted capture), restarted
the device through the session and verified tables, parameter CRC and security object after the
restart. The first attempt failed honestly with `RESTART_IGNORED`: the restart went out plain, which
a device in secure mode ignores. A GA flash that linked a second object to the secured address set
its flag on the device and verified; its revert restored ETS's load. **Not shown:** the secured group
address working on the bus (Busforge cannot yet send or decrypt a secured group
telegram).

**Refusals, shown on the same device:** a wrong tool key gets no answer to the Sync
(`SECURE_SYNC_NO_RESPONSE`); a plain session gets the descriptor `0xFFFF`, which the mask gate
reports as a missing key or an unexpected secure device (`SECURE_KEY_MISSING`), not as a mismatch;
a real answer with one bit flipped is dropped and reported as `SECURE_ANSWER_REJECTED` (the device
acknowledged and answered, and was not believed); a real answer replayed in place of the next is
dropped too and reported as `DEVICE_NOT_ANSWERING`, because a replay is MAC-valid and a stale
retransmission is ordinary transport, so it is no evidence against the key. Neither is ever used.
Both answers were altered in the test script between the tunnel and the session, not on the bus.

Driving a secure parameter flash needs a secure device a parameter flash can actually target, and
two common classes of secure device cannot serve:

- **A secure IP interface has no parameter image.** It is a `DefaultProcedure` device with **zero
  parameter segments**, configured through properties rather than a parameter image, so a parameter
  flash has nothing to write. Supporting it means building a property-based configuration path, a
  separate unimplemented capability, not "adding DefaultProcedure".
- **A device that is itself the bus gateway cannot be flashed over its own connection.** The flash
  restarts it, which drops the connection carrying the flash.

**The bench has a suitable device, and it now runs secure.** The Jung 400021SE (`M-0004_A-7072-21`)
declares `IsSecureEnabled="true"`, has a parameter image and is not the interface. On 2026-09-28 ETS
6.4.1 secure-commissioned it from its certificate, with one secured group address (0/0/1 on channel
1's switching output), through the logging proxy (see [The ETS reference capture](#the-ets-reference-capture)).
It left the plain bench runs with that: the plain smoke spec no longer applies, and the way back to
plain is Jung's documented master reset (start in safe state with the programming button held, then
hold it longer than 5 s; restores the FDSK, wipes configuration and address), not tried yet.

With the ETS project imported, Busforge reads the secured Jung back in full: parameters and links
equal to the ETS project, no gap (2026-09-28). `secure-identify` reports its security mode as on,
read from the security object itself.

So the secured full download, parameter flash and GA flash are supported on System B, each shown
once on this one device; a smoke spec with evidence records for them is still to come.

**Provisioning from a factory key is not built.** Writing a tool key into a factory device is
hard to reverse (a wrong or half-completed write locks the device out, recoverable only through the
factory key or a factory reset), so it needs a sacrificial device to develop and verify against, plus
explicit sign-off and a recovery procedure. It is on [roadmap.md](roadmap.md), and no partial version
of it ships.

## The ETS reference capture

ETS secure-commissioning the Jung was recorded through the logging proxy on 2026-09-28. All 523
secured frames decrypt with Busforge's own CCM and Sync (`tools/secure-capture-decode.ts`, keys
from the environment only), none is left undecrypted: the independent check that the envelope
matches ETS on an application device. The capture is kept on the development machine, not in the
repository: with the device certificate it decrypts completely, and the certificate is stored
nowhere. What ETS does, in order:

1. Sync with the **FDSK**, the serial field of the Sync request all zero.
2. Read PID 51 (security mode) of object type 17: off. Switch it on (`A_FunctionPropertyExtCommand`).
3. Write PID 56, the new **tool key**, with `A_PropertyExtValue_WriteCon`. The device answers that
   write already under the new key.
4. Sync again with the tool key; everything after runs under it.
5. Device descriptor and properties, the usual unloads, and the security object's unload
   (`A_FunctionPropertyExtCommand` on PID 5, event 4) with them.
6. The memory (`A_MemoryExtended_Write`). ETS first tried 151-byte frames, got no answer, and wrote
   everything in 22-byte frames after that.
7. The security object's bracket, after all memory and before any other object completes: PID 5
   event 1 (loading), PID 54 cleared (element 0, its count, set to 0), PID 53 (the group key table,
   one 18-byte entry: index 1, the position of 0/0/1 in the address table, and its key), PID 61 (one flag byte per group object: 74 writes,
   73 of 18 elements and one of 13, only object 253 set to `0x03`), PID 5 event 2 (loaded).
8. The application id, the other objects' load completed, and the restart.

Every secured request ETS sends there is at most 40 octets long: a 22-byte memory write and an
18-element property write come to exactly that. The exported ETS project carries the same tool key
(checked by hash) and, on the group address, the same group key the device holds. This capture is
the reference for the security object download and for Busforge's own activation (still to build).

## The honesty bar for this area

- **CCM correctness is the central risk.** It is pinned two ways: known-answer vectors from the two
  reference implementations as the unit oracle, and the live secure read as the end-to-end oracle.
  Green unit tests alone never carry the claim.
- **Sequence staleness:** always Sync before tool-access traffic, and answer a "sequence too low"
  rejection by re-syncing, never by blindly retrying.
- **Key handling:** sealed at rest, never logged, never sent to the client.
- **No silent skip.** A device that cannot be reached securely (missing key, failed Sync) is
  reported as exactly that. It is never skipped, and it is never quietly retried in the clear.
