// Desktop 分别显示飞书和数据库入口；真正的配置表单由各组件的本机设置页提供。
window.__ModuleLoader__.load({
  id: "dsh-sobuy-tools-bundle",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const { jsx, jsxs } = require("react/jsx-runtime");

    const NS = "settings.sobuyTools";
    const zh = {
      feishuTitle: "Sobuy 飞书工具",
      feishuDescription: "设置飞书凭据并授权。",
      openFeishuSetup: "打开飞书设置页",
      feishuNote: "设置页会在浏览器中打开；保存后直接进入飞书官方授权页。",
      databaseTitle: "Sobuy 数据库工具",
      databaseDescription: "设置只读数据库连接信息。",
      openDatabaseSetup: "打开数据库设置页",
      databaseNote: "设置页会在浏览器中打开；密码不会在状态页中回显。",
    };
    const en = {
      feishuTitle: "Sobuy Feishu tools",
      feishuDescription:
        "Configure Feishu credentials and authorization.",
      openFeishuSetup: "Open Feishu settings",
      feishuNote: "The settings page opens in your browser and then goes to Feishu authorization.",
      databaseTitle: "Sobuy database tools",
      databaseDescription: "Configure read-only database connection details.",
      openDatabaseSetup: "Open database settings",
      databaseNote: "The settings page opens in your browser; the saved password is never displayed.",
    };

    function SettingsLink({ t, url, buttonLabel, note }) {
      function openSetupPage() {
        // 用户点击时打开，避免 Desktop 浏览器把本机设置页拦截为弹窗。
        window.open(url, "_blank");
      }

      return jsxs("section", {
        style: {
          maxWidth: "520px",
          padding: "12px 0",
          color: "var(--dsw-alias-label-primary)",
        },
        children: [
          // 保持与 DeepSeek 设置页一致：不额外套卡片、阴影或渐变。
          jsx("button", {
            type: "button",
            onClick: openSetupPage,
            style: {
              height: "40px",
              padding: "0 16px",
              border: 0,
              borderRadius: "8px",
              background: "#3370ff",
              color: "#fff",
              cursor: "pointer",
              font: "500 14px inherit",
            },
            children: t(buttonLabel),
          }),
          jsx("p", {
            style: {
              margin: "10px 0 0",
              color: "var(--dsw-alias-label-secondary)",
              fontSize: "13px",
              lineHeight: 1.6,
            },
            children: t(note),
          }),
        ],
      });
    }

    function FeishuLoginCard({ view, t }) {
      if (view === "summary") return t("feishuDescription");
      return jsx(SettingsLink, {
        t,
        url: "http://127.0.0.1:18081/feishu/setup",
        buttonLabel: "openFeishuSetup",
        note: "feishuNote",
      });
    }

    function DatabaseSettingsCard({ view, t }) {
      if (view === "summary") return t("databaseDescription");
      return jsx(SettingsLink, {
        t,
        url: "http://127.0.0.1:18082/database/setup",
        buttonLabel: "openDatabaseSetup",
        note: "databaseNote",
      });
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(
        () => ctx.locale.register(NS, { zh, en }),
        "sobuy-tools: dictionaries",
      );
      ctx.slots.inject("plugins.item", () =>
        ctx.slots.register(
          {
            name: "plugins.item",
            id: "sobuy-feishu-tools",
            order: 50,
            label: () => t("feishuTitle"),
            locale: NS,
          },
          FeishuLoginCard,
        ),
      );
      ctx.slots.inject("plugins.item", () =>
        ctx.slots.register(
          {
            name: "plugins.item",
            id: "sobuy-database-tools",
            order: 51,
            label: () => t("databaseTitle"),
            locale: NS,
          },
          DatabaseSettingsCard,
        ),
      );
    }

    exports.NS = NS;
    exports.inject = ["slots", "locale"];
    exports.apply = apply;
    return module.exports;
  },
});
