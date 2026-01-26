import { z } from 'zod';

/**
 * Configuration schema for MCP Core
 * Validates environment variables and applies defaults
 */
export const configSchema = z.object({
  // Database Adapter Selection
  adapter: z.enum(['postgres', 'mysql', 'mssql']).default('postgres'),

  // PostgreSQL Connection
  pg: z.object({
    host: z.string().min(1),
    port: z.coerce.number().int().min(1).max(65535).default(5432),
    user: z.string().min(1),
    password: z.string().min(1),
    database: z.string().min(1),
    ssl: z.string().default('false').transform((val) => val === 'true'),
    maxConnections: z.coerce.number().int().min(1).max(100).default(10),
    idleTimeoutMillis: z.coerce.number().int().min(1000).default(30000),
    connectionTimeoutMillis: z.coerce.number().int().min(1000).default(5000),
  }),

  // MySQL Connection
  mysql: z.object({
    host: z.string().min(1),
    port: z.coerce.number().int().min(1).max(65535).default(3306),
    user: z.string().min(1),
    password: z.string().min(1),
    database: z.string().min(1),
    ssl: z.coerce.boolean().default(false),
    maxConnections: z.coerce.number().int().min(1).max(100).default(10),
  }),

  // MSSQL Connection
  mssql: z.object({
    host: z.string().min(1),
    port: z.coerce.number().int().min(1).max(65535).default(1433),
    user: z.string().min(1),
    password: z.string().min(1),
    database: z.string().min(1),
    ssl: z.coerce.boolean().default(false),
    maxConnections: z.coerce.number().int().min(1).max(100).default(10),
  }),

  // Security Configuration
  security: z.object({
    readOnly: z.coerce.boolean().default(true),
    allowlistSchemas: z
      .string()
      .transform((val) => (val ? val.split(',').map((s) => s.trim()) : []))
      .pipe(z.array(z.string()).default([])),
    allowlistTables: z
      .string()
      .transform((val) => (val ? val.split(',').map((s) => s.trim()) : []))
      .pipe(z.array(z.string()).default([])),
    maxTables: z.coerce.number().int().min(1).max(1000).default(100),
    maxColumns: z.coerce.number().int().min(1).max(500).default(200),
  }),

  // Logging Configuration
  logging: z.object({
    level: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    pretty: z.coerce.boolean().default(false),
  }),

  // Application Configuration
  app: z.object({
    name: z.string().default('@bytepro/mcp-core'),
    version: z.string().default('0.1.0'),
  }),
});

export const validateConfig = (rawConfig) => {
  try {
    return {
      success: true,
      data: configSchema.parse(rawConfig),
    };
  } catch (error) {
    return {
      success: false,
      error: error.errors || error.message,
    };
  }
};
