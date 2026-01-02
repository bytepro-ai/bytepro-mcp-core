import { describe, expect, test, jest } from "@jest/globals";
import { executeToolBoundary } from "../../src/core/executeToolBoundary.js";
import { SessionContext } from "../../src/core/sessionContext.js";
import { CapabilitySet, CapabilityAction } from "../../src/security/capabilities.js";

/**
 * Security invariant:
 * Read-only mode MUST block write attempts before any execution or adapter calls.
 *
 * Context:
 * - executeToolBoundary(request) is the canonical execution entrypoint.
 * - Project uses ESM; do not import server.js.
 * - Tools and adapters are untrusted.
 * - Read-only is enforced via request.mode.readOnly === true (or equivalent used by the boundary).
 */

describe("security invariant: read-only blocks writes before any side effects", () => {
  test(
    "denies write-attempting tool invocation in read-only mode with zero side effects",
    async () => {
      // 1) GIVEN a fully valid SessionContext (bound, branded, real capabilities)
      // (Construction mirrors the existing passing security tests pattern in this repo.)
      const sessionContext = new SessionContext();
      sessionContext.bind("user-1", "tenant-1", "session-1");

      const now = Date.now();
      const capabilities = new CapabilitySet({
        capSetId: "cap-set-test-readonly-1",
        issuedAt: now,
        expiresAt: now + 60 * 60 * 1000,
        issuer: "test-issuer",
        grants: [{ action: CapabilityAction.TOOL_INVOKE, target: "*" }],
      });
      sessionContext.attachCapabilities(capabilities);

      // 2) GIVEN mode.readOnly === true
      const mode = { readOnly: true };

      // 3) GIVEN a tool that would attempt a write operation (untrusted)
      const toolExecute = jest.fn(async ({ adapters }) => {
        // If this ever runs, it would attempt a write; invariant requires we never get here.
        await adapters.db.query("INSERT INTO audit_log(message) VALUES ('should-not-run')");
        return { ok: true, data: { wrote: true } };
      });

      // Tool registry must match the boundary contract: { tools: Map<string, Tool> }
      const toolRegistry = {
        tools: new Map([
          [
            "write.tool",
            {
              name: "write.tool",
              execute: toolExecute,
              schema: {},
              // Extra hints are harmless; boundary may use one of these to classify mutating tools.
              mutating: true,
              writes: true,
              readOnlySafe: false,
            },
          ],
        ]),
      };

      // Spyable adapters (must not be called)
      const auth = {
        authorizeTool: jest.fn(async () => ({ ok: true })),
        authorize: jest.fn(async () => ({ ok: true })),
        checkPermission: jest.fn(async () => ({ ok: true })),
      };

      const db = {
        query: jest.fn(async () => ({})),
        execute: jest.fn(async () => ({})),
        transaction: jest.fn(async (fn) => fn?.()),
        read: jest.fn(async () => ({})),
        write: jest.fn(async () => ({})),
      };

      const policy = {
        evaluate: jest.fn(async () => ({ ok: true })),
        check: jest.fn(async () => ({ ok: true })),
        validate: jest.fn(async () => ({ ok: true })),
      };

      const quota = {
        reserve: jest.fn(async () => ({ ok: true })),
        consume: jest.fn(async () => ({ ok: true })),
        check: jest.fn(async () => ({ ok: true })),
      };

      // 4) WHEN executeToolBoundary is invoked
      const result = await executeToolBoundary({
        sessionContext,
        mode,
        toolName: "write.tool",
        input: { sql: "INSERT INTO audit_log(message) VALUES ('x')" },
        toolRegistry,
        adapters: { auth, db, policy, quota },
      });

      // 5) THEN: observable denial
      expect(result).toBeTruthy();
      expect(result.ok).toBe(false);

      // Canonical code used by the boundary for read-only violations
      expect(result.error).toBeTruthy();
      expect(result.error.code).toBe("READ_ONLY");

      // Zero side effects: tool NOT executed
      expect(toolExecute).not.toHaveBeenCalled();

      // Zero side effects: adapters NOT called
      expect(auth.authorizeTool).not.toHaveBeenCalled();
      expect(auth.authorize).not.toHaveBeenCalled();
      expect(auth.checkPermission).not.toHaveBeenCalled();

      expect(policy.evaluate).not.toHaveBeenCalled();
      expect(policy.check).not.toHaveBeenCalled();
      expect(policy.validate).not.toHaveBeenCalled();

      expect(db.query).not.toHaveBeenCalled();
      expect(db.execute).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
      expect(db.read).not.toHaveBeenCalled();
      expect(db.write).not.toHaveBeenCalled();

      expect(quota.reserve).not.toHaveBeenCalled();
      expect(quota.consume).not.toHaveBeenCalled();
      expect(quota.check).not.toHaveBeenCalled();
    },
    300
  );
});