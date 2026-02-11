# First Run (After Install)

This is the “it works” checklist.

---

## 1) Start Text WebUI

1. Start **Text Generation WebUI**
2. Open WebUI in your browser
3. **Load a model** (WebUI may not respond until a model is loaded)

PB expects WebUI here:

- `http://127.0.0.1:5000`

---

## 2) Start Proworkbench (PB)

In the PB folder:

```bash
npm run dev
```

Open PB in Chrome:

- `http://localhost:5173`

---

## 3) Connect provider + model

PB → **Runtime → Provider**

- Provider: **Text WebUI**
- Base URL: `http://127.0.0.1:5000`
- Select model:
  - `models/quen/qwen2.5-coder-7b-instruct-q6_k.gguf`

---

## 4) First chat

Go to **WebChat** and type:

- “Tell me a joke.”

---

## 5) If something doesn’t respond

1. Open WebUI tab
2. Confirm model is loaded
3. Refresh PB WebChat and try again
