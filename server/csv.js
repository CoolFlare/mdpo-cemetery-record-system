'use strict';
// csv.js - RFC4180 CSV parsing/serialization (UTF-8, proper escaping), used offline
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // strip BOM
  const rows = [];
  let row = [], field = '', i = 0, inQuotes = false;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; i++; continue; }
    field += c; i++;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  // drop fully-empty trailing rows
  return rows.filter(r => !(r.length === 1 && r[0].trim() === ''));
}

function csvField(v) {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toCsv(headers, rows) {
  const lines = [headers.map(csvField).join(',')];
  for (const r of rows) lines.push(r.map(csvField).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n'; // BOM for Excel UTF-8
}

// money: cents -> plain numeric "1234.56"
function centsToPlain(cents) {
  return (cents / 100).toFixed(2);
}

// Accepts "1,234.50", "1234.5", "₱1234.50", "(500.00)" -> integer cents. Returns null if invalid.
function parseMoneyToCents(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().replace(/[,\s₱$]/g, '');
  if (s === '') return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { neg = true; s = s.slice(1); }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const cents = parseInt(whole, 10) * 100 + parseInt((frac + '00').slice(0, 2), 10);
  return neg ? -cents : cents;
}

// Parses common date formats into ISO yyyy-mm-dd. Returns null if invalid.
function parseDateToIso(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return validIso(m[1], m[2], m[3]);
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) return validIso(m[3], m[1], m[2]); // MM/dd/yyyy
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/))) return validIso('20' + m[3], m[1], m[2]);
  if ((m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/))) return validIso(m[3], m[1], m[2]);
  if ((m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/))) return validIso(m[3], m[1], m[2]);
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function validIso(y, mo, d) {
  y = parseInt(y, 10); mo = parseInt(mo, 10); d = parseInt(d, 10);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function formatUsDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

module.exports = { parseCsv, toCsv, csvField, centsToPlain, parseMoneyToCents, parseDateToIso, formatUsDate };
