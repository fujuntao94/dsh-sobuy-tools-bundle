import {
  DEFAULT_COVERAGE_DAYS,
  DEFAULT_FORECAST_TOP_N,
  INVENTORY_SHORTAGE_FORECAST_TABLES,
  MAX_COVERAGE_DAYS,
  MAX_FORECAST_TOP_N,
  runInventoryShortageForecast,
} from "../../domains/inventory-shortage-forecast.js";
import { configPath, readConfig } from "../../storage/config-store.js";
import { errorKind } from "../../security/query-audit.js";

const NUMBER = { type: "number" };
const STRING = { type: "string" };

function hasDatabaseConfig(config) {
  return Boolean(
    config?.host &&
    config?.port &&
    config?.database &&
    config?.username &&
    config?.password,
  );
}

function rowLines(row, index) {
  return [
    `${index + 1}. ${row.sku} @ ${row.warehouseName}(${row.warehouseId}) [${row.riskLabel}]：预测月销量 ${row.monthlyForecastQty} 件，日均 ${row.forecastDailyQty} 件，当前可用 ${row.localAvailable}，覆盖约 ${row.stockCoverDays} 天。`,
    `   缺口：达到 ${row.coverageThresholdDays} 天覆盖仍差 ${row.shortfallQty} 件；其他仓可用 ${row.otherWarehouseAvailable}${row.transferCandidates ? `，候选仓：${row.transferCandidates}` : ""}。`,
    row.forecastOwners ? `   预测责任人：${row.forecastOwners}` : null,
    row.localStockUpdatedAt
      ? `   库存更新时间：${row.localStockUpdatedAt}`
      : null,
    `   建议：${row.recommendedAction}`,
  ].filter(Boolean);
}

export function createInventoryShortageForecastTool({
  dataDirectory,
  forecast = runInventoryShortageForecast,
  auditLogger,
} = {}) {
  return {
    name: "database_inventory_shortage_forecast",
    description:
      "只读预测性缺货预警：按当前自然月 SKU×仓库预测销量和当前库存计算覆盖天数，只返回低于覆盖阈值的分组。用于发现“尚未缺货但即将断货”的商品；不扫描订单缺货明细。已经缺货的订单原因请使用 database_soldout_attribution。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        warehouse_id: {
          type: "integer",
          minimum: 1,
          description: "可选。只预警指定仓库。",
        },
        coverage_days: {
          type: "integer",
          minimum: 1,
          maximum: MAX_COVERAGE_DAYS,
          description: `覆盖天数阈值：只返回覆盖天数低于该值的分组，默认 ${DEFAULT_COVERAGE_DAYS}。`,
        },
        top_n: {
          type: "integer",
          minimum: 1,
          maximum: MAX_FORECAST_TOP_N,
          description: `返回条数上限，默认 ${DEFAULT_FORECAST_TOP_N}。`,
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: [
          "forecastMonth",
          "coverageThresholdDays",
          "groups",
          "summary",
          "rows",
        ],
        properties: {
          forecastMonth: STRING,
          coverageThresholdDays: NUMBER,
          groups: NUMBER,
          summary: {
            type: "object",
            additionalProperties: false,
            required: ["byRisk", "byWarehouse", "byOwner"],
            properties: {
              byRisk: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "risk",
                    "groups",
                    "monthlyForecastQty",
                    "shortfallQty",
                  ],
                  properties: {
                    risk: STRING,
                    groups: NUMBER,
                    monthlyForecastQty: NUMBER,
                    shortfallQty: NUMBER,
                  },
                },
              },
              byWarehouse: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "warehouse",
                    "groups",
                    "monthlyForecastQty",
                    "shortfallQty",
                  ],
                  properties: {
                    warehouse: STRING,
                    groups: NUMBER,
                    monthlyForecastQty: NUMBER,
                    shortfallQty: NUMBER,
                  },
                },
              },
              byOwner: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "owner",
                    "groups",
                    "monthlyForecastQty",
                    "shortfallQty",
                  ],
                  properties: {
                    owner: STRING,
                    groups: NUMBER,
                    monthlyForecastQty: NUMBER,
                    shortfallQty: NUMBER,
                  },
                },
              },
            },
          },
          rows: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "sku",
                "warehouseId",
                "warehouseName",
                "forecastMonth",
                "monthlyForecastQty",
                "forecastDailyQty",
                "localAvailable",
                "localUsednum",
                "localStockStatus",
                "localStockUpdatedAt",
                "stockCoverDays",
                "coverageThresholdDays",
                "shortfallQty",
                "otherWarehouseAvailable",
                "transferCandidates",
                "forecastOwners",
                "riskLevel",
                "riskLabel",
                "recommendedAction",
              ],
              properties: {
                sku: STRING,
                warehouseId: NUMBER,
                warehouseName: STRING,
                forecastMonth: STRING,
                monthlyForecastQty: NUMBER,
                forecastDailyQty: NUMBER,
                localAvailable: NUMBER,
                localUsednum: NUMBER,
                localStockStatus: NUMBER,
                localStockUpdatedAt: STRING,
                stockCoverDays: NUMBER,
                coverageThresholdDays: NUMBER,
                shortfallQty: NUMBER,
                otherWarehouseAvailable: NUMBER,
                transferCandidates: STRING,
                forecastOwners: STRING,
                riskLevel: STRING,
                riskLabel: STRING,
                recommendedAction: STRING,
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (!value.rows.length)
          return [
            {
              type: "text",
              text: `预测性缺货预警：当前没有库存覆盖低于 ${value.coverageThresholdDays} 天的 SKU×仓库分组。`,
            },
          ];
        const summary = value.summary.byRisk
          .map(
            (item) =>
              `${item.risk} ${item.groups} 组 / 缺口 ${item.shortfallQty} 件`,
          )
          .join("；");
        return [
          {
            type: "text",
            text: [
              `${value.forecastMonth} 预测性缺货预警（覆盖阈值 ${value.coverageThresholdDays} 天，共 ${value.groups} 组）：${summary}`,
              ...value.rows.flatMap(rowLines),
              "注意：覆盖天数基于当前库存和当前月预测销量，不是采购到货承诺；其他仓库存只表示候选调拨量。",
            ].join("\n"),
          },
        ];
      },
    },
    async execute(args, exec) {
      const startedAt = Date.now();
      let meta = {};
      if (exec?.signal?.aborted) throw new Error("预测性缺货预警查询已取消。");
      const config = await readConfig(dataDirectory);
      if (!hasDatabaseConfig(config))
        throw new Error(
          `请先在数据库设置页保存完整连接信息。配置文件位置：${configPath(dataDirectory)}`,
        );
      try {
        const result = await forecast(config, args, { signal: exec?.signal });
        meta = {
          coverageDays: result.coverageThresholdDays,
          appliedLimit: result.groups,
        };
        auditLogger?.record({
          operation: "inventory_shortage_forecast",
          status: "success",
          table: INVENTORY_SHORTAGE_FORECAST_TABLES[0],
          rowCount: result.groups,
          ...meta,
          durationMs: Math.max(0, Date.now() - startedAt),
        });
        return result;
      } catch (error) {
        auditLogger?.record({
          operation: "inventory_shortage_forecast",
          status: "error",
          table: INVENTORY_SHORTAGE_FORECAST_TABLES[0],
          ...meta,
          errorKind: errorKind(error),
          durationMs: Math.max(0, Date.now() - startedAt),
        });
        if (exec?.signal?.aborted)
          throw new Error("预测性缺货预警查询已取消。");
        if (
          error?.code === "DATABASE_QUERY_TIMEOUT" ||
          error?.code === "DATABASE_QUERY_CANCELLED"
        )
          throw error;
        if (/不支持参数|整数/.test(String(error?.message))) throw error;
        throw new Error(
          "无法完成预测性缺货预警查询，请检查数据库设置、网络和只读账号权限。",
        );
      }
    },
  };
}

export function registerInventoryShortageForecastTool(ctx, options) {
  return ctx.tools.register(createInventoryShortageForecastTool(options));
}
