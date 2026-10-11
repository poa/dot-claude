# Claude Code: where custom info can be shown (places-demo)

The `places-demo` mod (written for Claude Code 2.1.289) labels every place in
the Claude Code terminal UI where a plugin or the status line script can show
custom info. Each place gets a label with its own name: colored where the place
accepts a drawn tree, plain text where it only takes a string.

Mod code: `places-demo.code` (next to this file).

## Places that take colors

These take a drawn tree (`Box`/`Text` elements, `<Text color="...">`), so the
demo puts a colored `[Name]` tag beside Claude Code's normal content.

| Tag | Where it is |
|---|---|
| `[statusLine]` (white on magenta) | your status line script (`statusLine` in `~/.claude/settings.json`); the only place outside the mod API; ANSI colors |
| `[AbovePrompt]` cyan | a band directly above the input box |
| `[SessionMode]` green | the footer row under the input box, right side |
| `[PromptHint]` yellow | the hint line under the input box (`? for shortcuts`) |
| `[Spinner]` blue | the "working…" line while Claude is running |
| `[TurnDuration]` red | the "Baked for 3s" line at the end of each turn |
| `[UserMessage]`, `[AssistantMessage]`, `[ToolUse]`, `[ToolResult]`, `[ToolGroup]`, `[ToolProgress]`, `[CommandOutput]` | each kind of row in the transcript, each in its own color |
| `[AskUserQuestion]` | the question dialog, only when Claude asks you something |
| `[InfoNotice]` orange | the dim notices under the logo, only after a restart or `/clear` |
| `[Pane]` magenta | run `/places-pane`; this pane also lists every place |

## Places that take plain text only, no colors

These take a string; control characters (so ANSI color codes) are refused.

- `[ui.status]`: a pinned plugin line under the input box (`$.ui.status(text)`).
- `[ui.toast]`: a popup; the demo shows it for 8 seconds after each turn (`$.ui.toast(text)`).
- `[ui.log]`: a dim line added to the transcript once when the mod loads (`$.ui.log(text)`).
- `[ui.notice]`: a line inside a permission dialog, only when one opens (`$.ui.notice(tool_use_id, text)`).
- `SessionMode.modes (dim string)`: the plain-text way to fill the footer's right side; labels are joined with ` & `.
- `PromptHint.tail (dim string)`: dim text added at the end of the hint line.

## Not customizable

- The input box borders, including the session name on the top border.

## Notes

- A pane opened without a user action (e.g. from `session.start`) only appears
  when the terminal is at least 144 columns wide; one opened by a command (like
  `/places-pane`) appears at any width.
- If a place refuses a drawn tree, a dim line in the transcript names it, and
  Claude Code draws its normal content there instead.
- A tree hook keeps Claude Code's own content by wrapping what `next(e)`
  returns: `<Box><Text color="green">[Tag] </Text>{await next(e)}</Box>`.

## Install / remove

The mod is three files in a folder (see `places-demo.code`):

```
places-demo/
  .claude-plugin/plugin.json
  hooks/hooks.json
  hooks/register.tsx
  hooks/register.test.ts   (optional, for `claude plugin test`)
```

- Load it: `claude --plugin-dir /path/to/places-demo`, or put it under a
  session's hot-reload dev-mods folder.
- Check it: `claude plugin validate <folder>` and `claude plugin test <folder>`.
- Remove it: delete the folder. The status line `[statusLine]` tag is shown only
  while a `~/.claude/dev-mods/*/places-demo` folder exists, so it disappears too.
