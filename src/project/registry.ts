import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { load as parseYaml } from "js-yaml";
import type { ProjectConfig } from "../types.js";
import type { RawConfig } from "./config-schema.js";
import { validateProjectConfig } from "./config-schema.js";

export class ProjectRegistry {
  private projects: Map<string, ProjectConfig> = new Map();
  private configPath: string = "";

  static async load(configPath: string): Promise<ProjectRegistry> {
    if (!existsSync(configPath)) {
      throw new Error(`Config file not found: ${configPath}`);
    }
    const registry = new ProjectRegistry();
    registry.configPath = configPath;
    await registry.reload();
    return registry;
  }

  async reload(): Promise<string[]> {
    const raw = await readFile(this.configPath, "utf-8");
    const parsed = parseYaml(raw) as RawConfig;
    if (!parsed?.projects || typeof parsed.projects !== "object") {
      throw new Error("Invalid config: missing 'projects' key");
    }

    const next = new Map<string, ProjectConfig>();
    for (const [id, rawProject] of Object.entries(parsed.projects)) {
      const validated = validateProjectConfig(id, rawProject);
      next.set(id, validated);
    }

    this.projects = next;
    return this.getAll().map((p) => p.projectId);
  }

  get(projectId: string): ProjectConfig | undefined {
    return this.projects.get(projectId);
  }

  getAll(): ProjectConfig[] {
    return Array.from(this.projects.values());
  }

  has(projectId: string): boolean {
    return this.projects.has(projectId);
  }
}
