# pnpm-nix-provider

An external package provider for pnpm that materializes npm packages as Nix
store paths. pnpm sends it the resolved dependency graph; the provider builds
one derivation per package (or per dependency cycle group), returns the
resulting store paths, and pnpm symlinks `node_modules` straight into
`/nix/store`.

Packages are input-addressed: the same lockfile deterministically reaches the
same store paths, unchanged subtrees stay cached across updates, and store
paths can be shared through Nix binary caches. A single indirect gc root per
project protects the whole closure. Both pnpm CLIs (the TypeScript one and
pacquet) speak the provider protocol and produce identical store paths from
the same lockfile.

## Usage

Get the provider onto your PATH — the easiest way is this repo's flake.
Either install it into your profile:

```sh
nix profile install github:wmertens/pnpm-nix-provider
```

or, nicer for a team, add it to the project's dev shell so everyone who
enters the shell has it:

```nix
# flake.nix of your project
{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  inputs.pnpm-nix-provider.url = "github:wmertens/pnpm-nix-provider";

  outputs = { nixpkgs, pnpm-nix-provider, ... }:
    let system = "x86_64-linux"; # or your system
        pkgs = nixpkgs.legacyPackages.${system};
    in {
      devShells.${system}.default = pkgs.mkShell {
        packages = [ pnpm-nix-provider.packages.${system}.default ];
      };
    };
}
```

Then tell pnpm to use it. Most projects won't want to commit this setting —
whether dependencies come from the Nix store is a per-machine choice, and
collaborators without Nix should still be able to install. So set it in your
**user-level pnpm config**:

```sh
pnpm config set -g package-provider pnpm-nix-provider
```

which writes `packageProvider: pnpm-nix-provider` to
`~/.config/pnpm/config.yaml`. Every pnpm install on this machine now
materializes dependencies in the Nix store, in any project.

Projects that *do* want to commit the choice (an all-Nix team) put the same
setting in the repo instead:

```yaml
# pnpm-workspace.yaml
packageProvider: pnpm-nix-provider
```

Either way the value is resolved on PATH (an absolute path also works). The
provider needs a pnpm with the `package-provider` setting, and `nix-build`
on PATH. `<nixpkgs>` is taken from `NIX_PATH` when set; the flake-built
binary falls back to the flake's pinned nixpkgs, so it works on flakes-only
systems without channels.

When running straight from a checkout of this repo instead, use the absolute
path of `src/cli.js` (it must be executable, and `node` must be on PATH).

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
      "optional": true,                           // a failing build skips the package instead of aborting
      "engine": "linux;x64;node22",               // optional platform key folded into the derivation
      "patch": { "content": "diff --git …", "hash": "…" } // optional git-style patch, applied after unpack
    }
  }
}
```

Top-level request flags (also settable via CLI flags of the same name):
`impure` allows host builds (see below), `rebuild` bypasses the host-build
cache, and `check` appends a reproducibility report to the response.

Patches are deterministic, so the patch content is simply another derivation
input: a changed patch yields a new store path, an unchanged one hits the
cache. Patches are applied with `git apply` inside the sandbox before
dependency links are created and scripts run.

`nodes` must be a closed graph: every `deps[].depPath` must itself be a key of
`nodes`. Keys are opaque identifiers to the provider (pnpm uses depPaths, which
already encode resolved peer dependencies).

Response:

```jsonc
{
  "protocol": 1,
  "paths": { "<depPath>": "/nix/store/…" },
  "skipped": ["<depPath>"],                          // optional deps whose build failed
  "check": [{ "group": "…", "reproducible": true }]  // only with check: true
}
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

In pure mode, a failed batch build is retried group by group with rules and
the generic native recipe applied, and failing **optional** dependencies are
skipped (reported in the response's `skipped` list) instead of aborting —
matching pnpm's optional-dependency semantics. Only non-optional failures
abort.

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
