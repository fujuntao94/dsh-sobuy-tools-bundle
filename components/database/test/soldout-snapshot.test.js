import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  compareLatestSoldoutSnapshots,
  readSoldoutSnapshots,
  saveSoldoutSnapshot,
} from '../src/storage/soldout-snapshot-store.js'
import {
  createSoldoutSnapshotCaptureTool,
  createSoldoutSnapshotCompareTool,
  registerSoldoutSnapshotTools,
} from '../src/runtime/tools/soldout-snapshot-tool.js'
import { writePrivateConfig } from '../src/storage/config-store.js'

const CONFIG = {
  type: 'mysql', host: 'db.internal', port: 3306, database: 'sobuy-oms',
  username: 'readonly', password: 'secret', ssl: false,
}

test('缺货快照每天覆盖一次，并能比较最新两份数据库快照', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'dsh-soldout-snapshot-'))
  try {
    await saveSoldoutSnapshot({ capturedAt: '2026-10-05 09:00:00', rows: [{ sku: 'A', warehouseId: 1, quantitySum: 2 }] }, folder)
    const sameDay = await saveSoldoutSnapshot({ capturedAt: '2026-10-05 16:00:00', rows: [{ sku: 'A', warehouseId: 1, quantitySum: 3 }] }, folder)
    await saveSoldoutSnapshot({ capturedAt: '2026-10-06 09:00:00', rows: [{ sku: 'A', warehouseId: 1, quantitySum: 5 }, { sku: 'B', warehouseId: 2, quantitySum: 1 }] }, folder)
    assert.equal(sameDay.replaced, true)
    const history = await readSoldoutSnapshots(folder)
    assert.equal(history.snapshots.length, 2)
    assert.deepEqual(compareLatestSoldoutSnapshots(history.snapshots), {
      available: true, previousCapturedAt: '2026-10-05 16:00:00', latestCapturedAt: '2026-10-06 09:00:00',
      previousGroups: 1, latestGroups: 2, newGroups: 1, resolvedGroups: 0, continuingGroups: 1, worsenedGroups: 1,
    })
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('快照采集只保存数据库归因返回的安全字段，不写 OMS', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'dsh-soldout-capture-'))
  try {
    await writePrivateConfig(CONFIG, folder)
    const tool = createSoldoutSnapshotCaptureTool({
      dataDirectory: folder,
      now: () => new Date(2026, 9, 6, 16, 40, 0),
      attribution: async (_config, args) => {
        assert.deepEqual(args, { window_days: 30, scope: 'active', group_by: 'sku', top_n: 500 })
        return {
          windowDays: 30,
          rows: [{ sku: 'FRG225-W', warehouseId: 50, warehouseName: 'HS-A', soldoutRows: 2, orderCount: 2, quantitySum: 3, oldestShortageTime: '2026-10-05 10:00:00', localAvailable: 0, otherWarehouseAvailable: 2, attribution: 'warehouse_allocation_gap', currentState: 'active', priority: 'P2', customerName: 'must-not-save' }],
        }
      },
    })
    const value = await tool.execute({ window_days: 30 }, { signal: new AbortController().signal })
    assert.equal(value.capturedGroups, 1)
    const history = await readSoldoutSnapshots(folder)
    assert.equal(history.snapshots[0].rows[0].customerName, undefined)
    assert.equal(history.snapshots[0].rows[0].sku, 'FRG225-W')
    assert.match(tool.output.render({}, value)[0].text, /已采集 1 条/)

    const compare = createSoldoutSnapshotCompareTool({ dataDirectory: folder })
    const comparison = await compare.execute()
    assert.equal(comparison.available, false)
    assert.match(comparison.reason, /至少需要两份/)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('缺货快照 Tool 都可通过 DSH 运行时注册', () => {
  const tools = []
  const ctx = { tools: { register: definition => { tools.push(definition); return () => {} } } }
  registerSoldoutSnapshotTools(ctx, { dataDirectory: '/tmp/database-snapshot-register-test' })
  assert.deepEqual(tools.map(tool => tool.name), ['database_soldout_snapshot_capture', 'database_soldout_snapshot_compare'])
})
