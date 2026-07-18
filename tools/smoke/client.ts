// A thin typed client over the busforge production API — the same endpoints the UI calls, which
// are the single source of truth the runner asserts against. Every call surfaces the server's
// coded error verbatim (the {error:{code,message}} contract), so a refusal is a first-class,
// inspectable outcome rather than a swallowed 4xx.
import { gaToNum } from "../../packages/knx/src/index.ts";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export interface FlashResult {
  kind: "unchanged" | "dryRun" | "flashed";
  mask?: string;
  imageBytes?: number;
  diffBytes?: number;
  verified?: boolean;
  backup?: string;
}
export interface CatalogProduct { manufacturer: number; name: string; appRef: string; productRef: string }
export interface Task { id: string; deviceId: string; kind: string; state: string; phase: string; error: string | null; errorCode: string | null; outcome: FlashResult | null; startedAt?: number; queuedAt?: number }

export class Client {
  constructor(private readonly base = process.env.BUSFORGE_API ?? "http://localhost:3000") {}

  private async call<T>(method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method,
        headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } finally { clearTimeout(t); }
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const e = (json as { error?: { code?: string; message?: string } }).error;
      throw new ApiError(res.status, e?.code ?? "HTTP_" + res.status, e?.message ?? text);
    }
    return json as T;
  }

  catalogProducts() { return this.call<CatalogProduct[]>("GET", "/api/catalog/products"); }
  createProject(name: string) { return this.call<{ id: string }>("POST", "/api/projects", { name }); }
  deleteProject(id: string) { return this.call<unknown>("DELETE", `/api/projects/${id}`); }
  connections() { return this.call<{ id: string; type: string; host: string; port: number }[]>("GET", "/api/connections"); }
  attachConnection(pid: string, connectionId: string) { return this.call<unknown>("PUT", `/api/projects/${pid}/connection`, { connectionId }); }
  placeDevice(pid: string, appRef: string, productRef: string, name: string) { return this.call<{ id: string; ia: string }>("POST", `/api/projects/${pid}/devices`, { appRef, productRef, name }); }
  setAddress(pid: string, did: string, ia: string) { return this.call<unknown>("PUT", `/api/projects/${pid}/devices/${did}/address`, { ia }); }
  getConfig(pid: string, did: string, lang = "de") { return this.call<ConfigView>("GET", `/api/projects/${pid}/devices/${did}/config?lang=${lang}`); }
  setParam(pid: string, did: string, paramRefId: string, value: string) { return this.call<ConfigView>("PUT", `/api/projects/${pid}/devices/${did}/params`, { paramRefId, value, lang: "de" }); }
  link(pid: string, did: string, comObjRefId: string, ga: string) { return this.call<ConfigView>("PUT", `/api/projects/${pid}/devices/${did}/links`, { comObjRefId, gaRaws: [gaToNum(ga)], lang: "de" }); }
  progMode(pid: string) { return this.call<{ devices: string[] }>("GET", `/api/projects/${pid}/prog-mode`, undefined, 40_000); }
  assignIa(pid: string, did: string) { return this.call<{ previous: string; assigned: string; verified: boolean; progModeCleared: boolean }>("POST", `/api/projects/${pid}/devices/${did}/assign-ia`, undefined, 90_000); }
  readBack(pid: string, did: string) { return this.call<ConfigView>("POST", `/api/projects/${pid}/devices/${did}/read-back`, { lang: "de" }, 180_000); }
  tasks(pid: string) { return this.call<Task[]>("GET", `/api/projects/${pid}/tasks`); }

  // Dry-run download: short, returns the plan.
  downloadDry(pid: string, did: string) { return this.call<FlashResult>("POST", `/api/projects/${pid}/devices/${did}/download?dry=1`, undefined, 90_000); }
  flashDry(pid: string, did: string) { return this.call<FlashResult>("POST", `/api/projects/${pid}/devices/${did}/flash?dry=1`, undefined, 90_000); }

  // A real download can take minutes and the HTTP response is not always delivered before the
  // socket idles; fire it and POLL the task queue for the authoritative outcome instead of
  // trusting the response. Returns the FlashResult the server recorded.
  async downloadReal(pid: string, did: string, onPhase?: (p: string) => void): Promise<FlashResult> {
    return this.fireAndPoll(pid, did, `/api/projects/${pid}/devices/${did}/download`, "download", onPhase);
  }
  async flashReal(pid: string, did: string, onPhase?: (p: string) => void): Promise<FlashResult> {
    return this.fireAndPoll(pid, did, `/api/projects/${pid}/devices/${did}/flash`, "flash", onPhase);
  }

  private async fireAndPoll(pid: string, did: string, path: string, kind: string, onPhase?: (p: string) => void): Promise<FlashResult> {
    // The POST may RESOLVE (a fast flash — even an `unchanged`), REJECT (a coded refusal like
    // FLASH_UNVERIFIED or LOAD_PROC_CHECK_FAILED), or HANG (a long download whose HTTP response
    // never arrives before the socket idles). Race the fetch against a task-queue poll and use the
    // FIRST real answer: the fetch's result/refusal is authoritative when it comes, the poll covers
    // the hang. Crucially the fetch's error is NOT swallowed — masking a refusal as a timeout would
    // hide the very regression the harness exists to catch.
    const firedAt = Date.now();
    const fetchP = this.call<FlashResult>("POST", path, undefined, 600_000);
    let lastPhase = "";
    const pollP = (async (): Promise<FlashResult> => {
      for (let i = 0; i < 240; i++) { // up to ~20 min at 5 s, for a download whose response never arrives
        await new Promise((r) => setTimeout(r, 5_000));
        const tasks = await this.tasks(pid).catch(() => [] as Task[]);
        // The NEWEST matching real task — a prior (retried) attempt's stale errored task must not be
        // picked, or a retry would report the old failure instead of waiting for this attempt.
        const t = tasks
          .filter((x) => x.deviceId === did && x.kind === kind && x.outcome?.kind !== "dryRun" && (x.startedAt ?? x.queuedAt ?? 0) >= firedAt - 2_000)
          .sort((a, b) => (b.startedAt ?? b.queuedAt ?? 0) - (a.startedAt ?? a.queuedAt ?? 0))[0];
        if (t) {
          if (t.phase && t.phase !== lastPhase) { lastPhase = t.phase; onPhase?.(t.phase); }
          if (t.state === "done" && t.outcome) return t.outcome;
          if (t.state === "error") throw new ApiError(0, t.errorCode ?? "TASK_ERROR", t.error ?? "task failed");
        }
      }
      throw new ApiError(0, "OP_TIMED_OUT", `${kind} did not complete within the poll window`);
    })();
    try { return await Promise.race([fetchP, pollP]); }
    finally { fetchP.catch(() => undefined); } // a late fetch rejection (after the poll won) must not go unhandled
  }
}

// The subset of the config view the runner reads.
export interface ConfigView {
  blocks: { id: string; name: string; items: ConfigItem[] }[];
  readbackSupport?: { params: boolean; links: boolean };
}
export type ConfigItem =
  | { kind: "param"; param: { refId: string; value: string; changed?: boolean } }
  | { kind: "comObject"; comObject: { refId: string; number: number; name: string; gaRaw: number | null } }
  | { kind: "separator"; text: string }
  | { kind: string; [k: string]: unknown };

// Walk a config view for a com-object by ref (full or suffix match) and its current gaRaw.
export function findComObject(view: ConfigView, refId: string): { refId: string; number: number; gaRaw: number | null } | undefined {
  for (const b of view.blocks) for (const it of b.items) {
    if (it.kind === "comObject") { const c = (it as { comObject: { refId: string; number: number; gaRaw: number | null } }).comObject; if (c.refId === refId || c.refId.endsWith(refId)) return c; }
  }
  return undefined;
}
export function hasParamRef(view: ConfigView, refId: string): boolean {
  for (const b of view.blocks) for (const it of b.items) if (it.kind === "param" && (it as { param: { refId: string } }).param.refId === refId) return true;
  return false;
}
