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

    this._zoneWatering = {}; // last known per-zone watering state / dernier état arrosage par zone

    // Reconcile capabilities so app updates never require re-pairing and a
    // partial migration can't leave the device broken.
    // Réconcilie les capacités : une mise à jour n'exige jamais de ré-appairage,
    // et une migration partielle ne casse plus l'appareil.
    await this._migrateCapabilities().catch((e) => this.error('migrate:', e.message));

    // onoff = enable/standby — GUARDED so a missing capability during a
    // migration can never crash init (which broke the whole device before).
    // onoff = activer/veille — PROTÉGÉ : une capacité absente pendant une
    // migration ne peut plus faire planter l'init (ce qui cassait tout avant).
    if (this.hasCapability('onoff')) {
      this.registerCapabilityListener('onoff', async (value) => {
        this.log(`Flow/UI -> setStatus(${value})`);
        await this.api.setStatus(value);
        this.homey.setTimeout(() => this.poll().catch(this.error), 5000);
      });
    }

    // Seed the Insights number right away so its graph source exists from the
    // first minute (0 = no zone watering), independent of polling.
    // Amorce le nombre Insights tout de suite pour que sa source de graphe
    // existe dès la 1re minute (0 = aucune zone), sans dépendre du polling.
    if (this.hasCapability('watering_zone_active') && this.getCapabilityValue('watering_zone_active') === null) {
      await this.setCapabilityValue('watering_zone_active', 0).catch(() => {});
    }

    await this.poll().catch(this.error);
  }

  // Add missing capabilities and drop obsolete ones, in a safe order, so
  // existing devices self-migrate on app update (no re-pairing needed).
  // Ajoute les capacités manquantes et retire les obsolètes, dans un ordre sûr,
  // pour que les appareils existants se migrent seuls (sans ré-appairage).
  async _migrateCapabilities() {
    const obsolete = ['watering_zones', 'watering_z1', 'watering_z2', 'watering_z3', 'watering_z4', 'watering_z5', 'watering_z6'];
    const wanted = [
      'alarm_generic', 'onoff', 'netro_status', 'zone_watering',
      'zone_watering.zone1', 'zone_watering.zone2', 'zone_watering.zone3',
      'zone_watering.zone4', 'zone_watering.zone5', 'zone_watering.zone6',
      'watering_zone_active', 'watering_zone_name',
    ];
    for (const cap of obsolete) {
      if (this.hasCapability(cap)) {
        await this.removeCapability(cap).catch((e) => this.error(`removeCapability ${cap}:`, e.message));
      }
    }
    for (const cap of wanted) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap).catch((e) => this.error(`addCapability ${cap}:`, e.message));
      }
    }
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

    // Per-zone booleans (zone_watering.zone1..6) are kept for the widgets but
    // their tiles are hidden. Insights uses a single "active zone" number below.
    // Here we just seed each zone's edge state.
    // Les booléens par zone (tuiles masquées) restent pour les widgets ; le
    // graphe Insights passe par un seul nombre « zone active » (plus bas).
    const today = new Date().toISOString().slice(0, 10);
    for (const z of zones) {
      if (this._zoneWatering[z.ith] === undefined) {
        const c = `zone_watering.zone${z.ith}`;
        this._zoneWatering[z.ith] = this.hasCapability(c) && this.getCapabilityValue(c) === true;
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

      if (this.hasCapability(`zone_watering.zone${z.ith}`)) {
        await this.setCapabilityValue(`zone_watering.zone${z.ith}`, now).catch(() => {});
      }
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

    // Single "active zone" signals: a NUMBER (which zone is watering, 0 = none)
    // that graphs reliably in Insights, plus a readable TEXT tile with the zone
    // name. Netro waters one zone at a time, so a single value is accurate.
    // Signaux « zone active » : un NOMBRE (quelle zone arrose, 0 = aucune) qui
    // se trace de façon fiable dans Insights, + une tuile TEXTE lisible avec le
    // nom de la zone. Netro arrose une zone à la fois, un seul nombre suffit.
    let activeIth = 0;
    let activeName = '';
    if (executing.size) {
      const first = zones.find((z) => executing.has(z.ith));
      if (first) { activeIth = first.ith; activeName = first.name || `Zone ${first.ith}`; }
    }
    if (this.hasCapability('watering_zone_active') && this._activeIth !== activeIth) {
      await this.setCapabilityValue('watering_zone_active', activeIth).catch(() => {});
      this._activeIth = activeIth;
    }
    if (this.hasCapability('watering_zone_name')) {
      if (!this._idleLabel) {
        let fr = false;
        try { fr = this.homey.i18n.getLanguage() === 'fr'; } catch (e) {}
        this._idleLabel = fr ? 'Aucune' : 'None';
      }
      const label = activeName || this._idleLabel;
      if (this._activeName !== label) {
        await this.setCapabilityValue('watering_zone_name', label).catch(() => {});
        this._activeName = label;
      }
    }
  }

  // Called by the "start watering" flow action / appelé par la carte ALORS
  async startWatering({ zones, duration, delay }) {
    this.log(`startWatering zones=${JSON.stringify(zones) || 'all'} duration=${duration} delay=${delay || 0}`);
    const res = await this.api.water({ zones, duration, delay });
    this._repollBurst(); // refresh tiles/widgets within seconds, not minutes
    return res;
  }

  // Stop all watering on this controller, then refresh quickly.
  // Arrête tout arrosage sur ce contrôleur, puis rafraîchit vite.
  async stopWatering() {
    this.log('stopWatering (all zones)');
    const res = await this.api.stopWater();
    this._repollBurst();
    return res;
  }

  // After a manual start/stop, Netro's cloud takes a moment to reflect the new
  // state. Fire a few quick polls so tiles and widgets catch up in seconds
  // instead of waiting for the next scheduled poll.
  // Après un start/stop manuel, le cloud Netro met un instant à refléter le
  // nouvel état. On enchaîne quelques polls rapprochés pour que tuiles et
  // widgets se mettent à jour en quelques secondes, sans attendre le poll planifié.
  _repollBurst() {
    for (const ms of [3000, 8000, 15000]) {
      this.homey.setTimeout(() => this.poll().catch(this.error), ms);
    }
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
