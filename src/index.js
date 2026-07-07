import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSpec } from './groups.js'

const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'template.nix')

export const PROTOCOL_VERSION = 1

/**
 * Materialize every node of a closed dependency graph as a Nix store path.
 *
 * Request: {
 *   protocol: 1,
 *   gcRootDir?: string,   // where to register the indirect gc root symlink
 *   nixpkgs?: string,     // path or URL overriding <nixpkgs>
 *   nodes: {
 *     [depPath]: {
 *       name, version, tarball, integrity,
 *       deps?: { [alias]: { depPath, name } },
 *       requiresBuild?: boolean,
 *       engine?: string,  // platform key, folded into the drv for building nodes
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pnpm-nix-provider-'))
  try {
    const depsJsonPath = path.join(tmp, 'deps.json')
    await fs.writeFile(depsJsonPath, JSON.stringify(spec))
    let outLink
    if (request.gcRootDir) {
      await fs.mkdir(request.gcRootDir, { recursive: true })
      outLink = path.join(request.gcRootDir, 'nix-gc-root')
    } else {
      outLink = path.join(tmp, 'result')
    }
    const args = [TEMPLATE, '--argstr', 'depsJsonPath', depsJsonPath, '-A', 'anchor', '-o', outLink]
    if (request.nixpkgs) {
      args.push('-I', `nixpkgs=${request.nixpkgs}`)
    }
    const anchor = (await run(opts.nixBuild ?? 'nix-build', args)).trim()
    const paths = JSON.parse(await fs.readFile(path.join(anchor, 'manifest.json'), 'utf8'))
    return { protocol: PROTOCOL_VERSION, paths }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

async function run (cmd, args) {
  return new Promise((resolve, reject) => {
    // stderr is inherited so nix build output reaches the user via pnpm.
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] })
    let stdout = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout)
      } else {
        reject(new Error(`${cmd} exited with code ${code}`))
      }
    })
  })
}
