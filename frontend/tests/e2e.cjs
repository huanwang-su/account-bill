const { chromium, expect } = require("@playwright/test");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-ledger-e2e-"));
const port = 18765;
const url = `http://127.0.0.1:${port}`;
const python = process.env.LEDGER_PYTHON || path.join(root, ".venv/bin/python");
const server = spawn(
  python,
  [
    "-m",
    "uvicorn",
    "app.main:create_app",
    "--factory",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
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
const headers = {
  "Content-Type": "application/json",
  "X-Ledger-Client": "local-web",
};
async function api(endpoint, method = "GET", data) {
  const r = await fetch(url + "/api" + endpoint, {
    method,
    headers,
    body: data ? JSON.stringify(data) : undefined,
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
(async () => {
  let browser;
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try {
        await api("/health");
        ready = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    if (!ready) throw new Error("Test server did not start");
    browser = await chromium.launch({
      executablePath:
        process.env.CHROME_PATH ||
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true,
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1080 },
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(url);
    await page.locator("nav button").filter({ hasText: "账户管理" }).click();
    await page.getByRole("button", { name: /添加账户/ }).click();
    await page.getByLabel("账户名称", { exact: true }).fill("测试储蓄");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /保\s*存/ })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    let accounts = await api("/accounts");
    const account = accounts.find((a) => a.name === "测试储蓄");
    if (!account) throw new Error("UI did not create account");
    await api(`/accounts/${account.id}/opening`, "POST", {
      amount: "1000.00",
      occurred_at: "2020-01-01",
    });
    await page
      .locator(".account-grid .ant-card")
      .filter({ hasText: "测试储蓄" })
      .getByRole("button", { name: /对\s*账/ })
      .click();
    await page
      .getByLabel("外部实际余额（元，欠款填负数）", { exact: true })
      .fill("1000.00");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /保\s*存/ })
      .click();
    await expect(
      page
        .locator(".ant-modal-confirm-title")
        .filter({ hasText: "余额核对一致" }),
    ).toBeVisible();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /知\s*道\s*了|确\s*定/ })
      .click();
    await page.locator("header button").filter({ hasText: "记一笔" }).click();
    await page.getByLabel("付款账户", { exact: true }).click();
    await page
      .locator(".ant-select-item-option-content")
      .getByText("测试储蓄", { exact: true })
      .click();
    await page.locator("#items_0_category_id").click();
    await page
      .locator(".ant-select-tree-title")
      .getByText("餐饮", { exact: true })
      .click();
    await page.getByPlaceholder("金额（元）", { exact: true }).fill("12.34");
    await page.getByLabel("交易对方", { exact: true }).fill("测试餐厅");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /保\s*存/ })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    let txs = await api("/transactions");
    let tx = txs.find((t) => t.counterparty === "测试餐厅");
    if (tx?.amount !== 1234) throw new Error("UI amount wrong");
    await page.locator("nav button").filter({ hasText: "账户流水" }).click();
    const row = page.locator("tr").filter({ hasText: "测试餐厅" });
    await row.getByRole("button", { name: /修\s*改/ }).click();
    await page.getByPlaceholder("金额（元）", { exact: true }).fill("20.00");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /保\s*存/ })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    txs = await api("/transactions");
    tx = txs.find((t) => t.counterparty === "测试餐厅");
    if (tx?.amount !== 2000) throw new Error("UI replace failed");
    await row.getByRole("button", { name: /撤\s*销/ }).click();
    await page
      .locator(".ant-popconfirm")
      .getByRole("button", { name: /确\s*定/ })
      .click();
    await expect(
      page.locator("tr").filter({ hasText: "测试餐厅" }),
    ).toHaveCount(0);
    if ((await api("/reports/summary")).expense !== 0)
      throw new Error("Reversal affected summary");
    await page.locator("nav button").filter({ hasText: "账单导入" }).click();
    const csv =
      "支付宝账户：test@example.com\n交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号\n2026-09-01 12:00:00,餐饮美食,导入测试商户,午餐,支出,30.00,账户余额,交易成功,order-1\n2026-09-02 12:00:00,投资理财,测试收益,收益,收入,0.03,余额宝,交易成功,order-2\n";
    await page
      .locator('.import-workspace input[type=file][accept=".csv,.xlsx,.pdf"]')
      .setInputFiles({
        name: "测试支付宝.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(csv),
      });
    await expect(
      page.getByText(
        "账单状态：正常 2 条 · 忽略 0 条。忽略记录仅保留在账单中，不转入交易明细。",
        { exact: true },
      ),
    ).toBeVisible();
    const run = (await api("/import-runs"))[0];
    const artifact = run.artifacts.find((a) => a.stage === "NORMALIZED");
    const doc = await (
      await fetch(url + `/api/import-artifacts/${artifact.id}`)
    ).json();
    for (const r of doc.bills)
      r.classification = {
        category_path:
          r.facts.counterparty === "测试收益"
            ? ["收入", "理财收益"]
            : ["支出", "餐饮"],
        tags: [],
        status:
          r.facts.counterparty === "测试收益" ? "NEEDS_REVIEW" : "CLASSIFIED",
        note: "测试",
        classified_by: "Codex",
      };
    const form = new FormData();
    form.append(
      "file",
      new Blob([JSON.stringify(doc)], { type: "application/json" }),
      "classified.json",
    );
    const saved = await fetch(
      url + `/api/import-runs/${run.id}/classifications`,
      {
        method: "POST",
        headers: { "X-Ledger-Client": "local-web" },
        body: form,
      },
    );
    if (!saved.ok) throw Error(await saved.text());
    await api(`/import-runs/${run.id}/commit`, "POST");
    await page.reload();
    await page.locator("nav button").filter({ hasText: "账单导入" }).click();
    await page.getByText("原始账单记录（只读）", { exact: true }).click();
    const raw = page.locator(".raw-import-records");
    await expect(raw.locator("input[type=file]")).toHaveCount(0);
    await expect(
      raw.getByRole("button", { name: /确认入账|确认 \/ 调整|忽略/ }),
    ).toHaveCount(0);
    await expect(
      raw.getByText("原文件收入合计", { exact: true }),
    ).toBeVisible();
    await expect(
      raw.getByText("原文件支出合计", { exact: true }),
    ).toBeVisible();
    const beforeInspection = await api("/reports/summary");
    await raw
      .getByRole("button", { name: "原始字段", exact: true })
      .first()
      .click();
    await expect(
      page.getByRole("dialog").getByText("交易订单号", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    if (
      JSON.stringify(await api("/reports/summary")) !==
      JSON.stringify(beforeInspection)
    )
      throw Error("Read-only inspection changed financial data");
    if (beforeInspection.expense !== 3000) throw Error("Import summary wrong");
    // All financial confirmation now uses the unified detail page.
    await raw
      .getByRole("button", { name: "前往交易明细", exact: true })
      .click();
    await page
      .locator(".bill-workspace tr")
      .filter({ hasText: "测试收益" })
      .getByRole("button", { name: "核对入账", exact: true })
      .click();
    await expect(
      page.getByRole("dialog").getByText("收入", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "确认并入账", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    if ((await api("/reports/summary")).income !== 3)
      throw Error("Reviewed income wrong");
    await page.locator("nav button").filter({ hasText: "账单导入" }).click();
    await page
      .locator('.import-workspace input[type=file][accept=".csv,.xlsx,.pdf"]')
      .setInputFiles({
        name: "重复.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(csv),
      });
    await expect(
      page.getByRole("button", { name: "保存 AI 分类文件", exact: false }),
    ).toBeEnabled();
    const repeat = (await api("/import-runs"))[0];
    const repeatForm = new FormData();
    repeatForm.append(
      "file",
      new Blob([JSON.stringify(doc)], { type: "application/json" }),
      "classified.json",
    );
    const classified = await fetch(
      url + `/api/import-runs/${repeat.id}/classifications`,
      {
        method: "POST",
        headers: { "X-Ledger-Client": "local-web" },
        body: repeatForm,
      },
    );
    if (!classified.ok) throw Error(await classified.text());
    const repeated = await api(`/import-runs/${repeat.id}/commit`, "POST");
    if (repeated.created !== 0 || repeated.posted !== 0)
      throw Error("Duplicate posted twice");
    await page.locator("nav button").filter({ hasText: "总览" }).click();
    await page.waitForTimeout(700);
    await page.screenshot({
      path: path.join(dir, "populated-overview.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(200);
    if (
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 2,
      )
    )
      throw new Error("Mobile layout overflows viewport");
    await page.screenshot({
      path: path.join(dir, "mobile.png"),
      fullPage: true,
    });
    if (!(await api("/integrity")).ok)
      throw new Error("Ledger integrity failed");
    if (errors.length) throw new Error(errors.join("\n"));
    console.log(
      JSON.stringify({
        ok: true,
        flows: [
          "账户创建",
          "对账结果",
          "记账",
          "修改冲销",
          "撤销",
          "CSV 上传",
          "原始记录只读",
          "统一明细核对入账",
          "人工确认收入",
          "重复导入",
          "统计图表",
          "窄屏页面",
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
