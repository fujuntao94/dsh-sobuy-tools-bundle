/**
 * 时间格式化。
 *
 * 组件内所有对外返回的时间都必须是本地时区的 `YYYY-MM-DD HH:mm:ss` 字符串：
 * 一是避免把驱动的 Date 对象直接交给模型（序列化结果不确定），
 * 二是避免 UTC 与本地时区混用导致"时间对不上"的误判。
 */
export function formatLocalDateTime(date) {
  const pad = value => String(value).padStart(2, '0')
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  ].join(' ')
}
