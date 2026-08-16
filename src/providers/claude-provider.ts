import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import type { ModelListResponse } from "../../generated/app-server/v2/ModelListResponse";
import { ProviderError, type ModelProviderAdapter, type ProviderDescriptor } from "./types.js";

export class ClaudeProviderAdapter implements ModelProviderAdapter {
  readonly id = "claude" as const;

  async describe(): Promise<ProviderDescriptor> {
    const installed = await commandExists(process.env.CLAUDE_BIN ?? "claude");
    return {
      id: this.id,
      name: "Claude Code",
      available: false,
      status: installed ? "login_required" : "not_installed",
      detail: installed
        ? "CLI가 감지됐습니다. 실행·대화 어댑터를 연결한 뒤 사용할 수 있습니다."
        : "이 단말에 Claude Code CLI가 설치되지 않았습니다.",
      accounts: [],
      loginCommand: "claude",
    };
  }

  async listModels(): Promise<ModelListResponse> {
    throw new ProviderError(409, "Claude Code 실행 어댑터는 아직 연결되지 않았습니다.");
  }

  assertAccount(): void {
    throw new ProviderError(409, "Claude Code 실행 어댑터는 아직 연결되지 않았습니다.");
  }
}

async function commandExists(command: string): Promise<boolean> {
  if (isAbsolute(command)) return isExecutable(command);
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    if (await isExecutable(join(directory, command))) return true;
  }
  return false;
}

async function isExecutable(path: string): Promise<boolean> {
  return access(path, constants.X_OK).then(() => true, () => false);
}
