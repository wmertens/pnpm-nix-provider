# TODO

Real work items, roughly ordered by impact. Inline `TODO(TODO.md)` comments
in the source point here.

## Correctness / coverage

- **git / directory / injected resolutions**: git deps are deterministic by
  rev → `fetchGit`-style fixed derivations; local directories and injected
  workspace packages are mutable local trees → ingest like a host build
  (hash content, `nix-store --add`). Currently rejected.
- **Richer lifecycle env**: npm sets many `npm_package_*` / `npm_config_*`
  vars that some scripts read; run-scripts.cjs sets a minimal subset.
- **Non-Node bins on the script PATH**: wrappers assume Node scripts because
  `/usr/bin/env` is absent in the sandbox; detect the shebang interpreter
  instead.
- **Legacy `directories.bin`** manifests are ignored.
- **Real node-gyp smoke test**: the generic native recipe (python3,
  `npm_config_nodedir`, npm's bundled node-gyp) is mechanism-tested but not
  yet exercised against a real published native addon (e.g. better-sqlite3).

## pnpm integration

- **Headless fast path**: deps-restorer materializes straight from the
  lockfile; needs the same four touchpoints as the full path (build request
  from the lockfile graph, repoint dirs, skip import/scripts/dep-bins,
  honor skipped optionals). Until then provider installs always resolve.
- **`pnpm rebuild` wiring**: the provider already supports
  `rebuild: true` (bypass host-build cache) and `check: true`
  (byte-for-byte `nix-build --check` with diff excerpts); pnpm's rebuild
  command should invoke them.
- **pacquet parity**: the `package-provider` setting must be ported to the
  Rust CLI (config key, skip-fetch resolution, link-step integration,
  provider spawn). The provider binary itself is shared.

## Robustness / performance

- **Cache file locking**: concurrent installs race last-writer-wins on
  `impure-cache.json`; only costs a redundant rebuild, but a lock (or
  SQLite) would be cleaner.
- **Batch validity checks**: cache validation runs one `nix-store
  --check-validity` per group; batch them into one call.
- **Semver ranges in rule keys**: rules match exact `name` / `name@version`
  only.
- **Check host-built groups**: `check` reports them as unchecked
  (`reproducible: null`); a host re-assembly + NAR comparison would cover
  them.
- **Binary-cache guardrails**: host-added paths must not be pushed to
  caches; consider marking them (e.g. a `.pnpm-nix-impure` marker file) so
  push tooling can refuse.

## Ecosystem (later)

- Publish and curate a shared build-rules registry.
