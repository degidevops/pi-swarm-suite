# Notice

The child-process launcher in `src/core/worker.ts` (how to locate the running `pi`
binary and parse `--mode json` events) follows the pattern of the official example
`examples/extensions/subagent` shipped inside `@earendil-works/pi-coding-agent`.
Verify that package's license and keep its attribution if you copy more code from it.

Design ideas (shared task list, mailbox, lead + teammates) are inspired by the public
Claude Code agent-teams documentation. No Claude Code source code is used.
