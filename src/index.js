import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildSpec } from './groups.js'
import { materializeImpure } from './impure.js'
import { gcRootLink, nixBuildManifest, PROTOCOL_VERSION } from './nix.js'

export { PROTOCOL_VERSION }

/**
 * Materialize every node of a closed dependency graph as a Nix store path.
 *
 * Request: {
 *   protocol: 1,
 *   gcRootDir?: string,   // where to register the indirect gc root symlink
 *   nixpkgs?: string,     // path or URL overriding <nixpkgs>
 *   impure?: boolean,     // build lifecycle scripts on the host (see impure.js)
 *   nodes: {
 *     [depPath]: {
 *       name, version, tarball, integrity,
 *       deps?: { [alias]: { depPath, name } },
 *       engine?: string,  // platform key, folded into the drv for building nodes
 *       patch?: { content: string, hash: string },
 *     }
 *   }
 * }
 *
 * Response: { protocol: 1, paths: { [depPath]: storePathDir } } where
 * `${storePathDir}/node_modules/${name}` is the package directory.
 * Any failure rejects — callers must abort the install.
 */
export async function materialize (request, opts = {}) {
  if (request?.protocol !== PROTOCOL_VERSION) {
    throw new Error(`unsupported protocol version ${request?.protocol}; this provider speaks version ${PROTOCOL_VERSION}`)
  }
  const spec = buildSpec(request.nodes ?? {})
  if (request.impure === true || process.env.PNPM_NIX_IMPURE === '1') {
    return materializeImpure(request, spec, opts)
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pnpm-nix-provider-'))
  try {
    const outLink = (await gcRootLink(request.gcRootDir)) ?? path.join(tmp, 'result')
    const paths = await nixBuildManifest(spec, {
      mode: 'full',
      outLink,
      nixpkgs: request.nixpkgs,
      nixBuild: opts.nixBuild,
    })
    return { protocol: PROTOCOL_VERSION, paths }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
}
