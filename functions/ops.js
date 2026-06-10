const crypto = require('crypto');
const { logger } = require('firebase-functions');
const { HttpsError } = require('firebase-functions/v2/https');

const REGION = 'europe-west1';

function withRegion(options = {}) {
  return { region: REGION, ...options };
}

function publicError(code, message) {
  return new HttpsError(code, message);
}

function requireAuth(request) {
  if (!request.auth) throw publicError('unauthenticated', 'Sign in is required.');
  return request.auth;
}

function hashIdentifier(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''))
    .digest('hex')
    .slice(0, 12);
}

function errorMessage(error) {
  return String(error?.message || error || 'Unknown error').slice(0, 500);
}

function logInfo(event, fields = {}) {
  logger.info(event, sanitize(fields));
}

function logWarn(event, fields = {}) {
  logger.warn(event, sanitize(fields));
}

function logError(event, error, fields = {}) {
  logger.error(event, sanitize({ ...fields, error: errorMessage(error), code: error?.code }));
}

function sanitize(value) {
  if (Array.isArray(value)) return value.slice(0, 20).map(sanitize);
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string') return value.slice(0, 500);
    return value;
  }

  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (/(token|secret|key|authorization|password|prompt|body|text|email)/i.test(key)) {
      return [key, '[redacted]'];
    }
    return [key, sanitize(item)];
  }));
}

module.exports = {
  REGION,
  withRegion,
  publicError,
  requireAuth,
  hashIdentifier,
  errorMessage,
  logInfo,
  logWarn,
  logError,
};
