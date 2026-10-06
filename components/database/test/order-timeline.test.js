import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  DEFAULT_TIMELINE_LIMIT,
  MAX_TIMELINE_LIMIT,
  ORDER_TIMELINE_TABLES,
  assertTimelineTablesAllowed,
  buildTimelineQuery,
  normalizeTimelineEntries,
  normalizeTimelineParams,
  runOrderTimeline,
} from '../src/domains/order-timeline.js'
import { REASON_CODE_DICT_ID } from '../src/domains/dictionary.js'
import { createOrderTimelineTool, registerOrderTimelineTool } from '../src/runtime/tools/order-timeline-tool.js'
import { registerOrderTimelineSkill } from '../src/runtime/skills/order-timeline-skill.js'
import { writePrivateConfig } from '../src/storage/config-store.js'

const CONFIG = {
  type: 'mysql', host: 'db.internal', port: 3306, database: 'sobuy-oms',
  username: 'readonly', password: 'secret', ssl: false,
  allowedTables: [...ORDER_TIMELINE_TABLES], maxRows: 100, queryTimeoutMs: 5000,
}

const INTERCEPT_ROW = {
  logid: 991, operation: '拦截', operation_en: 'Intercept', reason: 'G17',
  reason_note: '缺货', information: '拦截成功', operators: '毛珊珊', create_time: '2026-10-06 17:15:04',
}

const PRINT_ROW = {
  logid: 992, operation: '仓库已打单', operation_en: 'Printed', reason: null,
  reason_note: null, information: '面单号:02636F694625', operators: null, create_time: '2026-10-06 17:15:01',
}

test('时间线参数强制 order_id，并限制长度、控制字符与返回条数', () => {
  assert.deepEqual(normalizeTimelineParams({ order_id: 'PO-186-123' }), {
    order_id: 'PO-186-123', limit: DEFAULT_TIMELINE_LIMIT,
  })
  assert.deepEqual(normalizeTimelineParams({ order_id: '  403-4266233-5557910  ', limit: 10 }), {
    order_id: '403-4266233-5557910', limit: 10,
  })
  assert.throws(() => normalizeTimelineParams({}), /order_id 不能为空/)
  assert.throws(() => normalizeTimelineParams({ order_id: '   ' }), /order_id 不能为空/)
  assert.throws(() => normalizeTimelineParams({ order_id: 'x'.repeat(65) }), /order_id 长度不能超过 64/)
  assert.throws(() => normalizeTimelineParams({ order_id: 'a\u0000b' }), /order_id 包含无效字符/)
  assert.throws(() => normalizeTimelineParams({ order_id: 'a', limit: 0 }), /limit必须是 1 到 200/)
  assert.throws(() => normalizeTimelineParams({ order_id: 'a', limit: MAX_TIMELINE_LIMIT + 1 }), /limit必须是 1 到 200/)
  assert.throws(() => normalizeTimelineParams({ order_id: 'a', sql: 'SELECT 1' }), /不支持参数：sql/)
  assert.throws(() => normalizeTimelineParams({ order_id: 'a', window_days: 30 }), /不支持参数：window_days/)
  assert.throws(() => normalizeTimelineParams({ order_id_in: 'a' }), /不支持参数：order_id_in/)
})

test('时间线只生成两条只读 SELECT，且不选人工解释等高风险列', () => {
  const built = buildTimelineQuery({ order_id: 'PO-186-123' })
  for (const sql of [built.countSql, built.sql]) {
    assert.match(sql, /^SELECT\b/)
    assert.equal(sql.includes(';'), false)
    assert.doesNotMatch(sql, /\b(UPDATE|DELETE|INSERT|DROP|ALTER|GRANT)\b/i)
  }
  for (const table of ORDER_TIMELINE_TABLES) assert.match(built.sql, new RegExp(`\\b${table}\\b`))
  assert.match(built.sql, /ORDER BY a\.create_time DESC/)
  assert.match(built.sql, /LIMIT \?$/)
  // action_explain 是人工填写的解释，PII 风险最高，必须完全不出现在查询里。
  assert.doesNotMatch(built.sql, /action_explain/)
  assert.doesNotMatch(built.countSql, /action_explain/)
  assert.match(built.sql, /LEFT\(a\.information, 300\)/)
  assert.deepEqual(built.values, [REASON_CODE_DICT_ID, 'PO-186-123', DEFAULT_TIMELINE_LIMIT])
  assert.deepEqual(built.countValues, ['PO-186-123'])
  assert.deepEqual(built.meta, { orderId: 'PO-186-123', appliedLimit: DEFAULT_TIMELINE_LIMIT })
})

test('时间线每条 SQL 的占位符数量都与参数个数一致', () => {
  for (const input of [
    { order_id: 'a' },
    { order_id: 'PO-186-12399759478314058' },
    { order_id: 'a', limit: 1 },
    { order_id: 'a', limit: MAX_TIMELINE_LIMIT },
  ]) {
    const built = buildTimelineQuery(input)
    assert.equal(built.sql.match(/\?/g).length, built.values.length, `主查询占位符不一致：${JSON.stringify(input)}`)
    assert.equal(built.countSql.match(/\?/g).length, built.countValues.length, `计数查询占位符不一致：${JSON.stringify(input)}`)
  }
})

test('时间线要求两张表都在白名单内，缺哪张就报哪张', () => {
  assert.throws(() => assertTimelineTablesAllowed({ ...CONFIG, allowedTables: [] }),
    /oms_t_order_action、bas_t_dict_values/)
  assert.throws(() => assertTimelineTablesAllowed({ ...CONFIG, allowedTables: ['oms_t_order_action'] }),
    /bas_t_dict_values/)
  assert.doesNotThrow(() => assertTimelineTablesAllowed(CONFIG))
})

test('原因码翻译不到时保留原编码并显式标记未翻译', () => {
  const entries = normalizeTimelineEntries([
    INTERCEPT_ROW,
    { ...INTERCEPT_ROW, logid: 993, reason: '50', reason_note: null },
    { ...INTERCEPT_ROW, logid: 994, reason: '取消订单', reason_note: '' },
    PRINT_ROW,
  ])
  assert.equal(entries[0].reasonTranslated, true)
  assert.equal(entries[0].reasonNote, '缺货')
  assert.equal(entries[1].reason, '50')
  assert.equal(entries[1].reasonTranslated, false)
  assert.equal(entries[2].reasonTranslated, false)
  assert.equal(entries[3].reason, '')
  assert.equal(entries[3].reasonTranslated, false)
  assert.equal(entries[3].information, '面单号:02636F694625')
  assert.equal(entries[3].operators, '')
})

test('时间线先查总数再取最近若干条，并统计翻译覆盖', async () => {
  const calls = []
  const result = await runOrderTimeline(CONFIG, { order_id: 'PO-186-1', limit: 2 }, {
    createConnection: async options => {
      assert.equal(options.multipleStatements, false)
      return {
        execute: async (sql, values) => {
          calls.push({ sql, values })
          assert.match(sql, /^SELECT\b/)
          if (/COUNT\(\*\)/.test(sql)) return [[{ total: '100786' }]]
          return [[INTERCEPT_ROW, { ...INTERCEPT_ROW, logid: 995, reason: '50', reason_note: null }]]
        },
        end: async () => {},
      }
    },
    now: () => new Date(2026, 9, 6, 17, 25, 0),
  })
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].values, ['PO-186-1'])
  assert.deepEqual(calls[1].values, [REASON_CODE_DICT_ID, 'PO-186-1', 2])
  assert.equal(result.orderId, 'PO-186-1')
  assert.equal(result.totalRecords, 100786)
  assert.equal(result.returned, 2)
  assert.equal(result.mayBeTruncated, true)
  assert.equal(result.translatedReasons, 1)
  assert.equal(result.untranslatedReasons, 1)
  assert.equal(result.generatedAt, '2026-10-06 17:25:00')
  assert.deepEqual(Object.keys(result), [
    'orderId', 'totalRecords', 'returned', 'mayBeTruncated',
    'translatedReasons', 'untranslatedReasons', 'entries', 'generatedAt',
  ])

  await assert.rejects(runOrderTimeline({ ...CONFIG, allowedTables: [] }, { order_id: 'a' }), /业务表白名单/)
})

test('时间线 Tool 渲染轨迹并明确提示未翻译与截断', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'dsh-database-timeline-'))
  try {
    await writePrivateConfig(CONFIG, folder)
    const tool = createOrderTimelineTool({
      dataDirectory: folder,
      timeline: async (config, args) => {
        assert.equal(config.database, 'sobuy-oms')
        assert.deepEqual(args, { order_id: 'PO-186-1' })
        return {
          orderId: 'PO-186-1', totalRecords: 100786, returned: 2, mayBeTruncated: true,
          translatedReasons: 1, untranslatedReasons: 1,
          entries: normalizeTimelineEntries([INTERCEPT_ROW, { ...PRINT_ROW, reason: '50', reason_note: null }]),
          generatedAt: '2026-10-06 17:25:00',
        }
      },
    })
    assert.equal(tool.name, 'database_order_timeline')
    assert.deepEqual(tool.parameters.required, ['order_id'])
    assert.equal(tool.parameters.additionalProperties, false)
    assert.equal(tool.parameters.properties.limit.maximum, MAX_TIMELINE_LIMIT)

    const value = await tool.execute({ order_id: 'PO-186-1' }, { signal: new AbortController().signal })
    const text = tool.output.render({}, value)[0].text
    assert.match(text, /订单 PO-186-1：操作流水共 100786 条，本次返回最近 2 条/)
    assert.match(text, /原因码 G17（缺货）/)
    assert.match(text, /原因码 50（字典中无此编码）/)
    assert.match(text, /操作人：毛珊珊/)
    assert.match(text, /原因码只在「拦截」类操作上才有值/)
    assert.match(text, /只有 G 码（如 G17=缺货）有字典/)
    assert.match(text, /部分较早记录未显示/)
    assert.doesNotMatch(text, /secret|db\.internal|password/)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('时间线 Tool 空轨迹给出明确提示，且不把驱动错误原文带出', async () => {
  const tool = createOrderTimelineTool({
    dataDirectory: '/tmp/does-not-matter',
    timeline: async () => {
      const error = new Error('Access denied for readonly using password secret at db.internal')
      error.code = 'ER_ACCESS_DENIED_ERROR'
      throw error
    },
  })
  await assert.rejects(
    tool.execute({ order_id: 'x' }, { signal: new AbortController().signal }),
    error => !/secret|db\.internal|Access denied/i.test(error.message),
  )

  const emptyText = tool.output.render({}, {
    orderId: 'NO-SUCH-ORDER', totalRecords: 0, returned: 0, mayBeTruncated: false,
    translatedReasons: 0, untranslatedReasons: 0, entries: [], generatedAt: '',
  })[0].text
  assert.match(emptyText, /没有任何记录/)
  assert.match(emptyText, /请确认订单号是否正确/)

  const completeText = tool.output.render({}, {
    orderId: 'OK-1', totalRecords: 1, returned: 1, mayBeTruncated: false,
    translatedReasons: 0, untranslatedReasons: 0,
    entries: normalizeTimelineEntries([PRINT_ROW]), generatedAt: '',
  })[0].text
  assert.doesNotMatch(completeText, /部分较早记录未显示/)
  assert.doesNotMatch(completeText, /本库字典里查不到/)
  assert.match(completeText, /说明：面单号:02636F694625/)
})

test('时间线 Tool 与 Skill 通过 DSH 运行时注册', () => {
  const tools = []
  const skills = []
  const ctx = {
    tools: { register: definition => { tools.push(definition); return () => {} } },
    skills: { register: definition => { skills.push(definition); return () => {} } },
  }
  registerOrderTimelineTool(ctx, { dataDirectory: '/tmp/database-timeline-register-test' })
  registerOrderTimelineSkill(ctx)
  assert.deepEqual(tools.map(tool => tool.name), ['database_order_timeline'])
  assert.equal(skills.length, 1)
  assert.equal(skills[0].name, 'database-order-timeline')
  assert.equal(skills[0].source, 'bundled')
  assert.deepEqual(skills[0].invocation, { modelInvocable: true, userInvocable: true })
  assert.match(skills[0].content, /database_order_timeline/)
  assert.match(skills[0].content, /只在「拦截」类操作上才有值/)
  assert.match(skills[0].content, /reasonTranslated=false/)
  assert.equal(skills[0].content.startsWith('---'), false)
})
