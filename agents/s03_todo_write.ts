#!/usr/bin/env -S npx tsx
/// <reference path="./s02_tool_use.d.ts" />
/**
 * s03_todo_write.ts - TodoWrite
 *
 * The model tracks its own progress via a TodoManager. A nag reminder
 * forces it to keep updating when it forgets.
 *
 *    +----------+      +-------+      +---------+
 *    |   User   | ---> |  LLM  | ---> | Tools   |
 *    |  prompt  |      |       |      | + todo  |
 *    +----------+      +---+---+      +----+----+
 *                         ^               |
 *                         |   tool_result |
 *                         +---------------+
 *                               |
 *                   +-----------+-----------+
 *                   | TodoManager state     |
 *                   | [ ] task A            |
 *                   | [>] task B <- doing   |
 *                   | [x] task C            |
 *                   +-----------------------+
 *                               |
 *                   if rounds_since_todo >= 3:
 *                     inject <reminder>
 *
 * Key insight: "The agent can track its own progress -- and I can see it."
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

if (!MODEL) {
  throw new Error("MODEL_ID is required");
}

const client = new Anthropic({
  baseURL: env.ANTHROPIC_BASE_URL,
});

const SYSTEM = `You are a coding agent at ${WORKDIR}.
Use the todo tool to plan multi-step tasks. Mark in_progress before starting, completed when done.
Prefer tools over prose.`;

type TodoStatus = "pending" | "in_progress" | "completed";
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
type TextBlock = {
  type: "text";
  text: string;
};
type UserContentBlock = ToolResultBlock | TextBlock;
type ToolHandler = (input: ToolInput) => Promise<string>;
type TodoItem = {
  id: string;
  text: string;
  status: TodoStatus;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected an object");
  }
  return value as Record<string, unknown>;
}

class TodoManager {
  private items: TodoItem[] = [];

  update(items: unknown): string {
    if (!Array.isArray(items)) {
      throw new Error("items must be an array");
    }

    if (items.length > 20) {
      throw new Error("Max 20 todos allowed");
    }

    const validated: TodoItem[] = [];
    let inProgressCount = 0;

    for (const [index, rawItem] of items.entries()) {
      const item = asRecord(rawItem);
      const itemId = String(item.id ?? index + 1);
      const text = String(item.text ?? "").trim();
      const status = String(item.status ?? "pending").toLowerCase() as TodoStatus;

      if (!text) {
        throw new Error(`Item ${itemId}: text required`);
      }

      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Item ${itemId}: invalid status '${status}'`);
      }

      if (status === "in_progress") {
        inProgressCount += 1;
      }

      validated.push({
        id: itemId,
        text,
        status,
      });
    }

    if (inProgressCount > 1) {
      throw new Error("Only one task can be in_progress at a time");
    }

    this.items = validated;
    return this.render();
  }

  render(): string {
    if (this.items.length === 0) {
      return "No todos.";
    }

    const lines = this.items.map((item) => {
      const markerMap: Record<TodoStatus, string> = {
        pending: "[ ]",
        in_progress: "[>]",
        completed: "[x]",
      };

      return `${markerMap[item.status]} #${item.id}: ${item.text}`;
    });

    const done = this.items.filter((item) => item.status === "completed").length;
    lines.push(`\n(${done}/${this.items.length} completed)`);

    return lines.join("\n");
  }
}

const TODO = new TodoManager();

// 中文注释：路径必须限制在工作区内，避免工具越权访问。
function safePath(filePath: string): string {
  const resolvedPath = resolve(WORKDIR, filePath);
  const relPath = relative(WORKDIR, resolvedPath);

  if (relPath.startsWith("..") || isAbsolute(relPath)) {
    throw new Error(`Path escapes workspace: ${filePath}`);
  }

  return resolvedPath;
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

    await writeFile(fullPath, content.replace(oldText, newText), "utf8");
    return `Edited ${filePath}`;
  } catch (error) {
    return `Error: ${String(error)}`;
  }
}

// 中文注释：todo 也是普通工具，只是它写入的是结构化进度状态。
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
  todo: async (input) => TODO.update(input.items),
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
    name: "todo",
    description: "Update task list. Track progress on multi-step tasks.",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
              },
            },
            required: ["id", "text", "status"],
          },
        },
      },
      required: ["items"],
    },
  },
] as const;

async function agentLoop(messages: AgentMessage[]): Promise<void> {
  let roundsSinceTodo = 0;

  while (true) {
    const response = (await client.messages.create({
      model: MODEL,
      system: SYSTEM,
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

    const results: UserContentBlock[] = [];
    let usedTodo = false;

    for (const block of response.content) {
      if (block.type !== "tool_use") {
        continue;
      }

      const toolName = String(block.name);
      const handler = TOOL_HANDLERS[toolName];

      let output = `Unknown tool: ${toolName}`;
      try {
        output = handler
          ? await handler((block.input ?? {}) as ToolInput)
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

      if (toolName === "todo") {
        usedTodo = true;
      }
    }

    roundsSinceTodo = usedTodo ? 0 : roundsSinceTodo + 1;
    if (roundsSinceTodo >= 3) {
      results.push({
        type: "text",
        text: "<reminder>Update your todos.</reminder>",
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
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    while (true) {
      let query = "";

      try {
        query = await rl.question("\u001b[36ms03-ts >> \u001b[0m");
      } catch {
        break;
      }

      if (["q", "exit", ""].includes(query.trim().toLowerCase())) {
        break;
      }

      history.push({ role: "user", content: query });
      await agentLoop(history);

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
