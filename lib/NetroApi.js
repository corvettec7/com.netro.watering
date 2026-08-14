'use strict';

/**
 * NetroApi — thin client for the Netro Public API (NPA) v2.
 * Client léger pour l'API publique Netro (NPA) v2.
 *
 * Docs: https://www.netrohome.com/en/shop/user_guides/7
 *
 * Rate limit / Limite de débit : 2000 calls per day per device (reset midnight UTC).
 *   -> watch meta.token_remaining / surveiller meta.token_remaining
 */

const BASE_URL = 'https://api.netrohome.com/npa/v2';

// Netro error codes / Codes d'erreur Netro
// 1 = invalid key / clé invalide
// 3 = rate limit exceeded / quota dépassé
// 4 = invalid device or sensor / device ou capteur invalide
// 5 = internal error / erreur interne
// 6 = parameter error / paramètre invalide
class NetroApiError extends Error {
  constructor(code, message) {
    super(message || `Netro API error ${code}`);
    this.name = 'NetroApiError';
    this.code = code;
  }
}

class NetroApi {
  /**
   * @param {string}   key            Netro API key (32 chars) / clé API Netro
   * @param {object}   [opts]
   * @param {string}   [opts.baseUrl] override base URL (e.g. v1)
   * @param {function} [opts.log]     logger(message, meta) — called on every call / appelé à chaque appel
   * @param {function} [opts.fetchImpl]
   */
  constructor(key, { baseUrl = BASE_URL, log, fetchImpl } = {}) {
    this.key = key;
    this.baseUrl = baseUrl;
    this.log = typeof log === 'function' ? log : () => {};
    // Homey Pro (Node 18+) exposes global fetch / expose fetch globalement
    this.fetch = fetchImpl || global.fetch;
  }

  // Masque la clé dans les logs / mask the key in logs
  get _maskedKey() {
    if (!this.key) return '(none)';
    return `${this.key.slice(0, 4)}…${this.key.slice(-2)}`;
  }

  async _get(endpoint, params = {}) {
    const url = new URL(`${this.baseUrl}/${endpoint}`);
    url.searchParams.set('key', this.key);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, Array.isArray(v) ? JSON.stringify(v) : String(v));
    }
    return this._request('GET', endpoint, () => this.fetch(url.toString()));
  }

  async _post(endpoint, body = {}) {
    return this._request('POST', endpoint, () => this.fetch(`${this.baseUrl}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ key: this.key, ...body }),
    }));
  }

  async _request(method, endpoint, doFetch) {
    const started = Date.now();
    try {
      const res = await doFetch();
      const json = await res.json();
      const ms = Date.now() - started;

      if (json.status !== 'OK') {
        const err = (json.errors && json.errors[0]) || {};
        this.log(`[Netro] ${method} ${endpoint} -> ERROR ${err.code} (${err.message}) [${ms}ms] key=${this._maskedKey}`);
        throw new NetroApiError(err.code, err.message);
      }

      const remaining = json.meta && json.meta.token_remaining;
      this.log(`[Netro] ${method} ${endpoint} -> OK [${ms}ms] tokens_left=${remaining}`);
      return { data: json.data, meta: json.meta };
    } catch (err) {
      if (err instanceof NetroApiError) throw err;
      // network / parse error
      this.log(`[Netro] ${method} ${endpoint} -> NETWORK/PARSE ERROR: ${err.message}`);
      throw err;
    }
  }

  // ---- Read / Lecture ----

  /** Basic device info incl. status & zones / infos device (statut + zones) */
  info() {
    return this._get('info.json');
  }

  /** Watering schedules / planning d'arrosage */
  schedules(params = {}) {
    return this._get('schedules.json', params);
  }

  /** Device events (offline/online/schedule) / évènements device */
  events(params = {}) {
    return this._get('events.json', params);
  }

  /** Per-zone moisture history / historique d'humidité par zone */
  moistures(params = {}) {
    return this._get('moistures.json', params);
  }

  /**
   * Sensor readings (Whisperer) — array of hourly records.
   * Relevés capteur (Whisperer) — tableau de relevés horaires.
   * Note: the sensor has its OWN API key, distinct from a controller.
   * Le capteur a sa PROPRE clé API, distincte d'un contrôleur.
   */
  sensorData(params = {}) {
    return this._get('sensor_data.json', params);
  }

  // ---- Actions ----

  /**
   * Start watering / Démarrer un arrosage.
   * @param {number[]} [zones]     zone indexes (all if omitted) / index de zones
   * @param {number}   duration    minutes
   * @param {number}   [delay]     start after N minutes / démarrage différé
   * @param {string}   [startTime] UTC "YYYY-MM-DD HH:mm" (overrides delay)
   */
  water({ zones, duration, delay, startTime } = {}) {
    return this._post('water.json', { zones, duration, delay, start_time: startTime });
  }

  /** Stop current & pending manual watering / arrêter l'arrosage en cours */
  stopWater() {
    return this._post('stop_water.json');
  }

  /** Skip watering for N days / ne pas arroser pendant N jours */
  noWater(days = 1) {
    return this._post('no_water.json', { days });
  }

  /** enabled=true -> ONLINE, false -> STANDBY */
  setStatus(enabled) {
    return this._post('set_status.json', { status: enabled ? 1 : 0 });
  }

  /**
   * Override the smart moisture estimate / forcer l'humidité estimée.
   * @param {number}   moisture  0..100
   * @param {number[]} [zones]   all zones if omitted / toutes si omis
   */
  setMoisture({ moisture, zones } = {}) {
    return this._post('set_moisture.json', { moisture, zones });
  }
}

module.exports = { NetroApi, NetroApiError, BASE_URL };
