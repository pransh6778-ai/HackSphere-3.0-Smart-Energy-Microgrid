/* Deployment settings. Edit this file, not main.js. */
window.MICROGRID_CONFIG = {
  // 'auto'    : try AppSail backend -> QuickML endpoint -> local estimate
  // 'appsail' : AppSail backend only | 'quickml': QuickML only | 'local': offline demo
  API_MODE: 'auto',
  // Catalyst AppSail (Flask) backend. Must match your routes: POST {APPSAIL_BASE}{FORECAST_PATH}
  // with multipart field "file" (CSV). Expected reply: [{timestamp, predicted_demand_kw, grid_mode, critical_alert}, ...]
  APPSAIL_BASE: 'https://microgrid-core-api-50047212280.development.catalystappsail.in',
  FORECAST_PATH: '/forecast',
  // Direct QuickML call. The X-QUICKML-ENDPOINT-KEY must stay on the backend, never in this file.
  QUICKML_ENDPOINT: 'https://api.catalyst.zoho.in/quickml/v1/project/101065000000013024/endpoints/predict',
  REQUEST_TIMEOUT_MS: 8000,
  // Only for the direct QuickML call: add hour, day_of_week, month, hour_sin/cos and lag features.
  // Must match the features used when the model was trained (see buildFeatures in main.js).
  SEND_ENGINEERED_FEATURES: false,
  DEFAULT_DATE: '2024-01-01',
  THRESHOLDS: { overloadKw: 200, storageKw: 160, peakStart: 18, peakEnd: 22 },
  // Simulated battery used for the state-of-charge display
  BATTERY: { capacityKwh: 600, startPct: 85, minPct: 10, dischargeShare: 0.4, chargeKwh: 45 }
};
