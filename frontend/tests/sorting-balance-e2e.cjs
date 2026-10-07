const { chromium, expect } = require("@playwright/test");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const root = path.resolve(__dirname, "../.."),
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-sorting-balance-"));
const python = process.env.LEDGER_PYTHON || path.join(root, ".venv/bin/python");
const env = {
  ...process.env,
  PYTHONPATH: path.join(root, "backend"),
  LEDGER_DB: path.join(dir, "db"),
};
const seeded = spawnSync(
  python,
  [path.join(__dirname, "sorting_balance_fixture.py"), env.LEDGER_DB],
  { env, encoding: "utf8" },
);
if (seeded.status !== 0) throw Error(seeded.stderr);
const groups = JSON.parse(seeded.stdout);
const url = "http://127.0.0.1:18776";
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
    "18776",
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
    const api = async (p) => (await fetch(url + "/api" + p)).json();
    browser = await chromium.launch({
      executablePath:
        process.env.CHROME_PATH ||
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
    const select = async (name, label) => {
      await page.getByRole("combobox", { name, exact: true }).locator("../..").click();
      await page
        .locator(".ant-select-dropdown:visible")
        .getByText(label, { exact: true })
        .click();
    };
    const rows = (table) => table.locator("tbody > tr.ant-table-row");
    const firstId = (table) => rows(table).first().getAttribute("data-row-key");
    const next = async (table) => {
      const before = await firstId(table);
      await table
        .locator(".ant-pagination-next:not(.ant-pagination-disabled)")
        .click();
      await expect.poll(() => firstId(table)).not.toBe(before);
    };
    const collect = async (table) => {
      const ids = [];
      for (let i = 0; i < 20; i++) {
        ids.push(
          ...(await rows(table).evaluateAll((rs) =>
            rs.map((r) => r.getAttribute("data-row-key")),
          )),
        );
        if (
          await table
            .locator(".ant-pagination-next.ant-pagination-disabled")
            .count()
        )
          return ids;
        await next(table);
      }
      throw Error("pagination did not finish");
    };
    await page.goto(url);
    await expect(
      page.getByRole("combobox", { name: "交易排序字段", exact: true }),
    ).toBeVisible();
    const data = await api("/bills"),
      byId = new Map(data.map((r) => [r.id, r]));
    let table = page.locator(".bill-workspace .ant-table-wrapper");
    await expect(rows(table)).toHaveCount(15);
    await next(table);
    await select("交易排序字段", "交易金额");
    await expect(table.locator(".ant-pagination-item-active")).toHaveText("1");
    let ids = await collect(table);
    expect(ids.length).toBe(data.length);
    expect(new Set(ids).size).toBe(data.length);
    let amounts = ids.map(
      (id) =>
        byId.get(id).effective_amount_minor ?? byId.get(id).facts.amount_minor,
    );
    expect(amounts).toEqual([...amounts].sort((a, b) => b - a));
    expect(amounts[0]).toBe(900000); // External opening detail also participates in sorting.
    const partial = data.find((r) => r.facts.counterparty === "部分退款商户");
    expect(partial.facts.amount_minor).toBe(10000);
    expect(partial.effective_amount_minor).toBe(1000);
    expect(ids.indexOf(partial.id)).toBeGreaterThan(50);
    console.log("PASS 金额按全部记录排序，使用部分退款净额，跨页完整无重复");
    await table.getByRole("columnheader", { name: /金额 \/ 方向/ }).click();
    await expect(table.locator(".ant-pagination-item-active")).toHaveText("1");
    await expect(
      page
        .getByRole("combobox", { name: "交易排序方向", exact: true })
        .locator("../.."),
    ).toContainText("升序");
    ids = await collect(table);
    amounts = ids.map(
      (id) =>
        byId.get(id).effective_amount_minor ?? byId.get(id).facts.amount_minor,
    );
    expect(amounts).toEqual([...amounts].sort((a, b) => a - b));
    await select("交易排序字段", "交易时间");
    ids = await collect(table);
    const dates = ids.map((id) => byId.get(id).facts.occurred_at);
    expect(dates).toEqual([...dates].sort());
    await select("入账状态", "待核对");
    await expect(rows(table)).toHaveCount(2);
    await expect(table.locator(".ant-pagination-item-active")).toHaveText("1");
    await select("交易排序字段", "交易对方");
    await expect(rows(table)).toHaveCount(2);
    console.log(
      "PASS 表头与排序控件同步，时间和交易对方排序，筛选及排序回首页",
    );
    await nav("总览");
    await page.getByRole("button", { name: /查看资产负债表/ }).click();
    await expect(
      page.getByRole("heading", { name: "资产负债表", exact: true }),
    ).toBeVisible();
    await select("资产负债表账户组", "排序测试家庭");
    const dateInput = page.getByRole("textbox", {
      name: "资产负债表截止日期",
      exact: true,
    });
    const date = async (value) => {
      await dateInput.fill(value);
      await dateInput.press("Enter");
      await expect(page.locator(".balance-sheet-note")).toContainText(value);
    };
    await date("2026-09-10");
    await expect(page.getByTestId("balance-assets")).toHaveText("¥ 1,600.00");
    await expect(page.getByTestId("balance-liabilities")).toHaveText(
      "¥ 200.00",
    );
    await expect(page.getByTestId("balance-net")).toHaveText("¥ 1,400.00");
    await expect(
      page
        .locator(".balance-sheet-workspace")
        .getByText("排序测试成员甲", { exact: true })
        .first(),
    ).toBeVisible();
    await expect(
      page.getByText("测试停用信用卡", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("隐藏合并来源", { exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByText("测试外部商户", { exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByText(/1 个账户的期初余额尚未补全/)).toBeVisible();
    console.log(
      "PASS 独立资产负债表及总览入口，账户组树，合并去重，停用保留，外部账户排除",
    );
    await date("2026-09-30");
    await expect(page.getByTestId("balance-assets")).toHaveText("¥ 2,100.00");
    await expect(page.getByTestId("balance-net")).toHaveText("¥ 1,900.00");
    const family = await api(
      `/reports/balance-sheet?as_of=2026-09-30&group_id=${groups.family}`,
    );
    await select("资产负债表账户组", "排序测试家庭 / 排序测试成员甲");
    await expect(page.getByTestId("balance-assets")).toHaveText("¥ 1,500.00");
    await expect(page.getByTestId("balance-net")).toHaveText("¥ 1,300.00");
    const mine = await api(
      `/reports/balance-sheet?as_of=2026-09-30&group_id=${groups.mine}`,
    );
    const spouse = await api(
      `/reports/balance-sheet?as_of=2026-09-30&group_id=${groups.spouse}`,
    );
    expect(mine.net_assets + spouse.net_assets).toBe(family.net_assets);
    console.log("PASS 日期切换、个人筛选和家庭守恒，期初不完整提示");
    await page.screenshot({
      path: path.join(dir, "balance-sheet.png"),
      fullPage: true,
    });
    for (const width of [1280, 1920]) {
      await page.setViewportSize({ width, height: 1100 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
      ).toBe(false);
    }
    expect((await api("/integrity")).ok).toBe(true);
    expect(errors).toEqual([]);
    console.log(
      JSON.stringify({
        ok: true,
        screenshot: path.join(dir, "balance-sheet.png"),
      }),
    );
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
