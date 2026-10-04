import { listDatabaseTables } from '../../domains/table-catalog.js'
import { configPath, readConfig } from '../../storage/config-store.js'
import { errorKind } from '../../security/query-audit.js'

function hasDatabaseConfig(config) {
  return Boolean(config?.host && config?.port && config?.database && config?.username && config?.password)
}

export function createListTablesTool({ dataDirectory, listTables = listDatabaseTables, auditLogger }) {
  return {
    name: 'database_list_tables',
    description: '只读统计当前配置数据库中的基础表，并返回表名和数据库表备注；不查询表字段或业务数据。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['total', 'tables'],
        properties: {
          total: { type: 'number', description: '基础表数量。' },
          tables: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'purpose'],
              properties: {
                name: { type: 'string', description: '数据表名称。' },
                purpose: { type: 'string', description: 'MySQL TABLE_COMMENT 表备注；未填写时返回固定提示。' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.total === 0
          ? '当前数据库共有 0 张数据表。'
          : [`当前数据库共有 ${value.total} 张数据表：`, ...value.tables.map(table => `- ${table.name}：${table.purpose}`)].join('\n'),
      }],
    },
    async execute(_args, exec) {
      const startedAt = Date.now()
      if (exec?.signal?.aborted) throw new Error('数据库表清单查询已取消。')
      const config = await readConfig(dataDirectory)
      if (!hasDatabaseConfig(config)) {
        throw new Error(`请先在数据库设置页保存完整连接信息。配置文件位置：${configPath(dataDirectory)}`)
      }
      try {
        const result = await listTables(config, { signal: exec?.signal })
        auditLogger?.record({
          operation: 'list_tables', status: 'success', rowCount: result.tables.length,
          durationMs: Math.max(0, Date.now() - startedAt),
        })
        return result
      } catch (error) {
        auditLogger?.record({
          operation: 'list_tables', status: 'error', errorKind: errorKind(error),
          durationMs: Math.max(0, Date.now() - startedAt),
        })
        if (exec?.signal?.aborted) throw new Error('数据库表清单查询已取消。')
        // 不把驱动错误原文返回模型，避免其中夹带主机、用户名或连接参数。
        throw new Error('无法读取数据库表清单，请检查数据库设置、网络和只读账号权限。')
      }
    },
  }
}

export function registerListTablesTool(ctx, options) {
  return ctx.tools.register(createListTablesTool(options))
}
