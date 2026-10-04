/** macOS Keychain 凭据存储；测试和非 macOS 平台保留私有文件兼容模式。 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'

const execFileAsync = promisify(execFile)
// 保留既有钥匙串标识，避免品牌重命名后已保存的凭据失效。
const ACCOUNT = 'dsh-feishu-tools'
const SERVICE_PREFIX = 'dsh-feishu-tools:'

function enabled() {
  return process.platform === 'darwin'
    && process.env.DSH_FEISHU_KEYCHAIN !== '0'
    && !process.argv.includes('--test')
    && !process.env.NODE_TEST_CONTEXT
}

async function run(args, ignoreMissing = false) {
  try {
    return await execFileAsync('security', args, { encoding: 'utf8', maxBuffer: 16 * 1024 })
  } catch (error) {
    if (ignoreMissing && /could not be found/i.test(error.stderr || '')) return undefined
    throw new Error(`无法访问 macOS 钥匙串：${error.stderr || error.message}`)
  }
}

function service(key, namespace = 'default') {
  const suffix = createHash('sha256').update(namespace).digest('hex').slice(0, 16)
  return `${SERVICE_PREFIX}${suffix}:${key}`
}

export async function readVaultSecret(key, namespace) {
  if (!enabled()) return undefined
  const result = await run(['find-generic-password', '-a', ACCOUNT, '-s', service(key, namespace), '-w'], true)
  return result?.stdout?.trim() || undefined
}

export async function writeVaultSecret(key, value, namespace) {
  if (!enabled() || !value) return false
  await run(['add-generic-password', '-U', '-a', ACCOUNT, '-s', service(key, namespace), '-w', value])
  return true
}

export async function removeVaultSecret(key, namespace) {
  if (!enabled()) return false
  await run(['delete-generic-password', '-a', ACCOUNT, '-s', service(key, namespace)], true)
  return true
}

export function isVaultEnabled() {
  return enabled()
}
