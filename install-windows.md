# Install on Windows (Non‑Technical, Step‑by‑Step)

Proworkbench (PB) runs locally in your browser. For **v1 preview**, PB uses **Text Generation WebUI** as the local model server (OpenAI‑compatible API).

✅ **Recommended browser:** **Google Chrome / Chromium** (preferred)

---

## What you will install

1. **Google Chrome** (recommended)
2. **Node.js (LTS)** (required to run PB)
3. **Git** (recommended) **or** download the PB ZIP from GitHub
4. **Text Generation WebUI** (your local model server)
5. (Optional) A local model file (PB recommends a known‑good default below)

---

## Step 1 — Install Google Chrome

If you already have Chrome, skip this.

- Install Chrome and open it once.

---

## Step 2 — Install Node.js (LTS)

1. Download Node.js **LTS** from the official Node website.
2. Install it with default options.
3. Restart your PC (recommended).

### Check Node is installed

1. Open the **Start Menu**
2. Type **PowerShell**
3. Open **Windows PowerShell**
4. Paste:

```powershell
node -v
npm -v
```

You should see two version numbers.

---

## Step 3 — Download Proworkbench

### Option A (easiest): Download ZIP

1. Open the PB GitHub repo in Chrome
2. Click **Code → Download ZIP**
3. Unzip it somewhere simple like:

- `C:\PB\proworkbench`

### Option B (recommended): Clone with Git

#### Install Git

Install “Git for Windows” (default options are fine).

#### Clone PB

Open **PowerShell** and paste:

```powershell
mkdir C:\PB -Force
cd C:\PB
git clone https://github.com/jamiegrl100/proworkbench.git
cd proworkbench
```

---

## Step 4 — Start PB (the app)

1. In **PowerShell**, go into the PB folder:

```powershell
cd C:\PB\proworkbench
```

2. Install dependencies:

```powershell
npm install
```

3. Start PB:

```powershell
npm run dev
```

✅ Leave this PowerShell window open while PB is running.

PB should print a local URL (usually `http://localhost:5173`).  
Open it in **Chrome**.

> PB pins Vite to **5173** to avoid browser issues and port hopping.

---

## Step 5 — Install + Start Text Generation WebUI (model server)

PB **does not** auto-start WebUI (by design). You start WebUI manually when you need it.

### A) Install Text Generation WebUI

Follow Text Generation WebUI’s official install steps for Windows.

### B) Start WebUI

1. Start WebUI
2. Open WebUI in your browser
3. **Load a model** (important — WebUI may not respond until a model is loaded)

PB expects WebUI here by default:

- `http://127.0.0.1:5000`

---

## Step 6 — Connect PB to WebUI

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

Do this in order:

1. Confirm WebUI is running
2. Open WebUI in the browser
3. Confirm a model is loaded
4. Refresh PB WebChat and try again

---

## Troubleshooting quick hits

### Chat “Send does nothing”
- Use **Chrome**
- Hard refresh: **Ctrl + Shift + R**

### PB stops
You probably closed the PowerShell window that was running `npm run dev`.  
Re-run:

```powershell
cd C:\PB\proworkbench
npm run dev
```
