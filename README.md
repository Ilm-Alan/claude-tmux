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
spawn(name, prompt, workdir)  → start session
read(name)                    → wait for completion, get output
send(name, text)              → steer with follow-up
read(name)                    → wait for completion, get output
kill(name)                    → cleanup
```

## Tips

- Attach manually: `tmux attach -t claude-<name>`
- Always kill sessions when done to avoid orphaned processes
