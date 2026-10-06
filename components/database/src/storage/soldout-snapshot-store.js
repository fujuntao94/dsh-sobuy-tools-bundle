import { join } from 'node:path'
import { readOptionalJson, writePrivateJson } from 'sobuy-plugin-core/storage'
import { defaultDataDirectory } from './config-store.js'

const MAX_SNAPSHOTS = 90

export function soldoutSnapshotPath(dataDirectory = defaultDataDirectory()) {
  return join(dataDirectory, 'soldout-snapshots.json')
}

function normalizeHistory(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.snapshots)) return { snapshots: [] }
  return { snapshots: value.snapshots.filter(snapshot => snapshot && typeof snapshot === 'object' && Array.isArray(snapshot.rows)) }
}

export async function readSoldoutSnapshots(dataDirectory = defaultDataDirectory()) {
  try {
    return normalizeHistory(await readOptionalJson(soldoutSnapshotPath(dataDirectory)))
  } catch (error) {
    throw new Error(`无法读取缺货快照：${error.message}`)
  }
}

/** 每天只保留一份快照；内容来自只读归因 Tool，绝不写入 OMS。 */
export async function saveSoldoutSnapshot(snapshot, dataDirectory = defaultDataDirectory()) {
  const history = await readSoldoutSnapshots(dataDirectory)
  const date = String(snapshot.capturedAt || '').slice(0, 10)
  const index = history.snapshots.findIndex(item => String(item.capturedAt || '').slice(0, 10) === date)
  const replaced = index >= 0
  if (replaced) history.snapshots[index] = snapshot
  else history.snapshots.push(snapshot)
  history.snapshots.sort((left, right) => String(left.capturedAt).localeCompare(String(right.capturedAt)))
  history.snapshots = history.snapshots.slice(-MAX_SNAPSHOTS)
  await writePrivateJson(soldoutSnapshotPath(dataDirectory), history)
  return { replaced, retained: history.snapshots.length }
}

export function compareLatestSoldoutSnapshots(snapshots = []) {
  const ordered = [...snapshots].sort((left, right) => String(left.capturedAt).localeCompare(String(right.capturedAt)))
  const latest = ordered.at(-1)
  const previous = ordered.at(-2)
  if (!latest) return { available: false, reason: '尚未采集缺货快照。' }
  if (!previous) return { available: false, reason: '至少需要两份快照才能比较变化。', latestCapturedAt: latest.capturedAt }

  const key = row => `${row.sku}\u0000${row.warehouseId}`
  const before = new Map(previous.rows.map(row => [key(row), row]))
  const after = new Map(latest.rows.map(row => [key(row), row]))
  const added = [...after.keys()].filter(item => !before.has(item))
  const resolved = [...before.keys()].filter(item => !after.has(item))
  const continuing = [...after.keys()].filter(item => before.has(item))
  const worsened = continuing.filter(item => Number(after.get(item).quantitySum || 0) > Number(before.get(item).quantitySum || 0))
  return {
    available: true,
    previousCapturedAt: previous.capturedAt,
    latestCapturedAt: latest.capturedAt,
    previousGroups: previous.rows.length,
    latestGroups: latest.rows.length,
    newGroups: added.length,
    resolvedGroups: resolved.length,
    continuingGroups: continuing.length,
    worsenedGroups: worsened.length,
  }
}
