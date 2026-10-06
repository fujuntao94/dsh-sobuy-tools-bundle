window.__ModuleLoader__.load({
  id: 'sobuy-database-tools',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const { jsx, jsxs } = require('react/jsx-runtime')
    const NS = 'settings.sobuyDatabase'
    const zh = {
      description: '设置只读数据库连接信息。',
      openSetup: '打开数据库设置页',
      note: '设置页会在浏览器中打开；密码不会在状态页中回显。',
    }
    const en = {
      description: 'Configure read-only database connection details.',
      openSetup: 'Open database settings',
      note: 'The settings page opens in your browser; the saved password is never displayed.',
    }

    function DatabaseSettings({ t, view }) {
      if (view === 'summary') return t('description')
      return jsxs('section', {
        style: { maxWidth: '520px', padding: '12px 0', color: 'var(--dsw-alias-label-primary)' },
        children: [
          jsx('button', {
            type: 'button',
            onClick: () => window.open('http://127.0.0.1:18082/database/setup', '_blank'),
            style: { height: '40px', padding: '0 16px', border: 0, borderRadius: '8px', background: '#3370ff', color: '#fff', cursor: 'pointer', font: '500 14px inherit' },
            children: t('openSetup'),
          }),
          jsx('p', { style: { margin: '10px 0 0', color: 'var(--dsw-alias-label-secondary)', fontSize: '13px', lineHeight: 1.6 }, children: t('note') }),
        ],
      })
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'sobuy-database: dictionaries')
      ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: 'dsh-sobuy-tools-bundle#sobuy-database-tools',
        locale: NS,
      }, DatabaseSettings))
    }

    exports.inject = ['slots', 'locale']
    exports.apply = apply
    return module.exports
  },
})
