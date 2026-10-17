# inam-log: signed local log of your Claude Code tool calls

Every tool call Claude Code makes is appended to a local, Ed25519-signed, hash-chained file. Only the tool name, a timestamp and the sha256 of the input and output are stored, never the content. No network, no account. Edit or reorder an entry and `verify` fails.

1. Get the repo and dependencies: `git clone https://github.com/inamprotocol/inam-protocol && cd inam-protocol && npm ci`
2. Add the hook to `~/.claude/settings.json` (absolute path to your clone):
   ```json
   { "hooks": { "PostToolUse": [ { "matcher": "*", "hooks": [ { "type": "command", "command": "npx tsx /path/to/inam-protocol/integrations/claude-code-log/inam-log.ts hook" } ] } ] } }
   ```
3. Check the chain any time, offline: `npx tsx integrations/claude-code-log/inam-log.ts verify`

Files live in `~/.inam-log/` (override with `INAM_LOG_DIR`): `key` (private key, mode 0600, never in a repo; on Windows file modes are not enforced, rely on your user profile ACL) and `log.jsonl`. The hook never blocks a tool call, even if logging fails.

Limits: the log proves integrity and order under one key, not the truth of what ran. Deleting the newest entries is undetectable unless you record the `head` hash that `verify` prints somewhere else.
