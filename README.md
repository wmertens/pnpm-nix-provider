# @pnpm/nix-provider

An external package provider for pnpm that materializes npm packages as Nix
store paths. pnpm sends it the resolved dependency graph; the provider builds
one derivation per package (or per dependency cycle group), returns the
resulting store paths, and pnpm symlinks `node_modules` straight into
`/nix/store`.

Packages are input-addressed: the same lockfile deterministically reaches the
same store paths, unchanged subtrees stay cached across updates, and store
paths can be shared through Nix binary caches. A single indirect gc root per
project protects the whole closure.

## Usage

```yaml
# pnpm-workspace.yaml
packageProvider: /path/to/pnpm-nix-provider
```

Requires `nix-build` on PATH and a resolvable `<nixpkgs>` (override per
request, see below). When pointing straight at a checkout of this repo, use
the absolute path of `src/cli.js` (it must be executable).

## Protocol (version 1)

The provider is an executable. pnpm writes one JSON request to stdin, the
provider writes one JSON response to stdout and exits 0. Any non-zero exit
aborts the install. stderr is passed through to the user (Nix build output).

Request:

```jsonc
{
  "protocol": 1,
  "gcRootDir": "/abs/project/node_modules/.pnpm", // optional; where the indirect gc root symlink goes
  "nixpkgs": "/path/or/url",                      // optional; overrides <nixpkgs>
  "nodes": {
    "<depPath>": {
      "name": "foo",
      "version": "1.2.3",
      "tarball": "https://registry.npmjs.org/foo/-/foo-1.2.3.tgz",
      "integrity": "sha512-…",                    // SRI, used verbatim as the fixed-output hash
      "deps": { "<alias>": { "depPath": "<other depPath>", "name": "bar" } },
      "engine": "linux;x64;node22",               // optional platform key folded into the derivation
      "patch": { "content": "diff --git …", "hash": "…" } // optional git-style patch, applied after unpack
    }
  }
}
```

Patches are deterministic, so the patch content is simply another derivation
input: a changed patch yields a new store path, an unchanged one hits the
cache. Patches are applied with `git apply` inside the sandbox before
dependency links are created and scripts run.

`nodes` must be a closed graph: every `deps[].depPath` must itself be a key of
`nodes`. Keys are opaque identifiers to the provider (pnpm uses depPaths, which
already encode resolved peer dependencies).

Response:

```jsonc
{ "protocol": 1, "paths": { "<depPath>": "/nix/store/…" } }
```

`paths[depPath] + "/node_modules/" + name` is the package directory. Each
returned directory's `node_modules` also contains the package's dependencies
as sibling symlinks, so Node module resolution works from the realpath without
any further linking.

## Design

- **Cycles**: Nix store paths cannot reference each other cyclically, so each
  strongly connected component of the graph becomes one store path holding all
  members side by side (each member under its own subdirectory with its own
  `node_modules`).
- **Lifecycle scripts** (`preinstall`, `install`, `postinstall`) are detected
  from `package.json` at build time and run inside the sandbox with the deps'
  bins on PATH.
- **GC**: an anchor derivation holds a `manifest.json` referencing every
  package path; one indirect gc root on the anchor (at
  `<gcRootDir>/nix-gc-root`) protects the whole closure. The manifest doubles
  as a machine-readable record of the last install.

## Build rules

Packages that need more than nodejs to build (native addons, code
generators) can be described declaratively instead of falling back to impure
builds:

```jsonc
// ${XDG_CONFIG_HOME:-~/.config}/pnpm-nix/rules.json, or a file named by
// PNPM_NIX_RULES; keys are "<name>" or "<name>@<version>"
{
  "better-sqlite3": { "extraInputs": ["python3"] },
  "my-codegen":     { "env": { "MY_FLAG": "1", "TOOLDIR": { "drv": "protobuf" } } }
}
```

`extraInputs` are nixpkgs attribute paths added to the sandbox build; `env`
entries become environment variables (a `{ "drv": "attr" }` value resolves to
that attribute's store path). Rules participate in the input hash, so
changing a rule rebuilds the package. Sources merge in order: built-in
`src/rules.json`, the user config file, then `PNPM_NIX_RULES`.

Packages that look like native addons (a `binding.gyp`, or scripts invoking
node-gyp/node-pre-gyp/prebuild-install) additionally get a **generic native
recipe** in impure mode: python3 on PATH, `npm_config_nodedir` pointing at
the nixpkgs Node (so headers aren't downloaded), and npm's bundled node-gyp
exposed on PATH.

## Impure mode

Some lifecycle scripts can never run inside the Nix sandbox — postinstalls
that download binaries, builds needing tools no rule describes yet. Set
`PNPM_NIX_IMPURE=1` (or `impure: true` in the request) to allow host builds.
Each package takes the first rung that works:

1. Script-free closures build in the sandbox as usual — exact same store
   paths as pure mode.
2. Script-bearing groups are **tried in the sandbox first**, with their build
   rules and (for native-looking packages) the generic native recipe applied.
   Success means a real derivation output, shareable like any other.
3. Only on failure is the group assembled on the host, dependencies first:
   scripts run with the host's network, toolchain, and HOME, and the result
   is added to the store content-addressed (`nix-store --add`). Host-built
   groups are *pinned*: packages above them still build purely in the
   sandbox, referencing them via `builtins.storePath`.

A cache under `${XDG_CACHE_HOME:-~/.cache}/pnpm-nix/` maps each group's pure
inputs (raw unpack path, final dependency paths, rules, engine key) to its
final path, so unchanged packages are reused across installs. GC safety is
unchanged: the anchor references every final path verbatim, so the single gc
root protects the full mixed set.

Host-built paths are machine-specific — don't push them to a binary cache.

## Limitations (v1)

- Only registry tarball resolutions (git/local-directory dependencies are
  rejected).
- Patches that `git apply` cannot handle (e.g. binary patches) fail the
  build.
- Bins invoked by lifecycle scripts are assumed to be Node scripts (shebangs
  can't resolve `/usr/bin/env` inside the sandbox).
- Legacy `directories.bin` manifests are ignored.
- Lifecycle scripts that need network access fail in pure mode (Nix sandbox);
  use impure mode for these.
