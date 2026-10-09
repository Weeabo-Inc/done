<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="doc/assets/mokou-logo-dark.svg">
    <img src="doc/assets/mokou-logo.svg" alt="Mokou" width="320">
  </picture>
</p>

# Mokou

**A Frictionless & Modern TypeScript Runtime.**

**Mokou** is a hard fork of [Deno](https://github.com/denoland/deno) that aims
to finish what Deno started: a secure, native JavaScript and TypeScript runtime
that is useful without anything else installed. Mokou was previously developed
under the working name Done.

It forks Deno 2.9.7 and keeps everything that made Deno good: V8, Rust, Tokio,
secure-by-default permissions, first-class TypeScript and web-standard APIs. Our
direction is different from upstream's. Deno has been moving back toward the
Node.js ecosystem. Mokou moves the other way.

> **Status:** early. The binary is still called `deno` and behaves like Deno
> 2.9.7. Everything below describes where we are going. See
> [ROADMAP.md](ROADMAP.md) for the plan and
> [doc/mokou-audit.md](doc/mokou-audit.md) for what the fork starts with.

## Goals

1. **Deno-first experience.** The native `Deno.*` APIs, web standards and
   TypeScript are the default way to do things. Node compatibility is something
   you can turn on, not the default answer.
2. **A standard library built into the runtime.** Common tasks such as SQL,
   routing, password hashing, assertions, parsing and hashing should need no
   dependencies at all.
3. **Performance and capabilities.** Measure everything, publish the numbers,
   and keep closing the gaps.
4. **Native APIs that rival the competition.** Anything a competing runtime
   ships built-in, Mokou should ship built-in too, and do it better.
5. **Products on top of the runtime.** Desktop apps (`deno desktop` already
   exists in this tree) and a first-party, Fresh-style web framework.

## Principles

- **Native before polyfill.** A new capability lands as a `Deno.*` API first.
  Code under `node:` is for compatibility, not for new features.
- **Zero-dependency by default.** If most apps need it, it belongs in the
  runtime.
- **Secure by default.** Every new API goes through the permission system.
- **Measured, not claimed.** Performance work comes with a benchmark in
  `tests/bench`.
- **Hard fork.** We do not track upstream. We take upstream fixes by hand when
  they are worth it, especially security and V8 updates.

## Building from source

Mokou builds exactly like Deno. Install the prerequisites listed in
[`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md#building-from-source), then:

```sh
git clone --recurse-submodules https://github.com/weeabo-inc/done.git
cd done
cargo build --bin deno
./target/debug/deno eval 'console.log("Hello from Mokou")'
```

`deno upgrade` installs releases from
[weeabo-inc/done](https://github.com/weeabo-inc/done/releases), never from
upstream Deno. Until Mokou publishes its first release, it reports that no
release is available. Canary builds are not published yet.

## Your first program

```ts
Deno.serve((_req: Request) => new Response("Hello, world!"));
```

```sh
./target/debug/deno run --allow-net server.ts
```

## Contributing

Read [ROADMAP.md](ROADMAP.md) to find a milestone, and see
[CLAUDE.md](CLAUDE.md) for build, test and lint commands. All work goes through
pull requests against `main`. Run `tools/format.js` and `tools/lint.js` before
you commit.

## License

MIT. Mokou is a derivative of Deno, Copyright 2018-2026 the Deno authors. See
[LICENSE.md](LICENSE.md).
