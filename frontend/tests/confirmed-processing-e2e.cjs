const { chromium, expect } = require("@playwright/test");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const root = path.resolve(__dirname, "../.."),
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-confirmed-processing-"));
const python = path.join(root, ".venv/bin/python"),
  url = "http://127.0.0.1:18773";
const env = {
  ...process.env,
  PYTHONPATH:
    path.join(root, "backend") + ":" + path.join(root, "backend/tests"),
  LEDGER_DB: path.join(dir, "db"),
};
const seed = spawnSync(
  python,
  [
    "-c",
    `import json\nfrom app.database import Database\nfrom test_processing_policy import staged\nfrom test_confirmed_processing import transfers\ndb=Database(${JSON.stringify(env.LEDGER_DB)});db.initialize()\nf,r,_=staged(db,(30,));f.commit(r)\nf,r,d=transfers(db);print(json.dumps(d))`,
  ],
  { env, encoding: "utf8" },
);
if (seed.status !== 0) throw Error(seed.stderr);
const decision = JSON.parse(seed.stdout.trim());
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
    "18773",
  ],
  { cwd: root, env, stdio: "ignore" },
);
const api = async (p, method = "GET", body) => {
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
};
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
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true,
    });
    const page = await browser.newPage({
        viewport: { width: 1500, height: 1050 },
      }),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const nav = async (name) =>
      page.locator("nav button").filter({ hasText: name }).click();
    await page.goto(url);
    await nav("设置");
    await expect(page.locator("#classification-reference")).toContainText(
      "用途不明",
    );
    await page
      .getByRole("switch", { name: "未匹配退款记为收入", exact: true })
      .click();
    await page
      .locator("#classification-reference")
      .fill(
        "用途不明记未知用途；未匹配退款记退款收入；已确认自有账户转存记内部转账。",
      );
    await page
      .getByRole("button", { name: "保存分类参考", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await api("/classification-policy")).unmatched_refund_income,
      )
      .toBe(true);
    await api("/classification-policy/reprocess", "POST", {});
    let summary = await api("/reports/summary");
    expect(summary.income).toBe(3000);
    expect(summary.expense).toBe(10000);
    const refund = (await api("/bills")).find(
      (r) => r.facts.settlement === "REFUNDED",
    );
    expect(refund.transaction_kind).toBe("INCOME");
    expect(refund.classification.category_path).toEqual(["退款"]);
    await api("/bills/confirmed-transfer", "POST", decision);
    await api("/bills/confirmed-transfer", "POST", decision);
    const rows = await api("/bills");
    expect(rows.length).toBe(3);
    expect(rows.find((r) => r.id === decision.bill_id).source_count).toBe(3);
    await page.reload();
    await nav("交易明细");
    await expect(page.getByText("3 份账单凭证", { exact: true })).toBeVisible();
    await nav("账户流水");
    const transfer = page
      .locator("tbody > tr.ant-table-row")
      .filter({ hasText: "转账" })
      .first();
    await transfer.getByRole("button", { name: "详情", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("账户变动", { exact: true })).toBeVisible();
    await expect(
      dialog
        .locator(".ant-table-wrapper")
        .first()
        .locator("tbody > tr.ant-table-row"),
    ).toHaveCount(2);
    await dialog.locator(".ant-modal-close").click();
    await page.reload();
    await nav("设置");
    await expect(
      page.getByRole("switch", { name: "未匹配退款记为收入", exact: true }),
    ).toBeChecked();
    await page.screenshot({
      path: path.join(dir, "policy.png"),
      fullPage: true,
    });
    await api("/bills/reverse", "POST", { bill_id: refund.id });
    summary = await api("/reports/summary");
    expect(summary.income).toBe(0);
    expect(summary.expense).toBe(10000);
    expect((await api("/integrity")).ok).toBe(true);
    expect(errors).toEqual([]);
    console.log(
      JSON.stringify({
        ok: true,
        flows: [
          "简化参考保存",
          "退款收入配置持久化",
          "退款单分类及收入入账",
          "三凭证转账幂等",
          "两个实际账户变动",
          "退款收入撤销",
        ],
        screenshot: path.join(dir, "policy.png"),
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
