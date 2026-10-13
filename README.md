# workhorse

> A Claude Code mod that hands coding, review and ops work to Codex as background subagents. Claude writes a four-part brief, Codex does the work in the background, and the report comes back into the conversation for Claude to verify. User-facing text and Codex rules are in Chinese.

让 Claude Code 像派子代理一样把活交给 Codex：Claude 写一份四段式 brief，Codex 在后台干活，报告自动回到对话里，由 Claude 审 diff、跑验收。Claude 负责想清楚和把关，Codex 负责动手。

```
✻ Working…
2 agents · 2 running · 0 done
├─ ✻ demo-fix     修复加法错误    running    21s
│    已把 a - b 改为 a + b · 3 cmds · 1 files
└─ ✻ demo-review  审查计算器缺口  running    21s
     nl -ba calc.py · 2 cmds · 0 files
```

## 它做了什么

- **一个工具派活。** `mcp__workhorse__run` 调用后立即返回，Codex 在后台运行；Claude 不用轮询，完成后报告以消息形式送回对话，附带下一步提醒（code 任务提醒运行验收命令，review 任务提醒核对证据）。
- **实时任务面板。** 提示框上方用 Claude 风格的树状面板显示本会话的每个任务：英文任务名、完整的中文说明、状态、每秒刷新的耗时；第二行实时显示 Codex 正在执行的命令和累计命令数、改动文件数。全部结束后面板自动消失。
- **brief 先过检查。** 缺 `done_when`、缺中文 `title`、任务名不是英文短横线命名，或者 brief 里要求 baseline、全量测试、前后对比，都会在 Codex 启动前被拒绝；"不跑全量测试"这类否定说法不受影响。
- **三种模式，权限分级。** `code` 只能写目标目录，`review` 只读，`ops` 可以访问仓库外和远程机器。`ops` 任务（以及续做 ops 任务）每次都会先征求你的同意。
- **看门狗只提醒、不杀进程。** 长时间无输出、单条命令跑太久、同一命令原地打转、测试跑太多、同一任务累计 token 过多，各提醒一次。
- **同一线程续做。** 用 `resume` 在原 Codex 线程上继续，不用重新读代码；review 的诊断可以用 `to_code` 直接转成修复。轮次自动命名为 `fix.2`、`fix.3`，面板显示为 `fix #3`。
- **并行用 worktree 隔离。** `worktree: <name>` 从当前 HEAD 建独立工作树和分支，多个任务改不同文件时互不干扰；合并后用 `workhorse --clean` 清理，未合并的分支会被拒绝删除。
- **报告精简可核对。** 第一行是退出码、模式、模型、耗时、新增与缓存 token、命令数、测试次数；接着是这次任务自己的 diff 统计（即使工作树原本就有未提交改动），最后是 Codex 不超过 10 行的总结。
- **省 token 的规则块。** 每个首轮任务都附带按 OpenAI Codex 提示指南写的四段规则：只做要求的事、只跑指定的验证一次、不轮询、简短报告。续做同一模式时只补一句"前面的规则仍然有效"。

## 安装

需要：

- Claude Code v2.1.287 或更新（支持 mod；在 v2.1.296 上测试）
- Codex CLI，支持 `codex exec --json` 且已登录（在 0.162.1 上测试）
- `bash`、`git`、`jq`、`perl`；macOS 或 Linux

```bash
claude plugin marketplace add guojunjie0614-cyber/workhorse
claude plugin install workhorse@workhorse
```

装好后在会话里执行 `/reload-plugins`，或新开一个会话（新开会话会让工具参数定义完整更新）。

想在终端里直接用引擎，克隆仓库后把它链接到 `PATH`：

```bash
git clone https://github.com/guojunjie0614-cyber/workhorse.git ~/workhorse
ln -s ~/workhorse/bin/workhorse ~/.local/bin/workhorse
```

## 怎么用

装好后正常跟 Claude 说要做什么即可，插件自带的 skill 会教 Claude 何时派活、怎么写 brief、怎么审结果。一次调用长这样：

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 新任务必填 | 英文短横线命名，如 `fix-parser`；续做时可省略 |
| `title` | 是 | 6–12 个中文字，面板完整显示，如"修复解析器空值" |
| `goal` | 是 | 这一个改动是什么 |
| `context` | 是 | 文件、函数、错误证据、需要的路径 |
| `constraints` | 否 | 只写这个任务特有的限制 |
| `done_when` | 是 | 一条验收命令 |
| `mode` | 否 | `code`（默认）、`review`、`ops` |
| `dir` / `worktree` | 否 | 工作目录；或新建 worktree 并行 |
| `resume`、`to_code` | 否 | 在原线程续做；把 review 结论转成修复 |
| `effort`、`model` | 否 | 覆盖默认推理强度和模型 |

推荐的工作方式：

1. **一个任务只做一个改动。** 不相关的需求拆成多个任务。
2. **根因不明先 review。** 先 `mode: review` 诊断，再 `resume` + `to_code` 修复。
3. **brief 里不写门禁。** baseline、全量测试、基准对比由 Claude 在合并后统一跑一次。
4. **先收紧 brief，再提高强度。** 好的 brief 比更高的 effort 更省更准。
5. **并行 2–3 个任务，按文件分开。** 先提交，再各自开 worktree。
6. **不验收不接受。** Claude 对照 brief 读 diff，自己跑验收命令，有问题用 `resume` 交回。

需要手动停止任务时，在会话里输入 `/workhorse-kill [name]`；不带名字时会停掉本会话唯一在跑的任务，有多个则列出来让你指定。

## 看门狗提醒

| 情况 | 触发条件（设置项） | 默认 |
|---|---|---|
| 无输出 | 没有命令在跑，且这么多分钟没有新事件（`stall_minutes`） | 10 |
| 命令跑太久 | 单条命令运行超过这么多分钟（`command_minutes`） | 20 |
| 原地打转 | 同一命令、同一退出码连续出现这么多次，中间没改文件（`repeat_limit`） | 3 |
| 测试跑太多 | 测试类命令超过这么多次（`max_tests`） | 2 |
| token 过多 | 同一任务所有轮次累计 token 达到这个数（`family_tokens_warn`） | 1000000 |

每类提醒对同一任务只发一次，会同时弹出提示并告诉 Claude；被 `-k` 停掉的任务在面板上显示为灰色 `cancelled`，不计入失败。

## 命令行引擎

`bin/workhorse` 是独立可用的引擎，插件通过它启动和查询任务：

| 命令 | 作用 |
|---|---|
| `workhorse -C dir <<'EOF' … EOF` | 在 `dir` 里起一个 code 任务，brief 从 stdin 读入 |
| `workhorse --review` / `--ops` | 只读诊断 / 运维任务 |
| `workhorse -w name` | 新建 worktree `<repo>-name`（分支 `workhorse/name`）并在其中运行 |
| `workhorse -r [name] [--code]` | 在同一 Codex 线程续做 |
| `workhorse -l` | 最近的任务及其结果 |
| `workhorse -t [name]` | 最近执行的命令、测试次数、距上次输出多久 |
| `workhorse -s [name …]` | JSON 状态，供插件读取 |
| `workhorse -k [name]` | 停止任务及其启动的所有命令 |
| `workhorse --clean name` | 合并后删除 worktree 和分支 |
| `workhorse -h` | 用法和当前设置 |

任务记录存放在 `~/.cache/workhorse/<name>/`（`prompt.md`、`events.jsonl`、`final.md`、`report.txt`、`session.txt` 等），超过 `keep_days` 天自动清理。

## 设置

在 `/plugin configure workhorse@workhorse` 里修改。字符串留空表示用引擎默认值。单独用命令行时，可以写成环境变量，或写进 `~/.config/workhorse/config`（每行 `WORKHORSE_XXX=值`）。

| 设置 | 引擎变量 | 默认 |
|---|---|---|
| `model_code`、`model_review`、`model_ops` | `WORKHORSE_MODEL_*` | `gpt-6-astra`、`gpt-6-astra`、`gpt-6.1-sol` |
| `effort_code`、`effort_review`、`effort_ops` | `WORKHORSE_EFFORT_*` | `medium`、`high`、`high` |
| `fast_match` | `WORKHORSE_FAST_MATCH` | `*sol*`：匹配的模型走 Fast 档，默认 high 强度 |
| `disable_mcp` | `WORKHORSE_DISABLE_MCP` | `node_repl` |
| `allow_ops` | `WORKHORSE_ALLOW_OPS` | `true` |
| `keep_days` | `WORKHORSE_KEEP_DAYS` | `14` |
| `skip_skills` | `WORKHORSE_SKIP_SKILLS` | `karpathy-guidelines,code-review,diagnosing-bugs,tdd`：Codex 不必再读的通用流程技能；留空则去掉这条规则 |
| `stall_minutes`、`command_minutes`、`repeat_limit`、`max_tests`、`family_tokens_warn` | | 见上方看门狗表 |
| `banned_phrases` | | `baseline,全量测试,full test suite,前后对比,before/after` |
| `hide_codex_rescue` | | `true`：装了官方 Codex 插件时，不让 Claude 再看到 `codex:codex-rescue`，避免两条派活路径相互竞争 |

## 工作原理

```
Claude ──mcp__workhorse__run──▶ hooks/register.ts ──lint / 权限──▶ bin/workhorse --detach
                                     ▲                                   │
                                     │ 状态（-s，事件变化即刷新）          ▼
                              面板 / 提醒 / 完成通知  ◀── events.jsonl ◀── codex exec --json
```

- `hooks/register.ts` 注册工具、权限检查、`/workhorse-kill` 和面板，按会话隔离状态；每 30 秒轮询一次，任务写入新事件时立即刷新。
- `hooks/lib.ts` 放 brief 拼装、lint、命令行参数、面板排版和全部中文文案。
- `bin/workhorse` 负责建目录、拼规则块、启动 Codex、记录事件、生成报告、worktree 和清理。
- `prompts/blocks.md` 是附加给 Codex 的四段规则。
- `skills/workhorse/SKILL.md` 教 Claude 写 brief 和审查。

完成通知确认送达后才删除任务记录；Codex 线程一开始就记下线程 ID，进程意外中断后也能续做。

## 开发

```bash
claude plugin validate . --strict
claude plugin test
```

测试在 `hooks/workhorse.test.ts`，使用 Claude Code 自带的 mod 测试工具（模拟 store、时钟和进程调用），不消耗 token。
