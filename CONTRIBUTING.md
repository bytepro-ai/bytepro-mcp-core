# Contributing to BytePro MCP Core

BytePro MCP Core is a security-sensitive runtime. The project prioritizes **correctness, isolation, and auditability** over convenience, performance micro-optimizations, or feature velocity.

If you are unsure whether a change affects security posture, treat it as security-relevant and ask before investing significant effort.

---

## 1) Project philosophy

- **Security-first and fail-closed:** When the system cannot make a trustworthy decision, it must deny rather than allow.
- **Explicit trust boundaries:** Callers, tools, and adapters must be treated as untrusted by default.
- **Correctness over convenience:** Prefer clear, verifiable behavior over “helpful” implicit defaults.
- **Auditability matters:** Control-plane decisions must remain explainable and observable without leaking sensitive data.
- **Conservative evolution:** Changes should be incremental and easy to reason about.

Security requirements are captured in **`SECURITY-INVARIANTS.md`**. Contributions must preserve those invariants.

---

## 2) What types of contributions are welcome

The following contributions are generally welcome when they preserve the security invariants and include appropriate tests:

- Bug fixes that **tighten** security posture or close bypasses
- Documentation improvements that clarify secure usage and operational expectations
- Hardening improvements (validation, safer error handling, stricter defaults)
- Reliability fixes that maintain **fail-closed** behavior under partial failures
- Performance improvements **only** when they do not weaken isolation, ordering, or enforcement integrity
- Adapter improvements that do not change security semantics and include failure-mode tests
- Tooling improvements that make security behavior easier to verify (tests, CI checks, lint rules)

---

## 3) What contributions will be rejected

The project will reject changes that introduce ambiguity or weaken enforcement, including (non-exhaustive):

- Any form of **default-allow** behavior (including “best-effort allow” during outages)
- Any change that weakens or bypasses the enforcement ordering: **validation → authorization → quota/limits → execution**
- Features that expand scope without a clear security model (e.g., “run arbitrary code/tools” without strict boundaries)
- “Convenience” shortcuts that reduce validation strictness for security-relevant fields
- Optimizations that obscure correctness (racy caching, shared mutable state across tenants, implicit fallbacks)
- Logging that risks leaking secrets, credentials, tenant identifiers, or sensitive policy details
- Changes that rely on trust in callers, tools, or adapters without explicit controls

If a change cannot be proven safe from code + tests, it should be treated as not ready.

---

## 4) Security review expectations

Security review is expected for any change that could affect:

- Authorization or policy evaluation
- Tenant/scope attribution, identity, or capability semantics
- Quotas/limits enforcement, reservation semantics, concurrency behavior
- Adapter behavior (timeouts, retries, consistency, error handling)
- Tool registration, invocation, or request parsing/validation
- Defaults or configuration that could change security posture
- Audit event generation or security-relevant logging

**How to request review**
- Open the PR early with a clear description of the security impact and failure modes.
- Explicitly reference which invariants in `SECURITY-INVARIANTS.md` are relevant.
- Provide a short “threat check” describing how an untrusted caller/tool/adapter might try to break the change.

---

## 5) Testing expectations

Security-sensitive behavior must be validated with tests. Manual testing is not sufficient on its own for enforcement changes.

Required expectations:

- Add tests for both **allowed** and **denied** outcomes.
- Include **negative tests** proving fail-closed behavior for:
  - missing/invalid context
  - adapter errors/timeouts (as applicable)
  - quota/limit failure paths (as applicable)
- Tests should assert **observable behavior** (deny/allow, error categories, no execution) rather than internal implementation details.
- Run the full test suite before requesting review.

When a change affects enforcement ordering, include tests that would fail if ordering regresses.

---

## 6) How to propose new adapters or tools safely

New adapters and tools are security-sensitive by default. Treat them as additions to the project’s attack surface.

### Proposing a new adapter (safe approach)
Include the following in your proposal or PR description:

- **Threat model:** What is untrusted? What failures are expected (timeouts, partial outages, stale reads)?
- **Security properties:** How enforcement remains fail-closed if the adapter cannot reliably perform its role.
- **Isolation:** How the adapter ensures strict tenant/scope separation and prevents cross-tenant influence.
- **Failure modes:** What happens on network errors, auth errors, and inconsistent responses.
- **Tests:** Concrete tests covering denial on adapter failure and denial on ambiguous/invalid inputs.

Adapters must not introduce fallback behaviors that permit execution when enforcement cannot be completed reliably.

### Proposing a new tool (safe approach)
Tools are treated as untrusted and must not weaken enforcement:

- Tools must not run unless the control plane has completed required checks.
- Tool inputs must be treated as untrusted and validated/guarded at the boundary appropriate to the tool’s risk.
- Tools must not create side effects that would undermine auditability or isolation expectations.
- Include tests demonstrating denial paths and failure paths relevant to the tool.

### Submission expectations
- Open an issue or draft PR first for security-sensitive additions (adapters/tools) to align on constraints.
- Be prepared to iterate based on security review feedback.

---

## PR process

- Keep PRs small and reviewable.
- Use the repository’s PR checklist (`PR-CHECKLIST.md`) and include evidence for each required item.
- If you are uncertain, default to **denial** and ask for guidance rather than guessing.

---

## License

By contributing, you agree that your contributions will be licensed under the project’s license (see `LICENSE`).