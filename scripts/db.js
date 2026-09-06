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
    pending: {},

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

    // merge two {uid: [msgs]} chat maps, messages unique by mid, ordered oldest->newest
    mergeChatMaps: function (baseObj, extraObj) {
      var out = {};
      var keys = {};
      Object.keys(baseObj || {}).forEach(function (k) { keys[k] = 1; });
      Object.keys(extraObj || {}).forEach(function (k) { keys[k] = 1; });
      Object.keys(keys).forEach(function (k) {
        var a = baseObj[k] || [];
        var b = (extraObj && extraObj[k]) || [];
        var seen = {};
        var merged = [];
        a.concat(b).forEach(function (m) {
          if (m && m.mid && !seen[m.mid]) { seen[m.mid] = 1; merged.push(m); }
        });
        merged.sort(function (x, y) {
          var tx = x.at || ''; var ty = y.at || '';
          return tx < ty ? -1 : tx > ty ? 1 : 0;
        });
        out[k] = merged;
      });
      return out;
    },

    // chat push that never silently drops messages: pulls the CURRENT remote
    // chat map, merges local+remote (unique by mid), writes the union back.
    upsertChatMerged: function (localRaw) {
      var self = this;
      var local = {};
      try { local = JSON.parse(localRaw) || {}; } catch (e) {}
      return this.q('app_meta?id=eq.chat&select=id,json', {}).then(function (rows) {
        var remote = {};
        if (Array.isArray(rows) && rows.length && rows[0].json) {
          try { remote = JSON.parse(rows[0].json) || {}; } catch (e) {}
        }
        var mergedRaw = JSON.stringify(self.mergeChatMaps(remote, local));
        // mirror the merged map locally so pull and render stay consistent
        try { localStorage.setItem('trustChat', mergedRaw); } catch (e) {}
        var row = self.blobRow('chat', mergedRaw);
        var exists = Array.isArray(rows) && rows.length > 0;
        if (!exists) return self.q('app_meta', { method: 'POST', body: row });
        return self.q('app_meta?id=eq.chat', { method: 'PATCH', body: { json: row.json, version: row.version } });
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
          // skip blobs this tab edited and is about to (or still) pushes
          if (self.pending[r.id]) return;
          var key = self.keyForBlob(r.id);
          if (!key) return;
          try {
            if (r.id === 'chat') {
              // merge remote chat into local (never drop locally-known messages)
              var cur = {};
              try { cur = JSON.parse(localStorage.getItem('trustChat')) || {}; } catch (e) {}
              var rem = {};
              try { rem = JSON.parse(r.json) || {}; } catch (e) {}
              var merged = self.mergeChatMaps(cur, rem);
              var mergedRaw = JSON.stringify(merged);
              localStorage.setItem('trustChat', mergedRaw);
              // heal lost-updates: if either side held messages the other lacks,
              // push the union back up so every device converges next poll
              try {
                if (mergedRaw !== JSON.stringify(rem)) {
                  self.pending['chat'] = true;
                  self.upsertChatMerged(mergedRaw).then(function () {
                    delete self.pending['chat'];
                  }, function () { delete self.pending['chat']; });
                }
              } catch (e) {}
            } else {
              localStorage.setItem(key, r.json);
            }
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
          self.pending[id] = true;
          var op = id === 'chat' ? self.upsertChatMerged(raw) : self.upsertBlob(id, raw);
          op.then(function () {
            delete self.pending[id];
          }, function () { delete self.pending[id]; });
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
      // keep localStorage fresh from Supabase so every open page sees
      // changes made on OTHER devices (admin approves deposit -> user sees it)
      var pollMs = 5000;
      if (typeof window.setInterval === 'function') {
        setInterval(function () {
          if (typeof document !== 'undefined' && document.hidden) return;
          self.pullAll().catch(function () {});
        }, pollMs);
      }
    }
  };

  global.DB = DB;
  DB.start();
})(window);