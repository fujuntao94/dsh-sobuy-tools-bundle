/**
 * 飞书 Tool 的会话关联操作日志。
 *
 * DSH 会持久记录 tool/call 与 tool/result；本 Service 补充的是便于排障的
 * 业务摘要。仅保留进程内最近记录，且绝不记录 token、Secret、授权码或原始响应。
 */
const MAX_RECORDS = 100
import { feishuErrorDiagnostic } from '../../domains/auth/feishu-error.js'

function sessionIdOf(exec) {
  const id = exec?.agent?.id
  return typeof id === 'string' && id ? id : 'unknown'
}

function redact(text) {
  return String(text)
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(access[_-]?token|refresh[_-]?token|tenant[_-]?access[_-]?token|app[_-]?secret|authorization[_-]?code|code)\b\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .slice(0, 300)
}

function errorSummary(error) {
  return redact(error instanceof Error ? error.message : error)
}

/**
 * 把内部记录转换为可显示的诊断摘要。
 * sessionId 与 callId 仅用于内部关联，不能进入 Tool 结果或浏览器面板。
 */
function createLogger(ctx) {
  // Cordis 的标准用法是 ctx.logger(name)。保留 fallback 方便旧运行时与单测。
  if (typeof ctx.logger === 'function') return ctx.logger('dsh-sobuy-feishu-tools')
  return ctx.logger
}

export function createOperationTelemetryService(ctx) {
  const records = []
  const logger = createLogger(ctx)
  let sequence = 0

  function append(record) {
    records.push(Object.freeze(record))
    if (records.length > MAX_RECORDS) records.shift()
  }

  function write(level, record) {
    // 日志 sink 缺失不影响 Tool 正常执行；内存记录仍可由诊断 Tool 查看。
    logger?.[level]?.(JSON.stringify(record))
  }

  return {
    async run({ tool, exec }, work, summarize = () => ({})) {
      const startedAt = Date.now()
      const operationId = `${startedAt.toString(36)}-${(++sequence).toString(36)}`
      const sessionId = sessionIdOf(exec)
      const callId = typeof exec?.callId === 'string' ? exec.callId : undefined
      write('info', { event: 'start', operationId, sessionId, tool })
      try {
        const value = await work()
        const record = {
          ...(callId ? { callId } : {}),
          operationId,
          sessionId,
          tool,
          status: 'success',
          startedAt,
          durationMs: Date.now() - startedAt,
          summary: summarize(value),
        }
        append(record)
        write('info', { event: 'success', ...record })
        return value
      } catch (error) {
        const diagnostic = feishuErrorDiagnostic(error)
        const record = {
          ...(callId ? { callId } : {}),
          operationId,
          sessionId,
          tool,
          status: 'error',
          startedAt,
          durationMs: Date.now() - startedAt,
          errorKind: diagnostic.kind,
          ...(diagnostic.code ? { errorCode: diagnostic.code } : {}),
          ...(diagnostic.status ? { errorStatus: diagnostic.status } : {}),
          error: errorSummary(error),
        }
        append(record)
        write('warn', { event: 'error', ...record })
        throw error
      }
    },

    recent(exec) {
      const sessionId = sessionIdOf(exec)
      return records.filter(record => record.sessionId === sessionId)
    },

    summary(exec) {
      const operations = this.recent(exec)
      const failures = operations.filter(record => record.status === 'error')
      const success = operations.filter(record => record.status === 'success')
      return {
        total: operations.length,
        successCount: success.length,
        errorCount: failures.length,
        averageDurationMs: operations.length ? Math.round(operations.reduce((sum, record) => sum + record.durationMs, 0) / operations.length) : 0,
        ...(success.length ? { lastSuccessAt: Math.max(...success.map(record => record.startedAt)) } : {}),
        errorKinds: Object.fromEntries(failures.reduce((counts, record) => counts.set(record.errorKind || 'unknown', (counts.get(record.errorKind || 'unknown') || 0) + 1), new Map())),
      }
    },

    // Tool 本体可能尚未执行就被 DSH 的参数校验或其他策略拒绝；由 tools/result Hook 补记。
    captureFinalResult(exec, result) {
      const callId = typeof exec?.callId === 'string' ? exec.callId : undefined
      if (callId && records.some(record => record.callId === callId)) return
      const failed = result?.isError === true
      const record = {
        ...(callId ? { callId } : {}),
        operationId: callId || `hook-${Date.now().toString(36)}-${(++sequence).toString(36)}`,
        sessionId: sessionIdOf(exec),
        tool: exec?.name || 'unknown',
        status: failed ? 'error' : 'success',
        startedAt: Date.now(),
        durationMs: 0,
        summary: { source: 'tools/result' },
        ...(failed ? { error: 'Tool 在执行前被 DSH 拦截、校验失败或执行失败；请查看当前会话的标准 Tool 错误。' } : {}),
      }
      append(record)
      write(failed ? 'warn' : 'info', { event: 'final-result', ...record })
    },
  }
}

export function provideOperationTelemetryService(ctx) {
  const service = createOperationTelemetryService(ctx)
  ctx.provide('feishuTelemetry', service)
  return service
}
