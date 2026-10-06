/** 只允许设置页和 OAuth 回调使用本机回环地址。 */
export function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === '::1'
}

export function isValidPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

/** 路径必须以 / 开头，且同一服务中的路由不可重叠。 */
export function areDistinctAbsolutePaths(paths) {
  return paths.every(path => typeof path === 'string' && path.startsWith('/'))
    && new Set(paths).size === paths.length
}
