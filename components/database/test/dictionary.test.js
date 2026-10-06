import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  DICTIONARY_TABLES,
  MAX_DICTIONARY_ROWS,
  REASON_CODE_DICT_ID,
  assertDictionaryTablesAllowed,
  buildDictionaryValuesQuery,
  isDictionaryDiscovery,
  normalizeDictionaryCatalog,
  normalizeDictionaryEntries,
  normalizeDictionaryParams,
  runDictionaryLookup,
} from '../src/domains/dictionary.js'
import { createDictionaryTool, registerDictionaryTool } from '../src/runtime/tools/dictionary-tool.js'
import { registerDictionarySkill } from '../src/runtime/skills/dictionary-skill.js'
import { writePrivateConfig } from '../src/storage/config-store.js'

const CONFIG = {
  type: 'mysql', host: 'db.internal', port: 3306, database: 'sobuy-oms',
  username: 'readonly', password: 'secret', ssl: false,
  allowedTables: [...DICTIONARY_TABLES], maxRows: 100, queryTimeoutMs: 5000,
}

const G17_ROW = {
  dict_id: 3, dict_name: 'Types Of Complaint', dict_value: 'G17',
  note: '缺货', status: 1, valid: 1,
}

test('字典参数只接受白名单字段，越界与空值直接报错', () => {
  assert.deepEqual(normalizeDictionaryParams({}), {
    dict_id: null, dict_value: null, keyword: null, include_deprecated: false,
  })
  assert.deepEqual(normalizeDictionaryParams({ dict_id: 3, dict_value: 'G17', keyword: '缺货', include_deprecated: true }), {
    dict_id: 3, dict_value: 'G17', keyword: '缺货', include_deprecated: true,
  })
  assert.throws(() => normalizeDictionaryParams({ sql: 'SELECT 1' }), /不支持参数：sql/)
  assert.throws(() => normalizeDictionaryParams({ table: 'bas_t_dict' }), /不支持参数：table/)
  assert.throws(() => normalizeDictionaryParams({ dict_id: 0 }), /dict_id必须是 1 到 100000/)
  assert.throws(() => normalizeDictionaryParams({ dict_id: 1.5 }), /dict_id/)
  assert.throws(() => normalizeDictionaryParams({ ignore_whitelist: true }), /不支持参数/)
  assert.throws(() => normalizeDictionaryParams({ dict_value: '   ' }), /dict_value不能为空/)
  assert.throws(() => normalizeDictionaryParams({ keyword: 'x'.repeat(51) }), /keyword长度不能超过 50/)
  assert.throws(() => normalizeDictionaryParams({ keyword: 'a\u0000b' }), /keyword包含无效字符/)
  assert.throws(() => normalizeDictionaryParams({ include_deprecated: 'yes' }), /include_deprecated 必须是布尔值/)
})

test('字典目录模式只在完全没有筛选条件时启用', () => {
  assert.equal(isDictionaryDiscovery(normalizeDictionaryParams({})), true)
  assert.equal(isDictionaryDiscovery(normalizeDictionaryParams({ include_deprecated: true })), true)
  assert.equal(isDictionaryDiscovery(normalizeDictionaryParams({ dict_id: 3 })), false)
  assert.equal(isDictionaryDiscovery(normalizeDictionaryParams({ dict_value: 'G17' })), false)
  assert.equal(isDictionaryDiscovery(normalizeDictionaryParams({ keyword: '缺货' })), false)
})

test('字典查询只生成单条只读 SELECT，默认过滤已失效项', () => {
  const built = buildDictionaryValuesQuery({ dict_id: REASON_CODE_DICT_ID })
  assert.match(built.sql, /^SELECT\b/)
  assert.equal(built.sql.includes(';'), false)
  assert.doesNotMatch(built.sql, /\b(UPDATE|DELETE|INSERT|DROP|ALTER|GRANT)\b/i)
  for (const table of DICTIONARY_TABLES) assert.match(built.sql, new RegExp(`\\b${table}\\b`))
  assert.match(built.sql, /d\.valid = 1/)
  assert.deepEqual(built.values, [3])
  assert.equal(built.meta.mode, 'entries')

  const withDeprecated = buildDictionaryValuesQuery({ dict_id: 3, include_deprecated: true })
  assert.doesNotMatch(withDeprecated.sql, /d\.valid = 1/)
})

test('keyword 的 LIKE 通配符被转义，不会放大结果范围', () => {
  // keyword 同时作用于 dict_value 与 note，因此会生成两个相同的模式参数。
  const built = buildDictionaryValuesQuery({ keyword: '50%' })
  assert.deepEqual(built.values, ['%50\\%%', '%50\\%%'])
  assert.match(built.sql, /d\.dict_value LIKE \? OR COALESCE\(d\.note, ''\) LIKE \?/)

  const underscore = buildDictionaryValuesQuery({ keyword: 'a_b' })
  assert.deepEqual(underscore.values, ['%a\\_b%', '%a\\_b%'])

  const backslash = buildDictionaryValuesQuery({ keyword: 'a\\b' })
  assert.deepEqual(backslash.values, ['%a\\\\b%', '%a\\\\b%'])
})

test('每种参数组合的占位符数量都与参数个数一致', () => {
  for (const input of [
    { dict_id: 3 },
    { dict_value: 'G17' },
    { keyword: '缺货' },
    { dict_id: 3, dict_value: 'G17' },
    { dict_id: 3, keyword: '投递' },
    { dict_id: 3, dict_value: 'G17', keyword: '缺货' },
    { dict_id: 3, dict_value: 'G17', keyword: '缺货', include_deprecated: true },
  ]) {
    const built = buildDictionaryValuesQuery(input)
    assert.equal(
      built.sql.match(/\?/g).length, built.values.length,
      `占位符与参数个数不一致：${JSON.stringify(input)}`,
    )
  }
})

test('字典查询要求两张表都在白名单内，缺哪张就报哪张', () => {
  assert.throws(() => assertDictionaryTablesAllowed({ ...CONFIG, allowedTables: [] }),
    /bas_t_dict、bas_t_dict_values/)
  assert.throws(() => assertDictionaryTablesAllowed({ ...CONFIG, allowedTables: ['bas_t_dict'] }),
    /bas_t_dict_values/)
  assert.doesNotThrow(() => assertDictionaryTablesAllowed(CONFIG))
})

test('字典行归一化区分已失效与未启用', () => {
  const entries = normalizeDictionaryEntries([
    G17_ROW,
    { ...G17_ROW, dict_value: 'G12-4', note: '仓库错发-错装', valid: 0 },
    { ...G17_ROW, dict_value: 'X1', note: '', status: 0 },
  ])
  assert.deepEqual(entries[0], {
    dictId: 3, dictName: 'Types Of Complaint', dictValue: 'G17', note: '缺货',
    enabled: true, deprecated: false,
  })
  assert.equal(entries[1].deprecated, true)
  assert.equal(entries[2].enabled, false)
  assert.equal(entries[2].note, '')

  const catalog = normalizeDictionaryCatalog([{ dict_id: 3, dict_name: 'Types Of Complaint', valid: 1 }])
  assert.deepEqual(catalog, [{ dictId: 3, dictName: 'Types Of Complaint', deprecated: false }])
})

test('目录模式只跑目录查询，取值模式只跑参数化取值查询', async () => {
  const queries = []
  const executes = []

  const catalogResult = await runDictionaryLookup(CONFIG, {}, {
    createConnection: async () => ({
      query: async sql => { queries.push(sql); return [[{ dict_id: 3, dict_name: 'Types Of Complaint', valid: 1 }]] },
      execute: async (sql, values) => { executes.push({ sql, values }); return [[]] },
      end: async () => {},
    }),
    now: () => new Date(2026, 9, 6, 17, 20, 0),
  })
  assert.equal(catalogResult.mode, 'catalog')
  assert.equal(catalogResult.returned, 0)
  assert.deepEqual(catalogResult.entries, [])
  assert.equal(catalogResult.dictionaries.length, 1)
  assert.equal(queries.length, 1)
  assert.equal(executes.length, 0)
  assert.match(queries[0], /FROM bas_t_dict\b/)

  const entriesResult = await runDictionaryLookup(CONFIG, { dict_id: 3, dict_value: 'G17' }, {
    createConnection: async options => {
      assert.equal(options.multipleStatements, false)
      assert.equal(options.password, 'secret')
      return {
        query: async () => { throw new Error('取值模式不应调用 query') },
        execute: async (sql, values) => { executes.push({ sql, values }); return [[G17_ROW]] },
        end: async () => {},
      }
    },
    now: () => new Date(2026, 9, 6, 17, 20, 0),
  })
  assert.equal(entriesResult.mode, 'entries')
  assert.equal(entriesResult.returned, 1)
  assert.equal(entriesResult.entries[0].note, '缺货')
  assert.deepEqual(entriesResult.dictionaries, [])
  assert.equal(entriesResult.truncated, false)
  assert.equal(entriesResult.generatedAt, '2026-10-06 17:20:00')
  assert.deepEqual(entriesResult.filters, {
    dictId: 3, dictValue: 'G17', keyword: null, includeDeprecated: false,
  })
  assert.deepEqual(executes.at(-1).values, [3, 'G17'])

  assert.equal(MAX_DICTIONARY_ROWS >= 305, true)
  await assert.rejects(runDictionaryLookup({ ...CONFIG, allowedTables: [] }, {}), /业务表白名单/)
})

test('字典 Tool 从私有配置执行并渲染翻译结果', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'dsh-database-dictionary-'))
  try {
    await writePrivateConfig(CONFIG, folder)
    const tool = createDictionaryTool({
      dataDirectory: folder,
      lookup: async (config, args) => {
        assert.equal(config.database, 'sobuy-oms')
        assert.deepEqual(args, { dict_value: 'G17' })
        return {
          mode: 'entries',
          filters: { dictId: null, dictValue: 'G17', keyword: null, includeDeprecated: false },
          dictionaries: [],
          entries: normalizeDictionaryEntries([G17_ROW]),
          returned: 1, truncated: false, generatedAt: '2026-10-06 17:20:00',
        }
      },
    })
    assert.equal(tool.name, 'database_dictionary_lookup')
    assert.equal(tool.parameters.additionalProperties, false)
    assert.equal(tool.output.schema.required.includes('mode'), true)

    const value = await tool.execute({ dict_value: 'G17' }, { signal: new AbortController().signal })
    const text = tool.output.render({}, value)[0].text
    assert.match(text, /\[3 Types Of Complaint\] G17 = 缺货/)
    assert.match(text, /原因码字典/)
    assert.doesNotMatch(text, /secret|db\.internal|password/)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('字典 Tool 目录模式、空结果与驱动错误都不外泄连接细节', async () => {
  const tool = createDictionaryTool({
    dataDirectory: '/tmp/does-not-matter',
    lookup: async () => {
      const error = new Error('Access denied for readonly using password secret at db.internal')
      error.code = 'ER_ACCESS_DENIED_ERROR'
      throw error
    },
  })
  await assert.rejects(
    tool.execute({}, { signal: new AbortController().signal }),
    error => !/secret|db\.internal|Access denied/i.test(error.message),
  )

  const catalogText = tool.output.render({}, {
    mode: 'catalog',
    filters: { dictId: null, dictValue: null, keyword: null, includeDeprecated: false },
    dictionaries: [
      { dictId: 2, dictName: 'Country', deprecated: false },
      { dictId: 3, dictName: 'Types Of Complaint', deprecated: false },
    ],
    entries: [], returned: 0, truncated: false, generatedAt: '',
  })[0].text
  assert.match(catalogText, /共有 2 个字典/)
  assert.match(catalogText, /2 = Country/)
  assert.match(catalogText, /原因码字典是 dict_id=3/)

  const emptyText = tool.output.render({}, {
    mode: 'entries',
    filters: { dictId: 3, dictValue: 'G99', keyword: null, includeDeprecated: false },
    dictionaries: [], entries: [], returned: 0, truncated: false, generatedAt: '',
  })[0].text
  assert.match(emptyText, /没有匹配的字典项（dict_id=3）/)
  assert.match(emptyText, /include_deprecated/)
})

test('字典 Tool 与 Skill 通过 DSH 运行时注册', () => {
  const tools = []
  const skills = []
  const ctx = {
    tools: { register: definition => { tools.push(definition); return () => {} } },
    skills: { register: definition => { skills.push(definition); return () => {} } },
  }
  registerDictionaryTool(ctx, { dataDirectory: '/tmp/database-dictionary-register-test' })
  registerDictionarySkill(ctx)
  assert.deepEqual(tools.map(tool => tool.name), ['database_dictionary_lookup'])
  assert.equal(skills.length, 1)
  assert.equal(skills[0].name, 'database-dictionary-lookup')
  assert.equal(skills[0].source, 'bundled')
  assert.deepEqual(skills[0].invocation, { modelInvocable: true, userInvocable: true })
  assert.match(skills[0].content, /database_dictionary_lookup/)
  assert.match(skills[0].content, /dict_id=3/)
  assert.match(skills[0].content, /混合编码/)
  assert.match(skills[0].content, /拦截原因/)
  assert.equal(skills[0].content.startsWith('---'), false)
})
