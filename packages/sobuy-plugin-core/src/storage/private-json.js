import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

/** 读取可选 JSON 文件；不存在代表尚未配置，其余读取或解析错误交给调用方说明业务语境。 */
export async function readOptionalJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/** 以 0700 目录、0600 文件权限原子写入 JSON，避免凭据文件半写入或被其他本机用户读取。 */
export async function writePrivateJson(file, value) {
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
