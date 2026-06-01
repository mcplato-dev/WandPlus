#!/usr/bin/env node
'use strict'
const fs = require('fs/promises')
const path = require('path')

function emit(passed, hint) {
  console.log(JSON.stringify(hint ? { passed, hint } : { passed }))
  process.exit(0)
}

;(async () => {
  try {
    const dir = path.join(process.env.WAND_DIR, 'entries')
    let files
    try {
      files = await fs.readdir(dir)
    } catch {
      return emit(false, 'No entries/ directory yet. Write at least one entry first.')
    }
    const md = files.filter((f) => f.endsWith('.md'))
    if (md.length === 0) {
      return emit(false, 'No .md files in entries/. Add at least one change entry.')
    }
    for (const f of md) {
      const text = await fs.readFile(path.join(dir, f), 'utf8')
      if (text.trim().length > 0) return emit(true)
    }
    emit(false, 'entries/ files are all empty. Add at least one change line.')
  } catch (err) {
    emit(false, `collect check error: ${err.message}`)
  }
})()
