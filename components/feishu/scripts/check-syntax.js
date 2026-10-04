import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map(async entry => {
    const file = resolve(directory, entry.name)
    if (entry.isDirectory()) return filesIn(file)
    return entry.isFile() && entry.name.endsWith('.js') ? [file] : []
  }))
  return files.flat()
}

const files = ['index.js', ...(await filesIn(resolve('src')))]
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status || 1)
}
