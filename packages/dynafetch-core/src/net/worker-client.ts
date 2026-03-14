import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

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
  rpcTimeoutMs?: number;
};

type WorkerTransportState = {
  child: ChildProcessWithoutNullStreams;
  pending: Map<string, PendingRequest>;
  updateRef: () => void;
  holdCount: number;
  hold: () => void;
  release: () => void;
};

const sessionStore = new AsyncLocalStorage<{ sessionId: string }>();

let transportPromise: Promise<WorkerTransportState> | null = null;
const workerDir = path.dirname(fileURLToPath(import.meta.url));

function findPrecompiledBinary(): string | null {
  const platform = process.platform;   // "darwin", "linux", "win32"
  const arch =
    process.arch === "x64"
      ? "x64"
      : process.arch === "arm64"
        ? "arm64"
        : null;
  if (!arch) return null;
  const ext = platform === "win32" ? ".exe" : "";
  const name = `dynafetch-net-${platform}-${arch}${ext}`;

  // Look relative to this file. After bundling into dist/index.js, binaries
  // are at ../bin/. In development, they're in packages/dynafetch-net/bin/.
  const candidates = [
    path.resolve(workerDir, "../bin", name),                                    // installed: dist/../bin
    path.resolve(workerDir, "../../../dynafetch-net/bin", name),                // dev: dynafetch-core/src/net -> dynafetch-net/bin
    path.resolve(workerDir, "../../../../packages/dynafetch-net/bin", name),    // dev: alt layout
    path.resolve(process.cwd(), "packages/dynafetch-net/bin", name),           // dev: from workspace root
  ];

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
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

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
  } catch (err) {
    return Promise.reject(
      new Error(`Failed to start dynafetch-net TLS proxy: ${err instanceof Error ? err.message : String(err)}. Binary: ${command}`),
    );
  }

  const pending = new Map<string, PendingRequest>();

  // Ref/unref the child based on whether there are pending requests.
  // When pending is empty, unref so Node can exit. When requests are
  // in flight, ref so the child stays alive until they complete.
  let holdCount = 0;
  const updateRef = () => {
    if (pending.size === 0 && holdCount === 0) {
      child.unref();
      (child.stdin as any).unref?.();
      (child.stdout as any).unref?.();
      (child.stderr as any).unref?.();
    } else {
      child.ref();
      (child.stdin as any).ref?.();
      (child.stdout as any).ref?.();
      (child.stderr as any).ref?.();
    }
  };
  const hold = () => { holdCount++; updateRef(); };
  const release = () => { holdCount = Math.max(0, holdCount - 1); updateRef(); };
  // Absorb EPIPE errors on stdin during shutdown
  child.stdin.on("error", () => {});

  // Start unref'd — no requests yet
  updateRef();
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
      updateRef();
      return;
    }

    const request = pending.get(payload.id);
    if (!request) return;
    pending.delete(payload.id);
    updateRef();

    if (payload.error) {
      request.reject(new Error(payload.error.message || payload.error.code || "dynafetch-net request failed"));
      return;
    }

    request.resolve(payload.result);
  });

  child.stderr.on("data", (chunk) => {
    const message = chunk.toString().trim();
    if (message) {
      if (process.env.DYNAFETCH_DEBUG === '1') console.warn(`[dynafetch-net] ${message}`);
    }
  });

  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    // During Node shutdown, the child gets SIGKILL. Don't reject pending
    // requests in that case — they're already abandoned fire-and-forget calls.
    if (pending.size > 0 && signal !== "SIGKILL") {
      const reason = `dynafetch-net exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
      for (const entry of pending.values()) {
        entry.reject(new Error(reason));
      }
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

  // Wait for the child to actually start (or fail) before returning.
  // spawn emits "error" asynchronously if the binary isn't found.
  return new Promise<WorkerTransportState>((resolve, reject) => {
    let settled = false;
    child.once("error", (err) => {
      if (!settled) {
        settled = true;
        reject(new Error(`Failed to start dynafetch-net TLS proxy: ${err.message}. Binary: ${command}`));
      }
    });
    child.once("spawn", () => {
      if (!settled) {
        settled = true;
        resolve({ child, pending, updateRef, holdCount, hold, release });
      }
    });
  });
}

async function getWorkerTransport(): Promise<WorkerTransportState> {
  if (!transportPromise) {
    transportPromise = createWorkerTransport();
  }
  return transportPromise;
}

async function callWorker<T>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
  const transport = await getWorkerTransport();
  const id = randomUUID();
  const payload = JSON.stringify({ id, method, params });

  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      transport.pending.delete(id);
      transport.updateRef();
      reject(new Error(`dynafetch-net request timed out after ${timeoutMs}ms (method: ${method})`));
    }, timeoutMs);
    timer.unref(); // Don't let the timeout itself block exit

    transport.pending.set(id, {
      resolve: (value: unknown) => { clearTimeout(timer); resolve(value as T); },
      reject: (err: Error) => { clearTimeout(timer); reject(err); },
    });
    transport.updateRef(); // Ref the child while request is in flight

    transport.child.stdin.write(`${payload}\n`, (error) => {
      if (!error) return;
      clearTimeout(timer);
      transport.pending.delete(id);
      transport.updateRef();
      reject(error);
    });
  });
}

function resolveRpcTimeoutMs(options: { rpcTimeoutMs?: number; timeoutSeconds?: number }): number {
  if (options.rpcTimeoutMs != null) {
    return Math.max(1, Math.ceil(options.rpcTimeoutMs));
  }
  if (options.timeoutSeconds != null) {
    return Math.max(1_000, Math.ceil(options.timeoutSeconds * 1_000) + 1_000);
  }
  return 30_000;
}

export async function withDynafetchSession<T>(
  options: WorkerSessionOptions,
  run: () => Promise<T>,
): Promise<T> {
  const transport = await getWorkerTransport();
  transport.hold(); // Keep child alive for the entire session

  const { rpcTimeoutMs, ...sessionOptions } = options;
  const session = await callWorker<{ sessionId: string }>(
    "openSession",
    sessionOptions,
    resolveRpcTimeoutMs(options),
  );

  try {
    return await sessionStore.run({ sessionId: session.sessionId }, run);
  } finally {
    callWorker("closeSession", { sessionId: session.sessionId }).catch(() => {});
    transport.release();
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
  }, resolveRpcTimeoutMs(options));
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
  }, resolveRpcTimeoutMs(options));
}
