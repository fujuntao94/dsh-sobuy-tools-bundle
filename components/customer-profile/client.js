window.__ModuleLoader__.load({
  id: 'sobuy-customer-profile-tools',
  factory: require => {
    const module = { exports: {} }; const exports = module.exports
    const { jsx, jsxs } = require('react/jsx-runtime'); const NS = 'settings.sobuyCustomerProfile'
    const zh = { description: '配置客户画像的独立主数据源。', open: '打开数据源设置页', note: '该组件单独保存凭据，不复用 OMS 数据库组件配置。' }
    const en = { description: 'Configure the standalone customer-profile source.', open: 'Open source settings', note: 'Credentials are stored separately from the OMS database component.' }
    function Settings({ t, view }) { if (view === 'summary') return t('description'); return jsxs('section', { style: { maxWidth: '520px', padding: '12px 0' }, children: [jsx('button', { type: 'button', onClick: () => window.open('http://127.0.0.1:18083/customer-profile/setup', '_blank'), style: { height: '40px', padding: '0 16px', border: 0, borderRadius: '8px', background: '#5747d9', color: '#fff', cursor: 'pointer', font: '500 14px inherit' }, children: t('open') }), jsx('p', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '13px' }, children: t('note') })] }) }
    function apply(ctx) { ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'sobuy-customer-profile: dictionaries'); ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config', key: 'dsh-sobuy-tools-bundle#sobuy-customer-profile-tools', locale: NS }, Settings)) }
    exports.inject = ['slots', 'locale']; exports.apply = apply; return module.exports
  },
})
