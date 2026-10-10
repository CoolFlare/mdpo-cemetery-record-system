'use strict';
// pricing.js - automatic pricing rules (all math in integer centavos)
const { BURIAL_TYPES, PAYMENT_METHODS, getPricing } = require('./db');

function computeTotalCents(burialType, indigent, paymentMethod) {
  if (indigent === 'Yes') return 0;
  const pricing = getPricing();
  const row = pricing[burialType];
  if (!row) return 0;
  const v = row[paymentMethod];
  return typeof v === 'number' ? v : 0;
}

function validateRecordFields(body, { requireAll = true } = {}) {
  const errors = {};
  const deceasedName = (body.deceased_name || '').trim();
  if (requireAll && !deceasedName) errors.deceased_name = 'Deceased Name is required.';
  const burialType = body.burial_type;
  if (requireAll && !BURIAL_TYPES.includes(burialType)) errors.burial_type = 'Burial Type must be one of the six supported options.';
  const indigent = body.indigent;
  if (requireAll && !['Yes', 'No'].includes(indigent)) errors.indigent = "Indigent must be 'Yes' or 'No'.";
  let paymentMethod = body.payment_method;
  if (indigent === 'Yes') paymentMethod = 'N/A';
  if (requireAll && !PAYMENT_METHODS.includes(paymentMethod)) errors.payment_method = "Payment Method must be Installment, Full Payment (Cash), or N/A.";
  for (const f of ['date_of_death', 'date_of_burial']) {
    const v = body[f];
    if (v != null && v !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) errors[f] = 'Use a valid date (yyyy-MM-dd).';
  }
  return { errors, paymentMethod, deceasedName, burialType, indigent };
}

// Balance = total - SUM(payments); never negative; indigent stays 0
function computeBalanceCents(totalCents, paidCents) {
  const b = totalCents - paidCents;
  return b > 0 ? b : 0;
}

module.exports = { computeTotalCents, validateRecordFields, computeBalanceCents };
