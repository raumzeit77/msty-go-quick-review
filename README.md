# Quick Review

Quick Review is a community extension for **Msty Go**. It gives the latest part of a conversation a
second opinion and shows the result in a separate pane. The review is never added to the chat and
does not trigger another assistant response.

It is inspired by [Hermes Agent's `/review` feature](https://hermes-agent.nousresearch.com/docs/reference/slash-commands),
adapted to work as a focused Msty Go extension.

## What it does

- Run `/review` to review the latest 10 visible messages.
- Add a focus when needed, for example `/review focus on citations`.
- Use a separate Review model, or fall back to the chat's main model.
- Keep a review history for each chat.
- Edit a review, copy it into the composer for revision, or delete it.
- Open the review pane from the title bar with `mod+shift+r`.

Quick Review makes no network requests of its own. Model calls are handled by Msty Go.

## Install

1. Download the ZIP from the [latest release](../../releases/latest).
2. In Msty Go, open **Extensions → Install from ZIP** and select the file.
3. Review and approve the requested access.

This is currently an unsigned community extension, so Msty Go will show it as unverified.

## Use

Open a chat and run `/review`. The pane opens immediately and shows the result when it is ready. You
can also open the pane from the **Quick Review** title-bar button and start a review there.

**Send to composer** prepares a revision request without sending it. You remain in control of what
goes into the conversation.

## Access and privacy

Quick Review reads the active chat and sends its latest 10 visible messages to the selected review
model through Msty Go. It stores the resulting review with that chat, but does not store the raw
conversation. It never sends composer text automatically.

The extension asks only for the access needed to provide its command, read the recent conversation,
run the reviewer, store per-chat history, update the composer when requested, and show the review
pane. Msty Go displays the full permission list before installation.

## Current limitations

- Only the latest 10 visible messages are reviewed.
- The reviewer cannot browse the web, call tools or MCP servers, or verify sources online.
- The result is a model-generated critique, not an independent fact check.

## Development

The source, release ZIP, tests and packaging checks are included in this repository. GitHub Actions
runs the automated checks on every push.

## License

[MIT](LICENSE)
