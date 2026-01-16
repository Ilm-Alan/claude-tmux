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
spawn("task-name", workdir, prompt)
```

- `name`: Unique session name (e.g., 'refactor-auth', 'debug-api')
- `workdir`: Working directory for Claude to operate in
- `prompt`: Initial prompt to send to Claude on startup
- `dangerouslySkipPermissions`: Skip permission prompts for fully autonomous operation

### read

Wait for a Claude session to finish working and return the terminal output.

```
read("task-name")
```

### send

Send a follow-up message to a running Claude session.

```
send("task-name", "do something else")
```

### kill

Terminate a Claude tmux session and clean up resources.

```
kill("task-name")
```

## Usage Pattern

```
spawn("task-name", workdir, prompt)  → start session
read("task-name")                    → wait for completion, get output
send("task-name", "now do this")     → steer with follow-up
read("task-name")                    → wait for completion, get output
kill("task-name")                    → cleanup
```

## Tips

- Use `dangerouslySkipPermissions: true` for fully autonomous operation
- User can attach manually: `tmux attach -t claude-<name>`
- Always kill sessions when done to avoid orphaned processes
