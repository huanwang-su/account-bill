"""Offline staged-file workflow; no AI API or credentials."""

import argparse
from pathlib import Path
from app.bills import BillService
from app.database import Database
from app.import_workflow import BillImportWorkflow
from app.refund_matching import RefundMatchService
from app.classification_policy import ClassificationPolicyService
from app.transfer_matching import TransferMatchService
import json


class BillFileTool:
    def run(self, args):
        db = Database(args.database)
        db.initialize()
        workflow = BillImportWorkflow(db)
        if args.command == "normalize":
            source = Path(args.input)
            result = workflow.stage(source.read_bytes(), source.name)
            if result["error"]:
                raise ValueError(
                    f"批次 {result['run_id']} 已保存原文件，但转换失败：{result['error']}"
                )
            detail = workflow.detail(result["run_id"])
            artifact = next(
                a for a in detail["artifacts"] if a["stage"] == "NORMALIZED"
            )
            Path(args.output).write_bytes(workflow.download(artifact["id"])[1])
            print(
                f"批次 {result['run_id']}：已保存原文件和统一账单；分类后 save --run-id {result['run_id']}，然后 commit {result['run_id']}"
            )
        elif args.command == "save":
            source = Path(args.input)
            print(workflow.classify(args.run_id, source.read_bytes(), source.name))
            print(
                "分类文件已归档；运行 commit 后生成交易明细并自动入账，特殊记录待核对。"
            )
        elif args.command == "commit":
            print(workflow.commit(args.run_id))
        elif args.command == "refund-candidates":
            Path(args.output).write_text(
                json.dumps(
                    RefundMatchService(db).candidates(args.run_id),
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
            print(
                "已导出同文件全额及部分退款候选；由 Codex 判断匹配后使用 refund-apply 保存决定。"
            )
        elif args.command == "refund-apply":
            source = Path(args.input)
            print(
                RefundMatchService(db).apply(
                    args.run_id, source.read_bytes(), source.name
                )
            )
        elif args.command == "export":
            Path(args.output).write_text(
                BillService(db).export().model_dump_json(indent=2), encoding="utf-8"
            )
        elif args.command == "ai-reference":
            Path(args.output).write_text(
                json.dumps(
                    ClassificationPolicyService(db).get(), ensure_ascii=False, indent=2
                ),
                encoding="utf-8",
            )
        elif args.command == "reprocess":
            print(ClassificationPolicyService(db).reprocess())
        elif args.command == "match-transfers":
            print(TransferMatchService(db).auto())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="统一账单导入与离线分类")
    parser.add_argument(
        "--database",
        default=str(Path(__file__).resolve().parents[1] / "data" / "ledger.sqlite3"),
    )
    sub = parser.add_subparsers(dest="command", required=True)
    normalize = sub.add_parser("normalize")
    normalize.add_argument("input")
    normalize.add_argument("output")
    save = sub.add_parser("save")
    save.add_argument("input")
    save.add_argument("--run-id", type=int, required=True)
    commit = sub.add_parser("commit")
    commit.add_argument("run_id", type=int)
    candidates = sub.add_parser("refund-candidates")
    candidates.add_argument("run_id", type=int)
    candidates.add_argument("output")
    match = sub.add_parser("refund-apply")
    match.add_argument("input")
    match.add_argument("--run-id", type=int, required=True)
    export = sub.add_parser("export")
    export.add_argument("output")
    reference = sub.add_parser("ai-reference")
    reference.add_argument("output")
    sub.add_parser("reprocess")
    sub.add_parser("match-transfers")
    BillFileTool().run(parser.parse_args())
