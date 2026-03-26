import base64
import json
import mimetypes
import os
from typing import Any, Dict, List, Literal, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, Response
from pydantic import BaseModel, Field

from muws_eval.evaluator import evaluate_batch


load_dotenv()

SCREENSHOTS_DIR = os.path.abspath(os.getenv("SCREENSHOTS_DIR", "./screenshots"))
FALLBACK_ASSETS_DIR = os.getenv(
    "FALLBACK_ASSETS_DIR",
    os.path.expanduser("~/.cursor/projects/Users-arykaul-dev-vlm/assets"),
)
FALLBACK_ASSETS_DIR_ABS = os.path.abspath(FALLBACK_ASSETS_DIR) if FALLBACK_ASSETS_DIR else None

MODEL_DEFAULT = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
METADATA_EXAMPLE_PATH = os.path.join(PROJECT_ROOT, "metadata.json")
RESULTS_PATH = os.path.join(PROJECT_ROOT, "results.json")

WEB_DIR = os.path.join(PROJECT_ROOT, "web")
INDEX_HTML_PATH = os.path.join(WEB_DIR, "index.html")


class ScreenshotInput(BaseModel):
    filename: Optional[str] = Field(default=None, description="Server-side filename to load from SCREENSHOTS_DIR.")
    image_base64: Optional[str] = Field(
        default=None, description="Optional base64 (or data URL) for uploaded screenshots."
    )
    image_mime_type: Optional[str] = Field(default=None, description="Optional MIME type for uploaded images.")

    step: int
    seconds_since_launch: int
    user_action: str
    notes: Optional[str] = ""


class AppInput(BaseModel):
    app_name: str
    package_name: Optional[str] = "unknown"
    screenshots: List[ScreenshotInput]


class EvaluateRequest(BaseModel):
    condition: Literal["baseline", "context", "trajectory", "all"] = "all"
    model: str = MODEL_DEFAULT
    apps: List[AppInput]


app = FastAPI(title="MUwS Screenshot Evaluator")

# UI is served from same origin, but allow local dev.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _read_text(path: str) -> str:
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


@app.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
    try:
        return HTMLResponse(_read_text(INDEX_HTML_PATH))
    except FileNotFoundError:
        return HTMLResponse(
            "<h1>UI not found</h1><p>Missing `web/index.html` in project.</p>",
            status_code=404,
        )


@app.get("/api/metadata")
def get_metadata_example() -> Dict[str, Any]:
    try:
        with open(METADATA_EXAMPLE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Missing metadata.json at project root.")


@app.get("/api/results")
def get_results() -> List[Dict[str, Any]]:
    # Optional convenience endpoint for the UI: precomputed results from `evaluate.py`.
    try:
        with open(RESULTS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, list):
            raise ValueError("results.json must contain a top-level JSON list.")
        return data
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Missing results.json. Run `evaluate.py ... --condition all` first.")


@app.get("/api/screenshot")
def get_screenshot(filename: str) -> Response:
    """
    Fetch a screenshot image by filename.

    Resolution order:
    1) SCREENSHOTS_DIR/filename
    2) FALLBACK_ASSETS_DIR/filename (useful for this workspace environment)
    """
    primary_path = os.path.join(SCREENSHOTS_DIR, filename)
    if os.path.exists(primary_path):
        path = primary_path
    else:
        if not FALLBACK_ASSETS_DIR_ABS:
            raise HTTPException(status_code=404, detail="Screenshot not found (no fallback assets dir).")
        fallback_path = os.path.join(FALLBACK_ASSETS_DIR_ABS, filename)
        if not os.path.exists(fallback_path):
            raise HTTPException(status_code=404, detail="Screenshot not found.")
        path = fallback_path

    mime, _ = mimetypes.guess_type(path)
    mime_type = mime or "image/png"
    with open(path, "rb") as f:
        return Response(content=f.read(), media_type=mime_type)


@app.post("/api/evaluate")
def api_evaluate(req: EvaluateRequest) -> List[Dict[str, Any]]:
    # pydantic -> plain dicts
    apps_payload = [a.model_dump() for a in req.apps]
    return evaluate_batch(
        apps=apps_payload,
        condition=req.condition,
        model=req.model,
        screenshots_dir=SCREENSHOTS_DIR,
        fallback_assets_dir=FALLBACK_ASSETS_DIR_ABS,
        api_key=None,  # evaluator loads GEMINI_API_KEY from .env
    )


# Serve web static assets (very small project).
@app.get("/web/app.js", response_class=HTMLResponse)
def app_js() -> HTMLResponse:
    js_path = os.path.join(WEB_DIR, "app.js")
    if not os.path.exists(js_path):
        raise HTTPException(status_code=404, detail="Missing web/app.js")
    return HTMLResponse(_read_text(js_path), media_type="application/javascript")


@app.get("/web/style.css", response_class=HTMLResponse)
def style_css() -> HTMLResponse:
    css_path = os.path.join(WEB_DIR, "style.css")
    if not os.path.exists(css_path):
        raise HTTPException(status_code=404, detail="Missing web/style.css")
    return HTMLResponse(_read_text(css_path), media_type="text/css")

