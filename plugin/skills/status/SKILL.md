---
name: status
description: Check if Claude Code Usage Dashboard is enabled in this session. Use when the user wants to verify usage tracking is active.
disable-model-invocation: true
allowed-tools: Bash(*session-uploader.py*--status*)
---

Check whether the Claude Code Usage Dashboard is enabled and will collect usage data when this session ends.

## Status output

!`python3 "${CLAUDE_PLUGIN_ROOT}/hooks/session-uploader.py" --status`

Present the status above to the user in a clear, readable format. If all checks pass (✓), usage data will be sent to the dashboard when the session ends. If any check fails (✗), explain what needs to be fixed.
