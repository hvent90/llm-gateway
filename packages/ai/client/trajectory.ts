import type { ServerEvent } from "./server-event";

export interface TrajectoryMetadata {
  timestamp: string;
  model: string;
  mode: "agent" | "rlm";
  serverUrl: string;
  sessionId?: string;
}

export type TrajectoryEventEntry =
  | { t: number; event: ServerEvent }
  | { t: number; kind: "relay_resolution"; relayId: string; approved: boolean; always?: boolean; reason?: string }
  | { t: number; kind: "user_message"; content: string };

export interface TrajectoryFile {
  version: "1.0";
  metadata: TrajectoryMetadata;
  events: TrajectoryEventEntry[];
}

export interface TrajectoryRecorderConfig {
  model: string;
  mode: "agent" | "rlm";
  serverUrl: string;
}

export class TrajectoryRecorder {
  private startTime: number | null = null;
  private entries: TrajectoryEventEntry[] = [];
  private sessionId: string | undefined;
  private config: TrajectoryRecorderConfig;

  constructor(config: TrajectoryRecorderConfig) {
    this.config = config;
  }

  private elapsed(): number {
    if (this.startTime === null) {
      this.startTime = Date.now();
      return 0;
    }
    return Date.now() - this.startTime;
  }

  record(event: ServerEvent): void {
    if (event.type === "connected") {
      this.sessionId = event.sessionId;
    }
    this.entries.push({ t: this.elapsed(), event });
  }

  recordRelayResolution(resolution: {
    relayId: string;
    approved: boolean;
    always?: boolean;
    reason?: string;
  }): void {
    this.entries.push({
      t: this.elapsed(),
      kind: "relay_resolution",
      relayId: resolution.relayId,
      approved: resolution.approved,
      ...(resolution.always !== undefined && { always: resolution.always }),
      ...(resolution.reason !== undefined && { reason: resolution.reason }),
    });
  }

  recordUserMessage(content: string): void {
    this.entries.push({
      t: this.elapsed(),
      kind: "user_message",
      content,
    });
  }

  toJSON(): TrajectoryFile {
    return {
      version: "1.0",
      metadata: {
        timestamp: new Date().toISOString(),
        model: this.config.model,
        mode: this.config.mode,
        serverUrl: this.config.serverUrl,
        ...(this.sessionId && { sessionId: this.sessionId }),
      },
      events: this.entries,
    };
  }

  async flush(path: string): Promise<void> {
    const { mkdir } = await import("node:fs/promises");
    const dir = path.substring(0, path.lastIndexOf("/"));
    if (dir) {
      await mkdir(dir, { recursive: true });
    }
    await Bun.write(path, JSON.stringify(this.toJSON(), null, 2));
  }
}
