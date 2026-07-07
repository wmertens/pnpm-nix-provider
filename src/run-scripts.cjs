// Runs npm lifecycle scripts (preinstall, install, postinstall) for one
// package inside the Nix build sandbox. Invoked by template.nix with the
// package directory as the only argument.
'use strict'
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const pkgDir = process.argv[2]
const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
const scripts = manifest.scripts ?? {}
const events = ['preinstall', 'install', 'postinstall'].filter((event) => scripts[event])
if (events.length === 0) process.exit(0)

const nodeModulesDir = findNodeModules(pkgDir)
const binDir = path.join(nodeModulesDir, '.bin')
setUpBins()

for (const event of events) {
  const result = spawnSync('sh', ['-c', scripts[event]], {
    cwd: pkgDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      HOME: process.env.TMPDIR ?? '/tmp',
      PATH: `${binDir}:${path.dirname(process.execPath)}:${process.env.PATH}`,
      npm_lifecycle_event: event,
      npm_package_name: manifest.name,
      npm_package_version: manifest.version,
      INIT_CWD: pkgDir,
    },
  })
  if (result.status !== 0) {
    console.error(`lifecycle script ${event} of ${manifest.name} failed with exit code ${result.status}`)
    process.exit(result.status || 1)
  }
}

function findNodeModules (dir) {
  while (path.basename(dir) !== 'node_modules') {
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error(`${pkgDir} is not inside a node_modules directory`)
    dir = parent
  }
  return dir
}

function setUpBins () {
  fs.mkdirSync(binDir, { recursive: true })
  for (const entry of listPackages(nodeModulesDir)) {
    const depManifest = readJson(path.join(nodeModulesDir, entry, 'package.json'))
    if (depManifest == null) continue
    const bins = typeof depManifest.bin === 'string'
      ? { [path.basename(depManifest.name ?? entry)]: depManifest.bin }
      : (depManifest.bin ?? {})
    for (const [binName, rel] of Object.entries(bins)) {
      const wrapper = path.join(binDir, binName)
      if (fs.existsSync(wrapper)) continue
      const target = path.resolve(nodeModulesDir, entry, rel)
      // ponytail: assumes node bins; /usr/bin/env is absent in the sandbox so
      // shebangs cannot resolve — wrap with the running node instead.
      fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${shQuote(process.execPath)} ${shQuote(target)} "$@"\n`, { mode: 0o755 })
    }
  }
}

function listPackages (dir) {
  const result = []
  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith('.')) continue
    if (entry.startsWith('@')) {
      for (const sub of fs.readdirSync(path.join(dir, entry))) {
        result.push(`${entry}/${sub}`)
      }
    } else {
      result.push(entry)
    }
  }
  return result
}

function readJson (file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function shQuote (value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}
