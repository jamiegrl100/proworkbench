# Live Activity Stream

WebChat now exposes a session-scoped SSE stream at `/api/chat/:sessionId/events`.

## How to test

1. Open WebChat.
2. Send a tool-using request such as `Create folder jobs/demo-live and write jobs/demo-live/x.txt = ok`.
3. Confirm the active assistant message shows the **Live Activity** panel immediately.
4. For a long command, run Alex in L2+ and send `/run pwd && ls -la && npm --version`.
5. Confirm stdout/stderr chunks appear while the command is still running.

## Event types

- `status`: narration such as request start or tool call start
- `tool.start`: tool invocation began
- `tool.end`: tool finished, including `ok`, `exit_code`, and artifact preview when available
- `proc.stdout`: streamed stdout chunk from `tools.proc.exec`
- `proc.stderr`: streamed stderr chunk from `tools.proc.exec`
- `error`: structured failure event

## Adding a new event type

1. Publish it with `publishLiveEvent(sessionId, event)` from `server/src/liveEvents/bus.js`.
2. Use the same WebChat session id that `/admin/webchat/send` uses.
3. Render it in `ui/src/components/LiveActivityPanel.tsx` if it needs custom formatting.
