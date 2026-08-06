import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface, type Interface } from "node:readline";
import type { CodexCuaRuntime } from "./runtime-resolver.ts";

type JsonRpcResponse = {
  id: number;
  result?: McpCallResult;
  error?: { code: number; message: string; data?: unknown };
};

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type McpCallResult = {
  content?: McpContent[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

export type TurnIdentity = {
  sessionId: string;
  threadId: string;
  turnId: string;
  startedAt: number;
  model: string;
  reasoningEffort?: string;
};

type Pending = {
  resolve(value: McpCallResult): void;
  reject(error: Error): void;
};

export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
export const DEFAULT_INITIALIZE_TIMEOUT_MS = 15_000;

export type NodeReplClientOptions = {
  toolTimeoutMs?: number;
  initializeTimeoutMs?: number;
};

class RequestInterruptedError extends Error {}

export class NodeReplClient {
  private readonly runtime: CodexCuaRuntime;
  private readonly toolTimeoutMs: number;
  private readonly initializeTimeoutMs: number;
  private child?: ChildProcessWithoutNullStreams;
  private lines?: Interface;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private starting?: Promise<void>;
  private stderr = "";

  constructor(runtime: CodexCuaRuntime, options: NodeReplClientOptions = {}) {
    this.runtime = runtime;
    this.toolTimeoutMs = options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    this.initializeTimeoutMs = options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
  }

  async callSky(
    method: string,
    args: Record<string, unknown>,
    turn: TurnIdentity,
    signal?: AbortSignal,
  ): Promise<McpCallResult> {
    try {
      await this.start();
      return await this.request(
        "tools/call",
        {
          name: method,
          arguments: prepareMcpArguments(method, args),
          _meta: buildRequestMeta(turn),
        },
        signal,
        this.toolTimeoutMs,
        method,
      );
    } catch (error) {
      if (error instanceof RequestInterruptedError) this.terminateChild();
      throw error;
    }
  }

  async start(): Promise<void> {
    if (this.child && this.child.exitCode === null) return;
    if (this.starting) return this.starting;
    this.starting = this.startImpl().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async startImpl() {
    // The Computer Use service authenticates the sender process. Launching its
    // signed client through Codex's signed sandbox runner matches the process
    // chain used by the first-party desktop app; spawning the client directly
    // is rejected with senderProcessNotAuthenticated (-10000).
    const child = spawn(this.runtime.codexCliPath, [
      "sandbox",
      "-P",
      ":danger-full-access",
      "--allow-unix-socket",
      this.runtime.socketDirectory,
      this.runtime.clientPath,
      "mcp",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: process.env.CODEX_HOME ?? `${process.env.HOME}/.codex/computer-use`,
      env: { ...process.env },
    });
    this.child = child;
    this.stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8_000);
    });
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.onLine(line));
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      const detail = this.stderr.trim();
      const error = new Error(
        `Codex Computer Use exited (${signal ?? code ?? "unknown"})${detail ? `: ${detail}` : ""}`,
      );
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.child = undefined;
      this.lines?.close();
      this.lines = undefined;
    });

    try {
      await this.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "pi-codex-cua", version: "0.1.0" },
      }, undefined, this.initializeTimeoutMs, "initialization");
      this.notify("notifications/initialized", {});
    } catch (error) {
      this.terminateChild();
      throw error;
    }
  }

  private onLine(line: string) {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      const response = message as JsonRpcResponse;
      if (response.error) {
        pending.reject(new Error(`Computer Use RPC ${response.error.code}: ${response.error.message}`));
      } else {
        pending.resolve(response.result ?? {});
      }
      return;
    }
    if (typeof message.id === "number" && typeof message.method === "string") {
      this.write({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `Unsupported client method: ${message.method}` },
      });
    }
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = this.toolTimeoutMs,
    operation = method,
  ): Promise<McpCallResult> {
    if (!this.child || this.child.exitCode !== null) {
      return Promise.reject(new Error("Codex node_repl is not running"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timeout: NodeJS.Timeout | undefined;
      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        this.pending.delete(id);
        this.notify("notifications/cancelled", { requestId: id, reason: "Pi tool call cancelled" });
        cleanup();
        reject(new RequestInterruptedError(
          signal?.reason instanceof Error ? signal.reason.message : "Cancelled",
        ));
      };
      this.pending.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) return onAbort();
      timeout = setTimeout(() => {
        this.pending.delete(id);
        this.notify("notifications/cancelled", {
          requestId: id,
          reason: `${operation} timed out`,
        });
        cleanup();
        reject(new RequestInterruptedError(
          `Codex Computer Use ${operation} timed out after ${formatDuration(timeoutMs)}. ` +
          "The bridge was restarted so later tool calls can continue. " +
          "The app may be waiting for an approval or security advisory.",
        ));
      }, timeoutMs);
      timeout.unref();
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: Record<string, unknown>) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: unknown) {
    this.child?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  close() {
    this.terminateChild();
  }

  private terminateChild() {
    this.lines?.close();
    this.child?.kill("SIGTERM");
    this.child = undefined;
    this.lines = undefined;
  }
}

function formatDuration(milliseconds: number): string {
  return milliseconds % 1_000 === 0
    ? `${milliseconds / 1_000}s`
    : `${milliseconds}ms`;
}

export function buildRequestMeta(turn: TurnIdentity) {
  return {
    "x-codex-turn-metadata": {
      session_id: turn.sessionId,
      thread_id: turn.threadId,
      turn_id: turn.turnId,
      turn_started_at_unix_ms: turn.startedAt,
      model: turn.model,
      ...(turn.reasoningEffort ? { reasoning_effort: turn.reasoningEffort } : {}),
      sandbox: "danger-full-access",
    },
    "codex/plugin_id": "computer-use@openai-bundled",
    threadId: turn.threadId,
  };
}

export function newTurnIdentity(
  sessionId: string,
  model: string,
  reasoningEffort?: string,
): TurnIdentity {
  return {
    sessionId,
    threadId: sessionId,
    turnId: randomUUID(),
    startedAt: Date.now(),
    model,
    reasoningEffort,
  };
}

export function prepareMcpArguments(
  method: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const prepared = { ...args };
  if (typeof prepared.element_index === "number") {
    prepared.element_index = String(prepared.element_index);
  }
  // The first-party MCP bridge predates Sky's selection_type spelling.
  if (method === "select_text" && prepared.selection_type !== undefined) {
    prepared.selection = prepared.selection_type;
    delete prepared.selection_type;
  }
  return prepared;
}
