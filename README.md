# Netro Smart Watering — Homey App

Control your **Netro** smart watering devices from **Homey Pro**, and monitor
whether they are online so you can raise alerts.

Piloter votre arrosage intelligent **Netro** depuis **Homey Pro**, et surveiller
l'état en ligne/hors ligne des appareils pour déclencher des alertes.

**Author / Auteur:** Patrick Tavaris
**License / Licence:** Public domain — The Unlicense (see [LICENSE](./LICENSE))

---

## About Netro / À propos de Netro

This is an **unofficial, community-built** app. It is not made, endorsed or
supported by Netro, Inc. "Netro", "Sprite", "Spark", "Pixie", "Stream" and
"Whisperer" are names of products by their manufacturer.

Application **communautaire non officielle**, sans lien avec Netro, Inc. Les
noms de produits appartiennent à leur fabricant.

- Manufacturer / Fabricant: **Netro, Inc.** — <https://www.netrohome.com>
- Public API (NPA v2) manual / Manuel de l'API publique:
  <https://www.netrohome.com/en/shop/user_guides/7>
- Netro support / Support Netro: <support@netrohome.com>

### Supported hardware / Matériel pris en charge

| Netro product | Homey device | Notes |
|---------------|--------------|-------|
| **Sprite** / **Spark** controllers | *Netro Controller* | Watering control + status |
| **Whisperer** plant sensor / capteur | *Netro Sensor (Whisperer)* | Read-only measurements |

Any Netro controller exposed by the NPA should work; it was developed against a
**Sprite**. / Développé avec un **Sprite** ; tout contrôleur exposé par la NPA
devrait fonctionner.

---

## What this app does & why / Ce que fait l'app et pourquoi

**EN —** The app talks to Netro's cloud **Public API (NPA v2)**, not to devices
on the local network. That is a deliberate design choice: a Netro controller is
reachable from anywhere with its API key, so a Homey in one house can drive
sprinklers in another. Each Netro device is paired as its own Homey device and
carries **its own API key** (Netro issues one key per device), which maps
cleanly onto Homey's driver/device model and supports any number of controllers
and sensors.

The Netro API is **rate-limited to 2000 calls per day per device** (reset at
midnight UTC). Every design decision about polling and extra data respects that
budget — status is polled on a configurable interval (default 5 min ≈ 288
calls/day), per-zone moisture is refreshed only once a day, and per-zone
"watering" state is only queried while a controller is actually watering.

**FR —** L'app dialogue avec l'**API publique cloud de Netro (NPA v2)**, pas avec
des appareils du réseau local. C'est un choix assumé : un contrôleur Netro est
joignable de partout avec sa clé API, donc un Homey d'une maison peut piloter les
arroseurs d'une autre. Chaque appareil Netro est appairé comme un device Homey
distinct portant **sa propre clé API** (Netro délivre une clé par appareil), ce
qui épouse le modèle driver/device de Homey et permet autant de contrôleurs et
de capteurs que voulu.

L'API Netro est **limitée à 2000 appels/jour par appareil** (reset minuit UTC).
Toutes les décisions de conception respectent ce budget : statut interrogé selon
un intervalle réglable (défaut 5 min ≈ 288 appels/jour), et état « arrosage » par
zone interrogé uniquement pendant un arrosage actif.

---

## Getting your API key / Obtenir votre clé API

Netro's NPA v2 authenticates with a **32-character API key** — one per device,
**not** a username/password. / La NPA v2 s'authentifie avec une **clé de 32
caractères** — une par appareil, ce n'est **pas** un identifiant/mot de passe.

1. Log in at / Connectez-vous sur <https://www.netrohome.com/shop>.
2. **Account** menu → **API Key** (left sidebar / barre latérale).
3. Select the device or sensor / sélectionnez l'appareil ou le capteur →
   **Generate API Key**, then copy it / puis copiez-la.

During pairing in Homey, paste the key. The app validates it before adding the
device, then stores it on that device. / Lors de l'ajout, collez la clé ; l'app
la valide avant d'ajouter l'appareil puis la stocke sur le device.

---

## Flow cards / Cartes de Flow

| Type | Card / Carte | Notes |
|------|--------------|-------|
| WHEN / QUAND | Controller went offline / passé hors ligne | token `status` |
| WHEN / QUAND | Controller came back online / revenu en ligne | token `status` |
| WHEN / QUAND | A zone started watering / une zone a commencé à arroser | tokens `zone`, `zone_name` |
| WHEN / QUAND | A zone stopped watering / une zone a fini d'arroser | tokens `zone`, `zone_name` |
| AND / ET | Controller is online / est en ligne | |
| THEN / ALORS | Start watering / Démarrer l'arrosage | duration + zones + delay |
| THEN / ALORS | Stop watering / Arrêter l'arrosage | |
| THEN / ALORS | Skip watering N days / Ne pas arroser N jours | |
| THEN / ALORS | Set zone moisture / Forcer l'humidité | 0–100 % + zones |

**Why "Set zone moisture"?** It overrides Netro's smart moisture estimate — e.g.
set a zone to 100 % after rain so the smart schedule skips a cycle **without**
disabling smart mode. / Elle surcharge l'estimation smart de Netro — ex. mettre
100 % après une pluie pour sauter un cycle **sans** désactiver le mode
intelligent.

### Capabilities / Capacités

- **Controller / Contrôleur:** offline alarm (`alarm_generic`), readable status
  (`netro_status`), enable/standby (`onoff`), a controller-level "watering now"
  indicator and a **per-zone** watering indicator (created automatically from the
  number of zones). / alarme hors ligne, statut lisible, activation/veille, un
  indicateur « arrosage en cours » au niveau contrôleur et un indicateur
  d'arrosage **par zone** (créés automatiquement selon le nombre de zones).
- **Sensor (Whisperer) / Capteur:** soil moisture, temperature, luminance,
  battery, and a low-battery alarm (`alarm_battery`) — read-only. / humidité du
  sol, température, luminosité, batterie, et une alarme de batterie faible — en
  lecture seule.

### Dashboard widget / Widget de tableau de bord

**EN —** The app adds two widgets for Homey Dashboards. **Zones overview**:
shows every zone of your Netro controllers at a glance, highlighting the ones
currently watering. It reads local state only (no Netro API call). Requires
Homey 12.3.0+.

**FR —** L'app ajoute deux widgets pour les Tableaux de bord Homey. **Vue d'ensemble des zones** : les Tableaux
de bord Homey : il montre toutes les zones de vos contrôleurs Netro d'un coup
d'œil, celles qui arrosent en surbrillance. Il lit uniquement l'état local
(aucun appel Netro). Nécessite Homey 12.3.0+.

**Watering control / Commande d'arrosage** — quick 5/10/15 min buttons to water each zone directly from the dashboard, plus a Stop button per controller. / boutons rapides 5/10/15 min pour arroser chaque zone depuis le dashboard, plus un bouton Arrêter par contrôleur.

---

### Visualising watering cycles / Visualiser les cycles d'arrosage

**EN —** Each zone's "watering" state is a boolean logged to **Insights**, so its
graph shows a clean square wave: rising edge = cycle start, falling edge = cycle
end. To make those edges accurate, the controller uses **adaptive polling** — it
refreshes every minute while a cycle is running (configurable) and returns to the
normal interval when idle. The state is written only on change, keeping the graph
clean and firing the "zone started/stopped watering" triggers. Overlay a zone's
watering graph with the Whisperer's soil-moisture graph to see moisture rise
after each cycle.

**FR —** L'état « arrosage » de chaque zone est un booléen enregistré dans
**Insights** : son graphe affiche un créneau net (front montant = début de cycle,
front descendant = fin). Pour que ces fronts soient précis, le contrôleur utilise
un **polling adaptatif** — rafraîchissement chaque minute pendant un cycle
(réglable), retour à l'intervalle normal au repos. L'état n'est écrit qu'au
changement, ce qui garde le graphe propre et déclenche les cartes « zone a
commencé/fini d'arroser ». Superpose le graphe d'arrosage d'une zone avec celui
de l'humidité du Whisperer pour voir l'humidité remonter après chaque cycle.

---

## Settings (per device) / Réglages (par appareil)

- **Polling interval / Intervalle de rafraîchissement** — default 5 min
  (controller) / 30 min (sensor). Mind the 2000 calls/day limit. / Attention à la
  limite de 2000 appels/jour.
- **Polling interval while watering / Intervalle pendant l'arrosage** (controller)
  — default 1 min, for accurate cycle start/end on the graph. / défaut 1 min, pour
  un début/fin de cycle précis sur le graphe.
- **Low-battery alarm below / Alarme batterie faible en dessous de** (sensor) —
  default 15 %. / défaut 15 %.
- **Verbose logging / Journalisation détaillée** — default off. Logs every API
  call (endpoint, latency, remaining quota; the key is masked). / Journalise
  chaque appel API (endpoint, latence, quota restant ; clé masquée).

---

## Debugging / Débogage

- Turn on **Verbose logging** in a device's settings to trace the Netro API.
  / Activez **Journalisation détaillée** dans les réglages du device.
- View logs live with `homey app run`, or in the Homey Developer Tools
  (**Application** log). / Logs en direct via `homey app run`, ou dans les Homey
  Developer Tools.
- Common issues / Problèmes fréquents:
  - *Device unavailable, "Invalid API key"* (error 1) → re-pair with a fresh key.
  - *Quota exceeded* (error 3) → raise the polling interval.
  - Recent Netro devices require API **v2** (this app uses v2).

---

## Development / Développement

The whole app manifest (drivers, capabilities, flow cards) lives in a single
`/app.json` — no HomeyCompose, no hidden folders. Driver logic is in each
driver's `device.js` / `driver.js`. / Tout le manifeste (drivers, capacités,
cartes de Flow) est dans un unique `/app.json` — pas de HomeyCompose, aucun
dossier caché. La logique est dans les `device.js` / `driver.js` de chaque driver.

```bash
npm install -g homey        # Homey CLI
homey login
homey app validate --level publish
homey app run --remote      # install + live logs on your Homey / installe + logs
```

Project layout / Structure:

```
app.json                            # full app manifest / manifeste complet
app.js                              # app entry point / point d'entrée
lib/NetroApi.js                     # NPA v2 client (bilingual JSDoc)
drivers/controller/                 # Sprite/Spark controller driver
drivers/sensor/                     # Whisperer sensor driver
.homeychangelog.json                # per-version changelog / journal par version
```

## Publishing / Publication

Publish a Test build with `homey app publish` (needs a developer account), or via
the official Athom GitHub Actions once the repo is on GitHub. / Publier une
version Test avec `homey app publish`, ou via les Actions GitHub officielles une
fois le repo en ligne. Requires the `.homeychangelog.json` changelog. / Nécessite
le changelog `.homeychangelog.json`.

## License / Licence

**Public domain — The Unlicense.** Do whatever you want with this code.
/ **Domaine public.** Faites-en ce que vous voulez. See [LICENSE](./LICENSE).
