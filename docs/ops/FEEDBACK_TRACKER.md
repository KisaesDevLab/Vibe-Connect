# Phase 18 — Feedback tracker

Kept in-repo so it survives team turnover. One issue per section.

## Template

```
### [YYYY-MM-DD] <short title>
- Reporter: <name>
- Frequency: <hit 1× | daily | per-user>
- Impact: <showstopper | paper-cut | nice-to-have>
- What happened: <narrative>
- Expected: <what they wanted>
- Workaround (if any):
- Disposition: <triaged | in-progress | shipped | dropped>
- Links: <git commit(s), PR>
```

## Prioritization

Score = `frequency × impact`:

- frequency: daily = 3, per-user = 2, once = 1
- impact: showstopper = 3, paper-cut = 2, nice-to-have = 1

Top-scored items go into the next iteration sprint. Anything scoring < 2 stays in the
tracker but doesn't block anything.

## Reserved items from the build plan (likely adds)

- [ ] Archive a conversation
- [ ] Star / pin a conversation
- [ ] Print-to-PDF a conversation
- [ ] Dark theme (gated on demand from 2+ users)
- [ ] Per-user notification sounds (gated on demand)

## Do NOT start client features (Phase 19+) until

- ≥ 4 consecutive weeks of stable internal use with zero critical incidents.
- All showstoppers closed.
- Paper-cut backlog < 10 items.
