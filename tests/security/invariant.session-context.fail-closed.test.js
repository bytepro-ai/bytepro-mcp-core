import { executeToolBoundary } from "../../src/core/executeToolBoundary.js";
import { jest } from '@jest/globals';

describe("Security invariant: fail-closed when SessionContext is missing or invalid", () => {
  it("DENIES and produces zero side effects when sessionContext is undefined or invalid", async () => {
    // GIVEN
    let sideEffects = 0;

    const toolExecute = jest.fn(async () => {
      sideEffects += 1; // would be a side effect if it ever ran
      return { ok: true, value: "should-not-happen" };
    });

    // Treat adapters as untrusted: if called, that's an observable violation.
    const authAdapter = {
      authorize: jest.fn(async () => {
        sideEffects += 10;
        return true;
      }),
    };

    const dbAdapter = {
      query: jest.fn(async () => {
        sideEffects += 100;
        return { rows: [] };
      }),
    };

    const executionAdapter = {
      execute: jest.fn(async () => {
        sideEffects += 1000;
        return { ok: true };
      }),
    };

    // Tool registry with multiple lookup styles to avoid coupling to internals.
    const safeTool = {
      name: "safeTool",
      execute: toolExecute,
      handler: toolExecute,
      run: toolExecute,
    };

    const toolRegistry = {
      safeTool,
      tools: { safeTool },
      get: jest.fn((name) => (name === "safeTool" ? safeTool : undefined)),
      getTool: jest.fn((name) => (name === "safeTool" ? safeTool : undefined)),
      has: jest.fn((name) => name === "safeTool"),
    };

    const baseRequest = {
      toolName: "safeTool",
      input: { any: "value" },
      // sessionContext will be overridden per case
      toolRegistry,
      adapters: {
        authAdapter,
        dbAdapter,
        executionAdapter,
        // common alias keys (if boundary uses different names)
        auth: authAdapter,
        db: dbAdapter,
        execution: executionAdapter,
      },
      mode: { readOnly: false },
      meta: { requestId: "test-req-1", nowMs: Date.now() },
    };

    const cases = [
      { name: "missing sessionContext (undefined)", sessionContext: undefined },
      { name: "invalid sessionContext (null)", sessionContext: null },
      { name: "invalid sessionContext (wrong type)", sessionContext: "not-an-object" },
      { name: "invalid sessionContext (empty object)", sessionContext: {} },
    ];

    // WHEN / THEN
    for (const c of cases) {
      // WHEN
      const result = await executeToolBoundary({
        ...baseRequest,
        sessionContext: c.sessionContext,
      });

      // THEN: denial is observable
      expect(result).toBeTruthy();
      expect(result).toMatchObject({ ok: false });

      // THEN: no tool execution
      expect(toolExecute).not.toHaveBeenCalled();

      // THEN: no adapter calls (auth, db, execution)
      expect(authAdapter.authorize).not.toHaveBeenCalled();
      expect(dbAdapter.query).not.toHaveBeenCalled();
      expect(executionAdapter.execute).not.toHaveBeenCalled();

      // THEN: no side effects beyond denial
      expect(sideEffects).toBe(0);
    }
  });
});