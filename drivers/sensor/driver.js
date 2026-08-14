'use strict';

const Homey = require('homey');
const { NetroApi } = require('../../lib/NetroApi');

// yyyy-mm-dd for a date offset by `daysAgo` / date décalée de `daysAgo` jours
function isoDate(daysAgo = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

class NetroSensorDriver extends Homey.Driver {

  async onInit() {
    this.log('Netro Sensor driver ready');
  }

  async onPair(session) {
    let apiKey = null;

    // Validate the sensor key by fetching recent data.
    // Valide la clé capteur en récupérant des données récentes.
    session.setHandler('validate_key', async (key) => {
      apiKey = (key || '').trim();
      const api = new NetroApi(apiKey);
      const { data } = await api.sensorData({ start_date: isoDate(2) }); // throws if invalid
      const readings = (data && data.sensor_data) ? data.sensor_data.length : 0;
      return { readings };
    });

    session.setHandler('list_devices', async () => {
      return [{
        name: 'Whisperer',
        data: { id: apiKey },   // sensor key is unique per sensor / clé unique par capteur
        store: { apiKey },
      }];
    });
  }

}

module.exports = NetroSensorDriver;
