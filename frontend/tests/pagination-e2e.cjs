const { chromium, expect } = require("@playwright/test");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const root = path.resolve(__dirname, "../..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-pagination-"));
const python = path.join(root, ".venv/bin/python");
const env = {
  ...process.env,
  PYTHONPATH: path.join(root, "backend"),
  LEDGER_DB: path.join(dir, "db"),
};
const seeded = spawnSync(
  python,
  [path.join(__dirname, "pagination_fixture.py"), env.LEDGER_DB],
  { env, encoding: "utf8" },
);
if (seeded.status !== 0) throw Error(seeded.stderr);
const url = "http://127.0.0.1:18772";
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
    "18772",
  ],
  { cwd: root, env, stdio: "ignore" },
);
(async () => {
  let browser;
  try {
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(url + "/api/health")).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 150));
    }
    browser = await chromium.launch({
      executablePath:
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true,
    });
    const page = await browser.newPage({
        viewport: { width: 1600, height: 1100 },
      }),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const nav = async (name) =>
      page.locator("nav button").filter({ hasText: name }).click();
    const tableRows = (table) => table.locator("tbody > tr.ant-table-row");
    const next = async (table) =>
      table
        .locator(".ant-pagination-next:not(.ant-pagination-disabled)")
        .click();
    const size = async (table, n) => {
      await table.locator(".ant-pagination-options .ant-select").click();
      await page
        .locator(".ant-select-dropdown:visible")
        .getByText(`${n} 条/页`, { exact: true })
        .click();
    };
    const select = async (locator, text) => {
      await locator.locator("..").locator("..").click();
      await page
        .locator(".ant-select-dropdown:visible .ant-select-item-option")
        .filter({ hasText: text })
        .click();
    };
    const allPages = async (table, total) => {
      const ids = [];
      while (true) {
        ids.push(
          ...(await tableRows(table).evaluateAll((rows) =>
            rows.map((r) => r.getAttribute("data-row-key")),
          )),
        );
        if (
          await table
            .locator(".ant-pagination-next.ant-pagination-disabled")
            .count()
        )
          break;
        const previous = await tableRows(table)
          .first()
          .getAttribute("data-row-key");
        await next(table);
        await expect
          .poll(() => tableRows(table).first().getAttribute("data-row-key"))
          .not.toBe(previous);
      }
      expect(ids.length).toBe(total);
      expect(new Set(ids).size).toBe(total);
    };
    await page.goto(url);
    await expect(
      page.getByRole("combobox", { name: "分类状态", exact: true }),
    ).toBeVisible();
    let table = page.locator(".bill-workspace .ant-table-wrapper").first();
    await expect(tableRows(table)).toHaveCount(15);
    await allPages(table, 67);
    await size(table, 20);
    await expect(tableRows(table)).toHaveCount(20);
    await expect(table.locator(".ant-pagination-item-active")).toHaveText("1");
    await next(table);
    await select(
      page.getByRole("combobox", { name: "入账状态", exact: true }),
      "待核对",
    );
    await expect(tableRows(table)).toHaveCount(2);
    await expect(table.locator(".ant-pagination-item-active")).toHaveText("1");
    console.log("PASS 明细跨页完整且无重复，切换条数生效，筛选回首页");
    await nav("总览");
    await expect(
      page.getByText("2 条记录待确认入账", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: /查看待处理/ }).click();
    await expect(
      page.getByRole("heading", { name: "交易明细", exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("combobox", { name: "入账状态", exact: true })
        .locator("..")
        .locator(".."),
    ).toContainText("待核对");
    await expect(
      tableRows(page.locator(".bill-workspace .ant-table-wrapper").first()),
    ).toHaveCount(2);
    console.log("PASS 待处理入口直接进入待核对交易");
    await nav("账户流水");
    table = page.locator(".page-content .ant-table-wrapper").first();
    await expect(tableRows(table)).toHaveCount(15);
    await allPages(table, 65);
    await size(table, 50);
    await expect(tableRows(table)).toHaveCount(50);
    await next(table);
    await expect(tableRows(table)).toHaveCount(15);
    console.log("PASS 账户流水完整跨页，每页50条生效");
    await nav("统计报表");
    await page.getByRole("tab", { name: "统计明细", exact: true }).click();
    table = page.locator(".ant-tabs-tabpane-active .ant-table-wrapper").first();
    await expect(tableRows(table)).toHaveCount(10);
    await allPages(table, 65);
    await size(table, 20);
    await expect(tableRows(table)).toHaveCount(20);
    console.log("PASS 统计明细完整跨页，条数切换生效");
    await nav("账单导入");
    await select(
      page.getByRole("combobox", { name: "导入批次", exact: true }),
      "· 分页.csv ·",
    );
    table = page.locator(".import-workspace .ant-table-wrapper").last();
    await expect(tableRows(table)).toHaveCount(10);
    await allPages(table, 65);
    await size(table, 20);
    await expect(tableRows(table)).toHaveCount(20);
    await next(table);
    await select(
      page.getByRole("combobox", { name: "导入批次", exact: true }),
      "小批次.csv",
    );
    await expect(tableRows(table)).toHaveCount(1);
    await expect(table.locator(".ant-pagination-item-active")).toHaveText("1");
    await select(
      page.getByRole("combobox", { name: "导入批次", exact: true }),
      "退款分页.csv",
    );
    table = page
      .locator(".import-workspace .ant-table-wrapper")
      .filter({ hasText: "退款统一编号" });
    await expect(tableRows(table)).toHaveCount(5);
    await next(table);
    await expect(tableRows(table)).toHaveCount(2);
    await size(table, 10);
    await expect(tableRows(table)).toHaveCount(7);
    console.log("PASS 导入预览跨页和切换批次，退款匹配分页生效");
    await page.getByText("原始账单记录（只读）", { exact: true }).click();
    await select(
      page.getByRole("combobox", { name: "原始账单文件", exact: true }),
      /^分页\.csv$/,
    );
    table = page.locator(".raw-import-records .ant-table-wrapper");
    await expect(tableRows(table)).toHaveCount(12);
    await allPages(table, 65);
    await size(table, 20);
    await expect(tableRows(table)).toHaveCount(20);
    await next(table);
    await select(
      page.getByRole("combobox", { name: "原始账单文件", exact: true }),
      "小批次.csv",
    );
    await expect(tableRows(table)).toHaveCount(1);
    await expect(table.locator(".ant-pagination-item-active")).toHaveText("1");
    await page.screenshot({
      path: path.join(dir, "pagination.png"),
      fullPage: true,
    });
    expect(errors).toEqual([]);
    console.log("PASS 原始记录完整跨页，条数切换和批次重置；无页面错误");
    console.log("Screenshots:", dir);
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
