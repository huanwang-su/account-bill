const { chromium, expect } = require("@playwright/test");
const { spawn } = require("node:child_process");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const { randomUUID } = require("node:crypto");
const root = path.resolve(__dirname, "../.."),
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-securities-")),
  url = "http://127.0.0.1:18778";
const server = spawn(
  process.env.LEDGER_PYTHON || path.join(root, ".venv/bin/python"),
  [
    "-m",
    "uvicorn",
    "app.main:create_app",
    "--factory",
    "--host",
    "127.0.0.1",
    "--port",
    "18778",
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      PYTHONPATH: path.join(root, "backend"),
      LEDGER_DB: path.join(dir, "db"),
    },
    stdio: "ignore",
  },
);
async function api(p, method = "GET", body) {
  const response = await fetch(url + "/api" + p, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Ledger-Client": "local-web",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw Error(await response.text());
  return response.json();
}
(async () => {
  let browser;
  try {
    for (let i = 0; i < 80; i++) {
      try {
        await api("/health");
        break;
      } catch {}
      await new Promise((r) => setTimeout(r, 150));
    }
    const stock = (
      await api("/accounts", "POST", {
        name: "合成证券账户",
        kind: "证券",
        role: "ASSET",
      })
    ).id;
    const salary = (await api("/categories")).find((c) => c.name === "工资").id;
    await api("/accounts/5/opening", "POST", {
      amount: "1000",
      occurred_at: "2026-09-01",
    });
    const tx = async (kind, amount, extra = {}) =>
      (
        await api("/transactions", "POST", {
          kind,
          amount,
          account_id: 5,
          category_id: kind === "INCOME" ? salary : 1,
          counterparty: "合成交易方甲",
          occurred_at: "2026-09-02",
          idempotency_key: randomUUID(),
          ...extra,
        })
      ).id;
    await tx("INCOME", "500");
    const payment = await tx("EXPENSE", "120", { occurred_at: "2026-09-03" });
    await tx("REFUND", "20", {
      related_id: payment,
      occurred_at: "2026-09-04",
    });
    await tx("TRANSFER", "50", { to_account_id: 6, occurred_at: "2026-09-05" });
    await tx("TRANSFER", "30", {
      account_id: 6,
      to_account_id: 5,
      occurred_at: "2026-09-06",
    });
    await tx("EXPENSE", "30", {
      items: [
        { amount: "10", category_id: 1 },
        { amount: "20", category_id: 2 },
      ],
      occurred_at: "2026-09-07",
    });
    const reversed = await tx("EXPENSE", "10");
    await api(`/transactions/${reversed}/reverse`, "POST", {});
    for (let i = 0; i < 12; i++)
      await tx("EXPENSE", String(i + 1), {
        counterparty: `合成商户${String(i).padStart(2, "0")}`,
        occurred_at: "2026-09-10",
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
    const nav = async (text) =>
      page.locator("nav button").filter({ hasText: text }).click();
    await page.goto(url);
    const update = async (actual, day) => {
      await nav("账户管理");
      await page
        .getByRole("button", { name: "更多操作：合成证券账户", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "更新证券余额", exact: true })
        .click();
      const modal = page.getByRole("dialog");
      await expect(modal).toContainText("总资产");
      await modal
        .getByLabel("证券账户总资产（元）", { exact: true })
        .fill(actual);
      const date = modal.getByLabel("余额更新时间", { exact: true });
      await date.fill(day + " 00:00:00");
      await date.press("Enter");
      await date.press("Tab");
      await modal.locator('button[type="submit"]').click();
      await expect(modal).toBeHidden();
      await expect
        .poll(
          async () =>
            (await api("/accounts")).find((a) => a.id === stock).balance,
        )
        .toBe(Number(actual) * 100);
    };
    await update("1000", "2026-09-01");
    expect((await api("/reports/analysis")).income).toBe(50000);
    await update("1200", "2026-09-02");
    await tx("TRANSFER", "300", {
      to_account_id: stock,
      counterparty: "证券本金",
      occurred_at: "2026-09-03",
    });
    await nav("交易明细");
    await nav("账户管理");
    await update("1500", "2026-09-04");
    await update("1460", "2026-09-05");
    const history = await api(`/accounts/${stock}/valuations`);
    expect(history.length).toBe(4);
    expect(history.map((r) => r.change)).toEqual([-4000, 0, 20000, 0]);
    console.log(
      "PASS 证券类型、首次期初、余额更新收益与亏损、本金转入排除、零变动历史",
    );
    await page
      .getByRole("button", { name: "更多操作：合成证券账户", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "交易方分析", exact: true })
      .click();
    await expect(
      page.getByRole("tab", { name: "交易方分析", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("party-incoming")).toHaveText("¥ 300.00");
    await expect(page.getByTestId("party-net")).toHaveText("¥ 300.00");
    await expect(page.getByTestId("valuation-gain")).toHaveText("¥ 200.00");
    await expect(page.getByTestId("valuation-net")).toHaveText("¥ 160.00");
    await expect(
      page.locator(".securities-history-table tbody tr.ant-table-row"),
    ).toHaveCount(4);
    await page
      .locator(".securities-history-table")
      .getByRole("button", { name: "查看", exact: true })
      .first()
      .click();
    await expect(page.getByRole("dialog")).toContainText("证券余额更新");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.waitForTimeout(1200);
    await page.screenshot({
      path: path.join(dir, "securities-analysis.png"),
      fullPage: true,
    });
    console.log("PASS 证券盈亏与本金往来单列，历史查看对应交易");
    const selector = page.getByRole("combobox", {
      name: "交易方分析账户",
      exact: true,
    });
    await selector.locator("../..").click();
    await page
      .locator(".ant-select-dropdown:visible")
      .getByText("支付宝余额", { exact: true })
      .click();
    await expect(page.getByTestId("party-incoming")).toHaveText("¥ 550.00");
    await expect(page.getByTestId("party-outgoing")).toHaveText("¥ 578.00");
    await expect(page.getByTestId("party-net")).toHaveText("¥ -28.00");
    await expect(page.getByTestId("party-count")).toHaveText("14 / 19");
    let table = page.locator(".counterparty-table");
    await expect(table.locator("tbody tr.ant-table-row")).toHaveCount(10);
    const first = await table
      .locator("tbody tr.ant-table-row")
      .evaluateAll((rs) => rs.map((r) => r.getAttribute("data-row-key")));
    await table.locator(".ant-pagination-next").click();
    await expect(table.locator("tbody tr.ant-table-row")).toHaveCount(4);
    const second = await table
      .locator("tbody tr.ant-table-row")
      .evaluateAll((rs) => rs.map((r) => r.getAttribute("data-row-key")));
    expect(new Set([...first, ...second]).size).toBe(14);
    const search = page.getByLabel("搜索交易方", { exact: true });
    await search.fill("合成交易方甲");
    await search.press("Enter");
    await expect(page.getByTestId("party-net")).toHaveText("¥ 350.00");
    await expect(page.getByTestId("party-count")).toHaveText("1 / 6");
    await expect(table.locator(".ant-pagination-item-active")).toHaveText("1");
    await table
      .getByRole("button", { name: "合成交易方甲", exact: true })
      .click();
    const drawer = page.locator(".ant-drawer-content");
    await expect(drawer).toBeVisible();
    await expect(drawer.locator("tbody tr.ant-table-row")).toHaveCount(6);
    await drawer
      .getByRole("button", { name: "查看交易", exact: true })
      .first()
      .click();
    await expect(page.locator(".ant-modal")).toBeVisible();
    await page
      .locator(".ant-modal")
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await drawer.locator(".ant-drawer-close").click();
    await search.fill("不存在交易方");
    await search.press("Enter");
    await expect(page.getByTestId("party-count")).toHaveText("0 / 0");
    await page.getByRole("button", { name: "重置筛选", exact: true }).click();
    await expect(page.getByTestId("party-count")).toHaveText("14 / 19");
    await page.waitForTimeout(1200);
    await page.screenshot({
      path: path.join(dir, "counterparty-analysis.png"),
      fullPage: true,
    });
    console.log(
      "PASS 收付方向、退款与转账、净额与笔数、分页完整、搜索重置、交易钻取",
    );
    for (const width of [1280, 1920]) {
      await page.setViewportSize({ width, height: 1100 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
      ).toBe(false);
    }
    await nav("账户管理");
    await page.setViewportSize({ width: 1280, height: 1100 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    expect((await api("/integrity")).ok).toBe(true);
    expect(errors).toEqual([]);
    console.log(JSON.stringify({ ok: true, screenshots: dir }));
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
