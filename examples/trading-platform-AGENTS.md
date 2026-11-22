# AGENTS.md (template for a Rust + TypeScript trading platform)

## Layout
crates/{schema,feed,store,aggregate,indicators,backtest,execution,server}, web/{chart-engine,workspace,client}

## Hard rules
- `crates/schema` is the single source of truth for wire types; TS types are generated from it. Only the architect agent edits it.
- No allocation in hot paths (tick ingest, aggregation, render loop). No `unwrap()`/`expect()` outside tests.
- Money, price and size use integer/fixed-point types, never f32/f64. Timestamps are UTC nanoseconds (i64).
- `crates/execution` and risk code: human review required; never auto-merged.
- One agent per crate/package. Never edit another task's files.

## Definition of done
`cargo fmt --check`, `cargo clippy -D warnings`, `cargo nextest run`, `tsc --noEmit`, `vitest` all pass; `criterion` benches show no regression on aggregate/feed.
