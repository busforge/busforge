# Real catalogue fixtures

Every distinct manufacturer `ApplicationProgram` found across a real multi-manufacturer KNX
installation (13 products, 6 manufacturers), plus bench products added for ETS-capture tests, gzipped, used by `real-catalogue.test.ts` to pin the
parser and the image projection against real catalogue data: every parameter type kind, unions,
modules, bitfields, and the segment layouts real hardware uses. The set is small enough
(~1.2 MB gzipped) to cover completely rather than sample, so every product in that installation is
a regression guard.

## No personal data

These are **manufacturer product definitions only**, the same data ETS ships and that sits in
plaintext inside every `.knxproj`. They contain no project, device, group-address or other personal
data: that lives in the encrypted project instance (`0.xml`), which is never included here. Each
file was verified free of topology, device-instance and group-address content before committing.

They remain the respective manufacturers' catalogue data, included here for testing. They are not
part of what this project licenses onward.

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
bun run packages/product/test/real-catalogue.gen.ts
```

and review the diff: a changed hash is a changed parse or image output.

## Adding a device

Drop another `<id>.xml.gz` here (gzip the plaintext ApplicationProgram XML), confirm it carries no
personal data (no `<DeviceInstance>`, `<GroupAddress>` or `<Topology>` elements, and no owner
name), and run the generator. The test asserts that the fixture set and the golden stay in
lock-step, so a new fixture without a regenerated golden fails.
