def register(self):
    app = self.app

    @app.get("/api/account-groups")
    def groups():
        return self.account_groups.list()

    @app.post("/api/account-groups")
    def create_group(data: dict):
        return self.account_groups.save(data)

    @app.put("/api/account-groups/{key}")
    def edit_group(key: int, data: dict):
        return self.account_groups.save(data, key)

    @app.post("/api/account-groups/assign")
    def assign_group(data: dict):
        return self.account_groups.assign(data.get("group_id"), data["account_ids"])

    @app.post("/api/account-merges/preview")
    def preview_merge(data: dict):
        return self.account_merges.preview(data["source_id"], data["target_id"])

    @app.post("/api/account-merges")
    def merge_account(data: dict):
        return self.account_merges.merge(data)

    @app.post("/api/account-merges/{key}/undo")
    def undo_merge(key: int):
        return self.account_merges.unmerge(key)

    @app.get("/api/account-merges")
    def merge_history():
        return self.account_merges.history()

    @app.get("/api/accounts")
    def accounts():
        return self.accounts.list()

    @app.post("/api/accounts")
    def create_account(data: dict):
        return self.accounts.save(data)

    @app.put("/api/accounts/{key}")
    def edit_account(key: int, data: dict):
        return self.accounts.save(data, key)

    @app.post("/api/accounts/{key}/opening")
    def opening(key: int, data: dict):
        return self.accounts.opening(key, data)

    @app.post("/api/accounts/{key}/reconcile")
    def reconcile(key: int, data: dict):
        return self.accounts.reconcile(key, data)

    @app.get("/api/accounts/{key}/valuations")
    def valuations(key: int):
        return self.securities.history(key)

    @app.post("/api/accounts/{key}/valuations")
    def update_valuation(key: int, data: dict):
        return self.securities.update(key, data)

    @app.post("/api/accounts/{key}/valuations/{valuation_id}/cancel")
    def cancel_valuation(key: int, valuation_id: int):
        return self.securities.cancel(key, valuation_id)
