import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BUILTIN_RULES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'rules.json')

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
    path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'pnpm-nix', 'rules.json'),
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
 * Fallback recipe for native addons: python for node-gyp, and the Node
 * headers so node-gyp does not try to download them. node-gyp itself is
 * provided by run-scripts.cjs from npm's bundled copy.
 */
export const GENERIC_NATIVE_RULE = {
  extraInputs: ['python3'],
  env: { npm_config_nodedir: { drv: 'nodejs' } },
}

const NATIVE_SCRIPT_PATTERN = /node-gyp|node-pre-gyp|prebuild-install/

/** Heuristic: does this unpacked package look like it builds a native addon? */
export function looksNative (manifest, hasBindingGyp) {
  return hasBindingGyp || NATIVE_SCRIPT_PATTERN.test(JSON.stringify(manifest.scripts ?? {}))
}
