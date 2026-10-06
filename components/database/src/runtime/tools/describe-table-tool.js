import { describeDatabaseTable, normalizeTableName } from '../../domains/table-schema.js'
import { configPath, readConfig } from '../../storage/config-store.js'
import { errorKind } from '../../security/query-audit.js'

function hasDatabaseConfig(config) {
  return Boolean(config?.host && config?.port && config?.database && config?.username && config?.password)
}

export function createDescribeTableTool({ dataDirectory, describeTable = describeDatabaseTable, auditLogger }) {
  return {
    name: 'database_describe_table',
    description: '只读查看当前数据库中指定数据表的字段结构：字段名、类型、是否可空、键标记和字段备注；不读取任何业务记录，也不接受 SQL。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['table'],
      properties: {
        table: { type: 'string', minLength: 1, maxLength: 64, description: '要查看结构的数据表名称。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['table', 'total', 'columns'],
        properties: {
          table: { type: 'string' },
          total: { type: 'number', description: '字段数量。' },
          columns: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'type', 'nullable', 'key', 'comment'],
              properties: {
                name: { type: 'string' },
                type: { type: 'string' },
                nullable: { type: 'boolean' },
                key: { type: 'string', description: 'MySQL COLUMN_KEY，例如 PRI、UNI、MUL；空字符串表示未标记。' },
                comment: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.total === 0
            ? `数据表 ${value.table} 未返回字段结构。`
            : [`数据表 ${value.table} 共有 ${value.total} 个字段：`, ...value.columns.map(column => `- ${column.name}：${column.type}；${column.nullable ? '可为空' : '不可为空'}；${column.key || '无键标记'}；${column.comment}`)].join('\n'),
        },
      ],
    },
    async execute(args, exec) {
      const startedAt = Date.now()
      let table
      if (exec?.signal?.aborted) throw new Error('数据表结构查询已取消。')
      const config = await readConfig(dataDirectory)
      if (!hasDatabaseConfig(config)) {
        throw new Error(`请先在数据库设置页保存完整连接信息。配置文件位置：${configPath(dataDirectory)}`)
      }
      try {
        table = normalizeTableName(args?.table)
        const result = await describeTable(config, table, { signal: exec?.signal })
        auditLogger?.record({
          operation: 'describe_table', status: 'success', table: result.table, columnCount: result.columns.length,
          durationMs: Math.max(0, Date.now() - startedAt),
        })
        return result
      } catch (error) {
        auditLogger?.record({
          operation: 'describe_table', status: 'error', ...(table ? { table } : {}),
          errorKind: errorKind(error), durationMs: Math.max(0, Date.now() - startedAt),
        })
        if (exec?.signal?.aborted) throw new Error('数据表结构查询已取消。')
        throw new Error('无法读取数据表结构，请检查表名、数据库设置、网络和只读账号权限。')
      }
    },
  }
}

export function registerDescribeTableTool(ctx, options) {
  return ctx.tools.register(createDescribeTableTool(options))
}
