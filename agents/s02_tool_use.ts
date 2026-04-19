#!/usr/bin/env -S npx tsx
/// <reference path="./s02_tool_use.d.ts" />
/**
 * s02_tool_use.ts - Tools
 *
 * The agent loop from s01 didn't change. We just added tools to the array
 * and a dispatch map to route calls.
 *
 *     +----------+      +-------+      +------------------+
 *     |   User   | ---> |  LLM  | ---> | Tool Dispatch    |
 *     |  prompt  |      |       |      | {                |
 *     +----------+      +---+---+      |   bash: runBash  |
 *                           ^          |   read: runRead  |
 *                           |          |   write: runWrite|
 *                           +----------+   edit: runEdit  |
 *                           tool_result| }                |
 *                                      +------------------+
 *
 * Key insight: "The loop didn't change at all. I just added tools."
 */

import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { cwd, env, platform, stdin, stdout } from "node:process";
import { dirname, isAbsolute, relative, resolve } from "node:path";

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

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks. Act, don't explain.`;

type ToolInput = Record<string, unknown>;
type ToolHandler = (input: ToolInput) => Promise<string>;
type ToolResult = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
};
type AgentMessage = {
  role: "user" | "assistant";
  content: unknown;
};

// 路径必须留在工作区内，防止工具逃逸到仓库外部。
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
    return `Wrote ${content.length} bytes to ${filePath}`;
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

// dispatch map 保持循环稳定，新工具只需要注册 handler。
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
] as const;

async function agentLoop(messages: AgentMessage[]): Promise<void> {
  while (true) {
    const response = (await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,
      tools: [...TOOLS],
      max_tokens: 8000,
    })) as {
      stop_reason: string | null;
      content: Array<{
        type: string;
        id?: string;
        name?: string;
        input?: unknown;
        text?: string;
      }>;
    };

    messages.push({
      role: "assistant",
      content: response.content,
    });

    if (response.stop_reason !== "tool_use") {
      return;
    }

    const results: ToolResult[] = [];

    for (const block of response.content) {
      if (block.type !== "tool_use") {
        continue;
      }

      const toolName = String(block.name);
      const handler = TOOL_HANDLERS[toolName];
      const output = handler
        ? await handler(block.input as ToolInput)
        : `Unknown tool: ${toolName}`;

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
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    while (true) {
      let query = "";

      try {
        query = await rl.question("\u001b[36ms02-ts >> \u001b[0m");
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
          if (block.type === "text") {
            console.log(block.text);
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
