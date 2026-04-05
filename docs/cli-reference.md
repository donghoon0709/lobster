# Lobster CLI Reference

This page covers the **top-level `lobster` CLI**. For commands used **inside** a Lobster pipeline or a workflow-file `pipeline:` step, see [`command-reference.md`](./command-reference.md).

## Usage summary

```text
lobster '<pipeline>'
lobster run --mode tool '<pipeline>'
lobster run path/to/workflow.lobster
lobster run --file path/to/workflow.lobster --args-json '{...}'
lobster resume --token <token> --approve yes|no
lobster doctor
lobster version
lobster help <command>
```

## Top-level commands

### `lobster '<pipeline>'`
Run a pipeline directly from the command line.

```bash
lobster 'exec --json "echo [1,2,3]" | json'
```

Use this form when you want to run ad hoc pipeline commands without a workflow file.

### `lobster run`
`run` supports two distinct entry paths:

1. **Pipeline string mode**

   ```bash
   lobster run --mode tool 'exec --json "echo [1]" | approve --prompt "ok?"'
   ```

2. **Workflow file mode**

   ```bash
   lobster run path/to/workflow.lobster
   lobster run --file path/to/workflow.lobster --args-json '{"task":"test"}'
   ```

If `run` receives a single file path ending in `.lobster`, `.yaml`, `.yml`, or `.json`, Lobster treats it as a workflow file.

### `lobster resume --token <token> --approve yes|no`
Resume a paused workflow-file run or approval-gated tool-mode pipeline.

```bash
lobster resume --token <token> --approve yes
lobster resume --token <token> --approve no
```

Notes:
- `--approve yes|no` is required.
- Rejecting (`no`) returns `status: "cancelled"` and cleans up persisted resume state.
- Resume tokens are versioned and validated before use.

### `lobster doctor`
Run a small built-in health check and print a **tool envelope**.

```bash
lobster doctor
```

The output includes:
- `protocolVersion: 1`
- `ok`
- `status`
- `output`
- current Lobster version

### `lobster version`
Print the package version.

```bash
lobster version
```

### `lobster help <command>`
Print the help text for a registry-backed command.

```bash
lobster help llm.invoke
lobster help approve
```

## Human mode vs tool mode

### Human mode (default)
Human mode is intended for direct shell use. Renderers may write to stdout.

### Tool mode
Tool mode prints a single JSON envelope for agent/tool integration.

```bash
lobster run --mode tool 'exec --json "echo [1]" | json'
```

Typical fields:

```json
{
  "protocolVersion": 1,
  "ok": true,
  "status": "ok",
  "output": [],
  "requiresApproval": null
}
```

If a run needs approval, tool mode returns `status: "needs_approval"` plus a `requiresApproval` object containing a `resumeToken`.

## Workflow files from the CLI

### Accepted file extensions
Lobster accepts workflow files ending in:

- `.lobster`
- `.yaml`
- `.yml`
- `.json`

`.lobster` is a naming convention, not a separate parser. Non-JSON files are loaded as YAML objects.

### Passing workflow args
Use `--args-json` to provide workflow arguments:

```bash
lobster run --file workflows/pr-monitor.lobster --args-json '{"repo":"openclaw/openclaw","pr":1152}'
```

`--args-json` must be valid JSON.

## Installed shim executables

The npm package also installs executable shims from `package.json`:

- `lobster`
- `openclaw.invoke`
- `clawd.invoke`

The two `*.invoke` shims forward their argv to the matching Lobster pipeline command:

```bash
openclaw.invoke --tool message --action send --args-json '{"provider":"telegram","to":"...","message":"..."}'
clawd.invoke --tool message --action send --args-json '{"provider":"telegram","to":"...","message":"..."}'
```

Use these when you want a system-level executable. Use the registry commands of the same names inside Lobster pipelines and `pipeline:` workflow steps.

## Practical examples

### Run a direct pipeline

```bash
lobster 'gog.gmail.search --query "newer_than:1d" --max 10 | email.triage'
```

### Run a workflow file in tool mode

```bash
lobster run --mode tool --file path/to/workflow.lobster --args-json '{"task":"daily triage"}'
```

### Resume after approval

```bash
lobster resume --token <token> --approve yes
```

## Source of truth

- `src/cli.ts`
- `src/resume.ts`
- `bin/lobster.js`
- `bin/openclaw.invoke.js`
- `bin/clawd.invoke.js`
- `package.json`
