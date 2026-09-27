# Changelog

All notable changes to this extension are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the package version is the version inside
`hermes-review-extension/manifest.json`.

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
