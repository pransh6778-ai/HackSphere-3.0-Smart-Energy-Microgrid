import requests, json
URL = "https://microgrid-core-api-50047212280.development.catalystappsail.in/predict"
rows = [{"timestamp": "2024-01-01 %02d:00:00" % h, "ambient_temp_c": 20 + h * 0.3,
         "humidity_pct": 60, "solar_irradiance_wm2": max(0, (h - 6) * 60) if h < 18 else 0}
        for h in range(24)]
r = requests.post(URL, json={"rows": rows})
print(r.status_code)
print(json.dumps(r.json(), indent=2)[:3000])