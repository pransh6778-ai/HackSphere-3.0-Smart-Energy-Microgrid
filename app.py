import os, io, csv, json, math, time, statistics
import urllib.request, urllib.parse, urllib.error
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor
from flask import Flask, request, jsonify, make_response

app = Flask(__name__)

# ---------- Configuration (Environment Variables) ----------
QUICKML_URL = os.environ.get("HS_QML_URL", "https://api.catalyst.zoho.in/quickml/v1/project/101065000000013024/endpoints/predict")
QUICKML_ENDPOINT_KEY = os.environ.get("HS_QML_KEY", "05a1779fdf5c405ac58c27792e3d504a5b530c9187a27970e23d8eae62bb5d5ffe4359077f105b8ef8bfb88e6deb3fb8")
CATALYST_ORG = os.environ.get("HS_ORG_ID", "60093523249")
QUICKML_ENV = os.environ.get("HS_QML_ENV", "Development")
ACCOUNTS_URL = os.environ.get("HS_OAUTH_URL", "https://accounts.zoho.in")
CLIENT_ID = os.environ.get("HS_CLIENT_ID", "1000.4AT7UGYZWFSAOB7PBYIOMEY1KFOZER")
CLIENT_SECRET = os.environ.get("HS_CLIENT_SECRET", "56af6de5483174d246b58efeea5fc77628b0931442")
REFRESH_TOKEN = os.environ.get("HS_REFRESH_TOKEN", "1000.ee4dcb2e05e2e6433741f51568b17eb9.3409097a523db72807620a16514bce17")
STATIC_TOKEN = os.environ.get("HS_ACCESS_TOKEN", "")

BATTERY_CAPACITY_KWH = float(os.environ.get("BATTERY_CAPACITY_KWH", "600"))
BATTERY_START_SOC = float(os.environ.get("BATTERY_START_SOC", "85"))
BATTERY_CHARGE_KW = float(os.environ.get("BATTERY_CHARGE_KW", "45"))

FEATURES = ["ambient_temp_c", "humidity_pct", "solar_irradiance_wm2"]
DEFAULTS = {"ambient_temp_c": 25.0, "humidity_pct": 50.0, "solar_irradiance_wm2": 0.0}
LIMITS = {
    "ambient_temp_c": (-30.0, 60.0),
    "humidity_pct": (0.0, 100.0),
    "solar_irradiance_wm2": (0.0, 1500.0)
}

_token = {"value": None, "exp": 0.0}


# ---------- Bulletproof Global CORS Handlers ----------
@app.before_request
def handle_preflight():
    if request.method == "OPTIONS":
        origin = request.headers.get("Origin") or "*"
        resp = make_response("", 204)
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Access-Control-Allow-Credentials"] = "true"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS, PUT, DELETE"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-Requested-With, Accept, Origin, Cache-Control"
        resp.headers["Access-Control-Max-Age"] = "86400"
        return resp


@app.after_request
def add_cors(resp):
    origin = request.headers.get("Origin") or "*"
    resp.headers["Access-Control-Allow-Origin"] = origin
    resp.headers["Access-Control-Allow-Credentials"] = "true"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS, PUT, DELETE"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-Requested-With, Accept, Origin, Cache-Control"
    resp.headers["Access-Control-Expose-Headers"] = "*"
    return resp


@app.errorhandler(Exception)
def handle_exception(e):
    origin = request.headers.get("Origin") or "*"
    resp = jsonify({"status": "failure", "error": str(e)})
    resp.status_code = 500
    resp.headers["Access-Control-Allow-Origin"] = origin
    resp.headers["Access-Control-Allow-Credentials"] = "true"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-Requested-With, Accept, Origin"
    return resp


# ---------- QuickML Access & Token Management ----------
def get_access_token():
    if STATIC_TOKEN:
        return STATIC_TOKEN
    if _token["value"] and time.time() < _token["exp"]:
        return _token["value"]
    if not (CLIENT_ID and CLIENT_SECRET and REFRESH_TOKEN):
        return None
    try:
        body = urllib.parse.urlencode({
            "grant_type": "refresh_token",
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET,
            "refresh_token": REFRESH_TOKEN
        }).encode()
        req = urllib.request.Request(ACCOUNTS_URL + "/oauth/v2/token", data=body, method="POST")
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode())
        if "access_token" in data:
            _token["value"] = data["access_token"]
            _token["exp"] = time.time() + int(data.get("expires_in", 3600)) - 120
            return _token["value"]
    except Exception as e:
        print(f"Warning: OAuth token refresh failed: {e}")
    return None


def build_payload(c):
    p = {"timestamp": c["timestamp"].strftime("%Y-%m-%d %H:%M:%S")}
    for f in FEATURES:
        p[f] = c[f]
    p["hour"] = c["timestamp"].hour
    return p


def call_quickml(payload, token):
    rows = payload if isinstance(payload, list) else [payload]
    headers = {
        "Content-Type": "application/json",
        "X-QUICKML-ENDPOINT-KEY": QUICKML_ENDPOINT_KEY,
        "Authorization": "Zoho-oauthtoken " + token,
        "CATALYST-ORG": CATALYST_ORG,
        "Environment": QUICKML_ENV
    }
    req = urllib.request.Request(QUICKML_URL, data=json.dumps({"data": rows}).encode(),
                                 headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def extract_number(obj):
    if isinstance(obj, bool):
        return None
    if isinstance(obj, (int, float)):
        return float(obj)
    if isinstance(obj, str):
        try:
            return float(obj)
        except ValueError:
            return None
    if isinstance(obj, dict):
        for k in ("target_demand_kw", "predicted_demand_kw", "prediction", "predictions", "result", "output", "data"):
            if k in obj:
                n = extract_number(obj[k])
                if n is not None:
                    return n
        for v in obj.values():
            n = extract_number(v)
            if n is not None:
                return n
    if isinstance(obj, list):
        for v in obj:
            n = extract_number(v)
            if n is not None:
                return n
    return None


def extract_list(raw):
    if isinstance(raw, dict) and isinstance(raw.get("result"), list):
        out = []
        for v in raw["result"]:
            n = extract_number(v)
            if n is None:
                return None
            out.append(n)
        return out
    return None


# ---------- Data Cleaning ----------
def parse_ts(v):
    s = str(v).strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M",
                "%Y-%m-%dT%H:%M", "%d-%m-%Y %H:%M:%S", "%d/%m/%Y %H:%M"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            pass
    raise ValueError(f"Invalid timestamp: {v}")


def to_float(v):
    if v is None:
        return None
    try:
        f = float(str(v).strip())
    except ValueError:
        return None
    return None if (math.isnan(f) or math.isinf(f)) else f


def clean_rows(rows):
    if not isinstance(rows, list) or not rows:
        raise ValueError("Provide a non-empty list of rows.")
    cleaned, errors = [], []
    for i, r in enumerate(rows):
        if not isinstance(r, dict):
            errors.append(f"row {i} is not an object")
            continue
        try:
            ts = parse_ts(r.get("timestamp"))
        except ValueError:
            errors.append(f"row {i}: invalid timestamp {r.get('timestamp')!r}")
            continue
        item = {"timestamp": ts, "warnings": []}
        for f in FEATURES:
            item[f] = to_float(r.get(f))
        cleaned.append(item)
    if errors:
        raise ValueError("; ".join(errors[:5]))

    for f in FEATURES:
        orig = [c[f] for c in cleaned]
        valid = [v for v in orig if v is not None]
        fallback = statistics.median(valid) if valid else DEFAULTS[f]
        lo, hi = LIMITS[f]
        for i, c in enumerate(cleaned):
            if orig[i] is None:
                prev = next((orig[j] for j in range(i - 1, -1, -1) if orig[j] is not None), None)
                nxt = next((orig[j] for j in range(i + 1, len(orig)) if orig[j] is not None), None)
                c[f] = prev if prev is not None else (nxt if nxt is not None else fallback)
                c["warnings"].append(f"{f} missing, filled")
            if c[f] < lo or c[f] > hi:
                c[f] = min(max(c[f], lo), hi)
                c["warnings"].append(f"{f} out of range, clipped")
    return cleaned


# ---------- Fallback Physics-based Predictor ----------
def fallback_predict(cleaned):
    out = []
    for c in cleaned:
        hour = c["timestamp"].hour
        base_load = 120.0 + 30.0 * math.sin(2 * math.pi * (hour - 6) / 24)
        temp = c["ambient_temp_c"] if c["ambient_temp_c"] is not None else 25.0
        cooling_load = max(0.0, temp - 24.0) * 8.5
        out.append(round(base_load + cooling_load, 2))
    return out


# ---------- Forecasting & Smart Grid Transition Rules ----------
def predict_all(cleaned):
    token = get_access_token()
    if token and QUICKML_ENDPOINT_KEY:
        try:
            payloads = [build_payload(c) for c in cleaned]
            vals = extract_list(call_quickml(payloads, token))
            if vals is not None and len(vals) == len(payloads):
                return vals
        except Exception as e:
            print(f"QuickML batch call failed: {e}, attempting single-row fallback...")
            try:
                def one(pl):
                    raw = call_quickml(pl, token)
                    n = extract_number(raw)
                    if n is None:
                        raise RuntimeError(f"No number found in QuickML response: {str(raw)[:200]}")
                    return n
                with ThreadPoolExecutor(max_workers=4) as ex:
                    return list(ex.map(one, payloads))
            except Exception as e2:
                print(f"QuickML single call failed: {e2}, using physical fallback estimate.")

    # Graceful fallback: physics-based demand estimation
    return fallback_predict(cleaned)


def apply_grid_rules(preds, cleaned):
    cap = BATTERY_CAPACITY_KWH
    soc = cap * BATTERY_START_SOC / 100.0
    out = []
    for p, c in zip(preds, cleaned):
        hour = c["timestamp"].hour
        in_window = 18 <= hour <= 22
        renewable = (p > 160.0) or in_window
        overload = (p >= 200.0)

        # Smart battery dispatch logic
        if renewable:
            soc = max(0.0, soc - p)
        else:
            soc = min(cap, soc + BATTERY_CHARGE_KW)

        mode_str = "Renewable Storage Mode" if renewable else "Main Grid Mode"
        out.append({
            "timestamp": c["timestamp"].strftime("%Y-%m-%d %H:%M:%S"),
            "ambient_temp_c": c["ambient_temp_c"],
            "humidity_pct": c["humidity_pct"],
            "solar_irradiance_wm2": c["solar_irradiance_wm2"],
            "predicted_demand_kw": round(float(p), 2),
            "target_demand_kw": round(float(p), 2),
            "grid_mode": mode_str,
            "mode": mode_str,
            "critical_alert": overload,
            "critical_overload": overload,
            "battery_soc_pct": round(100.0 * soc / cap, 1),
            "warnings": c["warnings"]
        })
    return out


def run_forecast(rows):
    cleaned = clean_rows(rows)
    preds = predict_all(cleaned)
    fc = apply_grid_rules(preds, cleaned)
    peak = max(fc, key=lambda r: r["predicted_demand_kw"])
    summary = {
        "hours": len(fc),
        "peak_demand_kw": peak["predicted_demand_kw"],
        "peak_time": peak["timestamp"],
        "renewable_hours": sum(1 for r in fc if r["grid_mode"].startswith("Renewable")),
        "overload_hours": sum(1 for r in fc if r["critical_overload"]),
        "min_battery_soc_pct": min(r["battery_soc_pct"] for r in fc)
    }
    return {
        "status": "success",
        "summary": summary,
        "forecast": fc,
        "results": fc
    }


def handle(fn):
    try:
        return jsonify(fn())
    except ValueError as e:
        return jsonify({"status": "failure", "error": str(e)}), 400
    except Exception as e:
        return jsonify({"status": "failure", "error": str(e)}), 500


# ---------- Routes ----------
@app.route("/", methods=["GET"])
def home():
    return jsonify({
        "status": "success",
        "message": "Microgrid Demand-Forecasting API is online and running on Catalyst Python 3.9",
        "quickml_configured": bool(QUICKML_URL and QUICKML_ENDPOINT_KEY and CATALYST_ORG and CLIENT_ID)
    })


@app.route("/predict", methods=["POST", "OPTIONS"])
def predict():
    if request.method == "OPTIONS":
        return handle_preflight()
    def go():
        # Handle JSON or raw text payloads
        data = request.get_json(force=True, silent=True)
        if not data and request.get_data():
            try:
                data = json.loads(request.get_data(as_text=True))
            except Exception:
                pass
        data = data or {}
        rows = data if isinstance(data, list) else data.get("rows", [])
        if not rows:
            raise ValueError("Missing 'rows' in JSON payload.")
        return run_forecast(rows)
    return handle(go)


@app.route("/predict-csv", methods=["POST", "OPTIONS"])
def predict_csv():
    if request.method == "OPTIONS":
        return handle_preflight()
    def go():
        if "file" in request.files:
            text = request.files["file"].read().decode("utf-8-sig")
        else:
            text = request.get_data(as_text=True)
        rows = list(csv.DictReader(io.StringIO(text)))
        return run_forecast(rows)
    return handle(go)


@app.route("/forecast", methods=["POST", "OPTIONS"])
def forecast():
    if request.method == "OPTIONS":
        return handle_preflight()
    def go():
        # Handle file upload from FormData
        if "file" in request.files:
            text = request.files["file"].read().decode("utf-8-sig")
            rows = list(csv.DictReader(io.StringIO(text)))
            return run_forecast(rows)

        # Handle raw CSV payload
        content_type = request.content_type or ""
        if "text/csv" in content_type:
            text = request.get_data(as_text=True)
            rows = list(csv.DictReader(io.StringIO(text)))
            return run_forecast(rows)

        # Handle JSON payload
        data = request.get_json(force=True, silent=True) or {}
        if isinstance(data, list):
            rows = data
        elif "rows" in data and isinstance(data["rows"], list):
            rows = data["rows"]
        elif "data" in data and isinstance(data["data"], list):
            rows = data["data"]
        else:
            # Fallback 24h sample generator for quick UI testing
            forecast_type = data.get("type", "standard")
            base_temp = 28.0 if forecast_type == "peak" else 21.0
            rows = [{
                "timestamp": f"2024-01-01 {h:02d}:00:00",
                "ambient_temp_c": round(base_temp + (5.0 if 12 <= h <= 16 else 0.0), 1),
                "humidity_pct": 55.0,
                "solar_irradiance_wm2": float(max(0, (h - 6) * 100) if 6 <= h <= 18 else 0)
            } for h in range(24)]

        return run_forecast(rows)
    return handle(go)


@app.route("/debug/quickml", methods=["GET"])
def debug_quickml():
    def go():
        sample = {
            "timestamp": "2024-01-01 12:00:00",
            "ambient_temp_c": 22.0,
            "humidity_pct": 55.0,
            "solar_irradiance_wm2": 600.0,
            "hour": 12
        }
        token = get_access_token()
        if not token:
            return {"status": "failure", "message": "Failed to get access token"}
        raw = call_quickml(sample, token)
        return {
            "status": "success",
            "sent": sample,
            "raw_response": raw,
            "parsed_number": extract_number(raw)
        }
    return handle(go)


if __name__ == "__main__":
    port = int(os.environ.get("X_ZOHO_CATALYST_LISTEN_PORT", 9000))
    app.run(host="0.0.0.0", port=port)
