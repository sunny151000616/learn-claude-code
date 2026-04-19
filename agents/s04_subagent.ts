#!/usr/bin/env -S npx tsx
/// <reference path="./s02_tool_use.d.ts" />
/**
 * s04_subagent.ts - Subagents
 *
 * Spawn a child agent with fresh messages=[]. The child works in its own
 * context, shares the filesystem, then returns only a summary to the parent.
 *
 *     Parent agent                     Subagent
 *     +------------------+             +------------------+
 *     | messages=[...]   |             | messages=[]      |  <-- fresh
 *     |                  |  dispatch   |                  |
 *     | tool: task       | ----------> | while tool_use:  |
 *     |   prompt="..."   |             |   call tools     |
 *     |   description="" |             |   append results |
 *     |                  |  summary    |                  |
 *     |   result = "..." | <---------  | return last text |
 *     +------------------+             +------------------+
 *
 * Key insight: "Process isolation gives context isolation for free."
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

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use the task tool to delegate exploration or subtasks.`;
const SUBAGENT_SYSTEM = `You are a coding subagent at ${WORKDIR}. Complete the given task, then summarize your findings.`;

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

// 中文注释：把 unknown 输入收敛成普通对象，便于后续安全读取字段。
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

// 中文注释：路径必须限制在当前工作区内，避免工具访问仓库外部。
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

    const index = content.indexOf(oldText);
    const updatedContent =
      content.slice(0, index) + newText + content.slice(index + oldText.length);

    await writeFile(fullPath, updatedContent, "utf8");
    return `Edited ${filePath}`;
  } catch (error) {
    return `Error: ${String(error)}`;
  }
}

// 中文注释：父子 agent 共享同一批基础工具，只有父端额外暴露 task。
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

const CHILD_TOOLS = [
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

const PARENT_TOOLS = [
  ...CHILD_TOOLS,
  {
    name: "task",
    description:
      "Spawn a subagent with fresh context. It shares the filesystem but not conversation history.",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        description: {
          type: "string",
          description: "Short description of the task",
        },
      },
      required: ["prompt"],
    },
  },
] as const;

async function createMessage(
  system: string,
  messages: AgentMessage[],
  tools: readonly unknown[],
): Promise<{ stop_reason: string | null; content: ResponseBlock[] }> {
  return (await client.messages.create({
    model: MODEL,
    system,
    messages,
    tools: [...tools],
    max_tokens: 8000,
  })) as {
    stop_reason: string | null;
    content: ResponseBlock[];
  };
}

async function executeBaseTool(block: ResponseBlock): Promise<string> {
  const toolName = String(block.name);
  const handler = TOOL_HANDLERS[toolName];

  try {
    return handler
      ? await handler(asRecord(block.input))
      : `Unknown tool: ${toolName}`;
  } catch (error) {
    return `Error: ${String(error)}`;
  }
}

// 中文注释：子 agent 用全新 messages 启动，只把最终文字摘要返回给父 agent。
async function runSubagent(prompt: string): Promise<string> {
  const subMessages: AgentMessage[] = [{ role: "user", content: prompt }];
  let finalResponse: { stop_reason: string | null; content: ResponseBlock[] } | null = null;

  for (let round = 0; round < 30; round += 1) {
    const response = await createMessage(SUBAGENT_SYSTEM, subMessages, CHILD_TOOLS);
    finalResponse = response;

    subMessages.push({
      role: "assistant",
      content: response.content,
    });

    if (response.stop_reason !== "tool_use") {
      break;
    }

    const results: ToolResultBlock[] = [];

    for (const block of response.content) {
      if (block.type !== "tool_use") {
        continue;
      }

      const output = await executeBaseTool(block);
      results.push({
        type: "tool_result",
        tool_use_id: String(block.id),
        content: output.slice(0, 50_000),
      });
    }

    subMessages.push({
      role: "user",
      content: results,
    });
  }

  if (!finalResponse) {
    return "(no summary)";
  }

  const summary = finalResponse.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");

  return summary || "(no summary)";
}

async function agentLoop(messages: AgentMessage[]): Promise<void> {
  while (true) {
    const response = await createMessage(SYSTEM, messages, PARENT_TOOLS);

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
      let output = "";

      if (toolName === "task") {
        const input = asRecord(block.input);
        const description = String(input.description ?? "subtask");
        const prompt = String(input.prompt ?? "");

        console.log(`> task (${description}): ${prompt.slice(0, 80)}`);
        output = await runSubagent(prompt);
      } else {
        output = await executeBaseTool(block);
        console.log(`> ${toolName}:`);
      }

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
        query = await rl.question("\u001b[36ms04-ts >> \u001b[0m");
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
