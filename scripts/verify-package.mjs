import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const archive = join(root, 'dist', `${manifest.name}-${manifest.version}.tgz`)
await access(archive)

const entries = new Set(execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n'))
const requiredEntries = [
  'package/index.js',
  'package/cordis.patch.yml',
  'package/components/feishu/index.js',
  'package/components/feishu/client.js',
  'package/components/database/index.js',
  'package/components/database/client.js',
  'package/packages/sobuy-plugin-core/src/http/local-setup-server.js',
  'package/packages/sobuy-plugin-core/src/storage/private-json.js',
]
for (const entry of requiredEntries) {
  assert(entries.has(entry), `发布包缺少 ${entry}`)
}
assert(!entries.has('package/feishu/package.json'), '发布包不应再包含旧的 /feishu 重复组件')
assert(!entries.has('package/database/package.json'), '发布包不应再包含旧的 /database 重复组件')

function readPackedJson(entry) {
  return JSON.parse(execFileSync('tar', ['-xOzf', archive, entry], { encoding: 'utf8' }))
}

const feishu = readPackedJson('package/components/feishu/package.json')
const database = readPackedJson('package/components/database/package.json')
const core = readPackedJson('package/packages/sobuy-plugin-core/package.json')
for (const child of [feishu, database, core]) {
  assert.equal(child.version, manifest.version, `${child.name} 版本未与总包同步`)
}
assert.equal(feishu.dependencies['sobuy-plugin-core'], 'file:../../packages/sobuy-plugin-core')
assert.equal(database.dependencies['sobuy-plugin-core'], 'file:../../packages/sobuy-plugin-core')
assert.equal(core.dsh, undefined, '公共层不能声明为 DeepSeek 组件')

// 在空目录离线安装，验证嵌套 file: 依赖可随 tgz 一同解析，不依赖工作区 symlink。
const installRoot = await mkdtemp(join(tmpdir(), 'sobuy-package-verify-'))
try {
  const install = spawnSync('npm', [
    'install', '--prefix', installRoot, '--ignore-scripts', '--no-package-lock', '--no-save', '--offline', archive,
  ], { encoding: 'utf8' })
  assert.equal(install.status, 0, `发布包离线安装失败：${install.stderr || install.stdout}`)

  const nodeModules = join(installRoot, 'node_modules')
  const imports = [
    pathToFileURL(join(nodeModules, 'sobuy-feishu-tools', 'index.js')).href,
    pathToFileURL(join(nodeModules, 'sobuy-database-tools', 'index.js')).href,
  ]
  const importCheck = spawnSync(process.execPath, ['--input-type=module', '--eval', `await Promise.all(${JSON.stringify(imports)}.map(value => import(value)))`], {
    cwd: installRoot,
    encoding: 'utf8',
  })
  assert.equal(importCheck.status, 0, `发布包组件导入失败：${importCheck.stderr || importCheck.stdout}`)
} finally {
  await rm(installRoot, { recursive: true, force: true })
}

console.log(`发布包结构校验通过：${archive}`)
