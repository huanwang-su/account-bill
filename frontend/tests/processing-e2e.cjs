const { chromium, expect } = require("@playwright/test");
const { spawn } = require("node:child_process");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const root = path.resolve(__dirname, "../.."),
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-processing-")),
  url = "http://127.0.0.1:18769";
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
    "18769",
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
    await nav("账单导入");
    const csv =
      "支付宝账户：test\n交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号\n2026-09-01 12:00:00,餐饮,餐厅,午餐,支出,100.00,账户余额,交易成功,pay\n2026-09-02 12:00:00,餐饮,餐厅,退款午餐,收入,30.00,账户余额,退款成功,r1\n2026-09-02 12:00:01,餐饮,餐厅,退款午餐,收入,20.00,账户余额,退款成功,r2\n";
    await page
      .locator('.import-workspace input[type=file][accept=".csv,.xlsx,.pdf"]')
      .setInputFiles({
        name: "部分退款.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(csv),
      });
    await expect.poll(async () => (await api("/import-runs")).length).toBe(1);
    const run = (await api("/import-runs"))[0],
      artifact = run.artifacts.find((a) => a.stage === "NORMALIZED");
    const doc = await (
      await fetch(url + "/api/import-artifacts/" + artifact.id)
    ).json();
    for (const r of doc.bills)
      r.classification = {
        category_path: r.facts.flow === "OUT" ? ["支出", "餐饮"] : ["退款"],
        tags: [],
        status: "CLASSIFIED",
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
      .toBe(10000);
    const c = await api(`/import-runs/${run.id}/refund-candidates`),
      review = {
        run_id: run.id,
        candidates_digest: c.candidates_digest,
        decisions: c.refunds.map((r) => ({
          refund_id: r.refund.id,
          payment_id: r.payments[0].id,
          decision: "MATCHED",
          note: "原订单及商品一致",
          matched_by: "Codex",
        })),
      };
    await page
      .locator(".refund-match-upload input[type=file]")
      .setInputFiles({
        name: "匹配.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(review)),
      });
    await expect
      .poll(async () => (await api("/reports/summary")).expense)
      .toBe(5000);
    await expect(
      page.getByText(
        "账单状态：正常 1 条 · 忽略 2 条。忽略记录仅保留在账单中，不转入交易明细。",
        { exact: true },
      ),
    ).toBeVisible();
    await nav("交易明细");
    await expect(
      page.getByText("50.00", { exact: false }).first(),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "详情", exact: true })
      .first()
      .click();
    await expect(
      page.getByText("退款抵扣 / 净支出", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("原始账单字段与关联凭证", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: path.join(dir, "partial-refund.png"),
      fullPage: true,
    });
    await page.locator(".ant-modal-close").click();
    // A classification-only review can post while preserving its remaining category review.
    const bill = (await api("/bills"))[0];
    const raw =
      "支付宝账户：test\n交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号\n2026-09-03 12:00:00,购物,超市,商品,支出,8,账户余额,交易成功,broad\n";
    await nav("账单导入");
    await page
      .locator('.import-workspace input[type=file][accept=".csv,.xlsx,.pdf"]')
      .setInputFiles({
        name: "宽泛分类.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(raw),
      });
    await expect.poll(async () => (await api("/import-runs")).length).toBe(2);
    const run2 = (await api("/import-runs"))[0],
      a2 = run2.artifacts.find((a) => a.stage === "NORMALIZED"),
      d2 = await (await fetch(url + "/api/import-artifacts/" + a2.id)).json();
    d2.bills[0].classification = {
      category_path: ["支出", "商超购物"],
      status: "NEEDS_REVIEW",
      review_scope: "CATEGORY",
      classified_by: "Codex",
      tags: [],
      note: "商品不详但确认消费",
    };
    await page
      .locator(".classification-upload input[type=file]")
      .setInputFiles({
        name: "宽泛.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(d2)),
      });
    await expect(
      page.getByRole("button", { name: "导入并入账", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "导入并入账", exact: true }).click();
    await expect
      .poll(async () => (await api("/reports/summary")).expense)
      .toBe(5800);
    await nav("设置");
    await expect(page.locator("#classification-reference")).toBeVisible();
    await nav("数据");
    await expect(
      page.getByRole("button", { name: "检查账目", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "检查账目", exact: true }).click();
    await expect(
      page.getByText("所有交易均平衡", { exact: true }),
    ).toBeVisible();
    await api("/bills/reverse", "POST", { bill_id: bill.id });
    if ((await api("/reports/summary")).expense !== 800)
      throw Error("Net reversal mismatch");
    if (!(await api("/integrity")).ok || errors.length)
      throw Error(errors.join(","));
    console.log(
      JSON.stringify({
        ok: true,
        flows: [
          "部分退款文件导入",
          "同付款多次退款",
          "净支出明细",
          "原始字段追溯",
          "宽泛分类允许入账",
          "数据设置拆分",
          "净额撤销",
          "财务平衡",
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
