const { chromium, expect } = require("@playwright/test");
const { spawn } = require("node:child_process");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const root = path.resolve(__dirname, "../.."),
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-account-groups-")),
  url = "http://127.0.0.1:18774";
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
    "18774",
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
    const group = async (name, parent_id) =>
      (await api("/account-groups", "POST", { name, parent_id })).id;
    const family = await group("家庭"),
      mine = await group("我的账户", family),
      wife = await group("老婆的账户", family),
      invest = await group("投资账户", mine),
      empty = await group("旅行备用", family);
    await api("/account-groups/assign", "POST", {
      group_id: mine,
      account_ids: [5, 6, 8],
    });
    await api("/account-groups/assign", "POST", {
      group_id: invest,
      account_ids: [7],
    });
    const spouse = (
      await api("/accounts", "POST", {
        name: "成员乙招行",
        kind: "银行卡",
        role: "ASSET",
        group_id: wife,
      })
    ).id;
    const pouch = (
      await api("/accounts", "POST", {
        name: "家庭小荷包",
        kind: "支付宝",
        role: "ASSET",
        group_id: family,
      })
    ).id;
    await api("/accounts", "POST", {
      name: "商户往来",
      role: "EXTERNAL",
      group_id: wife,
    });
    for (const [account_id, kind, amount] of [
      [5, "EXPENSE", "10"],
      [6, "EXPENSE", "20"],
      [spouse, "INCOME", "50"],
      [pouch, "INCOME", "10"],
    ])
      await api("/transactions", "POST", {
        account_id,
        kind,
        amount,
        category_id: kind === "EXPENSE" ? 1 : 15,
        occurred_at: "2026-09-01 12:00:00",
        idempotency_key: "seed-" + account_id,
      });
    await api("/account-merges", "POST", { source_id: 6, target_id: 5 });
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
    await nav("账户管理");
    const cards = () => page.locator("[data-account-id]");
    await expect(cards()).toHaveCount(7);
    expect(
      new Set(
        await cards().evaluateAll((rows) =>
          rows.map((r) => r.dataset.accountId),
        ),
      ).size,
    ).toBe(7);
    await expect(page.locator('[data-account-id="6"]')).toHaveCount(0);
    await expect(page.locator('[data-scope-summary="all"]')).toContainText(
      "30.00",
    );
    await expect(
      page.locator(`[data-group-section="${invest}"]`),
    ).toContainText("家庭 / 我的账户 / 投资账户");
    await expect(page.locator(`[data-group-section="${empty}"]`)).toContainText(
      "这个账户组还没有账户",
    );
    await page.screenshot({
      path: path.join(dir, "groups-desktop.png"),
      fullPage: true,
    });
    await page.locator(`[data-group-node="${wife}"]`).locator("..").click();
    await expect(cards()).toHaveCount(2);
    await expect(page.locator("[data-scope-summary]")).toContainText(
      "家庭 / 老婆的账户",
    );
    await expect(page.locator("[data-scope-summary]")).toContainText("50.00");
    await page.getByRole("button", { name: /添加账户/ }).click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog
        .locator(".ant-select-selection-item")
        .filter({ hasText: "家庭 / 老婆的账户" }),
    ).toBeVisible();
    await dialog.getByLabel("账户名称", { exact: true }).fill("老婆现金");
    await dialog.locator('button[type="submit"]').click();
    await expect
      .poll(
        async () =>
          (await api("/accounts")).find((a) => a.name === "老婆现金")?.group_id,
      )
      .toBe(wife);
    await expect(cards()).toHaveCount(3);
    await page.locator(`[data-group-node="${mine}"]`).locator("..").click();
    await expect(cards()).toHaveCount(3);
    await expect(page.locator("[data-scope-summary]")).toContainText("-30.00");
    await page
      .locator(`[data-group-section="${mine}"] .group-section-actions`)
      .getByRole("button", { name: "查看本组流水", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "账户流水", exact: true }),
    ).toBeVisible();
    await expect(
      page.locator(".page-content tbody > tr.ant-table-row"),
    ).toHaveCount(2);
    await nav("账户管理");
    await page.locator('[data-group-node="ungrouped"]').locator("..").click();
    await expect(cards()).toHaveCount(1);
    await expect(cards()).toContainText("现金");
    await page
      .getByRole("textbox", { name: "搜索账户", exact: true })
      .fill("不存在的账户");
    await expect(
      page.getByText("没有匹配的账户", { exact: true }),
    ).toBeVisible();

    await page.locator('[data-group-node="all"]').locator("..").click();
    for (const width of [1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1050 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: path.join(dir, `groups-pc-${width}.png`),
        fullPage: true,
      });
    }
    await page
      .getByRole("textbox", { name: "搜索账户", exact: true })
      .fill("成员乙");
    await expect(cards()).toHaveCount(1);
    await expect(cards()).toContainText("成员乙招行");
    await cards()
      .getByRole("button", { name: /更多操作/ })
      .click();
    await page.getByRole("menuitem", { name: "账户对账", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("账户对账");
    await page.getByRole("dialog").locator(".ant-modal-close").click();
    await page
      .getByRole("textbox", { name: "搜索账户", exact: true })
      .fill("不存在的账户");
    await expect(
      page.getByText("没有匹配的账户", { exact: true }),
    ).toBeVisible();
    await page.getByRole("textbox", { name: "搜索账户", exact: true }).fill("");
    await expect(cards()).toHaveCount(8);
    await page.getByRole("button", { name: "管理账户组", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "设置", exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
    console.log(
      JSON.stringify({
        ok: true,
        flows: [
          "多层账户组与直属账户",
          "合并来源不重复展示",
          "父组汇总与外部排除",
          "空组和未分组",
          "选择个人组与路径",
          "新账户预选所属组",
          "本组流水筛选",
          "PC多宽度无溢出",
          "账户搜索与空结果",
          "更多菜单对账",
          "组管理入口",
        ],
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
