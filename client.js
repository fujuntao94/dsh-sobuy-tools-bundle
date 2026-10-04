// Desktop 只显示一个入口按钮；真正的配置表单放在 src/pages/setup.html。
window.__ModuleLoader__.load({
  id: "dsh-sobuy-tools-bundle",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const { jsx, jsxs } = require("react/jsx-runtime");

    const NS = "settings.sobuyFeishuTools";
    const zh = {
      title: "Sobuy 飞书工具",
      description: "设置飞书凭据并授权。",
      openSetup: "打开飞书设置页",
      note: "设置页会在浏览器中打开；保存后直接进入飞书官方授权页。",
    };
    const en = {
      title: "Sobuy Feishu tools",
      description:
        "Configure Feishu credentials and authorization.",
      openSetup: "Open Feishu settings",
      note: "The settings page opens in your browser and then goes to Feishu authorization.",
    };

    function FeishuSettingsLink({ t }) {
      function openSetupPage() {
        // 用户点击时打开，避免 Desktop 浏览器把本机设置页拦截为弹窗。
        window.open("http://127.0.0.1:18081/feishu/setup", "_blank");
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
            children: t("openSetup"),
          }),
          jsx("p", {
            style: {
              margin: "10px 0 0",
              color: "var(--dsw-alias-label-secondary)",
              fontSize: "13px",
              lineHeight: 1.6,
            },
            children: t("note"),
          }),
        ],
      });
    }

    function FeishuLoginCard({ view, t }) {
      if (view === "summary") return t("description");
      return jsx(FeishuSettingsLink, { t });
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(
        () => ctx.locale.register(NS, { zh, en }),
        "sobuy-feishu-tools: dictionaries",
      );
      ctx.slots.inject("plugins.item", () =>
        ctx.slots.register(
          {
            name: "plugins.item",
            id: "sobuy-feishu-tools",
            order: 50,
            label: () => t("title"),
            locale: NS,
          },
          FeishuLoginCard,
        ),
      );
    }

    exports.NS = NS;
    exports.inject = ["slots", "locale"];
    exports.apply = apply;
    return module.exports;
  },
});
