# Structured output capture (child extension)

Child `pi` processes spawned by pi-review load `src/structured-output-capture.ts` via:

```text
pi --no-session --no-extensions --no-skills -e <path/to/structured-output-capture.ts> ...
```

## Environment variables

| Variable | Purpose |
|----------|---------|
| `PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA` | Path to JSON Schema file (written by parent; informs model via system prompt) |
| `PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE` | Path where child must write final JSON payload |

## Tool contract

The capture extension registers a single tool: `structured_output`.

- Parameters: open object (`additionalProperties: true`) — parent validates with TypeBox after spawn.
- `execute`: writes `JSON.stringify(params)` to capture path; returns `terminate: true`.
- Parent passes `--tools structured_output` (reviewers also include read/grep/… as configured).

## Parent validation

`src/spawn.ts` reads the capture file and validates against `ReviewerOutputSchema` or `GateOutputSchema`.
