/**
 * 飞书通讯录中的“我的部门”接口请求。
 *
 * 这个模块只负责向飞书读取原始数据，不决定哪些字段能返回给智能体。
 * 对外展示的字段筛选放在同领域的 department-tool.js，避免内部标识意外泄露。
 */

import { sdkData } from '../auth/feishu-sdk.js'
import { optionalArray, requireObject } from '../response-validation.js'

/** 负责人 ID 已在部门接口中指定为 open_id；这里只读取展示名称，不向上层返回用户资料。 */
async function getUserDisplayName(client, openId) {
  const data = await sdkData(
    () => client.contact.v3.user.get({
      path: { user_id: openId },
      params: { user_id_type: 'open_id' },
    }),
    '获取飞书负责人信息失败',
  )
  const user = requireObject(data.user, '获取飞书负责人信息')
  return user.name || user.en_name || '未命名负责人'
}

/**
 * 以应用身份查询指定 OAuth 当前用户所属的部门，再读取每个部门详情。
 *
 * openId 只用于锁定 OAuth 当前用户；department_ids 是飞书返回的内部引用，均不直接返回给工具调用者。
 */
export async function getMyDepartments(client, openId) {
  if (!openId || !/^ou_[A-Za-z0-9]+$/.test(openId)) {
    throw new Error('当前飞书授权未包含有效 open_id，请重新登录后重试。')
  }
  // contact/v3 不支持 users/me；SDK path 必须传入当前 OAuth 用户的 open_id。
  const current = await sdkData(
    () => client.contact.v3.user.get({
      path: { user_id: openId },
      params: { user_id_type: 'open_id', department_id_type: 'open_department_id' },
    }),
    '获取飞书用户部门信息失败',
  )
  // 单个用户接口的响应为 { data: { user: { department_ids } } }；getJson 已解开 data，仍需进入 user。
  const currentUser = requireObject(current.user, '获取飞书用户部门信息')
  const departmentIds = [...new Set(optionalArray(currentUser.department_ids, '获取飞书用户部门信息.department_ids'))]

  const departments = await Promise.all(departmentIds.map(async departmentId => {
    const data = await sdkData(
      () => client.contact.v3.department.get({
        path: { department_id: departmentId },
        params: { department_id_type: 'open_department_id', user_id_type: 'open_id' },
      }),
      '获取飞书部门信息失败',
    )
    return requireObject(data.department, '获取飞书部门信息')
  }))

  const leaderNameById = new Map()
  const leaderIds = [...new Set(departments.flatMap(department => [
    department.leader_user_id,
    ...(Array.isArray(department.leaders) ? department.leaders.map(leader => leader.leaderID) : []),
  ]).filter(id => typeof id === 'string' && id))]
  await Promise.all(leaderIds.map(async leaderId => {
    leaderNameById.set(leaderId, await getUserDisplayName(client, leaderId))
  }))

  return departments.map(department => ({
    ...department,
    leaderNames: [...new Set([
      department.leader_user_id,
      ...(Array.isArray(department.leaders) ? department.leaders.map(leader => leader.leaderID) : []),
    ].map(id => leaderNameById.get(id)).filter(Boolean))],
  }))
}
