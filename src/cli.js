#!/usr/bin/env node
import { materialize } from './index.js'

const chunks = []
process.stdin.on('data', (chunk) => chunks.push(chunk))
process.stdin.on('end', () => {
  void main(Buffer.concat(chunks).toString())
})

async function main (input) {
  try {
    const request = JSON.parse(input)
    const response = await materialize(request)
    process.stdout.write(JSON.stringify(response))
  } catch (err) {
    process.stderr.write(`pnpm-nix-provider: ${err.message}\n`)
    process.exit(1)
  }
}
