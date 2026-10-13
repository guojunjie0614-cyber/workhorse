---
name: workhorse
description: (Claude Code only; Codex must not use this.) Hand coding, ops (deploys, remote runs) or review work to Codex with the `cx` command, the way you would spawn a subagent. Use for any multi-file implementation, bug fix, refactor, deploy or regression run.
---

# cx: Codex as a subagent

Use `cx` the way you use the Agent tool: one Bash call with `run_in_background: true`, the brief as a heredoc, and a notification when it finishes. Its stdout is the short report.

```bash
cx -C <worktree> <<'EOF'
<brief>
EOF
```

| Call | Effect |
|---|---|
| `cx -C dir` | coding job (default): astra **medium**, writes only inside `dir`, network on, cannot touch other machines |
| `cx --review` | read-only diagnosis or review: astra high, runs no tests |
| `cx --ops` | deploys, remote runs, anything outside the repo: sol high + Fast tier, full access |
| `cx -w name` | create a worktree `<repo>-name` on branch `cx/name` from the current HEAD (uncommitted changes are not included) and run there; the job is named `name` |
| `cx --clean name` | after merging, remove that worktree and branch; refuses if the worktree has uncommitted changes or the branch is unmerged |
| `cx -r [name]` | follow-up in the same Codex thread (default: the last job), with the same dir, mode, model and effort; only the new task is sent, because the rules are already in the thread. Refused while that job is still running |
| `cx -r [name] --code` | turn a `--review` diagnosis into the fix on the same thread, with no re-reading |
| Sol | any sol model (`--ops` or `-m ...sol`) runs on the Fast tier with high effort by default; other models use the default tier |
| `-e low\|high` | `low` for mechanical edits; `high` for hard root-cause work. `-m` overrides the model |
| `cx -n name` | name the job (default `<dir>-<time>`) |
| `cx -l` | jobs with state, minutes, tokens, commands, test runs |
| `cx -t [name]` | last commands, test runs so far, elapsed time and minutes since the last output (spots a stall) |
| `cx -k [name]` | stop a job and every command it started |

The report's first line has `tests=N`: how many test commands Codex ran. Anything above 1–2 means it over-tested; tighten the next brief. The diff stat covers only this job's changes, including new files, even when the tree was already dirty. Jobs older than 14 days are pruned. Jobs live in `~/.cache/cx/<name>/` (`prompt.md`, `codex.log`, `final.md`, `report.txt`, `session.txt`). Model, effort and sandbox are passed on every call, resumes included, so the user's Codex app settings never leak in. If a resume silently starts a new thread, the report says so.

cx wraps the brief in `<task>` and adds the blocks from OpenAI's own Codex prompting guide: `action_safety`, `verification_loop`, `default_follow_through_policy` and `compact_output_contract`. These carry the lean rules: do only what is asked, no defensive code, no unrequested tests, run only the named check once, no polling loops, keep going without routine questions, report in at most 10 lines. Don't repeat them in the brief.

## Write the brief

Use OpenAI's four parts and keep each to a few lines:
- **Goal**: the one change.
- **Context**: file and function, the evidence or error in one or two sentences, paths it needs.
- **Constraints**: only what is specific to this task. The general rules are already added.
- **Done when**: one acceptance command.

Rules:
- **One job, one change.** Unrelated asks go to separate jobs. OpenAI's guide lists mixed jobs as an anti-pattern.
- **Unknown root cause:** `cx --review` first, then `cx -r --code`. Don't send an investigation and a fix in one brief.
- **No gates in the brief.** Leave out baselines, full suites, project-wide checks, benchmark reruns and before/after tables; Claude runs the gates once on the merged result. Ask for a measurement only when it is the acceptance criterion. Briefs that asked for all of these produced 500K–774K token, 50–84 min jobs.
- **Tighten the brief before raising effort.** OpenAI recommends starting astra at a low effort; a better contract beats more reasoning.
- **Parallel:** 2–3 jobs at once, each with `cx -w <task>` on disjoint files. Commit first, since worktrees start from HEAD. Always resume parallel jobs by name (`cx -r <task>`), because a bare `-r` takes the last started job. After merging, `cx --clean <task>`.
- **Long remote runs:** an ops job launches the run, or calls one script that runs, waits and collects in a single blocking command. Claude waits with Monitor, then `cx -r` to analyse.

## Supervise and review

- On a long job, `cx -t` now and then. When the last output is old, or the commands repeat, `cx -k` and re-brief it smaller.
- Never accept unreviewed. Read the diff against the brief, run the acceptance command yourself, and send fixes back with `cx -r`.
- A failed job is reported to the user with its log tail. Don't quietly redo it yourself.
