import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatContextStore } from "../../src/project/context-store.js";
import type { AppContext } from "../../src/mcp/server.js";
import type { ProjectConfig } from "../../src/types.js";
import { handleSkillsList, handleSkillsRead } from "../../src/mcp/tools/skills.js";

let tmpRoot = "";
const previousHaruContextHome = process.env.HARU_CONTEXT_HOME;
const previousCodexHome = process.env.CODEX_HOME;

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = "";
  }
  if (previousHaruContextHome === undefined) {
    delete process.env.HARU_CONTEXT_HOME;
  } else {
    process.env.HARU_CONTEXT_HOME = previousHaruContextHome;
  }
  if (previousCodexHome === undefined) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = previousCodexHome;
  }
});

function createProject(hostRoot: string): ProjectConfig {
  return {
    projectId: "alpha",
    displayName: "Alpha",
    hostRoot,
    sandboxRoot: hostRoot,
    sandboxType: "host",
    defaultShell: "/bin/bash",
    defaultTimeoutSeconds: 30,
    maxTimeoutSeconds: 300,
    networkPolicy: "ask",
    writePolicy: "allow",
    approvalMode: "catastrophic_only",
    deniedPaths: [".env", ".env.*", "secrets"],
    redactionProfile: "default",
  };
}

function createContext(project: ProjectConfig) {
  const contextStore = new ChatContextStore();
  contextStore.setCurrentProject("chat-a", project.projectId);
  return {
    registry: {
      has: (projectId: string) => projectId === project.projectId,
      get: (projectId: string) => (projectId === project.projectId ? project : undefined),
      getAll: () => [project],
    },
    contextStore,
  } as unknown as AppContext;
}

function payload(result: { content: Array<{ text?: string }> }) {
  return JSON.parse(result.content[0].text ?? "{}");
}

function writeSkill(path: string, name: string, description: string) {
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nUse this skill.\n`,
    "utf8"
  );
}

describe("skills tools", () => {
  it("lists project-local, common, and system skills with readable paths", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-skills-"));
    const projectRoot = join(tmpRoot, "project");
    const haruContextHome = join(tmpRoot, ".haru");
    const codexHome = join(tmpRoot, ".codex");
    process.env.HARU_CONTEXT_HOME = haruContextHome;
    process.env.CODEX_HOME = codexHome;

    writeSkill(join(projectRoot, ".agents", "skills", "project-skill"), "project-skill", "Project workflow");
    writeSkill(join(haruContextHome, "skills", "common-skill"), "common-skill", "Common workflow");
    writeSkill(join(codexHome, "skills", ".system", "system-skill"), "system-skill", "System workflow");

    const ctx = createContext(createProject(projectRoot));
    const result = await handleSkillsList(ctx, "chat-a", { path: projectRoot });
    const body = payload(result);

    expect(body.cwd).toBe(projectRoot);
    expect(body.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "project-skill", scope: "project", path: join(projectRoot, ".agents", "skills", "project-skill", "SKILL.md") }),
        expect.objectContaining({ name: "common-skill", scope: "common", path: join(haruContextHome, "skills", "common-skill", "SKILL.md") }),
        expect.objectContaining({ name: "system-skill", scope: "system", path: join(codexHome, "skills", ".system", "system-skill", "SKILL.md") }),
      ])
    );
    expect(body.read_hint).toContain("skills.read");
  });

  it("reads only SKILL.md files under allowed skill roots", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-skills-"));
    const projectRoot = join(tmpRoot, "project");
    process.env.HARU_CONTEXT_HOME = join(tmpRoot, ".haru");
    process.env.CODEX_HOME = join(tmpRoot, ".codex");
    writeSkill(join(projectRoot, ".agents", "skills", "project-skill"), "project-skill", "Project workflow");
    writeFileSync(join(tmpRoot, "outside.md"), "nope\n", "utf8");

    const ctx = createContext(createProject(projectRoot));
    const skillPath = join(projectRoot, ".agents", "skills", "project-skill", "SKILL.md");
    const read = payload(await handleSkillsRead(ctx, { path: skillPath }));
    expect(read).toMatchObject({ name: "project-skill", description: "Project workflow", path: skillPath });
    expect(read.content).toContain("# project-skill");

    const outside = await handleSkillsRead(ctx, { path: join(tmpRoot, "outside.md") });
    expect(outside.isError).toBe(true);
    expect(payload(outside).error.code).toBe("NOT_SKILL_FILE");
  });
});
