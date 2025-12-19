# Week 3 Plan — ORDER BY Allowlist Extension (Security-First)

## Objective

Extend the MCP Core Library with a strict, adapter-agnostic ORDER BY validator that uses regex-only validation and integrates into the existing queryValidator flow.

The objective is to allow ORDER BY only for explicitly allowlisted columns while rejecting all ambiguous, expression-based, or dialect-specific constructs, preserving the current fail-closed security posture.

ORDER BY is treated as a query-shape amplifier and therefore gated more strictly than basic SELECT validation.

---

## Design Principles

- Fail closed on any ambiguity
- Server-side enforcement only
- No trust in client tooling or MCP Inspector behavior
- Regex-based validation only (no SQL parsing or AST)
- No query rewriting or normalization
- No new dependencies
- No refactors of existing Week 1–2 security logic

---

## Scope

### In Scope

- Single, top-level ORDER BY clause
- Explicit column sorting
- Adapter-agnostic behavior across PostgreSQL, MySQL, and MariaDB

### Explicitly Out of Scope

- SQL parsing or AST usage
- SELECT-list aliases
- Expressions, functions, or computed columns
- Pagination or OFFSET
- Dialect-specific extensions

---

## Step 1 — Validation Flow Audit (Confirmatory)

Before introducing ORDER BY validation, perform an explicit audit of the existing validation flow to confirm architectural assumptions.

Files to review:
- src/security/queryValidator.js
- src/security/queryGuard.js

Objectives of the audit:
- Confirm that queryValidator.js is the authoritative and final SQL validation gate.
- Confirm that queryGuard.js does not rewrite, normalize, or relax SQL queries.
- Confirm that no adapter or tool bypasses queryValidator.
- Confirm that introducing ORDER BY validation does not require refactoring existing security logic.

This step is confirmatory only.
No code changes should be made unless a violation of the documented security model is discovered.

Rationale:
Making this audit explicit prevents validation drift, avoids duplicated enforcement, and ensures ORDER BY validation is introduced at the correct security boundary.

---

## Step 2 — ORDER BY Allowlist Definition

- ORDER BY columns must be explicitly allowlisted.
- Allowlist entries must use fully qualified identifiers in the form:
  - schema.table.column
- Only unquoted identifiers are allowed.
- Identifier rules must align with existing word-based extraction logic in the current validator.
- Quoted identifiers, backticks, and numeric positions are always rejected.

Rationale:
Quoted identifiers and numeric positions introduce dialect variance, bypass risk, and unnecessary complexity for regex-based validation.

---

## Step 3 — Table and Alias Resolution

- Extract tables and aliases only from explicit FROM and JOIN clauses.
- Support basic table aliasing.
- Do not attempt deep SQL understanding or SQL normalization.
- If table or alias resolution is ambiguous, incomplete, or conflicting, validation must fail closed.

Rules:
- ORDER BY must reference resolved tables only.
- Columns must be qualified using one of the following forms:
  - alias.column
  - schema.table.column
- Bare column references are always rejected.

---

## Step 4 — ORDER BY Structural Rules

The following constraints are mandatory:

- Only one ORDER BY clause is allowed.
- A maximum of two sort keys is permitted.
- Each sort key must specify an explicit direction (ASC or DESC).
- Implicit sort direction is rejected.
- Parentheses are not allowed anywhere inside the ORDER BY clause.
- Expressions, operators, functions, CASE statements, and numeric positions are rejected.
- SELECT-list aliases are rejected.
- Dialect-specific extensions such as NULLS FIRST or NULLS LAST are rejected.

---

## Step 5 — Validation Behavior

- ORDER BY validation must be integrated into the existing queryValidator flow.
- Validation must either fully accept or fully reject the query.
- No partial acceptance or silent fallback behavior is allowed.
- Errors must map to existing error categories and preserve sanitized messaging.
- Validation must not reveal whether a column exists versus being merely disallowed.

---

## Risk Analysis

- Expression-based bypass attempts are mitigated by rejecting parentheses, operators, and functions.
- Ambiguity and alias confusion are mitigated by mandatory qualification and fail-closed resolution.
- Performance abuse is mitigated by limiting the number of sort keys and preserving server-side LIMIT enforcement.
- False positives are acceptable under the security-first posture.
- False negatives are considered low risk given the strict rejection rules.

---

## Resolved Design Decisions

- NULLS FIRST / NULLS LAST are rejected for cross-adapter consistency.
- Maximum number of sort keys is limited to two.
- Column qualification is mandatory.
- Implicit sort direction is rejected.

---

## Completion Criteria

The ORDER BY allowlist extension is considered complete only if:

- ORDER BY validation is centralized in queryValidator.
- No adapter-specific logic is introduced.
- No existing security logic is refactored.
- All ambiguous cases fail closed.
- Manual MCP Inspector validation confirms consistent behavior across adapters.
