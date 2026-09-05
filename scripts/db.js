/* TrustCom static clone — light Supabase DB client + sync layer.
   Loaded BEFORE app.js. Uses the Supabase PostgREST API directly
   (no external SDK). Falls back silently to localStorage-only if
   SITE_CONFIG.ENABLED is false. */
(function (global) {
  'use strict';

  var CFG = global.SITE_CONFIG || { ENABLED: false };

  // blob id -> localStorage key the app reads/writes
  var BLOB_MAP = {
    users: 'trustUsers',
    balances: 'trustBalances',
    txns: 'trustTxns',
    loans: 'trustLoans',
    trades: 'trustTrades',
    orders: 'trustOrders',
    aiorders: 'trustAIOrders',
    chat: 'trustChat',
    greeted: 'trustChatGreeted',
    verifications: 'trustVerifications',
    addresses: 'trustCoinAddresses',
    profitMode: 'trustProfitMode',
    config: 'trustAppConfig'
  };
  var KEY_TO_BLOB = {};
  for (var b in BLOB_MAP) if (Object.prototype.hasOwnProperty.call(BLOB_MAP, b)) KEY_TO_BLOB[BLOB_MAP[b]] = b;

  var DB = {
    ENABLED: CFG.ENABLED,
    READONLY: !!CFG.READONLY,
    url: CFG.DB_URL || '',
    anon: CFG.DB_ANON_KEY || '',
    service: CFG.DB_SERVICE_KEY || '',
    connected: false,
    lastSync: 0,

    setConfig: function (c) {
      if (!c) return false;
      if (c.url) this.url = c.url;
      if (c.anon) this.anon = c.anon;
      if (c.service) this.service = c.service;
      if (c.readonly !== undefined) this.READONLY = !!c.readonly;
      if (!this.url || this.url.indexOf('YOUR-PROJECT') !== -1 || !this.anon || this.anon.indexOf('YOUR-PROJECT') !== -1) return false;
      this.ENABLED = true;
      return true;
    },

    keys: function () { return Object.keys(BLOB_MAP); },
    keyForBlob: function (id) { return BLOB_MAP[id]; },
    blobForKey: function (key) { return KEY_TO_BLOB[key]; },

    // core REST call
    q: function (path, opts) {
      opts = opts || {};
      if (!this.ENABLED) return Promise.resolve(null);
      var headers = {
        'apikey': this.anon,
        'Authorization': 'Bearer ' + this.anon,
        'Accept-Profile': 'public',
        'Content-Type': 'application/json'
      };
      if (opts.headers) for (var h in opts.headers) headers[h] = opts.headers[h];
      var init = { method: opts.method || 'GET', headers: headers };
      if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
      return fetch(this.url + '/rest/v1/' + path, init).then(function (res) {
        if (!res.ok) return Promise.reject(new Error('HTTP ' + res.status + ' ' + path));
        if (opts.text) return res.text();
        if (opts.noContent) return null;
        return res.json();
      });
    },

    blobRow: function (id, json) {
      return { id: id, json: typeof json === 'string' ? json : JSON.stringify(json || ''), version: 1 };
    },

    listBlobs: function () {
      var self = this;
      return this.q('app_meta?select=id,json,updated_at&order=updated_at.desc', {}).then(function (rows) {
        if (!Array.isArray(rows)) return [];
        self.connected = true;
        return rows;
      });
    },

    upsertBlob: function (id, json) {
      var self = this;
      var row = this.blobRow(id, json);
      return this.q('app_meta?id=eq.' + encodeURIComponent(id) + '&select=id', {}).then(function (rows) {
        var exists = Array.isArray(rows) && rows.length > 0;
        if (!exists) return self.q('app_meta', { method: 'POST', body: row });
        return self.q('app_meta?id=eq.' + encodeURIComponent(id), { method: 'PATCH', body: { json: row.json, version: row.version } });
      });
    },

    putAll: function () {
      // push every existing local key as a blob (seed/backup)
      var self = this;
      var jobs = [];
      this.keys().forEach(function (id) {
        var key = self.keyForBlob(id);
        var raw = null;
        try { raw = localStorage.getItem(key); } catch (e) { raw = null; }
        if (raw == null) return;
        jobs.push(self.upsertBlob(id, raw));
      });
      return Promise.all(jobs).then(function () { self.connected = true; });
    },

    pullAll: function () {
      var self = this;
      return this.listBlobs().then(function (rows) {
        rows.forEach(function (r) {
          var key = self.keyForBlob(r.id);
          if (!key) return;
          try {
            localStorage.setItem(key, r.json);
            self.connected = true;
          } catch (e) {}
        });
        self.lastSync = Date.now();
        try { localStorage.setItem('trustDbLastSync', String(self.lastSync)); } catch (e) {}
        return rows.length;
      });
    },

    // live sync: after a local write to a known key, push it up
    enqueue: (function () {
      var timers = {};
      var flushing = false;
      return function syncKey(key) {
        var self = DB;
        if (!self.ENABLED) return;
        var id = self.blobForKey(key);
        if (!id) return;
        if (timers[id]) clearTimeout(timers[id]);
        timers[id] = setTimeout(function () {
          var raw = null;
          try { raw = localStorage.getItem(key); } catch (e) { raw = null; }
          if (raw == null) return;
          self.upsertBlob(id, raw).catch(function () {});
        }, 400);
      };
    })(),

    start: function () {
      var self = this;
      if (!self.ENABLED) return;
      function boot() {
        // pull remote first, then seed local-if-remote-empty
        self.pullAll()
          .then(function (n) {
            if (n === 0) return self.putAll();
            return n;
          })
          .catch(function () { self.connected = false; });
      }
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
      } else {
        boot();
      }
    }
  };

  global.DB = DB;
  DB.start();
})(window);