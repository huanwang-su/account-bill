const { chromium, expect } = require("@playwright/test");
const { spawn } = require("node:child_process");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const root = path.resolve(__dirname, "../.."),
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-config-")),
  url = "http://127.0.0.1:18768";
const server = spawn(
  path.join(root, ".venv/bin/python"),
  [
    "-m",
    "uvicorn",
    "app.main:create_app",
    "--factory",
    "--host",
    "127.0.0.1",
    "--port",
    "18768",
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      PYTHONPATH: path.join(root, "backend"),
      LEDGER_DB: path.join(dir, "test.sqlite3"),
    },
    stdio: "ignore",
  },
);
const api = async (p, method = "GET", data) => {
  const r = await fetch(url + "/api" + p, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Ledger-Client": "local-web",
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!r.ok) throw Error(await r.text());
  return r.json();
};
(async () => {
  let browser;
  try {
    for (let i = 0; i < 80; i++) {
      try {
        await api("/health");
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    browser = await chromium.launch({
      executablePath:
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true,
    });
    const page = await browser.newPage({
        viewport: { width: 1450, height: 1050 },
      }),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const nav = async (text) =>
      page.locator("nav button").filter({ hasText: text }).click();
    await page.goto(url);
    await nav("数据");
    await expect(page.getByText("数据备份与恢复", { exact: true })).toBeVisible();
    await expect(
      page.getByText("AI 分类与复核参考", { exact: true }),
    ).toHaveCount(0);
    await nav("设置");
    await expect(page.getByText("数据备份与恢复", { exact: true })).toHaveCount(0);
    const reference = page.locator("#classification-reference");
    await reference.fill(
      (await reference.inputValue()) +
        "\n测试配置：仅细分类不明确可使用宽泛分类。",
    );
    await page
      .getByRole("button", { name: "保存分类参考", exact: true })
      .click();
    await expect
      .poll(async () => (await api("/classification-policy")).revision)
      .toBe(1);
    const choose = async (label, value) => {
      await page
        .locator(`.ant-select[aria-label="${label}"] .ant-select-selector`)
        .click();
      const controls = await page
        .getByRole("combobox", { name: label, exact: true })
        .getAttribute("aria-controls");
      await page
        .locator(`#${controls}`)
        .locator('xpath=ancestor::div[contains(@class,"ant-select-dropdown")]')
        .locator(".ant-select-item-option-content")
        .getByText(value, { exact: true })
        .click();
    };
    for (const [name, parent] of [
      ["家庭", null],
      ["我的账户", "家庭"],
      ["老婆的账户", "家庭"],
    ]) {
      await page
        .getByRole("button", { name: "新建账户组", exact: true })
        .click();
      await page.getByLabel("账户组名称", { exact: true }).fill(name);
      if (parent) {
        await page.getByLabel("父账户组", { exact: true }).click();
        await page
          .locator(
            ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content",
          )
          .getByText(parent, { exact: true })
          .click();
      }
      await page
        .getByRole("button", { name: "保存账户组", exact: true })
        .click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }
    await choose("分配所属账户组", "家庭 / 我的账户");
    await choose("分配资金账户", "支付宝余额");
    await page
      .locator(
        ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content",
      )
      .getByText("余额宝", { exact: true })
      .click();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "保存所属组", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await api("/account-groups")).find((g) => g.name === "我的账户")
            .account_count,
      )
      .toBe(2);
    for (const [id, amount] of [
      [5, "10"],
      [6, "20"],
    ])
      await api("/transactions", "POST", {
        kind: "EXPENSE",
        account_id: id,
        category_id: 1,
        amount,
        occurred_at: "2026-09-01 12:00:00",
        idempotency_key: "seed-" + id,
      });
    await page.reload();
    await nav("设置");
    await choose("合并来源账户", "余额宝");
    await choose("合并目标账户", "支付宝余额");
    await page.getByRole("button", { name: "预览合并", exact: true }).click();
    await expect(page.getByText("合并后余额", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "确认合并", exact: true }).click();
    await page
      .locator(".ant-popconfirm")
      .getByRole("button", { name: /确\s*定/ })
      .click();
    await expect
      .poll(
        async () => (await api("/accounts")).find((a) => a.id === 5).balance,
      )
      .toBe(-3000);
    await nav("账户管理");
    await expect(
      page.locator(".account-grid").getByText("余额宝", { exact: true }),
    ).toHaveCount(0);
    await nav("账单导入");
    const csv =
      "支付宝账户：test\n交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号\n2026-09-02 12:00:00,餐饮美食,餐厅,午餐,支出,30.00,余额宝,交易成功,pay\n2026-09-03 12:00:00,餐饮美食,餐厅,退款午餐,收入,30.00,余额宝,退款成功,refund\n2026-09-03 13:00:00,餐饮美食,餐厅,部分退款,收入,1.00,余额宝,退款成功,partial\n";
    await page
      .locator('.import-workspace input[type=file][accept=".csv,.xlsx,.pdf"]')
      .setInputFiles({
        name: "配对测试.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(csv),
      });
    await expect(
      page.getByText(
        "账单状态：正常 3 条 · 忽略 0 条。忽略记录仅保留在账单中，不转入交易明细。",
        { exact: true },
      ),
    ).toBeVisible();
    const run = (await api("/import-runs"))[0],
      normal = run.artifacts.find((a) => a.stage === "NORMALIZED");
    const doc = await (
      await fetch(url + "/api/import-artifacts/" + normal.id)
    ).json();
    if (!doc.ai_reference.reference.includes("测试配置"))
      throw Error("AI reference missing");
    for (const r of doc.bills)
      r.classification = {
        category_path:
          r.facts.settlement === "REFUNDED"
            ? ["退款", "原子分类"]
            : ["支出", "餐饮"],
        tags: [],
        status: "CLASSIFIED",
        note: "测试",
        classified_by: "Codex",
      };
    await page
      .locator(".classification-upload input[type=file]")
      .setInputFiles({
        name: "分类.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(doc)),
      });
    await expect(
      page.getByRole("button", { name: "导入并入账", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "导入并入账", exact: true }).click();
    await expect
      .poll(async () => (await api("/reports/summary")).expense)
      .toBe(6000);
    const candidates = await api(`/import-runs/${run.id}/refund-candidates`),
      review = {
        schema_version: "local-ledger.refund-matches.v1",
        run_id: run.id,
        candidates_digest: candidates.candidates_digest,
        decisions: candidates.refunds.map((r) => {
          const matching = r.payments.find(
            (p) => p.facts.amount_minor === r.refund.facts.amount_minor,
          );
          return {
            refund_id: r.refund.id,
            payment_id: matching?.id || null,
            decision: matching ? "MATCHED" : "UNMATCHED",
            note: matching ? "说明与金额完全对应" : "未确认部分退款关联",
            matched_by: "Codex",
          };
        }),
      };
    await page.locator(".refund-match-upload input[type=file]").setInputFiles({
      name: "退款匹配.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(review)),
    });
    await expect(
      page.getByText(
        "账单状态：正常 1 条 · 忽略 2 条。忽略记录仅保留在账单中，不转入交易明细。",
        { exact: true },
      ),
    ).toBeVisible();
    if ((await api("/reports/summary")).expense !== 3000)
      throw Error("Refund pair did not reverse payment");
    const details = await api("/bills");
    if (
      !details.find(
        (r) =>
          r.facts.settlement === "REFUNDED" &&
          r.classification.category_path.join("/") === "退款",
      )
    )
      throw Error("Refund category mismatch");
    const groups = await api("/account-groups");
    if (groups.find((g) => g.name === "家庭").balance !== -3000)
      throw Error("Family double counted balance");
    const current = await api(`/import-runs/${run.id}`);
    if (!current.artifacts.some((a) => a.stage === "REFUND_MATCHES"))
      throw Error("Decision not archived");
    await nav("设置");
    await page.screenshot({
      path: path.join(dir, "settings.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "解除合并", exact: true }).click();
    await page
      .locator(".ant-popconfirm")
      .getByRole("button", { name: /确\s*定/ })
      .click();
    await expect
      .poll(async () => (await api("/accounts")).find((a) => a.id === 6).active)
      .toBe(true);
    if (!(await api("/integrity")).ok || errors.length)
      throw Error("Integrity or browser errors: " + errors.join(","));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: path.join(dir, "mobile-settings.png"),
      fullPage: true,
    });
    console.log(
      JSON.stringify({
        ok: true,
        flows: [
          "账户组层级配置",
          "所属组分配",
          "合并预览与确认",
          "余额与导入映射统一",
          "合并来源隐藏",
          "退款候选与AI文件保存",
          "成对忽略冲回付款",
          "退款单分类",
          "家庭汇总不重复",
          "解除合并",
          "财务平衡",
          "窄屏设置",
        ],
        screenshots: dir,
      }),
    );
  } finally {
    if (browser) await browser.close();
    server.kill("SIGTERM");
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
