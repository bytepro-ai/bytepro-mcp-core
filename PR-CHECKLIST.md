# PR Checklist (Security-First Gate)

This checklist is **enforceable**. If any required item is unchecked or lacks evidence, the PR should be treated as **not ready** and **must not merge**.

**Default posture:** deny/stop until proven safe.

---

## 1) Security invariants verification (required)

- [ ] I have read `SECURITY-INVARIANTS.md` and verified this PR does not violate any **MUST ALWAYS** / **MUST NEVER** items.
- [ ] I confirm this PR introduces **no new execution path** that can reach tool execution without passing required enforcement.
- [ ] I confirm this PR does **not** weaken tenant/scope isolation semantics (no ambiguity, no cross-tenant mixing).
- [ ] I confirm this PR does **not** broaden permissions due to missing fields, empty lists, wildcards, fallbacks, or “compatibility” behavior.
- [ ] Evidence attached (required): links to relevant diffs and a short, concrete explanation of why invariants still hold.

---

## 2) Ordering guarantees validation (auth → quota → execution) (required)

- [ ] I verified the enforcement order is preserved: **context validation → authorization → quota/limits → execution**.
- [ ] I verified there is **no reordering**, **no optional bypass**, and **no alternative entrypoint** that skips any step.
- [ ] I verified error paths cannot trigger execution (including timeouts, adapter errors, and partial failures).
- [ ] Evidence attached (required): call-path explanation referencing the specific entrypoints modified by this PR.

---

## 3) Fail-closed behavior confirmation (required)

- [ ] Missing/invalid security context results in **deny**, not allow.
- [ ] Authorization indeterminate/failed evaluation results in **deny**, not allow.
- [ ] Quota/limits indeterminate/failed enforcement results in **deny**, not allow.
- [ ] Adapter errors/timeouts in security-relevant paths result in **deny**, not allow.
- [ ] Error handling does not leak sensitive data (tenant identifiers, secrets, privileged policy details).
- [ ] Evidence attached (required): test output or reproducible steps showing deny behavior for failure cases relevant to this PR.

---

## 4) Adapter and tool changes (additional gates)

Check all that apply:

### If this PR changes any adapter behavior (DB/network/persistence/integration)
- [ ] I documented the adapter trust assumptions and confirmed it is treated as **untrusted**.
- [ ] I verified adapter failures do **not** convert to implicit allow.
- [ ] I verified adapter changes cannot cause cross-tenant reads/writes of control-plane state.
- [ ] I verified timeouts/retries do **not** create quota bypass or duplicate side effects.
- [ ] Security review requested from a maintainer with security ownership.

### If this PR changes any tool definition/registration/invocation behavior
- [ ] I verified tools remain **untrusted computation** and cannot influence authorization outcomes.
- [ ] I verified tools cannot execute before enforcement completes.
- [ ] I verified tool parameters are treated as untrusted input and validated/guarded at the boundary (as applicable to this PR).
- [ ] Security review requested from a maintainer with security ownership.

### If this PR changes authn/authz, identity, tenancy, or capability semantics
- [ ] I explicitly listed the semantic changes in the PR description (before/after).
- [ ] I added negative tests that prove **deny-by-default** still holds for missing/invalid/ambiguous context.
- [ ] Security review requested from a maintainer with security ownership.

---

## 5) Test requirements (required)

Attach the exact commands run and their results (logs/screenshots/paste are acceptable).

- [ ] I ran the full test suite locally (or in CI) and it passed.
- [ ] I added or updated tests that cover:
  - [ ] the intended change
  - [ ] at least one **negative** case (deny path)
  - [ ] at least one **failure mode** relevant to the PR (e.g., adapter error, timeout, missing context)
- [ ] I verified tests assert **fail-closed** outcomes (deny), not just successful behavior.
- [ ] I did not rely on manual testing as the only evidence for security-sensitive changes.

---

## 6) Prohibited changes (must remain true)

If any item below is affected, the PR must be rejected unless there is an explicit, documented exception with security owner approval.

- [ ] No “default allow” or “best-effort allow” behavior was introduced.
- [ ] No bypass of the enforcement order (auth → quota → execution) was introduced.
- [ ] No new configuration option was introduced that weakens security posture by default.
- [ ] No fallback behavior was introduced that permits execution when policy, identity, tenancy, or quotas cannot be verified.
- [ ] No cross-tenant caching or shared mutable state was introduced without strict scoping and verification.
- [ ] No reduction in validation strictness for security-relevant fields (tenant, identity, capabilities, tool name, limits).
- [ ] No behavior was added that suppresses, downgrades, or ignores security-relevant errors.
- [ ] No logging was added that could expose secrets or sensitive tenant data.

---

## Final gate (required)

- [ ] I confirm that if any of the above cannot be proven from code + tests, the correct outcome is **NOT MERGE**.