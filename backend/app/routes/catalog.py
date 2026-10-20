import json
from fastapi.responses import Response


def register(self):
    app = self.app

    @app.get("/api/analysis-settings")
    def analysis_settings():
        return self.analysis_settings.get()

    @app.put("/api/analysis-settings")
    def save_analysis_settings(data: dict):
        return self.analysis_settings.save(data)

    @app.get("/api/classification-policy")
    def classification_policy():
        return self.policy.get()

    @app.put("/api/classification-policy")
    def save_classification_policy(data: dict):
        return self.policy.save(data)

    @app.get("/api/classification-policy/reference")
    def policy_reference():
        return Response(
            json.dumps(self.policy.reference(), ensure_ascii=False, indent=2),
            media_type="application/json",
            headers={
                "Content-Disposition": "attachment; filename=ai-classification-reference.json"
            },
        )

    @app.post("/api/classification-policy/reprocess")
    def reprocess_pending():
        return self.policy.reprocess()

    @app.get("/api/categories")
    def categories():
        return self.catalog.categories()

    @app.post("/api/categories")
    def create_category(data: dict):
        return self.catalog.save_category(data)

    @app.put("/api/categories/{key}")
    def edit_category(key: int, data: dict):
        return self.catalog.save_category(data, key)

    @app.get("/api/tags")
    def tags():
        return self.catalog.tags()

    @app.post("/api/tags")
    def create_tag(data: dict):
        return self.catalog.save_tag(data)

    @app.put("/api/tags/{key}")
    def edit_tag(key: int, data: dict):
        return self.catalog.save_tag(data, key)

    @app.post("/api/tags/{key}/activation")
    def tag_activation(key: int, data: dict):
        return self.catalog.set_tag_active(key, data.get("active"))
