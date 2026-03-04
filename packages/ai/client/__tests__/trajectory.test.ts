import { describe, test, expect } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { TrajectoryRecorder } from "../trajectory";
import type { ServerEvent } from "../server-event";

describe("TrajectoryRecorder", () => {
  test("records events with relative timestamps", () => {
    const recorder = new TrajectoryRecorder({
      model: "test-model",
      mode: "agent",
      serverUrl: "http://localhost:4000",
    });

    const event1: ServerEvent = { type: "connected", sessionId: "sess-1" };
    const event2: ServerEvent = {
      type: "text",
      id: "t1",
      runId: "r1",
      agentId: "a1",
      content: "hello",
    };

    recorder.record(event1);
    recorder.record(event2);

    const trajectory = recorder.toJSON();

    expect(trajectory.version).toBe("1.0");
    expect(trajectory.metadata.model).toBe("test-model");
    expect(trajectory.metadata.mode).toBe("agent");
    expect(trajectory.metadata.serverUrl).toBe("http://localhost:4000");
    expect(trajectory.events).toHaveLength(2);
    expect(trajectory.events[0].t).toBe(0);
    expect("event" in trajectory.events[0] && trajectory.events[0].event).toEqual(event1);
    expect(trajectory.events[1].t).toBeGreaterThanOrEqual(0);
    expect("event" in trajectory.events[1] && trajectory.events[1].event).toEqual(event2);
  });

  test("captures sessionId from connected event", () => {
    const recorder = new TrajectoryRecorder({
      model: "test-model",
      mode: "agent",
      serverUrl: "http://localhost:4000",
    });

    recorder.record({ type: "connected", sessionId: "sess-123" });

    const trajectory = recorder.toJSON();
    expect(trajectory.metadata.sessionId).toBe("sess-123");
  });

  test("records relay resolutions interleaved with events", () => {
    const recorder = new TrajectoryRecorder({
      model: "test-model",
      mode: "agent",
      serverUrl: "http://localhost:4000",
    });

    recorder.record({ type: "connected", sessionId: "sess-1" });
    recorder.recordRelayResolution({
      relayId: "relay-1",
      approved: true,
      always: false,
    });

    const trajectory = recorder.toJSON();
    expect(trajectory.events).toHaveLength(2);
    const relayEntry = trajectory.events[1];
    expect("kind" in relayEntry && relayEntry.kind).toBe("relay_resolution");
    expect("relayId" in relayEntry && relayEntry.relayId).toBe("relay-1");
    expect("approved" in relayEntry && relayEntry.approved).toBe(true);
  });

  test("records user messages", () => {
    const recorder = new TrajectoryRecorder({
      model: "test-model",
      mode: "agent",
      serverUrl: "http://localhost:4000",
    });

    recorder.recordUserMessage("hello agent");

    const trajectory = recorder.toJSON();
    expect(trajectory.events).toHaveLength(1);
    const entry = trajectory.events[0];
    expect("kind" in entry && entry.kind).toBe("user_message");
    expect("content" in entry && entry.content).toBe("hello agent");
  });

  test("flush writes trajectory to disk", async () => {
    const recorder = new TrajectoryRecorder({
      model: "test-model",
      mode: "agent",
      serverUrl: "http://localhost:4000",
    });

    recorder.record({ type: "connected", sessionId: "sess-1" });

    const path = "/tmp/test-trajectory.json";
    try {
      await recorder.flush(path);
      expect(existsSync(path)).toBe(true);
      const contents = JSON.parse(await Bun.file(path).text());
      expect(contents.version).toBe("1.0");
      expect(contents.events).toHaveLength(1);
    } finally {
      if (existsSync(path)) rmSync(path);
    }
  });

  test("flush creates parent directories", async () => {
    const recorder = new TrajectoryRecorder({
      model: "test-model",
      mode: "agent",
      serverUrl: "http://localhost:4000",
    });

    recorder.record({ type: "connected", sessionId: "sess-1" });

    const path = "/tmp/test-trajectories/nested/trajectory.json";
    try {
      await recorder.flush(path);
      expect(existsSync(path)).toBe(true);
    } finally {
      rmSync("/tmp/test-trajectories", { recursive: true, force: true });
    }
  });
});
