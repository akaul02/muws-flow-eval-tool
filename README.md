# MUwS Screenshot Evaluator

Prototype tool for detecting Google Mobile Unwanted Software (MUwS) issues in Android apps using Gemini 2.5 Flash (vision).

Policy: https://developers.google.com/android/play-protect/mobile-unwanted-software

## What this does

Takes Android app screenshots and checks for:
- disruptive ads
- unauthorized system imitation
- aggressive upselling tied to ad abuse

It runs 3 conditions on the same screenshots:
- **Baseline**: one screenshot, no context
- **Context**: one screenshot + metadata (app name, step, seconds since launch, user action, notes)
- **Trajectory**: full ordered flow for one app

## Why this matters

Flow-level problems can be invisible in single screenshots, like:
- lots of full-screen ads before the user does anything
- an ad that interrupts usage, then a paywall to remove ads
- result screens where the ad dominates the content

## What is in this repo

- `evaluate.py`: CLI runner
- `server/main.py`: local FastAPI backend and web UI
- `metadata.json`: example trajectories for the test set
- `results.json`: generated output (not committed)

## Test set

13 screenshots from 4 apps:
- Flashlight App 1: remove-ads popup on launch
- QR Scanner: ad on launch, remove-ads upsell, big TikTok ad on result screen
- Phone Cleaner: repeated full-screen ads, then subscription wall
- Flashlight App 2: full-screen ad interrupt, then remove-ads upsell

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
# put GEMINI_API_KEY=... in .env
```

## Usage

CLI:

```bash
.venv/bin/python evaluate.py --screenshots-dir ./screenshots --input-json metadata.json --output-json results.json --condition all
```

Run one condition:

```bash
.venv/bin/python evaluate.py --screenshots-dir ./screenshots --input-json metadata.json --output-json results.json --condition trajectory
```

Web UI:

```bash
.venv/bin/uvicorn server.main:app --reload --port 8000
```

Open `http://127.0.0.1:8000`.

## Related work

- DPGuard (WWW '25): https://github.com/GalaxyHBXY/DPGuard
- AdsDP (IMWUT '25): https://zenodo.org/records/15316373
- DECEPTICON (arXiv 2512.22894)
- A2 (arXiv 2508.21579)

