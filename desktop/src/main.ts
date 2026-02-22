// desktop/src/main.ts
import { app, BrowserWindow, dialog } from "electron";
import { spawn, SpawnOptions } from "child_process";
import path from "path";
import http from "http";
import net from "net";
import fs from "fs";

function repoRoot(): string {
  // In dev, Electron app path is: <repo>/desktop
  // In prod, files are under process.resourcesPath
  return app.isPackaged ? process.resourcesPath : path.resolve(app.getAppPath(), "..");
}

async function isPortFree(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

async function pickPort(candidates: number[]): Promise<number> {
  for (const p of candidates) {
    if (await isPortFree(p)) return p;
  }
  throw new Error(`No free ports in list: ${candidates.join(", ")}`);
}

async function waitForHttpOk(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();

  async function once(): Promise<boolean> {
    return await new Promise((resolve) => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 500);
      });
      req.on("error", () => resolve(false));
      req.setTimeout(2000, () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  while (Date.now() - start < timeoutMs) {
    if (await once()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for server: ${url}`);
}

function spawnCmd(cmd: string, args: string[], opts: SpawnOptions) {
  const p = spawn(cmd, args, opts);
  p.on("error", (e) => {
    // Why: surface spawn issues immediately, otherwise it looks like the app "hangs".
    console.error(`[desktop] spawn error: ${cmd} ${args.join(" ")}:`, e);
  });
  return p;
}

function findPackagedServerEntry(root: string): string {
  // Adjust these candidates once we know your actual server build output.
  const candidates = [
    path.join(root, "server", "dist", "index.js"),
    path.join(root, "server", "dist", "main.js"),
    path.join(root, "server", "index.js"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    `Could not find packaged server entry. Tried:\n${candidates.map((x) => `- ${x}`).join("\n")}`
  );
}

async function startServer(): Promise<{ port: number; proc: ReturnType<typeof spawn> }> {
  const root = repoRoot();

  const envBase = {
    ...process.env,
    NODE_ENV: app.isPackaged ? "production" : "development",
  };

  if (app.isPackaged) {
    const port = await pickPort([8787, 8788, 8789, 8790]);
    const entry = findPackagedServerEntry(root);
    const env = {
      ...envBase,
      PROWORKBENCH_PORT: String(port),
      PORT: String(port),
      PROWORKBENCH_UI_DIST: path.join(root, "ui"),
    };
    const proc = spawnCmd(process.execPath, [entry], { env, stdio: "inherit" });
    await waitForHttpOk(`http://127.0.0.1:${port}/admin/meta`, 60_000);
    return { port, proc };
  }

  // DEV MODE: run the existing root dev script (starts server + Vite UI together).
  const proc = spawnCmd("npm", ["run", "dev"], { cwd: root, env: envBase, stdio: "inherit" });
  // Vite binds to 5173 by default (strictPort in ui/vite.config or ui/package.json)
  await waitForHttpOk(`http://127.0.0.1:5173/`, 60_000);
  return { port: 5173, proc };
}

async function createWindow(port: number) {
  const win = new BrowserWindow({ width: 1280, height: 800 });
  await win.loadURL(`http://127.0.0.1:${port}/`);
}

let serverProc: ReturnType<typeof spawn> | null = null;

app.on("before-quit", () => {
  if (serverProc && !serverProc.killed) serverProc.kill();
});

app.whenReady().then(async () => {
  try {
    const { port, proc } = await startServer();
    serverProc = proc;
    await createWindow(port);
  } catch (e) {
    const msg = String((e as any)?.message || e);
    console.error(msg);
    dialog.showErrorBox("Error launching app", msg);
    app.quit();
  }
});
