# The review pane — design reference

This is the design the pane is built to and held to by its test suite. It describes what the pane
draws in each state and how it takes its colours from the host.

## Surfaces

| surface | contribution | what it is |
|---|---|---|
| review pane | `popups[0]` — `hermes-review-pane`, `size: medium`, entry `view.js` | the pane itself: a popup outside the chat transcript |
| launcher | `titleBarItems[0]` — always visible, `mod+shift+r`, opens/toggles the pane | the way in from any chat |
| workspace item | `workspaceItems[0]` — optional, opens the same pane | a second way in where the host offers it |
| command | `/review [focus]` | runs a review and opens the pane |
| diagnostic | `/hermes-review-diagnose` | read-only report of what the host supports right now |

The launcher's `title` is byte-identical to the manifest `name` (`Quick Review`): the host draws an
item's title with the extension name beneath it whenever the two differ, so matching them keeps the
menu entry one line.

## States

1. **Empty** — a heading, one sentence, and the single primary action. No starter chips: they read as
   content, get clicked once, and are wrong more often than they help.
2. **Running** — the same frame with a spinning mark inside the running panel, the focus line the run
   was started with, and a disabled action. The mark stops under `prefers-reduced-motion: reduce` but
   stays visible: it still has to say *something is happening*.
3. **Populated** — one card per review, newest first. Each row shows a title, the timestamp and an
   `edited` marker when the text was changed; expanding a row reveals the summary and one card per
   issue with a severity chip and labelled `Location:` / `Problem:` / `Correction:` lines. The header
   carries the review's own count and severity. Rows are siblings with real spacing — never one row
   nested inside another — and an expanded row sizes its meta line to its **content**, so a short
   title keeps its timestamp beside it instead of leaving an empty band.
4. **Editing** — the revision framing sentence as static text above a `textarea` seeded with the
   review body, with **Cancel** (ghost) and **Save** (primary) in that item's own action row. Saving
   stores your text verbatim and marks the row `edited`; the review's original count and severity are
   never rewritten, and the severities drawn afterwards come from the text you wrote — it is what gets
   sent.
5. **Completed** — a completion callout with an explicit, labelled dismiss control. Dismissing it
   survives a repaint; a new run's completion shows again.
6. **Failed** — one plain sentence, then the underlying reason. The machine token is there for grep,
   not for the reader.

Exactly **one primary action** is visible per state.

## Colours

- The pane declares `color-scheme: light dark` and styles itself **entirely** from the host's own CSS
  variables, aliased once into a `--rv-*` namespace at the top of `view.css`.
- Every colour alias is a chain whose last link is a concrete value, so a host that sends nothing
  still leaves every control legible. A chain ending in another bare `var()` is not a fallback: it
  resolves to an invalid value and the whole declaration is dropped, which is how a filled button
  ships with no fill.
- The primary action uses the host's filled-control pair (`--primary` with `--primary-foreground`)
  and derives its hover, border and focus states with `color-mix(in oklab, …)`. No component rule
  contains an authored literal colour.
- The sheet opens with a bare-element reset (`*`, `html, body`, headings, `button`, `input`,
  `textarea`), because the host's base styles own those elements inside the frame otherwise.
- Chips, badges and timestamps carry `overflow: hidden` + `text-overflow: ellipsis` +
  `white-space: nowrap`, so a narrow frame clips nothing silently.
- The editable field carries its own `scrollbar-color` / `::-webkit-scrollbar` treatment, measured
  against its own track.

## The stylesheet route

A custom entry receives a stylesheet only because **the entry imports it**: `import "./view.css";` is
the first import in `view.js`. There is no manifest field for CSS, and a co-located `view.css` is not
applied by itself — a frame that skips the import renders under the host's base styles while every
colour still resolves.

## What the harness cannot see

The offline harness mounts the real entry with a fake DOM and computes **styles, not layout**. A pure
geometry change — a flex rule, a reserved band, a wrap — cannot be proven through it; those rules are
pinned by mutation-checked assertions, and the rendered result is confirmed by installing the package
and looking at it.
