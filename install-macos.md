# Install on macOS (Non‑Technical, Step‑by‑Step)

Proworkbench (PB) runs locally in your browser. For **v1 preview**, PB uses **Text Generation WebUI** as the local model server (OpenAI‑compatible API).

✅ **Recommended browser:** **Google Chrome / Chromium** (preferred)

---

## What you will install

1. **Google Chrome** (recommended)
2. **Homebrew** (to install tools easily)
3. **Node.js (LTS)** (required to run PB)
4. **Git** (usually present; we’ll verify)
5. **Text Generation WebUI** (your local model server)

---

## Step 1 — Install Google Chrome

If you already have Chrome, skip this.

- Install Chrome and open it once.

---

## Step 2 — Install Homebrew

1. Open **Terminal** (Applications → Utilities → Terminal)
2. Install Homebrew using the official command from Homebrew’s site
3. Close Terminal and reopen it

---

## Step 3 — Install Node.js (LTS)

In Terminal:

```bash
brew install node
node -v
npm -v
```

You should see version numbers.

---

## Step 4 — Download Proworkbench

### Option A: Download ZIP

1. Open the PB GitHub repo in Chrome
2. Click **Code → Download ZIP**
3. Unzip it somewhere simple like:

- `~/PB/proworkbench`

### Option B (recommended): Clone with Git

Check Git exists:

```bash
git --version
```

If missing:

```bash
brew install git
```

Clone:

```bash
mkdir -p ~/PB
cd ~/PB
git clone https://github.com/jamiegrl100/proworkbench.git
cd proworkbench
```

---

## Step 5 — Start PB

In Terminal:

```bash
cd ~/PB/proworkbench
npm install
npm run dev
```

✅ Leave this Terminal window open while PB is running.

PB should print a local URL (usually `http://localhost:5173`).  
Open it in **Chrome**.

---

## Step 6 — Install + Start Text Generation WebUI (model server)

PB **does not** auto-start WebUI (by design). You start WebUI manually when you need it.

1. Install Text Generation WebUI using their official macOS steps.
2. Start WebUI
3. Open WebUI in the browser
4. **Load a model** (important)

PB expects WebUI here by default:

- `http://127.0.0.1:5000`

---

## Step 7 — Connect PB to WebUI

In PB:

1. Go to **Runtime → Provider**
2. Provider: **Text WebUI**
3. Base URL: `http://127.0.0.1:5000`
4. Select model:

**Known‑good non‑tech default model:**
- `models/quen/qwen2.5-coder-7b-instruct-q6_k.gguf`

5. Go to **WebChat** and send a message.

---

## If PB says “WebUI not responding”

1. Confirm WebUI is running
2. Open WebUI in the browser
3. Confirm a model is loaded
4. Refresh PB WebChat and try again
