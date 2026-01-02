import { describe, expect, test, jest } from "@jest/globals";
import { executeToolBoundary } from "../../src/core/executeToolBoundary.js";
import { SessionContext } from "../../src/core/sessionContext.js";
import { CapabilitySet, CapabilityAction } from "../../src/security/capabilities.js";

/**
 * Security invariant: Unknown tool names must produce an immediate denial with ZERO side effects.
 *
 * Context:
 * - executeToolBoundary(request) is the canonical execution entrypoint.
 * - The boundary validates SessionContext, then tool lookup, then authorization.
 * - Tests run in ESM and must not import server.js.
 * - Tools and adapters are untrusted.
 */

describe("security invariant: unknown tool -> immediate denial with zero side effects", () => {
  test(
    'denies "nonexistent.tool" without calling any adapter or executing any tool',
    async () => {
      // 1) GIVEN a fully valid SessionContext (bound, branded, with real capabilities)
      // Reusing construction from T2/Block-2 tests
      const sessionContext = new SessionContext();
      sessionContext.bind("user-1", "tenant-1", "session-1");

      const now = Date.now();
      const capabilities = new CapabilitySet({
        capSetId: "cap-set-test-1",
        issuedAt: now,
        expiresAt: now + 3600000, // 1 hour from now
        issuer: "test-issuer",
        grants: [
          { action: CapabilityAction.TOOL_INVOKE, target: "*" }
        ]
      });
      sessionContext.attachCapabilities(capabilities);

      // 2) GIVEN an empty or known-only toolRegistry (does NOT contain the requested tool)
      // Must match the exact structure used by executeToolBoundary: { tools: Map<string, Tool> }
      const knownToolExecute = jest.fn(async () => ({ ok: true, data: {} }));
      const toolRegistry = {
        tools: new Map([
          [
            "known.tool",
            {
              name: "known.tool",
              execute: knownToolExecute,
              schema: {},
            },
          ],
        ]),
      };

      // 3) GIVEN spyable adapters (auth, db, policy, quota if present)
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

      // 4) WHEN executeToolBoundary is called with toolName = "nonexistent.tool"
      const request = {
        sessionContext,
        toolName: "nonexistent.tool",
        input: { any: "payload" },
        toolRegistry,
        adapters: { auth, db, policy, quota },
      };

      const result = await executeToolBoundary(request);

      // 5) THEN:
      // - result.ok === false
      expect(result).toBeTruthy();
      expect(result.ok).toBe(false);

      // - error.code === "TOOL_NOT_FOUND"
      expect(result.error?.code).toBe("TOOL_NOT_FOUND");

      // - auth adapter is NOT called
      expect(auth.authorizeTool).not.toHaveBeenCalled();
      expect(auth.authorize).not.toHaveBeenCalled();
      expect(auth.checkPermission).not.toHaveBeenCalled();

      // - db adapter is NOT called
      expect(db.query).not.toHaveBeenCalled();
      expect(db.execute).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
      expect(db.read).not.toHaveBeenCalled();
      expect(db.write).not.toHaveBeenCalled();

      // - policy adapter is NOT called
      expect(policy.evaluate).not.toHaveBeenCalled();
      expect(policy.check).not.toHaveBeenCalled();
      expect(policy.validate).not.toHaveBeenCalled();

      // - NO tool execution occurs
      expect(knownToolExecute).not.toHaveBeenCalled();

      // - No quota reservation occurs (if observable)
      expect(quota.reserve).not.toHaveBeenCalled();
      expect(quota.consume).not.toHaveBeenCalled();
      expect(quota.check).not.toHaveBeenCalled();
    },
    300 // Complete in <300ms
  );
});
