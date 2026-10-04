// 入口只编排各类工具：不写 OAuth 细节，也不写业务 API，方便以后逐个添加工具模块。
import { registerLoginTool } from './src/runtime/tools/login-tool.js'
import { registerUserInfoTool } from './src/runtime/tools/user-info-tool.js'
import { registerDepartmentTool } from './src/runtime/tools/department-tool.js'
import { registerLeaveBalanceTool } from './src/runtime/tools/leave-balance-tool.js'
import { registerOperationLogTool } from './src/runtime/tools/operation-log-tool.js'
import { registerCapabilitiesTool } from './src/runtime/tools/capabilities-tool.js'
import { registerLoginGuideSkill } from './src/runtime/skills/login-guide-skill.js'
import { registerUserInfoSkill } from './src/runtime/skills/user-info-skill.js'
import { registerLeaveBalanceSkill } from './src/runtime/skills/leave-balance-skill.js'
import { registerLeaveBalanceDiagnoseSkill } from './src/runtime/skills/leave-balance-diagnose-skill.js'
import { registerOrganizationSkill } from './src/runtime/skills/organization-skill.js'
import { registerPermissionDiagnoseSkill } from './src/runtime/skills/permission-diagnose-skill.js'
import { registerCapabilityBoundarySkill } from './src/runtime/skills/capability-boundary-skill.js'
import { provideFeishuAuthService } from './src/runtime/services/feishu-auth-service.js'
import { provideOperationTelemetryService } from './src/runtime/services/operation-telemetry-service.js'
import { registerFeishuToolHooks } from './src/runtime/hooks/feishu-tool-hooks.js'
import { registerFeishuCapabilityGuard } from './src/runtime/guards/feishu-capability-guard.js'

export const name = 'dsh-sobuy-feishu-tools'
export const inject = ['tools', 'skills']

export function apply(ctx, config = {}) {
  provideFeishuAuthService(ctx, config)
  provideOperationTelemetryService(ctx)
  registerFeishuToolHooks(ctx)
  registerFeishuCapabilityGuard(ctx)
  registerLoginTool(ctx, config)
  registerUserInfoTool(ctx, config)
  registerDepartmentTool(ctx, config)
  registerLeaveBalanceTool(ctx, config)
  registerOperationLogTool(ctx)
  registerCapabilitiesTool(ctx)
  registerLeaveBalanceSkill(ctx)
  registerLeaveBalanceDiagnoseSkill(ctx)
  registerOrganizationSkill(ctx)
  registerPermissionDiagnoseSkill(ctx)
  registerCapabilityBoundarySkill(ctx)
  registerLoginGuideSkill(ctx)
  registerUserInfoSkill(ctx)
}
