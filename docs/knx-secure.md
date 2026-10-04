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

Every sender numbers its secured frames with a 48-bit counter, and every receiver rejects a frame
whose sequence is not strictly greater than the last it accepted from that sender. A tool's counter
(ours, for tool access) and a device's own sending counter are separate.

**The project file's `SequenceNumber` is the device's own sending counter, not the tool's.** ETS sets
it to the last sequence it saw the device send, answers in a tool-access session included
([findings.md](findings.md) §22), and so does Busforge (see [Senders](#senders-of-a-secured-group-address)).
That rests on a device answering tool access from the counter it sends group telegrams from, which is
shown for the Jung 400021SE only (PID 59 of its security object, its sending counter, read `0x011028`;
the last answer of its next session carried `0x011030`); a device with a separate tool-answer counter
would get the wrong value, in ETS as in Busforge. Our own tool-access counter is never taken from storage; it is
obtained live:

1. At session start, send an S-A_Sync_Req: the payload is a random 48-bit challenge, the target's
   6-byte serial goes in the body and in the AAD, and the sequence slot carries the current counter.
2. The device replies with an S-A_Sync_Rsp whose sequence slot is `random XOR challenge`; recover
   `random` and use it as the sequence input for the blocks. The 12-byte payload is
   `deviceNextSeq(6) || ourNextSeq(6)`.
3. Adopt `ourNextSeq` and send every further tool-access frame with a strictly increasing value.

This repairs a stale or unknown counter in one round trip, and it is the first thing a secure session
does. A failed Sync is a coded refusal (`SECURE_SYNC_FAILED`), never a blind retry.

## The key store

Tool keys live in a first-class Busforge store, not in an ETS keyring (one can be exported, see [Keyring export](#keyring-export)).

**Where they come from.** Inside the password-protected project file (the same `0.xml` Busforge
already decrypts to parse), every secure device carries a `<Security>` element with a base64 16-byte
tool key and a sequence number. No `.knxkeys` import and no keyring parser are needed. The device's
serial number, needed for the Sync request, comes from the same device instance.

Three paths populate it: the project import (`import`), the activation from a device certificate
(`pending` until confirmed, then `provisioned`, see below), and a key deposited by hand (`manual`).

**A key deposited by hand** (device menu, `PUT .../devices/:deviceId/tool-key`) is for a device
another tool activated. It is stored only after the device answered a secure Sync under it, through
the same identification as `secure-identify`; a device does not answer a Sync under a key it does not
hold, so an unanswered or unauthenticated Sync refuses the deposit (`SECURE_SYNC_NO_RESPONSE`,
`SECURE_SYNC_FAILED`, `SECURE_MODE_OFF`) and the key on file stays as it was. A device that answers
but states its security mode is off was reached under its factory key, which is not a tool key
(`TOOL_KEY_SECURITY_MODE_OFF`). Nothing is written to the device. The Sync carries the device's serial,
which a device in secure mode does not give a plain read: it comes from the key or certificate on file,
else from the request (`TOOL_KEY_SERIAL_MISSING` without one, `TOOL_KEY_SERIAL_MISMATCH` when it
contradicts the one on file or the one the device reports inside the session; a wrong serial on file
can only be corrected by a new import). The last sequence the device sent in that session, when it
sent one, is recorded with the key. Depositing the key already on file keeps its source (a pending key
becomes provisioned), so a key Busforge provisioned stays counted as its own; a different key replaces
it, and the old one, dead on the device, no longer guards the project against deletion.

| Column | Notes |
|---|---|
| `project_id`, `device_id` | owner, matching the parser's device id |
| `tool_key` | 16-byte AES-128 key, **sealed at rest** |
| `serial_number` | 6-byte device serial, needed for the Sync request |
| `seq_group` | the project's group/data counter, kept for future secure group communication; **not** the tool-access counter |
| `source` | `import`, `manual`, `pending` or `provisioned` |

A key that is not 16 bytes, or a serial that is not 6, is refused (`SECURE_KEY_BAD`) rather than
stored. Tool keys are never returned to the client and never logged.

**Group keys** come from the same file: a secured group address carries its 16-byte key in the
`Key` attribute of its `<GroupAddress>`, or Busforge generates one for an address it secures (source
`generated`, see [Group address security mode](#group-address-security-mode)). They live in
`group_keys` (`project_id`, `raw`, `key`, `source`), sealed like the tool keys, and are parsed apart from the address model so a key never
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

### Keyring export

The export dialog also writes the project's keys as an ETS keyring (`.knxkeys`,
`POST /api/projects/:id/keyring`): the format ETS 5/6 exports and xknx (Home Assistant) and Calimero
read. Every key is AES-128-CBC encrypted under `PBKDF2-HMAC-SHA256(password, "1.keyring.ets.knx.org",
65536, 16)` with the first 16 bytes of `SHA-256(Created)` as IV, and the file is signed with a hash over
its element tree and that key ([packages/project/src/keyring.ts](../packages/project/src/keyring.ts),
checked against real ETS exports from xknx's tests). A password is required and must be printable
ASCII: Calimero reads it as ASCII, xknx as UTF-8, so only ASCII means the same key to both.

What goes in:

| Element | From | For |
|---|---|---|
| `Device` with `ToolKey`, `SequenceNumber`, `SerialNumber` | the key store (the sequence is the device's own, last seen) | xknx, Calimero |
| `Device` with `SerialNumber` and `FDSK` | stored device certificates | ETS, Calimero |
| `GroupAddresses/Group` with `Key` | the group keys | xknx, Calimero |
| `Interface` with `Group Address Senders` | each sender assigned to a secured address, with the other assigned senders and every device with a tool key linked there | xknx (as accepted senders), Calimero |

Only ETS 6.4.1 and xknx 3.20.0 have read an exported file; Calimero is listed from its reader's source
(`io.calimero.secure.Keyring`), not from a run.

**ETS takes only the certificates.** ETS 6.4.1 (*Projekt > Sicherheit > Schlüsselbund importieren*)
imports a Busforge keyring, signature and all, but reports a file without certificates as "contains no
device certificates" and does not use the tool keys: a project holding only the keyring's key read the
activated Jung 400021SE plainly (mask `FFFF`), also with the certificate assigned to it by serial
([findings.md](findings.md#29-ets-imports-only-the-certificates-from-a-keyring)). So ETS takes over a
device Busforge activated only after a master reset, from the certificate. The dialog says so.

**The interface sender lists lean wide.** A software receiver only accepts a secured telegram from an
address it lists, so every keyed device linked to the address is listed, whether or not one of its
objects transmits there. That is more than a device's own security table (PID 54) carries. The lists follow ETS's meaning, the others that send to that
interface, so a sender is in a list only when another sender shares its address: a project whose only
assigned sender is Busforge's own address lists that address nowhere, and xknx then drops its secured
telegrams (it builds its accepted senders from the lists and the devices).

Before the file leaves, the server reads it back with the same reader that checks ETS's files; a
signature or key that does not come back the same refuses the download (`KEYRING_SELF_CHECK_FAILED`).
A project without keys or certificates is refused (`KEYRING_EMPTY`), not exported empty.

## Using it

There is no secure-specific code path in the operations. `withDeviceSession` takes optional
credentials, and read-back, parameter flash, group-address flash and full download all pass the
device's stored key, so a device with a key on file is driven securely automatically. A device
recognised as secure gets a badge in the device list.

One dedicated endpoint exists, `secure-identify`: it opens a session with no mask gate (the
identification is what learns the mask) and returns the device descriptor, the serial and the
device's security mode (PID 51 of the security interface object, through
`A_FunctionPropertyExtState_Read`). It is reachable over the API and has no button in the UI today.

- **With a tool key on file** the session is secured (`secure: true`). This is the proof that the
  envelope works against a device that answers `0xFFFF` to everything plain.
- **Without one** it reads plainly (`secure: false`), exactly as ETS probes PID 51 in a plain download.
- **A stored key whose Sync gets no answer** is checked plainly once: a device that then states its
  mode is off is not activated (factory state, for example after a master reset) and is refused as
  `SECURE_MODE_OFF`; anything else leaves the `SECURE_SYNC_NO_RESPONSE`, where a wrong key and a
  device that ignores the request look alike.

The mode is reported as the device states it, never guessed:

| `securityMode.state` | Device answer | Seen on (bench, 2026-09-30) |
|---|---|---|
| `on` | return code 0, mode 1 | Jung 400021SE, secured session |
| `off` | return code 0, mode 0 | GVS AMMA with Secure, plain, never activated |
| `denied` | return code `0xFC` (access denied) | Jung 400021SE in secure mode, plain read (raw probe) |
| `unreadable` | no answer, another service, or a closed connection | ABB US/U 4.2 (silent), MDT BE-02001.02 (closes the connection) |

A device in secure mode also answers a plain serial read with no element; the serial is then `null`,
not empty.

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

**Individual-address assignment goes out plain.** It is a broadcast and cannot go through a session.
It is not refused for a secure device: a master reset clears the address with the key, and the
assignment is proven by talking to the device on its new address. On a device still in secure mode
the plain programming-mode reset afterwards is ignored (the Jung, 2026-09-29), which the assignment
reports; switching it off through the secured session works. The Jung also ignores a master reset
(A_Restart with erase code 0x02 or 0x07) sent through its secured session: no answer, nothing
reset. Its only way back to the factory key is the physical reset.

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
| PID 54 | the security individual address table: element 0 (its count) set to 0, then from element 1 one 8-byte entry per assigned sender (see [Senders](#senders-of-a-secured-group-address)), its individual address then a last sequence of 0, ascending |
| PID 53 | the group key table: one 18-byte entry per secured address the device is linked to, the address's 1-based position in the device's address table then the key, ascending |
| PID 61 | one flag byte per group object from object 1: `0x03` (authentication and confidentiality) for an object on a secured address, `0x00` otherwise |

An object linked to both secured and plain addresses is refused (`SECURE_LINK_MIXED`): it has one
flag for all its links. The dry-run diff and the verify both read the object back (the device
returns its group keys only inside the session). Other memory models refuse a secure device's GA
flash and full download (`SECURE_TABLES_UNSUPPORTED`).

**Shown on the Jung, 2026-09-28:** a dry-run GA flash found the object ETS had loaded equal to the one
Busforge builds from the project; Busforge's secured full download then wrote it (all 158
security-object frames, requests and answers, byte-identical to ETS's decrypted capture), restarted
the device through the session and verified tables, parameter CRC and security object after the
restart. The first attempt failed honestly with `RESTART_IGNORED`: the restart went out plain, which
a device in secure mode ignores. A GA flash that linked a second object to the secured address set
its flag on the device and verified; its revert restored ETS's load. **Not shown:** the secured group
address working on the bus. It has since been shown both ways: the Jung's own telegram on 0/0/1
decrypted by the monitor (see [Secured group telegrams in the monitor](#secured-group-telegrams-in-the-monitor)),
and a secured read Busforge sent answered by the Jung (see [Senders](#senders-of-a-secured-group-address)).

### Senders of a secured group address

A receiver drops a secured group telegram from a sender its security individual address table (PID
54) does not list ([findings §20](findings.md#20-a-secure-device-answers-no-secured-group-read-from-a-sender-it-does-not-list)).
ETS lists the individual addresses assigned as senders of a secured address the device is linked
to: in ETS 6 a tunnelling channel of an IP interface or router, with the address dragged onto it in
the topology. The project file records that as `<BusInterface RefId><Connectors><Connector
GroupAddressRefId>` under the interface's DeviceInstance; the channel's address is the device's own at
the BusInterface's `AddressIndex` 0 (declared by its application program), otherwise its
`AdditionalAddresses` entry at that index.

Busforge imports these assignments from the `.knxproj` and lets the group-address overlay add and
remove them (`group_senders`, `apps/server/src/db/groupSenders.ts`). A secure device's GA flash and
full download load them into PID 54, once each, ascending, never the device itself (shown for the GA
flash; the full download builds the same object, but has not written a non-empty table on hardware).
A sender's sequence in the table is the device's own receive state and is not compared by the dry run
or the verify. A group key entry for an address-table index beyond the address table refers to nothing and is
left out of the comparison: a load writes the key table from element 1 without shrinking it, as ETS's
does, so a device whose address table lost entries keeps such keys. An assignment whose interface address cannot be resolved is counted in the import
result, never guessed.

Refused rather than guessed:

- **Another device on a secured address whose sequence number the project does not hold, or whose
  only objects there answer reads or transmit with the address as a further address**
  (`SECURE_SENDERS_UNPROVEN`): whether ETS lists the latter two is not shown. One whose objects there
  only receive (write flag, no read or transmit flag) is not listed, as ETS does not list it
  ([findings.md](findings.md) §22). Another
  secured device with a transmitting object on the address is listed like ETS does it, with the
  sequence the key store holds for it ([findings.md](findings.md) §22): the project's at import,
  replaced after every server session with that device (read, flash, identify, activation) by the
  last sequence the device was seen to send in it, as ETS does, so an activated device has one after
  its activation. Only the project the session ran under is updated; the smoke runner's own sessions
  record nothing. The master reset of 2026-09-30 did not rewind the Jung 400021SE's counter
  (`0x010C40` in the ETS session before it, `0x011028` after it and one activation and download). "Transmitting" means the communication and transmit
  flags on an object whose first (sending) address this is, in the device's active configuration. An
  object that only answers reads there (read flag, no transmit flag) sends secured responses too; a
  device with no other transmitting object there is refused. A linked object
  that is hidden by its parameters, or does not resolve in its application program, is refused as
  well, never left out; a link of a device the project no longer holds is ignored.
- **A device without a tool key linked to a secured address** (`SECURE_GA_WITHOUT_DEVICE_KEY`): a
  plain device, or a secure one ETS never commissioned (imported without its key, counted in the
  import result); writing its tables would put the address on it without key or flag. ETS never does
  that either: it turns the address plain for every device on it ("Automatisch") or refuses the link
  ("Erzwungen an"), [findings.md](findings.md) §22. Busforge does the same at link time
  ([Group address security mode](#group-address-security-mode)); this refusal still catches a plain
  device on a secured address that arrived another way (a reverted link, a restored snapshot, a
  replaced product).
- **An address whose mode and key disagree** (`SECURE_GA_FORCED_WITHOUT_KEY`, `SECURE_GA_OFF_WITH_KEY`):
  "Erzwungen an" without a key, or "Erzwungen aus" with one. A snapshot restores the mode but never a
  key, so this can arise. Saving the address with the same mode again brings the key in line.

Sending: the monitor's send panel (and `POST /api/projects/:id/bus/group`) hands a GroupValueWrite or
GroupValueRead to the interface over the monitor connection. The interface's confirmation is not
read, so the telegram is not recorded in the monitor as if the bus had carried it; the devices'
answers are. The value's form follows the address's datapoint type (DPT 1-3 in the six APCI bits,
others after it; without a type, a value that fits both forms is refused). On a secured address it
is encrypted with the address's key (S-A_Data, SCF 0x10) at a sequence persisted per sender
(`send_sequences`, never below the clock-derived tool-sequence start), and only if the connection's
own address is one of the address's senders (`SECURE_SENDER_NOT_LISTED` otherwise: the device would
drop it silently). A secured telegram longer than a standard frame (anything but a 6-bit value) is
refused (`SECURE_VALUE_TOO_LONG`): extended frames are not implemented on this path. Another tool
sending from the same address keeps its own counter; if that counter is ahead of Busforge's, the
receivers drop Busforge's telegrams without a word.

**Shown on the Jung, 2026-09-29:** ETS 6.4.1 with 1.1.100 assigned to 0/0/1 loaded PID 54 with the
single entry `1164 000000000000` ([findings §22](findings.md#22-how-ets-loads-a-secured-sender-into-a-receivers-pid-54-and-what-it-buys));
Busforge imported that project and its GA flash dry run found the Jung `unchanged`. With the sender
removed in Busforge, a GA flash emptied PID 54 (verified), the Jung then ignored a secured read from
1.1.100, and Busforge refused to send one. Added back and flashed (verified, dry run `unchanged` against
ETS's load again), a secured GroupValueRead sent from the monitor's send panel drew the Jung's secured
GroupValueResponse, both decrypted in the monitor.

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

- **A secure IP interface may have no parameter image.** The MDT IP Interface Secure (MV-0012) is a
  `DefaultProcedure` device with **zero parameter segments**, configured through properties rather than a parameter image, so a parameter
  flash has nothing to write. Supporting it means building a property-based configuration path, a
  separate unimplemented capability, not "adding DefaultProcedure". The MDT IP Interface/Router
  (MV-07B0) does have a System B parameter segment, but it is the house's gateway (next point), and
  its tunnelling entries are not modeled ([owned-products.md](owned-products.md)).
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

### Group address security mode

Every group address carries ETS's Data Secure mode, `group_addresses.security`:

| Mode | ETS | In the `.knxproj` | Key |
|---|---|---|---|
| `auto` | Automatisch | no `Security` attribute | while every linked device is secure |
| `on` | Erzwungen an | `Security="On"` | always |
| `off` | Erzwungen aus | `Security="Off"`, no `Key` | never |

Read from three ETS 6.4.1 exports of the same address ([findings.md](findings.md) §22). An unknown
value refuses the import. The mode travels with snapshots and `.busforge` exports; it is edited in the
group-address dialog (`PATCH /api/projects/:id/group-addresses/:raw` with `security`).

Whether an address is secured is whether the project holds a key for it. The rules (`gaSecurity.ts`),
where a secure device is one the project holds a tool key for:

- **A secure device linked to an `auto` address without a key**, with every device on it secure:
  Busforge generates a random 16-byte key (source `generated`, sealed like the rest). ETS was seen doing
  this for a new address; Busforge applies it to any `auto` address a link is added to.
- **A device without a tool key linked to a secured `auto` address**: refused with
  `SECURE_GA_TURNS_PLAIN` (409) until the user confirms (`allowPlain`); then the key is deleted and the
  address is plain for every device on it, as ETS warns before doing. The key is gone for good: undoing
  the link, reverting the device or restoring a snapshot does not bring it back, and securing the
  address again makes a new one.
- **A device without a tool key linked to an `on` address**: refused (`SECURE_GA_FORCED`), as ETS refuses
  it. Setting `on` while such a device is linked is refused the same way.
- **Setting `off`** deletes the key; **setting `on`** makes one if there is none; **setting `auto`** makes
  one if devices are linked and all are secure.

A new or deleted key changes the security object of every secure device on the address; each of them
shows it ([below](#security-object-baseline)). Deleting an address keeps its key, as before, so an address created again at the same raw value is
secured with it.

**Shown on the GVS AMMA 1.1.203, 2026-10-02** (bench, API on an isolated server, project imported from
the ETS export): a new 0/0/2 linked to output 1's switching object got a generated key; the GA flash
(23 bytes) verified; with 1.1.100 added as a sender of 0/0/2, a secured GroupValueWrite `01` on 0/0/2
switched the output on and its status object sent a secured `01` on 0/0/1, then `00` the same way.
Restored by linking the object back to 0/0/1 and a second verified GA flash (7 bytes). The key
element for index 2 stays in the device's PID 53, as ETS leaves it. The plain-link confirmation and
the mode dialog were driven in the browser, with no bus write.

### Security object baseline

A change to a device's security object often comes from somewhere else: a key generated or deleted for
an address, another device linking a transmitting object to it or changing its address, a sender
assigned in the group-address dialog, a snapshot restore. None of these touches the device's own
parameters or links, so the parameter and link baselines cannot show it. ETS shows such a receiver as
unchanged; Busforge flags it.

Each secure device keeps the fingerprint of the security object last verified on it
(`devices.security_base`, `deviceservice.ts` `securityFingerprint`): a hash of the group key table
(keys under their address-table indices), the sender table with its sequence numbers zeroed, and the
numbers of the secured objects, built by the same `buildSecurityObject` call and inputs the GA flash
and full download load. Sequence numbers are left out because they move with every session.

- **Recorded** by a verified GA flash, full download or structural flash, from the inputs that write
  used, and by a GA flash that finds the device already holding them (it compares the key table, the
  object flags and the senders it reads from the device); an unverified write and a dry run record
  nothing. A `.busforge` export carries it; a product replacement clears it.
- **Not adopted at an ETS import.** ETS does not flag a receiver whose senders changed, so a device in an
  ETS project may hold a stale object while the project looks programmed. Every secure device starts as
  unknown, and a GA flash settles it against the device (writing only if it differs).
- **Compared** whenever the project is read. A difference shows as **Security changed** on the device;
  no recorded fingerprint, or an object that cannot be decided for the project as it stands (for
  instance `SECURE_SENDERS_UNPROVEN`), shows as **Security unknown**. Neither is undone by reverting the
  device; a GA flash of it clears both.
- **Left out:** a device never programmed (flagged as such already), and a secure device of a memory
  model that does not load the security object: Busforge refuses its group tables, so nothing it could
  write would settle a flag.

Not shown on hardware: the flag is computed from the project, and was driven in route tests (a sender
assigned, a key replaced, a peer linking its transmitting object and changing its address).

### Activation from the device certificate

A factory-fresh secure device, or one after a master reset, opens only under its **factory default
setup key (FDSK)**, printed on it as a 36-character certificate (and QR code): RFC 4648 base32 of the
6-byte serial, the 16-byte FDSK and a CRC-4 nibble (`decodeCertificate` in
`packages/knx/src/certificate.ts`). A certificate that does not decode or whose checksum fails is
refused (`CERTIFICATE_INVALID`); one whose serial differs from the tool key's on file is refused
(`CERTIFICATE_SERIAL_MISMATCH`). The decoder was checked once against the Jung's real label: the
serial matched the device and the FDSK decrypted ETS's activation of it.

`PUT .../certificate` stores the FDSK sealed (`device_certificates`, exported like the tool keys; it
is kept after activation, since a master reset returns the device to it). `POST .../secure-activate`
then does what ETS does (`activateSecureDevice` in `packages/knx/src/activation.ts`):

1. If a tool key is on file and the device opens under it, it is already active: nothing is written.
2. Otherwise a session under the FDSK, the Sync's serial field zeroed as ETS sends it. A device that
   opens under neither key is offline, busy, or holds a key Busforge does not know
   (`ACTIVATION_NO_KEY_ACCEPTED`). Inside the session the device's own serial must equal the
   certificate's (`CERTIFICATE_SERIAL_MISMATCH`): the CRC-4 does not catch every typo, and the
   factory Sync carries no serial.
3. The tool key is **persisted before it is written**: the key on file if there is one (so a repeated
   run converges, and a key imported from ETS keeps the ETS project valid), a new random one
   otherwise, stored as `pending` and marked `provisioned` once confirmed.
4. Security mode on (PID 51), the tool key written (PID 56). The device answers that write already
   under the new key, so the session switches keys between framing the write and its answer, and the
   write is never retried: a retry would go out under a key the device may not hold.
5. A new session under the new key must open and report security mode on (`ACTIVATION_UNCONFIRMED`
   otherwise, the key stays on file for the next run).

**Shown on the Jung, 2026-09-29**, after a physical master reset (bus voltage on with the
programming button held until the LED blinks slowly, release, then hold it again for 5 s until it
blinks fast; it came back as 15.15.255 in programming mode): address 1.1.204 assigned, activation
from the certificate (the key imported from ETS written back, so the ETS project stays valid), its
security-mode read, switch-on and tool-key write byte-identical to ETS's, a secured full download
verified after its restart, and a read-back with no drift and no gap. Two things only the device
showed, both fixed: a Sync that went unanswered has to be closed with a T_Disconnect before the next
key is tried, and the switch-on takes ETS's three octets (reserved, service 0, mode 1); two octets
are refused with `0xF2`. The Sync sequence now starts at a clock, as ETS's does
([findings.md](findings.md) §19).

An interruption at any point leaves the device opening under exactly one of the two keys Busforge
holds. A device that refuses the key write answers under its old key, which the rekeyed session
cannot read, so that refusal shows as `SECURE_ANSWER_REJECTED` rather than by its return code; a
rerun converges through the FDSK. A project holding a key only Busforge has (`pending` or
`provisioned`) is not deleted without `keysExported=1` (`PROJECT_HOLDS_OWN_KEYS`), since deleting it
locks the device out until a master reset.

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

## Secured group telegrams in the monitor

The bus monitor opens a secured group telegram (A_Data_Secure on a group address) with the key the
imported project holds for that address, and records how it was received:

| State | Meaning | Value shown |
|---|---|---|
| decrypted | the MAC verified with the address's key; the inner GroupValueRead/Response/Write is shown | yes |
| no key | the project holds no key for this address | no |
| authentication failed | a key is held, the MAC does not verify (wrong key, altered frame) | no |
| sequence already seen | the MAC verifies, but the sequence is not above the last one accepted from that sender: a replay, or a link-layer repetition of a frame already shown (the monitor does not see the repeat flag, so it cannot tell them apart) | no |
| not decodable | a secured frame other than S-A_Data with authentication and confidentiality (tool access, auth-only, system broadcast, Sync) | no |

Only a decrypted telegram carries a service and a value; every other state is stored with an empty
value, so nothing downstream (the web monitor, an export) can decode ciphertext as if it were one.
Telegrams recorded before the monitor knew these states have no state and the service `Unknown`
with the ciphertext as payload; the web monitor shows any `Unknown` telegram as raw octets, never as
a DPT value.
The state is stored with the telegram and travels in the `.busforge` export.

Replay is judged per sender against the last sequence the monitor accepted from it **in the current
monitor connection**. The history starts empty at every connect, so a frame replayed across a
reconnect is shown as decrypted. One sequence per sender covers all its group addresses, as in the
receiving device.

The cipher is covered by xknx's group-address known-answer vectors (`packages/knx/test/secure.test.ts`).
**Shown on the Jung, 2026-09-29:** closing its K1 contact (parameterized to toggle on press, nothing
on release) sent a secured GroupValueWrite on 0/0/1, encrypted on the wire (the logging proxy's
capture shows only SCF, sequence, ciphertext and MAC). With the ETS project connected the monitor
showed it as decrypted, "On", with the lock in the web monitor. With a project that holds no key for
0/0/1 connected instead, the next two closings were recorded as "no key", without a value. Opened
with the project's key, the three captured frames read On, Off, On at sequences 5604, 5605, 5606,
the toggle the parameters describe. Not compared with an independent decoder (the ETS group
monitor). The Jung answers no GroupValueRead from Busforge, plain or secured (see
[findings §20](findings.md#20-a-secure-device-answers-no-secured-group-read-from-a-sender-it-does-not-list)),
so its own contact is the only stimulus.

