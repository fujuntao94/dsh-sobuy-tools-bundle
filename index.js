// 根组件同时承接飞书运行逻辑与 Desktop 设置页，避免在插件目录重复显示一项 client 组件。
// 数据库功能仍由 /database 子组件独立启停。
import { apply as applyFeishu } from './components/feishu/index.js'

export const name = 'dsh-sobuy-feishu-tools'
export const inject = ['tools', 'skills']

export function apply(ctx, config = {}) {
  return applyFeishu(ctx, config)
}
