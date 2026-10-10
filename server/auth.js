'use strict';
// auth.js - password hashing, sessions, role permissions, audit trail
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getDb, nowIso } = require('./db');

const SESSION_HOURS = 12;

// Permission matrix. Viewer = read-only, Staff = add/update records+payments,
// Admin = everything (users, deletes, import, backup/restore, settings).
const PERMISSIONS = {
  'records:create': ['Administrator', 'Staff'],
  'records:update': ['Administrator', 'Staff'],
  'records:delete': ['Administrator', 'Staff'],
  'records:recalculate': ['Administrator'],
  'payments:create': ['Administrator', 'Staff'],
  'payments:update': ['Administrator', 'Staff'],
  'payments:delete': ['Administrator', 'Staff'],
  'export:csv': ['Administrator', 'Staff'],
  'import:csv': ['Administrator'],
  'users:manage': ['Administrator'],
  'backup:manage': ['Administrator'],
  'restore:manage': ['Administrator'],
  'settings:update': ['Administrator'],
  'audit:view': ['Administrator'],
};

function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

function purgeExpiredSessions() {
  getDb().prepare('DELETE FROM SessionDb WHERE expires_at < ?').run(nowIso());
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const created = nowIso();
  const expires = new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString();
  getDb().prepare('INSERT INTO SessionDb (token, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(token, userId, created, expires);
  return { token, expires };
}

function destroySession(token) {
  getDb().prepare('DELETE FROM SessionDb WHERE token = ?').run(token);
}

function getUserFromToken(token) {
  if (!token) return null;
  const row = getDb().prepare(`
    SELECT u.user_id, u.full_name, u.username, u.role, u.account_status, s.expires_at
    FROM SessionDb s JOIN LoginDb u ON u.user_id = s.user_id
    WHERE s.token = ?`).get(token);
  if (!row) return null;
  if (row.expires_at < nowIso() || row.account_status !== 'Active') return null;
  return { userId: row.user_id, fullName: row.full_name, username: row.username, role: row.role };
}

function extractToken(req) {
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return null;
}

// Requires authentication. Populates req.user.
function requireAuth(req, res, next) {
  const user = getUserFromToken(extractToken(req));
  if (!user) return res.status(401).json({ error: 'Authentication required. Please sign in.' });
  req.user = user;
  next();
}

// Requires a specific permission for req.user's role.
function requirePermission(perm) {
  return (req, res, next) => {
    const allowed = PERMISSIONS[perm];
    if (!allowed) return res.status(500).json({ error: 'Unknown permission: ' + perm });
    if (!req.user || !allowed.includes(req.user.role)) {
      return res.status(403).json({ error: 'Your role (' + (req.user ? req.user.role : 'none') + ') is not authorized for this action.' });
    }
    next();
  };
}

function audit(req, action, entity, entityId, details) {
  const username = req && req.user ? req.user.username : (req && req.body && req.body.username) || 'system';
  try {
    getDb().prepare('INSERT INTO AuditDb (username, action, entity, entity_id, details, ts) VALUES (?,?,?,?,?,?)')
      .run(username, action, entity || null, entityId == null ? null : String(entityId), details ? JSON.stringify(details) : null, nowIso());
  } catch (e) { console.error('audit failed:', e.message); }
}

function activeAdminCount() {
  return getDb().prepare("SELECT COUNT(*) c FROM LoginDb WHERE role='Administrator' AND account_status='Active'").get().c;
}

module.exports = {
  hashPassword, verifyPassword, createSession, destroySession, getUserFromToken, extractToken,
  requireAuth, requirePermission, audit, activeAdminCount, purgeExpiredSessions, PERMISSIONS,
};
