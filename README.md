# workhorse

A Claude Code mod that hands coding, review and ops work to Codex the way Claude spawns a subagent. Claude writes a short four-part brief, Codex runs it in the background, and the report comes back to Claude as a message with the acceptance command to run.

## What it adds

- **`mcp__workhorse__run` tool.** The brief is structured (`goal`, `context` and `done_when` required, `constraints` optional), plus `mode` (`code`, `review`, `ops`), `dir` or `worktree`, `name`, `resume` and `to_code`, `effort` (`low`, `medium`, `high`), `model`. The call returns at once.
- **Brief lint.** A brief without `done_when`, or one whose goal, constraints or acceptance asks for baselines or full suites, is refused before Codex starts.
- **Permissions.** `code` and `review` jobs run without a prompt; `ops` jobs, which run Codex with full access, ask first. `allow_ops: false` turns them off.
- **Watchdog.** Every 30 s the mod reads job status (and once right after a launch). A finished job's report is sent to Claude with a review reminder. A job with no output for `stall_minutes`, or more than `max_tests` test commands, is flagged once.
- **Interface.** A Claude-style band above the prompt shows each job as a tree row with an activity sweep, state, live elapsed time and the latest Codex event, re-read as soon as the job writes one; the band disappears once no job is running; `/workhorse-jobs` opens a pane with recent jobs, the selected job's last commands or report, and returns the `workhorse -l` text even without a UI; the tool's transcript row shows name, mode, effort and goal.
- **Commands that run mid-turn.** `/workhorse-jobs` and `/workhorse-kill <name>`.
- **No competing delegate.** With `hide_codex_rescue` (default on), the official Codex plugin's `codex:codex-rescue` subagent is not offered, so Claude doesn't pick between two delegation paths.
- **`workhorse` CLI.** `bin/workhorse` is the engine and works on its own: `workhorse -C dir`, `--review`, `--ops`, `-w name`, `-r [name] [--code]`, `-l`, `-t`, `-s`, `-k`, `--clean`, `--detach`. The bundled skill teaches Claude both paths.

## Requirements

- Claude Code v2.1.287 or later (tested with v2.1.296)
- Codex CLI with `codex exec --json` (tested with 0.162.1), signed in
- `bash`, `git`, `jq`, `perl`; macOS or Linux

## Install

```bash
claude plugin marketplace add <path-or-git-url-of-this-repo>
claude plugin install workhorse@workhorse
```

To try it without installing: `claude --plugin-dir /path/to/workhorse`.

## Settings

Set them in `/plugin configure workhorse@workhorse`. Empty strings keep `workhorse`'s defaults. Outside the mod, the same values can go in `~/.config/workhorse/config` as `WORKHORSE_*` lines, or in the environment.

| Option | `workhorse` variable | Default |
|---|---|---|
| `model_code`, `model_review`, `model_ops` | `WORKHORSE_MODEL_CODE`, ... | `gpt-6-astra`, `gpt-6-astra`, `gpt-6.1-sol` |
| `effort_code`, `effort_review`, `effort_ops` | `WORKHORSE_EFFORT_CODE`, ... | `medium`, `high`, `high` |
| `fast_match` | `WORKHORSE_FAST_MATCH` | `*sol*`: matching models run on the Fast tier at high effort |
| `disable_mcp` | `WORKHORSE_DISABLE_MCP` | `node_repl` |
| `lang` | `WORKHORSE_LANG` | `zh`; `en` for English rule blocks |
| `allow_ops` | `WORKHORSE_ALLOW_OPS` | `true` |
| `stall_minutes`, `max_tests` | | `10`, `2` |
| `banned_phrases` | | `baseline,全量测试,full test suite,前后对比,before/after` |
| `hide_codex_rescue` | | `true` |

## Develop

```bash
claude plugin validate . --strict
claude plugin test
```

`tests/bin/codex` is an offline stand-in for `codex exec` that replays `tests/fixtures/events.jsonl`; put it first on `PATH` with a scratch `WORKHORSE_HOME` to exercise `bin/workhorse` without spending tokens.
