const path = require('path');

const backendRoot = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(backendRoot, '.env') });

function getBaseUrl() {
  const raw = (process.env.BASE_URL || '').trim();
  if (!raw) throw new Error('Missing required environment variable: BASE_URL');

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('BASE_URL must be an absolute HTTP or HTTPS origin.');
  }
  if (!['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash) {
    throw new Error('BASE_URL must be an HTTP or HTTPS origin without credentials, path, query, or fragment.');
  }
  return url.origin;
}

function publicUrl(resourcePath) {
  const relativePath = String(resourcePath || '').replace(/^\/+/, '');
  return new URL(relativePath, `${getBaseUrl()}/`).toString();
}

function getDatabaseConfig(databaseName = process.env.DB_NAME) {
  const host = (process.env.DB_HOST || '').trim();
  const user = (process.env.DB_USER || '').trim();
  const database = (databaseName || '').trim();
  const rawPort = (process.env.DB_PORT || '').trim();
  const port = Number(rawPort);
  const sslSetting = (process.env.DB_SSL || '').trim().toLowerCase();
  const sslCa = (process.env.DB_SSL_CA || '').replace(/\\n/g, '\n').trim();
  const password = process.env.DB_PASSWORD;

  if (!host || !user || !database || password === undefined) {
    throw new Error('DB_HOST, DB_NAME, DB_USER, and DB_PASSWORD must be set.');
  }
  if (!rawPort) {
    throw new Error('DB_PORT is required.');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('DB_PORT must be an integer between 1 and 65535.');
  }
  if (!sslSetting || !['true', 'false'].includes(sslSetting)) {
    throw new Error('DB_SSL must be true or false.');
  }
  if (process.env.NODE_ENV === 'production' && sslSetting !== 'true') {
    throw new Error('DB_SSL=true is required in production.');
  }
  if (sslCa && sslSetting !== 'true') {
    throw new Error('DB_SSL_CA can only be used when DB_SSL=true.');
  }
  if (sslCa && (!sslCa.includes('-----BEGIN CERTIFICATE-----')
    || !sslCa.includes('-----END CERTIFICATE-----'))) {
    throw new Error('DB_SSL_CA must contain a PEM-encoded certificate.');
  }

  return {
    host,
    port,
    user,
    password,
    database,
    ssl: sslSetting === 'true'
      ? { rejectUnauthorized: true, ...(sslCa ? { ca: sslCa } : {}) }
      : undefined,
  };
}

function resolveConfiguredDirectory(variableName) {
  const configuredPath = (process.env[variableName] || '').trim();
  if (!configuredPath) {
    throw new Error(`Missing required environment variable: ${variableName}`);
  }
  return path.isAbsolute(configuredPath)
    ? path.resolve(configuredPath)
    : path.resolve(backendRoot, configuredPath);
}

module.exports = {
  backendRoot,
  getBaseUrl,
  getDatabaseConfig,
  getPrivateUploadsDir: () => resolveConfiguredDirectory('PRIVATE_UPLOADS_DIR'),
  getPublicUploadsDir: () => resolveConfiguredDirectory('UPLOADS_DIR'),
  publicUrl,
};
