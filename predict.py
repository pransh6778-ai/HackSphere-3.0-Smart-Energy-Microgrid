"""
HackSphere 3.0 - Smart Microgrid demand forecast client (predict.py)

    predict(input_df) -> numpy array, predicted demand in kW, one value per input row

The model is the team's published Zoho Catalyst QuickML endpoint. The script
reaches it in this order (first one that works wins):

  1. DIRECT   - QuickML credentials are present in environment variables, so the
                published QuickML endpoint is called directly.
  2. API      - no credentials: the team's public forecast API (Catalyst AppSail)
                is called. It holds the QuickML credentials server-side and
                forwards the rows to the same published QuickML endpoint.
  3. FALLBACK - nothing reachable: a rough physics-style estimate is returned and
                a LOUD warning is printed. Set HS_STRICT=1 to raise instead.

Environment variables (all optional, nothing secret is stored in this file):
  HS_QML_URL         QuickML endpoint URL (defaults to the team's endpoint)
  HS_QML_KEY         QuickML endpoint key        (X-QUICKML-ENDPOINT-KEY)
  HS_ORG_ID          Catalyst org id             (CATALYST-ORG)
  HS_QML_ENV         Development | Production    (default Development)
  HS_OAUTH_URL       default https://accounts.zoho.in
  HS_CLIENT_ID, HS_CLIENT_SECRET, HS_REFRESH_TOKEN   Zoho OAuth self-client
  HS_ACCESS_TOKEN    optional ready-made access token (skips the refresh flow)
  HS_API_URL         public forecast API URL (defaults to the team's AppSail /predict)
  HS_STRICT          "1" = raise an error instead of using the fallback estimate

Usage:
  python predict.py --input sample_test_input.csv --output predictions.csv
"""

import argparse
import os
import sys
import time

import numpy as np
import pandas as pd
import requests

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
QUICKML_ENDPOINT_URL = os.environ.get(
    "HS_QML_URL",
    "https://api.catalyst.zoho.in/quickml/v1/project/101065000000013024/endpoints/predict",
)
API_URL = os.environ.get(
    "HS_API_URL",
    "https://microgrid-core-api-50047212280.development.catalystappsail.in/predict",
)
OAUTH_URL = os.environ.get("HS_OAUTH_URL", "https://accounts.zoho.in")

FEATURES = ["ambient_temp_c", "humidity_pct", "solar_irradiance_wm2"]
DEFAULTS = {"ambient_temp_c": 25.0, "humidity_pct": 50.0, "solar_irradiance_wm2": 0.0}
CHUNK = 100          # rows per request
TIMEOUT = 120        # seconds per request
TRIES = 3            # attempts per request


def _warn(msg):
    print("WARNING: " + msg, file=sys.stderr)


# ---------------------------------------------------------------------------
# Cleaning: build the exact feature rows the QuickML model was trained on
# (timestamp, 3 weather columns, and the engineered "hour" column)
# ---------------------------------------------------------------------------
def _clean(input_df):
    df = input_df.copy()
    ts = pd.to_datetime(df["timestamp"])
    df["timestamp"] = ts.dt.strftime("%Y-%m-%d %H:%M:%S")
    df["hour"] = ts.dt.hour.astype(int)
    for col in FEATURES:
        df[col] = pd.to_numeric(df[col], errors="coerce")
        df[col] = df[col].replace([np.inf, -np.inf], np.nan)
        if df[col].isna().all():
            df[col] = DEFAULTS[col]
        else:
            df[col] = df[col].ffill().bfill()
    return df[["timestamp"] + FEATURES + ["hour"]].reset_index(drop=True)


def _post(url, body, headers=None, data=None):
    """POST with retries on connection errors and HTTP 5xx. Returns parsed JSON."""
    last = None
    for attempt in range(TRIES):
        try:
            if data is not None:
                resp = requests.post(url, data=data, headers=headers, timeout=TIMEOUT)
            else:
                resp = requests.post(url, json=body, headers=headers, timeout=TIMEOUT)
        except requests.RequestException as exc:
            last = exc
        else:
            if resp.ok:
                return resp.json()
            if resp.status_code < 500:
                raise RuntimeError("HTTP %s from %s: %s" % (resp.status_code, url, resp.text[:300]))
            last = RuntimeError("HTTP %s: %s" % (resp.status_code, resp.text[:300]))
        if attempt < TRIES - 1:
            time.sleep(2 * (attempt + 1))
    raise RuntimeError("request to %s failed after %d tries: %s" % (url, TRIES, last))


# ---------------------------------------------------------------------------
# Route 1: direct QuickML call
# ---------------------------------------------------------------------------
def _have_direct_credentials():
    if not (os.environ.get("HS_QML_KEY") and os.environ.get("HS_ORG_ID")):
        return False
    if os.environ.get("HS_ACCESS_TOKEN"):
        return True
    return all(os.environ.get(k) for k in ("HS_CLIENT_ID", "HS_CLIENT_SECRET", "HS_REFRESH_TOKEN"))


def _access_token():
    token = os.environ.get("HS_ACCESS_TOKEN")
    if token:
        return token
    reply = _post(
        OAUTH_URL + "/oauth/v2/token",
        None,
        data={
            "grant_type": "refresh_token",
            "client_id": os.environ["HS_CLIENT_ID"],
            "client_secret": os.environ["HS_CLIENT_SECRET"],
            "refresh_token": os.environ["HS_REFRESH_TOKEN"],
        },
    )
    if "access_token" not in reply:
        raise RuntimeError("OAuth refresh failed: %s" % str(reply)[:200])
    return reply["access_token"]


def _direct(df):
    headers = {
        "Content-Type": "application/json",
        "X-QUICKML-ENDPOINT-KEY": os.environ["HS_QML_KEY"],
        "Authorization": "Zoho-oauthtoken " + _access_token(),
        "CATALYST-ORG": os.environ["HS_ORG_ID"],
        "Environment": os.environ.get("HS_QML_ENV", "Development"),
    }
    out = []
    for start in range(0, len(df), CHUNK):
        rows = df.iloc[start:start + CHUNK].to_dict(orient="records")
        reply = _post(QUICKML_ENDPOINT_URL, {"data": rows}, headers=headers)
        result = reply.get("result")
        if not isinstance(result, list) or len(result) != len(rows):
            raise RuntimeError("unexpected QuickML reply: %s" % str(reply)[:200])
        out.extend(float(v) for v in result)
    return np.array(out, dtype=float)


# ---------------------------------------------------------------------------
# Route 2: the team's public forecast API (AppSail)
# ---------------------------------------------------------------------------
def _via_api(df):
    out = []
    for start in range(0, len(df), CHUNK):
        rows = df.iloc[start:start + CHUNK].to_dict(orient="records")
        reply = _post(API_URL, {"rows": rows})
        forecast = reply.get("forecast")
        if reply.get("status") != "success" or not isinstance(forecast, list) or len(forecast) != len(rows):
            raise RuntimeError("unexpected API reply: %s" % str(reply)[:200])
        out.extend(float(item["predicted_demand_kw"]) for item in forecast)
    return np.array(out, dtype=float)


# ---------------------------------------------------------------------------
# Route 3: last-resort estimate (only used when the model cannot be reached)
# ---------------------------------------------------------------------------
def _fallback(df):
    hours = df["hour"].values
    base_load = 120.0 + 30.0 * np.sin(2 * np.pi * (hours - 6) / 24)
    cooling_load = np.maximum(0.0, df["ambient_temp_c"].values - 24.0) * 8.5
    return np.array(base_load + cooling_load, dtype=float)


# ---------------------------------------------------------------------------
# Public contract
# ---------------------------------------------------------------------------
def predict(input_df: pd.DataFrame):
    """Predict demand (kW) for each row.

    Parameters
    ----------
    input_df : pandas.DataFrame with columns
        ['timestamp', 'ambient_temp_c', 'humidity_pct', 'solar_irradiance_wm2']

    Returns
    -------
    numpy.ndarray of float, same length and order as input_df
    """
    df = _clean(input_df)
    if df.empty:
        return np.array([], dtype=float)

    routes = []
    if _have_direct_credentials():
        routes.append(("QuickML direct", _direct))
    if API_URL:
        routes.append(("forecast API", _via_api))

    failures = []
    for name, fn in routes:
        try:
            preds = fn(df)
            if len(preds) != len(df) or not np.isfinite(preds).all():
                raise RuntimeError("bad predictions (wrong length or NaN/inf)")
            return preds
        except Exception as exc:  # try the next route
            failures.append("%s: %s" % (name, exc))
            _warn("%s failed (%s)" % (name, exc))

    if os.environ.get("HS_STRICT") == "1":
        raise RuntimeError("no model route worked: " + " | ".join(failures))

    _warn("*" * 66)
    _warn("MODEL NOT REACHED - returning a rough FALLBACK ESTIMATE, not the QuickML model!")
    _warn("Fix the errors above (or set HS_STRICT=1 to make this a hard error).")
    _warn("*" * 66)
    return _fallback(df)


def main():
    parser = argparse.ArgumentParser(description="HackSphere 3.0 demand forecast")
    parser.add_argument("--input", default="sample_test_input.csv", help="input CSV")
    parser.add_argument("--output", default="predictions.csv", help="output CSV")
    args = parser.parse_args()

    print("Running predict.py on %s ..." % args.input)
    df = pd.read_csv(args.input)
    preds = predict(df)

    out = pd.DataFrame({"timestamp": df["timestamp"], "target_demand_kw": np.round(preds, 4)})
    out.to_csv(args.output, index=False)
    print("Generated %d predictions -> %s. First 5 samples:" % (len(preds), args.output))
    print(out.head(5).to_string(index=False))


if __name__ == "__main__":
    main()