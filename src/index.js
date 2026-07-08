import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { checkReproducibility } from './check.js'
import { buildSpec } from './groups.js'
import { materializeGranular } from './granular.js'
import { gcRootLink, nixBuildManifest, PROTOCOL_VERSION } from './nix.js'
import { groupRules, loadRules, resolveOverridesPath } from './rules.js'

export { PROTOCOL_VERSION }

/**
 * Materialize every node of a closed dependency graph as a Nix store path.
 *
 * Request: {
 *   protocol: 1,
 *   gcRootDir?: string,   // where to register the indirect gc root symlink
 *   nixpkgs?: string,     // path or URL overriding <nixpkgs>
 *   impure?: boolean,     // allow host builds as a last resort (see granular.js)
 *   rebuild?: boolean,    // bypass the host-build cache and rebuild
 *   check?: boolean,      // add a byte-for-byte reproducibility report
 *   nodes: {
 *     [depPath]: {
 *       name, version, tarball, integrity,
 *       deps?: { [alias]: { depPath, name } },
 *       optional?: boolean, // a failing build skips the package instead of aborting
 *       engine?: string,  // platform key, folded into the drv for building nodes
 *       patch?: { content: string, hash: string },
 *     }
 *   }
 * }
 *
 * Response: { protocol: 1, paths, skipped?, check? } where
 * `${paths[depPath]}/node_modules/${name}` is the package directory,
 * `skipped` lists optional depPaths whose build failed, and `check` is the
 * reproducibility report. Any failure rejects — callers must abort.
 */
export async function materialize (request, opts = {}) {
  if (request?.protocol !== PROTOCOL_VERSION) {
    throw new Error(`unsupported protocol version ${request?.protocol}; this provider speaks version ${PROTOCOL_VERSION}`)
  }
  const spec = buildSpec(request.nodes ?? {})
  spec.rules = groupRules(spec, await loadRules())
  if (request.nixpkgs == null && process.env.PNPM_NIX_NIXPKGS) {
    request = { ...request, nixpkgs: process.env.PNPM_NIX_NIXPKGS }
  }
  const overridesPath = await resolveOverridesPath()
  opts = {
    ...opts,
    overridesPath,
    // Overrides participate in the host-build cache key: an edited override
    // must rebuild what it may affect.
    overridesHash: overridesPath == null
      ? null
      : crypto.createHash('sha256').update(await fs.readFile(overridesPath)).digest('hex'),
  }
  const impure = request.impure === true || process.env.PNPM_NIX_IMPURE === '1'
  const response = await materializeInner(request, spec, opts, impure)
  if (request.check === true) {
    response.check = await checkReproducibility(spec, response.paths, opts, { nixpkgs: request.nixpkgs, nixBuild: opts.nixBuild, overridesPath })
  }
  return response
}

async function materializeInner (request, spec, opts, impure) {
  if (impure || request.rebuild === true) {
    return materializeGranular(request, spec, opts, { hostFallback: impure, forceRebuild: request.rebuild === true })
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pnpm-nix-provider-'))
  try {
    const outLink = (await gcRootLink(request.gcRootDir)) ?? path.join(tmp, 'result')
    const paths = await nixBuildManifest(spec, {
      mode: 'full',
      outLink,
      nixpkgs: request.nixpkgs,
      nixBuild: opts.nixBuild,
      overridesPath: opts.overridesPath,
    })
    return { protocol: PROTOCOL_VERSION, paths }
  } catch {
    // A failed batch gets a second chance group by group: build rules and the
    // generic native recipe are tried per group, and failing optional
    // dependencies are skipped instead of aborting. Still no host builds.
    process.stderr.write('pnpm-nix: batch build failed, retrying group by group\n')
    return materializeGranular(request, spec, opts, { hostFallback: false })
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
}
