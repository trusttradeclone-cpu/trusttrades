/*
 * TrustDB — Traditional Tables + Realtime
 * Replaces blob storage with proper Supabase tables.
 * All data persists in DB, realtime pushes to all open pages instantly.
 */
var TrustDB = (function () {
  'use strict';

  var self = {
    url: null,
    anon: null,
    service: null,
    ENABLED: false,
    READONLY: true,
    connected: false,
    lastSync: 0,

    // Local caches (in-memory, refreshed from DB)
    _cache: {
      users: [],
      userBalances: {},
      verifications: {},
      loans: [],
      transactions: [],
      trades: [],
      aiOrders: [],
      chatMessages: {},
      coinAddresses: {},
      adminSettings: {}
    },

    // Realtime channels
    _channels: {},

    // Init from config
    init: function (cfg) {
      if (!cfg) return false;
      this.url = cfg.url;
      this.anon = cfg.anon;
      this.service = cfg.service || '';
      this.READONLY = !!cfg.readonly;
      this.ENABLED = true;
      
      // Create init promise that resolves when bootstrap + realtime are ready
      var self = this;
      this._initPromise = new Promise(function (resolve) {
        self._bootstrap();
        // wait for supabase client then start realtime
        if (typeof window !== 'undefined') {
          function tryStart() {
            if (window.supabase && window.supabase.channel) {
              self._startRealtime();
              resolve(true);
            } else {
              setTimeout(tryStart, 100);
            }
          }
          tryStart();
        } else {
          resolve(true);
        }
      });
      
      return true;
    },

    // Wait for DB to be fully initialized (bootstrap + realtime)
    ready: function () {
      return this._initPromise || Promise.resolve(false);
    },

    // Clean up old blob localStorage on first load
    _cleanupOldBlobs: function () {
      var oldKeys = ['trustUsers', 'trustBalances', 'trustVerifications', 'trustLoans', 'trustTxns', 'trustTrades', 'trustAIOrders', 'trustChat', 'trustChatGreeted', 'trustAddresses', 'trustConfig', 'trustProfitMode', 'trustDbLastSync'];
      oldKeys.forEach(function (k) { try { localStorage.removeItem(k); } catch (e) {} });
      // mark cleaned
      try { localStorage.setItem('trustBlobsCleaned', '1'); } catch (e) {}
    },

    // Bootstrap: load initial data
    _bootstrap: function () {
      var self = this;
      if (!localStorage.getItem('trustBlobsCleaned')) self._cleanupOldBlobs();
      Promise.all([
        self._loadTable('users', 'uid'),
        self._loadTable('user_balances', 'uid'),
        self._loadTable('verifications', 'uid'),
        self._loadTable('loans', 'id'),
        self._loadTable('transactions', 'id'),
        self._loadTable('trades', 'id'),
        self._loadTable('ai_orders', 'id'),
        self._loadTable('chat_messages', 'uid'),
        self._loadTable('coin_addresses', 'coin'),
        self._loadTable('admin_settings', 'key')
      ]).then(function () {
        self.connected = true;
        self.lastSync = Date.now();
        self._notify('ready');
        // Dispatch trustsync events so pages re-render with loaded data
        var tables = ['users', 'user_balances', 'verifications', 'loans', 'transactions', 'trades', 'ai_orders', 'chat_messages', 'coin_addresses', 'admin_settings'];
        tables.forEach(function (t) {
          if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
            try {
              window.dispatchEvent(new window.CustomEvent('trustsync:' + t, { detail: { source: 'bootstrap' } }));
            } catch (e) {}
          }
        });
      }).catch(function (e) {
        console.warn('TrustDB bootstrap failed:', e);
        self.connected = false;
      });
    },

    // compat: pullBlob refreshes a table from Supabase
    pullBlob: function (table) {
      var self = this;
      var keyField = table === 'users' ? 'uid' :
                     table === 'user_balances' ? 'uid' :
                     table === 'verifications' ? 'uid' :
                     table === 'loans' ? 'id' :
                     table === 'transactions' ? 'id' :
                     table === 'trades' ? 'id' :
                     table === 'ai_orders' ? 'id' :
                     table === 'chat_messages' ? 'uid' :
                     table === 'coin_addresses' ? 'coin' : 'key';
      return self._loadTable(table, keyField);
    },

    // Generic table loader
    _loadTable: function (table, keyField) {
      var self = this;
      return this.q(table + '?select=*&order=' + keyField + '.asc', {}).then(function (rows) {
        var cache = self._cache[table === 'user_balances' ? 'userBalances' :
                      table === 'coin_addresses' ? 'coinAddresses' :
                      table === 'admin_settings' ? 'adminSettings' :
                      table === 'chat_messages' ? 'chatMessages' :
                      table === 'ai_orders' ? 'aiOrders' : table];
        if (table === 'user_balances') {
          var map = {};
          rows.forEach(function (r) { map[r.uid] = map[r.uid] || {}; map[r.uid][r.coin] = r.amount; });
          self._cache.userBalances = map;
        } else if (table === 'chat_messages') {
          var cmap = {};
          rows.forEach(function (r) { cmap[r.uid] = cmap[r.uid] || []; cmap[r.uid].push(r); });
          self._cache.chatMessages = cmap;
        } else if (table === 'admin_settings') {
          var smap = {};
          rows.forEach(function (r) { smap[r.key] = r.value; });
          self._cache.adminSettings = smap;
        } else if (Array.isArray(rows)) {
          if (keyField === 'id' && table !== 'loans') {
            cache.length = 0;
            rows.forEach(function (r) { cache.push(r); });
          } else if (keyField === 'uid' || keyField === 'coin') {
            var kmap = {};
            rows.forEach(function (r) { kmap[r[keyField]] = r; });
            Object.assign(cache, kmap);
          } else {
            cache.length = 0;
            rows.forEach(function (r) { cache.push(r); });
          }
        }
        return rows.length;
      });
    },

    // Core REST call
    q: function (path, opts) {
      opts = opts || {};
      if (!this.ENABLED) return Promise.resolve(null);
      var headers = {
        'apikey': this.anon,
        'Authorization': 'Bearer ' + this.anon,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      };
      if (opts.headers) for (var h in opts.headers) headers[h] = opts.headers[h];
      var init = { method: opts.method || 'GET', headers: headers };
      if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
      return fetch(this.url + '/rest/v1/' + path, init).then(function (res) {
        if (!res.ok) return res.text().then(function (t) { throw new Error('HTTP ' + res.status + ' ' + path + ': ' + t); });
        if (opts.text) return res.text();
        if (opts.noContent) return null;
        return res.json();
      });
    },

    // Realtime subscriptions
    _startRealtime: function () {
      var self = this;
      var tables = ['users', 'user_balances', 'verifications', 'loans', 'transactions', 'trades', 'ai_orders', 'chat_messages', 'coin_addresses', 'admin_settings'];
      tables.forEach(function (table) {
        self._subscribeTable(table);
      });
    },

    _subscribeTable: function (table) {
      var self = this;
      if (typeof window === 'undefined' || !window.supabase) return;
      try {
        var channel = window.supabase.channel('db_' + table)
          .on('postgres_changes', { event: '*', schema: 'public', table: table }, function (payload) {
            self._handleRealtime(table, payload);
          })
          .subscribe(function (status) {
            if (status === 'SUBSCRIBED') console.log('Realtime: ' + table + ' subscribed');
          });
        self._channels[table] = channel;
      } catch (e) { console.warn('Realtime subscribe failed for ' + table, e); }
    },

    _handleRealtime: function (table, payload) {
      var self = this;
      var eventType = payload.eventType; // INSERT, UPDATE, DELETE
      var newRecord = payload.new;
      var oldRecord = payload.old;

      switch (table) {
        case 'users':
          if (eventType === 'DELETE') {
            self._cache.users = self._cache.users.filter(function (u) { return u.uid !== oldRecord.uid; });
          } else {
            var idx = self._cache.users.findIndex(function (u) { return u.uid === newRecord.uid; });
            if (idx >= 0) self._cache.users[idx] = newRecord;
            else self._cache.users.push(newRecord);
          }
          break;
        case 'user_balances':
          if (eventType === 'DELETE') {
            if (self._cache.userBalances[oldRecord.uid]) delete self._cache.userBalances[oldRecord.uid][oldRecord.coin];
          } else {
            self._cache.userBalances[newRecord.uid] = self._cache.userBalances[newRecord.uid] || {};
            self._cache.userBalances[newRecord.uid][newRecord.coin] = newRecord.amount;
          }
          break;
        case 'verifications':
          if (eventType === 'DELETE') delete self._cache.verifications[oldRecord.uid];
          else self._cache.verifications[newRecord.uid] = newRecord;
          break;
        case 'loans':
          if (eventType === 'DELETE') self._cache.loans = self._cache.loans.filter(function (l) { return l.id !== oldRecord.id; });
          else {
            var lidx = self._cache.loans.findIndex(function (l) { return l.id === newRecord.id; });
            if (lidx >= 0) self._cache.loans[lidx] = newRecord;
            else self._cache.loans.push(newRecord);
          }
          break;
        case 'transactions':
          if (eventType === 'DELETE') self._cache.transactions = self._cache.transactions.filter(function (t) { return t.id !== oldRecord.id; });
          else {
            var tidx = self._cache.transactions.findIndex(function (t) { return t.id === newRecord.id; });
            if (tidx >= 0) self._cache.transactions[tidx] = newRecord;
            else self._cache.transactions.unshift(newRecord); // newest first
          }
          break;
        case 'trades':
          if (eventType === 'DELETE') self._cache.trades = self._cache.trades.filter(function (t) { return t.id !== oldRecord.id; });
          else {
            var tridx = self._cache.trades.findIndex(function (t) { return t.id === newRecord.id; });
            if (tridx >= 0) self._cache.trades[tridx] = newRecord;
            else self._cache.trades.push(newRecord);
          }
          break;
        case 'ai_orders':
          if (eventType === 'DELETE') self._cache.aiOrders = self._cache.aiOrders.filter(function (o) { return o.id !== oldRecord.id; });
          else {
            var oidx = self._cache.aiOrders.findIndex(function (o) { return o.id === newRecord.id; });
            if (oidx >= 0) self._cache.aiOrders[oidx] = newRecord;
            else self._cache.aiOrders.push(newRecord);
          }
          break;
        case 'chat_messages':
          if (eventType === 'DELETE') {
            if (self._cache.chatMessages[oldRecord.uid]) {
              self._cache.chatMessages[oldRecord.uid] = self._cache.chatMessages[oldRecord.uid].filter(function (m) { return m.id !== oldRecord.id; });
            }
          } else {
            self._cache.chatMessages[newRecord.uid] = self._cache.chatMessages[newRecord.uid] || [];
            var mf = self._cache.chatMessages[newRecord.uid].findIndex(function (m) { return m.id === newRecord.id; });
            if (mf >= 0) self._cache.chatMessages[newRecord.uid][mf] = newRecord;
            else self._cache.chatMessages[newRecord.uid].push(newRecord);
          }
          break;
        case 'coin_addresses':
          if (eventType === 'DELETE') delete self._cache.coinAddresses[oldRecord.coin];
          else self._cache.coinAddresses[newRecord.coin] = newRecord;
          break;
        case 'admin_settings':
          if (eventType === 'DELETE') delete self._cache.adminSettings[oldRecord.key];
          else self._cache.adminSettings[newRecord.key] = newRecord.value;
          break;
      }
      self._notify('change:' + table, { event: eventType, record: newRecord, old: oldRecord });
      self._notify('change', { table: table, event: eventType });
      // compat: dispatch trustsync events for legacy pages
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        try {
          window.dispatchEvent(new window.CustomEvent('trustsync:' + table, { detail: { source: 'realtime', event: eventType } }));
        } catch (e) {}
      }
    },

    // Event system
    _listeners: {},
    on: function (event, fn) { (this._listeners[event] = this._listeners[event] || []).push(fn); },
    off: function (event, fn) { var a = this._listeners[event]; if (a) this._listeners[event] = a.filter(function (f) { return f !== fn; }); },
    _notify: function (event, data) { var a = this._listeners[event]; if (a) a.forEach(function (f) { try { f(data); } catch (e) {} }); },

    // ===== Public API =====

    // Users
    getUsers: function () { return this._cache.users.slice().sort(function (a, b) { return (b.created_at || 0) - (a.created_at || 0); }); },
    getUser: function (uid) { return this._cache.users.find(function (u) { return u.uid === uid; }); },
    getUserByReferralCode: function (code) { return this._cache.users.find(function (u) { return u.referral_code === code; }); },
    createUser: function (account, passwordHash, extra) {
      var self = this;
      var payload = Object.assign({ account: account, password_hash: passwordHash }, extra || {});
      return this.q('users', { method: 'POST', body: payload }).then(function (rows) {
        return rows[0];
      });
    },
    // Generate consistent password hash using created_at as salt
    _hashPassword: function (password, createdAt) {
      return 'hash_' + btoa(password + ':' + (createdAt || new Date().toISOString()).slice(0, 10));
    },
    // Verify password against stored hash
    _verifyPassword: function (hash, password, createdAt) {
      return hash === this._hashPassword(password, createdAt);
    },
    updateUser: function (uid, patch) {
      return this.q('users?uid=eq.' + uid, { method: 'PATCH', body: patch });
    },

    // Balances
    getBalance: function (uid, coin) {
      var b = this._cache.userBalances[uid];
      return b ? (parseFloat(b[coin]) || 0) : 0;
    },
    getAllBalances: function (uid) { return this._cache.userBalances[uid] || {}; },
    addBalance: function (uid, coin, delta) {
      var self = this;
      var current = self.getBalance(uid, coin);
      var next = Math.max(0, current + delta);
      return this.q('user_balances', { method: 'POST', body: { uid: uid, coin: coin, amount: next } })
        .then(function () { return next; })
        .catch(function () { return self.q('user_balances?uid=eq.' + uid + '&coin=eq.' + coin, { method: 'PATCH', body: { amount: next } }).then(function () { return next; }); });
    },
    setBalance: function (uid, coin, amount) {
      return this.addBalance(uid, coin, amount - this.getBalance(uid, coin));
    },

    // Verifications
    getVerification: function (uid) { return this._cache.verifications[uid] || null; },
    getAllVerifications: function () { return Object.values(this._cache.verifications); },
    submitVerification: function (uid, data) {
      var payload = Object.assign({ uid: uid }, data, { status: 'pending', submitted_at: new Date().toISOString() });
      return this.q('verifications', { method: 'POST', body: payload }).then(function (rows) { return rows[0]; });
    },
    updateVerificationStatus: function (uid, status, extra) {
      var patch = Object.assign({ status: status, reviewed_at: new Date().toISOString() }, extra || {});
      return this.q('verifications?uid=eq.' + uid, { method: 'PATCH', body: patch });
    },

    // Loans
    getLoans: function () { return this._cache.loans.slice().sort(function (a, b) { return (b.created_at || 0) - (a.created_at || 0); }); },
    getLoansForUser: function (uid) { return this._cache.loans.filter(function (l) { return l.uid === uid; }); },
    getLoan: function (id) { return this._cache.loans.find(function (l) { return l.id === id; }); },
    addLoan: function (data) {
      var payload = Object.assign({}, data, { status: 'pending', created_at: new Date().toISOString() });
      return this.q('loans', { method: 'POST', body: payload }).then(function (rows) { return rows[0]; });
    },
    updateLoanStatus: function (id, status, extra) {
      var patch = Object.assign({ status: status }, extra || {});
      if (status === 'approved') patch.approved_at = new Date().toISOString();
      if (status === 'repaid') patch.repaid_at = new Date().toISOString();
      return this.q('loans?id=eq.' + id, { method: 'PATCH', body: patch });
    },

    // Transactions
    getTransactions: function () { return this._cache.transactions.slice(); },
    getTransactionsForUser: function (uid) { return this._cache.transactions.filter(function (t) { return t.uid === uid; }); },
    addTransaction: function (data) {
      var payload = Object.assign({}, data, { created_at: new Date().toISOString() });
      return this.q('transactions', { method: 'POST', body: payload }).then(function (rows) { return rows[0]; });
    },

    // Trades
    getTrades: function () { return this._cache.trades.slice().sort(function (a, b) { return (b.opened_at || 0) - (a.opened_at || 0); }); },
    getTradesForUser: function (uid) { return this._cache.trades.filter(function (t) { return t.uid === uid; }); },

    // AI Orders
    getAIOrders: function () { return this._cache.aiOrders.slice().sort(function (a, b) { return (b.created_at || 0) - (a.created_at || 0); }); },

    // Chat
    getChat: function (uid) { return (this._cache.chatMessages[uid] || []).slice().sort(function (a, b) { return (a.created_at || 0) - (b.created_at || 0); }); },
    getChatUsers: function () { return Object.keys(this._cache.chatMessages).map(function (k) { return parseInt(k, 10); }); },
    sendChatMessage: function (uid, fromRole, message) {
      var payload = { uid: uid, from_role: fromRole, message: message, created_at: new Date().toISOString() };
      return this.q('chat_messages', { method: 'POST', body: payload }).then(function (rows) { return rows[0]; });
    },
    markChatRead: function (uid) {
      var msgs = this._cache.chatMessages[uid];
      if (!msgs) return Promise.resolve();
      var unreadIds = msgs.filter(function (m) { return m.from_role === 'user' && !m.read_at; }).map(function (m) { return m.id; });
      if (!unreadIds.length) return Promise.resolve();
      return this.q('chat_messages?uid=eq.' + uid + '&id=in.(' + unreadIds.join(',') + ')', { method: 'PATCH', body: { read_at: new Date().toISOString() } });
    },

    // Coin Addresses
    getCoinAddresses: function () { return this._cache.coinAddresses; },
    getCoinAddress: function (coin) { return this._cache.coinAddresses[coin] || null; },

    // Admin Settings
    getSetting: function (key) { return this._cache.adminSettings[key] || null; },
    setSetting: function (key, value) {
      return this.q('admin_settings', { method: 'POST', body: { key: key, value: value } })
        .catch(function () { return this.q('admin_settings?key=eq.' + key, { method: 'PATCH', body: { value: value } }); }.bind(this));
    },

    // Auth helpers
    register: function (account, password) {
      var self = this;
      // Check if user exists
      return this.q('users?account=eq.' + encodeURIComponent(account), {}).then(function (rows) {
        if (rows.length) throw new Error('Account exists');
        // Hash password using created_at as salt for consistent verification
        var createdAt = new Date().toISOString();
        var hash = self._hashPassword(password, createdAt);
        var uid = Date.now() % 1000000000;
        return self.createUser(account, hash, { uid: uid, created_at: createdAt }).then(function (user) {
          // Initialize zero balances
          ['USDT', 'TRX', 'BTC', 'ETH', 'BNB'].forEach(function (c) {
            self.addBalance(user.uid, c, 0).catch(function () {});
          });
          return { ok: true, user: user };
        });
      });
    },

    login: function (account, password) {
      var self = this;
      return this.q('users?account=eq.' + encodeURIComponent(account), {}).then(function (rows) {
        if (!rows.length) throw new Error('User not found');
        var user = rows[0];
        // Verify using consistent hash based on created_at
        if (!self._verifyPassword(user.password_hash, password, user.created_at)) {
          throw new Error('Invalid password');
        }
        return { ok: true, user: user };
      });
    },

    // Utility
    isReady: function () { return this.connected; },
    onReady: function (fn) { if (this.connected) fn(); else this.on('ready', fn); }
  };

  return self;
})();

// Backward compat: expose as DB
var DB = TrustDB;

// Auto-init from config
if (typeof SITE_CONFIG !== 'undefined') {
  DB.init({
    url: SITE_CONFIG.DB_URL,
    anon: SITE_CONFIG.DB_ANON_KEY,
    service: SITE_CONFIG.DB_SERVICE_KEY,
    readonly: SITE_CONFIG.READONLY
  });
}