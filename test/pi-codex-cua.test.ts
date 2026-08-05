import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRequestMeta, prepareMcpArguments } from "../src/node-repl-client.ts";
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
