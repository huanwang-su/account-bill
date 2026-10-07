"""Synthetic fixtures stay public; original financial files are opt-in local tests."""

import io
import json
import os
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape
import pytest
from app.database import Database
from app.domain import DomainError
from app.importers import ParserRegistry
from app.import_workflow import BillImportWorkflow
from app.bills import BillNormalizer, BillClassification
from app.statement_parsers import (
    WechatParser,
    PouchParser,
    CmbParser,
    BocParser,
    BankPdfReader,
)
from app.models import Account, Bill, Transaction
from app.services import ReportService


def xlsx(rows):
    # Minimal inline-string XLSX, deliberately carrying the defective official A1 dimension.
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        z.writestr(
            "[Content_Types].xml",
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
        )
        z.writestr(
            "_rels/.rels",
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        )
        z.writestr(
            "xl/workbook.xml",
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="明细" sheetId="1" r:id="rId1"/></sheets></workbook>',
        )
        z.writestr(
            "xl/_rels/workbook.xml.rels",
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        )
        body = "".join(
            '<row r="%d">%s</row>'
            % (
                i,
                "".join(
                    '<c r="%s%d" t="inlineStr"><is><t>%s</t></is></c>'
                    % (chr(65 + j), i, escape(str(v)))
                    for j, v in enumerate(row)
                ),
            )
            for i, row in enumerate(rows, 1)
        )
        z.writestr(
            "xl/worksheets/sheet1.xml",
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1"/><sheetData>'
            + body
            + "</sheetData></worksheet>",
        )
    return out.getvalue()


def pouch_rows():
    return [
        ["支付宝小荷包名称：家庭"],
        ["支付宝小荷包账户ID：20001234"],
        ["订单号", "交易时间", "交易说明", "收入金额", "支出金额"],
        ["long-order-10000000000000000001", "2026-10-01 12:00:00", "早餐", "", "12.30"],
        ["refund-10000000000000000002", "2026-10-02 12:00:00", "退款-早餐", "1.30", ""],
        ["save-10000000000000000003", "2026-10-03 12:00:00", "自动攒", "100", ""],
    ]


def label(doc):
    for row in doc.bills:
        row.classification = BillClassification(
            category_path=["收入" if row.facts.flow == "IN" else "支出", "其他"],
            tags=[],
            status="CLASSIFIED",
            note="测试分类",
            classified_by="test",
        )
    return doc.model_dump_json().encode()


def test_pouch_bad_dimensions_stable_identity_and_financial_guards(tmp_path):
    data = xlsx(pouch_rows())
    registry = ParserRegistry()
    assert registry.detect(data, "renamed.xlsx") == "alipay_pouch"
    parsed = PouchParser().parse(data, "renamed.xlsx")
    assert len(parsed.rows) == 3 and parsed.rows[0]["order_id"].endswith("0001")
    assert parsed.rows[1]["status"] == "退款成功"
    assert "转存" in parsed.rows[2]["review_reason"]
    revised = pouch_rows()
    revised[0] = ["支付宝小荷包名称：新名称"]
    assert [r["source_key"] for r in parsed.rows] == [
        r["source_key"] for r in PouchParser().parse(xlsx(revised), "new.xlsx").rows
    ]
    db = Database(tmp_path / "ledger.sqlite3")
    db.initialize()
    flow = BillImportWorkflow(db)
    run = flow.stage(data, "pouch.xlsx")
    assert not run["error"]
    doc = BillNormalizer().normalize("alipay_pouch", parsed.rows)
    flow.classify(run["run_id"], label(doc))
    result = flow.commit(run["run_id"])
    assert result["created"] == 3 and result["posted"] == 1 and result["pending"] == 2
    with db.read() as s:
        assert s.query(Account).filter_by(number="20001234").count() == 1
    duplicate = flow.stage(data, "again.xlsx")
    flow.classify(duplicate["run_id"], label(doc))
    result = flow.commit(duplicate["run_id"])
    assert result["created"] == 0 and result["posted"] == 0
    assert len(flow.detail(duplicate["run_id"])["artifacts"]) == 3
    flow.cancel(duplicate["run_id"])
    assert len(ReportService(db).list()) == 1
    flow.cancel(run["run_id"])
    assert len(ReportService(db).list()) == 0
    assert ReportService(db).integrity()["ok"]


def wechat_rows():
    return [
        ["微信支付账单明细"],
        ["微信昵称：[测试]"],
        ["共3笔记录"],
        ["收入：1笔 0.20元"],
        ["支出：2笔 12.00元"],
        [
            "交易时间",
            "交易类型",
            "交易对方",
            "商品",
            "收/支",
            "金额(元)",
            "支付方式",
            "当前状态",
            "交易单号",
        ],
        [
            "2026-10-01 12:00:00",
            "商户消费",
            "餐厅",
            "早餐",
            "支出",
            "10.00",
            "零钱",
            "支付成功",
            "10000000000000000001",
        ],
        [
            "2026-10-01 13:00:00",
            "亲属卡交易",
            "家庭",
            "/",
            "支出",
            "2.00",
            "招商银行储蓄卡(1234)",
            "已退款(¥0.20)",
            "10000000000000000002",
        ],
        [
            "2026-10-02 12:00:00",
            "亲属卡交易-退款",
            "家庭",
            "/",
            "收入",
            "0.20",
            "招商银行储蓄卡(1234)",
            "已退款¥0.20",
            "10000000000000000003",
        ],
    ]


def test_wechat_refund_is_separate_and_bank_channel_pending(tmp_path):
    data = xlsx(wechat_rows())
    p = WechatParser().parse(data, "wx.xlsx")
    assert [r["status"] for r in p.rows] == ["交易成功", "交易成功", "退款成功"]
    renamed = wechat_rows()
    renamed[1] = ["微信昵称：[改名]"]
    assert (
        p.rows[0]["source_key"]
        == WechatParser().parse(xlsx(renamed), "wx.xlsx").rows[0]["source_key"]
    )
    db = Database(tmp_path / "db")
    db.initialize()
    flow = BillImportWorkflow(db)
    with db.write() as s:
        s.add(
            Account(
                name="招商银行卡", number="6210001234", kind="招商银行", role="ASSET"
            )
        )
    run = flow.stage(data, "wx.xlsx")
    assert run["status"] == "NORMALIZED"
    flow.classify(run["run_id"], label(BillNormalizer().normalize("wechat", p.rows)))
    result = flow.commit(run["run_id"])
    assert result["posted"] == 1 and result["pending"] == 2
    assert all(
        "银行" in r["ledger_reason"] for r in flow.detail(run["run_id"])["rows"][1:]
    )
    changed = wechat_rows()
    changed[2] = ["共4笔记录"]
    failed = flow.stage(xlsx(changed), "bad.xlsx")
    assert failed["status"] == "ERROR"
    assert len(flow.detail(failed["run_id"])["artifacts"]) == 1
    assert len(ReportService(db).list()) == 1


class Pdf:
    def __init__(self, pages):
        self.pages = pages

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass


class CmbPage:
    width = 600

    def extract_text(self):
        return "招商银行交易流水\n户名：测试\n账号：6210001234"

    def extract_words(self):
        words = [
            dict(text=t, x0=x, top=20)
            for t, x in zip(CmbParser.HEADERS, [30, 95, 150, 230, 300, 410])
        ]
        for y, date, amount, balance in [
            (60, "2026-10-01", "100.00", "500.00"),
            (90, "2026-10-02", "-20.00", "480.00"),
        ]:
            words.extend(
                dict(text=t, x0=x, top=y)
                for t, x in zip(
                    [date, "CNY", amount, balance, "快捷支付", "1点点337", "987654321"],
                    [30, 95, 150, 230, 300, 410, 495],
                )
            )
        return words


def test_cmb_date_precision_counterparty_digits_and_balance_validation(monkeypatch):
    monkeypatch.setattr(BankPdfReader, "open", lambda _: Pdf([CmbPage()]))
    a = CmbParser().parse(b"x", "a.pdf")
    b = CmbParser().parse(b"y", "b.pdf")
    assert a.rows[1]["counterparty"] == "1点点337"
    assert a.rows[1]["counterparty_account"] == "987654321"
    assert a.rows[1]["time_precision"] == "date"
    assert [r["source_key"] for r in a.rows] == [r["source_key"] for r in b.rows]
    assert (
        a.metadata["opening_balance"] == 40000
        and a.metadata["closing_balance"] == 48000
    )
    a.rows[1]["balance"] += 1
    with pytest.raises(DomainError, match="余额衔接"):
        CmbParser().finish(a.owner, a.rows)


class BocPage:
    def extract_text(self):
        return "中国银行交易流水明细清单 借记卡号：621001234 客户姓名：测试 行数：2 借方发生数：20.00 贷方发生数：100.00"

    def extract_tables(self):
        return [
            [
                [
                    "记账日期",
                    "记账时间",
                    "币别",
                    "金额",
                    "余额",
                    "交易名称",
                    "渠道",
                    "网点名称",
                    "附言",
                    "对方账户名",
                    "对方卡号/账号",
                    "对方开户行",
                ],
                [
                    "2026-10-02",
                    "13:00:00",
                    "人民币",
                    "-20.00",
                    "480.00",
                    "公积金",
                    "",
                    "",
                    "---",
                    "示例管理中\n心",
                    "1000",
                    "",
                ],
                [
                    "2026-10-01",
                    "12:00:00",
                    "人民币",
                    "100.00",
                    "500.00",
                    "跨行转账",
                    "",
                    "",
                    "转账",
                    "测试",
                    "6210001234",
                    "招商银行",
                ],
            ]
        ]


def test_boc_multiline_fields_count_and_signed_amount(monkeypatch):
    monkeypatch.setattr(BankPdfReader, "open", lambda _: Pdf([BocPage()]))
    parsed = BocParser().parse(b"x", "b.pdf")
    assert parsed.rows[0]["counterparty"] == "示例管理中心"
    assert parsed.rows[0]["amount"] == 2000 and parsed.rows[0]["direction"] == "支出"
    assert parsed.rows[1]["review_reason"]
    assert parsed.metadata["balance_chain_checked"]


def test_real_multisource_samples():
    manifest = os.environ.get("MULTISOURCE_SAMPLES")
    if not manifest:
        pytest.skip("private sample paths not provided")
    paths = json.loads(Path(manifest).read_text())
    expected = {
        "cmb": (41, 5311696, 5068098),
        "boc": (12, 5319581, 6190528),
        "wechat": (18, 89633, 201261),
        "pouch": (192, 949263, 947955),
    }
    for name, path in paths.items():
        p = Path(path)
        registry = ParserRegistry()
        provider = registry.detect(p.read_bytes(), p.name)
        parsed = registry.get(provider).parse(p.read_bytes(), p.name)
        assert not any(r["error"] for r in parsed.rows)
        count, income, expense = expected[name]
        assert len(parsed.rows) == count
        assert parsed.metadata["totals"]["收入"]["amount"] == income
        assert parsed.metadata["totals"]["支出"]["amount"] == expense
        assert len(BillNormalizer().normalize(provider, parsed.rows).bills) == count


def test_pouch_missing_order_never_silently_deduplicates(tmp_path):
    rows = pouch_rows()
    rows[3][0] = ""
    parsed = PouchParser().parse(xlsx(rows), "pouch.xlsx")
    assert "缺少交易流水号" in parsed.rows[0]["error"]
    db = Database(tmp_path / "db")
    db.initialize()
    flow = BillImportWorkflow(db)
    run = flow.stage(xlsx(rows), "pouch.xlsx")
    assert run["status"] == "ERROR"
    assert len(flow.bills.list()) == 0


def test_pouch_reuses_legacy_alias_even_after_display_rename(tmp_path):
    from app.account_matching import AlipayAccountResolver

    db = Database(tmp_path / "db")
    db.initialize()
    with db.write() as session:
        old = AlipayAccountResolver().resolve(
            session, "old-owner", "支付宝小荷包(????家庭)"
        )
        old.name = "自定义名字"
        old_id = old.id
    flow = BillImportWorkflow(db)
    run = flow.stage(xlsx(pouch_rows()), "pouch.xlsx")
    assert not run["error"]
    with db.read() as session:
        account = session.query(Account).filter_by(kind="支付宝小荷包").one()
        assert account.id == old_id and account.number == "20001234"
        assert account.name == "自定义名字"


def test_wechat_neutral_is_reviewable_not_alipay_ignored():
    rows = [
        ["微信支付账单明细"],
        ["微信昵称：[测试]"],
        ["共1笔记录"],
        ["中性交易：1笔 100.00元"],
        wechat_rows()[5],
        [
            "2026-10-01 12:00:00",
            "零钱充值",
            "自己",
            "/",
            "/",
            "100.00",
            "招商银行储蓄卡(1234)",
            "支付成功",
            "10000000000000000004",
        ],
    ]
    parsed = WechatParser().parse(xlsx(rows), "wx.xlsx")
    record = BillNormalizer().normalize("wechat", parsed.rows).bills[0]
    assert record.bill_status == "NORMAL"
    assert record.facts.flow == "UNSPECIFIED"
    assert parsed.rows[0]["review_reason"]
