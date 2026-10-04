/**
 * “我的部门”工具入口。
 * 工具没有参数：调用者身份已经由本机 OAuth 登录态决定，不能也不需要传用户 ID。
 */
import { getMyDepartments } from '../../domains/organization/department-api.js'

/** 只输出可展示的部门信息；所有部门、用户、群及 HRBP 标识均留在接口内部。 */
function publicDepartments(departments) {
  return departments.map(department => ({
    name: department.name || department.i18n_name?.zh_cn || department.i18n_name?.en_us || '未命名部门',
    ...(department.i18n_name ? { i18nName: department.i18n_name } : {}),
    ...(Number.isFinite(department.member_count) ? { memberCount: department.member_count } : {}),
    ...(Number.isFinite(department.primary_member_count) ? { primaryMemberCount: department.primary_member_count } : {}),
    ...(typeof department.status?.is_deleted === 'boolean' ? { isDeleted: department.status.is_deleted } : {}),
    ...(department.leaderNames?.length ? { leaderNames: department.leaderNames } : {}),
  }))
}

export function registerDepartmentTool(ctx, config = {}) {
  ctx.tools.register({
    name: 'feishu_my_departments',
    description: '查询当前 OAuth 用户的部门与负责人。无需也不能传入用户 ID 或部门 ID；不返回内部 ID。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object', additionalProperties: false, required: ['departments'],
        properties: {
          departments: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false, required: ['name'],
              properties: {
                name: { type: 'string' },
                i18nName: { type: 'object', additionalProperties: true },
                memberCount: { type: 'number' },
                primaryMemberCount: { type: 'number' },
                isDeleted: { type: 'boolean' },
                leaderNames: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.departments.length
          ? `当前部门与负责人：${value.departments.map(department => `${department.name}${department.leaderNames?.length ? `（负责人：${department.leaderNames.join('、')}）` : ''}`).join('；')}`
          : '未找到部门信息',
      }],
    },
    async execute(_args, exec) {
      return ctx.feishuTelemetry.run({ tool: 'feishu_my_departments', exec }, async () => {
        const { openId } = await ctx.feishuAuth.getCurrentOpenId({ signal: exec.signal })
        const client = await ctx.feishuAuth.getSdkClient({ signal: exec.signal })
        const departments = await getMyDepartments(client, openId)
        return { departments: publicDepartments(departments) }
      }, value => ({ departmentCount: value.departments.length }))
    },
  })
}
