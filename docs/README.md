# Lobster Documentation

Lobster exposes three different user-facing surfaces. This documentation keeps them separate so you can find the right reference quickly.

## Start here

- **I want to write a workflow file** → [`lobster-file-syntax.md`](./lobster-file-syntax.md)
- **I want to know how to invoke the CLI** → [`cli-reference.md`](./cli-reference.md)
- **I want to look up available pipeline commands** → [`command-reference.md`](./command-reference.md)
- **I want to integrate through MCP** → [`mcp-server.md`](./mcp-server.md)

## The three surfaces

| Surface | What it covers | Primary file |
| --- | --- | --- |
| Top-level CLI | `lobster`, `run`, `resume`, `help`, `doctor`, `version`, tool mode | [`cli-reference.md`](./cli-reference.md) |
| Registry-backed commands | Commands you use inside Lobster pipelines and `pipeline:` workflow steps | [`command-reference.md`](./command-reference.md) |
| MCP server | Local JSON-RPC / stdio tool surface for external agents | [`mcp-server.md`](./mcp-server.md) |
| Installed shim executables | Package-installed entrypoints such as `openclaw.invoke` and `clawd.invoke` | [`cli-reference.md`](./cli-reference.md) and [`command-reference.md`](./command-reference.md) |

## Recommended reading path for OpenClaw users

1. Read [`lobster-file-syntax.md`](./lobster-file-syntax.md) to learn the workflow-file shape.
2. Open [`command-reference.md`](./command-reference.md) to choose the commands your workflow needs.
3. Use [`cli-reference.md`](./cli-reference.md) when you are ready to run a pipeline or resume an approval-gated workflow.
4. Use [`mcp-server.md`](./mcp-server.md) when an external agent needs the generate/test MCP contract.

## Minimal workflow example

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

See [`lobster-file-syntax.md`](./lobster-file-syntax.md) for what each field means and which forms are actually supported.

## Source-of-truth policy

These docs describe **implemented behavior only**. The source files that matter most are:

- `src/cli.ts`
- `src/commands/registry.ts`
- `src/parser.ts`
- `src/workflows/file.ts`
- relevant tests under `test/`

When documentation and memory disagree, trust the source.
