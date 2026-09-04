#!/usr/bin/env python3
"""Claude Code Stop / SessionEnd hook: parse transcript and upload usage data to dashboard.

Registered for two hook events (see hooks.json):

  Stop        fires after every assistant turn and runs async, so it must stay
              cheap: it uploads at most once per UPLOAD_INTERVAL seconds per
              session and returns without doing anything in between.
  SessionEnd  always uploads, so the final snapshot lands even when the
              throttle window has not elapsed.

Each upload is the cumulative snapshot of the whole transcript; the ingest API
credits only the increment since the previous upload, so re-sending is safe.
A per-session lock file keeps an async Stop upload and the SessionEnd upload
from racing each other (two concurrent snapshots would both be credited in
full).

This is a standalone CLI script for external API communication.
JSON serialization is required for HTTP POST to the dashboard ingest API.

Transcript format reference:
  https://platform.claude.com/docs/en/agent-sdk/typescript

Author: AgenticSec Inc.
License: MIT
"""

import fnmatch
import json
import os
import re
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path
from urllib.parse import urljoin
from urllib.request import Request, urlopen

# Built-in CLI commands that are not user-defined skills
BUILTIN_COMMANDS = frozenset(
    {
        "exit",
        "help",
        "clear",
        "compact",
        "cost",
        "doctor",
        "init",
        "login",
        "logout",
        "memory",
        "permissions",
        "review",
        "status",
        "terminal-setup",
        "vim",
        "fast",
        "effort",
    }
)


CONFIG_DIR = Path.home() / ".claude-code-usage-dashboard"
CONFIG_PATH = CONFIG_DIR / "env"
STATE_DIR = CONFIG_DIR / "state"

# Minimum seconds between two uploads of the same session triggered by Stop.
DEFAULT_UPLOAD_INTERVAL = 300
# A lock older than this is assumed to belong to a crashed uploader.
LOCK_STALE_SECONDS = 120
# How long SessionEnd waits for an in-flight Stop upload before proceeding.
LOCK_WAIT_SECONDS = 30
# Throttle markers of sessions that never reported SessionEnd are swept after this.
MARKER_MAX_AGE_SECONDS = 7 * 24 * 3600


def read_plugin_version() -> str | None:
    manifest = Path(__file__).resolve().parent.parent / ".claude-plugin" / "plugin.json"
    try:
        return json.loads(manifest.read_text()).get("version")
    except (OSError, ValueError):
        return None


def run_status_check() -> None:
    """Print status of dashboard configuration for the current process."""
    config_path = CONFIG_PATH
    load_dotenv(str(config_path))

    project_dir = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    dashboard_url = os.environ.get(
        "CLAUDE_CODE_USAGE_DASHBOARD_URL", "http://localhost:5173"
    )
    allowed_dirs = os.environ.get("CLAUDE_CODE_USAGE_DASHBOARD_ALLOWED_DIRS", "")
    interval = get_upload_interval()

    lines = ["Claude Code Usage Dashboard — Status", "=" * 40, ""]

    # Plugin loaded (we're running, so it is) + version
    version = read_plugin_version()
    version_suffix = f" (v{version})" if version else ""
    lines.append(f"✓ Plugin loaded (this session){version_suffix}")

    # Config file
    if config_path.exists():
        lines.append(f"✓ Config file: {config_path}")
    else:
        lines.append(f"✗ Config file missing: {config_path}")

    # Dashboard URL
    if dashboard_url:
        lines.append(f"✓ Dashboard URL: {dashboard_url}")
    else:
        lines.append("✗ CLAUDE_CODE_USAGE_DASHBOARD_URL not set")

    # Auth
    email = get_email()
    if email:
        lines.append(f"✓ Authenticated: {email}")
    else:
        lines.append("✗ Not authenticated (run: claude auth status)")

    # Project dir allowed
    if is_allowed_dir(project_dir):
        lines.append(f"✓ Project dir allowed: {project_dir}")
    else:
        lines.append(
            f"✗ Project dir not in ALLOWED_DIRS: {project_dir}"
        )
        if allowed_dirs:
            lines.append(f"  Allowed: {allowed_dirs}")

    lines.append("")
    enabled = all(
        [
            config_path.exists(),
            bool(dashboard_url),
            bool(email),
            is_allowed_dir(project_dir),
        ]
    )
    if enabled:
        if interval > 0:
            lines.append(
                "→ Usage data will be sent to the dashboard during this session "
                f"(at most every {format_interval(interval)}) and when it ends."
            )
        else:
            lines.append(
                "→ Usage data will be sent to the dashboard after every turn "
                "and when this session ends."
            )
    else:
        lines.append("→ Fix the issues above for usage data to be collected.")

    print("\n".join(lines))


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "--status":
        run_status_check()
        return

    session_info = json.loads(sys.stdin.read())
    session_id = session_info.get("session_id")
    if not session_id:
        return
    # Anything other than SessionEnd (i.e. Stop) is a mid-session upload.
    is_final = session_info.get("hook_event_name") == "SessionEnd"

    load_dotenv(str(CONFIG_PATH))

    project_dir = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    if not is_allowed_dir(project_dir):
        return

    dashboard_url = os.environ.get(
        "CLAUDE_CODE_USAGE_DASHBOARD_URL", "http://localhost:5173"
    )
    if not dashboard_url:
        return

    # Cheap checks first: Stop fires after every turn, and most of those runs
    # must exit here without spawning `claude auth status` or reading the
    # transcript.
    if not is_final and not throttle_allows(session_id):
        return

    lock = acquire_lock(session_id, wait=is_final)
    if lock is None:
        return
    try:
        # Stop hooks are async; the throttle window is measured from when the
        # upload started so a slow request cannot let the next turn pile on.
        touch_marker(session_id)

        transcript_path = session_info.get("transcript_path")
        if not transcript_path or not os.path.isfile(transcript_path):
            transcript_path = find_transcript(session_id)
        if not transcript_path:
            return

        email = get_email()
        if not email:
            return

        records = read_jsonl(transcript_path)
        payload = parse_transcript(records)
        if not payload:
            return

        payload["email"] = email
        post_to_api(dashboard_url, payload)

        if is_final:
            remove_marker(session_id)
            sweep_stale_markers()
    finally:
        release_lock(lock)


def get_upload_interval() -> int:
    """Seconds between mid-session uploads; 0 uploads after every turn."""
    raw = os.environ.get("CLAUDE_CODE_USAGE_DASHBOARD_UPLOAD_INTERVAL", "")
    try:
        return max(0, int(raw)) if raw.strip() else DEFAULT_UPLOAD_INTERVAL
    except ValueError:
        return DEFAULT_UPLOAD_INTERVAL


def format_interval(seconds: int) -> str:
    if seconds % 3600 == 0:
        return f"{seconds // 3600} h"
    if seconds % 60 == 0:
        return f"{seconds // 60} min"
    return f"{seconds} s"


def _marker_path(session_id: str) -> Path:
    return STATE_DIR / f"{session_id}.last-upload"


def _lock_path(session_id: str) -> Path:
    return STATE_DIR / f"{session_id}.lock"


def throttle_allows(session_id: str) -> bool:
    """True when the last mid-session upload is old enough (or there was none)."""
    interval = get_upload_interval()
    if interval <= 0:
        return True
    try:
        last = _marker_path(session_id).stat().st_mtime
    except OSError:
        return True
    return time.time() - last >= interval


def touch_marker(session_id: str) -> None:
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        _marker_path(session_id).touch()
    except OSError:
        pass


def remove_marker(session_id: str) -> None:
    try:
        _marker_path(session_id).unlink()
    except OSError:
        pass


def sweep_stale_markers() -> None:
    """Drop markers left by sessions that were killed without a SessionEnd."""
    cutoff = time.time() - MARKER_MAX_AGE_SECONDS
    try:
        for path in STATE_DIR.glob("*.last-upload"):
            try:
                if path.stat().st_mtime < cutoff:
                    path.unlink()
            except OSError:
                continue
    except OSError:
        pass


def acquire_lock(session_id: str, wait: bool):
    """Create the per-session lock file exclusively.

    Returns the lock path, or None when another uploader holds it. A Stop
    upload gives up immediately (the next turn will try again); SessionEnd
    waits for the in-flight upload so the final snapshot is never skipped, and
    takes over a lock that looks abandoned.
    """
    lock = _lock_path(session_id)
    deadline = time.time() + (LOCK_WAIT_SECONDS if wait else 0)
    while True:
        try:
            STATE_DIR.mkdir(parents=True, exist_ok=True)
            fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.close(fd)
            return lock
        except FileExistsError:
            try:
                stale = time.time() - lock.stat().st_mtime > LOCK_STALE_SECONDS
            except OSError:
                stale = False  # Released between the open and the stat; retry.
            if stale:
                release_lock(lock)
                continue
            if time.time() >= deadline:
                return None
            time.sleep(0.5)
        except OSError:
            return None


def release_lock(lock) -> None:
    try:
        lock.unlink()
    except OSError:
        pass


def _get_claude_config_dir() -> Path:
    """Determine the Claude config directory.

    Checks CLAUDE_CONFIG_DIR environment variable first(or return ~/.claude as default)
    """
    config_dir = os.environ.get("CLAUDE_CONFIG_DIR")
    if config_dir:
        return Path(config_dir)
    return Path.home() / ".claude"


def find_transcript(session_id: str):
    claude_dir = _get_claude_config_dir() / "projects"
    if not claude_dir.exists():
        return None
    for path in claude_dir.rglob(f"{session_id}.jsonl"):
        return path
    return None


def get_email():
    try:
        result = subprocess.run(
            ["claude", "auth", "status"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        data = json.loads(result.stdout)
        return data.get("email") or None
    except Exception:
        return None


def load_dotenv(path: str) -> None:
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                value = value.strip().strip("'\"")
                os.environ.setdefault(key.strip(), value)
    except FileNotFoundError:
        pass


def is_allowed_dir(project_dir: str) -> bool:
    raw = os.environ.get("CLAUDE_CODE_USAGE_DASHBOARD_ALLOWED_DIRS", "")
    if not raw.strip():
        return True
    patterns = [p.strip() for p in raw.split(",") if p.strip()]
    project_dir = project_dir.rstrip("/")
    return any(fnmatch.fnmatch(project_dir, pat.rstrip("/")) for pat in patterns)


def _open_transcript_bytes(path):
    """Open the transcript for reading without getting in Claude Code's way.

    Claude Code keeps appending to the transcript while this hook runs (Stop
    fires mid-session). On Windows, Python's default open() shares read and
    write access but not delete, so for as long as the file is open Claude Code
    could not rename or delete it. Open it through CreateFileW with
    FILE_SHARE_DELETE as well so every operation stays possible; fall back to
    a plain open() if that fails for any reason.
    """
    if os.name == "nt":
        try:
            import ctypes
            import msvcrt
            from ctypes import wintypes

            GENERIC_READ = 0x80000000
            FILE_SHARE_READ = 0x1
            FILE_SHARE_WRITE = 0x2
            FILE_SHARE_DELETE = 0x4
            OPEN_EXISTING = 3
            FILE_ATTRIBUTE_NORMAL = 0x80
            INVALID_HANDLE_VALUE = wintypes.HANDLE(-1).value

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.CreateFileW.restype = wintypes.HANDLE
            kernel32.CreateFileW.argtypes = [
                wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
                wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
            ]
            handle = kernel32.CreateFileW(
                str(path), GENERIC_READ,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                None, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, None,
            )
            if handle != INVALID_HANDLE_VALUE:
                # open_osfhandle takes ownership of the handle; closing the
                # file object closes it.
                fd = msvcrt.open_osfhandle(handle, os.O_RDONLY)
                return os.fdopen(fd, "rb")
        except Exception:
            pass
    return open(path, "rb")


def read_jsonl(path):
    # Read everything in one go to keep the file open as briefly as possible,
    # then parse. The transcript is UTF-8 regardless of the OS locale (on
    # Windows without PYTHONUTF8 a text-mode open() would decode as cp932 and
    # raise on the first multi-byte character). A line still being appended
    # by Claude Code fails to parse and is skipped; the next upload picks it up.
    with _open_transcript_bytes(path) as f:
        text = f.read().decode("utf-8", errors="replace")
    records = []
    for line in text.splitlines():
        line = line.strip()
        if line:
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return records


def extract_user_skill_events(records):
    """Extract skill events from user messages containing <command-message> tags.

    When users invoke slash commands like /commit, Claude Code records
    them as user messages with <command-message>commit</command-message> tags.
    """
    command_msg_re = re.compile(r"<command-message>([^<]+)</command-message>")
    skill_events = []
    seen = set()

    for rec in records:
        if rec.get("type") != "user":
            continue
        timestamp = rec.get("timestamp", "")
        texts = _extract_texts(rec.get("message", {}))

        for text in texts:
            for match in command_msg_re.finditer(text):
                skill_name = match.group(1).strip()
                if skill_name in BUILTIN_COMMANDS:
                    continue
                dedup_key = (skill_name, timestamp)
                if dedup_key in seen:
                    continue
                seen.add(dedup_key)
                skill_events.append(
                    {
                        "skill_name": skill_name,
                        "timestamp": timestamp,
                    }
                )

    return skill_events


def _extract_texts(message):
    """Extract text strings from a user message (various formats)."""
    texts = []
    if type(message) is str:
        texts.append(message)
    elif type(message) is list:
        for item in message:
            if type(item) is dict:
                texts.append(item.get("text", ""))
    elif type(message) is dict:
        content = message.get("content", "")
        if type(content) is str:
            texts.append(content)
        elif type(content) is list:
            for item in content:
                if type(item) is dict:
                    texts.append(item.get("text", ""))
    return texts


def parse_transcript(records):
    assistant_recs = [
        r
        for r in records
        if r.get("type") == "assistant"
        and type(r.get("message", {}).get("content")) is list
    ]

    if not assistant_recs:
        return None

    # Extract all tool_use entries, deduplicated by id (last wins)
    tool_uses = {}
    for rec in assistant_recs:
        timestamp = rec.get("timestamp", "")
        for content in rec["message"]["content"]:
            if content.get("type") != "tool_use":
                continue
            tool_id = content.get("id", "")
            tool_uses[tool_id] = {
                "id": tool_id,
                "name": content.get("name", ""),
                "input": content.get("input", {}),
                "timestamp": timestamp,
            }
    all_tools = list(tool_uses.values())

    # Classify tools into MCP / Subagent / Skill
    skill_events = []
    mcp_events = []
    subagent_events = []

    for tool in all_tools:
        name = tool["name"]
        ts = tool["timestamp"]

        if name.startswith("mcp__"):
            # MCP: tool name = "mcp__<server>__<method>"
            # e.g. "mcp__notion__notion-fetch" → server="notion", method="notion-fetch"
            parts = name.split("__")
            mcp_events.append(
                {
                    "tool_name": name,
                    "mcp_server": parts[1] if len(parts) > 1 else "unknown",
                    "mcp_method": "__".join(parts[2:]) if len(parts) > 2 else "",
                    "timestamp": ts,
                }
            )
        elif name == "Agent":
            # Subagent: tool name = "Agent", input.subagent_type = "Explore" | "Plan" | etc.
            subagent_events.append(
                {
                    "subagent_type": tool["input"].get("subagent_type"),
                    "timestamp": ts,
                }
            )

    # Skill: extracted from user records containing <command-message> tags
    # e.g. <command-message>commit</command-message> → skill_name="commit"
    user_skill_events = extract_user_skill_events(records)
    skill_events.extend(user_skill_events)

    # Token aggregation (deduplicate by message id, last wins)
    messages_by_id = {}
    for rec in assistant_recs:
        msg = rec.get("message", {})
        msg_id = msg.get("id", id(rec))
        messages_by_id[msg_id] = msg

    input_tokens = 0
    output_tokens = 0
    cache_read_tokens = 0
    cache_creation_tokens = 0
    for msg in messages_by_id.values():
        usage = msg.get("usage", {})
        input_tokens += usage.get("input_tokens", 0)
        output_tokens += usage.get("output_tokens", 0)
        cache_read_tokens += usage.get("cache_read_input_tokens", 0)
        cache_creation_tokens += usage.get("cache_creation_input_tokens", 0)

    # Cost as reported by Claude Code (cumulative snapshot, last one wins).
    # Preferred over deriving it from tokens because a session usually mixes
    # models (a Haiku subagent under Opus) and only this breakdown prices each
    # one at its own rate.
    #
    # Trusted only when modelUsage is populated and every model in it was
    # priced: an empty modelUsage means Claude Code tracked no cost for this
    # session (seen with totalCostUSD 0 alongside millions of tokens), and
    # hasUnknownModelCost means the total omits a model it could not price.
    # In both cases the field is left out and the dashboard falls back to its
    # own pricing table.
    #
    # Claude Code writes cost-state only when a session ends. When a session is
    # resumed, new assistant turns follow that record until the next end, so a
    # cost-state with assistant records after it covers only part of the
    # tokens in this snapshot. Sending it would freeze the session's cost at
    # the old total (the ingest API credits the increment over the previous
    # upload, which would be 0); leaving it out lets the API estimate the
    # uncovered tokens instead, and the next end reports the exact total.
    estimated_cost_usd = None
    last_cost_state_idx = -1
    last_assistant_idx = -1
    for idx, rec in enumerate(records):
        rec_type = rec.get("type")
        if rec_type == "assistant":
            last_assistant_idx = idx
        elif rec_type == "cost-state":
            last_cost_state_idx = idx
            total = rec.get("totalCostUSD")
            usable = (
                isinstance(total, (int, float))
                and rec.get("modelUsage")
                and not rec.get("hasUnknownModelCost")
            )
            estimated_cost_usd = float(total) if usable else None
    if last_assistant_idx > last_cost_state_idx:
        estimated_cost_usd = None

    # Model: most frequent
    model_counter = Counter(
        msg.get("model", "unknown") for msg in messages_by_id.values()
    )
    model = model_counter.most_common(1)[0][0] if model_counter else "unknown"

    # Conversation turns
    conversation_turns = sum(1 for r in records if r.get("type") == "user")

    # Timestamps
    timestamps = sorted(
        r["timestamp"]
        for r in records
        if type(r.get("timestamp")) is str and r["timestamp"]
    )

    first_rec = assistant_recs[0]

    return {
        "session": {
            "session_id": first_rec.get("sessionId", "unknown"),
            "project_dir": first_rec.get("cwd", "unknown"),
            "git_branch": first_rec.get("gitBranch"),
            "claude_code_version": first_rec.get("version"),
            "model": model,
            "first_event_at": timestamps[0] if timestamps else "",
            "last_event_at": timestamps[-1] if timestamps else "",
            "conversation_turns": conversation_turns,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cache_read_tokens": cache_read_tokens,
            "cache_creation_tokens": cache_creation_tokens,
            "estimated_cost_usd": estimated_cost_usd,
        },
        "skill_events": skill_events,
        "mcp_events": mcp_events,
        "subagent_events": subagent_events,
    }


def post_to_api(dashboard_url, payload) -> None:
    url = urljoin(dashboard_url.rstrip("/") + "/", "api/v1/usage/ingest")
    headers = {
        "Content-Type": "application/json",
        "User-Agent": "claude-code-usage-dashboard/1.0",  # Avoid being classified as a bot
    }

    client_id = os.environ.get("CLAUDE_CODE_USAGE_DASHBOARD_CF_ACCESS_CLIENT_ID", "")
    client_secret = os.environ.get("CLAUDE_CODE_USAGE_DASHBOARD_CF_ACCESS_CLIENT_SECRET", "")
    if client_id and client_secret:
        headers["CF-Access-Client-Id"] = client_id
        headers["CF-Access-Client-Secret"] = client_secret

    data = json.dumps(payload).encode()
    req = Request(url, data=data, headers=headers, method="POST")
    try:
        urlopen(req, timeout=30)
    except Exception:
        pass


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
