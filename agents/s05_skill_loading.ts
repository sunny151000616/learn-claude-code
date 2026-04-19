#!/usr/bin/env -S npx tsx
/// <reference path="./s02_tool_use.d.ts" />
/**
 * s05_skill_loading.ts - Skills
 *
 * Two-layer skill injection keeps the system prompt small:
 *
 *     Layer 1 (cheap): skill names in system prompt
 *     Layer 2 (on demand): full skill body in tool_result
 *
 *     skills/
 *       pdf/
 *         SKILL.md
 *       code-review/
 *         SKILL.md
 *
 * Key insight: "Don't put everything in the system prompt. Load on demand."
 */

import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { cwd, env, platform, stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";

dotenv.config({ override: true });

if (env.ANTHROPIC_BASE_URL) {
  delete env.ANTHROPIC_AUTH_TOKEN;
}

const WORKDIR = cwd();
const MODEL = env.MODEL_ID;
const SKILLS_DIR = resolve(WORKDIR, "skills");

if (!MODEL) {
  throw new Error("MODEL_ID is required");
}

const client = new Anthropic({
  baseURL: env.ANTHROPIC_BASE_URL,
});

type ToolInput = Record<string, unknown>;
type AgentMessage = {
  role: "user" | "assistant";
  content: unknown;
};
type ResponseBlock = {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
};
type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
};
type ToolHandler = (input: ToolInput) => Promise<string>;
type SkillMeta = Record<string, unknown>;
type SkillEntry = {
  meta: SkillMeta;
  body: string;
  path: string;
};

// 中文注释：把 unknown 输入收敛成普通对象，避免直接读取时报错。
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

// 中文注释：路径必须限制在工作区内，避免工具越权访问仓库外部。
function safePath(filePath: string): string {
  const resolvedPath = resolve(WORKDIR, filePath);
  const relPath = relative(WORKDIR, resolvedPath);

  if (relPath.startsWith("..") || isAbsolute(relPath)) {
    throw new Error(`Path escapes workspace: ${filePath}`);
  }

  return resolvedPath;
}

function parseScalar(rawValue: string): unknown {
  const value = rawValue.trim();

  if (!value) {
    return "";
  }

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }

  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) {
      return [];
    }
    return inner.split(",").map((item) => String(parseScalar(item.trim())));
  }

  return value;
}

// 中文注释：这里只实现示例需要的轻量 frontmatter 解析，不额外引入 yaml 依赖。
function parseFrontmatter(text: string): { meta: SkillMeta; body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { meta: {}, body: text.trim() };
  }

  const meta: SkillMeta = {};
  const lines = match[1].split(/\r?\n/);
  let currentListKey: string | null = null;

  for (const line of lines) {
    const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (keyMatch) {
      const [, key, rawValue] = keyMatch;
      if (rawValue.trim()) {
        meta[key] = parseScalar(rawValue);
        currentListKey = null;
      } else {
        meta[key] = [];
        currentListKey = key;
      }
      continue;
    }

    const listMatch = currentListKey ? line.match(/^\s*-\s*(.*)$/) : null;
    if (listMatch && currentListKey) {
      const currentValue = meta[currentListKey];
      const items = Array.isArray(currentValue) ? currentValue : [];
      items.push(String(parseScalar(listMatch[1])));
      meta[currentListKey] = items;
      continue;
    }

    if (line.trim()) {
      currentListKey = null;
    }
  }

  return {
    meta,
    body: match[2].trim(),
  };
}

function normalizeTags(tags: unknown): string {
  if (Array.isArray(tags)) {
    return tags.map((item) => String(item)).join(", ");
  }

  if (tags === undefined || tags === null) {
    return "";
  }

  return String(tags);
}

class SkillLoader {
  private readonly skillsDir: string;
  private loaded = false;
  private readonly skills: Record<string, SkillEntry> = {};

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir;
  }

  private listSkillFiles(): string[] {
    const result = spawnSync("rg", ["--files", this.skillsDir, "-g", "SKILL.md"], {
      cwd: WORKDIR,
      encoding: "utf8",
    });

    if (result.error || !result.stdout) {
      return [];
    }

    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .sort();
  }

  private async loadAll(): Promise<void> {
    if (this.loaded) {
      return;
    }

    for (const relativePath of this.listSkillFiles()) {
      const fullPath = resolve(WORKDIR, relativePath);
      const text = await readFile(fullPath, "utf8");
      const { meta, body } = parseFrontmatter(text);
      const name = String(meta.name ?? relativePath.split("/").slice(-2, -1)[0] ?? "unknown");

      this.skills[name] = {
        meta,
        body,
        path: fullPath,
      };
    }

    this.loaded = true;
  }

  async getDescriptions(): Promise<string> {
    await this.loadAll();

    const names = Object.keys(this.skills).sort();
    if (names.length === 0) {
      return "(no skills available)";
    }

    return names
      .map((name) => {
        const skill = this.skills[name];
        const description = String(skill.meta.description ?? "No description");
        const tags = normalizeTags(skill.meta.tags);
        return tags ? `  - ${name}: ${description} [${tags}]` : `  - ${name}: ${description}`;
      })
      .join("\n");
  }

  async getContent(name: string): Promise<string> {
    await this.loadAll();

    const skill = this.skills[name];
    if (!skill) {
      const available = Object.keys(this.skills).sort().join(", ");
      return `Error: Unknown skill '${name}'. Available: ${available || "(none)"}`;
    }

    return `<skill name="${name}">\n${skill.body}\n</skill>`;
  }
}

const SKILL_LOADER = new SkillLoader(SKILLS_DIR);

async function buildSystemPrompt(): Promise<string> {
  const descriptions = await SKILL_LOADER.getDescriptions();
  return `You are a coding agent at ${WORKDIR}.
Use load_skill to access specialized knowledge before tackling unfamiliar topics.

Skills available:
${descriptions}`;
}

async function runBash(command: string): Promise<string> {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((item) => command.includes(item))) {
    return "Error: Dangerous command blocked";
  }

  const isWindows = platform === "win32";
  const shell = isWindows ? "cmd.exe" : "bash";
  const shellArgs = isWindows ? ["/d", "/s", "/c", command] : ["-lc", command];

  const result = spawnSync(shell, shellArgs, {
    cwd: WORKDIR,
    encoding: "utf8",
    timeout: 120_000,
  });

  if (result.error) {
    if (result.error.name === "TimeoutError") {
      return "Error: Timeout (120s)";
    }
    return `Error: ${result.error.message}`;
  }

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return output ? output.slice(0, 50_000) : "(no output)";
}

async function runRead(filePath: string, limit?: number): Promise<string> {
  try {
    const text = await readFile(safePath(filePath), "utf8");
    let lines = text.split(/\r?\n/);

    if (limit && limit < lines.length) {
      lines = [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`];
    }

    return lines.join("\n").slice(0, 50_000);
  } catch (error) {
    return `Error: ${String(error)}`;
  }
}

async function runWrite(filePath: string, content: string): Promise<string> {
  try {
    const fullPath = safePath(filePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf8");
    return `Wrote ${content.length} bytes`;
  } catch (error) {
    return `Error: ${String(error)}`;
  }
}

async function runEdit(filePath: string, oldText: string, newText: string): Promise<string> {
  try {
    const fullPath = safePath(filePath);
    const content = await readFile(fullPath, "utf8");

    if (!content.includes(oldText)) {
      return `Error: Text not found in ${filePath}`;
    }

    const index = content.indexOf(oldText);
    const updatedContent =
      content.slice(0, index) + newText + content.slice(index + oldText.length);

    await writeFile(fullPath, updatedContent, "utf8");
    return `Edited ${filePath}`;
  } catch (error) {
    return `Error: ${String(error)}`;
  }
}

// 中文注释：load_skill 只在模型主动请求时注入完整内容，避免系统提示过胖。
const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: async (input) => runBash(String(input.command)),
  read_file: async (input) =>
    runRead(
      String(input.path),
      typeof input.limit === "number" ? input.limit : undefined,
    ),
  write_file: async (input) => runWrite(String(input.path), String(input.content)),
  edit_file: async (input) =>
    runEdit(String(input.path), String(input.old_text), String(input.new_text)),
  load_skill: async (input) => SKILL_LOADER.getContent(String(input.name)),
};

const TOOLS = [
  {
    name: "bash",
    description: "Run a shell command.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string" },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read file contents.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace exact text in file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    name: "load_skill",
    description: "Load specialized knowledge by name.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Skill name to load",
        },
      },
      required: ["name"],
    },
  },
] as const;

async function agentLoop(messages: AgentMessage[], systemPrompt: string): Promise<void> {
  while (true) {
    const response = (await client.messages.create({
      model: MODEL,
      system: systemPrompt,
      messages,
      tools: [...TOOLS],
      max_tokens: 8000,
    })) as {
      stop_reason: string | null;
      content: ResponseBlock[];
    };

    messages.push({
      role: "assistant",
      content: response.content,
    });

    if (response.stop_reason !== "tool_use") {
      return;
    }

    const results: ToolResultBlock[] = [];

    for (const block of response.content) {
      if (block.type !== "tool_use") {
        continue;
      }

      const toolName = String(block.name);
      const handler = TOOL_HANDLERS[toolName];

      let output = `Unknown tool: ${toolName}`;
      try {
        output = handler
          ? await handler(asRecord(block.input))
          : `Unknown tool: ${toolName}`;
      } catch (error) {
        output = `Error: ${String(error)}`;
      }

      console.log(`> ${toolName}:`);
      console.log(output.slice(0, 200));

      results.push({
        type: "tool_result",
        tool_use_id: String(block.id),
        content: output,
      });
    }

    messages.push({
      role: "user",
      content: results,
    });
  }
}

async function main(): Promise<void> {
  const history: AgentMessage[] = [];
  const systemPrompt = await buildSystemPrompt();
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    while (true) {
      let query = "";

      try {
        query = await rl.question("\u001b[36ms05-ts >> \u001b[0m");
      } catch {
        break;
      }

      if (["q", "exit", ""].includes(query.trim().toLowerCase())) {
        break;
      }

      history.push({ role: "user", content: query });
      await agentLoop(history, systemPrompt);

      const responseContent = history[history.length - 1]?.content;
      if (Array.isArray(responseContent)) {
        for (const block of responseContent) {
          const typedBlock = block as ResponseBlock;
          if (typedBlock.type === "text") {
            console.log(typedBlock.text);
          }
        }
      }

      console.log();
    }
  } finally {
    rl.close();
  }
}

void main();
