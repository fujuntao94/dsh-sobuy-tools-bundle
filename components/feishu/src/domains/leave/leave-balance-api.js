/**
 * 飞书人事假期余额 API。
 *
 * 上游接口按页返回租户内记录且没有当前用户筛选参数，因此只在本模块内
 * 使用 OAuth 当前用户的 open_id 过滤，绝不把其它员工记录交给工具层。
 */
const PAGE_SIZE = 100
const MAX_PAGES = 20
import { sdkData } from '../auth/feishu-sdk.js'
import { optionalArray, requireObject } from '../response-validation.js'

/**
 * 读取并仅返回指定雇佣 ID 的假期余额。
 * open_id 与飞书人事 employment_id 都采用 ou_ 标识；入口层只会把当前
 * OAuth 用户的 open_id 传入此函数，调用者无法指定其他人的 ID。
 */
export async function getMyLeaveBalances(client, employmentId) {
  if (!employmentId) throw new Error('当前飞书授权未包含用户标识，请重新登录后重试。')

  let pageToken
  let pages = 0
  const seenPageTokens = new Set()
  do {
    if (++pages > MAX_PAGES) throw new Error('获取飞书假期余额失败：分页超过安全上限。')
    const data = await sdkData(
      () => client.corehr.v1.leave.leaveBalances({
        params: {
          page_size: String(PAGE_SIZE),
          ...(pageToken ? { page_token: pageToken } : {}),
          user_id_type: 'open_id',
        },
      }),
      '获取飞书假期余额失败',
    )
    const payload = requireObject(data, '获取飞书假期余额')
    const matched = optionalArray(payload.employment_leave_balance_list, '获取飞书假期余额.employment_leave_balance_list').find(item => item?.employment_id === employmentId)
    if (matched) return matched
    pageToken = payload.has_more ? payload.page_token : undefined
    if (pageToken && seenPageTokens.has(pageToken)) throw new Error('获取飞书假期余额失败：飞书分页 token 重复。')
    if (pageToken) seenPageTokens.add(pageToken)
  } while (pageToken)

  return undefined
}
