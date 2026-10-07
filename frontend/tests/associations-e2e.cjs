const { chromium, expect } = require("@playwright/test");
const { spawn, spawnSync } = require("node:child_process"),
  fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const root = path.resolve(__dirname, "../.."),
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-associations-")),
  url = "http://127.0.0.1:18771",
  python = path.join(root, ".venv/bin/python");
const seeded = spawnSync(
  python,
  [
    "-c",
    `from app.database import Database\nfrom test_bill_associations import seed\nD=Database(${JSON.stringify(path.join(dir, "db"))});D.initialize();seed(D)`,
  ],
  {
    env: {
      ...process.env,
      PYTHONPATH:
        path.join(root, "backend") + ":" + path.join(root, "backend/tests"),
    },
    encoding: "utf8",
  },
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
    "18771",
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
const api = async (p) => {
  const r = await fetch(url + "/api" + p);
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
        viewport: { width: 1450, height: 1000 },
      }),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("response", async (r) => {
      if (r.url().endsWith("/api/bills/associate") && !r.ok())
        console.error("Association response", r.status(), await r.text());
    });
    const nav = async (text) =>
      page.locator("nav button").filter({ hasText: text }).click();
    await page.goto(url);
    await page
      .getByRole("button", { name: "关联银行凭证", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("dialog").getByRole("combobox").click();
    await page
      .locator(".ant-select-dropdown:visible .ant-select-item-option-content")
      .click();
    await page
      .getByPlaceholder("例如：银行卡和商户一致，订单退款也对应")
      .fill("同一银行卡、商户一致，经订单信息确认");
    await page.getByRole("button", { name: "确认关联", exact: true }).click();
    await expect.poll(async () => (await api("/bills")).length).toBe(1);
    await expect(page.getByText("2 份账单凭证", { exact: true })).toBeVisible();
    if ((await api("/reports/summary")).expense !== 10000)
      throw Error("Duplicate debit");
    await nav("账单导入");
    await page
      .getByRole("combobox", { name: "导入批次" })
      .count()
      .catch(() => 0);
    // Select the WeChat batch through the visible source filename.
    const selects = page.locator(".import-workspace .ant-select").first();
    await selects.click();
    await page
      .locator(".ant-select-dropdown:visible .ant-select-item-option-content")
      .filter({ hasText: "wechat.csv" })
      .click();
    await expect(
      page.getByText("已关联交易", { exact: true }).first(),
    ).toBeVisible();
    await page.screenshot({
      path: path.join(dir, "linked-source.png"),
      fullPage: true,
    });
    await nav("账户流水");
    const rows = await api("/transactions");
    if (rows.length !== 1) throw Error("Expected one journal row");
    await page
      .getByRole("button", { name: "详情", exact: true })
      .first()
      .click();
    await expect(page.getByText("账户变动", { exact: true })).toBeVisible();
    await expect(
      page.getByText("记账分录（用于平衡账目）", { exact: true }),
    ).toBeVisible();
    await page
      .locator(".ant-modal-content")
      .screenshot({ path: path.join(dir, "account-movement.png") });
    if (!(await api("/integrity")).ok || errors.length)
      throw Error(errors.join(","));
    console.log(
      JSON.stringify({
        ok: true,
        flows: [
          "凭证关联确认",
          "单条明细双凭证",
          "不重复扣款",
          "已关联交易状态",
          "账户流水一行",
          "账户变动与平衡分录分开展示",
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
