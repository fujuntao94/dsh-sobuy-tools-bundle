import { readFile, writeFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const rootPackage = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const childManifests = [
  new URL('components/feishu/package.json', root),
  new URL('components/database/package.json', root),
  new URL('components/customer-profile/package.json', root),
  new URL('packages/sobuy-plugin-core/package.json', root),
]

for (const manifestUrl of childManifests) {
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'))
  if (manifest.version !== rootPackage.version) {
    manifest.version = rootPackage.version
    await writeFile(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`)
  }
}

console.log(`已同步飞书、数据库、客户画像与公共层版本为 ${rootPackage.version}。`)
