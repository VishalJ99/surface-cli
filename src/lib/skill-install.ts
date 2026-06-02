import { copyFile, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SurfaceError } from "./errors.js";

export type SkillInstallTarget = "codex" | "claude-code";

export interface SkillInstallResult {
  agent: SkillInstallTarget;
  skill: "surface-cli";
  source: string;
  path: string;
}

const SKILL_NAME = "surface-cli";

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function bundledSkillPath(): string {
  return join(packageRoot(), "skills", SKILL_NAME, "SKILL.md");
}

export function defaultSkillDestination(target: SkillInstallTarget): string {
  switch (target) {
    case "codex":
      return join(homedir(), ".codex", "skills", SKILL_NAME, "SKILL.md");
    case "claude-code":
      return join(homedir(), ".claude", "skills", SKILL_NAME, "SKILL.md");
  }
}

export function parseSkillInstallTarget(value: string): SkillInstallTarget | "all" {
  switch (value) {
    case "codex":
      return "codex";
    case "claude":
    case "claude-code":
      return "claude-code";
    case "all":
      return "all";
    default:
      throw new SurfaceError(
        "invalid_argument",
        `Expected skill install target to be one of: codex, claude-code, all. Received '${value}'.`,
      );
  }
}

export function expandSkillInstallTargets(target: SkillInstallTarget | "all"): SkillInstallTarget[] {
  return target === "all" ? ["codex", "claude-code"] : [target];
}

export async function installSurfaceSkill(target: SkillInstallTarget): Promise<SkillInstallResult> {
  const source = bundledSkillPath();
  try {
    await stat(source);
  } catch {
    throw new SurfaceError(
      "not_found",
      `Bundled Surface skill was not found at '${source}'. Reinstall surface-cli or install the skill from GitHub.`,
    );
  }

  const destination = defaultSkillDestination(target);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);

  return {
    agent: target,
    skill: SKILL_NAME,
    source,
    path: destination,
  };
}
