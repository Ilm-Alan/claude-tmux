# claude-tmux

[![npm version](https://img.shields.io/npm/v/claude-tmux.svg)](https://www.npmjs.com/package/claude-tmux)

MCP server for orchestrating multiple Claude Code instances via tmux.

## Installation

Add to your Claude Code MCP settings:

```json
{
  "mcpServers": {
    "claude-tmux": {
      "command": "npx",
      "args": ["-y", "claude-tmux"]
    }
  }
}
```

### Requirements

- [tmux](https://github.com/tmux/tmux) must be installed
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) must be installed

## Tools

### spawn

Launch a new Claude Code instance in a tmux session.

```
spawn(name, prompt, workdir)
```

- `name`: Unique session name (e.g., 'refactor-auth', 'debug-api')
- `prompt`: Initial prompt to send to Claude
- `workdir`: Working directory for Claude to operate in

### read

Wait for Claude sessions to finish working and return terminal output.

```
read(name: "task-name")           // single session
read(names: ["a", "b", "c"])      // parallel wait on multiple sessions
```

For multiple sessions, use `names` to wait in parallel - returns all outputs when all complete.

### send

Send a follow-up message to a running Claude session.

```
send("task-name", "do something else")
```

### list

List all active Claude tmux sessions.

```
list()
```

### kill

Terminate a Claude tmux session and clean up resources.

```
kill("task-name")
```

## Usage Pattern

```
spawn(name, prompt, workdir)  → start session
read(name)                    → wait for completion, get output
send(name, text)              → steer with follow-up
read(name)                    → wait again
kill(name)                    → cleanup
```

For parallel tasks:
```
spawn("task-a", ...)
spawn("task-b", ...)
spawn("task-c", ...)
read(names: ["task-a", "task-b", "task-c"])  → wait for all
```

## Idle Detection

`read` detects completion via:
1. **Done indicator** - Claude's status line showing `✻ model for Xm`
2. **Stability** - Output unchanged for 10 seconds (handles sub-minute tasks that don't show the indicator)

Timeout is 15 minutes.

## Tips

- Verify output shows task completion before killing. Idle agents are fine to leave running.
- Attach manually: `tmux attach -t claude-<name>`
