import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

/**
 * Creates an npm-style tarball (files under a package/ prefix) and returns
 * { buf, integrity }.
 */
export function makeTarball (workDir, manifest, files = {}) {
  const root = fs.mkdtempSync(path.join(workDir, 'tarball-'))
  const pkgDir = path.join(root, 'package')
  fs.mkdirSync(pkgDir)
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(manifest))
  for (const [name, content] of Object.entries({ 'index.js': `module.exports = ${JSON.stringify(manifest.name)}\n`, ...files })) {
    fs.mkdirSync(path.dirname(path.join(pkgDir, name)), { recursive: true })
    fs.writeFileSync(path.join(pkgDir, name), content)
  }
  const tarPath = path.join(root, 'package.tgz')
  execFileSync('tar', ['-czf', tarPath, '-C', root, 'package'])
  const buf = fs.readFileSync(tarPath)
  const integrity = `sha512-${crypto.createHash('sha512').update(buf).digest('base64')}`
  return { buf, integrity }
}

/** Serves { '/url-path': Buffer } over localhost; returns { baseUrl, close }. */
export async function serveTarballs (tarballs) {
  const server = http.createServer((req, res) => {
    const buf = tarballs[req.url]
    if (buf == null) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.end(buf)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
