/**
 * 数据库凭据的独立私有存储层。
 *
 * 数据库配置不复用飞书目录或 OAuth 登录态，避免两个组件互相覆盖凭据。
 */
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export function defaultDataDirectory() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'database-tools')
}

export function configPath(dataDirectory = defaultDataDirectory()) {
  return join(dataDirectory, 'config.json')
}

export async function readConfig(dataDirectory = defaultDataDirectory()) {
  const file = configPath(dataDirectory)
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw new Error(`无法读取数据库配置 ${file}：${error.message}`)
  }
}

/** 以 0700 目录、0600 文件权限原子保存数据库配置。 */
export async function writePrivateConfig(value, dataDirectory = defaultDataDirectory()) {
  const file = configPath(dataDirectory)
  const folder = dirname(file)
  await mkdir(folder, { recursive: true, mode: 0o700 })
  await chmod(folder, 0o700)
  const temporary = join(folder, `.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, file)
    await chmod(file, 0o600)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}
