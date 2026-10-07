const content = `# 客户画像

使用 \`customer_profile_lookup\` 根据 OMS \`customer_id\` 查询客户订单画像。工具只读取固定的三张表：\`oms_t_orders\`（客户身份、订单、金额、售后与取消特征）、\`oms_t_orders_product\`（常购 SKU）和 \`oms_t_orders_tracking\`（国家、签收与异常履约）。

不要猜测或编造客户身份、消费习惯、风险或联系方式。客户姓名、邮箱、电话、地址等个人资料只有在本机设置页保存解密密钥，并由已获授权的操作者显式启用“显示已解密个人资料”后才会返回；解密失败或缺少密钥的字段保持为空。`

export function registerCustomerProfileSkill(ctx) {
  return ctx.skills.register({
    name: 'customer-profile',
    description: '基于 OMS 固定订单链路的客户画像与受控个人资料解密。',
    source: 'bundled',
    content,
    invocation: { modelInvocable: true, userInvocable: true },
  })
}
