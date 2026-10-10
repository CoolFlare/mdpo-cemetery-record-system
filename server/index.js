'use strict';
// MPDO Cemetery Record System - offline local server
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const {
  DB_PATH, DATA_DIR, BURIAL_TYPES, PAYMENT_METHODS, DEFAULT_PRICING,
  openDb, closeDb, getDb, getPricing, setSettingSync, getSettingSync, nowIso, todayStr,
} = require('./db');
const {
  hashPassword, verifyPassword, createSession, destroySession, extractToken, requireAuth, requirePermission,
  audit, activeAdminCount, purgeExpiredSessions, PERMISSIONS,
} = require('./auth');
const { computeTotalCents, validateRecordFields, computeBalanceCents } = require('./pricing');
const csv = require('./csv');

const PORT = parseInt(process.env.MPDO_PORT || '3000', 10);
const HOST = process.env.MPDO_HOST || '0.0.0.0';
const app = express();
app.use(express.json({ limit: '64mb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: 0 }));

openDb();
purgeExpiredSessions();

const money = (cents) => (cents / 100).toFixed(2);
function httpError(res, status, msg) { return res.status(status).json({ error: msg }); }
function adminCount() { return activeAdminCount(); }

const RECORD_SELECT = `
  SELECT m.record_id, m.control_number, m.deceased_name, m.date_of_death, m.date_of_burial,
         m.burial_type, m.indigent, m.payment_method, m.total_cents,
         COALESCE(p.paid_cents, 0) AS paid_cents,
         CASE WHEN m.indigent = 'Yes' THEN 0 ELSE m.total_cents - COALESCE(p.paid_cents, 0) END AS raw_balance_cents,
         (SELECT COUNT(*) FROM PaymentDb pd WHERE pd.control_number = m.control_number) AS payment_count,
         latest.date_process AS latest_date_process,
         latest.remarks AS latest_remarks,
         latest.payment_id AS latest_payment_id
  FROM MainDb m
  LEFT JOIN (SELECT control_number, SUM(amount_cents) AS paid_cents FROM PaymentDb GROUP BY control_number) p
    ON p.control_number = m.control_number
  LEFT JOIN (
    SELECT pd.control_number, pd.payment_id, pd.date_process, pd.remarks
    FROM PaymentDb pd
    INNER JOIN (SELECT control_number, MAX(date_process || '#' || printf('%010d', payment_id)) AS mk
                FROM PaymentDb GROUP BY control_number) mx
      ON mx.control_number = pd.control_number
     AND mx.mk = (pd.date_process || '#' || printf('%010d', pd.payment_id))
  ) latest ON latest.control_number = m.control_number`;

function rowToRecord(r) {
  const total = r.total_cents;
  const paid = r.paid_cents;
  const balance = r.indigent === 'Yes' ? 0 : computeBalanceCents(total, paid);
  const status = r.indigent === 'Yes' ? 'Indigent' : (paid <= 0 ? 'Unpaid' : (balance <= 0 ? 'Paid' : 'Partial'));
  return {
    record_id: r.record_id,
    control_number: r.control_number,
    deceased_name: r.deceased_name,
    date_of_death: r.date_of_death,
    date_of_burial: r.date_of_burial,
    burial_type: r.burial_type,
    indigent: r.indigent,
    payment_method: r.payment_method,
    total_cents: total,
    total: money(total),
    paid_cents: paid,
    paid: money(paid),
    balance_cents: balance,
    balance: money(balance),
    payment_count: r.payment_count,
    status,
    latest_date_process: r.latest_date_process || null,
    latest_remarks: r.latest_remarks || null,
  };
}

// ======================= SETUP / AUTH =======================
app.get('/api/setup/status', (req, res) => {
  res.json({ needsSetup: adminCount() === 0 });
});

app.post('/api/setup/admin', (req, res) => {
  if (adminCount() > 0) return httpError(res, 403, 'Setup already completed.');
  const { full_name, username, password } = req.body || {};
  if (!full_name || !full_name.trim()) return httpError(res, 400, 'Full Name is required.');
  if (!username || !/^[a-zA-Z0-9_.-]{3,30}$/.test(username)) return httpError(res, 400, 'Username must be 3-30 characters (letters, numbers, _ . -).');
  if (!password || password.length < 8) return httpError(res, 400, 'Password must be at least 8 characters.');
  try {
    getDb().prepare("INSERT INTO LoginDb (full_name, username, password_hash, role, account_status, date_created) VALUES (?,?,?, 'Administrator','Active', ?)")
      .run(full_name.trim(), username.trim(), hashPassword(password), nowIso());
  } catch (e) { return httpError(res, 409, 'Could not create administrator: ' + e.message); }
  audit(req, 'setup.admin', 'LoginDb', username, { full_name });
  res.json({ ok: true });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return httpError(res, 400, 'Username and password are required.');
  const user = getDb().prepare('SELECT * FROM LoginDb WHERE username = ?').get(String(username).trim());
  if (!user || !verifyPassword(String(password), user.password_hash)) {
    audit(req, 'auth.login.failed', 'LoginDb', username, {});
    return httpError(res, 401, 'Invalid username or password.');
  }
  if (user.account_status !== 'Active') return httpError(res, 403, 'This account is deactivated. Contact an administrator.');
  purgeExpiredSessions();
  const sess = createSession(user.user_id);
  req.user = { username: user.username };
  audit(req, 'auth.login', 'LoginDb', user.user_id, {});
  res.json({
    token: sess.token,
    user: { userId: user.user_id, fullName: user.full_name, username: user.username, role: user.role },
  });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  destroySession(extractToken(req));
  audit(req, 'auth.logout', 'LoginDb', req.user.userId, {});
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user, permissions: Object.fromEntries(Object.entries(PERMISSIONS).map(([k, v]) => [k, v.includes(req.user.role)])) });
});

// ======================= USER MANAGEMENT =======================
app.get('/api/users', requireAuth, requirePermission('users:manage'), (req, res) => {
  const rows = getDb().prepare(`SELECT user_id, full_name, username, role, account_status, date_created FROM LoginDb ORDER BY user_id`).all();
  res.json({ users: rows });
});

app.post('/api/users', requireAuth, requirePermission('users:manage'), (req, res) => {
  const { full_name, username, password, role, account_status } = req.body || {};
  if (!full_name || !full_name.trim()) return httpError(res, 400, 'Full Name is required.');
  if (!username || !/^[a-zA-Z0-9_.-]{3,30}$/.test(username)) return httpError(res, 400, 'Username must be 3-30 characters (letters, numbers, _ . -).');
  if (!password || password.length < 8) return httpError(res, 400, 'Password must be at least 8 characters.');
  if (!['Administrator', 'Staff', 'Viewer'].includes(role)) return httpError(res, 400, 'Invalid role.');
  try {
    const info = getDb().prepare("INSERT INTO LoginDb (full_name, username, password_hash, role, account_status, date_created) VALUES (?,?,?,?,?,?)")
      .run(full_name.trim(), username.trim(), hashPassword(password), role, account_status === 'Inactive' ? 'Inactive' : 'Active', nowIso());
    audit(req, 'user.create', 'LoginDb', info.lastInsertRowid, { username, role });
    res.json({ ok: true, user_id: info.lastInsertRowid });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return httpError(res, 409, 'That username already exists.');
    return httpError(res, 500, 'Could not create user: ' + e.message);
  }
});

app.put('/api/users/:id', requireAuth, requirePermission('users:manage'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const db = getDb();
  const user = db.prepare('SELECT * FROM LoginDb WHERE user_id = ?').get(id);
  if (!user) return httpError(res, 404, 'User not found.');
  const { full_name, role, account_status, password } = req.body || {};
  if (role && !['Administrator', 'Staff', 'Viewer'].includes(role)) return httpError(res, 400, 'Invalid role.');
  const targetRole = role || user.role;
  const targetStatus = account_status || user.account_status;
  if ((user.role === 'Administrator') && (targetRole !== 'Administrator' || targetStatus !== 'Active') && adminCount() <= 1) {
    return httpError(res, 409, 'Cannot demote or deactivate the last active Administrator account.');
  }
  if (full_name !== undefined && !String(full_name).trim()) return httpError(res, 400, 'Full Name cannot be empty.');
  try {
    db.prepare('UPDATE LoginDb SET full_name = ?, role = ?, account_status = ? WHERE user_id = ?')
      .run(full_name !== undefined ? String(full_name).trim() : user.full_name, targetRole, targetStatus, id);
    if (password) {
      if (password.length < 8) return httpError(res, 400, 'Password must be at least 8 characters.');
      db.prepare('UPDATE LoginDb SET password_hash = ? WHERE user_id = ?').run(hashPassword(password), id);
      db.prepare('DELETE FROM SessionDb WHERE user_id = ?').run(id);
    }
    audit(req, 'user.update', 'LoginDb', id, { username: user.username, role: targetRole, status: targetStatus, password_reset: !!password });
    res.json({ ok: true });
  } catch (e) { return httpError(res, 500, 'Could not update user: ' + e.message); }
});

app.delete('/api/users/:id', requireAuth, requirePermission('users:manage'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const db = getDb();
  const user = db.prepare('SELECT * FROM LoginDb WHERE user_id = ?').get(id);
  if (!user) return httpError(res, 404, 'User not found.');
  if (user.role === 'Administrator' && adminCount() <= 1) return httpError(res, 409, 'Cannot delete the last active Administrator account.');
  if (id === req.user.userId) return httpError(res, 409, 'You cannot delete your own account.');
  db.prepare('DELETE FROM LoginDb WHERE user_id = ?').run(id);
  audit(req, 'user.delete', 'LoginDb', id, { username: user.username });
  res.json({ ok: true });
});

// ======================= CEMETERY RECORDS =======================
app.get('/api/records', requireAuth, (req, res) => {
  const {
    search = '', burial_type = '', indigent = '', payment_method = '', status = '',
    date_from = '', date_to = '', date_field = 'date_of_burial',
    sort = 'control_number', dir = 'desc', page = 1, page_size = 25,
  } = req.query;
  const where = [], params = [];
  // Filters apply to the derived table (plain column names, no aliases)
  if (search) {
    const like = `%${search}%`;
    where.push(`(control_number LIKE ? OR deceased_name LIKE ? OR burial_type LIKE ? OR control_number IN
      (SELECT control_number FROM PaymentDb WHERE relative_name LIKE ? OR or_number LIKE ?))`);
    params.push(like, like, like, like, like);
  }
  if (burial_type) { where.push('burial_type = ?'); params.push(burial_type); }
  if (indigent) { where.push('indigent = ?'); params.push(indigent); }
  if (payment_method) { where.push('payment_method = ?'); params.push(payment_method); }
  if (status) {
    if (status === 'Paid') where.push("indigent = 'No' AND total_cents > 0 AND paid_cents >= total_cents");
    else if (status === 'Partial') where.push("indigent = 'No' AND paid_cents > 0 AND paid_cents < total_cents");
    else if (status === 'Unpaid') where.push("indigent = 'No' AND paid_cents = 0");
    else if (status === 'Indigent') where.push("indigent = 'Yes'");
  }
  const safeDateField = ['date_of_burial', 'date_of_death'].includes(date_field) ? date_field : 'date_of_burial';
  if (date_from && /^\d{4}-\d{2}-\d{2}$/.test(date_from)) { where.push(`${safeDateField} >= ?`); params.push(date_from); }
  if (date_to && /^\d{4}-\d{2}-\d{2}$/.test(date_to)) { where.push(`${safeDateField} <= ?`); params.push(date_to); }

  const allowedSort = { control_number: 'control_number', deceased_name: 'deceased_name', burial_type: 'burial_type', indigent: 'indigent', payment_method: 'payment_method', total: 'total_cents', balance: 'balance_cents', latest: 'latest_date_process' };
  const sortCol = allowedSort[sort] || 'control_number';
  const sortDir = dir === 'asc' ? 'ASC' : 'DESC';
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const db = getDb();
  const total = db.prepare(`SELECT COUNT(*) c FROM (${RECORD_SELECT}) ${whereSql}`).get(...params).c;
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const size = Math.min(200, Math.max(1, parseInt(page_size, 10) || 25));
  const offset = (pageNum - 1) * size;
  const rows = db.prepare(`SELECT * FROM (${RECORD_SELECT}) ${whereSql} ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`)
    .all(...params, size, offset);
  res.json({
    records: rows.map(rowToRecord),
    total,
    page: pageNum,
    page_size: size,
    pages: Math.max(1, Math.ceil(total / size)),
  });
});

app.get('/api/records/next-control-number', requireAuth, (req, res) => {
  const db = getDb();
  const year = new Date().getFullYear();
  const row = db.prepare('SELECT last_number FROM SequenceDb WHERE year = ?').get(year);
  const n = (row ? row.last_number : 0) + 1;
  res.json({ control_number: `${year}-${String(n).padStart(3, '0')}` });
});

function allocateControlNumber(db) {
  const year = new Date().getFullYear();
  db.prepare('INSERT INTO SequenceDb (year, last_number) VALUES (?, 1) ON CONFLICT(year) DO UPDATE SET last_number = last_number + 1').run(year);
  const row = db.prepare('SELECT last_number FROM SequenceDb WHERE year = ?').get(year);
  return `${year}-${String(row.last_number).padStart(3, '0')}`;
}

app.post('/api/records', requireAuth, requirePermission('records:create'), (req, res) => {
  const body = req.body || {};
  const v = validateRecordFields(body);
  if (Object.keys(v.errors).length) return res.status(400).json({ errors: v.errors });
  const total = body.indigent === 'Yes' ? 0 : computeTotalCents(v.burialType, v.indigent, v.paymentMethod);
  const db = getDb();
  try {
    const result = db.transaction(() => {
      const cn = allocateControlNumber(db);
      const info = db.prepare(`INSERT INTO MainDb (control_number, deceased_name, date_of_death, date_of_burial, burial_type, indigent, payment_method, total_cents, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(cn, v.deceasedName, body.date_of_death || null, body.date_of_burial || null, v.burialType, v.indigent, v.paymentMethod, total, req.user.username, nowIso(), nowIso());
      return { record_id: info.lastInsertRowid, control_number: cn };
    })();
    audit(req, 'record.create', 'MainDb', result.control_number, { deceased_name: v.deceasedName, total_cents: total });
    const row = db.prepare(`${RECORD_SELECT} WHERE m.record_id = ?`).get(result.record_id);
    res.json({ ok: true, record: rowToRecord(row) });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return httpError(res, 409, 'Control Number conflict, please retry. ' + e.message);
    return httpError(res, 500, 'Could not save record: ' + e.message);
  }
});

app.put('/api/records/:id', requireAuth, requirePermission('records:update'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const db = getDb();
  const existing = db.prepare('SELECT * FROM MainDb WHERE record_id = ?').get(id);
  if (!existing) return httpError(res, 404, 'Record not found.');
  const body = req.body || {};
  const v = validateRecordFields(body);
  if (Object.keys(v.errors).length) return res.status(400).json({ errors: v.errors });

  const paymentCount = db.prepare('SELECT COUNT(*) c FROM PaymentDb WHERE record_id = ?').get(id).c;
  const isIndigent = v.indigent === 'Yes';
  // Require explicit confirmation before converting a record (esp. one with payments) to indigent
  if (isIndigent && existing.indigent === 'No' && body.confirm_indigent !== true) {
    const paidCents = db.prepare('SELECT COALESCE(SUM(amount_cents),0) s FROM PaymentDb WHERE record_id = ?').get(id).s;
    return res.status(409).json({
      needsConfirmation: true,
      message: paymentCount > 0
        ? `This record has ${paymentCount} payment transaction(s) totaling ${money(paidCents)}. Changing it to indigent will set Total Amount and Balance to 0.00. Confirm to continue.`
        : 'Changing this record to indigent will set Total Amount and Balance to 0.00. Confirm to continue.',
    });
  }

  // Total amount policy: indigent forces 0; otherwise keep stored total unless the client
  // explicitly sends a recalculated total (recalculate flag) or an explicit new total.
  let total;
  if (isIndigent) total = 0;
  else if (body.recalculate === true) total = computeTotalCents(v.burialType, v.indigent, v.paymentMethod);
  else if (body.total_cents !== undefined && body.total_cents !== null) total = Math.max(0, Math.round(Number(body.total_cents)));
  else total = existing.total_cents;

  const paid = db.prepare('SELECT COALESCE(SUM(amount_cents),0) s FROM PaymentDb WHERE record_id = ?').get(id).s;
  if (total < paid) return httpError(res, 400, `Total Amount (${money(total)}) cannot be less than payments already recorded (${money(paid)}).`);

  try {
    db.prepare(`UPDATE MainDb SET deceased_name=?, date_of_death=?, date_of_burial=?, burial_type=?, indigent=?, payment_method=?, total_cents=?, updated_by=?, updated_at=? WHERE record_id=?`)
      .run(v.deceasedName, body.date_of_death || null, body.date_of_burial || null, v.burialType, v.indigent, v.paymentMethod, total, req.user.username, nowIso(), id);
    audit(req, 'record.update', 'MainDb', existing.control_number, { total_cents: total, indigent: v.indigent });
    const row = db.prepare(`${RECORD_SELECT} WHERE m.record_id = ?`).get(id);
    res.json({ ok: true, record: rowToRecord(row) });
  } catch (e) { return httpError(res, 500, 'Could not update record: ' + e.message); }
});

app.delete('/api/records/:id', requireAuth, requirePermission('records:delete'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const db = getDb();
  const existing = db.prepare('SELECT * FROM MainDb WHERE record_id = ?').get(id);
  if (!existing) return httpError(res, 404, 'Record not found.');
  const paymentCount = db.prepare('SELECT COUNT(*) c FROM PaymentDb WHERE record_id = ?').get(id).c;
  const body = req.body || {};
  if (paymentCount > 0 && body.delete_payments !== true) {
    if (body.confirm === true) {
      return httpError(res, 400, 'Payment history exists. Choose "Delete record and all its payments" to proceed.');
    }
    return res.status(409).json({
      needsConfirmation: true,
      payment_count: paymentCount,
      message: `This record has ${paymentCount} payment transaction(s). Deleting it requires an explicit decision.`,
    });
  }
  try {
    db.transaction(() => {
      if (paymentCount > 0 && body.delete_payments === true) {
        db.prepare('DELETE FROM PaymentDb WHERE record_id = ?').run(id);
      }
      // Sequence counter is intentionally NOT decremented: numbers are never reused.
      db.prepare('DELETE FROM MainDb WHERE record_id = ?').run(id);
    })();
    audit(req, 'record.delete', 'MainDb', existing.control_number, { payments_deleted: paymentCount > 0 && body.delete_payments === true });
    res.json({ ok: true });
  } catch (e) { return httpError(res, e.status || 500, e.message); }
});

// ======================= PAYMENTS =======================
function paymentValidation(db, body, { excludePaymentId = null } = {}) {
  const errors = {};
  const controlNumber = (body.control_number || '').trim();
  if (!controlNumber) errors.control_number = 'Control Number is required.';
  const record = controlNumber ? db.prepare('SELECT * FROM MainDb WHERE control_number = ?').get(controlNumber) : null;
  if (controlNumber && !record) errors.control_number = `Control Number "${controlNumber}" does not exist in cemetery records.`;
  let amount = null;
  if (typeof body.amount_cents === 'number' && isFinite(body.amount_cents)) {
    amount = Math.round(body.amount_cents); // API clients send integer centavos
  } else if (typeof body.amount_cents === 'string' && body.amount_cents.trim() !== '') {
    amount = csv.parseMoneyToCents(body.amount_cents); // human-entered "1,234.50" pesos
  }
  const isIndigentRec = !!(record && record.indigent === 'Yes');
  if (amount === null || isNaN(amount)) {
    // Indigent records have Amount Paid disabled in the form (fixed at 0.00)
    if (isIndigentRec) amount = 0;
    else errors.amount_paid = 'Amount Paid must be a valid number.';
  }
  if (amount !== null && !isNaN(amount)) {
    if (amount < 0) errors.amount_paid = 'Amount Paid cannot be negative.';
    else if (amount === 0 && !isIndigentRec) errors.amount_paid = 'Amount Paid must be greater than zero.';
  }
  // Overpayment check applies to non-indigent records; indigent records have a 0.00 total
  // but still record payment details, so the balance cap is not enforced for them.
  if (record && record.indigent !== 'Yes' && amount !== null && amount > 0) {
    const paid = db.prepare('SELECT COALESCE(SUM(amount_cents),0) s FROM PaymentDb WHERE control_number = ? AND payment_id != ?')
      .get(controlNumber, excludePaymentId || -1).s;
    const balance = computeBalanceCents(record.total_cents, paid);
    if (amount > balance) errors.amount_paid = `Amount Paid exceeds the remaining balance of ${money(balance)}. Overpayment is not allowed.`;
  }
  if (!body.date_process || !/^\d{4}-\d{2}-\d{2}$/.test(body.date_process)) errors.date_process = 'Date Process is required.';
  if (!(body.relative_name || '').trim()) errors.relative_name = 'Relative Name is required.';
  let age = null;
  if (body.age !== undefined && body.age !== null && String(body.age).trim() !== '') {
    const n = Number(body.age);
    if (!Number.isInteger(n) || n < 0 || n > 150) errors.age = 'Age must be a whole number between 0 and 150.';
    else age = n;
  }
  if (record && record.indigent !== 'Yes') {
    if (!body.or_number || !String(body.or_number).trim()) errors.or_number = 'OR Number is required for non-indigent records.';
  }
  for (const f of ['cedula_date', 'or_date']) {
    if (body[f] && !/^\d{4}-\d{2}-\d{2}$/.test(body[f])) errors[f] = 'Use a valid date (yyyy-MM-dd).';
  }
  return { errors, record, amount, age };
}

function mapPayment(p) { return { ...p, amount: money(p.amount_cents) }; }

app.get('/api/payments', requireAuth, (req, res) => {
  const { control_number } = req.query;
  const db = getDb();
  const rows = control_number
    ? db.prepare('SELECT * FROM PaymentDb WHERE control_number = ? ORDER BY date_process DESC, payment_id DESC').all(control_number)
    : db.prepare('SELECT * FROM PaymentDb ORDER BY date_process DESC, payment_id DESC LIMIT 500').all();
  res.json({ payments: rows.map(mapPayment) });
});

app.post('/api/payments', requireAuth, requirePermission('payments:create'), (req, res) => {
  const db = getDb();
  const body = req.body || {};
  const v = paymentValidation(db, body);
  if (Object.keys(v.errors).length) return res.status(400).json({ errors: v.errors });
  const clientRef = body.client_ref || crypto.randomUUID();
  const existing = db.prepare('SELECT payment_id FROM PaymentDb WHERE client_ref = ?').get(clientRef);
  if (existing) return httpError(res, 409, 'Duplicate payment submission blocked (Payment ID ' + existing.payment_id + ' already exists).');
  try {
    const pid = db.transaction(() => {
      const info = db.prepare(`INSERT INTO PaymentDb (client_ref, record_id, control_number, date_process, relative_name, relative_address, contact_number,
        deceased_relation, relative_relation, age, amount_cents, cedula_number, cedula_date, cedula_place, or_number, or_date, or_place, remarks, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(clientRef, v.record.record_id, v.record.control_number, body.date_process, String(body.relative_name).trim(),
          body.relative_address || null, body.contact_number || null, body.deceased_relation || null, body.relative_relation || null,
          v.age, v.amount, body.cedula_number || null, body.cedula_date || null, body.cedula_place || null,
          body.or_number || null, body.or_date || null, body.or_place || null, body.remarks || null,
          req.user.username, nowIso(), nowIso());
      return info.lastInsertRowid;
    })();
    audit(req, 'payment.create', 'PaymentDb', pid, { control_number: v.record.control_number, amount_cents: v.amount });
    const row = db.prepare('SELECT * FROM PaymentDb WHERE payment_id = ?').get(pid);
    const record = db.prepare(`${RECORD_SELECT} WHERE m.record_id = ?`).get(v.record.record_id);
    res.json({ ok: true, payment: mapPayment(row), record: rowToRecord(record) });
  } catch (e) { return httpError(res, 500, 'Could not save payment: ' + e.message); }
});

app.put('/api/payments/:id', requireAuth, requirePermission('payments:update'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const db = getDb();
  const existing = db.prepare('SELECT * FROM PaymentDb WHERE payment_id = ?').get(id);
  if (!existing) return httpError(res, 404, 'Payment not found.');
  const body = req.body || {};
  const v = paymentValidation(db, body, { excludePaymentId: id });
  if (Object.keys(v.errors).length) return res.status(400).json({ errors: v.errors });
  try {
    db.prepare(`UPDATE PaymentDb SET control_number=?, record_id=?, date_process=?, relative_name=?, relative_address=?, contact_number=?,
      deceased_relation=?, relative_relation=?, age=?, amount_cents=?, cedula_number=?, cedula_date=?, cedula_place=?, or_number=?, or_date=?, or_place=?, remarks=?, updated_by=?, updated_at=?
      WHERE payment_id=?`)
      .run(v.record.control_number, v.record.record_id, body.date_process, String(body.relative_name).trim(),
        body.relative_address || null, body.contact_number || null, body.deceased_relation || null, body.relative_relation || null,
        v.age, v.amount, body.cedula_number || null, body.cedula_date || null, body.cedula_place || null,
        body.or_number || null, body.or_date || null, body.or_place || null, body.remarks || null,
        req.user.username, nowIso(), id);
    audit(req, 'payment.update', 'PaymentDb', id, { control_number: v.record.control_number, amount_cents: v.amount });
    const row = db.prepare('SELECT * FROM PaymentDb WHERE payment_id = ?').get(id);
    const record = db.prepare(`${RECORD_SELECT} WHERE m.record_id = ?`).get(v.record.record_id);
    res.json({ ok: true, payment: mapPayment(row), record: rowToRecord(record) });
  } catch (e) { return httpError(res, 500, 'Could not update payment: ' + e.message); }
});

app.delete('/api/payments/:id', requireAuth, requirePermission('payments:delete'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const db = getDb();
  const existing = db.prepare('SELECT * FROM PaymentDb WHERE payment_id = ?').get(id);
  if (!existing) return httpError(res, 404, 'Payment not found.');
  db.prepare('DELETE FROM PaymentDb WHERE payment_id = ?').run(id);
  audit(req, 'payment.delete', 'PaymentDb', id, { control_number: existing.control_number, amount_cents: existing.amount_cents });
  const record = db.prepare(`${RECORD_SELECT} WHERE m.record_id = ?`).get(existing.record_id);
  res.json({ ok: true, record: record ? rowToRecord(record) : null });
});

app.get('/api/payments/history/:controlNumber', requireAuth, (req, res) => {
  const cn = req.params.controlNumber;
  const db = getDb();
  const record = db.prepare(`${RECORD_SELECT} WHERE m.control_number = ?`).get(cn);
  if (!record) return httpError(res, 404, 'Record not found.');
  const rows = db.prepare('SELECT * FROM PaymentDb WHERE control_number = ? ORDER BY date_process DESC, payment_id DESC').all(cn);
  const rec = rowToRecord(record);
  res.json({
    record: rec,
    payments: rows.map(mapPayment),
    summary: {
      total_cents: rec.total_cents,
      total: rec.total,
      paid_cents: rec.paid_cents,
      paid: rec.paid,
      balance_cents: rec.balance_cents,
      balance: rec.balance,
      transaction_count: rows.length,
      latest_payment_date: rows.length ? rows[0].date_process : null,
    },
  });
});

// ======================= DASHBOARD =======================
app.get('/api/dashboard', requireAuth, (req, res) => {
  const db = getDb();
  const agg = db.prepare(`
    SELECT COUNT(*) AS total_records,
           SUM(CASE WHEN indigent = 'Yes' THEN 1 ELSE 0 END) AS indigent_records,
           SUM(CASE WHEN indigent = 'No' THEN 1 ELSE 0 END) AS non_indigent_records,
           SUM(CASE WHEN indigent = 'No' AND payment_method = 'Installment' THEN 1 ELSE 0 END) AS installment_accounts,
           SUM(CASE WHEN indigent = 'No' AND payment_method = 'Full Payment (Cash)' THEN 1 ELSE 0 END) AS full_payment_accounts,
           SUM(CASE WHEN indigent = 'Yes' THEN 0 ELSE total_cents END) AS total_due_cents,
           COALESCE((SELECT SUM(amount_cents) FROM PaymentDb), 0) AS total_collected_cents,
           SUM(CASE WHEN indigent = 'Yes' THEN 0 ELSE
               MAX(total_cents - COALESCE((SELECT SUM(amount_cents) FROM PaymentDb p2 WHERE p2.control_number = MainDb.control_number), 0), 0)
               END) AS outstanding_cents
    FROM MainDb`).get();
  const today = todayStr();
  const paymentsToday = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(amount_cents),0) s FROM PaymentDb WHERE date_process = ?').get(today);

  const byBurial = db.prepare('SELECT burial_type, COUNT(*) c FROM MainDb GROUP BY burial_type ORDER BY c DESC').all();
  const monthly = db.prepare(`
    SELECT substr(date_process, 1, 7) AS month, SUM(amount_cents) AS cents, COUNT(*) AS cnt
    FROM PaymentDb GROUP BY month ORDER BY month DESC LIMIT 24`).all().reverse();
  const byStatus = db.prepare(`
    SELECT CASE
             WHEN m.indigent = 'Yes' THEN 'Indigent'
             WHEN COALESCE(p.paid, 0) <= 0 THEN 'Unpaid'
             WHEN COALESCE(p.paid, 0) >= m.total_cents THEN 'Paid'
             ELSE 'Partial' END AS status, COUNT(*) AS c
    FROM MainDb m LEFT JOIN (SELECT control_number, SUM(amount_cents) paid FROM PaymentDb GROUP BY control_number) p
      ON p.control_number = m.control_number GROUP BY status`).all();

  res.json({
    cards: {
      total_records: agg.total_records || 0,
      indigent_records: agg.indigent_records || 0,
      non_indigent_records: agg.non_indigent_records || 0,
      installment_accounts: agg.installment_accounts || 0,
      full_payment_accounts: agg.full_payment_accounts || 0,
      total_due_cents: agg.total_due_cents || 0,
      total_due: money(agg.total_due_cents || 0),
      total_collected_cents: agg.total_collected_cents || 0,
      total_collected: money(agg.total_collected_cents || 0),
      outstanding_cents: agg.outstanding_cents || 0,
      outstanding: money(agg.outstanding_cents || 0),
      payments_today_count: paymentsToday.c,
      payments_today_amount: money(paymentsToday.s),
    },
    charts: {
      by_burial_type: byBurial.map(r => ({ label: r.burial_type, value: r.c })),
      monthly_collections: monthly.map(r => ({ label: r.month, value: r.cents / 100, count: r.cnt })),
      by_status: byStatus.map(r => ({ label: r.status, value: r.c })),
    },
  });
});

// ======================= REPORTS =======================
// Shared record-filter builder used by reports + CSV export
function buildRecordFilter(q) {
  const where = [], params = [];
  if (q.control_number) { where.push('m.control_number = ?'); params.push(q.control_number); }
  if (q.search) { const like = `%${q.search}%`; where.push('(m.deceased_name LIKE ? OR m.control_number LIKE ?)'); params.push(like, like); }
  if (q.burial_type) { where.push('m.burial_type = ?'); params.push(q.burial_type); }
  if (q.indigent) { where.push('m.indigent = ?'); params.push(q.indigent); }
  if (q.payment_method) { where.push('m.payment_method = ?'); params.push(q.payment_method); }
  if (q.date_from && /^\d{4}-\d{2}-\d{2}$/.test(q.date_from)) { where.push('m.date_of_burial >= ?'); params.push(q.date_from); }
  if (q.date_to && /^\d{4}-\d{2}-\d{2}$/.test(q.date_to)) { where.push('m.date_of_burial <= ?'); params.push(q.date_to); }
  if (q.status === 'Paid') where.push("m.indigent = 'No' AND m.total_cents > 0 AND COALESCE(p.paid_cents,0) >= m.total_cents");
  else if (q.status === 'Partial') where.push("m.indigent = 'No' AND COALESCE(p.paid_cents,0) > 0 AND COALESCE(p.paid_cents,0) < m.total_cents");
  else if (q.status === 'Unpaid') where.push("m.indigent = 'No' AND COALESCE(p.paid_cents,0) = 0");
  else if (q.status === 'Indigent') where.push("m.indigent = 'Yes'");
  return { whereSql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

function fetchFilteredRecords(q) {
  const db = getDb();
  const { whereSql, params } = buildRecordFilter(q);
  return db.prepare(`SELECT * FROM (${RECORD_SELECT}) ${whereSql} ORDER BY control_number DESC`).all(...params).map(rowToRecord);
}

function buildPaymentFilter(q) {
  const where = [], params = [];
  if (q.control_number) { where.push('p.control_number = ?'); params.push(q.control_number); }
  if (q.search) { const like = `%${q.search}%`; where.push('(p.relative_name LIKE ? OR p.or_number LIKE ? OR p.control_number LIKE ?)'); params.push(like, like, like); }
  if (q.date_from && /^\d{4}-\d{2}-\d{2}$/.test(q.date_from)) { where.push('p.date_process >= ?'); params.push(q.date_from); }
  if (q.date_to && /^\d{4}-\d{2}-\d{2}$/.test(q.date_to)) { where.push('p.date_process <= ?'); params.push(q.date_to); }
  return { whereSql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

function fetchFilteredPayments(q) {
  const db = getDb();
  const { whereSql, params } = buildPaymentFilter(q);
  return db.prepare(`SELECT p.* FROM PaymentDb p ${whereSql} ORDER BY p.date_process DESC, p.payment_id DESC`).all(...params);
}

app.get('/api/reports/:type', requireAuth, (req, res) => {
  const type = req.params.type;
  const q = req.query;
  const db = getDb();
  let title = '', recordRows = [], paymentRows = [], summary = {};

  const recordTypes = ['complete', 'by-burial-type', 'indigent', 'installment', 'full-payment', 'paid', 'partial', 'unpaid', 'outstanding', 'history'];
  const paymentTypes = ['transactions', 'or-transactions', 'collection-summary'];

  if (type === 'history') {
    const cn = q.control_number;
    if (!cn) return httpError(res, 400, 'Control Number is required for the payment history report.');
    const record = db.prepare(`${RECORD_SELECT} WHERE m.control_number = ?`).get(cn);
    if (!record) return httpError(res, 404, 'Record not found.');
    const rec = rowToRecord(record);
    paymentRows = db.prepare('SELECT * FROM PaymentDb WHERE control_number = ? ORDER BY date_process ASC, payment_id ASC').all(cn);
    summary = { total: rec.total, paid: rec.paid, balance: rec.balance, transaction_count: paymentRows.length };
    title = `Payment History - ${cn} - ${rec.deceased_name}`;
  } else if (recordTypes.includes(type)) {
    let qq = { ...q };
    if (type === 'indigent') qq.indigent = 'Yes';
    if (type === 'installment') qq.payment_method = 'Installment';
    if (type === 'full-payment') qq.payment_method = 'Full Payment (Cash)';
    if (type === 'paid') qq.status = 'Paid';
    if (type === 'partial') qq.status = 'Partial';
    if (type === 'unpaid') qq.status = 'Unpaid';
    recordRows = fetchFilteredRecords(qq);
    const totals = recordRows.reduce((a, r) => ({ total: a.total + r.total_cents, paid: a.paid + r.paid_cents, balance: a.balance + r.balance_cents }), { total: 0, paid: 0, balance: 0 });
    summary = {
      count: recordRows.length,
      total: money(totals.total), paid: money(totals.paid), balance: money(totals.balance),
    };
    if (type === 'outstanding') recordRows = recordRows.filter(r => r.balance_cents > 0);
    if (type === 'by-burial-type') {
      const groups = {};
      for (const r of recordRows) {
        const g = groups[r.burial_type] || (groups[r.burial_type] = { burial_type: r.burial_type, count: 0, total_cents: 0, paid_cents: 0, balance_cents: 0 });
        g.count++; g.total_cents += r.total_cents; g.paid_cents += r.paid_cents; g.balance_cents += r.balance_cents;
      }
      return res.json({ title: 'Cemetery Records by Burial Type', group_rows: Object.values(groups).map(g => ({ ...g, total: money(g.total_cents), paid: money(g.paid_cents), balance: money(g.balance_cents) })), summary });
    }
    title = {
      complete: 'Complete Cemetery Records',
      indigent: 'Indigent Records',
      installment: 'Installment Accounts',
      'full-payment': 'Full Payment Accounts',
      paid: 'Paid Records',
      partial: 'Partial Payment Records',
      unpaid: 'Unpaid Records',
      outstanding: 'Outstanding Balances',
    }[type] || 'Report';
  } else if (type === 'transactions') {
    paymentRows = fetchFilteredPayments(q);
    const sum = paymentRows.reduce((a, p) => a + p.amount_cents, 0);
    summary = { count: paymentRows.length, paid: money(sum) };
    title = 'Payment Transactions';
  } else if (type === 'or-transactions') {
    paymentRows = fetchFilteredPayments(q).filter(p => p.or_number);
    const sum = paymentRows.reduce((a, p) => a + p.amount_cents, 0);
    summary = { count: paymentRows.length, paid: money(sum) };
    title = 'Official Receipt Transactions';
  } else if (type === 'collection-summary') {
    const by = q.group_by === 'year' ? 'substr(date_process, 1, 4)' : 'substr(date_process, 1, 7)';
    const { whereSql, params } = buildPaymentFilter(q);
    const rows = db.prepare(`SELECT ${by} AS period, COUNT(*) cnt, SUM(amount_cents) cents FROM PaymentDb p ${whereSql} GROUP BY period ORDER BY period`).all(...params);
    const sum = rows.reduce((a, r) => a + r.cents, 0);
    summary = { count: rows.reduce((a, r) => a + r.cnt, 0), paid: money(sum) };
    title = q.group_by === 'year' ? 'Collection Summary by Year' : 'Collection Summary by Month';
    return res.json({ title, collection_rows: rows.map(r => ({ period: r.period, count: r.cnt, amount: money(r.cents) })), summary });
  } else {
    return httpError(res, 404, 'Unknown report type: ' + type);
  }
  res.json({ title, records: recordRows, payments: paymentRows, summary });
});

// ======================= CSV EXPORT =======================
const CSV_HEADERS = {
  records: ['Control Number', 'Deceased Name', 'Date of Death', 'Date of Burial', 'Burial Type', 'Indigent', 'Payment Method', 'Total Amount', 'Total Amount Paid', 'Balance', 'Latest Date Process', 'Latest Remarks'],
  payments: ['Payment ID', 'Control Number', 'Date Process', 'Relative Name', 'Relative Address', 'Contact Number', 'Deceased Relation', 'Relative Relation', 'Amount Paid', 'Cedula Number (CTC)', 'Cedula Date', 'Cedula Place', 'OR Number', 'OR Date', 'OR Place', 'Remarks', 'Age'],
  users: ['User ID', 'Full Name', 'Username', 'Role', 'Account Status', 'Date Created'],
};

app.get('/api/export/csv/:entity', requireAuth, requirePermission('export:csv'), (req, res) => {
  const entity = req.params.entity;
  const scope = req.query.scope === 'filtered' ? 'filtered' : 'all';
  const db = getDb();
  let headers, rows, fileName;
  if (entity === 'records') {
    const recs = scope === 'filtered' ? fetchFilteredRecords(req.query) : db.prepare(`SELECT * FROM (${RECORD_SELECT}) ORDER BY control_number DESC`).all().map(rowToRecord);
    headers = CSV_HEADERS.records;
    rows = recs.map(r => [
      r.control_number, r.deceased_name, csv.formatUsDate(r.date_of_death), csv.formatUsDate(r.date_of_burial),
      r.burial_type, r.indigent, r.payment_method, csv.centsToPlain(r.total_cents), csv.centsToPlain(r.paid_cents),
      csv.centsToPlain(r.balance_cents), csv.formatUsDate(r.latest_date_process), r.latest_remarks || '',
    ]);
    fileName = 'mpdo_cemetery_records.csv';
  } else if (entity === 'payments') {
    const pays = scope === 'filtered' ? fetchFilteredPayments(req.query) : db.prepare('SELECT * FROM PaymentDb ORDER BY payment_id').all();
    headers = CSV_HEADERS.payments;
    rows = pays.map(p => [
      p.payment_id, p.control_number, p.date_process, p.relative_name, p.relative_address || '', p.contact_number || '',
      p.deceased_relation || '', p.relative_relation || '', csv.centsToPlain(p.amount_cents),
      p.cedula_number || '', csv.formatUsDate(p.cedula_date), p.cedula_place || '',
      p.or_number || '', csv.formatUsDate(p.or_date), p.or_place || '', p.remarks || '', (p.age === null || p.age === undefined) ? '' : p.age,
    ]);
    fileName = 'mpdo_payment_transactions.csv';
  } else if (entity === 'users') {
    if (req.user.role !== 'Administrator') return httpError(res, 403, 'Only administrators can export user accounts.');
    const users = db.prepare('SELECT user_id, full_name, username, role, account_status, date_created FROM LoginDb ORDER BY user_id').all();
    headers = CSV_HEADERS.users; // never includes password hashes
    rows = users.map(u => [u.user_id, u.full_name, u.username, u.role, u.account_status, csv.formatUsDate(u.date_created)]);
    fileName = 'mpdo_user_accounts.csv';
  } else {
    return httpError(res, 404, 'Unknown export entity: ' + entity);
  }
  audit(req, 'export.csv', entity, null, { scope, count: rows.length });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.send(csv.toCsv(headers, rows));
});

// ======================= CSV IMPORT =======================
const IMPORT_HEADERS = {
  records: CSV_HEADERS.records,
  payments: CSV_HEADERS.payments,
};

app.get('/api/import/templates/:entity', requireAuth, (req, res) => {
  const entity = req.params.entity;
  if (!IMPORT_HEADERS[entity]) return httpError(res, 404, 'Unknown template: ' + entity);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="mpdo_template_${entity}.csv"`);
  res.send(csv.toCsv(IMPORT_HEADERS[entity], []));
});

// Auto-map header names to field keys (case/space-insensitive)
const RECORD_FIELD_MAP = {
  'control number': 'control_number', 'controlnumber': 'control_number', 'control#': 'control_number',
  'deceased name': 'deceased_name', 'name': 'deceased_name',
  'date of death': 'date_of_death', 'date of burial': 'date_of_burial',
  'burial type': 'burial_type', 'indigent': 'indigent', 'payment method': 'payment_method',
  'total amount': 'total_cents', 'total amount paid': 'paid_display',
  'balance': 'balance_display', 'latest date process': 'latest_display', 'latest remarks': 'latest_remarks',
};
const PAYMENT_FIELD_MAP = {
  'payment id': 'payment_id', 'control number': 'control_number', 'date process': 'date_process',
  'relative name': 'relative_name', 'relative address': 'relative_address', 'contact number': 'contact_number',
  'deceased relation': 'deceased_relation', 'relative relation': 'relative_relation', 'amount paid': 'amount_cents',
  'cedula number (ctc)': 'cedula_number', 'cedula number': 'cedula_number', 'ctc number': 'cedula_number',
  'cedula date': 'cedula_date', 'cedula place': 'cedula_place',
  'or number': 'or_number', 'or date': 'or_date', 'or place': 'or_place', 'remarks': 'remarks', 'age': 'age',
};

function autoMap(headers, kind) {
  const dict = kind === 'records' ? RECORD_FIELD_MAP : PAYMENT_FIELD_MAP;
  return headers.map(h => dict[String(h).trim().toLowerCase()] || '');
}

app.post('/api/import/preview', requireAuth, requirePermission('import:csv'), (req, res) => {
  const { entity, csv_text, mapping } = req.body || {};
  if (!IMPORT_HEADERS[entity]) return httpError(res, 400, 'Entity must be "records" or "payments".');
  if (!csv_text || typeof csv_text !== 'string') return httpError(res, 400, 'csv_text is required.');
  const parsed = csv.parseCsv(csv_text);
  if (parsed.length < 2) return httpError(res, 400, 'The CSV file has no data rows.');
  const headers = parsed[0];
  const auto = autoMap(headers, entity);
  const map = Array.isArray(mapping) && mapping.length === headers.length ? mapping : auto;
  const rowsRaw = parsed.slice(1);
  const validated = entity === 'records'
    ? validateImportRecords(rowsRaw, map)
    : validateImportPayments(rowsRaw, map);
  res.json({ headers, auto_map: auto, mapping: map, ...validated });
});

function validateImportRecords(rowsRaw, map) {
  const db = getDb();
  const idx = (field) => map.indexOf(field);
  const iCN = idx('control_number'), iName = idx('deceased_name'), iDOD = idx('date_of_death'), iDOB = idx('date_of_burial'),
    iBT = idx('burial_type'), iInd = idx('indigent'), iPM = idx('payment_method'), iTotal = idx('total_cents');
  const seen = new Set();
  const rows = [];
  const errors = [];
  let duplicates = 0;
  rowsRaw.forEach((r, i) => {
    const rowNo = i + 2; // 1-based incl header
    const cn = (r[iCN] || '').trim();
    const rowErrors = [];
    if (!cn) rowErrors.push({ row: rowNo, field: 'Control Number', reason: 'Control Number is empty.' });
    else if (!/^\d{4}-\d{1,6}$/.test(cn)) rowErrors.push({ row: rowNo, field: 'Control Number', reason: `"${cn}" does not follow the YYYY-001 format.` });
    else if (seen.has(cn)) { duplicates++; rowErrors.push({ row: rowNo, field: 'Control Number', reason: `Duplicate Control Number "${cn}" inside the CSV file.` }); }
    else seen.add(cn);
    const name = (r[iName] || '').trim();
    if (!name) rowErrors.push({ row: rowNo, field: 'Deceased Name', reason: 'Deceased Name is required.' });
    const burialType = (r[iBT] || '').trim();
    if (!BURIAL_TYPES.includes(burialType)) rowErrors.push({ row: rowNo, field: 'Burial Type', reason: `"${burialType}" is not one of the six supported burial types.` });
    const indigent = (r[iInd] || '').trim();
    if (!['Yes', 'No'].includes(indigent)) rowErrors.push({ row: rowNo, field: 'Indigent', reason: `Indigent must be Yes or No (got "${indigent}").` });
    let pm = (r[iPM] || '').trim();
    if (indigent === 'Yes') pm = 'N/A';
    else if (!['Installment', 'Full Payment (Cash)'].includes(pm)) rowErrors.push({ row: rowNo, field: 'Payment Method', reason: `Payment Method must be Installment or Full Payment (Cash) (got "${pm}").` });
    const dod = iDOD >= 0 ? csv.parseDateToIso(r[iDOD]) : null;
    if (iDOD >= 0 && (r[iDOD] || '').trim() && !dod) rowErrors.push({ row: rowNo, field: 'Date of Death', reason: `Invalid date "${r[iDOD]}".` });
    const dob = iDOB >= 0 ? csv.parseDateToIso(r[iDOB]) : null;
    if (iDOB >= 0 && (r[iDOB] || '').trim() && !dob) rowErrors.push({ row: rowNo, field: 'Date of Burial', reason: `Invalid date "${r[iDOB]}".` });
    // Total amount: default to pricing rule when blank; validate against rule when provided
    let totalCents;
    if (indigent === 'Yes') totalCents = 0;
    else if (iTotal >= 0 && String(r[iTotal] || '').trim() !== '') {
      totalCents = csv.parseMoneyToCents(r[iTotal]);
      if (totalCents === null) { rowErrors.push({ row: rowNo, field: 'Total Amount', reason: `"${r[iTotal]}" is not a valid amount.` }); totalCents = computeTotalCents(burialType, indigent, pm); }
      else if (totalCents !== computeTotalCents(burialType, indigent, pm)) {
        rowErrors.push({ row: rowNo, field: 'Total Amount', reason: `Total ${csv.centsToPlain(totalCents)} does not match the pricing rule (${csv.centsToPlain(computeTotalCents(burialType, indigent, pm))}) for this burial type/payment method.` });
      }
    } else totalCents = computeTotalCents(burialType, indigent, pm);

    const exists = cn ? db.prepare('SELECT record_id FROM MainDb WHERE control_number = ?').get(cn) : null;
    if (rowErrors.length) { errors.push(...rowErrors); return; }
    rows.push({ row_no: rowNo, control_number: cn, deceased_name: name, date_of_death: dod, date_of_burial: dob, burial_type: burialType, indigent, payment_method: pm, total_cents: totalCents, mode: exists ? 'update' : 'add' });
  });
  return {
    rows,
    errors,
    stats: { valid: rows.length, invalid: errors.length ? new Set(errors.map(e => e.row)).size : 0, duplicates, ready: rows.length },
  };
}

function validateImportPayments(rowsRaw, map) {
  const db = getDb();
  const idx = (field) => map.indexOf(field);
  const iPID = idx('payment_id'), iCN = idx('control_number'), iDP = idx('date_process'), iRN = idx('relative_name'),
    iRA = idx('relative_address'), iCT = idx('contact_number'), iDR = idx('deceased_relation'), iRR = idx('relative_relation'),
    iAmt = idx('amount_cents'), iCedN = idx('cedula_number'), iCedD = idx('cedula_date'), iCedP = idx('cedula_place'),
    iORN = idx('or_number'), iORD = idx('or_date'), iORP = idx('or_place'), iRem = idx('remarks'), iAge = idx('age');
  const rows = [], errors = [];
  let duplicates = 0;
  const seenKeys = new Set();
  rowsRaw.forEach((r, i) => {
    const rowNo = i + 2;
    const rowErrors = [];
    const cn = (r[iCN] || '').trim();
    if (!cn) rowErrors.push({ row: rowNo, field: 'Control Number', reason: 'Control Number is required.' });
    else if (!/^\d{4}-\d{1,6}$/.test(cn)) rowErrors.push({ row: rowNo, field: 'Control Number', reason: `"${cn}" does not follow the YYYY-001 format.` });
    const pidRaw = iPID >= 0 ? String(r[iPID] || '').trim() : '';
    const dp = iDP >= 0 ? csv.parseDateToIso(r[iDP]) : null;
    if (!dp) rowErrors.push({ row: rowNo, field: 'Date Process', reason: `Invalid or missing Date Process "${(r[iDP] || '').trim()}".` });
    const rn = (r[iRN] || '').trim();
    if (!rn) rowErrors.push({ row: rowNo, field: 'Relative Name', reason: 'Relative Name is required.' });
    const amt = iAmt >= 0 ? csv.parseMoneyToCents(r[iAmt]) : null;
    if (amt === null) rowErrors.push({ row: rowNo, field: 'Amount Paid', reason: `Amount Paid must be a valid number (got "${(r[iAmt] || '').trim()}").` });
    else if (amt < 0) rowErrors.push({ row: rowNo, field: 'Amount Paid', reason: 'Amount Paid cannot be negative.' });
    else if (amt === 0 && cn) {
      const amtRec = db.prepare('SELECT indigent FROM MainDb WHERE control_number = ?').get(cn);
      if (!amtRec || amtRec.indigent !== 'Yes') rowErrors.push({ row: rowNo, field: 'Amount Paid', reason: 'Amount Paid must be greater than zero for non-indigent records.' });
    }
    const cedD = iCedD >= 0 ? (String(r[iCedD] || '').trim() ? csv.parseDateToIso(r[iCedD]) : null) : null;
    if (iCedD >= 0 && String(r[iCedD] || '').trim() && !cedD) rowErrors.push({ row: rowNo, field: 'Cedula Date', reason: `Invalid date "${r[iCedD]}".` });
    const orD = iORD >= 0 ? (String(r[iORD] || '').trim() ? csv.parseDateToIso(r[iORD]) : null) : null;
    if (iORD >= 0 && String(r[iORD] || '').trim() && !orD) rowErrors.push({ row: rowNo, field: 'OR Date', reason: `Invalid date "${r[iORD]}".` });
    let ageVal = null;
    if (iAge >= 0 && String(r[iAge] || '').trim() !== '') {
      const an = Number(String(r[iAge]).trim());
      if (!Number.isInteger(an) || an < 0 || an > 150) rowErrors.push({ row: rowNo, field: 'Age', reason: `Age must be a whole number between 0 and 150 (got "${r[iAge]}").` });
      else ageVal = an;
    }
    // duplicate detection: explicit Payment ID, or (control_number, date, amount, OR number)
    const dupKey = pidRaw ? `pid:${pidRaw}` : `ck:${cn}|${dp}|${amt}|${(r[iORN] || '').trim()}`;
    if (seenKeys.has(dupKey)) { duplicates++; rowErrors.push({ row: rowNo, field: 'Payment', reason: 'Duplicate payment inside the CSV file.' }); }
    else seenKeys.add(dupKey);
    if (rowErrors.length) { errors.push(...rowErrors); return; }
    rows.push({
      row_no: rowNo, payment_id: pidRaw ? parseInt(pidRaw, 10) : null,
      control_number: cn, date_process: dp, relative_name: rn,
      relative_address: (r[iRA] || '').trim() || null, contact_number: (r[iCT] || '').trim() || null,
      deceased_relation: (r[iDR] || '').trim() || null, relative_relation: (r[iRR] || '').trim() || null,
      age: ageVal, amount_cents: amt, cedula_number: (r[iCedN] || '').trim() || null, cedula_date: cedD, cedula_place: (r[iCedP] || '').trim() || null,
      or_number: (r[iORN] || '').trim() || null, or_date: orD, or_place: (r[iORP] || '').trim() || null,
      remarks: (r[iRem] || '').trim() || null,
    });
  });
  return { rows, errors, stats: { valid: rows.length, invalid: errors.length ? new Set(errors.map(e => e.row)).size : 0, duplicates, ready: rows.length } };
}

// Import commit - single transaction, modes: add | update | replace
app.post('/api/import/commit', requireAuth, requirePermission('import:csv'), (req, res) => {
  const { entity, rows, mode, errors } = req.body || {};
  if (!['records', 'payments'].includes(entity)) return httpError(res, 400, 'Invalid entity.');
  if (!Array.isArray(rows) || rows.length === 0) return httpError(res, 400, 'No valid rows to import.');
  if (!['add', 'update', 'replace'].includes(mode)) return httpError(res, 400, 'Mode must be add, update, or replace.');
  if (Array.isArray(errors) && errors.length > 0) return httpError(res, 400, 'Fix all validation errors in the CSV before importing.');
  const db = getDb();
  let backupPath = null;
  try {
    if (mode === 'replace') {
      // Require an automatic safety backup first
      backupPath = createAutomaticBackup('before-replace-import');
    }
    const summary = db.transaction(() => {
      const s = { added: 0, updated: 0, skipped: 0, errors: [] };
      if (mode === 'replace') {
        if (entity === 'records') {
          db.prepare('DELETE FROM PaymentDb').run();
          db.prepare('DELETE FROM MainDb').run();
        } else {
          db.prepare('DELETE FROM PaymentDb').run();
        }
      }
      if (entity === 'records') {
        const insert = db.prepare(`INSERT INTO MainDb (control_number, deceased_name, date_of_death, date_of_burial, burial_type, indigent, payment_method, total_cents, created_by, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
        const update = db.prepare(`UPDATE MainDb SET deceased_name=?, date_of_death=?, date_of_burial=?, burial_type=?, indigent=?, payment_method=?, total_cents=?, updated_by=?, updated_at=?
          WHERE control_number=?`);
        for (const r of rows) {
          const exists = db.prepare('SELECT record_id, total_cents FROM MainDb WHERE control_number = ?').get(r.control_number);
          // Recalculate total by current pricing rules (imported values must follow the rules; blank -> computed)
          const total = r.indigent === 'Yes' ? 0 : (r.total_cents != null ? r.total_cents : computeTotalCents(r.burial_type, r.indigent, r.payment_method));
          if (exists) {
            if (mode === 'add') { s.skipped++; continue; }
            // update must not break existing payments
            const paid = db.prepare('SELECT COALESCE(SUM(amount_cents),0) x FROM PaymentDb WHERE control_number = ?').get(r.control_number).x;
            if (total < paid) { s.errors.push({ row: r.row_no, field: 'Total Amount', reason: `Total ${csv.centsToPlain(total)} is less than paid ${csv.centsToPlain(paid)}; skipped.` }); s.skipped++; continue; }
            update.run(r.deceased_name, r.date_of_death, r.date_of_burial, r.burial_type, r.indigent, r.payment_method, total, req.user.username, nowIso(), r.control_number);
            s.updated++;
          } else {
            if (mode === 'update') { s.skipped++; continue; }
            insert.run(r.control_number, r.deceased_name, r.date_of_death, r.date_of_burial, r.burial_type, r.indigent, r.payment_method, total, req.user.username, nowIso(), nowIso());
            s.added++;
            // keep the yearly sequence counter ahead of imported numbers
            const year = parseInt(r.control_number.slice(0, 4), 10);
            const seq = parseInt(r.control_number.slice(5), 10);
            if (!isNaN(year) && !isNaN(seq)) {
              db.prepare('INSERT INTO SequenceDb (year, last_number) VALUES (?, ?) ON CONFLICT(year) DO UPDATE SET last_number = MAX(last_number, excluded.last_number)').run(year, seq);
            }
          }
        }
      } else {
        const insert = db.prepare(`INSERT INTO PaymentDb (record_id, control_number, date_process, relative_name, relative_address, contact_number,
          deceased_relation, relative_relation, age, amount_cents, cedula_number, cedula_date, cedula_place, or_number, or_date, or_place, remarks, created_by, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        const update = db.prepare(`UPDATE PaymentDb SET control_number=?, date_process=?, relative_name=?, relative_address=?, contact_number=?,
          deceased_relation=?, relative_relation=?, age=?, amount_cents=?, cedula_number=?, cedula_date=?, cedula_place=?, or_number=?, or_date=?, or_place=?, remarks=?, updated_by=?, updated_at=?
          WHERE payment_id=?`);
        for (const r of rows) {
          const rec = db.prepare('SELECT record_id, indigent FROM MainDb WHERE control_number = ?').get(r.control_number);
          if (!rec) { s.errors.push({ row: r.row_no, field: 'Control Number', reason: `Control Number "${r.control_number}" does not exist; payment rejected.` }); continue; }
          // indigent records may hold payment details; OR fields simply stay empty
          const existing = r.payment_id ? db.prepare('SELECT payment_id, control_number FROM PaymentDb WHERE payment_id = ?').get(r.payment_id) : null;
          if (existing) {
            if (mode === 'add') { s.skipped++; continue; }
            update.run(r.control_number, r.date_process, r.relative_name, r.relative_address, r.contact_number,
              r.deceased_relation, r.relative_relation, r.age, r.amount_cents, r.cedula_number, r.cedula_date, r.cedula_place,
              r.or_number, r.or_date, r.or_place, r.remarks, req.user.username, nowIso(), r.payment_id);
            s.updated++;
          } else {
            if (mode === 'update') { s.skipped++; continue; }
            // balance check at import time
            if (rec.indigent !== 'Yes') {
              const total = db.prepare('SELECT total_cents FROM MainDb WHERE control_number = ?').get(r.control_number).total_cents;
              const paid = db.prepare('SELECT COALESCE(SUM(amount_cents),0) x FROM PaymentDb WHERE control_number = ?').get(r.control_number).x;
              if (paid + r.amount_cents > total) { s.errors.push({ row: r.row_no, field: 'Amount Paid', reason: `Payment would exceed the balance (${csv.centsToPlain(total - paid)} remaining); rejected.` }); continue; }
            }
            insert.run(rec.record_id, r.control_number, r.date_process, r.relative_name, r.relative_address, r.contact_number,
              r.deceased_relation, r.relative_relation, r.age, r.amount_cents, r.cedula_number, r.cedula_date, r.cedula_place,
              r.or_number, r.or_date, r.or_place, r.remarks, req.user.username, nowIso(), nowIso());
            s.added++;
          }
        }
      }
      if (s.errors.length) { const e = new Error('IMPORT_ROLLBACK'); e.summary = s; throw e; }
      return s;
    })();
    audit(req, 'import.csv', entity, null, { mode, added: summary.added, updated: summary.updated, skipped: summary.skipped });
    res.json({ ok: true, summary, backup_path: backupPath });
  } catch (e) {
    if (e.message === 'IMPORT_ROLLBACK') {
      return res.status(400).json({ ok: false, rolled_back: true, summary: e.summary, error: `Import rolled back: ${e.summary.errors.length} row error(s). No data was changed.` });
    }
    return httpError(res, 500, 'Import failed and was rolled back: ' + e.message);
  }
});

// ======================= BACKUP & RESTORE =======================
function listBackupsIn(dir) {
  try {
    return fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.db')).map(f => {
      const st = fs.statSync(path.join(dir, f));
      return { name: f, path: path.join(dir, f), size: st.size, mtime: st.mtime.toISOString() };
    }).sort((a, b) => b.mtime.localeCompare(a.mtime));
  } catch (e) { return []; }
}

function createAutomaticBackup(tag) {
  const dir = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const dest = path.join(dir, `mpdo_${tag || 'backup'}_${stamp}.db`);
  // synchronous copy via SQLite VACUUM INTO (consistent snapshot even while open)
  getDb().exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  setSettingSync('last_backup', JSON.stringify({ date: nowIso(), path: dest, status: 'OK' }));
  return dest;
}

app.get('/api/backup/list', requireAuth, requirePermission('backup:manage'), (req, res) => {
  const dir = path.join(DATA_DIR, 'backups');
  res.json({ backups: listBackupsIn(dir), last_backup: getSettingSync('last_backup'), db_path: DB_PATH });
});

app.post('/api/backup/create', requireAuth, requirePermission('backup:manage'), (req, res) => {
  try {
    const destDir = (req.body && req.body.dest_dir ? String(req.body.dest_dir).trim() : '') || path.join(DATA_DIR, 'backups');
    fs.mkdirSync(destDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const dest = path.join(destDir, `mpdo_backup_${stamp}.db`);
    getDb().exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    const info = { date: nowIso(), path: dest, status: 'OK', size: fs.statSync(dest).size };
    setSettingSync('last_backup', JSON.stringify(info));
    audit(req, 'backup.create', 'database', null, { path: dest });
    res.json({ ok: true, backup: info });
  } catch (e) { return httpError(res, 500, 'Backup failed: ' + e.message); }
});

function validateBackupFile(file) {
  const checks = [];
  if (!fs.existsSync(file)) return { valid: false, checks: [{ name: 'File exists', ok: false, detail: 'File not found.' }] };
  const stat = fs.statSync(file);
  if (stat.size < 4096) return { valid: false, checks: [{ name: 'File size', ok: false, detail: 'File is too small to be a valid database.' }] };
  const tmp = new (require('better-sqlite3'))(file, { readonly: true, fileMustExist: true });
  try {
    const sig = tmp.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    for (const t of ['MainDb', 'PaymentDb', 'LoginDb']) {
      checks.push({ name: `Table ${t}`, ok: sig.includes(t), detail: sig.includes(t) ? 'Present' : 'Missing' });
    }
    let integrity = 'unknown';
    try { integrity = tmp.pragma('integrity_check', { simple: true }); } catch (e) { integrity = e.message; }
    checks.push({ name: 'Integrity check', ok: integrity === 'ok', detail: String(integrity) });
    const counts = sig.includes('MainDb') ? {
      records: tmp.prepare('SELECT COUNT(*) c FROM MainDb').get().c,
      payments: tmp.prepare('SELECT COUNT(*) c FROM PaymentDb').get().c,
      users: tmp.prepare('SELECT COUNT(*) c FROM LoginDb').get().c,
    } : {};
    return { valid: checks.every(c => c.ok), checks, counts };
  } finally { tmp.close(); }
}

app.post('/api/backup/validate', requireAuth, requirePermission('restore:manage'), (req, res) => {
  const file = (req.body && req.body.path || '').trim();
  if (!file) return httpError(res, 400, 'path is required.');
  try { res.json(validateBackupFile(file)); } catch (e) { return httpError(res, 500, 'Validation failed: ' + e.message); }
});

app.post('/api/restore', requireAuth, requirePermission('restore:manage'), (req, res) => {
  const file = (req.body && req.body.path || '').trim();
  if (!file) return httpError(res, 400, 'path is required.');
  const v = validateBackupFile(file);
  if (!v.valid) return res.status(400).json({ error: 'The selected file is not a valid MPDO database backup.', checks: v.checks });
  try {
    const safety = createAutomaticBackup('before-restore');
    closeDb();
    try {
      fs.copyFileSync(file, DB_PATH);
      for (const suffix of ['-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + suffix); } catch (e) { /* ignore */ } }
    } finally {
      openDb();
    }
    setSettingSync('last_restore', JSON.stringify({ date: nowIso(), path: file, status: 'OK', backup_before_restore: safety }));
    audit(req, 'restore.database', 'database', null, { from: file, safety_backup: safety });
    res.json({ ok: true, restored_from: file, safety_backup: safety, counts: v.counts });
  } catch (e) {
    try { if (!getDb) openDb(); } catch (e2) { /* ignore */ }
    return httpError(res, 500, 'Restore failed: ' + e.message);
  }
});

app.get('/api/fs/list', requireAuth, requirePermission('backup:manage'), (req, res) => {
  const dir = (req.query.dir || DATA_DIR).trim();
  try {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) return httpError(res, 400, 'Not a directory.');
    const entries = fs.readdirSync(dir).slice(0, 500).map(name => {
      const st = fs.statSync(path.join(dir, name));
      return { name, is_dir: st.isDirectory(), size: st.size, mtime: st.mtime.toISOString() };
    });
    res.json({ dir, parent: path.dirname(dir), entries });
  } catch (e) { return httpError(res, 400, 'Cannot read directory: ' + e.message); }
});

// ======================= SETTINGS & AUDIT =======================
app.get('/api/settings', requireAuth, (req, res) => {
  res.json({
    pricing: getPricing(),
    burial_types: BURIAL_TYPES,
    payment_methods: PAYMENT_METHODS,
    db_path: DB_PATH,
    data_dir: DATA_DIR,
    last_backup: getSettingSync('last_backup'),
    last_restore: getSettingSync('last_restore'),
  });
});

app.put('/api/settings/pricing', requireAuth, requirePermission('settings:update'), (req, res) => {
  const pricing = req.body && req.body.pricing;
  if (!pricing || typeof pricing !== 'object') return httpError(res, 400, 'pricing object is required.');
  for (const bt of BURIAL_TYPES) {
    const row = pricing[bt];
    if (!row) return httpError(res, 400, `Missing pricing for "${bt}".`);
    for (const pm of ['Installment', 'Full Payment (Cash)']) {
      const val = Number(row[pm]);
      if (!isFinite(val) || val < 0) return httpError(res, 400, `Invalid price for ${bt} / ${pm}.`);
    }
  }
  const clean = {};
  for (const bt of BURIAL_TYPES) clean[bt] = { Installment: Math.round(pricing[bt].Installment), 'Full Payment (Cash)': Math.round(pricing[bt]['Full Payment (Cash)']) };
  setSettingSync('pricing', JSON.stringify(clean));
  audit(req, 'settings.pricing.update', 'SettingsDb', 'pricing', { pricing: clean });
  res.json({ ok: true, pricing: clean, note: 'New prices apply to new or explicitly recalculated records only. Existing records keep their stored Total Amount.' });
});

app.get('/api/audit', requireAuth, requirePermission('audit:view'), (req, res) => {
  const limit = Math.min(500, parseInt(req.query.limit, 10) || 200);
  const rows = getDb().prepare('SELECT * FROM AuditDb ORDER BY audit_id DESC LIMIT ?').all(limit);
  res.json({ entries: rows });
});

// ======================= STATIC SPA FALLBACK & BOOT =======================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error: ' + err.message });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`MPDO Cemetery Record System running at http://localhost:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
});

process.on('SIGTERM', () => { closeDb(); process.exit(0); });
process.on('SIGINT', () => { closeDb(); process.exit(0); });

module.exports = { app, server };
