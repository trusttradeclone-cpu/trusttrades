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
    chatTopic: 'realtime:chat',
    chatLive: false,
    chatPendingRaw: null,
    chatSock: null,
    chatHb: null,
    rtTimer: null,
    rtConnecting: false,
    rtRef: 0,

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

    // primary key used to union record lists when merging; maps (uid -> data)
    // are already keyed by property name so they need no accessor
    blobKeyFor: function (id) {
      if (id === 'users') return 'uid';
      if (id === 'txns' || id === 'trades' || id === 'loans' || id === 'aiorders' || id === 'orders') return 'id';
      return null;
    },

    // union a remote blob with the local copy so a stale device can never
    // silently delete records it does not know about:
    //  - arrays are merged keyed by uid/id, the local (writer) copy wins on
    //    conflict and remote-only entries are always kept
    //  - maps are merged per-key, local value wins on conflict
    //  - an empty local blob never wipes a non-empty remote one
    mergeBlobJson: function (id, remoteRaw, localRaw) {
      var remote = null;
      try { remote = JSON.parse(remoteRaw); } catch (e) { remote = null; }
      var local = null;
      try { local = JSON.parse(localRaw); } catch (e) { local = null; }
      var isEmpty = function (v) {
        return v == null || (Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0);
      };
      if (isEmpty(local)) return isEmpty(remote) ? '{}' : JSON.stringify(remote);
      if (isEmpty(remote)) return JSON.stringify(local);
      var key = this.blobKeyFor(id);
      var out;
      if (key) {
        var map = {};
        (remote || []).forEach(function (x) { if (x && x[key]) map[x[key]] = x; });
        (local || []).forEach(function (x) { if (x && x[key]) map[x[key]] = x; });
        out = Object.keys(map).map(function (k) { return map[k]; });
      } else if (Array.isArray(local) && Array.isArray(remote)) {
        out = local;
      } else {
        // shape mismatch or plain maps: per-key union, writer wins
        out = {};
        Object.keys(remote).forEach(function (k) { out[k] = remote[k]; });
        Object.keys(local).forEach(function (k) { out[k] = local[k]; });
      }
      return JSON.stringify(out);
    },

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

    // push that never silently drops records: pull the CURRENT remote blob,
    // union it with the local copy, write the union back. mirrors the union
    // locally too so this device converges to what everyone else has.
    upsertBlob: function (id, json) {
      var self = this;
      var row = this.blobRow(id, json);
      return this.q('app_meta?id=eq.' + encodeURIComponent(id) + '&select=id,json', {}).then(function (rows) {
        var exists = Array.isArray(rows) && rows.length > 0;
        var mergedRaw = row.json;
        if (exists) {
          var remoteRaw = '';
          try { remoteRaw = rows[0].json == null ? '' : rows[0].json; } catch (e) {}
          mergedRaw = self.mergeBlobJson(id, remoteRaw, json);
          row = self.blobRow(id, mergedRaw);
          try { localStorage.setItem(self.keyForBlob(id), mergedRaw); } catch (e) {}
        }
        if (!exists) return self.q('app_meta', { method: 'POST', body: row });
        return self.q('app_meta?id=eq.' + encodeURIComponent(id), { method: 'PATCH', body: { json: row.json, version: row.version } });
      });
    },

    // merge two {uid: [msgs]} chat maps, messages unique by mid, ordered oldest->newest.
    // when the same mid exists on both sides keep the copy that has been deleted /
    // seen, so tombstones and read-state are never lost in a merge; if both copies
    // are equally healthy, the newest edit (editedAt) wins so edits propagate to
    // every device instead of silently losing to a device's stale local copy.
    mergeChatMaps: function (baseObj, extraObj) {
      var out = {};
      var keys = {};
      Object.keys(baseObj || {}).forEach(function (k) { keys[k] = 1; });
      Object.keys(extraObj || {}).forEach(function (k) { keys[k] = 1; });
      var better = function (cur, m) {
        var rc = (cur && cur.deleted ? 2 : 0) + (cur && cur.seen ? 1 : 0);
        var rm = (m && m.deleted ? 2 : 0) + (m && m.seen ? 1 : 0);
        if (rm !== rc) return rm > rc ? m : cur;
        var ea = (cur && cur.editedAt) || '';
        var eb = (m && m.editedAt) || '';
        if (ea !== eb) return eb > ea ? m : cur;
        return cur;
      };
      Object.keys(keys).forEach(function (k) {
        var a = baseObj[k] || [];
        var b = (extraObj && extraObj[k]) || [];
        var idxByMid = {};
        var merged = [];
        a.concat(b).forEach(function (m) {
          if (!m || !m.mid) return;
          if (idxByMid[m.mid] === undefined) {
            idxByMid[m.mid] = merged.length;
            merged.push(m);
          } else {
            merged[idxByMid[m.mid]] = better(merged[idxByMid[m.mid]], m);
          }
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

    // merge remote chat json into local (never drop locally-known messages);
    // if either side held messages the other lacks, push the union back so
    // every device converges next poll (lost-update recovery)
    applyChat: function (remoteRaw) {
      var self = this;
      var cur = {};
      try { cur = JSON.parse(localStorage.getItem('trustChat')) || {}; } catch (e) {}
      var rem = {};
      try { rem = JSON.parse(remoteRaw) || {}; } catch (e) {}
      var merged = self.mergeChatMaps(cur, rem);
      var mergedRaw = JSON.stringify(merged);
      try { localStorage.setItem('trustChat', mergedRaw); } catch (e) {}
      if (mergedRaw !== JSON.stringify(rem)) {
        self.pending['chat'] = true;
        self.upsertChatMerged(mergedRaw).then(function () {
          delete self.pending['chat'];
        }, function () { delete self.pending['chat']; });
      }
      return rem;
    },

    // fast single-blob pull (used on chat pages so messages arrive near-instantly
    // without re-fetching every blob in the app)
    pullBlob: function (id) {
      var self = this;
      if (!this.ENABLED || !this.keyForBlob(id)) return Promise.resolve(0);
      return this.q('app_meta?id=eq.' + encodeURIComponent(id) + '&select=id,json', {}).then(function (rows) {
        // skip while this tab is mid-push on that blob
        if (self.pending[id]) return 0;
        if (!Array.isArray(rows) || !rows.length) return 0;
        var r = rows[0];
        try {
          if (r.id === 'chat') {
            self.applyChat(r.json);
          } else {
            localStorage.setItem(self.keyForBlob(id), r.json);
          }
          self.connected = true;
          self.lastSync = Date.now();
          try { localStorage.setItem('trustDbLastSync', String(self.lastSync)); } catch (e) {}
          return 1;
        } catch (e) { return 0; }
      });
    },

    // ---------- Supabase Realtime (instant chat delivery) ----------
    wsUrl: function () {
      var base = String(this.url || '').replace(/\/+$/, '');
      if (base.indexOf('/rest/v1') !== -1) base = base.split('/rest/v1')[0];
      return base + '/realtime/v1/websocket?apikey=' + encodeURIComponent(this.anon || '') + '&vsn=1.0.0';
    },

    trySendRt: function (obj) {
      try {
        if (this.chatSock && this.chatSock.readyState === 1) {
          this.chatSock.send(JSON.stringify(obj));
          return true;
        }
      } catch (e) {}
      return false;
    },

    connectChat: function () {
      var self = this;
      if (!this.ENABLED || this.rtConnecting) return;
      if (typeof window === 'undefined' || typeof window.WebSocket !== 'function') return;
      this.rtConnecting = true;
      var ws = null;
      try { ws = new window.WebSocket(this.wsUrl()); } catch (e) {}
      if (!ws) { this.rtConnecting = false; this.scheduleChatReconnect(); return; }
      this.chatSock = ws;
      ws.onopen = function () {
        self.rtConnecting = false;
        self.chatLive = true;
        // join the broadcast channel (Supabase realtime Phoenix protocol)
        self.trySendRt({
          topic: self.chatTopic, event: 'phx_join', ref: '1', join_ref: '1',
          payload: { config: { broadcast: { ack: false, self: false }, presence: { key: '', enabled: false }, private: false } }
        });
        self.startRtHeartbeat();
        // flush any message queued while the socket wasn't connected
        if (self.chatPendingRaw != null) {
          var pendingMap = self.chatPendingRaw;
          self.chatPendingRaw = null;
          self.trySendRt({
            topic: self.chatTopic, event: 'broadcast', ref: String(++self.rtRef), join_ref: '1',
            payload: { type: 'broadcast', event: 'msg', payload: { from: 'app', map: pendingMap } }
          });
        }
      };
      ws.onmessage = function (e) { self.onRtMessage(e.data); };
      ws.onclose = function () {
        self.chatLive = false;
        self.chatSock = null;
        self.stopRtHeartbeat();
        self.rtConnecting = false;
        self.scheduleChatReconnect();
      };
      ws.onerror = function () { try { ws.close(); } catch (e) {} };
    },

    scheduleChatReconnect: function () {
      var self = this;
      if (this.rtTimer) return;
      this.rtTimer = setTimeout(function () {
        self.rtTimer = null;
        self.connectChat();
      }, 3000);
    },

    startRtHeartbeat: function () {
      var self = this;
      this.stopRtHeartbeat();
      this.chatHb = setInterval(function () {
        self.trySendRt({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: 'hb-' + (++self.rtRef), join_ref: null });
      }, 15000);
    },

    stopRtHeartbeat: function () {
      if (this.chatHb) { try { clearInterval(this.chatHb); } catch (e) {} this.chatHb = null; }
    },

    notifyChatChanged: function () {
      this.notifyStore('trustchat');
    },

    notifyVerChanged: function () {
      this.notifyStore('trustver');
    },

    notifyStore: function (name) {
      try {
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
          if (typeof window.CustomEvent === 'function') {
            window.dispatchEvent(new window.CustomEvent(name, { detail: { source: 'realtime' } }));
          } else {
            var ev = document.createEvent('Event');
            ev.initEvent(name, false, false);
            window.dispatchEvent(ev);
          }
        }
      } catch (e) {}
    },

    onRtMessage: function (raw) {
      var self = this;
      var m = null;
      try { m = JSON.parse(raw); } catch (e) { return; }
      if (!m || !m.event) return;
      if (m.event !== 'broadcast' || !m.payload) return;
      var evName = m.payload.event;
      if (evName === 'msg' && m.payload.payload && m.payload.payload.map) {
        var incoming = m.payload.payload.map;
        var cur = {};
        try { cur = JSON.parse(localStorage.getItem('trustChat')) || {}; } catch (e) {}
        // merge (idempotent by mid) so nothing already local is ever dropped
        var merged = this.mergeChatMaps(cur, incoming);
        try { localStorage.setItem('trustChat', JSON.stringify(merged)); } catch (e) {}
        // reconcile + persist against the blob shortly after (heals if sender push lost)
        setTimeout(function () { self.pullBlob('chat').catch(function () {}); }, 150);
        this.notifyChatChanged();
      } else if (evName === 'verifications') {
        // verifications map is authoritative on the blob; pull + notify right away
        setTimeout(function () { self.pullBlob('verifications').catch(function () {}); }, 150);
        this.notifyVerChanged();
      } else if (BLOB_MAP.hasOwnProperty(evName)) {
        var pay = (m.payload.payload) || {};
        var incomingRaw = pay.raw;
        var isOptimistic = pay.optimistic === true;
        var key = self.blobKeyFor(evName);
        var doMerge = isOptimistic && key && (Array.isArray(JSON.parse(incomingRaw || '[]')));
        if (incomingRaw) {
          var curRaw = localStorage.getItem(self.keyForBlob(evName));
          if (doMerge) {
            try {
              var merged = self.mergeBlobJson(evName, curRaw || '[]', incomingRaw);
              if (merged !== curRaw) localStorage.setItem(self.keyForBlob(evName), merged);
            } catch (e) {}
          } else if (incomingRaw !== curRaw) {
            try { localStorage.setItem(self.keyForBlob(evName), String(incomingRaw)); } catch (e) {}
          }
        }
        setTimeout(function () { self.pullBlob(evName).catch(function () {}); }, 150);
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
          var nm = 'trustsync:' + evName;
          try {
            window.dispatchEvent(new window.CustomEvent(nm, { detail: { source: 'realtime', raw: incomingRaw, optimistic: isOptimistic } }));
          } catch (e) {
            try {
              var ev = new Event(nm);
              window.dispatchEvent(ev);
            } catch (e2) {}
          }
        }
      }
    },

    // call a local write across instantly to every connected chat page
    broadcastChat: function () {
      var self = this;
      if (!this.ENABLED) return;
      var raw = null;
      try { raw = localStorage.getItem('trustChat'); } catch (e) {}
      if (raw == null) return;
      var map = null;
      try { map = JSON.parse(raw); } catch (e) { return; }
      if (!this.chatLive) {
        // socket not ready yet: remember the map, deliver as soon as joined
        this.chatPendingRaw = map;
        this.connectChat();
        return;
      }
      this.trySendRt({
        topic: this.chatTopic, event: 'broadcast', ref: String(++this.rtRef), join_ref: '1',
        payload: { type: 'broadcast', event: 'msg', payload: { from: 'app', map: map } }
      });
    },

    // let a verification write reach every open page in real time (same socket
    // as chat; receivers pull the authoritative blob shortly after)
    broadcastVerifications: function () {
      this.broadcastBlob('verifications');
    },

    // deliver a blob-change notification over the realtime socket; receivers
    // pull the authoritative blob shortly after and re-render
broadcastBlob: function (id) {
      if (!this.ENABLED || !this.keyForBlob(id)) return;
      if (id === 'chat') { this.broadcastChat(); return; }
      var raw = null;
      try { raw = localStorage.getItem(this.keyForBlob(id)); } catch (e) {}
      if (raw == null) return;
      if (!this.chatLive) return;
      var body = { from: 'app' };
      if (raw.length < 100000) body.raw = raw;
      this.trySendRt({
        topic: this.chatTopic, event: 'broadcast', ref: String(++this.rtRef), join_ref: '1',
        payload: { type: 'broadcast', event: id, payload: body }
      });
    },

    // read a blob straight from Supabase into memory WITHOUT touching
    // localStorage (used by admin views that render photo-heavy blobs, so a
    // device storage quota can never hide records/details from them)
    fetchBlob: function (id) {
      var self = this;
      if (!this.ENABLED || !this.keyForBlob(id)) return Promise.resolve(null);
      return this.q('app_meta?id=eq.' + encodeURIComponent(id) + '&select=id,json', {}).then(function (rows) {
        if (!Array.isArray(rows) || !rows.length) return null;
        try { return JSON.parse(rows[0].json); } catch (e) { return null; }
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
              self.applyChat(r.json);
            } else {
              var curRaw = localStorage.getItem(key);
              // merge remote with local so optimistic data isn't lost
              var mergedRaw = self.mergeBlobJson(r.id, r.json, curRaw || '[]');
              if (mergedRaw !== curRaw) localStorage.setItem(key, mergedRaw);
            }
            self.connected = true;
            // dispatch trustsync so pages re-render instantly (initial load + 5s polls)
            if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
              try {
                var nm = 'trustsync:' + r.id;
                window.dispatchEvent(new window.CustomEvent(nm, { detail: { source: 'pullAll' } }));
              } catch (e) {}
            }
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
        // optimistic broadcast for all blobs; array blobs are merged on receive so stale devices can't overwrite
        var rawNow = null;
        try { rawNow = localStorage.getItem(key); } catch (e) { rawNow = null; }
        if (rawNow && rawNow.length < 100000 && self.chatLive) {
          var body = { from: 'app', raw: rawNow, optimistic: true };
          self.trySendRt({
            topic: self.chatTopic, event: 'broadcast', ref: String(++self.rtRef), join_ref: '1',
            payload: { type: 'broadcast', event: id, payload: body }
          });
        }
        timers[id] = setTimeout(function () {
          var raw = null;
          try { raw = localStorage.getItem(key); } catch (e) { raw = null; }
          if (raw == null) return;
          self.pending[id] = true;
          var op = id === 'chat' ? self.upsertChatMerged(raw) : self.upsertBlob(id, raw);
          // broadcast AFTER the Supabase write succeeds so receivers pull fresh data
          op.then(function () {
            delete self.pending[id];
            self.broadcastBlob(id);
          }, function () { delete self.pending[id]; });
        }, id === 'chat' ? 150 : 400);
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
      // realtime websocket for instant chat delivery (connects in background)
      setTimeout(function () { self.connectChat(); }, 1200);
    }
  };

  global.DB = DB;
  DB.start();
})(window);