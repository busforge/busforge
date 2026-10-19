// A thin typed client over the busforge production API — the same endpoints the UI calls, which
// are the single source of truth the runner asserts against. Every call surfaces the server's
// coded error verbatim (the {error:{code,message}} contract), so a refusal is a first-class,
// inspectable outcome rather than a swallowed 4xx.
import { gaToNum } from "../../packages/knx/src/index.ts";
// The authoritative config-view + capability types, imported from the product so the runner reads
// exactly the shapes the server sends (a field renamed on either side is a compile error here).
import type { DeviceConfigView, CfgItem, CfgParamView, CfgComObjView, DeviceCapabilities, DeviceReadbackInfo } from "../../packages/product/src/index.ts";
export type { DeviceConfigView as ConfigView, CfgItem, CfgParamView, CfgComObjView, DeviceCapabilities };

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
  structural?: boolean; // a structural flash: parameters, com-object table and group tables in one write
  confirmedOnly?: { address: number; length: number }[]; // bytes verified on the device's write confirmation alone
  restartUnproven?: boolean; // verified after a restart the device did not confirm
}
export interface CatalogProduct { manufacturer: number; name: string; appRef: string; productRef: string }
interface GaRange { id: number | string; rangeStart: number; children?: GaRange[]; addresses?: { raw: number }[] }
interface ProjectView { groupRanges: GaRange[] }
export interface Task { id: string; deviceId: string; kind: string; state: string; phase: string; error: string | null; errorCode: string | null; outcome: FlashResult | null; result: unknown; startedAt?: number; queuedAt?: number }

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
  version() { return this.call<{ version: string; commit: string; builtAt: string | null }>("GET", "/api/version"); }
  connections() { return this.call<{ id: string; type: string; host: string; port: number; ipTransport?: string }[]>("GET", "/api/connections"); }
  attachConnection(pid: string, connectionId: string) { return this.call<unknown>("PUT", `/api/projects/${pid}/connection`, { connectionId }); }
  // The operator's one acknowledgement per project that an untested Product may be written.
  acknowledgeUntested(pid: string, did: string) { return this.call<unknown>("PUT", `/api/projects/${pid}/devices/${did}/untested-ack`); }
  placeDevice(pid: string, appRef: string, productRef: string, name: string) { return this.call<{ id: string; ia: string }>("POST", `/api/projects/${pid}/devices`, { appRef, productRef, name }); }
  setAddress(pid: string, did: string, ia: string) { return this.call<unknown>("PUT", `/api/projects/${pid}/devices/${did}/address`, { ia }); }
  getConfig(pid: string, did: string, lang = "de") { return this.call<DeviceConfigView>("GET", `/api/projects/${pid}/devices/${did}/config?lang=${lang}`); }
  setParam(pid: string, did: string, paramRefId: string, value: string) { return this.call<DeviceConfigView>("PUT", `/api/projects/${pid}/devices/${did}/params`, { paramRefId, value, lang: "de" }); }
  // Import a .knxproj as a new project (the only way a project gets its Data Secure keys). The file is
  // sent as multipart, like the web import; the password never leaves this call.
  async importProject(bytes: Uint8Array, fileName: string, password: string): Promise<{ id: string; unresolvedSenders?: number; secureDevicesWithoutSerial?: number }> {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(bytes)], fileName));
    form.set("password", password);
    const res = await fetch(this.base + "/api/projects/import", { method: "POST", body: form });
    const json = await res.json() as { id?: string; error?: { code?: string; message?: string } };
    if (!res.ok || !json.id) throw new ApiError(res.status, json.error?.code ?? "HTTP_" + res.status, json.error?.message ?? "import failed");
    return json as { id: string };
  }
  projectDevices(pid: string) { return this.call<{ devices: { id: string; ia: string; name: string }[] }>("GET", `/api/projects/${pid}`).then((p) => p.devices); }
  createConnection(c: { name: string; type: "ip"; host: string; port: number; ipTransport: "tcp" | "udp" | "auto" }) { return this.call<{ id: string }>("POST", "/api/connections", c); }
  deleteConnection(id: string) { return this.call<unknown>("DELETE", `/api/connections/${id}`); }
  // Set an object's links outright (an empty list unlinks it); the restore after a run uses it.
  setLinks(pid: string, did: string, comObjRefId: string, gaRaws: number[]) { return this.call<DeviceConfigView>("PUT", `/api/projects/${pid}/devices/${did}/links`, { comObjRefId, gaRaws, lang: "de" }); }
  // Discard the project's edits of the device: parameters and links take the baseline the last
  // read-back set, i.e. what the device holds.
  revert(pid: string, did: string) { return this.call<DeviceConfigView>("POST", `/api/projects/${pid}/devices/${did}/revert`, { lang: "de" }); }
  link(pid: string, did: string, comObjRefId: string, ga: string) { return this.call<DeviceConfigView>("PUT", `/api/projects/${pid}/devices/${did}/links`, { comObjRefId, gaRaws: [gaToNum(ga)], lang: "de" }); }
  progMode(pid: string) { return this.call<{ devices: string[] }>("GET", `/api/projects/${pid}/prog-mode`, undefined, 40_000); }
  assignIa(pid: string, did: string) { return this.submitAndWait<{ previous: string; assigned: string; verified: boolean; progModeCleared: boolean }>(pid, `/api/projects/${pid}/devices/${did}/assign-ia`, "assign-ia"); }
  // The read-back triggers a server-side device read enqueued as a "read" task. On a large device
  // that read outlasts any single HTTP socket on the single-channel bench: the OpenKNX RaumController
  // reads back in ~4 min, past the old 180 s client timeout, so the POST aborted while the server read
  // ran on to completion (and every retry fired ANOTHER doomed 4 min read). So the POST is fired and
  // the TASK is polled to completion, exactly like downloadReal. What the read covered (parameters,
  // links, unresolved associations) exists only in the POST's response, not in the task or in GET
  // /config; it is returned when that response arrives, and null when the socket died, so a caller
  // that needs the coverage fails instead of assuming it. A coded refusal (e.g. DEVICE_NOT_ANSWERING)
  // still propagates as an ApiError, the same honesty contract as the flash.
  async readBack(pid: string, did: string, onPhase?: (p: string) => void, assume?: { paramRefId: string; value: string }[]): Promise<DeviceReadbackInfo | null> {
    const firedAt = Date.now();
    const fetchP = this.call<{ readback?: DeviceReadbackInfo }>("POST", `/api/projects/${pid}/devices/${did}/read-back`, { lang: "de", ...(assume ? { assume } : {}) }, 600_000).catch((e) => {
      if (e instanceof ApiError) throw e; // a coded refusal is a real outcome
      process.stderr.write(`    …read: POST socket died (${e instanceof Error ? e.message : String(e)}); deferring to the task poll\n`);
      return new Promise<{ readback?: DeviceReadbackInfo }>(() => {}); // never settles; the poll is the source of truth
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
          if (t.state !== "queued" && t.state !== "running") throw new ApiError(0, t.errorCode ?? `TASK_${t.state.toUpperCase()}`, t.error ?? `read ${t.state}`);
        }
      }
      throw new ApiError(0, "OP_TIMED_OUT", "read-back did not complete within the poll window");
    })();
    try {
      const first = await Promise.race([fetchP, pollP.then(() => null)]);
      if (first) return first.readback ?? null;
      // The poll saw the task done first; the response follows within moments unless its socket died.
      const late = await Promise.race([fetchP, new Promise<null>((r) => setTimeout(() => r(null), 15_000))]);
      return late?.readback ?? null;
    }
    finally { fetchP.catch(() => undefined); } // a late fetch rejection (after the poll won) must not go unhandled
  }
  tasks(pid: string) { return this.call<Task[]>("GET", `/api/projects/${pid}/tasks`); }
  private projectFull(pid: string) { return this.call<ProjectView>("GET", `/api/projects/${pid}`); }
  private createGaRange(pid: string, parentId: number | string | null, num: number, name: string) { return this.call<ProjectView>("POST", `/api/projects/${pid}/group-ranges`, { parentId: parentId === null ? null : Number(parentId), number: num, name }); }
  // The range id round-trips from the project view as a string; the group-address route requires a number.
  private createGaAddress(pid: string, rangeId: number | string, sub: number, name: string, dpt: string) { return this.call<ProjectView>("POST", `/api/projects/${pid}/group-addresses`, { rangeId: Number(rangeId), sub, name, dpt }); }

  // A group address's KNX Data Secure mode: "auto" (secured when a secure device uses it, as ETS),
  // "on" or "off".
  setGaSecurity(pid: string, ga: string, security: "auto" | "on" | "off") {
    return this.call<ProjectView>("PATCH", `/api/projects/${pid}/group-addresses/${gaToNum(ga)}`, { security });
  }

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
  flashGaDry(pid: string, did: string) { return this.call<FlashResult>("POST", `/api/projects/${pid}/devices/${did}/flash-ga?dry=1`, undefined, 180_000); }
  // A real write answers 202 with its queued task; the outcome is polled from that task.
  flashGaReal(pid: string, did: string, onPhase?: (p: string) => void): Promise<FlashResult> {
    return this.submitAndWait(pid, `/api/projects/${pid}/devices/${did}/flash-ga`, "flash-ga", onPhase);
  }
  downloadReal(pid: string, did: string, onPhase?: (p: string) => void): Promise<FlashResult> {
    return this.submitAndWait(pid, `/api/projects/${pid}/devices/${did}/download`, "download", onPhase);
  }
  flashReal(pid: string, did: string, onPhase?: (p: string) => void): Promise<FlashResult> {
    return this.submitAndWait(pid, `/api/projects/${pid}/devices/${did}/flash`, "flash", onPhase);
  }

  // Submit a write and poll ITS task (by id) to the end. A coded refusal before queueing (a guard,
  // DEVICE_WRITE_ACTIVE) throws from the POST. The device's own "not verified" verdict is returned
  // as the result it is, so the caller asserts on it; any other unsuccessful end throws its code.
  // A failed poll is retried: it says nothing about the job, which runs on in the server.
  private async submitAndWait<T>(pid: string, path: string, label: string, onPhase?: (p: string) => void): Promise<T> {
    const submitted = await this.call<Task>("POST", path, undefined, 60_000);
    let lastPhase = "";
    for (let i = 0; i < 240; i++) { // up to ~20 min at 5 s
      await new Promise((r) => setTimeout(r, 5_000));
      const t = await this.call<Task>("GET", `/api/projects/${pid}/tasks/${submitted.id}`).catch((e) => {
        if (e instanceof ApiError && e.code === "TASK_NOT_FOUND") throw e;
        return null;
      });
      if (!t) continue;
      if (t.phase && t.phase !== lastPhase) { lastPhase = t.phase; onPhase?.(t.phase); }
      if (t.state === "done" || (t.errorCode === "FLASH_UNVERIFIED" && t.result)) return t.result as T;
      if (t.state !== "queued" && t.state !== "running") throw new ApiError(0, t.errorCode ?? `TASK_${t.state.toUpperCase()}`, t.error ?? `${label} ${t.state}`);
    }
    throw new ApiError(0, "OP_TIMED_OUT", `${label} did not complete within the poll window`);
  }
}

// Walk a config view. Refs are matched full OR by suffix, so a spec can pin the short
// `A-....._O-2_R-3` ref the catalogue lists even though the device stores it fully qualified.
export function findComObject(view: DeviceConfigView, refId: string): CfgComObjView | undefined {
  for (const b of view.blocks) for (const it of b.items) {
    if (it.kind === "comObject" && (it.comObject.refId === refId || it.comObject.refId.endsWith(refId))) return it.comObject;
  }
  return undefined;
}
export function findParam(view: DeviceConfigView, refId: string): CfgParamView | undefined {
  for (const b of view.blocks) for (const it of b.items) {
    if (it.kind === "param" && (it.param.refId === refId || it.param.refId.endsWith(refId))) return it.param;
  }
  return undefined;
}
export function hasParamRef(view: DeviceConfigView, refId: string): boolean { return !!findParam(view, refId); }
// Every param / com-object the view currently exposes (visibility already resolved by the server).
export function allParams(view: DeviceConfigView): CfgParamView[] {
  const out: CfgParamView[] = [];
  for (const b of view.blocks) for (const it of b.items) if (it.kind === "param") out.push(it.param);
  return out;
}
export function allComObjects(view: DeviceConfigView): CfgComObjView[] {
  const out: CfgComObjView[] = [];
  for (const b of view.blocks) for (const it of b.items) if (it.kind === "comObject") out.push(it.comObject);
  return out;
}
// The GAs currently linked, as raw numbers, across the whole view.
export function linkedGaRaws(view: DeviceConfigView): number[] {
  return allComObjects(view).map((c) => c.gaRaw ?? null).filter((g): g is number => g !== null);
}
