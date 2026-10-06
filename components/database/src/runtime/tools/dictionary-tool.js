import {
  DICTIONARY_TABLES,
  MAX_DICTIONARY_ROWS,
  REASON_CODE_DICT_ID,
  runDictionaryLookup,
} from '../../domains/dictionary.js'
import { configPath, readConfig } from '../../storage/config-store.js'
import { errorKind } from '../../security/query-audit.js'
import { nullableSchema } from 'sobuy-plugin-core/schema'

function hasDatabaseConfig(config) {
  return Boolean(config?.host && config?.port && config?.database && config?.username && config?.password)
}

const NUMBER = { type: 'number' }
const STRING = { type: 'string' }

function entryLine(entry, index) {
  const tags = [
    entry.deprecated ? '已失效' : null,
    entry.enabled ? null : '未启用',
  ].filter(Boolean)
  const suffix = tags.length ? `（${tags.join('、')}）` : ''
  return `${index + 1}. [${entry.dictId} ${entry.dictName}] ${entry.dictValue} = ${entry.note || '（无说明）'}${suffix}`
}

function catalogLine(dictionary, index) {
  return `${index + 1}. ${dictionary.dictId} = ${dictionary.dictName}${dictionary.deprecated ? '（已失效）' : ''}`
}

export function createDictionaryTool({ dataDirectory, lookup = runDictionaryLookup, auditLogger } = {}) {
  return {
    name: 'database_dictionary_lookup',
    description: `只读查询订单库的字典表（bas_t_dict / bas_t_dict_values）。不传任何筛选条件时返回字典目录（有哪些字典、各自 dict_id）；传 dict_id 返回该字典的全部取值；也可按 dict_value 精确查或按 keyword 模糊搜。原因码（订单拦截原因 G 码，如 G17=缺货）在 dict_id=${REASON_CODE_DICT_ID}。自动过滤已失效项，可用 include_deprecated 打开。不接受 SQL。`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dict_id: {
          type: 'integer', minimum: 1,
          description: `字典 ID。留空则不限定字典。原因码字典是 ${REASON_CODE_DICT_ID}。`,
        },
        dict_value: {
          type: 'string', maxLength: 50,
          description: '字典值的精确匹配，例如 G17。常用于把已知编码翻译成中文说明。',
        },
        keyword: {
          type: 'string', maxLength: 50,
          description: '在字典值与中文说明里做模糊匹配，例如"投递"或"缺货"。% 和 _ 会被当作普通字符。',
        },
        include_deprecated: {
          type: 'boolean',
          description: '是否包含已失效（valid=0）的字典项，默认 false。需要翻译历史编码时才打开。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['mode', 'filters', 'dictionaries', 'entries', 'returned', 'truncated', 'generatedAt'],
        properties: {
          mode: { type: 'string', description: 'catalog 表示返回字典目录；entries 表示返回字典取值。' },
          filters: {
            type: 'object',
            additionalProperties: false,
            required: ['dictId', 'dictValue', 'keyword', 'includeDeprecated'],
            properties: {
              dictId: nullableSchema('number', '本次查询限定的字典 ID；没有限定字典时为 null。'),
              dictValue: nullableSchema('string', '本次按 dict_value 精确匹配的编码；没有设置时为 null。'),
              keyword: nullableSchema('string', '本次模糊匹配的关键词；没有设置时为 null。'),
              includeDeprecated: { type: 'boolean' },
            },
          },
          dictionaries: {
            type: 'array',
            description: '仅 mode=catalog 时返回。',
            items: {
              type: 'object', additionalProperties: false, required: ['dictId', 'dictName', 'deprecated'],
              properties: {
                dictId: NUMBER,
                dictName: STRING,
                deprecated: { type: 'boolean', description: '字典主表里 valid=0 表示已失效。' },
              },
            },
          },
          entries: {
            type: 'array',
            description: '仅 mode=entries 时返回。',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['dictId', 'dictName', 'dictValue', 'note', 'enabled', 'deprecated'],
              properties: {
                dictId: NUMBER,
                dictName: STRING,
                dictValue: { type: 'string', description: '字典值，即编码本身。' },
                note: { type: 'string', description: '编码对应的中文说明。' },
                enabled: { type: 'boolean', description: 'status=1 表示已启用。' },
                deprecated: { type: 'boolean', description: 'valid=0 表示已失效，多出现在历史数据里。' },
              },
            },
          },
          returned: NUMBER,
          truncated: { type: 'boolean', description: `结果是否达到 ${MAX_DICTIONARY_ROWS} 条上限。` },
          generatedAt: STRING,
        },
      },
      render: (_args, value) => {
        if (value.mode === 'catalog') {
          const text = [
            `订单库共有 ${value.dictionaries.length} 个字典（生成于 ${value.generatedAt}）：`,
            ...value.dictionaries.map(catalogLine),
            `需要某个字典的取值时用 dict_id 再查一次；原因码字典是 dict_id=${REASON_CODE_DICT_ID}。`,
          ].join('\n')
          return [{ type: 'text', text }]
        }
        if (!value.entries.length) {
          const scope = value.filters.dictId === null ? '不限字典' : `dict_id=${value.filters.dictId}`
          return [{
            type: 'text',
            text: `没有匹配的字典项（${scope}）。可以不带筛选条件先查看字典目录；如果是在翻译历史编码，可把 include_deprecated 设为 true 再试。`,
          }]
        }
        const scope = value.filters.includeDeprecated ? '（含已失效项）' : '（仅有效项）'
        // 按 dict_value 单独翻译（例如直接问 G17）时 filters.dictId 是空的，
        // 因此还要看结果里是否出现了原因码字典，否则最容易走的那条路反而拿不到提示。
        const includesReasonDict = value.filters.dictId === REASON_CODE_DICT_ID
          || value.entries.some(entry => entry.dictId === REASON_CODE_DICT_ID)
        const text = [
          `字典查询命中 ${value.returned} 条${scope}，生成于 ${value.generatedAt}：`,
          ...value.entries.map(entryLine),
          includesReasonDict
            ? '提示：这是订单原因码字典。订单操作流水的原因码是混合编码，只有 G 码能在这里查到，数字码和中文码在本库没有对应字典。'
            : null,
          value.truncated ? `注意：结果已达到 ${MAX_DICTIONARY_ROWS} 条上限，可能还有更多。` : null,
        ].filter(Boolean).join('\n')
        return [{ type: 'text', text }]
      },
    },
    async execute(args, exec) {
      const startedAt = Date.now()
      const meta = {}
      if (exec?.signal?.aborted) throw new Error('字典查询已取消。')
      const config = await readConfig(dataDirectory)
      if (!hasDatabaseConfig(config)) {
        throw new Error(`请先在数据库设置页保存完整连接信息。配置文件位置：${configPath(dataDirectory)}`)
      }
      try {
        const result = await lookup(config, args, { signal: exec?.signal })
        meta.rowCount = result.returned
        auditLogger?.record({
          operation: 'dictionary_lookup', status: 'success', table: DICTIONARY_TABLES[0],
          ...meta, durationMs: Math.max(0, Date.now() - startedAt),
        })
        return result
      } catch (error) {
        auditLogger?.record({
          operation: 'dictionary_lookup', status: 'error', table: DICTIONARY_TABLES[0],
          ...meta, errorKind: errorKind(error), durationMs: Math.max(0, Date.now() - startedAt),
        })
        if (exec?.signal?.aborted) throw new Error('字典查询已取消。')
        if (error?.code === 'DATABASE_QUERY_TIMEOUT' || error?.code === 'DATABASE_QUERY_CANCELLED') throw error
        // 参数与白名单错误可以直接告诉模型；其余驱动类错误不外泄连接细节。
        if (/白名单|不支持参数|不能为空|长度不能超过|必须是|包含无效字符/.test(String(error?.message))) throw error
        throw new Error('无法完成字典查询，请检查数据库设置、网络和只读账号权限。')
      }
    },
  }
}

export function registerDictionaryTool(ctx, options) {
  return ctx.tools.register(createDictionaryTool(options))
}
