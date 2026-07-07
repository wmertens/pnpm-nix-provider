import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'template.nix')

export const PROTOCOL_VERSION = 1

export async function run (cmd, args, { captureStdout = true, quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    // stderr is normally inherited so nix/build output reaches the user.
    const child = spawn(cmd, args, { stdio: ['ignore', captureStdout ? 'pipe' : 2, quiet ? 'ignore' : 'inherit'] })
    let stdout = ''
    child.stdout?.on('data', (chunk) => {
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

/**
 * nix-builds the spec's groups ("full": links + scripts, "raw": unpack+patch
 * only) and returns the anchor manifest mapping depPath -> package root dir.
 * The outLink keeps the result alive (use a gc root path or a temp link).
 */
export async function nixBuildManifest (spec, { mode, outLink, nixpkgs, nixBuild }) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pnpm-nix-eval-'))
  try {
    const depsJsonPath = path.join(tmp, 'deps.json')
    await fs.writeFile(depsJsonPath, JSON.stringify(spec))
    const args = [TEMPLATE, '--argstr', 'depsJsonPath', depsJsonPath, '--argstr', 'mode', mode, '-A', 'anchor', '-o', outLink]
    if (nixpkgs) args.push('-I', `nixpkgs=${nixpkgs}`)
    const anchor = (await run(nixBuild ?? 'nix-build', args)).trim()
    return JSON.parse(await fs.readFile(path.join(anchor, 'manifest.json'), 'utf8'))
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

/** nix-builds a single group and returns its store path. */
export async function nixBuildGroup (spec, groupKey, { outLink, nixpkgs, nixBuild }) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pnpm-nix-eval-'))
  try {
    const depsJsonPath = path.join(tmp, 'deps.json')
    await fs.writeFile(depsJsonPath, JSON.stringify(spec))
    const args = [TEMPLATE, '--argstr', 'depsJsonPath', depsJsonPath, '--argstr', 'mode', 'full', '-A', `groups."${groupKey}"`, '-o', outLink]
    if (nixpkgs) args.push('-I', `nixpkgs=${nixpkgs}`)
    return (await run(nixBuild ?? 'nix-build', args)).trim()
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

export async function gcRootLink (gcRootDir) {
  if (!gcRootDir) return undefined
  await fs.mkdir(gcRootDir, { recursive: true })
  return path.join(gcRootDir, 'nix-gc-root')
}
