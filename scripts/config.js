/* TrustCom static clone — Supabase connection settings.
   Loaded BEFORE app.js on every page. Edit the three values below, or set
   them from the in-app "Database" setup page (stored in trustDbConfig). */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------
  //  EDIT THESE to point at YOUR Supabase project.
  // ---------------------------------------------------------------
  // Create a table: Supabase dashboard -> Project Settings -> API.
  // (The trailing /rest/v1/ is added automatically; don't include it.)
  var DB_URL = 'https://ilqgldgilsmbillfuham.supabase.co';
  var DB_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlscWdsZGdpbHNtYmlsbGZ1aGFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg1OTYyMDIsImV4cCI6MjEwNDE3MjIwMn0.JkgdRwafJ-hvvM3YvnVqbDCY7OeqttgkaAxnN7iB-e8';
  // The service-role key is NOT stored here (this file can be public).
  // The Node import tool reads it from scripts/../supabase/service-key.txt
  // or the SUPABASE_SERVICE_KEY env var instead.
  var DB_SERVICE_KEY = '';

  // When true, the site can read from Supabase but only writes to the
  // app_meta blob table (shared settings/leaderboard data). Detailed tables
  // stay service-role/SQL only.
  var READONLY = true;

  var saved = null;
  try { saved = JSON.parse(localStorage.getItem('trustDbConfig') || 'null'); } catch (e) { saved = null; }
  if (saved && typeof saved === 'object') {
    if (saved.url) DB_URL = saved.url;
    if (saved.anon) DB_ANON_KEY = saved.anon;
    if (saved.service) DB_SERVICE_KEY = saved.service;
    if (saved.readonly !== undefined) READONLY = !!saved.readonly;
  }

  // Normalize: strip trailing slashes and any /rest/v1 suffix.
  DB_URL = String(DB_URL || '').trim().replace(/\/rest\/v1\/*$/, '').replace(/\/+$/, '');

  global.SITE_CONFIG = {
    DB_URL: DB_URL,
    DB_ANON_KEY: DB_ANON_KEY,
    DB_SERVICE_KEY: DB_SERVICE_KEY,
    READONLY: READONLY,
    ENABLED: !!DB_URL && DB_URL.indexOf('YOUR-PROJECT') === -1 && !!DB_ANON_KEY && DB_ANON_KEY.indexOf('YOUR-PROJECT') === -1
  };
})(window);