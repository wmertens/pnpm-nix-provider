import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildSpec, computeSccs } from '../src/groups.js'

const node = (name, deps = {}) => ({
  name,
  version: '1.0.0',
  tarball: `https://example.com/${name}.tgz`,
  integrity: 'sha512-xxx',
  deps: Object.fromEntries(Object.entries(deps).map(([alias, depPath]) => [alias, { depPath, name: depPath.split('@')[0] || depPath }])),
})

test('acyclic graph yields singleton groups', () => {
  const nodes = {
    'a@1.0.0': node('a', { b: 'b@1.0.0' }),
    'b@1.0.0': node('b', { c: 'c@1.0.0' }),
    'c@1.0.0': node('c'),
  }
  const sccs = computeSccs(nodes)
  assert.equal(sccs.length, 3)
  for (const scc of sccs) assert.equal(scc.length, 1)
})

test('cycles are grouped, self-deps ignored', () => {
  const nodes = {
    'a@1.0.0': node('a', { b: 'b@1.0.0' }),
    'b@1.0.0': node('b', { c: 'c@1.0.0', b: 'b@1.0.0' }),
    'c@1.0.0': node('c', { b: 'b@1.0.0' }),
  }
  const spec = buildSpec(nodes)
  assert.equal(spec.memberOf['b@1.0.0'], spec.memberOf['c@1.0.0'])
  assert.notEqual(spec.memberOf['a@1.0.0'], spec.memberOf['b@1.0.0'])
  const cycleGroup = spec.groups[spec.memberOf['b@1.0.0']]
  assert.deepEqual(cycleGroup.members, ['b@1.0.0', 'c@1.0.0'])
  assert.match(cycleGroup.drvName, /-cycle$/)
})

test('long chains do not overflow the stack', () => {
  const nodes = {}
  for (let i = 0; i < 50000; i++) {
    nodes[`p${i}@1.0.0`] = node(`p${i}`, i < 49999 ? { dep: `p${i + 1}@1.0.0` } : {})
  }
  assert.equal(computeSccs(nodes).length, 50000)
})

test('drvName and subdir are sanitized', () => {
  const nodes = {
    '@scope/a@1.0.0(peer@2.0.0)': { ...node('@scope/a'), deps: {} },
  }
  const spec = buildSpec(nodes)
  const group = spec.groups['@scope/a@1.0.0(peer@2.0.0)']
  assert.match(group.drvName, /^[A-Za-z0-9+._?=-]+$/)
  assert.ok(!group.drvName.startsWith('.') && !group.drvName.startsWith('-'))
  assert.match(spec.subdir['@scope/a@1.0.0(peer@2.0.0)'], /^[A-Za-z0-9._@+-]+$/)
})

test('rejects deps outside the batch', () => {
  const nodes = { 'a@1.0.0': node('a', { b: 'b@1.0.0' }) }
  assert.throws(() => buildSpec(nodes), /not in the request/)
})

test('rejects nodes without a tarball resolution', () => {
  const nodes = { 'a@1.0.0': { name: 'a', version: '1.0.0', deps: {} } }
  assert.throws(() => buildSpec(nodes), /tarball\+integrity/)
})
