/**
 * 飞书能力白名单：这是“插件究竟能做什么”的唯一来源。
 *
 * 新增飞书业务时，必须先新增专用 Tool，再把它登记到这里；
 * 不能因为 SDK 存在某个接口，就让模型直接调用它。
 */
const CAPABILITIES = [
  { id: 'login', name: '登录与授权', tool: 'feishu_login', examples: ['登录飞书', '刷新登录', '退出飞书'] },
  { id: 'user-info', name: '我的个人资料', tool: 'feishu_user_info', examples: ['我的飞书资料'] },
  { id: 'organization', name: '我的部门与负责人', tool: 'feishu_my_departments', examples: ['我在哪个部门', '我的领导是谁'] },
  { id: 'leave-balances', name: '我的假期余额', tool: 'feishu_my_leave_balances', examples: ['我的年假还有多少'] },
  { id: 'diagnostics', name: '操作与权限诊断', tool: 'feishu_operation_logs', examples: ['飞书权限为什么报错'] },
  { id: 'capabilities', name: '能力范围', tool: 'feishu_capabilities', examples: ['飞书插件支持什么功能'] },
]

// 明确列出常见但尚未实现的类别，方便 Skill 作出一致的拒绝回答。
export const UNSUPPORTED_CATEGORIES = ['发送消息', '审批', '考勤打卡', '日历', '群管理', '云文档', '多维表格', '请假申请']

/** Tool 输出使用副本，避免调用方改写模块内的能力定义。 */
export function publicCapabilities() {
  return CAPABILITIES.map(({ id, name, tool, examples }) => ({ id, name, tool, examples: [...examples] }))
}
