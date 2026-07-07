import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gcRootLink, nixBuildGroup, nixBuildManifest, PROTOCOL_VERSION, run } from './nix.js'
import { GENERIC_NATIVE_RULE, looksNative, mergeRules } from './rules.js'

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url))
const RUN_SCRIPTS = path.join(SRC_DIR, 'run-scripts.cjs')
const SCRIPT_EVENTS = ['preinstall', 'install', 'postinstall']

/**
 * Group-by-group materialization, used whenever the single batch build is
 * not enough: impure mode, rebuilds, and the pure-mode retry after a failed
 * batch.
 *
 * Every package is first unpacked+patched purely ("raw" derivations), which
 * also reveals who has lifecycle scripts. Groups whose whole closure is
 * script-free build in the sandbox in one batch — identical derivations,
 * identical store paths to pure mode. Each remaining group then takes the
 * first rung that works, dependencies first:
 *
 * 1. A sandbox build with its build rules applied (plus the generic native
 *    recipe when the package looks like a native addon). Success means a
 *    real derivation output, shareable like any other.
 * 2. With hostFallback (impure mode), assembly on the host: raw output
 *    copied, dependency symlinks pointed at the final paths, scripts run
 *    with the host's network and toolchain, and the result added
 *    content-addressed with `nix-store --add`. Host-built groups are
 *    "pinned": later groups reference them through builtins.storePath, so a
 *    pure dependent can still build in the sandbox on top of them.
 * 3. If the group still cannot be built and every member is an optional
 *    dependency, it is skipped: the group is dropped from the graph, links
 *    to it are scrubbed from dependents, and it is reported in the
 *    response's `skipped` list. Otherwise the install aborts.
 *
 * Host-added paths carry no reference metadata, but gc safety doesn't need
 * it: the final anchor pins every group to the exact path this run used, so
 * the single gc root protects the full set. A cache maps each group's pure
 * inputs (raw path, final dep paths, rules, engine) to its final path so
 * unchanged groups are reused across installs; forceRebuild bypasses it.
 */
export async function materializeGranular (request, spec, opts, { hostFallback, forceRebuild = false }) {
  const nixStore = opts.nixStore ?? 'nix-store'
  const nixOpts = { nixpkgs: request.nixpkgs, nixBuild: opts.nixBuild }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pnpm-nix-granular-'))
  try {
    // The temp out-links keep intermediate results alive until the anchor is rooted.
    const raw = await nixBuildManifest(spec, { mode: 'raw', outLink: path.join(tmp, 'raw-root'), ...nixOpts })

    const scriptGroups = new Set()
    for (const [groupKey, group] of Object.entries(spec.groups)) {
      if (await analyzeGroup(groupKey, group, spec, raw)) scriptGroups.add(groupKey)
    }

    // A group joins the plain pure batch when neither it nor anything below
    // it runs scripts.
    const pureGroups = new Set()
    for (const groupKey of spec.groupOrder) {
      const group = spec.groups[groupKey]
      const depsPure = group.members.every((depPath) =>
        Object.values(spec.nodes[depPath].deps ?? {}).every((dep) => {
          const depGroup = spec.memberOf[dep.depPath]
          return depGroup === groupKey || pureGroups.has(depGroup)
        }))
      if (depsPure && !scriptGroups.has(groupKey)) pureGroups.add(groupKey)
    }

    const finalRoots = {}
    if (pureGroups.size > 0) {
      const pureManifest = await nixBuildManifest(subsetSpec(spec, pureGroups), {
        mode: 'full',
        outLink: path.join(tmp, 'pure-root'),
        ...nixOpts,
      })
      for (const groupKey of pureGroups) {
        // groupKey is its first member's depPath; subdirs contain no slashes.
        finalRoots[groupKey] = path.dirname(pureManifest[groupKey])
      }
    }

    const cache = await loadCache()
    const pinned = {}
    const skippedGroups = new Set()
    const skipped = []
    let attemptCount = 0
    for (const groupKey of spec.groupOrder) {
      if (pureGroups.has(groupKey) || skippedGroups.has(groupKey)) continue
      const group = spec.groups[groupKey]
      const key = inputKey(groupKey, group, spec, raw, finalRoots)
      let finalRoot = forceRebuild ? null : cache.entries[key]
      if (finalRoot != null && (await isValidStorePath(nixStore, finalRoot))) {
        if (!(await hasDeriver(nixStore, finalRoot))) pinned[groupKey] = finalRoot
        finalRoots[groupKey] = finalRoot
        continue
      }
      finalRoot = null
      try {
        finalRoot = await nixBuildGroup({ ...spec, pinned }, groupKey, {
          outLink: path.join(tmp, `attempt-${attemptCount++}`),
          ...nixOpts,
        })
      } catch {}
      if (finalRoot == null && hostFallback) {
        process.stderr.write(`pnpm-nix: sandbox build of ${groupKey} failed, building on the host\n`)
        try {
          finalRoot = await assembleOnHost(groupKey, group, spec, raw, finalRoots, tmp, nixStore)
          pinned[groupKey] = finalRoot
        } catch {}
      }
      if (finalRoot == null) {
        if (group.members.every((depPath) => spec.nodes[depPath].optional === true)) {
          process.stderr.write(`pnpm-nix: skipping optional ${groupKey} (build failed)\n`)
          skippedGroups.add(groupKey)
          scrubGroup(spec, groupKey, skipped)
          continue
        }
        throw new Error(`building ${groupKey} failed`)
      }
      cache.entries[key] = finalRoot
      await saveCache(cache)
      finalRoots[groupKey] = finalRoot
    }

    // Anchor: every group is pinned to the exact path this run used (host
    // builds symlink into those), so the manifest mirrors finalRoots verbatim
    // and the single gc root protects the full set, pure or added.
    const outLink = (await gcRootLink(request.gcRootDir)) ?? path.join(tmp, 'anchor')
    const paths = await nixBuildManifest({ ...spec, pinned: finalRoots }, { mode: 'full', outLink, ...nixOpts })
    const response = { protocol: PROTOCOL_VERSION, paths }
    if (skipped.length > 0) response.skipped = skipped
    return response
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

// Marks script groups and augments spec.rules with the generic native recipe
// when a member looks like a native addon (explicit rules win on conflicts).
async function analyzeGroup (groupKey, group, spec, raw) {
  let hasScripts = false
  for (const depPath of group.members) {
    const pkgDir = path.join(raw[depPath], 'node_modules', spec.nodes[depPath].name)
    const manifest = JSON.parse(await fs.readFile(path.join(pkgDir, 'package.json'), 'utf8'))
    if (!SCRIPT_EVENTS.some((event) => manifest.scripts?.[event])) continue
    hasScripts = true
    const hasBindingGyp = await fs.access(path.join(pkgDir, 'binding.gyp')).then(() => true, () => false)
    if (looksNative(manifest, hasBindingGyp)) {
      spec.rules[groupKey] = mergeRules(GENERIC_NATIVE_RULE, spec.rules[groupKey])
    }
  }
  return hasScripts
}

// Drops a failed optional group: its members leave the graph and every edge
// into it is scrubbed, matching pnpm's optional-dependency semantics.
function scrubGroup (spec, groupKey, skipped) {
  const members = new Set(spec.groups[groupKey].members)
  for (const depPath of members) {
    skipped.push(depPath)
    delete spec.memberOf[depPath]
    delete spec.subdir[depPath]
    delete spec.nodes[depPath]
  }
  delete spec.groups[groupKey]
  delete spec.rules[groupKey]
  for (const node of Object.values(spec.nodes)) {
    for (const [alias, dep] of Object.entries(node.deps ?? {})) {
      if (members.has(dep.depPath)) delete node.deps[alias]
    }
  }
}

// The pure subgraph is closed by construction, so the subset is a valid spec
// and its groups produce derivations identical to a full-spec build.
function subsetSpec (spec, pureGroups) {
  const subset = { nodes: {}, groups: {}, memberOf: {}, subdir: {}, groupOrder: [], rules: {} }
  for (const groupKey of spec.groupOrder) {
    if (!pureGroups.has(groupKey)) continue
    subset.groupOrder.push(groupKey)
    subset.groups[groupKey] = spec.groups[groupKey]
    if (spec.rules[groupKey]) subset.rules[groupKey] = spec.rules[groupKey]
    for (const depPath of spec.groups[groupKey].members) {
      subset.memberOf[depPath] = groupKey
      subset.subdir[depPath] = spec.subdir[depPath]
      subset.nodes[depPath] = spec.nodes[depPath]
    }
  }
  return subset
}

// The raw path covers tarball+patch content; final dep roots cover the
// transitive build inputs; rules and engine cover the build environment.
// Together they play the role a derivation hash plays for sandboxed builds.
function inputKey (groupKey, group, spec, raw, finalRoots) {
  const depTargets = {}
  for (const depPath of group.members) {
    for (const [alias, dep] of Object.entries(spec.nodes[depPath].deps ?? {})) {
      const depGroup = spec.memberOf[dep.depPath]
      depTargets[`${depPath} ${alias}`] = depGroup === groupKey ? `intra:${dep.depPath}` : finalRoots[depGroup]
    }
  }
  const rawDirs = group.members.map((depPath) => raw[depPath])
  const engine = spec.nodes[groupKey].engine ?? ''
  const rule = spec.rules[groupKey] ?? null
  return crypto.createHash('sha256').update(JSON.stringify({ v: 2, rawDirs, depTargets, engine, rule })).digest('hex')
}

async function assembleOnHost (groupKey, group, spec, raw, finalRoots, tmp, nixStore) {
  const buildDir = await fs.mkdtemp(path.join(tmp, 'build-'))
  const groupDir = path.join(buildDir, `${group.drvName}-built`)
  for (const depPath of group.members) {
    await fs.cp(raw[depPath], path.join(groupDir, spec.subdir[depPath]), { recursive: true })
  }
  await run('chmod', ['-R', 'u+w', groupDir], { captureStdout: false })
  for (const depPath of group.members) {
    const node = spec.nodes[depPath]
    const linkDir = path.join(groupDir, spec.subdir[depPath], 'node_modules')
    for (const [alias, dep] of Object.entries(node.deps ?? {})) {
      const scopeUp = alias.startsWith('@') ? '../' : ''
      const depGroup = spec.memberOf[dep.depPath]
      const target = depGroup === groupKey
        ? `${scopeUp}../../${spec.subdir[dep.depPath]}/node_modules/${dep.name}`
        : `${finalRoots[depGroup]}/${spec.subdir[dep.depPath]}/node_modules/${dep.name}`
      const link = path.join(linkDir, alias)
      await fs.mkdir(path.dirname(link), { recursive: true })
      await fs.symlink(target, link)
    }
  }
  for (const depPath of group.members) {
    const pkgDir = path.join(groupDir, spec.subdir[depPath], 'node_modules', spec.nodes[depPath].name)
    await run(process.execPath, [RUN_SCRIPTS, pkgDir], { captureStdout: false })
  }
  return (await run(nixStore, ['--add', groupDir])).trim()
}

async function isValidStorePath (nixStore, storePath) {
  try {
    await run(nixStore, ['--check-validity', storePath], { quiet: true })
    return true
  } catch {
    return false
  }
}

// Distinguishes derivation outputs from host-added paths (which must be
// pinned): added paths have no deriver.
export async function hasDeriver (nixStore, storePath) {
  try {
    const deriver = (await run(nixStore, ['--query', '--deriver', storePath], { quiet: true })).trim()
    return deriver.endsWith('.drv')
  } catch {
    return false
  }
}

function cacheFile () {
  const cacheHome = process.env.PNPM_NIX_CACHE_DIR ??
    path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'pnpm-nix')
  return path.join(cacheHome, 'impure-cache.json')
}

async function loadCache () {
  try {
    const cache = JSON.parse(await fs.readFile(cacheFile(), 'utf8'))
    if (cache.version === 1 && cache.entries != null) return cache
  } catch {}
  return { version: 1, entries: {} }
}

// TODO(TODO.md): no lock; concurrent installs race to last-writer-wins,
// which only costs a redundant rebuild.
async function saveCache (cache) {
  await fs.mkdir(path.dirname(cacheFile()), { recursive: true })
  await fs.writeFile(cacheFile(), JSON.stringify(cache))
}
