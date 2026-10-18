"""Consolidating watch lists preserves selections without widening exclusions."""

import json
import pytest
from sqlalchemy import text
from app.analysis_settings import AnalysisSettingsService
from app.domain import Clock, DomainError
from app.models import AnalysisSettings
from app.overview import OverviewService
from test_analysis_settings import configured_ledger


def test_legacy_lists_merge_once_and_can_be_removed_without_changing_the_ledger(
    configured_ledger,
):
    db, ids = configured_ledger
    service = AnalysisSettingsService(db)
    with db.write() as session:
        legacy = dict(
            single_account_ids=[5],
            overview_account_ids=[6, ids["wealth"]],
            single_account_modes={"5": "counterparties"},
        )
        original = json.dumps(legacy)
        session.add(
            AnalysisSettings(id=1, revision=3, content=original, updated_at=Clock.now())
        )
    with db.read() as session:
        entries = [
            tuple(row)
            for row in session.execute(text("SELECT * FROM entries ORDER BY id"))
        ]

    config = service.get()
    assert config["single_account_ids"] == [5, 6, ids["wealth"]]
    assert config["single_excluded_account_ids"] == [5]
    assert config["single_account_modes"] == {
        "5": "counterparties",
        "6": "both",
        str(ids["wealth"]): "both",
    }
    assert "overview_account_ids" not in config
    with db.read() as session:
        assert session.get(AnalysisSettings, 1).content == original
    overview = OverviewService(db).snapshot(filters={"period": "latest_month"})
    assert overview["single_accounts"]["configured_account_ids"] == [
        5,
        6,
        ids["wealth"],
    ]

    # First save writes only the unified list; explicit removal must stay removed.
    saved = service.save(
        dict(revision=3, single_account_ids=[6], single_account_modes={"6": "cashflow"})
    )
    assert saved["single_account_ids"] == [6]
    assert saved["single_excluded_account_ids"] == [5]
    with db.read() as session:
        stored = json.loads(session.get(AnalysisSettings, 1).content)
        assert "overview_account_ids" not in stored
        assert entries == [
            tuple(row)
            for row in session.execute(text("SELECT * FROM entries ORDER BY id"))
        ]
    # Saving another setting must preserve the unified list and its analysis mode.
    saved = service.save(
        dict(revision=saved["revision"], large_income_threshold_minor=200000)
    )
    assert saved["single_account_ids"] == [6]
    assert saved["single_account_modes"] == {"6": "cashflow"}
    saved = service.save(dict(revision=saved["revision"], single_account_ids=[]))
    assert saved["single_account_ids"] == []
    assert service.get()["single_account_ids"] == []
    assert (
        OverviewService(db).snapshot(filters={"period": "latest_month"})[
            "single_accounts"
        ]["accounts"]
        == []
    )


def test_legacy_client_inputs_fold_into_one_list_and_validate_all_ids(
    configured_ledger,
):
    db, _ = configured_ledger
    service = AnalysisSettingsService(db)
    for invalid in ([True], [-1], [0], [999999], [1]):
        with pytest.raises(DomainError):
            service.save(dict(revision=0, overview_account_ids=invalid))
    saved = service.save(
        dict(revision=0, single_account_ids=[5], overview_account_ids=[6])
    )
    assert saved["single_account_ids"] == [5, 6]
    assert saved["single_excluded_account_ids"] == [5]
    assert "overview_account_ids" not in saved
