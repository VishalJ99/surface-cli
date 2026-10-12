import { execFileSync } from "node:child_process";
import { readlinkSync } from "node:fs";

export interface ProcessIdentitySnapshot {
  pid: number;
  parentPid: number;
  processGroupId: number;
  startedAt: string;
  elapsedSeconds: number;
  executablePath: string;
  commandLine: string;
}

function elapsedSeconds(value: string): number | null {
  const [day, clock] = value.includes("-") ? value.split("-", 2) : ["0", value];
  const parts = clock?.split(":").map(Number);
  if (!parts || ![2, 3].includes(parts.length) || parts.some(part => !Number.isInteger(part) || part < 0)) return null;
  const seconds = parts.at(-1)!; const minutes = parts.at(-2)!;
  const hours = parts.length === 3 ? parts[0]! : 0;
  if (seconds > 59 || minutes > 59 || hours > 23 || !/^\d+$/u.test(day ?? "")) return null;
  return Number(day) * 86400 + hours * 3600 + minutes * 60 + seconds;
}

/** Separate comm from argv, and reject a PID reused between the two snapshots. */
export function snapshotProcessIdentities(): ProcessIdentitySnapshot[] {
  if (!["darwin", "linux"].includes(process.platform)) return [];
  try {
    const commandOutput = execFileSync("ps", ["-ww", "-axo", "pid=,lstart=,command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" } });
    const identityOutput = execFileSync("ps", ["-ww", "-axo", "pid=,ppid=,pgid=,lstart=,etime=,comm="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" } });
    const commands = new Map<number, { startedAt: string; commandLine: string }>();
    for (const line of commandOutput.split("\n")) {
      const match = line.match(/^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/u);
      if (match) commands.set(Number(match[1]), { startedAt: match[2]!.replace(/\s+/gu, " "), commandLine: match[3]! });
    }
    const result: ProcessIdentitySnapshot[] = [];
    for (const line of identityOutput.split("\n")) {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s+(.+)$/u);
      if (!match) continue;
      const pid = Number(match[1]); const command = commands.get(pid);
      const startedAt = match[4]!.replace(/\s+/gu, " "); const elapsed = elapsedSeconds(match[5]!);
      if (!command || command.startedAt !== startedAt || elapsed === null) continue;
      let executablePath = match[6]!.trim();
      if (process.platform === "linux") {
        try { executablePath = readlinkSync(`/proc/${pid}/exe`); }
        catch { continue; } // Unknown executable identity must fail closed.
      }
      result.push({ pid, parentPid: Number(match[2]), processGroupId: Number(match[3]), startedAt,
        elapsedSeconds: elapsed, executablePath, commandLine: command.commandLine });
    }
    return result;
  } catch { return []; }
}

export function processCommandLineTokens(commandLine: string): string[] {
  const tokens: string[] = []; let current = ""; let quote: "'" | '"' | null = null; let escaped = false;
  for (const character of commandLine) {
    if (escaped) { current += character; escaped = false; continue; }
    if (character === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (character === quote) quote = null; else current += character; continue; }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (/\s/u.test(character)) { if (current) { tokens.push(current); current = ""; } continue; }
    current += character;
  }
  if (escaped) current += "\\";
  if (current) tokens.push(current);
  return tokens;
}
