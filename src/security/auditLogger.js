/**
 * Security-First Audit Logger (MINIMAL)
 * 
 * Implements minimal, fail-closed audit logging for read-only database access.
 * 
 * APPROVED FIELDS ONLY:
 * - timestamp (ISO8601, added automatically)
 * - adapter (string: 'postgres', 'mysql', etc.)
 * - resultType (enum: 'validated', 'rejected', 'success', 'execution_error')
 * - queryFingerprint (HMAC-SHA256 hash of normalized query shape)
 * - executionTimeMs (integer, rounded to 10ms, only for success/execution_error)
 * 
 * Security Guarantees:
 * - No raw SQL logging
 * - No parameter value logging
 * - No schema/table/column name leakage
 * - No request/operation/actor IDs
 * - No row counts, error codes, or SQL-derived metadata
 * - Fail-closed: logging failure blocks operation
 */

import crypto from 'crypto';

// Server-secret for HMAC operations (REQUIRED - no insecure defaults)
const SERVER_SECRET = process.env.AUDIT_SECRET;

// Fail-closed: If AUDIT_SECRET is not set or is weak, abort at module load
if (!SERVER_SECRET || SERVER_SECRET.length < 32) {
  throw new Error(
    'AUDIT_SECRET environment variable must be set and at least 32 characters. ' +
    'Generate with: openssl rand -hex 32'
  );
}

/**
 * Compute deterministic query fingerprint
 * Uses HMAC over normalized query "shape" with identifiers/literals stripped
 * 
 * @param {string} query - Raw SQL query
 * @returns {string} HMAC hex digest (non-reversible)
 */
export function computeQueryFingerprint(query) {
  // Step 1: Normalize whitespace
  let normalized = query
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/,\s+/g, ',');

  // Step 2: Strip string literals ('...' or "...")
  normalized = normalized.replace(/'(?:[^'\\]|\\.)*'/g, 'S');
  normalized = normalized.replace(/"(?:[^"\\]|\\.)*"/g, 'S');

  // Step 3: Strip numeric literals
  normalized = normalized.replace(/\b\d+\.?\d*\b/g, 'N');

  // Step 4: Strip identifiers (schema.table.column references)
  normalized = normalized.replace(/\b[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*\b/g, 'ID');
  normalized = normalized.replace(/\b[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*\b/g, 'ID');
  normalized = normalized.replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, (match) => {
    const keywords = new Set([
      'SELECT', 'FROM', 'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER',
      'ON', 'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'BETWEEN', 'LIKE', 'IS', 'NULL',
      'ORDER', 'BY', 'ASC', 'DESC', 'LIMIT', 'OFFSET', 'GROUP', 'HAVING',
      'DISTINCT', 'AS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'COUNT', 'SUM',
      'AVG', 'MIN', 'MAX', 'CAST', 'COALESCE', 'NULLIF', 'TRUE', 'FALSE'
    ]);
    return keywords.has(match.toUpperCase()) ? match.toUpperCase() : 'ID';
  });

  // Step 5: Final whitespace collapse
  normalized = normalized.replace(/\s+/g, ' ').trim();

  // Step 6: HMAC the shape
  const hmac = crypto.createHmac('sha256', SERVER_SECRET);
  hmac.update(normalized);
  return hmac.digest('hex');
}

/**
 * Emit audit log event (APPROVED FIELDS ONLY)
 * Fail-closed: throws if logging fails
 * 
 * @param {string} adapter - Adapter type ('postgres', 'mysql', etc.)
 * @param {string} resultType - Result type ('validated', 'rejected', 'success', 'execution_error')
 * @param {string} queryFingerprint - HMAC fingerprint of query
 * @param {number} [executionTimeMs] - Execution time in ms (for success/error only)
 * @throws {Error} If logging fails (fail-closed)
 */
function emitAuditLog(adapter, resultType, queryFingerprint, executionTimeMs) {
  try {
    const event = {
      timestamp: new Date().toISOString(),
      adapter,
      resultType,
      queryFingerprint
    };

    // Add execution time if provided (rounded to 10ms)
    if (executionTimeMs !== undefined) {
      event.executionTimeMs = Math.round(executionTimeMs / 10) * 10;
    }

    console.log(JSON.stringify(event));
  } catch (error) {
    throw new Error(`Audit logging failed: ${error.message}`);
  }
}

/**
 * Log query event with minimal approved fields
 * NO RAW SQL - accepts pre-computed fingerprint only
 * 
 * @param {string} adapter - Adapter type
 * @param {string} queryFingerprint - Pre-computed HMAC fingerprint
 * @param {string} resultType - Result type
 * @param {number} [executionTimeMs] - Execution time (optional)
 * @throws {Error} If logging fails (fail-closed)
 */
export function logQueryEvent(adapter, queryFingerprint, resultType, executionTimeMs) {
  emitAuditLog(adapter, resultType, queryFingerprint, executionTimeMs);
}
