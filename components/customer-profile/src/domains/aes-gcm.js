import { createDecipheriv, createHash } from 'node:crypto'

const IV_BYTES = 12
const TAG_BYTES = 16

/**
 * 与 OMS 的 AESGCMEncrypt 保持一致：SHA-256(配置密钥) 作为 AES-256 密钥，
 * Base64 密文前 12 字节为 GCM IV，尾 16 字节为认证标签。
 */
function keyBytes(secret) {
  return createHash('sha256').update(secret, 'utf8').digest()
}

function looksLikeOmsCiphertext(value) {
  return typeof value === 'string'
    && value.length >= 40
    && value.length % 4 === 0
    && /^[A-Za-z0-9+/]+={0,2}$/.test(value)
}

/** 解密失败时不抛出，也绝不把疑似密文作为客户资料返回。 */
export function decryptOmsText(value, secret) {
  if (value == null || value === '') return null
  const text = String(value)
  if (!looksLikeOmsCiphertext(text)) return text
  if (typeof secret !== 'string' || secret.length === 0) return null
  try {
    const payload = Buffer.from(text, 'base64')
    if (payload.length <= IV_BYTES + TAG_BYTES) return null
    const ciphertext = payload.subarray(IV_BYTES, -TAG_BYTES)
    const tag = payload.subarray(-TAG_BYTES)
    const decipher = createDecipheriv('aes-256-gcm', keyBytes(secret), payload.subarray(0, IV_BYTES))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}
