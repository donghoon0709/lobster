# Lobster Command Reference

This page documents the **registry-backed commands** available inside Lobster pipelines and workflow-file `pipeline:` steps.

For the top-level CLI (`lobster run`, `lobster resume`, `lobster help`, and so on), see [`cli-reference.md`](./cli-reference.md).

## Scope and naming

- This reference covers the commands registered in `src/commands/registry.ts`.
- Installed executable shims such as `openclaw.invoke` and `clawd.invoke` are mentioned where relevant, but their CLI entrypoint behavior is documented separately in [`cli-reference.md`](./cli-reference.md).
- The command inventory below reflects **implemented behavior only**.

## Command groups

1. [Data, shaping, and rendering](#data-shaping-and-rendering)
2. [Approval, state, and inspection](#approval-state-and-inspection)
3. [LLM and OpenClaw integration](#llm-and-openclaw-integration)
4. [Workflow and recipe commands](#workflow-and-recipe-commands)

---

## Data, shaping, and rendering

### `exec`
**Purpose:** Run an OS command.

**Usage:**
```text
exec <command...>
exec --stdin raw|json|jsonl <command...>
exec --json <command...>
exec --shell "<command line>"
```

**Key args / notes:**
- `--json` parses stdout as a single JSON value.
- `--stdin raw|json|jsonl` writes pipeline input to the subprocess stdin.
- `--shell` runs via the system shell.

**Example:**
```bash
exec --json --shell "echo [1,2,3]"
```

**Source:** `src/commands/stdlib/exec.ts`

### `head`
**Purpose:** Take the first N input items.

**Usage:**
```text
head --n 10
```

**Key args / notes:**
- `--n` defaults to `10`.

**Example:**
```bash
gog.gmail.search --query 'newer_than:1d' --max 20 | head --n 5
```

**Source:** `src/commands/stdlib/head.ts`

### `json`
**Purpose:** Render pipeline output as JSON.

**Usage:**
```text
... | json
```

**Key args / notes:**
- Takes no command-specific flags.
- Intended as a renderer near the end of a pipeline.

**Example:**
```bash
exec --json --shell "echo [1,2,3]" | json
```

**Source:** `src/commands/stdlib/json.ts`

### `pick`
**Purpose:** Project selected fields from object items.

**Usage:**
```text
... | pick id,subject,from
```

**Key args / notes:**
- The first positional argument is a comma-separated field list.

**Example:**
```bash
gog.gmail.search --query 'newer_than:1d' --max 20 | pick id,subject,from
```

**Source:** `src/commands/stdlib/pick.ts`

### `table`
**Purpose:** Render items as a simple table.

**Usage:**
```text
... | table
```

**Key args / notes:**
- If items are objects, columns are derived from the union of keys in the first 20 items.

**Example:**
```bash
gog.gmail.search --query 'newer_than:1d' --max 5 | pick id,subject,from | table
```

**Source:** `src/commands/stdlib/table.ts`

### `where`
**Purpose:** Filter objects by a simple predicate.

**Usage:**
```text
... | where unread=true
... | where minutes>=30
... | where sender.domain==example.com
```

**Key args / notes:**
- The first positional argument is the predicate expression.
- Expressions operate on object fields, including dot paths.

**Example:**
```bash
gog.gmail.search --query 'newer_than:1d' --max 20 | where unread=true
```

**Source:** `src/commands/stdlib/where.ts`

### `sort`
**Purpose:** Sort items stably by a key or by their stringified value.

**Usage:**
```text
... | sort
... | sort --key updatedAt
... | sort --key prNumber --desc
```

**Key args / notes:**
- `--key` accepts a dot-path.
- `--desc` reverses sort order.
- Sorting is stable, and `undefined` / `null` keys sort last.

**Example:**
```bash
workflows.list | sort --key name
```

**Source:** `src/commands/stdlib/sort.ts`

### `dedupe`
**Purpose:** Remove duplicate items while keeping the first occurrence.

**Usage:**
```text
... | dedupe
... | dedupe --key id
```

**Key args / notes:**
- `--key` uses a dot-path identity field.
- Without `--key`, the whole item is used for identity.

**Example:**
```bash
exec --json --shell "echo [{\"id\":1},{\"id\":1},{\"id\":2}]" | dedupe --key id | json
```

**Source:** `src/commands/stdlib/dedupe.ts`

### `template`
**Purpose:** Render a simple template against each input item.

**Usage:**
```text
... | template --text 'PR {{number}}: {{title}}'
... | template --file ./draft.txt
```

**Key args / notes:**
- Supports `{{field}}`, `{{nested.field}}`, and `{{.}}` for the whole item.
- Missing values render as empty strings.

**Example:**
```bash
workflows.list | template --text 'Workflow: {{name}}'
```

**Source:** `src/commands/stdlib/template.ts`

### `map`
**Purpose:** Transform items by wrapping, unwrapping, or adding fields.

**Usage:**
```text
... | map --wrap item
... | map --unwrap item
... | map foo=bar id={{id}}
```

**Key args / notes:**
- `--wrap <key>` yields `{ <key>: item }`.
- `--unwrap <key>` yields `item[<key>]`.
- Positional assignments like `foo=bar` support template placeholders.

**Example:**
```bash
workflows.list | map kind=workflow id={{name}}
```

**Source:** `src/commands/stdlib/map.ts`

### `groupBy`
**Purpose:** Group input items by a key.

**Usage:**
```text
... | groupBy --key from
```

**Key args / notes:**
- `--key` is required.
- Output items have the shape `{ key, items, count }`.
- Group order is stable.

**Example:**
```bash
gog.gmail.search --query 'newer_than:1d' --max 20 | groupBy --key from
```

**Source:** `src/commands/stdlib/group_by.ts`

---

## Approval, state, and inspection

### `approve`
**Purpose:** Require confirmation before a pipeline continues.

**Usage:**
```text
... | approve --prompt "Send these emails?"
... | approve --emit --prompt "Send these emails?"
... | approve --emit --preview-from-stdin --limit 5 --prompt "Proceed?"
```

**Key args / notes:**
- Interactive mode prompts on a TTY and passes items through if approved.
- `--emit` returns an approval-request object and halts.
- In tool mode or non-interactive runs, Lobster emits an approval request automatically.

**Example:**
```bash
... | email.triage --llm --emit drafts | approve --prompt 'Send replies?'
```

**Source:** `src/commands/stdlib/approve.ts`

### `state.get`
**Purpose:** Read a JSON value from Lobster state.

**Usage:**
```text
state.get <key>
```

**Key args / notes:**
- Missing keys return `null`.
- `LOBSTER_STATE_DIR` overrides the storage directory.

**Example:**
```bash
state.get github.pr:openclaw/openclaw#1152
```

**Source:** `src/commands/stdlib/state.ts`

### `state.set`
**Purpose:** Write a JSON value to Lobster state.

**Usage:**
```text
<value> | state.set <key>
```

**Key args / notes:**
- Consumes the entire input stream.
- If a single item is provided, that value is stored directly.
- If multiple items are provided, Lobster stores an array.

**Example:**
```bash
exec --json --shell "echo {\"changed\":true}" | state.set my.workflow.last-result
```

**Source:** `src/commands/stdlib/state.ts`

### `diff.last`
**Purpose:** Compare current items to the last stored snapshot.

**Usage:**
```text
<items> | diff.last --key <stateKey>
```

**Key args / notes:**
- Returns objects shaped like `{ changed, key, before, after }`.
- Useful for “notify only when the result changed” workflows.

**Example:**
```bash
exec --json --shell "echo {\"version\":2}" | diff.last --key sample.snapshot
```

**Source:** `src/commands/stdlib/diff_last.ts`

### `commands.list`
**Purpose:** List the currently registered Lobster pipeline commands.

**Usage:**
```text
commands.list
```

**Key args / notes:**
- Intended for agent-driven discovery.
- Output includes command name, description, and optional metadata such as `argsSchema`, `examples`, and `sideEffects`.

**Example:**
```bash
commands.list | json
```

**Source:** `src/commands/commands_list.ts`

---

## LLM and OpenClaw integration

### `openclaw.invoke`
**Purpose:** Call a local OpenClaw tool endpoint from a pipeline.

**Usage:**
```text
openclaw.invoke --tool message --action send --args-json '{...}'
openclaw.invoke --tool message --action send --args-json '{...}' --dry-run
... | openclaw.invoke --tool message --action send --each --item-key message --args-json '{...}'
```

**Key args / notes:**
- Requires `--tool` and `--action`.
- Uses `OPENCLAW_URL` by default; `CLAWD_URL` is accepted for backward compatibility.
- Uses `OPENCLAW_TOKEN` by default; `CLAWD_TOKEN` is also accepted.
- `--each` maps each input item into the tool args object.
- This same name is also installed as a package executable shim.

**Example:**
```bash
openclaw.invoke --tool message --action send --args-json '{"provider":"telegram","to":"...","message":"hello"}'
```

**Source:** `src/commands/stdlib/openclaw_invoke.ts`, `bin/openclaw.invoke.js`

### `clawd.invoke`
**Purpose:** Backward-compatible alias for `openclaw.invoke`.

**Usage:**
```text
clawd.invoke --tool message --action send --args-json '{...}'
... | clawd.invoke --tool message --action send --each --item-key message --args-json '{...}'
```

**Key args / notes:**
- Shares the same implementation and argument model as `openclaw.invoke`.
- Also installed as a package executable shim.

**Example:**
```bash
clawd.invoke --tool message --action send --args-json '{"provider":"telegram","to":"...","message":"hello"}'
```

**Source:** `src/commands/stdlib/openclaw_invoke.ts`, `bin/clawd.invoke.js`

### `llm.invoke`
**Purpose:** Call a configured LLM adapter with typed payload validation, caching, and optional schema validation.

**Usage:**
```text
llm.invoke --prompt 'Write summary'
llm.invoke --provider openclaw --model claude-3-sonnet --prompt 'Write summary'
cat artifacts.json | llm.invoke --provider pi --prompt 'Score each item'
... | llm.invoke --prompt 'Plan next steps' --output-schema '{"type":"object"}'
```

**Key args / notes:**
- Provider resolution order: `--provider`, `LOBSTER_LLM_PROVIDER`, then environment auto-detect.
- Built-in providers: `openclaw`, `pi`, `http`.
- Supports `--artifacts-json`, `--metadata-json`, `--output-schema`, `--schema-version`, `--max-validation-retries`, `--state-key`, `--disable-cache`, and `--refresh`.
- Uses run-state plus a file cache so resumed workflows do not repeat the same LLM call.

**Example:**
```bash
exec --json --shell "echo {\"location\":\"Phoenix\",\"temp_f\":73.8}" | llm.invoke --provider http --prompt 'Given this weather data, should I wear a jacket? Return JSON.' --disable-cache
```

**Source:** `src/commands/stdlib/llm_invoke.ts`

### `llm_task.invoke`
**Purpose:** Backward-compatible alias for `llm.invoke` using the OpenClaw adapter by default.

**Usage:**
```text
llm_task.invoke --prompt 'Write summary'
llm_task.invoke --model claude-3-sonnet --prompt 'Write summary'
cat artifacts.json | llm_task.invoke --prompt 'Score each item'
```

**Key args / notes:**
- Defaults to the OpenClaw provider.
- Requires `OPENCLAW_URL` (or `CLAWD_URL`) and optionally `OPENCLAW_TOKEN`.
- Use `llm.invoke` for new workflows when you do not need the legacy alias.

**Example:**
```bash
llm_task.invoke --prompt 'Summarize the latest email batch'
```

**Source:** `src/commands/stdlib/llm_invoke.ts`, `src/commands/stdlib/llm_task_invoke.ts`

---

## Workflow and recipe commands

### `workflows.list`
**Purpose:** List the built-in Lobster workflows.

**Usage:**
```text
workflows.list
```

**Key args / notes:**
- Intended for dynamic discovery by OpenClaw or other agents.
- The current built-in names are defined in `src/workflows/registry.ts`.

**Example:**
```bash
workflows.list | json
```

**Source:** `src/commands/workflows/workflows_list.ts`

### `workflows.run`
**Purpose:** Run a named Lobster workflow from the built-in registry.

**Usage:**
```text
workflows.run --name <workflow> [--args-json '{...}']
```

**Key args / notes:**
- `--name` is required.
- `--args-json` must be valid JSON.
- Works with the named workflows known to `src/workflows/registry.ts` and implemented runners.

**Example:**
```bash
workflows.run --name github.pr.monitor.notify --args-json '{"repo":"openclaw/openclaw","pr":1152}'
```

**Source:** `src/commands/workflows/workflows_run.ts`

### `gog.gmail.search`
**Purpose:** Fetch Gmail messages through the external `gog` CLI.

**Usage:**
```text
gog.gmail.search --query 'newer_than:1d' --max 20
```

**Key args / notes:**
- Requires the `gog` CLI.
- `GOG_BIN` overrides the executable name.
- `--limit` is an alias for `--max`.
- Outputs a stream of message objects.

**Example:**
```bash
gog.gmail.search --query 'newer_than:1d' --max 20
```

**Source:** `src/commands/stdlib/gog_gmail_search.ts`

### `gog.gmail.send`
**Purpose:** Send Gmail drafts through the external `gog` CLI.

**Usage:**
```text
... | approve --prompt 'Send replies?' | gog.gmail.send
```

**Key args / notes:**
- Requires the `gog` CLI.
- Expects draft-like input objects shaped like `{ to, subject, body }`.
- Supports `--dry-run` / `--dryRun`.

**Example:**
```bash
... | email.triage --llm --emit drafts | approve --prompt 'Send replies?' | gog.gmail.send
```

**Source:** `src/commands/stdlib/gog_gmail_send.ts`

### `email.triage`
**Purpose:** Categorize emails and optionally draft replies.

**Usage:**
```text
gog.gmail.search --query 'newer_than:1d' --max 20 | email.triage
gog.gmail.search --query 'newer_than:1d' --max 20 | email.triage --llm --model <model>
... | email.triage --llm --model <model> --emit drafts | approve --prompt 'Send replies?' | gog.gmail.send
```

**Key args / notes:**
- Deterministic by default.
- `--llm` enables LLM-assisted categorization and draft generation through `llm.invoke`.
- `--emit report` (default) returns a report; `--emit drafts` returns draft objects suitable for `gog.gmail.send`.
- Does not send email by itself.

**Example:**
```bash
gog.gmail.search --query 'newer_than:1d' --max 20 | email.triage --llm --model claude-3-sonnet --emit drafts
```

**Source:** `src/commands/stdlib/email_triage.ts`

## Registry inventory

The default registry currently includes these commands:

- `approve`
- `clawd.invoke`
- `commands.list`
- `dedupe`
- `diff.last`
- `email.triage`
- `exec`
- `gog.gmail.search`
- `gog.gmail.send`
- `groupBy`
- `head`
- `json`
- `llm.invoke`
- `llm_task.invoke`
- `map`
- `openclaw.invoke`
- `pick`
- `sort`
- `state.get`
- `state.set`
- `table`
- `template`
- `where`
- `workflows.list`
- `workflows.run`

## Source of truth

- `src/commands/registry.ts`
- command files under `src/commands/stdlib/`
- command files under `src/commands/workflows/`
- `package.json` and `bin/*.js` for installed executable aliases
