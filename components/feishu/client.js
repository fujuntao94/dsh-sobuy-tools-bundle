window.__ModuleLoader__.load({
  id: 'sobuy-feishu-tools',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const { jsx, jsxs } = require('react/jsx-runtime')
    const NS = 'settings.sobuyFeishu'
    const zh = {
      description: '设置飞书凭据并授权。',
      openSetup: '打开飞书设置页',
      note: '设置页会在浏览器中打开；保存后直接进入飞书官方授权页。',
    }
    const en = {
      description: 'Configure Feishu credentials and authorization.',
      openSetup: 'Open Feishu settings',
      note: 'The settings page opens in your browser and then goes to Feishu authorization.',
    }

    function FeishuSettings({ t, view }) {
      if (view === 'summary') return t('description')
      return jsxs('section', {
        style: { maxWidth: '520px', padding: '12px 0', color: 'var(--dsw-alias-label-primary)' },
        children: [
          jsx('button', {
            type: 'button',
            onClick: () => window.open('http://127.0.0.1:18081/feishu/setup', '_blank'),
            style: { height: '40px', padding: '0 16px', border: 0, borderRadius: '8px', background: '#3370ff', color: '#fff', cursor: 'pointer', font: '500 14px inherit' },
            children: t('openSetup'),
          }),
          jsx('p', { style: { margin: '10px 0 0', color: 'var(--dsw-alias-label-secondary)', fontSize: '13px', lineHeight: 1.6 }, children: t('note') }),
        ],
      })
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'sobuy-feishu: dictionaries')
      ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: 'dsh-sobuy-tools-bundle#sobuy-feishu-tools',
        locale: NS,
      }, FeishuSettings))
    }

    exports.inject = ['slots', 'locale']
    exports.apply = apply
    return module.exports
  },
})
