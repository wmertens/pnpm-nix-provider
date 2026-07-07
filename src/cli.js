#!/usr/bin/env node
import { materialize } from './index.js'

const flags = new Set(process.argv.slice(2))

const chunks = []
process.stdin.on('data', (chunk) => chunks.push(chunk))
process.stdin.on('end', () => {
  void main(Buffer.concat(chunks).toString())
})

async function main (input) {
  try {
    const request = JSON.parse(input)
    if (flags.has('--impure')) request.impure = true
    if (flags.has('--rebuild')) request.rebuild = true
    if (flags.has('--check')) request.check = true
    const response = await materialize(request)
    process.stdout.write(JSON.stringify(response))
  } catch (err) {
    process.stderr.write(`pnpm-nix-provider: ${err.message}\n`)
    process.exit(1)
  }
}
