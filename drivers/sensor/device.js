'use strict';

const Homey = require('homey');
const { NetroApi, NetroApiError } = require('../../lib/NetroApi');

function isoDate(daysAgo = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

class NetroSensorDevice extends Homey.Device {

  async onInit() {
    const apiKey = this.getStoreValue('apiKey');
    this.api = new NetroApi(apiKey, {
      log: (msg) => {
        if (this.getSetting('debug')) this.log(msg);
      },
    });

    this.log(`Sensor init: "${this.getName()}" (poll=${this.getSetting('poll_interval')}min)`);

    await this.poll().catch(this.error);
    this._startPolling();
  }

  _startPolling() {
    if (this.pollTimer) this.homey.clearInterval(this.pollTimer);
    const minutes = this.getSetting('poll_interval') || 30;
    this.pollTimer = this.homey.setInterval(
      () => this.poll().catch(this.error),
      minutes * 60 * 1000,
    );
    this.log(`Polling every ${minutes} min`);
  }

  async poll() {
    try {
      // Look back 2 days so there is always at least one reading.
      // On regarde 2 jours en arrière pour toujours avoir un relevé.
      const { data, meta } = await this.api.sensorData({ start_date: isoDate(2) });
      const readings = (data && data.sensor_data) || [];

      if (!readings.length) {
        this.log('No sensor readings in range / aucun relevé sur la période');
        return;
      }

      // Most recent reading by UTC time / relevé le plus récent
      const latest = readings.reduce((a, b) => (new Date(b.time) > new Date(a.time) ? b : a));

      await this._safeSet('measure_humidity', latest.moisture);
      await this._safeSet('measure_temperature', latest.celsius);
      // sunlight is in klux -> Homey expects lux / ensoleillement en klux -> lux
      if (typeof latest.sunlight === 'number') {
        await this._safeSet('measure_luminance', Math.round(latest.sunlight * 1000));
      }
      await this._safeSet('measure_battery', latest.battery_level);

      if (!this.getAvailable()) await this.setAvailable();

      if (meta && typeof meta.token_remaining === 'number' && meta.token_remaining < 50) {
        this.log(`WARNING: low Netro quota — ${meta.token_remaining} calls left`);
      }
    } catch (err) {
      if (err instanceof NetroApiError && err.code === 1) {
        this.error('Invalid sensor API key');
        await this.setUnavailable('Clé API capteur invalide / Invalid sensor API key');
      } else if (err instanceof NetroApiError && err.code === 3) {
        this.error('Netro daily quota exceeded / quota journalier dépassé');
      } else {
        this.error('poll() failed:', err.message);
      }
    }
  }

  async _safeSet(cap, value) {
    if (value === undefined || value === null) return;
    await this.setCapabilityValue(cap, value).catch((e) => this.error(`set ${cap}:`, e.message));
  }

  async onSettings({ changedKeys }) {
    if (changedKeys.includes('poll_interval')) this._startPolling();
  }

  async onDeleted() {
    if (this.pollTimer) this.homey.clearInterval(this.pollTimer);
    this.log('Sensor deleted, polling stopped');
  }

}

module.exports = NetroSensorDevice;
