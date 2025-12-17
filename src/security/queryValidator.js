/**
 * SQL Query Validator
 * 
 * Validates SQL queries using strict regex patterns.
 * Enforces SELECT-only, blocks dangerous constructs.
 * Does NOT execute queries or apply allowlists.
 */

/**
 * Validate a SQL query for security compliance
 * @param {string} query - Raw SQL query string
 * @returns {{ valid: boolean, reason?: string }} Validation result
 */
export function validateQuery(query) {
  // Reject empty or non-string queries
  if (!query || typeof query !== 'string') {
    return { valid: false, reason: 'Query must be a non-empty string' };
  }

  // Normalize: trim whitespace
  const normalized = query.trim();

  if (normalized.length === 0) {
    return { valid: false, reason: 'Query cannot be empty' };
  }

  // Rule 1: Must start with SELECT (case-insensitive)
  // This ensures only read operations are allowed
  if (!/^SELECT\s+/i.test(normalized)) {
    return { valid: false, reason: 'Query must start with SELECT' };
  }

  // Rule 2: Reject semicolons (multi-statement prevention)
  // Prevents attacks like: SELECT 1; DROP TABLE users;
  if (normalized.includes(';')) {
    return { valid: false, reason: 'Query must not contain semicolons (multi-statement forbidden)' };
  }

  // Rule 3: Reject SQL comments (obfuscation prevention)
  // Prevents attacks like: SELECT * FROM users -- WHERE admin = false
  if (normalized.includes('--') || normalized.includes('/*') || normalized.includes('*/')) {
    return { valid: false, reason: 'Query must not contain comments (-- or /* */forbidden)' };
  }

  // Rule 4: Reject null bytes and control characters
  // Prevents string truncation attacks in some SQL drivers
  if (/[\x00-\x1F]/.test(normalized)) {
    return { valid: false, reason: 'Query must not contain control characters' };
  }

  // Rule 5: Reject CTEs (WITH clauses)
  // CTEs can hide write operations: WITH x AS (INSERT INTO...) SELECT...
  if (/\bWITH\s+/i.test(normalized)) {
    return { valid: false, reason: 'Query must not contain WITH clauses (CTEs forbidden)' };
  }

  // Rule 6: Reject set operations (UNION, EXCEPT, INTERSECT)
  // These can be used to combine results from unauthorized tables
  if (/\b(UNION|EXCEPT|INTERSECT)\b/i.test(normalized)) {
    return { valid: false, reason: 'Query must not contain set operations (UNION/EXCEPT/INTERSECT forbidden)' };
  }

  // Rule 7: Reject OFFSET (DOS prevention)
  // OFFSET forces database to scan N rows before returning results
  // Example attack: SELECT * FROM huge_table LIMIT 10 OFFSET 9999999
  if (/\bOFFSET\s+/i.test(normalized)) {
    return { valid: false, reason: 'Query must not contain OFFSET (DOS prevention)' };
  }

  // Rule 8: Reject write-related keywords
  // Belt-and-suspenders: block obvious write operations even though we check for SELECT
  const writeKeywords = [
    'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 
    'TRUNCATE', 'GRANT', 'REVOKE', 'EXEC', 'EXECUTE', 'COPY'
  ];
  
  for (const keyword of writeKeywords) {
    const pattern = new RegExp(`\\b${keyword}\\b`, 'i');
    if (pattern.test(normalized)) {
      return { valid: false, reason: `Query must not contain ${keyword} keyword` };
    }
  }

  // Rule 9: Reject INTO clause (write operations)
  // Prevents: SELECT * INTO new_table FROM users
  if (/\bINTO\s+/i.test(normalized)) {
    return { valid: false, reason: 'Query must not contain INTO clause' };
  }

  // Rule 10: Reject FOR UPDATE/FOR SHARE (locking clauses)
  // These can hold locks and affect write operations
  if (/\bFOR\s+(UPDATE|SHARE)\b/i.test(normalized)) {
    return { valid: false, reason: 'Query must not contain locking clauses (FOR UPDATE/FOR SHARE forbidden)' };
  }

  // All validation rules passed
  return { valid: true };
}

/**
 * Extract table references from a validated SQL query
 * Uses best-effort regex to find table names in FROM and JOIN clauses
 * 
 * @param {string} query - SQL query string (should be pre-validated)
 * @returns {string[]} Array of table names (may include schema prefix)
 */
export function extractTables(query) {
  const tables = new Set();

  // Pattern 1: FROM clause
  // Matches: FROM schema.table, FROM table, FROM "schema"."table"
  const fromPattern = /\bFROM\s+(?:(\w+)\.)?(\w+)/gi;
  let match;
  
  while ((match = fromPattern.exec(query)) !== null) {
    const schema = match[1] || 'public'; // Default to public schema
    const table = match[2];
    tables.add(`${schema}.${table}`);
  }

  // Pattern 2: JOIN clause
  // Matches: JOIN schema.table, JOIN table, INNER JOIN table, LEFT JOIN table
  const joinPattern = /\b(?:INNER\s+|LEFT\s+|RIGHT\s+|FULL\s+)?JOIN\s+(?:(\w+)\.)?(\w+)/gi;
  
  while ((match = joinPattern.exec(query)) !== null) {
    const schema = match[1] || 'public'; // Default to public schema
    const table = match[2];
    tables.add(`${schema}.${table}`);
  }

  return Array.from(tables);
}

/**
 * Validate query and extract tables in one operation
 * Implements fail-closed rule: queries with zero tables are rejected
 * 
 * @param {string} query - Raw SQL query string
 * @returns {{ valid: boolean, reason?: string, tables?: string[] }} Validation result with tables
 */
export function validateQueryWithTables(query) {
  // First validate the query structure
  const validation = validateQuery(query);
  
  if (!validation.valid) {
    return validation;
  }

  // Extract table references
  const tables = extractTables(query);

  // Fail-closed rule: Queries with no extractable tables are rejected
  // This prevents table-less queries like: SELECT 1+1, SELECT NOW(), etc.
  // Over-extraction is acceptable; under-extraction will be caught by allowlist
  if (tables.length === 0) {
    return { 
      valid: false, 
      reason: 'Query must reference at least one table (fail-closed validation)' 
    };
  }

  return { 
    valid: true, 
    tables 
  };
}
