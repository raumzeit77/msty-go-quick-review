# Hermes Review

A native Msty Go `/review` extension inspired by Hermes Agent's independent review command.

## What it does

- Registers `/review [optional focus]`.
- Clears the executed `/review` command from the composer.
- Immediately opens the persistent **Quick Review pane** (a popup surface outside the chat transcript) with a visible running state. The host-visible name is **Quick Review**; the project keeps the name *Hermes Review*.
- Reads the latest 10 visible messages from the active chat.
- Uses the assigned **Review model**, falling back to the main model.
- Requests a structured critique with severity, location, problem, and correction fields.
- Keeps every completed review in the pane's list for the current chat (newest first, auto-titled), stored as per-chat history that is restored when you return to that chat.
- The pane lists, expands, edits, re-sends (**Send to composer**), and deletes reviews without ever adding a chat message.
- **Edit** a stored review's text in place: it opens that item with the constant framing sentence the revision prompt always begins with drawn above the field, and the field holding the review body only. **Save** stores your text on that review verbatim — it becomes what **Send to composer** sends, after the framing sentence — and marks the row `edited`; **Cancel** changes nothing. The review's original count and severity data are never rewritten.
- A title-bar launcher (with `mod+shift+r`) and the workspace **Quick Review** item open the pane from any chat; running the command again while the pane is open toggles it closed.
- Offers **Send to composer**, which places a focused revision prompt in the main composer for inspection. It never submits automatically.
- Does not insert the review itself into chat and does not trigger another assistant response.

## Reviewer scope

The current reviewer uses isolated `models.infer(...)` inference. It can critique the supplied transcript but cannot browse, search the web, call MCP tools, use the terminal, or independently verify online sources. A separate host-managed reviewer run is tracked as a future investigation.

## Usage

1. Open a chat with messages to review.
2. Run `/review` or `/review focus on citations` — the pane opens and shows progress.
3. Or open the pane any time via the title-bar **Quick Review** launcher (`mod+shift+r`) or the workspace item, then press **Review** there.
4. Completed reviews appear in the pane's list; click a row to expand its findings, and **Edit** to rewrite the review text before sending it.
5. Select **Send to composer** to place a revision request and the review findings (your edited text, when you saved one) in the composer, then inspect and send it yourself.
6. Delete a single review from its row, or clear all reviews for the chat from the pane header (both ask for confirmation).
7. Each completed review is kept in that chat's history with an auto-generated title and timestamp; returning to the chat keeps the history available.

## Permissions

- `commands.provide`: adds `/review`.
- `context.read`: identifies the active chat.
- `messages.read`: reads recent visible messages.
- `composer.read`: detects the executed slash-command draft.
- `composer.write`: clears `/review` and optionally places the user-approved revision prompt in the composer.
- `models.infer`: runs the independent critique.
- `storage.chat`: stores completed reviews in the chat they were produced in, so each chat keeps its own review history.
- `notifications.show`: reports start, completion, and failure.
- `ui.popup`: shows the persistent review pane (list, send, delete) outside the chat transcript.
- `ui.titleBar`: keeps the always-visible Review launcher in the title bar.
- `ui.workspace`: adds the persistent Review launcher to the workspace.

## Privacy and behavior

The extension sends the latest 10 visible chat messages to the selected review model. It does not write review content into the chat, start a new assistant run, auto-send composer content, or make network requests.

Per-chat review history stores only the normalized review (title, timestamp, message count, model label, summary, structured issues) in the chat it was produced in, under a per-chat storage key (`review-history:<chatId>`) — the isolation does not depend on how the host scopes `storage.chat` reads. The raw conversation transcript is never stored, and there is no cross-chat overview: the pane shows only the currently open chat's reviews, unknown chat ids render nothing, and entries attributed to another chat are filtered from view (and a delete can never sweep them out of the other chat's storage). The title-bar badge count is session-cosmetic bootstrap state, not a per-chat count.
