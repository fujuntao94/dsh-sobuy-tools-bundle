/**
 * 飞书人事假期余额 API。
 *
 * 上游接口支持 employment_id_list 与 user_id_type，因此直接按当前 OAuth
 * 用户的 open_id 过滤，避免读取租户内其他员工的余额。
 */
const PAGE_SIZE = 100
const MAX_PAGES = 20
import { sdkData } from '../auth/feishu-sdk.js'
import { optionalArray, requireObject } from '../response-validation.js'

/**
 * 读取并仅返回当前 OAuth 用户的假期余额。
 * 调用者只能传入当前登录态的 open_id；上游也只返回该用户的记录。
 */
export async function getMyLeaveBalances(client, openId) {
  if (!openId) throw new Error('当前飞书授权未包含用户标识，请重新登录后重试。')

  let pageToken
  let pages = 0
  const seenPageTokens = new Set()
  do {
    if (++pages > MAX_PAGES) throw new Error('获取飞书假期余额失败：分页超过安全上限。')
    const data = await sdkData(
      () => client.corehr.v1.leave.leaveBalances({
        params: {
          page_size: String(PAGE_SIZE),
          // 单个值会编码为 employment_id_list=<open_id>，符合 GET 数组参数规范。
          employment_id_list: openId,
          user_id_type: 'open_id',
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      }),
      '获取飞书假期余额失败',
    )
    const payload = requireObject(data, '获取飞书假期余额')
    const matched = optionalArray(payload.employment_leave_balance_list, '获取飞书假期余额.employment_leave_balance_list').find(item => item?.employment_id === openId)
    if (matched) return matched
    pageToken = payload.has_more ? payload.page_token : undefined
    if (pageToken && seenPageTokens.has(pageToken)) throw new Error('获取飞书假期余额失败：飞书分页 token 重复。')
    if (pageToken) seenPageTokens.add(pageToken)
  } while (pageToken)

  return undefined
}
