'use strict';

const Homey = require('homey');
const { NetroApi } = require('../../lib/NetroApi');

class NetroControllerDriver extends Homey.Driver {

  async onInit() {
    // Cartes de déclenchement (device-scoped)
    this.wentOfflineTrigger = this.homey.flow.getDeviceTriggerCard('controller_went_offline');
    this.cameOnlineTrigger = this.homey.flow.getDeviceTriggerCard('controller_came_online');
    this.zoneStartedTrigger = this.homey.flow.getDeviceTriggerCard('zone_watering_started');
    this.zoneStoppedTrigger = this.homey.flow.getDeviceTriggerCard('zone_watering_stopped');

    // Carte ALORS : démarrer un arrosage
    this.homey.flow.getActionCard('start_watering').registerRunListener(async (args) => {
      const zones = (args.zones && args.zones.trim())
        ? args.zones.split(',').map((z) => parseInt(z.trim(), 10)).filter((n) => !Number.isNaN(n))
        : undefined;
      return args.device.startWatering({
        zones,
        duration: args.duration,
        delay: args.delay || undefined,
      });
    });

    // Carte ALORS : arrêter l'arrosage
    this.homey.flow.getActionCard('stop_watering')
      .registerRunListener(async (args) => args.device.api.stopWater());

    // Carte ALORS : ne pas arroser pendant N jours
    this.homey.flow.getActionCard('no_water')
      .registerRunListener(async (args) => args.device.api.noWater(args.days));

    // Carte ALORS : forcer l'humidité d'une zone
    this.homey.flow.getActionCard('set_moisture')
      .registerRunListener(async (args) => {
        const zones = (args.zones && args.zones.trim())
          ? args.zones.split(',').map((z) => parseInt(z.trim(), 10)).filter((n) => !Number.isNaN(n))
          : undefined;
        return args.device.api.setMoisture({ moisture: args.moisture, zones });
      });

    // Carte ET : le contrôleur est-il en ligne ?
    this.homey.flow.getConditionCard('is_online')
      .registerRunListener(async (args) => args.device.getCapabilityValue('alarm_generic') === false);
  }

  triggerWentOffline(device, tokens) {
    return this.wentOfflineTrigger.trigger(device, tokens).catch(this.error);
  }

  triggerCameOnline(device, tokens) {
    return this.cameOnlineTrigger.trigger(device, tokens).catch(this.error);
  }

  triggerZoneStarted(device, tokens) {
    return this.zoneStartedTrigger.trigger(device, tokens).catch(this.error);
  }

  triggerZoneStopped(device, tokens) {
    return this.zoneStoppedTrigger.trigger(device, tokens).catch(this.error);
  }

  // ---- Pairing : saisie + validation de la clé API ----
  async onPair(session) {
    let apiKey = null;

    // Appelé depuis la vue custom enter_key.html
    session.setHandler('validate_key', async (key) => {
      apiKey = (key || '').trim();
      const api = new NetroApi(apiKey);
      const { data } = await api.info(); // lève une erreur si la clé est invalide
      return {
        name: data.device.name || 'Netro',
        serial: data.device.serial,
        zones: data.device.zone_num,
      };
    });

    session.setHandler('list_devices', async () => {
      const api = new NetroApi(apiKey);
      const { data } = await api.info();
      const d = data.device;
      return [{
        name: d.name || 'Contrôleur Netro',
        data: { id: d.serial },      // identifiant unique du device Homey
        store: { apiKey },           // la clé est stockée dans le device
      }];
    });
  }

}

module.exports = NetroControllerDriver;
