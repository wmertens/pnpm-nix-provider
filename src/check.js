import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { hasDeriver } from './granular.js'
import { nixBuildGroup } from './nix.js'

const DIFF_EXCERPT_LINES = 40

/**
 * Reproducibility report for an already-materialized graph: every
 * derivation-built group is rebuilt with `nix-build --check` and compared
 * byte for byte; differences are excerpted so non-determinism (embedded
 * timestamps, random ids) can be understood. Host-built groups cannot be
 * meaningfully checked this way and are reported as unchecked — re-run them
 * with `rebuild: true` instead.
 *
 * Returns [{ group, reproducible: boolean | null, diff? }].
 */
export async function checkReproducibility (spec, paths, opts, nixOpts) {
  const nixStore = opts.nixStore ?? 'nix-store'
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pnpm-nix-check-'))
  try {
    const pinned = {}
    const roots = {}
    for (const groupKey of Object.keys(spec.groups)) {
      if (paths[groupKey] == null) continue // skipped optional group
      roots[groupKey] = path.dirname(paths[groupKey])
      if (!(await hasDeriver(nixStore, roots[groupKey]))) pinned[groupKey] = roots[groupKey]
    }
    const report = []
    let attempt = 0
    for (const [groupKey, root] of Object.entries(roots)) {
      if (pinned[groupKey] != null) {
        report.push({ group: groupKey, reproducible: null })
        continue
      }
      try {
        await nixBuildGroup({ ...spec, pinned }, groupKey, {
          outLink: path.join(tmp, `check-${attempt++}`),
          extraArgs: ['--check', '--keep-failed'],
          ...nixOpts,
        })
        report.push({ group: groupKey, reproducible: true })
      } catch {
        report.push({ group: groupKey, reproducible: false, diff: await diffExcerpt(root, `${root}.check`) })
      }
    }
    return report
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

async function diffExcerpt (expected, actual) {
  try {
    await fs.access(actual)
  } catch {
    return 'differing output was not kept by nix; re-run with more verbosity'
  }
  const result = spawnSync('diff', ['-r', expected, actual], { encoding: 'utf8' })
  const lines = (result.stdout || result.stderr || '').split('\n')
  const excerpt = lines.slice(0, DIFF_EXCERPT_LINES).join('\n')
  return lines.length > DIFF_EXCERPT_LINES ? `${excerpt}\n… (${lines.length - DIFF_EXCERPT_LINES} more lines)` : excerpt
}
