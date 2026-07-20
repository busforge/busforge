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
interface GaRange { id: number | string; rangeStart: number; children?: GaRange[]; addresses?: { raw: number }[] }
interface ProjectView { groupRanges: GaRange[] }
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
  // The read-back triggers a server-side device read enqueued as a "read" task. On a large device
  // that read outlasts any single HTTP socket on the single-channel bench: the OpenKNX RaumController
  // reads back in ~4 min, past the old 180 s client timeout, so the POST aborted while the server read
  // ran on to completion (and every retry fired ANOTHER doomed 4 min read). So the POST is fired and
  // the TASK is polled to completion, exactly like downloadReal. The read task carries no FlashResult
  // (reads persist their result to the DB), and the runner ignores this return and re-reads the
  // persisted state via getConfig, so this resolves void on the task reaching "done". A coded refusal
  // (e.g. DEVICE_NOT_ANSWERING) still propagates as an ApiError, the same honesty contract as the flash.
  async readBack(pid: string, did: string, onPhase?: (p: string) => void): Promise<void> {
    const firedAt = Date.now();
    const fetchP = this.call<unknown>("POST", `/api/projects/${pid}/devices/${did}/read-back`, { lang: "de" }, 600_000).catch((e) => {
      if (e instanceof ApiError) throw e; // a coded refusal is a real outcome
      process.stderr.write(`    …read: POST socket died (${e instanceof Error ? e.message : String(e)}); deferring to the task poll\n`);
      return new Promise<unknown>(() => {}); // never settles; the poll is the source of truth
    });
    let lastPhase = "";
    const pollP = (async (): Promise<void> => {
      for (let i = 0; i < 240; i++) { // up to ~20 min at 5 s
        await new Promise((r) => setTimeout(r, 5_000));
        const tasks = await this.tasks(pid).catch(() => [] as Task[]);
        const t = tasks
          .filter((x) => x.deviceId === did && x.kind === "read" && (x.startedAt ?? x.queuedAt ?? 0) >= firedAt - 2_000)
          .sort((a, b) => (b.startedAt ?? b.queuedAt ?? 0) - (a.startedAt ?? a.queuedAt ?? 0))[0];
        if (t) {
          if (t.phase && t.phase !== lastPhase) { lastPhase = t.phase; onPhase?.(t.phase); }
          if (t.state === "done") return;
          if (t.state === "error") throw new ApiError(0, t.errorCode ?? "TASK_ERROR", t.error ?? "read failed");
        }
      }
      throw new ApiError(0, "OP_TIMED_OUT", "read-back did not complete within the poll window");
    })();
    try { await Promise.race([fetchP, pollP]); }
    finally { fetchP.catch(() => undefined); } // a late fetch rejection (after the poll won) must not go unhandled
  }
  tasks(pid: string) { return this.call<Task[]>("GET", `/api/projects/${pid}/tasks`); }
  private projectFull(pid: string) { return this.call<ProjectView>("GET", `/api/projects/${pid}`); }
  private createGaRange(pid: string, parentId: number | string | null, num: number, name: string) { return this.call<ProjectView>("POST", `/api/projects/${pid}/group-ranges`, { parentId: parentId === null ? null : Number(parentId), number: num, name }); }
  // The range id round-trips from the project view as a string; the group-address route requires a number.
  private createGaAddress(pid: string, rangeId: number | string, sub: number, name: string, dpt: string) { return this.call<ProjectView>("POST", `/api/projects/${pid}/group-addresses`, { rangeId: Number(rangeId), sub, name, dpt }); }

  // Ensure a 3-level group address exists as a PROJECT group address, creating the main range,
  // middle range and address as needed (idempotent). The UI GA picker only offers project group
  // addresses, so a UI-driven link needs the GA to exist first; the API-driven link does not (it
  // stores the raw number directly), but a project GA there is harmless and more realistic.
  async ensureGa(pid: string, ga: string): Promise<void> {
    const [M, m, s] = ga.split("/").map(Number);
    if (M === undefined || m === undefined || s === undefined) throw new ApiError(0, "GA_BAD", `not a 3-level group address: ${ga}`);
    const mainBase = M << 11, midBase = (M << 11) | (m << 8), raw = gaToNum(ga);
    let proj = await this.projectFull(pid);
    const findMain = (p: ProjectView) => p.groupRanges.find((r) => r.rangeStart === mainBase);
    let main = findMain(proj);
    if (!main) { proj = await this.createGaRange(pid, null, M, `smoke ${M}`); main = findMain(proj); }
    if (!main) throw new ApiError(0, "GA_RANGE_FAILED", `could not create main range ${M}`);
    const findMid = (mn: GaRange) => mn.children?.find((r) => r.rangeStart === midBase);
    let mid = findMid(main);
    if (!mid) { proj = await this.createGaRange(pid, main.id, m, `smoke ${M}/${m}`); main = findMain(proj)!; mid = findMid(main); }
    if (!mid) throw new ApiError(0, "GA_RANGE_FAILED", `could not create middle range ${M}/${m}`);
    if (!mid.addresses?.some((a) => a.raw === raw)) await this.createGaAddress(pid, mid.id, s, `smoke ${ga}`, "1.001");
  }

  // Dry-run: computes the diff by READING the whole device (an absolute-segment System 7 read
  // measured ~82 s on the bench), so it needs a read-back-sized budget, not a "short call" one.
  downloadDry(pid: string, did: string) { return this.call<FlashResult>("POST", `/api/projects/${pid}/devices/${did}/download?dry=1`, undefined, 180_000); }
  flashDry(pid: string, did: string) { return this.call<FlashResult>("POST", `/api/projects/${pid}/devices/${did}/flash?dry=1`, undefined, 180_000); }

  // A real download can take minutes and the HTTP response is not always delivered before the
  // socket idles; fire it and POLL the task queue for the authoritative outcome instead of
  // trusting the response. Returns the FlashResult the server recorded.
  async downloadReal(pid: string, did: string, onPhase?: (p: string) => void): Promise<FlashResult> {
    return this.fireAndPoll(pid, did, `/api/projects/${pid}/devices/${did}/download`, "download", onPhase);
  }
  async flashReal(pid: string, did: string, onPhase?: (p: string) => void): Promise<FlashResult> {
    // The kind MUST match the queue's task kind (deviceops.ts enqueues the param flash as
    // "flash-params"), or the poll would never find its own task and (now that a socket death
    // defers to the poll as the sole truth) a real refusal would be masked as OP_TIMED_OUT.
    return this.fireAndPoll(pid, did, `/api/projects/${pid}/devices/${did}/flash`, "flash-params", onPhase);
  }

  private async fireAndPoll(pid: string, did: string, path: string, kind: string, onPhase?: (p: string) => void): Promise<FlashResult> {
    // The POST may RESOLVE (a fast flash — even an `unchanged`), REJECT (a coded refusal like
    // FLASH_UNVERIFIED or LOAD_PROC_CHECK_FAILED), or HANG (a long download whose HTTP response
    // never arrives before the socket idles). Race the fetch against a task-queue poll and use the
    // FIRST real answer: the fetch's result/refusal is authoritative when it comes, the poll covers
    // the hang. Crucially the fetch's error is NOT swallowed — masking a refusal as a timeout would
    // hide the very regression the harness exists to catch.
    const firedAt = Date.now();
    // The POST may RESOLVE (a fast flash), REJECT WITH A CODED REFUSAL (an ApiError from a non-ok
    // response, e.g. FLASH_UNVERIFIED or LOAD_PROC_CHECK_FAILED), or its socket may DIE mid-download (a
    // transport reset/abort while the download runs on for minutes server-side). Only the first two
    // are answers. A transport death is NOT: the task keeps running server-side, so letting that
    // rejection win the race would fire a SPURIOUS retry (a second full download of a device that is
    // already being programmed). So swallow transport errors here and defer to the authoritative
    // task-queue poll; keep propagating a coded ApiError refusal, which is a real outcome.
    const fetchP = this.call<FlashResult>("POST", path, undefined, 600_000).catch((e) => {
      if (e instanceof ApiError) throw e;
      // A dropped socket / aborted read mid-download is expected on the single-channel bench tunnel;
      // it is NOT the outcome. Say so once, then let the poll report what the device actually did.
      process.stderr.write(`    …${kind}: POST socket died (${e instanceof Error ? e.message : String(e)}); deferring to the task poll\n`);
      return new Promise<FlashResult>(() => {}); // never settles; the poll is the source of truth
    });
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
