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
  // Also reject MySQL # comments for adapter-agnostic security
  if (normalized.includes('--') || normalized.includes('/*') || normalized.includes('*/') || normalized.includes('#')) {
    return { valid: false, reason: 'Query must not contain comments (-- or /* */ or # forbidden)' };
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
    const schema = match[1];
    if (!schema) {
      throw new Error('Table references must be schema-qualified (schema.table)');
    }
    const table = match[2];
    tables.add(`${schema}.${table}`);

    // SECURITY CHECK: Implicit Joins
    // Check for comma immediately following the match (ignoring whitespace)
    // This check is only valid if we are in the FROM clause context
    const remainder = query.slice(fromPattern.lastIndex);
    if (/^\s*,/.test(remainder)) {
      throw new Error("Implicit joins (comma-separated tables) are not allowed. Use explicit JOIN syntax.");
    }
  }

  // Pattern 2: JOIN clause
  // Matches: JOIN schema.table, JOIN table, INNER JOIN table, LEFT JOIN table
  const joinPattern = /\b(?:INNER\s+|LEFT\s+|RIGHT\s+|FULL\s+)?JOIN\s+(?:(\w+)\.)?(\w+)/gi;
  
  while ((match = joinPattern.exec(query)) !== null) {
    const schema = match[1];
    if (!schema) {
      throw new Error('Table references must be schema-qualified (schema.table)');
    }
    const table = match[2];
    tables.add(`${schema}.${table}`);
  }

  return Array.from(tables);
}

/**
 * Build qualifier-to-table mapping from FROM/JOIN clauses
 * Maps aliases and unambiguous table names to schema.table
 * 
 * @param {string} query - SQL query string
 * @returns {Map<string, string>} Map of qualifier -> schema.table
 */
function buildQualifierMap(query) {
  const qualifierMap = new Map();
  const tableOccurrences = new Map(); // Track table name occurrences for ambiguity detection

  // Pattern: FROM/JOIN schema.table [AS] alias
  const tablePattern = /\b(?:FROM|(?:INNER\s+|LEFT\s+|RIGHT\s+|FULL\s+)?JOIN)\s+(\w+)\.(\w+)(?:\s+(?:AS\s+)?(\w+))?/gi;
  let match;

  while ((match = tablePattern.exec(query)) !== null) {
    const schema = match[1];
    const table = match[2];
    const alias = match[3];
    const fullTableName = `${schema}.${table}`;

    // Register alias if present
    if (alias) {
      const aliasLower = alias.toLowerCase();
      // Fail-closed: reject duplicate alias definitions
      if (qualifierMap.has(aliasLower)) {
        throw new Error(`Duplicate alias definition: ${alias}`);
      }
      qualifierMap.set(aliasLower, fullTableName);
    }

    // Track table name for ambiguity detection
    const tableLower = table.toLowerCase();
    if (!tableOccurrences.has(tableLower)) {
      tableOccurrences.set(tableLower, []);
    }
    tableOccurrences.get(tableLower).push(fullTableName);
  }

  // Register unambiguous table names
  for (const [tableName, fullNames] of tableOccurrences.entries()) {
    if (fullNames.length === 1) {
      qualifierMap.set(tableName, fullNames[0]);
    }
  }

  return qualifierMap;
}

/**
 * Validate ORDER BY clause with strict allowlist enforcement
 * 
 * Rules:
 * - Single ORDER BY clause only
 * - Maximum 2 sort keys
 * - Explicit ASC/DESC required for every key
 * - Only qualified identifiers: alias.column or schema.table.column
 * - Bare columns, expressions, functions, numeric positions rejected
 * - Only allowlisted columns permitted
 * 
 * @param {string} query - SQL query string (pre-validated)
 * @param {Set<string>} allowedOrderByColumns - Set of schema.table.column strings
 * @returns {{ valid: boolean, reason?: string }} Validation result
 */
function validateOrderBy(query, allowedOrderByColumns) {
  // Check if query contains ORDER BY
  const orderByPattern = /\bORDER\s+BY\b/gi;
  const matches = query.match(orderByPattern);

  if (!matches) {
    // No ORDER BY clause - valid
    return { valid: true };
  }

  // Rule: Single ORDER BY only (fail-closed on nested queries)
  if (matches.length > 1) {
    return {
      valid: false,
      reason: 'Multiple ORDER BY clauses not supported (fail-closed)',
    };
  }

  // Check if ORDER BY is allowed
  if (!allowedOrderByColumns || allowedOrderByColumns.size === 0) {
    return {
      valid: false,
      reason: 'ORDER BY not permitted (no allowed columns configured)',
    };
  }

  // Extract ORDER BY clause tail
  // Find ORDER BY and capture until LIMIT/FETCH/FOR or end
  const orderByIndex = query.search(/\bORDER\s+BY\b/i);
  const afterOrderBy = query.substring(orderByIndex + 8); // Skip "ORDER BY"

  // Find where ORDER BY clause ends
  const endMatch = afterOrderBy.search(/\b(LIMIT|FETCH|FOR)\b/i);
  const orderByTail = endMatch >= 0 ? afterOrderBy.substring(0, endMatch) : afterOrderBy;

  // Rule: Reject parentheses (expressions/subqueries)
  if (orderByTail.includes('(') || orderByTail.includes(')')) {
    return {
      valid: false,
      reason: 'ORDER BY expressions are not allowed (parentheses forbidden)',
    };
  }

  // Rule: Reject invalid characters (fail-closed)
  // Allow only: letters, digits, underscore, dot, comma, whitespace
  // This prevents digit-leading identifiers and special characters
  if (!/^[A-Za-z0-9_\s.,]+$/i.test(orderByTail)) {
    return {
      valid: false,
      reason: 'Invalid characters in ORDER BY clause (fail-closed)',
    };
  }

  // Build qualifier map for resolution
  const qualifierMap = buildQualifierMap(query);

  // Split by comma to get individual sort keys
  const terms = orderByTail.split(',').map((t) => t.trim()).filter((t) => t.length > 0);

  // Rule: Maximum 2 sort keys
  if (terms.length > 2) {
    return {
      valid: false,
      reason: 'Too many ORDER BY keys (maximum: 2)',
    };
  }

  // Validate each term
  for (const term of terms) {
    // Rule: Reject numeric positions
    if (/^\d+(\s+(ASC|DESC))?$/i.test(term)) {
      return {
        valid: false,
        reason: 'ORDER BY positional references are not allowed',
      };
    }

    // Parse term: <ref> (ASC|DESC)
    // Ref can be: alias.column or schema.table.column
    // Identifier must start with letter or underscore, followed by letters/digits/underscores
    const IDENT = '[A-Za-z_][A-Za-z0-9_]*';
    const termPattern = new RegExp(`^((${IDENT})\\.(${IDENT})(?:\\.(${IDENT})?)?)\\s+(ASC|DESC)$`, 'i');
    const termMatch = term.match(termPattern);

    if (!termMatch) {
      return {
        valid: false,
        reason: 'ORDER BY must use qualified identifiers (alias.column or schema.table.column) with explicit direction (ASC or DESC)',
      };
    }

    const fullRef = termMatch[1];
    const part1 = termMatch[2]; // schema or alias
    const part2 = termMatch[3]; // table or column
    const part3 = termMatch[4]; // column (if 3-part)
    const direction = termMatch[5]; // ASC or DESC

    let resolvedColumn;

    if (part3) {
      // Three-part: schema.table.column
      resolvedColumn = fullRef.toLowerCase();
    } else {
      // Two-part: qualifier.column
      const qualifier = part1.toLowerCase();
      const column = part2.toLowerCase();

      // Resolve qualifier
      const resolvedTable = qualifierMap.get(qualifier);

      if (!resolvedTable) {
        return {
          valid: false,
          reason: `Unknown or ambiguous ORDER BY qualifier: ${qualifier}`,
        };
      }

      resolvedColumn = `${resolvedTable}.${column}`.toLowerCase();
    }

    // Check allowlist
    if (!allowedOrderByColumns.has(resolvedColumn)) {
      return {
        valid: false,
        reason: `ORDER BY column not allowed: ${resolvedColumn}`,
      };
    }
  }

  return { valid: true };
}

/**
 * Validate query and extract tables in one operation
 * Implements fail-closed rule: queries with zero tables are rejected
 * 
 * @param {string} query - Raw SQL query string
 * @param {Object} [options] - Validation options
 * @param {string[]} [options.allowedOrderByColumns] - Array of schema.table.column strings for ORDER BY allowlist
 * @returns {{ valid: boolean, reason?: string, tables?: string[] }} Validation result with tables
 */
export function validateQueryWithTables(query, options = {}) {
  // First validate the query structure
  const validation = validateQuery(query);
  
  if (!validation.valid) {
    return validation;
  }

  try {
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

    // Validate ORDER BY with strict allowlist enforcement
    // If allowlist is provided, validate against it
    // If allowlist is not provided but query has ORDER BY, reject (fail-closed)
    const allowedSet = options.allowedOrderByColumns
      ? new Set(options.allowedOrderByColumns.map((col) => col.toLowerCase()))
      : new Set();
    
    const orderByValidation = validateOrderBy(query, allowedSet);

    if (!orderByValidation.valid) {
      return orderByValidation;
    }

    return { 
      valid: true, 
      tables 
    };
  } catch (error) {
    return { valid: false, reason: error.message };
  }
}
