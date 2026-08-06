import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_INITIALIZE_TIMEOUT_MS,
  DEFAULT_TOOL_TIMEOUT_MS,
  NodeReplClient,
  buildRequestMeta,
  newTurnIdentity,
  prepareMcpArguments,
} from "../src/node-repl-client.ts";
import { skyToolSpecs } from "../extensions/pi-codex-cua.ts";

test("exposes the complete macOS Sky surface", () => {
  assert.deepEqual(
    skyToolSpecs.map((tool) => tool.name),
    [
      "list_apps",
      "get_app_state",
      "click",
      "drag",
      "perform_secondary_action",
      "press_key",
      "scroll",
      "select_text",
      "set_value",
      "type_text",
    ],
  );
});

test("adapts current Sky arguments to the first-party MCP bridge", () => {
  assert.deepEqual(
    prepareMcpArguments("select_text", {
      app: "TextEdit",
      element_index: 42,
      text: "hello",
      selection_type: "cursor_after",
    }),
    {
      app: "TextEdit",
      element_index: "42",
      text: "hello",
      selection: "cursor_after",
    },
  );
});

test("request metadata matches Codex MCP turn metadata", () => {
  const meta = buildRequestMeta({
    sessionId: "session",
    threadId: "thread",
    turnId: "turn",
    startedAt: 123,
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
  });
  assert.deepEqual(meta["x-codex-turn-metadata"], {
    session_id: "session",
    thread_id: "thread",
    turn_id: "turn",
    turn_started_at_unix_ms: 123,
    model: "gpt-5.6-sol",
    reasoning_effort: "medium",
    sandbox: "danger-full-access",
  });
  assert.equal(meta["codex/plugin_id"], "computer-use@openai-bundled");
});

test("uses bounded defaults for initialization and every tool call", () => {
  assert.equal(DEFAULT_INITIALIZE_TIMEOUT_MS, 15_000);
  assert.equal(DEFAULT_TOOL_TIMEOUT_MS, 30_000);
});

test("times out a stuck tool and restarts the bridge for the next call", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-codex-cua-test-"));
  const executable = join(directory, "fake-codex");
  const launches = join(directory, "launches");
  await writeFile(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const counter = ${JSON.stringify(launches)};
let launch = 1;
try { launch = Number(fs.readFileSync(counter, "utf8")) + 1; } catch {}
fs.writeFileSync(counter, String(launch));
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }));
  } else if (request.method === "tools/call" && launch > 1) {
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: { content: [{ type: "text", text: "recovered" }] }
    }));
  }
});
`);
  await chmod(executable, 0o755);

  const client = new NodeReplClient({
    codexCliPath: executable,
    clientPath: executable,
    serviceAppPath: directory,
    socketDirectory: directory,
  }, {
    toolTimeoutMs: 50,
    initializeTimeoutMs: 1_000,
  });
  const turn = newTurnIdentity("session", "model");

  try {
    await assert.rejects(
      client.callSky("get_app_state", { app: "Example" }, turn),
      /timed out after 50ms.*bridge was restarted.*security advisory/,
    );
    const result = await client.callSky("list_apps", {}, turn);
    assert.equal(result.content?.[0]?.type, "text");
    assert.equal(result.content?.[0]?.type === "text" ? result.content[0].text : "", "recovered");
    assert.equal(await readFile(launches, "utf8"), "2");
  } finally {
    client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
