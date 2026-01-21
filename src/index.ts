#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execSync } from "child_process";
import { writeFileSync } from "fs";

// Constants
const SESSION_PREFIX = "claude-";
const TIMEOUT_MS = 900000;        // 15 minutes
const POLL_INTERVAL_MS = 2000;    // 2 seconds
const INITIAL_DELAY_MS = 10000;   // 10 seconds
const CAPTURE_LINES = 100;
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

function response(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sessionExists(session: string): boolean {
  return runTmuxSafe(`has-session -t "${session}"`) !== null;
}

function sessionName(name: string): string {
  return `${SESSION_PREFIX}${name.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isIdle(output: string): boolean {
  const lines = output.split('\n');

  let lastDoneLine = -1;
  let lastWorkingLine = -1;

  for (let i = 0; i < lines.length; i++) {
    if (/✻\s+\S+\s+for\s+\d+[ms]/.test(lines[i])) {
      lastDoneLine = i;
    }
    if (lines[i].includes('ctrl+c to interrupt')) {
      lastWorkingLine = i;
    }
  }

  // Idle only if done message exists and is below any working indicator
  return lastDoneLine > lastWorkingLine;
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
  const startTime = Date.now();
  let output = "";

  // Initial delay to let Claude start working
  await sleep(INITIAL_DELAY_MS);

  while (Date.now() - startTime < TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);

    try {
      output = runTmux(`capture-pane -t "${session}" -p -S -${CAPTURE_LINES}`);

      if (isIdle(output)) {
        return filterUIChrome(output);
      }
    } catch (e: unknown) {
      return `Error: ${errorMessage(e)}`;
    }
  }

  return `Timeout after 15 minutes. Session still running.\n\n${filterUIChrome(output)}`;
}

const server = new McpServer(
  {
    name: "claude-tmux",
    version: "1.1.0",
  },
  {
    instructions: `# claude-tmux

Spawn Claude Code instances in tmux sessions for long-running tasks.

## Tools
- **spawn**: Start a new Claude session with a prompt.
- **read**: Wait for a session to finish and return output.
- **send**: Send a follow-up message to a session.
- **list**: List active sessions.
- **kill**: Terminate a session.

## Tips
- Verify completion before killing. Idle sessions are fine.`,
  }
);

server.tool(
  "spawn",
  "Start a Claude Code instance in a tmux session.",
  {
    name: z.string().min(1).max(50).describe("Unique session name (e.g., 'refactor-auth', 'debug-api')"),
    prompt: z.string().describe("Initial prompt to send to Claude on startup"),
    workdir: z.string().describe("Working directory for Claude to operate in"),
  },
  async ({ name, prompt, workdir }) => {
    const session = sessionName(name);

    runTmuxSafe(`kill-session -t "${session}"`);

    try {
      runTmux(`new-session -d -s "${session}" -c "${workdir}"`);
    } catch (e: unknown) {
      return response(`Error: ${errorMessage(e)}`);
    }

    const tempFile = `/tmp/claude-prompt-${session}.txt`;
    writeFileSync(tempFile, prompt);
    runTmux(`send-keys -t "${session}" 'cat ${tempFile} | claude --dangerously-skip-permissions && rm ${tempFile}' Enter`);

    return response(`Started ${session}`);
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
    if (!sessionExists(session)) {
      return response(`Session '${name}' does not exist`);
    }
    const output = await waitForIdle(session);
    return response(output);
  }
);

server.tool(
  "send",
  "Send a message to a running session.",
  {
    name: z.string().describe("Session name (as provided to spawn)"),
    text: z.string().describe("Message to send to Claude"),
  },
  async ({ name, text }) => {
    const session = sessionName(name);
    if (!sessionExists(session)) {
      return response(`Session '${name}' does not exist`);
    }

    try {
      const escaped = text
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\$/g, '\\$')
        .replace(/`/g, '\\`');
      runTmux(`send-keys -t "${session}" -l "${escaped}"`);
      runTmux(`send-keys -t "${session}" Enter`);
      return response(`Sent to ${session}`);
    } catch (e: unknown) {
      return response(`Error: ${errorMessage(e)}`);
    }
  }
);

server.tool(
  "kill",
  "Terminate a session.",
  {
    name: z.string().describe("Session name (as provided to spawn)"),
  },
  async ({ name }) => {
    const session = sessionName(name);
    if (!sessionExists(session)) {
      return response(`Session '${name}' does not exist`);
    }

    try {
      runTmux(`kill-session -t "${session}"`);
      return response(`Killed ${session}`);
    } catch (e: unknown) {
      return response(`Error: ${errorMessage(e)}`);
    }
  }
);

server.tool(
  "list",
  "List active sessions.",
  {},
  async () => {
    const output = runTmuxSafe(`list-sessions -F "#{session_name}"`) ?? "";
    const sessions = output.split('\n')
      .filter(s => s.startsWith(SESSION_PREFIX))
      .map(s => s.slice(SESSION_PREFIX.length));

    if (sessions.length === 0) {
      return response("No active sessions");
    }
    return response(sessions.join('\n'));
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
