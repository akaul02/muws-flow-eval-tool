import argparse
import json
import os
from typing import Any, Dict, List

from dotenv import load_dotenv

from muws_eval.evaluator import evaluate_batch


DEFAULT_MODEL = "gemini-2.5-flash"


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate Android screenshots for MUwS violations using Gemini vision.")
    parser.add_argument("--screenshots-dir", default="./screenshots", help="Folder containing screenshot PNGs.")
    parser.add_argument("--input-json", required=True, help="Path to input metadata JSON.")
    parser.add_argument("--output-json", required=True, help="Path to output results JSON.")
    parser.add_argument(
        "--condition",
        default="all",
        choices=["baseline", "context", "trajectory", "all"],
        help="Which condition(s) to run.",
    )
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Gemini model name.")
    parser.add_argument(
        "--fallback-assets-dir",
        default=os.path.expanduser("~/.cursor/projects/Users-arykaul-dev-vlm/assets"),
        help="Optional fallback folder for this workspace environment.",
    )
    args = parser.parse_args()

    load_dotenv()
    with open(args.input_json, "r", encoding="utf-8") as f:
        input_data: Dict[str, Any] = json.load(f)

    apps = input_data.get("apps", input_data.get("data", input_data))
    if not isinstance(apps, list):
        raise ValueError("Input JSON must include top-level key 'apps' (list).")

    # apps is list of app objects; evaluator expects that.
    results = evaluate_batch(
        apps=apps,
        condition=args.condition,
        model=args.model,
        screenshots_dir=os.path.abspath(args.screenshots_dir),
        fallback_assets_dir=os.path.abspath(args.fallback_assets_dir) if args.fallback_assets_dir else None,
    )

    with open(args.output_json, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)

    print(f"Wrote {len(results)} evaluation records to {args.output_json}")


if __name__ == "__main__":
    main()

