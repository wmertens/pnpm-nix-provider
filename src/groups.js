import path from 'node:path'

/**
 * Nix store paths cannot reference each other cyclically, so every strongly
 * connected component of the dependency graph is materialized as one store
 * path holding all of its members side by side.
 */
export function buildSpec (nodes) {
  validateNodes(nodes)
  const groups = {}
  const memberOf = {}
  const subdir = {}
  // Tarjan emits SCCs dependencies-first; keep that order for host builds.
  const groupOrder = []
  for (const scc of computeSccs(nodes)) {
    const members = [...scc].sort()
    const groupKey = members[0]
    groupOrder.push(groupKey)
    const first = nodes[groupKey]
    const base = sanitizeDrvName(`${first.name}-${first.version}`)
    groups[groupKey] = {
      drvName: members.length > 1 ? `${base}-cycle` : base,
      members,
    }
    const seenSubdirs = new Set()
    for (const depPath of members) {
      memberOf[depPath] = groupKey
      subdir[depPath] = sanitizeSubdir(depPath)
      if (seenSubdirs.has(subdir[depPath])) {
        throw new Error(`subdirectory name collision inside cycle group ${groupKey}: ${subdir[depPath]}`)
      }
      seenSubdirs.add(subdir[depPath])
    }
  }
  return { nodes, groups, memberOf, subdir, groupOrder }
}

function validateNodes (nodes) {
  for (const [depPath, node] of Object.entries(nodes)) {
    if (!node.name || !node.version) {
      throw new Error(`node ${depPath} is missing name or version`)
    }
    const hasTarball = Boolean(node.tarball && node.integrity)
    const hasDirectory = typeof node.directory === 'string' && path.isAbsolute(node.directory)
    const hasGit = Boolean(node.git?.repo && node.git?.commit)
    if (!hasTarball && !hasDirectory && !hasGit) {
      throw new Error(`node ${depPath} has no supported resolution (registry tarball+integrity, absolute directory, or git repo+commit)`)
    }
    for (const [alias, dep] of Object.entries(node.deps ?? {})) {
      if (nodes[dep.depPath] == null) {
        throw new Error(`node ${depPath} depends on ${alias} -> ${dep.depPath}, which is not in the request; the batch must be a closed graph`)
      }
    }
  }
}

// Tarjan's algorithm, iterative — dependency chains can exceed the JS stack.
export function computeSccs (nodes) {
  const index = new Map()
  const low = new Map()
  const onStack = new Set()
  const stack = []
  const sccs = []
  let counter = 0
  const childrenOf = (key) => Object.values(nodes[key].deps ?? {})
    .map((dep) => dep.depPath)
    .filter((depPath) => depPath !== key && nodes[depPath] != null)

  for (const root of Object.keys(nodes)) {
    if (index.has(root)) continue
    visit(root)
    const frames = [{ key: root, i: 0, children: childrenOf(root) }]
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]
      if (frame.i < frame.children.length) {
        const child = frame.children[frame.i++]
        if (!index.has(child)) {
          visit(child)
          frames.push({ key: child, i: 0, children: childrenOf(child) })
        } else if (onStack.has(child)) {
          low.set(frame.key, Math.min(low.get(frame.key), index.get(child)))
        }
      } else {
        frames.pop()
        const parent = frames[frames.length - 1]
        if (parent != null) {
          low.set(parent.key, Math.min(low.get(parent.key), low.get(frame.key)))
        }
        if (low.get(frame.key) === index.get(frame.key)) {
          const scc = []
          let popped
          do {
            popped = stack.pop()
            onStack.delete(popped)
            scc.push(popped)
          } while (popped !== frame.key)
          sccs.push(scc)
        }
      }
    }
  }
  return sccs

  function visit (key) {
    index.set(key, counter)
    low.set(key, counter)
    counter++
    stack.push(key)
    onStack.add(key)
  }
}

// Nix store names only allow [A-Za-z0-9+._?=-] and must not start with '.'.
function sanitizeDrvName (name) {
  return name.replace(/[^A-Za-z0-9+._?=-]/g, '-').replace(/^[.-]+/, '')
}

// Directory-per-member inside a group's store path; must be unique and
// filesystem-safe. depPaths only differ in [^A-Za-z0-9._@-] by punctuation,
// so a plain character substitution keeps them unique in practice (guarded
// by the collision check above).
function sanitizeSubdir (depPath) {
  return depPath.replace(/[^A-Za-z0-9._@-]/g, '+')
}
