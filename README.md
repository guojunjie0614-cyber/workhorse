# workhorse

A Claude Code mod that hands coding, review and ops work to Codex the way Claude spawns a subagent. Claude writes a short four-part brief, Codex runs it in the background, and the report comes back to Claude as a message: for a code job with the acceptance command to run, for a review job with a reminder to check its evidence.

## What it adds

Every `mcp__workhorse__run` call requires a short Chinese `title` (6–12 characters, at most 24 terminal columns). New jobs require an English kebab-case `name`, such as `fix-parser`, matching `^[a-z][a-z0-9-]*$`; resumed jobs may omit `name`.

- **`mcp__workhorse__run` tool.** The brief is structured (`goal`, `context` and `done_when` required, `constraints` optional), plus `mode` (`code`, `review`, `ops`), `dir` or `worktree`, `name`, `resume` and `to_code`, `effort` (`low`, `medium`, `high`), `model`. The call returns at once.
- **Brief lint.** A brief without `done_when`, or one whose goal, constraints or acceptance asks for baselines or full suites, is refused before Codex starts; a negated phrase ("不跑全量测试", "no baseline") is allowed.
- **Permissions.** `code` and `review` jobs run without a prompt; `ops` jobs, which run Codex with full access, ask first, and so does a resume of an ops job unless `to_code` or another `mode` is given. `allow_ops: false` turns them off.
- **Watchdog.** Every 30 s the mod reads job status (and once right after a launch). A finished job's report is sent to Claude with a review reminder. A job with no output for `stall_minutes` while no command is running, or more than `max_tests` test commands, is flagged once.
- **Interface.** A Claude-style band above the prompt shows each job as a tree row with a spinning star, full title, state, live elapsed time, and a second line with the latest Codex event, command count and changed-file count, re-read as soon as the job writes an event; finished jobs stay marked ✓ for up to 3 minutes while others run, and the band disappears once no job is running; the tool's transcript row shows name, mode, effort and title. Older stored jobs without a title use the goal's first clause in the band.
- **Commands that run mid-turn.** `/workhorse-kill [name]`; without a name, kill stops this session's only running job or lists them.
- **Job families.** A resume of `fix` or of any of its rounds becomes `fix.2`, `fix.3`, …; the band shows `fix #3`, and `-s`/`-t`/`-k` take the base name for the latest round. The report's first line splits tokens into new (`tokens=`) and `cached=`.
- **No competing delegate.** With `hide_codex_rescue` (default on), the official Codex plugin's `codex:codex-rescue` subagent is not offered, so Claude doesn't pick between two delegation paths.
- **`workhorse` CLI.** `bin/workhorse` is the engine and works on its own: `workhorse -C dir`, `--review`, `--ops`, `-w name`, `-r [name] [--code]`, `-l`, `-t`, `-s` (JSON status, including `activity`, the latest event in one line, and `files`, the number of changed files), `-k`, `--clean`, `--detach`.

`-s` also includes `cancelled` (boolean: this round was stopped by `-k`), `repeat` (integer: the latest consecutive completed commands with identical raw `command` and `exit_code`, reset by a completed `file_change`; 0 when none), `repeat_cmd` (that command's `command_display`, or `""` when `repeat` is 0), and `family_tokens` (tokens across all rounds of the base job, including this round, summed as input − cached + output, matching reports). Cancelled rounds append ` cancelled` to the report's first line.

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
| `fast_match` | `WORKHORSE_FAST_MATCH` | `*sol*`: matching models run on the Fast tier and default to high effort (`-e` or a resumed job's effort wins) |
| `disable_mcp` | `WORKHORSE_DISABLE_MCP` | `node_repl` |
| `allow_ops` | `WORKHORSE_ALLOW_OPS` | `true` |
| `stall_minutes`, `max_tests` | | `10`, `2` |
| `command_minutes` | | `20` minutes before warning once per command text; never terminates the command |
| `repeat_limit` | | `3` consecutive identical command + exit code results before warning once per command text; never terminates the job |
| `family_tokens_warn` | | `1000000` cumulative family tokens before warning once per job |
| `keep_days` | `WORKHORSE_KEEP_DAYS` | `14` days of job history retained by cleanup |
| `skip_skills` | `WORKHORSE_SKIP_SKILLS` | `karpathy-guidelines,code-review,diagnosing-bugs,tdd`; unlike other strings, empty is passed through and disables skill skipping |
| `banned_phrases` | | `baseline,全量测试,full test suite,前后对比,before/after` |
| `hide_codex_rescue` | | `true` |

## Develop

```bash
claude plugin validate . --strict
claude plugin test
```
