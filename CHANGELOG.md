# Changelog

All notable changes to this extension are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the package version is the version inside
`hermes-review-extension/manifest.json`.

## [1.0.1] — 2026-10-15

Three review-reliability fixes, contributed by Ashok Gelal in
[#1](https://github.com/raumzeit77/msty-go-quick-review/pull/1).

### Fixed

- A malformed reviewer response now **fails the run visibly** (`No review came back.`) instead of
  being read as "No material issues found". A response that does not match the schema the reviewer
  is asked for — a missing or blank summary, a missing issues list, an unknown severity, or an issue
  with a blank title, location, problem or correction — can no longer produce a false clean review.
- Saving an edited review **keeps your text when the write is rejected**, so Save can be retried
  without retyping. A save that finishes after you have switched chats or started another edit never
  clears the newer text.
- An edited review that repeats a `Location:`, `Problem:` or `Correction:` label now keeps **every**
  line — the first still carries the card's labelled detail, later ones stay visible instead of
  overwriting it.

### Added

- Regression suites for all three fixes (the reviewer response contract, and new gates in the pane
  edit and edited-render contracts).

## [1.0.0] — 2026-09-27

First public release. `Quick Review` adds an independent second opinion on the conversation you are
having, without touching the conversation itself.

### Added

- `/review [optional focus or instructions]` — runs an independent critique of the latest 10 visible
  messages on a separately assignable **Review model** (falls back to the main model when unset) and
  opens the review pane immediately, with a visible running state.
- The **Quick Review pane** (popup surface, outside the chat transcript): every completed review for
  the active chat, newest first, expandable to its full findings.
- **Per-chat history** — reviews are stored with the chat they were produced in and reappear when you
  return to that chat; switching chats re-scopes the open pane.
- **Editing** — rewrite a stored review's text in place, with the revision framing kept constant and
  the original count/severity data untouched; **Send to composer** then sends your edited text.
- **Send to composer** — places a revision request plus the findings in the composer for you to
  inspect and send yourself. It never submits automatically.
- **Delete** one review, or clear the chat's reviews from the pane header, both behind a confirmation.
- Title-bar launcher with the `mod+shift+r` shortcut, a workspace launcher, and toggle behaviour when
  `/review` is run again while the pane is open.
- `/hermes-review-diagnose` — a read-only report of what the host currently supports: API
  compatibility, granted/pending/denied permissions, usable surfaces, storage quotas, the reviewer
  model assignment status, and the theme values a custom frame receives.
- A host-native look: the pane styles itself entirely from the host's own theme variables, with the
  filled primary action taken from the host's primary/label pair and no authored colour of its own.
- An offline verification harness — the pane is rendered and contrast-checked without the host, and
  packaging is checked member by member against the sources it claims to come from.
