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

## Impure mode

Some lifecycle scripts cannot run inside the Nix sandbox — node-gyp builds
that need the host toolchain, postinstalls that download binaries. Set
`PNPM_NIX_IMPURE=1` (or `impure: true` in the request) to build those on the
host instead:

- Every package is still unpacked and patched purely, which also reveals who
  has lifecycle scripts.
- Packages whose whole dependency closure is script-free build in the sandbox
  as usual and get the exact same store paths as pure mode.
- The rest is assembled on the host, dependencies first: scripts run with the
  host's network, toolchain, and HOME, and the result is added to the store
  content-addressed (`nix-store --add`). A cache under
  `${XDG_CACHE_HOME:-~/.cache}/pnpm-nix/` maps the pure inputs (raw unpack
  path, final dependency paths, engine key) to the added path, so unchanged
  packages are reused across installs.
- GC safety is unchanged: host-built paths carry no reference metadata, but
  the anchor derivation imports every final path via `builtins.storePath`,
  so the single gc root still protects the full set.

Host-built paths are machine-specific — don't push them to a binary cache.

## Limitations (v1)

- Only registry tarball resolutions (git/local-directory dependencies are
  rejected).
- Patches that `git apply` cannot handle (e.g. binary patches) fail the
  build.
- Native addons: the sandbox provides nodejs, jq, and stdenv only — node-gyp
  builds fail in pure mode until per-package extra build inputs are
  supported. Use impure mode for these.
- Bins invoked by lifecycle scripts are assumed to be Node scripts (shebangs
  can't resolve `/usr/bin/env` inside the sandbox).
- Legacy `directories.bin` manifests are ignored.
- Lifecycle scripts that need network access fail in pure mode (Nix sandbox);
  use impure mode for these.
