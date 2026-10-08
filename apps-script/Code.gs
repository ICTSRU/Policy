/**
 * ICTD Policy Register — Google Apps Script Web App
 * Backend for: نموذج إعداد السياسات (ICTD Policy Template) v2.0
 * ---------------------------------------------------------------
 * Sheets created automatically on first run:
 *   Policies  — one row per policy code (latest saved state)
 *   Versions  — one row per (code + version) snapshot, for recall/rollback
 *   Log       — audit trail of every save / delete
 *   Archive   — deleted policies (soft delete: full JSON kept, restorable by an administrator)
 *
 * Endpoints
 *   GET  ?action=ping
 *   GET  ?action=list[&key=]                       → policy register
 *   GET  ?action=get&code=ICTD-22P[&version=1.0]   → full policy JSON
 *   GET  ?action=versions&code=ICTD-22P            → versions of one policy
 *   POST {action:'save', data:{…}, baseUpdatedAt, force, user, key}
 *   POST {action:'delete', code, reason, user, key}   → moves the policy to Archive
 *        (sent as text/plain to avoid CORS preflight)
 *
 * Optional security: Project Settings → Script properties → API_KEY = <secret>
 * If set, every request must carry the same key.
 */

const VERSION = 'v2.0';
const SH_POLICIES = 'Policies';
const SH_VERSIONS = 'Versions';
const SH_LOG = 'Log';
const SH_ARCHIVE = 'Archive';
const ARCHIVE_HEADERS = ['رمز السياسة Code','عنوان السياسة','الإصدار Version','تاريخ الحذف DeletedAt','حُذفت بواسطة DeletedBy','سبب الحذف Reason'];
const CHUNK = 45000;     // Google Sheets cell limit is 50,000 chars
const JSON_COLS = 8;     // up to ~360k chars per policy

const POLICY_HEADERS = ['رمز السياسة Code','عنوان السياسة','Title (EN)','الإصدار Version','الحالة Status','التصنيف','الجهة المالكة','جهة الاعتماد','تاريخ الإصدار','المراجعة القادمة','أُعدت بواسطة','عدد الأقسام','آخر تحديث UpdatedAt','حُدّثت بواسطة UpdatedBy'];
const VERSION_HEADERS = ['رمز السياسة Code','الإصدار Version','عنوان السياسة','الحالة Status','تاريخ الحفظ SavedAt','بواسطة SavedBy'];

/* ---------------- setup ---------------- */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, SH_POLICIES, POLICY_HEADERS.concat(jsonHeaders_()));
  ensureSheet_(ss, SH_VERSIONS, VERSION_HEADERS.concat(jsonHeaders_()));
  ensureSheet_(ss, SH_LOG, ['الوقت Time','الإجراء Action','رمز السياسة Code','الإصدار Version','بواسطة User','ملاحظات Notes']);
  ensureSheet_(ss, SH_ARCHIVE, ARCHIVE_HEADERS.concat(jsonHeaders_()));
  // remove the empty default sheet of a new spreadsheet
  ['Sheet1', 'الورقة1', 'ورقة1'].forEach(function (n) {
    const s = ss.getSheetByName(n);
    if (s && s.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s);
  });
  return 'OK';
}
function jsonHeaders_() { const a = []; for (let i = 1; i <= JSON_COLS; i++) a.push('JSON_' + i); return a; }
function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#501e8c').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    sh.setRightToLeft(true);
    sh.hideColumns(headers.length - JSON_COLS + 1, JSON_COLS);   // hide raw JSON columns
  }
  return sh;
}

/* ---------------- routing ---------------- */
function doGet(e) {
  try {
    const p = e.parameter || {};
    checkKey_(p.key);
    setup();
    switch (p.action) {
      case 'ping':     return out_({ ok: true, version: VERSION });
      case 'list':     return out_({ ok: true, items: list_(), deleted: deleted_() });
      case 'get':      return out_(get_(p.code, p.version));
      case 'versions': return out_({ ok: true, items: versions_(p.code) });
      default:         return out_({ ok: false, error: 'unknown action' });
    }
  } catch (err) { return out_({ ok: false, error: String(err.message || err) }); }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    checkKey_(body.key);
    setup();
    if (body.action === 'save') return out_(save_(body));
    if (body.action === 'delete') return out_(delete_(body));
    return out_({ ok: false, error: 'unknown action' });
  } catch (err) { return out_({ ok: false, error: String(err.message || err) }); }
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function checkKey_(key) {
  const k = PropertiesService.getScriptProperties().getProperty('API_KEY');
  if (k && key !== k) throw new Error('unauthorized');
}

/* ---------------- save (upsert) ---------------- */
function save_(body) {
  const d = body.data;
  if (!d || !d.meta) throw new Error('missing data');
  const code = String(d.meta.code || '').trim().toUpperCase();
  const ver = String(d.meta.version || '').trim();
  if (!/^ICTD-\d+P$/.test(code)) throw new Error('invalid policy code: ' + code);
  if (!/^\d+\.\d$/.test(ver)) throw new Error('invalid version: ' + ver);
  d.meta.code = code;

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(SH_POLICIES);
    const row = findRow_(sh, [code]);
    const now = new Date().toISOString();
    const user = String(body.user || '').slice(0, 120) || Session.getActiveUser().getEmail() || 'web';

    // Optimistic concurrency: refuse if someone saved after this client loaded it
    if (row && !body.force) {
      const serverUpdated = String(sh.getRange(row, 13).getDisplayValue() || '');
      if (body.baseUpdatedAt !== serverUpdated) {
        return { ok: false, conflict: true, serverUpdatedAt: serverUpdated,
                 serverBy: String(sh.getRange(row, 14).getDisplayValue() || ''),
                 error: 'conflict' };
      }
    }

    const json = JSON.stringify(d);
    const chunks = chunk_(json);
    const m = d.meta;
    const sections = Object.keys(d.on || {}).filter(function (k) { return d.on[k]; }).length;
    const values = [code, m.titleAr || '', m.titleEn || '', ver, m.status || '', m.classification || '',
                    m.owner || '', m.approver || '', m.issueDate || '', m.nextReview || '', m.preparedBy || '',
                    sections, now, user].concat(chunks);
    writeRow_(sh, row || sh.getLastRow() + 1, values);

    // Version snapshot: one row per code+version (updated in place while editing that version)
    const vs = ss.getSheetByName(SH_VERSIONS);
    const vrow = findRow_(vs, [code, ver]);
    const vvals = [code, ver, m.titleAr || '', m.status || '', now, user].concat(chunks);
    writeRow_(vs, vrow || vs.getLastRow() + 1, vvals);

    ss.getSheetByName(SH_LOG).appendRow([now, row ? 'update' : 'create', code, ver, user, body.auto ? 'auto-save' : 'manual']);
    return { ok: true, code: code, version: ver, updatedAt: now, created: !row };
  } finally {
    lock.releaseLock();
  }
}

// Write as plain text so Sheets never converts "1.0" → 1 or ISO timestamps → Date
function writeRow_(sh, r, values) {
  const rng = sh.getRange(r, 1, 1, values.length);
  rng.setNumberFormat('@');
  rng.setValues([values.map(function (v) {
    v = String(v);
    return /^[=+\-@]/.test(v) ? "'" + v : v;    // never let user text be parsed as a formula
  })]);
}

function chunk_(s) {
  if (s.length > CHUNK * JSON_COLS) throw new Error('policy too large');
  const a = [];
  // each chunk is prefixed with "~" so a chunk can never start with "=" and be read as a formula
  for (let i = 0; i < JSON_COLS; i++) { const c = s.substr(i * CHUNK, CHUNK); a.push(c ? '~' + c : ''); }
  return a;
}
function readJson_(sh, row, firstJsonCol) {
  const parts = sh.getRange(row, firstJsonCol, 1, JSON_COLS).getDisplayValues()[0];
  return JSON.parse(parts.map(function (c) { return String(c).replace(/^~/, ''); }).join(''));
}
function findRow_(sh, keys) {
  const n = sh.getLastRow() - 1;
  if (n < 1) return 0;
  const vals = sh.getRange(2, 1, n, keys.length).getDisplayValues();
  for (let i = 0; i < vals.length; i++) {
    let hit = true;
    for (let j = 0; j < keys.length; j++) if (String(vals[i][j]).trim().toUpperCase() !== String(keys[j]).toUpperCase()) { hit = false; break; }
    if (hit) return i + 2;
  }
  return 0;
}

/* ---------------- delete (soft) ---------------- */
// Moves the policy row (with its full JSON) to the Archive sheet and removes it from Policies.
// Version snapshots stay in Versions for audit. A policy that exists only in the bundled library
// is recorded in Archive as well, so every page hides it.
function delete_(body) {
  const code = String(body.code || '').trim().toUpperCase();
  if (!/^ICTD-\d+P$/.test(code)) throw new Error('invalid policy code: ' + code);
  const reason = String(body.reason || '').slice(0, 500);
  const user = String(body.user || '').slice(0, 120) || Session.getActiveUser().getEmail() || 'web';
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(SH_POLICIES);
    const ar = ss.getSheetByName(SH_ARCHIVE);
    const row = findRow_(sh, [code]);
    const now = new Date().toISOString();
    let title = String(body.title || ''), ver = String(body.version || ''), chunks = jsonHeaders_().map(function () { return ''; });
    if (row) {
      const r = sh.getRange(row, 1, 1, POLICY_HEADERS.length).getDisplayValues()[0];
      title = r[1]; ver = r[3];
      chunks = sh.getRange(row, POLICY_HEADERS.length + 1, 1, JSON_COLS).getDisplayValues()[0];
      chunks = chunks.map(function (c) { return c ? (c.charAt(0) === '~' ? c : '~' + c) : ''; });
    }
    writeRow_(ar, ar.getLastRow() + 1, [code, title, ver, now, user, reason].concat(chunks));
    if (row) sh.deleteRow(row);
    ss.getSheetByName(SH_LOG).appendRow([now, 'delete', code, ver, user, reason || (row ? 'deleted from register' : 'hidden library copy')]);
    return { ok: true, code: code, deletedAt: now, fromRegister: !!row };
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- admin: restore a deleted policy (menu inside the Google Sheet) ---------------- */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('سجل السياسات')
    .addItem('استرجاع سياسة محذوفة…', 'restorePolicyPrompt')
    .addToUi();
}
function restorePolicyPrompt() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('استرجاع سياسة محذوفة', 'اكتب رمز السياسة (مثال: ICTD-22P):', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const res = restorePolicy(r.getResponseText());
  ui.alert(res.ok ? 'تم استرجاع ' + res.code + ' (الإصدار ' + res.version + ') إلى قائمة السياسات.' : 'تعذّر الاسترجاع: ' + res.error);
}
// Restores the most recent archived copy of a policy back into Policies (and its version snapshot)
function restorePolicy(code) {
  code = String(code || '').trim().toUpperCase();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  setup();
  if (findRow_(ss.getSheetByName(SH_POLICIES), [code])) return { ok: false, error: 'السياسة موجودة حاليًا في القائمة' };
  const ar = ss.getSheetByName(SH_ARCHIVE);
  const n = ar.getLastRow() - 1;
  let row = 0;
  if (n > 0) {
    const codes = ar.getRange(2, 1, n, 1).getDisplayValues();
    for (let i = codes.length - 1; i >= 0; i--) if (String(codes[i][0]).toUpperCase() === code) { row = i + 2; break; }
  }
  if (!row) return { ok: false, error: 'لا توجد نسخة مؤرشفة لهذا الرمز' };
  const parts = ar.getRange(row, ARCHIVE_HEADERS.length + 1, 1, JSON_COLS).getDisplayValues()[0];
  if (!parts.join('')) return { ok: false, error: 'السياسة كانت من مكتبة السياسات فقط؛ أعد استيراد ملف JSON الخاص بها من القالب' };
  const data = JSON.parse(parts.map(function (c) { return String(c).replace(/^~/, ''); }).join(''));
  const res = save_({ data: data, force: true, user: Session.getActiveUser().getEmail() || 'admin' });
  if (res.ok) ss.getSheetByName(SH_LOG).appendRow([new Date().toISOString(), 'restore', code, res.version, Session.getActiveUser().getEmail() || 'admin', 'restored from Archive']);
  return res;
}

// Codes that were deleted and not re-created since
function deleted_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ar = ss.getSheetByName(SH_ARCHIVE);
  const n = ar.getLastRow() - 1;
  if (n < 1) return [];
  const live = {};
  list_().forEach(function (x) { live[String(x.code).toUpperCase()] = 1; });
  const out = {};
  ar.getRange(2, 1, n, 1).getDisplayValues().forEach(function (r) {
    const c = String(r[0]).toUpperCase(); if (c && !live[c]) out[c] = 1;
  });
  return Object.keys(out);
}

/* ---------------- read ---------------- */
function list_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_POLICIES);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, POLICY_HEADERS.length).getDisplayValues().map(function (r) {
    return { code: r[0], titleAr: r[1], titleEn: r[2], version: r[3], status: r[4], owner: r[6],
             nextReview: r[9], updatedAt: r[12], updatedBy: r[13] };
  }).filter(function (x) { return x.code; });
}

function get_(code, version) {
  code = String(code || '').trim().toUpperCase();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (version) {
    const vs = ss.getSheetByName(SH_VERSIONS);
    const vr = findRow_(vs, [code, version]);
    if (!vr) return { ok: false, error: 'version not found' };
    // A historical version is returned without updatedAt so a later save is checked against the live row
    const ps = ss.getSheetByName(SH_POLICIES);
    const pr = findRow_(ps, [code]);
    return { ok: true, data: readJson_(vs, vr, VERSION_HEADERS.length + 1),
             updatedAt: pr ? String(ps.getRange(pr, 13).getDisplayValue()) : null, historical: true };
  }
  const sh = ss.getSheetByName(SH_POLICIES);
  const row = findRow_(sh, [code]);
  if (!row) return { ok: false, error: 'not found' };
  return { ok: true, data: readJson_(sh, row, POLICY_HEADERS.length + 1),
           updatedAt: String(sh.getRange(row, 13).getDisplayValue()) };
}

function versions_(code) {
  code = String(code || '').trim().toUpperCase();
  const vs = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_VERSIONS);
  const n = vs.getLastRow() - 1;
  if (n < 1) return [];
  return vs.getRange(2, 1, n, VERSION_HEADERS.length).getDisplayValues()
    .filter(function (r) { return String(r[0]).toUpperCase() === code; })
    .map(function (r) { return { code: r[0], version: r[1], titleAr: r[2], status: r[3], savedAt: r[4], savedBy: r[5] }; })
    .sort(function (a, b) { return parseFloat(b.version) - parseFloat(a.version); });
}
