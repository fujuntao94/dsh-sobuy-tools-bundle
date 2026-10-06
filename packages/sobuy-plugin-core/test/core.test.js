import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { areDistinctAbsolutePaths, isLoopbackHost, isValidPort } from '../src/config/loopback.js'
import { componentDataDirectory } from '../src/config/dsh-home.js'
import { createLocalSetupServer } from '../src/http/local-setup-server.js'
import { readOptionalJson, writePrivateJson } from '../src/storage/private-json.js'

async function availablePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve)
  })
  const { port } = server.address()
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

test('私有 JSON 存储使用受限权限并对不存在文件返回 undefined', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'sobuy-plugin-core-'))
  const file = join(folder, 'private', 'config.json')
  try {
    assert.equal(await readOptionalJson(file), undefined)
    await writePrivateJson(file, { secret: 'local-only' })
    assert.deepEqual(await readOptionalJson(file), { secret: 'local-only' })
    assert.equal((await stat(file)).mode & 0o777, 0o600)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('本机设置页服务统一保护一次性令牌、状态接口和提交结果', async () => {
  const port = await availablePort()
  const server = createLocalSetupServer({
    host: '127.0.0.1',
    port,
    setupPath: '/setup',
    statusPath: '/status',
    renderPage: ({ setupToken, message }) => `<form><input name="setup_token" value="${setupToken}">${message}</form>`,
    getStatus: async () => ({ configured: true }),
    submit: async form => ({ message: `saved:${form.get('value')}` }),
  })
  try {
    await server.ready
    const page = await fetch(`http://127.0.0.1:${port}/setup`)
    const html = await page.text()
    const token = html.match(/value="([^"]+)"/)?.[1]
    assert.equal(page.status, 200)
    assert.ok(token)
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/status`)).json(), { configured: true })
    const stale = await fetch(`http://127.0.0.1:${port}/setup`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'setup_token=stale',
    })
    assert.match(await stale.text(), /设置页已过期/)
    const saved = await fetch(`http://127.0.0.1:${port}/setup`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ setup_token: token, value: 'ok' }),
    })
    assert.match(await saved.text(), /saved:ok/)
    const replay = await fetch(`http://127.0.0.1:${port}/setup`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ setup_token: token, value: 'replay' }),
    })
    assert.match(await replay.text(), /设置页已过期/)
    const invalidContentType = await fetch(`http://127.0.0.1:${port}/setup`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'setup_token=anything',
    })
    assert.match(await invalidContentType.text(), /提交格式无效/)
  } finally {
    await server.close()
  }
})

test('设置页渲染异常会记录错误并返回不泄露内部信息的 500 页面', async () => {
  const port = await availablePort()
  const errors = []
  const server = createLocalSetupServer({
    host: '127.0.0.1',
    port,
    setupPath: '/setup',
    statusPath: '/status',
    renderPage: () => { throw new Error('internal template detail') },
    getStatus: async () => ({ configured: true }),
    submit: async () => ({ message: 'saved' }),
    onError: error => errors.push(error),
  })
  try {
    await server.ready
    const response = await fetch(`http://127.0.0.1:${port}/setup`)
    assert.equal(response.status, 500)
    assert.doesNotMatch(await response.text(), /internal template detail/)
    assert.equal(errors.length, 1)
  } finally {
    await server.close()
  }
})

test('回环参数校验拒绝公网主机、非法端口与重复路径', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true)
  assert.equal(isLoopbackHost('0.0.0.0'), false)
  assert.equal(isValidPort(18081), true)
  assert.equal(isValidPort(0), false)
  assert.equal(areDistinctAbsolutePaths(['/setup', '/status']), true)
  assert.equal(areDistinctAbsolutePaths(['/setup', '/setup']), false)
})

test('组件数据目录限制名称并始终位于 DSH 私有根目录下', () => {
  assert.match(componentDataDirectory('database-tools'), /database-tools$/)
  assert.throws(() => componentDataDirectory('../outside'), /名称无效/)
})
