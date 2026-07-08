# TODO

Real work items, roughly ordered by impact. Inline `TODO(TODO.md)` comments
in the source point here.

## Correctness / coverage

- **git deps with a prepare step** (built from source with devDependencies)
  are still rejected; plain git deps and directory/injected resolutions are
  supported.
- **Richer lifecycle env**: npm sets many `npm_package_*` / `npm_config_*`
  vars that some scripts read; run-scripts.cjs sets a minimal subset.
- **Non-Node bins on the script PATH**: wrappers assume Node scripts because
  `/usr/bin/env` is absent in the sandbox; detect the shebang interpreter
  instead.
- **Legacy `directories.bin`** manifests are ignored.

## pnpm integration

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
- The home-manager module has no automated test; exercise it in a real
  home-manager evaluation (Linux + macOS) once there's a consumer.
