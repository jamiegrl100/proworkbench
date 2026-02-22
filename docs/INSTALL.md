# Install

## Requirements

- Node.js 20+
- npm 10+
- A local OpenAI-compatible model backend (example: Text Generation WebUI)

## Linux

```bash
cd /home/jamiegrl100/Apps/proworkbench
npm install
npm run dev
```

## macOS

```bash
cd /path/to/proworkbench
npm install
npm run dev
```

## Windows (PowerShell)

```powershell
cd C:\path\to\proworkbench
npm install
npm run dev
```

## Connect WebUI

Configure WebUI endpoint to `http://127.0.0.1:5000` and verify:

- `GET /v1/models`
- `POST /v1/chat/completions`

## Notes

- ProWorkBench does not bundle model weights.
- Keep model runtime external and explicitly managed.
- TODO: installer binaries section after packaging pipeline is finalized.
