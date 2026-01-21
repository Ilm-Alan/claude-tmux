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
const STABLE_COUNT_THRESHOLD = 5; // 5 polls * 2s = 10 seconds of no change
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

  // Find horizontal rules from the bottom
  const ruleIndices: number[] = [];
  for (let i = lines.length - 1; i >= 0 && ruleIndices.length < 2; i--) {
    if (/^[─━\-]{10,}$/.test(lines[i].trim())) {
      ruleIndices.push(i);
    }
  }

  // Cut at second-to-last rule, then append context tracker
  const cutoff = ruleIndices.length >= 2 ? ruleIndices[1] : lines.length;
  const content = lines.slice(0, cutoff);

  // Context tracker is second-to-last non-empty line from the bottom
  const nonEmptyLines = lines.filter(l => l.trim());
  if (nonEmptyLines.length >= 2) {
    content.push(nonEmptyLines[nonEmptyLines.length - 2]);
  }

  return content.join('\n').trim();
}

async function waitForIdle(session: string): Promise<string> {
  const startTime = Date.now();
  let output = "";
  let previousOutput = "";
  let stableCount = 0;

  // Check immediately if already idle (allows completed sessions to return fast)
  try {
    output = runTmux(`capture-pane -t "${session}" -p -S -${CAPTURE_LINES}`);
    if (isIdle(output)) {
      return filterUIChrome(output);
    }
    previousOutput = output;
  } catch (e: unknown) {
    return `Error: ${errorMessage(e)}`;
  }

  // Initial delay to let Claude start working
  await sleep(INITIAL_DELAY_MS);

  while (Date.now() - startTime < TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);

    try {
      output = runTmux(`capture-pane -t "${session}" -p -S -${CAPTURE_LINES}`);

      // Check for explicit done indicator
      if (isIdle(output)) {
        return filterUIChrome(output);
      }

      // Stability check: if output unchanged, increment counter
      if (output === previousOutput) {
        stableCount++;
        if (stableCount >= STABLE_COUNT_THRESHOLD) {
          return filterUIChrome(output);
        }
      } else {
        stableCount = 0;
        previousOutput = output;
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
- **read**: Wait for sessions to finish. Use \`names\` array for parallel waiting on multiple sessions.
- **send**: Send a follow-up message to a session.
- **list**: List active sessions.
- **kill**: Terminate a session.

## Tips
- Verify completion before killing. Idle sessions are fine.
- For multiple sessions, use \`read(names: ["a", "b", "c"])\` to wait in parallel.`,
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
  "Wait for Claude sessions to finish working and return their terminal output. Use 'names' for parallel waiting on multiple sessions.",
  {
    name: z.string().optional().describe("Session name (as provided to spawn)"),
    names: z.array(z.string()).optional().describe("Multiple session names for parallel waiting (preferred for multiple sessions)"),
  },
  async ({ name, names }) => {
    // Handle multiple sessions in parallel
    const sessionNames = names && names.length > 0 ? names : name ? [name] : [];

    if (sessionNames.length === 0) {
      return response("Error: Provide either 'name' or 'names'");
    }

    const results = await Promise.all(
      sessionNames.map(async (n) => {
        const session = sessionName(n);
        if (!sessionExists(session)) {
          return { name: n, output: `Session '${n}' does not exist` };
        }
        const output = await waitForIdle(session);
        return { name: n, output };
      })
    );

    // If single session, return just the output (backwards compatible)
    if (results.length === 1) {
      return response(results[0].output);
    }

    // Multiple sessions: format with headers
    const formatted = results
      .map(r => `=== ${r.name} ===\n${r.output}`)
      .join('\n\n');
    return response(formatted);
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
