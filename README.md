# WandPlus

**WandPlus is an open standard for building Wands — stateful, staged objects an AI agent crafts on disk.**

A **Wand** is the missing primitive between a tool and an instruction. Instead of *asking* a
model to produce something and hoping it follows the steps, you hand it an object that already
knows how it's supposed to be built: a directory with a workflow, per-stage rules about what can
be written, and gates that decide when each stage is done.

```
CreateWand(kind: "changelog", name: "v1.2.0 release")
  → WandWrite("entries/auth.md", ...)   # collect stage
  → CheckPhase()                         # gate passes → advances
  → WandWrite("CHANGELOG.md", ...)       # publish stage
  → CheckPhase({ version: "1.2.0" })     # gate passes → done
  → SaveAndCloseWand()
```

## Why Wands

Wands sit alongside two primitives you may already know:

| | MCP server | Skill | **Wand** |
|---|---|---|---|
| What it is | A set of callable tools | A reusable instruction fragment | A **stateful object** crafted on disk |
| State | Stateless | Stateless | Persistent (`.wand.json` + files) |
| Has a workflow | No | No | Yes — phases with gates |
| Constrains writes/tools | No | No | Yes — per phase |
| Authored as | Code | `SKILL.md` prose | `wand.json` + prompts + gates |

If your feature is "let the agent *call* something," that's an MCP tool. If it's "teach the
agent *how* to do something," that's a Skill. If it's "have the agent *build and refine an
object* through stages, with rules about what's valid at each stage," that's a **Wand**.

## How it works

1. A **Wand App** bundles one or more **Wands** and is loaded by a Wand-compatible runtime.
2. Each **Wand** declares a directory contract and a **phase** workflow in `wand.json`.
3. Each **phase** injects its own instructions, exposes its own tools, and fences what can be
   written — and advances only when its **gate check** passes.
4. The runtime drives the agent through the phases, enforces the rules, and persists state so a
   Wand can be closed, reopened, copied, or rewound.

Authoring a Wand is **declarative** — no host code. You write a manifest, a few markdown prompts,
and small gate scripts.

## Get started

- **[Quickstart](./docs/quickstart.md)** — build your first Wand (a `changelog`) in ~15 minutes.
- **[Authoring guide](./docs/authoring-guide.md)** — the full manifest reference, phase and gate
  design, tool exposure, and a pre-ship checklist.
- **[`examples/changelog`](./examples/changelog)** — a complete, runnable reference Wand.
- **[`schema/wand.schema.json`](./schema/wand.schema.json)** — the canonical manifest schema.

## Positioning

WandPlus is an **open, runtime-agnostic standard**: any agent runtime can implement the Wand
contract. [MCPlato](https://mcplato.com) is the first reference runtime.

> **Note on the schema URL:** the manifest references `https://wandplus.dev/schema/v1/wand.schema.json`
> as its canonical `$id`. Until that domain is serving the file, validate against the local
> [`schema/wand.schema.json`](./schema/wand.schema.json) in this repo.

## Status

Early. The format is stabilizing around `version: "1.0"`. The spec, a concepts guide, and SDK
tooling are planned — see the docs for what exists today.

## License

[Apache License 2.0](./LICENSE).
