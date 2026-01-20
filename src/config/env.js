import dotenv from 'dotenv';
import { validateConfig } from './schema.js';

// Load .env file
dotenv.config();

/**
 * Load and validate configuration from environment variables
 * Fails fast on invalid configuration
 */
export function loadConfig() {
  const rawConfig = {
    pg: {
      host: process.env.PG_HOST,
      port: process.env.PG_PORT,
      user: process.env.PG_USER,
      password: process.env.PG_PASSWORD,
      database: process.env.PG_DATABASE,
      ssl: process.env.PG_SSL,
      maxConnections: process.env.PG_MAX_CONNECTIONS,
      idleTimeoutMillis: process.env.PG_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: process.env.PG_CONNECTION_TIMEOUT_MS,
    },
    security: {
      readOnly: process.env.READ_ONLY,
      allowlistSchemas: process.env.ALLOWLIST_SCHEMAS || '',
      allowlistTables: process.env.ALLOWLIST_TABLES || '',
      maxTables: process.env.MAX_TABLES,
      maxColumns: process.env.MAX_COLUMNS,
    },
    logging: {
      level: process.env.LOG_LEVEL,
      pretty: process.env.LOG_PRETTY,
    },
    app: {
      name: process.env.APP_NAME,
      version: process.env.APP_VERSION,
    },
  };

  const result = validateConfig(rawConfig);

  if (!result.success) {
    console.error('Configuration validation failed:');
    console.error(JSON.stringify(result.error, null, 2));
    process.exit(1);
  }

  return result.data;
}

/**
 * Get validated configuration instance
 * @returns {Object} Validated configuration
 */
export function getConfig() {
  return loadConfig();
}
