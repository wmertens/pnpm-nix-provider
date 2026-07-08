import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BUILTIN_RULES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'rules.json')

/** ~/.config fallback keeps the same location on macOS (home-manager writes there too). */
export function userConfigDir () {
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'pnpm-nix')
}

/**
 * A Nix-level escape hatch beyond declarative rules: a file evaluating to
 * `{ pkgs, lib }: { "<name>" | "<name>@<version>" | "*" = drv: drv; }`,
 * applied to every group derivation (e.g. via overrideAttrs). Resolved from
 * PNPM_NIX_OVERRIDES, else ~/.config/pnpm-nix/overrides.nix.
 */
export async function resolveOverridesPath () {
  const candidate = process.env.PNPM_NIX_OVERRIDES ?? path.join(userConfigDir(), 'overrides.nix')
  try {
    await fs.access(candidate)
    return candidate
  } catch {
    if (process.env.PNPM_NIX_OVERRIDES) {
      throw new Error(`PNPM_NIX_OVERRIDES points to an unreadable file: ${candidate}`)
    }
    return undefined
  }
}

/**
 * Build rules describe what a package needs to build inside the sandbox:
 *   { "<name>" | "<name>@<version>": {
 *       extraInputs?: ["python3", "pkgs.attr.path", …],   // nixpkgs attr paths
 *       env?: { VAR: "value" | { drv: "nixpkgs.attr" } }, // {drv} becomes that attr's store path
 *   } }
 * Sources are merged in order (later wins): built-in rules.json,
 * ~/.config/pnpm-nix/rules.json, then the file named by PNPM_NIX_RULES.
 */
export async function loadRules () {
  const sources = [
    BUILTIN_RULES,
    path.join(userConfigDir(), 'rules.json'),
    process.env.PNPM_NIX_RULES,
  ]
  const merged = {}
  for (const file of sources) {
    if (!file) continue
    try {
      Object.assign(merged, JSON.parse(await fs.readFile(file, 'utf8')))
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
  }
  return merged
}

/** Collapses per-package rules onto cycle groups: spec.rules[groupKey]. */
export function groupRules (spec, rules) {
  const result = {}
  for (const [groupKey, group] of Object.entries(spec.groups)) {
    let combined
    for (const depPath of group.members) {
      const node = spec.nodes[depPath]
      const rule = rules[`${node.name}@${node.version}`] ?? rules[node.name]
      if (rule) combined = mergeRules(combined, rule)
    }
    if (combined) result[groupKey] = combined
  }
  return result
}

export function mergeRules (base, extra) {
  return {
    extraInputs: [...new Set([...(base?.extraInputs ?? []), ...(extra?.extraInputs ?? [])])].sort(),
    env: { ...base?.env, ...extra?.env },
  }
}

/**
 * Fallback recipe for native addons: python and a C/C++ toolchain for
 * node-gyp (runCommand's stdenvNoCC has make but no compiler), and the Node
 * headers so node-gyp does not try to download them. node-gyp itself is
 * provided by run-scripts.cjs from npm's bundled copy.
 */
export const GENERIC_NATIVE_RULE = {
  extraInputs: ['python3', 'stdenv.cc'],
  env: { npm_config_nodedir: { drv: 'nodejs' } },
}

const NATIVE_SCRIPT_PATTERN = /node-gyp|node-pre-gyp|prebuild-install/

/** Heuristic: does this unpacked package look like it builds a native addon? */
export function looksNative (manifest, hasBindingGyp) {
  return hasBindingGyp || NATIVE_SCRIPT_PATTERN.test(JSON.stringify(manifest.scripts ?? {}))
}
