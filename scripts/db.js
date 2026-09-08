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

    // Bootstrap: load initial data
    _bootstrap: function () {
      var self = this;
      var tables = [
        { t: 'users', k: 'uid' },
        { t: 'user_balances', k: 'uid' },
        { t: 'verifications', k: 'uid' },
        { t: 'loans', k: 'id' },
        { t: 'transactions', k: 'id' },
        { t: 'trades', k: 'id' },
        { t: 'ai_orders', k: 'id' },
        { t: 'chat_messages', k: 'uid' },
        { t: 'coin_addresses', k: 'coin' },
        { t: 'admin_settings', k: 'key' }
      ];
      Promise.all(tables.map(function (x) {
        return self._loadTable(x.t, x.k).catch(function (e) {
          console.warn('TrustDB load failed for ' + x.t + ':', e.message || e);
          return 0;
        });
      })).then(function () {
        self.connected = true;
        self.lastSync = Date.now();
        self._notify('ready');
        // Dispatch trustsync events so pages re-render with loaded data
        tables.forEach(function (x) {
          if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
            try {
              window.dispatchEvent(new window.CustomEvent('trustsync:' + x.t, { detail: { source: 'bootstrap' } }));
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
      table = this._canonical(table);
      return this._loadTable(table, this._keyField(table));
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
        } else if (Array.isArray(cache)) {
          cache.length = 0;
          rows.forEach(function (r) { cache.push(r); });
        } else {
          var kmap = {};
          rows.forEach(function (r) { kmap[r[keyField]] = r; });
          Object.assign(cache, kmap);
        }
        return rows.length;
      });
    },

    // Core REST call
    q: function (path, opts) {
      opts = opts || {};
      if (!this.ENABLED) return Promise.resolve(null);
      var self = this;
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
        return res.json().then(function (data) {
          var method = (opts.method || 'GET').toUpperCase();
          if (method !== 'GET' && opts.refreshCache !== false) {
            // Keep the in-memory cache current after any write so subsequent
            // reads immediately reflect the new state.
            self._refreshTable(path.split('?')[0]);
          }
          return data;
        });
      });
    },

    // Table name -> key field used to dedupe cache rows
    _keyField: function (table) {
      table = this._canonical(table);
      return table === 'users' ? 'uid' :
             table === 'user_balances' ? 'uid' :
             table === 'verifications' ? 'uid' :
             table === 'loans' ? 'id' :
             table === 'transactions' ? 'id' :
             table === 'trades' ? 'id' :
             table === 'ai_orders' ? 'id' :
             table === 'chat_messages' ? 'uid' :
             table === 'coin_addresses' ? 'coin' : 'key';
    },

    // Legacy short/alias table names -> real Supabase tables
    _canonical: function (table) {
      var aliases = {
        txns: 'transactions',
        transaction: 'transactions',
        balances: 'user_balances',
        balance: 'user_balances',
        chats: 'chat_messages',
        chat: 'chat_messages',
        aiorders: 'ai_orders',
        orders: 'ai_orders',
        ai: 'ai_orders'
      };
      return aliases[table] || table;
    },

    // Dispatch trustsync:<name> for the canonical table plus every legacy
    // alias so old pages re-render on realtime/write events.
    _dispatchTrustSync: function (table) {
      if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
      var names = [table];
      var aliases = { txns: 'transactions', transactions: 'transactions', balances: 'user_balances', user_balances: 'user_balances', chats: 'chat_messages', chat: 'chat_messages', chat_messages: 'chat_messages', aiorders: 'ai_orders', orders: 'ai_orders', ai_orders: 'ai_orders' };
      for (var a in aliases) if (aliases[a] === table && names.indexOf(a) === -1) names.push(a);
      names.forEach(function (n) {
        try { window.dispatchEvent(new window.CustomEvent('trustsync:' + n, { detail: {} })); } catch (e) {}
      });
    },

    // Reload one table into cache after a local write, then notify pages.
    _refreshTable: function (table) {
      var self = this;
      table = self._canonical(table);
      var known = ['users', 'user_balances', 'verifications', 'loans', 'transactions', 'trades', 'ai_orders', 'chat_messages', 'coin_addresses', 'admin_settings'];
      if (known.indexOf(table) === -1) return Promise.resolve(true);
      return self._loadTable(table, self._keyField(table)).then(function () {
        self._dispatchTrustSync(table);
        return true;
      }).catch(function () { return false; });
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
      // compat: dispatch trustsync events for legacy pages (canonical + aliases)
      self._dispatchTrustSync(table);
    },

    // Event system
    _listeners: {},
    on: function (event, fn) { (this._listeners[event] = this._listeners[event] || []).push(fn); },
    off: function (event, fn) { var a = this._listeners[event]; if (a) this._listeners[event] = a.filter(function (f) { return f !== fn; }); },
    _notify: function (event, data) { var a = this._listeners[event]; if (a) a.forEach(function (f) { try { f(data); } catch (e) {} }); },

    // ===== Public API =====

    // Users
    getUsers: function () { return this._cache.users.slice().sort(function (a, b) { return (b.created_at || 0) - (a.created_at || 0); }); },
    getUser: function (uid) { return this._cache.users.find(function (u) { return String(u.uid) === String(uid); }); },
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
    deleteUser: function (uid) {
      var self = this;
      // RLS blocks FK cascade when deleting through the anon key, so remove
      // child rows first, then the user.
      var tables = ['user_balances', 'verifications', 'loans', 'transactions', 'trades', 'ai_orders', 'chat_messages'];
      return tables.reduce(function (p, t) {
        return p.then(function () {
          return self.q(t + '?uid=eq.' + uid, { method: 'DELETE' }).catch(function () {});
        });
      }, Promise.resolve()).then(function () {
        return self.q('users?uid=eq.' + uid, { method: 'DELETE' });
      });
    },

    // Balances
    // Live rows store uid as BIGINT (number); the UI often queries with a
    // string, so match either numeric form.
    _balanceMap: function (uid) {
      var b = this._cache.userBalances;
      if (b) {
        var m = b[uid] || b[String(uid)] || b[Number(uid)] || null;
        if (m) return m;
      }
      return null;
    },
    getBalance: function (uid, coin) {
      var b = this._balanceMap(uid);
      return b ? (parseFloat(b[coin]) || 0) : 0;
    },
    getAllBalances: function (uid) { return this._balanceMap(uid) || {}; },
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
    getVerification: function (uid) { return this._cache.verifications[uid] || this._cache.verifications[String(uid)] || this._cache.verifications[Number(uid)] || null; },
    getAllVerifications: function () { return Object.values(this._cache.verifications); },
    submitVerification: function (uid, data) {
      var payload = Object.assign({ uid: uid }, data, { status: data.status || 'pending', submitted_at: new Date().toISOString() });
      // Convert camelCase to snake_case for database
      var converted = {};
      for (var k in payload) {
        var snake = k.replace(/([A-Z])/g, function (m) { return '_' + m.toLowerCase(); });
        converted[snake] = payload[k];
      }
      return this.q('verifications', { method: 'POST', body: converted }).then(function (rows) { return rows[0]; });
    },

    // Ensure local cache reflects a verification row (after admin actions)
    refreshVerification: function (uid) {
      var self = this;
      return this._loadTable('verifications', 'uid').catch(function () {});
    },
    updateVerificationStatus: function (uid, status, extra) {
      var patch = Object.assign({ status: status, reviewed_at: new Date().toISOString() }, extra || {});
      var converted = {};
      for (var k in patch) {
        var snake = k.replace(/([A-Z])/g, function (m) { return '_' + m.toLowerCase(); });
        converted[snake] = patch[k];
      }
      return this.q('verifications?uid=eq.' + uid, { method: 'PATCH', body: converted });
    },
    updateVerificationAdvanced: function (uid, fields) {
      var patch = Object.assign({}, fields || {});
      var converted = {};
      for (var k in patch) {
        var snake = k.replace(/([A-Z])/g, function (m) { return '_' + m.toLowerCase(); });
        converted[snake] = patch[k];
      }
      return this.q('verifications?uid=eq.' + uid, { method: 'PATCH', body: converted });
    },

    // Loans
    getLoans: function () { return this._cache.loans.slice().sort(function (a, b) { return (b.created_at || 0) - (a.created_at || 0); }); },
    getLoansForUser: function (uid) { return this._cache.loans.filter(function (l) { return String(l.uid) === String(uid); }); },
    getLoan: function (id) { return this._cache.loans.find(function (l) { return l.id === id; }); },
    addLoan: function (data) {
      var payload = Object.assign({}, data, { status: 'pending', created_at: new Date().toISOString() });
      if (!payload.id) payload.id = 'LOAN_' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1000);
      var converted = {};
      for (var k in payload) {
        var snake = k.replace(/([A-Z])/g, function (m) { return '_' + m.toLowerCase(); });
        converted[snake] = payload[k];
      }
      return this.q('loans', { method: 'POST', body: converted }).then(function (rows) { return rows[0]; });
    },
    updateLoanStatus: function (id, status, extra) {
      var self = this;
      var patch = Object.assign({ status: status }, extra || {});
      if (status === 'approved') patch.approved_at = new Date().toISOString();
      if (status === 'repaid') patch.repaid_at = new Date().toISOString();
      var converted = {};
      for (var k in patch) {
        var snake = k.replace(/([A-Z])/g, function (m) { return '_' + m.toLowerCase(); });
        converted[snake] = patch[k];
      }
      return this.q('loans?id=eq.' + id, { method: 'PATCH', body: converted }).catch(function (err) {
        // Pre-migration fallback: some live loans tables have a BEFORE UPDATE
        // trigger that writes NEW.updated_at although the column does not exist
        // (PostgREST 400 / 42703), and INSERT/DELETE are still allowed. Re-create
        // the row with the new status instead of failing the admin action.
        var existing = self.getLoan(id);
        if (!existing) throw err;
        var payload = {};
        for (var pk in existing) {
          if (pk === 'id' || existing[pk] === undefined) continue;
          var sk = pk.replace(/([A-Z])/g, function (m) { return '_' + m.toLowerCase(); });
          payload[sk] = existing[pk];
        }
        for (var ck in converted) payload[ck] = converted[ck];
        payload.id = String(id);
        return self.q('loans?id=eq.' + String(id), { method: 'DELETE' }).then(function () {
          return self.q('loans', { method: 'POST', body: payload }).then(function (rows) { return rows[0]; });
        });
      });
    },

    // Transactions
    getTransactions: function () { return this._cache.transactions.slice(); },
    getTransactionsForUser: function (uid) { return this._cache.transactions.filter(function (t) { return String(t.uid) === String(uid); }); },
    addTransaction: function (data) {
      var payload = Object.assign({}, data, { created_at: new Date().toISOString() });
      // Convert camelCase to snake_case for database
      var converted = {};
      for (var k in payload) {
        var snake = k.replace(/([A-Z])/g, function (m) { return '_' + m.toLowerCase(); });
        converted[snake] = payload[k];
      }
      var self = this;
      return this.q('transactions', { method: 'POST', body: converted }).then(function (rows) { return rows[0]; })
        .catch(function (err) {
          // Tolerate tables that predate the proof/proof_name columns (install a
          // column, not break the deposit): retry without the image columns. The
          // attachment is stashed inside description so it is never lost and can
          // be surfaced by dbTxnToApp even before the migration adds columns.
          if (converted.proof !== undefined || converted.proof_name !== undefined) {
            var slim = {};
            for (var k in converted) if (k !== 'proof' && k !== 'proof_name') slim[k] = converted[k];
            if (converted.proof) {
              slim.description = (slim.description || '') + '\n' + '[PROOF_ATTACHMENT]' + JSON.stringify({ name: converted.proof_name || 'proof', data: converted.proof });
            }
            return self.q('transactions', { method: 'POST', body: slim }).then(function (rows) { return rows[0]; });
          }
          throw err;
        });
    },
    setTransactionStatus: function (id, status) {
      return this.q('transactions?id=eq.' + id, { method: 'PATCH', body: { status: status } });
    },

    // Trades
    getTrades: function () { return this._cache.trades.slice().sort(function (a, b) { return (b.opened_at || 0) - (a.opened_at || 0); }); },
    getTradesForUser: function (uid) { return this._cache.trades.filter(function (t) { return String(t.uid) === String(uid); }); },

    // AI Orders
    getAIOrders: function () { return this._cache.aiOrders.slice().sort(function (a, b) { return (b.created_at || 0) - (a.created_at || 0); }); },

    // Chat
    getChat: function (uid) { return (this._cache.chatMessages[uid] || []).slice().sort(function (a, b) { return (a.created_at || 0) - (b.created_at || 0); }); },
    getChatUsers: function () { return Object.keys(this._cache.chatMessages).map(function (k) { return parseInt(k, 10); }); },
    sendChatMessage: function (uid, fromRole, message, extra) {
      var payload = { uid: uid, from_role: fromRole, message: message, created_at: new Date().toISOString() };
      for (var k in (extra || {})) if (extra[k] !== undefined) payload[k] = extra[k];
      var converted = {};
      for (var k in payload) {
        var snake = k.replace(/([A-Z])/g, function (m) { return '_' + m.toLowerCase(); });
        converted[snake] = payload[k];
      }
      return this.q('chat_messages', { method: 'POST', body: converted }).then(function (rows) { return rows[0]; });
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
    saveCoinAddress: function (coin, net, addr) {
      var self = this;
      return this.q('coin_addresses', { method: 'POST', body: { coin: coin, network: net, address: addr, is_active: true } })
        .then(function (rows) { return rows[0]; })
        .catch(function () { return self.q('coin_addresses?coin=eq.' + coin, { method: 'PATCH', body: { address: addr, network: net, is_active: true } }); });
    },
    deleteCoinAddress: function (coin) {
      return this.q('coin_addresses?coin=eq.' + coin, { method: 'DELETE' });
    },

    // Admin Settings
    getSetting: function (key) { return this._cache.adminSettings[key] || null; },
    setSetting: function (key, value) {
      return this.q('admin_settings', { method: 'POST', body: { key: key, value: value } })
        .catch(function () { return this.q('admin_settings?key=eq.' + key, { method: 'PATCH', body: { value: value } }); }.bind(this));
    },

    // Auth helpers
    register: function (account, password) {
      var self = this;
      // PostgREST filters broken - check existence client-side
      return self.q('users?select=uid,account&limit=1000', {}).then(function (rows) {
        if (rows.some(function (u) { return u.account && String(u.account).toLowerCase() === String(account).toLowerCase(); })) throw new Error('Account exists');
        var used = {};
        (self._cache.users || []).forEach(function (u) { if (u && u.uid != null) used[String(u.uid)] = true; });
        rows.forEach(function (u) { if (u && u.uid != null) used[String(u.uid)] = true; });
        // Hash password using created_at as salt for consistent verification
        var createdAt = new Date().toISOString();
        var hash = self._hashPassword(password, createdAt);
        function createWithUid(retries) {
          if (retries <= 0) return Promise.reject(new Error('Could not generate a unique UID, please try again'));
          var uid = parseInt(self._genUid(used), 10);
          return self.createUser(account, hash, { uid: uid, created_at: createdAt }).then(function (user) {
            // Initialize zero balances
            ['USDT', 'TRX', 'BTC', 'ETH', 'BNB'].forEach(function (c) {
              self.addBalance(user.uid, c, 0).catch(function () {});
            });
            return { ok: true, user: user };
          }).catch(function (e) {
            if (e && /23505|duplicate.*key/i.test(e.message)) return createWithUid(retries - 1);
            throw e;
          });
        }
        return createWithUid(5);
      });
    },

    // Generate a unique 6-digit UID (100000-999999)
    _genUid: function (used) {
      used = used || {};
      var uid;
      do { uid = String(Math.floor(100000 + Math.random() * 900000)); } while (used[uid]);
      if (used[uid]) return this._genUid(used);
      return uid;
    },

    login: function (account, password) {
      var self = this;
      // PostgREST filters are broken - fetch users and filter client-side
      return this.q('users?select=uid,account,password_hash,created_at,status,is_admin&limit=1000', {}).then(function (rows) {
        var user = rows.find(function (u) { return u.account === account; });
        if (!user) throw new Error('User not found');
        // Verify using consistent hash based on created_at
        if (!self._verifyPassword(user.password_hash, password, user.created_at)) {
          throw new Error('Invalid password');
        }
        if (user.status === 'inactive') throw new Error('Account deactivated');
        return { ok: true, user: user };
      });
    },

    // Utility
    isReady: function () { return this.connected; },
    onReady: function (fn) { if (this.connected) fn(); else this.on('ready', fn); },

    // Raw user list (includes guests) for internal lookups
    usersList: function () { return this._cache.users.slice(); },
    getUserStr: function (uid) { return this._cache.users.find(function (u) { return String(u.uid) === String(uid); }) || null; },

    // Guest -> real account conversion (preserves uid >= wallet/balances)
    convertGuest: function (uid, account, passwordHash) {
      return this.q('users?uid=eq.' + uid, { method: 'PATCH', body: { account: account, password_hash: passwordHash, is_guest: false } });
    },
    setUserLanguage: function (uid, lang) {
      return this.q('users?uid=eq.' + uid, { method: 'PATCH', body: { language: lang } });
    },
    setUserProfitMode: function (uid, on) {
      return this.q('users?uid=eq.' + uid, { method: 'PATCH', body: { profit_mode: !!on } });
    },
    setUserGreeted: function (uid) {
      return this.q('users?uid=eq.' + uid, { method: 'PATCH', body: { greeted: true } });
    },
    getUserLanguage: function (uid) {
      var u = this._cache.users.find(function (x) { return String(x.uid) === String(uid); });
      return u ? (u.language || 'en') : 'en';
    },
    getUserProfitMode: function (uid) {
      var u = this._cache.users.find(function (x) { return String(x.uid) === String(uid); });
      return !!(u && u.profit_mode);
    },
    getUserGreeted: function (uid) {
      var u = this._cache.users.find(function (x) { return String(x.uid) === String(uid); });
      return !!(u && u.greeted);
    },

    // Sessions (server-side login / guest / admin-lock state)
    createSession: function (token, uid, extra) {
      var payload = { token: token, uid: uid == null ? null : uid };
      for (var k in (extra || {})) if (extra[k] !== undefined) payload[k] = extra[k];
      payload.created_at = new Date().toISOString();
      payload.expires_at = new Date(Date.now() + 30 * 24 * 3600000).toISOString();
      return this.q('sessions', { method: 'POST', body: payload }).then(function (rows) { return rows[0]; });
    },
    getSession: function (token) {
      return this.q('sessions?token=eq.' + encodeURIComponent(token) + '&select=*&limit=1', {}).then(function (rows) { return rows[0] || null; });
    },
    updateSession: function (token, patch) {
      return this.q('sessions?token=eq.' + encodeURIComponent(token), { method: 'PATCH', body: patch });
    },
    deleteSession: function (token) {
      return this.q('sessions?token=eq.' + encodeURIComponent(token), { method: 'DELETE' });
    },

    // Trades writes
    addTrade: function (data) {
      var payload = Object.assign({}, data, { opened_at: new Date().toISOString() });
      if (payload.created_at) delete payload.created_at;
      if (payload.settledAt != null) { payload.settled_at = payload.settledAt; delete payload.settledAt; }
      if (payload.sellPrice != null) { payload.sell_price = payload.sellPrice; delete payload.sellPrice; }
      return this.q('trades', { method: 'POST', body: payload }).then(function (rows) { return rows[0]; });
    },
    updateTrade: function (id, patch) {
      var p = Object.assign({}, patch || {});
      if (p.settledAt != null) { p.settled_at = p.settledAt; delete p.settledAt; }
      if (p.sellPrice != null) { p.sell_price = p.sellPrice; delete p.sellPrice; }
      if (p.closedAt != null) { p.closed_at = p.closedAt; delete p.closedAt; }
      if (p.id) delete p.id;
      return this.q('trades?id=eq.' + id, { method: 'PATCH', body: p });
    },

    // AI orders writes
    addAIOrder: function (data) {
      var payload = Object.assign({}, data, { created_at: new Date().toISOString() });
      return this.q('ai_orders', { method: 'POST', body: payload }).then(function (rows) { return rows[0]; });
    },
    updateAIOrder: function (id, patch) {
      var p = Object.assign({}, patch || {});
      if (p.schedules && typeof p.schedules === 'object') p.schedules = JSON.stringify(p.schedules);
      if (p.id) delete p.id;
      return this.q('ai_orders?id=eq.' + id, { method: 'PATCH', body: p });
    },

    // Chat edits / soft-delete
    editChatMessage: function (uid, id, text) {
      return this.q('chat_messages?uid=eq.' + uid + '&id=eq.' + id, { method: 'PATCH', body: { message: text, edited_at: new Date().toISOString() } });
    },
    deleteChatMessage: function (uid, id) {
      return this.q('chat_messages?uid=eq.' + uid + '&id=eq.' + id, { method: 'PATCH', body: { deleted: true } });
    }
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