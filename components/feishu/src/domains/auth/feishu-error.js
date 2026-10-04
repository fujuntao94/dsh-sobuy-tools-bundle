/** 飞书错误的统一分类；message 保留飞书原文，分类只用于日志与诊断。 */
export class FeishuApiError extends Error {
  constructor({ message, kind = 'api', code, status }) {
    super(message)
    this.name = 'FeishuApiError'
    this.kind = kind
    if (code !== undefined) this.code = String(code)
    if (status !== undefined) this.status = Number(status)
  }
}

function classify({ code, status, message }) {
  const text = String(message || '').toLowerCase()
  if (status === 401 || /access.?token|token.*expired|unauthori[sz]ed|登录已过期/.test(text)) return 'authentication'
  if (status === 403 || /permission|scope|authority|权限/.test(text)) return 'permission'
  if (status === 404 || /not exists|not found|不存在/.test(text)) return 'not_found'
  if (status === 429 || /rate.?limit|too many|频率/.test(text)) return 'rate_limited'
  if (/abort|cancel/.test(text)) return 'cancelled'
  if (/econn|enotfound|timeout|network|socket/.test(text)) return 'network'
  return code ? 'api' : 'unknown'
}

/** 把 SDK/Axios/飞书业务错误压缩为不会携带请求配置或凭据的 Error。 */
export function toFeishuApiError(error, fallbackMessage) {
  if (error instanceof FeishuApiError) return error
  const payload = error?.response?.data || {}
  const code = payload.code ?? error?.code
  const status = error?.response?.status ?? error?.status ?? error?.statusCode
  const message = payload.error_description || payload.msg || payload.message || error?.errorDescription || error?.msg || error?.message || fallbackMessage
  return new FeishuApiError({ message, kind: classify({ code, status, message }), code, status })
}

/** 仅用于脱敏诊断记录，绝不把 SDK 原始 error/config 写入日志。 */
export function feishuErrorDiagnostic(error) {
  const safe = toFeishuApiError(error, '飞书请求失败')
  return {
    kind: safe.kind,
    ...(safe.code ? { code: safe.code } : {}),
    ...(Number.isFinite(safe.status) ? { status: safe.status } : {}),
  }
}
