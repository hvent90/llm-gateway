import { describe, test, expect } from "bun:test";
import type { InvokeParams, GeneratorInvokeParams } from "../types";

describe("InvokeParams types", () => {
  test("context only has parentId, not runId", () => {
    // This test validates the type shape at compile time
    // If context.runId exists, this should cause a type error
    const params: InvokeParams = {
      model: "test",
      messages: [],
      emit: () => {},
      context: { parentId: "parent-123" },
    };

    const genParams: GeneratorInvokeParams = {
      model: "test",
      messages: [],
      context: { parentId: "parent-123" },
    };

    // Runtime check that context shape is correct
    expect(params.context).toEqual({ parentId: "parent-123" });
    expect(genParams.context).toEqual({ parentId: "parent-123" });
  });
});
