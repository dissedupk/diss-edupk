
const { useState, useMemo, useEffect } = React;

// ── Storage ──────────────────────────────────────────────────────────────────
// `sms_ts` meta key — tracks last-modified ms per data key (NOT a data schema change,
// it is a sibling meta key kept inside the existing storage layer boundary).
// `sms_tombstones` meta key — records deleted item ids per list key so that stale
// cloud data CANNOT resurrect items the user explicitly deleted.

// Keys whose values are id-bearing arrays — declared here (before S) so S.set can
// reference it during deletion detection without forward-reference errors.
const _LIST_KEYS_WITH_ID = ['sms_stu','sms_pay','sms_staff','sms_spay','sms_vpay','sms_exp','sms_inv','sms_tx','sms_audit','sms_notif','sms_preq','sms_comp','sms_asset','sms_vend','sms_sbook','sms_cbook','sms_bl'];
const _TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const S = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set: (k, v) => {
    // ── Tombstone detection ── if this is a list key, compare old vs new and
    // record any disappearing ids so cloud sync can never bring them back.
    if (_LIST_KEYS_WITH_ID.indexOf(k) !== -1) {
      try {
        const oldRaw = localStorage.getItem(k);
        const oldArr = oldRaw ? JSON.parse(oldRaw) : null;
        if (Array.isArray(oldArr) && Array.isArray(v)) {
          const newIds = new Set(v.filter(it => it && it.id != null).map(it => String(it.id)));
          const removed = oldArr.filter(it => it && it.id != null && !newIds.has(String(it.id))).map(it => String(it.id));
          if (removed.length > 0) {
            const tombstones = JSON.parse(localStorage.getItem('sms_tombstones') || '{}');
            tombstones[k] = tombstones[k] || {};
            const now = Date.now();
            removed.forEach(id => { tombstones[k][id] = now; });
            // Prune entries older than TTL to keep registry small
            const cutoff = now - _TOMBSTONE_TTL_MS;
            Object.keys(tombstones).forEach(tk => {
              Object.keys(tombstones[tk]).forEach(tid => {
                if (Number(tombstones[tk][tid]) < cutoff) delete tombstones[tk][tid];
              });
              if (Object.keys(tombstones[tk]).length === 0) delete tombstones[tk];
            });
            localStorage.setItem('sms_tombstones', JSON.stringify(tombstones));
            if (window._fbAuthReady && window._fbDB) {
              window._fbDB.ref('sms/sms_tombstones').set(tombstones).catch(() => {});
            }
          }
        }
      } catch(e) {}
    }
    localStorage.setItem(k, JSON.stringify(v));
    // Stamp this key as locally-modified (skip sms_ts itself + sms_sess to avoid recursion/auth churn)
    if (k !== 'sms_ts' && k !== 'sms_sess' && k !== 'sms_tombstones') {
      try {
        const ts = JSON.parse(localStorage.getItem('sms_ts') || '{}');
        ts[k] = Date.now();
        localStorage.setItem('sms_ts', JSON.stringify(ts));
        if (window._fbAuthReady && window._fbDB) {
          window._fbDB.ref('sms/sms_ts').set(ts).catch(() => {});
        }
      } catch(e) {}
    }
    if (window._fbAuthReady && window._fbDB) {
      window._fbDB.ref('sms/' + k).set(v).catch(() => {});
    }
  }
};
const K = { STU:'sms_stu', INV:'sms_inv', TX:'sms_tx', CF:'sms_cf', PAY:'sms_pay', EXP:'sms_exp', AF:'sms_af', STAFF:'sms_staff', SPAY:'sms_spay', BL:'sms_bl', DS:'sms_ds', RS:'sms_rs', ST:'sms_st', SL:'sms_sl', VENDOR:'sms_vend', SBOOK:'sms_sbook', USERS:'sms_users', SESS:'sms_sess', VPAY:'sms_vpay', ACCT:'sms_acct', CBOOK:'sms_cbook', PERM:'sms_perm', AUDIT:'sms_audit', PREQ:'sms_preq', NOTIF:'sms_notif', COMP:'sms_comp', ASSET:'sms_asset', ACATS:'sms_acats' };

// ── Sync Reconciliation Helpers ──────────────────────────────────────────────
// Re-export the pre-S declaration so existing code that references LIST_KEYS_WITH_ID still works.
const LIST_KEYS_WITH_ID = _LIST_KEYS_WITH_ID;

// Snapshot local value to `sms_backups[k]` (keep last 5) before any overwrite —
// drives the "Recover Deleted Data" recovery panel.
function backupLocalBeforeOverwrite(k, oldVal) {
  try {
    const all = JSON.parse(localStorage.getItem('sms_backups') || '{}');
    all[k] = all[k] || [];
    all[k].unshift({ ts: Date.now(), data: oldVal });
    all[k] = all[k].slice(0, 5);
    localStorage.setItem('sms_backups', JSON.stringify(all));
  } catch(e) {}
}

// Union arrays by `id`. For overlapping ids, the local item wins
// (local was just edited by the user; cloud is the older fallback).
// Items whose id appears in the tombstone registry for this key are SKIPPED
// from the cloud side — this is how a deletion stays permanent across syncs.
function mergeArraysById(localArr, cloudArr, key) {
  if (!Array.isArray(localArr)) return Array.isArray(cloudArr) ? cloudArr : localArr;
  if (!Array.isArray(cloudArr)) return localArr;
  // Load tombstones for this key — ids here MUST NOT come back from cloud
  let tombstonedIds = null;
  if (key) {
    try {
      const all = JSON.parse(localStorage.getItem('sms_tombstones') || '{}');
      const forKey = all[key];
      if (forKey && Object.keys(forKey).length > 0) tombstonedIds = new Set(Object.keys(forKey));
    } catch(e) {}
  }
  const map = new Map();
  cloudArr.forEach(it => {
    if (it && it.id != null) {
      const sid = String(it.id);
      if (tombstonedIds && tombstonedIds.has(sid)) return; // skip resurrection
      map.set(sid, it);
    }
  });
  // Local items overwrite cloud items with same id (local was just edited).
  // Tombstones can't apply to local since local is the source of truth here.
  localArr.forEach(it => { if (it && it.id != null) map.set(String(it.id), it); });
  // Preserve items lacking an id by appending them after the id-merged ones
  const noId = [...cloudArr.filter(it => !it || it.id == null), ...localArr.filter(it => !it || it.id == null)];
  return [...Array.from(map.values()), ...noId];
}

// Timestamp-aware reconciliation: replaces blind cloud->local overwrites.
// Strategy per key:
//   - cloud missing       → push local up (don't touch local)
//   - localTs > cloudTs   → push local up (don't touch local)
//   - cloudTs >= localTs  → for LIST_KEYS_WITH_ID merge by id; else pull cloud down with backup
// Returns true if any local key actually changed (triggers React refresh).
// ── v83+: forceCloudWins — Firebase is the AUTHORITATIVE source.
// On every page load + on the "Sync Now" button, cloud data overwrites local.
// This eliminates the eternal multi-device drift problem: whichever device wrote
// last to Firebase wins on the next read everywhere. No timestamp games, no merge
// surprises. Trade-off: simultaneous edits on different devices = last write wins.
// For a single-admin school workflow this is exactly the right model.
function forceCloudWins(cloudData, allKeys) {
  if (!cloudData) return false;
  // ── v87 LOCAL-NEWER GUARD ──
  // A key whose LOCAL timestamp is newer than the cloud's holds edits that never
  // reached Firebase (typed while the connection was down/still starting). Blindly
  // pulling cloud down would DESTROY those edits — the "marks disappear" bug.
  // Instead, push the newer local copy UP. Cloud still wins for stale local data.
  const cloudTsMap = cloudData.sms_ts || {};
  let localTsMap = {};
  try { localTsMap = JSON.parse(localStorage.getItem('sms_ts') || '{}'); } catch(e) {}
  let changed = false;
  allKeys.forEach(k => {
    const cloudVal = cloudData[k];
    // Cloud doesn't have this key yet — keep local copy and push it up
    if (cloudVal === undefined || cloudVal === null) {
      const localRaw = localStorage.getItem(k);
      if (localRaw !== null && localRaw !== 'null' && window._fbDB) {
        try { window._fbDB.ref('sms/' + k).set(JSON.parse(localRaw)).catch(()=>{}); } catch(e) {}
      }
      return;
    }
    const cloudRaw = JSON.stringify(cloudVal);
    const localRaw = localStorage.getItem(k);
    if (localRaw === cloudRaw) return;            // identical — no-op
    const lts = Number(localTsMap[k] || 0);
    const cts = Number(cloudTsMap[k] || 0);
    if (lts > cts && localRaw !== null && localRaw !== 'null') {
      // Local is newer — push it up (and its timestamp) instead of wiping it
      if (window._fbDB) {
        try {
          window._fbDB.ref('sms/' + k).set(JSON.parse(localRaw)).catch(()=>{});
          window._fbDB.ref('sms/sms_ts/' + k).set(lts).catch(()=>{});
        } catch(e) {}
      }
      return;
    }
    backupLocalBeforeOverwrite(k, (function(){ try { return JSON.parse(localRaw); } catch { return null; } })());
    localStorage.setItem(k, cloudRaw);            // CLOUD WINS — local replaced
    changed = true;
  });
  // Stamp last-sync time so the UI badge can show "X seconds ago"
  try { localStorage.setItem('_lastCloudSync', String(Date.now())); } catch(e) {}
  return changed;
}
window.forceCloudWins = forceCloudWins;

function reconcileWithCloud(cloudData, allKeys) {
  if (!cloudData) return false;
  const cloudTs = cloudData.sms_ts || {};
  let localTs = {};
  try { localTs = JSON.parse(localStorage.getItem('sms_ts') || '{}'); } catch(e) {}
  let changed = false;

  // ── Tombstone reconciliation ── before processing list keys, merge cloud
  // tombstones into local so deletions made on OTHER devices are honored here too.
  // Union of local + cloud tombstones (most recent timestamp wins on collision).
  try {
    const cloudTombs = cloudData.sms_tombstones || {};
    const localTombs = JSON.parse(localStorage.getItem('sms_tombstones') || '{}');
    const merged = {};
    const allTombKeys = new Set([...Object.keys(localTombs), ...Object.keys(cloudTombs)]);
    const cutoff = Date.now() - _TOMBSTONE_TTL_MS;
    allTombKeys.forEach(k => {
      const local = localTombs[k] || {};
      const cloud = cloudTombs[k] || {};
      const all = new Set([...Object.keys(local), ...Object.keys(cloud)]);
      const out = {};
      all.forEach(id => {
        const lTs = Number(local[id] || 0);
        const cTs = Number(cloud[id] || 0);
        const best = Math.max(lTs, cTs);
        if (best > cutoff) out[id] = best;
      });
      if (Object.keys(out).length > 0) merged[k] = out;
    });
    const mergedRaw = JSON.stringify(merged);
    const localRaw  = JSON.stringify(localTombs);
    if (mergedRaw !== localRaw) {
      localStorage.setItem('sms_tombstones', mergedRaw);
      if (window._fbDB) {
        try { window._fbDB.ref('sms/sms_tombstones').set(merged).catch(() => {}); } catch(e) {}
      }
    }
  } catch(e) {}

  allKeys.forEach(k => {
    const localRaw = localStorage.getItem(k);
    const cloudVal = cloudData[k];
    const lts = Number(localTs[k]) || 0;
    const cts = Number(cloudTs[k]) || 0;

    // Cloud has no value for this key — push our local copy up if we have one
    if (cloudVal === undefined || cloudVal === null) {
      if (localRaw !== null && localRaw !== 'null' && window._fbDB) {
        try { window._fbDB.ref('sms/' + k).set(JSON.parse(localRaw)).catch(() => {}); } catch(e) {}
      }
      return;
    }

    const cloudRaw = JSON.stringify(cloudVal);
    if (localRaw === cloudRaw) return; // already identical

    // Local is newer — protect local, push it to cloud
    if (lts > cts && localRaw !== null && localRaw !== 'null') {
      if (window._fbDB) {
        try { window._fbDB.ref('sms/' + k).set(JSON.parse(localRaw)).catch(() => {}); } catch(e) {}
      }
      return;
    }

    // Cloud wins — but for ID-bearing list keys, merge instead of wipe.
    // Pass the key so mergeArraysById can filter out tombstoned ids from cloud.
    if (LIST_KEYS_WITH_ID.indexOf(k) !== -1) {
      let localArr = null;
      try { localArr = localRaw ? JSON.parse(localRaw) : []; } catch(e) {}
      if (Array.isArray(localArr) && Array.isArray(cloudVal)) {
        const merged = mergeArraysById(localArr, cloudVal, k);
        const mergedRaw = JSON.stringify(merged);
        if (mergedRaw !== localRaw) {
          backupLocalBeforeOverwrite(k, localArr);
          localStorage.setItem(k, mergedRaw);
          changed = true;
        }
        // Sync merged result back so cloud is canonical for next device
        if (mergedRaw !== cloudRaw && window._fbDB) {
          try { window._fbDB.ref('sms/' + k).set(merged).catch(() => {}); } catch(e) {}
        }
        return;
      }
    }

    // Plain overwrite of local — but first stash a backup for recovery
    try { backupLocalBeforeOverwrite(k, localRaw ? JSON.parse(localRaw) : null); } catch(e) {}
    localStorage.setItem(k, cloudRaw);
    changed = true;
  });

  // Merge cloud timestamps into local so future writes pick up where cloud left off
  try {
    const newTs = { ...localTs };
    Object.keys(cloudTs).forEach(k => {
      const ct = Number(cloudTs[k]) || 0;
      if (ct > (Number(newTs[k]) || 0)) newTs[k] = ct;
    });
    localStorage.setItem('sms_ts', JSON.stringify(newTs));
  } catch(e) {}

  return changed;
}
window.S = S; window.K = K;

// Session stored in sessionStorage — clears automatically when browser/PWA is closed
const getSession  = () => { try { const v = sessionStorage.getItem('sms_sess'); return v ? JSON.parse(v) : null; } catch { return null; } };
const setSession  = (v) => { try { if (v === null || v === undefined) sessionStorage.removeItem('sms_sess'); else sessionStorage.setItem('sms_sess', JSON.stringify(v)); } catch {} };
const clearSession = () => { sessionStorage.removeItem('sms_sess'); };

// ── Permission Context ─────────────────────────────────────────────────────────
const PermContext = React.createContext({ staffCanModify: false });

// ── Audit Logger ──────────────────────────────────────────────────────────────
// Set default admin PIN to 5555 if not already set
(function() { const p = S.get(K.PERM, {}); if (!p.adminPin) S.set(K.PERM, { ...p, adminPin: '5555' }); })();

const logAudit = (username, name, action, module, oldVal, newVal) => {
  const sess = getSession() || {};
  const userRole = sess.role || 'admin';
  const logs = S.get(K.AUDIT, []);
  logs.unshift({ id: Date.now(), userId: sess.id || username, username, name, role: userRole, action, module, oldVal: JSON.stringify(oldVal), newVal: JSON.stringify(newVal), timestamp: new Date().toISOString() });
  S.set(K.AUDIT, logs.slice(0, 500));
};

// ── v75-8: Creator capture for ALL new records ───────────────────────────
// Every write function should embed these fields so every entry shows who
// is responsible. Read from the live session — works offline (session is
// in localStorage). If for any reason no session exists, fall back to a
// labelled "Unknown" so the audit chain never silently breaks.
function getCreator() {
  const s = getSession() || {};
  return {
    createdBy:     s.id || s.username || 'unknown',
    createdByName: s.name || s.username || 'Unknown',
    createdByRole: s.role || 'unknown',
    createdAt:     new Date().toISOString(),
  };
}
window.getCreator = getCreator;

// ── v75-8: Strict admin-only gate for edit/delete ────────────────────────
// Returns true ONLY when current session role is 'admin' (NOT principal).
// All modules use this for Edit/Delete button visibility. Add buttons stay
// gated by the wider isAdmin/canAdd logic (admin + principal can both add).
function isStrictAdmin() {
  const s = getSession() || {};
  return s.role === 'admin';
}
window.isStrictAdmin = isStrictAdmin;

// ── User Context ──────────────────────────────────────────────────────────────
const UserContext = React.createContext({ role: 'admin', username: 'admin', name: 'Administrator' });

// ── Sync Context ──────────────────────────────────────────────────────────────
// Replaces the destructive <main key={syncTick}> pattern. Components that want
// to re-read S.get() data after a cloud sync just subscribe via useContext —
// they re-RENDER (cheap, preserves focus/scroll/modals) instead of being
// unmounted and remounted (destructive, the cause of input refresh / page jumps).
const SyncContext = React.createContext(0);

// ── Default Book Lists per Class ──────────────────────────────────────────────
const BOOKS_1_10    = ['English (Written)','English (Oral)','Math','Urdu (Written)','Urdu (Oral)','Computer','Science','Islamiyat','Mashartialoum','Nazra','Drawing','Rhymes'];
const BOOKS_PG_NURS = ['English (Written)','English (Oral)','Math','Urdu (Written)','Urdu (Oral)','Computer','Science','Islamiyat','Mashartialoum','Nazra','Drawing','Rhymes'];
const BOOKS_KG      = ['English (Written)','English (Oral)','Math','Urdu (Written)','Urdu (Oral)','Computer','Science','Islamiyat','Mashartialoum','Nazra','Drawing','Rhymes'];

const DEFAULT_BOOKS = {
  'Play Group Red':  BOOKS_PG_NURS.map(n => ({ name: n, qty: 1, price: 0 })),
  'Play Group Blue': BOOKS_PG_NURS.map(n => ({ name: n, qty: 1, price: 0 })),
  'Nursery':         BOOKS_PG_NURS.map(n => ({ name: n, qty: 1, price: 0 })),
  'KG':              BOOKS_KG.map(n => ({ name: n, qty: 1, price: 0 })),
  ...Object.fromEntries(['1','2','3','4','5','6','7','8','9','10'].map(c => [c, BOOKS_1_10.map(n => ({ name: n, qty: 1, price: 0 }))]))
};

// ── Exam Subjects per Class ───────────────────────────────────────────────────
const SUBJECTS_PG_KG  = ['English (Written)','English (Oral)','Math','Urdu (Written)','Urdu (Oral)','Computer','Science','General Knowledge','Islamiyat','Mashartialoum','Nazra','Drawing','Rhymes'];
const SUBJECTS_1_10   = ['English (Written)','English (Oral)','Math','Urdu (Written)','Urdu (Oral)','Computer','Science','Islamiyat','Mashartialoum','Nazra','Drawing'];
const TERMS           = ['Term 1','Term 2','Term 3'];
const TOTAL_MARKS     = 100;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);
// XSS sanitizer — use whenever user data is injected into HTML strings
const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

// ── Financial Engine Cutoff — June 2026 ──────────────────────────────────────
// Payments BEFORE this cutoff are excluded from outstanding balance calculations.
// Historical records remain in K.PAY untouched. Opening balances in K.STU still apply.
const ENGINE_CUTOFF_YEAR  = 2026;
const ENGINE_CUTOFF_MONTH = 5; // June (0-indexed, same as JS Date.getMonth())

// Returns true for payments from June 2026 onwards
const isFromCutoff = p =>
  Number(p.year) > ENGINE_CUTOFF_YEAR ||
  (Number(p.year) === ENGINE_CUTOFF_YEAR && Number(p.month) >= ENGINE_CUTOFF_MONTH);

// Wrapper: builds paid maps using only June 2026+ payments
// Use this for ALL outstanding balance calculations.
// Use raw buildPaidMaps() only for income/recovery totals in P&L.
function buildPaidMapsFromCutoff(payments) {
  return buildPaidMaps(payments.filter(isFromCutoff));
}

// Fresh-start outstanding: ignores opening balance (pre-June accumulated dues zeroed)
// Use everywhere getStuOutstanding is called with a cutoff paidMaps argument.
function getStuOutstandingFromCutoff(st, classFees, paidMaps) {
  return getStuOutstanding({ ...st, openingBalance: 0 }, classFees, paidMaps);
}

// ── Accounting ────────────────────────────────────────────────────────────────
const PAYMENT_METHODS = ['Cash', 'Bank Transfer', 'JazzCash', 'Easypaisa'];

const DEFAULT_ACCOUNTS = [
  { id: 'acct_cash', name: 'Cash In Hand', type: 'cash',   number: '' },
  { id: 'acct_bank', name: 'Bank Account', type: 'bank',   number: '' },
  { id: 'acct_jazz', name: 'JazzCash',     type: 'wallet', number: '' },
  { id: 'acct_easy', name: 'Easypaisa',    type: 'wallet', number: '' },
];

function getAccounts() {
  const stored = S.get(K.ACCT, null);
  if (stored && stored.length) return stored;
  S.set(K.ACCT, DEFAULT_ACCOUNTS);
  return DEFAULT_ACCOUNTS;
}

// Ensure default accounts exist on first run
getAccounts();

function addCashBookEntry(type, description, amount, paymentMethod, date, note, refTypeOverride, entryId) {
  if (!amount || Number(amount) <= 0) return;
  const accounts = getAccounts();
  let acct;
  if (paymentMethod === 'Bank Transfer') acct = accounts.find(a => a.type === 'bank');
  else if (paymentMethod === 'JazzCash')  acct = accounts.find(a => a.name === 'JazzCash');
  else if (paymentMethod === 'Easypaisa') acct = accounts.find(a => a.name === 'Easypaisa');
  else acct = accounts.find(a => a.type === 'cash');
  if (!acct) acct = accounts[0];
  if (!acct) return;
  const entry = Object.assign({
    id: entryId || uid(),
    date: date ? (typeof date === 'string' ? date.slice(0,10) : new Date(date).toISOString().slice(0,10)) : new Date().toISOString().slice(0,10),
    type,
    description,
    amount: Number(amount),
    accountId: acct.id,
    accountName: acct.name,
    note: note || '',
    refType: refTypeOverride || (type === 'income' ? 'fee' : 'expense'),
  }, getCreator());   // v75-8: stamp createdBy / createdByName / createdByRole / createdAt
  S.set(K.CBOOK, [...S.get(K.CBOOK, []), entry]);
}

// ── PHASE 1 INTERCEPTOR — processFeeTransaction ─────────────────────────────
// SINGLE ROOT for ALL fee writes. Both the individual payment modal and the
// family split modal funnel through here so K.PAY and K.CBOOK stay in lockstep.
// ── Contract ──
//   input  = {
//     familyId:        string  (optional — used only for audit/description)
//     studentTransactions: [{
//       stuId:        string (required)
//       stuName:      string (for audit + cashbook description)
//       amount:       number (fee portion)
//       annualFund:   number (default 0)
//       booksPaid:    number (default 0)
//       discount:     number (default 0)
//       month:        number (0-11, required)
//       year:         number (required)
//     }, ...]
//     paymentMethod:   'Cash' | 'Bank Transfer' | 'JazzCash' | 'Easypaisa'
//     date:            ISO date string (defaults to today)
//     note:            string (optional)
//     source:          'individual' | 'family_split' (for audit; defaults 'individual')
//   }
// ── Behavior ──
//   - Writes each studentTransaction to K.PAY in the exact existing schema
//     (NO schema changes — stuId/amount/annualFund/booksPaid/discount/month/year/...)
//   - Writes a matching cash-book entry per student via addCashBookEntry
//   - Single S.set per key (one K.PAY append batch + N cashbook appends)
//   - Returns { ok: true, payIds: [...], error: null } on success
//   - On any validation error returns { ok: false, payIds: [], error: '...' }
// ── Hard constraint: K.PAY shape MUST remain unchanged. Every existing reader
//   (Dashboard, FC, FL, P&L, Outstanding, calcPL, buildPaidMaps) continues to
//   work without ANY modification. This helper is additive — never a replacement
//   for the global engine. It only standardizes how fee data enters the engine.
function processFeeTransaction(input) {
  try {
    if (!input || !Array.isArray(input.studentTransactions) || input.studentTransactions.length === 0) {
      return { ok: false, payIds: [], error: 'No student transactions provided' };
    }
    const paymentMethod = input.paymentMethod || 'Cash';
    const date          = input.date || new Date().toISOString().slice(0,10);
    const note          = input.note || '';
    const source        = input.source === 'family_split' ? 'family_split' : 'individual';
    const familyId      = input.familyId || '';

    // Build all new K.PAY records up-front for atomic single-write
    const newPays   = [];
    const cbActions = []; // deferred so cash book also gets atomic-ish write
    // Pre-load existing students + payments ONCE for AF cap validation (Single Source Rule)
    const _allStu    = S.get(K.STU, []);
    const _allPayAll = S.get(K.PAY, []);
    for (const t of input.studentTransactions) {
      if (!t || !t.stuId) {
        return { ok: false, payIds: [], error: 'studentTransactions[*].stuId is required' };
      }
      const amount     = Number(t.amount      || 0);
      let   annualFund = Number(t.annualFund  || 0);
      const booksPaid  = Number(t.booksPaid   || 0);
      const discount   = Number(t.discount    || 0);

      // ── ACCOUNTING HEAD INTEGRITY GUARD ─────────────────────────────────
      // Rule (per owner directive, v71):
      //   Annual Fund head is SEALED. The only source for AF is the
      //   student.annualFund field in the Students module. A payment can
      //   credit AF only up to (st.annualFund − alreadyPaidAF). Any excess
      //   money belongs to OPENING BALANCE clearance (handled automatically
      //   by getStuOutstanding when admin types it in the "Amount" field),
      //   NEVER to Annual Fund. This prevents AF Collected > AF Expected
      //   data drift.
      if (annualFund > 0) {
        const stu = _allStu.find(s => s.id === t.stuId);
        if (stu) {
          const expectedAF = Number(stu.annualFund || 0);
          const paidAFSoFar = _allPayAll
            .filter(p => p.stuId === t.stuId)
            .reduce((s, p) => s + Number(p.annualFund || 0), 0);
          const remainingAF = Math.max(0, expectedAF - paidAFSoFar);
          if (annualFund > remainingAF) {
            return {
              ok: false, payIds: [],
              error: 'AF amount Rs.' + annualFund + ' exceeds remaining Annual Fund Rs.' + remainingAF +
                     ' for ' + (t.stuName || stu.name) + '. Per accounting head rule, excess money must go to "Amount" (clears Opening Balance), not Annual Fund. Reduce AF to Rs.' + remainingAF + ' and put the rest in Amount.'
            };
          }
        }
      }
      const month      = Number(t.month);
      const year       = Number(t.year);
      if (isNaN(month) || isNaN(year)) {
        return { ok: false, payIds: [], error: 'studentTransactions[*].month and .year required' };
      }
      // Skip empty payments (no money received, no AF, no books) — keeps K.PAY clean
      if (amount <= 0 && annualFund <= 0 && booksPaid <= 0) continue;
      const payId = uid();
      // Preserve receipt number + classFee for existing receipt printer compatibility.
      // Auto-generate rcpt if caller didn't pass one. classFee is optional (collectFee uses it).
      const rcpt = t.rcpt || ('RCP-' + Date.now().toString().slice(-6) + Math.floor(Math.random()*100));
      const payRecord = Object.assign({
        id:            payId,
        stuId:         t.stuId,
        month, year,
        amount, annualFund, booksPaid, discount,
        paymentMethod,
        date,
        note:          source === 'family_split' ? ('[Family Split] ' + (note || '')).trim() : note,
        rcpt,
      }, getCreator());  // v75-8: who collected this fee
      if (t.classFee !== undefined) payRecord.classFee = Number(t.classFee || 0);
      newPays.push(payRecord);
      const totalCashIn = amount + annualFund + booksPaid;
      if (totalCashIn > 0) {
        cbActions.push({
          desc:   (source === 'family_split' ? 'Family Split — ' : 'Fee — ') + (t.stuName || t.stuId) + ' (' + MONTHS[month] + ' ' + year + ')',
          amount: totalCashIn,
          method: paymentMethod,
          date, note,
          payId,
          stuId:  t.stuId,
        });
      }
    }
    if (newPays.length === 0) {
      return { ok: false, payIds: [], error: 'All transactions were empty (no amount/AF/books)' };
    }
    // ── Atomic-ish writes ──
    // 1) K.PAY — single S.set with the full new array (existing + new), fires one Firebase write
    const existingPays = S.get(K.PAY, []);
    S.set(K.PAY, [...existingPays, ...newPays]);
    // 2) Cash book — one entry per studentTransaction (uses existing addCashBookEntry, no shape change).
    //    Append a stuId marker to the note so the Cash Book renderer can do LIVE name lookup
    //    later — name corrections in the Students module automatically reflect in the description.
    cbActions.forEach(a => {
      const taggedNote = (a.note ? a.note + ' ' : '') + '[stuId=' + a.stuId + ']';
      addCashBookEntry('income', a.desc, a.amount, a.method, a.date, taggedNote, 'fee', undefined);
    });
    // ── v75.1: SHADOW-WRITE to immutable double-entry journal ──
    // For each new payment, post a debit/credit pair to sms_journal per
    // money head. Legacy K.PAY remains the canonical record; the journal
    // is the parallel CA audit trail.
    //   Fee amount  → debit <method>, credit FEE_INCOME
    //   AnnualFund  → debit <method>, credit AF_INCOME
    //   BooksPaid   → debit <method>, credit BOOKS_INCOME
    // Fire-and-forget: journal queue + Firebase write are non-blocking.
    // Failures are queued for later flush — NOT rolled back against K.PAY.
    try {
      const _txByStu = {};
      input.studentTransactions.forEach(function(t) { if (t && t.stuId) _txByStu[t.stuId] = t; });
      newPays.forEach(function(p) {
        const method  = _METHOD_TO_ACCOUNT[p.paymentMethod] || 'CASH';
        const dateStr = (typeof p.date === 'string' ? p.date : new Date().toISOString()).slice(0, 10);
        const stuName = (_txByStu[p.stuId] && _txByStu[p.stuId].stuName) || p.stuId;
        const tag     = ' [stuId=' + p.stuId + ']';
        const monLbl  = MONTHS[p.month] + ' ' + p.year;
        if (Number(p.amount) > 0) {
          postJournalEntry({
            debitAccount:  method,
            creditAccount: 'FEE_INCOME',
            amount:        Number(p.amount),
            refType:       'K.PAY',
            refId:         p.id,
            date:          dateStr,
            note:          'Fee — ' + stuName + ' (' + monLbl + ')' + tag,
          });
        }
        if (Number(p.annualFund) > 0) {
          postJournalEntry({
            debitAccount:  method,
            creditAccount: 'AF_INCOME',
            amount:        Number(p.annualFund),
            refType:       'K.PAY',
            refId:         p.id,
            date:          dateStr,
            note:          'Annual Fund — ' + stuName + tag,
          });
        }
        if (Number(p.booksPaid) > 0) {
          postJournalEntry({
            debitAccount:  method,
            creditAccount: 'BOOKS_INCOME',
            amount:        Number(p.booksPaid),
            refType:       'K.PAY',
            refId:         p.id,
            date:          dateStr,
            note:          'Books — ' + stuName + tag,
          });
        }
      });
    } catch (e) {
      // Journal shadow-write is best-effort. Never fail the user-facing transaction.
      console.warn('[journal] shadow-write enqueue raised — entries should still be queued', e && e.message);
    }
    return { ok: true, pays: newPays, payIds: newPays.map(p => p.id), error: null, source, familyId };
  } catch (e) {
    return { ok: false, payIds: [], error: (e && e.message) || 'Unknown error' };
  }
}
// expose for any module that wants to call it (UI popups, future automations)
window.processFeeTransaction = processFeeTransaction;

// ═══════════════════════════════════════════════════════════════════════════
// ── v75.1: DOUBLE-ENTRY JOURNAL HELPERS — CA AUDIT LEDGER WRITER ──────────
// ═══════════════════════════════════════════════════════════════════════════
// Purpose: every financial movement also lands in the append-only
// sms_journal (governed by database.rules.json deployed in v75.0). Legacy
// K.PAY / K.CBOOK paths are NOT changed — this is a parallel shadow-write,
// not a replacement.
//
// Atomicity: Firebase RTDB native multi-path update() guarantees that the
// debit and credit legs of one transaction either both land or neither
// lands. No partial-pair state is possible.
//
// Offline guarantee: every entry is queued in localStorage
// (key 'sms_journal_queue') BEFORE the Firebase write is attempted. If the
// device is offline or the write fails for any reason, entries stay in the
// queue until flushJournalQueue() succeeds. App init + 'online' event
// trigger the flush automatically.
//
// Account name conventions (matches v75.0 directive):
//   CASH | BANK | JAZZCASH | EASYPAISA       — payment methods (debit on receipt)
//   FEE_INCOME | AF_INCOME | BOOKS_INCOME    — revenue accounts (credit on receipt)
//   SALARY_EXP | VENDOR_PAY | RENT_EXP       — expense accounts (reserved for v75.2)
//   GENERAL_EXP                              — catch-all expense (reserved for v75.2)
//   STU:<stuId>                              — per-student receivable (reserved)
//   OWNER | OWNER_DRAWING                    — equity accounts (reserved)

const _METHOD_TO_ACCOUNT = {
  'Cash':          'CASH',
  'Bank Transfer': 'BANK',
  'JazzCash':      'JAZZCASH',
  'Easypaisa':     'EASYPAISA',
};

function _journalServerTs() {
  // ServerValue.TIMESTAMP is a sentinel object that Firebase server replaces
  // with the true server time at write. Survives JSON round-trip through
  // localStorage so queue flushes keep it correct.
  try {
    if (window.firebase && window.firebase.database && window.firebase.database.ServerValue) {
      return window.firebase.database.ServerValue.TIMESTAMP;
    }
  } catch (e) {}
  return Date.now();
}

function _buildJournalEntry(opts) {
  return {
    id:        opts.id,
    txnId:     opts.txnId,
    role:      opts.role,
    account:   opts.account,
    amount:    Number(opts.amount),
    refType:   opts.refType,
    refId:     opts.refId || '',
    date:      opts.date || new Date().toISOString().slice(0, 10),
    postedAt:  _journalServerTs(),
    note:      opts.note || '',
  };
}

function _enqueueJournalEntries(entries) {
  try {
    const queue = S.get('sms_journal_queue', []);
    entries.forEach(function(e) { queue.push(e); });
    S.set('sms_journal_queue', queue);
  } catch (e) {
    console.warn('[journal] enqueue failed', e && e.message);
  }
}

// Drain queued entries to Firebase in a single atomic update.
// Safe to call repeatedly; on success, drained entries are removed.
function flushJournalQueue() {
  let queue;
  try { queue = S.get('sms_journal_queue', []); } catch (e) { queue = []; }
  if (!Array.isArray(queue) || queue.length === 0) {
    return Promise.resolve({ ok: true, flushed: 0 });
  }
  if (!window._fbDB) {
    return Promise.resolve({ ok: false, reason: 'offline', queued: queue.length });
  }
  const updates = {};
  queue.forEach(function(e) {
    if (e && e.id) updates['sms/sms_journal/' + e.id] = e;
  });
  return window._fbDB.ref().update(updates)
    .then(function() {
      S.set('sms_journal_queue', []);
      if (window._DISS_DEBUG) console.log('[journal] flushed ' + queue.length + ' entries');
      return { ok: true, flushed: queue.length };
    })
    .catch(function(err) {
      console.warn('[journal] flush failed; entries stay queued', err && err.message);
      return { ok: false, reason: 'error', error: err && err.message, queued: queue.length };
    });
}
window.flushJournalQueue = flushJournalQueue;

// Main public writer. Posts ONE double-entry pair atomically.
// Returns a Promise that resolves to { ok, txnId, drId, crId, queued? }.
function postJournalEntry(opts) {
  if (!opts || !opts.debitAccount || !opts.creditAccount || !opts.refType) {
    return Promise.resolve({ ok: false, error: 'postJournalEntry: missing required opts' });
  }
  const amount = Number(opts.amount || 0);
  if (!(amount > 0)) {
    return Promise.resolve({ ok: false, error: 'postJournalEntry: amount must be > 0' });
  }
  const txnId  = uid();
  const drId   = txnId + '_dr';
  const crId   = txnId + '_cr';
  const common = {
    txnId: txnId, amount: amount,
    refType: opts.refType, refId: opts.refId || '',
    date: opts.date, note: opts.note || '',
  };
  const debit  = _buildJournalEntry(Object.assign({}, common, {
    id: drId, role: 'debit',  account: opts.debitAccount,
  }));
  const credit = _buildJournalEntry(Object.assign({}, common, {
    id: crId, role: 'credit', account: opts.creditAccount,
  }));

  // 1. Offline safety: always queue first.
  _enqueueJournalEntries([debit, credit]);

  // 2. If Firebase unavailable, leave in queue. flushJournalQueue() will catch up.
  if (!window._fbDB) {
    return Promise.resolve({ ok: true, txnId: txnId, drId: drId, crId: crId, queued: true });
  }

  // 3. Atomic multi-path update — either both legs land or neither does.
  return window._fbDB.ref().update({
    ['sms/sms_journal/' + drId]: debit,
    ['sms/sms_journal/' + crId]: credit,
  })
    .then(function() {
      // Success — remove these specific entries from the queue.
      try {
        const q = S.get('sms_journal_queue', []);
        const remaining = q.filter(function(e) { return e.id !== drId && e.id !== crId; });
        S.set('sms_journal_queue', remaining);
      } catch (e) {}
      return { ok: true, txnId: txnId, drId: drId, crId: crId };
    })
    .catch(function(err) {
      console.warn('[journal] direct write failed; pair stays queued', err && err.message);
      return { ok: false, txnId: txnId, drId: drId, crId: crId, queued: true, error: err && err.message };
    });
}
window.postJournalEntry = postJournalEntry;

// ── Cash Book LIVE description resolver ─────────────────────────────────────
// Takes a K.CBOOK entry and returns a description with the CURRENT student name
// pulled from K.STU. If admin corrects a student's name spelling later, every
// Cash Book row that references that student instantly reflects the new name.
//
// Resolution strategy (in priority order):
//   1. Explicit [stuId=XXX] marker in entry.note → direct K.STU lookup.
//      Added by processFeeTransaction for all writes from v63 onwards.
//   2. Retro-match against K.PAY by date(YYYY-MM-DD) + total cash amount.
//      Catches all PRE-v63 entries that were written without the marker.
//      Reliable because (date, totalCash) is almost always unique per student/day.
//   3. Fall back to stored description — guarantees graceful degradation.
//
// This is presentation-only — entry.description in storage is NEVER modified, so
// historical journal integrity is preserved while the live view stays consistent.
function resolveCashBookDesc(entry, _stuListOverride, _payMatchMapOverride) {
  try {
    if (!entry) return '';
    const desc = String(entry.description || '');
    const note = String(entry.note || '');
    const stuList = _stuListOverride || S.get(K.STU, []);
    // Helper — given a stuId, rewrite the name segment of desc
    const rewriteWithStu = (stuId) => {
      const stu = stuList.find(s => s && s.id === stuId);
      if (!stu || !stu.name) return desc;
      const idx1 = desc.indexOf(' — ');
      if (idx1 < 0) return desc;
      const prefix = desc.slice(0, idx1 + 3);
      const tail   = desc.slice(idx1 + 3);
      const idx2   = tail.indexOf(' (');
      if (idx2 < 0) return prefix + stu.name;
      return prefix + stu.name + tail.slice(idx2);
    };
    // ── Strategy 1: explicit marker (post-v63 entries) ──
    const m = note.match(/\[stuId=([^\]]+)\]/);
    if (m) {
      const result = rewriteWithStu(m[1]);
      if (result !== desc) return result;
    }
    // ── Strategy 2: retro-match against K.PAY by date+amount (pre-v63 entries) ──
    // Only attempt for fee-like entries to avoid false matches on owner_drawing/transfer/etc.
    if (entry.refType === 'fee' || entry.type === 'income') {
      let payMatchMap = _payMatchMapOverride;
      if (!payMatchMap) {
        // Build cache on demand. Re-built on each call if not passed — for one-off
        // callers; the Cash Book renderer passes a shared map for efficiency.
        payMatchMap = {};
        const pays = S.get(K.PAY, []);
        pays.forEach(p => {
          if (!p || !p.stuId || !p.date) return;
          const total = Number(p.amount || 0) + Number(p.annualFund || 0) + Number(p.booksPaid || 0);
          if (total <= 0) return;
          const key = String(p.date).slice(0,10) + '|' + total;
          // If multiple pays share same (date, total) we keep first → ambiguous case
          // falls back to original desc gracefully (no incorrect rewrite).
          if (payMatchMap[key] === undefined) payMatchMap[key] = p.stuId;
          else payMatchMap[key] = null; // mark ambiguous
        });
      }
      const cbDate = String(entry.date || '').slice(0,10);
      const cbAmt  = Number(entry.amount || 0);
      const k = cbDate + '|' + cbAmt;
      const matchedStuId = payMatchMap[k];
      if (matchedStuId) {
        const result = rewriteWithStu(matchedStuId);
        if (result !== desc) return result;
      }
    }
    // ── Fallback: stored description as-is ──
    return desc;
  } catch (e) { return entry && entry.description ? entry.description : ''; }
}
// Build a shared (date+amount → stuId) map for efficient retro-matching in renderers
function buildCashBookPayMatchMap() {
  const payMatchMap = {};
  const pays = S.get(K.PAY, []);
  pays.forEach(p => {
    if (!p || !p.stuId || !p.date) return;
    const total = Number(p.amount || 0) + Number(p.annualFund || 0) + Number(p.booksPaid || 0);
    if (total <= 0) return;
    const key = String(p.date).slice(0,10) + '|' + total;
    if (payMatchMap[key] === undefined) payMatchMap[key] = p.stuId;
    else payMatchMap[key] = null; // ambiguous → skip rewrite
  });
  return payMatchMap;
}
window.resolveCashBookDesc = resolveCashBookDesc;
window.buildCashBookPayMatchMap = buildCashBookPayMatchMap;

// ── Logo & Footer ─────────────────────────────────────────────────────────────
const LOGO_SRC = (() => { try { return new URL('diss-app/logo diss/for invoice printing diss logo.png', window.location.href).href; } catch { return ''; } })();
const ADDR_SRC = (() => { try { return new URL('diss-app/logo diss/diss address for fotter.png', window.location.href).href; } catch { return ''; } })();

// ── Print Audit Helpers — every printout shows who generated it & when ────────
// Pulls from the active session (set on login). Falls back gracefully so the
// print never breaks if the session is somehow missing.
function getCurrentUserName() {
  try {
    const s = getSession() || {};
    return s.name || s.username || 'Unknown User';
  } catch { return 'Unknown User'; }
}
// ── Strip system tags from notes so receipts never expose internal labels.
// Internal tags wrap context like [Family Split], [Family Payment], [Books],
// [stuId=…]. Returns the user-typed remainder, or '' if there's nothing left.
function cleanNoteForReceipt(rawNote) {
  if (!rawNote) return '';
  return String(rawNote)
    .replace(/\[Family Split\]/gi, '')
    .replace(/\[Family Payment\]/gi, '')
    .replace(/\[Books( Payment)?\]/gi, '')
    .replace(/\[stuId=[^\]]+\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function getPrintAudit() {
  const name = getCurrentUserName();
  const ts   = new Date().toLocaleString('en-PK', { year:'numeric', month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit' });
  return `<div style="margin-top:6px;font-size:10px;color:#475569;letter-spacing:.2px;text-align:center;font-weight:600">🖨️ Generated By: <span style="color:#1e3a8a">${esc(name)}</span> &nbsp;•&nbsp; ${ts}</div>`;
}
// PRINT_FOOTER is now a function so the audit line is evaluated at print time
// (captures the user who actually clicked Print, not who happened to load the app).
function PRINT_FOOTER_FN() {
  return `<div style="margin-top:14px;padding-top:10px;border-top:1px solid #e5e7eb;text-align:center">${getPrintAudit()}<img src="${ADDR_SRC}" alt="DISS Address" style="max-width:520px;width:100%;object-fit:contain;margin-top:6px" onerror="this.style.display='none'"/><div style="font-size:9px;color:#9ca3af;letter-spacing:.3px;margin-top:6px">© 2026 DISS — All Rights Reserved &nbsp;|&nbsp; Powered by Tataheer Business Group &nbsp;|&nbsp; +923218555566</div></div>`;
}
// Back-compat: legacy code references PRINT_FOOTER as a string. Provide a getter.
const PRINT_FOOTER = (typeof Proxy !== 'undefined') ? null : ''; // not used directly anymore

// ── Print Utility ─────────────────────────────────────────────────────────────
const SCHOOL_HEADER = `
  <div style="display:flex;align-items:center;justify-content:center;margin-bottom:18px;padding-bottom:12px;border-bottom:2px solid #c0392b">
    <img src="${LOGO_SRC}" alt="DISS Logo" style="height:70px;object-fit:contain;" onerror="this.style.display='none'"/>
  </div>`;

function printPage(title, bodyHtml) {
  const win = window.open('', '_blank', 'width=900,height=700');
  if (!win) { alert('Popup blocked! Please allow popups for this site to print.'); return; }
  const date = new Date().toLocaleDateString('en-PK', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
  win.document.write(`<!DOCTYPE html><html><head><title>${title}</title>
    <style>
      *{box-sizing:border-box}
      body{font-family:'Segoe UI',Arial,sans-serif;padding:28px;color:#1a1a1a;font-size:12px}
      h2{font-size:15px;margin:0 0 14px;color:#1e3a8a;font-weight:700}
      table{width:100%;border-collapse:collapse;margin-top:8px}
      th{background:#1e3a8a;color:#fff;padding:7px 10px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.5px}
      td{padding:6px 10px;border-bottom:1px solid #e5e7eb;font-size:12px}
      tr:nth-child(even) td{background:#f8fafc}
      tr:last-child td{border-bottom:none}
      .badge{display:inline-block;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700}
      .b-blue{background:#dbeafe;color:#1d4ed8}
      .b-green{background:#d1fae5;color:#065f46}
      .b-red{background:#fee2e2;color:#991b1b}
      .b-purple{background:#ede9fe;color:#6d28d9}
      .b-yellow{background:#fef3c7;color:#92400e}
      .summary{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:16px}
      .sum-card{border:1px solid #e5e7eb;border-radius:8px;padding:10px 16px;min-width:120px}
      .sum-card .val{font-size:18px;font-weight:800;color:#1e3a8a;margin-bottom:2px}
      .sum-card .lbl{font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px}
      .print-date{text-align:right;font-size:10px;color:#9ca3af;margin-bottom:12px}
      tfoot td{background:#f1f5f9;font-weight:700;font-size:12px}
      @media print{body{padding:14px}button{display:none!important}}
    </style>
  </head><body>
    ${SCHOOL_HEADER}
    <div class="print-date">Printed: ${date}</div>
    ${bodyHtml}
    ${PRINT_FOOTER_FN()}
    <script>window.onload=function(){window.print();}<\/script>
  </body></html>`);
  win.document.close();
}

const CLASSES = ['Play Group Red','Play Group Blue','Nursery','KG','1','2','3','4','5','6','7','8','9','10'];
const MONTHS  = ['January','February','March','April','May','June','July','August','September','October','November','December'];
// ── GLOBAL FINANCIAL ENGINE HELPERS ──────────────────────────────────────────
// ALL modules must use these. Never inline these formulas anywhere else.

// 1. Auto-discount: if student's set rate is below class fee, difference is discount
function getStuDisc(st, classFees) {
  const cf = Number(classFees[st.cls] || 0);
  const sr = Number(st.monthlyFee || 0);
  return (sr > 0 && sr < cf) ? cf - sr : 0;
}

// 2. Monthly net fee due for a student (class fee minus auto-discount, min 0)
function getStuNetMonthlyDue(st, classFees) {
  if (!isActiveStu(st)) return 0;  // left students have no future dues
  return Math.max(0, Number(classFees[st.cls] || 0) - getStuDisc(st, classFees));
}

// 2a. Total book bill for a single student (sum of qty × price across their book list).
//     ── SINGLE SOURCE OF TRUTH ── used by Students page, Dashboard, Fee Collection,
//     Family Ledger. Never inline this multiplication anywhere else.
function getStudentBookTotal(stu, bookLists) {
  if (!stu || !bookLists) return 0;
  const list = bookLists[stu.id] || [];
  return list.reduce((s, b) => s + Number(b.price || 0) * Number(b.qty || 0), 0);
}

// 2c. Global inventory asset value engine — SINGLE SOURCE OF TRUTH for stock-on-hand
//     valuation. Used by Inventory page header, Dashboard asset chip, Balance Sheet
//     (Assets & P&L). Returns { totalRetail, totalCost, itemCount, lowStockCount }.
//     - totalRetail uses retailPrice (or legacy `price` fallback).
//     - totalCost  uses purchasePrice (or legacy `price` fallback) — true asset value.
//     Never inline qty × price anywhere else. Always call this.
function getGlobalInventoryAssetValue(items) {
  const list = Array.isArray(items) ? items : getActiveList(K.INV);
  let totalRetail = 0, totalCost = 0, itemCount = 0, lowStockCount = 0;
  list.forEach(it => {
    if (!it) return;
    const qty   = Number(it.qty || 0);
    const retail = Number(it.retailPrice   || it.price || 0);
    const cost   = Number(it.purchasePrice || it.price || 0);
    totalRetail += qty * retail;
    totalCost   += qty * cost;
    itemCount   += 1;
    if (qty <= Number(it.threshold || 5)) lowStockCount += 1;
  });
  return { totalRetail, totalCost, itemCount, lowStockCount };
}
window.getGlobalInventoryAssetValue = getGlobalInventoryAssetValue;

// 2b. Effective monthly discount for a student in a specific month.
//     Rule: if any payment(s) were recorded that month, use the SUM of their
//     discount fields (supports multiple partial payments). If no payments yet,
//     fall back to the student's auto/sibling discount.
//     ── SINGLE SOURCE OF TRUTH ── used by Fee Collection, Dashboard, Family
//     Ledger, print receipts, and any future module that needs monthly discount.
//     Never inline this formula anywhere else.
function getStuEffectiveDisc(st, payments, month, year, classFees) {
  if (!isActiveStu(st)) return 0;
  const autoDisc = getStuDisc(st, classFees);
  let paidDisc = 0;
  (payments || []).forEach(p => {
    if (p.stuId === st.id && Number(p.month) === Number(month) && Number(p.year) === Number(year)) {
      paidDisc += Number(p.discount || 0);
    }
  });
  // Auto-discount (Class Fee − Monthly Fee) is the floor — always applies.
  // Recorded payment discount only matters if it's GREATER (manual override upward).
  return Math.max(paidDisc, autoDisc);
}

// ── DATA INTEGRITY GUARDS ────────────────────────────────────────────────────
// Strips any record carrying a soft-delete marker so financial reports / dashboards
// can never include data the user thinks is gone. Use at every entry point that
// reads a list out of localStorage / S.get(). Backups (sms_backups), audit log
// (sms_audit), tombstones (sms_tombstones) and timestamps (sms_ts) are META keys
// and MUST NEVER be sourced by financial calculations.
const _META_KEYS_NEVER_IN_REPORTS = ['sms_backups','sms_tombstones','sms_ts','sms_audit'];
function getActiveRecords(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(r => {
    if (!r) return false;
    if (r.isDeleted === true) return false;
    if (r.status === 'deleted') return false;
    if (r.archived === true) return false;
    if (r._tombstone === true) return false;
    if (r._deleted === true) return false;
    return true;
  });
}
// Live-data read with integrity filter applied. Forbids reading meta/backup keys.
function getActiveList(key) {
  if (_META_KEYS_NEVER_IN_REPORTS.indexOf(key) !== -1) {
    console.warn('[Data Integrity] Refused to read meta key for report:', key);
    return [];
  }
  return getActiveRecords(S.get(key, []));
}

// 3. Build all-time payment maps from a payments array in one pass
// Returns: { feeMap, afMap, booksMap, discMap } — each keyed by stuId
// IMPORTANT: callers MUST pass an array already filtered through getActiveRecords()
// so deleted/archived payments never inflate income totals.
function buildPaidMaps(payments) {
  const feeMap = {}, afMap = {}, booksMap = {}, discMap = {};
  payments.forEach(p => {
    const id = p.stuId;
    feeMap[id]   = (feeMap[id]   || 0) + Number(p.amount     || 0);
    afMap[id]    = (afMap[id]    || 0) + Number(p.annualFund  || 0);
    booksMap[id] = (booksMap[id] || 0) + Number(p.booksPaid   || 0);
    discMap[id]  = (discMap[id]  || 0) + Number(p.discount    || 0);
  });
  return { feeMap, afMap, booksMap, discMap };
}

// ── v85: monthsElapsedSinceCutoff — auto-carry-forward engine ──
// Every month that passes since the fiscal cutoff (June 2026) is billable.
// So on July 1 the previous June unpaid rolls forward automatically.
// On Aug 1 two months of unpaid stack. No manual "carry forward" needed.
function getMonthsBilledSinceCutoff() {
  const NOW = new Date();
  const cy  = NOW.getFullYear(), cm = NOW.getMonth();
  const elapsed = (cy - ENGINE_CUTOFF_YEAR) * 12 + (cm - ENGINE_CUTOFF_MONTH) + 1;
  return Math.max(1, elapsed);   // at least 1 month billed
}
window.getMonthsBilledSinceCutoff = getMonthsBilledSinceCutoff;

// 4. All-time outstanding balance for a student
// = openingBalance + (netMonthlyFee × monthsBilled) − allTimePaid
// The month multiplier turns "previous month unpaid" into a growing balance
// automatically as time passes — carry-forward runs on its own, every month.
function getStuOutstanding(st, classFees, paidMaps) {
  if (!isActiveStu(st)) return 0;  // left students excluded from active outstanding
  const cf       = Number(classFees[st.cls] || 0);
  const ob       = Number(st.openingBalance || 0);
  const autoDisc = getStuDisc(st, classFees);
  const recDisc  = paidMaps.discMap[st.id] || 0;
  const effDisc  = Math.max(autoDisc, recDisc);
  const netFee   = Math.max(0, cf - effDisc);
  const monthsBilled = getMonthsBilledSinceCutoff();
  const totalDemand  = (netFee * monthsBilled) + ob;
  const paid     = paidMaps.feeMap[st.id] || 0;
  return Math.max(0, totalDemand - paid);
}

// ── ACTIVE STATUS HELPERS — used by all modules ──────────────────────────────
const isActiveStu   = (st) => st.status !== 'left';
const isActiveStaff = (sf) => sf.status !== 'left';

// ── SHARED P&L ENGINE — single source of truth ────────────────────────────────
function calcPL({ year, period = 'annual', month = 0 }) {
  // ── Data Integrity Guard ── strip any soft-deleted records BEFORE any sum runs.
  // calcPL is the SINGLE root for Dashboard P&L, Assets & P&L page, Annual reports.
  // Reading via getActiveList ensures: (1) backup/tombstone/audit/ts keys are forbidden,
  // (2) any isDeleted/status='deleted'/archived/_tombstone/_deleted record is filtered.
  const payments = getActiveList(K.PAY);
  const cbAll    = getActiveList(K.CBOOK);
  const spays    = getActiveList(K.SPAY);
  const assets   = getActiveList(K.ASSET);
  // ── June 2026 Fresh-Start Cutoff for ANNUAL period ──
  // Annual 2026 must include ONLY June-Dec 2026 (excludes Jan-May test data).
  // Annual ≥2027 includes the full year. Monthly view respects the user's pick verbatim.
  const _isAnnualCutoff = (period !== 'monthly' && Number(year) === ENGINE_CUTOFF_YEAR);
  const payInRange = p => {
    if (period === 'monthly') return Number(p.year) === year && Number(p.month) === month;
    if (Number(p.year) !== year) return false;
    // Annual filter — apply cutoff for cutoff year only
    if (_isAnnualCutoff && Number(p.month) < ENGINE_CUTOFF_MONTH) return false;
    return true;
  };
  const dateInRange = dateStr => {
    const d = new Date(dateStr || 0);
    if (isNaN(d)) return false;
    if (period === 'monthly') return d.getFullYear() === year && d.getMonth() === month;
    if (d.getFullYear() !== year) return false;
    if (_isAnnualCutoff && d.getMonth() < ENGINE_CUTOFF_MONTH) return false;
    return true;
  };
  const feeIncome   = payments.filter(payInRange).reduce((s,p)=>s+Number(p.amount    ||0),0);
  const afIncome    = payments.filter(payInRange).reduce((s,p)=>s+Number(p.annualFund||0),0);
  const booksIncome = payments.filter(payInRange).reduce((s,p)=>s+Number(p.booksPaid ||0),0);
  // Exclude fee/books/AF/capital entries from Cash Book income — already counted via K.PAY or separate
  const cbIncome    = cbAll.filter(e=>e.type==='income'  && dateInRange(e.date)
                        && e.refType !== 'fee' && e.refType !== 'books'
                        && e.refType !== 'owner_capital' && e.refType !== 'transfer'
                        && e.refType !== 'opening_balance'  // memo only — not real cash received
                      ).reduce((s,e)=>s+Number(e.amount||0),0);
  const totalIncome = feeIncome + afIncome + booksIncome + cbIncome;

  // Exclude drawing/transfer entries from operating expenses.
  // Also exclude salary entries — those are counted via K.SPAY (single source for payroll).
  const cbExpenses  = cbAll.filter(e=>e.type==='expense' && dateInRange(e.date)
                        && e.refType !== 'owner_drawing' && e.refType !== 'transfer'
                        && e.refType !== 'salary'  // salary captured via K.SPAY — avoid double-count
                      ).reduce((s,e)=>s+Number(e.amount||0),0);
  const salaryExp   = spays.filter(p=>dateInRange(p.date)).reduce((s,p)=>s+Number(p.amount||0),0);
  const totalExpenses = cbExpenses + salaryExp;
  const netPL       = totalIncome - totalExpenses;

  // ── Owner Equity — ALL-TIME (not period filtered) ──
  const ownerCapital = cbAll.filter(e=>e.type==='income'  && e.refType==='owner_capital').reduce((s,e)=>s+Number(e.amount||0),0);
  const ownerDrawing = cbAll.filter(e=>e.type==='expense' && e.refType==='owner_drawing').reduce((s,e)=>s+Number(e.amount||0),0);
  // All-time net profit for equity calculation
  const allTimeFeeInc  = payments.reduce((s,p)=>s+Number(p.amount||0),0);
  const allTimeAFInc   = payments.reduce((s,p)=>s+Number(p.annualFund||0),0);
  const allTimeBkInc   = payments.reduce((s,p)=>s+Number(p.booksPaid||0),0);
  const allTimeCbInc   = cbAll.filter(e=>e.type==='income' && e.refType!=='fee' && e.refType!=='books' && e.refType!=='owner_capital' && e.refType!=='transfer').reduce((s,e)=>s+Number(e.amount||0),0);
  const allTimeCbExp   = cbAll.filter(e=>e.type==='expense' && e.refType!=='owner_drawing' && e.refType!=='transfer').reduce((s,e)=>s+Number(e.amount||0),0);
  const allTimeSalary  = spays.reduce((s,p)=>s+Number(p.amount||0),0);
  const allTimeNetPL   = (allTimeFeeInc + allTimeAFInc + allTimeBkInc + allTimeCbInc) - (allTimeCbExp + allTimeSalary);
  const ownerEquity    = ownerCapital + allTimeNetPL - ownerDrawing;

  // ── Quantity-aware total: Purchase/Current Value is per-unit price.
  //   Asset Book Value = Σ (currentValue × quantity). Old records lacking
  //   `quantity` default to 1, so totals never change retroactively.
  const assetValue  = assets.reduce((s,a) => {
    const qty = Math.max(1, parseInt(a && a.quantity, 10) || 1);
    return s + Number(a.currentValue || a.purchaseValue || 0) * qty;
  }, 0);
  const assetCount  = assets.length;
  // ── EMPTY-DATABASE GUARANTEE ── force every output to a finite number ──
  // If all active arrays are empty, every total becomes exactly 0.00.
  // No NaN, no undefined, no negative zero, no stale value can ever leak out.
  const _safe = n => { const v = Number(n); return Number.isFinite(v) ? v : 0; };
  return {
    feeIncome:   _safe(feeIncome),
    afIncome:    _safe(afIncome),
    booksIncome: _safe(booksIncome),
    cbIncome:    _safe(cbIncome),
    totalIncome: _safe(totalIncome),
    cbExpenses:  _safe(cbExpenses),
    salaryExp:   _safe(salaryExp),
    totalExpenses: _safe(totalExpenses),
    netPL:       _safe(netPL),
    assetValue:  _safe(assetValue),
    assetCount:  Math.max(0, Math.floor(_safe(assetCount))),
    ownerCapital:  _safe(ownerCapital),
    ownerDrawing:  _safe(ownerDrawing),
    ownerEquity:   _safe(ownerEquity),
    allTimeNetPL:  _safe(allTimeNetPL)
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ── MAJMA — UNIFIED FINANCIAL AGGREGATION ENGINE ─────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
// Single source of truth for ALL dashboard cards, Fee Collection headers,
// and any module that needs a financial snapshot. ZERO inline .reduce() loops
// allowed in any UI component. Every metric below is derived from existing
// Global Engine helpers (getStuNetMonthlyDue, getStuOutstandingFromCutoff,
// buildPaidMapsFromCutoff, getStudentBookTotal, calcPL) — no new formulas.
//
// Rule for callers (Dashboard, Fee Collection, etc.):
//   const snap = buildFinancialSnapshot({ vm, vy });
//   // Then ONLY reference snap.X — never compute your own .reduce()
//
// Inputs: { vm: 0-11 month, vy: year, payments?, students?, classFees?, bookLists? }
// (any unspecified input is auto-loaded from storage via getActiveList)
function buildFinancialSnapshot(opts) {
  const o          = opts || {};
  const students   = Array.isArray(o.students)   ? o.students   : getActiveList(K.STU);
  const payments   = Array.isArray(o.payments)   ? o.payments   : getActiveList(K.PAY);
  const cashbook   = Array.isArray(o.cashbook)   ? o.cashbook   : getActiveList(K.CBOOK);
  const expenses   = Array.isArray(o.expenses)   ? o.expenses   : getActiveList(K.EXP);
  const spays      = Array.isArray(o.spays)      ? o.spays      : getActiveList(K.SPAY);
  const inventory  = Array.isArray(o.inventory)  ? o.inventory  : getActiveList(K.INV);
  const classFees  = o.classFees && typeof o.classFees === 'object' ? o.classFees : S.get(K.CF, {});
  const bookLists  = o.bookLists && typeof o.bookLists === 'object' ? o.bookLists : S.get(K.BL, {});
  const now        = new Date();
  const vm         = Number.isFinite(o.vm) ? Number(o.vm) : now.getMonth();
  const vy         = Number.isFinite(o.vy) ? Number(o.vy) : now.getFullYear();

  // ── Single root for all per-student paid maps (cutoff-filtered: June 2026+ only) ──
  const paidMaps   = buildPaidMapsFromCutoff(payments);

  // ── Period-scoped payment slice (selected month) ──
  const monthPays  = payments.filter(p => Number(p.month) === vm && Number(p.year) === vy);
  const feeThisMonth   = monthPays.reduce((s, p) => s + Number(p.amount    || 0), 0);
  const afThisMonth    = monthPays.reduce((s, p) => s + Number(p.annualFund|| 0), 0);
  const booksThisMonth = monthPays.reduce((s, p) => s + Number(p.booksPaid || 0), 0);
  const incomeThisMonth= feeThisMonth + afThisMonth + booksThisMonth;

  // ── All-time collections (post-cutoff) ──
  const feeAllTime    = payments.reduce((s, p) => s + Number(p.amount    || 0), 0);
  const afAllTime     = payments.reduce((s, p) => s + Number(p.annualFund|| 0), 0);
  const booksAllTime  = payments.reduce((s, p) => s + Number(p.booksPaid || 0), 0);

  // ── Demand (what students owe — single Global-Engine root each) ──
  const feeGross      = students.reduce((s, st) => s + Number(classFees[st.cls] || 0), 0);
  const afExpected    = students.reduce((s, st) => s + Number(st.annualFund || 0), 0);
  const booksValue    = students.reduce((s, st) => s + getStudentBookTotal(st, bookLists), 0);
  const netFeeDue     = students.reduce((s, st) => s + getStuNetMonthlyDue(st, classFees), 0);
  const standingDisc  = Math.max(0, feeGross - netFeeDue);         // arithmetic identity
  const grossDemand   = feeGross + afExpected + booksValue;
  const netTarget     = netFeeDue + afExpected + booksValue;

  // ── Outstanding (UNIFIED ENGINE — Dashboard Red Card ≡ Ledger Blue Card) ──
  // Single source of truth. Both `outstandingFeeWithOB` (full per-student engine
  // including opening balance) and the cutoff-variant `outstandingFee` are
  // exposed so cards can show the 4-line breakdown that sums to `totalDue`.
  // Spec: Grand Total Net Outstanding = NetMonthlyFee + AnnualFund + Books + OB − Recoveries.
  const outstandingFee         = students.reduce((s, st) => s + getStuOutstandingFromCutoff(st, classFees, paidMaps), 0);            // pure fee due (cutoff variant, ignores OB)
  const outstandingFeeWithOB   = students.reduce((s, st) => s + getStuOutstanding(st, classFees, paidMaps), 0);                      // fee+OB outstanding (full engine)
  const obDue                  = Math.max(0, outstandingFeeWithOB - outstandingFee);                                                  // unpaid portion of opening balance
  const obTotal                = students.reduce((s, st) => isActiveStu(st) ? s + Number(st.openingBalance || 0) : s, 0);             // gross OB demand (reference)
  const outstandingAF          = students.reduce((s, st) => s + Math.max(0, Number(st.annualFund || 0) - (paidMaps.afMap[st.id]    || 0)), 0);
  const outstandingBks         = students.reduce((s, st) => s + Math.max(0, getStudentBookTotal(st, bookLists) - (paidMaps.booksMap[st.id] || 0)), 0);
  const totalDue               = outstandingFeeWithOB + outstandingAF + outstandingBks;                                               // GRAND TOTAL NET OUTSTANDING
  const outstandingCount       = students.filter(st => getStuOutstanding(st, classFees, paidMaps) > 0).length;

  // ── Period-scoped expenses (selected month) — Cash Book is THE single source ──
  const inSelMonth = e => { const d = e && e.date ? new Date(e.date) : null; return d && !isNaN(d) && d.getMonth() === vm && d.getFullYear() === vy; };
  const cbExpThisMonth = cashbook.filter(e => e.type === 'expense' && inSelMonth(e));
  const expensesThisMonthCB = cbExpThisMonth.reduce((s, e) => s + Number(e.amount || 0), 0);
  // Daily Expenses (K.EXP) scope — kept separate because it predates Cash Book in some installs
  const expEXPThisMonth = expenses.filter(e => { const d = new Date(e.date); return d.getMonth() === vm && d.getFullYear() === vy; });
  const expensesThisMonthEXP = expEXPThisMonth.reduce((s, e) => s + Number(e.amount || 0), 0);

  // ── Expense head breakdown (from Cash Book — same source the dashboard uses) ──
  const cbVendorPaidH = cbExpThisMonth.filter(e => e.refType === 'vendor').reduce((s, e) => s + Number(e.amount || 0), 0);
  const cbSalariesH   = cbExpThisMonth.filter(e => e.refType !== 'vendor' && /^salary\b/i.test(e.description || '') && !/guard|sweep/i.test(e.description || '')).reduce((s, e) => s + Number(e.amount || 0), 0);
  const cbGuardH      = cbExpThisMonth.filter(e => /guard/i.test(e.description || '')).reduce((s, e) => s + Number(e.amount || 0), 0);
  const cbSweeperH    = cbExpThisMonth.filter(e => /sweep/i.test(e.description || '')).reduce((s, e) => s + Number(e.amount || 0), 0);
  const cbRentH       = cbExpThisMonth.filter(e => e.refType !== 'vendor' && /rent/i.test(e.description || '')).reduce((s, e) => s + Number(e.amount || 0), 0);
  const cbGeneralH    = cbExpThisMonth.filter(e => e.refType !== 'vendor' && !/^salary\b/i.test(e.description || '') && !/guard|sweep|rent/i.test(e.description || '')).reduce((s, e) => s + Number(e.amount || 0), 0);

  // ── Cash position (Cash Book is the live ledger — same as Cash Book module) ──
  const cashInHand = incomeThisMonth - expensesThisMonthCB;

  // ── Population + inventory (Global Engine: getGlobalInventoryAssetValue) ──
  const activeStudents = students.filter(isActiveStu).length;
  const totalStudents  = students.length;
  const invStats       = getGlobalInventoryAssetValue(inventory);
  const lowStockCount  = invStats.lowStockCount;
  const invAssetCost   = invStats.totalCost;     // ← Balance Sheet "Current Assets" line
  const invAssetRetail = invStats.totalRetail;   // ← optional resale value display

  // ── Salary all-time (for Tier 2 view) ──
  const totalSalaryPaid = spays.reduce((s, p) => s + Number(p.amount || 0), 0);

  return {
    // Period
    vm, vy,
    // Students
    activeStudents, totalStudents,
    // This-month collections
    feeThisMonth, afThisMonth, booksThisMonth, incomeThisMonth,
    // All-time collections
    feeAllTime, afAllTime, booksAllTime,
    // Demand
    feeGross, afExpected, booksValue, netFeeDue, standingDisc, grossDemand, netTarget,
    // Outstanding (unified — Dashboard Red Card ≡ Ledger Blue Card)
    outstandingFee, outstandingFeeWithOB, obDue, obTotal,
    outstandingAF, outstandingBks, totalDue, outstandingCount,
    // Expenses
    expensesThisMonthCB, expensesThisMonthEXP,
    cbVendorPaidH, cbSalariesH, cbGuardH, cbSweeperH, cbRentH, cbGeneralH,
    // Cash + salary
    cashInHand, totalSalaryPaid,
    // Inventory (via getGlobalInventoryAssetValue — single source)
    lowStockCount, invAssetCost, invAssetRetail,
    // Underlying maps — exposed for advanced consumers (e.g. per-student rows)
    paidMaps,
  };
}
window.buildFinancialSnapshot = buildFinancialSnapshot;

// ═══════════════════════════════════════════════════════════════════════════
// ── EXTENSION #1: buildFamilySnapshot — per-family rollup (v73) ───────────
// ═══════════════════════════════════════════════════════════════════════════
// Same Majma engine, scoped to a subset of students (one family). Replaces
// the 12+ inline .reduce() loops in FamilyLedger. Returns the full snap
// shape PLUS family-specific fields (siblingCount, openingBalanceFam,
// perStudent breakdown).
function buildFamilySnapshot(familyStudents, opts) {
  if (!Array.isArray(familyStudents) || familyStudents.length === 0) {
    return buildFinancialSnapshot({ ...opts, students: [] });
  }
  const snap      = buildFinancialSnapshot({ ...(opts || {}), students: familyStudents });
  const classFees = (opts && opts.classFees) || S.get(K.CF, {});
  const bookLists = (opts && opts.bookLists) || S.get(K.BL, {});
  const openingBalanceFam = familyStudents.reduce((s, st) => s + Number(st.openingBalance || 0), 0);
  const perStudent = familyStudents.map(st => ({
    id:        st.id,
    name:      st.name,
    cls:       st.cls,
    classFee:  Number(classFees[st.cls] || 0),
    netFee:    getStuNetMonthlyDue(st, classFees),
    paid:      snap.paidMaps.feeMap[st.id]    || 0,
    afPaid:    snap.paidMaps.afMap[st.id]     || 0,
    booksPaid: snap.paidMaps.booksMap[st.id]  || 0,
    afExpected:  Number(st.annualFund || 0),
    booksValue:  getStudentBookTotal(st, bookLists),
    due:       getStuOutstandingFromCutoff(st, classFees, snap.paidMaps),
    openingBal:Number(st.openingBalance || 0),
  }));
  return Object.assign({}, snap, {
    siblingCount: familyStudents.length,
    openingBalanceFam,
    perStudent,
  });
}
window.buildFamilySnapshot = buildFamilySnapshot;

// ═══════════════════════════════════════════════════════════════════════════
// ── EXTENSION #2: buildCashBookSnapshot — accounts + ledger totals (v73) ──
// ═══════════════════════════════════════════════════════════════════════════
// Replaces inline reduces in CashBook component and Dashboard's account
// wallets section. June 2026 cutoff applied identically to every consumer.
function buildCashBookSnapshot(opts) {
  const o         = opts || {};
  const cashbook  = Array.isArray(o.cashbook) ? o.cashbook : getActiveList(K.CBOOK);
  const accounts  = Array.isArray(o.accounts) ? o.accounts : getAccounts();
  const now       = new Date();
  const vm        = Number.isFinite(o.vm) ? Number(o.vm) : now.getMonth();
  const vy        = Number.isFinite(o.vy) ? Number(o.vy) : now.getFullYear();

  // ── Per-account live balance (cutoff-filtered, identical rule everywhere) ─
  const balances = {};
  accounts.forEach(a => { balances[a.id] = Number(a.openingBalance || 0); });
  cashbook.forEach(e => {
    if (balances[e.accountId] === undefined) return;
    const d = new Date(e.date || 0);
    if (isNaN(d)) return;
    if (d.getFullYear() < ENGINE_CUTOFF_YEAR) return;
    if (d.getFullYear() === ENGINE_CUTOFF_YEAR && d.getMonth() < ENGINE_CUTOFF_MONTH) return;
    balances[e.accountId] += e.type === 'income' ? Number(e.amount) : -Number(e.amount);
  });
  const totalLiquidity = Object.values(balances).reduce((s, v) => s + v, 0);

  // ── All-time income/expense (cutoff applied) ──
  const inCutoff = e => {
    const d = new Date(e.date || 0);
    if (isNaN(d) || d.getFullYear() < ENGINE_CUTOFF_YEAR) return false;
    if (d.getFullYear() === ENGINE_CUTOFF_YEAR && d.getMonth() < ENGINE_CUTOFF_MONTH) return false;
    return true;
  };
  const eligible      = cashbook.filter(inCutoff);
  const totalIncomeAllTime  = eligible.filter(e => e.type === 'income') .reduce((s, e) => s + Number(e.amount || 0), 0);
  const totalExpAllTime     = eligible.filter(e => e.type === 'expense').reduce((s, e) => s + Number(e.amount || 0), 0);
  const netAllTime          = totalIncomeAllTime - totalExpAllTime;

  // ── This-month snapshot ──
  const inSel = e => { const d = new Date(e.date || 0); return !isNaN(d) && d.getMonth() === vm && d.getFullYear() === vy; };
  const monthEntries  = cashbook.filter(inSel);
  const monthIncome   = monthEntries.filter(e => e.type === 'income') .reduce((s, e) => s + Number(e.amount || 0), 0);
  const monthExpense  = monthEntries.filter(e => e.type === 'expense').reduce((s, e) => s + Number(e.amount || 0), 0);

  return {
    vm, vy,
    balances, totalLiquidity,
    totalIncomeAllTime, totalExpAllTime, netAllTime,
    monthIncome, monthExpense, monthNet: monthIncome - monthExpense,
    accountsCount: accounts.length,
  };
}
window.buildCashBookSnapshot = buildCashBookSnapshot;

// ═══════════════════════════════════════════════════════════════════════════
// ── EXTENSION #3: assertSnapshotMirror — REAL cross-component drift detector
// ═══════════════════════════════════════════════════════════════════════════
// v74 UPGRADE: The previous version compared buildFinancialSnapshot({}) to
// itself — a pure function returning identical output for identical input,
// so the check was tautological (could never fail).
//
// v74 truly detects drift by comparing values that the LIVE UI components
// have actually bound to their JSX. Each financial page now registers its
// displayed numbers into window._DRIFT_REGISTRY during render. This function
// cross-compares them. If any component computes a different value for the
// same logical metric, this fires a real warning.
//
// USAGE (in browser console):
//   window._DISS_DEBUG = true;
//   window.assertSnapshotMirror();      // logs any divergence
//   window._DISS_DEBUG = 'verbose';     // also logs success confirmations
//   window._DRIFT_REGISTRY;             // inspect registered values
//
// Page coverage: Dashboard, FeeCollection, StudentLedger, CashBook,
// FamilyLedger — populated when each page is rendered at least once.
function assertSnapshotMirror() {
  if (!window._DISS_DEBUG) return;
  const reg = window._DRIFT_REGISTRY || {};
  const D = reg.Dashboard, F = reg.FeeCollection, L = reg.StudentLedger,
        C = reg.CashBook,  Fa= reg.FamilyLedger;

  // Cross-component parity checks — only run when both ends have registered.
  // Tolerance: 0.01 (1 paisa) to absorb floating-point representation noise.
  const checks = [];
  if (D && F) {
    checks.push(['Dashboard.netFeeDue  vs FC.netFeeDue',  D.netFeeDue,  F.netFeeDue]);
    checks.push(['Dashboard.totalDue   vs FC.totalDue',   D.totalDue,   F.totalDue]);
    checks.push(['Dashboard.feeGross   vs FC.feeGross',   D.feeGross,   F.feeGross]);
  }
  if (D && L) {
    checks.push(['Dashboard.totalDue   vs Ledger.totalDue',   D.totalDue,   L.totalDue]);
    checks.push(['Dashboard.netFeeDue  vs Ledger.netFeeDue',  D.netFeeDue,  L.netFeeDue]);
    checks.push(['Dashboard.afExpected vs Ledger.afExpected', D.afExpected, L.afExpected]);
  }
  if (F && L) {
    checks.push(['FC.totalDue          vs Ledger.totalDue',   F.totalDue,   L.totalDue]);
  }
  if (D && C) {
    checks.push(['Dashboard.feeAllTime vs CashBook.feeCollAllTime', D.feeAllTime, C.feeCollAllTime]);
    checks.push(['Dashboard.afAllTime  vs CashBook.afCollAllTime',  D.afAllTime,  C.afCollAllTime]);
    checks.push(['Dashboard.booksAllTime vs CashBook.booksAllTime', D.booksAllTime, C.booksAllTime]);
  }

  let drifted = 0;
  checks.forEach(function(c) {
    const label = c[0], a = Number(c[1] || 0), b = Number(c[2] || 0);
    if (Math.abs(a - b) > 0.01) {
      console.warn('🔴 MAJMA DRIFT — ' + label + '   a=' + a + '   b=' + b + '   Δ=' + (a - b).toFixed(2));
      drifted++;
    }
  });

  if (checks.length === 0) {
    console.warn('⚠️ MAJMA — no UI bindings registered yet. Visit Dashboard / FeeCollection / Ledger / CashBook to populate _DRIFT_REGISTRY.');
    return { ok: true, checks: 0, drifted: 0 };
  }
  if (drifted === 0 && window._DISS_DEBUG === 'verbose') {
    console.log('✅ MAJMA mirror OK — ' + checks.length + ' cross-component checks passed.');
  }
  return { ok: drifted === 0, checks: checks.length, drifted: drifted, registry: reg };
}
window.assertSnapshotMirror = assertSnapshotMirror;

// Always return current time — never stale (getter, not static value)
Object.defineProperty(window, 'NOW', { get: () => new Date(), configurable: true });
Object.defineProperty(window, '_NOW', { get: () => new Date() });

// ── Shared UI ────────────────────────────────────────────────────────────────
function Modal({ title, onClose, children, wide = false, xl = false }) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-3">
      <div className={`bg-white rounded-2xl shadow-2xl w-full ${xl ? 'max-w-4xl' : wide ? 'max-w-2xl' : 'max-w-md'} max-h-[95vh] flex flex-col`}>
        <div className="flex items-center justify-between px-5 py-4 border-b shrink-0">
          <h3 className="text-base font-bold text-gray-800">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-2xl leading-none w-7 h-7 flex items-center justify-center rounded-full hover:bg-gray-100">&times;</button>
        </div>
        <div className="overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div className="mb-3">
      {label && <label className="block text-xs font-semibold text-gray-600 mb-1 uppercase tracking-wide">{label}</label>}
      {children}
    </div>
  );
}

const inputCls = "w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white";

function Inp({ label, ...p }) {
  return <Field label={label}><input {...p} className={inputCls}/></Field>;
}

function Sel({ label, options, value, onChange }) {
  return (
    <Field label={label}>
      <select value={value} onChange={onChange} className={inputCls}>
        {options.map(o => <option key={o.v ?? o} value={o.v ?? o}>{o.l ?? o}</option>)}
      </select>
    </Field>
  );
}

function Btn({ children, variant = 'blue', sm, full, onClick, disabled, type = 'button' }) {
  const v = {
    blue:    'bg-blue-600 hover:bg-blue-700 text-white',
    green:   'bg-emerald-600 hover:bg-emerald-700 text-white',
    red:     'bg-red-500 hover:bg-red-600 text-white',
    outline: 'border border-gray-200 hover:bg-gray-50 text-gray-700',
    ghost:   'hover:bg-gray-100 text-gray-500',
    yellow:  'bg-amber-500 hover:bg-amber-600 text-white',
    purple:  'bg-purple-600 hover:bg-purple-700 text-white',
  }[variant] || '';
  return (
    <button type={type} onClick={onClick} disabled={disabled}
      className={`${v} ${sm ? 'px-2.5 py-1 text-xs' : 'px-4 py-2 text-sm'} ${full ? 'w-full' : ''} rounded-lg font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed`}>
      {children}
    </button>
  );
}

function Badge({ children, color = 'blue' }) {
  const c = { blue:'bg-blue-50 text-blue-700', green:'bg-emerald-50 text-emerald-700', red:'bg-red-50 text-red-700', yellow:'bg-amber-50 text-amber-700', gray:'bg-gray-100 text-gray-600', purple:'bg-purple-50 text-purple-700', orange:'bg-orange-50 text-orange-600' }[color];
  return <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${c}`}>{children}</span>;
}

function Card({ children, className = '' }) {
  return <div className={`bg-white rounded-2xl border border-gray-100 shadow-sm ${className}`}>{children}</div>;
}

function Empty({ icon, text }) {
  return (
    <Card className="p-10 text-center">
      <div className="text-5xl mb-3">{icon}</div>
      <p className="text-gray-400 text-sm">{text}</p>
    </Card>
  );
}

// ── LOGIN SCREEN ─────────────────────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [tab, setTab]         = useState('staff');
  const [uname, setUname]     = useState('');
  const [pass, setPass]       = useState('');
  const [err, setErr]         = useState('');
  const [showPass, setShowPass] = useState(false);
  const [regMode, setRegMode] = useState(false);
  const [reg, setReg]         = useState({ username:'', password:'', confirm:'', name:'' });
  const [regMsg, setRegMsg]   = useState('');

  const switchTab = (t) => { setTab(t); setErr(''); setRegMode(false); setRegMsg(''); setUname(''); setPass(''); };

  const [syncing, setSyncing] = useState(!window._fbSyncDone);
  React.useEffect(() => {
    if (window._fbSyncDone) { setSyncing(false); return; }
    const iv = setInterval(() => { if (window._fbSyncDone) { setSyncing(false); clearInterval(iv); } }, 300);
    const tm = setTimeout(() => { setSyncing(false); clearInterval(iv); }, 8000);
    return () => { clearInterval(iv); clearTimeout(tm); };
  }, []);

  const [loginAttempts, setLoginAttempts] = useState(0);
  const [showRecovery, setShowRecovery]   = useState(false);
  const [recoveryCode, setRecoveryCode]   = useState('');
  const [recoveryErr, setRecoveryErr]     = useState('');

  const login = async () => {
    // Wait for Firebase sync (up to 6s)
    if (!window._fbSyncDone && window._fbDB) {
      setSyncing(true);
      await new Promise(res => {
        const iv = setInterval(() => { if (window._fbSyncDone) { clearInterval(iv); res(); } }, 200);
        setTimeout(() => { clearInterval(iv); res(); }, 6000);
      });
      setSyncing(false);
    }
    let users = S.get(K.USERS, []);
    // Always ensure at least one admin exists
    if (!users.find(u => u.role === 'admin')) {
      const admin = { id: uid(), username: 'admin', password: 'admin', name: 'Administrator', role: 'admin' };
      users = [...users, admin];
      S.set(K.USERS, users);
    }
    const user = users.find(u => u.username === uname.trim() && u.password === pass);
    if (!user) {
      const attempts = loginAttempts + 1;
      setLoginAttempts(attempts);
      setErr('Invalid username or password.');
      if (attempts >= 5) setShowRecovery(true);
      return;
    }
    if (tab === 'staff' && user.role === 'parent') { setErr('Please use the Parent Login tab.'); return; }
    if (tab === 'parent' && user.role !== 'parent') { setErr('Please use the Admin / Staff Login tab.'); return; }
    if (user.status === 'pending') { setErr('Your account is pending admin approval. Please wait.'); return; }
    if (user.status === 'rejected') { setErr('Your registration was rejected. Contact the school office.'); return; }
    if (user.disabled) { setErr('Your account has been disabled. Please contact the school office.'); return; }
    setSession(user); onLogin(user);
  };

  const emergencyReset = () => {
    setRecoveryErr('');
    const perm = S.get(K.PERM, {});
    const masterCode = perm.masterCode || '1234';
    if (recoveryCode !== masterCode) { setRecoveryErr('Wrong master code. Default is: 1234'); return; }
    // Reset or create admin account, keep all other users
    let users = S.get(K.USERS, []);
    const hasAdmin = users.find(u => u.role === 'admin');
    if (hasAdmin) {
      users = users.map(u => u.role === 'admin' ? { ...u, username: 'admin', password: 'admin', disabled: false } : u);
    } else {
      users = [...users, { id: uid(), username: 'admin', password: 'admin', name: 'Administrator', role: 'admin' }];
    }
    S.set(K.USERS, users);
    setUname('admin'); setPass('admin'); setErr(''); setRecoveryCode('');
    setShowRecovery(false); setLoginAttempts(0);
    alert('✅ Admin access restored!\nUsername: admin  |  Password: admin\nClick Sign In to continue.');
  };

  const register = () => {
    setRegMsg('');
    if (!reg.name.trim())     { setRegMsg('Please enter your full name.'); return; }
    if (!reg.username.trim()) { setRegMsg('Please choose a username.'); return; }
    if (!reg.password.trim()) { setRegMsg('Please enter a password.'); return; }
    if (reg.password !== reg.confirm) { setRegMsg('Passwords do not match.'); return; }
    const users = S.get(K.USERS, []);
    if (users.find(u => u.username === reg.username.trim())) { setRegMsg('Username already taken. Please choose another.'); return; }
    const newUser = { id: uid(), username: reg.username.trim(), password: reg.password, name: reg.name.trim(), role: 'parent', familyId: '', status: 'pending' };
    S.set(K.USERS, [...users, newUser]);
    const preqs = S.get(K.PREQ, []);
    S.set(K.PREQ, [...preqs, { ...newUser, requestedAt: new Date().toISOString() }]);
    setReg({ username:'', password:'', confirm:'', name:'' });
    setRegMode(false);
    alert('Registration submitted!\nYour request has been sent to the school admin.\nYou can login once the admin approves and assigns your Family ID.');
  };

  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-8">
        <div className="text-center mb-5">
          <img src={LOGO_SRC} alt="DISS" className="h-20 object-contain mx-auto mb-3" onError={e => { e.target.style.display='none'; }}/>
          <h2 className="text-base font-bold text-gray-800">School Management System</h2>
          <p className="text-xs text-gray-400 mt-0.5">Discovery International School System</p>
        </div>

        {/* Sync banner */}
        {syncing && (
          <div className="flex items-center gap-2 bg-blue-50 border border-blue-200 text-blue-700 text-xs px-3 py-2 rounded-xl mb-4">
            <span className="animate-spin inline-block">⏳</span>
            <span>Syncing data from cloud, please wait…</span>
          </div>
        )}

        {/* Tab Switcher */}
        <div className="flex rounded-xl overflow-hidden border border-gray-200 mb-5">
          <button onClick={() => switchTab('staff')}
            className={`flex-1 py-2 text-xs font-bold transition-all ${tab==='staff' ? 'bg-red-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}>
            🔐 Admin / Staff
          </button>
          <button onClick={() => switchTab('parent')}
            className={`flex-1 py-2 text-xs font-bold transition-all ${tab==='parent' ? 'bg-red-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}>
            👨‍👩‍👧 Parent
          </button>
        </div>

        {/* ── Staff / Admin / Teacher Login ── */}
        {tab === 'staff' && (
          <>
            {err && <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-xl mb-4">{err}</div>}
            <div className="mb-3">
              <label className="block text-xs font-semibold text-gray-600 mb-1 uppercase tracking-wide">Username</label>
              <input value={uname} onChange={e => { setUname(e.target.value); setErr(''); }}
                onKeyDown={e => e.key === 'Enter' && login()}
                className={inputCls} placeholder="Enter username" autoFocus/>
            </div>
            <div className="mb-5">
              <label className="block text-xs font-semibold text-gray-600 mb-1 uppercase tracking-wide">Password</label>
              <div className="relative">
                <input type={showPass ? 'text' : 'password'} value={pass}
                  onChange={e => { setPass(e.target.value); setErr(''); }}
                  onKeyDown={e => e.key === 'Enter' && login()}
                  className={inputCls + ' pr-10'} placeholder="Enter password"/>
                <button type="button" onClick={() => setShowPass(!showPass)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs">
                  {showPass ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>
            <button onClick={login} disabled={syncing}
              className="w-full bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white font-bold py-2.5 rounded-xl transition-all text-sm">
              {syncing ? '⏳ Syncing...' : 'Sign In'}
            </button>
            <p className="text-center text-xs text-gray-400 mt-3">Contact admin if you need login credentials.</p>

            {/* Emergency Recovery Panel */}
            {showRecovery && (
              <div className="mt-4 border border-amber-300 bg-amber-50 rounded-xl p-4">
                <p className="text-xs font-bold text-amber-800 mb-1">🆘 Emergency Admin Recovery</p>
                <p className="text-xs text-amber-700 mb-3">Enter master code to reset admin password back to default.</p>
                <input
                  type="password" value={recoveryCode}
                  onChange={e => { setRecoveryCode(e.target.value); setRecoveryErr(''); }}
                  onKeyDown={e => e.key === 'Enter' && emergencyReset()}
                  placeholder="Enter master code"
                  className="w-full border border-amber-300 rounded-lg px-3 py-2 text-sm mb-2 outline-none focus:border-amber-500"/>
                {recoveryErr && <p className="text-xs text-red-600 mb-2">{recoveryErr}</p>}
                <div className="flex gap-2">
                  <button onClick={emergencyReset} className="flex-1 bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold py-2 rounded-lg">
                    🔓 Restore Admin
                  </button>
                  <button onClick={() => { setShowRecovery(false); setRecoveryCode(''); setRecoveryErr(''); }}
                    className="text-xs text-gray-500 px-3 py-2 rounded-lg hover:bg-gray-100">Cancel</button>
                </div>
              </div>
            )}
            {!showRecovery && loginAttempts >= 5 && (
              <p className="text-center mt-2">
                <button onClick={() => setShowRecovery(true)} className="text-xs text-gray-400 hover:text-amber-600 underline">
                  Forgot password? Emergency reset
                </button>
              </p>
            )}
          </>
        )}

        {/* ── Parent Login ── */}
        {tab === 'parent' && !regMode && (
          <>
            {err && <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-xl mb-4">{err}</div>}
            <div className="mb-3">
              <label className="block text-xs font-semibold text-gray-600 mb-1 uppercase tracking-wide">Username</label>
              <input value={uname} onChange={e => { setUname(e.target.value); setErr(''); }}
                onKeyDown={e => e.key === 'Enter' && login()}
                className={inputCls} placeholder="Your username"/>
            </div>
            <div className="mb-5">
              <label className="block text-xs font-semibold text-gray-600 mb-1 uppercase tracking-wide">Password</label>
              <div className="relative">
                <input type={showPass ? 'text' : 'password'} value={pass}
                  onChange={e => { setPass(e.target.value); setErr(''); }}
                  onKeyDown={e => e.key === 'Enter' && login()}
                  className={inputCls + ' pr-10'} placeholder="Your password"/>
                <button type="button" onClick={() => setShowPass(!showPass)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs">
                  {showPass ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>
            <button onClick={login}
              className="w-full bg-red-600 hover:bg-red-700 text-white font-bold py-2.5 rounded-xl transition-all text-sm">
              Sign In
            </button>
            <div className="text-center mt-4">
              <p className="text-xs text-gray-400">New parent? <button onClick={() => { setRegMode(true); setErr(''); setRegMsg(''); }} className="text-red-600 font-semibold hover:underline">Create Account</button></p>
            </div>
          </>
        )}

        {/* ── Parent Registration ── */}
        {tab === 'parent' && regMode && (
          <>
            <div className="bg-blue-50 border border-blue-200 text-blue-700 text-xs px-3 py-2 rounded-xl mb-4 leading-relaxed">
              Register your account. The school admin will review your request and assign your Family ID to activate your login.
            </div>
            {regMsg && <div className="bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2 rounded-xl mb-3">{regMsg}</div>}
            <div className="mb-3">
              <label className="block text-xs font-semibold text-gray-600 mb-1 uppercase tracking-wide">Your Full Name *</label>
              <input value={reg.name} onChange={e => setReg({...reg, name: e.target.value})}
                className={inputCls} placeholder="Parent / Guardian name"/>
            </div>
            <div className="mb-3">
              <label className="block text-xs font-semibold text-gray-600 mb-1 uppercase tracking-wide">Choose Username *</label>
              <input value={reg.username} onChange={e => setReg({...reg, username: e.target.value})}
                className={inputCls} placeholder="Login username"/>
            </div>
            <div className="mb-3">
              <label className="block text-xs font-semibold text-gray-600 mb-1 uppercase tracking-wide">Password *</label>
              <input type="password" value={reg.password} onChange={e => setReg({...reg, password: e.target.value})}
                className={inputCls} placeholder="Create password"/>
            </div>
            <div className="mb-4">
              <label className="block text-xs font-semibold text-gray-600 mb-1 uppercase tracking-wide">Confirm Password *</label>
              <input type="password" value={reg.confirm} onChange={e => setReg({...reg, confirm: e.target.value})}
                className={inputCls} placeholder="Repeat password"/>
            </div>
            <button onClick={register}
              className="w-full bg-red-600 hover:bg-red-700 text-white font-bold py-2.5 rounded-xl transition-all text-sm mb-2">
              Submit Registration
            </button>
            <button onClick={() => { setRegMode(false); setRegMsg(''); }}
              className="w-full border border-gray-200 text-gray-600 font-semibold py-2 rounded-xl text-sm hover:bg-gray-50 transition-all">
              ← Back to Login
            </button>
          </>
        )}

        <p className="text-center text-xs text-gray-300 mt-6 leading-tight">© 2026 DISS — All Rights Reserved<br/>Powered by Tataheer Business Group<br/>+923218555566</p>
      </div>
    </div>
  );
}

// ── PARENT PORTAL ────────────────────────────────────────────────────────────
function ParentPortal({ currentUser, onLogout }) {
  const [tab, setTab] = useState('fee');
  const [tick, setTick] = useState(0);

  // ── Firebase real-time listeners — keep parent data live ──
  useEffect(() => {
    if (!window._fbDB) return;
    const keys = [K.STU, K.CF, K.PAY, K.NOTIF, K.COMP];
    let refs = [];
    const attach = () => {
      refs = keys.map(k => {
        const ref = window._fbDB.ref('sms/' + k);
        ref.on('value', snap => {
          const val = snap.val();
          if (val !== null && val !== undefined) {
            localStorage.setItem(k, JSON.stringify(val));
            setTick(t => t + 1);
          }
        });
        return ref;
      });
    };
    if (window._fbAuthReady) { attach(); }
    else {
      const iv = setInterval(() => { if (window._fbAuthReady) { clearInterval(iv); attach(); } }, 200);
      return () => { clearInterval(iv); refs.forEach(r => r.off('value')); };
    }
    return () => refs.forEach(r => r.off('value'));
  }, []);

  const familyId = currentUser.familyId || '';
  const students  = S.get(K.STU, []).filter(s => s.familyId && s.familyId.trim() === familyId.trim());
  const classFees = S.get(K.CF, {});
  const payments  = S.get(K.PAY, []);
  const notifs    = S.get(K.NOTIF, []);
  const comps     = S.get(K.COMP, []);
  const NOW2      = new Date();
  const curM      = NOW2.getMonth(), curY = NOW2.getFullYear();

  // ── Complaint form state ──
  const [cForm, setCForm] = useState({ subject:'', message:'', type:'complaint', attachData: null, attachName: '', attachType: '' });
  const [cSent, setCSent] = useState(false);
  const [cUploading, setCUploading] = useState(false);
  const cFileRef = React.useRef();

  const handleCFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setCUploading(true);
    const reader = new FileReader();
    reader.onload = ev => {
      setCForm(f => ({ ...f, attachData: ev.target.result, attachName: file.name, attachType: file.type.startsWith('image') ? 'image' : 'pdf' }));
      setCUploading(false);
    };
    reader.readAsDataURL(file);
  };

  const submitComplaint = () => {
    if (!cForm.subject.trim() || !cForm.message.trim()) { alert('Please fill in subject and message.'); return; }
    const entry = { id: uid(), parentId: currentUser.id, parentName: currentUser.name, familyId, subject: cForm.subject.trim(), message: cForm.message.trim(), type: cForm.type, attachData: cForm.attachData || null, attachName: cForm.attachName || '', attachType: cForm.attachType || '', submittedAt: new Date().toISOString(), status: 'open' };
    S.set(K.COMP, [...comps, entry]);
    setCForm({ subject:'', message:'', type:'complaint', attachData: null, attachName: '', attachType: '' });
    if (cFileRef.current) cFileRef.current.value = '';
    setCSent(true);
    setTimeout(() => setCSent(false), 4000);
  };

  // ── Fee calculations per student ──
  const feeData = students.map(s => {
    const classFee     = Number(classFees[s.cls] || 0);
    const customFee    = Number(s.monthlyFee || 0);
    const allPays      = payments.filter(p => p.stuId === s.id);
    const curMonthPays = allPays.filter(p => p.month === curM && p.year === curY);
    const paidThisMonth    = curMonthPays.reduce((t, p) => t + Number(p.amount || 0), 0);
    const payDiscThisMonth = curMonthPays.reduce((t, p) => t + Number(p.discount || 0), 0);
    // ── Global Engine: use core discount & fee functions ──────────────────
    const autoDisc = getStuDisc(s, classFees);
    const discount = autoDisc > 0 ? autoDisc : payDiscThisMonth;
    const fee      = getStuNetMonthlyDue(s, classFees);
    const lastPay  = [...allPays].sort((a, b) => new Date(b.date) - new Date(a.date))[0];
    const totalPaid = allPays.reduce((t, p) => t + Number(p.amount || 0), 0);
    const afPaid    = allPays.reduce((t, p) => t + Number(p.annualFund || 0), 0);
    const afDue     = Number(s.annualFund || 0);
    const afBalance = Math.max(0, afDue - afPaid);
    return { s, fee, discount, classFee, paidThisMonth, lastPay, totalPaid, afBalance };
  });

  // ── Notifications for this family's classes ──
  const myClasses = [...new Set(students.map(s => s.cls))];
  const myNotifs  = notifs.filter(n => n.cls === 'All' || myClasses.includes(n.cls))
                          .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));

  const TABS = [
    { id:'fee',        icon:'💰', label:'Fee Status' },
    { id:'notif',      icon:'📢', label:'Notifications' },
    { id:'complaint',  icon:'📝', label:'Messages' },
  ];

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col">
      {/* Header */}
      <div className="h-1 bg-gradient-to-r from-red-500 via-amber-400 to-red-600"/>
      <header className="bg-white border-b border-gray-200 shadow-sm px-4 py-3 flex items-center gap-3">
        <img src={LOGO_SRC} alt="DISS" className="h-10 object-contain" onError={e => { e.target.style.display='none'; }}/>
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-bold text-gray-800 leading-tight">Parent Portal</h1>
          <p className="text-xs text-gray-400 leading-tight truncate">Welcome, {currentUser.name}</p>
        </div>
        <button onClick={onLogout} className="text-xs text-gray-500 hover:text-red-600 px-3 py-1.5 rounded-lg hover:bg-red-50 border border-gray-200 transition-all">⏏ Logout</button>
      </header>

      {/* Family info banner */}
      {students.length === 0 && (
        <div className="m-4 bg-amber-50 border border-amber-200 text-amber-700 text-sm px-4 py-3 rounded-xl">
          ⚠️ No students found for Family ID: <strong>{familyId}</strong>. Please contact the school office.
        </div>
      )}

      {/* Tab Nav */}
      <div className="bg-white border-b border-gray-200 px-4 flex gap-1 overflow-x-auto">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 px-4 py-3 text-xs font-semibold whitespace-nowrap border-b-2 transition-all
              ${tab===t.id ? 'border-red-600 text-red-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      <main className="flex-1 p-4 sm:p-6 overflow-y-auto">

        {/* ── FEE STATUS ── */}
        {tab === 'fee' && (
          <div className="space-y-4">
            <h2 className="text-base font-bold text-gray-800">Fee Status — {MONTHS[curM]} {curY}</h2>
            {feeData.length === 0 && <p className="text-gray-500 text-sm">No student records found.</p>}
            {feeData.map(({ s, fee, discount, classFee, paidThisMonth, lastPay, totalPaid, afBalance }) => {
              const unpaid = Math.max(0, fee - paidThisMonth);
              const isPaid = fee > 0 && paidThisMonth >= fee;
              return (
                <div key={s.id} className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                  {/* Student header */}
                  <div className="bg-gradient-to-r from-red-600 to-red-700 px-4 py-3 flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full bg-white/20 flex items-center justify-center text-white font-bold text-sm">{s.name[0]}</div>
                    <div>
                      <p className="text-white font-bold text-sm">{s.name}</p>
                      <p className="text-red-100 text-xs">Class {s.cls} &nbsp;·&nbsp; Family ID: {s.familyId}</p>
                    </div>
                    <div className="ml-auto">
                      <span className={`px-3 py-1 rounded-full text-xs font-bold ${isPaid ? 'bg-green-400 text-green-900' : fee===0 ? 'bg-gray-300 text-gray-700' : 'bg-red-300 text-red-900'}`}>
                        {fee === 0 ? 'No Fee Set' : isPaid ? '✓ Paid' : '⚠ Unpaid'}
                      </span>
                    </div>
                  </div>
                  {/* Fee details */}
                  <div className="p-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <div className="bg-blue-50 rounded-xl p-3">
                      <p className="text-xs text-blue-600 font-semibold uppercase tracking-wide">Monthly Fee</p>
                      <p className="text-base font-bold text-blue-800 mt-0.5">Rs. {classFee.toLocaleString()}</p>
                      {discount > 0 && (
                        <>
                          <p className="text-xs text-red-500 mt-0.5">− Discount: Rs. {discount.toLocaleString()}</p>
                          <p className="text-xs font-bold text-green-700 mt-0.5">= Rs. {fee.toLocaleString()}</p>
                        </>
                      )}
                    </div>
                    <div className={`rounded-xl p-3 ${isPaid ? 'bg-green-50' : 'bg-red-50'}`}>
                      <p className={`text-xs font-semibold uppercase tracking-wide ${isPaid ? 'text-green-600' : 'text-red-600'}`}>This Month</p>
                      <p className={`text-base font-bold mt-0.5 ${isPaid ? 'text-green-800' : 'text-red-800'}`}>
                        {isPaid ? `Rs. ${paidThisMonth.toLocaleString()}` : unpaid > 0 ? `Rs. ${unpaid.toLocaleString()} Due` : 'Not Set'}
                      </p>
                    </div>
                    <div className="bg-purple-50 rounded-xl p-3">
                      <p className="text-xs text-purple-600 font-semibold uppercase tracking-wide">Annual Fund Due</p>
                      <p className={`text-base font-bold mt-0.5 ${afBalance > 0 ? 'text-red-700' : 'text-purple-800'}`}>
                        {afBalance > 0 ? `Rs. ${afBalance.toLocaleString()}` : '✓ Clear'}
                      </p>
                    </div>
                    <div className="bg-gray-50 rounded-xl p-3">
                      <p className="text-xs text-gray-500 font-semibold uppercase tracking-wide">Last Payment</p>
                      <p className="text-xs font-bold text-gray-800 mt-0.5">
                        {lastPay ? `Rs. ${Number(lastPay.amount).toLocaleString()} on ${new Date(lastPay.date).toLocaleDateString('en-PK',{day:'2-digit',month:'short',year:'numeric'})}` : 'No payments yet'}
                      </p>
                    </div>
                  </div>
                  {/* Payment history */}
                  {payments.filter(p => p.stuId === s.id).length > 0 && (
                    <div className="border-t border-gray-100 px-4 pb-4 pt-3">
                      <p className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Recent Payments</p>
                      <div className="space-y-1.5">
                        {[...payments.filter(p => p.stuId === s.id)]
                          .sort((a,b) => new Date(b.date)-new Date(a.date))
                          .slice(0,5)
                          .map(p => (
                          <div key={p.id} className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2">
                            <div>
                              <span className="text-xs font-semibold text-gray-700">{MONTHS[p.month]} {p.year}</span>
                              {p.rcpt && <span className="text-xs text-gray-400 ml-2">#{p.rcpt}</span>}
                            </div>
                            <span className="text-xs font-bold text-green-700">Rs. {Number(p.amount).toLocaleString()}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ── NOTIFICATIONS ── */}
        {tab === 'notif' && (
          <div className="space-y-3">
            <h2 className="text-base font-bold text-gray-800">School Notifications</h2>
            {myNotifs.length === 0 && (
              <div className="bg-white rounded-2xl border border-gray-100 p-8 text-center text-gray-400">
                <div className="text-3xl mb-2">📢</div>
                <p className="text-sm">No notifications yet.</p>
              </div>
            )}
            {myNotifs.map(n => (
              <div key={n.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-50 flex items-start justify-between gap-2">
                  <div>
                    <p className="font-bold text-gray-800 text-sm">{n.title}</p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {n.cls === 'All' ? 'All Classes' : `Class ${n.cls}`} &nbsp;·&nbsp;
                      {new Date(n.uploadedAt).toLocaleDateString('en-PK',{day:'2-digit',month:'short',year:'numeric'})} &nbsp;·&nbsp;
                      By {n.uploadedByName || n.uploadedBy}
                    </p>
                  </div>
                  {n.data && (
                    <div className="flex gap-1.5 shrink-0">
                      <button onClick={() => { const w = window.open('','_blank','width=800,height=700'); if(!w){alert('Popup blocked! Please allow popups.');return;} w.document.write(`<!DOCTYPE html><html><head><title>${n.title}</title><style>body{margin:0;background:#1a1a1a;display:flex;align-items:center;justify-content:center;min-height:100vh}img{max-width:100%;max-height:100vh;object-fit:contain}iframe{width:100%;height:100vh;border:none}</style></head><body>${n.fileType==='pdf' ? `<iframe src="${n.data}"></iframe>` : `<img src="${n.data}"/>`}</body></html>`); w.document.close(); }}
                        className="bg-red-600 hover:bg-red-700 text-white text-xs font-bold px-3 py-1.5 rounded-lg transition-all">
                        View / Print
                      </button>
                      <a href={n.data} download={n.title + (n.fileType === 'pdf' ? '.pdf' : '.jpg')}
                        className="bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold px-3 py-1.5 rounded-lg transition-all flex items-center gap-1">
                        ⬇ Download
                      </a>
                    </div>
                  )}
                </div>
                {n.note && <p className="px-4 py-2 text-xs text-gray-500 bg-gray-50">{n.note}</p>}
              </div>
            ))}
          </div>
        )}

        {/* ── COMPLAINTS & SUGGESTIONS ── */}
        {tab === 'complaint' && (
          <div className="space-y-4 max-w-xl">
            <h2 className="text-base font-bold text-gray-800">Messages</h2>

            {cSent && (
              <div className="bg-green-50 border border-green-200 text-green-700 text-sm px-4 py-3 rounded-xl">
                ✓ Your {cForm.type} has been submitted successfully. The school administration will review it.
              </div>
            )}

            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
              <p className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-3">Submit New</p>
              <div className="mb-3">
                <label className="block text-xs font-semibold text-gray-600 mb-1 uppercase tracking-wide">Type</label>
                <select value={cForm.type} onChange={e => setCForm({...cForm, type: e.target.value})} className={inputCls}>
                  <option value="complaint">Complaint</option>
                  <option value="suggestion">Suggestion</option>
                  <option value="leave">Leave Application</option>
                </select>
              </div>
              <div className="mb-3">
                <label className="block text-xs font-semibold text-gray-600 mb-1 uppercase tracking-wide">Subject *</label>
                <input value={cForm.subject} onChange={e => setCForm({...cForm, subject: e.target.value})}
                  className={inputCls} placeholder="Brief subject"/>
              </div>
              <div className="mb-3">
                <label className="block text-xs font-semibold text-gray-600 mb-1 uppercase tracking-wide">Message *</label>
                <textarea value={cForm.message} onChange={e => setCForm({...cForm, message: e.target.value})}
                  className={inputCls + ' resize-none'} rows="4" placeholder="Describe in detail..."/>
              </div>
              <div className="mb-4">
                <label className="block text-xs font-semibold text-gray-600 mb-1 uppercase tracking-wide">Attach Photo / File (optional)</label>
                <input ref={cFileRef} type="file" accept="image/*,application/pdf" capture="environment"
                  onChange={handleCFile}
                  className="w-full text-sm text-gray-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-bold file:bg-red-50 file:text-red-700 hover:file:bg-red-100"/>
                {cUploading && <p className="text-xs text-blue-600 mt-1">⏳ Processing...</p>}
                {cForm.attachData && <p className="text-xs text-green-600 mt-1">✓ {cForm.attachName} attached</p>}
              </div>
              <button onClick={submitComplaint}
                className="w-full bg-red-600 hover:bg-red-700 text-white font-bold py-2.5 rounded-xl text-sm transition-all">
                Submit {cForm.type === 'suggestion' ? 'Suggestion' : cForm.type === 'leave' ? 'Leave Application' : 'Complaint'}
              </button>
            </div>

            {/* My previous complaints */}
            {comps.filter(c => c.parentId === currentUser.id).length > 0 && (
              <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                <p className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-3">My Previous Submissions</p>
                <div className="space-y-2">
                  {[...comps.filter(c => c.parentId === currentUser.id)]
                    .sort((a,b) => new Date(b.submittedAt)-new Date(a.submittedAt))
                    .map(c => (
                    <div key={c.id} className="border border-gray-100 rounded-xl p-3">
                      <div className="flex items-center justify-between mb-1">
                        <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${c.type==='suggestion' ? 'bg-blue-100 text-blue-700' : c.type==='leave' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>{c.type==='leave' ? 'Leave Application' : c.type}</span>
                        <span className={`text-xs font-semibold ${c.status==='resolved' ? 'text-green-600' : c.status==='under_review' ? 'text-blue-600' : c.status==='decision_making' ? 'text-purple-600' : 'text-amber-600'}`}>
                          {c.status==='resolved' ? '✓ Resolved' : c.status==='under_review' ? '🔍 Under Review' : c.status==='decision_making' ? '⚖️ Decision Making' : '⏳ Pending'}
                        </span>
                      </div>
                      <p className="text-sm font-semibold text-gray-800">{c.subject}</p>
                      <p className="text-xs text-gray-500 mt-0.5">{new Date(c.submittedAt).toLocaleDateString('en-PK',{day:'2-digit',month:'short',year:'numeric'})}</p>
                      {c.reply && (
                        <div className="mt-2 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
                          <p className="text-xs font-bold text-blue-700 mb-0.5">↩ School Reply · {new Date(c.repliedAt).toLocaleDateString('en-PK',{day:'2-digit',month:'short',year:'numeric'})}</p>
                          <p className="text-xs text-blue-900">{c.reply}</p>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

      </main>
    </div>
  );
}

// ── NOTIFICATIONS UPLOAD (Teacher / Admin / Principal) ────────────────────────
function Notifications() {
  const { role, username, name: userName } = React.useContext(UserContext);
  const isAdmin     = role === 'admin' || role === 'principal';
  const [notifs, setNotifs]   = useState(() => S.get(K.NOTIF, []));
  const [comps, setComps]     = useState(() => S.get(K.COMP, []));
  const [tab, setTab]         = useState('notifs');
  const [form, setForm]       = useState(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = React.useRef();
  const [replyMod, setReplyMod] = useState(null); // complaint id being replied to
  const [replyText, setReplyText] = useState('');

  const persist = d => { S.set(K.NOTIF, d); setNotifs(d); };

  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    const reader = new FileReader();
    reader.onload = ev => {
      const isPdf = file.type === 'application/pdf';
      setForm(f => ({ ...f, data: ev.target.result, fileName: file.name, fileType: isPdf ? 'pdf' : 'image' }));
      setUploading(false);
    };
    reader.readAsDataURL(file);
  };

  const save = () => {
    if (!form.title.trim()) { alert('Please enter a title.'); return; }
    const entry = {
      id: uid(), title: form.title.trim(), cls: form.cls || 'All',
      note: form.note || '', data: form.data || null, fileName: form.fileName || '',
      fileType: form.fileType || 'image', uploadedBy: username, uploadedByName: userName,
      role, uploadedAt: new Date().toISOString(),
    };
    persist([entry, ...notifs]);
    setForm(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  const remove = (id) => {
    if (!window.confirm('Delete this notification?')) return;
    persist(notifs.filter(n => n.id !== id));
  };

  const downloadNotif = (n) => {
    const a = document.createElement('a');
    a.href = n.data;
    a.download = n.fileName || (n.fileType === 'pdf' ? `${n.title}.pdf` : `${n.title}.jpg`);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const setCompStatus = (id, status) => {
    const updated = comps.map(c => c.id === id ? { ...c, status } : c);
    S.set(K.COMP, updated); setComps(updated);
  };

  const COMP_STATUS = [
    { value: 'open',             label: '⏳ Open',              color: 'text-amber-600'  },
    { value: 'under_review',     label: '🔍 Under Review',      color: 'text-blue-600'   },
    { value: 'decision_making',  label: '⚖️ Decision Making',   color: 'text-purple-600' },
    { value: 'resolved',         label: '✓ Resolved',           color: 'text-green-600'  },
  ];
  const getStatusLabel = (s) => COMP_STATUS.find(x => x.value === s)?.label || '⏳ Open';
  const getStatusColor = (s) => COMP_STATUS.find(x => x.value === s)?.color || 'text-amber-600';

  const saveReply = (id) => {
    if (!replyText.trim()) return;
    const updated = comps.map(c => c.id === id
      ? { ...c, reply: replyText.trim(), repliedAt: new Date().toISOString(), repliedBy: userName || 'Admin', status: 'resolved' }
      : c);
    S.set(K.COMP, updated); setComps(updated);
    setReplyMod(null); setReplyText('');
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-xl font-bold text-gray-800">Notifications & Complaints</h2>
        {tab === 'notifs' && <Btn onClick={() => setForm({ title:'', cls:'All', note:'', data:null, fileName:'', fileType:'' })}>+ Upload Notification</Btn>}
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-1 mb-5 bg-gray-100 p-1 rounded-xl w-fit">
        <button onClick={() => setTab('notifs')} className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${tab==='notifs' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>📢 Notifications ({notifs.length})</button>
        <button onClick={() => setTab('comps')} className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${tab==='comps' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>📝 Complaints ({comps.filter(c => c.status==='open').length} open)</button>
      </div>

      {/* Notifications list */}
      {tab === 'notifs' && (
        <div className="space-y-3">
          {notifs.length === 0 && <div className="bg-white rounded-2xl border border-gray-100 p-8 text-center text-gray-400"><div className="text-3xl mb-2">📢</div><p className="text-sm">No notifications uploaded yet.</p></div>}
          {notifs.map(n => (
            <Card key={n.id} className="flex items-start gap-3 p-4">
              <div className="text-2xl mt-0.5">{n.fileType === 'pdf' ? '📄' : '🖼️'}</div>
              <div className="flex-1 min-w-0">
                <p className="font-bold text-gray-800 text-sm">{n.title}</p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {n.cls === 'All' ? 'All Classes' : `Class ${n.cls}`} &nbsp;·&nbsp;
                  {new Date(n.uploadedAt).toLocaleDateString('en-PK',{day:'2-digit',month:'short',year:'numeric'})} &nbsp;·&nbsp;
                  By {n.uploadedByName || n.uploadedBy}
                </p>
                {n.note && <p className="text-xs text-gray-500 mt-1">{n.note}</p>}
              </div>
              <div className="flex gap-1 shrink-0 flex-wrap">
                {n.data && <Btn sm variant="outline" onClick={() => { const w = window.open('','_blank','width=800,height=700'); if(!w){alert('Popup blocked! Please allow popups.');return;} w.document.write(`<!DOCTYPE html><html><head><title>${n.title}</title><style>body{margin:0;background:#111;display:flex;align-items:center;justify-content:center;min-height:100vh}img{max-width:100%;max-height:100vh}iframe{width:100%;height:100vh;border:none}</style></head><body>${n.fileType==='pdf'?`<iframe src="${n.data}"></iframe>`:`<img src="${n.data}"/>`}</body></html>`); w.document.close(); }}>View</Btn>}
                {n.data && <Btn sm variant="outline" onClick={() => downloadNotif(n)}>⬇ Download</Btn>}
                {isAdmin && <Btn sm variant="red" onClick={() => remove(n.id)}>Delete</Btn>}
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Complaints list */}
      {tab === 'comps' && (
        <div className="space-y-3">
          {comps.length === 0 && <div className="bg-white rounded-2xl border border-gray-100 p-8 text-center text-gray-400"><div className="text-3xl mb-2">📝</div><p className="text-sm">No complaints or suggestions yet.</p></div>}
          {[...comps].sort((a,b) => new Date(b.submittedAt)-new Date(a.submittedAt)).map(c => (
            <Card key={c.id} className="p-4">
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${c.type==='suggestion' ? 'bg-blue-100 text-blue-700' : c.type==='leave' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                    {c.type==='leave' ? 'Leave Application' : c.type==='suggestion' ? 'Suggestion' : 'Complaint'}
                  </span>
                  <span className={`text-xs font-semibold ${getStatusColor(c.status)}`}>{getStatusLabel(c.status)}</span>
                </div>
                {isAdmin && (
                  <select value={c.status || 'open'} onChange={e => setCompStatus(c.id, e.target.value)}
                    className="text-xs border border-gray-200 rounded-lg px-2 py-1 bg-white text-gray-700 font-semibold focus:outline-none focus:ring-2 focus:ring-red-300 cursor-pointer">
                    {COMP_STATUS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                )}
              </div>
              <p className="font-bold text-gray-800 text-sm">{c.subject}</p>
              <p className="text-xs text-gray-500 mt-0.5">{c.parentName} &nbsp;·&nbsp; Family {c.familyId} &nbsp;·&nbsp; {new Date(c.submittedAt).toLocaleDateString('en-PK',{day:'2-digit',month:'short',year:'numeric'})}</p>
              <p className="text-sm text-gray-700 mt-2 bg-gray-50 rounded-lg px-3 py-2">{c.message}</p>
              {c.attachData && (
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-xs text-gray-500">{c.attachType === 'image' ? '🖼️' : '📄'} {c.attachName}</span>
                  <button onClick={() => { const w = window.open('','_blank','width=800,height=700'); if(!w){alert('Popup blocked! Please allow popups.');return;} w.document.write(`<!DOCTYPE html><html><head><title>Attachment</title><style>body{margin:0;background:#111;display:flex;align-items:center;justify-content:center;min-height:100vh}img{max-width:100%;max-height:100vh}iframe{width:100%;height:100vh;border:none}</style></head><body>${c.attachType==='pdf'?`<iframe src="${c.attachData}"></iframe>`:`<img src="${c.attachData}"/>`}</body></html>`); w.document.close(); }}
                    className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold px-2 py-0.5 rounded-lg transition-all">View Attachment</button>
                </div>
              )}
              {/* Existing reply */}
              {c.reply && (
                <div className="mt-3 bg-blue-50 border border-blue-200 rounded-xl px-3 py-2">
                  <p className="text-xs font-bold text-blue-700 mb-0.5">↩ Reply from {c.repliedBy} · {new Date(c.repliedAt).toLocaleDateString('en-PK',{day:'2-digit',month:'short',year:'numeric'})}</p>
                  <p className="text-sm text-blue-900">{c.reply}</p>
                  {isAdmin && <button onClick={() => { setReplyMod(c.id); setReplyText(c.reply); }} className="text-xs text-blue-500 hover:text-blue-700 mt-1 font-semibold">Edit Reply</button>}
                </div>
              )}
              {/* Reply input */}
              {isAdmin && replyMod === c.id && (
                <div className="mt-3 space-y-2">
                  <textarea value={replyText} onChange={e => setReplyText(e.target.value)} rows={3}
                    placeholder="Type your reply to the parent..."
                    className="w-full border border-blue-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 resize-none"/>
                  <div className="flex gap-2">
                    <button onClick={() => saveReply(c.id)} className="bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold px-4 py-1.5 rounded-lg transition-all">Send Reply</button>
                    <button onClick={() => { setReplyMod(null); setReplyText(''); }} className="bg-gray-100 hover:bg-gray-200 text-gray-600 text-xs font-bold px-4 py-1.5 rounded-lg transition-all">Cancel</button>
                  </div>
                </div>
              )}
              {isAdmin && replyMod !== c.id && (
                <button onClick={() => { setReplyMod(c.id); setReplyText(c.reply || ''); }} className="mt-2 text-xs text-blue-600 hover:text-blue-800 font-semibold">
                  {c.reply ? '✏️ Edit Reply' : '↩ Reply'}
                </button>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* Upload modal */}
      {form && (
        <Modal title="Upload Notification" onClose={() => { setForm(null); if (fileRef.current) fileRef.current.value=''; }}>
          <Inp label="Title *" value={form.title} onChange={e => setForm({...form, title: e.target.value})} placeholder="e.g. Result Card Distribution — Class 5"/>
          <Field label="For Class">
            <select value={form.cls} onChange={e => setForm({...form, cls: e.target.value})} className={inputCls}>
              <option value="All">All Classes</option>
              {CLASSES.map(c => <option key={c} value={c}>Class {c}</option>)}
            </select>
          </Field>
          <Inp label="Note (optional)" value={form.note} onChange={e => setForm({...form, note: e.target.value})} placeholder="Any extra info"/>
          <Field label="Attach File (Photo / PDF)">
            <input ref={fileRef} type="file" accept="image/*,application/pdf" capture="environment"
              onChange={handleFile} className="w-full text-sm text-gray-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-bold file:bg-red-50 file:text-red-700 hover:file:bg-red-100"/>
          </Field>
          {uploading && <p className="text-xs text-blue-600 mb-2">⏳ Processing file...</p>}
          {form.data && <p className="text-xs text-green-600 mb-2">✓ {form.fileName} ready to upload</p>}
          <div className="flex gap-2 mt-4">
            <Btn full onClick={save}>Upload Notification</Btn>
            <Btn variant="outline" onClick={() => { setForm(null); if (fileRef.current) fileRef.current.value=''; }}>Cancel</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── DASHBOARD ────────────────────────────────────────────────────────────────
function Dashboard({ setPage }) {
  // ── Data Integrity Guard ── all financial lists routed through getActiveList
  // so soft-deleted (isDeleted / status='deleted' / archived) records never
  // contribute to dashboard totals. classFees is a settings object so left alone.
  const students  = getActiveList(K.STU);
  const inventory = getActiveList(K.INV);
  const payments  = getActiveList(K.PAY);
  const classFees = S.get(K.CF, {});
  const expenses  = getActiveList(K.EXP);

  // ── Period selector — Tier 2 Operational Summary auto-rolls every month.
  // Defaults to CURRENT month; user can pick any past month to view its snapshot.
  // Outstanding/receivable stays cumulative so unpaid prior dues remain visible.
  const [selDashMonth, setSelDashMonth] = useState(NOW.getMonth());
  const [selDashYear, setSelDashYear]   = useState(NOW.getFullYear());
  const m = selDashMonth, y = selDashYear;
  const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  // Year list: from 2026 (engine cutoff) up to current year, plus a fwd buffer
  const dashYears = (() => {
    const yrs = []; for (let yr = ENGINE_CUTOFF_YEAR; yr <= Math.max(NOW.getFullYear(), ENGINE_CUTOFF_YEAR) + 1; yr++) yrs.push(yr);
    return yrs;
  })();
  // ══════════════════════════════════════════════════════════════════════════
  // ── MAJMA — Single Aggregation Engine Call ─────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════
  // Per owner directive (v72): the Dashboard is a STATELESS PRESENTATION
  // MIRROR. It MUST NOT compute its own .reduce()/.filter()/sum loops. All
  // financial metrics come from buildFinancialSnapshot — the same utility
  // Fee Collection and any other module calls — so numbers ALWAYS match
  // operational pages. If a new metric is needed, add it inside
  // buildFinancialSnapshot ONLY; never inline here.
  const bookLists = S.get(K.BL, {});
  const snap = buildFinancialSnapshot({ vm: m, vy: y, students, payments, cashbook: getActiveList(K.CBOOK), expenses, classFees, bookLists, inventory });

  // ── v74: Register Dashboard's displayed snap values so assertSnapshotMirror
  // can cross-check them against FeeCollection / Ledger / CashBook bindings.
  if (typeof window !== 'undefined' && window._DISS_DEBUG) {
    window._DRIFT_REGISTRY = window._DRIFT_REGISTRY || {};
    window._DRIFT_REGISTRY.Dashboard = {
      netFeeDue:  snap.netFeeDue,
      totalDue:   snap.totalDue,
      afExpected: snap.afExpected,
      feeGross:   snap.feeGross,
      cashInHand: snap.cashInHand,
      netTarget:  snap.netTarget,
      feeAllTime: snap.feeAllTime,
      afAllTime:  snap.afAllTime,
      booksAllTime: snap.booksAllTime,
    };
  }

  // ── Aliases for backward-compatibility with existing JSX in this component ─
  // These are NOT new calculations — they're literal property reads on snap.
  // Each line is a pure rename so the JSX further down doesn't need changes.
  const collected            = snap.feeThisMonth;
  const monthPays            = payments.filter(p => Number(p.month) === m && Number(p.year) === y); // used by ledger drill-downs only
  const annualFundTotal      = snap.afAllTime;
  const annualFundExpected   = snap.afExpected;
  const totalExp             = snap.expensesThisMonthEXP;
  const netBalance           = collected - totalExp;
  const totalFeeCollected    = snap.feeThisMonth;
  const totalAFCollected     = snap.afThisMonth;
  const totalBooksCollected  = snap.booksThisMonth;
  const totalStudentIncome   = snap.incomeThisMonth;
  const spays                = getActiveList(K.SPAY);
  const totalSalaryPaid      = snap.totalSalaryPaid;
  const cbVendorPaidH        = snap.cbVendorPaidH;
  const cbSalariesH          = snap.cbSalariesH;
  const cbGuardH             = snap.cbGuardH;
  const cbSweeperH           = snap.cbSweeperH;
  const cbRentH              = snap.cbRentH;
  const cbGeneralH           = snap.cbGeneralH;
  const cbTotalExpH          = snap.expensesThisMonthCB;
  const cashInHand           = snap.cashInHand;
  const outstandingFee       = snap.outstandingFee;
  const outstandingAF        = snap.outstandingAF;
  const outstandingBks       = snap.outstandingBks;
  const totalDue             = snap.totalDue;
  const outstandingCount     = snap.outstandingCount;
  const totalMonthlyFee      = snap.feeGross;
  const totalAnnualFund      = snap.afExpected;
  const totalBooksValue      = snap.booksValue;
  const totalDemand          = snap.grossDemand;
  const dashNetFeeDue        = snap.netFeeDue;
  const dashTotalDiscount    = snap.standingDisc;
  const dashTotalAmount      = snap.grossDemand;
  const dashNetDue           = snap.totalDue;
  const monthAFCollected     = snap.afThisMonth;
  const monthBooksCollected  = snap.booksThisMonth;
  const monthGrandTotal      = snap.incomeThisMonth;
  const lowStock             = inventory.filter(i => Number(i.qty) <= Number(i.threshold || 5));
  const _dashPaidMaps        = snap.paidMaps;
  const allTimePaidMap       = snap.paidMaps.feeMap;
  const allTimePaidAFMap     = snap.paidMaps.afMap;
  const allTimePaidBksMap    = snap.paidMaps.booksMap;
  const allTimeDiscMap       = snap.paidMaps.discMap;
  const dashStuDisc          = (st) => getStuDisc(st, classFees);
  const inSelMonth           = (e) => { const d = e && e.date ? new Date(e.date) : null; return d && !isNaN(d) && d.getMonth() === m && d.getFullYear() === y; };
  // allExpenses kept as full historical sum (used in long-running P&L summaries)
  const allExpenses          = expenses.reduce((s, e) => s + Number(e.amount || 0), 0);
  // Pre-June dues — explicitly zeroed on dashboard per fresh-start policy
  const totalOpeningBalAll   = 0;

  // ── Tier 3 Annual P&L — shared engine (calcPL is the single P&L root) ──
  const { feeIncome:plFeeIncome, afIncome:plAFIncome, booksIncome:plBooksIncome,
          cbIncome:plCbIncome, totalIncome:plTotalIncome,
          cbExpenses:plCbExpenses, salaryExp:plSalaryExp,
          totalExpenses:plTotalExp, netPL:plNet,
          assetValue:plAssetVal, assetCount:dashAssetCount,
          ownerCapital:plOwnerCapital, ownerDrawing:plOwnerDrawing,
          ownerEquity:plOwnerEquity, allTimeNetPL:plAllTimeNetPL } = calcPL({ year: y });

  // ── Vendor Payable: Total supplied − Total paid (all vendors) ──
  // (Vendor data lives in separate keys K.SBOOK / K.VPAY — not part of student
  //  Majma. Kept inline here as a small, distinct aggregation.)
  const vendorBooks    = S.get(K.SBOOK, []);
  const vendorPayments = S.get(K.VPAY, []);
  const totalVendorSupplied = vendorBooks.reduce((s, b) => s + Number(b.qty||0)*Number(b.price||0), 0);
  const totalVendorPaid     = vendorPayments.reduce((s, p) => s + Number(p.amount||0), 0);
  const netPayableVendors   = Math.max(0, totalVendorSupplied - totalVendorPaid);

  // ── Tier 2: Operational expense heads (alias for clarity) ──
  const totalAllOut = cbTotalExpH;
  const netPosition = totalStudentIncome - totalAllOut;

  // ── Tier 3: Account Wallets real-time balances (integrity-guarded) ──
  const dashAccts  = getActiveList(K.ACCT);
  const dashCbook  = getActiveList(K.CBOOK);
  const dashAcctBal = {};
  dashAccts.forEach(a => { dashAcctBal[a.id] = Number(a.openingBalance || 0); });
  dashCbook.forEach(e => {
    if (dashAcctBal[e.accountId] !== undefined)
      dashAcctBal[e.accountId] += e.type === 'income' ? Number(e.amount) : -Number(e.amount);
  });
  const totalLiquidity = Object.values(dashAcctBal).reduce((s, v) => s + v, 0);
  const acctIcon = t => t === 'cash' ? '💵' : t === 'bank' ? '🏦' : '📱';

  // ── Quick Stats grid — STATELESS MIRROR of snap. No inline calculations. ──
  // Every value reads directly from `snap` (the Majma aggregation engine).
  // Any new metric MUST be added to buildFinancialSnapshot, not here.
  const stats = [
    { label: 'Active Students',  value: snap.activeStudents, icon: '👨‍🎓', color: 'blue',   pg: 'students'   },
    { label: 'Fee Collected',    value: `Rs. ${snap.feeThisMonth.toLocaleString()}`, icon: '💰', color: 'green',  pg: 'feecollect' },
    { label: 'Daily Expenses',   value: `Rs. ${snap.expensesThisMonthEXP.toLocaleString()}`, icon: '🧾', color: 'red',    pg: 'expenses'   },
    { label: 'Annual Fund (Expected)', value: `Rs. ${snap.afExpected.toLocaleString()}`, subValue: snap.afAllTime > 0 ? `Rs. ${snap.afAllTime.toLocaleString()} collected so far` : null, icon: '🏦', color: 'purple', pg: 'fees' },
    { label: 'Low Stock Items',  value: snap.lowStockCount, icon: '📦', color: 'yellow', pg: 'inventory'  },
    { label: 'Total Balance Due', value: `Rs. ${snap.totalDue.toLocaleString()}`, subValue: `incl. opening bal Rs.${totalOpeningBalAll.toLocaleString()}`, icon: '⚖️', color: 'red', pg: 'feecollect' },
    { label: 'Cash In Hand',     value: `Rs. ${snap.cashInHand.toLocaleString()}`, icon: '💵', color: snap.cashInHand >= 0 ? 'green' : 'red', pg: 'cashbook' },
    { label: 'Net Target (Demand)', value: `Rs. ${snap.netTarget.toLocaleString()}`, subValue: `Net Fee Rs.${snap.netFeeDue.toLocaleString()} + AF Rs.${snap.afExpected.toLocaleString()} + Books Rs.${snap.booksValue.toLocaleString()}`, icon: '📋', color: 'blue', pg: 'feecollect' },
  ];

  const printDashboard = () => {
    const m = NOW.getMonth(), y = NOW.getFullYear();
    // ── Global Engine: buildPaidMaps + getStuOutstanding — identical to screen ──
    const allPayments   = S.get(K.PAY, []);
    const _printPMaps   = buildPaidMapsFromCutoff(allPayments);
    const { feeMap: allPaidMap, discMap: allDiscMap } = _printPMaps;
    const monthPays     = allPayments.filter(p => p.month === m && p.year === y);
    const collected     = monthPays.reduce((s,p) => s+Number(p.amount),0);
    const annualFund    = monthPays.reduce((s,p) => s+Number(p.annualFund||0),0);
    // Use Cash Book for expense total — same source as P&L (single truth, integrity-guarded)
    const cbAll    = getActiveList(K.CBOOK);
    const totalExp = cbAll.filter(e => {
      if (e.type !== 'expense') return false;
      if (['owner_drawing','transfer'].includes(e.refType)) return false;
      const d = new Date(e.date);
      return d.getMonth() === m && d.getFullYear() === y;
    }).reduce((s,e) => s+Number(e.amount||0), 0);
    // getStuOutstanding — same function as Dashboard cards (guaranteed identical) ──
    // ── Global Engine: getStuOutstanding (FULL — includes OB) ──
    const unpaid   = students.filter(s => getStuOutstanding(s, classFees, _printPMaps) > 0);
    const totalDue = unpaid.reduce((s,st) => s + getStuOutstanding(st, classFees, _printPMaps), 0);
    printPage('Dashboard Summary', `
      <h2>Dashboard Summary — ${MONTHS[m]} ${y}</h2>
      <div class="summary">
        <div class="sum-card"><div class="val">${students.filter(isActiveStu).length}</div><div class="lbl">Active Students</div></div>
        <div class="sum-card"><div class="val">Rs. ${collected.toLocaleString()}</div><div class="lbl">Fee Collected</div></div>
        <div class="sum-card"><div class="val">Rs. ${annualFund.toLocaleString()}</div><div class="lbl">Annual Fund</div></div>
        <div class="sum-card"><div class="val">Rs. ${totalExp.toLocaleString()}</div><div class="lbl">Expenses</div></div>
        <div class="sum-card"><div class="val">Rs. ${(collected-totalExp).toLocaleString()}</div><div class="lbl">Net Balance</div></div>
        <div class="sum-card"><div class="val">Rs. ${totalDue.toLocaleString()}</div><div class="lbl">Outstanding Dues</div></div>
      </div>
      <h2>Unpaid Students (${MONTHS[m]} ${y})</h2>
      <table><thead><tr><th>#</th><th>Student Name</th><th>Father</th><th>Class</th><th>Roll</th><th>Monthly Fee</th><th>Opening Bal</th><th>All-Time Paid</th><th>Outstanding</th></tr></thead>
      <tbody>${unpaid.map((s,i)=>{ const cf=Number(classFees[s.cls]||0); const ob=Number(s.openingBalance||0); const disc=allDiscMap[s.id]||0; const paid=allPaidMap[s.id]||0; const bal=Math.max(0,Math.max(0,cf-disc)+ob-paid); return `<tr><td>${i+1}</td><td>${s.name}</td><td>${s.father||'—'}</td><td>${s.cls}</td><td>${s.roll}</td><td>Rs. ${cf.toLocaleString()}</td><td>Rs. ${ob.toLocaleString()}</td><td>Rs. ${paid.toLocaleString()}</td><td><b>Rs. ${bal.toLocaleString()}</b></td></tr>`; }).join('')}</tbody>
      <tfoot><tr><td colspan="8" style="text-align:right">Total Outstanding:</td><td>Rs. ${totalDue.toLocaleString()}</td></tr></tfoot>
      </table>`);
  };

  return (
    <div>
      {/* School Header */}
      <div className="bg-white rounded-2xl p-4 mb-6 shadow-lg border-2 border-red-100">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
          <img src={LOGO_SRC} alt="Discovery International School System" className="h-14 sm:h-20 w-full sm:w-auto object-contain"
            onError={e => { e.target.style.display='none'; }}/>
          <div className="text-center sm:text-right w-full sm:w-auto">
            <p className="text-gray-500 text-xs leading-relaxed">📍 Wagha Road, Jallo More, Lahore</p>
            <p className="text-gray-500 text-xs">📞 +92 (322) 8555566</p>
            <p className="text-gray-400 text-xs mt-0.5">{NOW.toLocaleDateString('en-PK', { weekday:'long', year:'numeric', month:'long', day:'numeric' })}</p>
            <button onClick={printDashboard} className="mt-2 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold px-3 py-1.5 rounded-xl transition-all">🖨️ Print</button>
          </div>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* ── TIER 1: Master Financial Cards (Monthly Target / Recovery / Outstanding) ── */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      <div className="mb-2">
        <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">📊 Tier 1 — Master Financial Overview</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        {/* Card 1: Monthly Target — every value here uses the SAME global root function
            that Fee Collection uses, so the numbers reconcile exactly:
              Net Fee Due   = sum(getStuNetMonthlyDue)   ← matches FC "NET DUE" card
              Fee Gross     = sum(classFees[cls])         ← matches FC "Fee Target"
              Discount      = sum(getStuEffectiveDisc)    ← matches FC "Discount" card
              + AF + Books shown as informational rows.                                */}
        <div className="bg-gradient-to-br from-blue-700 to-blue-800 rounded-2xl p-5 text-white shadow-lg relative overflow-hidden">
          <div className="absolute right-3 top-3 text-4xl opacity-20">🎯</div>
          <p className="text-xs font-bold uppercase tracking-widest opacity-80 mb-1">Monthly Target — Net Fee Due</p>
          <p className="text-3xl font-extrabold mb-1">Rs. {snap.netFeeDue.toLocaleString()}</p>
          <p className="text-[10px] opacity-60 mb-1.5">↔ mirrors Quick Stats &amp; Fee Collection NET DUE (via Majma)</p>
          <div className="text-xs opacity-80 space-y-0.5">
            <p className="flex justify-between"><span>📋 Fee Gross</span><span>Rs. {snap.feeGross.toLocaleString()}</span></p>
            <p className="flex justify-between"><span>🏷️ Discount</span><span>Rs. {snap.standingDisc.toLocaleString()}</span></p>
            <div className="border-t border-dashed border-white/30 my-1"></div>
            <p className="flex justify-between"><span>🏦 AF Expected</span><span>Rs. {snap.afExpected.toLocaleString()}</span></p>
            <p className="flex justify-between"><span>📚 Books (extra)</span><span>Rs. {snap.booksValue.toLocaleString()}</span></p>
            <div className="border-t border-white/20 my-1"></div>
            <p className="flex justify-between font-bold"><span>Grand Total Net</span><span>Rs. {snap.netTarget.toLocaleString()}</span></p>
          </div>
          <div className="mt-3 bg-white/20 rounded-xl px-3 py-1.5 text-xs font-semibold w-fit">
            {snap.activeStudents} students enrolled
          </div>
        </div>

        {/* Card 2: Total Recovery */}
        <div className="bg-gradient-to-br from-emerald-600 to-emerald-700 rounded-2xl p-5 text-white shadow-lg relative overflow-hidden">
          <div className="absolute right-3 top-3 text-4xl opacity-20">✅</div>
          <p className="text-xs font-bold uppercase tracking-widest opacity-80 mb-1">Total Recovery</p>
          <p className="text-3xl font-extrabold mb-1">Rs. {totalStudentIncome.toLocaleString()}</p>
          <div className="text-xs opacity-70 space-y-0.5">
            <p>💰 Fee: Rs. {totalFeeCollected.toLocaleString()}</p>
            <p>🏦 AF: Rs. {totalAFCollected.toLocaleString()}</p>
            <p>📚 Books: Rs. {totalBooksCollected.toLocaleString()}</p>
          </div>
          <div className={`mt-3 rounded-xl px-3 py-1.5 text-xs font-semibold w-fit ${totalStudentIncome >= totalDemand ? 'bg-white/20' : 'bg-white/20'}`}>
            {totalDemand > 0 ? Math.round((totalStudentIncome / totalDemand) * 100) : 0}% of target recovered
          </div>
        </div>

        {/* Card 3: Net Outstanding — UNIFIED with Student Ledger Blue Card via single Majma snapshot.
            Breakdown lines (Fee + AF + Books + OB) sum to the headline by engine identity. */}
        <div className="bg-gradient-to-br from-red-600 to-red-700 rounded-2xl p-5 text-white shadow-lg relative overflow-hidden">
          <div className="absolute right-3 top-3 text-4xl opacity-20">⚠️</div>
          <p className="text-xs font-bold uppercase tracking-widest opacity-80 mb-1">Net Outstanding</p>
          <p className="text-3xl font-extrabold mb-1">Rs. {snap.totalDue.toLocaleString()}</p>
          <div className="text-xs opacity-80 space-y-0.5">
            <p>📋 Fee Due: Rs. {snap.outstandingFee.toLocaleString()}</p>
            <p>🏦 AF Due: Rs. {snap.outstandingAF.toLocaleString()}</p>
            <p>📚 Books Due: Rs. {snap.outstandingBks.toLocaleString()}</p>
            <p>📂 Opening Bal: Rs. {snap.obDue.toLocaleString()}</p>
          </div>
          <p className="text-[10px] opacity-60 mt-1 italic">↔ mirrors Ledger via Majma</p>
          <div className="mt-2 bg-white/20 rounded-xl px-3 py-1.5 text-xs font-semibold w-fit cursor-pointer" onClick={() => { setPage('feecollect'); sessionStorage.setItem('_currentPage','feecollect'); }}>
            {snap.outstandingCount} students pending →
          </div>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* ── TIER 2: Operational Summary (Income | Expense | Net Position) ── */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      <div className="mb-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">📈 Tier 2 — Operational Summary</p>
          <p className="text-[10px] text-gray-400 mt-0.5">Monthly view · auto-rolls on the 1st · outstanding dues carry forward</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">📅 Period:</span>
          <select value={selDashMonth} onChange={e => setSelDashMonth(Number(e.target.value))}
            className="border-2 border-blue-200 rounded-lg px-3 py-1.5 text-sm font-semibold text-blue-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-400">
            {MONTH_NAMES.map((nm, i) => <option key={i} value={i}>{nm}</option>)}
          </select>
          <select value={selDashYear} onChange={e => setSelDashYear(Number(e.target.value))}
            className="border-2 border-blue-200 rounded-lg px-3 py-1.5 text-sm font-semibold text-blue-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-400">
            {dashYears.map(yr => <option key={yr} value={yr}>{yr}</option>)}
          </select>
          {(selDashMonth !== NOW.getMonth() || selDashYear !== NOW.getFullYear()) && (
            <button onClick={() => { setSelDashMonth(NOW.getMonth()); setSelDashYear(NOW.getFullYear()); }}
              className="text-xs font-bold text-blue-600 hover:text-blue-800 px-2 py-1 rounded hover:bg-blue-50 transition-all">
              ↻ Current Month
            </button>
          )}
        </div>
      </div>
      {(selDashMonth !== NOW.getMonth() || selDashYear !== NOW.getFullYear()) && (
        <div className="mb-3 bg-amber-50 border-l-4 border-amber-400 px-3 py-2 rounded-r-lg flex items-center gap-2">
          <span className="text-sm">📜</span>
          <span className="text-xs text-amber-800 font-semibold">Viewing historical statement — {MONTH_NAMES[selDashMonth]} {selDashYear}. Click "↻ Current Month" to return to live view.</span>
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        {/* Income Heads */}
        <div className="bg-emerald-50 border-2 border-emerald-200 rounded-2xl p-4">
          <p className="text-xs font-bold text-emerald-700 uppercase tracking-widest mb-3">💰 Income Heads</p>
          <div className="space-y-2.5 text-sm">
            <div className="flex justify-between items-center">
              <span className="text-gray-500 flex items-center gap-1.5">📋 Fee Collected</span>
              <span className="font-bold text-emerald-700">Rs. {totalFeeCollected.toLocaleString()}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-500 flex items-center gap-1.5">🏦 Annual Fund</span>
              <span className="font-bold text-purple-700">Rs. {totalAFCollected.toLocaleString()}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-500 flex items-center gap-1.5">📚 Books Sales</span>
              <span className="font-bold text-amber-600">Rs. {totalBooksCollected.toLocaleString()}</span>
            </div>
            <div className="border-t-2 border-emerald-200 pt-2 flex justify-between items-center">
              <span className="font-bold text-gray-700">Total In</span>
              <span className="font-extrabold text-emerald-700 text-base">Rs. {totalStudentIncome.toLocaleString()}</span>
            </div>
            <div className="border-t-2 border-orange-200 pt-2 mt-1">
              <p className="text-xs font-bold text-orange-600 uppercase tracking-widest mb-2">⚠️ Receivable (Outstanding)</p>
              {totalOpeningBalAll > 0 && (
                <div className="flex justify-between items-center mb-1">
                  <span className="text-gray-500 flex items-center gap-1.5">📂 Opening Balance</span>
                  <span className="font-bold text-orange-600">Rs. {totalOpeningBalAll.toLocaleString()}</span>
                </div>
              )}
              <div className="flex justify-between items-center mb-1">
                <span className="text-gray-500 flex items-center gap-1.5">📋 Fee Outstanding</span>
                <span className="font-bold text-red-600">Rs. {outstandingFee.toLocaleString()}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="font-bold text-gray-700">Total Receivable</span>
                <span className="font-extrabold text-red-700 text-base">Rs. {totalDue.toLocaleString()}</span>
              </div>
            </div>
          </div>
          <div className="mt-3 cursor-pointer" onClick={() => { setPage('feecollect'); sessionStorage.setItem('_currentPage','feecollect'); }}>
            <div className="bg-emerald-100 text-emerald-700 text-xs font-semibold px-3 py-1.5 rounded-xl text-center hover:bg-emerald-200 transition-all">
              → View Fee Collection
            </div>
          </div>
        </div>

        {/* Expense Heads */}
        <div className="bg-red-50 border-2 border-red-200 rounded-2xl p-4">
          <p className="text-xs font-bold text-red-600 uppercase tracking-widest mb-3">🧾 Expense Heads</p>
          <div className="space-y-2.5 text-sm">
            {cbGeneralH > 0 && (
              <div className="flex justify-between items-center">
                <span className="text-gray-500">🧾 General</span>
                <span className="font-bold text-red-600">Rs. {cbGeneralH.toLocaleString()}</span>
              </div>
            )}
            {cbRentH > 0 && (
              <div className="flex justify-between items-center">
                <span className="text-gray-500">🏠 Rent</span>
                <span className="font-bold text-red-600">Rs. {cbRentH.toLocaleString()}</span>
              </div>
            )}
            {cbSalariesH > 0 && (
              <div className="flex justify-between items-center">
                <span className="text-gray-500">👩‍🏫 Salaries</span>
                <span className="font-bold text-red-500">Rs. {cbSalariesH.toLocaleString()}</span>
              </div>
            )}
            {cbVendorPaidH > 0 && (
              <div className="flex justify-between items-center">
                <span className="text-gray-500">🏪 Vendor Payment</span>
                <span className="font-bold text-orange-600">Rs. {cbVendorPaidH.toLocaleString()}</span>
              </div>
            )}
            {cbGuardH > 0 && (
              <div className="flex justify-between items-center">
                <span className="text-gray-500">💂 Guard</span>
                <span className="font-bold text-red-500">Rs. {cbGuardH.toLocaleString()}</span>
              </div>
            )}
            {cbSweeperH > 0 && (
              <div className="flex justify-between items-center">
                <span className="text-gray-500">🧹 Sweeper</span>
                <span className="font-bold text-red-500">Rs. {cbSweeperH.toLocaleString()}</span>
              </div>
            )}
            {cbTotalExpH === 0 && (
              <div className="text-center text-gray-400 text-xs py-2">No expenses recorded</div>
            )}
            <div className="border-t-2 border-red-200 pt-2 flex justify-between items-center">
              <span className="font-bold text-gray-700">Total Out</span>
              <span className="font-extrabold text-red-600 text-base">Rs. {totalAllOut.toLocaleString()}</span>
            </div>
          </div>
          <div className="mt-3 cursor-pointer" onClick={() => { setPage('expenses'); sessionStorage.setItem('_currentPage','expenses'); }}>
            <div className="bg-red-100 text-red-600 text-xs font-semibold px-3 py-1.5 rounded-xl text-center hover:bg-red-200 transition-all">
              → View Expenses
            </div>
          </div>
        </div>

        {/* Net Position */}
        <div className={`border-2 rounded-2xl p-4 ${netPosition >= 0 ? 'bg-blue-50 border-blue-200' : 'bg-red-50 border-red-300'}`}>
          <p className={`text-xs font-bold uppercase tracking-widest mb-3 ${netPosition >= 0 ? 'text-blue-700' : 'text-red-600'}`}>
            📊 Net Position
          </p>
          <div className="space-y-2.5 text-sm">
            <div className="flex justify-between items-center">
              <span className="text-gray-500">Total In</span>
              <span className="font-bold text-emerald-700">Rs. {totalStudentIncome.toLocaleString()}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-500">Total Out</span>
              <span className="font-bold text-red-600">Rs. {totalAllOut.toLocaleString()}</span>
            </div>
            <div className={`border-t-2 pt-2 ${netPosition >= 0 ? 'border-blue-200' : 'border-red-300'}`}>
              <div className="flex justify-between items-center">
                <span className="font-bold text-gray-700">Net</span>
                <span className={`font-extrabold text-xl ${netPosition >= 0 ? 'text-blue-700' : 'text-red-600'}`}>
                  {netPosition < 0 ? '-' : ''}Rs. {Math.abs(netPosition).toLocaleString()}
                </span>
              </div>
            </div>
            <div className="flex justify-between items-center text-xs">
              <span className="text-gray-400">🏪 Vendor Payable</span>
              <span className={`font-semibold ${netPayableVendors > 0 ? 'text-orange-600' : 'text-emerald-600'}`}>
                Rs. {netPayableVendors.toLocaleString()}
              </span>
            </div>
            <div className="flex justify-between items-center text-xs">
              <span className="text-gray-400">⚠️ Fees Receivable</span>
              <span className={`font-semibold ${totalDue > 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                Rs. {totalDue.toLocaleString()}
              </span>
            </div>
            {totalOpeningBalAll > 0 && (
              <div className="flex justify-between items-center text-xs">
                <span className="text-gray-400">📂 Opening Bal (Prev Dues)</span>
                <span className="font-semibold text-orange-600">Rs. {totalOpeningBalAll.toLocaleString()}</span>
              </div>
            )}
          </div>
          <div className={`mt-3 text-center py-2 rounded-xl text-xs font-bold ${netPosition >= 0 ? 'bg-blue-100 text-blue-700' : 'bg-red-100 text-red-700'}`}>
            {netPosition >= 0 ? '✅ Surplus' : '⚠️ Deficit Alert'}
          </div>
        </div>
      </div>


      {/* Tier 3 Annual P&L and Owner Equity sections removed from Dashboard
          on owner request. Same data still available on the Assets & P&L page. */}

      {/* ── Quick Stats Grid ── */}
      <div className="mb-2">
        <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">⚡ Quick Stats</p>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        {stats.map(s => {
          const cardStyle = {
            blue:   { bg: 'bg-blue-50 border-blue-200',   val: 'text-blue-700',   icon: 'bg-blue-100' },
            green:  { bg: 'bg-emerald-50 border-emerald-200', val: 'text-emerald-700', icon: 'bg-emerald-100' },
            red:    { bg: 'bg-red-50 border-red-200',     val: 'text-red-600',    icon: 'bg-red-100' },
            yellow: { bg: 'bg-amber-50 border-amber-200', val: 'text-amber-700',  icon: 'bg-amber-100' },
            purple: { bg: 'bg-purple-50 border-purple-200', val: 'text-purple-700', icon: 'bg-purple-100' },
          }[s.color] || { bg: 'bg-gray-50 border-gray-200', val: 'text-gray-700', icon: 'bg-gray-100' };
          return (
            <div key={s.label} onClick={() => { setPage(s.pg); sessionStorage.setItem('_currentPage', s.pg); }}
              className={`rounded-2xl border-2 p-4 cursor-pointer hover:shadow-md transition-all ${cardStyle.bg}`}>
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-xl mb-3 ${cardStyle.icon}`}>{s.icon}</div>
              <div className={`text-xl font-extrabold mb-0.5 ${cardStyle.val}`}>{s.value}</div>
              {s.subValue && <div className="text-xs text-purple-500 font-semibold mb-0.5">{s.subValue}</div>}
              <div className="text-xs text-gray-500 font-semibold uppercase tracking-wide">{s.label}</div>
            </div>
          );
        })}
      </div>

      {/* ── This Month Collections Banner ── */}
      <div className="bg-gradient-to-r from-blue-700 via-blue-600 to-indigo-700 rounded-2xl p-4 mb-4 shadow-lg">
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className="text-blue-200 text-xs font-semibold uppercase tracking-wide">📊 {MONTHS[m]} {y} — This Month Collections</p>
            <p className="text-white text-3xl font-extrabold mt-0.5">Rs. {monthGrandTotal.toLocaleString()}</p>
            <p className="text-blue-200 text-xs mt-1">Fee + Annual Fund + Books</p>
          </div>
          <div className="text-5xl opacity-30">💵</div>
        </div>
        <div className="grid grid-cols-3 gap-2 mt-1">
          <div className="bg-white/15 rounded-xl px-3 py-2 text-center">
            <p className="text-blue-100 text-xs font-semibold uppercase mb-0.5">💰 Fee</p>
            <p className="text-white font-extrabold text-base">Rs. {collected.toLocaleString()}</p>
          </div>
          <div className="bg-white/15 rounded-xl px-3 py-2 text-center">
            <p className="text-blue-100 text-xs font-semibold uppercase mb-0.5">🏦 Annual Fund</p>
            <p className="text-white font-extrabold text-base">Rs. {monthAFCollected.toLocaleString()}</p>
          </div>
          <div className="bg-white/15 rounded-xl px-3 py-2 text-center">
            <p className="text-blue-100 text-xs font-semibold uppercase mb-0.5">📚 Books</p>
            <p className="text-white font-extrabold text-base">Rs. {monthBooksCollected.toLocaleString()}</p>
          </div>
        </div>
      </div>

      {/* ── Vendor Payable Alert ── */}
      {netPayableVendors > 0 && (
        <div className="bg-orange-50 border-2 border-orange-200 rounded-2xl p-4 mb-4 flex items-center justify-between cursor-pointer hover:bg-orange-100 transition-all"
          onClick={() => { setPage('books'); sessionStorage.setItem('_currentPage','books'); }}>
          <div>
            <p className="text-xs font-bold text-orange-700 uppercase tracking-wide mb-1">🏪 Vendor Payable Outstanding</p>
            <p className="text-2xl font-extrabold text-orange-700">Rs. {netPayableVendors.toLocaleString()}</p>
            <p className="text-xs text-orange-500">Supplied: Rs. {totalVendorSupplied.toLocaleString()} · Paid: Rs. {totalVendorPaid.toLocaleString()}</p>
          </div>
          <div className="text-4xl opacity-40">🏪</div>
        </div>
      )}

      {/* ── Low Stock Alert ── */}
      {lowStock.length > 0 && (
        <Card className="p-4 mb-4 border-red-100">
          <h3 className="font-bold text-red-600 mb-3 text-sm">⚠️ Low Stock Alerts — {lowStock.length} item{lowStock.length !== 1 ? 's' : ''}</h3>
          <div className="space-y-2 overflow-x-auto">
            {lowStock.map(item => (
              <div key={item.id} className="flex items-center justify-between p-2.5 bg-red-50 rounded-xl min-w-0">
                <span className="text-sm font-medium text-gray-800 truncate">{item.name}</span>
                <div className="flex gap-2 flex-shrink-0 ml-2">
                  <Badge color="red">Qty: {item.qty}</Badge>
                  <Badge color="gray">{item.type}</Badge>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {students.length === 0 && inventory.length === 0 && (
        <Empty icon="🏫" text="Welcome to Discovery International School System! Start by adding students from the sidebar." />
      )}
    </div>
  );
}

// ── STUDENTS ─────────────────────────────────────────────────────────────────
const blankStu = { name:'', father:'', cls:'1', roll:'', monthlyFee:'', annualFund:'', openingBalance:'', contact:'', address:'', family:'', familyId:'', siblingDiscount:'', photo:'' };

// ── Called by popup to save students into this window ───────────────────────
window.receiveStudents = function(newStudents) {
  const existing = S.get(K.STU, []);
  const updated = [...existing, ...newStudents];
  S.set(K.STU, updated);
  // Push to Firebase immediately so the background sync won't overwrite with stale data
  try {
    if (window._fbDB) {
      window._fbDB.ref('sms').update({ sms_stu: updated });
    }
  } catch(e) {}
  // Notify Students component to refresh state without a page reload
  window.dispatchEvent(new CustomEvent('sms_stuRefresh', { detail: updated }));
};

// ── Sibling Registration — opens separate popup window ──────────────────────
function openSiblingWindow() {
  const CLSLIST = CLASSES;
  const CFEES   = S.get(K.CF, {});
  const win = window.open('', '_blank', 'width=860,height=820,scrollbars=yes,resizable=yes');
  if (!win) { alert('Popup blocked! Please allow popups for this site.'); return; }

  var rowCount = 0;
  var rowPhotos = {};

  function uid() { return Math.random().toString(36).slice(2,10) + Date.now().toString(36); }

  function clsOptions(sel) {
    return CLSLIST.map(function(c) {
      return '<option value="' + c + '"' + (sel === c ? ' selected' : '') + '>Class ' + c + '</option>';
    }).join('');
  }

  function recalcDiscount() {
    var mfeeVal = Number((win.document.getElementById('inp_mfee') || {}).value) || 0;
    var rows = win.document.querySelectorAll('.sib-row');
    var count = rows.length;
    if (count === 0 || mfeeVal === 0) {
      var prev = win.document.getElementById('fee_preview');
      if (prev) prev.style.display = 'none';
      return;
    }
    var totalClassFee = 0;
    rows.forEach(function(row) {
      var n = row.id.replace('row', '');
      var cls = (win.document.getElementById('scls' + n) || {}).value || '1';
      totalClassFee += Number(CFEES[cls] || 0);
    });
    var perStudent = Math.round(mfeeVal / count);
    var discountTotal = Math.max(0, totalClassFee - mfeeVal);
    // Auto-fill discount field
    var sdEl = win.document.getElementById('inp_sd');
    if (sdEl) sdEl.value = discountTotal > 0 ? discountTotal : '';
    // Show preview
    var preview = win.document.getElementById('fee_preview');
    if (preview) {
      var txt = 'Rs.\u00a0' + mfeeVal.toLocaleString() + '\u00a0\xF7\u00a0' + count + '\u00a0=\u00a0Rs.\u00a0' + perStudent.toLocaleString() + '\u00a0each';
      if (discountTotal > 0) txt += '\u00a0\u2014\u00a0Discount:\u00a0Rs.\u00a0' + discountTotal.toLocaleString();
      else if (totalClassFee > 0) txt += '\u00a0\u2014\u00a0(Class fee:\u00a0Rs.\u00a0' + (totalClassFee/count).toLocaleString() + '\u00a0each)';
      preview.textContent = txt;
      preview.style.display = 'block';
    }
  }

  function addRow() {
    rowCount++;
    var n = rowCount;
    var container = win.document.getElementById('sibRows');
    if (!container) return;
    var div = win.document.createElement('div');
    div.className = 'sib-row';
    div.id = 'row' + n;
    div.innerHTML =
      '<input id="sname' + n + '" placeholder="Student full name" style="width:100%;border:2px solid #e5e7eb;border-radius:8px;padding:8px 10px;font-size:13px;outline:none"/>' +
      '<select id="scls' + n + '" onchange="recalcDiscount()" style="width:100%;border:2px solid #e5e7eb;border-radius:8px;padding:8px 10px;font-size:13px;outline:none">' + clsOptions('1') + '</select>' +
      '<input id="sroll' + n + '" placeholder="Roll No" style="width:100%;border:2px solid #e5e7eb;border-radius:8px;padding:8px 10px;font-size:13px;outline:none"/>' +
      '<div style="text-align:center">' +
        '<img id="sphimg' + n + '" style="display:none;width:36px;height:36px;border-radius:50%;object-fit:cover;border:2px solid #3b82f6;margin-bottom:3px"/>' +
        '<label style="display:inline-block;cursor:pointer;background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:4px 8px;font-size:10px;color:#1d4ed8;font-weight:700">📷<input type="file" accept="image/*" style="display:none" onchange="handlePhoto(' + n + ',this)"/></label>' +
      '</div>' +
      '<button onclick="removeRow(' + n + ')" style="background:#ef4444;color:#fff;border:none;border-radius:8px;padding:6px 10px;font-size:13px;font-weight:700;cursor:pointer">✕</button>';
    container.appendChild(div);
    recalcDiscount();
  }

  function removeRow(n) {
    var el = win.document.getElementById('row' + n);
    if (el) el.remove();
    recalcDiscount();
  }

  function handlePhoto(n, input) {
    var file = input.files[0];
    if (!file) return;
    var reader = new win.FileReader();
    reader.onload = function(e) {
      rowPhotos[n] = e.target.result;
      var img = win.document.getElementById('sphimg' + n);
      if (img) { img.src = e.target.result; img.style.display = 'block'; }
    };
    reader.readAsDataURL(file);
  }

  function saveAll() {
    var father   = win.document.getElementById('inp_father').value.trim();
    var family   = win.document.getElementById('inp_family').value.trim();
    var familyId = win.document.getElementById('inp_familyId').value.trim();
    var contact  = win.document.getElementById('inp_contact').value.trim();
    var address  = win.document.getElementById('inp_address').value.trim();
    var mFeeTotal = Number(win.document.getElementById('inp_mfee').value) || 0;
    var afTotal  = Number(win.document.getElementById('inp_af').value) || 0;
    var sdTotal  = Number(win.document.getElementById('inp_sd').value) || 0;
    var obTotal  = Number(win.document.getElementById('inp_ob').value) || 0;
    var msgEl    = win.document.getElementById('msg');

    if (!father) { msgEl.textContent = '❌ Father Name is required.'; msgEl.style.display = 'block'; return; }

    var rows = win.document.querySelectorAll('.sib-row');
    var siblings = [];
    var ok = true;
    rows.forEach(function(row) {
      var n    = row.id.replace('row', '');
      var name = (win.document.getElementById('sname' + n) || {}).value || '';
      var cls  = (win.document.getElementById('scls'  + n) || {}).value || '1';
      var roll = (win.document.getElementById('sroll' + n) || {}).value || '';
      name = name.trim(); roll = roll.trim();
      if (!name || !roll) { ok = false; return; }
      siblings.push({ name: name, cls: cls, roll: roll, photo: rowPhotos[n] || '' });
    });

    if (!ok || siblings.length === 0) {
      msgEl.textContent = '❌ Fill all student names and roll numbers.';
      msgEl.style.display = 'block';
      return;
    }

    var count    = siblings.length;
    var mFeeEach = count > 0 && mFeeTotal > 0 ? Math.round(mFeeTotal / count) : mFeeTotal;
    var afEach   = count > 0 ? Math.round(afTotal / count) : afTotal;
    var sdEach   = count > 0 ? Math.round(sdTotal / count) : sdTotal;
    var obEach   = count > 0 && obTotal > 0 ? Math.round(obTotal / count) : obTotal;

    var newStudents = siblings.map(function(s) {
      return {
        id: uid(), name: s.name, father: father, cls: s.cls, roll: s.roll,
        monthlyFee: mFeeEach > 0 ? String(mFeeEach) : '',
        annualFund: afEach > 0 ? String(afEach) : '',
        openingBalance: obEach > 0 ? String(obEach) : '', contact: contact, address: address,
        family: family || (father + ' Family'),
        familyId: familyId,
        siblingDiscount: sdEach > 0 ? String(sdEach) : '',
        photo: s.photo || ''
      };
    });

    // win.opener = main window (win is the popup, opener is whoever opened it)
    var mainWin = win.opener && !win.opener.closed ? win.opener : null;
    var saved = false;
    if (mainWin && typeof mainWin.receiveStudents === 'function') {
      try { mainWin.receiveStudents(newStudents); saved = true; } catch(e) {}
    }
    if (!saved) {
      // Fallback: write directly to localStorage and fire refresh event on main window
      var ex = JSON.parse(localStorage.getItem('sms_stu') || '[]');
      var merged = ex.concat(newStudents);
      localStorage.setItem('sms_stu', JSON.stringify(merged));
      try {
        if (mainWin) mainWin.dispatchEvent(new mainWin.CustomEvent('sms_stuRefresh', { detail: merged }));
      } catch(e) {}
    }

    win.document.body.innerHTML =
      '<div style="text-align:center;padding:80px 40px;font-family:Segoe UI,Arial,sans-serif;background:#f0fdf4;min-height:100vh">' +
      '<div style="font-size:72px;margin-bottom:20px">✅</div>' +
      '<h2 style="color:#059669;font-size:26px;font-weight:800;margin-bottom:12px">' + newStudents.length + ' Student(s) Saved!</h2>' +
      '<p style="color:#6b7280;font-size:13px;margin-bottom:30px">Students added to the system successfully.</p>' +
      '<button onclick="window.close()" style="padding:12px 32px;background:#10b981;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer">✕ Close</button>' +
      '</div>';

    setTimeout(function() { win.close(); }, 2000);
  }

  // expose functions to popup window
  win.removeRow        = removeRow;
  win.handlePhoto      = handlePhoto;
  win.saveAll          = saveAll;
  win.addMoreRow       = addRow;
  win.recalcDiscount   = recalcDiscount;

  win.document.write('<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Add New Student</title>' +
  '<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Segoe UI,Arial,sans-serif;background:#f1f5f9;padding:20px;color:#1a1a1a}' +
  '.hdr{text-align:center;margin-bottom:16px;padding-bottom:12px;border-bottom:3px solid #c0392b}' +
  '.hdr h1{font-size:20px;color:#c0392b;font-weight:800}.hdr p{font-size:12px;color:#6b7280;margin-top:4px}' +
  '.card{background:#fff;border-radius:14px;padding:16px;margin-bottom:12px;box-shadow:0 1px 4px rgba(0,0,0,.08)}' +
  '.card h2{font-size:12px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid #f3f4f6}' +
  '.g2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}' +
  '.g3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}' +
  '.fl{display:block;font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;margin-bottom:3px}' +
  '.fi{width:100%;border:2px solid #e5e7eb;border-radius:8px;padding:8px 10px;font-size:13px;outline:none}' +
  '.fi:focus{border-color:#3b82f6}' +
  '.sib-row{display:grid;grid-template-columns:2.5fr 1.2fr 1fr 60px 36px;gap:8px;align-items:center;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:10px;margin-bottom:8px}' +
  '.sh{display:grid;grid-template-columns:2.5fr 1.2fr 1fr 60px 36px;gap:8px;margin-bottom:4px;padding:0 10px}' +
  '.sh span{font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase}' +
  '.btn-add{background:#3b82f6;color:#fff;border:none;border-radius:10px;padding:10px 20px;font-size:13px;font-weight:700;cursor:pointer;margin-top:8px}' +
  '.btn-save{background:#10b981;color:#fff;border:none;border-radius:12px;padding:14px;font-size:15px;font-weight:700;cursor:pointer;width:100%}' +
  '#msg{display:none;padding:10px;border-radius:8px;background:#fee2e2;color:#991b1b;font-size:13px;font-weight:600;margin-bottom:10px}' +
  '</style></head><body>' +
  '<div class="hdr"><h1>🎓 Add New Student</h1><p>Single student or full siblings — common info entered once</p></div>' +
  '<div id="msg"></div>' +
  '<div class="card"><h2>👦👧 Students — Add Each Child</h2>' +
  '<div class="sh"><span>Full Name *</span><span>Class *</span><span>Roll No *</span><span>Photo</span><span></span></div>' +
  '<div id="sibRows"></div>' +
  '<button class="btn-add" onclick="addMoreRow()">+ Add Another Student</button></div>' +
  '<div class="card"><h2>👨 Common Family Details</h2>' +
  '<div class="g2"><div><span class="fl">Father\'s Name *</span><input class="fi" id="inp_father" placeholder="Father\'s full name"/></div>' +
  '<div><span class="fl">Family Name</span><input class="fi" id="inp_family" placeholder="e.g. Khan Family"/></div></div>' +
  '<div class="g3"><div><span class="fl">Family ID</span><input class="fi" id="inp_familyId" placeholder="F-001"/></div>' +
  '<div><span class="fl">Contact</span><input class="fi" id="inp_contact" placeholder="0321-1234567"/></div>' +
  '<div><span class="fl">Address</span><input class="fi" id="inp_address" placeholder="Home address"/></div></div></div>' +
  '<div class="card"><h2>💰 Fee & Financial Details</h2><div class="g3">' +
  '<div><span class="fl">Total Monthly Fee — All Siblings (Rs.)</span><input class="fi" type="number" min="0" id="inp_mfee" placeholder="e.g. 1800 for 2 siblings" oninput="recalcDiscount()"/></div>' +
  '<div><span class="fl">Annual Fund Rs. (total all siblings)</span><input class="fi" type="number" min="0" id="inp_af" placeholder="e.g. 5000"/></div>' +
  '<div><span class="fl">Sibling Discount Rs. (auto-calculated)</span><input class="fi" type="number" min="0" id="inp_sd" placeholder="Auto-filled"/></div>' +
  '</div>' +
  '<div id="fee_preview" style="display:none;margin-top:8px;padding:8px 12px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;font-size:12px;font-weight:600;color:#065f46"></div>' +
  '<div style="margin-top:10px"><span class="fl" style="color:#c2410c">Opening Balance (Rs.) — Previous Dues (Total All Siblings)</span>' +
  '<input class="fi" type="number" min="0" id="inp_ob" placeholder="0 if no prior balance" style="border-color:#fed7aa"/></div>' +
  '</div>' +
  '<button class="btn-save" onclick="saveAll()">✅ Save & Add to System</button>' +
  '<p style="text-align:center;font-size:11px;color:#9ca3af;margin-top:10px">Window closes automatically after saving.</p>' +
  '</body></html>');
  win.document.close();

  // Add first row after document is ready
  setTimeout(function() { addRow(); }, 100);
}

function printIdCard(s) {
  const logo = LOGO_SRC;
  const photoHtml = s.photo
    ? `<img src="${s.photo}" style="width:80px;height:80px;border-radius:50%;object-fit:cover;border:3px solid #1e3a8a;margin:0 auto 10px;display:block"/>`
    : `<div style="width:80px;height:80px;border-radius:50%;background:#dbeafe;border:3px solid #1e3a8a;margin:0 auto 10px;display:flex;align-items:center;justify-content:center;font-size:32px;font-weight:900;color:#1e3a8a">${s.name[0]}</div>`;
  const win = window.open('', '_blank', 'width=420,height=320');
  if (!win) { alert('Popup blocked! Please allow popups for this site to print.'); return; }
  win.document.write(`<!DOCTYPE html><html><head><title>ID Card — ${esc(s.name)}</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:'Segoe UI',Arial,sans-serif;background:#f1f5f9;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
    .card{width:340px;background:linear-gradient(160deg,#1e3a8a 0%,#1e40af 55%,#fff 55%);border-radius:16px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,.25);position:relative}
    .top{padding:18px 20px 60px;text-align:center;color:#fff}
    .top img.logo{height:42px;object-fit:contain;margin-bottom:8px}
    .top h1{font-size:11px;font-weight:800;letter-spacing:.8px;text-transform:uppercase;line-height:1.4}
    .top p{font-size:9px;opacity:.8;margin-top:3px}
    .photo-wrap{position:absolute;left:50%;transform:translateX(-50%);top:105px}
    .bottom{padding:58px 20px 18px;text-align:center}
    .stu-name{font-size:15px;font-weight:800;color:#1e293b;margin-bottom:4px}
    .father{font-size:11px;color:#475569;margin-bottom:10px}
    .badges{display:flex;justify-content:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}
    .badge{background:#eff6ff;border:1px solid #bfdbfe;border-radius:20px;padding:4px 12px;font-size:10px;font-weight:700;color:#1e40af}
    .badge.roll{background:#f0fdf4;border-color:#bbf7d0;color:#15803d}
    .footer{font-size:8px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:8px}
    @media print{body{background:#fff}.card{box-shadow:none}}
  </style></head><body>
  <div>
    <div class="card">
      <div class="top">
        <img class="logo" src="${logo}" onerror="this.style.display='none'"/>
        <h1>Discovery International School System</h1>
        <p>Wagha Road, Jallo More, Lahore</p>
      </div>
      <div class="photo-wrap">${photoHtml}</div>
      <div class="bottom">
        <div class="stu-name">${esc(s.name)}</div>
        <div class="father">S/O: ${esc(s.father || '—')}</div>
        <div class="badges">
          <span class="badge">Class ${s.cls}</span>
          <span class="badge roll">Roll # ${s.roll}</span>
          ${s.contact ? `<span class="badge">${s.contact}</span>` : ''}
        </div>
        <div class="footer">STUDENT ID CARD &nbsp;|&nbsp; ${new Date().getFullYear()}</div>
      </div>
    </div>
    <div style="text-align:center;margin-top:14px">
      <button onclick="window.print()" style="padding:10px 28px;background:#1e40af;color:#fff;border:none;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;margin-right:8px">🖨️ Print</button>
      <button onclick="window.close()" style="padding:10px 20px;background:#f1f5f9;color:#475569;border:1px solid #e2e8f0;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer">✕ Close</button>
    </div>
  </div>
  </body></html>`);
  win.document.close();
}

function Students() {
  const { role } = React.useContext(UserContext);
  const isAdmin      = role === 'admin';
  const isPrincipal  = role === 'principal';
  const canAdd       = isAdmin || isPrincipal; // principal can add new students
  const canWrite     = isAdmin;                // only admin can edit/delete
  const [list, setList]       = useState(() => S.get(K.STU, []));
  const [form, setForm]       = useState(null);
  const [familyEdit, setFamilyEdit] = useState(null);   // ── Family-bundled Edit modal ──
  const [delId, setDelId]     = useState(null);
  const [search, setSearch]   = useState('');
  const [fcls, setFcls]       = useState('All');
  const [statusFilter, setStatusFilter] = useState('active'); // 'active' | 'left' | 'all'
  // ── Students-page Fee Structure REFERENCE modal — read/edit shortcut for class fees.
  // NOTE: This is the ONLY surviving Fee Structure UI. The Student Ledger's old
  // 'config' tab has been permanently removed. Per-student monthlyFee on the
  // student record remains the primary driver of the global engine
  // (getStuDisc / getStuNetMonthlyDue / getStuOutstanding); this modal exists
  // only as a reference for the class baseline used by the discount mirror.
  const [showFeeStruct, setShowFeeStruct] = useState(false);
  const [studClassFees, setStudClassFees] = useState(() => S.get(K.CF, {}));
  const saveStudClassFee = (cls, val) => {
    if (!isAdmin) return; // only admin can edit
    const v = val === '' ? '' : Math.max(0, Number(val) || 0);
    const updated = { ...studClassFees, [cls]: v };
    S.set(K.CF, updated); setStudClassFees(updated);
  };

  // Refresh list when popup saves new students (without page reload)
  React.useEffect(() => {
    const handler = (e) => setList(e.detail || S.get(K.STU, []));
    window.addEventListener('sms_stuRefresh', handler);
    return () => window.removeEventListener('sms_stuRefresh', handler);
  }, []);

  const persist = (data) => { S.set(K.STU, data); setList(data); };

  const openAdd  = () => setForm({ ...blankStu });

  // ══════════════════════════════════════════════════════════════════════════
  // FAMILY-BUNDLED EDIT — clicking Edit on ANY student row opens unified
  // family modal. Fetches ALL siblings by familyId (or family+father fallback)
  // and edits the whole household in one screen. Per-child Active/Left toggle
  // drops inactive siblings from the global engine's billing calculations.
  // ══════════════════════════════════════════════════════════════════════════
  const openEdit = (s) => {
    // Group key priority: familyId → family+father → solo (no siblings)
    const matches = list.filter(x => {
      if (s.familyId && x.familyId && x.familyId === s.familyId) return true;
      if (!s.familyId && s.family && x.family === s.family && (x.father||'') === (s.father||'')) return true;
      return x.id === s.id;
    });
    const uniq = Array.from(new Map(matches.map(x => [x.id, x])).values());
    const obTotal = uniq.reduce((sum, x) => sum + Number(x.openingBalance || 0), 0);
    setFamilyEdit({
      primaryId: s.id,
      father:   s.father   || '',
      family:   s.family   || '',
      familyId: s.familyId || '',
      contact:  s.contact  || '',
      address:  s.address  || '',
      openingBalanceTotal: obTotal !== 0 ? String(obTotal) : '',
      children: uniq.map(x => ({ ...x, status: x.status || 'active' }))
    });
  };

  // Update one child's field within the family edit
  const updateChild = (idx, field, val) => {
    setFamilyEdit(fe => ({
      ...fe,
      children: fe.children.map((c, i) => i === idx ? { ...c, [field]: val } : c)
    }));
  };

  // Toggle child Active ⇄ Left School — global engine's isActiveStu() drops
  // 'left' students from class registers, fee billing, and outstanding totals
  const toggleChildStatus = (idx) => {
    setFamilyEdit(fe => ({
      ...fe,
      children: fe.children.map((c, i) => {
        if (i !== idx) return c;
        const goingLeft = (c.status || 'active') !== 'left';
        return {
          ...c,
          status: goingLeft ? 'left' : 'active',
          leftDate: goingLeft ? (c.leftDate || new Date().toISOString().slice(0,10)) : ''
        };
      })
    }));
  };

  // Save family — applies shared fields to every child, OB split equally
  // across ACTIVE only, mirrors siblingDiscount from global engine per child
  const saveFamily = () => {
    const fe = familyEdit;
    if (!fe.father.trim()) return alert("Father's name is required.");
    for (let i = 0; i < fe.children.length; i++) {
      const c = fe.children[i];
      if (!c.name.trim() || !c.roll.trim())
        return alert(`Name and Roll Number are required for every child (check #${i+1}).`);
    }
    const _cf = S.get(K.CF, {});
    const activeKids = fe.children.filter(c => (c.status || 'active') !== 'left');
    const obTotal    = Number(fe.openingBalanceTotal) || 0;
    // ── Advance/Credit support: negative obTotal distributes as advance to each active sibling.
    //    Positive = previous dues; negative = prepaid/advance credit. Zero = no carry-forward.
    const obEach     = activeKids.length > 0 && obTotal !== 0 ? Math.round(obTotal / activeKids.length) : 0;

    const updatedChildren = fe.children.map(c => {
      const isActive = (c.status || 'active') !== 'left';
      // Global Engine: getStuDisc — single source of truth, applied per child
      const _mirror = getStuDisc(c, _cf);
      return {
        ...c,
        father:   fe.father,
        family:   fe.family,
        familyId: fe.familyId,
        contact:  fe.contact,
        address:  fe.address,
        // OB redistributed only to active siblings; left students keep their historical OB.
        // Negative obEach means each active sibling carries an advance/credit.
        openingBalance: isActive ? (obEach !== 0 ? String(obEach) : '') : (c.openingBalance || ''),
        siblingDiscount: _mirror > 0 ? String(_mirror) : '',
        status:   c.status || 'active',
        leftDate: c.status === 'left' ? (c.leftDate || new Date().toISOString().slice(0,10)) : ''
      };
    });

    const idMap = new Map(updatedChildren.map(c => [c.id, c]));
    const previousById = new Map(list.map(s => [s.id, s]));
    const updated = list.map(s => idMap.get(s.id) || s);
    persist(updated);

    // ── Apply existing status side-effects (auto write-off when marking as Left) ──
    updatedChildren.forEach(uc => {
      const prev = previousById.get(uc.id);
      if (prev) applyStudentStatusSideEffects(prev, uc);
    });

    // ── Audit every child write ──
    const sess = getSession() || {};
    updatedChildren.forEach(uc => {
      const prev = previousById.get(uc.id);
      logAudit(sess.username || 'admin', sess.name || 'Admin', 'EDIT', 'Students', prev, uc);
    });
    setFamilyEdit(null);
  };

  // ── Status-change side-effect (write-off only) ── shared by save() AND inline re-activate
  // Option B (chosen): When marking AS Left → auto-create Owner Drawing write-off for current outstanding.
  // When re-activating → NO automatic reverse. Admin must manually delete the write-off cashbook entry
  // from Cash Book if they want to undo it. Safer, simpler, no double-reverse risk.
  // Uses Global Engine helpers ONLY — no schema change, no helper modification.
  const applyStudentStatusSideEffects = (previousStu, savedStu) => {
    if (!previousStu || !savedStu) return;
    // Only Case A: Marking AS Left → auto-create Owner Drawing write-off for current outstanding
    if (previousStu.status !== 'left' && savedStu.status === 'left') {
      const allPayments = S.get(K.PAY, []);
      const cf          = S.get(K.CF, {});
      const paidMaps    = buildPaidMapsFromCutoff(allPayments);
      // Use previousStu (still active) so getStuOutstanding returns the real number, not 0
      const outstanding = getStuOutstanding(previousStu, cf, paidMaps);
      if (outstanding > 0) {
        addCashBookEntry(
          'expense',
          'Student Left Write-off — ' + savedStu.name + (savedStu.familyId ? ' (FID ' + savedStu.familyId + ')' : ''),
          outstanding,
          'Cash',
          new Date().toISOString().slice(0,10),
          'Auto write-off — stuId=' + savedStu.id,
          'owner_drawing',
          undefined
        );
      }
    }
    // Re-activation: NO automatic action. Manual delete from Cash Book if needed.
  };

  const save = () => {
    if (!form.name.trim() || !form.roll.trim()) return alert('Name and Roll Number are required.');
    const isNew    = !form.id;
    const savedId  = isNew ? uid() : form.id;
    // ── Mirror siblingDiscount from the global engine — single source of truth ──
    const _mirror  = getStuDisc(form, S.get(K.CF, {}));
    const saved    = { ...form, id: savedId, siblingDiscount: _mirror > 0 ? String(_mirror) : '' };
    const previous = isNew ? null : list.find(s => s.id === form.id);
    const updated  = isNew ? [...list, saved] : list.map(s => s.id === form.id ? saved : s);
    persist(updated);
    // ── Auto side-effects when status changes ──
    if (!isNew && previous) applyStudentStatusSideEffects(previous, saved);
    // ── Global Engine: audit every student create / edit ──────────────────
    const sess = getSession() || {};
    logAudit(sess.username || 'admin', sess.name || 'Admin',
      isNew ? 'CREATE' : 'EDIT', 'Students',
      isNew ? null : previous,
      saved);
    setForm(null);
  };

  const remove = () => { persist(list.filter(s => s.id !== delId)); setDelId(null); };

  const filtered = useMemo(() =>
    list.filter(s => {
      const q           = search.toLowerCase();
      const matchSearch = s.name.toLowerCase().includes(q) || (s.roll||'').includes(q);
      const matchCls    = fcls === 'All' || s.cls === fcls;
      const matchStatus = statusFilter === 'all'  ? true
                        : statusFilter === 'left' ? s.status === 'left'
                        : s.status !== 'left';   // 'active' = default
      return matchSearch && matchCls && matchStatus;
    }), [list, search, fcls, statusFilter]);

  const printStudents = () => {
    printPage('Student List', `
      <h2>Student List (${filtered.length} students)</h2>
      <table><thead><tr><th>#</th><th>Student Name</th><th>Father's Name</th><th>Class</th><th>Roll No</th><th>Annual Fund</th><th>Family</th><th>Contact</th><th>Address</th></tr></thead>
      <tbody>${filtered.map((s,i)=>`<tr><td>${i+1}</td><td><b>${s.name}</b></td><td>${s.father||'—'}</td><td><span class="badge b-blue">${s.cls}</span></td><td>${s.roll}</td><td>${s.annualFund?`<span class="badge b-purple">Rs. ${Number(s.annualFund).toLocaleString()}</span>`:'—'}</td><td>${s.family?`<span class="badge b-purple">${s.family}</span>`:'—'}</td><td>${s.contact||'—'}</td><td>${s.address||'—'}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="9">Total: ${filtered.length} students</td></tr></tfoot>
      </table>`);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-xl font-bold text-gray-800">Students <span className="text-gray-400 font-normal text-base">({list.length})</span></h2>
      </div>

      <Card className="p-3 mb-4">
        <div className="flex flex-col sm:flex-row gap-2">
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search by name or roll number..."
            className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/>
          <select value={fcls} onChange={e => setFcls(e.target.value)}
            className="border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
            <option value="All">All Classes</option>
            {CLASSES.map(c => <option key={c} value={c}>Class {c}</option>)}
          </select>
          {(isAdmin || isPrincipal) && (
            <Btn variant="outline" onClick={() => setShowFeeStruct(true)}>⚙️ Fee Structure</Btn>
          )}
        </div>
      </Card>

      {/* ── Fee Structure REFERENCE Modal — Students page only.
          The Student Ledger's old config tab has been excised; this modal is
          retained here as the single quick-reference for per-class baseline
          rates. Admin can edit, Principal can view, others don't see it. ── */}
      {showFeeStruct && (() => {
        // Group classes for cleaner two-section layout: Pre-Primary vs. Primary/Secondary
        const PREP_CLASSES = CLASSES.filter(c => ['Play Group Red','Play Group Blue','Nursery','KG'].includes(c));
        const NUM_CLASSES  = CLASSES.filter(c => !PREP_CLASSES.includes(c));
        const labelFor = (cls) => /^\d+$/.test(cls) ? `Class ${cls}` : cls;
        const renderCell = (cls, accent) => (
          <div key={cls} className={`rounded-xl border-2 p-3 transition-all hover:shadow-sm ${accent}`}>
            <div className="text-[11px] font-bold uppercase tracking-wider text-gray-600 mb-2 truncate">{labelFor(cls)}</div>
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-bold text-gray-400">Rs.</span>
              <input type="number" min="0" value={studClassFees[cls] !== undefined ? studClassFees[cls] : ''}
                onChange={e => saveStudClassFee(cls, e.target.value)}
                readOnly={!isAdmin}
                placeholder="0"
                className={`flex-1 min-w-0 border rounded-lg px-2 py-1.5 text-base font-bold text-right ${isAdmin ? 'border-gray-200 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-800' : 'border-gray-100 bg-gray-100 text-gray-500 cursor-not-allowed'}`}/>
            </div>
          </div>
        );
        return (
          <Modal title="⚙️ Fee Structure — Monthly Fee Per Class" onClose={() => setShowFeeStruct(false)} xl>
            {/* Status banner */}
            <div className={`flex items-center gap-2 mb-4 px-3 py-2 rounded-lg ${isAdmin ? 'bg-red-50 border border-red-100' : 'bg-emerald-50 border border-emerald-100'}`}>
              {isAdmin
                ? <span className="text-xs bg-red-100 text-red-700 font-bold px-2.5 py-1 rounded-full whitespace-nowrap">🔒 Admin Only — Edit</span>
                : <span className="text-xs bg-emerald-100 text-emerald-700 font-bold px-2.5 py-1 rounded-full whitespace-nowrap">👁️ View Only</span>
              }
              <span className="text-xs text-gray-600 leading-snug">{isAdmin ? 'Reference rates — Family Edit modal still sets each student\'s actual monthlyFee.' : 'Contact admin to change values.'}</span>
            </div>

            {/* Pre-Primary section */}
            <div className="mb-4">
              <p className="text-xs font-bold uppercase tracking-widest text-blue-600 mb-2 flex items-center gap-2">🧸 Pre-Primary</p>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {PREP_CLASSES.map(cls => renderCell(cls, 'bg-blue-50 border-blue-100'))}
              </div>
            </div>

            {/* Primary / Secondary section */}
            <div>
              <p className="text-xs font-bold uppercase tracking-widest text-purple-600 mb-2 flex items-center gap-2">🎓 Primary / Secondary</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                {NUM_CLASSES.map(cls => renderCell(cls, 'bg-purple-50 border-purple-100'))}
              </div>
            </div>

            <div className="mt-5 pt-4 border-t border-gray-100 flex items-center justify-between">
              <p className="text-xs text-gray-400">Total classes configured: <span className="font-bold text-gray-600">{CLASSES.filter(c => Number(studClassFees[c]) > 0).length}</span> of {CLASSES.length}</p>
              <Btn onClick={() => setShowFeeStruct(false)}>✓ Done</Btn>
            </div>
          </Modal>
        );
      })()}

      {/* ── Active / Left / All Filter Tabs ── */}
      {(() => {
        const activeCount = list.filter(s => s.status !== 'left').length;
        const leftCount   = list.filter(s => s.status === 'left').length;
        const tabs = [
          { id:'active', label:'✅ Active',      count: activeCount },
          { id:'left',   label:'🔴 Left School', count: leftCount   },
          { id:'all',    label:'📋 All',          count: list.length },
        ];
        return (
          <div className="flex gap-1 mb-4 bg-gray-100 p-1 rounded-xl w-fit flex-wrap">
            {tabs.map(t => (
              <button key={t.id} onClick={() => setStatusFilter(t.id)}
                className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${statusFilter===t.id ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
                {t.label} ({t.count})
              </button>
            ))}
          </div>
        );
      })()}

      {/* ── Summary Cards ── all values via Global Engine, identical to Fee Collection ── */}
      {list.length > 0 && (() => {
        const bookLists  = S.get(K.BL, {});
        const classFees  = S.get(K.CF, {});
        const stuPayments = S.get(K.PAY, []);
        const _now = new Date();
        const _curM = _now.getMonth(), _curY = _now.getFullYear();
        const totalAF    = filtered.reduce((s, st) => s + Number(st.annualFund || 0), 0);
        // Global Engine: getStudentBookTotal — same root used by Dashboard, FC, Family Ledger.
        const totalBooks = filtered.reduce((s, st) => s + getStudentBookTotal(st, bookLists), 0);
        const activeFiltered = filtered.filter(isActiveStu);
        // ── Global Engine: getStuNetMonthlyDue = classFee − discount (Khalis Amdani) ──
        const totalNetDue = activeFiltered.reduce((s, st) => s + getStuNetMonthlyDue(st, classFees), 0);
        // Fee Target (gross monthly demand before discount) — same as FC Fee Target row.
        const feeTarget   = activeFiltered.reduce((s, st) => s + Number(classFees[st.cls] || 0), 0);
        // Total Discount via Global Engine getStuEffectiveDisc — same value FC shows on its card.
        const totalDiscount = activeFiltered.reduce((s, st) => s + getStuEffectiveDisc(st, stuPayments, _curM, _curY, classFees), 0);
        const withAF    = activeFiltered.filter(st => Number(st.annualFund||0) > 0).length;
        const withBooks = activeFiltered.filter(st => (bookLists[st.id]||[]).length > 0).length;
        return (
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-4">
            <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3">
              <p className="text-xs text-blue-500 font-semibold uppercase mb-1">👨‍🎓 Students</p>
              <p className="text-xl font-extrabold text-blue-700">{filtered.length}</p>
              <p className="text-xs text-gray-400 mt-0.5">{fcls === 'All' ? 'All Classes' : `Class ${fcls}`}</p>
            </div>
            {/* Net Due card — identical breakdown to Fee Collection card (Fee Target + Discount) */}
            <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3">
              <p className="text-xs text-red-500 font-semibold uppercase mb-1">📋 Net Due</p>
              <p className="text-xl font-extrabold text-red-600">Rs. {totalNetDue.toLocaleString()}</p>
              <div className="border-t border-dashed border-red-200 my-2"></div>
              <div className="flex justify-between items-center text-xs mb-1">
                <span className="text-gray-500">Fee Target</span>
                <span className="font-semibold text-gray-700">Rs. {feeTarget.toLocaleString()}</span>
              </div>
              <div className="flex justify-between items-center text-xs">
                <span className="text-gray-500">Discount</span>
                <span className="font-semibold text-amber-600">Rs. {totalDiscount.toLocaleString()}</span>
              </div>
            </div>
            <div className="bg-purple-50 border border-purple-200 rounded-xl px-4 py-3">
              <p className="text-xs text-purple-600 font-semibold uppercase mb-1">🏦 Annual Fund</p>
              <p className="text-xl font-extrabold text-purple-700">Rs. {totalAF.toLocaleString()}</p>
              <p className="text-xs text-gray-400 mt-0.5">{withAF} of {filtered.length} students</p>
            </div>
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
              <p className="text-xs text-amber-600 font-semibold uppercase mb-1">📚 Books Total</p>
              <p className="text-xl font-extrabold text-amber-700">Rs. {totalBooks.toLocaleString()}</p>
              <p className="text-xs text-gray-400 mt-0.5">{withBooks} students have book lists</p>
            </div>
            {/* Green card: Grand Total = Net Due + AF + Books (per-student totals, post-discount) */}
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">
              <p className="text-xs text-emerald-600 font-semibold uppercase mb-1">📊 Opening</p>
              <p className="text-xl font-extrabold text-emerald-700">Rs. {(totalNetDue + totalAF + totalBooks).toLocaleString()}</p>
              <p className="text-xs text-gray-400 mt-0.5">Net Due + AF + Books</p>
            </div>
          </div>
        );
      })()}

      {filtered.length === 0
        ? <Empty icon="👨‍🎓" text={list.length === 0 ? 'No students yet. Click + Add Student to begin.' : 'No students match your search.'} />
        : (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b">
                  <tr className="text-left text-xs text-gray-500 font-semibold uppercase">
                    <th className="px-4 py-3">Sr.</th>
                    <th className="px-4 py-3">Student Name</th>
                    <th className="px-4 py-3 hidden sm:table-cell">Father's Name</th>
                    <th className="px-4 py-3">Class</th>
                    <th className="px-4 py-3">Roll No</th>
                    <th className="px-4 py-3 hidden sm:table-cell">Family ID</th>
                    <th className="px-4 py-3 hidden sm:table-cell">Family</th>
                    <th className="px-4 py-3 hidden md:table-cell">Annual Fund</th>
                    <th className="px-4 py-3 hidden md:table-cell text-orange-500">Opening Bal</th>
                    <th className="px-4 py-3 hidden md:table-cell">Contact</th>
                    <th className="px-4 py-3 hidden md:table-cell">Address</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {filtered.map((s, idx) => (
                    <tr key={s.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-4 py-3 text-xs font-bold text-gray-400">{String(idx+1).padStart(2,'0')}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {s.photo
                            ? <img src={s.photo} alt="" className="w-8 h-8 rounded-full object-cover border border-gray-200 shrink-0"/>
                            : <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-bold text-xs shrink-0">{s.name[0]}</div>
                          }
                          <div className="flex items-center gap-1.5">
                            <span className={`font-semibold ${s.status==='left'?'text-gray-400 line-through':'text-gray-800'}`}>{s.name}</span>
                            {s.status==='left' && <span className="text-xs bg-red-100 text-red-600 font-bold px-1.5 py-0.5 rounded-full">LEFT</span>}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-500 hidden sm:table-cell">{s.father || '—'}</td>
                      <td className="px-4 py-3"><Badge color="blue">{s.cls}</Badge></td>
                      <td className="px-4 py-3 text-gray-600 font-mono">{s.roll}</td>
                      <td className="px-4 py-3 hidden sm:table-cell">{s.familyId ? <Badge color="blue">{s.familyId}</Badge> : <span className="text-gray-300">—</span>}</td>
                      <td className="px-4 py-3 hidden sm:table-cell">{s.family ? <Badge color="purple">{s.family}</Badge> : <span className="text-gray-300">—</span>}</td>
                      <td className="px-4 py-3 hidden md:table-cell">{s.annualFund ? <Badge color="purple">AF Rs. {Number(s.annualFund).toLocaleString()}</Badge> : <span className="text-gray-300">—</span>}</td>
                      <td className="px-4 py-3 hidden md:table-cell">{Number(s.openingBalance||0) > 0 ? <span className="text-orange-600 font-bold text-sm">Rs. {Number(s.openingBalance).toLocaleString()}</span> : <span className="text-gray-300">—</span>}</td>
                      <td className="px-4 py-3 text-gray-500 hidden md:table-cell">{s.contact || '—'}</td>
                      <td className="px-4 py-3 text-gray-500 hidden md:table-cell text-xs">{s.address || '—'}</td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex flex-wrap gap-1 justify-end">
                          <Btn sm variant="outline" onClick={() => printIdCard(s)}>🪪 ID Card</Btn>
                          {/* ── Quick Re-activate — only shown for left students ── */}
                          {isAdmin && s.status === 'left' && (
                            <Btn sm variant="green" onClick={() => window.requireMasterCode(() => {
                              const reactivated = { ...s, status: 'active', leftDate: '' };
                              const updated = list.map(x => x.id === s.id ? reactivated : x);
                              persist(updated);
                              // Auto-reverse the original write-off (shared logic)
                              applyStudentStatusSideEffects(s, reactivated);
                              const sess = getSession() || {};
                              logAudit(sess.username || 'admin', sess.name || 'Admin', 'EDIT', 'Students', s, reactivated);
                            }, `Re-activate student: ${s.name}`)}>
                              ✅ Re-activate
                            </Btn>
                          )}
                          {isAdmin && <Btn sm variant="outline" onClick={() => window.requireMasterCode(() => openEdit(s), `Edit student: ${s.name}`)}>Edit</Btn>}
                          {isAdmin && <Btn sm variant="red" onClick={() => window.requireMasterCode(() => setDelId(s.id), `Delete student: ${s.name}`)}>Delete</Btn>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )
      }

      {/* ── Action buttons — after last entry ── */}
      <div className="flex gap-2 flex-wrap mt-4">
        <Btn variant="outline" onClick={printStudents}>🖨️ Print</Btn>
        {canAdd && <Btn onClick={openSiblingWindow}>+ Add New Student</Btn>}
      </div>

      {form && (
        <Modal title={form.id ? '✏️ Edit Student' : '🎓 Add New Student'} onClose={() => setForm(null)} xl>

          {/* ── Left-student re-activation banner — shown at top for instant visibility ── */}
          {form.id && form.status === 'left' && (
            <div className="bg-red-50 border-2 border-red-300 rounded-xl px-4 py-3 mb-4 flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex-1">
                <p className="font-bold text-red-700 text-sm">🔴 This student is currently marked as Left School</p>
                <p className="text-xs text-red-500 mt-0.5">Fee billing and outstanding calculations are paused. Use the button to re-enrol.</p>
              </div>
              <button
                onClick={() => setForm({...form, status: 'active', leftDate: ''})}
                className="shrink-0 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold px-4 py-2 rounded-xl transition-all">
                ✅ Re-activate This Student
              </button>
            </div>
          )}

          {/* ── Active-student confirmation banner ── */}
          {form.id && form.status !== 'left' && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-2 mb-3 flex items-center gap-2 text-xs text-emerald-700 font-semibold">
              ✅ Active — included in fee billing and all financial reports
            </div>
          )}

          {/* ── Row 1: Basic Info ── */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-0">
            <Inp label="Student Full Name *" value={form.name} onChange={e => setForm({...form, name: e.target.value})} placeholder="Student full name"/>
            <Inp label="Father's Name *" value={form.father||''} onChange={e => setForm({...form, father: e.target.value})} placeholder="Father's full name"/>
          </div>
          {/* ── Row 2: Class / Roll ── */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-0">
            <Sel label="Class *" value={form.cls} onChange={e => setForm({...form, cls: e.target.value})} options={CLASSES.map(c => ({v:c, l:`Class ${c}`}))}/>
            <Inp label="Roll Number *" value={form.roll} onChange={e => setForm({...form, roll: e.target.value})} placeholder="e.g. 101"/>
          </div>
          {/* ── Row 3: Monthly Fee (student rate) — auto-calculates discount ── */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-0">
            <div>
              <Inp label="Monthly Fee (Rs.) — Student's Actual Rate" type="number" min="0" value={form.monthlyFee||''} onChange={e => setForm({...form, monthlyFee: e.target.value})} placeholder="Leave blank = pay full class fee"/>
              {(() => {
                const classFees = S.get(K.CF, {});
                const classDue  = Number(classFees[form.cls] || 0);
                const stuFee    = Number(form.monthlyFee || 0);
                const autoDisc  = stuFee > 0 && stuFee < classDue ? classDue - stuFee : 0;
                if (!classDue) return <p className="text-xs text-gray-400 mt-1 mb-2">Set class fee in Fee Settings to see auto-discount.</p>;
                if (stuFee > classDue) return <p className="text-xs text-red-500 mt-1 mb-2">⚠️ Student fee cannot exceed class fee (Rs. {classDue.toLocaleString()}).</p>;
                if (autoDisc > 0) return (
                  <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2 mb-2 text-xs">
                    <span className="text-gray-600">Class Fee: Rs. {classDue.toLocaleString()} </span>
                    <span className="text-red-500 font-bold"> − Rs. {autoDisc.toLocaleString()} discount </span>
                    <span className="text-emerald-700 font-bold">= Rs. {stuFee.toLocaleString()} ✅</span>
                  </div>
                );
                if (stuFee === classDue) return <p className="text-xs text-gray-400 mt-1 mb-2">No discount — pays full class fee.</p>;
                return <p className="text-xs text-blue-500 mt-1 mb-2">Enter amount &lt; Rs. {classDue.toLocaleString()} to auto-add discount.</p>;
              })()}
            </div>
            <Inp label="Annual Fund (Rs.)" type="number" min="0" value={form.annualFund||''} onChange={e => setForm({...form, annualFund: e.target.value})} placeholder="e.g. 500 — leave blank if none"/>
          </div>
          {/* ── Row 4: Opening Balance ── */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-0">
            <Inp label="Opening Balance (Rs.) — Previous Dues" type="number" min="0" value={form.openingBalance||''} onChange={e => setForm({...form, openingBalance: e.target.value})} placeholder="0 if no prior balance"/>
            <div/>
          </div>
          {Number(form.openingBalance) > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-2 mb-2 text-xs text-amber-700">
              ⚠️ Opening balance of <strong>Rs. {Number(form.openingBalance).toLocaleString()}</strong> will show as prior due in fee collection.
            </div>
          )}
          {/* ── Divider: Family / Sibling Info ── */}
          <div className="border-t border-gray-100 pt-3 mt-1 mb-1">
            <p className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-2">👨‍👧‍👦 Family & Sibling Info</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-5 gap-y-0">
              <div className="sm:col-span-2">
                <Inp label="Family Name (for siblings)" value={form.family||''} onChange={e => setForm({...form, family: e.target.value})} placeholder="e.g. Khan Family — same for all siblings"/>
              </div>
              <Inp label="Family ID / Serial No." value={form.familyId||''} onChange={e => setForm({...form, familyId: e.target.value})} placeholder="e.g. F-001"/>
            </div>
            {(() => {
              // ── Global Engine: single source of truth — siblingDiscount mirrors getStuDisc ──
              const mirrorDisc = getStuDisc(form, S.get(K.CF, {}));
              return (
                <div className="mb-2">
                  <label className="text-xs font-bold text-gray-500 uppercase tracking-wide">Sibling Discount (Rs./month)</label>
                  <div className="mt-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm flex items-center justify-between">
                    <span className={mirrorDisc > 0 ? 'text-red-600 font-bold' : 'text-gray-400'}>
                      {mirrorDisc > 0 ? `Rs. ${mirrorDisc.toLocaleString()}` : 'Rs. 0 — no discount'}
                    </span>
                    <span className="text-xs text-gray-400 italic">🔒 mirror of global engine</span>
                  </div>
                  <p className="text-xs text-gray-400 mt-1">Read-only — change Monthly Fee above to adjust the discount.</p>
                </div>
              );
            })()}
          </div>
          {/* ── Student Status ── */}
          <div className="border-t border-gray-100 pt-3 mt-1 mb-1">
            <p className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-2">📋 Student Status</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-0">
              <div className="mb-3">
                <label className="block text-xs font-semibold text-gray-500 mb-1 uppercase tracking-wide">Status</label>
                <select value={form.status||'active'} onChange={e=>setForm({...form,status:e.target.value})}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400">
                  <option value="active">✅ Active</option>
                  <option value="left">🔴 Left School</option>
                </select>
              </div>
              {(form.status==='left') && (
                <Inp label="Left Date" type="date" value={form.leftDate||''} onChange={e=>setForm({...form,leftDate:e.target.value})}/>
              )}
            </div>
            {form.status==='left' && (
              <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-2 mb-2 text-xs text-red-700">
                🔴 This student will be excluded from all future fee billing and outstanding calculations. Historical payment records are preserved.
              </div>
            )}
          </div>
          {/* ── Row: Contact / Address ── */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-0">
            <Inp label="Contact Number" value={form.contact} onChange={e => setForm({...form, contact: e.target.value})} placeholder="e.g. 0321-1234567"/>
            <Inp label="Address" value={form.address} onChange={e => setForm({...form, address: e.target.value})} placeholder="Home address"/>
          </div>
          {/* ── Photo ── */}
          <Field label="Student Photo (Optional — used for ID card)">
            <div className="flex items-center gap-3 mb-2">
              {form.photo
                ? <img src={form.photo} alt="Preview" className="w-16 h-16 rounded-full object-cover border-2 border-blue-200"/>
                : <div className="w-16 h-16 rounded-full bg-blue-50 border-2 border-dashed border-blue-200 flex items-center justify-center text-2xl">📷</div>
              }
              <div className="flex-1">
                <input type="file" accept="image/*" onChange={e => {
                  const file = e.target.files[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = ev => setForm({...form, photo: ev.target.result});
                  reader.readAsDataURL(file);
                }} className="text-xs text-gray-600 w-full"/>
                {form.photo && <button onClick={() => setForm({...form, photo:''})} className="text-xs text-red-400 hover:text-red-600 mt-1">✕ Remove photo</button>}
              </div>
            </div>
          </Field>
          <div className="flex gap-2 mt-5">
            <Btn full onClick={save}>{form.id ? 'Update Student' : 'Save Student'}</Btn>
            <Btn variant="outline" onClick={() => setForm(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {delId && (
        <Modal title="Confirm Delete" onClose={() => setDelId(null)}>
          <p className="text-gray-600 mb-5">Are you sure you want to delete <strong>{list.find(s=>s.id===delId)?.name}</strong>? This cannot be undone.</p>
          <div className="flex gap-2">
            <Btn full variant="red" onClick={remove}>Yes, Delete</Btn>
            <Btn variant="outline" onClick={() => setDelId(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {/* ════════════════ FAMILY-BUNDLED EDIT MODAL ════════════════
          Replaces the legacy single-student edit form. Fetches ALL siblings via
          familyId (or family+father fallback) and edits the whole household in
          one screen. Per-child Active/Left toggle drops inactive siblings from
          the global engine's billing calculations via isActiveStu(). */}
      {familyEdit && (() => {
        const _cf = S.get(K.CF, {});
        const activeCount = familyEdit.children.filter(c => (c.status||'active') !== 'left').length;
        const obTotal     = Number(familyEdit.openingBalanceTotal) || 0;
        const obEach      = activeCount > 0 && obTotal !== 0 ? Math.round(obTotal / activeCount) : 0;
        const totalMonthly = familyEdit.children
          .filter(c => (c.status||'active') !== 'left')
          .reduce((s,c) => s + Number(c.monthlyFee || 0), 0);
        const totalDiscount = familyEdit.children
          .filter(c => (c.status||'active') !== 'left')
          .reduce((s,c) => s + getStuDisc(c, _cf), 0);
        return (
        <Modal title={`👨‍👧‍👦 Edit Family — ${familyEdit.family || familyEdit.father || 'Unnamed Family'} ${familyEdit.familyId ? '(ID: '+familyEdit.familyId+')' : ''}`} onClose={() => setFamilyEdit(null)} xl>
          {/* Banner */}
          <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-2 mb-3 flex items-center gap-2 text-xs text-blue-700 font-semibold">
            👨‍👧‍👦 {familyEdit.children.length} sibling(s) in this family — {activeCount} active, {familyEdit.children.length - activeCount} left. Shared fields apply to all. Opening Balance distributed equally across active siblings.
          </div>

          {/* ── Family-Level Shared Fields ── */}
          <p className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">📋 Family-Level Info (shared)</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-5 gap-y-0">
            <Inp label="Father's Name *" value={familyEdit.father} onChange={e => setFamilyEdit({...familyEdit, father: e.target.value})} placeholder="Father's full name"/>
            <Inp label="Family Name" value={familyEdit.family} onChange={e => setFamilyEdit({...familyEdit, family: e.target.value})} placeholder="e.g. Khan Family"/>
            <Inp label="Family ID / Serial No." value={familyEdit.familyId} onChange={e => setFamilyEdit({...familyEdit, familyId: e.target.value})} placeholder="e.g. 293"/>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-0">
            <Inp label="Contact Number" value={familyEdit.contact} onChange={e => setFamilyEdit({...familyEdit, contact: e.target.value})} placeholder="e.g. 0321-1234567"/>
            <Inp label="Address" value={familyEdit.address} onChange={e => setFamilyEdit({...familyEdit, address: e.target.value})} placeholder="Home address"/>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-0 items-end">
            <Inp label="Opening Balance (Rs.) — Previous Dues (Total All Siblings) — negative = advance/credit" type="number"
              value={familyEdit.openingBalanceTotal}
              onChange={e => setFamilyEdit({...familyEdit, openingBalanceTotal: e.target.value})}
              placeholder="0 if no prior balance"/>
            {obTotal !== 0 && activeCount > 0 && (
              <div className={`border rounded-xl px-3 py-2 mb-2 text-xs ${obTotal < 0 ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-amber-50 border-amber-200 text-amber-700'}`}>
                {obTotal < 0
                  ? <>💚 Advance/Credit: Rs. {Math.abs(obTotal).toLocaleString()} ÷ {activeCount} active = <strong>Rs. {Math.abs(obEach).toLocaleString()} credit each</strong></>
                  : <>Rs. {obTotal.toLocaleString()} ÷ {activeCount} active = <strong>Rs. {obEach.toLocaleString()} each</strong></>
                }
              </div>
            )}
          </div>

          {/* ── Children Cards (stacked) ── */}
          <div className="border-t border-gray-100 pt-3 mt-3">
            <p className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-3">👨‍👧‍👦 Children ({familyEdit.children.length})</p>
            {familyEdit.children.map((c, idx) => {
              const autoDisc = getStuDisc(c, _cf);
              const classFee = Number(_cf[c.cls] || 0);
              const isActive = (c.status || 'active') !== 'left';
              return (
                <div key={c.id} className={`border-2 rounded-xl p-3 mb-3 transition-all ${isActive ? 'border-emerald-200 bg-emerald-50/30' : 'border-red-200 bg-red-50/30 opacity-70'}`}>
                  <div className="flex items-center justify-between mb-3">
                    <p className="font-bold text-sm text-gray-700">
                      <span className="text-gray-400">#{idx+1}</span> — {c.name || '(New Child)'}
                      {!isActive && c.leftDate && <span className="ml-2 text-xs text-red-500">(Left: {c.leftDate})</span>}
                    </p>
                    {/* Active / Left toggle */}
                    <div className="flex items-center gap-2">
                      <span className={`text-xs font-bold ${isActive ? 'text-emerald-600' : 'text-red-600'}`}>
                        {isActive ? '✅ Active' : '🔴 Left School'}
                      </span>
                      <button
                        onClick={() => toggleChildStatus(idx)}
                        type="button"
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${isActive ? 'bg-emerald-500' : 'bg-red-400'}`}>
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${isActive ? 'translate-x-6' : 'translate-x-1'}`}/>
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 mb-2">
                    <Inp label="Full Name *" value={c.name||''} onChange={e => updateChild(idx, 'name', e.target.value)} placeholder="Full name"/>
                    <Sel label="Class *" value={c.cls||'1'} onChange={e => updateChild(idx, 'cls', e.target.value)} options={CLASSES.map(cl => ({v:cl, l:`Class ${cl}`}))}/>
                    <Inp label="Roll No *" value={c.roll||''} onChange={e => updateChild(idx, 'roll', e.target.value)} placeholder="e.g. 101"/>
                    <Inp label="Monthly Fee" type="number" min="0" value={c.monthlyFee||''} onChange={e => updateChild(idx, 'monthlyFee', e.target.value)} placeholder="Class fee if blank"/>
                  </div>
                  {/* Discount mirror (global engine) */}
                  {classFee > 0 && autoDisc > 0 && (
                    <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-1.5 text-xs">
                      <span className="text-gray-600">Class Fee Rs. {classFee.toLocaleString()} </span>
                      <span className="text-red-600 font-bold">− Rs. {autoDisc.toLocaleString()} discount </span>
                      <span className="text-emerald-700 font-bold">= Rs. {Number(c.monthlyFee||0).toLocaleString()} ✅</span>
                      <span className="text-gray-400 italic ml-2">(via global engine)</span>
                    </div>
                  )}
                  {classFee > 0 && autoDisc === 0 && Number(c.monthlyFee||0) > 0 && (
                    <p className="text-xs text-gray-400">No discount — pays full class fee.</p>
                  )}
                  {/* ── OB share + Per-child Outstanding (engine identity) ──
                      Outstanding = monthlyFee + obShare. obShare = obTotal ÷ activeCount.
                      Only shown for ACTIVE children — left students excluded from OB split. */}
                  {isActive && obEach !== 0 && (
                    <div className={`mt-2 rounded-lg px-3 py-1.5 text-xs flex items-center justify-between ${obEach < 0 ? 'bg-emerald-50 border border-emerald-200' : 'bg-amber-50 border border-amber-200'}`}>
                      <span className="text-gray-600">
                        Monthly Rs. {Number(c.monthlyFee||0).toLocaleString()}
                        {obEach > 0
                          ? <> <span className="text-amber-700 font-bold">+ Rs. {obEach.toLocaleString()} OB share</span></>
                          : <> <span className="text-emerald-700 font-bold">− Rs. {Math.abs(obEach).toLocaleString()} advance share</span></>
                        }
                      </span>
                      <span className={`font-extrabold ${(Number(c.monthlyFee||0) + obEach) < 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                        = Rs. {Math.abs(Number(c.monthlyFee||0) + obEach).toLocaleString()}
                        {(Number(c.monthlyFee||0) + obEach) < 0 ? ' Advance' : ' Outstanding'}
                      </span>
                    </div>
                  )}
                  {!isActive && (
                    <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-1.5 mt-2 text-xs text-red-700">
                      🔴 Excluded from active class register, fee billing, and outstanding calculations. Historical records preserved.
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* ── Summary footer — UNIFIED: Grand Total Outstanding = sum(monthly) + obTotal.
              Uses obTotal (not sum-of-rounded obShares) so the headline matches the user's
              input exactly — no rounding drift. */}
          {(() => {
            const grandOutstanding = totalMonthly + obTotal;  // monthly net + family OB carry
            return (
              <div className="bg-gradient-to-r from-blue-50 to-emerald-50 border border-blue-200 rounded-xl p-3 mt-3 grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs">
                <div><span className="text-gray-500 block uppercase font-semibold">Active Siblings</span><b className="text-emerald-700 text-base">{activeCount}</b></div>
                <div><span className="text-gray-500 block uppercase font-semibold">Total Monthly</span><b className="text-blue-700 text-base">Rs. {totalMonthly.toLocaleString()}</b></div>
                <div><span className="text-gray-500 block uppercase font-semibold">Total Discount</span><b className="text-red-600 text-base">Rs. {totalDiscount.toLocaleString()}</b></div>
                <div><span className="text-gray-500 block uppercase font-semibold">OB / Active Child</span><b className="text-amber-600 text-base">{obEach < 0 ? `−Rs. ${Math.abs(obEach).toLocaleString()}` : `Rs. ${obEach.toLocaleString()}`}</b></div>
                {/* Grand Total Outstanding — bold + colored, the user-facing number */}
                <div className="bg-white rounded-lg px-2 py-1 border-2 border-rose-200 shadow-sm">
                  <span className="text-gray-500 block uppercase font-semibold text-[10px]">🎯 Total Outstanding</span>
                  <b className={`text-base ${grandOutstanding < 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                    {grandOutstanding < 0 ? `+Rs. ${Math.abs(grandOutstanding).toLocaleString()}` : `Rs. ${grandOutstanding.toLocaleString()}`}
                  </b>
                  <span className="text-[10px] text-gray-400 block leading-tight">
                    Rs. {totalMonthly.toLocaleString()} {obTotal >= 0 ? '+' : '−'} Rs. {Math.abs(obTotal).toLocaleString()} OB
                  </span>
                </div>
              </div>
            );
          })()}

          <div className="flex gap-2 mt-5">
            <Btn full onClick={saveFamily}>💾 Save Family ({familyEdit.children.length} children)</Btn>
            <Btn variant="outline" onClick={() => setFamilyEdit(null)}>Cancel</Btn>
          </div>
        </Modal>
        );
      })()}
    </div>
  );
}

// ── INVENTORY ────────────────────────────────────────────────────────────────
// ── Inventory schema ── retailPrice replaces legacy `price` (kept as alias for old rows).
// New fields: purchasePrice (قیمتِ خرید), retailPrice (قیمتِ فروخت), targetClass, rackShelf.
const blankItem = { name:'', type:'Book', qty:0, price:0, purchasePrice:0, retailPrice:0, threshold:5, vendorId:'', targetClass:'', rackShelf:'' };

function Inventory() {
  const { role } = React.useContext(UserContext);
  const isAdmin     = role === 'admin';
  const isPrincipal = role === 'principal';
  const canAdd      = isAdmin || isPrincipal; // principal can add items & issue
  const canWrite    = isAdmin;                // only admin can edit/delete
  // Integrity guard at mount
  const [items, setItems]       = useState(() => getActiveList(K.INV));
  const [txs, setTxs]           = useState(() => S.get(K.TX, []));
  const [form, setForm]         = useState(null);
  const [stockMod, setStockMod] = useState(null); // {item, mode:'in'|'out'}
  const [issueMod, setIssueMod] = useState(null); // item
  const [histMod, setHistMod]   = useState(null); // item
  const [delId, setDelId]       = useState(null);
  const students = S.get(K.STU, []);
  const [vendors] = useState(() => S.get(K.VENDOR, []));

  const [sQty, setSQty]       = useState('');
  const [sNote, setSNote]     = useState('');
  const [sVendorId, setSVendorId] = useState(''); // vendor for stock-in
  const [iForm, setIForm] = useState({ stuId:'', qty:1, note:'' });

  const persistItems = (data) => { S.set(K.INV, data); setItems(data); };
  const persistTxs   = (data) => { S.set(K.TX, data); setTxs(data); };

  const saveItem = () => {
    if (!form.name.trim()) return alert('Item name is required.');
    const qty = Math.max(0, Number(form.qty) || 0); // ← never negative
    if (Number(form.qty) < 0) return alert('⚠️ Stock quantity cannot be negative. Minimum is 0.');
    const itemId = form.id || uid();
    // Pricing: prefer new fields, fall back to legacy `price` for old rows
    const purchasePrice = Math.max(0, Number(form.purchasePrice || form.price || 0));
    const retailPrice   = Math.max(0, Number(form.retailPrice   || form.price || 0));
    const item = {
      ...form,
      id: itemId,
      qty,
      purchasePrice,
      retailPrice,
      price: retailPrice,                                // legacy alias for back-compat
      threshold: Math.max(0, Number(form.threshold || 5)),
      targetClass: form.targetClass || '',
      rackShelf:   form.rackShelf   || ''
    };
    const updated = form.id ? items.map(i => i.id === form.id ? item : i) : [...items, item];
    persistItems(updated);
    if (!form.id && qty > 0) {
      // Initial-stock cash entry uses PURCHASE price (cost), not retail
      const price = purchasePrice;
      if (form.vendorId) {
        // Vendor-linked initial stock → SBOOK; payment tracked via VendorBooks
        const sbook = S.get(K.SBOOK, []);
        const delivery = { id: uid(), vendorId: form.vendorId, name: form.name.trim(), cls: 'INV', qty, price, year: NOW.getFullYear(), note: 'Initial stock entry', invItem: true, date: new Date().toISOString() };
        S.set(K.SBOOK, [...sbook, delivery]);
      } else if (price > 0) {
        // ── Global Engine: direct cash purchase → Cash Book expense ──────
        addCashBookEntry('expense',
          `Initial Inventory — ${form.name.trim()} (×${qty})`,
          price * qty, 'Cash',
          new Date().toISOString().slice(0, 10),
          'Initial stock purchase (direct)', 'inventory');
      }
    }
    setForm(null);
  };

  const doStock = () => {
    const qty = Number(sQty);
    if (!qty || qty <= 0) return alert('Enter a valid quantity.');
    if (stockMod.mode === 'out') {
      const current = Number(stockMod.item.qty);
      if (qty > current) return alert(`⚠️ Cannot remove ${qty} — only ${current} in stock.\n\nStock cannot go negative.`);
    }
    const newQty = stockMod.mode === 'in' ? Number(stockMod.item.qty) + qty : Number(stockMod.item.qty) - qty;
    if (newQty < 0) return alert('⚠️ Stock cannot go negative.');
    const updatedItems = items.map(i => i.id === stockMod.item.id ? { ...i, qty: newQty } : i);
    const newTx = { id: uid(), itemId: stockMod.item.id, type: stockMod.mode, qty, date: new Date().toISOString(), note: sNote, vendorId: stockMod.mode === 'in' ? (sVendorId || '') : '' };
    persistItems(updatedItems);
    persistTxs([...txs, newTx]);
    if (stockMod.mode === 'in') {
      const price = Number(stockMod.item.price) || 0;
      if (sVendorId) {
        // Vendor-linked: log in SBOOK; cash book entry made when vendor payment is recorded
        const sbook = S.get(K.SBOOK, []);
        const delivery = { id: uid(), vendorId: sVendorId, name: stockMod.item.name, cls: 'INV', qty, price, year: NOW.getFullYear(), note: sNote || 'Inventory delivery', invItem: true, date: new Date().toISOString() };
        S.set(K.SBOOK, [...sbook, delivery]);
      } else if (price > 0) {
        // ── Global Engine: direct cash purchase → Cash Book expense ──────
        addCashBookEntry('expense',
          `Inventory Purchase — ${stockMod.item.name} (×${qty})`,
          price * qty, 'Cash',
          new Date().toISOString().slice(0, 10),
          sNote || 'Direct stock-in purchase', 'inventory');
      }
    }
    setStockMod(null); setSQty(''); setSNote(''); setSVendorId('');
  };

  const doIssue = () => {
    const qty = Number(iForm.qty);
    if (!iForm.stuId) return alert('Please select a student.');
    if (!qty || qty <= 0) return alert('Enter a valid quantity.');
    const current = Number(issueMod.qty);
    if (qty > current) return alert(`⚠️ Cannot issue ${qty} — only ${current} in stock.\n\nStock cannot go negative.`);
    const newQty = current - qty;
    if (newQty < 0) return alert('⚠️ Stock cannot go negative.');
    const updatedItems = items.map(i => i.id === issueMod.id ? { ...i, qty: newQty } : i);
    const newTx = { id: uid(), itemId: issueMod.id, type: 'issue', qty, stuId: iForm.stuId, date: new Date().toISOString(), note: iForm.note };
    persistItems(updatedItems);
    persistTxs([...txs, newTx]);
    setIssueMod(null); setIForm({ stuId:'', qty:1, note:'' });
  };

  const low = items.filter(i => Number(i.qty) <= Number(i.threshold || 5));

  const printInventory = () => {
    // ── Engine source: getGlobalInventoryAssetValue — same data as page header ──
    const stats = getGlobalInventoryAssetValue(items);
    printPage('Inventory Report', `
      <h2>Inventory Report</h2>
      <div class="summary">
        <div class="sum-card"><div class="val">${stats.itemCount}</div><div class="lbl">Total Items</div></div>
        <div class="sum-card"><div class="val">Rs. ${stats.totalCost.toLocaleString()}</div><div class="lbl">Stock Value (Cost)</div></div>
        <div class="sum-card"><div class="val">Rs. ${stats.totalRetail.toLocaleString()}</div><div class="lbl">Stock Value (Retail)</div></div>
        <div class="sum-card"><div class="val">${stats.lowStockCount}</div><div class="lbl">Low Stock</div></div>
      </div>
      <table><thead><tr><th>#</th><th>Item Name</th><th>Type</th><th>Qty</th><th>Cost (Rs.)</th><th>Retail (Rs.)</th><th>Stock Value</th><th>Low At</th><th>Status</th></tr></thead>
      <tbody>${items.map((it,i)=>{
        const isLow  = Number(it.qty)<=Number(it.threshold||5);
        const qty    = Number(it.qty||0);
        const cost   = Number(it.purchasePrice || it.price || 0);
        const retail = Number(it.retailPrice   || it.price || 0);
        return `<tr><td>${i+1}</td><td><b>${it.name}</b></td><td><span class="badge b-purple">${it.type}</span></td><td><b>${qty}</b></td><td>${cost.toLocaleString()}</td><td>${retail.toLocaleString()}</td><td><b>Rs. ${(qty*cost).toLocaleString()}</b></td><td>${it.threshold||5}</td><td><span class="badge ${isLow?'b-red':'b-green'}">${isLow?'Low Stock':'In Stock'}</span></td></tr>`;
      }).join('')}</tbody>
      <tfoot><tr><td colspan="6" style="text-align:right"><b>Total Stock Value (at cost):</b></td><td><b>Rs. ${stats.totalCost.toLocaleString()}</b></td><td colspan="2"></td></tr></tfoot>
      </table>`);
  };

  // ── Global Engine: single source for stock-on-hand value ──
  const invStats = getGlobalInventoryAssetValue(items);

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-xl font-bold text-gray-800">Inventory</h2>
        <div className="flex gap-2">
          <Btn variant="outline" onClick={printInventory}>🖨️ Print</Btn>
          {canAdd && <Btn onClick={() => setForm({ ...blankItem })}>+ Add Item</Btn>}
        </div>
      </div>

      {/* ── Stock Asset Value Cards — sourced from getGlobalInventoryAssetValue ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3">
          <p className="text-[10px] text-blue-600 font-bold uppercase tracking-wider">📦 Total Items</p>
          <p className="text-lg font-extrabold text-blue-700">{invStats.itemCount}</p>
        </div>
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
          <p className="text-[10px] text-amber-600 font-bold uppercase tracking-wider">💵 Stock Value (Cost)</p>
          <p className="text-lg font-extrabold text-amber-700">Rs. {invStats.totalCost.toLocaleString()}</p>
          <p className="text-[10px] text-gray-400">via global engine</p>
        </div>
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">
          <p className="text-[10px] text-emerald-600 font-bold uppercase tracking-wider">🏷️ Stock Value (Retail)</p>
          <p className="text-lg font-extrabold text-emerald-700">Rs. {invStats.totalRetail.toLocaleString()}</p>
          <p className="text-[10px] text-gray-400">via global engine</p>
        </div>
        <div className={`border rounded-xl px-4 py-3 ${invStats.lowStockCount > 0 ? 'bg-red-50 border-red-200' : 'bg-gray-50 border-gray-200'}`}>
          <p className={`text-[10px] font-bold uppercase tracking-wider ${invStats.lowStockCount > 0 ? 'text-red-600' : 'text-gray-500'}`}>⚠️ Low Stock</p>
          <p className={`text-lg font-extrabold ${invStats.lowStockCount > 0 ? 'text-red-700' : 'text-gray-500'}`}>{invStats.lowStockCount}</p>
        </div>
      </div>

      {low.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 mb-4 text-red-700 text-sm font-semibold">
          ⚠️ {low.length} item{low.length > 1 ? 's are' : ' is'} running low on stock
        </div>
      )}

      {items.length === 0
        ? <Empty icon="📦" text="No inventory items. Add books and copies to get started." />
        : (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b">
                  <tr className="text-left text-xs text-gray-500 font-semibold uppercase">
                    <th className="px-4 py-3">Sr.</th>
                    <th className="px-4 py-3">Item Name</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3">Qty</th>
                    <th className="px-4 py-3 hidden sm:table-cell">Price</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {items.map((item, idx) => {
                    const isLow = Number(item.qty) <= Number(item.threshold || 5);
                    return (
                      <tr key={item.id} className="hover:bg-slate-50 transition-colors">
                        <td className="px-4 py-3 text-xs font-bold text-gray-400">{String(idx+1).padStart(2,'0')}</td>
                        <td className="px-4 py-3 font-semibold text-gray-800">{item.name}</td>
                        <td className="px-4 py-3"><Badge color="purple">{item.type}</Badge></td>
                        <td className="px-4 py-3 font-bold text-gray-700">{item.qty}</td>
                        <td className="px-4 py-3 text-gray-500 hidden sm:table-cell">Rs. {Number(item.price).toLocaleString()}</td>
                        <td className="px-4 py-3"><Badge color={isLow ? 'red' : 'green'}>{isLow ? 'Low Stock' : 'In Stock'}</Badge></td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex flex-wrap gap-1 justify-end">
                            <Btn sm variant="green" onClick={() => { setStockMod({ item, mode:'in' }); setSQty(''); setSNote(''); }}>Stock In</Btn>
                            <Btn sm variant="outline" onClick={() => { setStockMod({ item, mode:'out' }); setSQty(''); setSNote(''); }}>Stock Out</Btn>
                            {canAdd && <Btn sm variant="yellow" onClick={() => { setIssueMod(item); setIForm({ stuId: students[0]?.id||'', qty:1, note:'' }); }}>Issue</Btn>}
                            <Btn sm variant="ghost" onClick={() => setHistMod(item)}>Log</Btn>
                            {isAdmin && <Btn sm variant="outline" onClick={() => window.requireMasterCode(() => setForm({ ...item }), `Edit item: ${item.name}`)}>Edit</Btn>}
                            {isAdmin && <Btn sm variant="red" onClick={() => window.requireMasterCode(() => setDelId(item.id), `Delete item: ${item.name}`)}>Del</Btn>}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )
      }

      {/* ════════════════ ADD / EDIT INVENTORY ITEM — bilingual prototype layout ════════════════ */}
      {form && (
        <Modal title={form.id ? '📦 Edit Inventory Item' : '📦 Add Inventory Item'} onClose={() => setForm(null)} xl>
          {/* Bilingual subtitle */}
          <p className="text-xs text-slate-500 mb-4 -mt-2">اسٹاک، خرید و فروخت کی قیمت اور کلاس میپنگ مینیج کریں</p>

          {/* Row 1: Name + Type */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1.5">Item Name *</label>
              <input type="text" value={form.name} onChange={e => setForm({...form, name: e.target.value})}
                placeholder="e.g. English Book Class 5"
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 text-slate-800"/>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1.5">Item Type *</label>
              <select value={form.type} onChange={e => setForm({...form, type: e.target.value})}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 text-slate-800">
                <option value="Book">📚 Book (کتاب)</option>
                <option value="Uniform">👕 Uniform (یونیفارم)</option>
                <option value="Stationery">✏️ Stationery (اسٹیشنری)</option>
                <option value="Copy">📒 Copy (کاپی)</option>
                <option value="Other">📦 Other Asset</option>
              </select>
            </div>
          </div>

          {/* Row 2: Class mapping + Vendor (blue tinted) */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-blue-50/40 p-3 rounded-xl border border-blue-100/60 mb-4">
            <div>
              <label className="block text-xs font-semibold text-blue-900 uppercase tracking-wider mb-1.5">Target Class (Map to Class)</label>
              <select value={form.targetClass||''} onChange={e => setForm({...form, targetClass: e.target.value})}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:border-blue-500 text-slate-800">
                <option value="">— General / No Class Restriction —</option>
                {CLASSES.map(c => <option key={c} value={c}>Class {c}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-blue-900 uppercase tracking-wider mb-1.5">Vendor / Supplier</label>
              <select value={form.vendorId||''} onChange={e => setForm({...form, vendorId: e.target.value})}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:border-blue-500 text-slate-800">
                <option value="">— Select Vendor —</option>
                {vendors.map(v => <option key={v.id} value={v.id}>{v.name}{v.contact ? ' · '+v.contact : ''}</option>)}
              </select>
            </div>
          </div>

          {/* Row 3: Quantity + Threshold + Rack */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1.5">Initial Quantity *</label>
              <input type="number" min="0" value={form.qty} onChange={e => setForm({...form, qty: e.target.value})}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-blue-500 text-slate-800"/>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1.5">Low Stock Threshold</label>
              <input type="number" min="0" value={form.threshold} onChange={e => setForm({...form, threshold: e.target.value})}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-blue-500 text-red-600 font-medium"/>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1.5">Rack / Shelf No.</label>
              <input type="text" value={form.rackShelf||''} onChange={e => setForm({...form, rackShelf: e.target.value})}
                placeholder="e.g. Almirah 2-B"
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-blue-500 text-slate-800"/>
            </div>
          </div>

          {/* Row 4: Pricing Matrix (slate-50 box) */}
          <div className="bg-slate-50 p-4 rounded-xl border border-slate-200/70 mb-4">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider block mb-3">🪙 Pricing Matrix (Rs.)</span>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Purchase Cost (قیمتِ خرید) *</label>
                <div className="relative">
                  <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-xs font-bold text-slate-400">Rs.</span>
                  <input type="number" min="0" value={form.purchasePrice !== undefined && form.purchasePrice !== '' ? form.purchasePrice : (form.price||'')} onChange={e => setForm({...form, purchasePrice: e.target.value})}
                    className="w-full pl-10 pr-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-amber-500 text-slate-800 font-semibold bg-white"/>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Retail / Sale Price (قیمتِ فروخت) *</label>
                <div className="relative">
                  <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-xs font-bold text-slate-400">Rs.</span>
                  <input type="number" min="0" value={form.retailPrice !== undefined && form.retailPrice !== '' ? form.retailPrice : (form.price||'')} onChange={e => setForm({...form, retailPrice: e.target.value})}
                    className="w-full pl-10 pr-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-emerald-500 text-slate-800 font-semibold bg-white"/>
                </div>
              </div>
            </div>
            {/* Margin preview */}
            {(() => {
              const pc = Number(form.purchasePrice || form.price || 0);
              const rp = Number(form.retailPrice   || form.price || 0);
              const margin = rp - pc;
              const pct = pc > 0 ? Math.round((margin / pc) * 100) : 0;
              if (pc <= 0 && rp <= 0) return null;
              return (
                <p className={`text-xs mt-2 font-semibold ${margin >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                  💹 Margin per unit: Rs. {margin.toLocaleString()} {pc > 0 && <span className="text-slate-500 font-normal">({pct}%)</span>}
                </p>
              );
            })()}
          </div>

          {/* Vendor cost hint */}
          {!form.id && form.vendorId && Number(form.qty) > 0 && Number(form.purchasePrice || form.price) > 0 && (
            <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-2 mb-3 text-xs text-blue-700">
              📦 Initial stock (qty × purchase cost = Rs. {(Number(form.qty)*Number(form.purchasePrice||form.price||0)).toLocaleString()}) will be added to vendor's ledger.
            </div>
          )}
          {vendors.length === 0 && !form.id && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-2 mb-3 text-xs text-amber-700">
              💡 Add vendors in <strong>Vendors &amp; Books</strong> tab to link inventory to supplier accounts.
            </div>
          )}

          <div className="flex gap-2 pt-3 border-t border-slate-100 justify-end">
            <Btn variant="outline" onClick={() => setForm(null)}>Cancel</Btn>
            <Btn onClick={saveItem}>✓ {form.id ? 'Update Item' : 'Save Item'}</Btn>
          </div>
        </Modal>
      )}

      {/* Stock In / Out */}
      {stockMod && (
        <Modal title={`Stock ${stockMod.mode === 'in' ? 'In ➕' : 'Out ➖'} — ${stockMod.item.name}`} onClose={() => setStockMod(null)}>
          <div className={`rounded-xl px-4 py-2.5 mb-4 flex justify-between text-sm ${stockMod.mode==='out' ? 'bg-amber-50 border border-amber-200' : 'bg-emerald-50 border border-emerald-200'}`}>
            <span className="text-gray-600">Current Stock:</span>
            <strong className={stockMod.item.qty <= 0 ? 'text-red-600' : 'text-gray-800'}>{stockMod.item.qty} units</strong>
          </div>
          {stockMod.mode === 'out' && stockMod.item.qty <= 0 && (
            <div className="bg-red-50 border border-red-300 rounded-xl px-4 py-2.5 mb-3 text-sm text-red-700 font-semibold">
              🚫 No stock available — cannot remove any quantity.
            </div>
          )}
          <Inp
            label={`Quantity to ${stockMod.mode === 'in' ? 'Add' : 'Remove'} *${stockMod.mode==='out' ? ` (max ${stockMod.item.qty})` : ''}`}
            type="number" min="1"
            max={stockMod.mode === 'out' ? stockMod.item.qty : undefined}
            value={sQty}
            onChange={e => {
              const v = Number(e.target.value);
              if (stockMod.mode === 'out' && v > Number(stockMod.item.qty)) return;
              setSQty(e.target.value);
            }}
            placeholder="Enter quantity"/>
          {stockMod.mode === 'out' && Number(sQty) > 0 && (
            <p className="text-xs text-gray-400 -mt-2 mb-2">
              After removal: <strong className={Number(stockMod.item.qty) - Number(sQty) < 0 ? 'text-red-600' : 'text-emerald-700'}>
                {Math.max(0, Number(stockMod.item.qty) - Number(sQty))} units
              </strong>
            </p>
          )}
          {stockMod.mode === 'in' && vendors.length > 0 && (
            <div className="mb-3">
              <label className="block text-xs font-semibold text-gray-500 mb-1 uppercase tracking-wide">Vendor (optional)</label>
              <select value={sVendorId} onChange={e => setSVendorId(e.target.value)} className={inputCls}>
                <option value="">— No vendor / walk-in —</option>
                {vendors.map(v => <option key={v.id} value={v.id}>{v.name}{v.contact ? ' · '+v.contact : ''}</option>)}
              </select>
              {sVendorId && <p className="text-xs text-blue-600 mt-1">📦 This delivery will be added to vendor's ledger automatically.</p>}
            </div>
          )}
          {stockMod.mode === 'in' && vendors.length === 0 && (
            <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-2.5 mb-3 text-xs text-blue-700">
              💡 Go to <strong>Vendors &amp; Books</strong> tab to add vendors — then stock deliveries will be linked to their ledger.
            </div>
          )}
          <Inp label="Note (optional)" value={sNote} onChange={e => setSNote(e.target.value)} placeholder="Reason or reference number"/>
          <div className="flex gap-2 mt-5">
            <Btn full variant={stockMod.mode === 'in' ? 'green' : 'red'} onClick={doStock}
              disabled={stockMod.mode === 'out' && stockMod.item.qty <= 0}>
              Confirm {stockMod.mode === 'in' ? 'Stock In ➕' : 'Stock Out ➖'}
            </Btn>
            <Btn variant="outline" onClick={() => setStockMod(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {/* Issue to Student */}
      {issueMod && (
        <Modal title={`Issue "${issueMod.name}" to Student`} onClose={() => setIssueMod(null)}>
          {students.length === 0
            ? <p className="text-gray-500">No students found. Please add students first.</p>
            : <>
                <p className="text-sm text-gray-500 mb-4">Available: <strong className="text-gray-800">{issueMod.qty}</strong></p>
                <Sel label="Select Student *" value={iForm.stuId} onChange={e => setIForm({...iForm, stuId: e.target.value})}
                  options={students.map(s => ({ v: s.id, l: `${s.name} (Class ${s.cls}, Roll ${s.roll})` }))}/>
                <Inp label="Quantity *" type="number" min="1" max={issueMod.qty} value={iForm.qty} onChange={e => setIForm({...iForm, qty: e.target.value})}/>
                <Inp label="Note (optional)" value={iForm.note} onChange={e => setIForm({...iForm, note: e.target.value})} placeholder="e.g. Lost previous copy"/>
                <div className="flex gap-2 mt-5">
                  <Btn full onClick={doIssue}>Issue to Student</Btn>
                  <Btn variant="outline" onClick={() => setIssueMod(null)}>Cancel</Btn>
                </div>
              </>
          }
        </Modal>
      )}

      {/* Transaction Log */}
      {histMod && (() => {
        const itemTxs = [...txs.filter(t => t.itemId === histMod.id)].reverse();
        return (
          <Modal title={`Stock Log — ${histMod.name}`} onClose={() => setHistMod(null)} wide>
            {itemTxs.length === 0
              ? <p className="text-center text-gray-400 py-6">No transactions recorded yet.</p>
              : <div className="space-y-2">
                  {itemTxs.map(tx => {
                    const stu = students.find(s => s.id === tx.stuId);
                    const colors = { in:'green', out:'red', issue:'yellow' };
                    return (
                      <div key={tx.id} className="flex items-start justify-between p-3 bg-gray-50 rounded-xl">
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <Badge color={colors[tx.type]}>{tx.type === 'in' ? 'Stock In' : tx.type === 'out' ? 'Stock Out' : 'Issued'}</Badge>
                            {stu && <span className="text-sm text-gray-600 font-medium">→ {stu.name} (Class {stu.cls})</span>}
                          </div>
                          {tx.note && <p className="text-xs text-gray-400">{tx.note}</p>}
                        </div>
                        <div className="text-right shrink-0 ml-3">
                          <p className="font-bold text-sm text-gray-800">{tx.type === 'in' ? '+' : '-'}{tx.qty}</p>
                          <p className="text-xs text-gray-400">{new Date(tx.date).toLocaleDateString()}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
            }
          </Modal>
        );
      })()}

      {delId && (
        <Modal title="Delete Item" onClose={() => setDelId(null)}>
          <p className="text-gray-600 mb-5">Delete <strong>{items.find(i=>i.id===delId)?.name}</strong>? All stock transactions will remain in logs.</p>
          <div className="flex gap-2">
            <Btn full variant="red" onClick={() => { persistItems(items.filter(i=>i.id!==delId)); setDelId(null); }}>Delete</Btn>
            <Btn variant="outline" onClick={() => setDelId(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── FEE LEDGER ───────────────────────────────────────────────────────────────
function Fees() {
  const { role } = React.useContext(UserContext);
  const isAdmin     = role === 'admin';
  const isPrincipal = role === 'principal';
  const [tab, setTab]           = useState('status');
  // ── v73: LIVE READS — students + classFees re-read each render.
  // setClassFees is a tick trigger: saveFee still does `S.set(K.CF, u)` then
  // setClassFees(u), and we just bump the tick so the live read above picks
  // up the new value. No double-write, no snapshot drift.
  const [_feesTick, _setFeesTick] = useState(0);
  const students                = getActiveList(K.STU);
  const classFees               = S.get(K.CF, {});
  const setClassFees            = (_u) => _setFeesTick(t => t + 1);
  const [payments, setPayments] = useState(() => getActiveList(K.PAY));
  const [payMod, setPayMod]     = useState(null);
  const [receipt, setReceipt]   = useState(null);
  const [histStu, setHistStu]   = useState('');

  const [vm, setVm] = useState(NOW.getMonth());
  const [vy, setVy] = useState(NOW.getFullYear());
  // Family Payment tab — local search + status filter (Master Design polish)
  const [famSearch, setFamSearch] = useState('');
  const [famStatusFilter, setFamStatusFilter] = useState('all'); // 'all' | 'due' | 'cleared'
  const [pf, setPf] = useState({ month: NOW.getMonth(), year: NOW.getFullYear(), amount: '', discount: '', annualFund: '', note: '', paymentMethod: 'Cash' });

  const years = Array.from({ length: 5 }, (_, i) => NOW.getFullYear() - 2 + i);

  const saveFee = (cls, val) => {
    const u = { ...classFees, [cls]: Number(val) };
    S.set(K.CF, u); setClassFees(u);
  };

  const recordPayment = () => {
    if (!pf.amount || Number(pf.amount) <= 0) return alert('Enter a valid amount.');
    const disc = Number(pf.discount || 0);
    if (disc < 0) return alert('Discount cannot be negative.');
    // Route through the SINGLE interceptor processFeeTransaction (Phase 2).
    // Same K.PAY shape, same K.CBOOK behavior — only the write path is unified.
    const result = processFeeTransaction({
      familyId:   payMod.familyId || '',
      paymentMethod: pf.paymentMethod || 'Cash',
      date:       new Date().toISOString(),
      note:       pf.note,
      source:     'individual',
      studentTransactions: [{
        stuId:      payMod.id,
        stuName:    payMod.name,
        amount:     Number(pf.amount),
        discount:   disc,
        annualFund: Number(pf.annualFund || 0),
        month:      Number(pf.month),
        year:       Number(pf.year),
      }],
    });
    if (!result.ok) { alert('Save failed: ' + (result.error || 'unknown')); return; }
    // Mirror the new payment(s) into local React state so the UI re-renders instantly
    // without waiting for the Firebase echo round-trip.
    setPayments(S.get(K.PAY, []));
    setPayMod(null);
    setReceipt({ pay: result.pays[0], stu: payMod });
  };

  const status = useMemo(() => {
    const paid = {};
    payments.filter(p => p.month === vm && p.year === vy).forEach(p => { paid[p.stuId] = p; });
    return students.map(s => {
      const cf       = Number(classFees[s.cls] || 0);
      const autoDisc = getStuDisc(s, classFees);
      return { stu: s, pay: paid[s.id] || null, due: cf, autoDisc };
    });
  }, [students, payments, classFees, vm, vy]);

  const histPays = histStu ? [...payments.filter(p => p.stuId === histStu)].reverse() : [];
  const histStuObj = students.find(s => s.id === histStu);

  const printReceipt = (pay, stu) => {
    // Calculate closing balance
    const allPays = S.get(K.PAY, []);
    const classFee = Number(classFees[stu.cls] || 0);
    const ob = Number(stu.openingBalance || 0);
    const stuMonthPays = allPays.filter(p => p.stuId === stu.id && p.month === pay.month && p.year === pay.year);
    const totalPaidThisMonth = stuMonthPays.reduce((s, p) => s + Number(p.amount || 0), 0);
    const totalDiscThisMonth = stuMonthPays.reduce((s, p) => s + Number(p.discount || 0), 0);
    const netDue = Math.max(0, classFee - totalDiscThisMonth) + ob;
    const closingBal = Math.max(0, netDue - totalPaidThisMonth);
    const isFullyPaid = closingBal === 0;

    const win = window.open('', '_blank', 'width=420,height=700');
    if (!win) { alert('Popup blocked! Please allow popups for this site to print.'); return; }
    win.document.write(`<!DOCTYPE html><html><head><title>Fee Receipt</title>
      <style>
        body{font-family:'Segoe UI',Arial,sans-serif;padding:26px;max-width:380px;margin:0 auto;color:#1a1a1a;position:relative}
        .logo-hdr{text-align:center;margin-bottom:10px;padding-bottom:10px;border-bottom:2px solid #c0392b}
        .logo-hdr img{height:60px;object-fit:contain}
        h2{text-align:center;color:#c0392b;margin:6px 0 2px;font-size:16px;font-weight:800;letter-spacing:1px}
        .divider{border:none;border-top:1px dashed #d1d5db;margin:10px 0}
        .grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}
        .label{font-size:10px;color:#6b7280;margin-bottom:2px;text-transform:uppercase}
        .value{font-size:12px;font-weight:600}
        .total{display:flex;justify-content:space-between;align-items:center;background:#f0fdf4;padding:10px 14px;border-radius:8px;margin:10px 0}
        .total-label{font-size:13px;font-weight:700;color:#15803d}
        .total-val{font-size:20px;font-weight:800;color:#15803d}
        .closing{display:flex;justify-content:space-between;align-items:center;padding:8px 14px;border-radius:8px;margin:6px 0;font-size:13px;font-weight:700;}
        .footer{text-align:center;font-size:10px;color:#9ca3af;margin-top:10px}
        .dev-footer{text-align:center;margin-top:14px;padding-top:8px;border-top:1px solid #e5e7eb;font-size:8px;color:#9ca3af;letter-spacing:.3px}
        .paid-stamp{position:fixed;top:50%;right:20px;transform:translateY(-50%) rotate(-25deg);border:5px solid #15803d;color:#15803d;font-size:42px;font-weight:900;padding:6px 16px;border-radius:8px;opacity:0.18;letter-spacing:4px;pointer-events:none;user-select:none}
        @media print{body{padding:10px}button{display:none!important}.paid-stamp{position:fixed;top:50%;right:20px}}
      </style></head><body>
      ${isFullyPaid ? '<div class="paid-stamp">PAID</div>' : ''}
      <div class="logo-hdr"><img src="${LOGO_SRC}" alt="DISS" onerror="this.style.display='none'"/></div>
      <h2>FEE RECEIPT</h2>
      <hr class="divider"/>
      <div class="grid">
        <div><div class="label">Receipt No</div><div class="value">${pay.rcpt}</div></div>
        <div><div class="label">Date</div><div class="value">${new Date(pay.date).toLocaleDateString('en-PK')}</div></div>
        <div><div class="label">Student Name</div><div class="value">${stu.name}</div></div>
        <div><div class="label">Father's Name</div><div class="value">${stu.father || '—'}</div></div>
        <div><div class="label">Class</div><div class="value">${stu.cls}</div></div>
        <div><div class="label">Roll Number</div><div class="value">${stu.roll}</div></div>
        <div><div class="label">Fee Month</div><div class="value">${MONTHS[pay.month]} ${pay.year}</div></div>
        <div><div class="label">Payment Method</div><div class="value">${pay.paymentMethod||'Cash'}</div></div>
        <div><div class="label">Collected By</div><div class="value" style="color:#1e40af;font-weight:700">${pay.createdByName || '—'}</div></div>
      </div>
      <hr class="divider"/>
      <div style="margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:12px"><span style="color:#6b7280">Monthly Fee</span><span style="font-weight:600">Rs. ${classFee.toLocaleString()}</span></div>
        ${totalDiscThisMonth > 0 ? `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:12px;color:#dc2626"><span>Discount</span><span style="font-weight:600">- Rs. ${totalDiscThisMonth.toLocaleString()}</span></div>` : ''}
        ${ob > 0 ? `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:12px;color:#d97706"><span>Opening Balance (prev dues)</span><span style="font-weight:600">+ Rs. ${ob.toLocaleString()}</span></div>` : ''}
        <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:12px;border-top:1px solid #e5e7eb"><span style="color:#6b7280">Net Due</span><span style="font-weight:700">Rs. ${netDue.toLocaleString()}</span></div>
        ${pay.annualFund ? `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:12px"><span style="color:#6b7280">Annual Fund</span><span style="font-weight:600">Rs. ${Number(pay.annualFund).toLocaleString()}</span></div>` : ''}
      </div>
      <div class="total">
        <span class="total-label">Amount Received</span>
        <span class="total-val">Rs. ${(Number(pay.amount) + Number(pay.annualFund||0)).toLocaleString()}</span>
      </div>
      <div class="closing" style="background:${isFullyPaid?'#f0fdf4':'#fef2f2'};color:${isFullyPaid?'#15803d':'#dc2626'}">
        <span>Closing Balance</span>
        <span style="font-size:16px">Rs. ${closingBal.toLocaleString()} ${isFullyPaid?'✅ CLEARED':''}</span>
      </div>
      ${(() => { const _n = cleanNoteForReceipt(pay.note); return _n ? `<p style="font-size:11px;color:#6b7280">Note: ${_n}</p>` : ''; })()}
      <hr class="divider"/>
      <div style="text-align:center;margin:10px 0">
        <p style="font-size:13px;color:#15803d;font-weight:700;margin:0 0 2px">🙏 Thank You for Your Payment!</p>
        <p style="font-size:10px;color:#6b7280;font-style:italic;margin:0">May your generosity be rewarded — keep growing with DISS.</p>
      </div>
      ${getPrintAudit()}
      <div class="dev-footer">© 2026 DISS — All Rights Reserved &nbsp;|&nbsp; Powered by Tataheer Business Group &nbsp;|&nbsp; +923218555566</div>
      <script>window.onload=function(){window.print();}<\/script>
    </body></html>`);
    win.document.close();
  };

  const printFees = () => {
    const rows = status.map((r,i) => { const disc=getStuEffectiveDisc(r.stu, payments, vm, vy, classFees); const netDue=Math.max(0,Number(r.due)-disc); return `<tr><td>${i+1}</td><td><b>${r.stu.name}</b></td><td>${r.stu.father||'—'}</td><td>${r.stu.cls}</td><td>${r.stu.roll}</td><td>Rs. ${netDue.toLocaleString()}${disc>0?` <small style="color:#dc2626">(disc Rs.${disc.toLocaleString()})</small>`:''}</td><td><span class="badge ${r.pay?'b-green':'b-red'}">${r.pay?'Paid Rs.'+Number(r.pay.amount).toLocaleString():'Unpaid'}</span></td></tr>`; }).join('');
    const paid = status.filter(r=>r.pay).length;
    printPage(`Fee Status — ${MONTHS[vm]} ${vy}`, `
      <h2>Fee Status — ${MONTHS[vm]} ${vy}</h2>
      <div class="summary">
        <div class="sum-card"><div class="val">${paid}</div><div class="lbl">Paid</div></div>
        <div class="sum-card"><div class="val">${status.length-paid}</div><div class="lbl">Unpaid</div></div>
        <div class="sum-card"><div class="val">Rs. ${status.filter(r=>r.pay).reduce((s,r)=>s+Number(r.pay.amount),0).toLocaleString()}</div><div class="lbl">Total Collected</div></div>
      </div>
      <table><thead><tr><th>#</th><th>Student</th><th>Father</th><th>Class</th><th>Roll</th><th>Monthly Fee</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody></table>`);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-xl font-bold text-gray-800">Student Ledger</h2>
        <Btn variant="outline" onClick={printFees}>🖨️ Print</Btn>
      </div>

      <div className="flex gap-1 bg-gray-100 p-1 rounded-xl w-fit mb-5">
        {/* 'config' tab removed — Fee Structure panel has been hard-deleted.
            Class fees are now driven exclusively by per-student monthlyFee on the
            student record, configured via Family Edit modal. */}
        {[['status','Fee Status'], ['history','History'], ['statement','Statement']].map(([k,l]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${tab === k ? 'bg-white shadow text-blue-700' : 'text-gray-500 hover:text-gray-700'}`}>
            {l}
          </button>
        ))}
      </div>

      {/* ── Fee Status ── */}
      {tab === 'status' && (
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <select value={vm} onChange={e => setVm(Number(e.target.value))} className={inputCls + ' w-auto'}>
              {MONTHS.map((m,i) => <option key={i} value={i}>{m}</option>)}
            </select>
            <select value={vy} onChange={e => setVy(Number(e.target.value))} className={inputCls + ' w-auto'}>
              {years.map(y => <option key={y}>{y}</option>)}
            </select>
            <span className="text-sm font-semibold text-emerald-600">✓ {status.filter(r=>r.pay).length} Paid</span>
            <span className="text-sm font-semibold text-red-600">✗ {status.filter(r=>!r.pay).length} Unpaid</span>
          </div>

          {students.length === 0
            ? <Empty icon="💰" text="No students added yet. Add students first." />
            : (() => {
                // ── v73: All financial totals from Majma — zero inline reduces ──
                // Same buildFinancialSnapshot Dashboard + Fee Collection use.
                // Drift between this Ledger and the other pages is now
                // architecturally impossible.
                const lSnap            = buildFinancialSnapshot({ vm, vy, students, payments, classFees });
                const totalFeeDue      = lSnap.feeGross;          // ↔ Dashboard "Fee Gross"
                const totalDiscount    = lSnap.standingDisc;      // ↔ Dashboard "Discount" (standing per Global Engine)
                const totalNetDue      = lSnap.netFeeDue;         // ↔ Dashboard "Net Fee Due"
                const totalCollected   = lSnap.feeThisMonth;      // ↔ Dashboard "Fee Collected" (selected month)
                const totalAF          = lSnap.afThisMonth;       // ↔ Dashboard "AF Collected (month)"
                const totalBooksCol    = lSnap.booksThisMonth;    // ↔ Dashboard "Books Collected (month)"
                const grandCollected   = lSnap.incomeThisMonth;   // ↔ Dashboard "Total Recovery (month)"
                const totalOutstanding = lSnap.totalDue;          // ↔ Dashboard "Net Outstanding"
                const allTimeBalance   = lSnap.totalDue;          // identical — kept name for legacy JSX refs
                // ── v74: Register Student Ledger's bindings for cross-component drift check ──
                if (typeof window !== 'undefined' && window._DISS_DEBUG) {
                  window._DRIFT_REGISTRY = window._DRIFT_REGISTRY || {};
                  window._DRIFT_REGISTRY.StudentLedger = {
                    netFeeDue:  lSnap.netFeeDue,
                    totalDue:   lSnap.totalDue,
                    afExpected: lSnap.afExpected,
                    feeGross:   lSnap.feeGross,
                  };
                }
                return (
                  <>
                    {/* Summary bar */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
                      {/* Fee Collected */}
                      <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">
                        <p className="text-xs text-emerald-600 font-semibold uppercase mb-1">💰 Fee Collected</p>
                        <p className="text-lg font-extrabold text-emerald-700">Rs. {totalCollected.toLocaleString()}</p>
                        {totalAF > 0 && <p className="text-xs text-purple-500 mt-0.5">+ AF: Rs. {totalAF.toLocaleString()}</p>}
                        {totalBooksCol > 0 && <p className="text-xs text-amber-500 mt-0.5">+ Books: Rs. {totalBooksCol.toLocaleString()}</p>}
                        {(totalAF > 0 || totalBooksCol > 0) && <p className="text-xs font-bold text-emerald-700 mt-1">Grand: Rs. {grandCollected.toLocaleString()}</p>}
                      </div>
                      {/* Outstanding — Monthly + All-Time */}
                      <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3">
                        <p className="text-xs text-red-500 font-semibold uppercase mb-1">⚠️ This Month Unpaid</p>
                        <p className="text-lg font-extrabold text-red-600">Rs. {totalOutstanding.toLocaleString()}</p>
                        <p className="text-xs text-gray-500 mt-0.5">Fee Due: Rs. {totalNetDue.toLocaleString()}</p>
                        <p className="text-xs text-emerald-600 mt-0.5">− Collected: Rs. {totalCollected.toLocaleString()}</p>
                        {/* All-time balance — from global engine (matches Dashboard exactly) */}
                        <div className="border-t border-red-200 mt-2 pt-1.5">
                          <p className="text-xs text-orange-600 font-bold">📊 All-Time Balance Due:</p>
                          <p className="text-sm font-extrabold text-orange-700">Rs. {allTimeBalance.toLocaleString()}</p>
                          {/* v75.0: Registry-aware parity badge. Registry is only populated
                              when window._DISS_DEBUG is on, so in production we just show a
                              static "via Majma" assurance (no runtime drift comparison). */}
                          {(() => {
                            const reg = window._DRIFT_REGISTRY;
                            if (!reg || !reg.Dashboard || reg.Dashboard.totalDue === undefined) {
                              return <p className="text-xs text-gray-400">↔ via Majma</p>;
                            }
                            const matches = Math.abs(Number(reg.Dashboard.totalDue) - Number(allTimeBalance)) < 0.01;
                            return (
                              <p className={`text-xs ${matches ? 'text-emerald-600' : 'text-amber-600'}`}>
                                {matches ? '↔ mirrors Dashboard via Majma ✓' : '↔ DRIFT detected (debug mode)'}
                              </p>
                            );
                          })()}
                        </div>
                      </div>
                      {/* Grand Total Net Outstanding — UNIFIED with Dashboard Red Card via single Majma snapshot.
                          Headline = lSnap.totalDue (identical to snap.totalDue on the Dashboard).
                          Breakdown lines (Fee + AF + Books + OB) sum to the headline by engine identity. */}
                      <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3">
                        <p className="text-xs text-blue-500 font-semibold uppercase mb-1">📋 Grand Total Outstanding</p>
                        <p className="text-lg font-extrabold text-blue-700">Rs. {lSnap.totalDue.toLocaleString()}</p>
                        <p className="text-xs text-gray-500 mt-0.5">📋 Fee Due: Rs. {lSnap.outstandingFee.toLocaleString()}</p>
                        <p className="text-xs text-purple-500 mt-0.5">🏦 AF Due: Rs. {lSnap.outstandingAF.toLocaleString()}</p>
                        <p className="text-xs text-amber-500 mt-0.5">📚 Books Due: Rs. {lSnap.outstandingBks.toLocaleString()}</p>
                        <p className="text-xs text-orange-500 mt-0.5">📂 Opening Bal: Rs. {lSnap.obDue.toLocaleString()}</p>
                        <p className="text-[10px] text-gray-400 italic mt-1">↔ mirrors Dashboard via Majma</p>
                      </div>
                      {/* Collection Rate */}
                      <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
                        <p className="text-xs text-amber-600 font-semibold uppercase mb-1">📊 Collection Rate</p>
                        <p className="text-lg font-extrabold text-amber-700">
                          {totalNetDue > 0 ? Math.round((totalCollected / totalNetDue) * 100) : 0}%
                        </p>
                        <p className="text-xs text-emerald-600 mt-0.5">Paid: {status.filter(r=>r.pay).length} students</p>
                        <p className="text-xs text-red-400 mt-0.5">Unpaid: {status.filter(r=>!r.pay).length} students</p>
                        <p className="text-xs font-bold text-amber-700 mt-1">Total: {status.length} students</p>
                      </div>
                    </div>

                    <Card className="overflow-hidden">
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-gray-50 border-b">
                            <tr className="text-left text-xs text-gray-500 font-semibold uppercase">
                              <th className="px-4 py-3">Sr.</th>
                              <th className="px-4 py-3">Student</th>
                              <th className="px-4 py-3">Class</th>
                              <th className="px-4 py-3">Monthly Fee</th>
                              <th className="px-4 py-3 text-red-500">Discount</th>
                              <th className="px-4 py-3">Net Due</th>
                              <th className="px-4 py-3">Status</th>
                              <th className="px-4 py-3 text-right">Action</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-50">
                            {status.map(({ stu, pay, due, autoDisc }, idx) => {
                              // ── Global Engine identity: Net Due = (Class Fee − Discount) + Opening Balance ──
                              // Same formula used by Fee Collection Net Due column and Family Ledger.
                              const disc   = getStuEffectiveDisc(stu, payments, vm, vy, classFees);
                              const ob     = Number(stu.openingBalance || 0);
                              const monthlyNet = Math.max(0, Number(due) - disc);
                              const netDue = monthlyNet + ob;
                              return (
                              <tr key={stu.id} className="hover:bg-slate-50">
                                <td className="px-4 py-3 text-xs font-bold text-gray-400">{String(idx+1).padStart(2,'0')}</td>
                                <td className="px-4 py-3 font-semibold text-gray-800">{stu.name}</td>
                                <td className="px-4 py-3"><Badge color="blue">Class {stu.cls}</Badge></td>
                                <td className="px-4 py-3 text-gray-600">Rs. {Number(due).toLocaleString()}</td>
                                <td className="px-4 py-3">
                                  {disc > 0
                                    ? <span className="text-red-500 font-semibold text-xs bg-red-50 px-2 py-0.5 rounded-lg">- Rs. {disc.toLocaleString()}</span>
                                    : <span className="text-gray-300 text-xs">—</span>}
                                </td>
                                <td className="px-4 py-3">
                                  {Number(due) > 0 || ob !== 0
                                    ? <div>
                                        <span className={`font-bold ${disc > 0 || ob !== 0 ? 'text-emerald-700' : 'text-gray-700'}`}>
                                          {netDue < 0 ? `+Rs. ${Math.abs(netDue).toLocaleString()}` : `Rs. ${netDue.toLocaleString()}`}
                                        </span>
                                        {ob > 0 && (
                                          <div className="text-xs text-gray-500 font-medium mt-0.5">
                                            Rs. {monthlyNet.toLocaleString()} <span className="text-amber-600">+ Rs. {ob.toLocaleString()} prev</span>
                                          </div>
                                        )}
                                        {ob < 0 && (
                                          <div className="text-xs text-gray-500 font-medium mt-0.5">
                                            Rs. {monthlyNet.toLocaleString()} <span className="text-emerald-600">− Rs. {Math.abs(ob).toLocaleString()} advance</span>
                                          </div>
                                        )}
                                      </div>
                                    : <span className="text-gray-300">—</span>}
                                </td>
                                <td className="px-4 py-3">
                                  {pay
                                    ? <Badge color="green">✓ Paid Rs. {Number(pay.amount).toLocaleString()}</Badge>
                                    : due > 0
                                      ? <Badge color="red">✗ Unpaid</Badge>
                                      : <Badge color="gray">Fee Not Set</Badge>}
                                </td>
                                <td className="px-4 py-3 text-right">
                                  {pay
                                    ? <Btn sm variant="outline" onClick={() => printReceipt(pay, stu)}>🖨️ Receipt</Btn>
                                    : <Btn sm onClick={() => { const ad=getStuDisc(stu, classFees); setPayMod(stu); setPf({ month: vm, year: vy, amount: '', discount: ad>0?String(ad):'', annualFund: '', note:'', paymentMethod:'Cash' }); }}>Record Payment</Btn>
                                  }
                                </td>
                              </tr>
                              );
                            })}
                          </tbody>
                          {/* ── Totals footer row ── */}
                          <tfoot className="bg-gray-100 border-t-2 border-gray-200">
                            <tr className="text-sm font-bold text-gray-700">
                              <td className="px-4 py-3" colSpan="2">Totals — {status.length} Students</td>
                              <td className="px-4 py-3">Rs. {totalFeeDue.toLocaleString()}</td>
                              <td className="px-4 py-3 text-red-500">{totalDiscount > 0 ? `- Rs. ${totalDiscount.toLocaleString()}` : '—'}</td>
                              <td className="px-4 py-3 text-blue-700">Rs. {totalNetDue.toLocaleString()}</td>
                              <td className="px-4 py-3">
                                <span className="text-emerald-700">✓ Rs. {totalCollected.toLocaleString()}</span>
                                {totalOutstanding > 0 && <span className="text-red-500 ml-2">⚠ Rs. {totalOutstanding.toLocaleString()}</span>}
                              </td>
                              <td className="px-4 py-3 text-right text-xs text-gray-400">{MONTHS[vm]} {vy}</td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    </Card>
                  </>
                );
              })()
          }
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════
          LEGACY FEE STRUCTURE PANEL — HARD-DELETED
          The white card containing per-class input boxes (Class Play Group
          Red, Blue, Nursery … Class 10) has been excised from the codebase.
          Base monthly rates are now governed solely by stu.monthlyFee on each
          student record, configured through the Family Edit modal in Students.
          The global fee engine (getStuDisc / getStuNetMonthlyDue /
          getStuOutstanding) remains the only legal operational calculator.
          ════════════════════════════════════════════════════════════════════ */}

      {/* ── Student History ── */}
      {tab === 'history' && (
        <div>
          <div className="mb-4">
            <select value={histStu} onChange={e => setHistStu(e.target.value)} className={inputCls + ' sm:w-80'}>
              <option value="">— Select a Student —</option>
              {students.map(s => <option key={s.id} value={s.id}>{s.name} (Class {s.cls}, Roll {s.roll})</option>)}
            </select>
          </div>

          {histStu && (
            <Card className="overflow-hidden">
              <div className="px-5 py-4 bg-blue-50 border-b border-blue-100">
                <p className="font-bold text-blue-900">{histStuObj?.name}</p>
                <p className="text-sm text-blue-600">Class {histStuObj?.cls} | Roll: {histStuObj?.roll}</p>
                <p className="text-sm text-blue-700 font-semibold mt-1">
                  Total Paid: Rs. {histPays.reduce((s,p)=>s+Number(p.amount),0).toLocaleString()}
                  <span className="font-normal text-blue-500 ml-2">({histPays.length} payments)</span>
                </p>
              </div>
              {histPays.length === 0
                ? <p className="text-center text-gray-400 py-8">No payment history for this student.</p>
                : <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 border-b">
                        <tr className="text-left text-xs text-gray-500 font-semibold uppercase">
                          <th className="px-4 py-3">Receipt No</th>
                          <th className="px-4 py-3">Month</th>
                          <th className="px-4 py-3">Amount</th>
                          <th className="px-4 py-3">Account Head</th>
                          <th className="px-4 py-3 hidden sm:table-cell">Date</th>
                          <th className="px-4 py-3 hidden sm:table-cell">Note</th>
                          <th className="px-4 py-3 text-right">Print</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {histPays.map(p => (
                          <tr key={p.id} className="hover:bg-slate-50">
                            <td className="px-4 py-3 font-mono text-xs text-gray-500">{p.rcpt}</td>
                            <td className="px-4 py-3 font-semibold">{MONTHS[p.month]} {p.year}</td>
                            <td className="px-4 py-3 font-bold text-emerald-700">Rs. {Number(p.amount).toLocaleString()}</td>
                            <td className="px-4 py-3"><Badge color={p.paymentMethod==='Bank Transfer'?'blue':p.paymentMethod==='JazzCash'||p.paymentMethod==='Easypaisa'?'purple':'green'}>{p.paymentMethod==='Cash'?'💵 Cash':p.paymentMethod==='Bank Transfer'?'🏦 Bank':p.paymentMethod==='JazzCash'?'📱 JazzCash':p.paymentMethod==='Easypaisa'?'📱 Easypaisa':p.paymentMethod||'💵 Cash'}</Badge></td>
                            <td className="px-4 py-3 text-gray-400 hidden sm:table-cell text-xs">{new Date(p.date).toLocaleDateString()}</td>
                            <td className="px-4 py-3 text-gray-400 hidden sm:table-cell text-xs">{p.note || '—'}</td>
                            <td className="px-4 py-3 text-right">
                              <Btn sm variant="outline" onClick={() => printReceipt(p, histStuObj)}>🖨️</Btn>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
              }
            </Card>
          )}
        </div>
      )}

      {/* ── Statement Tab (per-student date-range ledger, v75-9) ── */}
      {tab === 'statement' && (() => {
        const today = new Date().toISOString().slice(0, 10);
        const monthStart = (() => { const d=new Date(); d.setDate(1); return d.toISOString().slice(0,10); })();
        return <StudentStatement
          students={students}
          payments={payments}
          classFees={classFees}
          defaultFrom={monthStart}
          defaultTo={today}/>;
      })()}

      {/* ── Record Payment Modal ── */}
      {payMod && (() => {
        const pmCF      = Number(classFees[payMod.cls] || 0);
        const pmRate    = Number(payMod.monthlyFee || 0);
        const pmAutoD   = pmRate > 0 && pmRate < pmCF ? pmCF - pmRate : 0;
        const pmDisc    = Number(pf.discount || 0);
        const pmOB      = Number(payMod.openingBalance || 0);
        const pmNetFee  = Math.max(0, pmCF - (pmDisc || pmAutoD));
        const pmTotalDue = pmNetFee + pmOB;
        const pmAllTimePaid = payments.filter(p => p.stuId === payMod.id).reduce((s,p) => s + Number(p.amount), 0);
        const pmBal     = Math.max(0, pmTotalDue - pmAllTimePaid);
        const pmReceiving = Number(pf.amount || 0);
        const pmAfter   = pmTotalDue - pmAllTimePaid - pmReceiving;
        return (
        <Modal title={`Record Payment — ${payMod.name}`} onClose={() => setPayMod(null)}>
          {/* Student info header */}
          <div className="bg-blue-50 rounded-xl p-3 mb-4">
            <p className="font-bold text-blue-800">{payMod.name}</p>
            <p className="text-sm text-blue-600">Class {payMod.cls} | Roll: {payMod.roll}{payMod.family ? ` | ${payMod.family}` : ''}</p>
            {pmOB > 0 && (
              <div className="mt-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5 text-sm text-amber-700">
                📂 Opening Balance (prev dues): <strong>Rs. {pmOB.toLocaleString()}</strong>
              </div>
            )}
            <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
              <div className="bg-white rounded-lg px-3 py-1.5">
                <span className="text-gray-400 text-xs block">Total Due</span>
                <strong className="text-blue-700">Rs. {pmTotalDue.toLocaleString()}</strong>
                {pmOB > 0 && <span className="text-xs text-amber-500 block">incl. prev Rs. {pmOB.toLocaleString()}</span>}
              </div>
              <div className="bg-white rounded-lg px-3 py-1.5">
                <span className="text-gray-400 text-xs block">All-Time Paid</span>
                <strong className="text-emerald-700">Rs. {pmAllTimePaid.toLocaleString()}</strong>
              </div>
              <div className="bg-white rounded-lg px-3 py-1.5 col-span-2">
                <span className="text-gray-400 text-xs block">Balance Remaining</span>
                <strong className={pmBal > 0 ? 'text-red-600' : 'text-emerald-700'}>Rs. {pmBal.toLocaleString()}</strong>
              </div>
            </div>
          </div>
          <div className="flex gap-2 mb-1">
            <div className="flex-1">
              <Sel label="Month *" value={pf.month} onChange={e => setPf({...pf, month: Number(e.target.value)})}
                options={MONTHS.map((m,i) => ({v:i, l:m}))}/>
            </div>
            <div style={{width:90}}>
              <Sel label="Year" value={pf.year} onChange={e => setPf({...pf, year: Number(e.target.value)})}
                options={years.map(y => ({v:y, l:String(y)}))}/>
            </div>
          </div>
          <Inp label="Amount Received (Rs.) *" type="number" min="1" value={pf.amount} onChange={e => setPf({...pf, amount: e.target.value})} placeholder="Enter amount received now"/>
          <Inp label="Discount (Rs.)" type="number" min="0" value={pf.discount} onChange={e => setPf({...pf, discount: e.target.value})} placeholder="0 if no discount"/>
          {(pmDisc > 0 || pmOB > 0 || pmReceiving > 0) && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-3 text-sm">
              <div className="flex justify-between text-gray-600 mb-1"><span>Class Fee:</span><span className="font-semibold">Rs. {pmCF.toLocaleString()}</span></div>
              {pmDisc > 0 && <div className="flex justify-between text-red-600 mb-1"><span>Discount:</span><span className="font-semibold">− Rs. {pmDisc.toLocaleString()}</span></div>}
              {pmDisc > 0 && <div className="flex justify-between text-blue-700 font-semibold mb-1"><span>Monthly Net Fee:</span><span>Rs. {Math.max(0, pmCF - pmDisc).toLocaleString()}</span></div>}
              {pmOB > 0 && <div className="flex justify-between text-amber-700 font-semibold mb-1"><span>Opening Balance (prev dues):</span><span>+ Rs. {pmOB.toLocaleString()}</span></div>}
              <div className="flex justify-between text-blue-800 font-bold border-t border-amber-300 pt-1 mb-1"><span>Total Net Due:</span><span>Rs. {pmTotalDue.toLocaleString()}</span></div>
              {pmAllTimePaid > 0 && <div className="flex justify-between text-emerald-700 mb-1"><span>Already Paid (all-time):</span><span className="font-semibold">− Rs. {pmAllTimePaid.toLocaleString()}</span></div>}
              {pmReceiving > 0 && <div className="flex justify-between text-gray-600 mb-1"><span>Receiving Now:</span><span className="font-semibold">− Rs. {pmReceiving.toLocaleString()}</span></div>}
              {pmReceiving > 0 && <div className={`flex justify-between font-bold border-t border-amber-300 pt-1 ${pmAfter > 0 ? 'text-red-600' : pmAfter < 0 ? 'text-emerald-700' : 'text-gray-500'}`}>
                <span>{pmAfter > 0 ? '⚠️ Balance Remaining:' : pmAfter < 0 ? '✅ Advance:' : '✅ Fully Cleared'}</span>
                <span>Rs. {Math.abs(pmAfter).toLocaleString()}</span>
              </div>}
            </div>
          )}
          {/* ── AF HEAD STATUS — Single Source: payMod.annualFund (Students module) ── */}
          {payMod && (() => {
            const expAF  = Number(payMod.annualFund || 0);
            const paidAF = payments.filter(p => p.stuId === payMod.id).reduce((s, p) => s + Number(p.annualFund || 0), 0);
            const remAF  = Math.max(0, expAF - paidAF);
            const entered= Number(pf.annualFund || 0);
            const exceed = entered > remAF;
            if (expAF <= 0) return null;
            return (
              <div className={`rounded-xl p-2.5 mb-2 text-xs border ${exceed ? 'bg-red-50 border-red-300' : 'bg-purple-50 border-purple-200'}`}>
                <div className="flex justify-between"><span className="text-gray-600">🏦 AF Expected (from Student record):</span><span className="font-semibold">Rs. {expAF.toLocaleString()}</span></div>
                <div className="flex justify-between"><span className="text-gray-600">✅ AF Already Paid:</span><span className="font-semibold text-emerald-700">Rs. {paidAF.toLocaleString()}</span></div>
                <div className="flex justify-between border-t border-purple-200 pt-1 mt-1"><span className="font-bold text-purple-800">AF Remaining (max allowed):</span><span className="font-extrabold text-purple-900">Rs. {remAF.toLocaleString()}</span></div>
                {exceed && (
                  <div className="mt-1.5 text-red-700 font-semibold text-[11px] leading-snug">
                    ⚠️ AF exceeds remaining. Extra money should go to "Amount Received" field (it will clear Opening Balance). AF cap: Rs. {remAF.toLocaleString()}.
                  </div>
                )}
              </div>
            );
          })()}
          <Inp label="Annual Fund (Rs.)" type="number" min="0" value={pf.annualFund} onChange={e => setPf({...pf, annualFund: e.target.value})} placeholder="0 if not applicable"/>
          <Inp label="Note (optional)" value={pf.note} onChange={e => setPf({...pf, note: e.target.value})} placeholder="e.g. Partial payment / late fee"/>
          <div className="mb-3">
            <label className="block text-xs font-semibold text-gray-500 mb-1 uppercase tracking-wide">Payment Method *</label>
            <div className="flex flex-wrap gap-2">
              {PAYMENT_METHODS.map(m => (
                <label key={m} className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border-2 cursor-pointer text-sm font-semibold transition-all ${pf.paymentMethod===m?'border-blue-500 bg-blue-50 text-blue-700':'border-gray-200 text-gray-500 hover:border-gray-300'}`}>
                  <input type="radio" name="pfMethod" value={m} checked={pf.paymentMethod===m} onChange={()=>setPf({...pf,paymentMethod:m})} className="hidden"/>
                  {m==='Cash'?'💵':m==='Bank Transfer'?'🏦':m==='JazzCash'?'📱':'💳'} {m}
                </label>
              ))}
            </div>
          </div>
          <div className="bg-emerald-50 rounded-xl p-3 mb-3 flex justify-between items-center">
            <span className="font-bold text-emerald-800">Collecting Now:</span>
            <span className="text-xl font-extrabold text-emerald-700">Rs. {(pmReceiving + Number(pf.annualFund||0)).toLocaleString()}</span>
          </div>
          <div className="flex gap-2 mt-2">
            <Btn full variant="green" onClick={recordPayment}>✅ Save & Print Receipt</Btn>
            <Btn variant="outline" onClick={() => setPayMod(null)}>Cancel</Btn>
          </div>
        </Modal>
        );
      })()}

      {/* ── Auto-print receipt after recording ── */}
      {receipt && (() => {
        const { pay, stu } = receipt;
        return (
          <Modal title="Payment Recorded!" onClose={() => setReceipt(null)}>
            <div className="text-center mb-4">
              <div className="text-5xl mb-2">✅</div>
              <p className="font-bold text-emerald-700 text-lg">Payment Saved</p>
              <p className="text-gray-500 text-sm mt-1">{stu.name} — {MONTHS[pay.month]} {pay.year}</p>
              <p className="text-2xl font-bold text-gray-800 mt-2">Rs. {Number(pay.amount).toLocaleString()}</p>
              <p className="text-xs text-gray-400 mt-1 font-mono">{pay.rcpt}</p>
            </div>
            <div className="flex gap-2">
              <Btn full variant="blue" onClick={() => { printReceipt(pay, stu); setReceipt(null); }}>🖨️ Print Receipt</Btn>
              <Btn full variant="outline" onClick={() => setReceipt(null)}>Close</Btn>
            </div>
          </Modal>
        );
      })()}
    </div>
  );
}

// ── FEE COLLECTION (Dedicated Fee Receiving Module) ──────────────────────────
function FeeCollection() {
  const { role, username, name: userName } = React.useContext(UserContext);
  const isAdmin     = role === 'admin';
  const isPrincipal = role === 'principal';
  const { staffCanModify } = React.useContext(PermContext);
  // ── v73: LIVE READS (no more mount snapshots — auto-aligned with SyncContext) ─
  // Per Architectural Standardization rule: students/classFees/payments are
  // re-evaluated each render. Any K.STU / K.CF / K.PAY update propagates
  // instantly without needing a remount. payments still has a setter for
  // local instant feedback (mirrors S.set writes for sub-second UI response).
  const students     = getActiveList(K.STU);
  const classFees    = S.get(K.CF, {});
  const [payments, setPayments] = useState(() => getActiveList(K.PAY));
  const [search, setSearch] = useState('');
  const [fcls, setFcls]     = useState('All');
  const [collMod, setCollMod] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [vm, setVm] = useState(NOW.getMonth());
  const [vy, setVy] = useState(NOW.getFullYear());
  const [tab, setTab] = useState('collect');
  // Family Payment tab — local search + status filter (Master Design polish)
  const [famSearch, setFamSearch] = useState('');
  const [famStatusFilter, setFamStatusFilter] = useState('all'); // 'all' | 'due' | 'cleared'
  const [ledgerStu, setLedgerStu] = useState('');
  const [cf, setCf] = useState({ month: NOW.getMonth(), year: NOW.getFullYear(), feeAmount: '', discount: '', annualFund: '', note: '', paymentMethod: 'Cash' });
  const years = Array.from({ length: 5 }, (_, i) => NOW.getFullYear() - 2 + i);
  // ── Edit / Delete Payment ──
  const [editPayMod, setEditPayMod] = useState(null);
  const [delPayConf, setDelPayConf] = useState(null);
  const [epf, setEpf] = useState({ amount: '', discount: '', annualFund: '', note: '', paymentMethod: 'Cash' });
  // ── Admin PIN Override ──
  const [pinOverride, setPinOverride] = useState(null); // { action: 'edit'|'delete', pay, stu }
  const [pinInput, setPinInput] = useState('');
  // ── Family Split Payment ──
  const [familyMod, setFamilyMod]   = useState(null);
  const [familyForm, setFamilyForm] = useState({ totalAmount: '', paymentMethod: 'Cash', month: NOW.getMonth(), year: NOW.getFullYear(), note: '' });
  const [familySearch, setFamilySearch] = useState('');

  const printFamilyLedger = (familyKey, siblings) => {
    const allPays = S.get(K.PAY, []);
    // ── June 2026 Fresh-Start Cutoff applied to Family Ledger report ──
    // Pre-June 2026 payments AND pre-June opening balances must NOT appear here.
    // Uses the same ENGINE_CUTOFF constants as every other module — single rule.
    const rows = siblings.map(stu => {
      const due  = Number(classFees[stu.cls] || 0);
      // Filter K.PAY to post-cutoff payments only — May 2026 and earlier vanish
      const stuPays = allPays
        .filter(p => p.stuId === stu.id)
        .filter(p => Number(p.year) > ENGINE_CUTOFF_YEAR || (Number(p.year) === ENGINE_CUTOFF_YEAR && Number(p.month) >= ENGINE_CUTOFF_MONTH))
        .sort((a,b) => a.year !== b.year ? a.year-b.year : a.month-b.month);
      const totalPaid = stuPays.reduce((s,p) => s+Number(p.amount||0), 0);
      // Opening balance hidden per fresh-start policy (treated as pre-June carry-forward, zeroed)
      const ob   = 0;
      const netDue = getStuNetMonthlyDue(stu, classFees);
      const outstanding = Math.max(0, netDue + ob - totalPaid);
      // ── Effective discount per payment row ──
      // Combines: (a) recorded p.discount from the payment AND
      //           (b) auto/class-fee adjustment (getStuDisc) AND
      //           (c) sibling discount (stu.siblingDiscount)
      // Result: discount column NEVER shows "—" when the student actually has any
      // standing monthly discount, fixing the long-standing display gap.
      // ── Global Engine: single discount = Class Fee − Monthly Fee ──
      // siblingDiscount field is a mirror only (record-keeping), NEVER additive.
      const standingMonthly = Number(getStuDisc(stu, classFees) || 0);
      const payRows = stuPays.map(p => {
        const payDisc = Number(p.discount || 0);
        // Display rule: show the LARGER of (recorded payment discount, standing monthly discount)
        // so the column reflects the real economic benefit per month, not just the explicit field.
        const effDisc = Math.max(payDisc, standingMonthly);
        const discCell = effDisc > 0
          ? 'Rs. ' + effDisc.toLocaleString() + (standingMonthly > 0 && payDisc === 0 ? ' <small style="color:#9ca3af">(auto)</small>' : '')
          : '—';
        return `<tr><td>${MONTHS[p.month]} ${p.year}</td><td>${p.rcpt||'—'}</td><td>Rs. ${Number(p.amount).toLocaleString()}</td><td>${discCell}</td><td>${p.annualFund>0?'Rs. '+Number(p.annualFund).toLocaleString():'—'}</td><td>${p.paymentMethod||'Cash'}</td></tr>`;
      }).join('');
      // Header chip indicating the student's standing monthly discount (if any)
      const standingChip = standingMonthly > 0
        ? ` <span style="color:#d97706;font-weight:600;font-size:11px">· Standing monthly discount: Rs. ${standingMonthly.toLocaleString()}</span>`
        : '';
      return `<tr style="background:#f8fafc"><td colspan="6" style="font-weight:700;padding:8px 6px;border-top:2px solid #e2e8f0">
        ${stu.name} — Class ${stu.cls} | Roll: ${stu.roll}${standingChip}
      </td></tr>
      <tr style="font-size:11px;color:#64748b;background:#f1f5f9"><td>Month</td><td>Receipt</td><td>Paid</td><td>Discount</td><td>Annual Fund</td><td>Method</td></tr>
      ${payRows || '<tr><td colspan="6" style="color:#94a3b8;font-style:italic;padding:4px 6px">No payments recorded since June 2026</td></tr>'}
      <tr style="background:#ecfdf5"><td colspan="2" style="font-weight:700;padding:6px">Total Paid</td><td style="font-weight:700;color:#059669">Rs. ${totalPaid.toLocaleString()}</td><td></td><td colspan="2" style="font-weight:700;color:${outstanding>0?'#dc2626':'#059669'}">Balance: Rs. ${outstanding.toLocaleString()}</td></tr>`;
    }).join('');
    printPage(`Family Ledger — ${familyKey}`, `
      <h2 style="margin-bottom:4px">Family Ledger — ${familyKey}</h2>
      <p style="font-size:12px;color:#64748b;margin-bottom:12px">Printed: ${NOW.toLocaleDateString('en-PK',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}</p>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="background:#1e3a8a;color:white">
          <th style="padding:6px">Month</th><th>Receipt</th><th>Paid</th><th>Discount</th><th>Annual Fund</th><th>Method</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`);
  };

  // Aggregate all payments per student for the selected month — supports multiple (partial) payments
  const paidMap = useMemo(() => {
    const map = {};
    payments.filter(p => p.month === vm && p.year === vy).forEach(p => {
      if (!map[p.stuId]) map[p.stuId] = { pays: [], total: 0, totalAF: 0, totalDisc: 0 };
      map[p.stuId].pays.push(p);
      map[p.stuId].total    += Number(p.amount || 0);
      map[p.stuId].totalAF  += Number(p.annualFund || 0);
      map[p.stuId].totalDisc += Number(p.discount || 0);
    });
    return map;
  }, [payments, vm, vy]);

  // ── Global Engine: buildPaidMaps — single source of truth (replaces manual map) ──
  const allTimePaidMapFC = useMemo(() => buildPaidMapsFromCutoff(payments), [payments]);

  const getStatus = (stu) => {
    const due  = Number(classFees[stu.cls] || 0);
    const info = paidMap[stu.id];
    const paid = info ? info.total : 0;
    if (paid <= 0) return 'unpaid';
    // Net due = class fee − discounts + opening balance carry-forward
    // monthlyFee = student's personal rate; discount = classFee - monthlyFee
    const autoDisc     = getStuDisc(stu, classFees);
    const totalDisc    = info ? info.totalDisc : autoDisc;
    const openingBal   = Number(stu.openingBalance || 0);
    const netDue       = Math.max(0, due - totalDisc) + openingBal;
    if (netDue > 0 && paid < netDue) return 'partial';
    return 'paid';
  };

  const filtered = useMemo(() =>
    students.filter(s => {
      const q = search.toLowerCase();
      return (s.name.toLowerCase().includes(q) || s.roll.includes(q) || (s.father||'').toLowerCase().includes(q)) &&
             (fcls === 'All' || s.cls === fcls);
    }), [students, search, fcls]);

  // Discount applies to CLASS FEE → student net fee = classFee - discount
  // Opening balance = prior dues, added on top of monthly net fee
  // Total real due = studentNetFee + openingBalance
  // Balance = totalRealDue - amountAlreadyPaid
  const classDueForModal  = () => Number(classFees[collMod?.stu?.cls] || 0);
  const openingBalModal   = () => Number(collMod?.stu?.openingBalance || 0);
  const studentNetFee     = () => Math.max(0, classDueForModal() - Number(cf.discount||0));
  const totalRealDue      = () => studentNetFee() + openingBalModal();
  const alreadyPaidModal  = () => Number(collMod?.alreadyPaid || 0);
  const realTimeBalance   = () => Math.max(0, totalRealDue() - alreadyPaidModal());
  const netPayable        = () => Number(cf.feeAmount || 0); // actual money being collected now

  const openCollect = (stu) => {
    const due         = Number(classFees[stu.cls] || 0);
    const openingBal  = Number(stu.openingBalance || 0);
    const alreadyPaid = paidMap[stu.id]?.total || 0;
    // Auto discount: monthlyFee = student's personal rate; discount = classFee - monthlyFee
    const autoDisc    = getStuDisc(stu, classFees);
    const netMonthly  = getStuNetMonthlyDue(stu, classFees); // student's monthly net fee
    const totalDue    = netMonthly + openingBal;      // total owed including prior balance
    const balance     = Math.max(0, totalDue - alreadyPaid);
    setCollMod({ stu, alreadyPaid, balance, openingBal, totalDue });
    // STRICT RECOVERY RULE: annualFund starts EMPTY (not '0') — admin must
    // explicitly type a value. Excess money beyond Net Monthly Fee is applied
    // to Opening Balance by the engine, NEVER to Annual Fund or Books.
    setCf({ month: vm, year: vy, feeAmount: '', discount: autoDisc > 0 ? String(autoDisc) : '', annualFund: '', note: '', paymentMethod: 'Cash' });
  };

  const collectFee = () => {
    const fee  = Number(cf.feeAmount || 0);
    const disc = Number(cf.discount || 0);
    const due  = Number(classFees[collMod.stu.cls] || 0);
    if (fee <= 0) return alert('Enter a valid amount received.');
    if (disc > due) return alert('Discount cannot exceed the class fee.');
    // Single-write pipeline via processFeeTransaction (Phase 2).
    // classFee preserved on the record so the existing receipt printer still works.
    const result = processFeeTransaction({
      familyId:      collMod.stu.familyId || '',
      paymentMethod: cf.paymentMethod || 'Cash',
      date:          new Date().toISOString(),
      note:          cf.note,
      source:        'individual',
      studentTransactions: [{
        stuId:      collMod.stu.id,
        stuName:    collMod.stu.name,
        amount:     fee,
        discount:   disc,
        classFee:   due,
        annualFund: Number(cf.annualFund || 0),
        month:      Number(cf.month),
        year:       Number(cf.year),
      }],
    });
    if (!result.ok) { alert('Save failed: ' + (result.error || 'unknown')); return; }
    setPayments(S.get(K.PAY, []));
    setReceipt({ pay: result.pays[0], stu: collMod.stu });
    setCollMod(null);
  };

  const printReceipt = (pay, stu) => {
    const payDisc  = Number(pay.discount||0);     // explicit discount on this payment record
    const received = Number(pay.amount);          // actual money received
    const af       = Number(pay.annualFund||0);
    // ── Live class fee + standing monthly discount (auto + sibling) from K.STU/K.CF ──
    // Even if pay.discount = 0 (e.g. family-split entry), we still show the student's
    // STANDING discount that's already baked into their monthly rate.
    const liveClassFee = Number(classFees[stu.cls] || 0);
    // ── Global Engine: single discount = Class Fee − Monthly Fee ──
    // siblingDiscount is a mirror only, NEVER additive.
    const standingDisc = Number(getStuDisc(stu, classFees) || 0);
    const effDisc      = Math.max(payDisc, standingDisc);                  // shown on receipt
    // Class fee: prefer live K.CF (current truth); fall back to stored or computed
    const origFee  = liveClassFee > 0 ? liveClassFee : (Number(pay.classFee||0) || (received + payDisc));
    const net      = Math.max(0, origFee - effDisc); // student net fee after standing+explicit discount
    const balAmt   = net - received; // positive = still owes, negative = advance
    const isFullyPaid = balAmt <= 0;
    const win = window.open('', '_blank', 'width=420,height=680');
    if (!win) { alert('Popup blocked! Please allow popups for this site to print.'); return; }
    win.document.write(`<!DOCTYPE html><html><head><title>Fee Receipt</title>
      <style>
        body{font-family:'Segoe UI',Arial,sans-serif;padding:26px;max-width:380px;margin:0 auto;color:#1a1a1a;position:relative}
        .logo-hdr{text-align:center;margin-bottom:10px;padding-bottom:10px;border-bottom:2px solid #c0392b}
        .logo-hdr img{height:60px;object-fit:contain}
        h2{text-align:center;color:#c0392b;margin:6px 0 2px;font-size:16px;font-weight:800;letter-spacing:1px}
        .divider{border:none;border-top:1px dashed #d1d5db;margin:10px 0}
        .grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}
        .label{font-size:10px;color:#6b7280;margin-bottom:2px;text-transform:uppercase}
        .value{font-size:12px;font-weight:600}
        .fee-row{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid #f3f4f6;font-size:12px}
        .disc-row{display:flex;justify-content:space-between;padding:5px 0;font-size:12px;color:#dc2626;font-weight:600}
        .net-row{display:flex;justify-content:space-between;padding:5px 0;font-size:12px;font-weight:700;border-top:1px solid #e5e7eb}
        .disc-badge{background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:5px 12px;font-size:11px;color:#dc2626;font-weight:700;text-align:center;margin:8px 0}
        .total{display:flex;justify-content:space-between;align-items:center;background:#f0fdf4;padding:10px 14px;border-radius:8px;margin:10px 0}
        .total-label{font-size:13px;font-weight:700;color:#15803d}
        .total-val{font-size:22px;font-weight:800;color:#15803d}
        .footer{text-align:center;font-size:10px;color:#9ca3af;margin-top:10px}
        .dev-footer{text-align:center;margin-top:12px;padding-top:8px;border-top:1px solid #e5e7eb;font-size:8px;color:#9ca3af;letter-spacing:.3px}
        .paid-stamp{position:fixed;top:55%;right:20px;transform:translateY(-50%) rotate(-22deg);border:5px solid #15803d;color:#15803d;font-size:42px;font-weight:900;padding:6px 18px;border-radius:8px;opacity:0.20;letter-spacing:6px;pointer-events:none;user-select:none}
        @media print{body{padding:10px}button{display:none!important}.paid-stamp{position:fixed;top:55%;right:20px}}
      </style></head><body>
      ${isFullyPaid ? '<div class="paid-stamp">PAID</div>' : ''}
      <div class="logo-hdr"><img src="${LOGO_SRC}" alt="DISS" onerror="this.style.display='none'"/></div>
      <h2>FEE RECEIPT</h2>
      <hr class="divider"/>
      <div class="grid">
        <div><div class="label">Receipt No</div><div class="value">${pay.rcpt}</div></div>
        <div><div class="label">Date</div><div class="value">${new Date(pay.date).toLocaleDateString('en-PK')}</div></div>
        <div><div class="label">Student Name</div><div class="value">${stu.name}</div></div>
        <div><div class="label">Father's Name</div><div class="value">${stu.father||'—'}</div></div>
        <div><div class="label">Class</div><div class="value">${stu.cls}</div></div>
        <div><div class="label">Roll Number</div><div class="value">${stu.roll}</div></div>
        <div><div class="label">Fee Month</div><div class="value">${MONTHS[pay.month]} ${pay.year}</div></div>
        <div><div class="label">Payment Method</div><div class="value">${pay.paymentMethod||'Cash'}</div></div>
        ${stu.family ? `<div><div class="label">Family</div><div class="value">${stu.family}</div></div>` : ''}
        <div><div class="label">Collected By</div><div class="value" style="color:#1e40af;font-weight:700">${pay.createdByName || '—'}</div></div>
      </div>
      <hr class="divider"/>
      <div class="fee-row"><span>Class Fee</span><span>Rs. ${origFee.toLocaleString()}</span></div>
      ${effDisc > 0 ? `<div class="disc-row"><span>Discount${standingDisc > 0 && payDisc === 0 ? ' (standing)' : ''}</span><span>- Rs. ${effDisc.toLocaleString()}</span></div>` : ''}
      ${effDisc > 0 ? `<div class="net-row"><span>Student Net Fee</span><span>Rs. ${net.toLocaleString()}</span></div>` : ''}
      <div class="fee-row"><span>Amount Received</span><span>Rs. ${received.toLocaleString()}</span></div>
      ${af > 0 ? `<div class="fee-row"><span>Annual Fund</span><span>Rs. ${af.toLocaleString()}</span></div>` : ''}
      ${effDisc > 0 ? `<div class="disc-badge">✓ Discount Applied: Rs. ${effDisc.toLocaleString()}${standingDisc > 0 && payDisc === 0 ? ' (auto/sibling)' : ''}</div>` : ''}
      ${balAmt > 0 ? `<div class="disc-row" style="color:#dc2626"><span>Balance Remaining</span><span>Rs. ${balAmt.toLocaleString()}</span></div>` : ''}
      ${balAmt < 0 ? `<div class="net-row" style="color:#059669"><span>Advance Paid</span><span>Rs. ${Math.abs(balAmt).toLocaleString()}</span></div>` : ''}
      <div class="total">
        <span class="total-label">Total Collected</span>
        <span class="total-val">Rs. ${(received + af).toLocaleString()}</span>
      </div>
      ${(() => { const _n = cleanNoteForReceipt(pay.note); return _n ? `<p style="font-size:11px;color:#6b7280;margin-top:4px">Note: ${_n}</p>` : ''; })()}
      <hr class="divider"/>
      <div style="text-align:center;margin:10px 0">
        <p style="font-size:13px;color:#15803d;font-weight:700;margin:0 0 2px">🙏 Thank You for Your Payment!</p>
        <p style="font-size:10px;color:#6b7280;font-style:italic;margin:0">May your generosity be rewarded — keep growing with DISS.</p>
      </div>
      ${getPrintAudit()}
      <div class="dev-footer">© 2026 DISS — All Rights Reserved &nbsp;|&nbsp; Powered by Tataheer Business Group &nbsp;|&nbsp; +923218555566</div>
      <script>window.onload=function(){window.print();}<\/script>
    </body></html>`);
    win.document.close();
  };

  // ── MAJMA Mirror — FC reads from the SAME unified engine the Dashboard uses ─
  // Per owner directive (v72/v73): Dashboard and Fee Collection MUST consume
  // from buildFinancialSnapshot only. No independent reductions. Drift is now
  // mathematically impossible: change any rule once in buildFinancialSnapshot
  // and BOTH pages update in lock-step.
  const fcSnap         = buildFinancialSnapshot({ vm, vy, students, payments, classFees });
  const netDueTotal    = fcSnap.netFeeDue;      // ↔ Dashboard "Net Fee Due"
  const feeTarget      = fcSnap.feeGross;       // ↔ Dashboard "Fee Gross"
  const totalBalanceDue= fcSnap.totalDue;       // ↔ Dashboard "Total Balance Due"
  // ── v74: Register FC's displayed snap values for cross-component drift check ──
  if (typeof window !== 'undefined' && window._DISS_DEBUG) {
    window._DRIFT_REGISTRY = window._DRIFT_REGISTRY || {};
    window._DRIFT_REGISTRY.FeeCollection = {
      netFeeDue:  fcSnap.netFeeDue,
      totalDue:   fcSnap.totalDue,
      feeGross:   fcSnap.feeGross,
    };
  }
  // ── v73: collectedAmt + totalDiscount now from Majma (zero inline reduce) ──
  const collectedAmt  = fcSnap.feeThisMonth;    // ↔ Dashboard "Fee Collected"
  const totalDiscount = fcSnap.standingDisc;    // ↔ Dashboard "Discount"
  const fullPaidCount = students.filter(s => getStatus(s) === 'paid').length;
  const partialCount  = students.filter(s => getStatus(s) === 'partial').length;
  const unpaidCount   = students.filter(s => getStatus(s) === 'unpaid').length;

  // Ledger: all-time payment history per student (or selected student)
  const ledgerStudents = ledgerStu ? students.filter(s => s.id === ledgerStu) : students;
  const stuPayMap = useMemo(() => {
    const map = {};
    payments.forEach(p => {
      if (!map[p.stuId]) map[p.stuId] = [];
      map[p.stuId].push(p);
    });
    return map;
  }, [payments]);

  // ── Family Groups (same family field OR same father name) ──
  const familyGroups = useMemo(() => {
    // Grouping priority: familyId (canonical) > family name > father name > stuId (singleton).
    // ── Option A: exclude "left" students entirely from Family Payment view.
    //    A family with ALL siblings left is hidden — no ghost cards. Left students
    //    remain in the database + Students page (History/Statement still shows them).
    const activeOnly = students.filter(isActiveStu);
    const groups = {};
    const meta = {}; // per-group display metadata: { familyId, familyName, fatherName }
    activeOnly.forEach(st => {
      let key;
      if (st.familyId && String(st.familyId).trim()) key = 'FID:' + String(st.familyId).trim();
      else if (st.family && st.family.trim())       key = 'FAM:' + st.family.trim();
      else if (st.father && st.father.trim())       key = 'FATH:' + st.father.trim();
      else                                          key = 'STU:' + st.id;
      if (!groups[key]) {
        groups[key] = [];
        meta[key] = {
          familyId:   st.familyId   ? String(st.familyId).trim() : '',
          familyName: st.family     ? st.family.trim()           : '',
          fatherName: st.father     ? st.father.trim()           : '',
        };
      }
      groups[key].push(st);
      // Promote richer metadata when a later student in the same group has it
      if (!meta[key].familyId && st.familyId) meta[key].familyId = String(st.familyId).trim();
      if (!meta[key].familyName && st.family) meta[key].familyName = st.family.trim();
      if (!meta[key].fatherName && st.father) meta[key].fatherName = st.father.trim();
    });
    // Return [key, siblings, meta] for the renderer — families with 0 active kids are gone
    return Object.entries(groups).map(([k, sibs]) => [k, sibs, meta[k]]);
  }, [students]);

  // ── Split Preview — equally distribute lump sum across siblings ──
  const splitPreview = useMemo(() => {
    if (!familyMod || !Number(familyForm.totalAmount)) return [];
    const total = Number(familyForm.totalAmount);
    // ── Single Engine: use getStuOutstanding for all-time outstanding per student ──
    const paidMaps = buildPaidMapsFromCutoff(payments);
    const data = familyMod.siblings.map(stu => {
      // ── Global Engine: getStuOutstanding (FULL — includes OB) ──
      const outstanding = parseFloat(getStuOutstanding(stu, classFees, paidMaps).toFixed(2));
      const due = Number(classFees[stu.cls] || 0);
      const paid = paidMaps.feeMap[stu.id] || 0;
      return { stu, due, paid, outstanding, allocate: 0 };
    });
    // Equal split with redistribution of excess
    let remaining = total;
    let unpaid = data.filter(r => r.outstanding > 0);
    while (remaining > 0 && unpaid.length > 0) {
      const share = Math.floor(remaining / unpaid.length);
      let redistributed = false;
      unpaid.forEach(r => {
        const give = Math.min(share || remaining, r.outstanding - r.allocate);
        r.allocate += give;
        remaining  -= give;
        if (give > 0) redistributed = true;
      });
      unpaid = data.filter(r => r.outstanding > r.allocate);
      if (!redistributed) break;
    }
    return data.map(r => ({ ...r, balAfter: r.outstanding - r.allocate }));
  }, [familyMod, familyForm.totalAmount, allTimePaidMapFC, classFees]);

  const isAccountant = role === 'accountant';
  const canCollect = isAdmin || staffCanModify || isPrincipal || isAccountant;
  // v75-8 owner rule: ONLY admin can edit/delete fee payments. Principal,
  // accountant, and staffCanModify no longer grant modify access.
  // (Add/collect is still open to canCollect — the rule is about edit/delete.)
  const canModify  = isAdmin;

  const checkPinThenDo = (action, pay, stu) => {
    if (canModify) {
      if (action === 'edit') { setEditPayMod({ pay, stu }); setEpf({ amount: String(Number(pay.amount)+Number(pay.discount||0)), discount: String(pay.discount||0), annualFund: String(pay.annualFund||0), note: pay.note||'', paymentMethod: pay.paymentMethod||'Cash' }); }
      else setDelPayConf({ pay, stu });
    } else {
      setPinOverride({ action, pay, stu }); setPinInput('');
    }
  };

  const verifyPin = () => {
    const savedPin = S.get(K.PERM, {}).adminPin || '5555';
    if (pinInput !== savedPin) return alert('❌ Incorrect PIN. Access denied.');
    const { action, pay, stu } = pinOverride;
    setPinOverride(null); setPinInput('');
    if (action === 'edit') { setEditPayMod({ pay, stu }); setEpf({ amount: String(Number(pay.amount)+Number(pay.discount||0)), discount: String(pay.discount||0), annualFund: String(pay.annualFund||0), note: pay.note||'', paymentMethod: pay.paymentMethod||'Cash' }); }
    else setDelPayConf({ pay, stu });
  };

  const openEditPay = (pay, stu) => checkPinThenDo('edit', pay, stu);

  const saveEditPay = () => {
    const fee  = Number(epf.amount || 0);
    const disc = Number(epf.discount || 0);
    if (fee <= 0) return alert('Enter a valid amount.');
    if (disc > fee) return alert('Discount cannot exceed the fee.');
    const net = Math.max(0, fee - disc);
    const oldPay = editPayMod.pay;
    const updated = payments.map(p => p.id === oldPay.id
      ? { ...p, amount: net, discount: disc, annualFund: Number(epf.annualFund||0), note: epf.note, paymentMethod: epf.paymentMethod }
      : p);
    logAudit(username, userName, 'EDIT', 'Fee Payment', { amount: oldPay.amount, discount: oldPay.discount, rcpt: oldPay.rcpt }, { amount: net, discount: disc, rcpt: oldPay.rcpt });
    S.set(K.PAY, updated); setPayments(updated); setEditPayMod(null);
  };
  const confirmDelPay = () => {
    const pay = delPayConf.pay;
    logAudit(username, userName, 'DELETE', 'Fee Payment', { amount: pay.amount, rcpt: pay.rcpt, stuId: pay.stuId }, {});
    // 1) Remove K.PAY record
    const updated = payments.filter(p => p.id !== pay.id);
    S.set(K.PAY, updated); setPayments(updated);
    // 2) Cascade-remove matching Cash Book entry — keeps Day Book in sync with Collected card.
    // Match by stuId tag in note + same date + same total (amount + AF + books).
    const payTotal = Number(pay.amount||0) + Number(pay.annualFund||0) + Number(pay.booksPaid||0);
    const payDate  = String(pay.date||'').slice(0,10);
    const allCb    = S.get(K.CBOOK, []);
    const cbMatch  = allCb.find(e => {
      if (e.type !== 'income' || e.refType !== 'fee') return false;
      const tag = (e.note||'').match(/\[stuId=([^\]]+)\]/);
      if (tag && tag[1] !== pay.stuId) return false;
      const eDate = String(e.date||'').slice(0,10);
      if (eDate !== payDate) return false;
      return Math.abs(Number(e.amount||0) - payTotal) < 0.01;
    });
    if (cbMatch) {
      S.set(K.CBOOK, allCb.filter(e => e.id !== cbMatch.id));
      logAudit(username, userName, 'DELETE_CASCADE', 'CashBook',
        { source: 'FeeCollection', payId: pay.id, cbId: cbMatch.id, amount: payTotal, stuId: pay.stuId },
        { reason: 'K.PAY deletion cascaded to CashBook to keep Day Book in sync' });
    }
    setDelPayConf(null);
  };

  const saveSplitPayment = () => {
    const total = Number(familyForm.totalAmount);
    if (!total || total <= 0) return alert('Please enter a valid total amount.');
    const toApply = splitPreview.filter(r => r.allocate > 0);
    if (!toApply.length) return alert('All siblings are fully paid. No outstanding balance to settle.');
    const ts = Date.now();
    // Route through the SINGLE interceptor — multi-student family split payload.
    // Each sibling's share is a separate studentTransaction, atomic write to K.PAY.
    const result = processFeeTransaction({
      familyId:      (familyMod && familyMod.familyId) || (familyMod && familyMod.familyKey) || '',
      paymentMethod: familyForm.paymentMethod || 'Cash',
      date:          new Date().toISOString(),
      note:          familyForm.note || 'Family split payment',
      source:        'family_split',
      studentTransactions: toApply.map((r, i) => ({
        stuId:   r.stu.id,
        stuName: r.stu.name,
        amount:  r.allocate,
        discount:   0,
        annualFund: 0,
        month:   Number(familyForm.month),
        year:    Number(familyForm.year),
        // Preserve family-split receipt numbering scheme (FAM-XXXXXX-N)
        rcpt:    'FAM-' + String(ts).slice(-6) + '-' + String(i + 1),
      })),
    });
    if (!result.ok) { alert('Family split save failed: ' + (result.error || 'unknown')); return; }
    setPayments(S.get(K.PAY, []));
    setFamilyMod(null);
    setFamilyForm({ totalAmount: '', paymentMethod: 'Cash', month: NOW.getMonth(), year: NOW.getFullYear(), note: '' });
    alert(`✅ Rs. ${total.toLocaleString()} distributed to ${toApply.length} student(s) successfully!`);
  };

  return (
    <div>
      {isPrincipal && (
        <div className="bg-blue-50 border border-blue-200 text-blue-800 text-sm px-4 py-3 rounded-xl mb-4 flex items-center gap-2">
          <span className="text-lg">🎓</span>
          <span><strong>Principal Mode</strong> — You can collect new fee payments. To edit or delete existing records, admin access is required.</span>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <h2 className="text-xl font-bold text-gray-800">Fee Collection</h2>
        <div className="flex items-center gap-2">
          <select value={vm} onChange={e => setVm(Number(e.target.value))} className={inputCls + ' w-auto'}>
            {MONTHS.map((mo,i) => <option key={i} value={i}>{mo}</option>)}
          </select>
          <select value={vy} onChange={e => setVy(Number(e.target.value))} className={inputCls + ' w-auto'}>
            {years.map(y => <option key={y}>{y}</option>)}
          </select>
        </div>
      </div>

      {/* ── Stats Cards ── */}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3 mb-4">
        {/* 1. Net Due — top stays as before, dashed divider + live breakdown below */}
        <Card className="p-4 border-blue-100">
          <p className="text-xs text-gray-400 font-semibold uppercase mb-1">📋 Net Due</p>
          <p className="text-lg font-bold text-blue-700">Rs. {netDueTotal.toLocaleString()}</p>
          <p className="text-[10px] text-emerald-600 opacity-80 mt-0.5">↔ mirrors Dashboard via Majma</p>
          {/* Light dashed divider — separates the main balance from its breakdown */}
          <div className="border-t border-dashed border-gray-300 my-2"></div>
          {/* Row 1: Fee Target (gross monthly demand, live) */}
          <div className="flex justify-between items-center text-xs mb-1">
            <span className="text-gray-500">Fee Target</span>
            <span className="font-semibold text-gray-700">Rs. {feeTarget.toLocaleString()}</span>
          </div>
          {/* Row 2: Discount (this month's discount given, live) */}
          <div className="flex justify-between items-center text-xs">
            <span className="text-gray-500">Discount</span>
            <span className="font-semibold text-amber-600">Rs. {totalDiscount.toLocaleString()}</span>
          </div>
        </Card>
        {/* 2. Collected */}
        <Card className="p-4 border-emerald-100">
          <p className="text-xs text-gray-400 font-semibold uppercase mb-1">✅ Collected</p>
          <p className="text-lg font-bold text-emerald-700">Rs. {collectedAmt.toLocaleString()}</p>
          <p className="text-xs text-gray-400 mt-0.5">This month</p>
        </Card>
        {/* 3. Discount */}
        <Card className="p-4 border-amber-100">
          <p className="text-xs text-gray-400 font-semibold uppercase mb-1">🏷️ Discount</p>
          <p className="text-lg font-bold text-amber-600">Rs. {totalDiscount.toLocaleString()}</p>
          <p className="text-xs text-gray-400 mt-0.5">Total given</p>
        </Card>
        {/* 4. Students */}
        <Card className="p-4 border-green-100">
          <p className="text-xs text-gray-400 font-semibold uppercase mb-1">👨‍🎓 Students</p>
          <div className="flex items-end gap-2 mt-1">
            <div className="text-center">
              <p className="text-xl font-extrabold text-blue-700">{students.length}</p>
              <p className="text-xs text-gray-400">Total</p>
            </div>
            <p className="text-gray-300 font-bold mb-3">−</p>
            <div className="text-center">
              <p className="text-xl font-extrabold text-green-600">{fullPaidCount}</p>
              <p className="text-xs text-gray-400">Paid</p>
            </div>
            <p className="text-gray-300 font-bold mb-3">=</p>
            <div className="text-center">
              <p className="text-xl font-extrabold text-red-500">{students.length - fullPaidCount}</p>
              <p className="text-xs text-gray-400">Unpaid</p>
            </div>
          </div>
        </Card>
        {/* 5. Partial */}
        <Card className="p-4 border-orange-100">
          <p className="text-xs text-gray-400 font-semibold uppercase mb-1">⏳ Partial</p>
          <p className="text-lg font-bold text-orange-500">{partialCount}</p>
          <p className="text-xs text-gray-400 mt-0.5">Partial payments</p>
        </Card>
        {/* 6. Total Balance Due */}
        <Card className={`p-4 ${totalBalanceDue>0?'border-red-200 bg-red-50':'border-emerald-100'}`}>
          <p className="text-xs text-gray-400 font-semibold uppercase mb-1">⚖️ Balance Due</p>
          <p className={`text-lg font-extrabold ${totalBalanceDue>0?'text-red-700':'text-emerald-600'}`}>Rs. {totalBalanceDue.toLocaleString()}</p>
          <p className="text-xs text-gray-400 mt-0.5">Total outstanding</p>
          <p className="text-[10px] text-emerald-600 opacity-80 mt-0.5">↔ mirrors Dashboard via Majma</p>
        </Card>
      </div>

      {/* ── Tab Bar ── */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-xl w-fit mb-4">
        {[['collect','💰 Collection'],['ledger','📋 Ledger'],['family','👨‍👧‍👦 Family Payment']].map(([k,l]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${tab===k?'bg-white shadow text-blue-700':'text-gray-500 hover:text-gray-700'}`}>{l}</button>
        ))}
      </div>

      {/* ════════════════ COLLECTION TAB ════════════════ */}
      {tab === 'collect' && (
        <div>
          <Card className="p-3 mb-4">
            <div className="flex flex-col sm:flex-row gap-2">
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search by name, roll no or father's name..."
                className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/>
              <select value={fcls} onChange={e => setFcls(e.target.value)}
                className="border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="All">All Classes</option>
                {CLASSES.map(c => <option key={c} value={c}>Class {c}</option>)}
              </select>
            </div>
          </Card>

          {students.length === 0
            ? <Empty icon="💰" text="No students found. Add students first from the Students page." />
            : (
              <Card className="overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b">
                      <tr className="text-left text-xs text-gray-500 font-semibold uppercase">
                        <th className="px-4 py-3">Sr.</th>
                        <th className="px-4 py-3">Student</th>
                        <th className="px-4 py-3 hidden lg:table-cell">Father</th>
                        <th className="px-4 py-3">Class</th>
                        <th className="px-4 py-3 hidden md:table-cell">Monthly Fee</th>
                        <th className="px-4 py-3 hidden md:table-cell text-red-500">Discount</th>
                        <th className="px-4 py-3 hidden md:table-cell">Net Due</th>
                        <th className="px-4 py-3 hidden sm:table-cell">Status</th>
                        <th className="px-4 py-3 text-red-600 font-bold">⚖️ Balance</th>
                        <th className="px-4 py-3 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {filtered.map((stu, idx) => {
                        const due        = Number(classFees[stu.cls] || 0);
                        // monthlyFee = student's personal rate → auto discount = classFee - monthlyFee
                        const autoDisc   = getStuDisc(stu, classFees);
                        const info       = paidMap[stu.id];
                        const paid       = info ? info.total : 0;
                        // disc: Global Engine getStuEffectiveDisc — same root used by all modules
                        const disc       = getStuEffectiveDisc(stu, payments, vm, vy, classFees);
                        const openingBal = Number(stu.openingBalance || 0);
                        // Net Due = (Class Fee − Discount) + Opening Balance — single consolidated figure
                        const monthlyNet = Math.max(0, due - disc);
                        const netDue     = monthlyNet + openingBal;
                        const status     = getStatus(stu);
                        const lastPay = info ? [...info.pays].sort((a,b)=>new Date(b.date)-new Date(a.date))[0] : null;
                        return (
                          <tr key={stu.id} className="hover:bg-slate-50">
                            <td className="px-4 py-3 text-xs font-bold text-gray-400">{String(idx+1).padStart(2,'0')}</td>
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-2">
                                {stu.photo
                                  ? <img src={stu.photo} alt="" className="w-7 h-7 rounded-full object-cover border border-gray-200 shrink-0"/>
                                  : <div className="w-7 h-7 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-bold text-xs shrink-0">{stu.name[0]}</div>
                                }
                                <div>
                                  <div className="font-semibold text-gray-800">{stu.name}</div>
                                  <div className="text-xs text-gray-400">Roll: {stu.roll}</div>
                                  {openingBal > 0 && <div className="text-xs text-amber-600 font-semibold">📂 Prev: Rs. {openingBal.toLocaleString()}</div>}
                                  {openingBal < 0 && <div className="text-xs text-emerald-600 font-semibold">💚 Advance: Rs. {Math.abs(openingBal).toLocaleString()}</div>}
                                </div>
                              </div>
                            </td>
                            <td className="px-4 py-3 text-gray-500 hidden lg:table-cell">{stu.father||'—'}</td>
                            <td className="px-4 py-3"><Badge color="blue">{stu.cls}</Badge></td>
                            <td className="px-4 py-3 text-gray-600 hidden md:table-cell">
                              {due > 0 ? `Rs. ${due.toLocaleString()}` : <Badge color="gray">Not Set</Badge>}
                            </td>
                            <td className="px-4 py-3 hidden md:table-cell">
                              {disc > 0
                                ? <span className="text-red-500 font-semibold text-xs bg-red-50 px-2 py-0.5 rounded-lg">− Rs. {disc.toLocaleString()}</span>
                                : <span className="text-gray-300 text-xs">—</span>}
                            </td>
                            <td className="px-4 py-3 hidden md:table-cell">
                              {due > 0 || openingBal !== 0
                                ? <div>
                                    <span className={`font-bold ${netDue < 0 ? 'text-emerald-600' : (disc > 0 || openingBal !== 0 ? 'text-emerald-700' : 'text-gray-700')}`}>
                                      {netDue < 0 ? `+Rs. ${Math.abs(netDue).toLocaleString()}` : `Rs. ${netDue.toLocaleString()}`}
                                    </span>
                                    {openingBal > 0 && (
                                      <div className="text-xs text-gray-500 font-medium mt-0.5">
                                        Rs. {monthlyNet.toLocaleString()} <span className="text-amber-600">+ Rs. {openingBal.toLocaleString()} prev</span>
                                      </div>
                                    )}
                                    {openingBal < 0 && (
                                      <div className="text-xs text-gray-500 font-medium mt-0.5">
                                        Rs. {monthlyNet.toLocaleString()} <span className="text-emerald-600">− Rs. {Math.abs(openingBal).toLocaleString()} advance</span>
                                      </div>
                                    )}
                                  </div>
                                : <span className="text-gray-300">—</span>}
                            </td>
                            <td className="px-4 py-3 hidden sm:table-cell">
                              {status === 'paid' && <Badge color="green">✓ Paid</Badge>}
                              {status === 'partial' && <Badge color="orange">⏳ Partial</Badge>}
                              {status === 'unpaid' && <Badge color="red">✗ Unpaid</Badge>}
                            </td>
                            <td className="px-4 py-3">
                              {(() => {
                                const bal = paid - netDue; // negative = still owes, positive = advance
                                if (!due && !openingBal) return <span className="text-gray-300 text-xs">—</span>;
                                if (bal >= 0 && netDue === 0) return (
                                  <span className="text-emerald-600 font-bold text-sm">✅ Clear</span>
                                );
                                if (bal > 0) return (
                                  <div className="flex flex-col">
                                    <span className="text-emerald-600 font-extrabold text-sm">+Rs. {bal.toLocaleString()}</span>
                                    <span className="text-xs text-emerald-500 font-semibold">Advance</span>
                                  </div>
                                );
                                if (bal === 0) return (
                                  <div className="flex flex-col">
                                    <span className="text-emerald-600 font-bold text-sm">✅ Rs. 0</span>
                                    <span className="text-xs text-emerald-400">Clear</span>
                                  </div>
                                );
                                return (
                                  <div className="flex flex-col">
                                    <span className="text-red-600 font-extrabold text-base">Rs. {Math.abs(bal).toLocaleString()}</span>
                                    <span className="text-xs text-red-400 font-semibold">⬆ Due</span>
                                  </div>
                                );
                              })()}
                            </td>
                            <td className="px-4 py-3 text-right">
                              <div className="flex flex-wrap gap-1 justify-end">
                                {status !== 'paid' && (
                                  <Btn sm variant="green" onClick={() => openCollect(stu)}>
                                    {status === 'partial' ? '➕ Add' : '💰 Collect'}
                                  </Btn>
                                )}
                                {lastPay && (
                                  <Btn sm variant="outline" onClick={() => window.requireMasterCode(() => checkPinThenDo('edit', lastPay, stu), `Edit payment: ${stu.name}`)}>✏️</Btn>
                                )}
                                {lastPay && (
                                  <Btn sm variant="red" onClick={() => window.requireMasterCode(() => checkPinThenDo('delete', lastPay, stu), `Delete payment: ${stu.name}`)}>🗑️</Btn>
                                )}
                                {lastPay && (
                                  <Btn sm variant="outline" onClick={() => printReceipt(lastPay, stu)}>🖨️</Btn>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot className="bg-gray-800 border-t-2 border-gray-700">
                      <tr>
                        <td colSpan="8" className="px-4 py-3 text-right text-xs font-bold text-gray-300 uppercase tracking-wide">
                          Closing Balance ({filtered.length} students)
                        </td>
                        <td className="px-4 py-3">
                          {(() => {
                            // ── Global Engine: getStuOutstanding (FULL — includes OB) ──
                            const total = filtered.reduce((sum, stu) => sum + getStuOutstanding(stu, classFees, allTimePaidMapFC), 0);
                            return (
                              <div>
                                <span className={`font-extrabold text-base ${total > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                                  Rs. {total.toLocaleString()}
                                </span>
                                <div className="text-xs text-gray-400 font-semibold">{total > 0 ? '⬆ Due' : '✅ All Clear'}</div>
                              </div>
                            );
                          })()}
                        </td>
                        <td className="px-4 py-3"></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </Card>
            )
          }
        </div>
      )}

      {/* ════════════════ LEDGER TAB ════════════════ */}
      {tab === 'ledger' && (
        <div>
          <div className="flex flex-wrap gap-2 mb-4 items-center">
            <select value={ledgerStu} onChange={e => setLedgerStu(e.target.value)} className={inputCls + ' sm:w-80'}>
              <option value="">All Students</option>
              {students.map(s => <option key={s.id} value={s.id}>{s.name} — Class {s.cls} | Roll {s.roll}</option>)}
            </select>
            <select value={fcls} onChange={e => setFcls(e.target.value)} className={inputCls + ' w-auto'}>
              <option value="All">All Classes</option>
              {CLASSES.map(c => <option key={c} value={c}>Class {c}</option>)}
            </select>
          </div>
          {/* ── Closing Balance Summary Card ── */}
          {(() => {
            const vis = ledgerStudents.filter(s => fcls === 'All' || s.cls === fcls);
            // ── Global Engine: getStuOutstanding (FULL — includes OB) ──
            const closingBal   = vis.reduce((sum, stu) => sum + getStuOutstanding(stu, classFees, allTimePaidMapFC), 0);
            const totalPaidAll = vis.reduce((sum, stu) => sum + (allTimePaidMapFC.feeMap[stu.id] || 0), 0);
            // Global Engine: getStuNetMonthlyDue + openingBalance — single formula
            const totalDueAll  = vis.reduce((sum, stu) =>
              sum + getStuNetMonthlyDue(stu, classFees) + Number(stu.openingBalance || 0), 0);
            return (
              <div className={`rounded-2xl p-4 mb-4 flex flex-wrap gap-4 items-center justify-between ${closingBal > 0 ? 'bg-red-50 border-2 border-red-200' : 'bg-emerald-50 border-2 border-emerald-200'}`}>
                <div>
                  <p className="text-xs font-bold uppercase text-gray-500 mb-0.5">⚖️ Closing Balance — {ledgerStu ? '1 Student' : `${vis.length} Students`}</p>
                  <p className={`text-2xl font-extrabold ${closingBal > 0 ? 'text-red-700' : 'text-emerald-700'}`}>
                    Rs. {closingBal.toLocaleString()}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">{closingBal > 0 ? '⬆ Total outstanding balance due' : '✅ All accounts settled'}</p>
                </div>
                <div className="flex gap-4 text-sm">
                  <div className="text-center">
                    <p className="text-xs text-gray-400 uppercase font-semibold">Total Due</p>
                    <p className="font-bold text-blue-700">Rs. {totalDueAll.toLocaleString()}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs text-gray-400 uppercase font-semibold">Total Paid</p>
                    <p className="font-bold text-emerald-700">Rs. {totalPaidAll.toLocaleString()}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs text-gray-400 uppercase font-semibold">Closing Balance</p>
                    <p className={`font-extrabold ${closingBal > 0 ? 'text-red-600' : 'text-emerald-600'}`}>Rs. {closingBal.toLocaleString()}</p>
                  </div>
                </div>
              </div>
            );
          })()}

          {ledgerStudents.filter(s => fcls === 'All' || s.cls === fcls).map(stu => {
            const stuPays    = [...(stuPayMap[stu.id] || [])].sort((a,b) => new Date(a.date)-new Date(b.date));
            const due        = Number(classFees[stu.cls] || 0);
            if (stuPays.length === 0) return null;
            let running = 0;
            const allTimePaidStu = stuPays.reduce((s,p)=>s+Number(p.amount),0);
            const ob             = Number(stu.openingBalance || 0);
            // Global Engine: getStuNetMonthlyDue + ob, getStuOutstanding (FULL — includes OB) ──
            const netDueStu      = getStuNetMonthlyDue(stu, classFees) + ob;
            const balDue         = getStuOutstanding(stu, classFees, allTimePaidMapFC);
            const stuStatus      = getStatus(stu);
            const isCleared      = balDue === 0;
            return (
              <Card key={stu.id} className="overflow-hidden mb-4">
                <div className={`px-5 py-3 border-b flex flex-wrap items-center justify-between gap-3 ${isCleared ? 'bg-emerald-50 border-emerald-100' : stuStatus==='partial' ? 'bg-amber-50 border-amber-100' : 'bg-red-50 border-red-100'}`}>
                  <div>
                    <p className={`font-bold text-base ${isCleared?'text-emerald-800':stuStatus==='partial'?'text-amber-800':'text-red-800'}`}>{stu.name}</p>
                    <p className="text-xs text-gray-500">Class {stu.cls} | Roll: {stu.roll}{stu.family ? ` | ${stu.family}` : ''}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-sm">
                    <div className="text-center">
                      <p className="text-xs text-gray-400 uppercase font-semibold">Monthly Fee</p>
                      <p className="font-bold text-gray-700">Rs. {due.toLocaleString()}</p>
                    </div>
                    {ob > 0 && <div className="text-center">
                      <p className="text-xs text-gray-400 uppercase font-semibold">Opening Bal</p>
                      <p className="font-bold text-orange-600">Rs. {ob.toLocaleString()}</p>
                    </div>}
                    <div className="text-center">
                      <p className="text-xs text-gray-400 uppercase font-semibold">All-Time Paid</p>
                      <p className="font-bold text-emerald-700">Rs. {allTimePaidStu.toLocaleString()}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-xs text-gray-400 uppercase font-semibold">Balance</p>
                      <p className={`font-extrabold text-base ${isCleared?'text-emerald-600':'text-red-700'}`}>{isCleared ? '✓ Cleared' : `Rs. ${balDue.toLocaleString()}`}</p>
                    </div>
                    <div className="flex flex-col items-center gap-1">
                      {stuStatus==='paid'    && <Badge color="green">✓ Paid</Badge>}
                      {stuStatus==='partial' && <Badge color="orange">⏳ Partial</Badge>}
                      {stuStatus==='unpaid'  && <Badge color="red">✗ Unpaid</Badge>}
                    </div>
                    {!isCleared && (
                      <Btn variant="red" onClick={() => openCollect(stu)}>
                        💳 Pay Rs. {balDue.toLocaleString()}
                      </Btn>
                    )}
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b">
                      <tr className="text-left text-xs text-gray-500 font-semibold uppercase">
                        <th className="px-4 py-2">Receipt</th>
                        <th className="px-4 py-2">Month</th>
                        <th className="px-4 py-2">Date</th>
                        <th className="px-4 py-2">Amount</th>
                        <th className="px-4 py-2">Method</th>
                        <th className="px-4 py-2">Running Total</th>
                        <th className="px-4 py-2">Note</th>
                        <th className="px-4 py-2 text-right">Print</th>
                        {isAdmin && <th className="px-4 py-2 text-right text-red-500">Delete</th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {stuPays.map(p => {
                        running += Number(p.amount);
                        return (
                          <tr key={p.id} className="hover:bg-slate-50">
                            <td className="px-4 py-2 font-mono text-xs text-gray-500">{p.rcpt}</td>
                            <td className="px-4 py-2 font-semibold">{MONTHS[p.month]} {p.year}</td>
                            <td className="px-4 py-2 text-xs text-gray-500">{new Date(p.date).toLocaleDateString('en-PK')}</td>
                            <td className="px-4 py-2 font-bold text-emerald-700">Rs. {Number(p.amount).toLocaleString()}</td>
                            <td className="px-4 py-2"><Badge color={p.paymentMethod==='Bank Transfer'?'blue':p.paymentMethod==='JazzCash'||p.paymentMethod==='Easypaisa'?'purple':'green'}>{p.paymentMethod||'Cash'}</Badge></td>
                            <td className="px-4 py-2 font-semibold text-gray-700">Rs. {running.toLocaleString()}</td>
                            <td className="px-4 py-2 text-xs text-gray-400">{p.note||'—'}</td>
                            <td className="px-4 py-2 text-right">
                              <Btn sm variant="outline" onClick={() => printReceipt(p, stu)}>🖨️</Btn>
                            </td>
                            {isAdmin && (
                              <td className="px-4 py-2 text-right">
                                <Btn sm variant="red" onClick={() => setDelPayConf({ pay: p, stu })}>🗑️ Delete</Btn>
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
            );
          })}

          {ledgerStudents.filter(s => (fcls === 'All' || s.cls === fcls) && (stuPayMap[s.id]||[]).length > 0).length === 0 && (
            <Empty icon="📋" text="No payment records found."/>
          )}
        </div>
      )}

      {/* ════════════════ FAMILY SPLIT TAB ════════════════ */}
      {tab === 'family' && (() => {
        // Master Design — derive per-family snapshot once for stats AND rendering
        const _fcPaidMapsTab = buildPaidMapsFromCutoff(payments);
        const enrichedFamilies = familyGroups.map(([key, siblings, fmeta]) => {
          // ── Global Engine: getStuOutstanding (FULL — includes Opening Balance) ──
          // Same call used by Fee Collection table, Student Ledger card, Family Ledger card.
          // Drift fix: was previously using cutoff variant which strips OB.
          const totalOutstanding = parseFloat(
            siblings.reduce((s, stu) => s + getStuOutstanding(stu, classFees, _fcPaidMapsTab), 0).toFixed(2)
          );
          return { key, siblings, fmeta: fmeta || {}, totalOutstanding };
        });
        // Stats (across ALL families, regardless of search/filter)
        const statTotalFamilies   = enrichedFamilies.length;
        const statClearedCount    = enrichedFamilies.filter(f => f.totalOutstanding === 0).length;
        const statDueCount        = statTotalFamilies - statClearedCount;
        const statGrandOutstanding = enrichedFamilies.reduce((s, f) => s + f.totalOutstanding, 0);
        // Apply local search + status filter
        const q = famSearch.trim().toLowerCase();
        const visibleFamilies = enrichedFamilies.filter(f => {
          if (famStatusFilter === 'cleared' && f.totalOutstanding > 0) return false;
          if (famStatusFilter === 'due'     && f.totalOutstanding === 0) return false;
          if (!q) return true;
          const meta = f.fmeta || {};
          const hay = [
            meta.familyId, meta.familyName, meta.fatherName,
            ...f.siblings.map(s => s.name), ...f.siblings.map(s => s.roll)
          ].filter(Boolean).join(' ').toLowerCase();
          return hay.includes(q);
        });
        return (
        <div>
          {familyGroups.length === 0
            ? <Empty icon="👨‍👧‍👦" text="No students yet. Add students from the Students page first." />
            : (<>
              {/* ── Summary stats strip ── */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
                <div className="bg-blue-50 border border-blue-100 rounded-xl px-4 py-2.5">
                  <p className="text-[10px] text-blue-500 font-bold uppercase tracking-wider">👨‍👧‍👦 Families</p>
                  <p className="text-lg font-extrabold text-blue-700">{statTotalFamilies}</p>
                </div>
                <div className="bg-emerald-50 border border-emerald-100 rounded-xl px-4 py-2.5">
                  <p className="text-[10px] text-emerald-600 font-bold uppercase tracking-wider">✓ Cleared</p>
                  <p className="text-lg font-extrabold text-emerald-700">{statClearedCount}</p>
                </div>
                <div className="bg-amber-50 border border-amber-100 rounded-xl px-4 py-2.5">
                  <p className="text-[10px] text-amber-600 font-bold uppercase tracking-wider">⏳ With Due</p>
                  <p className="text-lg font-extrabold text-amber-700">{statDueCount}</p>
                </div>
                <div className="bg-red-50 border border-red-100 rounded-xl px-4 py-2.5">
                  <p className="text-[10px] text-red-500 font-bold uppercase tracking-wider">💰 Total Due</p>
                  <p className="text-lg font-extrabold text-red-600">Rs. {statGrandOutstanding.toLocaleString()}</p>
                </div>
              </div>
              {/* ── Search + status filter ── */}
              <Card className="p-3 mb-4">
                <div className="flex flex-col sm:flex-row gap-2 items-stretch">
                  <input value={famSearch} onChange={e => setFamSearch(e.target.value)}
                    placeholder="🔎 Search by Family ID, family/father name, student name, or roll…"
                    className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/>
                  <div className="flex gap-1 bg-gray-100 p-1 rounded-lg">
                    {[['all','All'],['due','Due only'],['cleared','Cleared']].map(([k,l])=>(
                      <button key={k} onClick={()=>setFamStatusFilter(k)}
                        className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all ${famStatusFilter===k?'bg-white shadow text-blue-700':'text-gray-500 hover:text-gray-700'}`}>{l}</button>
                    ))}
                  </div>
                </div>
                {(famSearch || famStatusFilter !== 'all') && (
                  <p className="text-[11px] text-gray-400 mt-2">Showing {visibleFamilies.length} of {statTotalFamilies} families</p>
                )}
              </Card>
              {/* ── Family cards ── */}
              {visibleFamilies.length === 0
                ? <Empty icon="🔎" text="No families match your filter."/>
                : visibleFamilies.map(({ key: familyKey, siblings, fmeta, totalOutstanding }) => {
                const allPaid     = totalOutstanding === 0;
                const isSingle    = siblings.length === 1;
                const familyId    = fmeta.familyId   || '';
                const familyName  = fmeta.familyName || '';
                const fatherName  = fmeta.fatherName || '';
                const displayTitle = familyName || fatherName || siblings[0]?.name || 'Unnamed';
                const familyGrossMonthly = siblings.reduce((s, stu) => s + Number(classFees[stu.cls] || 0), 0);
                const familyMonthDiscount = siblings.reduce((s, stu) => s + getStuEffectiveDisc(stu, payments, vm, vy, classFees), 0);
                const familyMonthPaid = siblings.reduce((s, stu) => s + (paidMap[stu.id]?.total || 0), 0);
                return (
                  <Card key={familyKey} className="mb-4 overflow-hidden">
                    <div className={`px-5 py-3 flex flex-wrap items-center justify-between gap-3 border-b ${allPaid ? 'bg-emerald-50 border-emerald-100' : 'bg-blue-50 border-blue-100'}`}>
                      <div className="flex items-center gap-3 flex-wrap">
                        {/* Prominent Family ID badge */}
                        {familyId
                          ? <div className={`text-sm font-extrabold px-3 py-2 rounded-lg border-2 font-mono tracking-wide ${allPaid ? 'bg-white text-emerald-700 border-emerald-300' : 'bg-white text-blue-700 border-blue-300'}`}>
                              <span className="text-[9px] opacity-60 block leading-none mb-0.5">FAMILY ID</span>{familyId}
                            </div>
                          : <div className="text-xs font-bold px-3 py-2 rounded-lg border-2 bg-gray-50 text-gray-400 border-gray-200">no FID</div>
                        }
                        <div>
                          <p className={`font-bold text-base ${allPaid ? 'text-emerald-800' : 'text-blue-900'}`}>
                            {isSingle ? '👤' : '👨‍👧‍👦'} {displayTitle}
                            {isSingle && <span className="text-[10px] font-semibold ml-2 px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 align-middle">SINGLE</span>}
                          </p>
                          <p className="text-xs text-gray-500">
                            {siblings.length} {siblings.length === 1 ? 'student' : 'siblings'}
                            {fatherName && familyName && fatherName !== familyName ? <> · S/O {fatherName}</> : null}
                            {' · '}
                            {allPaid ? <span className="text-emerald-700 font-semibold">✅ All Cleared</span> : <span className="text-red-600 font-semibold">Outstanding: Rs. {totalOutstanding.toLocaleString()}</span>}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Btn sm variant="outline" onClick={() => printFamilyLedger(familyId ? (displayTitle + ' (FID ' + familyId + ')') : displayTitle, siblings)}>🖨️ Ledger</Btn>
                        {!allPaid && (
                          <Btn variant="red" onClick={() => {
                            setFamilyMod({ familyKey, siblings, familyId, familyName: displayTitle });
                            setFamilyForm({ totalAmount: String(totalOutstanding), paymentMethod: 'Cash', month: vm, year: vy, note: '' });
                          }}>💳 Pay Rs. {totalOutstanding.toLocaleString()}</Btn>
                        )}
                      </div>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50 border-b">
                          <tr className="text-left text-xs text-gray-500 font-semibold uppercase">
                            <th className="px-4 py-2">Student</th>
                            <th className="px-4 py-2">Class</th>
                            <th className="px-4 py-2 text-right">Monthly Fee</th>
                            <th className="px-4 py-2 text-right">Discount</th>
                            <th className="px-4 py-2 text-right">Paid (This Month)</th>
                            <th className="px-4 py-2 text-right">Outstanding</th>
                            <th className="px-4 py-2">Status</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50">
                          {siblings.map(stu => {
                            // ── Global Engine: getStuOutstanding (FULL — includes OB) ──
                            // Identical to per-row Outstanding in Fee Collection Collection tab.
                            const outstanding = getStuOutstanding(stu, classFees, allTimePaidMapFC);
                            const st          = getStatus(stu);
                            const due         = Number(classFees[stu.cls] || 0);
                            const disc        = getStuEffectiveDisc(stu, payments, vm, vy, classFees);
                            const paid        = paidMap[stu.id]?.total || 0;
                            return (
                              <tr key={stu.id} className="hover:bg-slate-50">
                                <td className="px-4 py-2">
                                  <div className="font-semibold text-gray-800">{stu.name}</div>
                                  <div className="text-xs text-gray-400">Roll: {stu.roll}</div>
                                </td>
                                <td className="px-4 py-2"><Badge color="blue">{stu.cls}</Badge></td>
                                <td className="px-4 py-2 text-right text-gray-600">Rs. {due.toLocaleString()}</td>
                                <td className="px-4 py-2 text-right font-semibold text-amber-600">{disc > 0 ? `- Rs. ${disc.toLocaleString()}` : <span className="text-gray-300">—</span>}</td>
                                <td className="px-4 py-2 text-right font-semibold text-emerald-700">Rs. {paid.toLocaleString()}</td>
                                <td className="px-4 py-2 text-right font-semibold text-red-600">
                                  {outstanding > 0 ? `Rs. ${outstanding.toLocaleString()}` : <span className="text-emerald-600 font-semibold">✓ Cleared</span>}
                                </td>
                                <td className="px-4 py-2">
                                  {st === 'paid'    && <Badge color="green">✓ Paid</Badge>}
                                  {st === 'partial' && <Badge color="orange">⏳ Partial</Badge>}
                                  {st === 'unpaid'  && <Badge color="red">✗ Unpaid</Badge>}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                        <tfoot className="bg-gray-50 border-t-2 border-gray-200">
                          <tr className="text-sm font-bold">
                            <td colSpan="2" className="px-4 py-2 text-gray-500">Total</td>
                            <td className="px-4 py-2 text-right text-blue-700">Rs. {familyGrossMonthly.toLocaleString()}</td>
                            <td className="px-4 py-2 text-right text-amber-600">{familyMonthDiscount > 0 ? `- Rs. ${familyMonthDiscount.toLocaleString()}` : '—'}</td>
                            <td className="px-4 py-2 text-right text-emerald-700">Rs. {familyMonthPaid.toLocaleString()}</td>
                            <td className="px-4 py-2 text-right text-red-600">Rs. {totalOutstanding.toLocaleString()}</td>
                            <td></td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </Card>
                );
              })
              }
            </>)
          }
        </div>
        );
      })()}

      {/* ── Family Split Payment Modal ── */}
      {familyMod && (
        <Modal title={`👨‍👧‍👦 Family Payment — ${familyMod.familyName || familyMod.familyKey}${familyMod.familyId ? ' (FID ' + familyMod.familyId + ')' : ''}`} onClose={() => setFamilyMod(null)}>
          <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 mb-4">
            <p className="text-sm text-blue-700 font-semibold">{familyMod.siblings.length} siblings — Enter total lump sum received. It will auto-distribute to each sibling's outstanding balance.</p>
          </div>
          <div className="flex gap-2 mb-1">
            <div className="flex-1">
              <Sel label="Month *" value={familyForm.month} onChange={e => setFamilyForm({...familyForm, month: Number(e.target.value)})}
                options={MONTHS.map((mo,i) => ({v:i, l:mo}))}/>
            </div>
            <div style={{width:90}}>
              <Sel label="Year" value={familyForm.year} onChange={e => setFamilyForm({...familyForm, year: Number(e.target.value)})}
                options={years.map(y => ({v:y, l:String(y)}))}/>
            </div>
          </div>
          <Inp label="Total Amount Received (Rs.) *" type="number" min="1"
            value={familyForm.totalAmount}
            onChange={e => setFamilyForm({...familyForm, totalAmount: e.target.value})}
            placeholder="Enter lump sum amount received from family"/>
          <div className="mb-3">
            <label className="block text-xs font-semibold text-gray-500 mb-1 uppercase tracking-wide">Payment Method *</label>
            <div className="flex flex-wrap gap-2">
              {PAYMENT_METHODS.map(m => (
                <label key={m} className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border-2 cursor-pointer text-sm font-semibold transition-all ${familyForm.paymentMethod===m?'border-blue-500 bg-blue-50 text-blue-700':'border-gray-200 text-gray-500 hover:border-gray-300'}`}>
                  <input type="radio" name="famMethod" value={m} checked={familyForm.paymentMethod===m} onChange={()=>setFamilyForm({...familyForm,paymentMethod:m})} className="hidden"/>
                  {m==='Cash'?'💵':m==='Bank Transfer'?'🏦':m==='JazzCash'?'📱':'💳'} {m}
                </label>
              ))}
            </div>
          </div>
          <Inp label="Note (optional)" value={familyForm.note}
            onChange={e => setFamilyForm({...familyForm, note: e.target.value})}
            placeholder="e.g. Monthly family payment"/>
          {/* Live Distribution Preview */}
          {Number(familyForm.totalAmount) > 0 && (
            <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 mb-4">
              <p className="text-xs font-bold text-gray-500 uppercase mb-2">📊 Auto Distribution Preview</p>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-gray-400 uppercase border-b border-gray-200">
                    <th className="text-left pb-2">Student</th>
                    <th className="text-right pb-2">Outstanding</th>
                    <th className="text-right pb-2">Will Receive</th>
                  </tr>
                </thead>
                <tbody>
                  {splitPreview.map(r => (
                    <tr key={r.stu.id} className="border-b border-gray-100">
                      <td className="py-1.5 font-semibold text-gray-700">{r.stu.name} <span className="text-gray-400 font-normal text-xs">Cls {r.stu.cls}</span></td>
                      <td className="py-1.5 text-right text-red-500 font-semibold">Rs. {r.outstanding.toLocaleString()}</td>
                      <td className={`py-1.5 text-right font-bold ${r.allocate > 0 ? 'text-emerald-700' : 'text-gray-300'}`}>
                        {r.allocate > 0 ? `Rs. ${r.allocate.toLocaleString()}` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-gray-300">
                    <td className="pt-2 font-bold text-gray-700">Total</td>
                    <td className="pt-2 text-right font-bold text-red-500">Rs. {splitPreview.reduce((s,r)=>s+r.outstanding,0).toLocaleString()}</td>
                    <td className="pt-2 text-right font-extrabold text-emerald-700">Rs. {splitPreview.reduce((s,r)=>s+r.allocate,0).toLocaleString()}</td>
                  </tr>
                </tfoot>
              </table>
              {Number(familyForm.totalAmount) > splitPreview.reduce((s,r)=>s+r.outstanding,0) && (
                <p className="text-xs text-amber-600 mt-2 font-semibold">⚠️ Amount exceeds total outstanding. Only outstanding portion will be recorded.</p>
              )}
            </div>
          )}
          <div className="flex gap-2">
            <Btn full variant="green" onClick={saveSplitPayment}>✅ Confirm & Save Split Payment</Btn>
            <Btn variant="outline" onClick={() => setFamilyMod(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {/* ── Edit Payment Modal (Admin Only) ── */}
      {editPayMod && (
        <Modal title={`✏️ Edit Payment — ${editPayMod.stu.name}`} onClose={() => setEditPayMod(null)}>
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-4 text-sm">
            <p className="font-bold text-amber-800">{editPayMod.stu.name} · Receipt: {editPayMod.pay.rcpt}</p>
            <p className="text-amber-600">{MONTHS[editPayMod.pay.month]} {editPayMod.pay.year} · Original: Rs. {(Number(editPayMod.pay.amount)+Number(editPayMod.pay.discount||0)).toLocaleString()}</p>
          </div>
          <Inp label="Amount Received (Rs.) *" type="number" min="1" value={epf.amount}
            onChange={e => setEpf({...epf, amount: e.target.value})} placeholder="Total amount before discount"/>
          <Inp label="Discount (Rs.)" type="number" min="0" value={epf.discount}
            onChange={e => setEpf({...epf, discount: e.target.value})} placeholder="0 if no discount"/>
          {Number(epf.discount) > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-3 text-sm">
              <div className="flex justify-between text-gray-600 mb-1"><span>Amount:</span><span>Rs. {Number(epf.amount||0).toLocaleString()}</span></div>
              <div className="flex justify-between text-red-600 mb-1"><span>Discount:</span><span>- Rs. {Number(epf.discount||0).toLocaleString()}</span></div>
              <div className="flex justify-between font-bold text-emerald-700 border-t pt-1"><span>Net Payable:</span><span>Rs. {Math.max(0,Number(epf.amount||0)-Number(epf.discount||0)).toLocaleString()}</span></div>
            </div>
          )}
          <Inp label="Annual Fund (Rs.)" type="number" min="0" value={epf.annualFund}
            onChange={e => setEpf({...epf, annualFund: e.target.value})} placeholder="0 if not applicable"/>
          <Inp label="Note" value={epf.note} onChange={e => setEpf({...epf, note: e.target.value})} placeholder="Optional note"/>
          <div className="mb-3">
            <label className="block text-xs font-semibold text-gray-500 mb-1 uppercase tracking-wide">Payment Method</label>
            <div className="flex flex-wrap gap-2">
              {PAYMENT_METHODS.map(m => (
                <label key={m} className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border-2 cursor-pointer text-sm font-semibold transition-all ${epf.paymentMethod===m?'border-blue-500 bg-blue-50 text-blue-700':'border-gray-200 text-gray-500 hover:border-gray-300'}`}>
                  <input type="radio" name="epfMethod" value={m} checked={epf.paymentMethod===m} onChange={()=>setEpf({...epf,paymentMethod:m})} className="hidden"/>
                  {m==='Cash'?'💵':m==='Bank Transfer'?'🏦':m==='JazzCash'?'📱':'💳'} {m}
                </label>
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <Btn full variant="blue" onClick={saveEditPay}>✅ Update Payment</Btn>
            <Btn variant="outline" onClick={() => setEditPayMod(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {/* ── Delete Payment Confirmation (Admin Only) ── */}
      {delPayConf && (
        <Modal title="🗑️ Delete Payment" onClose={() => setDelPayConf(null)}>
          <div className="text-center py-4">
            <div className="text-5xl mb-3">⚠️</div>
            <p className="font-bold text-gray-800 text-lg mb-1">Delete this payment record?</p>
            <p className="text-gray-500 text-sm mb-1">{delPayConf.stu.name} · {MONTHS[delPayConf.pay.month]} {delPayConf.pay.year}</p>
            <p className="text-red-600 font-bold text-lg mb-1">Rs. {Number(delPayConf.pay.amount).toLocaleString()}</p>
            <p className="text-xs text-gray-400 font-mono mb-4">{delPayConf.pay.rcpt}</p>
            <p className="text-red-500 text-sm font-semibold bg-red-50 px-4 py-2 rounded-xl">This action cannot be undone. Student's balance will be restored.</p>
          </div>
          <div className="flex gap-2 mt-2">
            <Btn full variant="red" onClick={confirmDelPay}>🗑️ Yes, Delete</Btn>
            <Btn full variant="outline" onClick={() => setDelPayConf(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {/* ── Admin PIN Override Modal ── */}
      {pinOverride && (
        <Modal title="🔑 Admin Authorization Required" onClose={() => setPinOverride(null)}>
          <div className="text-center mb-4">
            <div className="text-4xl mb-2">🔒</div>
            <p className="font-bold text-gray-800">This action requires Admin authorization.</p>
            <p className="text-sm text-gray-500 mt-1">Enter the Admin Override PIN to proceed with this {pinOverride.action}.</p>
          </div>
          <div className="mb-4">
            <label className="block text-xs font-semibold text-gray-500 mb-1 uppercase">Admin Override PIN</label>
            <input type="password" value={pinInput} onChange={e => setPinInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && verifyPin()}
              placeholder="Enter admin PIN..."
              className="w-full border-2 border-gray-200 rounded-xl px-4 py-3 text-center text-xl tracking-widest font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"/>
          </div>
          <div className="flex gap-2">
            <Btn full variant="blue" onClick={verifyPin}>🔓 Authorize</Btn>
            <Btn variant="outline" onClick={() => setPinOverride(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {/* ── Collection Modal ── */}
      {collMod && (
        <Modal title={`Add Payment — ${collMod.stu.name}`} onClose={() => setCollMod(null)}>
          <div className="bg-blue-50 rounded-xl p-3 mb-4">
            <p className="font-bold text-blue-800">{collMod.stu.name}</p>
            <p className="text-sm text-blue-600">Class {collMod.stu.cls} | Roll: {collMod.stu.roll}{collMod.stu.family ? ` | ${collMod.stu.family}` : ''}</p>
            {Number(collMod.stu.openingBalance||0) > 0 && (
              <div className="mt-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5 text-sm text-amber-700">
                📂 Opening Balance (prev dues): <strong>Rs. {Number(collMod.stu.openingBalance).toLocaleString()}</strong>
              </div>
            )}
            <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
              <div className="bg-white rounded-lg px-3 py-1.5">
                <span className="text-gray-400 text-xs block">Total Due</span>
                <strong className="text-blue-700">Rs. {(collMod.totalDue||collMod.balance).toLocaleString()}</strong>
                {collMod.openingBal > 0 && <span className="text-xs text-amber-500 block">incl. prev Rs. {collMod.openingBal.toLocaleString()}</span>}
              </div>
              <div className="bg-white rounded-lg px-3 py-1.5">
                <span className="text-gray-400 text-xs block">{collMod.alreadyPaid > 0 ? 'Paid This Month' : 'Paid'}</span>
                <strong className="text-emerald-700">Rs. {collMod.alreadyPaid.toLocaleString()}</strong>
              </div>
              <div className="bg-white rounded-lg px-3 py-1.5 col-span-2">
                <span className="text-gray-400 text-xs block">Balance Remaining</span>
                <strong className={collMod.balance > 0 ? 'text-red-600' : 'text-emerald-700'}>Rs. {collMod.balance.toLocaleString()}</strong>
              </div>
            </div>
          </div>
          <div className="flex gap-2 mb-1">
            <div className="flex-1">
              <Sel label="Month *" value={cf.month} onChange={e => setCf({...cf, month: Number(e.target.value)})}
                options={MONTHS.map((mo,i) => ({v:i, l:mo}))}/>
            </div>
            <div style={{width:90}}>
              <Sel label="Year" value={cf.year} onChange={e => setCf({...cf, year: Number(e.target.value)})}
                options={years.map(y => ({v:y, l:String(y)}))}/>
            </div>
          </div>
          <Inp label="Amount Received (Rs.) *" type="number" min="1" value={cf.feeAmount}
            onChange={e => setCf({...cf, feeAmount: e.target.value})} placeholder="Enter amount received now"/>
          <Inp label="Discount (Rs.)" type="number" min="0" value={cf.discount}
            onChange={e => setCf({...cf, discount: e.target.value})} placeholder="0 if no discount"/>
          {(Number(cf.discount) > 0 || openingBalModal() > 0) && (() => {
            const due2      = classDueForModal();
            const disc2     = Number(cf.discount || 0);
            const netFee2   = studentNetFee();           // class fee − discount
            const obBal     = openingBalModal();          // prior dues
            const totalDue2 = netFee2 + obBal;           // total owed
            const paid2     = alreadyPaidModal();         // already paid this month
            const received2 = Number(cf.feeAmount || 0); // receiving now
            const bal2      = totalDue2 - paid2 - received2; // balance after this payment
            return (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-3 text-sm">
                <div className="flex justify-between text-gray-600 mb-1"><span>Class Fee:</span><span className="font-semibold">Rs. {due2.toLocaleString()}</span></div>
                {disc2 > 0 && <div className="flex justify-between text-red-600 mb-1"><span>Discount:</span><span className="font-semibold">− Rs. {disc2.toLocaleString()}</span></div>}
                {disc2 > 0 && <div className="flex justify-between text-blue-700 font-semibold mb-1"><span>Monthly Net Fee:</span><span>Rs. {netFee2.toLocaleString()}</span></div>}
                {obBal > 0 && <div className="flex justify-between text-amber-700 font-semibold mb-1"><span>Opening Balance (prev dues):</span><span>+ Rs. {obBal.toLocaleString()}</span></div>}
                <div className="flex justify-between text-blue-800 font-bold border-t border-amber-300 pt-1 mb-1"><span>Total Net Due:</span><span>Rs. {totalDue2.toLocaleString()}</span></div>
                {paid2 > 0 && <div className="flex justify-between text-emerald-700 mb-1"><span>Already Paid:</span><span className="font-semibold">− Rs. {paid2.toLocaleString()}</span></div>}
                {received2 > 0 && <div className="flex justify-between text-gray-600 mb-1"><span>Receiving Now:</span><span className="font-semibold">− Rs. {received2.toLocaleString()}</span></div>}
                {received2 > 0 && <div className={`flex justify-between font-bold border-t border-amber-300 pt-1 ${bal2 > 0 ? 'text-red-600' : bal2 < 0 ? 'text-emerald-700' : 'text-gray-500'}`}>
                  <span>{bal2 > 0 ? '⚠️ Balance Remaining:' : bal2 < 0 ? '✅ Advance:' : '✅ Fully Cleared'}</span>
                  <span>Rs. {Math.abs(bal2).toLocaleString()}</span>
                </div>}
              </div>
            );
          })()}
          {/* ── AF HEAD STATUS — Single Source: st.annualFund (Students module) ── */}
          {collMod && (() => {
            const expAF  = Number(collMod.stu.annualFund || 0);
            const paidAF = payments.filter(p => p.stuId === collMod.stu.id).reduce((s, p) => s + Number(p.annualFund || 0), 0);
            const remAF  = Math.max(0, expAF - paidAF);
            const entered= Number(cf.annualFund || 0);
            const exceed = entered > remAF;
            if (expAF <= 0) return null;
            return (
              <div className={`rounded-xl p-2.5 mb-2 text-xs border ${exceed ? 'bg-red-50 border-red-300' : 'bg-purple-50 border-purple-200'}`}>
                <div className="flex justify-between"><span className="text-gray-600">🏦 AF Expected (from Student record):</span><span className="font-semibold">Rs. {expAF.toLocaleString()}</span></div>
                <div className="flex justify-between"><span className="text-gray-600">✅ AF Already Paid:</span><span className="font-semibold text-emerald-700">Rs. {paidAF.toLocaleString()}</span></div>
                <div className="flex justify-between border-t border-purple-200 pt-1 mt-1"><span className="font-bold text-purple-800">AF Remaining (max allowed):</span><span className="font-extrabold text-purple-900">Rs. {remAF.toLocaleString()}</span></div>
                {exceed && (
                  <div className="mt-1.5 text-red-700 font-semibold text-[11px] leading-snug">
                    ⚠️ AF exceeds remaining. Extra money should go to "Amount" field (it will clear Opening Balance). AF cap: Rs. {remAF.toLocaleString()}.
                  </div>
                )}
              </div>
            );
          })()}
          <Inp label="Annual Fund (Rs.)" type="number" min="0" value={cf.annualFund}
            onChange={e => setCf({...cf, annualFund: e.target.value})} placeholder="0 if not applicable"/>
          <Inp label="Remarks / Note (optional)" value={cf.note}
            onChange={e => setCf({...cf, note: e.target.value})} placeholder="e.g. Partial payment, 2nd instalment…"/>
          <div className="mb-3">
            <label className="block text-xs font-semibold text-gray-500 mb-1 uppercase tracking-wide">Payment Method *</label>
            <div className="flex flex-wrap gap-2">
              {PAYMENT_METHODS.map(m => (
                <label key={m} className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border-2 cursor-pointer text-sm font-semibold transition-all ${cf.paymentMethod===m?'border-blue-500 bg-blue-50 text-blue-700':'border-gray-200 text-gray-500 hover:border-gray-300'}`}>
                  <input type="radio" name="cfMethod" value={m} checked={cf.paymentMethod===m} onChange={()=>setCf({...cf,paymentMethod:m})} className="hidden"/>
                  {m==='Cash'?'💵':m==='Bank Transfer'?'🏦':m==='JazzCash'?'📱':'💳'} {m}
                </label>
              ))}
            </div>
          </div>
          <div className="bg-emerald-50 rounded-xl p-3 mb-2 flex justify-between items-center">
            <span className="font-bold text-emerald-800">Collecting Now:</span>
            <span className="text-xl font-extrabold text-emerald-700">Rs. {(netPayable() + Number(cf.annualFund||0)).toLocaleString()}</span>
          </div>
          {(() => {
            const remainAfter = totalRealDue() - alreadyPaidModal() - netPayable();
            if (!collMod) return null;
            return remainAfter > 0
              ? <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-2 mb-3 flex justify-between text-sm"><span className="text-red-600 font-semibold">Balance after this payment:</span><span className="text-red-700 font-bold">Rs. {remainAfter.toLocaleString()} remaining</span></div>
              : remainAfter < 0
              ? <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-2 mb-3 flex justify-between text-sm"><span className="text-emerald-600 font-semibold">After this payment:</span><span className="text-emerald-700 font-bold">Rs. {Math.abs(remainAfter).toLocaleString()} advance</span></div>
              : <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-2 mb-3 text-center text-sm text-emerald-700 font-bold">✅ Fully cleared after this payment</div>;
          })()}
          <div className="flex gap-2">
            <Btn full variant="green" onClick={collectFee}>✅ Save & Print Receipt</Btn>
            <Btn variant="outline" onClick={() => setCollMod(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {/* ════════════════ LEGACY FAMILY SPLIT TAB — REMOVED ════════════════
          This block used to render a duplicate family list under the same
          `tab === 'family'` condition as the new enrichedFamilies view above
          (line ~5949). That caused every family (e.g. FID 291) to appear twice
          on the Family Payment tab. The enriched view above is the canonical
          renderer — this legacy duplicate is intentionally deleted. */}
      {false && tab === 'family' && (
        <div>
          <Card className="p-3 mb-4">
            <input value={familySearch} onChange={e => setFamilySearch(e.target.value)}
              placeholder="Search by family name or student name..."
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/>
          </Card>
          {familyGroups.filter(([fk, sibs]) =>
            !familySearch || fk.toLowerCase().includes(familySearch.toLowerCase()) ||
            sibs.some(s => s.name.toLowerCase().includes(familySearch.toLowerCase()))
          ).length === 0
            ? <Empty icon="👨‍👧‍👦" text="No families found. Make sure siblings share the same Family Name or Father's Name in student records." />
            : familyGroups.filter(([fk, sibs]) =>
                !familySearch || fk.toLowerCase().includes(familySearch.toLowerCase()) ||
                sibs.some(s => s.name.toLowerCase().includes(familySearch.toLowerCase()))
              ).map(([familyKey, siblings]) => {
                // Global Engine: getStuOutstanding (FULL — includes OB) ──
                const totalOutstanding = siblings.reduce((s, stu) =>
                  s + getStuOutstanding(stu, classFees, allTimePaidMapFC), 0);
                const allPaid = totalOutstanding === 0;
                return (
                  <Card key={familyKey} className="mb-4 overflow-hidden">
                    {/* Family Header */}
                    <div className={`px-5 py-3 flex flex-wrap items-center justify-between gap-2 border-b ${allPaid ? 'bg-emerald-50 border-emerald-100' : 'bg-blue-50 border-blue-100'}`}>
                      <div>
                        <p className={`font-bold text-base ${allPaid ? 'text-emerald-800' : 'text-blue-900'}`}>👨‍👧‍👦 {familyKey}</p>
                        <p className="text-xs text-gray-500">{siblings.length} siblings — {allPaid ? '✅ All Cleared' : `Outstanding: Rs. ${totalOutstanding.toLocaleString()}`}</p>
                      </div>
                      <div className="flex gap-2 flex-wrap">
                        <Btn variant="outline" onClick={() => printFamilyLedger(familyKey, siblings)}>🖨️ Print Ledger</Btn>
                        {!allPaid && (
                          <Btn variant="red" onClick={() => {
                            setFamilyMod({ familyKey, siblings });
                            setFamilyForm({ totalAmount: String(totalOutstanding), paymentMethod: 'Cash', month: vm, year: vy, note: '' });
                          }}>💳 Pay Rs. {totalOutstanding.toLocaleString()}</Btn>
                        )}
                      </div>
                    </div>
                    {/* Siblings Table */}
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50 border-b">
                          <tr className="text-left text-xs text-gray-500 font-semibold uppercase">
                            <th className="px-4 py-2">Student</th>
                            <th className="px-4 py-2">Class</th>
                            <th className="px-4 py-2">Monthly Fee</th>
                            <th className="px-4 py-2">Paid</th>
                            <th className="px-4 py-2">Outstanding</th>
                            <th className="px-4 py-2">Status</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50">
                          {siblings.map(stu => {
                            const due         = Number(classFees[stu.cls] || 0);
                            const paid        = allTimePaidMapFC.feeMap[stu.id] || 0;
                            // Global Engine: getStuOutstanding (FULL — includes OB) ──
                            const outstanding = getStuOutstanding(stu, classFees, allTimePaidMapFC);
                            const st          = getStatus(stu);
                            return (
                              <tr key={stu.id} className="hover:bg-slate-50">
                                <td className="px-4 py-2">
                                  <div className="font-semibold text-gray-800">{stu.name}</div>
                                  <div className="text-xs text-gray-400">Roll: {stu.roll}</div>
                                </td>
                                <td className="px-4 py-2"><Badge color="blue">{stu.cls}</Badge></td>
                                <td className="px-4 py-2 text-gray-600">Rs. {due.toLocaleString()}</td>
                                <td className="px-4 py-2 font-semibold text-emerald-700">Rs. {paid.toLocaleString()}</td>
                                <td className="px-4 py-2 font-semibold text-red-600">{outstanding > 0 ? `Rs. ${outstanding.toLocaleString()}` : <span className="text-emerald-600">Cleared</span>}</td>
                                <td className="px-4 py-2">
                                  {st === 'paid'    && <Badge color="green">✓ Paid</Badge>}
                                  {st === 'partial' && <Badge color="orange">⏳ Partial</Badge>}
                                  {st === 'unpaid'  && <Badge color="red">✗ Unpaid</Badge>}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                );
              })
          }
        </div>
      )}

      {/* ── Family Split Payment Modal ── */}
      {familyMod && (
        <Modal title={`Family Split Payment — ${familyMod.familyKey}`} onClose={() => setFamilyMod(null)}>
          {/* Info header */}
          <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 mb-4">
            <p className="text-xs text-blue-500 font-semibold uppercase mb-1">👨‍👧‍👦 {familyMod.familyKey}</p>
            <p className="text-sm text-blue-700">{familyMod.siblings.length} siblings — Enter total amount and it will auto-distribute to each sibling's outstanding balance.</p>
          </div>
          {/* Month / Year */}
          <div className="flex gap-2 mb-1">
            <div className="flex-1">
              <Sel label="Month *" value={familyForm.month} onChange={e => setFamilyForm({...familyForm, month: Number(e.target.value)})}
                options={MONTHS.map((mo,i) => ({v:i, l:mo}))}/>
            </div>
            <div style={{width:90}}>
              <Sel label="Year" value={familyForm.year} onChange={e => setFamilyForm({...familyForm, year: Number(e.target.value)})}
                options={years.map(y => ({v:y, l:String(y)}))}/>
            </div>
          </div>
          {/* Total Amount */}
          <Inp label="Total Amount Received (Rs.) *" type="number" min="1"
            value={familyForm.totalAmount}
            onChange={e => setFamilyForm({...familyForm, totalAmount: e.target.value})}
            placeholder="Enter lump sum amount received from family"/>
          {/* Payment Method */}
          <div className="mb-3">
            <label className="block text-xs font-semibold text-gray-500 mb-1 uppercase tracking-wide">Payment Method *</label>
            <div className="flex flex-wrap gap-2">
              {PAYMENT_METHODS.map(m => (
                <label key={m} className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border-2 cursor-pointer text-sm font-semibold transition-all ${familyForm.paymentMethod===m?'border-blue-500 bg-blue-50 text-blue-700':'border-gray-200 text-gray-500 hover:border-gray-300'}`}>
                  <input type="radio" name="famMethod" value={m} checked={familyForm.paymentMethod===m} onChange={()=>setFamilyForm({...familyForm,paymentMethod:m})} className="hidden"/>
                  {m==='Cash'?'💵':m==='Bank Transfer'?'🏦':m==='JazzCash'?'📱':'💳'} {m}
                </label>
              ))}
            </div>
          </div>
          <Inp label="Note (optional)" value={familyForm.note}
            onChange={e => setFamilyForm({...familyForm, note: e.target.value})}
            placeholder="e.g. Monthly family payment"/>
          {/* Live Distribution Preview */}
          {(() => {
            const totalOutst = splitPreview.reduce((s,r)=>s+r.outstanding,0);
            const totalAlloc = splitPreview.reduce((s,r)=>s+r.allocate,0);
            const entered    = Number(familyForm.totalAmount);
            return (
              <div className="bg-purple-50 border border-purple-200 rounded-xl p-3 mb-4">
                {/* Family summary header */}
                <div className="mb-2 pb-2 border-b border-purple-200">
                  <p className="text-xs font-bold text-purple-700 uppercase">👨‍👧‍👦 {familyMod?.familyKey} — {familyMod?.siblings.length} children</p>
                  <div className="flex flex-wrap gap-3 mt-1 text-xs">
                    <span className="text-gray-600">Grand Due: <strong className="text-blue-700">Rs. {totalOutst.toLocaleString()}</strong></span>
                    <span className="text-gray-600">Paid: <strong className="text-emerald-600">Rs. {splitPreview.reduce((s,r)=>s+r.paid,0).toLocaleString()}</strong></span>
                    {entered > 0 && <span className="text-gray-600">Balance: <strong className="text-red-600">Rs. {Math.max(0, totalOutst - totalAlloc).toLocaleString()}</strong></span>}
                    <span className="text-xs text-gray-400">Fee: Rs. {splitPreview.reduce((s,r)=>s+r.due,0).toLocaleString()}</span>
                  </div>
                </div>
                <p className="text-xs font-semibold text-purple-600 uppercase mb-2">÷ Equal Split Preview</p>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-gray-500 font-semibold uppercase border-b border-purple-200">
                      <th className="text-left pb-1">Child</th>
                      <th className="text-right pb-1">Fee Due</th>
                      <th className="text-right pb-1">Already Paid</th>
                      <th className="text-right pb-1">Fee Share</th>
                      <th className="text-right pb-1">Balance After</th>
                    </tr>
                  </thead>
                  <tbody>
                    {splitPreview.map(r => (
                      <tr key={r.stu.id} className="border-t border-purple-100">
                        <td className="py-1.5 font-semibold text-gray-800">{r.stu.name} <span className="text-gray-400 font-normal text-xs">(Cls {r.stu.cls})</span></td>
                        <td className="py-1.5 text-right text-blue-700 font-semibold">Rs. {r.outstanding.toLocaleString()}</td>
                        <td className="py-1.5 text-right text-emerald-600 font-semibold">Rs. {r.paid.toLocaleString()}</td>
                        <td className={`py-1.5 text-right font-bold ${r.allocate > 0 ? 'text-purple-700' : 'text-gray-300'}`}>
                          {r.allocate > 0 ? `Rs. ${r.allocate.toLocaleString()}` : '—'}
                        </td>
                        <td className={`py-1.5 text-right font-bold text-xs ${r.balAfter > 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                          {r.balAfter > 0 ? `Rs. ${r.balAfter.toLocaleString()}` : entered > 0 ? '+Rs. ' + Math.abs(r.allocate - r.outstanding).toLocaleString() + ' Adv' : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="border-t-2 border-purple-300">
                    <tr>
                      <td className="pt-2 font-bold text-gray-700 text-xs">Total Collected:</td>
                      <td className="pt-2 text-right font-bold text-blue-700 text-xs">Rs. {totalOutst.toLocaleString()}</td>
                      <td className="pt-2 text-right font-bold text-emerald-600 text-xs">Rs. {splitPreview.reduce((s,r)=>s+r.paid,0).toLocaleString()}</td>
                      <td className="pt-2 text-right font-extrabold text-purple-700">Rs. {totalAlloc.toLocaleString()}</td>
                      <td className="pt-2 text-right font-bold text-red-600 text-xs">{totalAlloc > 0 && totalOutst > totalAlloc ? `Rs. ${(totalOutst-totalAlloc).toLocaleString()} left` : ''}</td>
                    </tr>
                  </tfoot>
                </table>
                {entered > totalOutst && (
                  <p className="text-xs text-amber-600 mt-2 font-semibold">⚠️ Amount exceeds total outstanding. Extra will not be recorded.</p>
                )}
              </div>
            );
          })()}
          <div className="flex gap-2">
            <Btn full variant="green" onClick={saveSplitPayment}>✅ Confirm & Save Split Payment</Btn>
            <Btn variant="outline" onClick={() => setFamilyMod(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {/* ── Receipt Success Modal ── */}
      {receipt && (() => {
        const { pay, stu } = receipt;
        return (
          <Modal title="Payment Recorded!" onClose={() => setReceipt(null)}>
            <div className="text-center mb-4">
              <div className="text-5xl mb-2">✅</div>
              <p className="font-bold text-emerald-700 text-lg">Payment Saved Successfully</p>
              <p className="text-gray-500 text-sm mt-1">{stu.name} — {MONTHS[pay.month]} {pay.year}</p>
              {pay.discount > 0 && (
                <div className="bg-amber-50 border border-amber-100 rounded-xl px-4 py-2 mt-2 inline-block">
                  <p className="text-amber-700 text-sm font-semibold">✓ Discount Applied: Rs. {Number(pay.discount).toLocaleString()}</p>
                </div>
              )}
              <p className="text-2xl font-bold text-gray-800 mt-2">Rs. {(Number(pay.amount)+Number(pay.annualFund||0)).toLocaleString()}</p>
              <p className="text-xs text-gray-400 mt-1 font-mono">{pay.rcpt}</p>
            </div>
            <div className="flex gap-2">
              <Btn full variant="blue" onClick={() => { printReceipt(pay, stu); setReceipt(null); }}>🖨️ Print Receipt</Btn>
              <Btn full variant="outline" onClick={() => setReceipt(null)}>Close</Btn>
            </div>
          </Modal>
        );
      })()}
    </div>
  );
}

// ── EXPENSES ─────────────────────────────────────────────────────────────────
function Expenses() {
  const { role } = React.useContext(UserContext);
  const isAdmin     = role === 'admin';
  const isPrincipal  = role === 'principal';
  const isAccountant = role === 'accountant';
  const canAdd       = isAdmin || isPrincipal || isAccountant;
  const canWrite    = isAdmin;                // only admin can edit/delete
  // Integrity guard at mount
  const [list, setList] = useState(() => getActiveList(K.EXP));
  const [form, setForm] = useState(null);
  const [delId, setDelId] = useState(null);
  const [fm, setFm] = useState(NOW.getMonth());
  const [fy, setFy] = useState(NOW.getFullYear());
  const years = Array.from({ length: 5 }, (_, i) => NOW.getFullYear() - 2 + i);

  const persist = (data) => { S.set(K.EXP, data); setList(data); };

  const save = () => {
    if (!form.title.trim()) return alert('Title is required.');
    if (!form.amount || Number(form.amount) <= 0) return alert('Enter a valid amount.');
    const item = { ...form, amount: Number(form.amount), paymentMethod: form.paymentMethod || 'Cash' };
    // ── Build Cash Book description (Advance Paid gets richer label) ──────
    const cbDesc = item.category === 'Advance Paid' && item.advanceName
      ? `Advance Paid to ${item.advanceName} [${item.advanceFor}] — ${item.title}`
      : `${item.title} (${item.category})`;
    const cbRefType = item.category === 'Advance Paid' ? 'advance' : undefined;

    if (!form.id) {
      // ── Global Engine: new expense — create linked Cash Book entry ─────
      const cbId = uid();
      item.cbEntryId = cbId;
      addCashBookEntry('expense', cbDesc,
        item.amount, item.paymentMethod, item.date, item.note, cbRefType, cbId);
      // v75-8: stamp creator on every new expense
      persist([...list, Object.assign({ ...item, id: uid() }, getCreator())]);
    } else {
      // ── Global Engine: edit — keep linked Cash Book entry in sync ──────
      if (item.cbEntryId) {
        S.set(K.CBOOK, S.get(K.CBOOK, []).map(e => e.id === item.cbEntryId
          ? { ...e,
              description: cbDesc,
              amount: item.amount,
              note: item.note || '',
              date: item.date ? item.date.slice(0, 10) : e.date }
          : e));
      }
      persist(list.map(e => e.id === form.id ? item : e));
    }
    setForm(null);
  };

  const filtered = list.filter(e => {
    const d = new Date(e.date);
    return d.getMonth() === fm && d.getFullYear() === fy;
  });
  // Phase 3: total counts ONLY real K.EXP entries — mirror rows are excluded
  //          to prevent double-counting vs. K.SPAY (Payroll) and K.VPAY (Vendor).
  const total = filtered.reduce((s, e) => s + Number(e.amount), 0);
  // Phase 3: Read-only mirror rows sourced from K.SPAY (Salary) and K.VPAY (Vendor).
  //          Displayed with clear badges. Users cannot edit/delete them from this
  //          page — those flows live in Staff & Salary and Books & Vendors.
  const _mirrorStaff = getActiveList(K.STAFF);
  const _mirrorVendors = getActiveList(K.VENDOR);
  const mirrorSpays = getActiveList(K.SPAY).filter(p => {
    const d = new Date(p.date); return d.getMonth() === fm && d.getFullYear() === fy;
  }).map(p => {
    const st = _mirrorStaff.find(s => s.id === p.staffId);
    return {
      id: 'MIR_SAL_' + p.id,
      _mirror: 'salary',
      date: p.date ? String(p.date).slice(0,10) : '',
      title: `Salary — ${st ? st.name : 'Staff'}${p.month != null ? ' (' + MONTHS[p.month] + ' ' + p.year + ')' : ''}`,
      category: 'Salary',
      amount: Number(p.amount || 0),
      note: p.note || '',
    };
  });
  const mirrorVpays = getActiveList(K.VPAY).filter(p => {
    const d = new Date(p.date); return d.getMonth() === fm && d.getFullYear() === fy;
  }).map(p => {
    const v = _mirrorVendors.find(vd => vd.id === p.vendorId);
    return {
      id: 'MIR_VEN_' + p.id,
      _mirror: 'vendor',
      date: p.date ? String(p.date).slice(0,10) : '',
      title: `Vendor Payment — ${v ? v.name : 'Vendor'}${p.rcpt ? ' [' + p.rcpt + ']' : ''}`,
      category: 'Vendor',
      amount: Number(p.amount || 0),
      note: p.note || '',
    };
  });

  // Integrity guard
  const payments = getActiveList(K.PAY);
  const monthFee = payments.filter(p => p.month === fm && p.year === fy).reduce((s,p) => s + Number(p.amount), 0);
  const net = monthFee - total;

  const CATS = ['Salary','Utilities','Maintenance','Stationery','Rent','Transport','Food','Advance Paid','Other'];

  const printExpenses = () => {
    const sorted = [...filtered].sort((a,b)=>new Date(a.date)-new Date(b.date));
    printPage(`Expenses — ${MONTHS[fm]} ${fy}`, `
      <h2>Daily Expenses — ${MONTHS[fm]} ${fy}</h2>
      <div class="summary">
        <div class="sum-card"><div class="val">Rs. ${monthFee.toLocaleString()}</div><div class="lbl">Fee Collected</div></div>
        <div class="sum-card"><div class="val">Rs. ${total.toLocaleString()}</div><div class="lbl">Total Expenses</div></div>
        <div class="sum-card"><div class="val">Rs. ${net.toLocaleString()}</div><div class="lbl">Net Balance</div></div>
      </div>
      <table><thead><tr><th>#</th><th>Date</th><th>Title</th><th>Category</th><th>Note</th><th>Amount (Rs.)</th></tr></thead>
      <tbody>${sorted.map((e,i)=>{
        const advLabel = e.category==='Advance Paid' && e.advanceName ? `<br/><span style="font-size:10px;color:#d97706">→ ${esc(e.advanceName)} (${esc(e.advanceFor||'')})</span>` : '';
        return `<tr><td>${i+1}</td><td>${new Date(e.date).toLocaleDateString('en-PK')}</td><td><b>${esc(e.title)}</b>${advLabel}</td><td><span class="badge ${e.category==='Advance Paid'?'b-yellow':'b-purple'}">${esc(e.category)}</span></td><td>${esc(e.note||'—')}</td><td>Rs. ${Number(e.amount).toLocaleString()}</td></tr>`;
      }).join('')}</tbody>
      <tfoot><tr><td colspan="5" style="text-align:right"><b>Total:</b></td><td><b>Rs. ${total.toLocaleString()}</b></td></tr></tfoot>
      </table>`);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-xl font-bold text-gray-800">Daily Expenses</h2>
        <div className="flex gap-2">
          <Btn variant="outline" onClick={printExpenses}>🖨️ Print</Btn>
          {canAdd && <Btn onClick={() => setForm({ title:'', amount:'', category:'Other', date: new Date().toISOString().slice(0,10), note:'', paymentMethod:'Cash', advanceFor:'', advanceName:'' })}>+ Add Expense</Btn>}
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <select value={fm} onChange={e => setFm(Number(e.target.value))} className={inputCls + ' w-auto'}>
          {MONTHS.map((mo,i) => <option key={i} value={i}>{mo}</option>)}
        </select>
        <select value={fy} onChange={e => setFy(Number(e.target.value))} className={inputCls + ' w-auto'}>
          {years.map(y => <option key={y}>{y}</option>)}
        </select>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-5">
        <Card className="p-4">
          <p className="text-xs text-gray-400 font-semibold uppercase mb-1">Fee Collected</p>
          <p className="text-lg font-bold text-emerald-700">Rs. {monthFee.toLocaleString()}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-gray-400 font-semibold uppercase mb-1">Total Expenses</p>
          <p className="text-lg font-bold text-red-600">Rs. {total.toLocaleString()}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-gray-400 font-semibold uppercase mb-1">Net Balance</p>
          <p className={`text-lg font-bold ${net >= 0 ? 'text-blue-700' : 'text-red-600'}`}>Rs. {net.toLocaleString()}</p>
        </Card>
      </div>

      {filtered.length === 0
        ? <Empty icon="🧾" text="No expenses recorded for this month." />
        : <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b">
                  <tr className="text-left text-xs text-gray-500 font-semibold uppercase">
                    <th className="px-4 py-3">Sr.</th>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Title</th>
                    <th className="px-4 py-3 hidden sm:table-cell">Category</th>
                    <th className="px-4 py-3 hidden sm:table-cell">Note</th>
                    <th className="px-4 py-3 text-right">Amount</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {[...filtered].sort((a,b) => new Date(b.date)-new Date(a.date)).map((e, idx) => (
                    <tr key={e.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 text-xs font-bold text-gray-400">{String(idx+1).padStart(2,'0')}</td>
                      <td className="px-4 py-3 text-gray-500 text-xs">{new Date(e.date).toLocaleDateString('en-PK')}</td>
                      <td className="px-4 py-3">
                        <span className="font-semibold text-gray-800">{e.title}</span>
                        {e.category === 'Advance Paid' && e.advanceName && (
                          <div className="text-xs text-amber-600 font-semibold mt-0.5">→ {e.advanceName} ({e.advanceFor})</div>
                        )}
                        {/* v75-8: creator badge — clear audit responsibility */}
                        {e.createdByName && <div className="text-[10px] text-blue-600 font-semibold mt-0.5">👤 {e.createdByName}</div>}
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell">
                        <Badge color={e.category === 'Advance Paid' ? 'yellow' : 'purple'}>{e.category}</Badge>
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell text-gray-400 text-xs">{e.note || '—'}</td>
                      <td className="px-4 py-3 text-right font-bold text-red-600">Rs. {Number(e.amount).toLocaleString()}</td>
                      <td className="px-4 py-3 text-right space-x-1">
                        {/* v75-8: Edit/Delete admin-only — accountant no longer permitted */}
                        {isAdmin && <Btn sm variant="outline" onClick={() => window.requireMasterCode(() => setForm({...e}), `Edit expense: ${e.title}`)}>Edit</Btn>}
                        {isAdmin && <Btn sm variant="red" onClick={() => window.requireMasterCode(() => setDelId(e.id), `Delete expense: ${e.title}`)}>Del</Btn>}
                        {!isAdmin && <span className="text-[10px] text-gray-300">view only</span>}
                      </td>
                    </tr>
                  ))}
                  {/* Phase 3: Read-only mirror rows — Salary & Vendor payments.
                      Distinct row styling + badges. Excluded from Total Expenses
                      to prevent double-counting with K.SPAY / K.VPAY. */}
                  {[...mirrorSpays, ...mirrorVpays].sort((a,b) => new Date(b.date)-new Date(a.date)).map((m, idx) => (
                    <tr key={m.id} className="bg-blue-50/40 hover:bg-blue-50/60">
                      <td className="px-4 py-3 text-xs font-bold text-gray-400">•</td>
                      <td className="px-4 py-3 text-xs text-gray-500">{m.date}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-block text-[10px] font-bold px-2 py-0.5 rounded-full mr-2 ${m._mirror === 'salary' ? 'bg-purple-100 text-purple-700' : 'bg-amber-100 text-amber-700'}`}>
                          {m._mirror === 'salary' ? '[Salary]' : '[Vendor]'}
                        </span>
                        <span className="font-semibold text-gray-700">{m.title}</span>
                        <div className="text-[10px] text-gray-400 italic mt-0.5">Read-only mirror — edit from {m._mirror === 'salary' ? 'Staff & Salary' : 'Books & Vendors'}</div>
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell">
                        <Badge color={m._mirror === 'salary' ? 'purple' : 'yellow'}>{m.category}</Badge>
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell text-gray-400 text-xs">{m.note || '—'}</td>
                      <td className="px-4 py-3 text-right font-bold text-gray-500">Rs. {m.amount.toLocaleString()}</td>
                      <td className="px-4 py-3 text-right"><span className="text-[10px] text-gray-300">mirror</span></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-gray-50 border-t-2 border-gray-200">
                  <tr>
                    <td colSpan="4" className="px-4 py-3 text-sm font-bold text-gray-600 text-right hidden sm:table-cell">Total Expenses (K.EXP only):</td>
                    <td colSpan="4" className="px-4 py-3 text-sm font-bold text-gray-600 text-right sm:hidden">Total:</td>
                    <td className="px-4 py-3 text-right font-extrabold text-red-600">Rs. {total.toLocaleString()}</td>
                    <td></td>
                  </tr>
                  {(mirrorSpays.length + mirrorVpays.length) > 0 && (
                    <tr className="bg-blue-50/40">
                      <td colSpan="5" className="px-4 py-2 text-xs text-gray-500 text-right italic">
                        Reference (mirrored, NOT included in total): Salary Rs. {mirrorSpays.reduce((s,x)=>s+x.amount,0).toLocaleString()} · Vendor Rs. {mirrorVpays.reduce((s,x)=>s+x.amount,0).toLocaleString()}
                      </td>
                      <td colSpan="2"></td>
                    </tr>
                  )}
                </tfoot>
              </table>
            </div>
          </Card>
      }

      {form && (
        <Modal title={form.id ? 'Edit Expense' : 'Add Expense'} onClose={() => setForm(null)}>
          <Inp label="Title *" value={form.title} onChange={e => setForm({...form, title: e.target.value})} placeholder="e.g. Electricity Bill"/>
          <Inp label="Amount (Rs.) *" type="number" min="1" value={form.amount} onChange={e => setForm({...form, amount: e.target.value})}/>
          <Sel label="Category" value={form.category} onChange={e => setForm({...form, category: e.target.value, advanceFor:'', advanceName:''})} options={CATS}/>

          {/* ── Advance Paid — who is it for? ── */}
          {form.category === 'Advance Paid' && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-3">
              <p className="text-xs font-bold text-amber-700 uppercase tracking-wide mb-2">💰 Advance Details</p>
              <Field label="Advance For *">
                <select value={form.advanceFor||''} onChange={e => setForm({...form, advanceFor: e.target.value, advanceName:''})} className={inputCls}>
                  <option value="">Select type…</option>
                  <option value="Staff">👩‍🏫 Staff Member</option>
                  <option value="Vendor">🏪 Vendor / Supplier</option>
                  <option value="Other">📋 Other</option>
                </select>
              </Field>
              {form.advanceFor === 'Staff' && (
                <Field label="Staff Member *">
                  <select value={form.advanceName||''} onChange={e => setForm({...form, advanceName: e.target.value})} className={inputCls}>
                    <option value="">Select staff member…</option>
                    {S.get(K.STAFF, []).filter(m => m.status !== 'left').map(m => (
                      <option key={m.id} value={m.name}>{m.name} — {m.role}</option>
                    ))}
                  </select>
                </Field>
              )}
              {form.advanceFor === 'Vendor' && (
                <Field label="Vendor / Supplier *">
                  <select value={form.advanceName||''} onChange={e => setForm({...form, advanceName: e.target.value})} className={inputCls}>
                    <option value="">Select vendor…</option>
                    {S.get(K.VENDOR, []).map(v => (
                      <option key={v.id} value={v.name}>{v.name}</option>
                    ))}
                  </select>
                </Field>
              )}
              {form.advanceFor === 'Other' && (
                <Inp label="Name / Description *" value={form.advanceName||''} onChange={e => setForm({...form, advanceName: e.target.value})} placeholder="Enter name or description"/>
              )}
              {form.advanceFor && form.advanceName && (
                <div className="flex items-center gap-2 bg-white border border-amber-300 rounded-xl px-3 py-2 text-xs text-amber-800 font-semibold">
                  ✅ Advance of Rs. {form.amount||'0'} → <strong>{form.advanceName}</strong> ({form.advanceFor})
                </div>
              )}
            </div>
          )}

          <Inp label="Date *" type="date" value={form.date} onChange={e => setForm({...form, date: e.target.value})}/>
          <Field label="Paid From (Account) *">
            <div className="flex flex-wrap gap-2">
              {PAYMENT_METHODS.map(m => (
                <label key={m} className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border-2 cursor-pointer text-sm font-semibold transition-all ${(form.paymentMethod||'Cash')===m?'border-red-500 bg-red-50 text-red-700':'border-gray-200 text-gray-500 hover:border-gray-300'}`}>
                  <input type="radio" name="expMethod" value={m} checked={(form.paymentMethod||'Cash')===m} onChange={()=>setForm({...form,paymentMethod:m})} className="hidden"/>
                  {m==='Cash'?'💵':m==='Bank Transfer'?'🏦':m==='JazzCash'?'📱':'💳'} {m}
                </label>
              ))}
            </div>
          </Field>
          <Inp label="Note (optional)" value={form.note} onChange={e => setForm({...form, note: e.target.value})} placeholder="Additional details"/>
          <div className="flex gap-2 mt-5">
            <Btn full onClick={save}>{form.id ? 'Update' : 'Save Expense'}</Btn>
            <Btn variant="outline" onClick={() => setForm(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {delId && (
        <Modal title="Delete Expense" onClose={() => setDelId(null)}>
          <p className="text-gray-600 mb-5">Delete <strong>{list.find(e=>e.id===delId)?.title}</strong>?</p>
          <div className="flex gap-2">
            <Btn full variant="red" onClick={() => {
              // ── Global Engine: remove linked Cash Book entry ────────────
              const toDelete = list.find(e => e.id === delId);
              if (toDelete?.cbEntryId) {
                S.set(K.CBOOK, S.get(K.CBOOK, []).filter(e => e.id !== toDelete.cbEntryId));
              }
              persist(list.filter(e => e.id !== delId));
              setDelId(null);
            }}>Delete</Btn>
            <Btn variant="outline" onClick={() => setDelId(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── FAMILY LEDGER ────────────────────────────────────────────────────────────
function FamilyLedger() {
  const { role } = React.useContext(UserContext);
  const isAdmin = role === 'admin';
  // Integrity guard: filter soft-deleted records at mount
  const [allStudents, setAllStudents] = useState(() => getActiveList(K.STU));
  const [allPayments, setAllPayments] = useState(() => getActiveList(K.PAY));
  const classFees = S.get(K.CF, {});

  const [selFamily, setSelFamily] = useState('');
  const [searchQ, setSearchQ] = useState('');
  const detailRef = React.useRef(null);
  const [vm, setVm] = useState(NOW.getMonth());
  const [vy, setVy] = useState(NOW.getFullYear());
  const [splitMod, setSplitMod] = useState(false); // family payment modal
  const [tab, setTab] = useState('fees');
  const [pf, setPf] = useState({ month: NOW.getMonth(), year: NOW.getFullYear(), totalAmount: '', annualFund: '', note: '', paymentMethod: 'Cash' });
  const [bookPayMod, setBookPayMod] = useState(null); // { stu } — Pay Books modal
  const [bpf, setBpf] = useState({ amount: '', paymentMethod: 'Cash', note: '' });
  const years = Array.from({ length: 5 }, (_, i) => NOW.getFullYear() - 2 + i);

  // Group by familyId (primary) → family name (fallback). Each group: { key, label, fid }
  const families = useMemo(() => {
    // ── Option A: only ACTIVE students form a family group. Families whose
    //    every child has left the school disappear from the ledger dropdown/list.
    const groups = {};
    allStudents.filter(isActiveStu).forEach(s => {
      const fid   = (s.familyId || '').trim();
      const fname = (s.family   || '').trim();
      const key   = fid || fname;
      if (!key) return;
      if (!groups[key]) groups[key] = { key, label: fname || fid, fid };
      if (fname) groups[key].label = fname; // prefer family name as display label
    });
    return Object.values(groups).sort((a, b) => {
      const an = parseInt(a.fid || a.key, 10);
      const bn = parseInt(b.fid || b.key, 10);
      if (!isNaN(an) && !isNaN(bn)) return an - bn;
      return (a.fid || a.key).localeCompare(b.fid || b.key) || a.label.localeCompare(b.label);
    });
  }, [allStudents]);

  // Sr. number map: group.key → sequential number (1-based, stable across search)
  const familySrMap = useMemo(() => {
    const map = {};
    families.forEach((g, i) => { map[g.key] = i + 1; });
    return map;
  }, [families]);

  // Search: find matching family by Sr. No, Family ID, label, Student Name, Father Name
  const filteredFamilies = useMemo(() => {
    if (!searchQ.trim()) return families;
    const q = searchQ.trim().toLowerCase();
    return families.filter(g => {
      const sibs = allStudents.filter(s => g.fid ? (s.familyId||'').trim() === g.fid : s.family === g.key);
      const sr   = String(familySrMap[g.key] || '');
      return (
        sr === q.replace(/^0+/, '') ||
        g.label.toLowerCase().includes(q) ||
        g.fid.toLowerCase().includes(q) ||
        sibs.some(s => (s.name||'').toLowerCase().includes(q)) ||
        sibs.some(s => (s.father||'').toLowerCase().includes(q))
      );
    });
  }, [searchQ, families, allStudents, familySrMap]);

  // All ACTIVE siblings in the selected group (matched by familyId if available, else family name)
  // ── Option A: exclude "left" students. Same rule as Fee Collection Family Payment. ──
  const familyStudents = useMemo(() => {
    if (!selFamily) return [];
    const group = families.find(g => g.key === selFamily);
    if (!group) return [];
    const base = group.fid
      ? allStudents.filter(s => (s.familyId||'').trim() === group.fid)
      : allStudents.filter(s => s.family === selFamily);
    return base.filter(isActiveStu);
  }, [allStudents, selFamily, families]);

  // Display label for the currently selected family
  const selFamilyLabel = families.find(g => g.key === selFamily)?.label || selFamily;

  // All payments for this family — June 2026 cutoff applied at the source so EVERY
  // downstream view (cards, history table, print ledger, monthly aggregates) is clean.
  // Pre-June test data and historic carry-forward never leak into the Family Ledger.
  const familyPayments = useMemo(() => {
    const ids = new Set(familyStudents.map(s => s.id));
    return allPayments.filter(p =>
      ids.has(p.stuId) &&
      (Number(p.year) > ENGINE_CUTOFF_YEAR || (Number(p.year) === ENGINE_CUTOFF_YEAR && Number(p.month) >= ENGINE_CUTOFF_MONTH))
    );
  }, [familyStudents, allPayments]);

  // Aggregate per-child payments for selected month — supports multiple (partial) payments
  const monthPaidMap = useMemo(() => {
    const map = {};
    familyPayments.filter(p => p.month === vm && p.year === vy).forEach(p => {
      if (!map[p.stuId]) map[p.stuId] = 0;
      map[p.stuId] += Number(p.amount || 0);
    });
    return map;
  }, [familyPayments, vm, vy]);

  // Annual Fund paid per child this month
  const monthAFPaidMap = useMemo(() => {
    const map = {};
    familyPayments.filter(p => p.month === vm && p.year === vy).forEach(p => {
      map[p.stuId] = (map[p.stuId] || 0) + Number(p.annualFund || 0);
    });
    return map;
  }, [familyPayments, vm, vy]);

  // Books paid per child — all-time via global engine (no manual loop)
  const booksPaidMap = useMemo(() => buildPaidMapsFromCutoff(familyPayments).booksMap, [familyPayments]);

  // Per-student: auto discount = classFee − stu.monthlyFee (if monthlyFee < classFee)
  const getStuAutoDisc = (st) => getStuDisc(st, classFees);

  // Per-child status — engine identity: (Class Fee − Discount) + Opening Balance
  const getChildStatus = (stu) => {
    const classFee = Number(classFees[stu.cls] || 0);
    const disc     = getStuAutoDisc(stu);
    const ob       = Number(stu.openingBalance || 0);
    const netDue   = Math.max(0, classFee - disc) + ob;
    const paid     = monthPaidMap[stu.id] || 0;
    if (paid <= 0)                    return 'unpaid';
    if (netDue > 0 && paid >= netDue) return 'paid';
    if (paid > netDue)                return 'advance';
    return 'partial';
  };

  // Family-level status
  const familyStatus = useMemo(() => {
    if (!familyStudents.length) return 'unpaid';
    const statuses = familyStudents.map(s => getChildStatus(s));
    if (statuses.every(s => s === 'paid' || s === 'advance')) return 'paid';
    if (statuses.some(s => s === 'paid' || s === 'partial' || s === 'advance')) return 'partial';
    return 'unpaid';
  }, [familyStudents, monthPaidMap, classFees]);
  // ── v73: Family totals from Majma (buildFamilySnapshot) — zero inline reduces.
  // Same engine the Dashboard, Fee Collection, and Student Ledger use, scoped
  // to this family's students. monthPaidMap/monthAFPaidMap retained because
  // they reflect SELECTED-MONTH paid amounts (snap returns all-time-paid map);
  // these are derived from the same K.PAY source.
  const famSnap               = buildFamilySnapshot(familyStudents, { vm, vy, payments: allPayments, classFees });
  const totalDue              = famSnap.feeGross;          // sum of class fees
  const totalDiscount         = famSnap.standingDisc;      // ↔ Dashboard "Discount"
  const totalActualMonthlyDue = famSnap.netFeeDue;         // ↔ Dashboard "Net Fee Due"
  const totalAFDue            = famSnap.afExpected;        // ↔ Dashboard "AF Expected"
  const netOutstandingEngine  = parseFloat(famSnap.totalDue.toFixed(2));
  const totalOpeningBalance   = famSnap.openingBalanceFam;
  // Family-specific roll-ups still derived locally (need per-family paid maps):
  const totalPaidMonth        = familyStudents.reduce((s, st) => s + (monthPaidMap[st.id]   || 0), 0);
  const totalAFPaid           = familyStudents.reduce((s, st) => s + (monthAFPaidMap[st.id] || 0), 0);
  const allTimePaid           = familyPayments.reduce((s, p) => s + Number(p.amount || 0), 0);
  const totalBalance          = Math.max(0, totalActualMonthlyDue - totalPaidMonth);
  const _flPaidMaps           = famSnap.paidMaps;          // same shape; kept name for downstream refs
  // grandTotal computed after getBookTotal is defined (see below, after bookLists state)

  // ── Equal Split Payment ──
  const openSplitPay = () => {
    setPf({ month: vm, year: vy, totalAmount: String(parseFloat((grandBalance || grandTotalDue).toFixed(2))), annualFund: '', note: '', paymentMethod: 'Cash' });
    setSplitMod(true);
  };

  const recordSplitPayment = () => {
    const total = Number(pf.totalAmount || 0);
    if (total <= 0) return alert('Enter a valid total amount.');
    const n = familyStudents.length;
    if (n === 0) return;

    const baseShare   = Math.floor((total / n) * 100) / 100;
    const remainder   = Math.round((total - baseShare * n) * 100) / 100;
    const af          = Number(pf.annualFund || 0);
    const baseAF      = Math.floor((af / n) * 100) / 100;
    const afRemainder = Math.round((af - baseAF * n) * 100) / 100;

    const famRcpt = 'FAM-' + Date.now().toString().slice(-6);
    const now     = new Date().toISOString();
    const newPays = familyStudents.map((stu, idx) => {
      const isLast     = idx === n - 1;
      const amount     = isLast ? Math.round((baseShare + remainder) * 100) / 100 : baseShare;
      const annualFund = isLast ? Math.round((baseAF + afRemainder) * 100) / 100 : baseAF;
      return {
        id: uid(), stuId: stu.id,
        month: Number(pf.month), year: Number(pf.year),
        amount, discount: 0,
        annualFund: af > 0 ? annualFund : 0,
        booksPaid: 0,
        note: pf.note ? `[Family Split] ${pf.note}` : '[Family Split]',
        paymentMethod: pf.paymentMethod || 'Cash',
        date: now,
        rcpt: `${famRcpt}-${idx+1}`,
        familyRcpt: famRcpt,
        familyTotal: total
      };
    });

    const updated = [...allPayments, ...newPays];
    S.set(K.PAY, updated);
    setAllPayments(updated);
    addCashBookEntry('income', `Family Fee — ${selFamily} (${MONTHS[Number(pf.month)]} ${Number(pf.year)})`, total + af, pf.paymentMethod, now, pf.note);
    setSplitMod(false);

    // Print family split receipt
    printSplitReceipt(newPays, total, af, famRcpt);
  };

  const openBookPay = (stu) => {
    const bkDue  = getBookTotal(stu);
    const bkPaid = booksPaidMap[stu.id] || 0;
    const bal    = Math.max(0, bkDue - bkPaid);
    setBpf({ amount: String(bal || bkDue), paymentMethod: 'Cash', note: '' });
    setBookPayMod(stu);
  };

  const recordBookPayment = () => {
    const stu = bookPayMod;
    const amt = Number(bpf.amount || 0);
    if (amt <= 0) return alert('Enter a valid amount.');
    const now = new Date().toISOString();
    const pay = {
      id: uid(), stuId: stu.id,
      month: NOW.getMonth(), year: NOW.getFullYear(),
      amount: 0, discount: 0, annualFund: 0, booksPaid: amt,
      note: bpf.note ? `[Books] ${bpf.note}` : '[Books Payment]',
      paymentMethod: bpf.paymentMethod,
      date: now, rcpt: 'BK-' + Date.now().toString().slice(-6),
    };
    const updated = [...allPayments, pay];
    S.set(K.PAY, updated);
    setAllPayments(updated);
    addCashBookEntry('income', `Books — ${stu.name} (${selFamily})`, amt, bpf.paymentMethod, now, bpf.note);
    setBookPayMod(null);
  };

  const printSplitReceipt = (pays, total, af, famRcpt) => {
    const rows = pays.map((p, i) => {
      const stu = familyStudents[i];
      return `<tr><td>${stu.name}</td><td>Class ${stu.cls}</td><td style="text-align:right">Rs. ${Number(classFees[stu.cls]||0).toLocaleString()}</td><td style="text-align:right"><b>Rs. ${Number(p.amount).toLocaleString()}</b></td>${af>0?`<td style="text-align:right">Rs. ${Number(p.annualFund).toLocaleString()}</td>`:''}</tr>`;
    }).join('');
    const n = pays.length;
    const win = window.open('', '_blank', 'width=500,height=680');
    if (!win) { alert('Popup blocked! Please allow popups for this site to print.'); return; }
    win.document.write(`<!DOCTYPE html><html><head><title>Family Payment</title>
      <style>
        body{font-family:'Segoe UI',Arial,sans-serif;padding:26px;max-width:460px;margin:0 auto;color:#1a1a1a}
        .logo-hdr{text-align:center;margin-bottom:10px;padding-bottom:10px;border-bottom:2px solid #c0392b}
        .logo-hdr img{height:60px;object-fit:contain}
        h2{text-align:center;color:#6d28d9;margin:6px 0 2px;font-size:16px;font-weight:800;letter-spacing:1px}
        .divider{border:none;border-top:1px dashed #d1d5db;margin:10px 0}
        .meta{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px}
        .label{font-size:10px;color:#6b7280;margin-bottom:2px;text-transform:uppercase}
        .value{font-size:12px;font-weight:600}
        table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}
        th{background:#6d28d9;color:#fff;padding:6px 10px;text-align:left;font-size:11px}
        td{padding:5px 10px;border-bottom:1px solid #f3f4f6}
        .split-info{background:#ede9fe;border:1px solid #c4b5fd;border-radius:8px;padding:8px 12px;font-size:11px;color:#5b21b6;margin:8px 0;text-align:center;font-weight:700}
        .total{display:flex;justify-content:space-between;align-items:center;background:#f5f3ff;padding:10px 14px;border-radius:8px;margin:10px 0}
        .total-label{font-size:13px;font-weight:700;color:#6d28d9}
        .total-val{font-size:22px;font-weight:800;color:#6d28d9}
        .footer{text-align:center;font-size:10px;color:#9ca3af;margin-top:10px}
        .dev-footer{text-align:center;margin-top:12px;padding-top:8px;border-top:1px solid #e5e7eb;font-size:8px;color:#9ca3af}
        @media print{body{padding:10px}button{display:none!important}}
      </style></head><body>
      <div class="logo-hdr"><img src="${LOGO_SRC}" alt="DISS" onerror="this.style.display='none'"/></div>
      <h2>FAMILY FEE RECEIPT</h2>
      <hr class="divider"/>
      <div class="meta">
        <div><div class="label">Family Receipt</div><div class="value">${famRcpt}</div></div>
        <div><div class="label">Date</div><div class="value">${new Date().toLocaleDateString('en-PK')}</div></div>
        <div><div class="label">Family</div><div class="value" style="color:#6d28d9;font-weight:700">${selFamilyLabel}</div></div>
        <div><div class="label">Month</div><div class="value">${MONTHS[Number(pays[0]?.month)]} ${pays[0]?.year}</div></div>
        <div><div class="label">Children</div><div class="value">${n}</div></div>
        <div><div class="label">Payment Method</div><div class="value">${pays[0]?.paymentMethod||'Cash'}</div></div>
      </div>
      <div class="split-info">÷ Equal Split: Rs. ${Number(total+af).toLocaleString()} ÷ ${n} children</div>
      <table>
        <thead><tr><th>Child</th><th>Class</th><th>Fee Due</th><th>Share Paid</th>${af>0?'<th>Annual Fund</th>':''}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="total">
        <span class="total-label">Total Family Payment</span>
        <span class="total-val">Rs. ${Number(total+af).toLocaleString()}</span>
      </div>
      ${af>0?`<div style="font-size:11px;color:#6b7280;margin-top:4px">Fee: Rs. ${Number(total).toLocaleString()} + Annual Fund: Rs. ${Number(af).toLocaleString()}</div>`:''}
      ${pays[0]?.note && pays[0].note !== '[Family Split]' ? `<p style="font-size:11px;color:#6b7280">Note: ${pays[0].note.replace('[Family Split] ','')}</p>` : ''}
      <hr class="divider"/>
      <p class="footer">Thank you for your payment!</p>
      ${getPrintAudit()}
      <div class="dev-footer">© 2026 DISS — All Rights Reserved &nbsp;|&nbsp; Powered by Tataheer Business Group &nbsp;|&nbsp; +923218555566</div>
      <script>window.onload=function(){window.print();}<\/script>
    </body></html>`);
    win.document.close();
  };

  const printIndividualReceipt = (pay, stu) => {
    const win = window.open('', '_blank', 'width=420,height=580');
    if (!win) { alert('Popup blocked! Please allow popups for this site to print.'); return; }
    win.document.write(`<!DOCTYPE html><html><head><title>Fee Receipt</title>
      <style>
        body{font-family:'Segoe UI',Arial,sans-serif;padding:26px;max-width:380px;margin:0 auto;color:#1a1a1a}
        .logo-hdr{text-align:center;margin-bottom:10px;padding-bottom:10px;border-bottom:2px solid #c0392b}
        .logo-hdr img{height:60px;object-fit:contain}
        h2{text-align:center;color:#c0392b;margin:6px 0 2px;font-size:16px;font-weight:800;letter-spacing:1px}
        .divider{border:none;border-top:1px dashed #d1d5db;margin:10px 0}
        .grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}
        .label{font-size:10px;color:#6b7280;margin-bottom:2px;text-transform:uppercase}
        .value{font-size:12px;font-weight:600}
        .family-tag{background:#ede9fe;color:#6d28d9;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:700}
        .total{display:flex;justify-content:space-between;align-items:center;background:#f0fdf4;padding:10px 14px;border-radius:8px;margin:10px 0}
        .total-label{font-size:13px;font-weight:700;color:#15803d}
        .total-val{font-size:20px;font-weight:800;color:#15803d}
        .footer{text-align:center;font-size:10px;color:#9ca3af;margin-top:10px}
        .dev-footer{text-align:center;margin-top:12px;padding-top:8px;border-top:1px solid #e5e7eb;font-size:8px;color:#9ca3af}
        @media print{body{padding:10px}button{display:none!important}}
      </style></head><body>
      <div class="logo-hdr"><img src="${LOGO_SRC}" alt="DISS" onerror="this.style.display='none'"/></div>
      <h2>FEE RECEIPT</h2>
      <hr class="divider"/>
      <div class="grid">
        <div><div class="label">Receipt No</div><div class="value">${pay.rcpt}</div></div>
        <div><div class="label">Date</div><div class="value">${new Date(pay.date).toLocaleDateString('en-PK')}</div></div>
        <div><div class="label">Student</div><div class="value">${stu.name}</div></div>
        <div><div class="label">Class</div><div class="value">${stu.cls} | Roll ${stu.roll}</div></div>
        <div><div class="label">Family</div><div class="value"><span class="family-tag">${stu.family||'—'}</span></div></div>
        <div><div class="label">Fee Month</div><div class="value">${MONTHS[pay.month]} ${pay.year}</div></div>
        <div><div class="label">Method</div><div class="value">${pay.paymentMethod||'Cash'}</div></div>
        ${pay.familyRcpt ? `<div><div class="label">Family Ref</div><div class="value" style="color:#6d28d9">${pay.familyRcpt}</div></div>` : ''}
        <div><div class="label">Collected By</div><div class="value" style="color:#1e40af;font-weight:700">${pay.createdByName || '—'}</div></div>
      </div>
      <hr class="divider"/>
      <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:12px"><span style="color:#6b7280">Amount Paid</span><span style="font-weight:700">Rs. ${Number(pay.amount).toLocaleString()}</span></div>
      ${pay.annualFund > 0 ? `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:12px"><span style="color:#6b7280">Annual Fund</span><span style="font-weight:600">Rs. ${Number(pay.annualFund).toLocaleString()}</span></div>` : ''}
      <div class="total">
        <span class="total-label">Total Paid</span>
        <span class="total-val">Rs. ${(Number(pay.amount)+Number(pay.annualFund||0)).toLocaleString()}</span>
      </div>
      ${(() => { const _n = cleanNoteForReceipt(pay.note); return _n ? `<p style="font-size:11px;color:#6b7280">Note: ${_n}</p>` : ''; })()}
      <hr class="divider"/>
      <p class="footer">Thank you for your payment!</p>
      ${getPrintAudit()}
      <div class="dev-footer">© 2026 DISS — All Rights Reserved &nbsp;|&nbsp; Powered by Tataheer Business Group &nbsp;|&nbsp; +923218555566</div>
      <script>window.onload=function(){window.print();}<\/script>
    </body></html>`);
    win.document.close();
  };

  // ── Book Lists ──
  const [bookLists, setBookLists] = useState(() => S.get(K.BL, {}));
  const [bookMod, setBookMod] = useState(null);
  const persistBooks = d => { S.set(K.BL, d); setBookLists(d); };
  const getBooksForStu = (stu) => bookLists[stu.id] || (DEFAULT_BOOKS[stu.cls] ? DEFAULT_BOOKS[stu.cls].map(b => ({...b})) : []);
  const getBookTotal   = (stu) => getBooksForStu(stu).reduce((s, b) => s + (Number(b.price||0) * Number(b.qty||0)), 0);
  const totalBooksDue  = familyStudents.reduce((s, st) => s + getBookTotal(st), 0);
  const totalBooksPaid = familyStudents.reduce((s, st) => s + (booksPaidMap[st.id] || 0), 0);
  const grandTotalDue  = totalDue + totalAFDue + totalBooksDue;
  const grandTotalPaid = totalPaidMonth + totalAFPaid + totalBooksPaid;
  const netOutstanding = netOutstandingEngine;
  const grandBalance   = netOutstandingEngine;
  const openBookEdit = (stu) => setBookMod({ stu, books: getBooksForStu(stu).map(b => ({...b})) });
  const saveBooks = () => {
    const oldBooks = bookLists[bookMod.stu.id] || [];
    const newBooks = bookMod.books;
    // ── Global Engine: auto-deduct / restore inventory when book list changes ──
    const invItems = S.get(K.INV, []);
    let invChanged = false;
    const updatedInv = invItems.map(item => {
      const oldB = oldBooks.find(b => (b.name||'').trim().toLowerCase() === (item.name||'').trim().toLowerCase());
      const newB = newBooks.find(b => (b.name||'').trim().toLowerCase() === (item.name||'').trim().toLowerCase());
      const oldQty = oldB ? Number(oldB.qty || 0) : 0;
      const newQty = newB ? Number(newB.qty || 0) : 0;
      const delta  = newQty - oldQty; // positive → more assigned → deduct stock
      if (delta === 0) return item;
      invChanged = true;
      return { ...item, qty: Math.max(0, Number(item.qty || 0) - delta) }; // negative delta = return to stock
    });
    if (invChanged) S.set(K.INV, updatedInv);
    persistBooks({ ...bookLists, [bookMod.stu.id]: bookMod.books });
    setBookMod(null);
  };
  const updateBook = (idx, field, val) => setBookMod({ ...bookMod, books: bookMod.books.map((b, i) => i === idx ? {...b, [field]: field==='name'?val:Number(val)} : b) });
  const addBook = () => setBookMod({ ...bookMod, books: [...bookMod.books, { name:'', qty:1, price:0 }] });
  const removeBook = (idx) => setBookMod({ ...bookMod, books: bookMod.books.filter((_,i) => i !== idx) });

  // ── Print: Full family ledger ──
  const printFamily = () => {
    if (!selFamily) return alert('Please select a family first.');
    const childRows = familyStudents.map((stu, i) => {
      const due    = Number(classFees[stu.cls]||0);
      const paid   = monthPaidMap[stu.id] || 0;
      // ── Global Engine: getStuOutstanding (FULL — includes OB) ──
      const bal    = getStuOutstanding(stu, classFees, _flPaidMaps);
      const status = getChildStatus(stu);
      const statusLabel = status==='paid'?'Paid':status==='advance'?'Advance':status==='partial'?'Partial':'Unpaid';
      const statusColor = status==='paid'||status==='advance'?'b-green':status==='partial'?'b-yellow':'b-red';
      return `<tr><td>${i+1}</td><td><b>${stu.name}</b></td><td>${stu.cls}</td><td>${stu.roll}</td><td style="text-align:right">Rs. ${due.toLocaleString()}</td><td style="text-align:right">Rs. ${paid.toLocaleString()}</td><td style="text-align:right">${bal>0?`Rs. ${bal.toLocaleString()}`:'—'}</td><td><span class="badge ${statusColor}">${statusLabel}</span></td></tr>`;
    }).join('');
    const histRows = [...familyPayments].sort((a,b)=>new Date(b.date)-new Date(a.date)).map(p=>{
      const s = allStudents.find(x=>x.id===p.stuId);
      return `<tr><td>${p.rcpt}</td><td>${s?.name||'—'}</td><td>${MONTHS[p.month]} ${p.year}</td><td style="text-align:right">Rs. ${Number(p.amount).toLocaleString()}</td><td>${p.paymentMethod||'Cash'}</td><td>${new Date(p.date).toLocaleDateString('en-PK')}</td></tr>`;
    }).join('');
    printPage(`Family Ledger — ${selFamilyLabel}`, `
      <h2>Family Ledger — ${selFamilyLabel} &nbsp;|&nbsp; ${MONTHS[vm]} ${vy}</h2>
      <div class="summary">
        <div class="sum-card"><div class="val">${familyStudents.length}</div><div class="lbl">Children</div></div>
        <div class="sum-card"><div class="val">Rs. ${totalDue.toLocaleString()}</div><div class="lbl">Total Due</div></div>
        <div class="sum-card"><div class="val">Rs. ${totalPaidMonth.toLocaleString()}</div><div class="lbl">Total Paid</div></div>
        <div class="sum-card"><div class="val">Rs. ${totalBalance.toLocaleString()}</div><div class="lbl">Balance</div></div>
        <div class="sum-card"><div class="val">Rs. ${allTimePaid.toLocaleString()}</div><div class="lbl">All-Time Paid</div></div>
      </div>
      <h2>Per Child — ${MONTHS[vm]} ${vy}</h2>
      <table><thead><tr><th>#</th><th>Student</th><th>Class</th><th>Roll</th><th style="text-align:right">Fee Due</th><th style="text-align:right">Paid</th><th style="text-align:right">Balance</th><th>Status</th></tr></thead>
      <tbody>${childRows}</tbody>
      <tfoot><tr><td colspan="4" style="text-align:right"><b>Total</b></td><td style="text-align:right"><b>Rs. ${totalDue.toLocaleString()}</b></td><td style="text-align:right"><b>Rs. ${totalPaidMonth.toLocaleString()}</b></td><td style="text-align:right"><b>${totalBalance>0?`Rs. ${totalBalance.toLocaleString()}`:'Cleared'}</b></td><td></td></tr></tfoot>
      </table>
      <br/><h2>All-Time Payment History</h2>
      <table><thead><tr><th>Receipt</th><th>Student</th><th>Month</th><th style="text-align:right">Amount</th><th>Method</th><th>Date</th></tr></thead>
      <tbody>${histRows}</tbody>
      <tfoot><tr><td colspan="3" style="text-align:right"><b>Grand Total Paid:</b></td><td style="text-align:right"><b>Rs. ${allTimePaid.toLocaleString()}</b></td><td colspan="2"></td></tr></tfoot>
      </table>`);
  };

  const printBookRequirements = () => {
    if (!selFamily) return alert('Please select a family first.');
    const sections = familyStudents.map(stu => {
      const books = getBooksForStu(stu);
      const total = books.reduce((s, b) => s + Number(b.qty)*Number(b.price), 0);
      const rows = books.map((b,i) => `<tr><td>${i+1}</td><td>${b.name}</td><td style="text-align:center">${b.qty}</td><td style="text-align:right">Rs. ${Number(b.price).toLocaleString()}</td><td style="text-align:right">Rs. ${(Number(b.qty)*Number(b.price)).toLocaleString()}</td></tr>`).join('');
      return `<div style="margin-bottom:28px;page-break-inside:avoid">
        <div style="background:#1e3a8a;color:#fff;padding:8px 14px;border-radius:8px 8px 0 0;display:flex;justify-content:space-between;align-items:center">
          <div><span style="font-size:14px;font-weight:700">${stu.name}</span><span style="font-size:11px;margin-left:10px;opacity:.8">S/O ${stu.father||'—'}</span></div>
          <span style="font-size:12px;background:rgba(255,255,255,.2);padding:2px 10px;border-radius:20px">Class ${stu.cls} | Roll ${stu.roll}</span>
        </div>
        <table><thead><tr><th>#</th><th>Book/Subject</th><th style="text-align:center">Qty</th><th style="text-align:right">Price</th><th style="text-align:right">Total</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td colspan="4" style="text-align:right"><b>Subtotal:</b></td><td style="text-align:right"><b>Rs. ${total.toLocaleString()}</b></td></tr></tfoot></table>
      </div>`;
    }).join('');
    const grandTotal = familyStudents.reduce((s,stu)=>s+getBooksForStu(stu).reduce((t,b)=>t+Number(b.qty)*Number(b.price),0),0);
    const win = window.open('', '_blank', 'width=900,height=700');
    if (!win) { alert('Popup blocked! Please allow popups for this site to print.'); return; }
    win.document.write(`<!DOCTYPE html><html><head><title>Book Requirements — ${selFamilyLabel}</title>
      <style>*{box-sizing:border-box}body{font-family:'Segoe UI',Arial,sans-serif;padding:28px;color:#1a1a1a;font-size:12px}
      table{width:100%;border-collapse:collapse}th{background:#1e3a8a;color:#fff;padding:7px 10px;text-align:left;font-size:11px;text-transform:uppercase}
      td{padding:6px 10px;border-bottom:1px solid #e5e7eb}tr:nth-child(even) td{background:#f8fafc}tfoot td{background:#f1f5f9;font-weight:700}
      .school-hdr{text-align:center;margin-bottom:18px;padding-bottom:12px;border-bottom:2px solid #1e3a8a}
      .grand{background:#f0fdf4;border:2px solid #16a34a;border-radius:8px;padding:10px 16px;text-align:right;margin-top:8px;font-size:14px;font-weight:700;color:#15803d}
      @media print{body{padding:14px}button{display:none!important}}</style></head><body>
      <div class="school-hdr"><h1 style="margin:0;font-size:20px;color:#1e3a8a;font-weight:800">Discovery International School System</h1>
      <p style="margin:4px 0 0;font-size:11px;color:#6b7280">Wagha Road, Jallo More, Lahore | +92 (322) 8555566</p></div>
      <h2 style="color:#6d28d9;margin:0 0 16px">📚 Book Requirements — ${selFamilyLabel}</h2>
      ${sections}
      <div class="grand">Grand Total (All Children): Rs. ${grandTotal.toLocaleString()}</div>
      <script>window.onload=function(){window.print();}<\/script></body></html>`);
    win.document.close();
  };

  // Split preview for modal
  const splitPreview = useMemo(() => {
    const total = Number(pf.totalAmount || 0);
    const n = familyStudents.length;
    if (!n || total <= 0) return [];
    const base = Math.floor((total / n) * 100) / 100;
    const rem  = Math.round((total - base * n) * 100) / 100;
    const af   = Number(pf.annualFund || 0);
    const baseAF = Math.floor((af / n) * 100) / 100;
    const afRem  = Math.round((af - baseAF * n) * 100) / 100;
    return familyStudents.map((stu, idx) => ({
      stu,
      share: idx === n-1 ? Math.round((base + rem)*100)/100 : base,
      afShare: af > 0 ? (idx === n-1 ? Math.round((baseAF + afRem)*100)/100 : baseAF) : 0,
      // ── Engine identity: due = (Class Fee − Discount) + Opening Balance ──
      due: Math.max(0, Number(classFees[stu.cls] || 0) - getStuAutoDisc(stu)) + Number(stu.openingBalance || 0),
      alreadyPaid: monthPaidMap[stu.id] || 0,
    }));
  }, [pf.totalAmount, pf.annualFund, familyStudents, classFees, monthPaidMap]);

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xl font-bold text-gray-800">Family Ledger</h2>
        <div className="flex gap-2">
          <Btn variant="outline" onClick={printFamily}>🖨️ Fee Ledger</Btn>
          <Btn variant="yellow" onClick={printBookRequirements}>📚 Print Books</Btn>
        </div>
      </div>
      <p className="text-sm text-gray-400 mb-4">Family-level fee management with equal split payment distribution.</p>

      {families.length === 0 ? (
        <Empty icon="👨‍👩‍👧‍👦" text='No family groups yet. Edit students and fill in "Family Name" to link siblings together.'/>
      ) : (
        <>
          {/* Search Bar */}
          <div className="relative mb-4">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-lg">🔍</span>
            <input
              className="w-full pl-10 pr-4 py-2 border-2 border-gray-200 rounded-xl text-sm focus:outline-none focus:border-purple-400 bg-white"
              placeholder="Search by Sr. No, Family ID, Student Name, or Father Name..."
              value={searchQ}
              onChange={e => { setSearchQ(e.target.value); setSelFamily(''); }}
            />
            {searchQ && <button onClick={() => setSearchQ('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-lg">×</button>}
          </div>

          <div className="flex flex-wrap gap-2 mb-4">
            {filteredFamilies.length === 0 && <p className="text-sm text-gray-400 italic">No families match your search.</p>}
            {filteredFamilies.map(g => {
              const sr = familySrMap[g.key] || '';
              return (
                <button key={g.key} onClick={() => { setSelFamily(g.key); setSearchQ(''); setTimeout(() => detailRef.current && detailRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100); }}
                  className={`px-3 py-2 rounded-xl text-sm font-bold border-2 transition-all flex items-center gap-2 ${selFamily===g.key?'bg-purple-600 border-purple-600 text-white shadow':'bg-white border-gray-200 text-gray-600 hover:border-purple-400'}`}>
                  <span className={`text-xs font-extrabold px-1.5 py-0.5 rounded-lg ${selFamily===g.key?'bg-white/20 text-white':'bg-purple-100 text-purple-700'}`}>{String(sr).padStart(2,'0')}</span>
                  👨‍👩‍👧‍👦 {g.label}
                  {g.fid ? <span className="text-xs opacity-60">{g.fid}</span> : ''}
                </button>
              );
            })}
          </div>

          {selFamily && (
            <div ref={detailRef}>
              {/* Tabs */}
              <div className="flex gap-1 bg-gray-100 p-1 rounded-xl w-fit mb-5">
                {[['fees','💰 Fee Ledger'],['books','📚 Books']].map(([k,l]) => (
                  <button key={k} onClick={() => setTab(k)}
                    className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${tab===k?'bg-white shadow text-purple-700':'text-gray-500 hover:text-gray-700'}`}>{l}</button>
                ))}
              </div>

              {/* ── FEE TAB ── */}
              {tab === 'fees' && (
                <>
                  {/* Month/Year + Pay button */}
                  <div className="flex flex-wrap gap-2 mb-4 items-center">
                    <select value={vm} onChange={e => setVm(Number(e.target.value))} className={inputCls+' w-auto'}>
                      {MONTHS.map((mo,i) => <option key={i} value={i}>{mo}</option>)}
                    </select>
                    <select value={vy} onChange={e => setVy(Number(e.target.value))} className={inputCls+' w-auto'}>
                      {years.map(y => <option key={y}>{y}</option>)}
                    </select>
                    <Btn variant="purple" onClick={openSplitPay}>÷ Pay Family (Equal Split)</Btn>
                  </div>

                  {/* Family summary — children count only */}
                  <div className="flex items-center gap-3 mb-4">
                    <span className="bg-purple-100 text-purple-700 font-bold px-4 py-2 rounded-xl text-sm">👨‍👩‍👧‍👦 {familyStudents.length} Children</span>
                  </div>

                  {/* Combined Family Calculation Box */}
                  <div className="bg-gradient-to-r from-purple-50 to-blue-50 border-2 border-purple-200 rounded-2xl p-4 mb-5">
                    <h4 className="font-bold text-purple-800 text-sm mb-3">🧮 Combined Family Outstanding — All Siblings</h4>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
                      <div className="bg-white rounded-xl p-3 border border-orange-100">
                        <div className="text-xs text-gray-500 uppercase font-semibold mb-1">Opening Balance</div>
                        <div className="text-lg font-bold text-orange-600">Rs. {totalOpeningBalance.toLocaleString()}</div>
                      </div>
                      <div className="bg-white rounded-xl p-3 border border-blue-100">
                        <div className="text-xs text-gray-500 uppercase font-semibold mb-1">+ Monthly Fee</div>
                        <div className="text-lg font-bold text-blue-700">Rs. {totalActualMonthlyDue.toLocaleString()}</div>
                        {totalDiscount > 0 && <div className="text-xs text-emerald-600 mt-0.5">after −Rs. {totalDiscount.toLocaleString()} disc</div>}
                      </div>
                      <div className="bg-white rounded-xl p-3 border border-emerald-100">
                        <div className="text-xs text-gray-500 uppercase font-semibold mb-1">− Total Paid</div>
                        <div className="text-lg font-bold text-emerald-700">Rs. {allTimePaid.toLocaleString()}</div>
                      </div>
                      <div className={`rounded-xl p-3 border-2 ${netOutstanding>0?'bg-red-50 border-red-300':'bg-emerald-50 border-emerald-300'}`}>
                        <div className="text-xs text-gray-500 uppercase font-semibold mb-1">= Net Due</div>
                        <div className={`text-xl font-extrabold ${netOutstanding>0?'text-red-700':'text-emerald-700'}`}>{netOutstanding>0?`Rs. ${netOutstanding.toLocaleString()}`:'✓ Cleared'}</div>
                      </div>
                    </div>
                    {familyStudents.length > 1 && (
                      <div className="mt-3 pt-3 border-t border-purple-100 flex flex-wrap gap-3">
                        {familyStudents.map(st => {
                          const stDisc = getStuAutoDisc(st);
                          const stOB   = Number(st.openingBalance||0);
                          const stNetDue = Math.max(0, Number(classFees[st.cls]||0) - stDisc) + stOB;
                          const stPaid = familyPayments.filter(p => p.stuId===st.id).reduce((s,p)=>s+Number(p.amount||0),0);
                          const stBal  = Math.max(0, stNetDue - stPaid);
                          return (
                            <div key={st.id} className="flex items-center gap-2 bg-white rounded-lg px-3 py-1.5 border border-gray-100 text-xs">
                              <span className="font-semibold text-gray-700">{st.name}</span>
                              <span className="text-gray-400">|</span>
                              {stOB > 0 && <span className="text-orange-500">OB: Rs. {stOB.toLocaleString()}</span>}
                              <span className="text-blue-600">Fee: Rs. {Math.max(0,Number(classFees[st.cls]||0)-stDisc).toLocaleString()}{stDisc>0&&<span className="text-emerald-500"> (−{stDisc})</span>}</span>
                              <span className="text-emerald-600">Paid: Rs. {stPaid.toLocaleString()}</span>
                              <span className={`font-bold ${stBal>0?'text-red-600':'text-emerald-600'}`}>{stBal>0?`Due: Rs. ${stBal.toLocaleString()}`:'✓'}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Per-child status table */}
                  <Card className="overflow-hidden mb-5">
                    <div className="px-5 py-3 bg-purple-50 border-b border-purple-100 flex items-center justify-between">
                      <h3 className="font-bold text-purple-800 text-sm">📋 {MONTHS[vm]} {vy} — Per Child Status</h3>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50 border-b">
                          <tr className="text-left text-xs text-gray-500 font-semibold uppercase">
                            <th className="px-4 py-3">Student</th>
                            <th className="px-4 py-3">Class</th>
                            <th className="px-4 py-3 text-right text-orange-600">Opening Bal</th>
                            <th className="px-4 py-3 text-right">Fee Due</th>
                            <th className="px-4 py-3 text-right text-purple-600">Ann. Fund</th>
                            <th className="px-4 py-3 text-right text-amber-600">Books Due</th>
                            <th className="px-4 py-3 text-right text-amber-700">Bk Paid</th>
                            <th className="px-4 py-3 text-right">Fee Paid</th>
                            <th className="px-4 py-3 text-right text-purple-600">AF Paid</th>
                            <th className="px-4 py-3 text-right">Balance</th>
                            <th className="px-4 py-3">Status</th>
                            <th className="px-4 py-3 text-right">Receipts</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50">
                          {familyStudents.map(stu => {
                            const due      = Number(classFees[stu.cls] || 0);
                            const paid     = monthPaidMap[stu.id] || 0;
                            const afDue    = Number(stu.annualFund || 0);
                            const afPaid   = monthAFPaidMap[stu.id] || 0;
                            const bkTotal  = getBookTotal(stu);
                            const bkPaid2  = booksPaidMap[stu.id] || 0;
                            const autoDisc = getStuAutoDisc(stu);
                            const obStu    = Number(stu.openingBalance || 0);
                            const stuNetDue = Math.max(0, due - autoDisc) + obStu;
                            const stuAllPaid = familyPayments.filter(p => p.stuId === stu.id).reduce((s, p) => s + Number(p.amount||0), 0);
                            const bal      = stuNetDue - stuAllPaid;
                            const status   = getChildStatus(stu);
                            const stuMonthPays = familyPayments.filter(p => p.stuId===stu.id && p.month===vm && p.year===vy);
                            return (
                              <tr key={stu.id} className="hover:bg-slate-50">
                                <td className="px-4 py-3 font-semibold text-gray-800">{stu.name}</td>
                                <td className="px-4 py-3"><Badge color="blue">{stu.cls}</Badge></td>
                                <td className="px-4 py-3 text-right font-semibold text-orange-600">{Number(stu.openingBalance||0)>0?`Rs. ${Number(stu.openingBalance).toLocaleString()}`:<span className="text-gray-300">—</span>}</td>
                                <td className="px-4 py-3 text-right text-gray-600">Rs. {due.toLocaleString()}</td>
                                <td className="px-4 py-3 text-right text-purple-600 font-semibold">{afDue > 0 ? `Rs. ${afDue.toLocaleString()}` : <span className="text-gray-300">—</span>}</td>
                                <td className="px-4 py-3 text-right text-amber-600 font-semibold">
                                  {bkTotal > 0 ? `Rs. ${bkTotal.toLocaleString()}` : <span className="text-gray-300">—</span>}
                                </td>
                                <td className="px-4 py-3 text-right font-semibold text-amber-700">
                                  {bkPaid2 > 0
                                    ? <span className={bkPaid2 >= bkTotal ? 'text-emerald-600' : 'text-amber-700'}>Rs. {bkPaid2.toLocaleString()}{bkPaid2 >= bkTotal && <span className="ml-1 text-xs">✓</span>}</span>
                                    : <span className="text-gray-300">—</span>}
                                </td>
                                <td className="px-4 py-3 text-right font-bold text-emerald-700">Rs. {paid.toLocaleString()}</td>
                                <td className="px-4 py-3 text-right font-semibold text-purple-700">{afPaid > 0 ? `Rs. ${afPaid.toLocaleString()}` : <span className="text-gray-300">—</span>}</td>
                                <td className="px-4 py-3 text-right">
                                  {status==='advance' ? <span className="text-blue-600 font-semibold text-xs">+Rs. {Math.abs(bal).toLocaleString()} Adv</span>
                                   : bal > 0 ? <span className="text-red-600 font-semibold">Rs. {bal.toLocaleString()}</span>
                                   : <span className="text-emerald-600 font-semibold">—</span>}
                                </td>
                                <td className="px-4 py-3">
                                  {status==='paid'    && <Badge color="green">✓ Paid</Badge>}
                                  {status==='advance' && <Badge color="blue">↑ Advance</Badge>}
                                  {status==='partial' && <Badge color="orange">⏳ Partial</Badge>}
                                  {status==='unpaid'  && <Badge color="red">✗ Unpaid</Badge>}
                                </td>
                                <td className="px-4 py-3 text-right">
                                  {stuMonthPays.map(p => (
                                    <Btn key={p.id} sm variant="outline" onClick={() => printIndividualReceipt(p, stu)}>🖨️ {p.rcpt}</Btn>
                                  ))}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                        <tfoot className="border-t-2 border-purple-200">
                          <tr className="bg-purple-50">
                            <td colSpan="2" className="px-4 py-2.5 font-bold text-purple-800 text-sm">Fee Subtotal</td>
                            <td className="px-4 py-2.5 text-right font-bold text-orange-600">Rs. {totalOpeningBalance.toLocaleString()}</td>
                            <td className="px-4 py-2.5 text-right font-bold text-blue-700">Rs. {totalDue.toLocaleString()}</td>
                            <td className="px-4 py-2.5 text-right font-semibold text-purple-600">Rs. {totalAFDue.toLocaleString()}</td>
                            <td className="px-4 py-2.5 text-right font-semibold text-amber-600">{totalBooksDue > 0 ? `Rs. ${totalBooksDue.toLocaleString()}` : '—'}</td>
                            <td className="px-4 py-2.5 text-right font-semibold text-amber-700">{totalBooksPaid > 0 ? `Rs. ${totalBooksPaid.toLocaleString()}` : '—'}</td>
                            <td className="px-4 py-2.5 text-right font-bold text-emerald-700">Rs. {allTimePaid.toLocaleString()}</td>
                            <td className="px-4 py-2.5 text-right font-semibold text-purple-700">Rs. {totalAFPaid.toLocaleString()}</td>
                            <td className="px-4 py-2.5 text-right font-bold text-red-600">{netOutstanding>0?`Rs. ${netOutstanding.toLocaleString()}`:'—'}</td>
                            <td colSpan="2"></td>
                          </tr>
                          <tr className="bg-purple-100 border-t border-purple-200">
                            <td colSpan="2" className="px-4 py-3 font-extrabold text-purple-900 text-sm">🧾 Net Outstanding</td>
                            <td colSpan="2" className="px-4 py-3 text-right font-extrabold text-orange-700">Opening: Rs. {totalOpeningBalance.toLocaleString()}</td>
                            <td colSpan="3" className="px-4 py-3 text-right font-extrabold text-blue-800">+ Monthly: Rs. {totalActualMonthlyDue.toLocaleString()}</td>
                            <td colSpan="2" className="px-4 py-3 text-right font-extrabold text-emerald-800">− Paid: Rs. {allTimePaid.toLocaleString()}</td>
                            <td className="px-4 py-3 text-right font-extrabold text-red-700">{netOutstanding>0?`Rs. ${netOutstanding.toLocaleString()} Due`:'✓ Cleared'}</td>
                            <td colSpan="2"></td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </Card>

                  {/* All-time payment history */}
                  <Card className="overflow-hidden">
                    <div className="px-5 py-3 bg-gray-50 border-b flex items-center justify-between">
                      <h3 className="font-bold text-gray-700 text-sm">🕐 All-Time Payment History</h3>
                      <span className="text-sm font-bold text-emerald-700">Total: Rs. {allTimePaid.toLocaleString()}</span>
                    </div>
                    {familyPayments.length === 0
                      ? <p className="text-center text-gray-400 py-6 text-sm">No payments recorded yet.</p>
                      : <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead className="bg-gray-50 border-b">
                              <tr className="text-left text-xs text-gray-500 font-semibold uppercase">
                                <th className="px-4 py-3">Receipt</th>
                                <th className="px-4 py-3">Student</th>
                                <th className="px-4 py-3">Month</th>
                                <th className="px-4 py-3 text-right">Amount</th>
                                <th className="px-4 py-3">Method</th>
                                <th className="px-4 py-3 hidden sm:table-cell">Date</th>
                                <th className="px-4 py-3 text-right">Print</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50">
                              {[...familyPayments].sort((a,b)=>new Date(b.date)-new Date(a.date)).map(p => {
                                const stu = allStudents.find(s => s.id === p.stuId);
                                return (
                                  <tr key={p.id} className={`hover:bg-slate-50 ${p.familyRcpt?'bg-purple-50/30':''}`}>
                                    <td className="px-4 py-3 font-mono text-xs text-gray-500">
                                      {p.rcpt}
                                      {p.familyRcpt && <div className="text-purple-500 text-xs">÷ {p.familyRcpt}</div>}
                                    </td>
                                    <td className="px-4 py-3 font-semibold text-gray-800">{stu?.name}</td>
                                    <td className="px-4 py-3">{MONTHS[p.month]} {p.year}</td>
                                    <td className="px-4 py-3 text-right font-bold text-emerald-700">Rs. {Number(p.amount).toLocaleString()}</td>
                                    <td className="px-4 py-3"><Badge color={p.paymentMethod==='Bank Transfer'?'blue':p.paymentMethod==='JazzCash'||p.paymentMethod==='Easypaisa'?'purple':'green'}>{p.paymentMethod||'Cash'}</Badge></td>
                                    <td className="px-4 py-3 text-gray-400 text-xs hidden sm:table-cell">{new Date(p.date).toLocaleDateString('en-PK')}</td>
                                    <td className="px-4 py-3 text-right">
                                      {stu && <Btn sm variant="outline" onClick={() => printIndividualReceipt(p, stu)}>🖨️</Btn>}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                    }
                  </Card>
                </>
              )}

              {/* ── BOOKS TAB ── */}
              {tab === 'books' && (
                <div className="space-y-4">
                  {familyStudents.map(stu => {
                    const books   = getBooksForStu(stu);
                    const bkDue   = books.reduce((s,b)=>s+Number(b.qty)*Number(b.price),0);
                    const bkPaid  = booksPaidMap[stu.id] || 0;
                    const bkBal   = Math.max(0, bkDue - bkPaid);
                    const bkStatus = bkDue === 0 ? 'none' : bkPaid >= bkDue ? 'paid' : bkPaid > 0 ? 'partial' : 'unpaid';
                    return (
                      <Card key={stu.id} className="overflow-hidden">
                        <div className="px-5 py-3 bg-blue-50 border-b border-blue-100 flex items-center justify-between flex-wrap gap-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-bold text-blue-900">{stu.name}</span>
                            <span className="text-blue-500 text-xs">S/O {stu.father||'—'}</span>
                            <Badge color="blue">{stu.cls}</Badge>
                            {bkStatus==='paid'    && <Badge color="green">✓ Books Paid</Badge>}
                            {bkStatus==='partial' && <Badge color="orange">⏳ Partial</Badge>}
                            {bkStatus==='unpaid'  && <Badge color="red">✗ Unpaid</Badge>}
                          </div>
                          <div className="flex items-center gap-2">
                            {isAdmin && bkStatus !== 'paid' && bkDue > 0 && <Btn sm variant="green" onClick={() => openBookPay(stu)}>💰 Pay Books</Btn>}
                            {isAdmin && <Btn sm variant="outline" onClick={() => openBookEdit(stu)}>✏️ Edit</Btn>}
                          </div>
                        </div>
                        {/* Payment summary bar */}
                        {bkDue > 0 && (
                          <div className="px-5 py-2 flex flex-wrap gap-4 text-sm bg-white border-b border-gray-100">
                            <span className="text-gray-500">Due: <strong className="text-blue-700">Rs. {bkDue.toLocaleString()}</strong></span>
                            <span className="text-gray-500">Paid: <strong className="text-emerald-700">Rs. {bkPaid.toLocaleString()}</strong></span>
                            {bkBal > 0 && <span className="text-gray-500">Balance: <strong className="text-red-600">Rs. {bkBal.toLocaleString()}</strong></span>}
                          </div>
                        )}
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead className="bg-gray-50 border-b">
                              <tr className="text-left text-xs text-gray-500 font-semibold uppercase">
                                <th className="px-4 py-2">#</th><th className="px-4 py-2">Book/Subject</th>
                                <th className="px-4 py-2 text-center">Qty</th><th className="px-4 py-2 text-right">Price</th><th className="px-4 py-2 text-right">Total</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50">
                              {books.map((b,i) => (
                                <tr key={i} className="hover:bg-slate-50">
                                  <td className="px-4 py-2 text-gray-400">{i+1}</td>
                                  <td className="px-4 py-2 font-medium text-gray-800">{b.name}</td>
                                  <td className="px-4 py-2 text-center text-gray-600">{b.qty}</td>
                                  <td className="px-4 py-2 text-right text-gray-600">Rs. {Number(b.price).toLocaleString()}</td>
                                  <td className="px-4 py-2 text-right font-semibold text-gray-800">Rs. {(Number(b.qty)*Number(b.price)).toLocaleString()}</td>
                                </tr>
                              ))}
                            </tbody>
                            <tfoot className="bg-blue-50 border-t-2 border-blue-200">
                              <tr><td colSpan="4" className="px-4 py-2 text-right font-bold text-blue-800">Books Total:</td><td className="px-4 py-2 text-right font-bold text-blue-800">Rs. {bkDue.toLocaleString()}</td></tr>
                            </tfoot>
                          </table>
                        </div>
                      </Card>
                    );
                  })}
                  {/* Grand total for books */}
                  <Card className="p-4 border-blue-200">
                    <div className="grid grid-cols-3 gap-4 text-center">
                      <div>
                        <p className="text-xs text-gray-400 uppercase font-semibold mb-1">Total Books Due</p>
                        <p className="text-lg font-extrabold text-blue-700">Rs. {totalBooksDue.toLocaleString()}</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-400 uppercase font-semibold mb-1">Total Paid</p>
                        <p className="text-lg font-extrabold text-emerald-700">Rs. {totalBooksPaid.toLocaleString()}</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-400 uppercase font-semibold mb-1">Balance</p>
                        <p className={`text-lg font-extrabold ${(totalBooksDue-totalBooksPaid)>0?'text-red-600':'text-emerald-600'}`}>
                          {(totalBooksDue-totalBooksPaid)>0?`Rs. ${(totalBooksDue-totalBooksPaid).toLocaleString()}`:'✓ Cleared'}
                        </p>
                      </div>
                    </div>
                  </Card>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* ── Pay Books Modal ── */}
      {bookPayMod && (
        <Modal title={`📚 Pay Books — ${bookPayMod.name}`} onClose={() => setBookPayMod(null)}>
          <div className="bg-blue-50 rounded-xl p-3 mb-4 text-sm">
            <p className="font-semibold text-blue-800">{bookPayMod.name} — Class {bookPayMod.cls}</p>
            <div className="flex gap-4 mt-1">
              <span className="text-gray-600">Books Total: <strong className="text-blue-700">Rs. {getBookTotal(bookPayMod).toLocaleString()}</strong></span>
              <span className="text-gray-600">Already Paid: <strong className="text-emerald-700">Rs. {(booksPaidMap[bookPayMod.id]||0).toLocaleString()}</strong></span>
            </div>
          </div>
          <Inp label="Amount Received (Rs.) *" type="number" min="1" value={bpf.amount}
            onChange={e => setBpf({...bpf, amount: e.target.value})} placeholder="Enter books payment amount"/>
          <Inp label="Note (optional)" value={bpf.note}
            onChange={e => setBpf({...bpf, note: e.target.value})} placeholder="e.g. Partial book payment"/>
          <div className="mb-3">
            <label className="block text-xs font-semibold text-gray-500 mb-1 uppercase tracking-wide">Payment Method *</label>
            <div className="flex flex-wrap gap-2">
              {PAYMENT_METHODS.map(m => (
                <label key={m} className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border-2 cursor-pointer text-sm font-semibold transition-all ${bpf.paymentMethod===m?'border-blue-500 bg-blue-50 text-blue-700':'border-gray-200 text-gray-500 hover:border-gray-300'}`}>
                  <input type="radio" name="bpfMethod" value={m} checked={bpf.paymentMethod===m} onChange={()=>setBpf({...bpf,paymentMethod:m})} className="hidden"/>
                  {m==='Cash'?'💵':m==='Bank Transfer'?'🏦':m==='JazzCash'?'📱':'💳'} {m}
                </label>
              ))}
            </div>
          </div>
          <div className="flex gap-2 mt-5">
            <Btn full variant="green" onClick={recordBookPayment}>✅ Save Book Payment</Btn>
            <Btn variant="outline" onClick={() => setBookPayMod(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {/* ── Equal Split Payment Modal ── */}
      {splitMod && (
        <Modal title={`÷ Family Payment — ${selFamilyLabel}`} onClose={() => setSplitMod(false)} wide>
          <div className="bg-purple-50 rounded-xl p-3 mb-4">
            <p className="font-semibold text-purple-800">{selFamilyLabel} — {familyStudents.length} children</p>
            <div className="flex flex-wrap gap-4 mt-1 text-sm">
              <span className="text-gray-600">Grand Due: <strong>Rs. {grandTotalDue.toLocaleString()}</strong></span>
              <span className="text-gray-600">Paid: <strong className="text-emerald-700">Rs. {grandTotalPaid.toLocaleString()}</strong></span>
              <span className="text-gray-600">Balance: <strong className="text-red-600">Rs. {grandBalance.toLocaleString()}</strong></span>
            </div>
            <div className="flex flex-wrap gap-3 mt-1 text-xs text-gray-400">
              <span>Fee: Rs. {totalDue.toLocaleString()}</span>
              {totalAFDue>0 && <span className="text-purple-500">+ Ann. Fund: Rs. {totalAFDue.toLocaleString()}</span>}
              {totalBooksDue>0 && <span className="text-amber-500">+ Books: Rs. {totalBooksDue.toLocaleString()}</span>}
            </div>
          </div>
          <div className="flex gap-2 mb-1">
            <div className="flex-1"><Sel label="Month *" value={pf.month} onChange={e=>setPf({...pf,month:Number(e.target.value)})} options={MONTHS.map((mo,i)=>({v:i,l:mo}))}/></div>
            <div style={{width:90}}><Sel label="Year" value={pf.year} onChange={e=>setPf({...pf,year:Number(e.target.value)})} options={years.map(y=>({v:y,l:String(y)}))}/></div>
          </div>
          <Inp label="Total Amount Received (Rs.) *" type="number" min="1" value={pf.totalAmount}
            onChange={e=>setPf({...pf,totalAmount:e.target.value})} placeholder={`e.g. ${grandBalance||grandTotalDue} (grand balance)`}/>
          <Inp label="Annual Fund (Rs.) — will also be split equally" type="number" min="0" value={pf.annualFund}
            onChange={e=>setPf({...pf,annualFund:e.target.value})} placeholder="0 if not applicable"/>

          {/* Live split preview */}
          {splitPreview.length > 0 && Number(pf.totalAmount) > 0 && (
            <div className="bg-purple-50 border border-purple-200 rounded-xl p-3 mb-3">
              <p className="text-xs font-bold text-purple-700 uppercase mb-2">÷ Equal Split Preview</p>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-500">
                    <th className="text-left pb-1">Child</th>
                    <th className="text-right pb-1">Fee Due</th>
                    <th className="text-right pb-1">Already Paid</th>
                    <th className="text-right pb-1">Fee Share</th>
                    {Number(pf.annualFund)>0 && <th className="text-right pb-1 text-purple-600">Ann. Fund</th>}
                    <th className="text-right pb-1">Balance After</th>
                  </tr>
                </thead>
                <tbody>
                  {splitPreview.map((row, i) => {
                    const afterPay = row.alreadyPaid + row.share;
                    const balAfter = row.due - afterPay;
                    return (
                      <tr key={i} className="border-t border-purple-100">
                        <td className="py-1 font-semibold text-gray-800">{row.stu.name}</td>
                        <td className="py-1 text-right text-gray-600">Rs. {row.due.toLocaleString()}</td>
                        <td className="py-1 text-right text-emerald-700">Rs. {row.alreadyPaid.toLocaleString()}</td>
                        <td className="py-1 text-right font-bold text-purple-700">Rs. {row.share.toLocaleString()}</td>
                        {Number(pf.annualFund)>0 && <td className="py-1 text-right font-semibold text-purple-600">Rs. {row.afShare.toLocaleString()}</td>}
                        <td className="py-1 text-right font-bold">
                          {balAfter > 0 ? <span className="text-red-600">Rs. {balAfter.toLocaleString()}</span>
                           : balAfter < 0 ? <span className="text-blue-600">+Rs. {Math.abs(balAfter).toLocaleString()} Adv</span>
                           : <span className="text-emerald-600">Cleared</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="flex justify-between mt-2 pt-2 border-t border-purple-200 text-xs font-bold text-purple-800">
                <span>Total Collected:</span>
                <span>Rs. {(Number(pf.totalAmount) + Number(pf.annualFund||0)).toLocaleString()}</span>
              </div>
              {Number(pf.annualFund)>0 && (
                <div className="flex gap-4 mt-1 text-xs text-gray-500">
                  <span>Fee: Rs. {Number(pf.totalAmount).toLocaleString()}</span>
                  <span className="text-purple-600">+ Ann. Fund: Rs. {Number(pf.annualFund).toLocaleString()}</span>
                </div>
              )}
            </div>
          )}

          <Inp label="Note (optional)" value={pf.note} onChange={e=>setPf({...pf,note:e.target.value})} placeholder="e.g. Monthly fee payment"/>
          <div className="mb-3">
            <label className="block text-xs font-semibold text-gray-500 mb-1 uppercase tracking-wide">Payment Method *</label>
            <div className="flex flex-wrap gap-2">
              {PAYMENT_METHODS.map(m => (
                <label key={m} className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border-2 cursor-pointer text-sm font-semibold transition-all ${pf.paymentMethod===m?'border-purple-500 bg-purple-50 text-purple-700':'border-gray-200 text-gray-500 hover:border-gray-300'}`}>
                  <input type="radio" name="splitMethod" value={m} checked={pf.paymentMethod===m} onChange={()=>setPf({...pf,paymentMethod:m})} className="hidden"/>
                  {m==='Cash'?'💵':m==='Bank Transfer'?'🏦':m==='JazzCash'?'📱':'💳'} {m}
                </label>
              ))}
            </div>
          </div>
          <div className="flex gap-2 mt-5">
            <Btn full variant="purple" onClick={recordSplitPayment}>÷ Split & Save All Payments</Btn>
            <Btn variant="outline" onClick={() => setSplitMod(false)}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {/* Book Edit Modal */}
      {bookMod && (
        <Modal title={`Edit Book List — ${bookMod.stu.name} (Class ${bookMod.stu.cls})`} onClose={() => setBookMod(null)} wide>
          <div className="space-y-2 mb-4 max-h-80 overflow-y-auto pr-1">
            {bookMod.books.map((b, i) => (
              <div key={i} className="flex gap-2 items-center bg-gray-50 rounded-xl p-2">
                <span className="text-xs text-gray-400 w-5 shrink-0 text-center">{i+1}</span>
                <input value={b.name} onChange={e=>updateBook(i,'name',e.target.value)} placeholder="Book/Subject name"
                  className="flex-1 border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/>
                <input type="number" min="1" value={b.qty} onChange={e=>updateBook(i,'qty',e.target.value)}
                  className="w-14 border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-center focus:outline-none focus:ring-2 focus:ring-blue-500"/>
                <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden">
                  <span className="text-xs text-gray-400 px-2 bg-gray-50">Rs.</span>
                  <input type="number" min="0" value={b.price} onChange={e=>updateBook(i,'price',e.target.value)}
                    className="w-20 px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-2 focus:ring-blue-500"/>
                </div>
                <button onClick={() => removeBook(i)} className="text-red-400 hover:text-red-600 text-lg w-6 shrink-0">×</button>
              </div>
            ))}
          </div>
          <Btn sm variant="outline" full onClick={addBook}>+ Add Book</Btn>
          <div className="flex gap-2 mt-4">
            <Btn full onClick={saveBooks}>Save Book List</Btn>
            <Btn variant="outline" onClick={() => setBookMod(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── STAFF & SALARY ───────────────────────────────────────────────────────────
const blankStaff = { name:'', father:'', role:'Teacher', contact:'', address:'', salary:0, joinDate:'', workingDays:26 };
const ROLES = ['Principal','Teacher','Admin','Peon','Guard','Driver','Cook','Other'];

function Staff() {
  const { role } = React.useContext(UserContext);
  const isAdmin     = role === 'admin';
  const isPrincipal = role === 'principal';
  const canAdd      = isAdmin || isPrincipal; // principal can add staff & pay salary
  // Integrity guard at mount
  const [staff, setStaff]   = useState(() => getActiveList(K.STAFF));
  const [spays, setSpays]   = useState(() => getActiveList(K.SPAY));
  const [form, setForm]     = useState(null);
  const [delId, setDelId]   = useState(null);
  const [payMod, setPayMod] = useState(null);
  const [histMod, setHistMod] = useState(null);
  const [staffFilter, setStaffFilter] = useState('active'); // 'active' | 'left' | 'all'
  const [pf, setPf]         = useState({ month: NOW.getMonth(), year: NOW.getFullYear(), amount:'', note:'', paymentMethod:'Cash', workingDays:26, paidLeaves:0, unpaidLeaves:0 });
  const [vm, setVm]         = useState(NOW.getMonth());
  const [vy, setVy]         = useState(NOW.getFullYear());
  const years = Array.from({ length: 5 }, (_, i) => NOW.getFullYear() - 2 + i);

  const persistStaff = d => { S.set(K.STAFF, d); setStaff(d); };
  const persistSpays = d => { S.set(K.SPAY, d); setSpays(d); };

  // Phase 3: Salary Delete Cascade.
  //   - Removes the salary payment from K.SPAY (staff becomes Unpaid for that month again).
  //   - Removes the matching CashBook entry (refType='salary', date+amount+staff match).
  //   - Preserves leave-deduction memo on the staff profile (staff.leaveMemos array)
  //     so historical unpaid-leave impact isn't lost.
  //   - Logs audit trail.
  const deleteSpay = (pay) => {
    const st = staff.find(s => s.id === pay.staffId);
    if (!window.confirm(`Delete salary payment ${pay.rcpt || ''} — Rs. ${Number(pay.amount||0).toLocaleString()} for ${st?.name || 'staff'}?\n\n• Staff will show as Unpaid for ${MONTHS[pay.month]} ${pay.year}.\n• Linked Cash Book entry will be removed.\n• Any leave deduction is preserved as a historical memo.`)) return;
    // 1) Remove from K.SPAY
    persistSpays(spays.filter(p => p.id !== pay.id));
    // 2) Remove matching Cash Book entry (refType='salary' with date+amount+staff match)
    const payDate = String(pay.date || '').slice(0,10);
    const allCb   = S.get(K.CBOOK, []);
    const cbMatch = allCb.find(e =>
      e.type === 'expense' && e.refType === 'salary' &&
      String(e.date||'').slice(0,10) === payDate &&
      Math.abs(Number(e.amount||0) - Number(pay.amount||0)) < 0.01 &&
      (st ? (e.description||'').includes(st.name) : true)
    );
    if (cbMatch) S.set(K.CBOOK, allCb.filter(e => e.id !== cbMatch.id));
    // 3) Preserve leave deduction as historical memo on staff profile
    if (Number(pay.unpaidLeaves||0) > 0 && st) {
      const memo = {
        id: uid(),
        date: payDate,
        month: pay.month,
        year: pay.year,
        rcpt: pay.rcpt || '',
        unpaidLeaves: Number(pay.unpaidLeaves||0),
        perDay: Number(pay.perDay||0),
        deduction: Number(pay.deduction||0),
        note: 'Preserved from deleted salary payment ' + (pay.rcpt || ''),
        createdAt: new Date().toISOString(),
      };
      const updatedStaff = staff.map(s => s.id === st.id
        ? { ...s, leaveMemos: Array.isArray(s.leaveMemos) ? [...s.leaveMemos, memo] : [memo] }
        : s);
      persistStaff(updatedStaff);
    }
    // 4) Audit
    logAudit(username, userName, 'DELETE', 'Salary Payment',
      { staff: st?.name, amount: pay.amount, month: pay.month, year: pay.year, rcpt: pay.rcpt, unpaidLeaves: pay.unpaidLeaves },
      { cascadedCashBook: !!cbMatch, memoPreserved: Number(pay.unpaidLeaves||0) > 0 });
  };

  const save = () => {
    if (!form.name.trim()) return alert('Name is required.');
    const item = { ...form, salary: Number(form.salary) };
    const u = form.id ? staff.map(s => s.id === form.id ? item : s) : [...staff, { ...item, id: uid() }];
    persistStaff(u); setForm(null);
  };

  const recordPay = () => {
    const amt = Number(pf.amount);
    if (!pf.amount || amt <= 0) return alert('Enter a valid amount.');
    // ── Leave deduction pre-calculation ──────────────────────────────────
    const wDays    = Math.max(1, Number(pf.workingDays || 26));
    const uLeaves  = Math.max(0, Number(pf.unpaidLeaves || 0));
    const pLeaves  = Math.max(0, Number(pf.paidLeaves || 0));
    const perDay   = Math.round(Number(payMod.salary) / wDays);
    const deduction = Math.round(uLeaves * perDay);
    // Balance check
    const acctInfo = getAcctBalance(pf.paymentMethod || 'Cash');
    if (acctInfo && acctInfo.balance < amt) {
      return alert(`⚠️ Insufficient Balance!\n\n${acctInfo.name} has Rs. ${acctInfo.balance.toLocaleString()} available.\nYou entered Rs. ${amt.toLocaleString()}.\n\nPlease enter Rs. ${acctInfo.balance.toLocaleString()} or less, or change payment method.`);
    }
    const alreadyPaid = monthPaidTotalMap[payMod.id] || 0;
    // ── Auto Net Payable — effective salary considers this payment's NEW deduction too,
    // not just past payments' deductions. Latest entry can raise the month's MAX deduction.
    const existingMaxDed = monthMaxDeductionMap[payMod.id] || 0;
    const effectiveMaxDed = Math.max(existingMaxDed, deduction);
    const effectiveSalary = Math.max(0, Number(payMod.salary) - effectiveMaxDed);
    const remaining = Math.max(0, effectiveSalary - alreadyPaid);
    if (amt > remaining + 0.01) {
      const confirm = window.confirm(`⚠️ Overpayment Warning!\n\nRemaining salary after deduction: Rs. ${remaining.toLocaleString()}\nYou entered: Rs. ${amt.toLocaleString()}\n\nContinue anyway?`);
      if (!confirm) return;
    }
    const now = new Date().toISOString();
    // Partial flag now respects effective (post-deduction) salary target
    const isPartial = alreadyPaid + amt < effectiveSalary - 0.01;
    const leaveNote = uLeaves > 0 ? ` [${uLeaves} unpaid leave(s) − Rs. ${deduction.toLocaleString()}]` : '';
    const pay = {
      id: uid(), staffId: payMod.id,
      month: Number(pf.month), year: Number(pf.year),
      amount: amt,
      note: pf.note || (isPartial ? '[Partial Payment]' : ''),
      paymentMethod: pf.paymentMethod || 'Cash',
      date: now,
      rcpt: 'SAL-' + Date.now().toString().slice(-6),
      partial: isPartial,
      // ── Global Engine: leave data stored in payment record ────────────
      workingDays: wDays, paidLeaves: pLeaves,
      unpaidLeaves: uLeaves, perDay, deduction,
    };
    // v75-8: stamp who recorded this salary payment
    Object.assign(pay, getCreator());
    persistSpays([...spays, pay]);
    // ── Global Engine: Cash Book entry with leave detail + 'salary' tag ─────
    // Tagging with refType='salary' lets calcPL exclude it from cbExpenses
    // (so we don't double-count vs. K.SPAY sum which is the source of truth).
    addCashBookEntry('expense',
      `Salary — ${payMod.name} (${MONTHS[Number(pf.month)]} ${Number(pf.year)})${leaveNote}`,
      amt, pf.paymentMethod || 'Cash', now, pf.note, 'salary');
    setPayMod(null);
    printSlip(pay, payMod);
  };

  // Total paid per staff for selected month (supports multiple/partial payments)
  const monthPaidTotalMap = {};
  const monthPaysList = {};
  // ── Leave deduction tracker — MAX deduction across all month payments per staff.
  // Effective Salary Target = base salary − monthMaxDeduction. This is the source of truth
  // for "Paid / Partial / Unpaid" status. Lets unpaid-leave deductions override the salary
  // target so paying the net payable amount clears the row. Stored field, no schema change.
  const monthMaxDeductionMap = {};
  spays.filter(p => p.month === vm && p.year === vy).forEach(p => {
    monthPaidTotalMap[p.staffId] = (monthPaidTotalMap[p.staffId] || 0) + Number(p.amount);
    if (!monthPaysList[p.staffId]) monthPaysList[p.staffId] = [];
    monthPaysList[p.staffId].push(p);
    const ded = Number(p.deduction || 0);
    if (ded > (monthMaxDeductionMap[p.staffId] || 0)) monthMaxDeductionMap[p.staffId] = ded;
  });

  // Get live account balance for a payment method
  const getAcctBalance = (paymentMethod) => {
    const accounts = getAccounts();
    const cbEntries = getActiveList(K.CBOOK);
    let acct;
    if (paymentMethod === 'Bank Transfer') acct = accounts.find(a => a.type === 'bank');
    else if (paymentMethod === 'JazzCash')  acct = accounts.find(a => a.name === 'JazzCash');
    else if (paymentMethod === 'Easypaisa') acct = accounts.find(a => a.name === 'Easypaisa');
    else acct = accounts.find(a => a.type === 'cash');
    if (!acct) return null;
    const bal = cbEntries.reduce((s, e) => {
      if (e.accountId !== acct.id) return s;
      return s + (e.type === 'income' ? Number(e.amount) : -Number(e.amount));
    }, Number(acct.openingBalance || 0));
    return { balance: bal, name: acct.name };
  };

  // Filtered list for the table — respects Active / Left / All tab
  const displayStaff = staff.filter(m =>
    staffFilter === 'all'  ? true :
    staffFilter === 'left' ? m.status === 'left' :
    m.status !== 'left');
  const totalSalaryBudget = staff.filter(isActiveStaff).reduce((s, m) => s + Number(m.salary), 0);
  const totalPaidMonth    = Object.values(monthPaidTotalMap).reduce((s, v) => s + v, 0);

  const printSlip = (pay, member) => {
    const win = window.open('', '_blank', 'width=420,height=580');
    if (!win) { alert('Popup blocked! Please allow popups for this site to print.'); return; }
    win.document.write(`<!DOCTYPE html><html><head><title>Salary Slip</title>
      <style>
        body{font-family:'Segoe UI',Arial,sans-serif;padding:26px;max-width:380px;margin:0 auto;color:#1a1a1a}
        .logo-hdr{text-align:center;margin-bottom:10px;padding-bottom:10px;border-bottom:2px solid #c0392b}
        .logo-hdr img{height:60px;object-fit:contain}
        h2{text-align:center;color:#1d4ed8;margin:6px 0 2px;font-size:16px;font-weight:800;letter-spacing:1px}
        .divider{border:none;border-top:1px dashed #d1d5db;margin:10px 0}
        .grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}
        .label{font-size:10px;color:#6b7280;margin-bottom:2px;text-transform:uppercase}
        .value{font-size:12px;font-weight:600}
        .total{display:flex;justify-content:space-between;align-items:center;background:#eff6ff;padding:10px 14px;border-radius:8px;margin:10px 0}
        .total-label{font-size:13px;font-weight:700;color:#1d4ed8}
        .total-val{font-size:20px;font-weight:800;color:#1d4ed8}
        .footer{text-align:center;font-size:10px;color:#9ca3af;margin-top:10px}
        .dev-footer{text-align:center;margin-top:12px;padding-top:8px;border-top:1px solid #e5e7eb;font-size:8px;color:#9ca3af;letter-spacing:.3px}
        @media print{body{padding:10px}button{display:none!important}}
      </style></head><body>
      <div class="logo-hdr"><img src="${LOGO_SRC}" alt="DISS" onerror="this.style.display='none'"/></div>
      <h2>SALARY SLIP</h2>
      <hr class="divider"/>
      <div class="grid">
        <div><div class="label">Slip No</div><div class="value">${pay.rcpt}</div></div>
        <div><div class="label">Date</div><div class="value">${new Date(pay.date).toLocaleDateString('en-PK')}</div></div>
        <div><div class="label">Staff Name</div><div class="value">${member.name}</div></div>
        <div><div class="label">Father's Name</div><div class="value">${member.father || '—'}</div></div>
        <div><div class="label">Designation</div><div class="value">${member.role}</div></div>
        <div><div class="label">Salary Month</div><div class="value">${MONTHS[pay.month]} ${pay.year}</div></div>
        <div><div class="label">Payment Method</div><div class="value">${pay.paymentMethod||'Cash'}</div></div>
        ${member.contact?`<div><div class="label">Contact</div><div class="value">${member.contact}</div></div>`:''}
      </div>
      <hr class="divider"/>
      <div class="total">
        <span class="total-label">Amount Paid</span>
        <span class="total-val">Rs. ${Number(pay.amount).toLocaleString()}</span>
      </div>
      ${Number(member.salary) > 0 && Number(pay.amount) < Number(member.salary) ? `<div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;padding:7px 12px;margin:6px 0;font-size:11px;color:#92400e;font-weight:600;text-align:center">⚡ Partial Payment — Full Monthly Salary: Rs. ${Number(member.salary).toLocaleString()}</div>` : ''}
      ${pay.unpaidLeaves > 0 ? `
        <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:8px 12px;margin:6px 0;font-size:11px;color:#991b1b">
          <div style="font-weight:700;margin-bottom:4px">📅 Attendance Summary</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:3px">
            <span>Working Days:</span><span style="font-weight:600">${pay.workingDays||26}</span>
            <span>Per Day Rate:</span><span style="font-weight:600">Rs. ${(pay.perDay||0).toLocaleString()}</span>
            <span style="color:#15803d">Paid Leaves:</span><span style="font-weight:600;color:#15803d">${pay.paidLeaves||0} (No Deduction)</span>
            <span style="color:#dc2626">Unpaid Leaves:</span><span style="font-weight:600;color:#dc2626">${pay.unpaidLeaves}</span>
            <span style="color:#dc2626">Leave Deduction:</span><span style="font-weight:700;color:#dc2626">− Rs. ${(pay.deduction||0).toLocaleString()}</span>
          </div>
        </div>` : ''}
      ${pay.paidLeaves > 0 && !pay.unpaidLeaves ? `<div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:7px 12px;margin:6px 0;font-size:11px;color:#15803d;font-weight:600;text-align:center">✅ Paid Leaves: ${pay.paidLeaves} — No Deduction</div>` : ''}
      ${(() => { const _n = cleanNoteForReceipt(pay.note); return _n ? `<p style="font-size:11px;color:#6b7280">Note: ${_n}</p>` : ''; })()}
      <hr class="divider"/>
      <div style="display:flex;justify-content:space-between;margin-top:30px;font-size:11px;color:#6b7280">
        <div>Staff Signature: __________</div>
        <div>Principal Signature: __________</div>
      </div>
      ${getPrintAudit()}
      <div class="dev-footer">© 2026 DISS — All Rights Reserved &nbsp;|&nbsp; Powered by Tataheer Business Group &nbsp;|&nbsp; +923218555566</div>
      <script>window.onload=function(){window.print();}<\/script>
    </body></html>`);
    win.document.close();
  };

  const printStaff = () => {
    const rows = displayStaff.map((m,i)=>{
      const paidAmt = monthPaidTotalMap[m.id] || 0;
      const leftLabel = m.status==='left' ? ` <span class="badge b-red">LEFT${m.leftDate?' '+m.leftDate:''}</span>` : '';
      return `<tr><td>${i+1}</td><td><b>${m.name}</b>${leftLabel}</td><td>${m.father||'—'}</td><td><span class="badge b-blue">${m.role}</span></td><td>Rs. ${Number(m.salary).toLocaleString()}</td><td>${m.contact||'—'}</td><td><span class="badge ${paidAmt>0?'b-green':'b-red'}">${paidAmt>0?'Paid Rs.'+paidAmt.toLocaleString():'Unpaid'}</span></td></tr>`;
    }).join('');
    const filterLabel = staffFilter==='left' ? ' — Left Staff' : staffFilter==='all' ? ' — All Staff' : ' — Active Staff';
    printPage(`Staff & Salary — ${MONTHS[vm]} ${vy}`, `
      <h2>Staff & Salary${filterLabel} — ${MONTHS[vm]} ${vy}</h2>
      <div class="summary">
        <div class="sum-card"><div class="val">${displayStaff.length}</div><div class="lbl">${staffFilter==='left'?'Left Staff':staffFilter==='all'?'Total Staff':'Active Staff'}</div></div>
        <div class="sum-card"><div class="val">Rs. ${totalSalaryBudget.toLocaleString()}</div><div class="lbl">Salary Budget</div></div>
        <div class="sum-card"><div class="val">Rs. ${totalPaidMonth.toLocaleString()}</div><div class="lbl">Paid This Month</div></div>
        <div class="sum-card"><div class="val">Rs. ${(totalSalaryBudget-totalPaidMonth).toLocaleString()}</div><div class="lbl">Pending</div></div>
      </div>
      <table><thead><tr><th>#</th><th>Name</th><th>Father's Name</th><th>Role</th><th>Monthly Salary</th><th>Contact</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td colspan="4" style="text-align:right"><b>Total Budget:</b></td><td><b>Rs. ${totalSalaryBudget.toLocaleString()}</b></td><td></td><td></td></tr></tfoot>
      </table>`);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-xl font-bold text-gray-800">Staff & Salary</h2>
        <div className="flex gap-2">
          <Btn variant="outline" onClick={printStaff}>🖨️ Print</Btn>
          {canAdd && <Btn onClick={() => setForm({ ...blankStaff })}>+ Add Staff</Btn>}
        </div>
      </div>

      {/* ── Active / Left / All Filter Tabs ── */}
      {(() => {
        const activeCount = staff.filter(m => m.status !== 'left').length;
        const leftCount   = staff.filter(m => m.status === 'left').length;
        const tabs = [
          { id:'active', label:'✅ Active',          count: activeCount },
          { id:'left',   label:'🔴 Left / Terminated', count: leftCount   },
          { id:'all',    label:'📋 All',               count: staff.length },
        ];
        return (
          <div className="flex gap-1 mb-4 bg-gray-100 p-1 rounded-xl w-fit flex-wrap">
            {tabs.map(t => (
              <button key={t.id} onClick={() => setStaffFilter(t.id)}
                className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${staffFilter===t.id ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
                {t.label} ({t.count})
              </button>
            ))}
          </div>
        );
      })()}

      {/* Month selector + summary */}
      <div className="flex flex-wrap gap-2 mb-4">
        <select value={vm} onChange={e => setVm(Number(e.target.value))} className={inputCls + ' w-auto'}>
          {MONTHS.map((mo,i) => <option key={i} value={i}>{mo}</option>)}
        </select>
        <select value={vy} onChange={e => setVy(Number(e.target.value))} className={inputCls + ' w-auto'}>
          {years.map(y => <option key={y}>{y}</option>)}
        </select>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Card className="p-4 bg-blue-50 border-blue-200">
          <p className="text-xs text-blue-500 font-semibold uppercase mb-1">{staffFilter==='left'?'Left Staff':staffFilter==='all'?'Total Staff':'Active Staff'}</p>
          <p className="text-2xl font-bold text-blue-700">{displayStaff.length}</p>
        </Card>
        <Card className="p-4 bg-amber-50 border-amber-200">
          <p className="text-xs text-amber-600 font-semibold uppercase mb-1">Salary Budget</p>
          <p className="text-lg font-bold text-amber-700">Rs. {totalSalaryBudget.toLocaleString()}</p>
        </Card>
        <Card className="p-4 bg-emerald-50 border-emerald-200">
          <p className="text-xs text-emerald-600 font-semibold uppercase mb-1">Paid This Month</p>
          <p className="text-lg font-bold text-emerald-700">Rs. {totalPaidMonth.toLocaleString()}</p>
        </Card>
        <Card className={`p-4 ${totalSalaryBudget-totalPaidMonth>0 ? 'bg-red-50 border-red-200' : 'bg-gray-50 border-gray-200'}`}>
          <p className={`text-xs font-semibold uppercase mb-1 ${totalSalaryBudget-totalPaidMonth>0 ? 'text-red-500' : 'text-gray-400'}`}>Pending</p>
          <p className={`text-lg font-bold ${totalSalaryBudget-totalPaidMonth>0 ? 'text-red-600' : 'text-gray-400'}`}>
            {totalSalaryBudget-totalPaidMonth>0 ? `Rs. ${(totalSalaryBudget-totalPaidMonth).toLocaleString()}` : '✓ All Paid'}
          </p>
        </Card>
      </div>

      {displayStaff.length === 0
        ? <Empty icon="👩‍🏫" text={staff.length === 0 ? 'No staff added yet. Click + Add Staff to begin.' : `No ${staffFilter === 'left' ? 'left/terminated' : 'active'} staff found.`} />
        : <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b">
                  <tr className="text-left text-xs text-gray-500 font-semibold uppercase">
                    <th className="px-4 py-3">Sr.</th>
                    <th className="px-4 py-3">Name</th>
                    <th className="px-4 py-3 hidden sm:table-cell">Father's Name</th>
                    <th className="px-4 py-3">Role</th>
                    <th className="px-4 py-3 hidden sm:table-cell">Salary</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {displayStaff.map((m, idx) => {
                    const paidAmt        = monthPaidTotalMap[m.id] || 0;
                    const salary         = Number(m.salary);
                    // ── Auto Net Payable rule — unpaid-leave deduction overrides month target.
                    // effectiveSalary becomes the new target; paying it in full → row clears (Paid).
                    const monthDeduction = monthMaxDeductionMap[m.id] || 0;
                    const effectiveSalary = Math.max(0, salary - monthDeduction);
                    const remaining = Math.max(0, effectiveSalary - paidAmt);
                    const isPaid    = salary > 0 && paidAmt + monthDeduction >= salary - 0.01;
                    const isPartial = paidAmt > 0 && paidAmt < effectiveSalary - 0.01;
                    const pays      = monthPaysList[m.id] || [];
                    const lastPay   = pays[pays.length - 1];
                    return (
                      <tr key={m.id} className="hover:bg-slate-50">
                        <td className="px-4 py-3 text-xs font-bold text-gray-400">{String(idx+1).padStart(2,'0')}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            <span className={`font-semibold ${m.status==='left'?'text-gray-400 line-through':'text-gray-800'}`}>{m.name}</span>
                            {m.status==='left' && <span className="text-xs bg-red-100 text-red-600 font-bold px-1.5 py-0.5 rounded-full">LEFT</span>}
                          </div>
                          {m.contact && <div className="text-xs text-gray-400">{m.contact}</div>}
                          {m.status==='left' && m.leftDate && <div className="text-xs text-red-400">Left: {m.leftDate}</div>}
                        </td>
                        <td className="px-4 py-3 text-gray-500 hidden sm:table-cell">{m.father || '—'}</td>
                        <td className="px-4 py-3"><Badge color="blue">{m.role}</Badge></td>
                        <td className="px-4 py-3 font-semibold text-gray-700 hidden sm:table-cell">Rs. {salary.toLocaleString()}</td>
                        <td className="px-4 py-3">
                          {isPaid    ? <Badge color="green">✓ Paid Rs. {paidAmt.toLocaleString()}</Badge>
                          : isPartial ? <div>
                                          <Badge color="yellow">⚡ Partial Rs. {paidAmt.toLocaleString()}</Badge>
                                          <div className="text-xs text-red-500 mt-0.5">Remaining: Rs. {remaining.toLocaleString()}</div>
                                        </div>
                          : <Badge color="red">✗ Unpaid</Badge>}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex flex-wrap gap-1 justify-end">
                            {isPaid
                              ? <Btn sm variant="outline" onClick={() => lastPay && printSlip(lastPay, m)}>🖨️ Slip</Btn>
                              : canAdd && <Btn sm variant="green" onClick={() => { setPayMod(m); setPf({ month: vm, year: vy, amount: String(remaining || salary), note:'', paymentMethod:'Cash', workingDays: Number(m.workingDays||26), paidLeaves:0, unpaidLeaves:0 }); }}>
                                  {isPartial ? `Pay Rs. ${remaining.toLocaleString()} More` : 'Pay Salary'}
                                </Btn>}
                            <Btn sm variant="ghost" onClick={() => setHistMod(m)}>History</Btn>
                            {isAdmin && <Btn sm variant="outline" onClick={() => window.requireMasterCode(() => setForm({...m}), `Edit staff: ${m.name}`)}>Edit</Btn>}
                            {isAdmin && <Btn sm variant="red" onClick={() => window.requireMasterCode(() => setDelId(m.id), `Delete staff: ${m.name}`)}>Del</Btn>}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
      }

      {/* Add/Edit Staff */}
      {form && (
        <Modal title={form.id ? 'Edit Staff' : 'Add Staff Member'} onClose={() => setForm(null)}>
          <Inp label="Full Name *" value={form.name} onChange={e => setForm({...form, name: e.target.value})} placeholder="Staff full name"/>
          <Inp label="Father's Name" value={form.father||''} onChange={e => setForm({...form, father: e.target.value})} placeholder="Father's full name"/>
          <Sel label="Role / Designation" value={form.role} onChange={e => setForm({...form, role: e.target.value})} options={ROLES}/>
          <Inp label="Monthly Salary (Rs.)" type="number" min="0" value={form.salary} onChange={e => setForm({...form, salary: e.target.value})} placeholder="e.g. 15000"/>
          <Inp label="Contact Number" value={form.contact||''} onChange={e => setForm({...form, contact: e.target.value})} placeholder="e.g. 0321-1234567"/>
          <Inp label="Address" value={form.address||''} onChange={e => setForm({...form, address: e.target.value})} placeholder="Home address"/>
          <Inp label="Join Date" type="date" value={form.joinDate||''} onChange={e => setForm({...form, joinDate: e.target.value})}/>
          <div className="mb-3">
            <label className="block text-xs font-semibold text-gray-500 mb-1 uppercase tracking-wide">Working Days / Month</label>
            <input type="number" min="1" max="31" value={form.workingDays||26}
              onChange={e => setForm({...form, workingDays: Math.max(1, Number(e.target.value)||26)})}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"/>
            <p className="text-xs text-gray-400 mt-1">Used for per-day rate & unpaid leave deduction. Default: 26</p>
          </div>
          {/* Staff Status */}
          <div className="mb-3">
            <label className="block text-xs font-semibold text-gray-500 mb-1 uppercase tracking-wide">Status</label>
            <select value={form.status||'active'} onChange={e=>setForm({...form,status:e.target.value})}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400">
              <option value="active">✅ Active</option>
              <option value="left">🔴 Left / Terminated</option>
            </select>
          </div>
          {(form.status==='left') && (
            <Inp label="Left Date" type="date" value={form.leftDate||''} onChange={e=>setForm({...form,leftDate:e.target.value})}/>
          )}
          {form.status==='left' && (
            <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-2 mb-2 text-xs text-red-700">
              🔴 This staff member will be excluded from active payroll. All historical salary records are preserved.
            </div>
          )}
          <div className="flex gap-2 mt-5">
            <Btn full onClick={save}>{form.id ? 'Update' : 'Save Staff'}</Btn>
            <Btn variant="outline" onClick={() => setForm(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {/* Pay Salary */}
      {payMod && (
        <Modal title={`Pay Salary — ${payMod.name}`} onClose={() => setPayMod(null)}>
          {(() => {
            const alreadyPaid = monthPaidTotalMap[payMod.id] || 0;
            const rem = Math.max(0, Number(payMod.salary) - alreadyPaid);
            const acctInfo = getAcctBalance(pf.paymentMethod || 'Cash');
            const enteredAmt = Number(pf.amount || 0);
            const balanceOk = !acctInfo || acctInfo.balance >= enteredAmt;
            return (
              <>
                <div className="bg-blue-50 rounded-xl p-3 mb-3 flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-blue-200 flex items-center justify-center text-blue-700 font-bold text-lg shrink-0">{payMod.name[0]}</div>
                  <div>
                    <p className="font-semibold text-blue-800">{payMod.name}</p>
                    <p className="text-xs text-blue-500">{payMod.role} &nbsp;|&nbsp; Monthly Salary: <strong>Rs. {Number(payMod.salary).toLocaleString()}</strong></p>
                  </div>
                </div>
                {alreadyPaid > 0 && (
                  <div className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 mb-3 text-xs flex justify-between">
                    <span className="text-amber-700">Already Paid this month: <strong>Rs. {alreadyPaid.toLocaleString()}</strong></span>
                    <span className="text-red-600 font-bold">Remaining: Rs. {rem.toLocaleString()}</span>
                  </div>
                )}
                {acctInfo && (
                  <div className={`border rounded-xl px-3 py-2 mb-3 text-xs flex justify-between ${balanceOk ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-300'}`}>
                    <span className={balanceOk ? 'text-emerald-700' : 'text-red-700'}>
                      {pf.paymentMethod || 'Cash'} Balance: <strong>Rs. {acctInfo.balance.toLocaleString()}</strong>
                    </span>
                    {!balanceOk && enteredAmt > 0 && (
                      <span className="text-red-600 font-bold">⚠️ Short by Rs. {(enteredAmt - acctInfo.balance).toLocaleString()}</span>
                    )}
                  </div>
                )}
              </>
            );
          })()}
          <div className="flex gap-2">
            <div className="flex-1">
              <Sel label="Month *" value={pf.month} onChange={e => setPf({...pf, month: Number(e.target.value)})} options={MONTHS.map((mo,i)=>({v:i,l:mo}))}/>
            </div>
            <div style={{width:90}}>
              <Sel label="Year" value={pf.year} onChange={e => setPf({...pf, year: Number(e.target.value)})} options={years.map(y=>({v:y,l:String(y)}))}/>
            </div>
          </div>
          {/* ── Attendance & Leave Calculation ── */}
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 mb-3">
            <p className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">📅 Attendance & Leave</p>
            <div className="grid grid-cols-3 gap-2 mb-3">
              <div>
                <label className="text-xs text-gray-500 font-semibold block mb-1">Working Days</label>
                <input type="number" min="1" max="31" value={pf.workingDays||26}
                  onChange={e => {
                    const wDays   = Math.max(1, Number(e.target.value)||26);
                    const perDay  = Number(payMod.salary) / wDays;
                    const ded     = Math.round(Number(pf.unpaidLeaves||0) * perDay);
                    setPf({...pf, workingDays: wDays, amount: String(Math.max(0, Number(payMod.salary) - ded))});
                  }}
                  className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-center focus:outline-none focus:ring-2 focus:ring-blue-400"/>
              </div>
              <div>
                <label className="text-xs text-emerald-600 font-semibold block mb-1">✅ Paid Leaves</label>
                <input type="number" min="0" value={pf.paidLeaves||0}
                  onChange={e => setPf({...pf, paidLeaves: Math.max(0, Number(e.target.value)||0)})}
                  className="w-full border border-emerald-200 rounded-lg px-2 py-1.5 text-sm text-center focus:outline-none focus:ring-2 focus:ring-emerald-400"/>
              </div>
              <div>
                <label className="text-xs text-red-500 font-semibold block mb-1">🔴 Unpaid Leaves</label>
                <input type="number" min="0" value={pf.unpaidLeaves||0}
                  onChange={e => {
                    const uLeaves = Math.max(0, Number(e.target.value)||0);
                    const wDays   = Math.max(1, Number(pf.workingDays||26));
                    const perDay  = Number(payMod.salary) / wDays;
                    const ded     = Math.round(uLeaves * perDay);
                    setPf({...pf, unpaidLeaves: uLeaves, amount: String(Math.max(0, Number(payMod.salary) - ded))});
                  }}
                  className="w-full border border-red-200 rounded-lg px-2 py-1.5 text-sm text-center text-red-600 font-bold focus:outline-none focus:ring-2 focus:ring-red-400"/>
              </div>
            </div>
            {/* Per-day live breakdown */}
            {(() => {
              const sal     = Number(payMod.salary);
              const wDays   = Math.max(1, Number(pf.workingDays||26));
              const uLeaves = Number(pf.unpaidLeaves||0);
              const pL      = Number(pf.paidLeaves||0);
              const perDay  = Math.round(sal / wDays);
              const ded     = Math.round(uLeaves * perDay);
              if (sal <= 0) return null;
              return (
                <div className="text-xs space-y-1 border-t border-slate-200 pt-2">
                  <div className="flex justify-between text-gray-500">
                    <span>Per Day Rate ({sal.toLocaleString()} ÷ {wDays} days):</span>
                    <span className="font-bold text-blue-600">Rs. {perDay.toLocaleString()}</span>
                  </div>
                  {pL > 0 && <div className="flex justify-between text-emerald-600"><span>Paid Leaves ({pL}):</span><span className="font-bold">No Deduction ✓</span></div>}
                  {uLeaves > 0 && (
                    <div className="flex justify-between text-red-500">
                      <span>Unpaid Leave Deduction ({uLeaves} × Rs. {perDay.toLocaleString()}):</span>
                      <span className="font-bold">− Rs. {ded.toLocaleString()}</span>
                    </div>
                  )}
                  <div className="flex justify-between font-bold border-t border-slate-200 pt-1">
                    <span className="text-gray-700">Net Payable:</span>
                    <span className={`text-base ${ded>0?'text-red-600':'text-emerald-700'}`}>Rs. {Math.max(0,sal-ded).toLocaleString()}</span>
                  </div>
                </div>
              );
            })()}
          </div>

          <Inp label="Amount (Rs.) *" type="number" min="1" value={pf.amount} onChange={e => setPf({...pf, amount: e.target.value})} placeholder="Amount paid"/>
          <div className="mb-3">
            <label className="block text-xs font-semibold text-gray-500 mb-1 uppercase tracking-wide">Payment Method *</label>
            <div className="flex flex-wrap gap-2">
              {PAYMENT_METHODS.map(m => (
                <label key={m} className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border-2 cursor-pointer text-sm font-semibold transition-all ${pf.paymentMethod===m?'border-blue-500 bg-blue-50 text-blue-700':'border-gray-200 text-gray-500 hover:border-gray-300'}`}>
                  <input type="radio" name="salMethod" value={m} checked={pf.paymentMethod===m} onChange={()=>setPf({...pf,paymentMethod:m})} className="hidden"/>
                  {m==='Cash'?'💵':m==='Bank Transfer'?'🏦':m==='JazzCash'?'📱':'💳'} {m}
                </label>
              ))}
            </div>
          </div>
          <Inp label="Note (optional)" value={pf.note} onChange={e => setPf({...pf, note: e.target.value})} placeholder="e.g. Advance / partial / bonus"/>
          <div className="flex gap-2 mt-5">
            <Btn full variant="green" onClick={recordPay}>💾 Save & Print Slip</Btn>
            <Btn variant="outline" onClick={() => setPayMod(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {/* Salary History */}
      {histMod && (() => {
        const hist = [...spays.filter(p => p.staffId === histMod.id)].sort((a,b) => new Date(b.date)-new Date(a.date));
        const total = hist.reduce((s,p) => s + Number(p.amount), 0);
        return (
          <Modal title={`Salary History — ${histMod.name}`} onClose={() => setHistMod(null)} wide>
            <p className="text-sm text-gray-500 mb-1">{histMod.role} &nbsp;|&nbsp; Monthly Salary: <strong>Rs. {Number(histMod.salary).toLocaleString()}</strong></p>
            <div className="flex gap-4 mb-4 text-sm">
              <span className="font-bold text-emerald-700">Total Paid: Rs. {total.toLocaleString()}</span>
              {total < Number(histMod.salary) && <span className="font-bold text-red-500">Balance Due: Rs. {(Number(histMod.salary)-total).toLocaleString()}</span>}
            </div>
            {hist.length === 0
              ? <p className="text-center text-gray-400 py-6">No salary payments recorded.</p>
              : <div className="space-y-2">
                  {hist.map(p => (
                    <div key={p.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-xl">
                      <div>
                        <p className="font-semibold text-sm text-gray-800">{MONTHS[p.month]} {p.year}</p>
                        <p className="text-xs text-gray-400 font-mono">{p.rcpt} &nbsp;|&nbsp; {p.paymentMethod||'Cash'}</p>
                        {p.note && <p className="text-xs text-gray-400 mt-0.5">{p.note}</p>}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-emerald-700">Rs. {Number(p.amount).toLocaleString()}</span>
                        <Btn sm variant="outline" onClick={() => printSlip(p, histMod)}>🖨️ Slip</Btn>
                        {isAdmin && <Btn sm variant="red" onClick={() => window.requireMasterCode(() => deleteSpay(p), `Delete salary payment: ${histMod.name} — Rs. ${Number(p.amount).toLocaleString()}`)}>🗑️</Btn>}
                      </div>
                    </div>
                  ))}
                </div>
            }
          </Modal>
        );
      })()}

      {delId && (
        <Modal title="Delete Staff" onClose={() => setDelId(null)}>
          <p className="text-gray-600 mb-5">Delete <strong>{staff.find(s=>s.id===delId)?.name}</strong>? Salary history will remain.</p>
          <div className="flex gap-2">
            <Btn full variant="red" onClick={() => { persistStaff(staff.filter(s=>s.id!==delId)); setDelId(null); }}>Delete</Btn>
            <Btn variant="outline" onClick={() => setDelId(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── USER ADMIN ───────────────────────────────────────────────────────────────
function UserAdmin() {
  const { role, id: selfId } = React.useContext(UserContext);
  const isAdmin = role === 'admin';
  const [users, setUsers]       = useState(() => S.get(K.USERS, []));
  const [form, setForm]         = useState(null);
  const [delId, setDelId]       = useState(null);
  const [pwMod, setPwMod]       = useState(null);
  const [pwForm, setPwForm]     = useState({ cur:'', newp:'', conf:'' });
  const [adminReset, setAdminReset] = useState(null);
  const [approveModal, setApproveModal] = useState(null); // { req, familyId }
  // Tabs split into three: staff (admin/principal/staff/custom), parents, pending
  // Default = 'staff' so opening the page shows internal users first.
  const [tab, setTab]           = useState('staff');
  const [preqs, setPreqs]       = useState(() => S.get(K.PREQ, []));
  const [viewPw, setViewPw]     = useState({});

  const persist = d => { S.set(K.USERS, d); setUsers(d); };

  const save = () => {
    if (!form.username.trim() || !form.name.trim()) return alert('Name and username are required.');
    if (!form.id && !form.password.trim()) return alert('Password is required for new users.');
    if (!form.id && users.find(u => u.username === form.username.trim())) return alert('Username already exists.');
    const item = { ...form, username: form.username.trim(), name: form.name.trim() };
    if (form.id && !form.password.trim()) delete item.password;
    const u = form.id ? users.map(x => x.id === form.id ? { ...x, ...item } : x) : [...users, { ...item, id: uid() }];
    persist(u); setForm(null);
  };

  const remove = () => {
    const target = users.find(u => u.id === delId);
    if (target?.role === 'admin') return alert('🔒 Admin accounts cannot be deleted for security reasons.');
    if (target?.role === 'principal') return alert('🔒 Principal accounts cannot be deleted. Change role first.');
    persist(users.filter(u => u.id !== delId)); setDelId(null);
  };

  const changePw = () => {
    const self = users.find(u => u.id === selfId);
    if (pwForm.cur !== self?.password) return alert('Current password is incorrect.');
    if (!pwForm.newp.trim()) return alert('New password cannot be empty.');
    if (pwForm.newp !== pwForm.conf) return alert('Passwords do not match.');
    const updated = users.map(u => u.id === selfId ? { ...u, password: pwForm.newp } : u);
    persist(updated);
    setSession({ ...self, password: pwForm.newp });
    setPwMod(null); setPwForm({ cur:'', newp:'', conf:'' });
    alert('Password changed successfully.');
  };

  const adminResetPw = () => {
    if (!adminReset.newp.trim()) return alert('Enter a new password.');
    const updated = users.map(u => u.id === adminReset.user.id ? { ...u, password: adminReset.newp } : u);
    persist(updated); setAdminReset(null);
    alert(`Password for ${adminReset.user.name} reset successfully.`);
  };

  const approveParent = () => {
    if (!approveModal) return;
    const { req, familyId } = approveModal;
    if (!familyId.trim()) { alert('Please enter the Family ID / Sibling Number before approving.'); return; }
    const updated = users.map(u => u.id === req.id ? { ...u, status: 'active', familyId: familyId.trim() } : u);
    persist(updated);
    const updPreqs = preqs.filter(r => r.id !== req.id);
    S.set(K.PREQ, updPreqs); setPreqs(updPreqs);
    setApproveModal(null);
    alert(`✓ ${req.name} approved!\nFamily ID "${familyId.trim()}" assigned.\nThey can now login.`);
  };

  const rejectParent = (reqId) => {
    const req = preqs.find(r => r.id === reqId);
    if (!req) return;
    const updated = users.map(u => u.id === req.id ? { ...u, status: 'rejected' } : u);
    persist(updated);
    const updPreqs = preqs.filter(r => r.id !== reqId);
    S.set(K.PREQ, updPreqs); setPreqs(updPreqs);
  };

  const ROLE_DEFAULT_NAMES = {
    admin: 'Admin — Full Access',
    principal: 'Principal — Add & View Only',
    accountant: 'Accountant — Fees, Cash Book & Expenses',
    teacher: 'Teacher — Notifications & Complaints',
    staff: 'Staff — Fee Collection',
    parent: 'Parent',
    custom: '',
  };
  const roleBadge = (r, rName) => {
    const map = { admin:'blue', principal:'green', accountant:'teal', teacher:'purple', staff:'gray', parent:'yellow', custom:'red' };
    const defaultLabel = { admin:'🔐 Admin', principal:'🎓 Principal', accountant:'🧾 Accountant', teacher:'📖 Teacher', staff:'👤 Staff', parent:'👨‍👩‍👧 Parent', custom:'⚙️ Custom' };
    const display = rName || defaultLabel[r] || r;
    const colorMap = { blue:'bg-blue-100 text-blue-700', green:'bg-green-100 text-green-700', teal:'bg-teal-100 text-teal-700', purple:'bg-purple-100 text-purple-700', gray:'bg-gray-100 text-gray-600', yellow:'bg-yellow-100 text-yellow-700', red:'bg-red-100 text-red-700' };
    const col = map[r]||'gray';
    return <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${colorMap[col]||'bg-gray-100 text-gray-600'}`}>{display}</span>;
  };

  const pendingCount = preqs.filter(r => users.find(u => u.id===r.id && u.status==='pending')).length;

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-xl font-bold text-gray-800">User Management</h2>
        <div className="flex gap-2">
          <Btn variant="outline" onClick={() => { setPwMod(true); setPwForm({ cur:'', newp:'', conf:'' }); }}>🔑 My Password</Btn>
          {isAdmin && <Btn onClick={() => setForm({ username:'', password:'', name:'', role:'staff', roleName: ROLE_DEFAULT_NAMES['staff'] })}>+ Add User</Btn>}
        </div>
      </div>

      {/* ── Sub-tabs ── Staff Users / Parent Users / Parent Requests
            "Parent Users" is split off from the main list so staff (admin,
            principal, custom) appear in their own clean window, separate from
            parent accounts. Counts on each tab reflect the actual user split. */}
      {(() => {
        const staffUsers  = users.filter(u => u.role !== 'parent');
        const parentUsers = users.filter(u => u.role === 'parent');
        return (
          <div className="flex gap-1 mb-5 bg-gray-100 p-1 rounded-xl w-fit flex-wrap">
            <button onClick={() => setTab('staff')} className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${tab==='staff' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}>
              🏛️ Staff Users ({staffUsers.length})
            </button>
            <button onClick={() => setTab('parents')} className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${tab==='parents' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}>
              👨‍👩‍👧 Parent Users ({parentUsers.length})
            </button>
            {isAdmin && <button onClick={() => setTab('pending')} className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${tab==='pending' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}>
              📩 Parent Requests {pendingCount > 0 && <span className="ml-1 bg-red-500 text-white text-xs rounded-full px-1.5">{pendingCount}</span>}
            </button>}
          </div>
        );
      })()}

      {!isAdmin && <div className="bg-amber-50 border border-amber-200 text-amber-700 text-sm px-4 py-3 rounded-xl mb-4">⚠️ You have view-only access. Contact admin to manage users.</div>}

      {/* Staff Users Tab — admin, principal, staff, custom roles only */}
      {tab === 'staff' && (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr className="text-left text-xs text-gray-500 font-semibold uppercase">
                  <th className="px-4 py-3">Sr.</th>
                  <th className="px-4 py-3">Full Name</th>
                  <th className="px-4 py-3">Username</th>
                  <th className="px-4 py-3">Role</th>
                  {isAdmin && <th className="px-4 py-3">Password</th>}
                  {isAdmin && <th className="px-4 py-3 text-right">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {users.filter(u => u.role !== 'parent').length === 0 && (
                  <tr><td colSpan={isAdmin?6:4} className="px-4 py-8 text-center text-gray-400 text-sm">No staff users yet. Click + Add User to create one.</td></tr>
                )}
                {users.filter(u => u.role !== 'parent').map((u, idx) => (
                  <tr key={u.id} className={`hover:bg-slate-50 ${u.disabled ? 'opacity-60' : ''}`}>
                    <td className="px-4 py-3 text-xs font-bold text-gray-400">{String(idx+1).padStart(2,'0')}</td>
                    <td className="px-4 py-3 font-semibold text-gray-800">
                      {u.name}
                      {u.disabled && <span className="ml-2 text-xs bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full font-semibold">Disabled</span>}
                      {u.status === 'pending' && <span className="ml-2 text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-semibold">Pending</span>}
                      {u.status === 'rejected' && <span className="ml-2 text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-semibold">Rejected</span>}
                      {u.familyId && <span className="ml-2 text-xs text-gray-400">({u.familyId})</span>}
                    </td>
                    <td className="px-4 py-3 font-mono text-gray-600">{u.username}</td>
                    <td className="px-4 py-3">{roleBadge(u.role, u.roleName)}</td>
                    {isAdmin && (
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <span className="font-mono text-xs text-gray-600">{viewPw[u.id] ? u.password : '••••••'}</span>
                          <button onClick={() => setViewPw(v => ({...v, [u.id]: !v[u.id]}))} className="text-xs text-gray-400 hover:text-gray-700 px-1">{viewPw[u.id] ? 'Hide' : 'Show'}</button>
                        </div>
                      </td>
                    )}
                    {isAdmin && (
                      <td className="px-4 py-3 text-right space-x-1">
                        <Btn sm variant="outline" onClick={() => window.requireMasterCode(() => setAdminReset({ user: u, newp: '' }), `Reset password: ${u.name}`)}>Reset PW</Btn>
                        <Btn sm variant="outline" onClick={() => window.requireMasterCode(() => setForm({ ...u, password:'' }), `Edit user: ${u.name}`)}>Edit</Btn>
                        {u.role !== 'admin' && (
                          <Btn sm variant={u.disabled ? 'outline' : 'red'} onClick={() => window.requireMasterCode(() => {
                            const upd = users.map(x => x.id === u.id ? { ...x, disabled: !x.disabled } : x);
                            persist(upd);
                          }, `${u.disabled ? 'Enable' : 'Disable'} account: ${u.name}`)}>
                            {u.disabled ? '▶ Enable' : '⏸ Disable'}
                          </Btn>
                        )}
                        {u.role !== 'admin' && u.role !== 'principal' && <Btn sm variant="red" onClick={() => window.requireMasterCode(() => setDelId(u.id), `Delete user: ${u.name}`)}>Del</Btn>}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Parent Users Tab — only role === 'parent' */}
      {tab === 'parents' && (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr className="text-left text-xs text-gray-500 font-semibold uppercase">
                  <th className="px-4 py-3">Sr.</th>
                  <th className="px-4 py-3">Full Name</th>
                  <th className="px-4 py-3">Username</th>
                  <th className="px-4 py-3">Family</th>
                  <th className="px-4 py-3">Role</th>
                  {isAdmin && <th className="px-4 py-3">Password</th>}
                  {isAdmin && <th className="px-4 py-3 text-right">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {users.filter(u => u.role === 'parent').length === 0 && (
                  <tr><td colSpan={isAdmin?7:5} className="px-4 py-8 text-center text-gray-400 text-sm">No parent users yet. Approved parent registration requests will appear here.</td></tr>
                )}
                {users.filter(u => u.role === 'parent').map((u, idx) => (
                  <tr key={u.id} className={`hover:bg-slate-50 ${u.disabled ? 'opacity-60' : ''}`}>
                    <td className="px-4 py-3 text-xs font-bold text-gray-400">{String(idx+1).padStart(2,'0')}</td>
                    <td className="px-4 py-3 font-semibold text-gray-800">
                      {u.name}
                      {u.disabled && <span className="ml-2 text-xs bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full font-semibold">Disabled</span>}
                      {u.status === 'pending' && <span className="ml-2 text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-semibold">Pending</span>}
                      {u.status === 'rejected' && <span className="ml-2 text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-semibold">Rejected</span>}
                    </td>
                    <td className="px-4 py-3 font-mono text-gray-600">{u.username}</td>
                    <td className="px-4 py-3 text-gray-500">{u.familyId ? <span className="text-xs bg-purple-50 text-purple-700 px-2 py-0.5 rounded-full font-semibold">{u.familyId}</span> : <span className="text-gray-300">—</span>}</td>
                    <td className="px-4 py-3">{roleBadge(u.role, u.roleName)}</td>
                    {isAdmin && (
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <span className="font-mono text-xs text-gray-600">{viewPw[u.id] ? u.password : '••••••'}</span>
                          <button onClick={() => setViewPw(v => ({...v, [u.id]: !v[u.id]}))} className="text-xs text-gray-400 hover:text-gray-700 px-1">{viewPw[u.id] ? 'Hide' : 'Show'}</button>
                        </div>
                      </td>
                    )}
                    {isAdmin && (
                      <td className="px-4 py-3 text-right space-x-1">
                        <Btn sm variant="outline" onClick={() => window.requireMasterCode(() => setAdminReset({ user: u, newp: '' }), `Reset password: ${u.name}`)}>Reset PW</Btn>
                        <Btn sm variant="outline" onClick={() => window.requireMasterCode(() => setForm({ ...u, password:'' }), `Edit user: ${u.name}`)}>Edit</Btn>
                        <Btn sm variant={u.disabled ? 'outline' : 'red'} onClick={() => window.requireMasterCode(() => {
                          const upd = users.map(x => x.id === u.id ? { ...x, disabled: !x.disabled } : x);
                          persist(upd);
                        }, `${u.disabled ? 'Enable' : 'Disable'} parent: ${u.name}`)}>
                          {u.disabled ? '▶ Enable' : '⏸ Disable'}
                        </Btn>
                        <Btn sm variant="red" onClick={() => window.requireMasterCode(() => setDelId(u.id), `Delete parent: ${u.name}`)}>Del</Btn>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Parent Requests Tab */}
      {tab === 'pending' && isAdmin && (
        <div className="space-y-3">
          {preqs.filter(r => users.find(u => u.id===r.id && u.status==='pending')).length === 0 && (
            <div className="bg-white rounded-2xl border border-gray-100 p-8 text-center text-gray-400"><div className="text-3xl mb-2">👨‍👩‍👧</div><p className="text-sm">No pending parent registration requests.</p></div>
          )}
          {preqs.filter(r => users.find(u => u.id===r.id && u.status==='pending')).map(r => (
            <Card key={r.id} className="p-4">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <p className="font-bold text-gray-800">{r.name}</p>
                  <p className="text-xs text-gray-500 mt-0.5">Username: <strong>{r.username}</strong></p>
                  <p className="text-xs text-gray-400 mt-0.5">Requested: {new Date(r.requestedAt).toLocaleDateString('en-PK',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})}</p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Btn sm onClick={() => setApproveModal({ req: r, familyId: '' })}>✓ Approve & Assign ID</Btn>
                  <Btn sm variant="red" onClick={() => rejectParent(r.id)}>✗ Reject</Btn>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {form && (
        <Modal title={form.id ? 'Edit User' : 'Add New User'} onClose={() => setForm(null)}>
          <Inp label="Full Name *" value={form.name} onChange={e => setForm({...form, name: e.target.value})} placeholder="Display name"/>
          <Inp label="Username *" value={form.username} onChange={e => setForm({...form, username: e.target.value})} placeholder="Login username"/>
          <Inp label={form.id ? 'New Password (leave blank to keep)' : 'Password *'} type="password"
            value={form.password} onChange={e => setForm({...form, password: e.target.value})} placeholder="Password"/>

          {/* Role Selector */}
          <div className="mb-3">
            <label className="block text-xs font-semibold text-gray-600 mb-1 uppercase tracking-wide">Role *</label>
            <select value={form.role}
              onChange={e => setForm({...form, role: e.target.value, allowedModules: e.target.value==='custom' ? (form.allowedModules||[]) : undefined})}
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-800 outline-none focus:border-red-400 focus:ring-2 focus:ring-red-100 bg-white">
              <option value="admin">🔐 Admin — Full Access (View, Add, Edit, Delete)</option>
              <option value="principal">🎓 Principal — Add &amp; View Only</option>
              <option value="accountant">🧾 Accountant — Fees, Cash Book &amp; Expenses</option>
              <option value="teacher">📖 Teacher — Notifications &amp; Complaints</option>
              <option value="custom">⚙️ Custom — Select Modules Manually</option>
            </select>

            {/* Role description hints */}
            {form.role === 'admin'      && <p className="text-xs text-blue-600 mt-1.5 bg-blue-50 px-3 py-1.5 rounded-lg">✅ Full system access. Can View, Add, Edit and Delete everything.</p>}
            {form.role === 'principal'  && <p className="text-xs text-green-700 mt-1.5 bg-green-50 px-3 py-1.5 rounded-lg">👁️ Can view all modules and add new entries. Edit/Delete buttons are hidden.</p>}
            {form.role === 'accountant' && <p className="text-xs text-teal-700 mt-1.5 bg-teal-50 px-3 py-1.5 rounded-lg">🧾 Access limited to: Fees, Student Ledger, Cash Book, Expenses, Family Ledger.</p>}
            {form.role === 'teacher'    && <p className="text-xs text-purple-700 mt-1.5 bg-purple-50 px-3 py-1.5 rounded-lg">📢 Access limited to: Notifications and Complaints only.</p>}
          </div>

          {/* Custom Module Selector */}
          {form.role === 'custom' && (
            <div className="border-2 border-dashed border-red-200 bg-red-50/40 rounded-xl p-4 mt-1">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-sm font-bold text-gray-700">⚙️ Select Allowed Modules</span>
                <span className="relative group cursor-help">
                  <span className="w-4 h-4 rounded-full bg-gray-400 text-white text-xs font-bold flex items-center justify-center inline-flex">i</span>
                  <span className="absolute left-6 top-0 z-50 hidden group-hover:block bg-gray-800 text-white text-xs rounded-lg px-3 py-2 w-56 shadow-xl">
                    Use this to manually set access for any staff member. E.g. select only "Notifications" for a Guard.
                  </span>
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {[
                  {id:'dashboard',     icon:'🏠', label:'Dashboard'},
                  {id:'students',      icon:'👨‍🎓', label:'Students'},
                  {id:'feecollect',    icon:'💰', label:'Fee Collection'},
                  {id:'fees',          icon:'📒', label:'Student Ledger'},
                  {id:'inventory',     icon:'📦', label:'Inventory'},
                  {id:'expenses',      icon:'🧾', label:'Expenses'},
                  {id:'family',        icon:'👨‍👩‍👧‍👦', label:'Family Ledger'},
                  {id:'staff',         icon:'👩‍🏫', label:'Staff & Salary'},
                  {id:'books',         icon:'📚', label:'Books & Vendors'},
                  {id:'exams',         icon:'📝', label:'Exams'},
                  {id:'cashbook',      icon:'💼', label:'Cash Book'},
                  {id:'notifications', icon:'📢', label:'Notifications'},
                ].map(m => {
                  const checked = (form.allowedModules||[]).includes(m.id);
                  return (
                    <label key={m.id} className={`flex items-center gap-2 cursor-pointer text-xs rounded-lg px-2 py-2 border transition-all ${checked ? 'bg-red-600 text-white border-red-600 font-semibold' : 'bg-white text-gray-700 border-gray-200 hover:border-red-300 hover:bg-red-50'}`}>
                      <input type="checkbox" checked={checked}
                        onChange={e => {
                          const mods = form.allowedModules || [];
                          setForm({...form, allowedModules: e.target.checked ? [...mods, m.id] : mods.filter(x => x !== m.id)});
                        }}
                        className="sr-only"/>
                      <span>{m.icon}</span>
                      <span>{m.label}</span>
                      {checked && <span className="ml-auto">✓</span>}
                    </label>
                  );
                })}
              </div>
              <p className="text-xs text-gray-400 mt-2">Selected: {(form.allowedModules||[]).length} modules</p>
            </div>
          )}

          <div className="flex gap-2 mt-5">
            <Btn full onClick={save}>{form.id ? 'Update User' : 'Save User'}</Btn>
            <Btn variant="outline" onClick={() => setForm(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {delId && (
        <Modal title="Delete User" onClose={() => setDelId(null)}>
          <p className="text-gray-600 mb-5">Delete user <strong>{users.find(u=>u.id===delId)?.name}</strong>?</p>
          <div className="flex gap-2">
            <Btn full variant="red" onClick={remove}>Delete</Btn>
            <Btn variant="outline" onClick={() => setDelId(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {pwMod && (
        <Modal title="Change My Password" onClose={() => setPwMod(null)}>
          <Inp label="Current Password *" type="password" value={pwForm.cur} onChange={e => setPwForm({...pwForm, cur: e.target.value})}/>
          <Inp label="New Password *" type="password" value={pwForm.newp} onChange={e => setPwForm({...pwForm, newp: e.target.value})}/>
          <Inp label="Confirm New Password *" type="password" value={pwForm.conf} onChange={e => setPwForm({...pwForm, conf: e.target.value})}/>
          <div className="flex gap-2 mt-5">
            <Btn full variant="green" onClick={changePw}>Change Password</Btn>
            <Btn variant="outline" onClick={() => setPwMod(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {approveModal && (
        <Modal title="Approve Parent Account" onClose={() => setApproveModal(null)}>
          <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 mb-4">
            <p className="text-sm font-bold text-gray-800">{approveModal.req.name}</p>
            <p className="text-xs text-gray-500 mt-0.5">Username: <strong>{approveModal.req.username}</strong></p>
          </div>
          <Inp label="Family ID / Sibling Number *"
            value={approveModal.familyId}
            onChange={e => setApproveModal({...approveModal, familyId: e.target.value})}
            placeholder="e.g. F-001 or FAM-2025-01"
          />
          <p className="text-xs text-gray-400 mb-4">This ID links the parent to their children's records. Use the same Family ID set on the student profiles.</p>
          <div className="flex gap-2">
            <Btn full onClick={approveParent}>✓ Approve & Activate Login</Btn>
            <Btn variant="outline" onClick={() => setApproveModal(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {adminReset && (
        <Modal title={`Reset Password — ${adminReset.user.name}`} onClose={() => setAdminReset(null)}>
          <p className="text-xs text-gray-500 mb-4">Set a new password for <strong>{adminReset.user.name}</strong> ({adminReset.user.role}).</p>
          <Inp label="New Password *" type="text" value={adminReset.newp} onChange={e => setAdminReset({...adminReset, newp: e.target.value})} placeholder="Enter new password"/>
          <div className="flex gap-2 mt-5">
            <Btn full variant="green" onClick={adminResetPw}>Reset Password</Btn>
            <Btn variant="outline" onClick={() => setAdminReset(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── VENDOR & BOOKS ────────────────────────────────────────────────────────────
function VendorBooks() {
  const { role, username, name: userName } = React.useContext(UserContext);
  const isAdmin  = role === 'admin';
  const [tab, setTab]       = useState('books');
  // Integrity guard at mount
  const [vendors, setVendors] = useState(() => getActiveList(K.VENDOR));
  const [books, setBooks]   = useState(() => getActiveList(K.SBOOK));
  const [selYear, setSelYear] = useState(NOW.getFullYear());
  const [selCls, setSelCls]   = useState('All');
  const [vForm, setVForm]   = useState(null);
  const [bForm, setBForm]   = useState(null);
  const [delVId, setDelVId] = useState(null);
  const [delBId, setDelBId] = useState(null);
  const years = Array.from({length:5},(_,i)=>NOW.getFullYear()-1+i);

  const [vpays, setVpays] = useState(() => getActiveList(K.VPAY));
  const [vpayMod, setVpayMod] = useState(null);
  const [vpf, setVpf] = useState({ amount: '', date: new Date().toISOString().split('T')[0], method: 'Cash', note: '' });
  const [selVendorHist, setSelVendorHist] = useState('');
  const [selVL, setSelVL] = useState('');

  const persistV = d => { S.set(K.VENDOR, d); setVendors(d); };
  const persistB = d => { S.set(K.SBOOK, d); setBooks(d); };
  const persistVP = d => { S.set(K.VPAY, d); setVpays(d); };

  const vendorBooksTotal = (vendorId) => books.filter(b => b.vendorId === vendorId).reduce((s,b) => s + Number(b.qty||0)*Number(b.price||0), 0);
  const vendorPaidTotal  = (vendorId) => vpays.filter(p => p.vendorId === vendorId).reduce((s,p) => s + Number(p.amount||0), 0);

  const openVpay = (vendor) => {
    setVpayMod(vendor);
    setVpf({ amount: '', date: new Date().toISOString().split('T')[0], method: 'Cash', note: '' });
  };

  const saveVpay = () => {
    if (!vpf.amount || Number(vpf.amount) <= 0) return alert('Enter a valid amount.');
    const vendor = vpayMod;
    const cbEntryId = uid(); // pre-generate Cash Book entry ID for linkage + reversal
    const pay = {
      id: uid(),
      vendorId: vendor.id,
      amount: Number(vpf.amount),
      date: vpf.date,
      method: vpf.method || 'Cash',
      note: vpf.note,
      rcpt: 'VP-' + Date.now().toString().slice(-6),
      cbEntryId, // link to Cash Book
    };
    // v75-8: stamp who recorded this vendor payment
    Object.assign(pay, getCreator());
    persistVP([...vpays, pay]);
    // ── Auto-post to Daily Cash Book as Expense (Vendor Payment head) ──
    addCashBookEntry('expense', `Vendor Payment — ${vendor.name}`, pay.amount, pay.method, pay.date, pay.note || '', 'vendor', cbEntryId);
    // ── Audit Trail ──
    logAudit(username, userName, 'CREATE', 'Vendor Payment', {}, { vendor: vendor.name, amount: pay.amount, method: pay.method, rcpt: pay.rcpt });
    setVpayMod(null);
    printVpay(pay, vendor);
  };

  const deleteVpay = (pay) => {
    const vendor = vendors.find(v => v.id === pay.vendorId);
    if (!window.confirm(`Delete payment ${pay.rcpt} — Rs. ${Number(pay.amount).toLocaleString()} paid to ${vendor?.name||'vendor'}?\n\n• Amount returns to vendor Payables/Outstanding Dues.\n• Linked Cash Book entry is removed.\n• Historical note logs are preserved on the vendor profile.`)) return;
    // Phase 3: Preserve historical note as a deletionMemo on the vendor before removing the payment
    if (vendor && pay.note) {
      const memo = {
        id: uid(),
        date: pay.date ? String(pay.date).slice(0,10) : '',
        rcpt: pay.rcpt || '',
        amount: Number(pay.amount||0),
        method: pay.method || pay.paymentMethod || 'Cash',
        note: pay.note,
        deletedAt: new Date().toISOString(),
      };
      const updatedVendors = vendors.map(v => v.id === vendor.id
        ? { ...v, deletionMemos: Array.isArray(v.deletionMemos) ? [...v.deletionMemos, memo] : [memo] }
        : v);
      persistV(updatedVendors);
    }
    // Remove from vendor payments
    persistVP(vpays.filter(p => p.id !== pay.id));
    // Reverse linked Cash Book entry
    if (pay.cbEntryId) {
      const cbook = S.get(K.CBOOK, []);
      S.set(K.CBOOK, cbook.filter(e => e.id !== pay.cbEntryId));
    }
    // Audit Trail
    logAudit(username, userName, 'DELETE', 'Vendor Payment', { vendor: vendor?.name, amount: pay.amount, method: pay.method, rcpt: pay.rcpt }, { historicalNotePreserved: !!(vendor && pay.note) });
  };

  const printVpay = (pay, vendor) => {
    const win = window.open('', '_blank', 'width=420,height=560');
    if (!win) { alert('Popup blocked! Please allow popups for this site to print.'); return; }
    win.document.write(`<!DOCTYPE html><html><head><title>Vendor Payment</title>
      <style>
        body{font-family:'Segoe UI',Arial,sans-serif;padding:26px;max-width:380px;margin:0 auto;color:#1a1a1a}
        .logo-hdr{text-align:center;margin-bottom:10px;padding-bottom:10px;border-bottom:2px solid #c0392b}
        .logo-hdr img{height:60px;object-fit:contain}
        h2{text-align:center;color:#1e3a8a;margin:6px 0 2px;font-size:16px;font-weight:800;letter-spacing:1px}
        .divider{border:none;border-top:1px dashed #d1d5db;margin:10px 0}
        .grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}
        .label{font-size:10px;color:#6b7280;margin-bottom:2px;text-transform:uppercase}
        .value{font-size:12px;font-weight:600}
        .total{display:flex;justify-content:space-between;align-items:center;background:#eff6ff;padding:10px 14px;border-radius:8px;margin:10px 0}
        .total-label{font-size:13px;font-weight:700;color:#1d4ed8}
        .total-val{font-size:20px;font-weight:800;color:#1d4ed8}
        .dev-footer{text-align:center;margin-top:14px;padding-top:8px;border-top:1px solid #e5e7eb;font-size:8px;color:#9ca3af;letter-spacing:.3px}
        @media print{body{padding:10px}button{display:none!important}}
      </style></head><body>
      <div class="logo-hdr"><img src="${LOGO_SRC}" alt="DISS" onerror="this.style.display='none'"/></div>
      <h2>VENDOR PAYMENT SLIP</h2>
      <hr class="divider"/>
      <div class="grid">
        <div><div class="label">Receipt No</div><div class="value">${pay.rcpt}</div></div>
        <div><div class="label">Date</div><div class="value">${new Date(pay.date).toLocaleDateString('en-PK')}</div></div>
        <div><div class="label">Vendor</div><div class="value">${vendor.name}</div></div>
        <div><div class="label">Contact</div><div class="value">${vendor.contact||'—'}</div></div>
        <div><div class="label">Payment Method</div><div class="value">${pay.method||'Cash'}</div></div>
      </div>
      <hr class="divider"/>
      <div class="total">
        <span class="total-label">Amount Paid</span>
        <span class="total-val">Rs. ${Number(pay.amount).toLocaleString()}</span>
      </div>
      ${(() => { const _n = cleanNoteForReceipt(pay.note); return _n ? `<p style="font-size:11px;color:#6b7280">Note: ${_n}</p>` : ''; })()}
      <hr class="divider"/>
      <div style="display:flex;justify-content:space-between;margin-top:30px;font-size:11px;color:#6b7280">
        <span>Authorized By: _______________</span><span>Vendor Signature: _______________</span>
      </div>
      ${getPrintAudit()}
      <div class="dev-footer">© 2026 DISS — All Rights Reserved &nbsp;|&nbsp; Powered by Tataheer Business Group &nbsp;|&nbsp; +923218555566</div>
      <script>window.onload=function(){window.print();}<\/script>
    </body></html>`);
    win.document.close();
  };

  const saveVendor = () => {
    if (!vForm.name.trim()) return alert('Vendor name is required.');
    const u = vForm.id ? vendors.map(v => v.id===vForm.id ? vForm : v) : [...vendors, {...vForm, id:uid()}];
    persistV(u); setVForm(null);
  };

  const saveBook = () => {
    if (!bForm.name.trim()) return alert('Book name is required.');
    const u = bForm.id ? books.map(b => b.id===bForm.id ? bForm : b) : [...books, {...bForm, id:uid()}];
    persistB(u); setBForm(null);
  };

  const filteredBooks = books.filter(b => b.year === selYear && (selCls === 'All' || b.cls === selCls));

  const booksByClass = {};
  CLASSES.forEach(c => { booksByClass[c] = []; });
  filteredBooks.forEach(b => { if (booksByClass[b.cls]) booksByClass[b.cls].push(b); });

  const grandTotal = filteredBooks.reduce((s,b) => s + Number(b.qty||0)*Number(b.price||0), 0);

  const printBooks = () => {
    const sections = CLASSES.filter(c => booksByClass[c]?.length > 0).map(cls => {
      const rows = booksByClass[cls].map((b,i) => {
        const vend = vendors.find(v => v.id === b.vendorId);
        return `<tr><td>${i+1}</td><td><b>${b.name}</b></td><td>${vend?.name||'—'}</td><td style="text-align:center">${b.qty||0}</td><td style="text-align:right">Rs. ${Number(b.price||0).toLocaleString()}</td><td style="text-align:right">Rs. ${(Number(b.qty||0)*Number(b.price||0)).toLocaleString()}</td></tr>`;
      }).join('');
      const total = booksByClass[cls].reduce((s,b)=>s+Number(b.qty||0)*Number(b.price||0),0);
      return `<h3 style="color:#1e3a8a;margin:16px 0 6px">Class ${cls}</h3>
        <table><thead><tr><th>#</th><th>Book Name</th><th>Vendor</th><th style="text-align:center">Qty</th><th style="text-align:right">Price</th><th style="text-align:right">Total</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td colspan="5" style="text-align:right"><b>Class Total:</b></td><td style="text-align:right"><b>Rs. ${total.toLocaleString()}</b></td></tr></tfoot></table>`;
    }).join('');
    printPage(`Session Books — ${selYear}`, `
      <h2>Session Books — ${selYear}${selCls!=='All'?' | Class '+selCls:''}</h2>
      <div class="summary">
        <div class="sum-card"><div class="val">${filteredBooks.length}</div><div class="lbl">Total Books</div></div>
        <div class="sum-card"><div class="val">${vendors.length}</div><div class="lbl">Vendors</div></div>
        <div class="sum-card"><div class="val">Rs. ${grandTotal.toLocaleString()}</div><div class="lbl">Grand Total</div></div>
      </div>${sections}`);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-xl font-bold text-gray-800">Books & Vendors</h2>
        <Btn variant="outline" onClick={printBooks}>🖨️ Print</Btn>
      </div>

      <div className="flex gap-1 bg-gray-100 p-1 rounded-xl w-fit mb-5 flex-wrap">
        {[['books','📚 Session Books'],['vendors','🏪 Vendors'],['payments','💳 Vendor Payments'],['vledger','📊 Vendor Ledger']].map(([k,l])=>(
          <button key={k} onClick={()=>setTab(k)}
            className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${tab===k?'bg-white shadow text-blue-700':'text-gray-500 hover:text-gray-700'}`}>{l}</button>
        ))}
      </div>

      {/* ── VENDORS TAB ── */}
      {tab === 'vendors' && (
        <div>
          <div className="mb-4">
            <Btn onClick={() => setVForm({ name:'', contact:'', address:'', note:'' })}>+ Add Vendor</Btn>
          </div>
          {vendors.length === 0
            ? <Empty icon="🏪" text="No vendors yet. Add a book supplier to get started."/>
            : <Card className="overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b">
                      <tr className="text-left text-xs text-gray-500 font-semibold uppercase">
                        <th className="px-4 py-3">#</th>
                        <th className="px-4 py-3">Vendor Name</th>
                        <th className="px-4 py-3 hidden sm:table-cell">Contact</th>
                        <th className="px-4 py-3 hidden md:table-cell">Books Total</th>
                        <th className="px-4 py-3 hidden md:table-cell">Paid</th>
                        <th className="px-4 py-3 hidden md:table-cell">Balance</th>
                        <th className="px-4 py-3 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {vendors.map((v,i) => {
                        const bTotal = vendorBooksTotal(v.id);
                        const pTotal = vendorPaidTotal(v.id);
                        const balance = bTotal - pTotal;
                        return (
                        <tr key={v.id} className="hover:bg-slate-50">
                          <td className="px-4 py-3 text-gray-400">{i+1}</td>
                          <td className="px-4 py-3 font-semibold text-gray-800">{v.name}</td>
                          <td className="px-4 py-3 text-gray-500 hidden sm:table-cell">{v.contact||'—'}</td>
                          <td className="px-4 py-3 text-gray-600 hidden md:table-cell">Rs. {bTotal.toLocaleString()}</td>
                          <td className="px-4 py-3 text-emerald-700 font-semibold hidden md:table-cell">Rs. {pTotal.toLocaleString()}</td>
                          <td className="px-4 py-3 hidden md:table-cell">
                            <Badge color={balance <= 0 ? 'green' : 'red'}>{balance <= 0 ? 'Cleared' : `Rs. ${balance.toLocaleString()}`}</Badge>
                          </td>
                          <td className="px-4 py-3 text-right space-x-1">
                            <Btn sm variant="outline" onClick={() => openVpay(v)}>💳 Pay</Btn>
                            {isAdmin && <Btn sm variant="outline" onClick={() => window.requireMasterCode(() => setVForm({...v}), `Edit vendor: ${v.name}`)}>Edit</Btn>}
                            {isAdmin && <Btn sm variant="red" onClick={() => window.requireMasterCode(() => setDelVId(v.id), `Delete vendor: ${v.name}`)}>Delete</Btn>}
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
          }
        </div>
      )}

      {/* ── BOOKS TAB ── */}
      {tab === 'books' && (
        <div>
          <div className="flex flex-wrap gap-2 mb-4 items-center">
            <select value={selYear} onChange={e => setSelYear(Number(e.target.value))} className={inputCls+' w-auto'}>
              {years.map(y=><option key={y}>{y}</option>)}
            </select>
            <select value={selCls} onChange={e => setSelCls(e.target.value)} className={inputCls+' w-auto'}>
              <option value="All">All Classes</option>
              {CLASSES.map(c=><option key={c} value={c}>Class {c}</option>)}
            </select>
            <Btn onClick={() => setBForm({ name:'', cls: selCls==='All'?'1':selCls, vendorId: vendors[0]?.id||'', qty:1, price:0, year: selYear, note:'' })}>
              + Add Book
            </Btn>
          </div>

          {vendors.length === 0 && (
            <div className="bg-amber-50 border border-amber-200 text-amber-700 text-sm px-4 py-3 rounded-xl mb-4">
              ⚠️ No vendors added yet. Go to the Vendors tab to add a book supplier first.
            </div>
          )}

          {filteredBooks.length === 0
            ? <Empty icon="📚" text="No books added for this session/class yet."/>
            : CLASSES.filter(c => booksByClass[c]?.length > 0).map(cls => {
                const clsBooks = booksByClass[cls];
                const clsTotal = clsBooks.reduce((s,b)=>s+Number(b.qty||0)*Number(b.price||0),0);
                return (
                  <Card key={cls} className="overflow-hidden mb-4">
                    <div className="px-5 py-3 bg-blue-50 border-b border-blue-100 flex items-center justify-between">
                      <h3 className="font-bold text-blue-900">Class {cls}</h3>
                      <span className="text-sm font-bold text-emerald-700">Total: Rs. {clsTotal.toLocaleString()}</span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50 border-b">
                          <tr className="text-left text-xs text-gray-500 font-semibold uppercase">
                            <th className="px-4 py-2">#</th>
                            <th className="px-4 py-2">Book Name</th>
                            <th className="px-4 py-2">Vendor</th>
                            <th className="px-4 py-2 text-center">Qty</th>
                            <th className="px-4 py-2 text-right">Price</th>
                            <th className="px-4 py-2 text-right">Total</th>
                            {isAdmin && <th className="px-4 py-2 text-right">Actions</th>}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50">
                          {clsBooks.map((b,i) => {
                            const vend = vendors.find(v=>v.id===b.vendorId);
                            return (
                              <tr key={b.id} className="hover:bg-slate-50">
                                <td className="px-4 py-2 text-gray-400">{i+1}</td>
                                <td className="px-4 py-2 font-medium text-gray-800">{b.name}</td>
                                <td className="px-4 py-2"><Badge color="purple">{vend?.name||'—'}</Badge></td>
                                <td className="px-4 py-2 text-center text-gray-600">{b.qty}</td>
                                <td className="px-4 py-2 text-right text-gray-600">Rs. {Number(b.price||0).toLocaleString()}</td>
                                <td className="px-4 py-2 text-right font-semibold text-gray-800">Rs. {(Number(b.qty||0)*Number(b.price||0)).toLocaleString()}</td>
                                {isAdmin && (
                                  <td className="px-4 py-2 text-right space-x-1">
                                    <Btn sm variant="outline" onClick={() => setBForm({...b})}>Edit</Btn>
                                    <Btn sm variant="red" onClick={() => setDelBId(b.id)}>Del</Btn>
                                  </td>
                                )}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                );
              })
          }

          {filteredBooks.length > 0 && (
            <Card className="p-4 bg-emerald-50 border-emerald-200">
              <div className="flex justify-between items-center">
                <span className="font-bold text-emerald-800">Grand Total — {selYear}{selCls!=='All'?' | Class '+selCls:' | All Classes'}</span>
                <span className="text-xl font-extrabold text-emerald-700">Rs. {grandTotal.toLocaleString()}</span>
              </div>
            </Card>
          )}
        </div>
      )}

      {/* ── PAYMENTS TAB ── */}
      {tab === 'payments' && (
        <div>
          <div className="flex flex-wrap gap-2 mb-4 items-center">
            <select value={selVendorHist} onChange={e => setSelVendorHist(e.target.value)} className={inputCls+' w-auto'}>
              <option value="">All Vendors</option>
              {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
            {vendors.filter(v => !selVendorHist || v.id === selVendorHist).map(v => {
              const bTotal = vendorBooksTotal(v.id);
              const pTotal = vendorPaidTotal(v.id);
              const balance = bTotal - pTotal;
              return (
                <Card key={v.id} className="p-4">
                  <p className="font-bold text-gray-800 mb-1">{v.name}</p>
                  <div className="flex justify-between text-xs text-gray-500 mb-1"><span>Books Supplied:</span><span className="font-semibold text-gray-700">Rs. {bTotal.toLocaleString()}</span></div>
                  <div className="flex justify-between text-xs text-gray-500 mb-1"><span>Total Paid:</span><span className="font-semibold text-emerald-700">Rs. {pTotal.toLocaleString()}</span></div>
                  <div className="flex justify-between text-xs font-bold border-t border-gray-100 pt-1 mt-1">
                    <span>Balance Due:</span>
                    <span className={balance > 0 ? 'text-red-600' : 'text-emerald-600'}>{balance > 0 ? `Rs. ${balance.toLocaleString()}` : 'Cleared'}</span>
                  </div>
                  {balance > 0 && <Btn sm full variant="green" onClick={() => openVpay(v)} className="mt-2">💳 Pay Vendor</Btn>}
                </Card>
              );
            })}
          </div>

          {vpays.filter(p => !selVendorHist || p.vendorId === selVendorHist).length === 0
            ? <Empty icon="💳" text="No vendor payments recorded yet."/>
            : <Card className="overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b">
                      <tr className="text-left text-xs text-gray-500 font-semibold uppercase">
                        <th className="px-4 py-3">Receipt</th>
                        <th className="px-4 py-3">Vendor</th>
                        <th className="px-4 py-3">Amount</th>
                        <th className="px-4 py-3">Method</th>
                        <th className="px-4 py-3 hidden sm:table-cell">Date</th>
                        <th className="px-4 py-3 hidden sm:table-cell">Note</th>
                        <th className="px-4 py-3 hidden sm:table-cell">Cash Book</th>
                        <th className="px-4 py-3 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {[...vpays].filter(p => !selVendorHist || p.vendorId === selVendorHist).reverse().map(p => {
                        const vendor = vendors.find(v => v.id === p.vendorId);
                        return (
                          <tr key={p.id} className="hover:bg-slate-50">
                            <td className="px-4 py-3 font-mono text-xs text-gray-500">{p.rcpt}</td>
                            <td className="px-4 py-3 font-semibold text-gray-800">{vendor?.name||'—'}</td>
                            <td className="px-4 py-3 font-bold text-blue-700">Rs. {Number(p.amount).toLocaleString()}</td>
                            <td className="px-4 py-3"><Badge color={p.method==='Bank Transfer'?'blue':p.method==='JazzCash'||p.method==='Easypaisa'?'purple':'green'}>{p.method||'Cash'}</Badge></td>
                            <td className="px-4 py-3 text-gray-400 hidden sm:table-cell text-xs">{new Date(p.date).toLocaleDateString('en-PK')}</td>
                            <td className="px-4 py-3 text-gray-400 hidden sm:table-cell text-xs">{p.note||'—'}</td>
                            <td className="px-4 py-3 hidden sm:table-cell">
                              {p.cbEntryId
                                ? <Badge color="green">✅ Auto-posted</Badge>
                                : <Badge color="yellow">⚠️ Manual</Badge>}
                            </td>
                            <td className="px-4 py-3 text-right space-x-1">
                              <Btn sm variant="outline" onClick={() => vendor && printVpay(p, vendor)}>🖨️</Btn>
                              {isAdmin && <Btn sm variant="red" onClick={() => window.requireMasterCode(() => deleteVpay(p), `Delete vendor payment: Rs. ${Number(p.amount).toLocaleString()}`)}>🗑️</Btn>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
          }
        </div>
      )}

      {/* ── VENDOR LEDGER TAB ── */}
      {tab === 'vledger' && (() => {
        const vledgerId = selVL || (vendors[0]?.id || '');
        const vendor = vendors.find(v => v.id === vledgerId);
        if (vendors.length === 0) return <Empty icon="🏪" text="No vendors added yet. Add vendors first."/>;
        // Build ledger entries (books + inventory deliveries)
        const entries = [];
        books.filter(b => b.vendorId === vledgerId).forEach(b => {
          const amt = Number(b.qty||0) * Number(b.price||0);
          if (b.invItem) {
            // Inventory delivery (from Inventory module Stock In)
            const entryDate = b.date || (String(b.year)+'-01-01');
            if (amt > 0 || Number(b.qty||0) > 0) entries.push({ date: entryDate, desc: `📦 Inventory — ${b.name} (${b.note||'Stock In'})`, qty: Number(b.qty||0), rate: Number(b.price||0), dr: 0, cr: amt, type: 'inv' });
          } else {
            if (amt > 0) entries.push({ date: String(b.year)+'-01-01', desc: `📚 Books — ${b.name} (Class ${b.cls}, Session ${b.year})`, qty: Number(b.qty||0), rate: Number(b.price||0), dr: 0, cr: amt, type: 'in' });
          }
        });
        vpays.filter(p => p.vendorId === vledgerId).forEach(p => {
          entries.push({ date: p.date, desc: `Payment — ${p.rcpt}${p.note?' | '+p.note:''}`, qty: 0, rate: 0, dr: Number(p.amount||0), cr: 0, type: 'pay' });
        });
        entries.sort((a,b) => new Date(a.date) - new Date(b.date));
        let running = 0;
        const rows = entries.map((e,i) => { running += e.cr - e.dr; return {...e, running, i}; });
        const totalCr = entries.reduce((s,e)=>s+e.cr,0);
        const totalDr = entries.reduce((s,e)=>s+e.dr,0);
        const balance = totalCr - totalDr;
        return (
          <div>
            <div className="flex flex-wrap gap-2 mb-4 items-center">
              <select value={vledgerId} onChange={e => setSelVL(e.target.value)} className={inputCls+' w-auto'}>
                {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
                <p className="text-xs text-blue-500 font-semibold uppercase mb-1">📦 Total Supplied (Cr)</p>
                <p className="text-xl font-extrabold text-blue-700">Rs. {totalCr.toLocaleString()}</p>
                <p className="text-xs text-gray-400 mt-0.5">Books &amp; inventory received from vendor</p>
              </div>
              <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4">
                <p className="text-xs text-emerald-600 font-semibold uppercase mb-1">💳 Total Paid (Dr)</p>
                <p className="text-xl font-extrabold text-emerald-700">Rs. {totalDr.toLocaleString()}</p>
                <p className="text-xs text-gray-400 mt-0.5">Payments made to vendor</p>
              </div>
              <div className={`${balance>0?'bg-red-50 border-red-200':'bg-emerald-50 border-emerald-200'} border rounded-xl p-4`}>
                <p className={`text-xs font-semibold uppercase mb-1 ${balance>0?'text-red-500':'text-emerald-600'}`}>⚖️ Balance Due</p>
                <p className={`text-xl font-extrabold ${balance>0?'text-red-600':'text-emerald-700'}`}>Rs. {Math.abs(balance).toLocaleString()}</p>
                <p className="text-xs text-gray-400 mt-0.5">{balance>0?'We owe vendor':balance<0?'Overpaid':'Fully cleared'}</p>
              </div>
            </div>
            {rows.length === 0
              ? <Empty icon="📊" text="No transactions found for this vendor."/>
              : <Card className="overflow-hidden">
                  <div className="px-4 py-3 bg-gray-800 text-white flex items-center justify-between">
                    <p className="font-bold">📊 Ledger — {vendor?.name}</p>
                    <p className="text-xs opacity-70">{vendor?.contact||''}</p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-100 border-b">
                        <tr className="text-xs text-gray-600 font-bold uppercase">
                          <th className="px-3 py-2 text-left">#</th>
                          <th className="px-3 py-2 text-left">Date</th>
                          <th className="px-3 py-2 text-left">Description</th>
                          <th className="px-3 py-2 text-center">Qty</th>
                          <th className="px-3 py-2 text-right">Rate</th>
                          <th className="px-3 py-2 text-right text-red-600">Debit (Dr)</th>
                          <th className="px-3 py-2 text-right text-blue-600">Credit (Cr)</th>
                          <th className="px-3 py-2 text-right">Balance</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {rows.map(r => (
                          <tr key={r.i} className={`hover:bg-slate-50 ${r.type==='pay'?'bg-emerald-50':'bg-white'}`}>
                            <td className="px-3 py-2 text-gray-400 text-xs">{r.i+1}</td>
                            <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">{new Date(r.date).toLocaleDateString('en-PK')}</td>
                            <td className="px-3 py-2 text-gray-700 text-xs">{r.desc}</td>
                            <td className="px-3 py-2 text-center text-gray-600">{r.qty>0?r.qty:'—'}</td>
                            <td className="px-3 py-2 text-right text-gray-600">{r.rate>0?`Rs. ${r.rate.toLocaleString()}`:'—'}</td>
                            <td className="px-3 py-2 text-right font-semibold text-red-600">{r.dr>0?`Rs. ${r.dr.toLocaleString()}`:'—'}</td>
                            <td className="px-3 py-2 text-right font-semibold text-blue-700">{r.cr>0?`Rs. ${r.cr.toLocaleString()}`:'—'}</td>
                            <td className={`px-3 py-2 text-right font-bold ${r.running>0?'text-red-600':'text-emerald-700'}`}>
                              Rs. {Math.abs(r.running).toLocaleString()} <span className="text-xs font-normal">{r.running>0?'Dr':'Cr'}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="bg-gray-100 border-t-2 border-gray-300">
                        <tr className="font-bold text-sm">
                          <td colSpan="5" className="px-3 py-3 text-right text-gray-700">TOTAL</td>
                          <td className="px-3 py-3 text-right text-red-600">Rs. {totalDr.toLocaleString()}</td>
                          <td className="px-3 py-3 text-right text-blue-700">Rs. {totalCr.toLocaleString()}</td>
                          <td className={`px-3 py-3 text-right font-extrabold ${balance>0?'text-red-600':'text-emerald-700'}`}>
                            Rs. {Math.abs(balance).toLocaleString()} <span className="text-xs font-normal">{balance>0?'Dr':'Cr'}</span>
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </Card>
            }
          </div>
        );
      })()}

      {/* Vendor Form */}
      {vForm && (
        <Modal title={vForm.id ? 'Edit Vendor' : 'Add Vendor'} onClose={() => setVForm(null)}>
          <Inp label="Vendor / Supplier Name *" value={vForm.name} onChange={e => setVForm({...vForm, name: e.target.value})} placeholder="e.g. City Book House"/>
          <Inp label="Contact Number" value={vForm.contact||''} onChange={e => setVForm({...vForm, contact: e.target.value})} placeholder="e.g. 0321-1234567"/>
          <Inp label="Address" value={vForm.address||''} onChange={e => setVForm({...vForm, address: e.target.value})} placeholder="Vendor address"/>
          <Inp label="Note" value={vForm.note||''} onChange={e => setVForm({...vForm, note: e.target.value})} placeholder="Optional notes"/>
          <div className="flex gap-2 mt-5">
            <Btn full onClick={saveVendor}>{vForm.id ? 'Update' : 'Save Vendor'}</Btn>
            <Btn variant="outline" onClick={() => setVForm(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {/* Book Form */}
      {bForm && (
        <Modal title={bForm.id ? 'Edit Book' : 'Add Book'} onClose={() => setBForm(null)}>
          <Inp label="Book Name *" value={bForm.name} onChange={e => setBForm({...bForm, name: e.target.value})} placeholder="e.g. English Written"/>
          <Sel label="Class *" value={bForm.cls} onChange={e => setBForm({...bForm, cls: e.target.value})} options={CLASSES.map(c=>({v:c,l:`Class ${c}`}))}/>
          <Sel label="Vendor *" value={bForm.vendorId||''} onChange={e => setBForm({...bForm, vendorId: e.target.value})}
            options={vendors.length ? vendors.map(v=>({v:v.id,l:v.name})) : [{v:'',l:'— Add a vendor first —'}]}/>
          <div className="flex gap-2">
            <div className="flex-1"><Inp label="Quantity" type="number" min="0" value={bForm.qty} onChange={e => setBForm({...bForm, qty: Number(e.target.value)})}/></div>
            <div className="flex-1"><Inp label="Price (Rs.)" type="number" min="0" value={bForm.price} onChange={e => setBForm({...bForm, price: Number(e.target.value)})}/></div>
          </div>
          <Sel label="Session Year *" value={bForm.year} onChange={e => setBForm({...bForm, year: Number(e.target.value)})} options={years.map(y=>({v:y,l:String(y)}))}/>
          <Inp label="Note (optional)" value={bForm.note||''} onChange={e => setBForm({...bForm, note: e.target.value})} placeholder="Additional info"/>
          <div className="flex gap-2 mt-5">
            <Btn full onClick={saveBook}>{bForm.id ? 'Update Book' : 'Save Book'}</Btn>
            <Btn variant="outline" onClick={() => setBForm(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {delVId && (
        <Modal title="Delete Vendor" onClose={() => setDelVId(null)}>
          <p className="text-gray-600 mb-5">Delete vendor <strong>{vendors.find(v=>v.id===delVId)?.name}</strong>?</p>
          <div className="flex gap-2">
            <Btn full variant="red" onClick={() => { persistV(vendors.filter(v=>v.id!==delVId)); setDelVId(null); }}>Delete</Btn>
            <Btn variant="outline" onClick={() => setDelVId(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {delBId && (
        <Modal title="Delete Book" onClose={() => setDelBId(null)}>
          <p className="text-gray-600 mb-5">Delete book <strong>{books.find(b=>b.id===delBId)?.name}</strong>?</p>
          <div className="flex gap-2">
            <Btn full variant="red" onClick={() => { persistB(books.filter(b=>b.id!==delBId)); setDelBId(null); }}>Delete</Btn>
            <Btn variant="outline" onClick={() => setDelBId(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {/* Vendor Payment Modal */}
      {vpayMod && (() => {
        // Compute which account will be debited based on selected method
        const allAccts = S.get(K.ACCT, []);
        const allCbook = S.get(K.CBOOK, []);
        const acctBals = {};
        allAccts.forEach(a => { acctBals[a.id] = Number(a.openingBalance || 0); });
        allCbook.forEach(e => {
          if (acctBals[e.accountId] !== undefined)
            acctBals[e.accountId] += e.type === 'income' ? Number(e.amount) : -Number(e.amount);
        });
        let debitAcct;
        if (vpf.method === 'Bank Transfer') debitAcct = allAccts.find(a => a.type === 'bank');
        else if (vpf.method === 'JazzCash')  debitAcct = allAccts.find(a => a.name === 'JazzCash');
        else if (vpf.method === 'Easypaisa') debitAcct = allAccts.find(a => a.name === 'Easypaisa');
        else debitAcct = allAccts.find(a => a.type === 'cash');
        if (!debitAcct) debitAcct = allAccts[0];
        const debitBal = debitAcct ? (acctBals[debitAcct.id] || 0) : 0;
        const payAmt   = Number(vpf.amount || 0);
        const balAfter = debitBal - payAmt;
        const booksTotal   = vendorBooksTotal(vpayMod.id);
        const paidTotal    = vendorPaidTotal(vpayMod.id);
        const vendorBalance = Math.max(0, booksTotal - paidTotal);

        return (
          <Modal title={`💳 Pay Vendor — ${vpayMod.name}`} onClose={() => setVpayMod(null)}>
            {/* Vendor Summary */}
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 mb-4">
              <p className="font-bold text-blue-800 mb-1">{vpayMod.name}</p>
              {vpayMod.contact && <p className="text-xs text-blue-600 mb-2">📞 {vpayMod.contact}</p>}
              <div className="grid grid-cols-3 gap-2 text-xs text-center">
                <div className="bg-white rounded-lg p-2">
                  <p className="text-gray-400">Books Supplied</p>
                  <p className="font-extrabold text-gray-800">Rs. {booksTotal.toLocaleString()}</p>
                </div>
                <div className="bg-white rounded-lg p-2">
                  <p className="text-gray-400">Total Paid</p>
                  <p className="font-extrabold text-emerald-700">Rs. {paidTotal.toLocaleString()}</p>
                </div>
                <div className="bg-white rounded-lg p-2">
                  <p className="text-gray-400">Balance Due</p>
                  <p className="font-extrabold text-red-600">Rs. {vendorBalance.toLocaleString()}</p>
                </div>
              </div>
            </div>

            <Inp label="Amount (Rs.) *" type="number" min="1" value={vpf.amount}
              onChange={e => setVpf({...vpf, amount: e.target.value})} placeholder={`Enter payment (max: Rs. ${vendorBalance.toLocaleString()})`}/>
            <Inp label="Payment Date *" type="date" value={vpf.date} onChange={e => setVpf({...vpf, date: e.target.value})}/>

            {/* Payment Method */}
            <div className="mb-3">
              <label className="block text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wide">Payment Source (Account to Debit) *</label>
              <div className="flex flex-wrap gap-2">
                {PAYMENT_METHODS.map(m => (
                  <label key={m} className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border-2 cursor-pointer text-sm font-semibold transition-all ${vpf.method===m?'border-blue-500 bg-blue-50 text-blue-700':'border-gray-200 text-gray-500 hover:border-gray-300'}`}>
                    <input type="radio" name="vpMethod" value={m} checked={vpf.method===m} onChange={()=>setVpf({...vpf,method:m})} className="hidden"/>
                    {m==='Cash'?'💵':m==='Bank Transfer'?'🏦':m==='JazzCash'?'📱':'💳'} {m}
                  </label>
                ))}
              </div>
            </div>

            {/* Account Debit Preview */}
            {debitAcct && (
              <div className={`rounded-xl p-3 mb-3 text-sm border ${balAfter >= 0 ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-300'}`}>
                <p className="font-bold text-gray-700 mb-1.5">💳 Account Debit Preview</p>
                <div className="flex justify-between items-center text-xs mb-1">
                  <span className="text-gray-500">Account</span>
                  <span className="font-semibold text-gray-800">{debitAcct.name}</span>
                </div>
                <div className="flex justify-between items-center text-xs mb-1">
                  <span className="text-gray-500">Current Balance</span>
                  <span className="font-semibold text-blue-700">Rs. {debitBal.toLocaleString()}</span>
                </div>
                {payAmt > 0 && <>
                  <div className="flex justify-between items-center text-xs mb-1">
                    <span className="text-gray-500">Payment Amount</span>
                    <span className="font-semibold text-red-600">- Rs. {payAmt.toLocaleString()}</span>
                  </div>
                  <div className={`flex justify-between items-center text-xs border-t pt-1.5 mt-1 ${balAfter >= 0 ? 'border-emerald-200' : 'border-red-300'}`}>
                    <span className="font-bold text-gray-700">Balance After</span>
                    <span className={`font-extrabold ${balAfter >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                      {balAfter < 0 ? '-' : ''}Rs. {Math.abs(balAfter).toLocaleString()}
                      {balAfter < 0 && ' ⚠️ Insufficient!'}
                    </span>
                  </div>
                </>}
              </div>
            )}

            <Inp label="Note (optional)" value={vpf.note} onChange={e => setVpf({...vpf, note: e.target.value})} placeholder="e.g. Partial payment / invoice ref"/>

            {/* Auto-post notice */}
            <div className="bg-purple-50 border border-purple-200 rounded-xl p-2.5 mb-4 text-xs text-purple-700">
              ✅ This payment will automatically post an <strong>OUT entry</strong> in the Daily Cash Book and update the <strong>{debitAcct?.name || 'selected'}</strong> account balance.
            </div>

            <div className="flex gap-2">
              <Btn full variant="blue" onClick={saveVpay}>💾 Save & Print Slip</Btn>
              <Btn variant="outline" onClick={() => setVpayMod(null)}>Cancel</Btn>
            </div>
          </Modal>
        );
      })()}
    </div>
  );
}

// ── EXAM MODULE (Date Sheet + Result Cards) ──────────────────────────────────
function Exams() {
  // ── LIVE student list — subscribes to SyncContext so K.STU edits (name spelling
  // corrections, opening balance adjustments, etc.) made in the Students module
  // propagate INSTANTLY into all Exam views (Date Sheet, Result Cards, Paper).
  // Every sync echo (Firebase live listener) increments the context tick, which
  // re-evaluates this useMemo and re-reads K.STU from localStorage. Result: the
  // name you correct in Students appears in the result card the next render.
  const _examSyncTick = React.useContext(SyncContext);
  const students = useMemo(() => S.get(K.STU, []), [_examSyncTick]);
  // ── Tab state: saved to sessionStorage so Firebase sync (syncTick remount) doesn't reset it ──
  const [tab, setTab] = useState(() => sessionStorage.getItem('_examTab') || 'datesheet');
  const setTabSafe = (t) => {
    sessionStorage.setItem('_examTab', t);
    // Whole School mode only exists on the Result Cards tab — snap back to a
    // real class when leaving so Date Sheet / Paper never see '__ALL__'.
    if (t !== 'results' && selCls === '__ALL__') setSelCls(CLASSES[0]);
    setTab(t);
  };

  const [dateSheets, setDateSheets] = useState(() => S.get(K.DS, {}));
  // ── Phase 1: One-time purge of legacy class-less date sheet keys.
  //    Old format: `Term 1_2026`. New format: `Term 1_2026_Class 3`.
  //    Any key that doesn't match the new 3-part format gets removed once.
  useEffect(() => {
    const flag = 'sms_dsPurgeV1';
    if (localStorage.getItem(flag)) return;
    const cur = S.get(K.DS, {});
    const cleaned = {}; let removed = 0;
    Object.keys(cur).forEach(k => {
      const parts = k.split('_');
      const looksNew = parts.length >= 3 && /^\d{4}$/.test(parts[1]);
      if (looksNew) cleaned[k] = cur[k];
      else removed++;
    });
    if (removed > 0) { S.set(K.DS, cleaned); setDateSheets(cleaned); }
    try { localStorage.setItem(flag, '1'); } catch (e) {}
  }, []);
  // ── Phase 1 patch v3 (SAFER): The aggressive PG-class deletion path from v2
  //    has been REMOVED. It could wrongly delete legitimate customizations that
  //    happened to not include the 'Rhymes' / 'General Knowledge' markers.
  //    Now only the very safe case remains: a numeric class whose subject list
  //    explicitly contains PG markers is cleared (data integrity fix).
  //    NEVER touches PG classes. NEVER deletes user marks (K.RS) or subject
  //    totals (K.ST). Before writing, we back up the previous K.SL to
  //    sms_backups so restore is possible if this fires unexpectedly.
  useEffect(() => {
    const flag = 'sms_customSubjectsFixV3';
    if (localStorage.getItem(flag)) return;
    const cur = S.get(K.SL, {});
    const cleaned = { ...cur };
    let fixedCount = 0;
    const PG_MARKERS = ['Rhymes', 'General Knowledge', 'General Knowledge (O)'];
    const numericClass = (c) => /^([1-9]|10)$/.test(String(c));
    Object.keys(cur).forEach(cls => {
      if (!numericClass(cls)) return;
      const list = Array.isArray(cur[cls]) ? cur[cls] : [];
      const hasPGMarker = list.some(s => PG_MARKERS.includes(s));
      if (hasPGMarker) { delete cleaned[cls]; fixedCount++; }
    });
    if (fixedCount > 0) {
      // Safety net: back up the pre-migration K.SL so an admin can restore later.
      try {
        const backups = JSON.parse(localStorage.getItem('sms_backups') || '{}');
        backups[K.SL] = backups[K.SL] || [];
        backups[K.SL].unshift({ ts: Date.now(), reason: 'customSubjectsFixV3', data: cur });
        backups[K.SL] = backups[K.SL].slice(0, 5);
        localStorage.setItem('sms_backups', JSON.stringify(backups));
      } catch (e) {}
      S.set(K.SL, cleaned);
      setCustomSubjects(cleaned);
    }
    try { localStorage.setItem(flag, '1'); } catch (e) {}
  }, []);
  const [results, setResults]       = useState(() => S.get(K.RS, {}));
  // ── Smart auto-save for marks entry ────────────────────────────────────────
  // While you type, marks are buffered LOCALLY (localStorage + React state) but
  // NOT pushed to Firebase until 1.5 seconds after you stop typing.
  // This prevents the Firebase listener echo from causing the result-card screen
  // to remount and lose your input focus mid-entry. The status indicator shows
  // 'saved' / 'pending' / 'saving' so you always know where you stand.
  const [marksSaveState, setMarksSaveState] = useState('saved');
  const marksSaveTimerRef = React.useRef(null);
  const [subjectTotals, setSubjectTotals] = useState(() => S.get(K.ST, {}));
  const [customSubjects, setCustomSubjects] = useState(() => S.get(K.SL, {}));
  const [defaultTotal, setDefaultTotal]     = useState('');
  const [showSubjEditor, setShowSubjEditor] = useState(false);
  const [editorRows, setEditorRows]         = useState([]);

  // ── Paper Tab State: sessionStorage-backed so work survives Firebase sync remounts ──
  const [paperSettings, setPaperSettings] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem('_examPaperSettings') || 'null') || { cls: CLASSES[0], subject:'English', term:'Term 1', year: NOW.getFullYear(), date:'', totalMarks:100, time:'2 Hours', instructions:'Attempt all questions.' }; } catch { return { cls: CLASSES[0], subject:'English', term:'Term 1', year: NOW.getFullYear(), date:'', totalMarks:100, time:'2 Hours', instructions:'Attempt all questions.' }; }
  });
  const setPaperSettingsSafe = (v) => { sessionStorage.setItem('_examPaperSettings', JSON.stringify(v)); setPaperSettings(v); };

  const [paperQs, setPaperQs] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem('_examPaperQs') || '[]'); } catch { return []; }
  });
  const savePaperQs = (qs) => { sessionStorage.setItem('_examPaperQs', JSON.stringify(qs)); setPaperQs(qs); };

  const blankQ = () => ({ id: uid(), section:'', type:'english', text:'', marks:5, shapes:[], narrowCount:'', writtenCount:'', urduCount:'', mathRows:'', mathCols:'', shortCount:'', shapesLineCount:'', shapeSize:80, shapeNameLine:false, shapeAlign:'left', tableEnabled:false, tableColumns:[{header:''}], tableRows:1, tableData:{}, tableDir:'ltr', tableRowHeight:'0.45in' });
  const addQ    = () => savePaperQs([...paperQs, blankQ()]);
  const removeQ = (id) => savePaperQs(paperQs.filter(q => q.id !== id));
  const updateQ = (id, field, val) => savePaperQs(paperQs.map(q => q.id===id ? {...q, [field]: val} : q));

  const SHAPE_LIST = ['Circle','Rectangle','Square','Triangle','Sun','Moon','Star','Ball','Apple','Bus','Computer'];

  const shapeSVG = (shape, size=77) => {
    const h = Math.round(size); const s = {circle:`<ellipse cx="${h/2}" cy="${h/2}" rx="${h/2-4}" ry="${h/2-4}" fill="none" stroke="#222" stroke-width="2"/>`,rectangle:`<rect x="4" y="${h*.2}" width="${h-8}" height="${h*.6}" fill="none" stroke="#222" stroke-width="2"/>`,square:`<rect x="4" y="4" width="${h-8}" height="${h-8}" fill="none" stroke="#222" stroke-width="2"/>`,triangle:`<polygon points="${h/2},4 ${h-4},${h-4} 4,${h-4}" fill="none" stroke="#222" stroke-width="2"/>`,sun:`<circle cx="${h/2}" cy="${h/2}" r="${h/5}" fill="none" stroke="#222" stroke-width="2"/>${[0,45,90,135,180,225,270,315].map(a=>`<line x1="${h/2+Math.cos(a*Math.PI/180)*h/4.5}" y1="${h/2+Math.sin(a*Math.PI/180)*h/4.5}" x2="${h/2+Math.cos(a*Math.PI/180)*h/2.5}" y2="${h/2+Math.sin(a*Math.PI/180)*h/2.5}" stroke="#222" stroke-width="2"/>`).join('')}`,moon:`<path d="M${h*.55},${h*.1} A${h*.35},${h*.35} 0 1,0 ${h*.55},${h*.9} A${h*.25},${h*.25} 0 1,1 ${h*.55},${h*.1}Z" fill="none" stroke="#222" stroke-width="2"/>`,star:`<polygon points="${h/2},${h*.06} ${h*.6},${h*.38} ${h*.94},${h*.38} ${h*.67},${h*.58} ${h*.77},${h*.9} ${h/2},${h*.72} ${h*.23},${h*.9} ${h*.33},${h*.58} ${h*.06},${h*.38} ${h*.4},${h*.38}" fill="none" stroke="#222" stroke-width="2"/>`,ball:`<circle cx="${h/2}" cy="${h/2}" r="${h/2-4}" fill="none" stroke="#222" stroke-width="2"/><path d="M${h*.15},${h*.3} Q${h/2},${h*.15} ${h*.85},${h*.3}" fill="none" stroke="#222" stroke-width="1.5"/><path d="M${h*.08},${h*.6} Q${h/2},${h*.75} ${h*.92},${h*.6}" fill="none" stroke="#222" stroke-width="1.5"/>`,apple:`<path d="M${h/2},${h*.25} C${h*.3},${h*.25} ${h*.1},${h*.42} ${h*.1},${h*.6} C${h*.1},${h*.8} ${h*.3},${h*.92} ${h/2},${h*.92} C${h*.7},${h*.92} ${h*.9},${h*.8} ${h*.9},${h*.6} C${h*.9},${h*.42} ${h*.7},${h*.25} ${h/2},${h*.25}Z" fill="none" stroke="#222" stroke-width="2"/><path d="M${h/2},${h*.25} C${h/2},${h*.12} ${h*.6},${h*.06} ${h*.65},${h*.1}" fill="none" stroke="#222" stroke-width="2"/><path d="M${h*.35},${h*.2} C${h*.28},${h*.08} ${h*.18},${h*.05} ${h*.15},${h*.1}" fill="none" stroke="#222" stroke-width="1.5"/>`,bus:`<rect x="4" y="${h*.22}" width="${h-8}" height="${h*.52}" rx="4" fill="none" stroke="#222" stroke-width="2"/><rect x="${h*.1}" y="${h*.32}" width="${h*.18}" height="${h*.18}" fill="none" stroke="#222" stroke-width="1.5"/><rect x="${h*.38}" y="${h*.32}" width="${h*.18}" height="${h*.18}" fill="none" stroke="#222" stroke-width="1.5"/><rect x="${h*.66}" y="${h*.32}" width="${h*.18}" height="${h*.18}" fill="none" stroke="#222" stroke-width="1.5"/><circle cx="${h*.22}" cy="${h*.78}" r="${h*.08}" fill="none" stroke="#222" stroke-width="2"/><circle cx="${h*.72}" cy="${h*.78}" r="${h*.08}" fill="none" stroke="#222" stroke-width="2"/>`,computer:`<rect x="4" y="4" width="${h-8}" height="${h*.6}" rx="3" fill="none" stroke="#222" stroke-width="2"/><rect x="${h*.1}" y="${h*.12}" width="${h*.8}" height="${h*.44}" fill="none" stroke="#222" stroke-width="1"/><rect x="${h*.32}" y="${h*.65}" width="${h*.36}" height="${h*.12}" fill="none" stroke="#222" stroke-width="1.5"/><rect x="${h*.2}" y="${h*.77}" width="${h*.6}" height="${h*.08}" rx="1" fill="none" stroke="#222" stroke-width="1.5"/>`};
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${h}" height="${h}" viewBox="0 0 ${h} ${h}">${s[shape.toLowerCase()] || s.circle}</svg>`;
  };

  const printPaper = () => {
    if (!paperQs.length) return alert('Add at least one question first.');
    const ps = paperSettings;
    const BOX = 0.80; // inches — each math box
    const lineH = '0.38in';
    const narrowH = '0.22in';
    let qNum = 0;
    let sectCurrent = '';
    const qHtml = paperQs.map(q => {
      qNum++;
      let sectionHtml = '';
      if (q.section && q.section !== sectCurrent) { sectCurrent = q.section; sectionHtml = `<div class="section-hdr">${q.section}</div>`; }
      // notebook line generators
      const engLines = (count) => {
        let html = '<div class="eng-plain">';
        for(let g=0;g<(count||1);g++) {
          html += '<div class="eng-group">';
          for(let i=0;i<4;i++) html += '<div class="eng-4line"></div>';
          html += '</div>';
        }
        html += '</div>';
        return html;
      };
      const urduLines = (count) => {
        let html = '<div class="urdu-plain">';
        for(let i=0;i<(count||6);i++) html += `<div class="urdu-plain-line"></div>`;
        html += '</div>';
        return html;
      };
      // Build table block (works for ALL types)
      let tableBlock = '';
      if (q.type === 'table' || q.tableEnabled) {
        const tcols = q.tableColumns || [{header:''},{header:''}];
        const trows = Number(q.tableRows) || 5;
        const tdata = q.tableData || {};
        const tdir  = q.tableDir || 'ltr';
        const trh   = q.tableRowHeight || '0.45in';
        const colW  = Math.floor(100 / tcols.length);
        const thead = `<tr>${tcols.map(c=>`<th style="width:${colW}%">${c.header||''}</th>`).join('')}</tr>`;
        const tbody = Array(trows).fill(0).map((_,ri)=>
          '<tr>'+tcols.map(function(_,ci){return '<td style="height:'+trh+'">'+( tdata[ri+'_'+ci]||'' )+'</td>';}).join('')+'</tr>'
        ).join('');
        tableBlock = `<table class="q-table" style="direction:${tdir};margin-bottom:8px"><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
      }
      // Build shapes block (works for ALL types)
      let shapesBlock = '';
      if ((q.shapes||[]).length > 0) {
        const sz = q.shapeSize || 80;
        const alignStyle = q.shapeAlign==='center'?'justify-content:center':q.shapeAlign==='right'?'justify-content:flex-end':'justify-content:flex-start';
        const shapeItems = (q.shapes||[]).map(sh => `<div style="display:flex;flex-direction:column;align-items:center;gap:4px">${shapeSVG(sh,sz)}${q.shapeNameLine?`<div style="width:${sz}px;border-bottom:1.5px solid #333;margin-top:6px"></div>`:''}</div>`).join('');
        shapesBlock = `<div class="shapes-row" style="${alignStyle};margin-bottom:10px">${shapeItems}</div>`;
      }
      let answerHtml = '';
      if (q.type === 'english') {
        answerHtml = tableBlock + shapesBlock + engLines(q.writtenCount || 6);
      } else if (q.type === 'urdu') {
        answerHtml = tableBlock + shapesBlock + urduLines(q.urduCount || 6);
      } else if (q.type === 'short') {
        answerHtml = tableBlock + shapesBlock + engLines(q.shortCount || 2);
      } else if (q.type === 'narrow') {
        answerHtml = tableBlock + shapesBlock + Array(q.narrowCount || 6).fill(`<div class="line-narrow"></div>`).join('');
      } else if (q.type === 'math') {
        const rows = q.mathRows || 2; const cols = q.mathCols || 4;
        answerHtml = tableBlock + shapesBlock + `<div class="math-grid">${Array(rows).fill(Array(cols).fill(`<div class="math-box"></div>`).join('')).map(r=>`<div class="math-row">${r}</div>`).join('')}</div>`;
      } else if (q.type === 'shapes') {
        answerHtml = tableBlock + shapesBlock + (Number(q.shapesLineCount)>0 ? engLines(q.shapesLineCount) : '');
      } else if (q.type === 'table') {
        answerHtml = tableBlock + shapesBlock;
      }
      return `${sectionHtml}<div class="question"><div class="q-row"><span class="q-num">Q${qNum}.</span><span class="q-text">${q.text || '(No question text)'}</span><span class="q-marks">[${q.marks} mark${q.marks!=1?'s':''}]</span></div><div class="q-answer">${answerHtml}</div></div>`;
    }).join('');

    const win = window.open('','_blank','width=820,height=900');
    if (!win) { alert('Popup blocked! Please allow popups for this site to print.'); return; }
    win.document.write(`<!DOCTYPE html><html><head><title>Question Paper</title><style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:'Segoe UI',Arial,sans-serif;padding:0.5in;color:#111;font-size:12pt;line-height:1.4}
      .hdr{text-align:center;border-bottom:3px double #1e3a8a;padding-bottom:10px;margin-bottom:14px}
      .hdr img{height:60px;object-fit:contain;margin-bottom:6px}
      .hdr h1{font-size:15pt;font-weight:800;color:#1e3a8a;letter-spacing:.5px}
      .hdr h2{font-size:12pt;font-weight:700;color:#c0392b;margin:2px 0}
      .info-row{display:flex;justify-content:space-between;border:1px solid #ccc;padding:7px 12px;border-radius:6px;margin-bottom:10px;font-size:10pt}
      .student-row{display:flex;justify-content:space-between;margin-bottom:14px;font-size:10pt}
      .student-row .field{border-bottom:1.5px solid #333;width:38%;padding-bottom:2px}
      .student-row .field span{color:#555;font-size:9pt}
      .instructions{font-size:9.5pt;color:#444;border-left:3px solid #1e3a8a;padding:4px 10px;margin-bottom:14px;background:#f8fafc}
      .section-hdr{font-weight:800;font-size:12pt;color:#1e3a8a;border-bottom:1.5px solid #1e3a8a;margin:18px 0 10px;padding-bottom:4px;text-transform:uppercase;letter-spacing:.5px}
      .question{margin-bottom:18px}
      .q-row{display:flex;gap:8px;align-items:flex-start;margin-bottom:6px}
      .q-num{font-weight:800;min-width:28px;color:#1e3a8a}
      .q-text{flex:1;font-size:11.5pt}
      .q-marks{font-size:9pt;color:#666;white-space:nowrap;font-weight:600}
      .q-answer{margin-left:36px}
      /* English 4-line groups — plain black */
      .eng-plain{background:#fff;margin:4px 0}
      .eng-group{margin-bottom:0.28in}
      .eng-4line{height:0.16in;border-bottom:1.5px solid #333}
      /* Urdu plain lines — simple ruled paper */
      .urdu-plain{background:#fff;margin:4px 0}
      .urdu-plain-line{height:0.60in;border-bottom:1.5px solid #555;width:100%}
      /* Narrow lines */
      .line-narrow{border-bottom:1px solid #bbb;height:${narrowH};width:100%;margin-bottom:1px}
      .math-row{display:flex;gap:0;margin-bottom:0}
      .math-box{width:${BOX}in;height:${BOX}in;border:1.5px solid #888;display:inline-block}
      .math-grid{display:inline-block;border-top:1.5px solid #888;border-left:1.5px solid #888}
      .math-grid .math-box{border-top:none;border-left:none}
      .shapes-row{display:flex;gap:24px;flex-wrap:wrap;margin:6px 0;align-items:flex-end}
      .q-table{width:100%;border-collapse:collapse;margin:6px 0}
      .q-table th{background:#1e3a8a;color:#fff;padding:7px 10px;font-size:10.5pt;border:1.5px solid #333;text-align:center;font-weight:700}
      .q-table td{border:1.5px solid #333;padding:4px 8px;vertical-align:top}
      .shapes-row svg{display:block}
      .sig{display:flex;justify-content:space-between;align-items:flex-end;margin-top:48px;font-size:10pt}
      .sig-item{text-align:center;min-width:1.8in}
      .sig-item .sig-line{border-top:1.5px solid #333;padding-top:5px;margin-top:28px;font-size:9pt;color:#444;font-weight:600}
      .dev-footer{text-align:center;margin-top:12px;padding-top:8px;border-top:1px dashed #ccc;font-size:7pt;color:#bbb;letter-spacing:.3px}
      @page{size:A4 portrait;margin:0.55in 0.6in 0.5in 0.6in}
      @media print{
        body{padding:0;margin:0}
        button{display:none!important}
        .page-content{min-height:calc(297mm - 1.05in);display:flex;flex-direction:column}
        .questions-area{flex:1}
        .footer-area{margin-top:auto}
      }
    </style></head><body>
    <div class="page-content">
      <div class="hdr">
        <img src="${LOGO_SRC}" onerror="this.style.display='none'" alt="DISS"/>
        <h1>Discovery International School System</h1>
        <h2>${ps.subject} — Question Paper</h2>
      </div>
      <div class="info-row">
        <span><b>Class:</b> ${ps.cls}</span>
        <span><b>Term:</b> ${ps.term} ${ps.year}</span>
        <span><b>Date:</b> ${ps.date || '___________'}</span>
        <span><b>Total Marks:</b> ${ps.totalMarks}</span>
        <span><b>Time Allowed:</b> ${ps.time}</span>
      </div>
      <div class="student-row">
        <div class="field"><span>Student Name:</span> ________________________________</div>
        <div class="field"><span>Roll No:</span> ____________</div>
        <div class="field"><span>Marks Obtained:</span> ________ / ${ps.totalMarks}</div>
      </div>
      <div class="instructions"><b>Instructions:</b> ${ps.instructions}</div>
      <div class="questions-area">${qHtml}</div>
      <div class="footer-area">
        <div class="sig">
          <div class="sig-item"><div class="sig-line">Class Teacher</div></div>
          <div class="sig-item"><div class="sig-line">Examiner</div></div>
          <div class="sig-item"><div class="sig-line">Principal</div></div>
        </div>
        ${getPrintAudit()}
      <div class="dev-footer">© 2026 DISS — All Rights Reserved &nbsp;|&nbsp; Powered by Tataheer Business Group &nbsp;|&nbsp; +923218555566</div>
      </div>
    </div>
    <script>window.onload=function(){window.print();}<\/script>
    </body></html>`);
    win.document.close();
  };

  // ── shared state
  const [selTerm, setSelTerm]   = useState('Term 1');
  const [selYear, setSelYear]   = useState(NOW.getFullYear());
  const [selCls,  setSelCls]    = useState(CLASSES[0]);
  const years = Array.from({length:5},(_,i)=>NOW.getFullYear()-1+i);

  // ── Phase 1: Isolate date sheet per (term × year × class). Legacy keys of the
  //    form `${term}_${year}` (without class) are purged on mount below.
  const dsKey  = `${selTerm}_${selYear}_${selCls}`;
  const dsRows = dateSheets[dsKey] || [];

  // subjects for selected class — custom list takes priority
  const getDefaultSubjects = (cls) => ['Play Group Red','Play Group Blue','Nursery','KG'].includes(cls)
    ? SUBJECTS_PG_KG : SUBJECTS_1_10;
  const getSubjects = (cls) => customSubjects[cls] && customSubjects[cls].length > 0
    ? customSubjects[cls] : getDefaultSubjects(cls);

  // ── Per-subject total marks helpers
  const getSubjTotal = (subj) => Number(subjectTotals[subj]) || TOTAL_MARKS;
  const setSubjTotal = (subj, val) => {
    const v = val === '' ? '' : Math.max(1, Number(val));
    const updated = { ...subjectTotals, [subj]: v };
    S.set(K.ST, updated); setSubjectTotals(updated);
  };
  const applyToAll = () => {
    const v = Number(defaultTotal);
    if (!v || v < 1) return;
    const updated = { ...subjectTotals };
    getSubjects(selCls).forEach(s => { updated[s] = v; });
    S.set(K.ST, updated); setSubjectTotals(updated);
  };
  const openSubjEditor = () => {
    setEditorRows(getSubjects(selCls).map(s => ({ name:s, total:String(getSubjTotal(s)) })));
    setShowSubjEditor(true);
  };
  const saveSubjEditor = () => {
    const valid = editorRows.filter(r => r.name.trim());
    if (!valid.length) return alert('At least one subject is required.');
    const newCL = { ...customSubjects, [selCls]: valid.map(r => r.name.trim()) };
    S.set(K.SL, newCL); setCustomSubjects(newCL);
    const newST = { ...subjectTotals };
    valid.forEach(r => { newST[r.name.trim()] = Number(r.total) || TOTAL_MARKS; });
    S.set(K.ST, newST); setSubjectTotals(newST);
    setShowSubjEditor(false);
  };
  const resetSubjEditor = () => {
    if (!window.confirm('Reset subjects for this class to system defaults?')) return;
    const newCL = { ...customSubjects };
    delete newCL[selCls];
    S.set(K.SL, newCL); setCustomSubjects(newCL);
    setShowSubjEditor(false);
  };

  // ── Date Sheet helpers
  const persistDS = d => { S.set(K.DS, d); setDateSheets(d); };

  // ── Phase 1: Auto-sync subjects from Result Cards → Date Sheet.
  //    When user switches to a class (or term/year) whose date sheet is empty,
  //    seed it automatically with that class's subjects (from customSubjects[cls]
  //    via getSubjects). Existing rows are NEVER overwritten — user edits stick.
  useEffect(() => {
    if (dsRows.length > 0) return;
    const subjs = getSubjects(selCls);
    if (subjs.length === 0) return;
    const rows = subjs.map(s => ({ subject: s, date: '', day: '', startTime: '09:00', endTime: '11:00' }));
    persistDS({ ...dateSheets, [dsKey]: rows });
  }, [selCls, selTerm, selYear]);

  const initDateSheet = () => {
    if (dsRows.length > 0 && !window.confirm('Replace existing date sheet for this term?')) return;
    const subjs = getSubjects(selCls);
    const rows = subjs.map(s => ({ subject: s, date: '', day: '', startTime: '09:00', endTime: '11:00' }));
    persistDS({ ...dateSheets, [dsKey]: rows });
  };

  const updateDSRow = (idx, field, val) => {
    const rows = dsRows.map((r,i) => i===idx ? {...r, [field]: val} : r);
    persistDS({ ...dateSheets, [dsKey]: rows });
  };

  const addDSRow = () => persistDS({ ...dateSheets, [dsKey]: [...dsRows, { subject:'', date:'', day:'', startTime:'09:00', endTime:'11:00' }] });
  const removeDSRow = (idx) => persistDS({ ...dateSheets, [dsKey]: dsRows.filter((_,i)=>i!==idx) });

  // ── Drag-and-drop row reordering. Persists new order to K.DS on drop so
  //    print + refresh + sync all reflect the new sequence immediately.
  const [dragIdx, setDragIdx] = useState(null);
  const [dropOverIdx, setDropOverIdx] = useState(null);
  const moveDSRow = (from, to) => {
    if (from === to || from == null || to == null) return;
    const rows = [...dsRows];
    const [moved] = rows.splice(from, 1);
    rows.splice(to, 0, moved);
    persistDS({ ...dateSheets, [dsKey]: rows });
  };

  // ── Phase 2: Apply-to-Multiple-Classes modal state + handler.
  //    Copies current class's date sheet rows (subjects + dates + times) to each
  //    target class's own dsKey. Each target remains independently editable.
  const [applyToMod, setApplyToMod] = useState(false);
  const [applyTargets, setApplyTargets] = useState([]);
  const doApplyToClasses = () => {
    if (dsRows.length === 0) { alert('Current date sheet is empty — nothing to copy.'); return; }
    if (applyTargets.length === 0) { alert('Pick at least one target class.'); return; }
    if (!window.confirm(`Copy ${dsRows.length} rows (subjects + dates + times) from ${selCls} to ${applyTargets.length} class(es)?\n\nExisting date sheets on target classes will be OVERWRITTEN for ${selTerm} ${selYear}.`)) return;
    const next = { ...dateSheets };
    applyTargets.forEach(cls => {
      const targetKey = `${selTerm}_${selYear}_${cls}`;
      next[targetKey] = dsRows.map(r => ({ ...r })); // deep-copy each row
    });
    persistDS(next);
    setApplyToMod(false); setApplyTargets([]);
    alert(`✓ Applied to ${applyTargets.length} class(es). Each remains independently editable.`);
  };

  // ── Phase 2: Consolidated Date Sheet print — one printable page with a
  //    separate table per class for the current Term × Year. Notice-board ready.
  const printConsolidatedDateSheet = () => {
    const allClasses = CLASSES.filter(c => {
      const k = `${selTerm}_${selYear}_${c}`;
      return (dateSheets[k] || []).length > 0;
    });
    if (allClasses.length === 0) { alert('No date sheets set up for any class in this term.'); return; }
    const dayName = (d) => { if (!d) return '—'; const dt = new Date(d); if (isNaN(dt)) return '—'; return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dt.getDay()]; };
    const blocks = allClasses.map(cls => {
      const rows = dateSheets[`${selTerm}_${selYear}_${cls}`] || [];
      const body = rows.map((r,i) => `<tr><td>${i+1}</td><td>${r.subject||'—'}</td><td>${r.date||'—'}</td><td>${dayName(r.date)}</td><td>${r.startTime||'—'} – ${r.endTime||'—'}</td></tr>`).join('');
      return `<div class="cls-block">
        <h3 class="hdr-title">Class ${cls} — ${selTerm} ${selYear}</h3>
        <table>
          <thead><tr><th>#</th><th>Subject</th><th>Date</th><th>Day</th><th>Time</th></tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
    }).join('');
    printPage(`Consolidated Date Sheet — ${selTerm} ${selYear}`, `
      <style>
        .cls-block{page-break-inside:avoid;margin-bottom:22px}
        .cls-block h3{background:#1e40af;color:#fff;padding:8px 12px;margin:0 0 8px;border-radius:6px;font-size:14px}
        .cls-block table{width:100%;border-collapse:collapse;font-size:12px}
        .cls-block th{background:#f3f4f6;border:1px solid #d1d5db;padding:5px;text-align:left}
        .cls-block td{border:1px solid #e5e7eb;padding:5px}
      </style>
      <h2 style="text-align:center;margin-bottom:14px;color:#1e3a8a">📚 Consolidated Date Sheet — ${selTerm} ${selYear}</h2>
      ${blocks}
    `);
  };

  const printDateSheet = () => {
    if (!dsRows.length) return alert('No date sheet entries yet.');
    const rows = dsRows.map((r,i) => `<tr><td>${i+1}</td><td><b>${r.subject||'—'}</b></td><td>${r.date||'—'}</td><td>${r.day||'—'}</td><td>${r.startTime||'—'} – ${r.endTime||'—'}</td></tr>`).join('');
    const win = window.open('','_blank','width=750,height=650');
    if (!win) { alert('Popup blocked! Please allow popups for this site to print.'); return; }
    win.document.write(`<!DOCTYPE html><html><head><title>Date Sheet</title>
    <style>
      *{box-sizing:border-box}body{font-family:'Segoe UI',Arial,sans-serif;padding:28px;color:#1a1a1a;font-size:12px}
      .logo-hdr{text-align:center;border-bottom:2px solid #c0392b;padding-bottom:12px;margin-bottom:16px}
      .logo-hdr img{height:65px;object-fit:contain}
      h3{color:#1e3a8a;font-size:15px;margin:14px 0 8px}
      table{width:100%;border-collapse:collapse}
      th{background:#1e3a8a;color:#fff;padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase}
      td{padding:8px 12px;border-bottom:1px solid #e5e7eb}
      tr:nth-child(even) td{background:#f8fafc}
      .sig{display:flex;justify-content:space-between;margin-top:40px;font-size:11px;color:#6b7280}
      .dev-footer{text-align:center;margin-top:16px;padding-top:8px;border-top:1px solid #e5e7eb;font-size:8px;color:#9ca3af;letter-spacing:.3px}
      @media print{body{padding:14px}button{display:none!important}}
    </style></head><body>
    <div class="logo-hdr"><img src="${LOGO_SRC}" alt="DISS" onerror="this.style.display='none'"/></div>
    <h3>📅 Date Sheet — ${selTerm} ${selYear} &nbsp;|&nbsp; Class: ${selCls}</h3>
    <table><thead><tr><th>#</th><th>Subject</th><th>Date</th><th>Day</th><th>Time</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <div class="sig"><span>Class Teacher: _______________</span><span>Principal: _______________</span></div>
    <div class="dev-footer">© 2026 DISS — All Rights Reserved &nbsp;|&nbsp; Powered by Tataheer Business Group &nbsp;|&nbsp; +923218555566</div>
    <script>window.onload=function(){window.print();}<\/script>
    </body></html>`);
    win.document.close();
  };

  // ── Result helpers
  const rsKey = (stu) => `${stu.id}_${selTerm}_${selYear}`;
  const getMarks = (stu) => results[rsKey(stu)] || {};

  // Push the currently-buffered marks to Firebase immediately. Used by the
  // debounced auto-save AND the unmount-flush effect below.
  const flushMarksToFirebase = () => {
    if (!window._fbAuthReady || !window._fbDB) {
      // Cloud connection not ready — marks are NOT saved to the cloud yet.
      // NEVER claim 'saved' here (that lie destroyed data before v87): keep the
      // indicator on pending and retry until the connection comes up. The local
      // copy is timestamped newer, so the load-time guard cannot wipe it either.
      setMarksSaveState('pending');
      if (marksSaveTimerRef.current) clearTimeout(marksSaveTimerRef.current);
      marksSaveTimerRef.current = setTimeout(flushMarksToFirebase, 2000);
      return;
    }
    try {
      const updated = JSON.parse(localStorage.getItem(K.RS) || '{}');
      const ts      = JSON.parse(localStorage.getItem('sms_ts') || '{}');
      setMarksSaveState('saving');
      window._fbDB.ref('sms/' + K.RS).set(updated)
        .then(() => setMarksSaveState('saved'))
        .catch(() => {
          // Push failed (connection dropped mid-write) — retry, don't lie.
          setMarksSaveState('pending');
          if (marksSaveTimerRef.current) clearTimeout(marksSaveTimerRef.current);
          marksSaveTimerRef.current = setTimeout(flushMarksToFirebase, 3000);
        });
      window._fbDB.ref('sms/sms_ts').set(ts).catch(() => {});
    } catch(e) { setMarksSaveState('pending'); }
  };

  const updateMark = (stu, subj, val) => {
    const key = rsKey(stu);
    const max = getSubjTotal(subj);
    const newVal = val === '' ? '' : Math.min(Number(val), max);
    setResults(prev => {
      const updated = { ...prev, [key]: { ...(prev[key] || {}), [subj]: newVal } };
      // Save to localStorage instantly + bump sms_ts so the sync engine treats
      // local as newer than cloud. DO NOT push to Firebase yet — that's deferred
      // to avoid the listener echo from refreshing the input you're typing in.
      try {
        localStorage.setItem(K.RS, JSON.stringify(updated));
        const ts = JSON.parse(localStorage.getItem('sms_ts') || '{}');
        ts[K.RS] = Date.now();
        localStorage.setItem('sms_ts', JSON.stringify(ts));
      } catch(e) {}
      setMarksSaveState('pending');
      if (marksSaveTimerRef.current) clearTimeout(marksSaveTimerRef.current);
      marksSaveTimerRef.current = setTimeout(flushMarksToFirebase, 1500);
      return updated;
    });
  };

  // Flush any buffered marks when leaving the Exams page (tab switch, navigation,
  // browser close via beforeunload). Guarantees no data is left only in localStorage.
  React.useEffect(() => {
    const onBeforeUnload = () => {
      if (marksSaveTimerRef.current) {
        clearTimeout(marksSaveTimerRef.current);
        flushMarksToFirebase();
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (marksSaveTimerRef.current) {
        clearTimeout(marksSaveTimerRef.current);
        flushMarksToFirebase();
      }
    };
  }, []);

  // Only count marks for subjects in the current class list (ignore orphan keys from renamed/removed subjects)
  const calcTotal    = (marks, subjs) => (subjs || Object.keys(marks)).reduce((s,sub)=>{const v=marks[sub];return s+(v===''||v===undefined?0:Number(v));},0);
  const calcMaxTotal = (subjs) => subjs.reduce((s,sub)=>s+getSubjTotal(sub),0);
  const calcPct      = (marks, subjs) => subjs.length ? Math.round(calcTotal(marks, subjs) / calcMaxTotal(subjs) * 100) : 0;
  // Grade scale: A+ 90-100 | A 80-89 | B+ 70-79 | B 60-69 | C 50-59 | D 40-49 | F below 40 (FAIL)
  const getGrade   = (pct) => pct>=90?'A+':pct>=80?'A':pct>=70?'B+':pct>=60?'B':pct>=50?'C':pct>=40?'D':'F';
  const passOrFail = (pct) => pct >= 40 ? 'PASS' : 'FAIL';

  // ── Class filter — defensive: trim+case-insensitive so whitespace/casing in
  //   student records never makes them invisible in their actual class.
  //   Fixes "students don't show in their class" issue when student.cls has stray
  //   spaces or differs in capitalization from the CLASSES dropdown values.
  const _normCls = (x) => String(x == null ? '' : x).trim().toLowerCase();
  // '__ALL__' = Whole School mode (Result Cards tab): every student, all classes.
  const wholeSchool = selCls === '__ALL__';
  const clsLabel = wholeSchool ? 'Whole School' : `Class ${selCls}`;
  const classStu = wholeSchool ? [...students] : students.filter(s => _normCls(s.cls) === _normCls(selCls));

  // ── "NO APPEAR" filter ────────────────────────────────────────────────────
  // A student is treated as "appeared" if they have AT LEAST ONE non-empty mark
  // entered for the currently-selected term + year. Anyone with all-blank marks
  // is excluded from Print All / position ranking and shown in a separate
  // collapsible cluster below, so blank result cards are never printed.
  const hasAnyMarks = (stu) => {
    const marks = results[`${stu.id}_${selTerm}_${selYear}`] || {};
    return Object.values(marks).some(v => v !== '' && v !== null && v !== undefined && !Number.isNaN(Number(v)));
  };
  const appearedStu = classStu.filter(hasAnyMarks);
  const noAppearStu = classStu.filter(s => !hasAnyMarks(s));
  // ── UX fix — auto-EXPAND No Appear cluster by default so newly-added students
  // (who naturally have no marks yet) are IMMEDIATELY VISIBLE for the teacher
  // to type marks in. Was previously collapsed, which made students look "missing".
  // Teacher can still manually collapse via the cluster header.
  const [showNoAppear, setShowNoAppear] = useState(true);

  // ── SHARED PRINT CSS — identical for single and bulk ──────────────────────────
  const PRINT_CSS = `
    *{box-sizing:border-box}
    body{font-family:'Segoe UI',Arial,sans-serif;padding:28px;color:#1a1a1a;font-size:12px;max-width:700px;margin:auto}
    .student-card-container{max-width:700px;margin:0 auto}
    .hdr{text-align:center;border-bottom:3px solid #c0392b;padding-bottom:10px;margin-bottom:14px}
    .hdr img{height:70px;object-fit:contain}
    .hdr-title{font-size:13px;font-weight:800;color:#c0392b;margin-top:6px}
    .info-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin:12px 0;background:#f8fafc;padding:10px 12px;border-radius:8px;border:1px solid #e2e8f0}
    .info-item .lbl{font-size:9px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px}
    .info-item .val{font-size:12px;font-weight:800;color:#1a1a1a}
    .info-item.pos .val{font-size:20px;font-weight:900;color:#c0392b;line-height:1.1}
    .info-item.pos .lbl{color:#c0392b;font-weight:700}
    table{width:100%;border-collapse:collapse;margin:8px 0}
    th{background:#1e3a8a;color:#fff;padding:7px 10px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.3px}
    td{padding:6px 10px;border-bottom:1px solid #e5e7eb;font-size:11px}
    tr:nth-child(even) td{background:#f8fafc}
    tfoot td{background:#dbeafe;font-weight:700;color:#1e3a8a}
    .result-box{display:flex;gap:8px;margin:12px 0;flex-wrap:wrap}
    .rcard{border-radius:10px;padding:10px 16px;text-align:center;flex:1;min-width:80px}
    .rcard .rv{font-size:22px;font-weight:900}
    .rcard .rl{font-size:9px;text-transform:uppercase;opacity:.75;margin-top:3px;letter-spacing:.5px}
    .pass{background:#dcfce7;color:#15803d}.fail{background:#fee2e2;color:#dc2626}
    .blue{background:#dbeafe;color:#1d4ed8}.purple{background:#ede9fe;color:#6d28d9}
    .orange{background:#fff7ed;color:#c2410c}
    h3{font-size:11px;color:#1e3a8a;margin:14px 0 5px;text-transform:uppercase;letter-spacing:.8px;font-weight:800}
    .sig{display:flex;justify-content:space-between;margin-top:32px;font-size:11px;color:#6b7280;border-top:1px dashed #e5e7eb;padding-top:14px}
    .dev-footer{text-align:center;margin-top:12px;padding-top:8px;border-top:1px solid #e5e7eb;font-size:8px;color:#9ca3af;letter-spacing:.3px}
    @page{size:A4 portrait;margin:0.4in 0.5in}
    @media print{
      body{padding:0;margin:0;max-width:none}
      button{display:none!important}
      .student-card-container{page-break-after:always;break-after:page;page-break-inside:avoid;break-inside:avoid}
    }
  `;

  // ── SINGLE CARD BUILDER — used by BOTH single and bulk print ──────────────────
  const buildCardHTML = (stu, position) => {
    const subjs    = getSubjects(stu.cls);
    const marks    = getMarks(stu);
    const total    = calcTotal(marks, subjs);
    const maxTot   = calcMaxTotal(subjs);
    const pct      = calcPct(marks, subjs);
    const grade    = getGrade(pct);
    const pf       = passOrFail(pct);
    const subjRows = subjs.map(s => {
      const m   = marks[s] !== undefined && marks[s] !== '' ? Number(marks[s]) : '—';
      const st  = getSubjTotal(s);
      const grd = m === '—' ? '—' : getGrade(Math.round(Number(m)/st*100));
      return `<tr><td>${s}</td><td style="text-align:center">${st}</td><td style="text-align:center;font-weight:700">${m}</td><td style="text-align:center">${grd}</td></tr>`;
    }).join('');
    // Helper: true if at least one mark was actually entered (not empty)
    const hasData = (marksObj) => Object.values(marksObj).some(v => v !== '' && v !== undefined && v !== null);

    // ── Per-term rows (Term 1, Term 2, Term 3) — same formula for all three ──
    const termRows = TERMS.map(t => {
      const tk = `${stu.id}_${t}_${selYear}`;
      const tm = results[tk] || {};
      if (!hasData(tm)) {
        return `<tr><td>${t}</td><td style="text-align:center">${maxTot}</td><td style="text-align:center;color:#9ca3af">—</td><td style="text-align:center;color:#9ca3af">—</td><td style="text-align:center;color:#9ca3af">—</td><td style="text-align:center;color:#9ca3af;font-style:italic">Not Yet</td></tr>`;
      }
      const tt = calcTotal(tm, subjs);
      const tp = calcPct(tm, subjs);
      return `<tr><td>${t}</td><td style="text-align:center">${maxTot}</td><td style="text-align:center;font-weight:700">${tt}</td><td style="text-align:center">${tp}%</td><td style="text-align:center">${getGrade(tp)}</td><td style="text-align:center;font-weight:700;color:${passOrFail(tp)==='PASS'?'#15803d':'#dc2626'}">${passOrFail(tp)}</td></tr>`;
    }).join('');

    // ── Annual combined row (T1+T2+T3) — only appears on Term 3 result cards ──
    let annualRow = '';
    if (selTerm === 'Term 3') {
      const tm1 = results[`${stu.id}_Term 1_${selYear}`] || {};
      const tm2 = results[`${stu.id}_Term 2_${selYear}`] || {};
      const tm3 = results[`${stu.id}_Term 3_${selYear}`] || {};
      const combObt = calcTotal(tm1, subjs) + calcTotal(tm2, subjs) + calcTotal(tm3, subjs);
      const combMax = maxTot * 3;
      const combPct = combMax > 0 ? Math.round(combObt / combMax * 100) : 0;
      annualRow = `<tr style="background:#f0fdf4"><td><b>Annual (T1+T2+T3)</b></td><td style="text-align:center"><b>${combMax}</b></td><td style="text-align:center;font-weight:700">${combObt}</td><td style="text-align:center">${combPct}%</td><td style="text-align:center">${getGrade(combPct)}</td><td style="text-align:center;font-weight:700;color:${passOrFail(combPct)==='PASS'?'#15803d':'#dc2626'}">${passOrFail(combPct)}</td></tr>`;
    }
    const posLabel = position ? `${position}${position===1?'st':position===2?'nd':position===3?'rd':'th'}` : '—';
    return `
    <div class="student-card-container">
      <div class="hdr">
        <img src="${LOGO_SRC}" alt="DISS" onerror="this.style.display='none'"/>
        <div class="hdr-title">RESULT CARD — ${selTerm} ${selYear}</div>
      </div>
      <div class="info-grid">
        <div class="info-item">
          <div class="lbl">Student Name</div><div class="val">${stu.name}</div>
          <div class="lbl" style="margin-top:6px">Class</div><div class="val">${stu.cls}</div>
        </div>
        <div class="info-item">
          <div class="lbl">Father's Name</div><div class="val">${stu.father||'—'}</div>
          <div class="lbl" style="margin-top:6px">Roll Number</div><div class="val">${stu.roll}</div>
        </div>
        <div class="info-item pos" style="text-align:center;border-left:2px solid #e2e8f0;padding-left:8px">
          <div class="lbl">Class Position</div>
          <div class="val">${posLabel}</div>
          <div style="font-size:9px;color:#6b7280;margin-top:2px">in class</div>
        </div>
      </div>
      <h3>Subject-wise Marks — ${selTerm}</h3>
      <table>
        <thead><tr><th>Subject</th><th style="text-align:center">Total</th><th style="text-align:center">Obtained</th><th style="text-align:center">Grade</th></tr></thead>
        <tbody>${subjRows}</tbody>
        <tfoot><tr><td><b>Grand Total</b></td><td style="text-align:center"><b>${maxTot}</b></td><td style="text-align:center"><b>${total}</b></td><td style="text-align:center"><b>${grade}</b></td></tr></tfoot>
      </table>
      <div class="result-box">
        <div class="rcard blue"><div class="rv">${total}/${maxTot}</div><div class="rl">Marks</div></div>
        <div class="rcard purple"><div class="rv">${pct}%</div><div class="rl">Percentage</div></div>
        <div class="rcard orange"><div class="rv">${posLabel}</div><div class="rl">Position</div></div>
        <div class="rcard purple"><div class="rv">${grade}</div><div class="rl">Grade</div></div>
        <div class="rcard ${pf==='PASS'?'pass':'fail'}"><div class="rv">${pf}</div><div class="rl">Result</div></div>
      </div>
      <h3>Term-wise Performance — ${selYear}</h3>
      <table>
        <thead><tr><th>Term</th><th style="text-align:center">Total Marks</th><th style="text-align:center">Obtained</th><th style="text-align:center">%</th><th style="text-align:center">Grade</th><th style="text-align:center">Result</th></tr></thead>
        <tbody>${termRows}${annualRow}</tbody>
      </table>
      <div class="sig">
        <span>Class Teacher: _______________</span>
        <span>Principal: _______________</span>
        <span>Parent Signature: _______________</span>
      </div>
      ${getPrintAudit()}
      <div class="dev-footer">© 2026 DISS — All Rights Reserved &nbsp;|&nbsp; Powered by Tataheer Business Group &nbsp;|&nbsp; +923218555566</div>
    </div>
    <div class="student-card-container">
      <h3>Grading Scale</h3>
      <table style="width:100%;border-collapse:collapse;font-size:10px">
        <thead>
          <tr style="background:#1e3a8a;color:#fff">
            <th style="padding:6px;text-align:center">Grade</th>
            <th style="padding:6px;text-align:center">Percentage</th>
            <th style="padding:6px;text-align:center">Remarks</th>
          </tr>
        </thead>
        <tbody>
          <tr><td style="padding:5px;text-align:center;font-weight:700;color:#15803d">A+</td><td style="padding:5px;text-align:center">90% and above</td><td style="padding:5px;text-align:center">Outstanding</td></tr>
          <tr style="background:#f8fafc"><td style="padding:5px;text-align:center;font-weight:700;color:#15803d">A</td><td style="padding:5px;text-align:center">80% – 89%</td><td style="padding:5px;text-align:center">Excellent</td></tr>
          <tr><td style="padding:5px;text-align:center;font-weight:700;color:#1e40af">B+</td><td style="padding:5px;text-align:center">70% – 79%</td><td style="padding:5px;text-align:center">Very Good</td></tr>
          <tr style="background:#f8fafc"><td style="padding:5px;text-align:center;font-weight:700;color:#1e40af">B</td><td style="padding:5px;text-align:center">60% – 69%</td><td style="padding:5px;text-align:center">Good</td></tr>
          <tr><td style="padding:5px;text-align:center;font-weight:700;color:#b45309">C</td><td style="padding:5px;text-align:center">50% – 59%</td><td style="padding:5px;text-align:center">Satisfactory</td></tr>
          <tr style="background:#f8fafc"><td style="padding:5px;text-align:center;font-weight:700;color:#b45309">D</td><td style="padding:5px;text-align:center">40% – 49%</td><td style="padding:5px;text-align:center">Pass</td></tr>
          <tr><td style="padding:5px;text-align:center;font-weight:700;color:#dc2626">F</td><td style="padding:5px;text-align:center">Below 40%</td><td style="padding:5px;text-align:center">Fail (FAIL)</td></tr>
        </tbody>
      </table>
      ${getPrintAudit()}
      <div class="dev-footer">© 2026 DISS — All Rights Reserved &nbsp;|&nbsp; Powered by Tataheer Business Group &nbsp;|&nbsp; +923218555566</div>
    </div>`;
  };

  // ── CLASS POSITION MAP — GLOBAL DENSE RANKING ENGINE (single source of truth) ──
  // Sorts by absolute total marks DESC (never rounded percentages, so a change of
  // even half a mark re-ranks correctly). Students with identical totals share the
  // same position, and the next lower total gets the IMMEDIATE next position with
  // zero gaps (238, 235, 235, 233 → 1st, 2nd, 2nd, 3rd — never skips to 4th).
  // Result cards (single + Print All) and the Position List all read THIS map.
  const getPositionMap = (stuList) => {
    const ranked = [...stuList]
      .map(s => ({ id: s.id, total: calcTotal(getMarks(s), getSubjects(s.cls)) }))
      .sort((a, b) => b.total - a.total);
    const map = {};
    let prevTotal = null, pos = 0;
    ranked.forEach(r => {
      if (prevTotal === null || r.total !== prevTotal) pos += 1;
      map[r.id] = pos;
      prevTotal = r.total;
    });
    return map;
  };

  // Class-aware wrapper around the dense-ranking engine: groups students by class
  // and ranks each group separately. In single-class mode this is one group (same
  // result as before); in Whole School mode every student is still positioned
  // within their OWN class — never against the whole school.
  const getClassAwarePosMap = (stuList) => {
    const byCls = {};
    stuList.forEach(s => { const k = _normCls(s.cls); (byCls[k] = byCls[k] || []).push(s); });
    const map = {};
    Object.values(byCls).forEach(group => Object.assign(map, getPositionMap(group)));
    return map;
  };

  // Live on-screen position for the marks-entry list — reads the SAME dense-ranking
  // engine as the printouts, and re-computes on every keystroke so the badge moves
  // the moment a mark changes.
  const screenPosMap = getClassAwarePosMap(appearedStu);
  const ordinal = (p) => p ? `${p}${p===1?'st':p===2?'nd':p===3?'rd':'th'}` : '—';

  const printResultCard = (stu) => {
    const posMap  = getClassAwarePosMap(classStu);
    const cardHTML = buildCardHTML(stu, posMap[stu.id]);
    const win = window.open('','_blank','width=720,height=800');
    if (!win) { alert('Popup blocked! Please allow popups for this site to print.'); return; }
    win.document.write(`<!DOCTYPE html><html><head><title>Result Card — ${stu.name}</title><style>${PRINT_CSS}</style></head><body>${cardHTML}<script>window.onload=function(){window.print();}<\/script></body></html>`);
    win.document.close();
  };

  const printAllResults = () => {
    // Only print cards for students who actually sat the exam — never print blank cards.
    if (appearedStu.length === 0) {
      alert('No students have any marks entered yet for ' + selTerm + ' ' + selYear + '. Nothing to print.');
      return;
    }
    const posMap = getClassAwarePosMap(appearedStu);
    // Whole School: cards come out grouped by class (school class order), then by
    // roll number inside each class — one command prints the entire school.
    const ordered = [...appearedStu].sort((a, b) =>
      CLASSES.indexOf(a.cls) - CLASSES.indexOf(b.cls) ||
      String(a.roll).localeCompare(String(b.roll), undefined, { numeric: true }));
    const cards  = ordered.map(stu => buildCardHTML(stu, posMap[stu.id])).join('\n');
    const win = window.open('','_blank','width=720,height=800');
    if (!win) { alert('Popup blocked! Please allow popups for this site to print.'); return; }
    win.document.write(`<!DOCTYPE html><html><head><title>Result Cards — ${clsLabel}</title><style>${PRINT_CSS}</style></head><body>${cards}<script>window.onload=function(){window.print();}<\/script></body></html>`);
    win.document.close();
  };

  // ── POSITION LIST GENERATOR ──────────────────────────────────────────────────
  // Builds a class-wise 1st/2nd/3rd rank sheet for ALL classes, formatted for
  // physical notice-board printing. Students with no marks for the selected term
  // are excluded automatically (they sit in the "No Appear" cluster).
  const printPositionList = () => {
    const classesWithData = [];
    CLASSES.forEach(cls => {
      const inCls = students.filter(s => s.cls === cls);
      const appeared = inCls.filter(stu => {
        const m = results[`${stu.id}_${selTerm}_${selYear}`] || {};
        return Object.values(m).some(v => v !== '' && v !== null && v !== undefined && !Number.isNaN(Number(v)));
      });
      if (appeared.length === 0) return;
      const ranked = appeared
        .map(stu => {
          const subjs = getSubjects(stu.cls);
          const marks = getMarks(stu);
          return {
            stu,
            total: calcTotal(marks, subjs),
            maxTot: calcMaxTotal(subjs),
            pct: calcPct(marks, subjs),
            grade: getGrade(calcPct(marks, subjs))
          };
        })
        .sort((a, b) => b.total - a.total);
      // Positions come ONLY from the global dense-ranking engine — no local
      // recalculation, so the Position List always mirrors the result cards.
      const posMap = getPositionMap(appeared);
      ranked.forEach(r => { r.position = posMap[r.stu.id]; });
      // Notice board shows EVERY student holding rank 1-3 — ties expand the list
      // (e.g. four students tied at 2nd are all printed, next student is 6th and excluded)
      classesWithData.push({ cls, ranked: ranked.filter(r => r.position <= 3) });
    });

    if (classesWithData.length === 0) {
      alert('No classes have any marks entered for ' + selTerm + ' ' + selYear + '. Enter marks first.');
      return;
    }

    const medal = (p) => p === 1 ? '🥇' : p === 2 ? '🥈' : p === 3 ? '🥉' : '';
    const sections = classesWithData.map(({ cls, ranked }) => `
      <div class="cls-block">
        <div class="cls-title">Class ${esc(cls)}</div>
        <table class="rank-tbl">
          <thead><tr><th style="width:50px">Pos</th><th>Student Name</th><th style="width:100px">Father</th><th style="width:60px">Roll</th><th style="width:80px">Marks</th><th style="width:60px">%</th><th style="width:50px">Grade</th></tr></thead>
          <tbody>
            ${ranked.map(r => `
              <tr class="${r.position===1?'gold':r.position===2?'silver':r.position===3?'bronze':''}">
                <td style="text-align:center;font-weight:900;font-size:14px">${medal(r.position)} ${r.position}${r.position===1?'st':r.position===2?'nd':r.position===3?'rd':'th'}</td>
                <td><b>${esc(r.stu.name)}</b></td>
                <td style="color:#6b7280;font-size:10px">${esc(r.stu.father || '—')}</td>
                <td style="text-align:center">${esc(String(r.stu.roll || '—'))}</td>
                <td style="text-align:center;font-weight:700">${r.total} / ${r.maxTot}</td>
                <td style="text-align:center;font-weight:800;color:#1d4ed8">${r.pct}%</td>
                <td style="text-align:center;font-weight:800;color:#7c3aed">${r.grade}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `).join('');

    const html = `<!DOCTYPE html><html><head><title>Position List — ${selTerm} ${selYear}</title>
      <style>
        @page{size:A4 portrait;margin:0.5in 0.55in}
        *{box-sizing:border-box;margin:0;padding:0}
        body{font-family:'Segoe UI',Arial,sans-serif;color:#111;padding:0}
        /* Header repeats on every printed page via thead → display:table-header-group.
           Footer also repeats via tfoot → display:table-footer-group. */
        .page-wrap{width:100%;border-collapse:collapse}
        .page-wrap thead{display:table-header-group}
        .page-wrap tfoot{display:table-footer-group}
        .hdr{text-align:center;border-bottom:3px solid #c0392b;padding-bottom:10px;margin-bottom:18px}
        .hdr img{height:65px;object-fit:contain;margin-bottom:6px}
        .hdr-title{font-size:16px;font-weight:900;color:#c0392b;letter-spacing:1px;margin-top:4px}
        .cls-block{margin-bottom:22px;page-break-inside:avoid;break-inside:avoid}
        .cls-title{font-size:14px;font-weight:900;color:#1e3a8a;background:#dbeafe;padding:6px 12px;border-radius:6px;margin-bottom:6px;letter-spacing:.5px;text-transform:uppercase}
        .rank-tbl{width:100%;border-collapse:collapse;font-size:12px}
        .rank-tbl th{background:#1e3a8a;color:#fff;padding:7px 10px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.3px}
        .rank-tbl td{padding:8px 10px;border-bottom:1px solid #e5e7eb}
        .rank-tbl tr.gold td{background:#fef9c3;border-bottom:2px solid #ca8a04}
        .rank-tbl tr.silver td{background:#f1f5f9;border-bottom:2px solid #94a3b8}
        .rank-tbl tr.bronze td{background:#fef3c7;border-bottom:2px solid #b45309}
        .dev-footer{text-align:center;margin-top:18px;padding-top:8px;border-top:1px solid #e5e7eb;font-size:9px;color:#9ca3af;letter-spacing:.3px}
        @media print{button{display:none!important}}
      </style></head><body>
      <table class="page-wrap">
        <thead><tr><td>
          <div class="hdr">
            <img src="${LOGO_SRC}" alt="DISS" onerror="this.style.display='none'"/>
            <div class="hdr-title">🏆 POSITION LIST — ${esc(selTerm)} ${esc(String(selYear))}</div>
          </div>
        </td></tr></thead>
        <tbody><tr><td>
          ${sections}
        </td></tr></tbody>
        <tfoot><tr><td>
          <div class="dev-footer">© ${esc(String(selYear))} DISS — All Rights Reserved &nbsp;|&nbsp; Powered by Tataheer Business Group &nbsp;|&nbsp; +923218555566</div>
        </td></tr></tfoot>
      </table>
      <script>window.onload=function(){window.print();}<\/script>
      </body></html>`;

    const win = window.open('', '_blank', 'width=820,height=900');
    if (!win) { alert('Popup blocked! Please allow popups for this site to print.'); return; }
    win.document.write(html);
    win.document.close();
  };

  return (
    <div>
      <h2 className="text-xl font-bold text-gray-800 mb-5">Exams</h2>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-xl w-fit mb-5">
        {[['datesheet','📅 Date Sheet'],['results','📊 Result Cards'],['paper','📝 Paper']].map(([k,l])=>(
          <button key={k} onClick={()=>setTabSafe(k)}
            className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${tab===k?'bg-white shadow text-blue-700':'text-gray-500 hover:text-gray-700'}`}>{l}</button>
        ))}
      </div>

      {/* Common filters */}
      <div className="flex flex-wrap gap-2 mb-5">
        <select value={selTerm} onChange={e=>setSelTerm(e.target.value)} className={inputCls+' w-auto'}>
          {TERMS.map(t=><option key={t}>{t}</option>)}
        </select>
        <select value={selYear} onChange={e=>setSelYear(Number(e.target.value))} className={inputCls+' w-auto'}>
          {years.map(y=><option key={y}>{y}</option>)}
        </select>
        <select value={selCls} onChange={e=>setSelCls(e.target.value)} className={inputCls+' w-auto'}>
          {tab==='results' && <option value="__ALL__">🏫 Whole School — All Classes</option>}
          {CLASSES.map(c=><option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {/* ── DATE SHEET TAB ── */}
      {tab==='datesheet' && (
        <div>
          <div className="flex flex-wrap gap-2 mb-4">
            <Btn variant="outline" onClick={addDSRow}>+ Add Row</Btn>
            <Btn variant="outline" onClick={() => setApplyToMod(true)}>📋 Apply to Classes…</Btn>
            <Btn onClick={printDateSheet}>🖨️ Print Date Sheet</Btn>
            <Btn variant="outline" onClick={printConsolidatedDateSheet}>📚 Print Consolidated</Btn>
          </div>

          {dsRows.length===0
            ? <Empty icon="📅" text="No subjects configured for this class yet. Add subjects via Result Cards → Subjects editor. Then this date sheet will auto-populate."/>
            : <Card className="overflow-hidden">
                {/* Phase 2: Apply-to-Multiple-Classes modal */}
                {applyToMod && (
                  <Modal title={`📋 Apply ${selCls} Date Sheet to Other Classes`} onClose={() => { setApplyToMod(false); setApplyTargets([]); }}>
                    <p className="text-xs text-gray-500 mb-3">Copies subjects + dates + times from <b>{selCls}</b> ({selTerm} {selYear}) into each ticked class. Existing date sheets on those classes will be overwritten.</p>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-4 max-h-72 overflow-y-auto">
                      {CLASSES.filter(c => c !== selCls).map(c => {
                        const checked = applyTargets.includes(c);
                        return (
                          <label key={c} className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer text-sm ${checked ? 'bg-blue-50 border-blue-300' : 'bg-white border-gray-200 hover:border-gray-300'}`}>
                            <input type="checkbox" checked={checked} onChange={() => setApplyTargets(t => checked ? t.filter(x => x !== c) : [...t, c])} />
                            <span className="font-medium">{c}</span>
                          </label>
                        );
                      })}
                    </div>
                    <div className="flex gap-2">
                      <Btn variant="outline" onClick={() => setApplyTargets(CLASSES.filter(c => c !== selCls))}>Select All</Btn>
                      <Btn variant="outline" onClick={() => setApplyTargets([])}>Clear</Btn>
                      <div className="flex-1"/>
                      <Btn onClick={doApplyToClasses} disabled={applyTargets.length === 0}>✓ Apply to {applyTargets.length} class(es)</Btn>
                    </div>
                  </Modal>
                )}
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b">
                      <tr className="text-left text-xs text-gray-500 font-semibold uppercase">
                        <th className="px-2 py-3"></th>
                        <th className="px-3 py-3">#</th>
                        <th className="px-3 py-3">Subject</th>
                        <th className="px-3 py-3">Date</th>
                        <th className="px-3 py-3">Day</th>
                        <th className="px-3 py-3">Start</th>
                        <th className="px-3 py-3">End</th>
                        <th className="px-3 py-3"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {dsRows.map((r,i)=>(
                        <tr key={i}
                            onDragOver={(e) => { if (dragIdx === null) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dropOverIdx !== i) setDropOverIdx(i); }}
                            onDragLeave={() => { if (dropOverIdx === i) setDropOverIdx(null); }}
                            onDrop={(e) => { e.preventDefault(); const from = dragIdx != null ? dragIdx : Number(e.dataTransfer.getData('text/plain')); moveDSRow(from, i); setDragIdx(null); setDropOverIdx(null); }}
                            className={`hover:bg-slate-50 ${dragIdx === i ? 'opacity-40' : ''} ${dropOverIdx === i && dragIdx !== null && dragIdx !== i ? 'border-t-2 border-blue-500' : ''}`}>
                          <td className="px-2 py-2 text-gray-400 select-none text-lg leading-none"
                              title="Drag to reorder"
                              draggable
                              onDragStart={(e) => { setDragIdx(i); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', String(i)); } catch(_) {} }}
                              onDragEnd={() => { setDragIdx(null); setDropOverIdx(null); }}
                              style={{ cursor: 'grab' }}>⋮⋮</td>
                          <td className="px-3 py-2 text-gray-400 text-xs">{i+1}</td>
                          <td className="px-3 py-2">
                            <input value={r.subject} onChange={e=>updateDSRow(i,'subject',e.target.value)}
                              className="w-44 border border-gray-200 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"/>
                          </td>
                          <td className="px-3 py-2">
                            <input type="date" value={r.date} onChange={e=>{
                              const d = new Date(e.target.value);
                              const day = e.target.value ? d.toLocaleDateString('en-PK',{weekday:'long'}) : '';
                              const rows = dsRows.map((rr,ii)=>ii===i?{...rr,date:e.target.value,day}:rr);
                              persistDS({...dateSheets,[dsKey]:rows});
                            }} className="border border-gray-200 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"/>
                          </td>
                          <td className="px-3 py-2 text-gray-600 text-xs">{r.day||'—'}</td>
                          <td className="px-3 py-2">
                            <input type="time" value={r.startTime} onChange={e=>updateDSRow(i,'startTime',e.target.value)}
                              className="border border-gray-200 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"/>
                          </td>
                          <td className="px-3 py-2">
                            <input type="time" value={r.endTime} onChange={e=>updateDSRow(i,'endTime',e.target.value)}
                              className="border border-gray-200 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"/>
                          </td>
                          <td className="px-3 py-2">
                            <Btn sm variant="red" onClick={()=>removeDSRow(i)}>×</Btn>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
          }
        </div>
      )}

      {/* ── RESULT CARDS TAB ── */}
      {tab==='results' && (
        <div>
          {/* Auto-save status bar — STICKY so it stays visible while scrolling through students */}
          <div className={`sticky top-0 z-20 flex items-center justify-between gap-2 mb-3 px-4 py-2.5 rounded-xl border-2 transition-colors shadow-sm ${
            marksSaveState === 'saved'   ? 'bg-emerald-50 border-emerald-300' :
            marksSaveState === 'pending' ? 'bg-amber-50 border-amber-400' :
                                           'bg-blue-50 border-blue-400'
          }`}>
            <div className="flex items-center gap-2">
              {marksSaveState === 'saved'   && <><span className="text-emerald-600 text-base">✓</span><span className="text-sm font-bold text-emerald-700">All marks saved</span><span className="text-xs text-emerald-600 hidden sm:inline">— safe to leave this page</span></>}
              {marksSaveState === 'pending' && <><span className="text-amber-600 text-base animate-pulse">●</span><span className="text-sm font-bold text-amber-700">Typing… auto-save in 1.5 s</span><span className="text-xs text-amber-600 hidden sm:inline">— marks are safe in this browser</span></>}
              {marksSaveState === 'saving'  && <><span className="text-blue-600 text-base animate-spin inline-block">⟳</span><span className="text-sm font-bold text-blue-700">Saving to cloud…</span></>}
            </div>
            {/* Save Now button — ALWAYS visible. Disabled when nothing to save, active when there's a pending change. */}
            <button
              onClick={() => { if (marksSaveTimerRef.current) { clearTimeout(marksSaveTimerRef.current); marksSaveTimerRef.current = null; } flushMarksToFirebase(); }}
              disabled={marksSaveState === 'saving' || marksSaveState === 'saved'}
              className={`text-xs sm:text-sm font-bold px-4 py-1.5 rounded-lg border-2 transition-all ${
                marksSaveState === 'pending'
                  ? 'text-white bg-amber-500 border-amber-600 hover:bg-amber-600 cursor-pointer animate-pulse'
                  : marksSaveState === 'saving'
                    ? 'text-blue-700 bg-blue-100 border-blue-300 cursor-wait'
                    : 'text-emerald-700 bg-emerald-100 border-emerald-300 cursor-default'
              }`}>
              {marksSaveState === 'saved'   && '✓ Saved'}
              {marksSaveState === 'pending' && '💾 Save Now'}
              {marksSaveState === 'saving'  && '⟳ Saving…'}
            </button>
          </div>

          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-2 mb-4 p-3 bg-blue-50 rounded-xl border border-blue-100">
            {!wholeSchool && <>
              <span className="text-sm font-semibold text-blue-800">📝 Set Default Total Marks:</span>
              <input type="number" min="1" value={defaultTotal} onChange={e=>setDefaultTotal(e.target.value)}
                placeholder="e.g. 25"
                className="border border-blue-200 rounded-lg px-3 py-1.5 text-sm w-24 focus:outline-none focus:ring-2 focus:ring-blue-400"/>
              <Btn onClick={applyToAll}>✅ Apply to All</Btn>
              <Btn variant="outline" onClick={openSubjEditor}>⚙️ Edit Subjects</Btn>
            </>}
            {wholeSchool && <span className="text-sm font-semibold text-blue-800">🏫 Whole School mode — one click prints every class's result cards together.</span>}
            <div className="ml-auto flex gap-2">
              <Btn variant="outline" onClick={printPositionList}>🏆 Position List (All Classes)</Btn>
              <Btn onClick={printAllResults}>🖨️ Print All Cards — {clsLabel}</Btn>
            </div>
          </div>

          {/* Subject Editor Popup */}
          {showSubjEditor && (
            <Modal title={`⚙️ Edit Subjects — Class ${selCls}`} onClose={()=>setShowSubjEditor(false)} xl>
              <p className="text-xs text-gray-500 mb-4">Rename, remove, add subjects and set total marks. Changes apply to this class only.</p>
              <div className="grid grid-cols-12 gap-2 mb-2 px-1">
                <div className="col-span-1 text-xs font-bold text-gray-400 uppercase">#</div>
                <div className="col-span-6 text-xs font-bold text-gray-400 uppercase">Subject Name</div>
                <div className="col-span-3 text-xs font-bold text-gray-400 uppercase">Total Marks</div>
                <div className="col-span-2 text-xs font-bold text-gray-400 uppercase text-center">Remove</div>
              </div>
              <div className="space-y-2 mb-4 max-h-80 overflow-y-auto pr-1">
                {editorRows.map((row,idx)=>(
                  <div key={idx} className="grid grid-cols-12 gap-2 items-center bg-gray-50 rounded-xl px-2 py-1.5">
                    <div className="col-span-1 text-xs font-bold text-gray-400">{idx+1}</div>
                    <div className="col-span-6"><input value={row.name} onChange={e=>setEditorRows(rows=>rows.map((r,i)=>i===idx?{...r,name:e.target.value}:r))} className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" placeholder="Subject name"/></div>
                    <div className="col-span-3"><input type="number" min="1" value={row.total} onChange={e=>setEditorRows(rows=>rows.map((r,i)=>i===idx?{...r,total:e.target.value}:r))} className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-center focus:outline-none focus:ring-2 focus:ring-blue-400" placeholder="100"/></div>
                    <div className="col-span-2 text-center"><button onClick={()=>setEditorRows(rows=>rows.filter((_,i)=>i!==idx))} className="text-red-400 hover:text-red-600 text-xl font-bold px-2 rounded hover:bg-red-50 transition-all">✕</button></div>
                  </div>
                ))}
              </div>
              <button onClick={()=>setEditorRows(rows=>[...rows,{name:'',total:'100'}])} className="w-full border-2 border-dashed border-blue-300 rounded-xl py-2 text-sm font-semibold text-blue-600 hover:bg-blue-50 transition-all mb-5">+ Add Subject</button>
              <div className="flex gap-2 flex-wrap">
                <Btn onClick={saveSubjEditor}>💾 Save Changes</Btn>
                <Btn variant="outline" onClick={()=>setShowSubjEditor(false)}>Cancel</Btn>
                <div className="ml-auto"><Btn variant="red" onClick={resetSubjEditor}>🔄 Reset to Default</Btn></div>
              </div>
            </Modal>
          )}

          {classStu.length===0
            ? <Empty icon="📊" text="No students in this class yet."/>
            : <div className="space-y-4">
                {/* Cluster summary banner */}
                <div className="flex items-center justify-between gap-2 px-3 py-2 bg-blue-50/50 border border-blue-100 rounded-xl text-xs">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="font-semibold text-blue-800">📊 {selTerm} {selYear} — {clsLabel}:</span>
                    <span className="text-emerald-700 font-bold">✓ Appeared: {appearedStu.length}</span>
                    {noAppearStu.length > 0 && <span className="text-amber-700 font-bold">⊘ No Appear: {noAppearStu.length}</span>}
                    <span className="text-gray-500">· Total students: {classStu.length}</span>
                  </div>
                  <span className="text-gray-400 text-[10px] hidden sm:inline">Print All uses only Appeared students</span>
                </div>

                {/* ── APPEARED STUDENTS — shown in the main active list ── */}
                {appearedStu.map(stu=>{
                  const subjs   = getSubjects(stu.cls);
                  const marks   = getMarks(stu);
                  const total   = calcTotal(marks, subjs);
                  const maxTot  = calcMaxTotal(subjs);
                  const pct     = calcPct(marks, subjs);
                  const grade   = getGrade(pct);
                  const pf      = passOrFail(pct);
                  return (
                    <Card key={stu.id} className="overflow-hidden">
                      <div className="px-5 py-3 bg-blue-50 border-b border-blue-100 flex items-center justify-between">
                        <div>
                          <span className="font-bold text-blue-900">{stu.name}</span>
                          <span className="text-blue-400 text-xs ml-2">S/O {stu.father||'—'}</span>
                          <Badge color="blue" className="ml-2">{stu.cls}</Badge>
                          <span className="text-blue-400 text-xs ml-2">Roll: {stu.roll}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-extrabold text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-2 py-0.5 whitespace-nowrap">🏆 {ordinal(screenPosMap[stu.id])}</span>
                          <Badge color={pf==='PASS'?'green':'red'}>{pf}</Badge>
                          <span className="text-sm font-bold text-gray-700">{pct}% | {grade}</span>
                          <Btn sm onClick={()=>printResultCard(stu)}>🖨️ Print</Btn>
                        </div>
                      </div>
                      <div className="p-4">
                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                          {subjs.map(subj=>(
                            <div key={subj} className="bg-gray-50 rounded-xl p-2">
                              <p className="text-xs text-gray-500 mb-1 truncate" title={subj}>{subj}</p>
                              <input type="number" min="0" max={getSubjTotal(subj)}
                                value={marks[subj]!==undefined ? marks[subj] : ''}
                                onChange={e=>updateMark(stu, subj, e.target.value)}
                                placeholder="—"
                                className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-center font-bold focus:outline-none focus:ring-2 focus:ring-blue-400"/>
                              <div className="flex items-center justify-center gap-1 mt-0.5">
                                <span className="text-xs text-gray-300">/</span>
                                <input type="number" min="1"
                                  value={subjectTotals[subj]!==undefined ? subjectTotals[subj] : TOTAL_MARKS}
                                  onChange={e=>setSubjTotal(subj, e.target.value)}
                                  className="w-14 border border-gray-200 rounded px-1 py-0.5 text-xs text-center text-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-300"/>
                              </div>
                            </div>
                          ))}
                        </div>
                        <div className="mt-3 flex gap-3 text-sm flex-wrap">
                          <span className="text-gray-500">Total: <b className="text-gray-800">{total} / {maxTot}</b></span>
                          <span className="text-gray-500">Percentage: <b className="text-blue-700">{pct}%</b></span>
                          <span className="text-gray-500">Grade: <b className="text-purple-700">{grade}</b></span>
                          <span className="text-gray-500">Position: <b className="text-amber-600">{ordinal(screenPosMap[stu.id])}</b></span>
                        </div>
                      </div>
                    </Card>
                  );
                })}

                {/* ── NO APPEAR CLUSTER — collapsible. Excluded from Print All & ranking. ── */}
                {noAppearStu.length > 0 && (
                  <Card className="overflow-hidden border-2 border-dashed border-amber-300">
                    <button onClick={() => setShowNoAppear(!showNoAppear)}
                      className="w-full px-5 py-3 bg-amber-100 border-b border-amber-200 flex items-center justify-between hover:bg-amber-200 transition-colors text-left">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-lg">📝</span>
                        <span className="font-bold text-amber-900">Marks Entry — {noAppearStu.length} student{noAppearStu.length!==1?'s':''} pending in Class {selCls}</span>
                        <span className="text-xs text-amber-700 hidden sm:inline">· Enter even one mark and they move to Appeared list</span>
                      </div>
                      <span className="text-amber-800 font-bold text-sm whitespace-nowrap">{showNoAppear ? '▼ Hide' : '▶ Show & enter marks'}</span>
                    </button>
                    {showNoAppear && (
                      <div className="p-4 space-y-4 bg-amber-50/30">
                        <div className="text-xs text-amber-700 bg-amber-100/60 border-l-4 border-amber-400 px-3 py-2 rounded-r">
                          💡 These students currently have no marks for {selTerm} {selYear}. As soon as you enter even one mark, the student moves to the Appeared list and becomes eligible for Print All and position ranking.
                        </div>
                        {noAppearStu.map(stu => {
                          const subjs   = getSubjects(stu.cls);
                          const marks   = getMarks(stu);
                          return (
                            <Card key={stu.id} className="overflow-hidden">
                              <div className="px-5 py-3 bg-amber-50 border-b border-amber-100 flex items-center justify-between">
                                <div>
                                  <span className="font-bold text-amber-900">{stu.name}</span>
                                  <span className="text-amber-500 text-xs ml-2">S/O {stu.father||'—'}</span>
                                  <Badge color="yellow" className="ml-2">{stu.cls}</Badge>
                                  <span className="text-amber-500 text-xs ml-2">Roll: {stu.roll}</span>
                                </div>
                                <span className="text-xs font-bold text-amber-700 bg-amber-100 px-2 py-1 rounded-full">⊘ NO APPEAR</span>
                              </div>
                              <div className="p-4">
                                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                                  {subjs.map(subj=>(
                                    <div key={subj} className="bg-gray-50 rounded-xl p-2">
                                      <p className="text-xs text-gray-500 mb-1 truncate" title={subj}>{subj}</p>
                                      <input type="number" min="0" max={getSubjTotal(subj)}
                                        value={marks[subj]!==undefined ? marks[subj] : ''}
                                        onChange={e=>updateMark(stu, subj, e.target.value)}
                                        placeholder="—"
                                        className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-center font-bold focus:outline-none focus:ring-2 focus:ring-amber-400"/>
                                      <div className="flex items-center justify-center gap-1 mt-0.5">
                                        <span className="text-xs text-gray-300">/</span>
                                        <input type="number" min="1"
                                          value={subjectTotals[subj]!==undefined ? subjectTotals[subj] : TOTAL_MARKS}
                                          onChange={e=>setSubjTotal(subj, e.target.value)}
                                          className="w-14 border border-gray-200 rounded px-1 py-0.5 text-xs text-center text-gray-500 focus:outline-none focus:ring-1 focus:ring-amber-300"/>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            </Card>
                          );
                        })}
                      </div>
                    )}
                  </Card>
                )}
              </div>
          }
        </div>
      )}

      {/* ── PAPER TAB ── */}
      {tab==='paper' && (
        <div>
          {/* Paper Settings */}
          <Card className="p-4 mb-4">
            <h3 className="font-bold text-gray-700 mb-3">📋 Paper Settings</h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              <div><label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Class</label>
                <select value={paperSettings.cls} onChange={e=>setPaperSettingsSafe({...paperSettings,cls:e.target.value})} className={inputCls}>
                  {CLASSES.map(c=><option key={c} value={c}>Class {c}</option>)}</select></div>
              <div><label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Subject</label>
                <input value={paperSettings.subject} onChange={e=>setPaperSettingsSafe({...paperSettings,subject:e.target.value})} className={inputCls} placeholder="English"/></div>
              <div><label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Term</label>
                <select value={paperSettings.term} onChange={e=>setPaperSettingsSafe({...paperSettings,term:e.target.value})} className={inputCls}>
                  {TERMS.map(t=><option key={t}>{t}</option>)}</select></div>
              <div><label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Year</label>
                <select value={paperSettings.year} onChange={e=>setPaperSettingsSafe({...paperSettings,year:Number(e.target.value)})} className={inputCls}>
                  {years.map(y=><option key={y}>{y}</option>)}</select></div>
              <div><label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Date</label>
                <input type="date" value={paperSettings.date} onChange={e=>setPaperSettingsSafe({...paperSettings,date:e.target.value})} className={inputCls}/></div>
              <div><label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Total Marks</label>
                <input type="number" value={paperSettings.totalMarks} onChange={e=>setPaperSettingsSafe({...paperSettings,totalMarks:e.target.value})} className={inputCls}/></div>
              <div><label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Time Allowed</label>
                <input value={paperSettings.time} onChange={e=>setPaperSettingsSafe({...paperSettings,time:e.target.value})} className={inputCls} placeholder="2 Hours"/></div>
              <div className="col-span-2 sm:col-span-3 lg:col-span-1"><label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Instructions</label>
                <input value={paperSettings.instructions} onChange={e=>setPaperSettingsSafe({...paperSettings,instructions:e.target.value})} className={inputCls} placeholder="Attempt all questions."/></div>
            </div>
          </Card>

          {/* Questions */}
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-bold text-gray-700">Questions <span className="text-gray-400 font-normal text-sm">({paperQs.length})</span></h3>
            <div className="flex gap-2">
              <Btn variant="outline" onClick={printPaper}>🖨️ Print Paper</Btn>
              <Btn onClick={addQ}>+ Add Question</Btn>
            </div>
          </div>

          {paperQs.length === 0
            ? <Empty icon="📝" text="No questions yet. Click + Add Question to start building your paper."/>
            : <div className="space-y-3">
                {paperQs.map((q, idx) => (
                  <Card key={q.id} className="p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <span className="w-7 h-7 rounded-full bg-blue-100 text-blue-700 font-bold text-sm flex items-center justify-center shrink-0">Q{idx+1}</span>
                      <input value={q.section} onChange={e=>updateQ(q.id,'section',e.target.value)} placeholder="Section (optional, e.g. Section A)" className="border border-gray-200 rounded-lg px-3 py-1.5 text-xs flex-1 focus:outline-none focus:ring-1 focus:ring-blue-400"/>
                      <button onClick={()=>removeQ(q.id)} className="text-red-400 hover:text-red-600 text-lg font-bold px-2">✕</button>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                      <div>
                        <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Question Text</label>
                        <textarea value={q.text} onChange={e=>updateQ(q.id,'text',e.target.value)} rows={2} placeholder="Type your question here..." className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 resize-none"/>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Answer Type</label>
                          <select value={q.type} onChange={e=>updateQ(q.id,'type',e.target.value)} className={inputCls}>
                            <option value="english">🇬🇧 English Lines</option>
                            <option value="urdu">اردو Urdu Lines</option>
                            <option value="short">✏️ Short Answer</option>
                            <option value="narrow">〰️ Narrow Lines</option>
                            <option value="math">➕ Math Boxes</option>
                            <option value="shapes">🔵 Shapes</option>
                            <option value="table">📊 Table</option>
                          </select>
                        </div>
                        <div>
                          <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Marks</label>
                          <input type="number" min="1" value={q.marks} onChange={e=>updateQ(q.id,'marks',Number(e.target.value))} className={inputCls}/>
                        </div>
                        {q.type==='english' && (
                          <div>
                            <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">No. of Lines</label>
                            <input type="number" min="1" max="30" value={q.writtenCount} onChange={e=>updateQ(q.id,'writtenCount',e.target.value)} placeholder="e.g. 6" className={inputCls}/>
                          </div>
                        )}
                        {q.type==='urdu' && (
                          <div>
                            <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">No. of Lines</label>
                            <input type="number" min="1" max="30" value={q.urduCount} onChange={e=>updateQ(q.id,'urduCount',e.target.value)} placeholder="e.g. 6" className={inputCls}/>
                          </div>
                        )}
                        {q.type==='short' && (
                          <div>
                            <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">No. of Lines</label>
                            <input type="number" min="1" max="30" value={q.shortCount} onChange={e=>updateQ(q.id,'shortCount',e.target.value)} placeholder="e.g. 2" className={inputCls}/>
                          </div>
                        )}
                        {q.type==='narrow' && (
                          <div>
                            <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">No. of Lines</label>
                            <input type="number" min="1" max="30" value={q.narrowCount} onChange={e=>updateQ(q.id,'narrowCount',e.target.value)} placeholder="e.g. 6" className={inputCls}/>
                          </div>
                        )}
                        {q.type==='math' && (
                          <>
                            <div>
                              <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Rows</label>
                              <input type="number" min="1" max="8" value={q.mathRows} onChange={e=>updateQ(q.id,'mathRows',e.target.value)} placeholder="e.g. 2" className={inputCls}/>
                            </div>
                            <div>
                              <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Columns</label>
                              <input type="number" min="1" max="12" value={q.mathCols} onChange={e=>updateQ(q.id,'mathCols',e.target.value)} placeholder="e.g. 4" className={inputCls}/>
                            </div>
                          </>
                        )}
                        {q.type==='shapes' && (
                          <div>
                            <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Lines Below</label>
                            <input type="number" min="0" max="10" value={q.shapesLineCount} onChange={e=>updateQ(q.id,'shapesLineCount',e.target.value)} placeholder="e.g. 3" className={inputCls}/>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Table toggle — for non-table types */}
                    {q.type !== 'table' && (
                      <div className="mt-2 flex items-center gap-2">
                        <label className="flex items-center gap-1.5 cursor-pointer px-3 py-1.5 border-2 rounded-xl transition-all select-none
                          border-dashed border-gray-300 hover:border-blue-400 bg-white">
                          <input type="checkbox" checked={!!q.tableEnabled} onChange={e=>updateQ(q.id,'tableEnabled',e.target.checked)} className="w-4 h-4 accent-blue-600"/>
                          <span className="text-xs font-bold text-gray-600">📊 Add Table to this question</span>
                        </label>
                      </div>
                    )}

                    {/* Shapes panel — available for ALL question types */}
                    <div className="mt-3 border border-dashed border-blue-200 rounded-xl p-3 bg-blue-50/30">
                      <div className="flex flex-wrap items-center gap-3 mb-2">
                        <span className="text-xs font-bold text-blue-700">🔵 Add Shapes (optional)</span>
                        {/* Size */}
                        <div className="flex items-center gap-1.5">
                          <label className="text-xs font-semibold text-gray-500">Size:</label>
                          <input type="number" min="30" max="300" value={q.shapeSize||80}
                            onChange={e=>updateQ(q.id,'shapeSize',Number(e.target.value))}
                            className="border border-gray-200 rounded-lg px-2 py-1 text-xs w-16 bg-white focus:outline-none focus:ring-1 focus:ring-blue-400"/>
                          <span className="text-xs text-gray-400">px</span>
                        </div>
                        {/* Name line toggle */}
                        <label className="flex items-center gap-1.5 cursor-pointer">
                          <input type="checkbox" checked={!!q.shapeNameLine} onChange={e=>updateQ(q.id,'shapeNameLine',e.target.checked)} className="w-4 h-4 accent-blue-600"/>
                          <span className="text-xs font-semibold text-gray-600">Name Line</span>
                        </label>
                        {/* Alignment */}
                        <div className="flex items-center gap-1">
                          <span className="text-xs text-gray-500 mr-1">Align:</span>
                          {[['left','⬅'],['center','↔'],['right','➡']].map(([a,icon])=>(
                            <button key={a} onClick={()=>updateQ(q.id,'shapeAlign',a)}
                              className={`px-2 py-0.5 rounded text-xs font-bold border transition-all ${q.shapeAlign===a?'bg-blue-600 text-white border-blue-600':'bg-white border-gray-200 text-gray-500 hover:border-gray-400'}`}>
                              {icon}
                            </button>
                          ))}
                        </div>
                      </div>
                      {/* Shape toggle buttons */}
                      <div className="flex flex-wrap gap-1.5 mb-2">
                        {SHAPE_LIST.map(sh => (
                          <button key={sh} onClick={() => {
                            const curr = q.shapes || [];
                            const next = curr.includes(sh) ? curr.filter(s=>s!==sh) : [...curr, sh];
                            updateQ(q.id,'shapes',next);
                          }} className={`px-2.5 py-1 rounded-lg text-xs font-semibold border-2 transition-all ${(q.shapes||[]).includes(sh)?'border-blue-500 bg-blue-100 text-blue-700':'border-gray-200 bg-white text-gray-500 hover:border-gray-300'}`}>
                            {sh}
                          </button>
                        ))}
                      </div>
                      {/* Shape preview */}
                      {(q.shapes||[]).length > 0 && (
                        <div className={`flex gap-4 flex-wrap p-3 bg-white rounded-lg border border-gray-100 ${q.shapeAlign==='center'?'justify-center':q.shapeAlign==='right'?'justify-end':'justify-start'}`}>
                          {(q.shapes||[]).map((sh,i) => (
                            <div key={i} className="flex flex-col items-center gap-1">
                              <div dangerouslySetInnerHTML={{__html: shapeSVG(sh, q.shapeSize||80)}}/>
                              {q.shapeNameLine && <div style={{width:`${q.shapeSize||80}px`,borderBottom:'1.5px solid #333',marginTop:'4px'}}/>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Preview answer space */}
                    {q.type==='english' && Number(q.writtenCount)>0 && (
                      <div className="mt-2 bg-white">
                        {Array(Math.min(Number(q.writtenCount),6)).fill(0).map((_,g)=>(
                          <div key={g} style={{marginBottom:'18px'}}>
                            {[0,1,2,3].map(i=>(
                              <div key={i} style={{height:'12px',borderBottom:'1.5px solid #333',width:'100%'}}/>
                            ))}
                          </div>
                        ))}
                      </div>
                    )}
                    {q.type==='urdu' && Number(q.urduCount)>0 && (
                      <div className="mt-2 bg-white">
                        {Array(Math.min(Number(q.urduCount),8)).fill(0).map((_,i)=>(
                          <div key={i} style={{height:'46px',borderBottom:'1.5px solid #555',width:'100%'}}/>
                        ))}
                      </div>
                    )}
                    {q.type==='short' && Number(q.shortCount)>0 && (
                      <div className="mt-2 bg-white">
                        {Array(Math.min(Number(q.shortCount),6)).fill(0).map((_,g)=>(
                          <div key={g} style={{marginBottom:'18px'}}>
                            {[0,1,2,3].map(i=>(
                              <div key={i} style={{height:'12px',borderBottom:'1.5px solid #333',width:'100%'}}/>
                            ))}
                          </div>
                        ))}
                      </div>
                    )}
                    {q.type==='narrow' && Number(q.narrowCount)>0 && (
                      <div className="mt-2 space-y-0.5 opacity-40">
                        {Array(Math.min(Number(q.narrowCount),12)).fill(0).map((_,i)=><div key={i} className="border-b border-gray-400 h-4 w-full"/>)}
                      </div>
                    )}
                    {q.type==='math' && Number(q.mathRows)>0 && Number(q.mathCols)>0 && (
                      <div className="mt-2 opacity-50 overflow-x-auto">
                        <div style={{display:'inline-block',borderTop:'2px solid #888',borderLeft:'2px solid #888'}}>
                          {Array(Number(q.mathRows)).fill(0).map((_,r)=>(
                            <div key={r} style={{display:'flex'}}>
                              {Array(Number(q.mathCols)).fill(0).map((_,c)=>(
                                <div key={c} style={{width:'58px',height:'58px',borderRight:'2px solid #888',borderBottom:'2px solid #888'}}/>
                              ))}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Table editor — available for ALL question types */}
                    {(q.type==='table' || q.tableEnabled) && (
                      <div className="mt-3 border border-gray-200 rounded-xl overflow-hidden">
                        {/* Table toolbar */}
                        <div className="flex flex-wrap items-center gap-2 p-2 bg-gray-50 border-b border-gray-200">
                          <span className="text-xs font-bold text-gray-600">📊 Table Editor</span>
                          {/* Column controls */}
                          <button onClick={()=>updateQ(q.id,'tableColumns',[...(q.tableColumns||[]),{header:''}])}
                            className="px-2 py-1 text-xs bg-blue-600 text-white rounded font-semibold hover:bg-blue-700">+ Col</button>
                          {(q.tableColumns||[]).length>1 && (
                            <button onClick={()=>updateQ(q.id,'tableColumns',(q.tableColumns||[]).slice(0,-1))}
                              className="px-2 py-1 text-xs bg-red-100 text-red-600 rounded font-semibold hover:bg-red-200">− Col</button>
                          )}
                          {/* Row controls */}
                          <button onClick={()=>updateQ(q.id,'tableRows',(q.tableRows||1)+1)}
                            className="px-2 py-1 text-xs bg-emerald-600 text-white rounded font-semibold hover:bg-emerald-700">+ Row</button>
                          {(q.tableRows||1)>1 && (
                            <button onClick={()=>{
                              const nr=(q.tableRows||1)-1;
                              const nd=Object.assign({},(q.tableData||{}));
                              (q.tableColumns||[]).forEach(function(_,ci){delete nd[nr+'_'+ci];});
                              setPaperQs(function(prev){return prev.map(function(qq){return qq.id===q.id?Object.assign({},qq,{tableRows:nr,tableData:nd}):qq;});});
                            }} className="px-2 py-1 text-xs bg-red-100 text-red-600 rounded font-semibold hover:bg-red-200">- Row</button>
                          )}
                          {/* Direction */}
                          <div className="flex items-center gap-1 ml-1">
                            <span className="text-xs text-gray-500">Dir:</span>
                            {['ltr','rtl'].map(d=>(
                              <button key={d} onClick={()=>updateQ(q.id,'tableDir',d)}
                                className={`px-2 py-0.5 text-xs rounded font-bold border ${q.tableDir===d?'bg-blue-600 text-white border-blue-600':'bg-white border-gray-300 text-gray-500'}`}>
                                {d==='ltr'?'LTR →':'RTL ←'}
                              </button>
                            ))}
                          </div>
                          {/* Row height */}
                          <select value={q.tableRowHeight||'0.45in'} onChange={e=>updateQ(q.id,'tableRowHeight',e.target.value)}
                            className="text-xs border border-gray-200 rounded px-1 py-0.5 bg-white">
                            <option value="0.30in">Narrow rows</option>
                            <option value="0.45in">Normal rows</option>
                            <option value="0.60in">Wide rows</option>
                            <option value="0.80in">Extra wide</option>
                          </select>
                        </div>
                        {/* Table grid */}
                        <div className="overflow-x-auto p-2">
                          <table style={{width:'100%',borderCollapse:'collapse',direction:q.tableDir||'ltr'}}>
                            <thead>
                              <tr>
                                {(q.tableColumns||[{header:''},{header:''}]).map((col,ci)=>(
                                  <th key={ci} style={{border:'1.5px solid #334155',background:'#1e3a8a',color:'#fff',padding:'4px 6px'}}>
                                    <input value={col.header} onChange={e=>{
                                      const cols=(q.tableColumns||[]).map((c,i)=>i===ci?{...c,header:e.target.value}:c);
                                      updateQ(q.id,'tableColumns',cols);
                                    }} placeholder={`Header ${ci+1}`}
                                    className="w-full bg-transparent text-white text-xs text-center outline-none placeholder-blue-300 font-bold"/>
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {Array(Number(q.tableRows)||5).fill(0).map((_,ri)=>(
                                <tr key={ri}>
                                  {(q.tableColumns||[{header:''},{header:''}]).map((col,ci)=>(
                                    <td key={ci} style={{border:'1.5px solid #334155',padding:'2px 4px',minHeight:'32px'}}>
                                      <input value={(q.tableData||{})[ri+'_'+ci]||''} onChange={e=>{
                                        var nd=Object.assign({},(q.tableData||{}));
                                        nd[ri+'_'+ci]=e.target.value;
                                        updateQ(q.id,'tableData',nd);
                                      }} placeholder="type to pre-fill"
                                      className="w-full text-xs px-1 outline-none" style={{direction:q.tableDir||'ltr'}}/>
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          <p className="text-xs text-gray-400 mt-1">💡 Leave cells empty for students to fill. Type content to pre-fill (e.g. words/questions).</p>
                        </div>
                      </div>
                    )}
                  </Card>
                ))}
              </div>
          }

          {paperQs.length > 0 && (
            <div className="mt-4 flex justify-between items-center">
              <Btn onClick={addQ}>+ Add Question</Btn>
              <Btn onClick={printPaper}>🖨️ Print Question Paper</Btn>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── CASH BOOK ────────────────────────────────────────────────────────────────
function CashBook() {
  const { role } = React.useContext(UserContext);
  const isAdmin = role === 'admin';
  const today = new Date().toISOString().slice(0, 10);

  // ── v73: LIVE READS — Cash Book accounts and entries re-evaluated each
  // render so any Fee Collection → Cash Book write echoes immediately and
  // any external K.ACCT / K.CBOOK update propagates without remount.
  // The setters are now thin re-render triggers: callers still do
  // `S.set(K.X, updated); setX(updated)` (no shape change), and our setX
  // bumps a tick counter so React re-reads K.X live above.
  const [_cbTick, _setCbTick] = useState(0);
  const accounts  = getAccounts();
  const entries   = getActiveList(K.CBOOK);
  const setAccounts = (_next) => _setCbTick(t => t + 1); // arg ignored — live read picks up new K.ACCT
  const setEntries  = (_next) => _setCbTick(t => t + 1); // arg ignored — live read picks up new K.CBOOK
  const [tab, setTab]           = useState('ledger');
  const [balanceWarn, setBalanceWarn] = useState(true); // toggle insufficient balance check

  // Filters
  const [filterAcct, setFilterAcct] = useState('');
  const [filterType, setFilterType] = useState('');
  // ── Default Cash Book to current-month view. June entries auto-hide when
  //    July arrives. User can click "Show All" to see full history anytime.
  const _todayForFilter = new Date();
  const _monthStart = new Date(_todayForFilter.getFullYear(), _todayForFilter.getMonth(), 1).toISOString().slice(0,10);
  const [filterFrom, setFilterFrom] = useState(_monthStart);
  const [filterTo,   setFilterTo]   = useState('');

  // Account modal
  const [acctMod, setAcctMod] = useState(null);
  const [af, setAf] = useState({ name:'', type:'cash', number:'', openingBalance:'' });

  // Manual entry modal
  const [entryMod, setEntryMod] = useState(false);
  const [ef, setEf] = useState({ date: today, type:'income', description:'', amount:'', accountId:'', note:'' });

  // Internal Transfer modal
  const [transferMod, setTransferMod] = useState(false);
  const [tf, setTf] = useState({ date: today, fromId:'', toId:'', amount:'', note:'' });

  // Edit entry modal
  const [cbEdit, setCbEdit] = useState(null);

  const refreshEntries = () => { setEntries(getActiveList(K.CBOOK)); setAccounts(getAccounts()); };

  const acctIcon = t => t==='cash'?'💵':t==='bank'?'🏦':'📱';

  // ── All-time per-account balance (includes opening balance) ──
  // ── v73: Single Majma call — provides balances + totalIncome/totalExpense ─
  // Same cutoff rule applied centrally so this CashBook view, the Dashboard
  // "Cash In Hand" card, and any future consumer cannot diverge.
  const cbSnap       = useMemo(() => buildCashBookSnapshot({ cashbook: entries, accounts }), [entries, accounts]);
  const balances     = cbSnap.balances;
  const totalIncome  = cbSnap.totalIncomeAllTime;   // ↔ Dashboard income (cutoff-filtered)
  const totalExpense = cbSnap.totalExpAllTime;      // ↔ Dashboard expense (cutoff-filtered)

  // ── Live student list + retro-match map — shared across all rows for efficiency.
  // Rebuilds when entries or students change (Sync echo or local edits).
  const cbStuList     = useMemo(() => S.get(K.STU, []), [entries]);
  const cbPayMatchMap = useMemo(() => buildCashBookPayMatchMap(), [entries]);

  // ── Sort ALL entries by date asc, then id ──
  const allSorted = useMemo(() =>
    [...entries].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)),
    [entries]);

  // ── Per-account running balance up to any point ──
  // Build running balance per account for display
  const allWithAcctRunning = useMemo(() => {
    const acctRunning = {};
    accounts.forEach(a => { acctRunning[a.id] = Number(a.openingBalance || 0); });
    return allSorted.map(e => {
      if (acctRunning[e.accountId] !== undefined) {
        acctRunning[e.accountId] += e.type === 'income' ? Number(e.amount) : -Number(e.amount);
      }
      return { ...e, acctBalance: acctRunning[e.accountId] ?? 0 };
    });
  }, [allSorted, accounts]);

  // ── Apply filters on top of the running-balance list ──
  // June 2026 Fresh-Start cutoff is enforced HERE so pre-June rows never display in any
  // ledger view (regardless of date-range or account filters the user picks).
  const filteredWithRunning = useMemo(() => {
    let list = allWithAcctRunning.filter(e => {
      const ed = new Date(e.date || 0);
      if (isNaN(ed)) return false;
      if (ed.getFullYear() < ENGINE_CUTOFF_YEAR) return false;
      if (ed.getFullYear() === ENGINE_CUTOFF_YEAR && ed.getMonth() < ENGINE_CUTOFF_MONTH) return false;
      return true;
    });
    if (filterAcct) list = list.filter(e => e.accountId === filterAcct);
    if (filterType === 'transfer') list = list.filter(e => e.refType === 'transfer');
    else if (filterType) list = list.filter(e => e.type === filterType && e.refType !== 'transfer');
    if (filterFrom) list = list.filter(e => e.date >= filterFrom);
    if (filterTo)   list = list.filter(e => e.date <= filterTo);
    return list;
  }, [allWithAcctRunning, filterAcct, filterType, filterFrom, filterTo]);

  // ── Group by date for day summaries ──
  const dayGroups = useMemo(() => {
    const groups = {};
    filteredWithRunning.forEach(e => {
      if (!groups[e.date]) groups[e.date] = [];
      groups[e.date].push(e);
    });
    // Compute opening balance per day per account:
    // opening = acctBalance of first entry of that day minus its own effect
    const result = [];
    Object.keys(groups).sort().reverse().forEach(date => {
      const dayEntries = groups[date];
      // Opening balance for this day = balance before the first entry of the day (per account or combined)
      // For combined ledger view: sum of per-account balances before this day
      const openingPerAcct = {};
      accounts.forEach(a => { openingPerAcct[a.id] = Number(a.openingBalance || 0); });
      // ── June 2026 Fresh-Start Cutoff applied to "Balance brought forward" ──
      // Pre-June 2026 cashbook entries must NOT contribute to the running opening balance
      // shown for any day. Uses the same ENGINE_CUTOFF_YEAR / ENGINE_CUTOFF_MONTH constants
      // that calcPL, buildPaidMapsFromCutoff, and the dashboard cutoff filter all use.
      // No architecture change, no formula overwrite — only the filter scope is tightened.
      allSorted.filter(e => {
        if (e.date >= date) return false;
        const ed = new Date(e.date);
        if (isNaN(ed)) return false;
        if (ed.getFullYear() < ENGINE_CUTOFF_YEAR) return false;
        if (ed.getFullYear() === ENGINE_CUTOFF_YEAR && ed.getMonth() < ENGINE_CUTOFF_MONTH) return false;
        return true;
      }).forEach(e => {
        if (openingPerAcct[e.accountId] !== undefined)
          openingPerAcct[e.accountId] += e.type === 'income' ? Number(e.amount) : -Number(e.amount);
      });
      // If filtered by account, use that account's opening; else sum all
      const openingBal = filterAcct
        ? (openingPerAcct[filterAcct] || 0)
        : Object.values(openingPerAcct).reduce((s, v) => s + v, 0);

      const totalIn  = dayEntries.filter(e => e.type === 'income').reduce((s,e) => s + Number(e.amount), 0);
      const totalOut = dayEntries.filter(e => e.type === 'expense').reduce((s,e) => s + Number(e.amount), 0);
      const closingBal = openingBal + totalIn - totalOut;

      result.push({ date, entries: dayEntries, openingBal, totalIn, totalOut, closingBal });
    });
    return result;
  }, [filteredWithRunning, allSorted, accounts, filterAcct]);

  // (cbSnap moved above — totalIncome/totalExpense derived there directly)

  // ── Account balance before a given entry (for insufficient-balance check) ──
  const getBalanceBefore = (accountId, beforeDate) => {
    const acct = accounts.find(a => a.id === accountId);
    let bal = Number(acct?.openingBalance || 0);
    allSorted.filter(e => e.accountId === accountId && e.date <= beforeDate).forEach(e => {
      bal += e.type === 'income' ? Number(e.amount) : -Number(e.amount);
    });
    return bal;
  };

  const saveAccount = () => {
    if (!af.name.trim()) return alert('Enter account name.');
    let updated;
    if (acctMod === 'new') {
      updated = [...accounts, { id: uid(), name: af.name.trim(), type: af.type, number: af.number, openingBalance: Number(af.openingBalance || 0) }];
    } else {
      updated = accounts.map(a => a.id === acctMod.id ? { ...a, name: af.name.trim(), type: af.type, number: af.number, openingBalance: Number(af.openingBalance || 0) } : a);
    }
    S.set(K.ACCT, updated); setAccounts(updated); setAcctMod(null);
  };

  const deleteAccount = (id) => {
    if (entries.some(e => e.accountId === id)) return alert('Cannot delete — this account has transactions.');
    const updated = accounts.filter(a => a.id !== id);
    S.set(K.ACCT, updated); setAccounts(updated);
  };

  const saveEntry = () => {
    if (!ef.description.trim()) return alert('Description is required.');
    if (!ef.amount || Number(ef.amount) <= 0) return alert('Enter a valid amount.');
    if (!ef.accountId) return alert('Select an account.');
    // Insufficient balance check for expenses
    if (balanceWarn && ef.type === 'expense') {
      const curBal = balances[ef.accountId] || 0;
      if (curBal < Number(ef.amount)) {
        if (!window.confirm(`Warning: Insufficient balance in "${accounts.find(a=>a.id===ef.accountId)?.name}". Current balance: Rs. ${curBal.toLocaleString()}, Expense: Rs. ${Number(ef.amount).toLocaleString()}. Proceed anyway?`)) return;
      }
    }
    const acct = accounts.find(a => a.id === ef.accountId);
    const entry = { id: uid(), date: ef.date, type: ef.type, description: ef.description.trim(), amount: Number(ef.amount), accountId: ef.accountId, accountName: acct?.name || '', note: ef.note, refType: ef.refType || 'manual' };
    const updated = [...entries, entry];
    S.set(K.CBOOK, updated); setEntries(updated);
    setEntryMod(false);
    setEf({ date: today, type:'income', description:'', amount:'', accountId: accounts[0]?.id || '', note:'' });
  };

  const saveTransfer = () => {
    if (!tf.fromId || !tf.toId) return alert('Select both From and To accounts.');
    if (tf.fromId === tf.toId) return alert('From and To accounts must be different.');
    if (!tf.amount || Number(tf.amount) <= 0) return alert('Enter a valid amount.');
    const fromAcct = accounts.find(a => a.id === tf.fromId);
    const toAcct   = accounts.find(a => a.id === tf.toId);
    if (!fromAcct || !toAcct) return alert('Invalid accounts.');
    // Insufficient balance check
    if (balanceWarn && (balances[tf.fromId] || 0) < Number(tf.amount)) {
      if (!window.confirm(`Warning: Insufficient balance in "${fromAcct.name}". Current: Rs. ${(balances[tf.fromId]||0).toLocaleString()}, Transfer: Rs. ${Number(tf.amount).toLocaleString()}. Proceed anyway?`)) return;
    }
    const trid = uid();
    const desc = `Transfer: ${fromAcct.name} → ${toAcct.name}`;
    const outEntry = { id: uid(), date: tf.date, type: 'expense', description: desc, amount: Number(tf.amount), accountId: tf.fromId, accountName: fromAcct.name, note: tf.note || '', refType: 'transfer', transferId: trid };
    const inEntry  = { id: uid(), date: tf.date, type: 'income',  description: desc, amount: Number(tf.amount), accountId: tf.toId,   accountName: toAcct.name,   note: tf.note || '', refType: 'transfer', transferId: trid };
    const updated  = [...entries, outEntry, inEntry];
    S.set(K.CBOOK, updated); setEntries(updated);
    setTransferMod(false);
    setTf({ date: today, fromId:'', toId:'', amount:'', note:'' });
  };

  const fmtBal = (b) => `${b<0?'-':''}Rs. ${Math.abs(b).toLocaleString()}`;

  const printCashBook = () => {
    const acctCards = accounts.map(a => { const b = balances[a.id]||0; return `<div class="sum-card"><div class="val" style="color:${b>=0?'#1e3a8a':'#991b1b'}">${fmtBal(b)}</div><div class="lbl">${a.name}</div></div>`; }).join('');
    const filtIn  = filteredWithRunning.filter(e=>e.type==='income').reduce((s,e)=>s+Number(e.amount),0);
    const filtOut = filteredWithRunning.filter(e=>e.type==='expense').reduce((s,e)=>s+Number(e.amount),0);
    let bodyRows = '';
    dayGroups.forEach(({ date, entries: de, openingBal, totalIn, totalOut, closingBal }) => {
      const dateLabel = new Date(date).toLocaleDateString('en-PK', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
      bodyRows += `<tr style="background:#eff6ff"><td colspan="7" style="padding:8px 10px;font-weight:700;color:#1e3a8a;border-top:2px solid #bfdbfe">${dateLabel}</td></tr>`;
      bodyRows += `<tr style="background:#f8fafc;font-style:italic"><td colspan="4" style="padding:5px 10px;color:#6b7280;font-size:11px">Opening Balance</td><td></td><td></td><td style="text-align:right;font-weight:700;color:${openingBal>=0?'#1e3a8a':'#991b1b'}">${fmtBal(openingBal)}</td></tr>`;
      de.forEach(e => {
        const an = accounts.find(a=>a.id===e.accountId)?.name || e.accountName || '';
        bodyRows += `<tr>
          <td></td>
          <td><span class="badge ${e.type==='income'?'b-green':'b-red'}">${e.type==='income'?'↓ In':'↑ Out'}</span></td>
          <td><b>${resolveCashBookDesc(e, cbStuList, cbPayMatchMap)}</b>${e.note?`<br/><span style="color:#9ca3af;font-size:10px">${e.note.replace(/\s*\[stuId=[^\]]+\]/g,'').trim()||''}</span>`:''}</td>
          <td>${an}</td>
          <td style="text-align:right;color:#065f46">${e.type==='income'?'Rs. '+Number(e.amount).toLocaleString():''}</td>
          <td style="text-align:right;color:#991b1b">${e.type==='expense'?'Rs. '+Number(e.amount).toLocaleString():''}</td>
          <td style="text-align:right;font-weight:700;color:${e.acctBalance>=0?'#1e3a8a':'#991b1b'}">${fmtBal(e.acctBalance)}</td>
        </tr>`;
      });
      bodyRows += `<tr style="background:#f1f5f9;border-top:1px solid #e5e7eb">
        <td colspan="4" style="text-align:right;padding:6px 10px;font-weight:700;font-size:11px;color:#374151">Day Summary:</td>
        <td style="text-align:right;font-weight:700;color:#065f46">Rs. ${totalIn.toLocaleString()}</td>
        <td style="text-align:right;font-weight:700;color:#991b1b">Rs. ${totalOut.toLocaleString()}</td>
        <td style="text-align:right;font-weight:800;color:${closingBal>=0?'#1e3a8a':'#991b1b'}">${fmtBal(closingBal)}</td>
      </tr>`;
    });
    printPage('Cash Book', `
      <h2>Cash Book ${filterFrom||filterTo?`(${filterFrom||'Start'} → ${filterTo||'Today'})`:'— All Transactions'}</h2>
      <div class="summary">${acctCards}</div>
      <div class="summary">
        <div class="sum-card"><div class="val" style="color:#065f46">Rs. ${totalIncome.toLocaleString()}</div><div class="lbl">Total Income (All Time)</div></div>
        <div class="sum-card"><div class="val" style="color:#991b1b">Rs. ${totalExpense.toLocaleString()}</div><div class="lbl">Total Expense (All Time)</div></div>
        <div class="sum-card"><div class="val" style="color:#065f46">Rs. ${filtIn.toLocaleString()}</div><div class="lbl">Filtered In</div></div>
        <div class="sum-card"><div class="val" style="color:#991b1b">Rs. ${filtOut.toLocaleString()}</div><div class="lbl">Filtered Out</div></div>
      </div>
      <table><thead><tr><th>Date</th><th>Type</th><th>Description</th><th>Account</th><th style="text-align:right">In (Rs.)</th><th style="text-align:right">Out (Rs.)</th><th style="text-align:right">Balance</th></tr></thead>
      <tbody>${bodyRows||'<tr><td colspan="7" style="text-align:center;color:#9ca3af;padding:16px">No entries found</td></tr>'}</tbody>
      <tfoot><tr><td colspan="4" style="text-align:right;font-weight:700">Filtered Totals:</td><td style="text-align:right;color:#065f46;font-weight:700">Rs. ${filtIn.toLocaleString()}</td><td style="text-align:right;color:#991b1b;font-weight:700">Rs. ${filtOut.toLocaleString()}</td><td></td></tr></tfoot>
      </table>`);
  };

  // Selected account preview balance for entry modal
  const selectedAcctBal = ef.accountId ? (balances[ef.accountId] || 0) : null;

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-xl font-bold text-gray-800">💼 Cash Book</h2>
          <p className="text-sm text-gray-400">Daily accounting ledger with per-account tracking</p>
        </div>
        <div className="flex gap-2 flex-wrap justify-end">
          <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer select-none">
            <input type="checkbox" checked={balanceWarn} onChange={e=>setBalanceWarn(e.target.checked)} className="accent-blue-600"/>
            Balance check
          </label>
          <Btn variant="outline" onClick={refreshEntries}>🔄</Btn>
          <Btn variant="outline" onClick={printCashBook}>🖨️ Print</Btn>
          {isAdmin && <Btn variant="outline" onClick={() => { setTransferMod(true); setTf({ date: today, fromId: accounts[0]?.id||'', toId: accounts[1]?.id||'', amount:'', note:'' }); }}>↔ Transfer</Btn>}
          {isAdmin && <Btn variant="outline" onClick={() => { setEntryMod(true); setEf({ date: today, type:'income', description:'Owner Capital Investment', amount:'', accountId: accounts[0]?.id||'', note:'', refType:'owner_capital' }); }}>💰 Capital</Btn>}
          {isAdmin && <Btn variant="outline" onClick={() => { setEntryMod(true); setEf({ date: today, type:'expense', description:'Owner Drawing / Withdrawal', amount:'', accountId: accounts[0]?.id||'', note:'', refType:'owner_drawing' }); }}>💸 Drawing</Btn>}
          {isAdmin && <Btn onClick={() => { setEntryMod(true); setEf({ date: today, type:'income', description:'', amount:'', accountId: accounts[0]?.id||'', note:'', refType:'manual' }); }}>+ Add Entry</Btn>}
        </div>
      </div>

      {/* Account Balance Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        {accounts.map(a => {
          const b = balances[a.id] || 0;
          return (
            <Card key={a.id} className={`p-4 cursor-pointer border-2 transition-all ${filterAcct===a.id?'border-blue-400 bg-blue-50':'border-transparent hover:border-gray-200'}`}
              onClick={() => setFilterAcct(filterAcct===a.id?'':a.id)}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xl">{acctIcon(a.type)}</span>
                {filterAcct===a.id && <span className="text-xs text-blue-500 font-semibold">Filtered</span>}
              </div>
              <div className={`text-lg font-extrabold ${b >= 0 ? 'text-blue-700' : 'text-red-600'}`}>{fmtBal(b)}</div>
              <div className="text-xs text-gray-500 font-semibold mt-0.5">{a.name}</div>
              {a.number && <div className="text-xs text-gray-400">#{a.number}</div>}
              {Number(a.openingBalance||0) > 0 && <div className="text-xs text-gray-400 mt-0.5">Opening: Rs. {Number(a.openingBalance).toLocaleString()}</div>}
            </Card>
          );
        })}
      </div>

      {/* ── Real-Time Collection Heads — v74: Majma-sourced (zero inline reduce) ── */}
      {(() => {
        // ── v74: Income heads now come from buildFinancialSnapshot (THE Majma).
        // Same cutoff rule centralized inside the engine; this view cannot
        // drift from Dashboard / Fee Collection / Student Ledger.
        const reportSnap = buildFinancialSnapshot({});
        const feeCol  = reportSnap.feeAllTime;     // ↔ Dashboard "Fee Collected (all-time)"
        const afCol   = reportSnap.afAllTime;      // ↔ Dashboard AF total
        const bksCol  = reportSnap.booksAllTime;   // ↔ Dashboard Books total
        const totalIn = feeCol + afCol + bksCol;
        // Expense heads — kept inline because category grouping is module-specific
        // (Cash Book expenses come from K.EXP/K.SPAY/K.VPAY which aren't part of
        // student Majma). These are aggregate counts, not per-student metrics.
        const _dateCutoff = e => {
          const d = new Date(e.date || 0);
          if (isNaN(d)) return false;
          if (d.getFullYear() < ENGINE_CUTOFF_YEAR) return false;
          if (d.getFullYear() === ENGINE_CUTOFF_YEAR && d.getMonth() < ENGINE_CUTOFF_MONTH) return false;
          return true;
        };
        const exps   = getActiveList(K.EXP).filter(_dateCutoff);
        const spays  = getActiveList(K.SPAY).filter(_dateCutoff);
        const vpays  = getActiveList(K.VPAY).filter(_dateCutoff);
        const expCats = {};
        exps.forEach(e => { const c = e.category||'Other'; expCats[c] = (expCats[c]||0) + Number(e.amount||0); });
        const totalExpAmt  = exps.reduce((s,e) => s + Number(e.amount||0), 0);
        const totalSal     = spays.reduce((s,p) => s + Number(p.amount||0), 0);
        const totalVendPay = vpays.reduce((s,p) => s + Number(p.amount||0), 0);
        const totalOut     = totalExpAmt + totalSal + totalVendPay;
        const netCash      = totalIn - totalOut;
        // ── v74: Register UI values for the cross-component drift detector ──
        if (typeof window !== 'undefined' && window._DISS_DEBUG) {
          window._DRIFT_REGISTRY = window._DRIFT_REGISTRY || {};
          window._DRIFT_REGISTRY.CashBook = {
            feeCollAllTime: feeCol,
            afCollAllTime:  afCol,
            booksAllTime:   bksCol,
            totalIncome:    totalIn,
          };
        }
        return (
          <div className="mb-5">
            <div className="flex items-center gap-2 mb-2">
              <h3 className="text-sm font-bold text-gray-700">📊 Real-Time Collection Summary</h3>
              <span className="text-xs text-gray-400">(From June 2026 onwards · live Global Engine data)</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {/* Income */}
              <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-4">
                <p className="text-xs font-bold text-emerald-700 uppercase mb-0">💰 Income Heads</p>
                <p className="text-[10px] text-emerald-600 opacity-80 mb-2">↔ mirrors Dashboard via Majma</p>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-500">📋 Fee Collection</span>
                    <span className="font-bold text-emerald-700">Rs. {feeCol.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">🏦 Annual Fund</span>
                    <span className="font-bold text-purple-700">Rs. {afCol.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">📚 Books Sales</span>
                    <span className="font-bold text-amber-700">Rs. {bksCol.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between border-t border-emerald-200 pt-2 mt-1">
                    <span className="font-bold text-gray-700">Total Income</span>
                    <span className="font-extrabold text-emerald-700">Rs. {totalIn.toLocaleString()}</span>
                  </div>
                </div>
              </div>
              {/* Expense */}
              <div className="bg-red-50 border border-red-200 rounded-2xl p-4">
                <p className="text-xs font-bold text-red-600 uppercase mb-3">🧾 Expense Heads</p>
                <div className="space-y-2 text-sm">
                  {Object.entries(expCats).slice(0,3).map(([cat, amt]) => (
                    <div key={cat} className="flex justify-between">
                      <span className="text-gray-500 truncate">{cat}</span>
                      <span className="font-bold text-red-600 ml-2">Rs. {amt.toLocaleString()}</span>
                    </div>
                  ))}
                  {Object.keys(expCats).length > 3 && (
                    <div className="text-xs text-gray-400">+{Object.keys(expCats).length-3} more categories</div>
                  )}
                  <div className="flex justify-between">
                    <span className="text-gray-500">👩‍🏫 Salaries</span>
                    <span className="font-bold text-orange-600">Rs. {totalSal.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">🏪 Vendor Payments</span>
                    <span className="font-bold text-red-700">Rs. {totalVendPay.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between border-t border-red-200 pt-2 mt-1">
                    <span className="font-bold text-gray-700">Total Expense</span>
                    <span className="font-extrabold text-red-600">Rs. {totalOut.toLocaleString()}</span>
                  </div>
                </div>
              </div>
              {/* Net */}
              <div className={`border rounded-2xl p-4 ${netCash >= 0 ? 'bg-blue-50 border-blue-200' : 'bg-red-50 border-red-300'}`}>
                <p className="text-xs font-bold text-blue-700 uppercase mb-3">📈 Net Position</p>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Total In</span>
                    <span className="font-bold text-emerald-700">Rs. {totalIn.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Total Out</span>
                    <span className="font-bold text-red-600">Rs. {totalOut.toLocaleString()}</span>
                  </div>
                  <div className={`flex justify-between border-t pt-2 mt-1 ${netCash>=0?'border-blue-200':'border-red-200'}`}>
                    <span className="font-bold text-gray-700">Net Cash</span>
                    <span className={`font-extrabold text-xl ${netCash >= 0 ? 'text-blue-700' : 'text-red-600'}`}>
                      {netCash < 0 ? '-' : ''}Rs. {Math.abs(netCash).toLocaleString()}
                    </span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-400">🏪 Vendor Debit</span>
                    <span className="text-red-500 font-semibold">Rs. {totalVendPay.toLocaleString()}</span>
                  </div>
                  <div className={`mt-1 text-center py-1.5 rounded-xl text-xs font-bold ${netCash>=0?'bg-blue-100 text-blue-700':'bg-red-100 text-red-600'}`}>
                    {netCash >= 0 ? '✅ Surplus' : '⚠️ Deficit'}
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-xl w-fit mb-5">
        {[['ledger','📒 Daily Ledger'],['accounts','🏛️ Accounts']].map(([t,l]) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-xl text-sm font-semibold transition-all ${tab===t?'bg-white shadow text-blue-700':'text-gray-500 hover:text-gray-700'}`}>
            {l}
          </button>
        ))}
      </div>

      {tab === 'ledger' && (
        <Card className="overflow-hidden">
          {/* Filters */}
          <div className="p-4 border-b bg-gray-50 flex flex-wrap gap-2 items-end">
            <div>
              <label className="block text-xs text-gray-500 font-semibold mb-1 uppercase">Account</label>
              <select value={filterAcct} onChange={e => setFilterAcct(e.target.value)} className={inputCls+' w-auto'}>
                <option value="">All Accounts</option>
                {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 font-semibold mb-1 uppercase">Type</label>
              <select value={filterType} onChange={e => setFilterType(e.target.value)} className={inputCls+' w-auto'}>
                <option value="">All</option>
                <option value="income">Income</option>
                <option value="expense">Expense</option>
                <option value="transfer">↔ Transfer</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 font-semibold mb-1 uppercase">From</label>
              <input type="date" value={filterFrom} onChange={e => setFilterFrom(e.target.value)} className={inputCls+' w-auto'}/>
            </div>
            <div>
              <label className="block text-xs text-gray-500 font-semibold mb-1 uppercase">To</label>
              <input type="date" value={filterTo} onChange={e => setFilterTo(e.target.value)} className={inputCls+' w-auto'}/>
            </div>
            {/* Quick monthly filters — default shows only current month; click Show All to see full history */}
            <Btn sm variant="outline" onClick={() => {
              const t = new Date();
              setFilterFrom(new Date(t.getFullYear(), t.getMonth(), 1).toISOString().slice(0,10));
              setFilterTo('');
            }}>📅 This Month</Btn>
            <Btn sm variant="outline" onClick={() => {
              const t = new Date();
              const lastMonth = new Date(t.getFullYear(), t.getMonth() - 1, 1);
              const lastDay   = new Date(t.getFullYear(), t.getMonth(), 0);
              setFilterFrom(lastMonth.toISOString().slice(0,10));
              setFilterTo(lastDay.toISOString().slice(0,10));
            }}>📅 Last Month</Btn>
            <Btn sm variant="outline" onClick={() => { setFilterFrom(''); setFilterTo(''); }}>📚 Show All</Btn>
            {(filterAcct||filterType) && (
              <Btn sm variant="outline" onClick={() => { setFilterAcct(''); setFilterType(''); }}>✕ Clear Filters</Btn>
            )}
            {filteredWithRunning.length > 0 && (
              <div className="ml-auto text-xs text-gray-400 self-center">
                <span className="text-emerald-600 font-semibold">In: Rs. {filteredWithRunning.filter(e=>e.type==='income').reduce((s,e)=>s+Number(e.amount),0).toLocaleString()}</span>
                {' · '}
                <span className="text-red-500 font-semibold">Out: Rs. {filteredWithRunning.filter(e=>e.type==='expense').reduce((s,e)=>s+Number(e.amount),0).toLocaleString()}</span>
              </div>
            )}
          </div>

          {dayGroups.length === 0
            ? <Empty icon="📒" text="No entries yet. Transactions from fee collection and expenses appear here automatically."/>
            : <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b sticky top-0">
                    <tr className="text-left text-xs text-gray-500 font-semibold uppercase">
                      <th className="px-4 py-3 w-10">Sr.</th>
                      <th className="px-4 py-3 w-28">Date</th>
                      <th className="px-4 py-3 w-24">Type</th>
                      <th className="px-4 py-3">Description</th>
                      <th className="px-4 py-3 hidden lg:table-cell">Account</th>
                      <th className="px-4 py-3 text-right text-emerald-600 w-28">In</th>
                      <th className="px-4 py-3 text-right text-red-500 w-28">Out</th>
                      <th className="px-4 py-3 text-right text-blue-600 w-32">Balance</th>
                      <th className="px-4 py-3 text-right w-20">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dayGroups.map(({ date, entries: de, openingBal, totalIn, totalOut, closingBal }) => {
                      const dateLabel = new Date(date).toLocaleDateString('en-PK', { weekday:'short', month:'short', day:'numeric', year:'numeric' });
                      return (
                        <React.Fragment key={date}>
                          {/* Day header */}
                          <tr className="bg-blue-50 border-t-2 border-blue-200">
                            <td colSpan="9" className="px-4 py-2 font-bold text-blue-800 text-xs tracking-wide uppercase">
                              📅 {dateLabel}
                            </td>
                          </tr>
                          {/* Opening balance row */}
                          <tr className="bg-gray-50 border-b border-gray-100">
                            <td className="px-4 py-1.5 text-xs text-gray-400 italic"></td>
                            <td className="px-4 py-1.5 text-xs text-gray-400 italic">Opening</td>
                            <td colSpan="5" className="px-4 py-1.5 text-xs text-gray-400 italic">Balance brought forward</td>
                            <td className={`px-4 py-1.5 text-right text-xs font-bold italic ${openingBal>=0?'text-blue-600':'text-red-500'}`}>{fmtBal(openingBal)}</td>
                            <td></td>
                          </tr>
                          {/* Entries */}
                          {de.map((e, ei) => {
                            const an = accounts.find(a => a.id === e.accountId)?.name || e.accountName || '';
                            return (
                              <tr key={e.id} className={`hover:bg-slate-50 border-b border-gray-50 ${e.refType==='transfer'?'bg-purple-50/40':e.type==='expense'?'bg-red-50/30':''}`}>
                                <td className="px-4 py-2.5 text-xs font-bold text-gray-400">{String(ei+1).padStart(2,'0')}</td>
                                <td className="px-4 py-2.5 text-xs text-gray-400">{new Date(e.date).toLocaleDateString('en-PK',{day:'2-digit',month:'short'})}</td>
                                <td className="px-4 py-2.5">
                                  {e.refType==='transfer'
                                    ? <Badge color="purple">↔ Transfer</Badge>
                                    : <Badge color={e.type==='income'?'green':'red'}>{e.type==='income'?'↑ In':'↓ Out'}</Badge>}
                                </td>
                                <td className="px-4 py-2.5">
                                  {/* LIVE description — auto-reflects student name changes from K.STU.
                                      Uses shared cbStuList + cbPayMatchMap for efficient retro-matching. */}
                                  <div className="font-semibold text-gray-800">{resolveCashBookDesc(e, cbStuList, cbPayMatchMap)}</div>
                                  {e.note && <div className="text-xs text-gray-400">{e.note.replace(/\s*\[stuId=[^\]]+\]/g,'').trim() || ''}</div>}
                                  {/* v75-8: who created this entry — clear audit responsibility */}
                                  {e.createdByName && <div className="text-[10px] text-blue-600 font-semibold mt-0.5">👤 {e.createdByName}</div>}
                                </td>
                                <td className="px-4 py-2.5 hidden lg:table-cell text-xs text-gray-400">{an}</td>
                                <td className="px-4 py-2.5 text-right font-semibold text-emerald-700">{e.type==='income'?`Rs. ${Number(e.amount).toLocaleString()}`:''}</td>
                                <td className="px-4 py-2.5 text-right font-semibold text-red-600">{e.type==='expense'?`Rs. ${Number(e.amount).toLocaleString()}`:''}</td>
                                <td className={`px-4 py-2.5 text-right font-bold ${e.acctBalance>=0?'text-blue-700':'text-red-600'}`}>{fmtBal(e.acctBalance)}</td>
                                <td className="px-4 py-2.5 text-right">
                                  {/* v75-8: Edit/Delete only for strict admin. Principal/accountant/staff see entries but cannot modify. */}
                                  {isAdmin ? (
                                    <div className="flex gap-1 justify-end">
                                      <button onClick={()=>window.requireMasterCode(()=>setCbEdit({...e}),`Edit: ${e.description}`)}
                                        className="p-1.5 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-600 text-xs font-bold border border-amber-200" title="Edit">✏️</button>
                                      <button onClick={()=>window.requireMasterCode(()=>{
                                        // ── BIDIRECTIONAL CASCADE — Cash Book ↔ K.PAY single-source enforcement ──
                                        // When deleting a Cash Book fee entry, ALSO delete the matching K.PAY
                                        // record. Without this, deleting a CB row leaves a ghost K.PAY entry that
                                        // keeps the Fee Collection "Collected" card inflated even after the
                                        // student is gone. Engine reads K.PAY directly (no join to K.STU) so an
                                        // orphan K.PAY for a deleted student still gets summed otherwise.
                                        const isFeeEntry = e.refType === 'fee' && e.type === 'income';
                                        const stuIdMatch = (e.note||'').match(/\[stuId=([^\]]+)\]/);
                                        const linkedStuId = stuIdMatch ? stuIdMatch[1] : null;
                                        const cbAmount    = Number(e.amount||0);
                                        const cbDate      = String(e.date||'').slice(0,10);
                                        // Find the matching K.PAY record: stuId + date + total(amount+AF+books) match.
                                        // Falls back to amount-only match when no stuId tag (very old entries).
                                        const allPays = S.get(K.PAY, []);
                                        let matchedPay = null;
                                        if (isFeeEntry) {
                                          matchedPay = allPays.find(p => {
                                            const pTotal = Number(p.amount||0)+Number(p.annualFund||0)+Number(p.booksPaid||0);
                                            const pDate  = String(p.date||'').slice(0,10);
                                            if (linkedStuId && p.stuId !== linkedStuId) return false;
                                            if (pDate !== cbDate) return false;
                                            return Math.abs(pTotal - cbAmount) < 0.01;
                                          });
                                        }
                                        const confirmMsg = matchedPay
                                          ? `Delete this Cash Book entry?\n\n⚠️ Linked Fee Payment will also be removed:\n  • Receipt: ${matchedPay.rcpt||'—'}\n  • Amount: Rs. ${(Number(matchedPay.amount)+Number(matchedPay.annualFund||0)+Number(matchedPay.booksPaid||0)).toLocaleString()}\n  • Student ID: ${matchedPay.stuId}\n\nBoth records will be deleted in sync. Continue?`
                                          : 'Delete this entry?';
                                        if(!window.confirm(confirmMsg)) return;
                                        // 1) Remove Cash Book entry
                                        const upd=entries.filter(x=>x.id!==e.id);
                                        S.set(K.CBOOK,upd);
                                        // 2) Cascade-remove K.PAY record (if linked)
                                        if (matchedPay) {
                                          S.set(K.PAY, allPays.filter(p => p.id !== matchedPay.id));
                                          const sess = getSession() || {};
                                          logAudit(sess.username || 'admin', sess.name || 'Admin', 'DELETE_CASCADE', 'Fee Payment',
                                            { source: 'CashBook', cbId: e.id, payId: matchedPay.id, amount: cbAmount, stuId: matchedPay.stuId, rcpt: matchedPay.rcpt },
                                            { reason: 'CashBook entry deletion cascaded to K.PAY to keep Collected card in sync' });
                                        }
                                        refreshEntries();
                                        if (window._smsRefresh) window._smsRefresh();
                                      },`Delete: ${e.description}`)}
                                        className="p-1.5 rounded-lg bg-red-50 hover:bg-red-100 text-red-500 text-xs font-bold border border-red-200" title="Delete">🗑️</button>
                                    </div>
                                  ) : (
                                    <span className="text-[10px] text-gray-300">view only</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                          {/* Daily summary row */}
                          <tr className="bg-amber-50 border-t border-amber-200">
                            <td colSpan="5" className="px-4 py-2 text-xs font-bold text-amber-800 text-right">Day Total:</td>
                            <td className="px-4 py-2 text-right text-xs font-bold text-emerald-700">Rs. {totalIn.toLocaleString()}</td>
                            <td className="px-4 py-2 text-right text-xs font-bold text-red-600">Rs. {totalOut.toLocaleString()}</td>
                            <td className={`px-4 py-2 text-right text-sm font-extrabold ${closingBal>=0?'text-blue-800':'text-red-700'}`}>{fmtBal(closingBal)}</td>
                            <td></td>
                          </tr>
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                  <tfoot className="bg-gray-100 border-t-2 border-gray-300">
                    <tr>
                      <td colSpan="5" className="px-4 py-3 text-sm font-bold text-gray-700 text-right">Grand Total:</td>
                      <td className="px-4 py-3 text-right font-extrabold text-emerald-700">Rs. {filteredWithRunning.filter(e=>e.type==='income').reduce((s,e)=>s+Number(e.amount),0).toLocaleString()}</td>
                      <td className="px-4 py-3 text-right font-extrabold text-red-600">Rs. {filteredWithRunning.filter(e=>e.type==='expense').reduce((s,e)=>s+Number(e.amount),0).toLocaleString()}</td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
          }
        </Card>
      )}

      {tab === 'accounts' && (
        <div>
          <div className="flex justify-between items-center mb-4">
            <h3 className="font-bold text-gray-700">Manage Accounts</h3>
            {isAdmin && <Btn sm onClick={() => { setAcctMod('new'); setAf({ name:'', type:'cash', number:'', openingBalance:'' }); }}>+ Add Account</Btn>}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {accounts.map(a => {
              const b = balances[a.id] || 0;
              const ob = Number(a.openingBalance || 0);
              const txCount = entries.filter(e => e.accountId === a.id).length;
              return (
                <Card key={a.id} className="p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="text-2xl">{acctIcon(a.type)}</div>
                      <div>
                        <div className="font-bold text-gray-800">{a.name}</div>
                        <div className="text-xs text-gray-400 capitalize">{a.type}{a.number?` · #${a.number}`:''}</div>
                        <div className="text-xs text-gray-400">{txCount} transactions</div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className={`font-extrabold text-base ${b>=0?'text-blue-700':'text-red-600'}`}>{fmtBal(b)}</div>
                      <div className="text-xs text-gray-400">Current Balance</div>
                      {ob > 0 && <div className="text-xs text-gray-400">Opening: Rs. {ob.toLocaleString()}</div>}
                    </div>
                  </div>
                  {isAdmin && (
                    <div className="flex gap-2 mt-3 pt-3 border-t border-gray-100">
                      <Btn sm variant="outline" onClick={() => { setAcctMod(a); setAf({ name:a.name, type:a.type, number:a.number||'', openingBalance: String(a.openingBalance||'') }); }}>Edit</Btn>
                      <Btn sm variant="red" onClick={() => deleteAccount(a.id)}>Delete</Btn>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {/* Account Modal */}
      {acctMod && (
        <Modal title={acctMod==='new'?'Add Account':'Edit Account'} onClose={() => setAcctMod(null)}>
          <Inp label="Account Name *" value={af.name} onChange={e => setAf({...af, name: e.target.value})} placeholder="e.g. HBL Current Account"/>
          <Sel label="Account Type" value={af.type} onChange={e => setAf({...af, type: e.target.value})}
            options={[{v:'cash',l:'💵 Cash'},{v:'bank',l:'🏦 Bank'},{v:'wallet',l:'📱 Mobile Wallet'}]}/>
          <Inp label="Account / Phone Number (optional)" value={af.number} onChange={e => setAf({...af, number: e.target.value})} placeholder="IBAN or phone number"/>
          <Inp label="Opening Balance (Rs.)" type="number" min="0" value={af.openingBalance} onChange={e => setAf({...af, openingBalance: e.target.value})} placeholder="0"/>
          <div className="flex gap-2 mt-5">
            <Btn full onClick={saveAccount}>{acctMod==='new'?'Add Account':'Update Account'}</Btn>
            <Btn variant="outline" onClick={() => setAcctMod(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {/* Internal Transfer Modal */}
      {transferMod && (
        <Modal title="↔ Internal Transfer" onClose={() => setTransferMod(false)}>
          <div className="bg-purple-50 border border-purple-200 rounded-xl p-3 mb-4 text-sm text-purple-700">
            Move funds between accounts. Two Cash Book entries will be created automatically — one debit (Out) and one credit (In).
          </div>
          <Inp label="Date *" type="date" value={tf.date} onChange={e => setTf({...tf, date: e.target.value})}/>
          <Field label="From Account (Money goes OUT) *">
            <select value={tf.fromId} onChange={e => setTf({...tf, fromId: e.target.value})} className={inputCls}>
              <option value="">— Select Source Account —</option>
              {accounts.map(a => {
                const b = balances[a.id] || 0;
                return <option key={a.id} value={a.id}>{acctIcon(a.type)} {a.name} (Balance: Rs. {b.toLocaleString()})</option>;
              })}
            </select>
          </Field>
          {tf.fromId && (
            <div className={`text-xs font-semibold px-3 py-2 rounded-lg mb-2 ${(balances[tf.fromId]||0)>=0?'bg-emerald-50 text-emerald-700':'bg-red-50 text-red-600'}`}>
              Source Balance: {fmtBal(balances[tf.fromId]||0)}
              {tf.amount && Number(tf.amount) > 0 && (balances[tf.fromId]||0) < Number(tf.amount) && (
                <span className="ml-2 text-red-600 font-bold">⚠️ Insufficient!</span>
              )}
            </div>
          )}
          <Field label="To Account (Money goes IN) *">
            <select value={tf.toId} onChange={e => setTf({...tf, toId: e.target.value})} className={inputCls}>
              <option value="">— Select Destination Account —</option>
              {accounts.filter(a => a.id !== tf.fromId).map(a => {
                const b = balances[a.id] || 0;
                return <option key={a.id} value={a.id}>{acctIcon(a.type)} {a.name} (Balance: Rs. {b.toLocaleString()})</option>;
              })}
            </select>
          </Field>
          <Inp label="Amount (Rs.) *" type="number" min="1" value={tf.amount} onChange={e => setTf({...tf, amount: e.target.value})}/>
          <Inp label="Note (optional)" value={tf.note} onChange={e => setTf({...tf, note: e.target.value})} placeholder="e.g. Bank withdrawal for petty cash"/>
          {tf.fromId && tf.toId && tf.amount && Number(tf.amount) > 0 && (
            <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 mb-3 text-xs text-gray-600 space-y-1">
              <p className="font-bold text-gray-700 mb-1">Preview:</p>
              <p>↓ Out: <b className="text-red-600">Rs. {Number(tf.amount).toLocaleString()}</b> from <b>{accounts.find(a=>a.id===tf.fromId)?.name}</b></p>
              <p>↑ In: <b className="text-emerald-600">Rs. {Number(tf.amount).toLocaleString()}</b> to <b>{accounts.find(a=>a.id===tf.toId)?.name}</b></p>
            </div>
          )}
          <div className="flex gap-2 mt-5">
            <Btn full variant="outline" onClick={saveTransfer} style={{borderColor:'#7c3aed',color:'#7c3aed'}}>↔ Execute Transfer</Btn>
            <Btn variant="outline" onClick={() => setTransferMod(false)}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {/* Manual Entry Modal */}
      {entryMod && (
        <Modal title="Add Cash Book Entry" onClose={() => setEntryMod(false)}>
          <Field label="Type *">
            <div className="flex gap-3">
              {['income','expense'].map(t => (
                <label key={t} className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-xl border-2 cursor-pointer text-sm font-semibold transition-all ${ef.type===t?(t==='income'?'border-emerald-500 bg-emerald-50 text-emerald-700':'border-red-500 bg-red-50 text-red-700'):'border-gray-200 text-gray-500 hover:border-gray-300'}`}>
                  <input type="radio" name="cbType" value={t} checked={ef.type===t} onChange={()=>setEf({...ef,type:t})} className="hidden"/>
                  {t==='income'?'↑ Income':'↓ Expense'}
                </label>
              ))}
            </div>
          </Field>
          <Inp label="Date *" type="date" value={ef.date} onChange={e => setEf({...ef, date: e.target.value})}/>
          <Inp label="Description *" value={ef.description} onChange={e => setEf({...ef, description: e.target.value})} placeholder="e.g. Fee collection, Office expense"/>
          <Inp label="Amount (Rs.) *" type="number" min="1" value={ef.amount} onChange={e => setEf({...ef, amount: e.target.value})}/>
          <Sel label="Account *" value={ef.accountId} onChange={e => setEf({...ef, accountId: e.target.value})}
            options={[{v:'',l:'— Select Account —'},...accounts.map(a => ({ v:a.id, l:`${acctIcon(a.type)} ${a.name}` }))]}/>
          {ef.accountId && (
            <div className={`text-xs font-semibold px-3 py-2 rounded-lg mb-2 ${selectedAcctBal>=0?'bg-emerald-50 text-emerald-700':'bg-red-50 text-red-700'}`}>
              Account Balance: {fmtBal(selectedAcctBal)}
              {balanceWarn && ef.type==='expense' && Number(ef.amount)>0 && selectedAcctBal < Number(ef.amount) && (
                <span className="ml-2 text-red-600 font-bold">⚠️ Insufficient!</span>
              )}
            </div>
          )}
          <Inp label="Note (optional)" value={ef.note} onChange={e => setEf({...ef, note: e.target.value})} placeholder="Additional details"/>
          <div className="flex gap-2 mt-5">
            <Btn full variant={ef.type==='income'?'green':'red'} onClick={saveEntry}>Save Entry</Btn>
            <Btn variant="outline" onClick={() => setEntryMod(false)}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {/* Edit Cash Book Entry Modal */}
      {cbEdit && (
        <Modal title={`Edit Entry`} onClose={() => setCbEdit(null)}>
          <Field label="Date *">
            <input type="date" value={cbEdit.date?.slice(0,10)||''} onChange={e=>setCbEdit({...cbEdit,date:e.target.value})} className={inputCls}/>
          </Field>
          <Field label="Type *">
            <div className="flex gap-3">
              {['income','expense'].map(t=>(
                <label key={t} className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-xl border-2 cursor-pointer text-sm font-semibold transition-all ${cbEdit.type===t?(t==='income'?'border-emerald-500 bg-emerald-50 text-emerald-700':'border-red-500 bg-red-50 text-red-700'):'border-gray-200 text-gray-500 hover:border-gray-300'}`}>
                  <input type="radio" name="cbEditType" value={t} checked={cbEdit.type===t} onChange={()=>setCbEdit({...cbEdit,type:t})} className="hidden"/>
                  {t==='income'?'↑ Income':'↓ Expense'}
                </label>
              ))}
            </div>
          </Field>
          <Inp label="Description *" value={cbEdit.description||''} onChange={e=>setCbEdit({...cbEdit,description:e.target.value})} placeholder="Description"/>
          <Inp label="Amount (Rs.) *" type="number" min="0" value={cbEdit.amount||''} onChange={e=>setCbEdit({...cbEdit,amount:e.target.value})} placeholder="Amount"/>
          <Field label="Account">
            <select value={cbEdit.accountId||''} onChange={e=>setCbEdit({...cbEdit,accountId:e.target.value})} className={inputCls}>
              <option value="">— Select Account —</option>
              {accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          <Inp label="Note (optional)" value={cbEdit.note||''} onChange={e=>setCbEdit({...cbEdit,note:e.target.value})} placeholder="Additional details"/>
          <div className="flex gap-2 mt-5">
            <Btn full variant={cbEdit.type==='income'?'green':'red'} onClick={()=>{
              if (!cbEdit.description?.trim() || !cbEdit.amount) return alert('Description and amount required.');
              const upd = entries.map(x => x.id===cbEdit.id ? {...x, ...cbEdit, amount: Number(cbEdit.amount)} : x);
              S.set(K.CBOOK, upd); refreshEntries(); setCbEdit(null);
            }}>💾 Save Changes</Btn>
            <Btn variant="outline" onClick={()=>setCbEdit(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── APP SHELL ────────────────────────────────────────────────────────────────
// ── SECURITY DASHBOARD ───────────────────────────────────────────────────────
function SecuritySettings() {
  const { staffCanModify, setStaffCanModify } = React.useContext(PermContext);
  const [audit, setAudit] = useState(() => S.get(K.AUDIT, []));
  const [pinForm, setPinForm] = useState({ cur: '', newp: '', conf: '' });
  const [pinMod, setPinMod]   = useState(false);
  const [adminPin, setAdminPin] = useState(() => S.get(K.PERM, { staffCanModify: false, adminPin: '5555' }).adminPin || '5555');

  // Master Code state
  const [mcForm, setMcForm] = useState({ cur:'', newp:'', conf:'' });
  const [mcMod,  setMcMod]  = useState(false);
  const [masterCode, setMasterCode] = useState(() => S.get(K.PERM, {}).masterCode || '1234');

  // ── Recovery panel state — snapshots saved by reconcileWithCloud before overwrite ──
  const [recoverTick, setRecoverTick] = useState(0);
  const recoveryBackups = (() => { try { return JSON.parse(localStorage.getItem('sms_backups') || '{}'); } catch(e) { return {}; } })();
  const [expandedRecoverKey, setExpandedRecoverKey] = useState('');
  const KEY_LABELS = { sms_stu:'Students', sms_pay:'Fee Payments', sms_staff:'Staff', sms_spay:'Salary Payments', sms_vpay:'Vendor Payments', sms_exp:'Expenses', sms_inv:'Inventory', sms_tx:'Stock Transactions', sms_audit:'Audit Logs', sms_notif:'Notifications', sms_preq:'Payroll Requests', sms_comp:'Complaints', sms_asset:'Assets', sms_vend:'Vendors', sms_sbook:'Session Books', sms_cbook:'Cash Book', sms_bl:'Bus List', sms_cf:'Class Fees', sms_af:'Annual Fund', sms_rs:'Results / Marks', sms_st:'Subject Totals', sms_sl:'Custom Subject Lists', sms_ds:'Date Sheets', sms_users:'Users', sms_perm:'Permissions', sms_acct:'Accounts' };
  const restoreRecoveryBackup = (key, snapTs) => {
    if (!window.confirm('Restore this backup? Your CURRENT data for "' + (KEY_LABELS[key]||key) + '" will be backed up first and replaced by the snapshot from ' + new Date(snapTs).toLocaleString('en-PK') + '.')) return;
    try {
      const all = JSON.parse(localStorage.getItem('sms_backups') || '{}');
      const arr = all[key] || [];
      const snap = arr.find(b => b.ts === snapTs);
      if (!snap) return alert('Backup not found.');
      const currentRaw = localStorage.getItem(key);
      try { if (typeof backupLocalBeforeOverwrite === 'function') backupLocalBeforeOverwrite(key, currentRaw ? JSON.parse(currentRaw) : null); } catch(e) {}
      S.set(key, snap.data);
      alert('✅ Restored. Refresh the page to see changes in all tabs.');
      setRecoverTick(t => t + 1);
      if (window._smsRefresh) window._smsRefresh();
    } catch(e) { alert('Restore failed: ' + e.message); }
  };
  const clearAllRecoveryBackups = () => {
    if (!window.confirm('Delete ALL saved recovery snapshots? This cannot be undone.')) return;
    localStorage.removeItem('sms_backups');
    setRecoverTick(t => t + 1);
  };

  const savePin = () => {
    if (!pinForm.newp.trim()) return alert('PIN cannot be empty.');
    if (pinForm.newp !== pinForm.conf) return alert('PINs do not match.');
    const perm = S.get(K.PERM, {});
    S.set(K.PERM, { ...perm, adminPin: pinForm.newp });
    setAdminPin(pinForm.newp);
    setPinMod(false); setPinForm({ cur:'', newp:'', conf:'' });
    alert('✅ Admin Override PIN updated.');
  };

  const saveMasterCode = () => {
    const perm = S.get(K.PERM, {});
    const stored = perm.masterCode || '1234';
    if (mcForm.cur !== stored) return alert('❌ Current master code is incorrect.');
    if (!mcForm.newp.trim()) return alert('New master code cannot be empty.');
    if (mcForm.newp !== mcForm.conf) return alert('Codes do not match.');
    S.set(K.PERM, { ...perm, masterCode: mcForm.newp });
    setMasterCode(mcForm.newp);
    setMcMod(false); setMcForm({ cur:'', newp:'', conf:'' });
    alert('✅ Master Code updated successfully.');
  };

  const toggleStaffModify = () => {
    const newVal = !staffCanModify;
    setStaffCanModify(newVal);
    const perm = S.get(K.PERM, {});
    S.set(K.PERM, { ...perm, staffCanModify: newVal });
  };

  const clearAudit = () => {
    if (!window.confirm('Clear all audit logs?')) return;
    S.set(K.AUDIT, []); setAudit([]);
  };

  return (
    <div>
      <h2 className="text-xl font-bold text-gray-800 mb-5">🔒 Security Dashboard</h2>

      {/* Permission Panel */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
        {/* Staff Modification Toggle */}
        <Card className="p-5">
          <p className="font-bold text-gray-800 mb-1">👤 Staff Modification Access</p>
          <p className="text-sm text-gray-500 mb-4">When ON, staff can Edit/Delete records in this session.</p>
          <div className="flex items-center gap-4">
            <button onClick={toggleStaffModify}
              className={`relative w-14 h-7 rounded-full transition-all duration-300 focus:outline-none ${staffCanModify ? 'bg-emerald-500' : 'bg-gray-300'}`}>
              <span className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow-md transition-all duration-300 ${staffCanModify ? 'left-7' : 'left-0.5'}`}/>
            </button>
            <span className={`font-bold text-sm ${staffCanModify ? 'text-emerald-600' : 'text-red-500'}`}>
              {staffCanModify ? '✅ Enabled (Staff can Modify)' : '🔒 Disabled (Admin Only)'}
            </span>
          </div>
          <p className="text-xs text-amber-600 mt-3 font-semibold">⚠️ Setting resets to OFF on page reload.</p>
        </Card>

        {/* Admin Override PIN */}
        <Card className="p-5">
          <p className="font-bold text-gray-800 mb-1">🔑 Admin Override PIN</p>
          <p className="text-sm text-gray-500 mb-4">Staff can request admin authorization for fee payment edits using this PIN.</p>
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-600">Current PIN: <strong className="font-mono">{adminPin ? '••••••' : 'Not Set'}</strong></span>
            <Btn sm variant="outline" onClick={() => setPinMod(true)}>🔑 {adminPin ? 'Change' : 'Set'} PIN</Btn>
          </div>
        </Card>

        {/* Master Code */}
        <Card className="p-5 border-2 border-red-100">
          <div className="flex items-center gap-2 mb-1">
            <p className="font-bold text-gray-800">🔐 Master Code</p>
            <span className="text-xs bg-red-100 text-red-700 font-bold px-2 py-0.5 rounded-full">Critical</span>
          </div>
          <p className="text-sm text-gray-500 mb-4">Required for ALL edit and delete operations system-wide. Default: <strong className="font-mono text-red-600">1234</strong> — change immediately.</p>
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-600">Master Code: <strong className="font-mono text-red-600">{masterCode ? '••••••' : 'Not Set'}</strong></span>
            <Btn sm variant="red" onClick={() => setMcMod(true)}>🔐 Change Master Code</Btn>
          </div>
          <p className="text-xs text-gray-400 mt-3">⚠️ This code is required before any Edit or Delete action in the entire system.</p>
        </Card>
      </div>

      {/* Recover Deleted Data — backups stashed before sync overwrites local */}
      <Card className="p-5 border-2 border-emerald-200 bg-emerald-50 mb-6">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-xl">🛟</span>
            <p className="font-bold text-emerald-800 text-base">Recover Deleted Data</p>
            <span className="text-xs bg-emerald-600 text-white font-bold px-2 py-0.5 rounded-full">SAFE</span>
          </div>
          {Object.keys(recoveryBackups).length > 0 && (
            <Btn sm variant="outline" onClick={clearAllRecoveryBackups}>🗑️ Clear All Snapshots</Btn>
          )}
        </div>
        <p className="text-xs text-emerald-700 mb-3">Each time cloud sync replaces a local module, the previous local copy is auto-saved here (up to 5 per module). Use this as a fail-safe if newer data was unexpectedly overwritten.</p>
        {Object.keys(recoveryBackups).length === 0 ? (
          <p className="text-xs text-emerald-600 italic bg-white/50 rounded-lg px-3 py-2">No snapshots yet — backups are created automatically whenever the sync engine replaces local data.</p>
        ) : (
          <div className="space-y-2">
            {Object.keys(recoveryBackups).map(key => {
              const snaps = recoveryBackups[key] || [];
              const isOpen = expandedRecoverKey === key;
              return (
                <div key={key+recoverTick} className="bg-white rounded-lg border border-emerald-100 overflow-hidden">
                  <button onClick={() => setExpandedRecoverKey(isOpen ? '' : key)} className="w-full px-3 py-2 flex items-center justify-between hover:bg-emerald-50 transition-colors text-left">
                    <span className="text-sm font-semibold text-gray-800">📦 {KEY_LABELS[key] || key}</span>
                    <span className="text-xs text-emerald-700 font-bold">{snaps.length} snapshot{snaps.length!==1?'s':''} {isOpen?'▼':'▶'}</span>
                  </button>
                  {isOpen && (
                    <div className="px-3 py-2 border-t border-emerald-100 space-y-1.5 bg-emerald-50/40">
                      {snaps.map((s, i) => {
                        const itemCount = Array.isArray(s.data) ? s.data.length : (s.data && typeof s.data === 'object' ? Object.keys(s.data).length : 0);
                        return (
                          <div key={s.ts} className="flex items-center justify-between bg-white rounded px-3 py-1.5 text-xs">
                            <div>
                              <div className="font-semibold text-gray-700">{new Date(s.ts).toLocaleString('en-PK')}</div>
                              <div className="text-gray-400">{itemCount > 0 ? itemCount + ' items' : 'empty/object'} {i===0?'· latest':''}</div>
                            </div>
                            <Btn sm variant="outline" onClick={() => restoreRecoveryBackup(key, s.ts)}>↩️ Restore</Btn>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Factory Reset */}
      <Card className="p-5 border-2 border-red-300 bg-red-50 mb-6">
        {/* ── June 2026 Fresh Start Reset — PERMANENT removal of pre-June 2026 transactions ── */}
        <Card className="p-5 border-2 border-orange-300 bg-orange-50 mb-5">
          <div className="flex items-center gap-2 mb-2"><span className="text-xl">🔄</span><p className="font-bold text-orange-700 text-base">Fresh Start — June 2026 Permanent Cleanup</p><span className="text-xs bg-orange-500 text-white font-bold px-2 py-0.5 rounded-full">IRREVERSIBLE</span></div>
          <p className="text-xs font-bold text-emerald-700 mb-1">✅ KEEPS (untouched):</p>
          <ul className="list-disc pl-5 text-xs text-emerald-700 space-y-0.5 mb-2">
            <li>All student records (names, class, roll, family, monthly fee, annual fund)</li>
            <li>All staff records (names, designation)</li>
            <li>All vendor master records (names, contact)</li>
            <li>Fee structure (K.CF)</li>
            <li>Class book lists (K.BL)</li>
          </ul>
          <p className="text-xs font-bold text-red-700 mb-1">🗑️ PERMANENTLY REMOVES (pre-June 2026 only):</p>
          <ul className="list-disc pl-5 text-xs text-red-700 space-y-0.5 mb-4">
            <li>Fee payment records (K.PAY)</li>
            <li>Cash Book / Day Book entries (K.CBOOK)</li>
            <li>Vendor payment records (K.VPAY)</li>
            <li>Salary payment records (K.SPAY)</li>
            <li>Expense records (K.EXP)</li>
            <li>Student opening balances → reset to Rs. 0</li>
            <li>Account opening balances → reset to Rs. 0</li>
          </ul>
          <Btn variant="outline" onClick={() => window.requireMasterCode(() => {
            if (!window.confirm('PERMANENT FRESH START — June 2026:\n\n✅ KEEPS: Student names, staff names, vendor names, fee structure, book lists\n\n🗑️ PERMANENTLY DELETES (pre-June 2026 only):\n• Fee payments\n• Cash Book / Day Book entries\n• Vendor payments\n• Salary payments\n• Expenses\n• All opening balances → Rs. 0\n\nThis CANNOT be undone. Continue?')) return;
            // Use the existing engine constants — same cutoff as everywhere else
            const _Y = ENGINE_CUTOFF_YEAR, _M = ENGINE_CUTOFF_MONTH;
            // K.PAY uses .year + .month fields
            const isPostCutoffPay = (p) => Number(p.year) > _Y || (Number(p.year) === _Y && Number(p.month) >= _M);
            // K.CBOOK / K.VPAY / K.SPAY / K.EXP use ISO .date field
            const isPostCutoffDate = (e) => {
              const d = new Date(e && e.date ? e.date : 0);
              if (isNaN(d)) return false;
              return d.getFullYear() > _Y || (d.getFullYear() === _Y && d.getMonth() >= _M);
            };
            // 1) Student records — keep all, just zero openingBalance (identity data preserved)
            const students = S.get(K.STU, []);
            S.set(K.STU, students.map(s => ({ ...s, openingBalance: '' })));
            // 2) Account records — keep all, just zero openingBalance
            S.set(K.ACCT, S.get(K.ACCT, []).map(a => ({ ...a, openingBalance: 0 })));
            // 3) Permanently filter pre-June transactional records
            S.set(K.PAY,   S.get(K.PAY,   []).filter(isPostCutoffPay));
            S.set(K.CBOOK, S.get(K.CBOOK, []).filter(isPostCutoffDate));
            S.set(K.VPAY,  S.get(K.VPAY,  []).filter(isPostCutoffDate));
            S.set(K.SPAY,  S.get(K.SPAY,  []).filter(isPostCutoffDate));
            S.set(K.EXP,   S.get(K.EXP,   []).filter(isPostCutoffDate));
            alert('✅ Fresh Start complete!\n\nPre-June 2026 transactions have been permanently deleted.\nStudent / staff / vendor names are intact.\n\nPlease refresh the page.');
            if (window._smsRefresh) window._smsRefresh();
          }, 'June 2026 Fresh Start — Permanent Cleanup')}>🔄 Run June 2026 Permanent Cleanup</Btn>
        </Card>

        {/* ── Sweep Orphan Payments (deleted students) ──────────────────────
            Finds K.PAY records whose stuId no longer exists in K.STU (student
            was deleted) and removes them along with their linked Cash Book
            entries. These ghost records inflate the "Collected" card without
            any matching active student. */}
        <Card className="p-4 border-2 border-rose-300 bg-rose-50 mb-5">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xl">👻</span>
            <p className="font-bold text-rose-800 text-base">Sweep Orphan Payments</p>
            <span className="text-xs bg-rose-600 text-white font-bold px-2 py-0.5 rounded-full">CASCADE</span>
          </div>
          <p className="text-xs text-rose-700 mb-2">Finds K.PAY records whose <code>stuId</code> no longer exists in the Students registry (student was deleted but payment record remained). Removes those orphan payments AND their matching Cash Book entries in one pass. Use this if the "Collected" card stays inflated after deleting students.</p>
          <Btn variant="outline" onClick={() => window.requireMasterCode(() => {
            const allStu = S.get(K.STU, []);
            const allPay = S.get(K.PAY, []);
            const allCb  = S.get(K.CBOOK, []);
            const liveIds = new Set(allStu.map(s => s.id));
            const orphans = allPay.filter(p => p.stuId && !liveIds.has(p.stuId));
            if (orphans.length === 0) { alert('✅ No orphan payments found. Every K.PAY record references a live student.'); return; }
            const orphanTotal = orphans.reduce((s,p) => s + Number(p.amount||0) + Number(p.annualFund||0) + Number(p.booksPaid||0), 0);
            const orphanFee   = orphans.reduce((s,p) => s + Number(p.amount||0), 0);
            const orphanAF    = orphans.reduce((s,p) => s + Number(p.annualFund||0), 0);
            const orphanBks   = orphans.reduce((s,p) => s + Number(p.booksPaid||0), 0);
            // Find matching CB entries for cascade delete
            const orphanIds = new Set(orphans.map(p => p.id));
            const cbToDelete = new Set();
            orphans.forEach(pay => {
              const payTotal = Number(pay.amount||0) + Number(pay.annualFund||0) + Number(pay.booksPaid||0);
              const payDate  = String(pay.date||'').slice(0,10);
              const cb = allCb.find(e => {
                if (e.type !== 'income' || e.refType !== 'fee') return false;
                const tag = (e.note||'').match(/\[stuId=([^\]]+)\]/);
                if (tag && tag[1] !== pay.stuId) return false;
                const eDate = String(e.date||'').slice(0,10);
                if (eDate !== payDate) return false;
                return Math.abs(Number(e.amount||0) - payTotal) < 0.01;
              });
              if (cb) cbToDelete.add(cb.id);
            });
            if (!window.confirm(`Orphan Payment Sweep:\n\n• Orphan K.PAY records: ${orphans.length}\n• Total Fee Recovery to drop: Rs. ${orphanFee.toLocaleString()}\n• Total AF to drop: Rs. ${orphanAF.toLocaleString()}\n• Total Books to drop: Rs. ${orphanBks.toLocaleString()}\n• Grand total cleared: Rs. ${orphanTotal.toLocaleString()}\n• Linked Cash Book entries to also remove: ${cbToDelete.size}\n\nThis CANNOT be undone. Continue?`)) return;
            S.set(K.PAY,   allPay.filter(p => !orphanIds.has(p.id)));
            S.set(K.CBOOK, allCb.filter(e => !cbToDelete.has(e.id)));
            const sess = getSession() || {};
            logAudit(sess.username || 'admin', sess.name || 'Admin', 'SWEEP_ORPHANS', 'Payments',
              { orphanCount: orphans.length, cbCount: cbToDelete.size, total: orphanTotal, fee: orphanFee, af: orphanAF, books: orphanBks },
              { stuIdsCleared: [...new Set(orphans.map(p => p.stuId))] });
            alert(`✅ Sweep complete.\n• ${orphans.length} orphan payments removed.\n• ${cbToDelete.size} matching Cash Book entries removed.\n• Rs. ${orphanTotal.toLocaleString()} dropped from the Collected card.\n\nRefresh the page to see updated totals.`);
            if (window._smsRefresh) window._smsRefresh();
          }, 'Sweep orphan payments left by deleted students')}>👻 Sweep Orphan Payments</Btn>
        </Card>

        {/* ── Reclassify Ghost AF / Books → Fee (Cash Preserved) ──────────────
            Per owner directive: AF and Books should ONLY hold money the admin
            explicitly entered into those fields. Money that was accidentally
            routed to AF/Books actually belongs to FEE collection, where the
            engine will then naturally apply any excess over Net Monthly Fee
            against the student's Opening Balance via:
              outstanding = max(0, netFee + ob − paid)
            So we MOVE the AF/Books amounts into `amount` (fee) — not delete them.
            Cash Book totals stay untouched (cash is the same; only its label changes). */}
        <Card className="p-4 border-2 border-purple-300 bg-purple-50 mb-5">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xl">🔄</span>
            <p className="font-bold text-purple-800 text-base">Reclassify Ghost AF / Books → Fee Recovery</p>
            <span className="text-xs bg-purple-600 text-white font-bold px-2 py-0.5 rounded-full">SAFE</span>
          </div>
          <p className="text-xs text-purple-700 mb-2">Transfers any money sitting in <code>annualFund</code> or <code>booksPaid</code> on K.PAY records into the <code>amount</code> (fee) column. Cash is preserved — only the head changes. The engine then applies any excess over Net Monthly Fee to clear Opening Balance automatically. Use when the Recovery card shows AF/Books you never explicitly collected.</p>
          <Btn variant="outline" onClick={() => window.requireMasterCode(() => {
            const pays = S.get(K.PAY, []);
            const ghostAF = pays.reduce((s,p) => s + Number(p.annualFund||0), 0);
            const ghostBk = pays.reduce((s,p) => s + Number(p.booksPaid ||0), 0);
            if (ghostAF === 0 && ghostBk === 0) { alert('✅ No ghost AF/Books to reclassify. All payment heads already match real collections.'); return; }
            const recordsAffected = pays.filter(p => Number(p.annualFund||0) > 0 || Number(p.booksPaid||0) > 0).length;
            if (!window.confirm(`Reclassify AF/Books → Fee:\n\n• Annual Fund money to move into Fee: Rs. ${ghostAF.toLocaleString()}\n• Books money to move into Fee: Rs. ${ghostBk.toLocaleString()}\n• Records affected: ${recordsAffected}\n• Cash Book entries: UNCHANGED (cash total stays the same)\n• Engine will apply excess to clear Opening Balances automatically.\n\nThis cannot be undone. Continue?`)) return;
            // Move AF + Books amounts into the fee `amount` field. Cash total per record stays identical.
            const reclassified = pays.map(p => {
              const af  = Number(p.annualFund || 0);
              const bks = Number(p.booksPaid  || 0);
              if (af === 0 && bks === 0) return p;
              return {
                ...p,
                amount:     Number(p.amount || 0) + af + bks,  // ← fold AF + Books into fee
                annualFund: 0,
                booksPaid:  0,
                note:       (p.note || '') + ` [Reclassified: AF Rs.${af} + Books Rs.${bks} → Fee]`
              };
            });
            S.set(K.PAY, reclassified);
            // Cash Book intentionally NOT modified — the original `addCashBookEntry`
            // wrote totalCashIn = amount + AF + books. After reclassify, amount alone
            // now equals that same totalCashIn, so the CB totals already match.
            const sess = getSession() || {};
            logAudit(sess.username || 'admin', sess.name || 'Admin', 'RECLASSIFY_HEADS', 'Payments',
              { ghostAF, ghostBk, recordsAffected },
              { movedToFee: ghostAF + ghostBk, reason: 'AF/Books with no admin-entered collection moved to Fee head; engine will apply surplus to OB' });
            alert(`✅ Reclassification complete.\n• Rs. ${(ghostAF + ghostBk).toLocaleString()} moved from AF/Books → Fee.\n• ${recordsAffected} payment records updated.\n• Cash Book totals unchanged (same money, correct head).\n• Refresh: Recovery card will show AF Rs. 0 and Books Rs. 0; the surplus over Net Monthly Fee will reduce Opening Balance outstanding automatically.`);
            if (window._smsRefresh) window._smsRefresh();
          }, 'Reclassify ghost AF & Books money back into Fee head')}>🔄 Reclassify AF / Books → Fee</Btn>
        </Card>

        <div className="flex items-center gap-2 mb-2">
          <span className="text-xl">⚠️</span>
          <p className="font-bold text-red-700 text-base">Factory Reset — Clear All Data</p>
          <span className="text-xs bg-red-600 text-white font-bold px-2 py-0.5 rounded-full">DANGER</span>
        </div>
        <p className="text-sm text-red-600 mb-4">This will <strong>permanently delete ALL data</strong> — Students, Fees, Staff, Inventory, Cash Book, Users, Accounts, Audit Logs — and reset the app to factory defaults. <strong>This cannot be undone.</strong></p>
        <Btn variant="red" onClick={() => window.requireMasterCode(() => {
          if (!window.confirm('⚠️ FINAL WARNING: Delete ALL data and reset the app?\n\nThis cannot be undone. Press OK to confirm.')) return;
          if (window._fbDB) { try { window._fbDB.goOffline(); } catch(e) {} }
          localStorage.clear();
          sessionStorage.clear();
          alert('✅ All data cleared. App will now restart.');
          window.location.reload();
        }, 'Factory Reset — Delete ALL Data')}>
          🗑️ Factory Reset (Clear Everything)
        </Btn>
        <p className="text-xs text-red-400 mt-2">Master Code required. All users, records and settings will be wiped. You will need to set up the app again from scratch.</p>
      </Card>

      {/* Audit Trail */}
      <div className="flex items-center justify-between mb-3">
        <p className="font-bold text-gray-800">📋 Audit Trail <span className="text-gray-400 font-normal text-sm">({audit.length} entries)</span></p>
        {audit.length > 0 && <Btn sm variant="red" onClick={clearAudit}>🗑️ Clear Log</Btn>}
      </div>

      {audit.length === 0
        ? <Empty icon="📋" text="No audit entries yet. Edit or delete actions will be logged here."/>
        : <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 border-b">
                  <tr className="text-left text-xs text-gray-500 font-semibold uppercase">
                    <th className="px-3 py-2">Time</th>
                    <th className="px-3 py-2">User / Role</th>
                    <th className="px-3 py-2">Action</th>
                    <th className="px-3 py-2">Module</th>
                    <th className="px-3 py-2">Old Value</th>
                    <th className="px-3 py-2">New Value</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {audit.map(log => (
                    <tr key={log.id} className={`hover:bg-slate-50 ${log.action==='DELETE'?'bg-red-50/40':log.action==='EDIT'?'bg-amber-50/40':log.action==='CREATE'?'bg-green-50/30':''}`}>
                      <td className="px-3 py-2 text-gray-400 whitespace-nowrap">{new Date(log.timestamp).toLocaleString('en-PK')}</td>
                      <td className="px-3 py-2">
                        <div className="font-semibold text-gray-700">{log.username}</div>
                        <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full ${
                          log.role==='admin' ? 'bg-blue-100 text-blue-700' :
                          log.role==='principal' ? 'bg-green-100 text-green-700' :
                          log.role==='accountant' ? 'bg-teal-100 text-teal-700' :
                          log.role==='teacher' ? 'bg-purple-100 text-purple-700' :
                          'bg-gray-100 text-gray-500'
                        }`}>
                          {log.role==='admin' ? '🔐 Admin' : log.role==='principal' ? '🎓 Principal' : log.role==='accountant' ? '🧾 Accountant' : log.role==='teacher' ? '📖 Teacher' : '👤 Staff'}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <Badge color={log.action==='DELETE'?'red':log.action==='EDIT'?'yellow':'green'}>{log.action}</Badge>
                      </td>
                      <td className="px-3 py-2 text-gray-600">{log.module}</td>
                      <td className="px-3 py-2 text-red-500 font-mono max-w-xs truncate">{log.oldVal}</td>
                      <td className="px-3 py-2 text-emerald-600 font-mono max-w-xs truncate">{log.newVal}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
      }

      {/* PIN Change Modal */}
      {pinMod && (
        <Modal title="🔑 Set Admin Override PIN" onClose={() => setPinMod(false)}>
          <Inp label="New PIN *" type="password" value={pinForm.newp} onChange={e => setPinForm({...pinForm, newp: e.target.value})} placeholder="Enter new PIN"/>
          <Inp label="Confirm PIN *" type="password" value={pinForm.conf} onChange={e => setPinForm({...pinForm, conf: e.target.value})} placeholder="Repeat PIN"/>
          <div className="flex gap-2 mt-4">
            <Btn full onClick={savePin}>✅ Save PIN</Btn>
            <Btn variant="outline" onClick={() => setPinMod(false)}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {/* Master Code Change Modal */}
      {mcMod && (
        <Modal title="🔐 Change Master Code" onClose={() => setMcMod(false)}>
          <div className="bg-red-50 border border-red-200 rounded-xl p-3 mb-4 text-sm text-red-700">
            ⚠️ The Master Code protects all Edit & Delete operations system-wide.
          </div>
          <Inp label="Current Master Code *" type="password" value={mcForm.cur} onChange={e => setMcForm({...mcForm, cur: e.target.value})} placeholder="Enter current code"/>
          <Inp label="New Master Code *" type="password" value={mcForm.newp} onChange={e => setMcForm({...mcForm, newp: e.target.value})} placeholder="Enter new code"/>
          <Inp label="Confirm New Code *" type="password" value={mcForm.conf} onChange={e => setMcForm({...mcForm, conf: e.target.value})} placeholder="Repeat new code"/>
          <div className="flex gap-2 mt-4">
            <Btn full variant="red" onClick={saveMasterCode}>🔐 Update Master Code</Btn>
            <Btn variant="outline" onClick={() => setMcMod(false)}>Cancel</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── ASSETS & PROFIT/LOSS ─────────────────────────────────────────────────────
function Assets() {
  // Default categories — always present. Users can add more via the
  // "+ Add Category" button. Custom categories are persisted in K.ACATS
  // (an additive new key — no rules change, no legacy schema touched).
  const DEFAULT_CATS = ['Furniture','Electronics','Vehicles','Building','Equipment','Other'];
  const [customCats, setCustomCats] = useState(() => {
    try { const c = S.get(K.ACATS, []); return Array.isArray(c) ? c : []; } catch(e) { return []; }
  });
  // Merged list — default + custom (dedup, preserve order).
  const CATS = (() => {
    const seen = new Set();
    const out  = [];
    [...DEFAULT_CATS, ...customCats].forEach(c => {
      const v = String(c || '').trim();
      if (v && !seen.has(v.toLowerCase())) { seen.add(v.toLowerCase()); out.push(v); }
    });
    return out;
  })();
  const addCategory = () => {
    const name = (window.prompt('Add new asset category:') || '').trim();
    if (!name) return;
    if (CATS.some(c => c.toLowerCase() === name.toLowerCase())) {
      return alert('That category already exists.');
    }
    const next = [...customCats, name];
    S.set(K.ACATS, next);
    setCustomCats(next);
  };
  const removeCustomCat = (name) => {
    if (!window.confirm(`Remove category "${name}"? Existing assets in this category will keep their label.`)) return;
    const next = customCats.filter(c => c !== name);
    S.set(K.ACATS, next);
    setCustomCats(next);
    if (filterCat === name) setFilterCat('All');
    if (form.category === name) setForm({ ...form, category: DEFAULT_CATS[0] });
  };
  // Integrity guard at mount
  const [assets, setAssets]   = useState(() => getActiveList(K.ASSET));
  const [form, setForm]       = useState({ name:'', category:'Furniture', purchaseDate:'', purchaseValue:'', currentValue:'', quantity:'1', notes:'' });
  const [editId, setEditId]   = useState(null);
  const [filterCat, setFilterCat] = useState('All');
  const [tab, setTab]         = useState('assets');
  const [plYear, setPlYear]   = useState(NOW.getFullYear());
  const [plPeriod, setPlPeriod] = useState('annual');
  const [plMonth, setPlMonth] = useState(NOW.getMonth());
  const persist = a => { S.set(K.ASSET, a); setAssets(a); };
  const resetForm = () => { setForm({ name:'', category:'Furniture', purchaseDate:'', purchaseValue:'', currentValue:'', quantity:'1', notes:'' }); setEditId(null); };
  // Backward-safe quantity reader — older assets stored without this field default to 1.
  const getQty = a => Math.max(1, parseInt(a && a.quantity, 10) || 1);
  const save = () => {
    if (!form.name.trim() || !form.purchaseValue) return alert('Name and Purchase Value required.');
    // Normalize quantity into an integer >= 1 before persisting.
    const qty = Math.max(1, parseInt(form.quantity, 10) || 1);
    const payload = { ...form, quantity: qty };
    if (editId) { persist(assets.map(a => a.id===editId ? {...a,...payload} : a)); }
    // v75-8: stamp creator on new asset
    else { persist([...assets, Object.assign({...payload, id:uid(), addedAt:Date.now()}, getCreator())]); }
    resetForm();
  };
  const startEdit = a => { setForm({ name:a.name, category:a.category, purchaseDate:a.purchaseDate||'', purchaseValue:a.purchaseValue, currentValue:a.currentValue||'', quantity:String(getQty(a)), notes:a.notes||'' }); setEditId(a.id); };
  const del = id => { if (!window.confirm('Delete this asset?')) return; persist(assets.filter(a=>a.id!==id)); };
  const filtered = filterCat==='All' ? assets : assets.filter(a=>a.category===filterCat);
  // ── Quantity-aware totals: Purchase Value is treated as Unit Price.
  //   Total = Σ (purchaseValue × quantity). Backward-compat: old records lacking
  //   `quantity` default to 1 via getQty(), so historical numbers stay identical.
  const totalPurchase = assets.reduce((s,a)=>s+Number(a.purchaseValue||0) * getQty(a), 0);
  const totalCurrent  = assets.reduce((s,a)=>s+Number(a.currentValue||a.purchaseValue||0) * getQty(a), 0);
  const totalDeprec   = totalPurchase - totalCurrent;
  // ── Print Assets Register ── visible (filtered) rows + grand totals ──
  const printAssets = () => {
    const list = filterCat==='All' ? assets : assets.filter(a => a.category === filterCat);
    if (list.length === 0) { alert('No assets to print.'); return; }
    let totPv = 0, totCv = 0;
    const rows = list.map((a,i) => {
      const qty  = getQty(a);
      const uPv  = Number(a.purchaseValue || 0);
      const uCv  = Number(a.currentValue || a.purchaseValue || 0);
      const pv   = uPv * qty;
      const cv   = uCv * qty;
      const dep  = pv - cv;
      totPv += pv; totCv += cv;
      return `<tr>
        <td>${i+1}</td>
        <td><b>${a.name || '—'}</b>${a.notes ? `<div style="font-size:9px;color:#9ca3af">${a.notes}</div>` : ''}</td>
        <td><span class="badge b-blue">${a.category || '—'}</span></td>
        <td class="r">${qty}</td>
        <td class="r">Rs. ${uPv.toLocaleString()}</td>
        <td class="r">Rs. ${uCv.toLocaleString()}</td>
        <td class="r"><b>Rs. ${pv.toLocaleString()}</b></td>
        <td class="r"><b>Rs. ${cv.toLocaleString()}</b></td>
        <td class="r" style="color:${dep>0?'#dc2626':dep<0?'#059669':'#6b7280'}">${dep===0?'—':(dep>0?'- ':'+ ')+'Rs. '+Math.abs(dep).toLocaleString()}</td>
        <td>${a.purchaseDate || '—'}</td>
      </tr>`;
    }).join('');
    const totDep = totPv - totCv;
    const scope  = filterCat==='All' ? 'All Categories' : filterCat;
    printPage('Assets Register — ' + scope, `
      <h2>Assets Register</h2>
      <p style="font-size:11px;color:#6b7280;margin:0 0 8px">Scope: <b>${scope}</b> · ${list.length} item${list.length===1?'':'s'} · Generated on ${new Date().toLocaleDateString('en-PK', { year:'numeric', month:'long', day:'numeric' })}</p>
      <div class="summary">
        <div class="sum-card"><div class="val">Rs. ${totPv.toLocaleString()}</div><div class="lbl">Total Purchase</div></div>
        <div class="sum-card"><div class="val" style="color:#059669">Rs. ${totCv.toLocaleString()}</div><div class="lbl">Current Value</div></div>
        <div class="sum-card"><div class="val" style="color:${totDep>0?'#dc2626':'#6b7280'}">Rs. ${Math.abs(totDep).toLocaleString()}</div><div class="lbl">${totDep>0?'Depreciation':totDep<0?'Appreciation':'No Change'}</div></div>
      </div>
      <table>
        <thead><tr>
          <th>#</th>
          <th>Asset Name</th>
          <th>Category</th>
          <th class="r">Qty</th>
          <th class="r">Unit Purchase</th>
          <th class="r">Unit Current</th>
          <th class="r">Total Purchase</th>
          <th class="r">Total Current</th>
          <th class="r">Depreciation</th>
          <th>Purchase Date</th>
        </tr></thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr style="font-weight:700;background:#dbeafe">
            <td colspan="6" style="text-align:right">GRAND TOTAL:</td>
            <td class="r">Rs. ${totPv.toLocaleString()}</td>
            <td class="r">Rs. ${totCv.toLocaleString()}</td>
            <td class="r" style="color:${totDep>0?'#dc2626':'#059669'}">${totDep===0?'—':(totDep>0?'- ':'+ ')+'Rs. '+Math.abs(totDep).toLocaleString()}</td>
            <td></td>
          </tr>
        </tfoot>
      </table>`);
  };
  const cy = NOW.getFullYear();
  const _allPay = getActiveList(K.PAY), _allCb = getActiveList(K.CBOOK);
  const plYears = Array.from(new Set([..._allPay.map(p=>Number(p.year)||cy), ..._allCb.map(e=>new Date(e.date||0).getFullYear()), cy])).sort((a,b)=>b-a);
  const { feeIncome, afIncome, booksIncome, cbIncome, totalIncome, cbExpenses, salaryExp, totalExpenses, netPL,
          ownerCapital, ownerDrawing, ownerEquity, allTimeNetPL } = calcPL({ year:plYear, period:plPeriod, month:plMonth });
  const inputCls = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400';
  const printPL = () => {
    const period = plPeriod==='monthly' ? `${MONTHS[plMonth]} ${plYear}` : `Annual ${plYear}`;
    const rows = [['Fee Income',feeIncome],['Annual Fund',afIncome],['Books Income',booksIncome],['Other Income (Cash Book)',cbIncome]].map(([l,v])=>`<tr><td>${l}</td><td class="r">Rs. ${Number(v).toLocaleString()}</td></tr>`).join('');
    const erows = [['Operating Expenses (Cash Book)',cbExpenses],['Salary Payments',salaryExp]].map(([l,v])=>`<tr><td>${l}</td><td class="r">Rs. ${Number(v).toLocaleString()}</td></tr>`).join('');
    const win = window.open('','_blank','width=680,height=700');
    if (!win) { alert('Popup blocked!'); return; }
    win.document.write(`<!DOCTYPE html><html><head><title>P&L</title><style>*{box-sizing:border-box}body{font-family:'Segoe UI',Arial,sans-serif;padding:28px;max-width:620px;margin:auto;font-size:12px;color:#1a1a1a}.hdr{text-align:center;border-bottom:2px solid #1e3a8a;padding-bottom:10px;margin-bottom:16px}.hdr img{height:60px;object-fit:contain}h1{font-size:17px;color:#1e3a8a;margin:4px 0}.sub{font-size:11px;color:#6b7280}table{width:100%;border-collapse:collapse;margin:10px 0}th{background:#1e3a8a;color:#fff;padding:7px 10px;text-align:left;font-size:10px;text-transform:uppercase}td{padding:6px 10px;border-bottom:1px solid #e5e7eb;font-size:11px}.r{text-align:right}.total-row td{background:#dbeafe;font-weight:700}.net-pos td{background:#dcfce7;color:#15803d;font-weight:800;font-size:13px}.net-neg td{background:#fee2e2;color:#dc2626;font-weight:800;font-size:13px}.dev-footer{text-align:center;margin-top:16px;font-size:8px;color:#9ca3af;border-top:1px solid #e5e7eb;padding-top:8px}@media print{body{padding:12px}}</style></head><body><div class="hdr"><img src="${LOGO_SRC}" alt="DISS" onerror="this.style.display='none'"/><h1>Profit &amp; Loss Statement</h1><p class="sub">Period: ${period}</p></div><table><thead><tr><th colspan="2">INCOME</th></tr></thead><tbody>${rows}<tr class="total-row"><td><b>Total Income</b></td><td class="r"><b>Rs. ${totalIncome.toLocaleString()}</b></td></tr></tbody></table><table><thead><tr><th colspan="2">EXPENSES</th></tr></thead><tbody>${erows}<tr class="total-row"><td><b>Total Expenses</b></td><td class="r"><b>Rs. ${totalExpenses.toLocaleString()}</b></td></tr></tbody></table><table><tbody><tr class="${netPL>=0?'net-pos':'net-neg'}"><td>${netPL>=0?'NET PROFIT':'NET LOSS'}</td><td class="r">Rs. ${Math.abs(netPL).toLocaleString()}</td></tr></tbody></table><div class="dev-footer">© 2026 DISS — All Rights Reserved | Powered by Tataheer Business Group | +923218555566</div><script>window.onload=function(){window.print()}<\/script></body></html>`);
    win.document.close();
  };
  const tabCls = a => `px-4 py-2 rounded-lg text-sm font-semibold transition-all ${a?'bg-blue-700 text-white shadow':'bg-white text-gray-600 border border-gray-200 hover:bg-blue-50'}`;
  return (
    <div>
      <div className="mb-5"><h2 className="text-2xl font-extrabold text-gray-800">🏛️ Assets &amp; P&amp;L</h2><p className="text-sm text-gray-500 mt-0.5">Track school assets and view Profit &amp; Loss reports</p></div>
      <div className="flex gap-2 mb-5">
        <button className={tabCls(tab==='assets')} onClick={()=>setTab('assets')}>🏛️ Assets</button>
        <button className={tabCls(tab==='pl')} onClick={()=>setTab('pl')}>📊 Profit &amp; Loss</button>
      </div>
      {tab==='assets' && (
        <div>
          {/* Top action bar — Print button for Assets tab */}
          <div className="flex justify-end mb-3">
            <Btn onClick={printAssets}>🖨️ Print Assets Register</Btn>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
            {[{label:'Total Assets',value:`Rs. ${totalPurchase.toLocaleString()}`,sub:'Purchase value',icon:'🏛️',color:'blue'},{label:'Current Value',value:`Rs. ${totalCurrent.toLocaleString()}`,sub:'After depreciation',icon:'💎',color:'green'},{label:'Depreciation',value:`Rs. ${totalDeprec.toLocaleString()}`,sub:'Total loss in value',icon:'📉',color:'red'}].map(c=>(
              <div key={c.label} className={`rounded-2xl p-4 border-2 ${c.color==='blue'?'bg-blue-50 border-blue-200':c.color==='green'?'bg-green-50 border-green-200':'bg-red-50 border-red-200'}`}>
                <div className="text-2xl mb-1">{c.icon}</div>
                <div className={`text-xl font-extrabold ${c.color==='blue'?'text-blue-700':c.color==='green'?'text-green-700':'text-red-600'}`}>{c.value}</div>
                <div className="text-xs text-gray-500 mt-0.5">{c.sub} · {assets.length} items</div>
              </div>
            ))}
          </div>
          <Card className="p-4 mb-5">
            <h3 className="font-bold text-gray-700 mb-3">{editId?'✏️ Edit Asset':'➕ Add New Asset'}</h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <div className="col-span-2 sm:col-span-1"><label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Asset Name *</label><input value={form.name} onChange={e=>setForm({...form,name:e.target.value})} placeholder="e.g. Computer Lab PC" className={inputCls}/></div>
              <div><label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Category</label><select value={form.category} onChange={e=>setForm({...form,category:e.target.value})} className={inputCls}>{CATS.map(c=><option key={c}>{c}</option>)}</select></div>
              <div><label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Purchase Date</label><input type="date" value={form.purchaseDate} onChange={e=>setForm({...form,purchaseDate:e.target.value})} className={inputCls}/></div>
              <div><label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Purchase Value (Rs.) *</label><input type="number" min="0" value={form.purchaseValue} onChange={e=>setForm({...form,purchaseValue:e.target.value})} placeholder="0 (unit price)" className={inputCls}/></div>
              <div><label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Quantity *</label><input type="number" min="1" step="1" value={form.quantity} onChange={e=>setForm({...form,quantity:e.target.value})} placeholder="e.g. 10" className={inputCls}/></div>
              <div><label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Current Value (Rs.)</label><input type="number" min="0" value={form.currentValue} onChange={e=>setForm({...form,currentValue:e.target.value})} placeholder="Per-unit, blank = same as purchase" className={inputCls}/></div>
              <div className="col-span-2 sm:col-span-1"><label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Notes</label><input value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})} placeholder="Optional" className={inputCls}/></div>
            </div>
            {/* ── Live preview: see Total Purchase / Current / Depreciation BEFORE adding ── */}
            {(Number(form.purchaseValue) > 0) && (() => {
              const uPv  = Number(form.purchaseValue || 0);
              const uCv  = Number(form.currentValue || form.purchaseValue || 0);
              const qty  = Math.max(1, parseInt(form.quantity, 10) || 1);
              const totalPv = uPv * qty;
              const totalCv = uCv * qty;
              const dep     = totalPv - totalCv;
              const depPct  = totalPv > 0 ? Math.round((dep / totalPv) * 100) : 0;
              return (
                <div className="mt-3 bg-gradient-to-br from-blue-50 to-purple-50 border-2 border-blue-200 rounded-xl p-3">
                  <p className="text-xs font-bold text-blue-700 uppercase tracking-widest mb-2">🔎 Live Preview (before saving)</p>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
                    <div className="bg-white rounded-lg p-2">
                      <p className="text-[10px] text-gray-400 uppercase">Total Purchase</p>
                      <p className="font-extrabold text-blue-700">Rs. {totalPv.toLocaleString()}</p>
                      <p className="text-[10px] text-gray-400">{qty} × Rs. {uPv.toLocaleString()}</p>
                    </div>
                    <div className="bg-white rounded-lg p-2">
                      <p className="text-[10px] text-gray-400 uppercase">Total Current</p>
                      <p className="font-extrabold text-green-700">Rs. {totalCv.toLocaleString()}</p>
                      <p className="text-[10px] text-gray-400">{qty} × Rs. {uCv.toLocaleString()}</p>
                    </div>
                    <div className="bg-white rounded-lg p-2">
                      <p className="text-[10px] text-gray-400 uppercase">Depreciation</p>
                      <p className={`font-extrabold ${dep>0?'text-red-600':dep<0?'text-emerald-600':'text-gray-500'}`}>
                        {dep>0?'- ':dep<0?'+ ':''}Rs. {Math.abs(dep).toLocaleString()}
                      </p>
                      <p className="text-[10px] text-gray-400">{dep>0?'Loss in value':dep<0?'Value appreciated':'No change'}</p>
                    </div>
                    <div className={`rounded-lg p-2 text-center ${dep>0?'bg-red-50':dep<0?'bg-emerald-50':'bg-gray-50'}`}>
                      <p className="text-[10px] text-gray-500 uppercase">Depreciation %</p>
                      <p className={`text-lg font-extrabold ${dep>0?'text-red-600':dep<0?'text-emerald-600':'text-gray-500'}`}>{Math.abs(depPct)}%</p>
                      <p className="text-[10px] text-gray-400">{form.purchaseDate || 'today'}</p>
                    </div>
                  </div>
                  {qty > 1 && (
                    <p className="text-[11px] text-purple-600 mt-2 font-semibold">
                      💡 Unit price entered Rs. {uPv.toLocaleString()} × Qty {qty} = Rs. {totalPv.toLocaleString()} total purchase value
                    </p>
                  )}
                </div>
              );
            })()}
            <div className="flex gap-2 mt-3"><Btn onClick={save}>{editId?'💾 Update':'➕ Add Asset'}</Btn>{editId&&<Btn variant="outline" onClick={resetForm}>Cancel</Btn>}</div>
          </Card>
          <div className="flex gap-2 mb-3 flex-wrap items-center">
            {['All',...CATS].map(c=>{
              const isCustom = c !== 'All' && customCats.indexOf(c) !== -1;
              return (
                <span key={c} className={`inline-flex items-center rounded-lg border transition-all ${filterCat===c?'bg-blue-700 border-blue-700':'bg-white border-gray-200 hover:bg-blue-50'}`}>
                  <button onClick={()=>setFilterCat(c)} className={`px-3 py-1.5 text-xs font-semibold rounded-lg ${filterCat===c?'text-white':'text-gray-600'}`}>{c}</button>
                  {isCustom && (
                    <button onClick={()=>removeCustomCat(c)} title={`Remove "${c}" category`}
                      className={`px-1.5 py-1.5 text-xs ${filterCat===c?'text-white/80 hover:text-white':'text-red-400 hover:text-red-600'}`}>×</button>
                  )}
                </span>
              );
            })}
            <button onClick={addCategory}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-dashed border-purple-400 text-purple-700 bg-purple-50 hover:bg-purple-100 transition-all">
              + Add Category
            </button>
          </div>
          {filtered.length===0 ? <Empty icon="🏛️" text="No assets yet. Add your first asset above."/> : (
            <div className="space-y-2">{filtered.map(a=>{
              // Unit values
              const uPv  = Number(a.purchaseValue||0);
              const uCv  = Number(a.currentValue||a.purchaseValue||0);
              const qty  = getQty(a);
              // Total per asset row (unit × qty)
              const pv   = uPv * qty;
              const cv   = uCv * qty;
              const dep  = pv - cv;
              return (<Card key={a.id} className="p-4 flex flex-col sm:flex-row sm:items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-gray-800">{a.name}</span>
                    <Badge color="blue">{a.category}</Badge>
                    {qty > 1 && <Badge color="purple">Qty: {qty}</Badge>}
                    {a.purchaseDate&&<span className="text-xs text-gray-400">{a.purchaseDate}</span>}
                  </div>
                  {a.notes&&<p className="text-xs text-gray-400 mt-0.5">{a.notes}</p>}
                </div>
                <div className="flex items-center gap-4 text-sm shrink-0">
                  <div className="text-center">
                    <div className="text-xs text-gray-400">Purchase</div>
                    <div className="font-bold text-blue-700">Rs. {pv.toLocaleString()}</div>
                    {qty > 1 && <div className="text-[10px] text-gray-400">{qty} × Rs. {uPv.toLocaleString()}</div>}
                  </div>
                  <div className="text-center">
                    <div className="text-xs text-gray-400">Current</div>
                    <div className="font-bold text-green-700">Rs. {cv.toLocaleString()}</div>
                    {qty > 1 && <div className="text-[10px] text-gray-400">{qty} × Rs. {uCv.toLocaleString()}</div>}
                  </div>
                  {dep>0&&<div className="text-center"><div className="text-xs text-gray-400">Depreciation</div><div className="font-bold text-red-500">- Rs. {dep.toLocaleString()}</div></div>}
                  <div className="flex gap-1"><button onClick={()=>startEdit(a)} className="text-blue-500 hover:text-blue-700 text-lg px-1">✏️</button><button onClick={()=>del(a.id)} className="text-red-400 hover:text-red-600 text-lg px-1">🗑️</button></div>
                </div>
              </Card>);
            })}</div>
          )}
        </div>
      )}
      {tab==='pl' && (
        <div>
          <Card className="p-4 mb-5">
            <div className="flex flex-wrap items-end gap-3">
              <div><label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Period</label><select value={plPeriod} onChange={e=>setPlPeriod(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"><option value="annual">Full Year</option><option value="monthly">Monthly</option></select></div>
              <div><label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Year</label><select value={plYear} onChange={e=>setPlYear(Number(e.target.value))} className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400">{plYears.map(y=><option key={y}>{y}</option>)}</select></div>
              {plPeriod==='monthly'&&<div><label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Month</label><select value={plMonth} onChange={e=>setPlMonth(Number(e.target.value))} className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400">{MONTHS.map((mo,i)=><option key={i} value={i}>{mo}</option>)}</select></div>}
              <Btn onClick={printPL}>🖨️ Print P&amp;L</Btn>
            </div>
          </Card>
          <div className={`rounded-2xl p-5 mb-5 text-center ${netPL>=0?'bg-green-50 border-2 border-green-300':'bg-red-50 border-2 border-red-300'}`}>
            <p className="text-xs font-bold uppercase tracking-widest mb-1 text-gray-500">{netPL>=0?'NET PROFIT':'NET LOSS'}</p>
            <p className={`text-4xl font-extrabold ${netPL>=0?'text-green-700':'text-red-600'}`}>Rs. {Math.abs(netPL).toLocaleString()}</p>
            <p className="text-xs text-gray-500 mt-1">{plPeriod==='monthly'?`${MONTHS[plMonth]} ${plYear}`:`Annual ${plYear}`}</p>
          </div>
          <Card className="p-4 mb-4">
            <h3 className="font-bold text-green-700 mb-3">📈 Income</h3>
            <table className="w-full text-sm"><thead><tr className="border-b-2 border-green-200"><th className="text-left py-2 text-gray-500 font-semibold text-xs uppercase">Source</th><th className="text-right py-2 text-gray-500 font-semibold text-xs uppercase">Amount</th></tr></thead>
            <tbody>{[['📒 Fee Income',feeIncome],['🏦 Annual Fund',afIncome],['📚 Books Income',booksIncome],['💵 Other Income (Cash Book)',cbIncome]].map(([l,v])=>(<tr key={l} className="border-b border-gray-100"><td className="py-2 text-gray-700">{l}</td><td className="py-2 text-right font-semibold text-green-700">Rs. {Number(v).toLocaleString()}</td></tr>))}
            <tr className="bg-green-50 font-bold"><td className="py-2.5 px-2 rounded-l-lg text-green-800">Total Income</td><td className="py-2.5 px-2 rounded-r-lg text-right text-green-800">Rs. {totalIncome.toLocaleString()}</td></tr></tbody></table>
          </Card>
          <Card className="p-4 mb-4">
            <h3 className="font-bold text-red-600 mb-3">📉 Expenses</h3>
            <table className="w-full text-sm"><thead><tr className="border-b-2 border-red-200"><th className="text-left py-2 text-gray-500 font-semibold text-xs uppercase">Category</th><th className="text-right py-2 text-gray-500 font-semibold text-xs uppercase">Amount</th></tr></thead>
            <tbody>{[['🧾 Operating Expenses (Cash Book)',cbExpenses],['👩‍🏫 Salary Payments',salaryExp]].map(([l,v])=>(<tr key={l} className="border-b border-gray-100"><td className="py-2 text-gray-700">{l}</td><td className="py-2 text-right font-semibold text-red-600">Rs. {Number(v).toLocaleString()}</td></tr>))}
            <tr className="bg-red-50 font-bold"><td className="py-2.5 px-2 rounded-l-lg text-red-800">Total Expenses</td><td className="py-2.5 px-2 rounded-r-lg text-right text-red-800">Rs. {totalExpenses.toLocaleString()}</td></tr></tbody></table>
          </Card>
          {assets.length>0&&<Card className="p-4 bg-purple-50 border-2 border-purple-200 mb-4"><h3 className="font-bold text-purple-800 mb-2">🏛️ Asset Book Value</h3><div className="flex gap-6 text-sm"><div><span className="text-gray-500">Total Purchase: </span><b className="text-purple-700">Rs. {totalPurchase.toLocaleString()}</b></div><div><span className="text-gray-500">Current Value: </span><b className="text-green-700">Rs. {totalCurrent.toLocaleString()}</b></div><div><span className="text-gray-500">Depreciation: </span><b className="text-red-600">Rs. {totalDeprec.toLocaleString()}</b></div></div></Card>}

          {/* Owner Equity Section */}
          <Card className={`p-4 border-2 ${ownerEquity>=0?'bg-emerald-50 border-emerald-300':'bg-red-50 border-red-300'}`}>
            <h3 className="font-bold text-gray-800 mb-3">🏦 Owner / Partner Equity (All-Time)</h3>
            <table className="w-full text-sm">
              <tbody>
                <tr className="border-b border-gray-100"><td className="py-2 text-gray-600">💰 Capital Invested (Owner)</td><td className="py-2 text-right font-semibold text-blue-700">Rs. {ownerCapital.toLocaleString()}</td></tr>
                <tr className="border-b border-gray-100"><td className="py-2 text-gray-600">📈 All-Time Net {allTimeNetPL>=0?'Profit':'Loss'}</td><td className={`py-2 text-right font-semibold ${allTimeNetPL>=0?'text-green-700':'text-red-600'}`}>Rs. {Math.abs(allTimeNetPL).toLocaleString()}</td></tr>
                <tr className="border-b border-gray-100"><td className="py-2 text-gray-600">💸 Owner Drawings (Withdrawals)</td><td className="py-2 text-right font-semibold text-orange-600">− Rs. {ownerDrawing.toLocaleString()}</td></tr>
                <tr className={`font-bold text-base ${ownerEquity>=0?'text-emerald-700':'text-red-600'}`}>
                  <td className="py-3">= Net Owner Equity</td>
                  <td className="py-3 text-right">Rs. {Math.abs(ownerEquity).toLocaleString()}</td>
                </tr>
              </tbody>
            </table>
            <p className="text-xs text-gray-400 mt-2">Formula: Capital + All-Time Net Profit − Drawings → from <b>calcPL()</b> via K.CBOOK</p>
          </Card>

          {/* Student Write-offs Breakdown — derived live from K.CBOOK markers, no calcPL change */}
          {(() => {
            const allCb = getActiveList(K.CBOOK);
            const writeOffs = allCb.filter(e =>
              e.type === 'expense' && e.refType === 'owner_drawing' &&
              e.note && e.note.indexOf('Auto write-off') !== -1
            );
            const totalWO  = writeOffs.reduce((s, e) => s + Number(e.amount || 0), 0);
            if (writeOffs.length === 0) return null;
            return (
              <Card className="p-4 mt-4 bg-amber-50 border-2 border-amber-200">
                <h3 className="font-bold text-amber-800 mb-3 flex items-center gap-2">🚪 Student Write-offs (Left School)</h3>
                <p className="text-xs text-gray-500 mb-3">Outstanding balances of students marked as left → auto-booked as Owner Drawing. To undo a write-off, manually delete the corresponding entry from Cash Book.</p>
                <table className="w-full text-sm">
                  <tbody>
                    <tr className="font-bold text-base text-amber-900">
                      <td className="py-3">📤 Total Written Off ({writeOffs.length} {writeOffs.length===1?'entry':'entries'})</td>
                      <td className="py-3 text-right text-red-600">Rs. {totalWO.toLocaleString()}</td>
                    </tr>
                  </tbody>
                </table>
                <p className="text-xs text-gray-400 mt-2">Source: K.CBOOK entries tagged with <code className="bg-white px-1 rounded">Auto write-off</code> in note. Already counted in Owner Drawings above — shown here for transparency.</p>
              </Card>
            );
          })()}
        </div>
      )}
    </div>
  );
}

const NAV_ALL = [
  // Dashboard restricted to admin + principal per owner directive — other
  // roles (staff, accountant, teacher, custom, parent) do not see it and
  // will land on their first allowed module after login.
  { id:'dashboard',     label:'Dashboard',       icon:'🏠',  roles:['admin','principal'] },
  { id:'students',      label:'Students',        icon:'👨‍🎓', roles:['admin','staff','principal'] },
  { id:'feecollect',    label:'Fee Collection',  icon:'💰',  roles:['admin','staff','principal','accountant'] },
  { id:'fees',          label:'Student Ledger',  icon:'📒',  roles:['admin','staff','principal','accountant'] },
  { id:'inventory',     label:'Inventory',       icon:'📦',  roles:['admin','staff','principal'] },
  { id:'expenses',      label:'Expenses',        icon:'🧾',  roles:['admin','staff','principal','accountant'] },
  { id:'family',        label:'Family Ledger',   icon:'👨‍👩‍👧‍👦', roles:['admin','staff','principal','accountant'] },
  { id:'staff',         label:'Staff & Salary',  icon:'👩‍🏫', roles:['admin','staff','principal'] },
  { id:'books',         label:'Books & Vendors', icon:'📚',  roles:['admin','staff','principal'] },
  { id:'exams',         label:'Exams',           icon:'📝',  roles:['admin','staff','principal'] },
  { id:'cashbook',      label:'Cash Book',       icon:'💼',  roles:['admin','principal','accountant'] },
  { id:'assets',        label:'Assets & P&L',   icon:'🏛️',  roles:['admin','principal','accountant'] },
  { id:'statements',    label:'Statements',      icon:'📑',  roles:['admin','principal'] },
  { id:'notifications', label:'Notifications',   icon:'📢',  roles:['admin','principal','teacher'] },
  { id:'users',         label:'User Management', icon:'🔐',  roles:['admin'] },
  { id:'security',      label:'Security',        icon:'🛡️',  roles:['admin'] },
];

// ═══════════════════════════════════════════════════════════════════════════
// ── STATEMENTS COMPONENT (v75-9, Part B — whole-school date-range report) ──
// ═══════════════════════════════════════════════════════════════════════════
// Read-only by design — no writes, no schema changes. Pulls from K.CBOOK
// (the unified Cash Book ledger that everything auto-posts into) and adds
// per-record labels. Uses local-date string prefix slicing (YYYY-MM-DD) so
// timezone math never drifts the displayed dates.
//
// Why K.CBOOK is the single source here:
//   - Every fee collection auto-posts to K.CBOOK (refType='fee')
//   - Every expense auto-posts to K.CBOOK
//   - Every vendor pay, salary, transfer, owner equity → K.CBOOK
// So pulling K.CBOOK alone gives the canonical chronological ledger without
// risk of double-counting. K.PAY / K.EXP / K.SPAY / K.VPAY are specialized
// views into the same money movement.
function Statements() {
  const { role } = React.useContext(UserContext);
  // ── Date-range state with quick presets ──
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = (() => { const d=new Date(); d.setDate(1); return d.toISOString().slice(0,10); })();
  const prevMonthStart = (() => { const d=new Date(); d.setDate(1); d.setMonth(d.getMonth()-1); return d.toISOString().slice(0,10); })();
  const prevMonthEnd   = (() => { const d=new Date(); d.setDate(0); return d.toISOString().slice(0,10); })();
  // NOTE: 'last_30' preset removed — it duplicated 'prev_month' semantically.
  const [fromDate, setFromDate] = useState(monthStart);
  const [toDate,   setToDate]   = useState(today);
  const [preset,   setPreset]   = useState('this_month');

  const applyPreset = (k) => {
    setPreset(k);
    if (k === 'this_month')  { setFromDate(monthStart); setToDate(today); }
    if (k === 'prev_month')  { setFromDate(prevMonthStart); setToDate(prevMonthEnd); }
    // 'custom' leaves dates alone — user edits the inputs
  };

  // ── Pull canonical ledger (K.CBOOK) — integrity-guarded ──
  const cbAll    = getActiveList(K.CBOOK);
  const students = getActiveList(K.STU);
  const stuMap   = useMemo(() => { const m={}; students.forEach(s=>{m[s.id]=s;}); return m; }, [students]);
  // Live name resolver for fee rows (reuse the same helper Cash Book uses)
  const payMatchMap = useMemo(() => buildCashBookPayMatchMap(), [cbAll]);

  // ── Filter by date range using YYYY-MM-DD prefix (timezone-safe) ──
  const inRange = (e) => {
    if (!e || !e.date) return false;
    const d = String(e.date).slice(0, 10);
    return d >= fromDate && d <= toDate;
  };
  const filtered = cbAll.filter(inRange)
    .sort((a, b) => {
      const da = String(a.date || '').slice(0,10);
      const db = String(b.date || '').slice(0,10);
      if (da !== db) return da.localeCompare(db);
      return String(a.id || '').localeCompare(String(b.id || ''));
    });

  // ── Type labels derived from refType (no schema lookup, pure mapping) ──
  const typeLabel = (e) => {
    const r = e.refType || (e.type === 'income' ? 'income' : 'expense');
    if (r === 'fee')           return { icon:'💰', text:'Fee Income',     color:'text-emerald-700 bg-emerald-50' };
    if (r === 'vendor')        return { icon:'📦', text:'Vendor Payment', color:'text-orange-700 bg-orange-50' };
    if (r === 'advance')       return { icon:'📤', text:'Advance Paid',   color:'text-amber-700 bg-amber-50' };
    if (r === 'transfer')      return { icon:'🔁', text:'Transfer',        color:'text-purple-700 bg-purple-50' };
    if (r === 'owner_capital') return { icon:'💎', text:'Owner Capital',  color:'text-blue-700 bg-blue-50' };
    if (r === 'owner_drawing') return { icon:'💸', text:'Owner Drawing',  color:'text-rose-700 bg-rose-50' };
    if (e.type === 'income')   return { icon:'💵', text:'Income',         color:'text-emerald-700 bg-emerald-50' };
    return { icon:'🧾', text:'Expense', color:'text-red-700 bg-red-50' };
  };

  // ── Summary totals (Majma-style — single reduce, no drift) ──
  const totalIn  = filtered.filter(e => e.type === 'income') .reduce((s, e) => s + Number(e.amount || 0), 0);
  const totalOut = filtered.filter(e => e.type === 'expense').reduce((s, e) => s + Number(e.amount || 0), 0);
  const netRange = totalIn - totalOut;

  // ── Print (hardened with try/catch + null guards) ──
  const printStatement = () => {
    try {
      console.log('[Statements] Print clicked — entries in range:', filtered.length);
      const periodLbl = (fromDate || '?') + '  →  ' + (toDate || '?');
      const safeEscape = (s) => String(s == null ? '' : s).replace(/[<>&]/g, c => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;' }[c]));
      const rows = filtered.map((e, i) => {
        const tl = typeLabel(e) || { icon:'', text:'' };
        let desc = '';
        try { desc = String(resolveCashBookDesc(e, students, payMatchMap) || e.description || ''); } catch (er) { desc = String(e.description || ''); }
        const cleanDesc = desc.replace(/\s*\[stuId=[^\]]+\]/g, '').trim() || '—';
        return '<tr>'
          + '<td>' + (i+1) + '</td>'
          + '<td>' + safeEscape(String(e.date || '').slice(0,10)) + '</td>'
          + '<td>' + safeEscape(tl.text) + '</td>'
          + '<td>' + safeEscape(cleanDesc) + '</td>'
          + '<td class="r" style="color:#059669">' + (e.type==='income'  ? 'Rs. ' + Number(e.amount||0).toLocaleString() : '') + '</td>'
          + '<td class="r" style="color:#dc2626">' + (e.type==='expense' ? 'Rs. ' + Number(e.amount||0).toLocaleString() : '') + '</td>'
          + '<td class="r">' + (e.createdByName ? '👤 ' + safeEscape(e.createdByName) : '—') + '</td>'
          + '</tr>';
      }).join('');
      const emptyMsg = filtered.length === 0
        ? '<p style="text-align:center;color:#9ca3af;padding:24px;font-size:13px">No entries fall inside this date range.</p>'
        : '';
      printPage('School Statement — ' + periodLbl, ''
        + '<h2>School Statement</h2>'
        + '<p style="font-size:11px;color:#6b7280;margin:0 0 8px">Period: <b>' + periodLbl + '</b> · ' + filtered.length + ' entries</p>'
        + '<div class="summary">'
        +   '<div class="sum-card"><div class="val" style="color:#059669">Rs. ' + totalIn.toLocaleString()  + '</div><div class="lbl">Total Cash Inflow</div></div>'
        +   '<div class="sum-card"><div class="val" style="color:#dc2626">Rs. ' + totalOut.toLocaleString() + '</div><div class="lbl">Total Cash Outflow</div></div>'
        +   '<div class="sum-card"><div class="val" style="color:' + (netRange>=0?'#1e40af':'#dc2626') + '">Rs. ' + Math.abs(netRange).toLocaleString() + '</div><div class="lbl">Net ' + (netRange>=0?'Surplus':'Deficit') + '</div></div>'
        + '</div>'
        + emptyMsg
        + (filtered.length > 0 ? ''
            + '<table>'
            +   '<thead><tr><th>#</th><th>Date</th><th>Type</th><th>Reference</th><th class="r">Cash In</th><th class="r">Cash Out</th><th class="r">Recorded By</th></tr></thead>'
            +   '<tbody>' + rows + '</tbody>'
            +   '<tfoot><tr style="font-weight:700;background:#dbeafe">'
            +     '<td colspan="4" style="text-align:right">TOTALS:</td>'
            +     '<td class="r" style="color:#059669">Rs. ' + totalIn.toLocaleString()  + '</td>'
            +     '<td class="r" style="color:#dc2626">Rs. ' + totalOut.toLocaleString() + '</td>'
            +     '<td></td>'
            +   '</tr></tfoot>'
            + '</table>'
          : '')
      );
    } catch (err) {
      console.error('[Statements] Print failed:', err);
      alert('Print failed: ' + (err && err.message ? err.message : 'Unknown error') + '\n\nPlease open browser console (F12) and share the red error so I can fix it.');
    }
  };

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-extrabold text-gray-800">📑 Statements</h2>
          <p className="text-sm text-gray-500 mt-0.5">Whole-school activity for any date range — read-only ledger view</p>
        </div>
        <Btn onClick={printStatement}>🖨️ Print Statement</Btn>
      </div>

      {/* ── Quick presets + custom range ── */}
      <Card className="p-4 mb-5">
        <div className="flex flex-wrap gap-2 items-end">
          {[
            ['this_month', 'This Month'],
            ['prev_month', 'Previous Month'],
            ['custom',     'Custom Range'],
          ].map(([k, l]) => (
            <button key={k} onClick={() => applyPreset(k)}
              className={`px-4 py-1.5 rounded-lg text-xs font-bold border transition-all ${preset===k ? 'bg-blue-700 text-white border-blue-700' : 'bg-white text-gray-600 border-gray-200 hover:bg-blue-50'}`}>
              {l}
            </button>
          ))}
          <div className="flex items-end gap-2 ml-2">
            <div>
              <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">From</label>
              <input type="date" value={fromDate} onChange={e => { setFromDate(e.target.value); setPreset('custom'); }}
                className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"/>
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">To</label>
              <input type="date" value={toDate} onChange={e => { setToDate(e.target.value); setPreset('custom'); }}
                className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"/>
            </div>
          </div>
        </div>
      </Card>

      {/* ── Summary cards ── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
        <div className="bg-emerald-50 border-2 border-emerald-200 rounded-2xl p-4">
          <p className="text-xs font-bold text-emerald-700 uppercase tracking-widest mb-1">💰 Total Cash Inflow</p>
          <p className="text-2xl font-extrabold text-emerald-700">Rs. {totalIn.toLocaleString()}</p>
          <p className="text-xs text-gray-500 mt-1">Fees + income entries in range</p>
        </div>
        <div className="bg-red-50 border-2 border-red-200 rounded-2xl p-4">
          <p className="text-xs font-bold text-red-700 uppercase tracking-widest mb-1">🧾 Total Cash Outflow</p>
          <p className="text-2xl font-extrabold text-red-700">Rs. {totalOut.toLocaleString()}</p>
          <p className="text-xs text-gray-500 mt-1">Expenses + salary + vendor in range</p>
        </div>
        <div className={`border-2 rounded-2xl p-4 ${netRange>=0 ? 'bg-blue-50 border-blue-200' : 'bg-orange-50 border-orange-300'}`}>
          <p className={`text-xs font-bold uppercase tracking-widest mb-1 ${netRange>=0?'text-blue-700':'text-orange-700'}`}>📊 Net {netRange>=0?'Surplus':'Deficit'}</p>
          <p className={`text-2xl font-extrabold ${netRange>=0?'text-blue-700':'text-orange-600'}`}>Rs. {Math.abs(netRange).toLocaleString()}</p>
          <p className="text-xs text-gray-500 mt-1">{filtered.length} entries · {fromDate} → {toDate}</p>
        </div>
      </div>

      {/* ── Unified ledger table ── */}
      {filtered.length === 0 ? (
        <Empty icon="📑" text="No entries fall inside this date range. Widen the range or pick a different preset." />
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr className="text-left text-xs text-gray-500 font-semibold uppercase">
                  <th className="px-4 py-3">#</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Reference / Name</th>
                  <th className="px-4 py-3 text-right">Cash In</th>
                  <th className="px-4 py-3 text-right">Cash Out</th>
                  <th className="px-4 py-3 hidden md:table-cell">Recorded By</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map((e, idx) => {
                  const tl   = typeLabel(e);
                  const desc = resolveCashBookDesc(e, students, payMatchMap);
                  const cleanDesc = (desc || '').replace(/\s*\[stuId=[^\]]+\]/g, '').trim() || (e.description || '—');
                  return (
                    <tr key={e.id || idx} className="hover:bg-slate-50">
                      <td className="px-4 py-2.5 text-xs font-bold text-gray-400">{String(idx+1).padStart(3,'0')}</td>
                      <td className="px-4 py-2.5 text-xs text-gray-600 whitespace-nowrap">{String(e.date).slice(0,10)}</td>
                      <td className="px-4 py-2.5">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${tl.color}`}>
                          <span>{tl.icon}</span><span>{tl.text}</span>
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="font-semibold text-gray-800">{cleanDesc}</div>
                        {e.note && <div className="text-xs text-gray-400">{e.note.replace(/\s*\[stuId=[^\]]+\]/g,'').trim()}</div>}
                      </td>
                      <td className="px-4 py-2.5 text-right font-semibold text-emerald-700">
                        {e.type === 'income'  ? 'Rs. ' + Number(e.amount).toLocaleString() : ''}
                      </td>
                      <td className="px-4 py-2.5 text-right font-semibold text-red-600">
                        {e.type === 'expense' ? 'Rs. ' + Number(e.amount).toLocaleString() : ''}
                      </td>
                      <td className="px-4 py-2.5 hidden md:table-cell text-xs text-blue-600 font-semibold">
                        {e.createdByName ? '👤 ' + e.createdByName : <span className="text-gray-300">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="bg-blue-50 border-t-2 border-blue-200 font-bold">
                <tr>
                  <td colSpan={4} className="px-4 py-3 text-right text-gray-700">TOTALS:</td>
                  <td className="px-4 py-3 text-right text-emerald-700">Rs. {totalIn.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right text-red-700">Rs. {totalOut.toLocaleString()}</td>
                  <td className="px-4 py-3 hidden md:table-cell"></td>
                </tr>
                <tr className={netRange>=0 ? 'bg-emerald-100' : 'bg-red-100'}>
                  <td colSpan={4} className={`px-4 py-3 text-right ${netRange>=0?'text-emerald-800':'text-red-800'}`}>NET {netRange>=0?'SURPLUS':'DEFICIT'}:</td>
                  <td colSpan={2} className={`px-4 py-3 text-right text-base ${netRange>=0?'text-emerald-800':'text-red-800'}`}>Rs. {Math.abs(netRange).toLocaleString()}</td>
                  <td className="hidden md:table-cell"></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ── STUDENT STATEMENT (v75-9, Part A — per-student date-range ledger) ─────
// ═══════════════════════════════════════════════════════════════════════════
// Opening Balance = student's outstanding considering only payments BEFORE
//                   the From Date (uses the same global engine helper that
//                   Dashboard and FeeCollection use — guaranteed reconcile).
// Closing Balance = Opening + new fees accrued in range (months touched)
//                   − payments received in range.
// Read-only — no writes to any storage.
function StudentStatement({ students, payments, classFees, defaultFrom, defaultTo }) {
  const [stuId,    setStuId]    = useState(students[0]?.id || '');
  const [fromDate, setFromDate] = useState(defaultFrom);
  const [toDate,   setToDate]   = useState(defaultTo);
  const [preset,   setPreset]   = useState('this_month');

  const applyPreset = (k) => {
    setPreset(k);
    if (k === 'this_month') {
      const t = new Date(); const d = new Date(); d.setDate(1);
      setFromDate(d.toISOString().slice(0,10)); setToDate(t.toISOString().slice(0,10));
    } else if (k === 'prev_month') {
      const d = new Date(); d.setDate(1); d.setMonth(d.getMonth()-1);
      const e = new Date(); e.setDate(0);
      setFromDate(d.toISOString().slice(0,10)); setToDate(e.toISOString().slice(0,10));
    }
    // 'last_30' preset removed — duplicated 'prev_month' semantically.
  };

  const stu = students.find(s => s.id === stuId);
  if (!stu) return <Empty icon="📑" text="Select a student to generate a statement."/>;

  // ── All payments for this student, sorted oldest → newest ──
  const stuPays = payments.filter(p => p.stuId === stuId)
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));

  // ── Split by date range ──
  const beforeFrom   = stuPays.filter(p => String(p.date || '').slice(0,10) < fromDate);
  const inRange      = stuPays.filter(p => {
    const d = String(p.date || '').slice(0,10);
    return d >= fromDate && d <= toDate;
  });

  // ── Net monthly due from Global Engine (Majma) ──
  const netMonthly = getStuNetMonthlyDue(stu, classFees);
  const openingBal0 = Number(stu.openingBalance || 0);  // pre-system carry-forward

  // ── Months elapsed before From Date (post-cutoff only) ──
  const monthsBetween = (yA, mA, yB, mB) => (yB - yA) * 12 + (mB - mA);
  const cutoffY = ENGINE_CUTOFF_YEAR, cutoffM = ENGINE_CUTOFF_MONTH;
  const from = new Date(fromDate);
  const to   = new Date(toDate);
  // Months ACCRUED before From Date (June 2026 onwards)
  const mBefore = Math.max(0, monthsBetween(cutoffY, cutoffM, from.getFullYear(), from.getMonth()));
  const accruedBefore = mBefore * netMonthly;
  const paidBefore    = beforeFrom.reduce((s, p) => s + Number(p.amount || 0), 0);
  const afPaidBefore  = beforeFrom.reduce((s, p) => s + Number(p.annualFund || 0), 0);
  const bksPaidBefore = beforeFrom.reduce((s, p) => s + Number(p.booksPaid || 0), 0);
  const openingBalance = Math.max(0, openingBal0 + accruedBefore - paidBefore);

  // ── Months ACCRUED within range ──
  const mInRange = Math.max(0, monthsBetween(from.getFullYear(), from.getMonth(), to.getFullYear(), to.getMonth()) + 1);
  const accruedInRange = mInRange * netMonthly;
  const paidInRange    = inRange.reduce((s, p) => s + Number(p.amount || 0), 0);
  const closingBalance = Math.max(0, openingBalance + accruedInRange - paidInRange);

  const totalAFInRange    = inRange.reduce((s, p) => s + Number(p.annualFund || 0), 0);
  const totalBooksInRange = inRange.reduce((s, p) => s + Number(p.booksPaid  || 0), 0);

  // ── Running balance for each row ──
  let running = openingBalance;
  const rows = [];
  // Inject monthly accrual rows so the running balance is honest
  for (let i = 0; i < mInRange; i++) {
    const d = new Date(from.getFullYear(), from.getMonth() + i, 1);
    const dateStr = d.toISOString().slice(0,10);
    running += netMonthly;
    rows.push({
      kind: 'accrual',
      date: dateStr,
      desc: 'Monthly fee accrual — ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear(),
      debit: netMonthly,
      credit: 0,
      balance: running,
    });
    // Add any payments for that month
    inRange.filter(p => Number(p.month) === d.getMonth() && Number(p.year) === d.getFullYear()).forEach(p => {
      const amt = Number(p.amount || 0);
      running -= amt;
      rows.push({
        kind: 'payment',
        date: String(p.date || dateStr).slice(0,10),
        desc: 'Fee payment received · ' + (p.rcpt || '') + (p.createdByName ? ' · 👤 ' + p.createdByName : ''),
        debit: 0,
        credit: amt,
        balance: Math.max(0, running),
        meta: p,
      });
    });
  }
  // Sort rows by date then by kind so accrual posts before payment of same month
  rows.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.kind === 'accrual' ? -1 : 1;
  });

  const printStmt = () => {
    const periodLbl = `${fromDate}  →  ${toDate}`;
    const trs = rows.map((r, i) => `<tr>
      <td>${i+1}</td>
      <td>${r.date}</td>
      <td>${r.desc}</td>
      <td class="r" style="color:#dc2626">${r.debit ? 'Rs. ' + r.debit.toLocaleString() : ''}</td>
      <td class="r" style="color:#059669">${r.credit ? 'Rs. ' + r.credit.toLocaleString() : ''}</td>
      <td class="r"><b>Rs. ${r.balance.toLocaleString()}</b></td>
    </tr>`).join('');
    printPage('Statement — ' + stu.name + ' (' + periodLbl + ')', `
      <h2>Student Statement</h2>
      <p style="font-size:11px;color:#6b7280;margin:0 0 4px"><b>${stu.name}</b> · Class ${stu.cls} · Roll ${stu.roll} · Family ${stu.family || '—'}</p>
      <p style="font-size:11px;color:#6b7280;margin:0 0 8px">Period: <b>${periodLbl}</b></p>
      <div class="summary">
        <div class="sum-card"><div class="val">Rs. ${openingBalance.toLocaleString()}</div><div class="lbl">Opening Balance</div></div>
        <div class="sum-card"><div class="val" style="color:#059669">Rs. ${paidInRange.toLocaleString()}</div><div class="lbl">Paid In Range</div></div>
        <div class="sum-card"><div class="val" style="color:${closingBalance>0?'#dc2626':'#059669'}">Rs. ${closingBalance.toLocaleString()}</div><div class="lbl">Closing Balance</div></div>
      </div>
      <table>
        <thead><tr><th>#</th><th>Date</th><th>Description</th><th class="r">Debit (Due)</th><th class="r">Credit (Paid)</th><th class="r">Running Balance</th></tr></thead>
        <tbody>${trs}</tbody>
      </table>`);
  };

  return (
    <Card className="p-4">
      <h3 className="font-bold text-gray-800 mb-3">📑 Generate Statement</h3>
      <div className="flex flex-wrap gap-2 mb-4 items-end">
        <div className="min-w-[200px]">
          <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Student</label>
          <select value={stuId} onChange={e => setStuId(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400">
            {students.map(s => <option key={s.id} value={s.id}>{s.name} (Roll {s.roll} · Class {s.cls})</option>)}
          </select>
        </div>
        {[['this_month','This Month'],['prev_month','Previous Month'],['custom','Custom']].map(([k,l]) => (
          <button key={k} onClick={() => applyPreset(k)}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold border ${preset===k?'bg-blue-700 text-white border-blue-700':'bg-white text-gray-600 border-gray-200 hover:bg-blue-50'}`}>
            {l}
          </button>
        ))}
        <div>
          <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">From</label>
          <input type="date" value={fromDate} onChange={e => { setFromDate(e.target.value); setPreset('custom'); }}
            className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"/>
        </div>
        <div>
          <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">To</label>
          <input type="date" value={toDate} onChange={e => { setToDate(e.target.value); setPreset('custom'); }}
            className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"/>
        </div>
        <Btn onClick={printStmt}>🖨️ Print</Btn>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <div className="bg-orange-50 border-2 border-orange-200 rounded-xl p-3">
          <p className="text-xs font-bold text-orange-700 uppercase mb-1">📂 Opening Balance</p>
          <p className="text-xl font-extrabold text-orange-700">Rs. {openingBalance.toLocaleString()}</p>
          <p className="text-[10px] text-gray-500 mt-0.5">As of {fromDate}</p>
        </div>
        <div className="bg-emerald-50 border-2 border-emerald-200 rounded-xl p-3">
          <p className="text-xs font-bold text-emerald-700 uppercase mb-1">✅ Paid In Range</p>
          <p className="text-xl font-extrabold text-emerald-700">Rs. {paidInRange.toLocaleString()}</p>
          <p className="text-[10px] text-gray-500 mt-0.5">{inRange.length} payment{inRange.length===1?'':'s'} · AF: Rs. {totalAFInRange.toLocaleString()} · Books: Rs. {totalBooksInRange.toLocaleString()}</p>
        </div>
        <div className={`border-2 rounded-xl p-3 ${closingBalance>0?'bg-red-50 border-red-200':'bg-blue-50 border-blue-200'}`}>
          <p className={`text-xs font-bold uppercase mb-1 ${closingBalance>0?'text-red-700':'text-blue-700'}`}>📊 Closing Balance</p>
          <p className={`text-xl font-extrabold ${closingBalance>0?'text-red-700':'text-blue-700'}`}>Rs. {closingBalance.toLocaleString()}</p>
          <p className="text-[10px] text-gray-500 mt-0.5">As of {toDate}</p>
        </div>
      </div>

      {rows.length === 0 ? (
        <Empty icon="📑" text="No accrual or payment activity in this date range."/>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr className="text-left text-xs text-gray-500 font-semibold uppercase">
                <th className="px-3 py-2">#</th>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Description</th>
                <th className="px-3 py-2 text-right">Debit (Due)</th>
                <th className="px-3 py-2 text-right">Credit (Paid)</th>
                <th className="px-3 py-2 text-right">Running Balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              <tr className="bg-orange-50">
                <td className="px-3 py-2 text-xs font-bold text-gray-400">—</td>
                <td className="px-3 py-2 text-xs text-gray-600">{fromDate}</td>
                <td className="px-3 py-2 text-xs font-semibold text-orange-700">Opening Balance</td>
                <td className="px-3 py-2 text-right text-xs text-gray-400">—</td>
                <td className="px-3 py-2 text-right text-xs text-gray-400">—</td>
                <td className="px-3 py-2 text-right font-bold text-orange-700">Rs. {openingBalance.toLocaleString()}</td>
              </tr>
              {rows.map((r, idx) => (
                <tr key={idx} className={r.kind === 'accrual' ? 'bg-red-50/50' : 'bg-emerald-50/40'}>
                  <td className="px-3 py-2 text-xs font-bold text-gray-400">{String(idx+1).padStart(3,'0')}</td>
                  <td className="px-3 py-2 text-xs text-gray-600 whitespace-nowrap">{r.date}</td>
                  <td className="px-3 py-2 text-xs">{r.desc}</td>
                  <td className="px-3 py-2 text-right text-xs text-red-600 font-semibold">{r.debit ? 'Rs. ' + r.debit.toLocaleString() : ''}</td>
                  <td className="px-3 py-2 text-right text-xs text-emerald-700 font-semibold">{r.credit ? 'Rs. ' + r.credit.toLocaleString() : ''}</td>
                  <td className="px-3 py-2 text-right text-xs font-bold text-gray-700">Rs. {r.balance.toLocaleString()}</td>
                </tr>
              ))}
              <tr className={closingBalance>0?'bg-red-100 font-bold':'bg-blue-100 font-bold'}>
                <td className="px-3 py-2">—</td>
                <td className="px-3 py-2 text-xs">{toDate}</td>
                <td className={`px-3 py-2 text-xs ${closingBalance>0?'text-red-800':'text-blue-800'}`}>Closing Balance</td>
                <td className="px-3 py-2 text-right">—</td>
                <td className="px-3 py-2 text-right">—</td>
                <td className={`px-3 py-2 text-right ${closingBalance>0?'text-red-800':'text-blue-800'}`}>Rs. {closingBalance.toLocaleString()}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function App() {
  const [currentUser, setCurrentUser] = useState(() => getSession());
  const [page, setPage]     = useState(() => sessionStorage.getItem('_currentPage') || 'dashboard');
  const [syncTick, setSyncTick] = useState(0);
  const [sideOpen, setSideOpen] = useState(false);
  const [canInstall, setCanInstall] = useState(false);
  // ── Online / Offline / Firebase connection state ──────────────────────────
  const [isOnline,     setIsOnline]     = useState(navigator.onLine);
  const [fbConnected,  setFbConnected]  = useState(false);
  const [syncMsg,      setSyncMsg]      = useState('');
  React.useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      setSyncMsg('🔄 Back online — syncing…');
      setTimeout(() => setSyncMsg(''), 3000);
      if (window._fbDB) firebase.database().goOnline();
    };
    const handleOffline = () => {
      setIsOnline(false);
      setSyncMsg('⚠️ Offline — changes saved locally');
    };
    window.addEventListener('online',  handleOnline);
    window.addEventListener('offline', handleOffline);
    let connRef = null;
    if (window._fbDB) {
      connRef = window._fbDB.ref('.info/connected');
      connRef.on('value', snap => {
        const connected = snap.val() === true;
        setFbConnected(connected);
        if (connected && window._smsRefresh) {
          setTimeout(() => { if (window._smsRefresh) window._smsRefresh(); }, 500);
        }
      });
    }
    return () => {
      window.removeEventListener('online',  handleOnline);
      window.removeEventListener('offline', handleOffline);
      if (connRef) connRef.off('value');
    };
  }, []);
  React.useEffect(() => { window._smsRefresh = () => setSyncTick(t => t + 1); return () => { window._smsRefresh = null; }; }, []);
  React.useEffect(() => {
    if (window._pwaInstallPrompt) setCanInstall(true);
    const h = () => setCanInstall(true);
    document.addEventListener('pwaready', h);
    return () => document.removeEventListener('pwaready', h);
  }, []);
  const [staffCanModify, setStaffCanModify] = useState(() => S.get(K.PERM, {}).staffCanModify || false);
  const [showCalc, setShowCalc] = useState(false);
  const [calcDisp, setCalcDisp] = useState('0');
  const [calcPrev, setCalcPrev] = useState('');
  const [calcOp,   setCalcOp]   = useState('');
  const [calcNew,  setCalcNew]  = useState(true);

  const calcPress = (val) => {
    if (val === 'C') { setCalcDisp('0'); setCalcPrev(''); setCalcOp(''); setCalcNew(true); return; }
    if (val === '⌫') { setCalcDisp(d => d.length > 1 ? d.slice(0,-1) : '0'); return; }
    if (val === '=') {
      if (!calcOp || !calcPrev) return;
      const a = parseFloat(calcPrev), b = parseFloat(calcDisp);
      let r = calcOp==='+' ? a+b : calcOp==='-' ? a-b : calcOp==='×' ? a*b : b!==0 ? a/b : 'Error';
      const rs = typeof r==='number' ? (Number.isInteger(r) ? String(r) : parseFloat(r.toFixed(8)).toString()) : 'Error';
      setCalcDisp(rs); setCalcPrev(''); setCalcOp(''); setCalcNew(true); return;
    }
    if (['+','-','×','÷'].includes(val)) {
      setCalcOp(val); setCalcPrev(calcDisp); setCalcNew(true); return;
    }
    if (val === '.' && calcDisp.includes('.')) return;
    if (calcNew) { setCalcDisp(val === '.' ? '0.' : val); setCalcNew(false); }
    else setCalcDisp(d => d === '0' && val !== '.' ? val : d + val);
  };

  if (!currentUser) return <LoginScreen onLogin={setCurrentUser}/>;

  if (currentUser.role === 'parent') {
    return <ParentPortal currentUser={currentUser} onLogout={() => { clearSession(); setCurrentUser(null); }}/>;
  }

  const NAV = currentUser.role === 'custom'
    ? NAV_ALL.filter(n => (currentUser.allowedModules || []).includes(n.id))
    : NAV_ALL.filter(n => n.roles.includes(currentUser.role));
  const go  = (p) => { setPage(p); setSideOpen(false); sessionStorage.setItem('_currentPage', p); };
  const logout = () => { clearSession(); setCurrentUser(null); setPage('dashboard'); sessionStorage.removeItem('_currentPage'); };

  return (
    <UserContext.Provider value={currentUser}>
    <PermContext.Provider value={{ staffCanModify, setStaffCanModify }}>
    <div className="min-h-screen flex bg-slate-100">
      {sideOpen && <div className="fixed inset-0 bg-black/40 z-20 lg:hidden" onClick={() => setSideOpen(false)}/>}

      {/* Sidebar */}
      <aside className={`fixed top-0 left-0 h-full w-64 z-30 flex flex-col bg-gradient-to-b from-gray-800 via-gray-700 to-gray-800 text-white transition-transform duration-300
        ${sideOpen ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0 lg:static lg:shrink-0`}>
        <div className="p-4 border-b border-gray-600/50 bg-white/10">
          <img src={LOGO_SRC} alt="DISS" className="w-full max-h-14 object-contain"
            onError={e => { e.target.style.display='none'; e.target.nextSibling.style.display='block'; }}/>
          <div style={{display:'none'}}>
            <div className="text-2xl mb-1">🏫</div>
            <h1 className="text-base font-bold leading-tight text-white">Discovery International</h1>
            <p className="text-xs text-gray-300 mt-0.5">School System</p>
          </div>
        </div>
        <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
          {NAV.map(n => (
            <button key={n.id} onClick={() => go(n.id)}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-semibold transition-all
                ${page === n.id ? 'bg-white/20 text-white shadow-inner' : 'text-gray-200 hover:bg-white/10 hover:text-white'}`}>
              <span className="text-lg">{n.icon}</span>
              {n.label}
            </button>
          ))}
        </nav>
        {/* ── Calculator ── */}
        <div className="border-t border-gray-600/50">
          <button onClick={() => setShowCalc(v => !v)}
            className="w-full flex items-center justify-between px-4 py-2.5 text-gray-300 hover:text-white hover:bg-white/10 transition-all text-sm font-semibold">
            <span>🧮 Calculator</span>
            <span className="text-xs">{showCalc ? '▲' : '▼'}</span>
          </button>
          {showCalc && (
            <div className="px-3 pb-3">
              <div className="bg-gray-900 rounded-xl px-3 py-2 mb-2 text-right">
                {calcOp && <div className="text-xs text-gray-500">{calcPrev} {calcOp}</div>}
                <div className="text-white font-mono text-xl font-bold truncate">{calcDisp}</div>
              </div>
              {[
                ['C','⌫','÷','×'],
                ['7','8','9','-'],
                ['4','5','6','+'],
                ['1','2','3','='],
                ['.','0','00','='],
              ].map((row, ri) => (
                <div key={ri} className="grid grid-cols-4 gap-1 mb-1">
                  {row.map((btn, bi) => {
                    if (ri === 4 && bi === 3) return null;
                    const isEq  = btn === '=';
                    const isOp  = ['+','-','×','÷'].includes(btn);
                    const isCl  = btn === 'C';
                    const isDel = btn === '⌫';
                    return (
                      <button key={bi} onClick={() => calcPress(btn)}
                        className={`py-2 rounded-lg text-sm font-bold transition-all active:scale-95
                          ${isEq  ? 'bg-emerald-500 hover:bg-emerald-400 text-white'
                          : isOp  ? 'bg-amber-500 hover:bg-amber-400 text-white'
                          : isCl  ? 'bg-red-500 hover:bg-red-400 text-white'
                          : isDel ? 'bg-gray-500 hover:bg-gray-400 text-white'
                          : 'bg-gray-600 hover:bg-gray-500 text-white'}`}>
                        {btn}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="p-4 border-t border-gray-600/50">
          {canInstall && (
            <button onClick={async () => {
              if (!window._pwaInstallPrompt) return;
              window._pwaInstallPrompt.prompt();
              const { outcome } = await window._pwaInstallPrompt.userChoice;
              if (outcome === 'accepted') { setCanInstall(false); window._pwaInstallPrompt = null; }
            }} className="w-full flex items-center justify-center gap-2 px-3 py-2 mb-3 bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold rounded-xl transition-all">
              📲 Install App
            </button>
          )}
          <div className="flex items-center gap-2 mb-2">
            <div className="w-7 h-7 rounded-full bg-white/20 flex items-center justify-center text-xs font-bold">{currentUser.name[0]}</div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-white truncate">{currentUser.name}</p>
              <p className="text-xs text-gray-300 capitalize">{currentUser.role}</p>
            </div>
            <button onClick={logout} title="Logout" className="text-gray-300 hover:text-white text-xs px-2 py-1 rounded-lg hover:bg-white/10 transition-all shrink-0">⏏ Out</button>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="bg-white border-b border-gray-200 sticky top-0 z-10 shadow-sm">
          <div className="h-1 bg-gradient-to-r from-red-500 via-amber-400 to-red-600"/>
          <div className="bg-gray-800 text-white text-xs py-0.5 overflow-hidden" style={{whiteSpace:'nowrap'}}>
            <style>{`@keyframes _ticker{0%{transform:translateX(100vw)}100%{transform:translateX(-100%)}}`}</style>
            <span style={{display:'inline-block',animation:'_ticker 28s linear infinite',paddingLeft:'100%'}}>
              ⭐ Welcome to TATAHEER BUSINESS GROUP &nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp; Discovery International School System &nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp; Wagha Road, Jallo More, Lahore &nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp; 📞 +92 (322) 8555566 &nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp; ⭐ Welcome to TATAHEER BUSINESS GROUP &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
            </span>
          </div>
          <div className="px-4 py-2.5 flex items-center gap-3">
            <button onClick={() => setSideOpen(true)} className="lg:hidden text-gray-500 hover:text-gray-800 text-xl p-1 rounded-lg hover:bg-gray-100">☰</button>
            <div className="flex-1 min-w-0">
              <h1 className="text-sm font-bold text-gray-800 leading-tight">{NAV.find(n => n.id === page)?.icon} {NAV.find(n => n.id === page)?.label}</h1>
              <p className="text-xs text-gray-400 leading-tight hidden sm:block">Discovery International School System</p>
            </div>
            {syncMsg ? (
              <span className={`text-xs font-semibold px-2 py-1 rounded-lg border hidden sm:block ${isOnline ? 'bg-blue-50 text-blue-600 border-blue-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>{syncMsg}</span>
            ) : (
              <span className={`text-xs font-semibold px-2 py-1 rounded-lg border hidden sm:flex items-center gap-1 ${fbConnected ? 'bg-emerald-50 text-emerald-600 border-emerald-200' : isOnline ? 'bg-amber-50 text-amber-600 border-amber-200' : 'bg-red-50 text-red-600 border-red-200'}`}>
                <span className={`w-1.5 h-1.5 rounded-full inline-block ${fbConnected ? 'bg-emerald-500' : isOnline ? 'bg-amber-400' : 'bg-red-500'}`}/>
                {fbConnected ? 'Live' : isOnline ? 'Connecting…' : 'Offline'}
              </span>
            )}
            <span className="text-xs text-gray-400 hidden sm:block bg-gray-50 px-2 py-1 rounded-lg border border-gray-100">{new Date().toLocaleDateString('en-PK', { weekday:'short', year:'numeric', month:'short', day:'numeric' })}</span>
            {/* 🔄 Sync Now — manual force-pull from Firebase. Cloud overwrites local on click. */}
            <button onClick={() => {
              if (!window._fbDB || !window._fbAuthReady) { alert('⏳ Firebase not connected yet. Please wait a moment and try again.'); return; }
              const ALL_KEYS = ['sms_stu','sms_inv','sms_tx','sms_cf','sms_pay','sms_exp','sms_af','sms_staff','sms_spay','sms_bl','sms_ds','sms_rs','sms_st','sms_sl','sms_vend','sms_sbook','sms_users','sms_vpay','sms_acct','sms_cbook','sms_perm','sms_audit','sms_preq','sms_notif','sms_comp','sms_asset','sms_rcpt_ctr'];
              window._fbDB.ref('sms').once('value').then(snap => {
                const cloudData = snap.val() || {};
                const changed = window.forceCloudWins(cloudData, ALL_KEYS);
                alert(changed ? '✅ Synced from cloud. Refreshing…' : '✅ Already in sync. Latest cloud data.');
                if (changed && window._smsRefresh) window._smsRefresh();
                setTimeout(() => window.location.reload(), 500);
              }).catch(e => alert('❌ Sync failed: ' + e.message));
            }} title="Force-pull latest data from Firebase. Cloud overwrites local." className="text-xs font-semibold text-blue-600 hover:text-white hover:bg-blue-600 px-3 py-1.5 rounded-lg border border-blue-200 hover:border-blue-600 transition-all hidden sm:flex items-center gap-1">🔄 <span>Sync Now</span></button>
            <button onClick={logout} className="text-xs text-gray-500 hover:text-red-600 px-3 py-1.5 rounded-lg hover:bg-red-50 border border-gray-200 hover:border-red-200 transition-all hidden sm:flex items-center gap-1">⏏ <span>Logout</span></button>
          </div>
        </header>

        {/*
          CRITICAL: do NOT add `key={syncTick}` or any sync-driven key here.
          The previous `key={syncTick}` forced this <main> to UNMOUNT/REMOUNT on
          every Firebase listener fire — which is what wiped input focus, scroll
          position, modal state, and bounced the user back to the dashboard.

          The SyncContext.Provider below makes the same syncTick value available
          to any component that explicitly opts in via React.useContext(SyncContext).
          Subscribers re-render (cheap, focus-preserving). Active forms and modals
          that don't subscribe stay completely untouched during cloud syncs.
        */}
        <main className="flex-1 p-4 sm:p-6 overflow-y-auto">
        <SyncContext.Provider value={syncTick}>
          {/* Defensive gate: if a non-allowed role is on the Dashboard page
              (e.g. cached session), bounce them to their first allowed module.
              NAV filter already hides the menu item — this guards direct URLs. */}
          {(() => {
            const dashAllowed = ['admin','principal'].includes(currentUser.role);
            if (page === 'dashboard' && !dashAllowed && NAV.length > 0 && NAV[0].id !== 'dashboard') {
              setTimeout(() => { setPage(NAV[0].id); sessionStorage.setItem('_currentPage', NAV[0].id); }, 0);
              return null;
            }
            return null;
          })()}
          {page === 'dashboard'     && ['admin','principal'].includes(currentUser.role) && <Dashboard setPage={setPage}/>}
          {page === 'statements'    && ['admin','principal'].includes(currentUser.role) && <Statements/>}
          {page === 'students'      && <Students/>}
          {page === 'feecollect'    && <FeeCollection/>}
          {page === 'fees'          && <Fees/>}
          {page === 'inventory'     && <Inventory/>}
          {page === 'expenses'      && <Expenses/>}
          {page === 'family'        && <FamilyLedger/>}
          {page === 'staff'         && <Staff/>}
          {page === 'books'         && <VendorBooks/>}
          {page === 'exams'         && <Exams/>}
          {page === 'cashbook'      && <CashBook/>}
          {page === 'assets'        && <Assets/>}
          {page === 'notifications' && <Notifications/>}
          {page === 'users'         && <UserAdmin/>}
          {page === 'security'      && <SecuritySettings/>}
        </SyncContext.Provider>
        </main>
      </div>
    </div>
    </PermContext.Provider>
    </UserContext.Provider>
  );
}

(function() {
  localStorage.removeItem('sms_sess');
  window._fbSyncDone = false;
  window._fbAuthReady = false;
  window._isOffline = !navigator.onLine;

  window.addEventListener('online', function() {
    window._isOffline = false;
    if (!window._fbDB) return;
    firebase.database().goOnline();
    setTimeout(function() {
      if (!window._fbAuthReady) return;
      window._fbDB.ref('sms').once('value').then(function(snap) {
        var cloudData = snap.val() || {};
        var ALL_KEYS = ['sms_stu','sms_inv','sms_tx','sms_cf','sms_pay','sms_exp','sms_af','sms_staff','sms_spay','sms_bl','sms_ds','sms_rs','sms_st','sms_sl','sms_vend','sms_sbook','sms_users','sms_vpay','sms_acct','sms_cbook','sms_perm','sms_audit','sms_preq','sms_notif','sms_comp','sms_asset','sms_rcpt_ctr'];
        // v83+: CLOUD WINS — Firebase is the authoritative source after reconnect.
        // Eliminates multi-device drift; whichever device wrote last to Firebase wins.
        var changed = forceCloudWins(cloudData, ALL_KEYS);
        if (changed && window._smsRefresh) window._smsRefresh();
      }).catch(function() {});
    }, 800);
  });

  window.addEventListener('offline', function() { window._isOffline = true; });

  // ── v75.1: Journal queue flush triggers ──
  // 1. On 'online' event: device just reconnected — drain queued entries.
  // 2. After Firebase auth ready (delay): catch any entries left from a prior
  //    offline session that the app couldn't flush on close.
  window.addEventListener('online', function() {
    if (typeof window.flushJournalQueue === 'function') {
      window.flushJournalQueue();
    }
  });
  setTimeout(function() {
    if (typeof window.flushJournalQueue === 'function' && window._fbDB) {
      window.flushJournalQueue();
    }
  }, 3500);

  ReactDOM.createRoot(document.getElementById('root')).render(<App/>);

  const pageLoadTime = Date.now();
  let _syncDone = false;
  firebase.auth().onAuthStateChanged(async function(user) {
    if (!user || _syncDone) return;
    _syncDone = true;
    window._fbAuthReady = true;

    try {
      const fbFetch = window._fbDB.ref('sms').once('value');
      const fbTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 12000));
      const snap = await Promise.race([fbFetch, fbTimeout]);
      const cloudData = snap.val() || {};
      const ALL_KEYS = ['sms_stu','sms_inv','sms_tx','sms_cf','sms_pay','sms_exp','sms_af','sms_staff','sms_spay','sms_bl','sms_ds','sms_rs','sms_st','sms_sl','sms_vend','sms_sbook','sms_users','sms_vpay','sms_acct','sms_cbook','sms_perm','sms_audit','sms_preq','sms_notif','sms_comp','sms_asset','sms_rcpt_ctr'];
      // v83+: CLOUD WINS — Firebase is the authoritative source on every page load.
      // Whatever you saved last (from any device) wins everywhere. No more drift.
      const changed = forceCloudWins(cloudData, ALL_KEYS);
      if (changed && window._smsRefresh) window._smsRefresh();
      window._fbConnected = true;
    } catch(e) {
      window._fbConnected = false;
      console.warn('Firebase background sync failed:', e);
    }
    window._fbSyncDone = true;
    window._hideFbLoading();

    const LIVE_KEYS = [
      'sms_stu','sms_inv','sms_tx','sms_cf','sms_pay','sms_exp','sms_af',
      'sms_staff','sms_spay','sms_bl','sms_ds','sms_rs','sms_st','sms_sl',
      'sms_vend','sms_sbook','sms_users','sms_vpay','sms_acct','sms_cbook',
      'sms_perm','sms_audit','sms_preq','sms_notif','sms_comp','sms_asset','sms_rcpt_ctr',
      'sms_tombstones'   // live-subscribe so cross-device deletions are honored immediately
    ];
    let _refreshTimer = null;
    // Defer refresh if the user is actively typing in an input/textarea/select.
    // Even though the `key={syncTick}` was removed (so refresh no longer remounts
    // main), a re-render that lands mid-keystroke can still feel jittery — this
    // delays the re-render until the user lifts focus.
    const scheduleRefresh = () => {
      if (_refreshTimer) clearTimeout(_refreshTimer);
      const fire = () => {
        const ae = document.activeElement;
        const tag = ae && ae.tagName ? ae.tagName.toUpperCase() : '';
        const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (ae && ae.isContentEditable);
        if (isTyping) {
          // User still typing — retry once focus is released or after 1.5s
          _refreshTimer = setTimeout(fire, 1500);
          return;
        }
        if (window._smsRefresh) window._smsRefresh();
      };
      _refreshTimer = setTimeout(fire, 400);
    };

    // ── Cache cloud-side timestamps so the LIVE listener can do the same
    // ── timestamp comparison the initial reconcileWithCloud does. Without this
    // ── cache, an incoming echo for a value where local is newer would blindly
    // ── overwrite the user's just-typed/just-edited data (the "rollback bug").
    window._cloudTsCache = window._cloudTsCache || {};
    try {
      window._fbDB.ref('sms/sms_ts').on('value', snap => {
        const v = snap.val();
        if (v && typeof v === 'object') window._cloudTsCache = v;
      });
    } catch(e) {}

    try {
      LIVE_KEYS.forEach(k => {
        const ref = window._fbDB.ref('sms/' + k);
        let firstFire = true;
        ref.on('value', snap => {
          if (firstFire) { firstFire = false; return; }
          const val = snap.val();
          if (val === null || val === undefined) return;
          const cloudRaw = JSON.stringify(val);
          const localRaw = localStorage.getItem(k);
          if (localRaw === cloudRaw) return;

          // ── Timestamp guard: protects local edits from being wiped by stale cloud echoes ──
          let localTs = {};
          try { localTs = JSON.parse(localStorage.getItem('sms_ts') || '{}'); } catch(e) {}
          const lts = Number(localTs[k]) || 0;
          const cts = Number((window._cloudTsCache || {})[k]) || 0;

          // If local was modified more recently than cloud's known timestamp for this
          // key → DO NOT overwrite. Push our local value up to win the conflict.
          if (lts > cts && localRaw !== null && localRaw !== 'null') {
            try {
              window._fbDB.ref('sms/' + k).set(JSON.parse(localRaw)).catch(() => {});
            } catch(e) {}
            return;
          }

          // ── For list keys (sms_stu, sms_pay, …) MERGE by id instead of replacing
          // ── the entire array — protects items that exist only locally.
          // Pass the key so tombstoned ids (locally-deleted records) are filtered OUT
          // of cloud data and CANNOT be resurrected by a stale device echo.
          if (typeof LIST_KEYS_WITH_ID !== 'undefined' && LIST_KEYS_WITH_ID.indexOf(k) !== -1) {
            let localArr = [];
            try { localArr = localRaw ? JSON.parse(localRaw) : []; } catch(e) {}
            if (Array.isArray(localArr) && Array.isArray(val)) {
              const merged = (typeof mergeArraysById === 'function') ? mergeArraysById(localArr, val, k) : val;
              const mergedRaw = JSON.stringify(merged);
              if (mergedRaw !== localRaw) {
                try { if (typeof backupLocalBeforeOverwrite === 'function') backupLocalBeforeOverwrite(k, localArr); } catch(e) {}
                localStorage.setItem(k, mergedRaw);
                scheduleRefresh();
              }
              // Sync merged result back so cloud is canonical
              if (mergedRaw !== cloudRaw) {
                try { window._fbDB.ref('sms/' + k).set(merged).catch(() => {}); } catch(e) {}
              }
              return;
            }
          }

          // ── Plain overwrite path — back up local first for the Recovery panel ──
          try { if (typeof backupLocalBeforeOverwrite === 'function') backupLocalBeforeOverwrite(k, localRaw ? JSON.parse(localRaw) : null); } catch(e) {}
          localStorage.setItem(k, cloudRaw);
          scheduleRefresh();
        });
      });
    } catch(e) {}
  });
})();
