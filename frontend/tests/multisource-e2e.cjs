// Optional private-fixture integration: paths supplied at runtime, never packaged.
const { chromium, expect } = require("@playwright/test");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
if (
  !process.env.MULTISOURCE_SAMPLES ||
  !process.env.MULTISOURCE_CLASSIFIED_DIR
) {
  console.log(
    "Skipped: provide MULTISOURCE_SAMPLES and MULTISOURCE_CLASSIFIED_DIR",
  );
  process.exit(0);
}
const paths = JSON.parse(fs.readFileSync(process.env.MULTISOURCE_SAMPLES));
const labels = {
  cmb: "招商银行",
  boc: "中国银行",
  wechat: "微信支付",
  pouch: "支付宝小荷包",
};
const counts = { cmb: 41, boc: 12, wechat: 18, pouch: 192 };
const root = path.resolve(__dirname, "../..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-multisource-"));
const url = "http://127.0.0.1:18767";
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
    "18767",
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
const api = async (p) => {
  const r = await fetch(url + "/api" + p);
  if (!r.ok) throw Error(await r.text());
  return r.json();
};
(async () => {
  let browser;
  try {
    for (let i = 0; i < 100; i++) {
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
      viewport: { width: 1450, height: 1100 },
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(url);
    await page.locator("nav button").filter({ hasText: "账单导入" }).click();
    let expected = 0;
    for (const source of ["cmb", "boc", "wechat", "pouch"]) {
      await page
        .locator('.import-workspace input[type=file][accept=".csv,.xlsx,.pdf"]')
        .setInputFiles(paths[source]);
      await expect(
        page.getByText(
          `账单状态：正常 ${counts[source]} 条 · 忽略 0 条。忽略记录仅保留在账单中，不转入交易明细。`,
          { exact: true },
        ),
      ).toBeVisible({ timeout: 20000 });
      let run = (await api("/import-runs"))[0];
      if (run.summary.provider_label !== labels[source])
        throw Error("Source mismatch");
      if ((await api("/bills")).length !== expected)
        throw Error("Published before classification");
      await page
        .locator(".import-workspace")
        .getByRole("button", { name: "查看文件", exact: true })
        .first()
        .click();
      await expect(page.getByRole("dialog").locator("pre")).toContainText(
        "Excel 或 PDF 原始文件",
      );
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await page
        .locator(
          '.import-workspace .classification-upload input[type=file][accept=".json"]',
        )
        .setInputFiles(
          path.join(
            process.env.MULTISOURCE_CLASSIFIED_DIR,
            labels[source] + "-已分类账单.json",
          ),
        );
      await expect(
        page.getByRole("button", { name: "导入并入账", exact: true }),
      ).toBeEnabled();
      await page
        .getByRole("button", { name: "导入并入账", exact: true })
        .click();
      expected += counts[source];
      await expect
        .poll(async () => (await api("/bills")).length)
        .toBe(expected);
      run = (await api("/import-runs"))[0];
      if (run.artifacts.length !== 3) throw Error("Missing staged artifacts");
      const stored = await (
        await fetch(
          url +
            "/api/import-artifacts/" +
            run.artifacts.find((a) => a.stage === "ORIGINAL").id,
        )
      ).arrayBuffer();
      if (!Buffer.from(stored).equals(fs.readFileSync(paths[source])))
        throw Error("Original bytes changed");
    }
    const integrity = await api("/integrity");
    if (!integrity.ok) throw Error("Unbalanced ledger");
    if (errors.length) throw Error(errors.join("\n"));
    await page.screenshot({
      path: path.join(dir, "imports.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: path.join(dir, "mobile.png"),
      fullPage: true,
    });
    console.log(
      JSON.stringify({
        ok: true,
        details: expected,
        flows: [
          "四种文件页面上传",
          "自动识别来源",
          "统一账单预览",
          "原文件完整存档",
          "分类文件导入",
          "统一交易明细",
          "余额平衡",
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
