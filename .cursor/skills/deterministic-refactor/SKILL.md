---
name: deterministic-refactor
description: Guides refactors of core governance logic while preserving behavioral equivalence, API surface, deterministic policy resolution, and fail-closed semantics. Use when restructuring governance logic, refactoring policy resolution, or modifying core runtime modules.
---

# Deterministic Refactor

## When to Apply

Use this skill when restructuring core governance logic in the bytepro-mcp-core repository. The agent applies it when refactoring policy resolution, tool boundaries, adapter registries, or any module that affects governance behavior.

## Invariants (Non-Negotiable)

Before and after every refactor:

1. **Behavioral equivalence** — Outputs and side effects must remain identical for all inputs.
2. **External API surface** — Do not add, remove, or change public exports or signatures.
3. **Deterministic policy resolution** — Resolution must remain order-independent; no policy decision may depend on database row order.
4. **Fail-closed semantics** — No matching policy ⇒ DENY; policy engine failure ⇒ DENY.
5. **No import-time side effects** — No server auto-start, process lifecycle ownership, or dotenv mutation on import.
6. **Test validation** — Run the full test suite before concluding; all tests must pass.

## Refactor Workflow

Copy this checklist and track progress:

```
Refactor Progress:
- [ ] Step 1: Identify scope (modules touched)
- [ ] Step 2: Verify no API surface changes
- [ ] Step 3: Apply structural changes only
- [ ] Step 4: Run full test suite
- [ ] Step 5: Confirm all tests pass before merge
```

### Step 1: Identify Scope

List all modules that will be modified. Ensure none are:
- `executeToolBoundary` (do not modify)
- Adapter implementations (do not change adapter behavior)
- Public API entry points (do not change signatures)

### Step 2: Verify No API Surface Changes

- No new external APIs
- No changes to exported function signatures
- No new public exports without explicit approval

### Step 3: Apply Structural Changes Only

- Restructure code for clarity
- Do not introduce speculative abstractions
- Do not split modules unless the resolution pipeline is finalized
- Do not invent policy semantics

### Step 4: Run Full Test Suite

```bash
npm test
```

### Step 5: Confirm Before Concluding

Only mark the refactor complete when:
- All tests pass
- No new import-time side effects were introduced
- Tenant isolation is unchanged or strengthened

## Anti-Patterns

| Avoid | Instead |
|-------|---------|
| Adding new exports "for flexibility" | Keep changes structural only |
| Changing resolution order or logic | Preserve exact semantics |
| Introducing env/config reads at import | Lazy-load or pass as parameters |
| Skipping tests "to save time" | Always run full suite before concluding |

## Related Rules

This skill aligns with:
- `.cursor/rules/Governance-Core-Invariants.mdc` — Core invariants that must never be violated
- `.cursor/rules/Refactor-Discipline-Rule.mdc` — Hardening-phase constraints
