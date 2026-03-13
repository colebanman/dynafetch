import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import readline from "node:readline";

export type DynafetchNetRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  headerOrder?: string[];
  body: string;
  proxy?: string;
};

export type DynafetchNetResponse = {
  status: number;
  body: string;
  headers: Record<string, string>;
  finalUrl?: string;
  error?: string;
  retried?: boolean;
};

type RpcEnvelope = {
  id: string;
  result?: unknown;
  error?: {
    code?: string;
    message?: string;
  };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type WorkerSessionOptions = {
  browserProfile?: string;
  timeoutSeconds?: number;
  proxy?: string;
};

type WorkerTransportState = {
  child: ChildProcessWithoutNullStreams;
  pending: Map<string, PendingRequest>;
};

const sessionStore = new AsyncLocalStorage<{ sessionId: string }>();

let transportPromise: Promise<WorkerTransportState> | null = null;

function findPrecompiledBinary(): string | null {
  const platform = process.platform;   // "darwin", "linux", "win32"
  const arch = process.arch === "x64" ? "x64" : "arm64";
  const ext = platform === "win32" ? ".exe" : "";
  const name = `dynafetch-net-${platform}-${arch}${ext}`;

  // Look relative to this file (works whether running from source or installed)
  const candidates = [
    path.resolve(__dirname, "../../../dynafetch-net/bin", name),
    path.resolve(__dirname, "../../../../packages/dynafetch-net/bin", name),
    path.resolve(process.cwd(), "packages/dynafetch-net/bin", name),
  ];

  for (const candidate of candidates) {
    try {
      const fs = require("fs") as typeof import("fs");
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function createWorkerCommand():
  | { command: string; args: string[]; cwd?: string }
  | { command: string; args: string[]; cwd: string } {
  const explicitBin = process.env.DYNAFETCH_NET_BIN?.trim();
  if (explicitBin) {
    return { command: explicitBin, args: [] };
  }

  const precompiled = findPrecompiledBinary();
  if (precompiled) {
    return { command: precompiled, args: [] };
  }

  // Fallback: try `go run` for development
  return {
    command: "go",
    args: ["run", "."],
    cwd: path.resolve(process.cwd(), "packages/dynafetch-net"),
  };
}

function createWorkerTransport(): Promise<WorkerTransportState> {
  const { command, args, cwd } = createWorkerCommand();
  const child = spawn(command, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  const pending = new Map<string, PendingRequest>();
  const rl = readline.createInterface({ input: child.stdout });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let payload: RpcEnvelope;
    try {
      payload = JSON.parse(trimmed) as RpcEnvelope;
    } catch (error) {
      for (const entry of pending.values()) {
        entry.reject(new Error(`Invalid dynafetch-net response: ${String(error)}`));
      }
      pending.clear();
      return;
    }

    const request = pending.get(payload.id);
    if (!request) return;
    pending.delete(payload.id);

    if (payload.error) {
      request.reject(new Error(payload.error.message || payload.error.code || "dynafetch-net request failed"));
      return;
    }

    request.resolve(payload.result);
  });

  child.stderr.on("data", (chunk) => {
    const message = chunk.toString().trim();
    if (message) {
      console.warn(`[dynafetch-net] ${message}`);
    }
  });

  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    const reason = `dynafetch-net exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
    for (const entry of pending.values()) {
      entry.reject(new Error(reason));
    }
    pending.clear();
    transportPromise = null;
  };

  child.once("error", (error) => {
    for (const entry of pending.values()) {
      entry.reject(error);
    }
    pending.clear();
    transportPromise = null;
  });
  child.once("exit", onExit);

  return Promise.resolve({ child, pending });
}

async function getWorkerTransport(): Promise<WorkerTransportState> {
  if (!transportPromise) {
    transportPromise = createWorkerTransport();
  }
  return transportPromise;
}

async function callWorker<T>(method: string, params: unknown): Promise<T> {
  const transport = await getWorkerTransport();
  const id = randomUUID();
  const payload = JSON.stringify({ id, method, params });

  return await new Promise<T>((resolve, reject) => {
    transport.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    transport.child.stdin.write(`${payload}\n`, (error) => {
      if (!error) return;
      transport.pending.delete(id);
      reject(error);
    });
  });
}

export async function withDynafetchSession<T>(
  options: WorkerSessionOptions,
  run: () => Promise<T>,
): Promise<T> {
  const session = await callWorker<{ sessionId: string }>("openSession", options);

  try {
    return await sessionStore.run({ sessionId: session.sessionId }, run);
  } finally {
    await callWorker("closeSession", { sessionId: session.sessionId }).catch(() => {});
  }
}

export async function dynafetchNetHealth(): Promise<{ ok: boolean; service: string }> {
  return await callWorker("health", {});
}

export async function dynafetchNetFetch(
  request: DynafetchNetRequest,
  options: WorkerSessionOptions & {
    followRedirect?: boolean;
    maxRedirects?: number;
  } = {},
): Promise<DynafetchNetResponse> {
  const session = sessionStore.getStore();

  return await callWorker<DynafetchNetResponse>("fetch", {
    sessionId: session?.sessionId,
    request,
    followRedirect: options.followRedirect,
    maxRedirects: options.maxRedirects,
    browserProfile: options.browserProfile,
    timeoutSeconds: options.timeoutSeconds,
    proxy: options.proxy,
  });
}

export async function dynafetchNetBatchFetch(
  requests: DynafetchNetRequest[],
  options: WorkerSessionOptions & {
    followRedirect?: boolean;
    maxRedirects?: number;
  } = {},
): Promise<DynafetchNetResponse[]> {
  const session = sessionStore.getStore();

  return await callWorker<DynafetchNetResponse[]>("batchFetch", {
    sessionId: session?.sessionId,
    requests,
    followRedirect: options.followRedirect,
    maxRedirects: options.maxRedirects,
    browserProfile: options.browserProfile,
    timeoutSeconds: options.timeoutSeconds,
    proxy: options.proxy,
  });
}
