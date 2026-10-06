import { homedir } from 'node:os'
import { join } from 'node:path'

/** 返回 DSH 的私有数据根目录；组件仅在其下创建各自的隔离目录。 */
export function dshHomeDirectory() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function componentDataDirectory(componentName) {
  if (typeof componentName !== 'string' || !/^[a-z0-9-]+$/.test(componentName)) {
    throw new TypeError('组件数据目录名称无效。')
  }
  return join(dshHomeDirectory(), componentName)
}
