"""Keep later provider annotations without rewriting a booked event's facts."""

import json
from .models import Bill


class SourceObservationReconciler:
    @staticmethod
    def reconcile(session, provider, document):
        observations = []
        for record in document.bills:
            saved = session.get(Bill, record.id)
            if not saved:
                continue
            previous = json.loads(saved.facts)
            current = record.facts.model_dump()
            changed = {k for k in previous if previous[k] != current[k]}
            if not changed:
                continue
            receipt = (
                provider == "alipay"
                and changed == {"settlement"}
                and (
                    (
                        previous["settlement"] == "AWAITING_RECEIPT"
                        and current["settlement"] == "COMPLETED"
                    )
                    or (
                        record.bill_status == "IGNORED"
                        and previous["settlement"] == "COMPLETED"
                        and current["settlement"] == "CLOSED"
                    )
                )
            )
            refunded_description = (
                provider == "alipay_pouch"
                and changed == {"description"}
                and current["description"] == "已退款 - " + previous["description"]
            )
            family_voucher = (
                provider == "wechat"
                and changed <= {"counterparty", "description", "payment_hint"}
                and previous["description"] == "亲属卡交易"
                and current["payment_hint"].startswith("亲属卡(")
                and current["description"].startswith("商户消费")
            )
            if receipt or refunded_description or family_voucher:
                observations.append(
                    dict(id=record.id, previous=previous, observed=current)
                )
                record.facts = type(record.facts).model_validate(previous)
        return observations
