import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { materialize } from '../src/index.js'
import { makeTarball, serveTarballs } from './helpers.js'

const hasNix = spawnSync('nix-build', ['--version'], { stdio: 'ignore' }).status === 0

let workDir
let server
let nodes
let netNode
let ruleNodes
let onnetNode

before(async () => {
  if (!hasNix) return
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nix-provider-test-'))
  process.env.PNPM_NIX_CACHE_DIR = path.join(workDir, 'cache')
  const tarballs = {}
  server = await serveTarballs(tarballs)
  const addPkg = (manifest, files) => {
    const { buf, integrity } = makeTarball(workDir, manifest, files)
    const urlPath = `/${manifest.name.replace('/', '-')}-${manifest.version}.tgz`
    tarballs[urlPath] = buf
    return { urlPath, integrity }
  }
  const pkgs = {
    a: addPkg({ name: 'a', version: '1.0.0' }),
    b: addPkg({ name: 'b', version: '1.0.0' }),
    c: addPkg({ name: 'c', version: '1.0.0' }),
    d: addPkg({ name: '@scope/d', version: '1.0.0' }),
    e: addPkg({
      name: 'e',
      version: '1.0.0',
      scripts: { postinstall: 'f-cli' },
    }),
    f: addPkg(
      { name: 'f', version: '1.0.0', bin: { 'f-cli': './cli.js' } },
      { 'cli.js': 'require("fs").writeFileSync("ran-f-cli.txt", process.cwd())\n' }
    ),
    // needs network during postinstall — only works in impure mode
    net: addPkg({
      name: 'net',
      version: '1.0.0',
      scripts: { postinstall: `node -e "fetch('${server.baseUrl}/ping').then((r) => r.text()).then((t) => require('fs').writeFileSync('net.txt', t))"` },
    }),
    // needs a tool that only a build rule can provide
    tool: addPkg({
      name: 'tool',
      version: '1.0.0',
      scripts: { postinstall: 'hello > used-hello.txt' },
    }),
    // reads an env var that only a build rule can set
    envy: addPkg({
      name: 'envy',
      version: '1.0.0',
      scripts: { postinstall: 'node -e "require(\'fs\').writeFileSync(\'env.txt\', process.env.MY_RULE_VAR || \'missing\')"' },
    }),
    // script-bearing dependent of the host-built net package
    onnet: addPkg({
      name: 'onnet',
      version: '1.0.0',
      scripts: { postinstall: 'node -e "require(\'fs\').writeFileSync(\'built.txt\', \'ok\')"' },
    }),
  }
  tarballs['/ping'] = Buffer.from('pong')
  const rulesFile = path.join(workDir, 'rules.json')
  fs.writeFileSync(rulesFile, JSON.stringify({
    tool: { extraInputs: ['hello'] },
    envy: { env: { MY_RULE_VAR: 'from-rule' } },
  }))
  process.env.PNPM_NIX_RULES = rulesFile
  const dep = (depPath, name) => ({ depPath, name })
  const mkNode = (pkg, name, version, deps = {}) => ({
    name,
    version,
    tarball: `${server.baseUrl}${pkg.urlPath}`,
    integrity: pkg.integrity,
    deps,
    engine: 'test-engine',
  })
  nodes = {
    'a@1.0.0': mkNode(pkgs.a, 'a', '1.0.0', {
      b: dep('b@1.0.0', 'b'),
      'c-alias': dep('c@1.0.0', 'c'),
      '@scope/d': dep('@scope/d@1.0.0', '@scope/d'),
    }),
    // b <-> c form a dependency cycle
    'b@1.0.0': mkNode(pkgs.b, 'b', '1.0.0', { c: dep('c@1.0.0', 'c') }),
    'c@1.0.0': mkNode(pkgs.c, 'c', '1.0.0', { b: dep('b@1.0.0', 'b') }),
    '@scope/d@1.0.0': mkNode(pkgs.d, '@scope/d', '1.0.0'),
    'e@1.0.0': mkNode(pkgs.e, 'e', '1.0.0', { f: dep('f@1.0.0', 'f') }),
    'f@1.0.0': mkNode(pkgs.f, 'f', '1.0.0'),
  }
  netNode = mkNode(pkgs.net, 'net', '1.0.0')
  ruleNodes = {
    'tool@1.0.0': mkNode(pkgs.tool, 'tool', '1.0.0'),
    'envy@1.0.0': mkNode(pkgs.envy, 'envy', '1.0.0'),
  }
  onnetNode = mkNode(pkgs.onnet, 'onnet', '1.0.0', { net: dep('net@1.0.0', 'net') })
})

after(async () => {
  await server?.close()
})

test('materializes a graph with aliases, scopes, cycles, and lifecycle scripts', { skip: !hasNix }, async () => {
  const gcRootDir = path.join(workDir, 'gc-roots')
  const { paths } = await materialize({ protocol: 1, gcRootDir, nodes })

  for (const depPath of Object.keys(nodes)) {
    assert.ok(paths[depPath]?.startsWith('/nix/store/'), `missing path for ${depPath}`)
  }

  const pkgJson = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const aModules = path.join(paths['a@1.0.0'], 'node_modules')
  assert.equal(pkgJson(path.join(aModules, 'a')).name, 'a')
  assert.equal(pkgJson(path.join(aModules, 'b')).name, 'b')
  assert.equal(pkgJson(path.join(aModules, 'c-alias')).name, 'c')
  assert.equal(pkgJson(path.join(aModules, '@scope/d')).name, '@scope/d')

  // the cycle members share one store path and can resolve each other
  assert.equal(path.dirname(paths['b@1.0.0']), path.dirname(paths['c@1.0.0']))
  assert.notEqual(paths['b@1.0.0'], paths['c@1.0.0'])
  assert.equal(pkgJson(path.join(paths['b@1.0.0'], 'node_modules', 'c')).name, 'c')
  assert.equal(pkgJson(path.join(paths['c@1.0.0'], 'node_modules', 'b')).name, 'b')

  // e's postinstall ran f's bin inside the build sandbox
  assert.ok(fs.existsSync(path.join(paths['e@1.0.0'], 'node_modules', 'e', 'ran-f-cli.txt')))

  // gc root protects the closure and doubles as the install record
  const anchor = fs.readlinkSync(path.join(gcRootDir, 'nix-gc-root'))
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(anchor, 'manifest.json'), 'utf8')), paths)

  // determinism: a second run resolves to identical paths
  const second = await materialize({ protocol: 1, gcRootDir, nodes })
  assert.deepEqual(second.paths, paths)
})

test('cli speaks the stdio protocol', { skip: !hasNix }, async () => {
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url))
  const request = JSON.stringify({ protocol: 1, nodes: { 'f@1.0.0': nodes['f@1.0.0'] } })
  const result = spawnSync(process.execPath, [cli], { input: request, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const response = JSON.parse(result.stdout)
  assert.equal(response.protocol, 1)
  assert.ok(response.paths['f@1.0.0'].startsWith('/nix/store/'))
})

test('patches are applied and participate in the input hash', { skip: !hasNix }, async () => {
  const mkPatch = (replacement) => [
    'diff --git a/index.js b/index.js',
    '--- a/index.js',
    '+++ b/index.js',
    '@@ -1 +1 @@',
    '-module.exports = "f"',
    `+module.exports = ${JSON.stringify(replacement)}`,
    '',
  ].join('\n')
  const patched = (content) => ({
    'f@1.0.0': { ...nodes['f@1.0.0'], patch: { content, hash: 'irrelevant' } },
  })

  const first = await materialize({ protocol: 1, nodes: patched(mkPatch('f-patched')) })
  const index = fs.readFileSync(path.join(first.paths['f@1.0.0'], 'node_modules', 'f', 'index.js'), 'utf8')
  assert.match(index, /f-patched/)

  const unpatched = await materialize({ protocol: 1, nodes: { 'f@1.0.0': nodes['f@1.0.0'] } })
  const changed = await materialize({ protocol: 1, nodes: patched(mkPatch('f-other')) })
  assert.notEqual(first.paths['f@1.0.0'], unpatched.paths['f@1.0.0'])
  assert.notEqual(first.paths['f@1.0.0'], changed.paths['f@1.0.0'])
})

test('aborts on a bad integrity hash', { skip: !hasNix }, async () => {
  const bad = {
    'a@1.0.0': {
      ...nodes['a@1.0.0'],
      deps: {},
      integrity: 'sha512-' + Buffer.alloc(64).toString('base64'),
    },
  }
  await assert.rejects(materialize({ protocol: 1, nodes: bad }), /exited with code/)
})

test('rejects unknown protocol versions', async () => {
  await assert.rejects(materialize({ protocol: 2, nodes: {} }), /unsupported protocol/)
})

test('impure mode builds on the host with network access, keeping the script-free closure pure', { skip: !hasNix }, async () => {
  const gcRootDir = path.join(workDir, 'gc-roots-impure')
  const request = { protocol: 1, impure: true, gcRootDir, nodes: { ...nodes, 'net@1.0.0': netNode } }
  const { paths } = await materialize(request)

  // the network-fetching postinstall succeeded (it would fail in the sandbox)
  assert.equal(fs.readFileSync(path.join(paths['net@1.0.0'], 'node_modules', 'net', 'net.txt'), 'utf8'), 'pong')
  // e's postinstall ran f's bin on the host
  assert.ok(fs.existsSync(path.join(paths['e@1.0.0'], 'node_modules', 'e', 'ran-f-cli.txt')))

  // script-free packages build as the same pure derivations as pure mode,
  // and e's sandbox attempt succeeds so it stays pure too
  const pure = await materialize({ protocol: 1, nodes })
  assert.equal(paths['a@1.0.0'], pure.paths['a@1.0.0'])
  assert.equal(paths['f@1.0.0'], pure.paths['f@1.0.0'])
  assert.equal(paths['e@1.0.0'], pure.paths['e@1.0.0'])

  // cycle members and scoped deps still resolve from the host-assembled dirs
  assert.ok(fs.existsSync(path.join(paths['b@1.0.0'], 'node_modules', 'c', 'package.json')))
  assert.ok(fs.existsSync(path.join(paths['a@1.0.0'], 'node_modules', '@scope/d', 'package.json')))

  // one gc root protects the mixed pure/host-built set
  const anchor = fs.readlinkSync(path.join(gcRootDir, 'nix-gc-root'))
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(anchor, 'manifest.json'), 'utf8')), paths)

  // repeat run reuses the host-built paths through the cache
  const again = await materialize(request)
  assert.deepEqual(again.paths, paths)
})

test('build rules let script packages build purely in impure mode', { skip: !hasNix }, async () => {
  const request = { protocol: 1, impure: true, nodes: ruleNodes }
  const { paths } = await materialize(request)

  const toolDir = path.join(paths['tool@1.0.0'], 'node_modules', 'tool')
  assert.match(fs.readFileSync(path.join(toolDir, 'used-hello.txt'), 'utf8'), /Hello/)
  const envyDir = path.join(paths['envy@1.0.0'], 'node_modules', 'envy')
  assert.equal(fs.readFileSync(path.join(envyDir, 'env.txt'), 'utf8'), 'from-rule')

  // identical to a pure-mode build with the same rules — no host fallback ran
  const pure = await materialize({ protocol: 1, nodes: ruleNodes })
  assert.deepEqual(pure.paths, paths)
})

test('pure dependents build in the sandbox on top of pinned host-built deps', { skip: !hasNix }, async () => {
  const request = {
    protocol: 1,
    impure: true,
    nodes: { 'net@1.0.0': netNode, 'onnet@1.0.0': onnetNode },
  }
  const { paths } = await materialize(request)

  assert.equal(fs.readFileSync(path.join(paths['net@1.0.0'], 'node_modules', 'net', 'net.txt'), 'utf8'), 'pong')
  assert.ok(fs.existsSync(path.join(paths['onnet@1.0.0'], 'node_modules', 'onnet', 'built.txt')))
  assert.equal(
    fs.realpathSync(path.join(paths['onnet@1.0.0'], 'node_modules', 'net')),
    fs.realpathSync(path.join(paths['net@1.0.0'], 'node_modules', 'net'))
  )

  // net was host-added (no deriver); onnet is a genuine derivation output
  const deriverOf = (pkgPath) =>
    spawnSync('nix-store', ['-q', '--deriver', path.dirname(pkgPath)], { encoding: 'utf8' }).stdout.trim()
  assert.ok(!deriverOf(paths['net@1.0.0']).endsWith('.drv'))
  assert.ok(deriverOf(paths['onnet@1.0.0']).endsWith('.drv'))
})
