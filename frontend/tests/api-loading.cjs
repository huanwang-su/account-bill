const assert = require("node:assert/strict");
const path = require("node:path");
const React = require("react");
const { loadTs } = require("./source-loader.cjs");
const source = (name) => loadTs(path.resolve(__dirname, "../src", name));
const { LedgerApi } = source("api.ts");
const { LatestRequest } = source("LatestRequest.ts");
const { BillWorkspace } = source("BillWorkspace.tsx");
const { ExpenseTransactionPicker } = source("forms/ExpenseTransactionPicker.tsx");
const { PagedTable } = source("PagedTable.tsx");
function instance(Type, props) {
  const value = new Type(props);
  value.setState = (patch, done) => { Object.assign(value.state, typeof patch === "function" ? patch(value.state) : patch); done?.(); };
  return value;
}
async function run() {
  const originalFetch = global.fetch;
  try {
    let resolveRead, reads = 0;
    global.fetch = async (url, options) => {
      if (options.method !== "GET") return new Response(JSON.stringify({ ok: true }));
      reads++;
      if (reads === 1) return new Promise(resolve => { resolveRead = resolve; });
      return new Response(JSON.stringify({ revision: "new" }));
    };
    const first = new LedgerApi(), second = new LedgerApi();
    const old = first.request("/workspace"), shared = second.request("/workspace");
    assert.equal(reads, 1);
    await first.request("/accounts", "POST", {});
    assert.deepEqual(await second.request("/workspace"), { revision: "new" });
    assert.equal(reads, 2, "A successful write cannot reuse an earlier pending read");
    resolveRead(new Response(JSON.stringify({revision:"old"})));
    assert.deepEqual(await old, await shared);
    let signal;
    global.fetch = async (url, options) => { signal = options.signal; return new Response(JSON.stringify({id:7})); };
    const gate = new LatestRequest(first), version = gate.begin();
    await first.transaction(7);
    assert.equal(signal.aborted, false);
    gate.dispose();
    assert.equal(signal.aborted, true);
    assert.equal(gate.current(version), false);

    const page = instance(BillWorkspace, {mode:"list",onChanged:async()=>{}});
    const rows = Array.from({length:5}, (_,index)=>({id:"b"+index,facts:{occurred_at:"2026-10-01",amount_minor:100},effective_amount_minor:100,ledger_status:"POSTED"}));
    page.api.request = async (url) => url.startsWith("/bills?") ? {items:rows,total:31,page:1,page_size:5,statistics:{total:31,classified:31,pending:2,posted:29,reversed:0,review:0}} : [];
    await page.load();
    assert.equal(page.state.total,31);
    assert.equal(page.filtered.length,5);
    page.state.current=4;
    page.setFilter({q:"午餐"});
    assert.equal(page.state.current,1);
    const table = instance(PagedTable, {dataSource:rows,remote:{current:2,pageSize:5,total:31,onChange(current,size){assert.equal(current,3);assert.equal(size,5);}}});
    const rendered = table.render();
    assert.equal(rendered.props.pagination.total,31);
    rendered.props.onChange({current:3,pageSize:5},{},{},{action:"paginate"});
    const picker = instance(ExpenseTransactionPicker,{value:99});
    const calls=[];
    picker.api.request=async url=>{calls.push(url);return url==="/transactions/99" ? {id:99,amount:200,counterparty:"原支出"} : {items:[{id:1,amount:100,counterparty:"新支出"}]};};
    await picker.load("原支出");
    assert.equal(picker.state.rows[0].id,99);
    assert.ok(calls[0].includes("page_size=20") && calls[0].includes("kind=EXPENSE"));
    assert.ok(React.isValidElement(picker.render()));
    page.componentWillUnmount(); picker.componentWillUnmount();
    console.log("API/loading: coalescing, write invalidation, cancellation, server paging and cross-page refund lookup passed");
  } finally { global.fetch=originalFetch; }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
