import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatContextStore } from "../../src/project/context-store.js";
import type { AppContext } from "../../src/mcp/server.js";
import type { ProjectConfig } from "../../src/types.js";
import { handleSkillsList, handleSkillsRead } from "../../src/mcp/tools/skills.js";

let tmpRoot = "";
const previousCodexHome = process.env.CODEX_HOME;

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = "";
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
  it("uses the selected nested cwd and reads its folded YAML metadata and references", async () => {
    tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "local-dev-mcp-skills-")));
    process.env.CODEX_HOME = join(tmpRoot, ".codex");
    const directory = join(tmpRoot, "nested/.agents/skills/example");
    writeSkill(directory, "example", ">-\n  first line\n  second line");
    mkdirSync(join(directory, "references"));
    const reference = join(directory, "references/guide.md");
    writeFileSync(reference, "reference body");
    const ctx = createContext(createProject(tmpRoot));
    ctx.contextStore.setWorkingDirectory("chat-a", "nested");
    const listed = payload(await handleSkillsList(ctx, "chat-a", {}));
    expect(listed.cwd).toBe(join(tmpRoot, "nested"));
    expect(listed.skills).toContainEqual(expect.objectContaining({ name: "example", description: "first line second line" }));
    expect(payload(await handleSkillsRead(ctx, { path: reference })).content).toBe("reference body");
  });
  it("lists project-local, CODEX_HOME user, and system skills with readable paths", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-skills-"));
    const projectRoot = join(tmpRoot, "project");
    const codexHome = join(tmpRoot, ".codex");
    process.env.CODEX_HOME = codexHome;

    writeSkill(join(projectRoot, ".agents", "skills", "project-skill"), "project-skill", "Project workflow");
    writeSkill(join(codexHome, "skills", "user-skill"), "user-skill", "User workflow");
    writeSkill(join(codexHome, "skills", ".system", "system-skill"), "system-skill", "System workflow");
    writeFileSync(
      join(codexHome, ".haru-context-origins.json"),
      `${JSON.stringify({ version: 1, skills: { "user-skill": "private_user" } })}\n`,
      "utf8"
    );

    const ctx = createContext(createProject(projectRoot));
    const result = await handleSkillsList(ctx, "chat-a", { path: projectRoot });
    const body = payload(result);

    expect(body.cwd).toBe(projectRoot);
    expect(body.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "project-skill", scope: "project", origin: "project", path: join(projectRoot, ".agents", "skills", "project-skill", "SKILL.md") }),
        expect.objectContaining({ name: "user-skill", scope: "user", origin: "private_user", path: join(codexHome, "skills", "user-skill", "SKILL.md") }),
        expect.objectContaining({ name: "system-skill", scope: "system", origin: "system", path: join(codexHome, "skills", ".system", "system-skill", "SKILL.md") }),
      ])
    );
    expect(body.read_hint).toContain("skills.read");
    expect(body.skills.find((skill: { name: string }) => skill.name === "project-skill")).not.toHaveProperty("relative_path");
    expect(body.skills.find((skill: { name: string }) => skill.name === "project-skill")).not.toHaveProperty("enabled");

    const filtered = payload(await handleSkillsList(ctx, "chat-a", { path: projectRoot, query: "Project", scope: "project" }));
    expect(filtered.count).toBe(1);
    expect(filtered.total_count).toBe(3);
    expect(filtered.skills.map((skill: { name: string }) => skill.name)).toEqual(["project-skill"]);

    const full = payload(await handleSkillsList(ctx, "chat-a", { path: projectRoot, detail: "full", scope: "project" }));
    expect(full.skills[0]).toMatchObject({ name: "project-skill", relative_path: "project-skill/SKILL.md", enabled: true });
  });

  it("reads only SKILL.md files under allowed skill roots", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-skills-"));
    const projectRoot = join(tmpRoot, "project");
    process.env.CODEX_HOME = join(tmpRoot, ".codex");
    writeSkill(join(projectRoot, ".agents", "skills", "project-skill"), "project-skill", "Project workflow");
    writeFileSync(join(tmpRoot, "outside.md"), "nope\n", "utf8");

    const ctx = createContext(createProject(projectRoot));
    const skillPath = join(projectRoot, ".agents", "skills", "project-skill", "SKILL.md");
    const read = payload(await handleSkillsRead(ctx, { path: skillPath }));
    expect(read).toMatchObject({ name: "project-skill", description: "Project workflow", path: realpathSync(skillPath), scope: "project", origin: "project" });
    expect(read.content).toContain("# project-skill");

    const userSkillPath = join(process.env.CODEX_HOME!, "skills", "user-skill", "SKILL.md");
    const systemSkillPath = join(process.env.CODEX_HOME!, "skills", ".system", "system-skill", "SKILL.md");
    writeSkill(join(process.env.CODEX_HOME!, "skills", "user-skill"), "user-skill", "User workflow");
    writeSkill(join(process.env.CODEX_HOME!, "skills", ".system", "system-skill"), "system-skill", "System workflow");
    writeFileSync(
      join(process.env.CODEX_HOME!, ".haru-context-origins.json"),
      `${JSON.stringify({ version: 1, skills: { "user-skill": "private_user" } })}\n`,
      "utf8"
    );
    expect(payload(await handleSkillsRead(ctx, { path: userSkillPath }))).toMatchObject({ scope: "user", origin: "private_user", name: "user-skill" });
    expect(payload(await handleSkillsRead(ctx, { path: systemSkillPath }))).toMatchObject({ scope: "system", origin: "system", name: "system-skill" });

    const outside = await handleSkillsRead(ctx, { path: join(tmpRoot, "outside.md") });
    expect(outside.isError).toBe(true);
    expect(payload(outside).error.code).toBe("PATH_OUTSIDE_SKILLS_ROOTS");
  });

  it("rejects a SKILL.md symlink that points outside an allowed root", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-skills-"));
    const projectRoot = join(tmpRoot, "project");
    process.env.CODEX_HOME = join(tmpRoot, ".codex");
    const outsideDir = join(tmpRoot, "outside-skill");
    writeSkill(outsideDir, "outside-skill", "Outside workflow");
    const linkedDir = join(projectRoot, ".agents", "skills", "linked-skill");
    mkdirSync(linkedDir, { recursive: true });
    const linkedPath = join(linkedDir, "SKILL.md");
    symlinkSync(join(outsideDir, "SKILL.md"), linkedPath);

    const ctx = createContext(createProject(projectRoot));
    const result = await handleSkillsRead(ctx, { path: linkedPath });
    expect(result.isError).toBe(true);
    expect(payload(result).error.code).toBe("SKILL_SYMLINK_NOT_ALLOWED");
  });
});
