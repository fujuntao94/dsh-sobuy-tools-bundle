import { readFileSync } from 'node:fs'
import { createLocalSetupServer, escapeHtml, renderTemplate } from 'sobuy-plugin-core/http'
import { readSourceConfig, writeSourceConfig } from './storage/config-store.js'
const template = readFileSync(new URL('./ui/setup.html', import.meta.url), 'utf8')
const text = value => typeof value === 'string' ? value.trim() : ''
export function normalizeCustomerProfileConfig(input, previous) { const password = typeof input.password === 'string' && input.password !== '' ? input.password : previous?.sources?.[0]?.password || ''; const encryptionKey = typeof input.encryptionKey === 'string' && input.encryptionKey !== '' ? input.encryptionKey : previous?.encryptionKey || ''; const source = { id: 'primary', name: text(input.sourceName) || 'OMS 主数据源', type: 'mysql', host: text(input.host), port: Number(input.port), database: text(input.database), username: text(input.username), password, ssl: input.ssl === 'on' || input.ssl === 'true' }; if (!source.host || !Number.isInteger(source.port) || source.port < 1 || source.port > 65535 || !source.database || !source.username || !source.password) throw new Error('请完整填写数据源名称、主机、端口、数据库名、用户名和密码。'); return { version: 1, sources: [source], encryptionKey, allowPiiOutput: input.allowPiiOutput === 'on' || input.allowPiiOutput === 'true' } }
export function publicSourceStatus(config) { const source = config?.sources?.[0]; if (!source) return { configured: false, sources: [], encryptionKeyConfigured: false, allowPiiOutput: false }; return { configured: Boolean(source.host && source.port && source.database && source.username && source.password), sources: [{ id: source.id, name: source.name, type: source.type, host: source.host, port: source.port, database: source.database, username: source.username, passwordConfigured: Boolean(source.password), ssl: Boolean(source.ssl) }], encryptionKeyConfigured: Boolean(config.encryptionKey), allowPiiOutput: Boolean(config.allowPiiOutput) } }
export function createCustomerProfileSetupServer(options) {
  return createLocalSetupServer({
    host: options.setupHost,
    port: options.setupPort,
    setupPath: options.setupPath,
    statusPath: options.statusPath,
    bodyLimitBytes: 16384,
    renderPage: ({ setupToken, message, tone }) => renderTemplate(template, {
      setupPath: escapeHtml(options.setupPath), statusPath: escapeHtml(options.statusPath), setupToken: escapeHtml(setupToken), message: escapeHtml(message || ''), noticeHidden: message ? '' : 'hidden', noticeTone: tone === 'success' ? 'success' : 'error',
    }).replace('</form>', '<label for="encryption-key">OMS 解密密钥</label><input id="encryption-key" name="encryption_key" type="password" autocomplete="new-password"><p class="hint">密钥仅用于本机 AES-GCM 解密，留空表示不修改。</p><label class="check"><input id="allow-pii-output" name="allow_pii_output" type="checkbox">我已获授权，可在客户画像中显示已解密的个人资料</label></form>').replace('</body>', `<script>fetch('${options.statusPath}',{cache:'no-store'}).then(r=>r.json()).then(s=>{const key=document.getElementById('encryption-key'),allow=document.getElementById('allow-pii-output');if(key)key.placeholder=s.encryptionKeyConfigured?'已安全保存；留空表示不修改':'仅本机解密使用';if(allow)allow.checked=Boolean(s.allowPiiOutput)}).catch(()=>{})</script></body>`),
    getStatus: async () => publicSourceStatus(await readSourceConfig(options.dataDirectory)),
    statusError: '无法读取客户画像数据源配置',
    onError: error => options.logger?.warn('客户画像设置页请求失败：%s', error.message),
    submit: async form => {
      try {
        const previous = await readSourceConfig(options.dataDirectory)
        await writeSourceConfig(normalizeCustomerProfileConfig({
          sourceName: form.get('source_name'), host: form.get('host'), port: form.get('port'), database: form.get('database'), username: form.get('username'), password: form.get('password'), ssl: form.get('ssl'), encryptionKey: form.get('encryption_key'), allowPiiOutput: form.get('allow_pii_output'),
        }, previous), options.dataDirectory)
        return { message: '客户画像主数据源已保存到本机。', tone: 'success' }
      } catch (error) {
        return { message: error instanceof Error ? error.message : '无法保存数据源配置。' }
      }
    },
  })
}
