import base64
import json
import mimetypes
import os
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

from dotenv import load_dotenv
from google import genai
from google.genai import types


VIOLATION_TYPES = [
    "disruptive_ads",
    "unauthorized_system_imitation",
    "aggressive_upsell",
]


SYSTEM_PROMPT = (
    "You are a mobile app policy analyst evaluating Android apps against Google's Mobile Unwanted Software (MUwS) policy. "
    "For each screenshot or sequence, identify any violations, classify the violation type, explain why it violates the policy, "
    "and rate the severity as low/medium/high."
)


def _safe_int(x: Any, default: int = 0) -> int:
    try:
        return int(x)
    except Exception:
        return default


def _extract_json_object(text: str) -> Dict[str, Any]:
    # Common model behavior: wrap output in ```json ... ``` fences.
    cleaned = (text or "").strip()
    if cleaned.startswith("```"):
        # Drop the opening fence line (``` or ```json) and the closing fence if present.
        cleaned = re.sub(r"^```[a-zA-Z0-9_-]*\n", "", cleaned)
        cleaned = re.sub(r"\n```$", "", cleaned.strip())
    cleaned = cleaned.strip()

    # Find the outermost JSON object in case the model adds leading/trailing prose.
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("No JSON object found in model response.")

    candidate = cleaned[start : end + 1]
    return json.loads(candidate)


def _decode_data_url_maybe(b64_or_data_url: str) -> str:
    # Accept either raw base64 or a data URL like: data:image/png;base64,AAAA...
    if "base64," in b64_or_data_url:
        return b64_or_data_url.split("base64,", 1)[1]
    return b64_or_data_url


def _image_mime_from_filename(filename: str) -> str:
    mime, _ = mimetypes.guess_type(filename)
    return mime or "image/png"


def _load_image_bytes_from_entry(
    *,
    screenshots_dir: str,
    fallback_assets_dir: Optional[str],
    filename: Optional[str],
    image_base64: Optional[str],
    image_mime_type: Optional[str],
) -> Tuple[bytes, str]:
    if image_base64:
        raw_b64 = _decode_data_url_maybe(image_base64)
        data = base64.b64decode(raw_b64)
        return data, image_mime_type or "image/png"

    if not filename:
        raise ValueError("Either filename or image_base64 must be provided.")

    # Try the primary screenshots directory first.
    primary_path = os.path.join(screenshots_dir, filename)
    if os.path.exists(primary_path):
        with open(primary_path, "rb") as f:
            return f.read(), _image_mime_from_filename(filename)

    # Then try the fallback directory (useful in this workspace environment).
    if fallback_assets_dir:
        fallback_path = os.path.join(fallback_assets_dir, filename)
        if os.path.exists(fallback_path):
            with open(fallback_path, "rb") as f:
                return f.read(), _image_mime_from_filename(filename)

    raise FileNotFoundError(
        f"Could not find image '{filename}' in '{screenshots_dir}'"
        + (f" or fallback '{fallback_assets_dir}'." if fallback_assets_dir else ".")
    )


def _build_prompt_baseline(app_name: str, package_name: str, screenshot_filename: str) -> str:
    return (
        "Does this screenshot show a MUwS violation? If so, what type?\n\n"
        "Return valid JSON only with keys: violation_detected (bool), violation_types (list of strings), "
        "severity (low/medium/high), reasoning (string).\n"
        "Keep reasoning concise (max 3 sentences).\n\n"
        f"App: {app_name}\nPackage: {package_name}\nFilename: {screenshot_filename}\n\n"
        "Violation type options: "
        + ", ".join(VIOLATION_TYPES)
        + ". If no violation, set violation_detected=false and violation_types=[] and severity=low."
    )


def _build_prompt_context(
    *,
    app_name: str,
    package_name: str,
    step: int,
    seconds_since_launch: int,
    user_action: str,
    notes: Optional[str],
    screenshot_filename: str,
) -> str:
    notes_block = ""
    if notes and notes.strip():
        notes_block = f"\nNotes (observation): {notes.strip()}\n"

    return (
        "Does this screenshot show a MUwS violation? If so, what type?\n\n"
        "Return valid JSON only with keys: violation_detected (bool), violation_types (list of strings), "
        "severity (low/medium/high), reasoning (string).\n"
        "Keep reasoning concise (max 3 sentences).\n\n"
        "Violation type options: "
        + ", ".join(VIOLATION_TYPES)
        + ". If no violation, set violation_detected=false and violation_types=[] and severity=low.\n\n"
        f"App: {app_name}\nPackage: {package_name}\nFilename: {screenshot_filename}\n"
        f"Step: {step}\nSeconds since app launch: {seconds_since_launch}\n"
        f"User action before this screen appeared: {user_action}\n"
        f"{notes_block}"
    )


def _build_prompt_trajectory_intro(app_name: str, package_name: str) -> str:
    return (
        "Does this ordered sequence of screenshots show a MUwS violation? If so, what type?\n\n"
        f"Analyze this ordered sequence of screenshots for MUwS violations that are only visible from the full user flow.\n"
        f"App: {app_name}\nPackage: {package_name}\n\n"
        "Return valid JSON only with keys: violation_detected (bool), violation_types (list of strings), "
        "severity (low/medium/high), reasoning (string).\n"
        "Keep reasoning concise (max 5 sentences).\n\n"
        "Violation type options: "
        + ", ".join(VIOLATION_TYPES)
        + ". If no violation, set violation_detected=false and violation_types=[] and severity=low."
    )


@dataclass(frozen=True)
class ScreenshotEntry:
    filename: Optional[str]
    image_base64: Optional[str]
    image_mime_type: Optional[str]
    step: int
    seconds_since_launch: int
    user_action: str
    notes: Optional[str]


def _screenshot_parts_for_baseline(user_text: str, image_bytes: bytes, mime_type: str):
    return [
        types.Part.from_text(text=user_text),
        types.Part.from_bytes(data=image_bytes, mime_type=mime_type),
    ]


def _screenshot_parts_for_context(user_text: str, image_bytes: bytes, mime_type: str):
    return [
        types.Part.from_text(text=user_text),
        types.Part.from_bytes(data=image_bytes, mime_type=mime_type),
    ]


def _screenshot_parts_for_trajectory(
    *,
    intro_text: str,
    ordered_entries: Sequence[ScreenshotEntry],
    image_bytes_list: Sequence[bytes],
    mime_types_list: Sequence[str],
) -> List[types.Part]:
    # Multimodal sequence: intro text -> image1 -> action_to_reach_next_screen -> image2 -> ...
    parts: List[types.Part] = [types.Part.from_text(text=intro_text)]
    if ordered_entries:
        first = ordered_entries[0]
        first_notes_block = ""
        if first.notes and first.notes.strip():
            first_notes_block = f"\nNotes (observation): {first.notes.strip()}"
        parts.append(
            types.Part.from_text(
                text=
                f"Action before step {first.step} screenshot: {first.user_action}\n"
                f"Seconds since app launch: {first.seconds_since_launch}\n"
                f"{first_notes_block}\n"
            )
        )
    for idx, entry in enumerate(ordered_entries):
        parts.append(types.Part.from_bytes(data=image_bytes_list[idx], mime_type=mime_types_list[idx]))
        if idx < len(ordered_entries) - 1:
            next_entry = ordered_entries[idx + 1]
            next_notes_block = ""
            if next_entry.notes and next_entry.notes.strip():
                next_notes_block = f"\nNotes (observation): {next_entry.notes.strip()}"
            action_text = (
                f"\n--- Between step {entry.step} and step {next_entry.step} ---\n"
                f"Action before step {next_entry.step} screenshot: {next_entry.user_action}\n"
                f"Seconds since app launch: {next_entry.seconds_since_launch}\n"
                f"{next_notes_block}\n"
            )
            parts.append(types.Part.from_text(text=action_text))
    return parts


def _call_gemini_json_only(
    *,
    api_key: str,
    model: str,
    system_instruction: str,
    parts: List[types.Part],
) -> Tuple[Dict[str, Any], str]:
    client = genai.Client(api_key=api_key)

    response = client.models.generate_content(
        model=model,
        contents=[types.Content(parts=parts, role="user")],
        config=types.GenerateContentConfig(
            system_instruction=system_instruction,
            temperature=0.2,
            max_output_tokens=1500,
            response_mime_type="application/json",
        ),
    )

    raw_text = getattr(response, "text", None) or str(response)
    parsed: Dict[str, Any]
    if hasattr(response, "parsed") and isinstance(getattr(response, "parsed"), dict):
        parsed = response.parsed  # SDK-parsed JSON when response_mime_type is application/json
    else:
        try:
            parsed = _extract_json_object(raw_text)
        except Exception as e:
            # Keep the run alive even if the model doesn't strictly comply with JSON-only output.
            parsed = {
                "violation_detected": False,
                "violation_types": [],
                "severity": "low",
                "reasoning": f"JSON parse failed: {e.__class__.__name__}. See raw_response.",
            }
    return parsed, raw_text


def _normalize_parsed_output(model_output: Dict[str, Any]) -> Dict[str, Any]:
    # Be forgiving about field types.
    violation_detected = bool(model_output.get("violation_detected", False))
    violation_types = model_output.get("violation_types", []) or []
    if not isinstance(violation_types, list):
        violation_types = [str(violation_types)]

    severity = str(model_output.get("severity", "low")).lower()
    if severity not in ("low", "medium", "high"):
        severity = "low"

    reasoning = str(model_output.get("reasoning", model_output.get("explanation", ""))).strip()

    # If model forgot to set violation_detected=false, but types are empty, reconcile.
    if not violation_types:
        violation_detected = False

    return {
        "violation_detected": violation_detected,
        "violation_types": violation_types,
        "severity": severity,
        "reasoning": reasoning,
    }


def evaluate_baseline(
    *,
    api_key: str,
    model: str,
    app_name: str,
    package_name: str,
    screenshot: ScreenshotEntry,
    screenshots_dir: str,
    fallback_assets_dir: Optional[str],
) -> Dict[str, Any]:
    image_bytes, mime_type = _load_image_bytes_from_entry(
        screenshots_dir=screenshots_dir,
        fallback_assets_dir=fallback_assets_dir,
        filename=screenshot.filename,
        image_base64=screenshot.image_base64,
        image_mime_type=screenshot.image_mime_type,
    )

    user_text = _build_prompt_baseline(app_name, package_name, screenshot.filename or "uploaded_image")
    parts = _screenshot_parts_for_baseline(user_text, image_bytes, mime_type)
    parsed, raw_text = _call_gemini_json_only(
        api_key=api_key,
        model=model,
        system_instruction=SYSTEM_PROMPT,
        parts=parts,
    )
    normalized = _normalize_parsed_output(parsed)

    return {
        "condition": "baseline",
        "app_name": app_name,
        "screenshots_used": [screenshot.filename or "uploaded_image"],
        "model": model,
        **normalized,
        "raw_response": raw_text,
    }


def evaluate_context(
    *,
    api_key: str,
    model: str,
    app_name: str,
    package_name: str,
    screenshot: ScreenshotEntry,
    screenshots_dir: str,
    fallback_assets_dir: Optional[str],
) -> Dict[str, Any]:
    image_bytes, mime_type = _load_image_bytes_from_entry(
        screenshots_dir=screenshots_dir,
        fallback_assets_dir=fallback_assets_dir,
        filename=screenshot.filename,
        image_base64=screenshot.image_base64,
        image_mime_type=screenshot.image_mime_type,
    )

    user_text = _build_prompt_context(
        app_name=app_name,
        package_name=package_name,
        step=screenshot.step,
        seconds_since_launch=screenshot.seconds_since_launch,
        user_action=screenshot.user_action,
        notes=screenshot.notes,
        screenshot_filename=screenshot.filename or "uploaded_image",
    )

    parts = _screenshot_parts_for_context(user_text, image_bytes, mime_type)
    parsed, raw_text = _call_gemini_json_only(
        api_key=api_key,
        model=model,
        system_instruction=SYSTEM_PROMPT,
        parts=parts,
    )
    normalized = _normalize_parsed_output(parsed)

    return {
        "condition": "context",
        "app_name": app_name,
        "screenshots_used": [screenshot.filename or "uploaded_image"],
        "model": model,
        **normalized,
        "raw_response": raw_text,
    }


def evaluate_trajectory(
    *,
    api_key: str,
    model: str,
    app_name: str,
    package_name: str,
    ordered_screenshots: Sequence[ScreenshotEntry],
    screenshots_dir: str,
    fallback_assets_dir: Optional[str],
) -> Dict[str, Any]:
    image_bytes_list: List[bytes] = []
    mime_types_list: List[str] = []
    for screenshot in ordered_screenshots:
        image_bytes, mime_type = _load_image_bytes_from_entry(
            screenshots_dir=screenshots_dir,
            fallback_assets_dir=fallback_assets_dir,
            filename=screenshot.filename,
            image_base64=screenshot.image_base64,
            image_mime_type=screenshot.image_mime_type,
        )
        image_bytes_list.append(image_bytes)
        mime_types_list.append(mime_type)

    intro_text = _build_prompt_trajectory_intro(app_name, package_name)
    parts = _screenshot_parts_for_trajectory(
        intro_text=intro_text,
        ordered_entries=ordered_screenshots,
        image_bytes_list=image_bytes_list,
        mime_types_list=mime_types_list,
    )

    parsed, raw_text = _call_gemini_json_only(
        api_key=api_key,
        model=model,
        system_instruction=SYSTEM_PROMPT,
        parts=parts,
    )
    normalized = _normalize_parsed_output(parsed)

    screenshots_used = [s.filename or "uploaded_image" for s in ordered_screenshots]

    return {
        "condition": "trajectory",
        "app_name": app_name,
        "screenshots_used": screenshots_used,
        "model": model,
        **normalized,
        "raw_response": raw_text,
    }


def evaluate_batch(
    *,
    apps: Sequence[Dict[str, Any]],
    condition: str,
    model: str,
    screenshots_dir: str,
    fallback_assets_dir: Optional[str],
    api_key: Optional[str] = None,
) -> List[Dict[str, Any]]:
    if not api_key:
        load_dotenv()
        api_key = os.getenv("GEMINI_API_KEY", "")

    if not api_key:
        raise ValueError("Missing GEMINI_API_KEY. Put it in .env or pass api_key.")

    conditions: List[str]
    if condition == "all":
        conditions = ["baseline", "context", "trajectory"]
    else:
        conditions = [condition]

    results: List[Dict[str, Any]] = []

    for cond in conditions:
        for app in apps:
            app_name = str(app.get("app_name", "unknown_app"))
            package_name = str(app.get("package_name", "unknown"))
            screenshots_in = app.get("screenshots", []) or []

            # Normalize to ScreenshotEntry objects.
            screenshots: List[ScreenshotEntry] = []
            for s in screenshots_in:
                screenshots.append(
                    ScreenshotEntry(
                        filename=s.get("filename"),
                        image_base64=s.get("image_base64"),
                        image_mime_type=s.get("image_mime_type"),
                        step=_safe_int(s.get("step"), 0),
                        seconds_since_launch=_safe_int(s.get("seconds_since_launch"), 0),
                        user_action=str(s.get("user_action", "")),
                        notes=s.get("notes"),
                    )
                )

            if cond == "baseline":
                for screenshot in screenshots:
                    results.append(
                        evaluate_baseline(
                            api_key=api_key,
                            model=model,
                            app_name=app_name,
                            package_name=package_name,
                            screenshot=screenshot,
                            screenshots_dir=screenshots_dir,
                            fallback_assets_dir=fallback_assets_dir,
                        )
                    )
            elif cond == "context":
                for screenshot in screenshots:
                    results.append(
                        evaluate_context(
                            api_key=api_key,
                            model=model,
                            app_name=app_name,
                            package_name=package_name,
                            screenshot=screenshot,
                            screenshots_dir=screenshots_dir,
                            fallback_assets_dir=fallback_assets_dir,
                        )
                    )
            elif cond == "trajectory":
                ordered = sorted(screenshots, key=lambda x: x.step)
                results.append(
                    evaluate_trajectory(
                        api_key=api_key,
                        model=model,
                        app_name=app_name,
                        package_name=package_name,
                        ordered_screenshots=ordered,
                        screenshots_dir=screenshots_dir,
                        fallback_assets_dir=fallback_assets_dir,
                    )
                )
            else:
                raise ValueError(f"Unknown condition: {cond}")

    return results

