const { chromium, expect } = require("@playwright/test");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const root = path.resolve(__dirname, "../.."),
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-investment-")),
  url = "http://127.0.0.1:18779";
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
    "18779",
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
  const r = await fetch(url + "/api" + p, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Ledger-Client": "local-web",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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
      } catch {}
      await new Promise((r) => setTimeout(r, 150));
    }
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
    const unused = (await api("/accounts")).find((a) => a.id === 6);
    await api("/accounts/6", "PUT", { ...unused, kind: "其他" });
    await page.goto(url);
    await page.locator("nav button").filter({ hasText: "统计报表" }).click();
    await page.getByRole("tab", { name: "理财", exact: true }).click();
    await expect(
      page.getByText(
        "暂无理财账户或理财收益记录，可添加证券/理财账户，或将相关收入分类为“理财收益”",
        {
          exact: true,
        },
      ),
    ).toBeVisible();
    const a = (
        await api("/accounts", "POST", {
          name: "合成证券甲",
          kind: "证券",
          role: "ASSET",
        })
      ).id,
      b = (
        await api("/accounts", "POST", {
          name: "合成证券乙",
          kind: "证券",
          role: "ASSET",
        })
      ).id;
    const value = async (account, actual, when) =>
      api(`/accounts/${account}/valuations`, "POST", {
        actual,
        occurred_at: when,
        idempotency_key: randomUUID(),
      });
    const transfer = async (source, target, amount, when) =>
      api("/transactions", "POST", {
        kind: "TRANSFER",
        account_id: source,
        to_account_id: target,
        amount,
        occurred_at: when,
        idempotency_key: randomUUID(),
      });
    await value(a, "1000", "2026-09-01");
    await value(b, "2000", "2026-09-01");
    await value(a, "1100", "2026-09-02");
    await value(b, "2200", "2026-09-02");
    await transfer(5, a, "500", "2026-09-03");
    await value(a, "1650", "2026-09-03");
    await transfer(b, 5, "200", "2026-09-04");
    await transfer(a, b, "100", "2026-09-05");
    await value(a, "1500", "2026-09-06");
    await value(b, "2200", "2026-09-06");
    const income = (await api("/categories")).find(
      (c) => c.name === "理财收益",
    ).id;
    await api("/transactions", "POST", {
      kind: "INCOME",
      account_id: a,
      amount: "10",
      category_id: income,
      occurred_at: "2026-09-07",
      counterparty: "合成分红",
      idempotency_key: randomUUID(),
    });
    await api("/transactions", "POST", {
      kind: "EXPENSE",
      account_id: b,
      amount: "5",
      category_id: 1,
      occurred_at: "2026-09-08",
      counterparty: "合成费用",
      idempotency_key: randomUUID(),
    });
    for (let i = 9; i <= 12; i++) {
      const day = `2026-09-${String(i).padStart(2, "0")}`;
      await value(a, "1511", day + " 09:00:00");
      await value(a, "1510", day + " 10:00:00");
    }
    await page.reload();
    await page.locator("nav button").filter({ hasText: "统计报表" }).click();
    await page.getByRole("tab", { name: "理财", exact: true }).click();
    const workspace = page.locator(".investment-workspace");
    await expect(page.getByTestId("investment-assets")).toHaveText(
      "¥ 3,705.00",
    );
    await expect(page.getByTestId("investment-profit")).toHaveText("¥ 405.00");
    await expect(page.getByTestId("investment-capital")).toHaveText("¥ 300.00");
    await expect(page.getByTestId("investment-valuation")).toHaveText(
      "¥ 400.00",
    );
    await expect(
      workspace
        .getByRole("img", { name: "理财收益趋势", exact: true })
        .locator("canvas"),
    ).toHaveCount(1);
    await expect(
      workspace
        .getByRole("img", { name: "理财资产趋势", exact: true })
        .locator("canvas"),
    ).toHaveCount(1);
    await expect(
      workspace.getByText("金额一致", { exact: true }),
    ).toBeVisible();
    const choose = async (name, label) => {
      await workspace
        .getByRole("combobox", { name, exact: true })
        .locator("../..")
        .click();
      await page
        .locator(".ant-select-dropdown:visible")
        .getByText(label, { exact: true })
        .click();
    };
    await choose("理财分析账户", "合成证券甲");
    await expect(page.getByTestId("investment-profit")).toHaveText("¥ 110.00");
    await expect(page.getByTestId("investment-assets")).toHaveText(
      "¥ 1,510.00",
    );
    await choose("理财分析账户", "合成证券乙");
    await expect(page.getByTestId("investment-profit")).toHaveText("¥ 295.00");
    await expect(page.getByTestId("investment-assets")).toHaveText(
      "¥ 2,195.00",
    );
    await choose("理财分析账户", "全部理财收益");
    await expect(page.getByTestId("investment-profit")).toHaveText("¥ 405.00");
    console.log(
      "PASS 空证券账户入口、全部/单账户盈亏守恒、银行本金排除与证券互转抵消",
    );
    let profits = workspace.locator(".investment-profit-table");
    await expect(profits.locator("tbody tr.ant-table-row")).toHaveCount(10);
    const first = await profits
      .locator("tbody tr.ant-table-row")
      .evaluateAll((rs) => rs.map((r) => r.getAttribute("data-row-key")));
    await profits.locator(".ant-pagination-next").click();
    await expect(profits.locator("tbody tr.ant-table-row")).toHaveCount(5);
    const second = await profits
      .locator("tbody tr.ant-table-row")
      .evaluateAll((rs) => rs.map((r) => r.getAttribute("data-row-key")));
    expect(new Set([...first, ...second]).size).toBe(15);
    await profits
      .getByRole("button", { name: "查看", exact: true })
      .first()
      .click();
    await expect(page.locator(".ant-modal")).toBeVisible();
    await page.locator(".ant-modal-close").click();
    await workspace
      .getByRole("tab", { name: "资金转账（3）", exact: true })
      .click();
    const transfers = workspace.locator(".investment-transfer-table");
    await expect(transfers.locator("tbody tr.ant-table-row")).toHaveCount(3);
    const internal = transfers
      .locator("tbody tr.ant-table-row")
      .filter({ hasText: "理财账户互转" });
    await expect(internal).toContainText("100.00");
    await expect(internal.locator("td").nth(5)).toHaveText("0.00");
    await transfers
      .getByRole("button", { name: "查看", exact: true })
      .first()
      .click();
    await expect(page.locator(".ant-modal")).toContainText("内部转账");
    await page.locator(".ant-modal-close").click();
    const range = workspace.locator(
      ".ant-picker-range .ant-picker-input input",
    );
    await range.nth(0).fill("2026-09-03");
    await range.nth(0).press("Tab");
    await range.nth(1).fill("2026-09-05");
    await range.nth(1).press("Enter");
    await range.nth(1).press("Tab");
    await expect(page.getByTestId("investment-profit")).toHaveText("¥ 50.00");
    await expect(page.getByTestId("investment-assets")).toHaveText(
      "¥ 3,650.00",
    );
    await workspace
      .getByRole("button", { name: "重置条件", exact: true })
      .click();
    await expect(page.getByTestId("investment-profit")).toHaveText("¥ 405.00");
    await choose("理财趋势粒度", "按日");
    await expect(page.getByTestId("investment-profit")).toHaveText("¥ 405.00");
    console.log("PASS 趋势图、日期区间、明细真实分页、转账两侧与原交易查看");
    await choose("理财分析账户", "合成证券甲");
    await expect(page.getByTestId("investment-profit")).toHaveText("¥ 110.00");
    await workspace
      .getByRole("button", { name: "更新证券余额", exact: true })
      .click();
    const modal = page.locator(".ant-modal");
    await modal
      .getByLabel("证券账户总资产（元）", { exact: true })
      .fill("1610");
    await modal.locator('button[type="submit"]').click();
    await expect(modal).toBeHidden();
    await expect(page.getByTestId("investment-profit")).toHaveText("¥ 210.00");
    await expect(page.getByTestId("investment-assets")).toHaveText(
      "¥ 1,610.00",
    );
    await choose("理财分析账户", "全部理财收益");
    await expect(page.getByTestId("investment-profit")).toHaveText("¥ 505.00");
    const wealth = (
      await api("/accounts", "POST", {
        name: "合成理财产品",
        kind: "理财",
        role: "ASSET",
      })
    ).id;
    await api(`/accounts/${wealth}/opening`, "POST", {
      amount: "2000",
      occurred_at: "2026-09-01",
    });
    await api("/transactions", "POST", {
      kind: "INCOME",
      account_id: wealth,
      amount: "20",
      category_id: income,
      occurred_at: "2026-09-02",
      idempotency_key: randomUUID(),
    });
    await transfer(5, wealth, "500", "2026-09-03");
    await api("/transactions", "POST", {
      kind: "EXPENSE",
      account_id: wealth,
      amount: "4",
      category_id: 1,
      occurred_at: "2026-09-04",
      idempotency_key: randomUUID(),
    });
    await api("/transactions", "POST", {
      kind: "INCOME",
      account_id: 5,
      amount: "12",
      category_id: income,
      occurred_at: "2026-09-02",
      idempotency_key: randomUUID(),
    });
    const salary = (await api("/categories")).find((c) => c.name === "工资").id;
    await api("/transactions", "POST", {
      kind: "INCOME",
      account_id: 5,
      amount: "99",
      category_id: salary,
      occurred_at: "2026-09-02",
      idempotency_key: randomUUID(),
    });
    await page.reload();
    await page.locator("nav button").filter({ hasText: "统计报表" }).click();
    await page.getByRole("tab", { name: "理财", exact: true }).click();
    await expect(page.getByTestId("investment-profit")).toHaveText("¥ 533.00");
    await expect(page.getByTestId("investment-assets")).toHaveText(
      "¥ 6,321.00",
    );
    await expect(
      workspace.getByText("整体收益", { exact: true }),
    ).toBeVisible();
    await expect(
      workspace
        .getByRole("img", { name: "各账户理财净收益对比", exact: true })
        .locator("canvas"),
    ).toHaveCount(1);
    const ordinary = workspace
      .locator(".investment-accounts-table tbody tr.ant-table-row")
      .filter({ hasText: "支付宝余额" });
    await expect(ordinary).toContainText("仅理财收益");
    await expect(ordinary.locator("td").nth(5)).toHaveText("—");
    await ordinary
      .getByRole("button", { name: "支付宝余额", exact: true })
      .click();
    await expect(page.getByTestId("investment-profit")).toHaveText("¥ 12.00");
    await expect(page.getByTestId("investment-assets")).toHaveText("—");
    await expect(
      workspace.getByRole("button", { name: "更新证券余额", exact: true }),
    ).toHaveCount(0);
    await workspace
      .getByRole("button", { name: "查看全部账户", exact: true })
      .click();
    await expect(page.getByTestId("investment-profit")).toHaveText("¥ 533.00");
    await choose("理财分析账户", "合成理财产品");
    await expect(page.getByTestId("investment-profit")).toHaveText("¥ 16.00");
    await expect(page.getByTestId("investment-assets")).toHaveText(
      "¥ 2,516.00",
    );
    await workspace
      .getByRole("button", { name: "查看全部账户", exact: true })
      .click();
    await expect(page.getByTestId("investment-profit")).toHaveText("¥ 533.00");
    console.log(
      "PASS 理财产品纳入、普通账户仅计投资收益、排除工资与余额、账户点击及返回整体",
    );
    await page.waitForTimeout(1200);
    await page.screenshot({
      path: path.join(dir, "investment-analysis.png"),
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
        flows: "余额更新即时刷新、PC布局、账目完整",
        screenshots: dir,
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
