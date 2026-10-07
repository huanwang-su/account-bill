const { chromium, expect } = require("@playwright/test");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const root = path.resolve(__dirname, "../.."),
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-analysis-")),
  url = "http://127.0.0.1:18777";
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
    "18777",
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
    const cats = await api("/categories"),
      category = (name) => cats.find((c) => c.name === name).id;
    await api("/transactions", "POST", {
      kind: "EXPENSE",
      account_id: 5,
      occurred_at: "2026-09-11",
      counterparty: "餐饮分类合成",
      items: [
        { amount: "20", category_id: category("买菜") },
        { amount: "10", category_id: category("日常用餐") },
      ],
      idempotency_key: "analysis-split",
    });
    await api("/transactions", "POST", {
      kind: "INCOME",
      account_id: 5,
      amount: "20",
      occurred_at: "2026-09-12",
      category_id: category("红包收入"),
      idempotency_key: "analysis-income",
    });
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
    const select = async (name, label) => {
      await page
        .getByRole("combobox", { name, exact: true })
        .locator("../..")
        .click();
      await page
        .locator(".ant-select-dropdown:visible")
        .getByText(label, { exact: true })
        .click();
    };
    const next = async (table) => {
      const first = await table
        .locator("tbody tr.ant-table-row")
        .first()
        .getAttribute("data-row-key");
      await table
        .locator(".ant-pagination-next:not(.ant-pagination-disabled)")
        .click();
      await expect
        .poll(() =>
          table
            .locator("tbody tr.ant-table-row")
            .first()
            .getAttribute("data-row-key"),
        )
        .not.toBe(first);
    };
    await page.goto(url);
    await page.locator("nav button").filter({ hasText: "统计报表" }).click();
    await expect(
      page.getByRole("tab", { name: "收支分析", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("analysis-income")).toHaveText("¥ 520.00");
    await expect(page.getByTestId("analysis-expense")).toHaveText("¥ 2,770.00");
    await expect(page.getByTestId("analysis-net")).toHaveText("¥ -2,250.00");
    await expect(
      page
        .getByRole("img", { name: "收入支出净收支趋势曲线", exact: true })
        .locator("canvas"),
    ).toHaveCount(1);
    await expect(
      page
        .getByRole("img", { name: "收入分类占比饼图", exact: true })
        .locator("canvas"),
    ).toHaveCount(1);
    await expect(
      page
        .getByRole("img", { name: "支出分类占比饼图", exact: true })
        .locator("canvas"),
    ).toHaveCount(1);
    const snapshot = await api("/reports/analysis");
    expect(snapshot.count).toBe(69);
    expect(snapshot.expense).toBe(277000);
    console.log("PASS 报表子页、收入支出曲线与饼图，净退款和期初/转账排除");
    await select("收支趋势粒度", "按月");
    await expect(page.getByTestId("analysis-expense")).toHaveText("¥ 2,770.00");
    await select("分析分类层级", "按二级分类");
    await expect(
      page
        .locator(".financial-analysis-workspace")
        .getByText("餐饮 / 买菜", { exact: true }),
    ).toBeVisible();
    await page
      .locator(".analysis-category-title")
      .evaluate((el) => el.scrollIntoView({ block: "start" }));
    const scrollBefore = await page.evaluate(() => window.scrollY);
    expect(scrollBefore).toBeGreaterThan(200);
    await page.route("**/api/reports/analysis?**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.continue();
    });
    await page
      .locator(".financial-analysis-workspace")
      .getByRole("button", { name: "餐饮 / 买菜", exact: true })
      .click();
    await expect(page.locator(".ant-spin-spinning")).toBeVisible();
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(
      scrollBefore - 80,
    );
    await expect(
      page
        .getByRole("img", { name: "收入支出净收支趋势曲线", exact: true })
        .locator("canvas"),
    ).toHaveCount(1);
    await expect(page.getByTestId("analysis-expense")).toHaveText("¥ 20.00");
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(
      scrollBefore - 80,
    );
    await page.unroute("**/api/reports/analysis?**");
    await expect(page.getByTestId("analysis-income")).toHaveText("¥ 0.00");
    await page.getByRole("button", { name: "重置条件", exact: true }).click();
    await expect(page.getByTestId("analysis-expense")).toHaveText("¥ 2,770.00");
    console.log("PASS 一级/二级分类、分类钻取、拆分交易只计算匹配部分");
    const threshold = page.getByRole("spinbutton", {
      name: "大额交易门槛",
      exact: true,
    });
    await threshold.fill("50");
    await page
      .getByRole("button", { name: "应用大额门槛", exact: true })
      .click();
    await expect(page.getByTestId("analysis-large-count")).toHaveText("26 笔");
    let table = page.locator(".analysis-large-table .ant-table-wrapper");
    await expect(table.locator("tbody tr.ant-table-row")).toHaveCount(10);
    const ids = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        ...(await table
          .locator("tbody tr.ant-table-row")
          .evaluateAll((rs) => rs.map((r) => r.getAttribute("data-row-key")))),
      );
      if (
        await table
          .locator(".ant-pagination-next.ant-pagination-disabled")
          .count()
      )
        break;
      await next(table);
    }
    expect(ids.length).toBe(26);
    expect(new Set(ids).size).toBe(26);
    await select("大额交易类型", "支出");
    await expect(table.locator(".ant-pagination-item-active")).toHaveText("1");
    await expect(page.locator(".analysis-large-summary")).toContainText(
      "25 笔",
    );
    await table
      .getByRole("button", { name: "查看", exact: true })
      .first()
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    console.log("PASS 大额门槛、跨页无重复、收支筛选及查看原交易");
    await select("收支分析账户组", "排序测试家庭 / 排序测试成员乙");
    await expect(page.getByTestId("analysis-income")).toHaveText("¥ 0.00");
    await expect(
      page.getByText("当前条件没有已入账的收支记录", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "重置条件", exact: true }).click();
    await expect(page.getByTestId("analysis-expense")).toHaveText("¥ 2,770.00");
    await page.getByRole("tab", { name: "资产负债表", exact: true }).click();
    await expect(
      page.getByRole("combobox", { name: "资产负债表账户组", exact: true }),
    ).toBeVisible();
    expect(
      await page
        .locator("nav button")
        .filter({ hasText: "资产负债表" })
        .count(),
    ).toBe(0);
    await page.getByRole("tab", { name: "统计明细", exact: true }).click();
    await expect(
      page.getByText("统计明细", { exact: true }).last(),
    ).toBeVisible();
    await page.getByRole("tab", { name: "收支分析", exact: true }).click();
    await expect(page.getByTestId("analysis-expense")).toBeVisible();
    await page.locator(".analysis-intro h2").click();
    // Let chart reveal animations finish after the hidden tab becomes visible.
    await page.waitForTimeout(1300);
    await page.screenshot({
      path: path.join(dir, "income-expense-analysis.png"),
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
        screenshot: path.join(dir, "income-expense-analysis.png"),
      }),
    );
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
