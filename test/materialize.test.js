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

before(async () => {
  if (!hasNix) return
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nix-provider-test-'))
  const tarballs = {}
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
  }
  server = await serveTarballs(tarballs)
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
