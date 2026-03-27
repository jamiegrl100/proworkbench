# WebChat Tools

## Access Defaults

- L0/L1: tools default to `OFF`
- L2/L3/L4: tools default to `ON for session`
- The value is stored in local storage per `agent + chat session`

## Commands

- `/run`: turn tools on for the current chat session and do not send `/run` to the model
- `/run <message>`: turn tools on for the current chat session, then send `<message>`
- `/tools on`: same as `/run`
- `/tools off`: turn tools off for the current chat session
- `/stop`: only affects build-loop/background work; it must not disable tools

## Storage

- Key format: `pb_webchat_tools_mode:<agent>:<session_id>`
- Current implementation lives in:
  - `ui/src/pages/webchatToolsState.js`
  - `ui/src/pages/WebChatPage.tsx`

## Activity Stream

- The live activity header should only show `reconnecting…` on actual disconnects
- While connected it shows the latest event age so the user can tell the stream is still alive
