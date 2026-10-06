/**
 * 宿主（DSH）对工具 schema 的强制子集校验。
 *
 * 为什么需要这个模块：宿主的 `tools.register()` 会对 `output.schema` 调用
 * `assertSupportedJsonSchema()`，不合规就抛 `JsonSchemaError`。而这个异常发生在
 * **插件 entry 的激活阶段**，一旦抛出，整个组件（含其它完全正常的工具）全部无法激活 ——
 * 表现就是插件列表里显示「启用失败」，且不只是一个工具不可用。
 *
 * 真实事故：`type: ['number', 'null']` 这类**联合类型数组**会让整个数据库组件
 * （6 个工具）一起激活失败，报错原文：
 *   schema.properties.filters.properties.dictId.type must be a single type string
 *   (type arrays are not supported)
 *
 * 规则抄自宿主的 `@deepseek-ai/dsh-tools/lib/types/json-schema.js`（checkSchemaNode /
 * checkValue）。要点：
 *
 * 1. **只接受单一标量 type**；可空字段必须写成 `oneOf: [{ type: 'x' }, { type: 'null' }]`。
 * 2. 关键字白名单：type / oneOf / properties / required / additionalProperties / items
 *    / enum / const，外加注解 description / title / default / examples。
 *    像 `minimum`、`maxLength`、`minLength`、`format`、`pattern` 这些**不是**合法关键字，
 *    只能出现在工具参数（parameters）里 —— 参数不受这套子集约束，输出 schema 受。
 * 3. `oneOf` 旁不能有 properties / required / additionalProperties / items / enum / const，
 *    但 `description` 允许。
 * 4. 输出值在运行时同样按 `output.schema` 校验（createSuccessResult → validateJsonSchemaValue），
 *    所以把可空字段声明成单类型，即使注册通过、运行到那一步也会失败。
 *
 * 本模块只做纯函数校验，不依赖宿主内部包，便于单测。
 */

/** 宿主支持的标量类型。 */
export const DSH_SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']

/** 约束类关键字白名单。 */
export const DSH_CONSTRAINT_KEYWORDS = ['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const']

/** 注解类关键字白名单。 */
export const DSH_ANNOTATION_KEYWORDS = ['description', 'title', 'default', 'examples']

/** 与 oneOf 并列即非法的关键字。 */
export const DSH_ONE_OF_SIBLING_KEYWORDS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']

/**
 * 表达可空字段的**唯一受支持写法**。
 * 不要用 `type: ['string', 'null']` —— 那会让整个插件激活失败。
 * @param type - 非空时的标量类型，例如 'string' / 'number'。
 * @param description - 字段说明。
 * @returns 可空字段的 schema 片段。
 */
export function nullableSchema(type, description) {
  return {
    oneOf: [{ type }, { type: 'null' }],
    description,
  }
}

const isPlainRecord = value => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const isScalarMatch = (type, value) => {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return false
  }
}

/**
 * 校验 schema 本身是否落在宿主支持的子集内。
 * @param schema - 待校验的 schema。
 * @returns 违规描述列表，空数组表示合规。
 */
export function dshToolSchemaViolations(schema) {
  const violations = []
  const seen = new Set()
  const visit = (node, path) => {
    if (!isPlainRecord(node) && !Array.isArray(node)) {
      violations.push(`${path} must be a schema object`)
      return
    }
    if (seen.has(node)) {
      violations.push(`${path} is circular`)
      return
    }
    seen.add(node)
    try {
      for (const key of Object.keys(node)) {
        if (DSH_CONSTRAINT_KEYWORDS.includes(key) || DSH_ANNOTATION_KEYWORDS.includes(key)) continue
        violations.push(`${path}.${key} is not a supported keyword (subset: ${DSH_CONSTRAINT_KEYWORDS.join('/')} + annotations)`)
      }
      if (Object.hasOwn(node, 'description') && typeof node.description !== 'string') {
        violations.push(`${path}.description must be a string`)
      }
      const hasType = Object.hasOwn(node, 'type')
      const hasOneOf = Object.hasOwn(node, 'oneOf')
      if (hasType && hasOneOf) {
        violations.push(`${path} cannot declare both type and oneOf`)
        return
      }
      if (!hasType && !hasOneOf) {
        for (const key of DSH_ONE_OF_SIBLING_KEYWORDS) {
          if (Object.hasOwn(node, key)) violations.push(`${path}.${key} requires type or oneOf`)
        }
        return
      }
      if (hasOneOf) {
        for (const key of DSH_ONE_OF_SIBLING_KEYWORDS) {
          if (Object.hasOwn(node, key)) violations.push(`${path}.${key} is not supported beside oneOf`)
        }
        if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
          violations.push(`${path}.oneOf must be an array of at least two schemas`)
        } else {
          node.oneOf.forEach((branch, index) => visit(branch, `${path}.oneOf[${index}]`))
        }
        return
      }
      const type = node.type
      if (typeof type !== 'string' || !DSH_SCHEMA_TYPES.includes(type)) {
        violations.push(Array.isArray(type)
          ? `${path}.type must be a single type string (type arrays are not supported)`
          : `${path}.type must be one of ${DSH_SCHEMA_TYPES.join('/')}`)
        return
      }
      const keywordTypes = {
        properties: ['object'], required: ['object'], additionalProperties: ['object'], items: ['array'],
        enum: ['string', 'number', 'integer', 'boolean', 'null'], const: ['string', 'number', 'integer', 'boolean', 'null'],
      }
      for (const [key, allowed] of Object.entries(keywordTypes)) {
        if (Object.hasOwn(node, key) && !allowed.includes(type)) violations.push(`${path}.${key} is not supported on type "${type}"`)
      }
      if (type === 'object') {
        if (Object.hasOwn(node, 'properties')) {
          if (!isPlainRecord(node.properties)) violations.push(`${path}.properties must be an object of schemas`)
          else for (const [key, child] of Object.entries(node.properties)) visit(child, `${path}.properties.${key}`)
        }
        if (Object.hasOwn(node, 'required') && !Array.isArray(node.required)) violations.push(`${path}.required must be an array`)
        return
      }
      if (type === 'array' && Object.hasOwn(node, 'items')) visit(node.items, `${path}.items`)
    } finally {
      seen.delete(node)
    }
  }
  visit(schema, 'schema')
  return violations
}

/**
 * 断言 schema 合规；不合规时抛出与宿主同格式的错误。
 * @param schema - 待校验的 schema。
 */
export function assertDshToolSchema(schema) {
  const violations = dshToolSchemaViolations(schema)
  if (violations.length > 0) throw new Error(`unsupported JSON schema: ${violations.join('; ')}`)
}

/**
 * 校验输出值是否符合 schema（对应宿主的 createSuccessResult）。
 * @param schema - 工具的输出 schema。
 * @param value - 待校验的输出值。
 * @returns 违规描述列表，空数组表示合规。
 */
export function dshToolValueViolations(schema, value) {
  const violations = []
  const visit = (node, current, path) => {
    if (Array.isArray(node.oneOf)) {
      const matches = node.oneOf.filter(branch => dshToolValueViolations(branch, current).length === 0).length
      if (matches !== 1) violations.push(`"${path}" must match exactly one oneOf branch (matched ${matches})`)
      return
    }
    const type = node.type
    if (type === undefined) return
    if (type === 'object') {
      if (!isPlainRecord(current)) { violations.push(`"${path}" must be an object`); return }
      const properties = node.properties ?? {}
      for (const key of node.required ?? []) {
        if (!Object.hasOwn(current, key) || current[key] === undefined) violations.push(`missing required property "${key}"`)
      }
      if (node.additionalProperties === false) {
        for (const key of Object.keys(current)) {
          if (!Object.hasOwn(properties, key)) violations.push(`"${key}" is not a declared property (additionalProperties: false)`)
        }
      }
      for (const [key, child] of Object.entries(properties)) {
        if (!Object.hasOwn(current, key) || current[key] === undefined) continue
        visit(child, current[key], `${path}.${key}`)
      }
      return
    }
    if (type === 'array') {
      if (!Array.isArray(current)) { violations.push(`"${path}" must be an array`); return }
      if (node.items !== undefined) current.forEach((entry, index) => visit(node.items, entry, `${path}[${index}]`))
      return
    }
    if (!isScalarMatch(type, current)) { violations.push(`"${path}" must be a ${type}`); return }
    if (Array.isArray(node.enum) && !node.enum.includes(current)) violations.push(`"${path}" must be one of ${JSON.stringify(node.enum)}`)
    if (Object.hasOwn(node, 'const') && current !== node.const) violations.push(`"${path}" must be ${JSON.stringify(node.const)}`)
  }
  visit(schema, value, 'value')
  return violations
}

/**
 * 断言输出值合规。
 * @param schema - 工具的输出 schema。
 * @param value - 待校验的输出值。
 */
export function assertDshToolValue(schema, value) {
  const violations = dshToolValueViolations(schema, value)
  if (violations.length > 0) throw new Error(`tool output rejected: ${violations.join('; ')}`)
}
