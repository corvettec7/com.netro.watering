'use strict';

// Widget "Watering control" — read zone state + trigger watering / stop.
// Actions call the Netro API (quota) only on a button press.
// Widget « Commande d'arrosage » — lit l'état des zones + déclenche/arrête
// l'arrosage. Les actions appellent l'API Netro (quota) seulement sur appui.

function findDevice(homey, id) {
  try {
    return homey.drivers.getDriver('controller').getDevices()
      .find((d) => d.getData().id === id) || null;
  } catch (e) { return null; }
}

module.exports = {
  async getState({ homey }) {
    let lang = 'en';
    try { lang = homey.i18n.getLanguage(); } catch (e) {}
    const fr = lang === 'fr';

    const t = {
      watering: fr ? 'Arrosage en cours' : 'Watering',
      unavailable: fr ? 'Indisponible' : 'Unavailable',
      none: fr ? 'Aucun contrôleur Netro.' : 'No Netro controller.',
      detecting: fr ? 'Zones en cours de détection…' : 'Detecting zones…',
      stop: fr ? 'Arrêter' : 'Stop',
      min: fr ? 'min' : 'min',
      error: fr ? 'Erreur' : 'Error',
    };
    const statusMap = fr
      ? { ONLINE: 'En ligne', WATERING: 'Arrosage', STANDBY: 'Veille', OFFLINE: 'Hors ligne', POWEROFF: 'Éteint', SLEEPING: 'Sommeil', SETUP: 'Config' }
      : { ONLINE: 'Online', WATERING: 'Watering', STANDBY: 'Standby', OFFLINE: 'Offline', POWEROFF: 'Power off', SLEEPING: 'Sleeping', SETUP: 'Setup' };

    let devices = [];
    try { devices = homey.drivers.getDriver('controller').getDevices(); }
    catch (e) { return { t, durations: [5, 10, 15], controllers: [] }; }

    const controllers = devices.map((d) => {
      const status = d.getCapabilityValue('netro_status') || null;
      return {
        id: d.getData().id,
        name: d.getName(),
        available: d.getAvailable(),
        statusLabel: status ? (statusMap[status] || status) : '',
        watering: status === 'WATERING',
        zones: (typeof d.getZonesSnapshot === 'function') ? d.getZonesSnapshot() : [],
      };
    });
    return { t, durations: [5, 10, 15], controllers };
  },

  // Start watering one zone for `duration` minutes.
  async water({ homey, body }) {
    const device = findDevice(homey, body && body.deviceId);
    if (!device) return { ok: false, error: 'device_not_found' };
    try {
      await device.startWatering({ zones: [body.zone], duration: body.duration });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  // Stop all watering on a controller.
  async stop({ homey, body }) {
    const device = findDevice(homey, body && body.deviceId);
    if (!device) return { ok: false, error: 'device_not_found' };
    try {
      await device.api.stopWater();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },
};
