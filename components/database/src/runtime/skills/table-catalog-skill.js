/** 数据表数量、名称和用途的最小问答 Skill。 */
const SKILL_NAME = 'database-table-catalog'
const SKILL_DESCRIPTION = '统计当前配置数据库中有多少张数据表，并列出表名和表备注用途；不查询字段结构或业务数据。'

const SKILL_CONTENT = `# 数据库表清单

用户询问数据库有多少张表、有哪些表或各表用途时，调用无参数的 \`database_list_tables\`。

先回答“共有 N 张数据表”，再只列出“表名”和“用途”。用途严格使用 Tool 返回的 \`purpose\`；没有表备注时保留“未填写表备注”，不要根据表名猜测。

不要查询字段、记录数、样例数据或业务数据，不执行任意 SQL，也不展示数据库连接信息或驱动原始错误。`

export function registerTableCatalogSkill(ctx) {
  return ctx.skills.register({
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    source: 'bundled',
    content: SKILL_CONTENT,
    invocation: { modelInvocable: true, userInvocable: true },
  })
}
