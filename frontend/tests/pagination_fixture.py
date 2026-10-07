"""Synthetic multi-page records. Never reads the user's ledger or source files."""
import csv
import io
import json
import sys
from app.database import Database
from app.import_workflow import BillImportWorkflow
from app.refund_matching import RefundMatchService


def statement(count, prefix, mixed=False, refunds=False):
    text = io.StringIO()
    writer = csv.writer(text)
    writer.writerow(['交易时间','交易分类','交易对方','对方账号','商品说明','收/支','金额','收/付款方式','交易状态','交易订单号','商家订单号','备注'])
    for i in range(count):
        for refund in ([False, True] if refunds else [False]):
            writer.writerow(['2026-09-10 12:00:00','餐饮美食',f'{prefix}商户{i:03}', '/', f'{prefix}商品{i:03}', '收入' if refund else '支出', str(10+i), '账户余额&优惠' if mixed else '账户余额', '退款成功' if refund else '交易成功', f'{prefix}{i:03}-refund' if refund else f'{prefix}{i:03}-pay','',''])
    return text.getvalue().encode('utf-8-sig')


def create(flow, count, prefix, **kwargs):
    run = flow.stage(statement(count, prefix, **kwargs), prefix+'.csv')['run_id']
    with flow.db.read() as session:
        doc = flow.artifacts.document(session, run, 'NORMALIZED').model_dump()
    for row in doc['bills']:
        row['classification'] = dict(category_path=['退款'] if row['facts']['settlement']=='REFUNDED' else ['支出','餐饮'],tags=[],status='CLASSIFIED',note='合成测试分类',classified_by='测试')
    flow.classify(run, json.dumps(doc, ensure_ascii=False).encode())
    if kwargs.get('refunds'):
        service = RefundMatchService(flow.db)
        candidates = service.candidates(run)
        decisions=[]
        for row in candidates['refunds']:
            payment=next(p for p in row['payments'] if p['facts']['counterparty']==row['refund']['facts']['counterparty'])
            decisions.append(dict(refund_id=row['refund']['id'],payment_id=payment['id'],decision='MATCHED',note='合成测试：同商户、同订单、等金额',matched_by='测试'))
        service.apply(run, json.dumps(dict(schema_version='local-ledger.refund-matches.v1',run_id=run,candidates_digest=candidates['candidates_digest'],decisions=decisions)).encode())
    flow.commit(run)


if __name__ == '__main__':
    db=Database(sys.argv[1]);db.initialize();flow=BillImportWorkflow(db)
    create(flow,65,'分页')
    create(flow,2,'待处理',mixed=True)
    create(flow,7,'退款分页',refunds=True)
    flow.stage(statement(1,'小批次'),'小批次.csv')
