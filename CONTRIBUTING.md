# Contributing to Busforge

Thank you for wanting to help. Busforge writes bytes into real devices in real buildings, so the
bar for a change is that it is honest about what it does. This page says how to get a change in.

## Reports first

A device that works, a device that does not, a wrong value on the screen: open an
[issue](https://github.com/busforge/busforge/issues). The app opens a prefilled one from a
device's menu (*Report on GitHub*). [docs/reporting.md](docs/reporting.md) says what stays out of
a public issue (keys, project files, addresses). A report from a device nobody has tested is as
valuable as code.

For a larger change, open an issue before you write it, so we can agree on the approach.

## Pull requests

1. Fork the repository and branch from `main`.
2. Set up the project as described in [docs/development.md](docs/development.md).
3. Make the change, with tests, and update the docs it affects in the same pull request.
4. Run the gate and make sure it is green:

   ```bash
   bun install
   bun run check   # typecheck + lint + tests + build, every workspace
   ```

   Some tests need a private corpus of manufacturer data and are skipped without it; the check's
   last line names them. A green run without the corpus is the gate for a contribution, the
   maintainers also run it with the corpus ([docs/testing.md](docs/testing.md#the-private-corpus)).

5. Open the pull request against `main`.

### The CLA

The first time you open a pull request, a bot asks you to agree to the
[Contributor License Agreement](CLA.md), once, by posting a comment. It is the short agreement
n8n uses: you let the author license your contribution on any terms.

Why: Busforge is free under the AGPL for everyone, and it is also sold under a commercial license
to companies that want to build it into a closed product. Without the CLA, code from outside could
only ever be shipped under the AGPL, and that second path would close. The sole reason for the CLA
is that dual licensing, not a later move to a license that is not open source
([CLA.md](CLA.md#why-it-exists)).

## What a change has to respect

- **Refuse, never pretend.** A device family, mask or case the code does not handle makes the code
  say so and stop, with an error the UI can explain. No silent fallback, no plausible default, no
  swallowed error, no `TODO` left behind: an unhandled case that looks handled will be trusted, and
  then a device in someone's house is misconfigured.
- **Claims follow evidence.** Green tests prove that the code is stable and the arithmetic is
  right, not that a device is programmed correctly. Only a read-back from a real device supports
  a claim about hardware; [docs/status.md](docs/status.md) and
  [docs/evidence-contract.md](docs/evidence-contract.md) say what counts. If you could not test on
  hardware, say so in the pull request.
- **Docs state what holds today.** They are part of the change, in English, and describe the
  current state, not its history.
- **Commit messages say what the software now does**, in the imperative: *"Refuse a write that
  would leave the com-object table stale"*, not *"Update flash.ts"*.

## License

Busforge is licensed under the [GNU AGPL-3.0-or-later](LICENSE) ([NOTICE](NOTICE)); contributions
need the [CLA](CLA.md) above.
