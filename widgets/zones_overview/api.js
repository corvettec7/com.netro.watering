'use strict';

// Widget API — runs on Homey, has access to the app's `homey` instance.
// Reads local capability values only (no Netro API call, no quota use).
// Localises labels using the Homey language so the widget matches EN/FR.
// API du widget — lecture locale uniquement (aucun appel Netro), libellés
// localisés selon la langue du Homey (EN/FR).
module.exports = {
  async getState({ homey }) {
    let lang = 'en';
    try { lang = homey.i18n.getLanguage(); } catch (e) {}
    const fr = lang === 'fr';

    const t = {
      watering: fr ? 'Arrosage en cours' : 'Watering',
      unavailable: fr ? 'Indisponible' : 'Unavailable',
      detecting: fr ? 'Zones en cours de détection…' : 'Detecting zones…',
      none: fr ? 'Aucun contrôleur Netro.' : 'No Netro controller.',
      error: fr ? 'Erreur de lecture.' : 'Read error.',
    };

    const statusMap = fr
      ? { ONLINE: 'En ligne', WATERING: 'Arrosage', STANDBY: 'Veille', OFFLINE: 'Hors ligne', POWEROFF: 'Éteint', SLEEPING: 'Sommeil', SETUP: 'Config' }
      : { ONLINE: 'Online', WATERING: 'Watering', STANDBY: 'Standby', OFFLINE: 'Offline', POWEROFF: 'Power off', SLEEPING: 'Sleeping', SETUP: 'Setup' };

    let devices = [];
    try {
      devices = homey.drivers.getDriver('controller').getDevices();
    } catch (e) {
      return { t, controllers: [] };
    }

    const controllers = devices.map((d) => {
      const status = d.getCapabilityValue('netro_status') || null;
      return {
        id: d.getData().id,
        name: d.getName(),
        available: d.getAvailable(),
        statusLabel: status ? (statusMap[status] || status) : '',
        zones: (typeof d.getZonesSnapshot === 'function') ? d.getZonesSnapshot() : [],
      };
    });

    return { t, controllers };
  },
};
