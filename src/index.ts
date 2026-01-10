#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execSync } from "child_process";
import { writeFileSync } from "fs";

const SESSION_PREFIX = "claude-";

function runTmux(args: string): string {
  return execSync(`tmux ${args}`, { encoding: "utf-8", timeout: 10000 }).trim();
}

function runTmuxSafe(args: string): string | null {
  try {
    return runTmux(args);
  } catch {
    return null;
  }
}

function sessionName(name: string): string {
  return `${SESSION_PREFIX}${name.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isClaudeIdle(output: string): boolean {
  if (output.includes('esc to interrupt')) {
    return false;
  }
  return true;
}

function filterUIChrome(output: string): string {
  const lines = output.split('\n');
  const filtered = lines.filter(line => {
    const trimmed = line.trim();
    if (/^[─━\-]{10,}$/.test(trimmed)) return false;
    if (trimmed.startsWith('> Try "')) return false;
    if (trimmed.includes('bypass permissions on')) return false;
    if (trimmed.includes('↵ send')) return false;
    if (trimmed.includes('shift+tab to cycle')) return false;
    return true;
  });
  return filtered.join('\n').trim();
}

async function waitForIdle(session: string): Promise<string> {
  const timeout = 600000; // 10 minutes
  const lines = 50;
  const startTime = Date.now();
  let lastOutput = "";
  let stableCount = 0;

  while (Date.now() - startTime < timeout) {
    await sleep(2000);

    try {
      const output = runTmux(`capture-pane -t "${session}" -p -S -${lines}`);

      if (isClaudeIdle(output)) {
        return filterUIChrome(output);
      }

      if (output === lastOutput) {
        stableCount++;
        if (stableCount >= 3) {
          return filterUIChrome(output);
        }
      } else {
        stableCount = 0;
        lastOutput = output;
      }
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  }

  return `Timeout after 10 minutes. Session still running.\n\n${filterUIChrome(lastOutput)}`;
}

const server = new McpServer(
  {
    name: "claude-tmux",
    version: "1.0.0",
  },
  {
    instructions: `# claude-tmux: Autonomous Claude Agents

Spawn Claude Code instances in tmux sessions for long-running, independent tasks.

## Tools
- **spawn**: Start a new Claude session with a prompt.
- **read**: Wait for a session to finish and return the output. You can continue other work while waiting.
- **send**: Send a follow-up message to steer a running session mid-task.
- **kill**: Terminate a session and clean up resources.

## Pattern

\`\`\`
spawn("task-name", workdir, prompt) → starts session
read("task-name") → waits for completion, returns output
kill("task-name") → cleanup
\`\`\`

For steering mid-task:
\`\`\`
send("task-name", "do something else")
read("task-name") → waits for completion, returns output
\`\`\`

## Tips
- Use \`dangerouslySkipPermissions: true\` for fully autonomous operation
- User can attach manually: \`tmux attach -t claude-<name>\`
- Always kill sessions when done`,
  }
);

server.tool(
  "spawn",
  "Launch a new Claude Code instance in a tmux session. Creates an interactive session you can communicate with via send/read. The session runs until killed. Use for multi-turn conversations or tasks requiring steering.",
  {
    name: z.string().min(1).max(50).describe("Unique session name (e.g., 'refactor-auth', 'debug-api')"),
    workdir: z.string().describe("Working directory for Claude to operate in"),
    prompt: z.string().optional().describe("Initial prompt to send to Claude on startup"),
    dangerouslySkipPermissions: z.boolean().optional().default(false).describe("Skip permission prompts for fully autonomous operation"),
  },
  async ({ name, workdir, prompt, dangerouslySkipPermissions }) => {
    const session = sessionName(name);

    runTmuxSafe(`kill-session -t "${session}"`);

    try {
      runTmux(`new-session -d -s "${session}" -c "${workdir}"`);
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }

    const flags = dangerouslySkipPermissions ? "--dangerously-skip-permissions " : "";

    if (prompt) {
      const tempFile = `/tmp/claude-prompt-${session}.txt`;
      writeFileSync(tempFile, prompt);
      runTmux(`send-keys -t "${session}" 'claude ${flags}"$(cat ${tempFile})" && rm ${tempFile}' Enter`);
    } else {
      runTmux(`send-keys -t "${session}" 'claude ${flags}' Enter`);
    }

    return { content: [{ type: "text", text: `Started ${session}` }] };
  }
);

server.tool(
  "read",
  "Wait for a Claude session to finish working and return the terminal output. You can continue other work while waiting.",
  {
    name: z.string().describe("Session name (as provided to spawn)"),
  },
  async ({ name }) => {
    const session = sessionName(name);
    const output = await waitForIdle(session);
    return { content: [{ type: "text", text: output }] };
  }
);

server.tool(
  "send",
  "Send a follow-up message to a running Claude session. Use to steer the session mid-task or provide additional instructions. Call read afterwards to get the result.",
  {
    name: z.string().describe("Session name (as provided to spawn)"),
    text: z.string().describe("Message to send to Claude"),
  },
  async ({ name, text }) => {
    const session = sessionName(name);

    try {
      const escaped = text
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\$/g, '\\$')
        .replace(/`/g, '\\`');
      runTmux(`send-keys -t "${session}" -l "${escaped}"`);
      runTmux(`send-keys -t "${session}" Enter`);
      return { content: [{ type: "text", text: `Sent to ${session}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  "kill",
  "Terminate a Claude tmux session and clean up resources. Always kill sessions when done to avoid orphaned processes.",
  {
    name: z.string().describe("Session name (as provided to spawn)"),
  },
  async ({ name }) => {
    const session = sessionName(name);

    try {
      runTmux(`kill-session -t "${session}"`);
      return { content: [{ type: "text", text: `Killed ${session}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
