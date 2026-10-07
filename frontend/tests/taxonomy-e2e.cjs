const { chromium, expect } = require("@playwright/test");
const { spawn } = require("node:child_process");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const root = path.resolve(__dirname, "../.."),
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-taxonomy-")),
  url = "http://127.0.0.1:18775";
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
    "18775",
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
    const baby = (await api("/categories")).find(
      (c) => c.name === "宝宝" && c.parent_id === null && c.kind === "EXPENSE",
    );
    expect(baby).toBeTruthy();
    const category = async (name, parent_id) =>
      (
        await api("/categories", "POST", {
          name,
          parent_id,
          kind: "EXPENSE",
          active: true,
        })
      ).id;
    const preset = await api("/categories");
    const supplies = preset.find(
        (c) => c.name === "用品" && c.parent_id === baby.id,
      ).id,
      milk = supplies,
      clothes = preset.find(
        (c) => c.name === "衣物" && c.parent_id === baby.id,
      ).id;
    const tag = async (name, parent_id) =>
      (await api("/tags", "POST", { name, parent_id, scope: "BOTH" })).id;
    const family = await tag("家庭消费"),
      child = await tag("宝宝标签", family),
      daily = await tag("日常用品", child),
      diaper = await tag("尿布", daily);
    await tag("童装", child);
    for (const [key, category_id, tags] of [
      ["milk", milk, ["尿布"]],
      ["clothes", clothes, ["童装"]],
      ["food", 1, ["餐饮"]],
    ])
      await api("/transactions", "POST", {
        kind: "EXPENSE",
        account_id: 5,
        amount: "12.34",
        category_id,
        tags,
        occurred_at: "2026-09-01 12:00:00",
        idempotency_key: key,
      });
    const balance = (await api("/accounts")).find((a) => a.id === 5).balance;
    browser = await chromium.launch({
      executablePath:
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true,
    });
    const page = await browser.newPage({
        viewport: { width: 1500, height: 1080 },
      }),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const nav = async (name) =>
      page.locator("nav button").filter({ hasText: name }).click();
    const rows = () => page.locator(".bill-workspace tbody > tr.ant-table-row");
    const choose = async (label, text) => {
      const input = page.getByRole("combobox", { name: label, exact: true });
      await input.locator("..").locator("..").click();
      await input.fill(text);
      await page
        .locator(".ant-select-dropdown:visible .ant-select-tree-title")
        .getByText(text, { exact: true })
        .click();
    };
    await page.goto(url);
    await expect(rows()).toHaveCount(3);
    await choose("分类树筛选", "宝宝");
    await expect(rows()).toHaveCount(2);
    const exported = await api(
      "/bills/export?" + new URLSearchParams({ category: "支出 / 宝宝" }),
    );
    expect(exported.bills.length).toBe(2);
    expect(
      exported.ai_reference.taxonomy.tags.some(
        (t) => t.name === "尿布" && t.path.length === 4,
      ),
    ).toBe(true);
    await choose("标签树筛选", "宝宝标签");
    await expect(rows()).toHaveCount(2);
    await choose("标签树筛选", "尿布");
    await expect(rows()).toHaveCount(1);
    await page.screenshot({
      path: path.join(dir, "parent-filter.png"),
      fullPage: true,
    });
    await nav("分类与标签");
    await expect(
      page.locator(`[data-catalog-id="category:${baby.id}"]`),
    ).toContainText("宝宝");
    await expect(
      page.locator(`[data-catalog-id="tag:${diaper}"]`),
    ).toContainText("尿布");
    await page
      .getByRole("button", { name: "新增宝宝子项", exact: true })
      .click();
    let dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("宝宝");
    await dialog.getByLabel("分类名称", { exact: true }).fill("玩具");
    await dialog.locator('button[type="submit"]').click();
    await expect
      .poll(
        async () =>
          (await api("/categories")).find((c) => c.name === "玩具")?.parent_id,
      )
      .toBe(baby.id);
    await page
      .getByRole("button", { name: "新增宝宝标签子项", exact: true })
      .click();
    dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("宝宝标签");
    await dialog.getByLabel("标签名称", { exact: true }).fill("纸尿裤");
    await dialog.locator('button[type="submit"]').click();
    await expect
      .poll(
        async () =>
          (await api("/tags")).find((t) => t.name === "纸尿裤")?.parent_id,
      )
      .toBe(child);
    await page.getByRole("button", { name: "编辑尿布", exact: true }).click();
    dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("日常用品");
    await dialog.locator(".ant-modal-close").click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await page.screenshot({
      path: path.join(dir, "catalog-tree.png"),
      fullPage: true,
    });
    await api("/tags/" + diaper, "PUT", {
      name: "尿布",
      scope: "BOTH",
      parent_id: family,
    });
    await nav("交易明细");
    await choose("标签树筛选", "宝宝标签");
    await expect(rows()).toHaveCount(1);
    await page.reload();
    await choose("标签树筛选", "宝宝标签");
    await expect(rows()).toHaveCount(1);
    expect(
      (await api("/bills?tag=" + encodeURIComponent("宝宝标签"))).length,
    ).toBe(1);
    const historyBefore = await api("/bills");
    await nav("分类与标签");
    await expect(
      page.getByText("分类记录钱的用途，标签补充归属与场景。", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("辅助标签", { exact: true })).toBeVisible();
    await page
      .getByRole("button", { name: "归档标签家庭消费", exact: true })
      .click();
    await page
      .locator(".ant-popconfirm:visible")
      .getByRole("button", { name: "确认归档标签", exact: true })
      .click();
    await expect
      .poll(
        async () => (await api("/tags")).find((t) => t.id === family)?.active,
      )
      .toBe(false);
    await expect(
      page.locator(`[data-catalog-id="tag:${family}"]`),
    ).not.toBeVisible();
    await page.getByText(/^已归档标签（/).click();
    await expect(
      page.locator(`[data-catalog-id="tag:${family}"]`),
    ).toBeVisible();
    const afterArchive = await api("/bills/export");
    expect(
      afterArchive.ai_reference.taxonomy.tags.some(
        (t) => t.name === "家庭消费" || t.name === "尿布",
      ),
    ).toBe(false);
    expect(await api("/bills")).toEqual(historyBefore);
    expect(
      (await api("/bills?tag=" + encodeURIComponent("家庭消费"))).length,
    ).toBe(2);
    await page.screenshot({
      path: path.join(dir, "catalog-archived.png"),
      fullPage: true,
    });
    await nav("交易明细");
    const filter = page.getByRole("combobox", {
      name: "标签树筛选",
      exact: true,
    });
    await filter.locator("../..").click();
    await expect(
      page
        .locator(".ant-select-dropdown:visible")
        .getByText("家庭消费", { exact: true }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await nav("分类与标签");
    await page.getByText(/^已归档标签（/).click();
    await page
      .getByRole("button", { name: "恢复标签家庭消费", exact: true })
      .click();
    await page
      .locator(".ant-popconfirm:visible")
      .getByRole("button", { name: "确认恢复标签", exact: true })
      .click();
    await expect
      .poll(
        async () => (await api("/tags")).find((t) => t.id === family)?.active,
      )
      .toBe(true);
    await expect(page.getByText(/^已归档标签（/)).toHaveCount(0);
    expect((await api("/accounts")).find((a) => a.id === 5).balance).toBe(
      balance,
    );
    expect((await api("/integrity")).ok).toBe(true);
    expect(errors).toEqual([]);
    console.log(
      JSON.stringify({
        ok: true,
        flows: [
          "宝宝一级分类",
          "分类父级递归筛选",
          "父标签及四级标签筛选",
          "导出与目录参考一致",
          "分类标签树展示",
          "新增子分类和子标签",
          "编辑父标签入口",
          "移动标签刷新持久化",
          "标签整树归档及恢复，历史保留且 AI 目录排除",
          "余额不变",
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
