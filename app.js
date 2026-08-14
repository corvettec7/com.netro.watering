'use strict';

const Homey = require('homey');

class NetroApp extends Homey.App {
  async onInit() {
    this.log('Netro Watering app démarrée');
  }
}

module.exports = NetroApp;
