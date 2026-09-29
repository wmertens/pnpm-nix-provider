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
const NIX_STORE_PREFIX = '/nix/store/'

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
 * 1. A sandbox build with its build rules and user overrides applied (plus
 *    the generic native recipe when the package looks like a native addon).
 *    Success means a real derivation output, shareable like any other.
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
 * Impure mode never fails because Nix could not store something — it
 * degrades with a warning instead: a failed `nix-store --add` keeps the
 * result in the local cache store, a failed gc-anchor build only loses gc
 * protection, and if Nix cannot build at all (daemon down), packages are
 * fetched, verified, unpacked, and built entirely on the host.
 *
 * A cache (outside the project by default; see cacheDir) maps each group's
 * inputs (content identity, final dep paths, rules, overrides, engine) to
 * its final path so unchanged groups are reused; forceRebuild bypasses it.
 */
export async function materializeGranular (request, spec, opts, { hostFallback, forceRebuild = false }) {
  const nixStore = opts.nixStore ?? 'nix-store'
  const nixOpts = { nixpkgs: request.nixpkgs, nixBuild: opts.nixBuild, overridesPath: opts.overridesPath }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pnpm-nix-granular-'))
  try {
    // The temp out-links keep intermediate results alive until the anchor is rooted.
    let raw = null
    try {
      raw = await nixBuildManifest(spec, { mode: 'raw', outLink: path.join(tmp, 'raw-root'), ...nixOpts })
    } catch (err) {
      if (!hostFallback) throw err
      warn(`Nix cannot build right now (${message(err)}); materializing on the host`)
    }

    const scriptGroups = new Set()
    const pureGroups = new Set()
    if (raw != null) {
      for (const [groupKey, group] of Object.entries(spec.groups)) {
        if (await analyzeGroup(groupKey, group, spec, raw)) scriptGroups.add(groupKey)
      }
      // A group joins the plain pure batch when neither it nor anything
      // below it runs scripts.
      for (const groupKey of spec.groupOrder) {
        const group = spec.groups[groupKey]
        const depsPure = group.members.every((depPath) =>
          Object.values(spec.nodes[depPath].deps ?? {}).every((dep) => {
            const depGroup = spec.memberOf[dep.depPath]
            return depGroup === groupKey || pureGroups.has(depGroup)
          }))
        if (depsPure && !scriptGroups.has(groupKey)) pureGroups.add(groupKey)
      }
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
      // Local directory sources have no stable content identity without the
      // raw derivation, so their host builds are not cached.
      const cacheable = raw != null || group.members.every((depPath) => {
        const node = spec.nodes[depPath]
        return node.integrity != null || node.git?.commit != null
      })
      const key = inputKey(groupKey, group, spec, raw, finalRoots, opts.overridesHash)
      let finalRoot = forceRebuild || !cacheable ? null : cache.entries[key]
      if (finalRoot != null && (await rootIsValid(nixStore, finalRoot))) {
        if (!finalRoot.startsWith(NIX_STORE_PREFIX) || !(await hasDeriver(nixStore, finalRoot))) {
          pinned[groupKey] = finalRoot
        }
        finalRoots[groupKey] = finalRoot
        continue
      }
      finalRoot = null
      // The sandbox can only reference dependencies that live in the store.
      const depsInStore = group.members.every((depPath) =>
        Object.values(spec.nodes[depPath].deps ?? {}).every((dep) => {
          const depGroup = spec.memberOf[dep.depPath]
          return depGroup === groupKey || finalRoots[depGroup].startsWith(NIX_STORE_PREFIX)
        }))
      if (raw != null && depsInStore) {
        try {
          finalRoot = await nixBuildGroup({ ...spec, pinned: storeOnly(pinned) }, groupKey, {
            outLink: path.join(tmp, `attempt-${attemptCount++}`),
            ...nixOpts,
          })
        } catch {}
      }
      if (finalRoot == null && hostFallback) {
        if (raw != null) {
          process.stderr.write(`pnpm-nix: sandbox build of ${groupKey} failed, building on the host\n`)
        }
        try {
          const groupDir = await assembleOnHost(groupKey, group, spec, raw, finalRoots, tmp)
          finalRoot = await storeGroupDir(groupDir, group, key, nixStore)
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
      if (cacheable) {
        cache.entries[key] = finalRoot
        await saveCache(cache)
      }
      finalRoots[groupKey] = finalRoot
    }

    const paths = {}
    for (const [depPath, groupKey] of Object.entries(spec.memberOf)) {
      paths[depPath] = `${finalRoots[groupKey]}/${spec.subdir[depPath]}`
    }

    // Anchor: pins every store-resident group to the exact path this run
    // used, so one gc root protects them (local-cache paths need none).
    // Best effort — losing gc protection is a warning, not a failure.
    try {
      const storeRoots = storeOnly(finalRoots)
      if (Object.keys(storeRoots).length > 0) {
        const outLink = (await gcRootLink(request.gcRootDir)) ?? path.join(tmp, 'anchor')
        await nixBuildManifest({ ...subsetSpec(spec, new Set(Object.keys(storeRoots))), pinned: storeRoots }, {
          mode: 'full',
          outLink,
          ...nixOpts,
        })
      }
    } catch (err) {
      warn(`could not register the Nix gc root (${message(err)}); the store paths are unprotected until the next install`)
    }

    const response = { protocol: PROTOCOL_VERSION, paths }
    if (skipped.length > 0) response.skipped = skipped
    return response
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

function warn (text) {
  process.stderr.write(`pnpm-nix: warning: ${text}\n`)
}

function message (err) {
  return err instanceof Error ? err.message : String(err)
}

function storeOnly (roots) {
  return Object.fromEntries(Object.entries(roots).filter(([, dir]) => dir.startsWith(NIX_STORE_PREFIX)))
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

// The subset is a valid spec when its groups' dependencies are all included
// or pinned; its groups produce derivations identical to a full-spec build.
function subsetSpec (spec, includedGroups) {
  const subset = { nodes: {}, groups: {}, memberOf: {}, subdir: {}, groupOrder: [], rules: {} }
  for (const groupKey of spec.groupOrder) {
    if (!includedGroups.has(groupKey)) continue
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

// Content identity (raw store path, or integrity/commit when Nix is down),
// final dep roots, rules, overrides, and engine together play the role a
// derivation hash plays for sandboxed builds.
function inputKey (groupKey, group, spec, raw, finalRoots, overridesHash) {
  const depTargets = {}
  for (const depPath of group.members) {
    for (const [alias, dep] of Object.entries(spec.nodes[depPath].deps ?? {})) {
      const depGroup = spec.memberOf[dep.depPath]
      depTargets[`${depPath} ${alias}`] = depGroup === groupKey ? `intra:${dep.depPath}` : finalRoots[depGroup]
    }
  }
  const sources = group.members.map((depPath) => {
    if (raw != null) return raw[depPath]
    const node = spec.nodes[depPath]
    return node.integrity ?? (node.git?.commit != null ? `git:${node.git.commit}` : `dir:${node.directory}`)
  })
  const engine = spec.nodes[groupKey].engine ?? ''
  const rule = spec.rules[groupKey] ?? null
  const payload = { v: 3, sources, depTargets, engine, rule, overrides: overridesHash ?? null }
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

/**
 * Copies/creates the group members under a temp dir with dependency links
 * and runs their lifecycle scripts on the host. When `raw` is null (Nix
 * unavailable) the members are fetched, integrity-checked, and unpacked on
 * the host too.
 */
async function assembleOnHost (groupKey, group, spec, raw, finalRoots, tmp) {
  const buildDir = await fs.mkdtemp(path.join(tmp, 'build-'))
  const groupDir = path.join(buildDir, `${group.drvName}-built`)
  for (const depPath of group.members) {
    const dest = path.join(groupDir, spec.subdir[depPath])
    if (raw != null) {
      await fs.cp(raw[depPath], dest, { recursive: true })
    } else {
      await hostRawMember(spec.nodes[depPath], dest, tmp)
    }
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
  return groupDir
}

// Host-side equivalent of a raw derivation: fetch/copy the source into
// <dest>/node_modules/<name> and apply the patch.
async function hostRawMember (node, dest, tmp) {
  const pkgDir = path.join(dest, 'node_modules', node.name)
  await fs.mkdir(pkgDir, { recursive: true })
  if (node.directory != null) {
    await fs.cp(node.directory, pkgDir, {
      recursive: true,
      filter: (src) => {
        const base = path.basename(src)
        return base !== 'node_modules' && base !== '.git'
      },
    })
  } else if (node.git != null) {
    const checkout = await fs.mkdtemp(path.join(tmp, 'git-'))
    const repo = node.git.repo.replace(/^git\+/, '')
    await run('git', ['clone', '--quiet', repo, checkout], { captureStdout: false })
    await run('git', ['-C', checkout, 'checkout', '--quiet', node.git.commit], { captureStdout: false })
    await fs.rm(path.join(checkout, '.git'), { recursive: true, force: true })
    await fs.cp(checkout, pkgDir, { recursive: true })
  } else {
    const response = await fetch(node.tarball)
    if (!response.ok) throw new Error(`downloading ${node.tarball} failed: HTTP ${response.status}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    verifyIntegrity(buffer, node.integrity, node.tarball)
    const tarball = path.join(await fs.mkdtemp(path.join(tmp, 'tgz-')), 'package.tgz')
    await fs.writeFile(tarball, buffer)
    await run('tar', ['-xzf', tarball, '--strip-components=1', '-C', pkgDir], { captureStdout: false })
  }
  if (node.patch != null) {
    const patchFile = path.join(await fs.mkdtemp(path.join(tmp, 'patch-')), 'pnpm.patch')
    await fs.writeFile(patchFile, node.patch.content)
    await run('git', ['-C', pkgDir, 'apply', '--ignore-whitespace', '--whitespace=nowarn', patchFile], { captureStdout: false })
  }
}

function verifyIntegrity (buffer, integrity, url) {
  const [algorithm, expected] = integrity.split('-', 2)
  const actual = crypto.createHash(algorithm).update(buffer).digest('base64')
  if (actual !== expected) {
    throw new Error(`integrity mismatch for ${url}: expected ${integrity}, got ${algorithm}-${actual}`)
  }
}

// `nix-store --add` the assembled group; when Nix cannot store it, keep it
// in the local cache store with a warning instead of failing the install.
async function storeGroupDir (groupDir, group, key, nixStore) {
  try {
    return (await run(nixStore, ['--add', groupDir])).trim()
  } catch (err) {
    warn(`could not store ${group.drvName} in the Nix store (${message(err)}); keeping it in the local cache store`)
    const dest = path.join(cacheDir(), 'store', key, path.basename(groupDir))
    await fs.rm(path.dirname(dest), { recursive: true, force: true })
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.cp(groupDir, dest, { recursive: true, verbatimSymlinks: true })
    return dest
  }
}

async function rootIsValid (nixStore, root) {
  if (!root.startsWith(NIX_STORE_PREFIX)) {
    return fs.access(root).then(() => true, () => false)
  }
  try {
    await run(nixStore, ['--check-validity', root], { quiet: true })
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

/** Outside the project by default; PNPM_NIX_CACHE_DIR may point anywhere, including into a project. */
function cacheDir () {
  return process.env.PNPM_NIX_CACHE_DIR ??
    path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'pnpm-nix')
}

async function loadCache () {
  try {
    const cache = JSON.parse(await fs.readFile(path.join(cacheDir(), 'impure-cache.json'), 'utf8'))
    if (cache.version === 1 && cache.entries != null) return cache
  } catch {}
  return { version: 1, entries: {} }
}

// TODO(TODO.md): no lock; concurrent installs race to last-writer-wins,
// which only costs a redundant rebuild.
async function saveCache (cache) {
  await fs.mkdir(cacheDir(), { recursive: true })
  await fs.writeFile(path.join(cacheDir(), 'impure-cache.json'), JSON.stringify(cache))
}
