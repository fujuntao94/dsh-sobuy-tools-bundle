/** 飞书响应的最小运行时校验，防止上游字段变化被误判为空数据。 */
export class FeishuResponseError extends Error {
  constructor(context, detail) {
    super(`${context}：飞书响应结构异常${detail ? `（${detail}）` : ''}`)
    this.name = 'FeishuResponseError'
    this.kind = 'invalid_response'
  }
}

export function requireObject(value, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FeishuResponseError(context, '应为对象')
  return value
}

export function optionalArray(value, context) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new FeishuResponseError(context, '应为数组')
  return value
}

export function requireString(value, context) {
  if (typeof value !== 'string' || !value) throw new FeishuResponseError(context, '缺少字符串字段')
  return value
}
