"""Provider-specific payment hints resolve to reusable, stable account identities."""

import re
from .models import Account, AccountAlias
from .account_config import AccountGraph


class AlipayAccountResolver:
    # Only known non-funding suffixes may be removed. Mixed fund sources stay unresolved.
    DISCOUNTS = {
        "遇财神立减",
        "企业码员工优惠",
        "商家优惠抵扣",
        "代扣随机抽立减",
        "支付立减优惠",
    }

    def resolve(self, session, owner, method):
        account = self.resolve_source(session, owner, method)
        return AccountGraph(session).canonical(account.id) if account else None

    def resolve_source(self, session, owner, method):
        parts = [part.strip() for part in method.split("&")]
        match = re.fullmatch(r"支付宝小荷包[（(](.+)[）)]", parts[0])
        if match:
            if any(part not in self.DISCOUNTS for part in parts[1:]):
                return None
            source_name = "支付宝小荷包(" + match.group(1) + ")"
            alias = (
                session.query(AccountAlias)
                .filter_by(provider="alipay", owner=owner, source_name=source_name)
                .first()
            )
            if alias:
                account = session.get(Account, alias.account_id)
                return account if account.active and account.role == "ASSET" else None
            # Keep the exact source identity in the alias. Hide damaged leading emoji
            # placeholders in the display name only; never merge distinct identities.
            label = match.group(1).lstrip("?？ ") or match.group(1)
            base = "小荷包（" + label[:60] + "）"
            name = base
            suffix = 2
            while session.query(Account).filter_by(name=name).first():
                name = f"{base} · {suffix}"
                suffix += 1
            account = Account(
                name=name, role="ASSET", kind="支付宝小荷包", opening_set=False
            )
            session.add(account)
            session.flush()
            session.add(
                AccountAlias(
                    provider="alipay",
                    owner=owner,
                    source_name=source_name,
                    account_id=account.id,
                )
            )
            session.flush()
            return account
        suggested = "支付宝余额" if method == "账户余额" else method
        alias = (
            session.query(AccountAlias)
            .filter_by(provider="account-name", owner="", source_name=suggested)
            .first()
        )
        if alias:
            account = session.get(Account, alias.account_id)
            return account if account and account.active else None
        return (
            session.query(Account)
            .filter(
                Account.name == suggested,
                Account.active == True,
                Account.role != "SYSTEM",
            )
            .first()
        )


class StatementAccountResolver:
    """Stable bank and wallet identities; payment channels never become merchants."""

    LABELS = {"cmb": "招商银行", "boc": "中国银行"}

    def resolve(self, session, provider, statement, row):
        account = self.resolve_source(session, provider, statement, row)
        return AccountGraph(session).canonical(account.id) if account else None

    def resolve_source(self, session, provider, statement, row):
        if provider == "alipay":
            return AlipayAccountResolver().resolve(
                session, statement.owner, row["method"]
            )
        if provider == "wechat":
            hint = row.get("funding_hint", row["method"])
            if hint == "微信":
                return (
                    session.query(Account)
                    .filter_by(name="微信", active=True, role="ASSET")
                    .first()
                )
            bank = re.search(r"(招商银行|中国银行).*?[（(](\d{4})[）)]", hint)
            if bank:
                candidates = (
                    session.query(Account)
                    .filter(
                        Account.number.endswith(bank.group(2)),
                        Account.kind == bank.group(1),
                        Account.active == True,
                        Account.role == "ASSET",
                    )
                    .all()
                )
                return candidates[0] if len(candidates) == 1 else None
            return None
        number = statement.metadata.get("account_number", "")
        if not number:
            return None
        alias = (
            session.query(AccountAlias)
            .filter_by(provider=provider, owner=number, source_name=number)
            .first()
        )
        if alias:
            account = session.get(Account, alias.account_id)
            return account if account.active and account.role == "ASSET" else None
        kind = self.LABELS.get(provider, "支付宝小荷包")
        account = (
            session.query(Account)
            .filter_by(number=number, kind=kind, role="ASSET")
            .first()
        )
        if account is None and provider == "alipay_pouch":
            # A previous Alipay export may have replaced emoji with question marks.
            normalize = lambda text: "".join(
                re.findall(r"[\u4e00-\u9fffA-Za-z0-9]", text)
            )
            label = normalize(statement.metadata["account_name"])
            candidates = []
            for old in session.query(AccountAlias).filter_by(provider="alipay"):
                match = re.fullmatch(r"支付宝小荷包[（(](.+)[）)]", old.source_name)
                if match and normalize(match.group(1)) == label:
                    candidate = session.get(Account, old.account_id)
                    if candidate and not candidate.number and candidate.role == "ASSET":
                        candidates.append(candidate)
            unique = {a.id: a for a in candidates}
            if len(unique) == 1:
                account = next(iter(unique.values()))
                account.number = number
        if account is None:
            base = (
                (kind + "（" + number[-4:] + "）")
                if provider in self.LABELS
                else "小荷包（"
                + (
                    "".join(
                        re.findall(
                            r"[\u4e00-\u9fffA-Za-z0-9]",
                            statement.metadata["account_name"],
                        )
                    )
                    or number[-4:]
                )[:60]
                + "）"
            )
            name, suffix = base, 2
            while session.query(Account).filter_by(name=name).first():
                name = base + f" · {suffix}"
                suffix += 1
            account = Account(
                name=name, number=number, role="ASSET", kind=kind, opening_set=False
            )
            session.add(account)
            session.flush()
        session.add(
            AccountAlias(
                provider=provider,
                owner=number,
                source_name=number,
                account_id=account.id,
            )
        )
        session.flush()
        return account if account.active else None
