# Real catalogue fixtures

One manufacturer `ApplicationProgram` per manufacturer, gzipped, used by
`real-catalogue.test.ts` to pin the parser and the image projection against real
catalogue data (7 manufacturers, every parameter type kind, unions, modules,
bitfields, segment layouts).

## No personal data

These are **manufacturer product definitions only**, the same data ETS ships and
that sits in plaintext inside every `.knxproj`. They contain no project, device,
group-address, or other personal data: that lives in the encrypted project instance
(`0.xml`), which is never included here. Each file was verified free of topology /
device-instance / group-address content before committing.

## Regenerating the golden

`golden.json` is a content snapshot (model shape, a hash of the byte-relevant image
model, and per-segment image + decode hashes). After an **intentional, reviewed**
change to the parser or image projection, regenerate it:

```
bun run packages/product/test/real-catalogue.gen.ts
```

and review the diff: a changed hash is a changed parse/image output.

## Adding a manufacturer

Drop another `<id>.xml.gz` here (gzip the plaintext ApplicationProgram XML), confirm
it carries no personal data, and run the generator. The test asserts the fixture set
and the golden stay in lock-step, so a new fixture without a regenerated golden fails.
