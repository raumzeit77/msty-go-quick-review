# Quick Review

A native **Msty Go** extension: `/review [optional focus]` runs an independent critique of the recent
conversation on a separately assignable reviewer model and shows it in a persistent **Quick Review**
pane — never inserted into the chat, never triggering another assistant run.

> Package identity: extension id `com.raumzeit77.hermes-review`, host-visible name **Quick Review**.
> The extension `name`, the title-bar item's `title`/`label`, the pane title and the `/review`
> command row all read `Quick Review` — the host renders an item title with the extension name
> beneath it whenever the two differ, so keeping them identical keeps the menu entry one line.

## What it does

- Registers the slash command `/review [optional focus or instructions]`.
- Reads the latest 10 visible messages of the active chat as the review context.
- Runs an **isolated reviewer inference** (`models.infer`) on the assigned **Review model**,
  falling back to the main model when none is assigned.
- Requests a structured critique with severity, location, problem and correction per issue.
- Opens the **Quick Review pane** (a popup surface outside the chat transcript) with a visible
  running state, and lists every completed review for that chat, newest first.
- Keeps reviews per chat: leaving and returning to a chat restores its review list.
- Lets you expand a review, **edit** its text, **send it to the composer** for inspection, or
  **delete** it — without ever adding a message to the chat.
- Adds a title-bar launcher (`mod+shift+r`) and a workspace item that open the same pane.
- Provides a second command, `/hermes-review-diagnose`, which reports what the host currently
  supports (API compatibility, permission state, usable surfaces, storage quotas, model assignment).
- Makes **no network requests**.

## Install

1. Download the ZIP from the [latest release](../../releases/latest).
2. In Msty Go: **Extensions → Install from ZIP**, pick the ZIP, and review the requested access.

The package is not signed, so the host shows it as an unsigned/community install. Review the
permissions below before allowing access; every one of them is required for `/review` to work.

## Use

1. Open a chat with messages to review.
2. Run `/review` or `/review focus on citations` — the pane opens and shows progress.
3. Or open the pane any time from the title-bar **Quick Review** launcher (`mod+shift+r`) or the
   workspace item, then press **Review** there.
4. Expand a row to read its findings; **Edit** rewrites the review text, **Send to composer**
   places a revision request plus the findings in the composer without submitting it.
5. **Delete** removes one review; the pane header clears all reviews for that chat. Both ask for
   confirmation first.

## Permissions

| Permission | Why it is needed |
|---|---|
| `commands.provide` | Adds the native `/review` slash command. |
| `context.read` | Identifies the active chat to review. |
| `messages.read` | Reads the latest 10 messages as review context. |
| `composer.read` | Detects and clears the executed `/review` command from the composer. |
| `composer.write` | Places a user-approved revision prompt in the composer without sending it. |
| `models.infer` | Runs the isolated reviewer inference. |
| `storage.chat` | Stores completed reviews in the chat they were produced in, so the chat's review history persists across chat switching. |
| `notifications.show` | Shows concise progress and error notifications. |
| `ui.popup` | Opens the review pane that lists, sends and deletes the chat's reviews without adding chat messages. |
| `ui.titleBar` | Keeps the always-visible Review launcher in the title bar. |
| `ui.workspace` | Optionally adds a workspace launcher for the same pane; `/review` still works when unavailable. |
| `events.subscribe` | Re-scopes the open pane to the chat that is now open when you switch chats. |

## Privacy and behaviour

- The extension sends the **latest 10 visible messages** of the active chat to the selected review
  model. That is the only data it passes on, and the host controls the provider call.
- Reviews are stored **per chat**, under a key scoped to that chat. The stored document is the
  normalised review (title, timestamp, message count, summary, structured issues) — never the raw
  transcript, and never credentials.
- The pane shows only the currently open chat's reviews; entries belonging to another chat are
  filtered from view and cannot be deleted accidentally.
- Nothing is written into the chat transcript, no assistant run is started, and composer content is
  never sent automatically.

## Reviewer scope

The reviewer uses isolated inference: it can critique the transcript you hand it, but it cannot
browse, search the web, call tools or MCP servers, or verify sources online. Treat its output as a
critique of the supplied text, not as independently verified fact.

## Verification

Every push runs the repository's own gates in CI (`.github/workflows/gates.yml`): a syntax check on
every runtime file, the contract suites in `tests/`, a packaging check that resolves every ZIP
member to the source file it claims to come from, and a pre-flight that mirrors the host's manifest
and permission validation. Run them locally the same way:

```sh
for f in hermes-review-extension/*.js; do node --check "$f" || exit 1; done
for t in tests/*-contract.mjs; do node "$t" || exit 1; done
python3 scripts/package-extension.py verify releases/<zip>
python3 scripts/perm-preflight.py hermes-review-extension releases/<zip>
```

No dependencies are required beyond Node 22 and Python 3.

## Repository layout

```
hermes-review-extension/   the extension itself (manifest.json, entry, view, stylesheet, icon)
tests/                     contract suites + the offline render harness
scripts/                   packaging (member → source map) and host pre-flight
releases/                  packaged, checksummed ZIPs
```

## License

MIT — see [LICENSE](LICENSE).
