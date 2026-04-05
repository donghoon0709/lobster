# `.lobster` File Syntax and Workflow Authoring

This guide explains how to author Lobster workflow files from a **user point of view**, while staying faithful to the current implementation in `src/workflows/file.ts`, `src/parser.ts`, and the test suite.

## What a workflow file is

A Lobster workflow file is a **YAML or JSON object** with a non-empty `steps` array.

The CLI accepts files ending in:

- `.lobster`
- `.yaml`
- `.yml`
- `.json`

`.lobster` is just the preferred filename extension for Lobster workflows.

## Minimal example

```yaml
name: jacket-advice
args:
  location:
    default: Phoenix
steps:
  - id: fetch
    run: weather --json ${location}

  - id: confirm
    approval: Want jacket advice from the LLM?
    stdin: $fetch.json

  - id: advice
    pipeline: >
      llm.invoke --prompt "Given this weather data, should I wear a jacket?
      Be concise and return JSON."
    stdin: $fetch.json
    when: $confirm.approved
```

## Top-level fields

| Field | Type | Meaning |
| --- | --- | --- |
| `name` | string | Optional display name for the workflow |
| `description` | string | Optional description |
| `args` | object | Optional argument definitions with defaults/descriptions |
| `env` | object | Optional environment variables applied to all steps |
| `cwd` | string | Optional working directory applied to all steps |
| `steps` | array | **Required** non-empty list of workflow steps |

If `steps` is missing or empty, the workflow is invalid.

## Step fields

Every step must be an object with a unique string `id`.

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | **Required** unique step identifier |
| `run` | string | Shell command to run |
| `command` | string | Shell command alias for `run` |
| `pipeline` | string | Lobster pipeline string |
| `env` | object | Step-specific environment variables |
| `cwd` | string | Step-specific working directory |
| `stdin` | any | Input for the step |
| `approval` | `true` / string / object | Approval gate for the step |
| `when` | boolean / string | Conditional execution |
| `condition` | boolean / string | Alias for `when` |

### Execution rule
A step may define **exactly one** of:

- `run`
- `command`
- `pipeline`

The one exception is an **approval-only** step, which may omit all three if `approval` is present.

## `run` vs `command`

`run` and `command` are equivalent shell-step fields. The runtime treats them the same way.

```yaml
steps:
  - id: first
    run: echo hello

  - id: second
    command: echo world
```

For new files, `run:` is the clearer spelling.

## `pipeline`

Use `pipeline:` when you want a step to run Lobster registry commands rather than a shell command.

```yaml
steps:
  - id: advice
    pipeline: llm.invoke --prompt "Summarize this data" --disable-cache
    stdin: $fetch.json
```

Important limitation:
- If a nested `pipeline:` stage halts for approval, the workflow step fails.
- To make approvals resumable, use a **separate workflow step** with `approval:`.

## `approval`

`approval` turns a step into a human checkpoint.

Supported forms:

### String prompt

```yaml
- id: confirm
  approval: Want to continue?
  stdin: $fetch.json
```

### Object form

```yaml
- id: confirm
  approval:
    prompt: Want to continue?
    preview: About to send the generated drafts.
```

### Required / boolean form

```yaml
- id: confirm
  approval: required
```

```yaml
- id: confirm
  approval: true
```

In tool mode (or any non-interactive run), approval pauses the workflow and returns a `resumeToken`.

## Conditions: `when` and `condition`

`when` and `condition` are equivalent. The runtime currently supports:

- `true`
- `false`
- `$step.approved`
- `$step.skipped`

Example:

```yaml
- id: advice
  pipeline: llm.invoke --prompt "Return JSON"
  stdin: $fetch.json
  when: $confirm.approved
```

If a condition references a step that has not produced a matching result yet, it evaluates to `false`.

## `stdin`

`stdin` controls what input a step receives.

Common forms:

### Use another step's JSON output

```yaml
stdin: $fetch.json
```

### Use another step's stdout

```yaml
stdin: $render.stdout
```

### Use a literal string with argument or step interpolation

```yaml
stdin: "Task: ${task}"
```

Shell steps receive `stdin` as a string. Structured values are JSON-encoded before being written to the process.

Pipeline steps receive `stdin` as pipeline items:
- arrays become multiple input items
- single values become one input item

## Workflow args

Use top-level `args` to define optional workflow inputs.

```yaml
args:
  task:
    default: daily triage
    description: Short task label
```

Pass values from the CLI with `--args-json`:

```bash
lobster run --file workflow.lobster --args-json '{"task":"urgent triage"}'
```

### `${arg}` interpolation

String fields such as `run`, `command`, `pipeline`, `cwd`, and `env` values support `${arg}` placeholders.

```yaml
steps:
  - id: echo
    run: echo ${task}
```

If an argument key is missing, the placeholder is left unchanged.

### Automatically injected environment variables

Lobster also exposes workflow args as environment variables for shell steps:

- `LOBSTER_ARGS_JSON`
- `LOBSTER_ARG_<NAME>`

Example:

```yaml
args:
  text:
    default: hello
steps:
  - id: echo
    command: >
      node -e "process.stdout.write(JSON.stringify({text: process.env.LOBSTER_ARG_TEXT}))"
```

This is the safest way to pass quoted or shell-sensitive values into shell commands.

## Step references inside strings

String fields may reference earlier step results:

- `$step.stdout`
- `$step.json`
- `$step.approved`

Examples:

```yaml
env:
  PREVIOUS_JSON: $fetch.json

stdin: $fetch.stdout

when: $confirm.approved
```

For string interpolation:
- `$step.stdout` becomes the raw stdout string
- `$step.json` becomes JSON text
- `$step.approved` becomes `true` or `false`

For direct `stdin` references:
- `$step.stdout` returns the raw stdout value
- `$step.json` returns the structured JSON value

## Environment variables and working directory

Top-level `env` / `cwd` apply to every step unless a step overrides them.

```yaml
env:
  LOG_LEVEL: debug
cwd: /tmp/lobster
steps:
  - id: run-task
    run: node script.js
```

Step-level `env` values override top-level values.

## Pipeline string parsing inside `pipeline:`

Lobster parses pipeline strings with these rules:

- `|` splits pipeline stages **outside** quotes
- single quotes and double quotes are both supported
- backslash escapes are preserved inside quoted strings
- long args support both `--flag` and `--key=value`

Example:

```yaml
pipeline: >
  exec --json --shell "echo [1,2,3]" | head --n 1 | json
```

## Approval and resume flow

When a workflow hits an approval step in tool mode or a non-interactive environment, Lobster returns:

- `status: "needs_approval"`
- `requiresApproval.prompt`
- `requiresApproval.items`
- `requiresApproval.preview` (when available)
- `requiresApproval.resumeToken`

Resume with:

```bash
lobster resume --token <token> --approve yes
lobster resume --token <token> --approve no
```

Rejecting the approval cancels the run and cleans up stored resume state.

## Practical patterns

### Pattern: shell step → approval step → pipeline step

```yaml
steps:
  - id: fetch
    run: node -e "process.stdout.write(JSON.stringify({location:'Phoenix',temp_f:73.8}))"

  - id: confirm
    approval: Want jacket advice from the LLM?
    stdin: $fetch.json

  - id: advice
    pipeline: llm.invoke --provider http --prompt "Given this weather data, should I wear a jacket? Return JSON." --disable-cache
    stdin: $fetch.json
    when: $confirm.approved
```

### Pattern: safe shell access to workflow args

```yaml
args:
  text:
    default: hello
steps:
  - id: echo
    command: >
      node -e "process.stdout.write(JSON.stringify({text: process.env.LOBSTER_ARG_TEXT}))"
```

## Validation rules to remember

A workflow file is invalid if:

- the top level is not a JSON/YAML object
- `steps` is missing or empty
- a step is not an object
- a step is missing `id`
- two steps share the same `id`
- a step defines more than one of `run`, `command`, or `pipeline`
- a non-approval step defines none of `run`, `command`, or `pipeline`
- `run`, `command`, or `pipeline` is present but not a string

## Source of truth

- `src/cli.ts`
- `src/parser.ts`
- `src/workflows/file.ts`
- `test/workflow_file.test.ts`
- `test/workflow_args_env.test.ts`
- `test/cli_run_file_args_json.test.ts`
- `test/tool_mode.test.ts`
