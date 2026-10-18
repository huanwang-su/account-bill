const assert = require("node:assert/strict");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { Alert, Checkbox, Button, Upload, message } = require("antd");
const { loadTs } = require("./source-loader.cjs");
const { DataBackupPanel } = loadTs(
  path.resolve(__dirname, "../src/DataBackupPanel.tsx"),
);
const { BackupDownloadDialog, BackupFileDownload } = loadTs(
  path.resolve(__dirname, "../src/BackupDownloadDialog.tsx"),
);
const { LedgerApi } = loadTs(path.resolve(__dirname, "../src/api.ts"));
const { ImportWorkspace } = loadTs(
  path.resolve(__dirname, "../src/ImportWorkspace.tsx"),
);
const feedback = [];
message.success = (text) => feedback.push(text);
message.warning = (text) => feedback.push(text);
const preview = {
  token: "validated-token",
  filename: "账本.ledger.zip",
  created_at: "2026-10-19 12:00:00",
  current: {
    accounts: 9,
    account_groups: 0,
    categories: 30,
    tags: 0,
    bills: 0,
    transactions: 0,
    entries: 0,
    account_valuations: 0,
    import_batches: 0,
  },
  incoming: {
    accounts: 10,
    account_groups: 2,
    categories: 30,
    tags: 4,
    bills: 6,
    transactions: 5,
    entries: 10,
    account_valuations: 1,
    import_batches: 1,
  },
  checks: ["文件格式与校验值", "逐笔流水借贷平衡"],
  omitted_files: 3,
  unfinished_imports: 1,
};
function instance(Component, props) {
  const page = new Component(props);
  page.setState = (patch, done) => {
    Object.assign(
      page.state,
      typeof patch === "function" ? patch(page.state) : patch,
    );
    done?.();
  };
  return page;
}
function elements(node) {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(elements);
  return React.isValidElement(node)
    ? [node, ...elements(node.props.children)]
    : [];
}
async function run() {
  let refreshed = 0;
  const requests = [];
  const page = instance(DataBackupPanel, {
    onRestored: async () => {
      refreshed++;
    },
  });
  page.api.request = async (url, method, body) => {
    requests.push({ url, method, body });
    if (url.endsWith("/validate")) {
      assert(body instanceof FormData);
      return preview;
    }
    if (url.endsWith("/restore"))
      return {
        restored: true,
        rollback_download_url: "/api/data-backup/recovery/before.ledger.zip",
      };
    return { discarded: true };
  };
  const initial = renderToStaticMarkup(page.render());
  assert(initial.includes("下载账本备份") && initial.includes(".ledger.zip"));
  const downloadButton = elements(page.render()).find(
    (element) =>
      element.type === Button && element.props.children === "下载账本备份",
  );
  downloadButton.props.onClick();
  assert.equal(page.state.downloadPath, "/data-backup");
  elements(page.render())
    .find((element) => element.type === BackupDownloadDialog)
    .props.onClose();
  assert.equal(page.state.downloadPath, undefined);
  assert(
    initial.includes("上传备份并校验") &&
      initial.includes("覆盖当前工程的全部账本数据"),
  );
  assert(initial.includes("不包含原始、统一或分类后账单的文件内容"));
  await page.selectBackup(new File(["synthetic"], "账本.ledger.zip"));
  assert.equal(page.state.phase, "ready");
  assert.equal(
    requests.length,
    1,
    "Upload performs validation without restoring",
  );
  assert.equal(refreshed, 0);
  const details = page.renderPreview(preview);
  const checkbox = elements(details).find(
    (element) => element.type === Checkbox,
  );
  let confirm = elements(details).find(
    (element) =>
      element.type === Button && element.props.children === "确认覆盖并恢复",
  );
  assert.equal(confirm.props.disabled, true);
  await page.restore();
  assert.equal(requests.length, 1);
  checkbox.props.onChange({ target: { checked: true } });
  confirm = elements(page.renderPreview(preview)).find(
    (element) =>
      element.type === Button && element.props.children === "确认覆盖并恢复",
  );
  assert.equal(confirm.props.disabled, false);
  await page.restore();
  assert.deepEqual(requests[1].body, {
    token: preview.token,
    confirmation: "OVERWRITE_LEDGER",
  });
  assert.equal(page.state.phase, "done");
  assert.equal(refreshed, 1);
  assert(renderToStaticMarkup(page.render()).includes("下载恢复前备份"));
  elements(
    elements(page.render()).find(
      (element) => element.type === Alert && element.props.type === "success",
    ).props.description,
  )
    .find(
      (element) =>
        element.type === Button && element.props.children === "下载恢复前备份",
    )
    .props.onClick();
  assert.equal(
    page.state.downloadPath,
    "/data-backup/recovery/before.ledger.zip",
  );
  await page.restore();
  assert.equal(
    requests.length,
    2,
    "A successful restore cannot be replayed by the page",
  );

  const failed = instance(DataBackupPanel, {
    onRestored: async () =>
      assert.fail("Rejected data must not refresh or overwrite"),
  });
  failed.api.request = async () => {
    throw Error("备份账目不平衡");
  };
  await failed.validate(new File(["invalid"], "bad.zip"));
  assert.equal(failed.state.phase, "idle");
  assert(renderToStaticMarkup(failed.render()).includes("备份账目不平衡"));
  failed.state = { phase: "ready", preview, confirmed: true };
  await failed.restore();
  assert.equal(failed.state.confirmed, false);
  assert.equal(failed.state.phase, "ready");

  const cancelled = instance(DataBackupPanel, { onRestored: async () => {} });
  cancelled.state = { phase: "ready", preview, confirmed: true };
  let discarded;
  cancelled.api.request = async (url, method) => {
    discarded = { url, method };
  };
  cancelled.cancel();
  assert.equal(cancelled.state.preview, undefined);
  assert.deepEqual(discarded, {
    url: "/data-backup/validation/validated-token",
    method: "DELETE",
  });
  const big = instance(DataBackupPanel, { onRestored: async () => {} });
  big.api.request = async () =>
    assert.fail("Oversized files must be rejected before uploading");
  await big.validate({ size: 65 * 1024 * 1024 });
  assert.match(big.state.error, /64 MB/);
  const late = instance(DataBackupPanel, { onRestored: async () => {} });
  let resolve, deleted;
  late.api.request = (url) =>
    url.endsWith("/validate")
      ? new Promise((done) => {
          resolve = done;
        })
      : ((deleted = url), Promise.resolve({}));
  const pending = late.validate(new File(["synthetic"], "late.zip"));
  late.componentWillUnmount();
  resolve(preview);
  await pending;
  assert.equal(late.state.preview, undefined);
  assert.equal(deleted, "/data-backup/validation/validated-token");

  // Encrypted uploads prompt for a password by content, even when renamed.
  const encrypted = instance(DataBackupPanel, { onRestored: async () => {} });
  let validateCalls = 0,
    receivedPassword;
  encrypted.api.request = async (url, method, body) => {
    validateCalls++;
    receivedPassword = body.get("password");
    if (validateCalls === 1) throw Error("密码不正确或备份文件已损坏");
    return { ...preview, encrypted: true };
  };
  const encryptedFile = new File(
    [new Uint8Array([0x50, 0x4b, 3, 4, 20, 0, 1, 0, 8, 0])],
    "renamed.zip",
  );
  await encrypted.selectBackup(encryptedFile);
  assert.equal(
    validateCalls,
    0,
    "Selecting an encrypted file waits for a password",
  );
  assert.equal(encrypted.state.uploadFile, encryptedFile);
  encrypted.state.uploadPassword = "wrong";
  await encrypted.validate(encryptedFile, encrypted.state.uploadPassword);
  assert.equal(receivedPassword, "wrong");
  assert.equal(encrypted.state.phase, "idle");
  assert.equal(encrypted.state.uploadPassword, "", "Clear failed passwords");
  assert.equal(
    encrypted.state.uploadFile,
    encryptedFile,
    "Keep file for retry",
  );
  await encrypted.validate(encryptedFile, "家庭备份密码");
  assert.equal(receivedPassword, "家庭备份密码");
  assert.equal(encrypted.state.uploadFile, undefined);
  assert.equal(encrypted.state.uploadPassword, "");
  assert.equal(encrypted.state.phase, "ready");
  assert(
    renderToStaticMarkup(
      encrypted.renderPreview(encrypted.state.preview),
    ).includes("已解密并通过备份校验"),
  );

  // Password confirmation and errors do not start a file download or retain secrets.
  let closed = 0,
    downloaded = 0,
    saved;
  BackupFileDownload.save = (blob, filename) => {
    saved = { blob, filename };
  };
  const dialog = instance(BackupDownloadDialog, {
    path: "/data-backup",
    onClose: () => closed++,
  });
  dialog.api.download = async (url, body) => {
    downloaded++;
    assert.equal(url, "/data-backup");
    assert.deepEqual(body, { password: "秘密123" });
    return { blob: new Blob(["encrypted"]), filename: "账本.ledger.zip" };
  };
  dialog.state.password = "秘密123";
  await dialog.download();
  assert.equal(downloaded, 0);
  assert.equal(dialog.state.error, "两次输入的密码不一致");
  dialog.state.confirmation = "秘密123";
  await dialog.download();
  assert.equal(downloaded, 1);
  assert.equal(closed, 1);
  assert.equal(saved.filename, "账本.ledger.zip");
  assert.equal(dialog.state.password, "");
  assert.equal(dialog.state.confirmation, "");
  const plainDialog = instance(BackupDownloadDialog, {
    path: "/data-backup",
    onClose: () => {},
  });
  plainDialog.api.download = async (url, body) => {
    assert.deepEqual(body, { password: "" });
    return { blob: new Blob(["zip"]), filename: "账本.ledger.zip" };
  };
  await plainDialog.download();
  assert.equal(saved.filename, "账本.ledger.zip");
  const failedDialog = instance(BackupDownloadDialog, {
    path: "/data-backup",
    onClose: () => assert.fail(),
  });
  failedDialog.state.password = failedDialog.state.confirmation = "secret";
  failedDialog.api.download = async () => {
    throw Error("下载失败");
  };
  await failedDialog.download();
  assert.equal(failedDialog.state.password, "");
  assert.equal(failedDialog.state.confirmation, "");
  assert.equal(failedDialog.state.error, "下载失败");

  // File API uses a POST body and decodes server filenames; no secret in URL.
  const originalFetch = global.fetch;
  try {
    global.fetch = async (url, options) => {
      assert.equal(url, "/api/data-backup");
      assert.equal(options.method, "POST");
      assert.equal(options.headers["X-Ledger-Client"], "local-web");
      assert.equal(JSON.parse(options.body).password, "测试密码");
      return new Response("encrypted", {
        headers: {
          "Content-Disposition":
            "attachment; filename*=UTF-8''" +
            encodeURIComponent("账本.ledger.zip"),
        },
      });
    };
    const file = await new LedgerApi().download("/data-backup", {
      password: "测试密码",
    });
    assert.equal(file.filename, "账本.ledger.zip");
    assert.equal(await file.blob.text(), "encrypted");
    global.fetch = async () =>
      new Response(JSON.stringify({ detail: "备份下载失败" }), { status: 400 });
    await assert.rejects(
      () => new LedgerApi().download("/data-backup", {}),
      /备份下载失败/,
    );
  } finally {
    global.fetch = originalFetch;
  }

  // Archived-file buttons stay unavailable after a business-only restore.
  const imports = instance(ImportWorkspace, { onChanged: async () => {} });
  imports.state.detail = {
    id: 1,
    filename: "bill.csv",
    status: "IMPORTED",
    summary: {},
    result: {},
    rows: [],
    files_omitted: true,
    artifacts: [
      {
        id: 1,
        stage: "NORMALIZED",
        filename: "账单.json",
        size: 0,
        digest: "a".repeat(64),
        created_at: "2026-10-19",
        available: false,
      },
    ],
  };
  const tree = elements(imports.render());
  const download = tree.find(
    (element) =>
      element.type === Button && element.props.children === "下载统一账单",
  );
  assert.equal(download.props.disabled, true);
  assert.equal(download.props.href, undefined);
  assert(renderToStaticMarkup(imports.render()).includes("历史文件不可下载"));
  console.log(
    "Data backup UI passed: business-only scope, validate-before-restore, explicit overwrite confirmation, counts, success/refresh/recovery link, error/cancel/stale/size guards and omitted-file handling.",
  );
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
