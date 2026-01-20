import pino from 'pino';

/**
 * Create a configured logger instance with audit metadata support
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  ...((process.env.LOG_PRETTY === 'true') && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    },
  }),
  base: {
    app: process.env.APP_NAME || 'mcp-server',
    version: process.env.APP_VERSION || '1.0.0',
  },
});

/**
 * Create an audit log entry with standardized metadata
 * @param {Object} params - Audit parameters
 * @param {string} params.action - Action performed (e.g., 'list_tables', 'describe_table')
 * @param {string} params.adapter - Adapter used (e.g., 'postgres')
 * @param {Object} params.input - Sanitized input parameters
 * @param {number} params.duration - Duration in milliseconds
 * @param {string} params.outcome - Outcome ('success' or 'error')
 * @param {string} [params.error] - Error message if outcome is 'error'
 */
export function auditLog({ action, adapter, input, duration, outcome, error }) {
  const auditEntry = {
    type: 'audit',
    action,
    adapter,
    input: sanitizeForLog(input),
    duration,
    outcome,
    ...(error && { error }),
    timestamp: new Date().toISOString(),
  };

  if (outcome === 'error') {
    logger.error(auditEntry, `Audit: ${action} failed`);
  } else {
    logger.info(auditEntry, `Audit: ${action} succeeded`);
  }
}

/**
 * Sanitize sensitive data from log output
 * @param {Object} data - Data to sanitize
 * @returns {Object} Sanitized data
 */
function sanitizeForLog(data) {
  if (!data || typeof data !== 'object') return data;

  const sanitized = { ...data };
  const sensitiveKeys = ['password', 'token', 'secret', 'apiKey', 'api_key'];

  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.some((k) => key.toLowerCase().includes(k.toLowerCase()))) {
      sanitized[key] = '***REDACTED***';
    }
  }

  return sanitized;
}

export default logger;
