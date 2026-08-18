'use strict';

const Homey = require('homey');
const { NetroApi, NetroApiError } = require('../../lib/NetroApi');

// States treated as "down" -> alarm / États considérés « hors service » -> alarme
const OFFLINE_STATES = ['OFFLINE', 'POWEROFF'];

class NetroControllerDevice extends Homey.Device {

  async onInit() {
    const apiKey = this.getStoreValue('apiKey');

    // Logger gated by the "debug" device setting.
    // Journalisation conditionnée par le réglage « debug » du device.
    this.api = new NetroApi(apiKey, {
      log: (msg) => {
        if (this.getSetting('debug')) this.log(msg);
      },
    });

    this.log(`Device init: "${this.getName()}" (poll=${this.getSetting('poll_interval')}min, debug=${!!this.getSetting('debug')})`);

    // onoff = enable (ONLINE) / standby (STANDBY) the controller
    this.registerCapabilityListener('onoff', async (value) => {
      this.log(`Flow/UI -> setStatus(${value})`);
      await this.api.setStatus(value);
      this.homey.setTimeout(() => this.poll().catch(this.error), 5000);
    });

    this._zoneWatering = {}; // last known per-zone watering state / dernier état arrosage par zone
    await this.poll().catch(this.error);
  }

  // Self-scheduling poll loop: tighter cadence while watering so the start and
  // end of each zone cycle land accurately on the Insights graph, normal cadence
  // when idle to respect the 2000 calls/day quota.
  // Boucle auto-planifiée : cadence resserrée pendant l'arrosage pour un début/fin
  // de cycle précis sur le graphe, cadence normale au repos pour le quota.
  _scheduleNext(status) {
    if (this.pollTimer) this.homey.clearTimeout(this.pollTimer);
    if (this._deleted) return;
    const idle = Number(this.getSetting('poll_interval')) || 5;
    const active = Number(this.getSetting('watering_poll_interval')) || 1;
    const minutes = (status === 'WATERING') ? active : idle;
    this.pollTimer = this.homey.setTimeout(() => this.poll().catch(this.error), minutes * 60 * 1000);
  }

  async poll() {
    let status = null;
    try {
      const { data, meta } = await this.api.info();
      const device = data.device;
      status = device.status; // ONLINE / WATERING / STANDBY / OFFLINE / ...

      const isOffline = OFFLINE_STATES.includes(status);
      const wasOffline = this.getCapabilityValue('alarm_generic') === true;

      await this.setCapabilityValue('alarm_generic', isOffline);
      await this.setCapabilityValue('netro_status', status).catch(() => {});
      await this.setCapabilityValue('onoff', status !== 'STANDBY').catch(() => {});
      // Controller-level "watering now" (any zone) / « arrosage en cours » (toutes zones)
      if (this.hasCapability('zone_watering')) {
        await this.setCapabilityValue('zone_watering', status === 'WATERING').catch(() => {});
      }

      // Rising/falling edges -> trigger cards / fronts -> cartes de déclenchement
      if (isOffline && !wasOffline) {
        this.log(`Status -> OFFLINE (${status}); firing "went offline"`);
        await this.driver.triggerWentOffline(this, { status });
      } else if (!isOffline && wasOffline) {
        this.log(`Status -> back ONLINE (${status}); firing "came online"`);
        await this.driver.triggerCameOnline(this, { status });
      }

      if (!this.getAvailable()) await this.setAvailable();

      // Per-zone KPIs / indicateurs par zone
      await this._syncZones(device, status).catch((e) => this.error('zone sync:', e.message));

      // Quota watchdog / surveillance du quota (2000/day)
      if (meta && typeof meta.token_remaining === 'number' && meta.token_remaining < 50) {
        this.log(`WARNING: low Netro quota — ${meta.token_remaining} calls left today`);
      }
    } catch (err) {
      if (err instanceof NetroApiError && err.code === 1) {
        this.error('Invalid API key — marking device unavailable');
        await this.setUnavailable('Clé API Netro invalide / Invalid Netro API key');
      } else if (err instanceof NetroApiError && err.code === 3) {
        this.error('Netro daily quota exceeded / quota journalier dépassé');
      } else {
        this.error('poll() failed:', err.message);
      }
    } finally {
      this._scheduleNext(status);
    }
  }

  // ---- Per-zone watering / arrosage par zone ----

  _zoneTitle(z) {
    const name = z.name || `Zone ${z.ith}`;
    return { en: name, fr: name };
  }

  // Read-only snapshot consumed by the dashboard widget API (no Netro call).
  // Instantané en lecture seule pour l'API du widget (aucun appel Netro).
  getZonesSnapshot() {
    return (this._zonesInfo || []).map((z) => ({
      ith: z.ith,
      name: z.name,
      watering: this.getCapabilityValue(`zone_watering.zone${z.ith}`) === true,
    }));
  }

  async _syncZones(device, status) {
    const zones = Array.isArray(device.zones) ? device.zones : [];
    if (!zones.length) return;

    // Keep a lightweight zones snapshot (index + name) for the dashboard widget.
    // Instantané léger des zones (index + nom) pour le widget de tableau de bord.
    this._zonesInfo = zones.map((z) => ({ ith: z.ith, name: z.name || `Zone ${z.ith}` }));

    // One-time cleanup: remove the deprecated per-zone humidity tiles that
    // earlier versions created (Netro rarely returns per-zone estimates, so
    // they stayed empty). Real soil moisture comes from the Whisperer sensor.
    // Nettoyage unique : retire les tuiles d'humidité par zone des anciennes
    // versions (souvent vides). L'humidité réelle vient du capteur Whisperer.
    if (!this._humidityCleaned) {
      for (const cap of this.getCapabilities()) {
        if (cap.startsWith('measure_humidity.zone')) {
          await this.removeCapability(cap).catch(() => {});
        }
      }
      this._humidityCleaned = true;
    }

    // Zone watering sub-capabilities are declared STATICALLY in the manifest
    // (zone_watering.zone1..6) so each gets its own reliable Insights log.
    // Here we only label each with its real Netro name and seed its edge state.
    // Les sous-capacités d'arrosage par zone sont déclarées STATIQUEMENT dans le
    // manifeste (zone_watering.zone1..6) pour un journal Insights fiable par
    // zone. Ici on leur donne le vrai nom Netro et on amorce leur état.
    const today = new Date().toISOString().slice(0, 10);
    this._zoneTitled = this._zoneTitled || {};
    for (const z of zones) {
      const watCap = `zone_watering.zone${z.ith}`;
      if (!this.hasCapability(watCap)) continue; // zone beyond the declared count
      // Set the real zone name as the capability title, once per name change.
      // Met le vrai nom de zone comme titre, une fois par changement de nom.
      if (this._zoneTitled[z.ith] !== z.name && typeof this.setCapabilityOptions === 'function') {
        await this.setCapabilityOptions(watCap, { title: this._zoneTitle(z) }).catch(() => {});
        this._zoneTitled[z.ith] = z.name;
      }
      if (this._zoneWatering[z.ith] === undefined) {
        this._zoneWatering[z.ith] = this.getCapabilityValue(watCap) === true;
      }
    }

    // Per-zone watering start/end — schedules are queried only while the
    // controller is watering; otherwise every zone is idle (no API call).
    // We write the capability ONLY on change, which gives clean square-wave
    // edges on the Insights graph and lets us fire start/stop trigger cards.
    // Début/fin d'arrosage par zone — planning interrogé seulement pendant un
    // arrosage. On n'écrit qu'au changement : créneaux nets sur le graphe +
    // cartes de déclenchement début/fin.
    let executing = new Set();
    if (status === 'WATERING') {
      try {
        const { data } = await this.api.schedules({ start_date: today, end_date: today });
        executing = new Set(
          ((data && data.schedules) || [])
            .filter((s) => s.status === 'EXECUTING')
            .map((s) => s.zone),
        );
      } catch (e) {
        this.log(`schedule sync skipped: ${e.message}`);
        return; // keep last known zone states; retry next poll
      }
    }

    for (const z of zones) {
      const now = executing.has(z.ith);
      const prev = this._zoneWatering[z.ith];
      if (prev === now) continue; // no edge -> nothing to log or fire
      if (!this.hasCapability(`zone_watering.zone${z.ith}`)) continue;

      await this.setCapabilityValue(`zone_watering.zone${z.ith}`, now).catch(() => {});
      this._zoneWatering[z.ith] = now;

      const tokens = { zone: z.ith, zone_name: z.name || `Zone ${z.ith}` };
      if (now) {
        this.log(`Zone ${z.ith} (${tokens.zone_name}) started watering`);
        this.driver.triggerZoneStarted(this, tokens);
      } else if (prev === true) {
        this.log(`Zone ${z.ith} (${tokens.zone_name}) stopped watering`);
        this.driver.triggerZoneStopped(this, tokens);
      }
    }

    // Numeric watering activity (0..N) — a BASE number capability logs reliably
    // to Insights, unlike per-zone boolean sub-capabilities. Written on change.
    // Activité d'arrosage numérique (0..N) — une capacité nombre de base se
    // trace de façon fiable dans Insights, contrairement aux sous-capacités
    // booléennes par zone. Écrite au changement.
    const count = executing.size;
    if (this.hasCapability('watering_zones') && this._wateringCount !== count) {
      await this.setCapabilityValue('watering_zones', count).catch(() => {});
      this._wateringCount = count;
    }
  }

  // Called by the "start watering" flow action / appelé par la carte ALORS
  async startWatering({ zones, duration, delay }) {
    this.log(`startWatering zones=${JSON.stringify(zones) || 'all'} duration=${duration} delay=${delay || 0}`);
    const res = await this.api.water({ zones, duration, delay });
    this.homey.setTimeout(() => this.poll().catch(this.error), 5000);
    return res;
  }

  async onSettings({ changedKeys }) {
    if (changedKeys.includes('poll_interval') || changedKeys.includes('watering_poll_interval')) {
      // Apply the new cadence right away / applique la nouvelle cadence tout de suite
      this.homey.setTimeout(() => this.poll().catch(this.error), 500);
    }
    if (changedKeys.includes('debug')) this.log('Debug logging toggled');
  }

  async onDeleted() {
    this._deleted = true;
    if (this.pollTimer) this.homey.clearTimeout(this.pollTimer);
    this.log('Device deleted, polling stopped');
  }

}

module.exports = NetroControllerDevice;
