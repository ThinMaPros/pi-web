import { existsSync, linkSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Resolve pi-web-owned data below its private data directory, migrating legacy files once. */
export function piWebDataPath(name: string, agentDir = getAgentDir()): string {
  const directory = join(agentDir, "pi-web");
  const path = join(directory, name);
  const legacyPath = join(agentDir, name);
  if (!existsSync(path) && existsSync(legacyPath)) {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      // local: link is an atomic no-clobber move claim; POSIX rename would replace a concurrent destination.
      linkSync(legacyPath, path);
      unlinkSync(legacyPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "EEXIST") throw error;
    }
  }
  return path;
}
