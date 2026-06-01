#!/usr/bin/env node
'use strict'
const fs = require('fs/promises')
const path = require('path')

function readStdin() {
  return new Promise((resolve) => {
    let raw = ''
    process.stdin.on('data', (c) => (raw += c))
    process.stdin.on('end', () => resolve(raw))
  })
}

function emit(passed, hint) {
  console.log(JSON.stringify(hint ? { passed, hint } : { passed }))
  process.exit(0)
}

;(async () => {
  try {
    const input = JSON.parse((await readStdin()) || '{}')
    const version = (input.args || {}).version
    if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
      return emit(false, 'Pass a semver version, e.g. CheckPhase({ version: "1.2.0" }).')
    }
    let body
    try {
      body = await fs.readFile(path.join(process.env.WAND_DIR, 'CHANGELOG.md'), 'utf8')
    } catch {
      return emit(false, 'CHANGELOG.md not found. Write it before checking.')
    }
    if (!body.includes(`## ${version}`)) {
      return emit(false, `CHANGELOG.md must contain a "## ${version}" heading.`)
    }
    emit(true)
  } catch (err) {
    emit(false, `publish check error: ${err.message}`)
  }
})()
