# Security Change Checklist (Main Branch Gate)

This checklist is **enforceable** and applies to **any security-relevant change**,
including **direct commits to the main branch**.

If any required item is unchecked or lacks objective evidence,
the change must be treated as **NOT READY** and **must not land**.

**Default posture:** deny / stop until proven safe.

---

## 0) Scope of this checklist

This checklist applies when:
- working directly on `main`
- working solo (no PRs)
- no CI is assumed (if CI exists in a downstream fork, it must run the same local gate: `npm test`)
- refactoring, extending, or optimizing security-sensitive code

No PR workflow is assumed; direct commits to `main` **do not relax security requirements**.

---

## 1) Security invariants verification (REQUIRED)

- [ ] I have reviewed `SECURITY-INVARIANTS.md` and verified this change does not violate any **MUST ALWAYS** or **MUST NEVER** invariant.
- [ ] I confirm this change introduces **no new execution path** that can reach tool execution without passing the execution boundary.
- [ ] I confirm tenant and scope isolation semantics remain strict and unambiguous.
- [ ] I confirm permissions are not broadened due to:
  - missing fields
  - empty lists
  - wildcards
  - fallbacks
  - “compatibility” behavior
- [ ] Evidence attached (required):
  - relevant diffs
  - short explanation of why invariants still hold

---

## 2) Enforcement ordering validation (REQUIRED)

I verified the canonical enforcement order is preserved:

**Context validation → Tool lookup → Read-only enforcement → Authorization → Quota/Limits → Execution**

- [ ] No reordering was introduced (including preserving “tool lookup before read-only/auth/quota/execution”)
- [ ] No optional bypass exists
- [ ] No alternative entrypoint skips any step
- [ ] Error paths cannot trigger execution (timeouts, adapter failures, partial failures)

Evidence:
- call-path explanation referencing the exact functions modified

---

## 3) Fail-closed behavior confirmation (REQUIRED)

- [ ] Missing or invalid SessionContext results in **DENY**
- [ ] Authorization failure or indeterminate result in **DENY**
- [ ] Quota / limits failure result in **DENY**
- [ ] Adapter errors or timeouts result in **DENY**
- [ ] Error handling does not leak sensitive data

Evidence:
- test output, logs, or reproducible steps demonstrating deny behavior

---

## 4) Verified-by-tests requirement (RELEASE BLOCKING)

For any change touching enforcement, adapters, or execution flow:

- [ ] `npm test` executed
- [ ] All security invariant tests PASS
- [ ] No invariant test was removed, weakened, or broadened
- [ ] Tests still assert **zero side effects on denial**

Mandatory invariant tests:

- [ ] Fail-closed on missing/invalid SessionContext  
  `tests/security/invariant.session-context.fail-closed.test.js`

- [ ] Authorization precedes execution  
  `tests/security/invariant.authorization-precedes-execution.test.js`

- [ ] Unknown tools produce zero side effects  
  `tests/security/invariant.unknown-tool-zero-effects.test.js`

- [ ] Read-only blocks writes before auth or execution  
  `tests/security/invariant.read-only-blocks-writes.test.js`

---

## 5) Adapter and tool safety (IF APPLICABLE)

### If this change affects adapters
- [ ] Adapter is treated as untrusted
- [ ] Adapter failure cannot result in implicit allow
- [ ] Adapter cannot cause cross-tenant effects
- [ ] Timeouts/retries cannot bypass quotas or duplicate side effects

### If this change affects tools or tool registration
- [ ] Tools remain untrusted computation
- [ ] Tools cannot influence authorization
- [ ] Tools cannot execute before enforcement completes
- [ ] Tool inputs are treated as untrusted

---

## 6) Prohibited outcomes (MUST NEVER OCCUR)

- [ ] No default-allow or best-effort allow behavior introduced
- [ ] No bypass of enforcement ordering
- [ ] No weakening of default security posture
- [ ] No fallback that permits execution when policy, identity, tenancy, or quota cannot be verified
- [ ] No cross-tenant shared mutable state
- [ ] No suppression of security-relevant errors
- [ ] No logging that leaks secrets or sensitive tenant data

---

## Final decision (REQUIRED)

- [ ] I confirm that if any of the above cannot be proven from code + tests,
      the correct outcome is **DO NOT COMMIT / DO NOT MERGE**.

---

**Reminder**

Jest security invariant tests are the single source of enforceable security behavior. If `npm test` fails, the change must not be committed.
> If invariant tests fail, the change must not land.
