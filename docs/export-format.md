# The `.busforge` export format

A `.busforge` file is a portable, self-contained copy of a whole project. Importing it recreates an
equivalent, independent project on any machine, with no dependency on the original `.knxproj` and no
dependency on this installation.

It is Busforge's own format, not a KNX format. Busforge imports `.knxproj` and never re-exports it.

Design goals, in the order they drove the decisions:

- **One file** that fully restores a project.
- **Compresses well.** The bulk is application-program XML and JSON, which gzip shrinks roughly
  tenfold.
- **Openable by a script.** Anyone with a console or a few lines of code can get at the raw JSON. No
  special tool, no Busforge installation.
- **Optional encryption**, with a mechanism that stays scriptable for anyone who has the password.

## Container

The payload is always the project as a single JSON document (`busforgeExport: 1`). How that JSON is
wrapped depends on whether an export password was set.

### Without a password: a plain gzip stream

The file is simply `gzip(JSON)`. It starts with the gzip magic `1f 8b`, so any unzip tool recognises
it:

```sh
gunzip < project.busforge > project.json
gunzip -c project.busforge | jq .project.name
```

### With a password: a small AES-256-GCM container

```
offset  size  field
0       4     magic  "BF1E"  (ASCII)
4       16    salt          (scrypt)
20      12    iv            (GCM nonce)
32      16    authTag       (GCM)
48      ...   ciphertext  = AES-256-GCM( gzip(JSON) )
```

Key derivation and cipher are fixed so any implementation can reproduce them:

- **KDF:** `scrypt(password, salt, N=2^17, r=8, p=1)` to a 32-byte key. scrypt is memory-hard, which
  makes offline password guessing far more expensive than a plain hash. AES-256 is not the weak
  link; the password is, and scrypt is what makes each guess cost something.
- **Cipher:** AES-256-GCM. The 16-byte auth tag means a wrong password, or any tampering, fails
  loudly instead of yielding garbage.

Compression happens **before** encryption, never the other way around: ciphertext is
indistinguishable from random and would not compress. The order is load-bearing, not cosmetic.

A legacy plaintext `.busforge.json` (a bare JSON object, first byte `{`) is still accepted on import,
so exports taken before compression existed keep working.

### Decrypting with a script

Node.js, no dependencies:

```js
import { readFileSync } from "node:fs";
import { scryptSync, createDecipheriv } from "node:crypto";
import { gunzipSync } from "node:zlib";

const password = process.argv[3] ?? "";
const buf = readFileSync(process.argv[2]);
if (buf.subarray(0, 4).toString("ascii") !== "BF1E") throw new Error("not an encrypted .busforge");

const salt = buf.subarray(4, 20);
const iv = buf.subarray(20, 32);
const tag = buf.subarray(32, 48);
const ciphertext = buf.subarray(48);

const key = scryptSync(Buffer.from(password, "utf8"), salt, 32, { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
const decipher = createDecipheriv("aes-256-gcm", key, iv);
decipher.setAuthTag(tag);
const json = gunzipSync(Buffer.concat([decipher.update(ciphertext), decipher.final()])).toString("utf8");
process.stdout.write(json);
```

```sh
node decrypt-busforge.mjs project.busforge "my-password" | jq .project.name
```

## What travels with the project

| Included | Not included |
|---|---|
| project properties (name, referenced connection) | the import timestamp (local-only metadata) |
| the file the project was first imported from: kind, name, SHA-256 and size (not the file itself) | |
| devices, group ranges, group addresses, building structure | the derived browsable product rows, which are rebuilt from the devices on import |
| live parameter values and links | |
| the **programmed baselines** for both, so drift survives the move | |
| device module instances | |
| the referenced catalog application programs | |
| DCA baggage | |
| restore points (snapshots) | |
| the recorded bus log | |
| KNX Data Secure tool keys | |

Several fields are optional in the schema (building structure, restore points, bus log, tool keys,
source) purely so artifacts written before those features existed still import. A re-imported project
keeps the source its artifact carries, the file the project was first imported from; an artifact
without one (a project created in Busforge, or an older export) is recorded as the source itself. The project list shows the
source file's name, with its kind, size and SHA-256 on hover, so a project can be traced back to the
file. The name is the one the upload carried, without control or bidi-override characters and cut at
255 characters.

> **Tool keys ride in the clear.** A project must never be separated from the keys that let it talk
> to its own secure devices, so the archive always carries them, unsealed from this installation's
> master key. Their only protection is the container password. The export dialog therefore warns
> before writing an unencrypted archive for a project that has secure devices. On import the keys are
> re-sealed under the importing installation's master key. See [knx-secure.md](knx-secure.md).

## Importing

The import dialog accepts a `.busforge` file as readily as a `.knxproj`. On selecting a file it is
**analysed** first: the server parses the metadata and persists nothing, and the dialog shows a
preview card (name, device / group-address / restore-point counts, date) rendered with the same
component as a project card. Confirming performs the real import, which recreates the project under a
fresh id and restores its catalog entries and baggage in one transaction. An encrypted file needs its
password at the analyse step.

The importer is the exact inverse of the serializer. Two things it has to do rather than copy:

- **Remap autoincrementing ids.** Group ranges, group addresses and spaces carry globally
  autoincrementing ids. The export orders ranges so a parent always precedes its children, so a
  single forward pass remaps them and rewrites every reference.
- **Check the version.** `busforgeExport` must equal the importer's version. A newer or malformed
  artifact is rejected with a coded error, never partially applied.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/projects/:id/export` | write the archive (POST so the password rides in the body) |
| POST | `/api/projects/analyze` | inspect an uploaded file, persist nothing |
| POST | `/api/projects/import-busforge` | import the archive as a new project |
