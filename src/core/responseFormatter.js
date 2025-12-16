import { logger } from '../utils/logger.js';

/**
 * Standardized response formatter for MCP tools
 * Provides consistent success and error responses
 */

/**
 * Format a successful response
 * @param {Object} params - Response parameters
 * @param {*} params.data - Response data
 * @param {Object} [params.meta] - Optional metadata
 * @returns {Object} Formatted success response
 */
export function success({ data, meta = {} }) {
  return {
    success: true,
    data,
    meta: {
      timestamp: new Date().toISOString(),
      ...meta,
    },
  };
}

/**
 * Format an error response
 * @param {Object} params - Error parameters
 * @param {string} params.code - Error code (e.g., 'VALIDATION_ERROR', 'ACCESS_DENIED')
 * @param {string} params.message - Human-readable error message
 * @param {Object} [params.details] - Optional error details
 * @returns {Object} Formatted error response
 */
export function error({ code, message, details = {} }) {
  logger.error({ code, message, details }, 'Error response');

  return {
    success: false,
    error: {
      code,
      message,
      details,
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * Error codes enumeration
 */
export const ErrorCodes = {
  // Validation errors
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_INPUT: 'INVALID_INPUT',

  // Security errors
  ACCESS_DENIED: 'ACCESS_DENIED',
  QUERY_BLOCKED: 'QUERY_BLOCKED',

  // Database errors
  DATABASE_ERROR: 'DATABASE_ERROR',
  CONNECTION_ERROR: 'CONNECTION_ERROR',

  // Not found errors
  NOT_FOUND: 'NOT_FOUND',
  SCHEMA_NOT_FOUND: 'SCHEMA_NOT_FOUND',
  TABLE_NOT_FOUND: 'TABLE_NOT_FOUND',

  // Server errors
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
};

/**
 * Create an error response from an Error object
 * @param {Error} err - Error object
 * @param {string} [defaultCode] - Default error code if not specified
 * @returns {Object} Formatted error response
 */
export function fromError(err, defaultCode = ErrorCodes.INTERNAL_ERROR) {
  const code = err.code || defaultCode;
  const message = err.message || 'An unexpected error occurred';
  const details = {
    ...(err.details || {}),
    ...(err.stack && { stack: err.stack.split('\n').slice(0, 3).join('\n') }),
  };

  return error({ code, message, details });
}

export default {
  success,
  error,
  fromError,
  ErrorCodes,
};
