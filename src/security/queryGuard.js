import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Query guard to enforce security rules on SQL queries
 * Blocks dangerous patterns and enforces result limits
 */
export class QueryGuard {
  constructor() {
    this.readOnly = config.security.readOnly;
    this.maxTables = config.security.maxTables;
    this.maxColumns = config.security.maxColumns;

    // Dangerous SQL patterns to block
    this.dangerousPatterns = [
      /\bDROP\b/i,
      /\bALTER\b/i,
      /\bTRUNCATE\b/i,
      /\bDELETE\b/i,
      /\bINSERT\b/i,
      /\bUPDATE\b/i,
      /\bCREATE\b/i,
      /\bGRANT\b/i,
      /\bREVOKE\b/i,
      /\bEXEC\b/i,
      /\bEXECUTE\b/i,
      /;/g, // Multiple statements
      /--/g, // SQL comments
      /\/\*/g, // Block comments
    ];

    logger.info(
      {
        readOnly: this.readOnly,
        maxTables: this.maxTables,
        maxColumns: this.maxColumns,
      },
      'Query guard initialized'
    );
  }

  /**
   * Check if a query contains dangerous patterns
   * @param {string} query - SQL query to check
   * @returns {Object} Result with isValid and reasons
   */
  validateQuery(query) {
    if (!query || typeof query !== 'string') {
      return {
        isValid: false,
        reasons: ['Query is empty or not a string'],
      };
    }

    const reasons = [];

    // Check for dangerous patterns
    for (const pattern of this.dangerousPatterns) {
      if (pattern.test(query)) {
        reasons.push(`Blocked pattern detected: ${pattern.source}`);
      }
    }

    // In read-only mode, only allow SELECT statements
    if (this.readOnly) {
      const trimmedQuery = query.trim().toUpperCase();
      if (!trimmedQuery.startsWith('SELECT') && !trimmedQuery.startsWith('WITH')) {
        reasons.push('Read-only mode: only SELECT queries are allowed');
      }
    }

    const isValid = reasons.length === 0;

    if (!isValid) {
      logger.warn({ query: query.substring(0, 100), reasons }, 'Query blocked by guard');
    }

    return {
      isValid,
      reasons,
    };
  }

  /**
   * Enforce query validation - throws if invalid
   * @param {string} query - SQL query to validate
   * @throws {Error} If query is invalid
   */
  enforceQuery(query) {
    const result = this.validateQuery(query);

    if (!result.isValid) {
      throw new Error(`Query blocked: ${result.reasons.join(', ')}`);
    }
  }

  /**
   * Enforce result limit for tables
   * @param {Array} tables - Array of tables
   * @returns {Array} Limited array
   */
  limitTables(tables) {
    if (!Array.isArray(tables)) {
      return tables;
    }

    if (tables.length > this.maxTables) {
      logger.warn(
        {
          returned: this.maxTables,
          total: tables.length,
        },
        'Table result set limited'
      );

      return tables.slice(0, this.maxTables);
    }

    return tables;
  }

  /**
   * Enforce result limit for columns
   * @param {Array} columns - Array of columns
   * @returns {Array} Limited array
   */
  limitColumns(columns) {
    if (!Array.isArray(columns)) {
      return columns;
    }

    if (columns.length > this.maxColumns) {
      logger.warn(
        {
          returned: this.maxColumns,
          total: columns.length,
        },
        'Column result set limited'
      );

      return columns.slice(0, this.maxColumns);
    }

    return columns;
  }

  /**
   * Check if a query uses parameterized format (for future use)
   * @param {string} query - SQL query to check
   * @param {Array} params - Query parameters
   * @returns {boolean} True if properly parameterized
   */
  isParameterized(query, params = []) {
    // Check for $1, $2, etc. placeholders
    const placeholderRegex = /\$\d+/g;
    const placeholders = query.match(placeholderRegex) || [];

    // Should have parameters if placeholders exist
    if (placeholders.length > 0 && params.length === 0) {
      return false;
    }

    // Check for common SQL injection patterns (unescaped quotes)
    const hasUnescapedQuotes = /'[^']*'[^']*'/g.test(query);

    return !hasUnescapedQuotes || params.length > 0;
  }

  /**
   * Get guard configuration for debugging
   * @returns {Object} Guard configuration
   */
  getConfig() {
    return {
      readOnly: this.readOnly,
      maxTables: this.maxTables,
      maxColumns: this.maxColumns,
      dangerousPatterns: this.dangerousPatterns.map((p) => p.source),
    };
  }
}

// Export singleton instance
export const queryGuard = new QueryGuard();

export default queryGuard;
