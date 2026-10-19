# Real catalogue fixtures

The fixtures themselves are not in this repository: they are the `catalogue/` directory of the
private corpus ([`docs/testing.md`](../../../../../docs/testing.md#the-private-corpus)). This
directory keeps only `golden.json`, their per-fixture counts and content hashes.

16 manufacturer `ApplicationProgram`s from 9 manufacturers (M-0002, M-0004, M-0008, M-0048, M-0081,
M-0083, M-0085, M-008E, M-0162), gzipped: the applications the corpus's ETS captures and the device tests
refer to. `real-catalogue.test.ts` uses them to pin the parser and the image projection
against real catalogue data: every parameter type kind, unions, modules, bitfields, and the segment
layouts real hardware uses. The set is small enough (~1.2 MB gzipped) to cover completely rather
than sample, so every application in it is a regression guard.

## No personal data

These are **manufacturer product definitions only**, the same data ETS ships and that sits in
plaintext inside every `.knxproj`. They contain no project, device, group-address or other personal
data: that lives in the encrypted project instance (`0.xml`), which is never included here. Each
file was verified free of topology, device-instance and group-address content before committing.

They remain the respective manufacturers' catalogue data, which is why they stay in the private
corpus and out of this repository.

## What this proves

This golden master is a **stability** check. It proves the output is unchanged since the last
reviewed regeneration, not that it is correct. See
[`docs/verification.md`](../../../../../docs/verification.md) for the full model and
[`docs/testing.md`](../../../../../docs/testing.md) for how the levels stack.

## Regenerating the golden

`golden.json` is a content snapshot (model shape, a hash of the byte-relevant image model, and
per-segment image + decode hashes). After an **intentional, reviewed** change to the parser or the
image projection, regenerate it:

```
BUSFORGE_CORPUS=/absolute/path/to/busforge-corpus bun run packages/product/test/real-catalogue.gen.ts
```

and review the diff: a changed hash is a changed parse or image output.

## Adding a device

Drop another `<id>.xml.gz` into the corpus's `catalogue/` (gzip the plaintext ApplicationProgram
XML), confirm it carries no personal data (no `<DeviceInstance>`, `<GroupAddress>` or `<Topology>`
elements, and no owner name), add it to `CORPUS_FILES` in `tools/corpus.ts`, and run the generator. The test asserts that the fixture set and the golden stay in
lock-step, so a new fixture without a regenerated golden fails.
