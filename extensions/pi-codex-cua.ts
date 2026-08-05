import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";
import {
  newTurnIdentity,
  NodeReplClient,
  type McpCallResult,
  type TurnIdentity,
} from "../src/node-repl-client.ts";
import { resolveCodexCuaRuntime } from "../src/runtime-resolver.ts";

const app = Type.String({
  description: "App display name, full .app path, bundle identifier, or id from list_apps",
});
const elementIndex = Type.Integer({
  minimum: 0,
  description: "Element index from the latest get_app_state accessibility text",
});
const mouseButton = StringEnum(["left", "right", "middle", "l", "r", "m"] as const);
const direction = StringEnum(["up", "down", "left", "right", "u", "d", "l", "r"] as const);

type ToolSpec = {
  name: string;
  description: string;
  parameters: TSchema;
  readOnly: boolean;
};

export const skyToolSpecs: ToolSpec[] = [
  {
    name: "list_apps",
    description:
      "List apps targetable by Codex Computer Use, including recent/running state and canonical ids.",
    parameters: Type.Object({}, { additionalProperties: false }),
    readOnly: true,
  },
  {
    name: "get_app_state",
    description:
      "Capture an app window's screenshot and indexed accessibility text. Text is a diff by default; request a full tree with disableDiff.",
    parameters: Type.Object({
      app,
      disableDiff: Type.Optional(Type.Boolean({
        description: "Return a full accessibility tree instead of a diff",
      })),
    }, { additionalProperties: false }),
    readOnly: true,
  },
  {
    name: "click",
    description:
      "Click an indexed element from the latest app state or an app-window screenshot coordinate.",
    parameters: Type.Object({
      app,
      element_index: Type.Optional(elementIndex),
      x: Type.Optional(Type.Number({ description: "Screenshot-relative X coordinate" })),
      y: Type.Optional(Type.Number({ description: "Screenshot-relative Y coordinate" })),
      mouse_button: Type.Optional(mouseButton),
      click_count: Type.Optional(Type.Integer({ minimum: 1, description: "Defaults to 1" })),
    }, { additionalProperties: false }),
    readOnly: false,
  },
  {
    name: "drag",
    description: "Drag between two app-window screenshot-relative coordinates.",
    parameters: Type.Object({
      app,
      from_x: Type.Number(),
      from_y: Type.Number(),
      to_x: Type.Number(),
      to_y: Type.Number(),
    }, { additionalProperties: false }),
    readOnly: false,
  },
  {
    name: "perform_secondary_action",
    description:
      "Invoke a secondary accessibility action explicitly exposed for an indexed element.",
    parameters: Type.Object({
      app,
      element_index: elementIndex,
      action: Type.String({ description: "Exact exposed accessibility action name" }),
    }, { additionalProperties: false }),
    readOnly: false,
  },
  {
    name: "press_key",
    description:
      "Press a key or + separated X keysym-style chord in an app, such as Return, Tab, Control_L+a, or Super_L+d.",
    parameters: Type.Object({ app, key: Type.String() }, { additionalProperties: false }),
    readOnly: false,
  },
  {
    name: "scroll",
    description: "Scroll an indexed app element in a direction by a number of pages.",
    parameters: Type.Object({
      app,
      element_index: elementIndex,
      direction,
      pages: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Defaults to 1" })),
    }, { additionalProperties: false }),
    readOnly: false,
  },
  {
    name: "select_text",
    description:
      "Select exact text in an indexed editable element or place the cursor before/after it.",
    parameters: Type.Object({
      app,
      element_index: elementIndex,
      text: Type.String(),
      prefix: Type.Optional(Type.String()),
      suffix: Type.Optional(Type.String()),
      selection_type: Type.Optional(
        StringEnum(["text", "cursor_before", "cursor_after"] as const),
      ),
    }, { additionalProperties: false }),
    readOnly: false,
  },
  {
    name: "set_value",
    description: "Replace the value of an indexed settable accessibility element.",
    parameters: Type.Object({
      app,
      element_index: elementIndex,
      value: Type.String(),
    }, { additionalProperties: false }),
    readOnly: false,
  },
  {
    name: "type_text",
    description: "Type literal text into the current focus in the specified app.",
    parameters: Type.Object({ app, text: Type.String() }, { additionalProperties: false }),
    readOnly: false,
  },
];

export default function piCodexCua(pi: ExtensionAPI) {
  let client: NodeReplClient | undefined;
  let runtimeError: Error | undefined;
  let turn: TurnIdentity | undefined;
  let sessionId = randomSessionId();

  try {
    client = new NodeReplClient(resolveCodexCuaRuntime());
  } catch (error) {
    runtimeError = error instanceof Error ? error : new Error(String(error));
  }

  for (const spec of skyToolSpecs) {
    pi.registerTool({
      name: spec.name,
      label: spec.name.replaceAll("_", " "),
      description: spec.description,
      promptSnippet:
        spec.name === "get_app_state"
          ? "Inspect and control local macOS apps through OpenAI Codex Computer Use"
          : undefined,
      promptGuidelines:
        spec.name === "get_app_state"
          ? [
              "Use get_app_state before interacting with an app and after actions; do not reuse stale element indexes.",
              "Prefer element indexes over coordinates, and use screenshot coordinates only when accessibility is insufficient.",
              "Use list_apps only when an app cannot be identified directly.",
              "Ask immediately before consequential Computer Use actions unless the user's request specifically pre-authorized that exact action; never bypass security warnings, change credentials, or execute regulated financial transactions for the user.",
            ]
          : undefined,
      parameters: spec.parameters,
      executionMode: "sequential",
      async execute(_toolCallId, args, signal, _onUpdate, ctx) {
        if (runtimeError) throw runtimeError;
        if (!client) throw new Error("Codex Computer Use client is unavailable");
        turn ??= newTurnIdentity(
          ctx.sessionManager.getSessionId(),
          ctx.model?.id ?? "unknown",
          ctx.thinkingLevel,
        );
        const result = await client.callSky(
          spec.name,
          args as Record<string, unknown>,
          turn,
          signal,
        );
        if (result.isError) throw new Error(resultText(result) || "Codex Computer Use failed");
        return {
          content: result.content ?? [{ type: "text", text: "(no output)" }],
          details: { method: spec.name, args, meta: result._meta },
        };
      },
      renderCall(args, theme) {
        const target = typeof (args as any).app === "string" ? ` ${(args as any).app}` : "";
        return new Text(
          `${theme.fg("toolTitle", theme.bold(spec.name))}${theme.fg("muted", target)}`,
          0,
          0,
        );
      },
      renderResult(result, { expanded }, theme, { isError }) {
        const text = result.content
          .filter((item) => item.type === "text")
          .map((item: any) => item.text)
          .join("\n");
        const visible = expanded || text.length <= 2_000
          ? text
          : `${text.slice(0, 2_000).trimEnd()}\n…`;
        return new Text(theme.fg(isError ? "error" : "toolOutput", visible), 0, 0);
      },
    });
  }

  pi.on("session_start", (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    turn = undefined;
    if (runtimeError && ctx.hasUI) ctx.ui.notify(runtimeError.message, "warning");
  });
  pi.on("agent_start", (_event, ctx) => {
    turn = newTurnIdentity(
      ctx.sessionManager.getSessionId() || sessionId,
      ctx.model?.id ?? "unknown",
      ctx.thinkingLevel,
    );
  });
  pi.on("agent_end", () => {
    turn = undefined;
  });
  pi.on("session_shutdown", () => {
    client?.close();
  });
}

function resultText(result: McpCallResult): string {
  return (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function randomSessionId(): string {
  return `pi-cua-${Date.now().toString(36)}`;
}
