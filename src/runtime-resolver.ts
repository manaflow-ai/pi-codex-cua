import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type CodexCuaRuntime = {
  clientPath: string;
  codexCliPath: string;
  serviceAppPath: string;
  socketDirectory: string;
};

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function first(paths: Array<string | undefined>, predicate = readable): string | undefined {
  return paths.find((path): path is string => Boolean(path && predicate(path)));
}

export function resolveCodexCuaRuntime(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): CodexCuaRuntime {
  if (process.platform !== "darwin" && !env.PI_CODEX_CUA_ALLOW_UNSUPPORTED_PLATFORM) {
    throw new Error("Codex Sky Computer Use currently requires macOS");
  }

  const appResources = env.PI_CODEX_CUA_RESOURCES ??
    "/Applications/ChatGPT.app/Contents/Resources";
  const installedService = join(home, ".codex", "computer-use", "Codex Computer Use.app");
  const clientRelative = join(
    "Contents",
    "SharedSupport",
    "SkyComputerUseClient.app",
    "Contents",
    "MacOS",
    "SkyComputerUseClient",
  );
  const serviceAppPath = first([
    env.PI_CODEX_CUA_SERVICE,
    installedService,
  ]);
  const clientPath = first(
    [
      env.PI_CODEX_CUA_CLIENT,
      serviceAppPath ? join(serviceAppPath, clientRelative) : undefined,
    ],
    executable,
  );
  const codexCliPath = first(
    [env.PI_CODEX_CUA_CODEX, join(appResources, "codex")],
    executable,
  );
  const socketDirectory = env.PI_CODEX_CUA_SOCKET_DIRECTORY ?? join(
    home,
    "Library",
    "Group Containers",
    "2DC432GLL2.com.openai.sky.CUAService",
    "IPC",
  );

  const missing = [
    ["Codex Computer Use.app", serviceAppPath],
    ["SkyComputerUseClient", clientPath],
    ["Codex CLI", codexCliPath],
    ["Computer Use IPC directory", readable(socketDirectory) ? socketDirectory : undefined],
  ].filter((entry) => !entry[1]).map((entry) => entry[0]);
  if (missing.length > 0) {
    throw new Error(
      `Codex Computer Use runtime is unavailable (missing ${missing.join(", ")}). ` +
      "Install or update the ChatGPT/Codex desktop app.",
    );
  }

  return {
    clientPath: clientPath!,
    codexCliPath: codexCliPath!,
    serviceAppPath: serviceAppPath!,
    socketDirectory,
  };
}
