const { chromium, expect } = require("@playwright/test");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-flow-"));
const url = "http://127.0.0.1:18766";
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
    "18766",
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
async function api(p) {
  const r = await fetch(url + "/api" + p);
  if (!r.ok) throw Error(await r.text());
  return r.json();
}
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
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(url);
    const nav = async (name) =>
      page.locator("nav button").filter({ hasText: name }).click();
    await nav("账单导入");
    const csv =
      "支付宝账户：test@example.com\n交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号\n2026-09-01 12:00:00,餐饮美食,测试商户,午餐,支出,30.00,支付宝小荷包(家用),交易成功,order-1\n2026-09-01 13:00:00,餐饮美食,待核对商户,晚餐,支出,50.00,未知账户,交易成功,order-2\n2026-09-01 14:00:00,餐饮美食,忽略测试商户,内部记录,不计收支,12.00,支付宝小荷包(家用),交易成功,order-ignored\n";
    const uploadOriginal = async () =>
      page
        .locator('.import-workspace input[type=file][accept=".csv,.xlsx,.pdf"]')
        .setInputFiles({
          name: "账单.csv",
          mimeType: "text/csv",
          buffer: Buffer.from(csv),
        });
    await uploadOriginal();
    await expect(
      page
        .locator(".import-workspace table")
        .getByText("测试商户", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "账单状态：正常 2 条 · 忽略 1 条。忽略记录仅保留在账单中，不转入交易明细。",
        { exact: true },
      ),
    ).toBeVisible();
    await page.getByText("全部账单状态", { exact: true }).click();
    await page
      .locator(".ant-select-item-option-content")
      .getByText("忽略", { exact: true })
      .click();
    await expect(
      page
        .locator(".import-workspace table")
        .getByText("忽略测试商户", { exact: true }),
    ).toBeVisible();
    await expect(
      page
        .locator(".import-workspace table")
        .getByText("测试商户", { exact: true }),
    ).toHaveCount(0);
    await page
      .locator(".ant-select-selector")
      .filter({ hasText: "忽略" })
      .click();
    await page
      .locator(".ant-select-item-option-content")
      .getByText("全部账单状态", { exact: true })
      .click();
    if ((await api("/bills")).length) throw Error("Staging published early");
    let run = (await api("/import-runs"))[0];
    const original = run.artifacts.find((a) => a.stage === "ORIGINAL");
    const normalized = run.artifacts.find((a) => a.stage === "NORMALIZED");
    if (
      (await (
        await fetch(url + `/api/import-artifacts/${original.id}`)
      ).text()) !== csv
    )
      throw Error("Original changed");
    const doc = await (
      await fetch(url + `/api/import-artifacts/${normalized.id}`)
    ).json();
    for (const r of doc.bills)
      r.classification = {
        category_path: ["支出", "餐饮", "午餐"],
        tags: ["工作日"],
        status: "CLASSIFIED",
        note: "依据商品描述",
        classified_by: "Codex",
      };
    const uploadClass = async () =>
      page
        .locator(
          '.import-workspace .classification-upload input[type=file][accept=".json"]',
        )
        .setInputFiles({
          name: "已分类.json",
          mimeType: "application/json",
          buffer: Buffer.from(JSON.stringify(doc)),
        });
    await uploadClass();
    await expect(
      page.getByRole("button", { name: "导入并入账", exact: true }),
    ).toBeEnabled();
    if ((await api("/transactions")).length)
      throw Error("Classification posted early");
    await page.getByRole("button", { name: "导入并入账", exact: true }).click();
    await expect(
      page.getByText("新增 2 条，跳过 0 条；入账 1 条，待核对 1 条", {
        exact: true,
      }),
    ).toBeVisible();
    if ((await api("/reports/summary")).expense !== 3000)
      throw Error("Automatic posting failed");
    await page
      .locator(".import-workspace")
      .getByRole("button", { name: "查看文件", exact: true })
      .first()
      .click();
    await expect(page.getByRole("dialog").locator("pre")).toContainText(
      "支付宝账户",
    );
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await nav("交易明细");
    await page.reload();
    await expect(
      page
        .locator(".bill-workspace table")
        .getByText("忽略测试商户", { exact: true }),
    ).toHaveCount(0);
    let normal = page
      .locator(".bill-workspace tr")
      .filter({ hasText: "测试商户" });
    let pending = page
      .locator(".bill-workspace tr")
      .filter({ hasText: "待核对商户" });
    await expect(normal.getByText("已入账", { exact: true })).toBeVisible();
    await expect(
      normal.getByText("小荷包（家用）", { exact: true }),
    ).toBeVisible();
    await normal.getByRole("button", { name: "修正分类", exact: true }).click();
    await page
      .getByLabel("分类路径", { exact: true })
      .fill("支出 / 餐饮 / 食堂");
    await page.getByRole("button", { name: "保存分类", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await normal.getByRole("button", { name: /详\s*情/ }).click();
    await expect(
      page.getByRole("dialog").getByText("order-1", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("分类修改历史", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await pending
      .getByRole("button", { name: "核对入账", exact: true })
      .click();
    await page
      .getByLabel("收付款账户（转账为转出账户）", { exact: true })
      .click();
    await page
      .locator(".ant-select-item-option-content")
      .getByText("小荷包（家用）", { exact: true })
      .click();
    await page.getByRole("button", { name: "确认并入账", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    if ((await api("/reports/summary")).expense !== 8000)
      throw Error("Review failed");
    await normal.getByRole("button", { name: "撤销交易", exact: true }).click();
    await page
      .locator(".ant-popconfirm")
      .getByRole("button", { name: /确\s*定/ })
      .click();
    await expect(normal.getByText("已撤销", { exact: true })).toBeVisible();
    if ((await api("/reports/summary")).expense !== 5000)
      throw Error("Single reversal failed");
    await nav("账单导入");
    await uploadOriginal();
    await expect(
      page.getByText("与已有明细重复 2 条，冲突 0 条", { exact: true }),
    ).toBeVisible();
    await uploadClass();
    await page.getByRole("button", { name: "导入并入账", exact: true }).click();
    await expect(
      page.getByText("新增 0 条，跳过 2 条；入账 0 条，待核对 0 条", {
        exact: true,
      }),
    ).toBeVisible();
    if ((await api("/reports/summary")).expense !== 5000)
      throw Error("Repeat resurrected reversal");
    const cancel = async () => {
      await page.getByRole("button", { name: "撤销账单", exact: true }).click();
      await page
        .locator(".ant-popconfirm")
        .getByRole("button", { name: /确\s*定/ })
        .click();
    };
    await cancel();
    await expect(
      page.getByText("已撤销 0 条明细", { exact: true }),
    ).toBeVisible();
    if ((await api("/reports/summary")).expense !== 5000)
      throw Error("Duplicate cancellation touched original");
    await page
      .locator(".import-workspace .ant-select-selector")
      .first()
      .click();
    await page
      .locator(".ant-select-item-option")
      .filter({ hasText: "#1 ·" })
      .click();
    await expect(
      page.getByRole("button", { name: "撤销账单", exact: true }),
    ).toBeEnabled();
    await cancel();
    await expect(
      page.getByText("已撤销 1 条明细", { exact: true }),
    ).toBeVisible();
    if ((await api("/reports/summary")).expense !== 0)
      throw Error("Batch reversal failed");
    const balance = (await api("/accounts")).find(
      (a) => a.name === "小荷包（家用）",
    ).balance;
    if (balance !== 0) throw Error("Balances not restored");
    if ((await api("/bills")).length !== 2)
      throw Error("Reversal deleted details");
    if (!(await api("/integrity")).ok) throw Error("Unbalanced ledger");
    const ignoredCsv =
      csv
        .split("\n")
        .filter((line, i) => i < 2 || line.includes("order-ignored"))
        .join("\n") + "\n";
    await page
      .locator('.import-workspace input[type=file][accept=".csv,.xlsx,.pdf"]')
      .setInputFiles({
        name: "全部忽略.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(ignoredCsv),
      });
    await expect(
      page.getByRole("button", { name: "导入并入账", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "导入并入账", exact: true }).click();
    await expect(
      page.getByText("新增 0 条，跳过 0 条；入账 0 条，待核对 0 条", {
        exact: true,
      }),
    ).toBeVisible();
    if ((await api("/bills")).length !== 2)
      throw Error("All ignored file created details");
    await page.screenshot({
      path: path.join(dir, "reversed-batch.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    if (
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 2,
      )
    )
      throw Error("Mobile overflow");
    if (errors.length) throw Error(errors.join("\n"));
    console.log(
      JSON.stringify({
        ok: true,
        flows: [
          "忽略账单状态与筛选",
          "忽略记录不转明细",
          "全忽略无需分类",
          "文件存档",
          "分类阶段不入账",
          "导入自动入账",
          "待核对确认",
          "人工分类同步",
          "单笔撤销",
          "重复导入不恢复撤销",
          "重复批次撤销隔离",
          "整批撤销余额恢复",
          "文件与明细保留",
          "小荷包账户",
          "窄屏布局",
        ],
        screenshot: path.join(dir, "reversed-batch.png"),
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
