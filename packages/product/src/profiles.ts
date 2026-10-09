import { KnxDevice, KnxError, type LoadPlan, type SecurityObjectTables, OBJECT_TYPE_SECURITY, SECURITY_PID, GROUP_KEY_ENTRY, SENDER_ENTRY, planSystemBGaFlash, planSystemBFullDownload, appId, runLoadPlan, iaToNum, compareDeclaredProp, readGroupTables, readGroupTablesMv0705, loadedTableAddr, crc16Ccitt, crc16CcittFalse, readSegmentCrc, GroupTableUnreadable, OBJ, PID, lsmState, STATE } from "@busforge/knx";
import { toAppModel, unmappedParamRefs } from "./application.ts";
import { buildRelativeSegmentTarget, type RelativeSegmentTarget, mergeRelativeTarget, verifyMaskedBytes, confirmedMatch, type ConfirmedOnlyRange, buildAbsoluteSegmentTargets, wholeBytes } from "./deviceimage.ts";
import { resolveModuleInstances } from "./modules.ts";
import { assertComObjectTableStable } from "./comobjtable.ts";
import { buildComObjectTable, programIdStamp, withLinkedCommFlags, withInstanceOverrides, refuseUnwritableOverrides, type ComObjInstanceOverride, type OverridableBit } from "./comobjbuild.ts";
import { buildDeviceConfig, type DeviceCapabilities } from "./config.ts";
import { decodeParameterImage, decodeAbsoluteImage } from "./image.ts";
import { buildGroupTables, buildGroupTablesMv0705, decodeGroupTables, decodeGroupTablesMv0705, type ComObjectLink } from "./grouptables.ts";
import { parseLoadProcedures, assessParCoverage, declaredPropChecks, relParamFillByte, relParamFullMode, declaredMcbWrites, unrunGrpSteps, lsmIdx, stepAddress, type ParCoverage, type LoadProcedures, type McbWrite } from "./loadproc.ts";
import { planAbsoluteParFlash, planRelativeParFlash, planRelativeStructuralFlash, planRelativePartialFullDownload, changedOwned, differentialMask, declaredMcbRegions, type McbRegion, planAbsoluteStructuralFlash, absoluteStructuralImages, differingBytes, planAbsoluteFullDownload, absoluteFullStepRefusal, fullDownloadSegmentRefusal, absoluteFullForm, withClosing, withConfirmedRestart, planSystem7GaFlash, fullDownloadImageDigest, type AbsFullSegment } from "./deviceflash.ts";
import { maskInfo, isMemoryMappedLsm, type MemoryModel, type SystemFamily } from "./masks.ts";
import { type AppConfig, type ModuleInstance } from "./appconfig.ts";
import type { AppModel } from "./application.ts";
import { ProductError } from "./errors.ts";
import { buildSecurityObject, reachableGroupKeys, type OtherDevice } from "./securityobject.ts";
import { bcu1Segment, bcu1ApplicationRefusal, decodeEmptyBcu1Tables, system1LoadRefusal, SYSTEM1_GROUP_TABLES_REFUSAL } from "./system1.ts";

// Progress reporting for long-running device operations: a phase label plus optional
// done/total counters (unit-agnostic; memory reads report bytes). Structurally identical
// to the server task queue's ProgressFn, defined here so the device domain has no
// dependency on the server.
export type ProgressFn = (phase: string, done?: number, total?: number) => void;

// ─────────────────────────────────────────────────────────────────────────────
// Device profiles: one strategy per KNX memory model.
//
// A KNX device's mask version (see masks.ts) fixes its MEMORY MODEL, and the memory
// model decides how we read its parameters/links off the bus and how we program them.
// Rather than re-detecting "is this MV-0705?" inline in every flash/read function (the
// old code did this five times, twice with DIFFERENT criteria), classify() resolves the
// device to exactly one DeviceProfile and every operation dispatches through it.
//
// The cardinal rule: a model we have NOT implemented does not fall through to a path that
// guesses. It resolves to UnsupportedProfile, whose every operation throws. That is the
// difference between "we don't support this device" (honest, explicit) and silently
// fabricating a wrong baseline or corrupting a table (the bug class this replaces).
//
// The profiles are PURE DEVICE DOMAIN: they receive an already-connected KnxDevice and
// context hooks (progress, backup persistence) and never touch transports, HTTP, the DB
// or the filesystem. The connect / mask-check / disconnect envelope lives in the server
// (withDeviceSession, apps/server deviceprofile.ts), which is the only glue left there.
// ─────────────────────────────────────────────────────────────────────────────

const LSM = OBJ.APP_PROGRAM; // System B parameter segment (LSM 4)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// After a LoadProcedure restart the device can be briefly unreachable while it reboots. Some
// devices are notably slow (M-008E answers only several seconds after the restart), so a single
// fixed pause then one connect would throw "device not answering" on the post-restart read and
// report a SUCCESSFUL flash as a failure. Re-establish the connection and wait for the device to
// answer a lightweight liveness probe, retrying with backoff. Throws only if the device never
// answers within the budget. Timing is injectable for tests. Worst case on a truly dead device
// is bounded (~40 s with the defaults: 3 s + 6 probes, each probe's request retries internally),
// which is acceptable for a one-off commissioning flash and far better than the false-failure. A
// failed link to the interface reopens it and is retried for up to `linkDeadlineMs` (see LINK_ERRORS).
export async function reconnectAfterRestart(
  dev: Pick<KnxDevice, "connect" | "disconnect" | "deviceDescriptor" | "reopenTransport">,
  opts: { initialMs?: number; tries?: number; delayMs?: number; linkDeadlineMs?: number; linkDown?: boolean } = {},
): Promise<void> {
  const { initialMs = 3000, tries = 6, delayMs = 2000, linkDeadlineMs = 120_000 } = opts;
  const start = Date.now();
  await sleep(initialMs);
  // `tries` counts the device's answers only; failures of the link to the interface are retried,
  // the link opened again each time, until `linkDeadlineMs` has passed since the restart.
  let linkDown = opts.linkDown ?? false;
  let deviceTries = 0;
  let lastErr: unknown;
  for (;;) {
    try {
      if (linkDown) {
        // Any failure to open the link again (no answer, no free channel yet, the interface without
        // its bus) is still the link, not the device; only another address is final.
        try { await dev.reopenTransport(); }
        catch (e) { throw (e as { code?: string }).code === "TUNNEL_ADDRESS_CHANGED" ? e : Object.assign(e as Error, { linkFailure: true }); }
      }
      linkDown = false;
      await dev.connect();
      await dev.deviceDescriptor(); // probe: confirms the rebooted device answers before verifying
      return;
    } catch (e) {
      lastErr = e;
      // A link that came back under another address cannot carry the secured session: final.
      if ((e as { code?: string }).code === "TUNNEL_ADDRESS_CHANGED") throw e;
      try { await dev.disconnect(); } catch { /* connection may already be gone */ }
      if (isLinkError(e) || (e as { linkFailure?: boolean }).linkFailure) {
        linkDown = true;
        if (Date.now() - start >= linkDeadlineMs) {
          throw new KnxError("FLASH_UNVERIFIED_LINK_DOWN", `the link to the interface did not come back within ${Math.round(linkDeadlineMs / 1000)} s of the restart (${(e as Error).message}), so the write is not verified; it may well have landed: read the device back`);
        }
      } else if (++deviceTries >= tries) break;
      await sleep(delayMs);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("device did not answer after restart");
}
// The link to the interface failed, not the device: an MDT IP interface stops serving its tunnels
// for 40-64 s and then drops them whenever the MDT IP router beside it restarts, so the tunnel is
// opened again until `linkDeadlineMs` has passed.
const LINK_ERRORS = new Set(["TUNNEL_CLOSED", "TUNNEL_CON_TIMEOUT", "TUNNEL_ACK_TIMEOUT", "TUNNEL_CONNECT_TIMEOUT", "TUNNEL_CONNECT_FAILED"]);
function isLinkError(e: unknown): boolean { return LINK_ERRORS.has((e as { code?: string } | undefined)?.code ?? ""); }

// A post-restart verify read can transiently mismatch while a slow device is still settling its
// memory (it answers the reconnect probe before every byte is stable). Read, check, and on a
// mismatch settle briefly and read ONCE more before declaring failure, so a momentary read does
// not report a successful flash as failed. A genuine mis-write still fails (it persists on re-read).
// Returns the final readback and whether it matched. Settle is injectable for tests.
export async function verifySettled<T>(read: () => Promise<T>, ok: (v: T) => boolean, settleMs = 1500): Promise<{ value: T; ok: boolean }> {
  let value = await read();
  if (!ok(value)) { await sleep(settleMs); value = await read(); }
  return { value, ok: ok(value) };
}

// Fold a segment's decoded device values into the programmed baseline.
//
// Only refs the memory image ENCODES appear in `deviceVals`, and only those may be
// re-baselined: a parameter with no memory offset (a channel-count that lives solely in the
// project, say) is unobservable on the bus, so the read must leave its baseline untouched
// rather than adopt the live value. Adopting it would mark an unflashed edit as "programmed"
// merely because the device cannot contradict it.
//
// For an observable ref: the device's value wins where it differs from what the project would
// write; where it agrees, the baseline is the project's own live value (and stays SPARSE, an
// absent entry meaning "holds the application default", which is exactly what it holds). A ref
// the image writes at its default although the project stores another value for it (`defaulted`,
// an inactive parameter) keeps the device's value: the project's value is not what it holds.
function foldDeviceValues(
  paramBase: Map<string, string>,
  deviceVals: Map<string, string>,
  projectVals: Map<string, string>,
  liveParams: Map<string, string>,
  relevantRefs?: Set<string>,
  defaulted?: Set<string>,
): void {
  for (const [refId, devVal] of deviceVals) {
    if (relevantRefs && !relevantRefs.has(refId)) continue;
    if (projectVals.get(refId) !== devVal || defaulted?.has(refId)) { paramBase.set(refId, devVal); continue; }
    const live = liveParams.get(refId);
    if (live === undefined) paramBase.delete(refId); else paramBase.set(refId, live);
  }
}

// A text field the read-back's build left unowned (textRefusals "skip": its byte layout is not
// shown by any capture) is compared neither way: its ref leaves the device values, so the read
// keeps the baseline it had instead of reporting the field in sync.
function dropUnownedText(model: AppModel, vals: Map<string, string>, segOf: (p: { codeSegment?: string }) => ReadonlyArray<number> | undefined): void {
  for (const ref of model.refs.values()) {
    const p = model.params.get(ref.paramId);
    if (!p || p.offset === undefined || model.types.get(p.typeId)?.base !== "Text") continue;
    const owned = segOf(p);
    if (owned && !owned[p.offset]) vals.delete(ref.id);
  }
}

// Which refs a read-back records drift for: the ones the project's configuration shows, plus the
// ones the DEVICE's configuration shows. Visibility depends on parameter values (a sensor type set
// to "none" hides every setting of that sensor), so relevance from the project alone skips exactly
// the settings the device has and the project lacks, and a later flash would silently reset them.
// The device's configuration is found by overlaying its values for every parameter active in the
// image (hidden Merker included, since they gate chooses too) on the project, repeated until the
// active set is stable; one that never settles is refused rather than half-read.
function deviceRelevantRefs(
  deviceVals: Map<string, string>,
  liveParams: Map<string, string>,
  configFor?: (values: Map<string, string>) => { shown: Set<string>; active: Set<string> },
): { relevant: Set<string>; deviceConfig: Map<string, string> } | undefined {
  if (!configFor) return undefined;
  const project = configFor(liveParams);
  let cur = project;
  for (let i = 0; i < 16; i++) {
    const effective = new Map(liveParams);
    for (const [refId, v] of deviceVals) if (cur.active.has(refId)) effective.set(refId, v);
    const next = configFor(effective);
    if (next.active.size === cur.active.size && [...next.active].every((r) => cur.active.has(r))) {
      return { relevant: new Set([...project.shown, ...next.shown]), deviceConfig: effective };
    }
    cur = next;
  }
  throw new ProductError("READBACK_UNSTABLE", "the parameters active under the device's configuration never settled; its state cannot be read back reliably");
}

// Whether every listed load-state machine is LOADED.
async function allLoaded(dev: KnxDevice, objs: number[], memMapped = false): Promise<boolean> {
  for (const obj of objs) if ((await lsmState(dev, obj, memMapped)) !== STATE.LOADED) return false;
  return true;
}

const byteDiff = (a: Buffer, b: Buffer): number => {
  if (a.length !== b.length) return Math.max(a.length, b.length);
  let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d;
};

// What a Data Secure device's security object holds, in the shape buildSecurityObject builds: the
// group key table by its element count, and the flags of objects 1..`flagCount`. The device reads
// its group keys back only inside the secured session this runs in.
// `addressCount`: the entries of the address table the device holds or is given (reachableGroupKeys).
async function readSecurityObject(dev: KnxDevice, flagCount: number, addressCount: number): Promise<SecurityObjectTables> {
  const count = async (pid: number) => (await dev.propExtRead(OBJECT_TYPE_SECURITY, 1, pid, 0, 1)).readUInt16BE(0);
  const n = await count(SECURITY_PID.GROUP_KEY_TABLE);
  const all = n ? await dev.propExtReadElements(OBJECT_TYPE_SECURITY, 1, SECURITY_PID.GROUP_KEY_TABLE, 1, n, GROUP_KEY_ENTRY) : Buffer.alloc(0);
  const groupKeys = reachableGroupKeys(all, addressCount);
  const goFlags = await dev.propExtReadElements(OBJECT_TYPE_SECURITY, 1, SECURITY_PID.GO_SECURITY_FLAGS, 1, flagCount, 1);
  const m = await count(SECURITY_PID.SECURITY_IA_TABLE);
  const senders = m ? await dev.propExtReadElements(OBJECT_TYPE_SECURITY, 1, SECURITY_PID.SECURITY_IA_TABLE, 1, m, SENDER_ENTRY) : Buffer.alloc(0);
  return { groupKeys, goFlags, senders };
}
// A sender entry's last sequence is the device's own receive state, advanced by every telegram it
// accepts from that sender; only the listed addresses are configuration.
const senderAddresses = (t: Buffer) => { const out: number[] = []; for (let i = 0; i + SENDER_ENTRY <= t.length; i += SENDER_ENTRY) out.push(t.readUInt16BE(i)); return out.join(","); };
const sameSecurityObject = (a: SecurityObjectTables, b: SecurityObjectTables) =>
  a.groupKeys.equals(b.groupKeys) && a.goFlags.equals(b.goFlags) && senderAddresses(a.senders) === senderAddresses(b.senders);

// Only System B's secured tables are loaded the way ETS does it (planSecurityObjectLoad); on any
// other memory model the security object would be left behind the tables it belongs to.
function refuseSecureTables(ctx: { security?: SecureTablesCtx }, family: string): void {
  if (ctx.security) {
    throw new ProductError("SECURE_TABLES_UNSUPPORTED", `this device runs KNX Data Secure, and loading its security object with its group tables is implemented for System B devices only, not ${family}`);
  }
}

// Firmware families hardware-verified to persist their configuration at LoadCompleted rather than on
// the closing A_Restart, so a restart that does not reboot is not a failure (KnxDevice.restart's
// requireReboot=false path). Each entry is a manufacturer id PROVEN on real hardware by a power
// cycle: the parameter segment read back byte-identical after power-down. Everything NOT listed keeps
// the safe default — persistence happens on the restart (thelsing/knx, OpenKNX) — so an unproven
// device still refuses on a restart it could not confirm.
//   0x0085 GVS (K-BUS): AMMA-04/06.S full download survived a power cycle byte-identical, 2026-07-14.
const PERSIST_ON_LOAD_COMPLETED = new Set<number>([0x0085]);
const appManufacturer = (app: AppConfig): number => Number.parseInt(String(app.id).split("_")[0].replace("M-", ""), 16);

// Does this application's firmware persist at LoadCompleted (so the closing A_Restart need not prove
// a reboot)? Exported for the test that guards the default-strict gate: everything not in the
// hardware-verified allowlist must return false, or an OpenKNX device that failed to restart would
// be reported as programmed while it comes back factory-fresh.
export const persistsOnLoadCompleted = (app: AppConfig): boolean => PERSIST_ON_LOAD_COMPLETED.has(appManufacturer(app));

// Firmware families hardware-verified to INVALIDATE their running application when a table it
// references is unloaded underneath it, so a group-address flash must hold the application program
// object in its own load bracket across the rewrite (planSystemBGaFlash holdApplication).
//   0x0004 Jung (Insta stack): a table-only GA flash left all three tables LOADED and byte-perfect while
//   object 4 dropped to ERROR — the device answered management but ran no application, so every link was
//   dead, and only a full download recovered it. With the bracket the same flash keeps object 4 LOADED
//   and the re-pointed link answers on the bus (2026-07-24).
// Everything NOT listed keeps the proven table-only bracket, because the extra LoadCompleted is not
// free: on a persist-at-LoadCompleted device (GVS) it triggers an additional flash persist, and the GVS
// smoke failed its very next parameter flash with DEVICE_NOT_ANSWERING when the bracket was applied
// universally. The safety net for an unlisted family is the guard in flashGroupTables: if a GA flash
// does break the application, the flash FAILS loudly (GA_FLASH_BROKE_APPLICATION) instead of reporting
// verified, and the fix is to add that family here once it is proven on hardware.
const HOLD_APPLICATION_ON_GA_FLASH = new Set<number>([0x0004]);
export const holdsApplicationOnGaFlash = (app: AppConfig): boolean => HOLD_APPLICATION_ON_GA_FLASH.has(appManufacturer(app));

// The structural flash (one bracket set over the application, the com-object table and both group
// tables, findings.md §28) follows the family's rule on every application; it is offered only on the
// applications whose ETS capture of such a download it is tested against (tools/etsdiff.test.ts,
// "structural flash"): the revert of a parameter and a link change in one download, and for the first
// two a change that reshapes the com-object table. Every other application takes the full download for
// such a change, or ETS. This is evidence, not ETS behaviour: an entry is added with its capture test.
// Two firmware stacks stay off regardless, hardware-shown not to take the bracket: thelsing/OpenKNX
// loses a download whose tables follow a long parameter write (planSystemBFullDownload), the GVS stack
// (persist at LoadCompleted) failed its next flash after an extra LoadCompleted.
export const STRUCTURAL_FLASH_CAPTURED: readonly string[] = [
  "M-0004_A-7072-21-99A7", // Jung 400021SE
  "M-0083_A-00B6-32-9642", // MDT BE-02001.02
  "M-0083_A-00B4-32-3919", // MDT BE-06001.02
  "M-0081_A-FE01-11-75D9", // Auro presence detector
  "M-0008_A-10D7-11-2783", // Gira Tastsensor 3 Komfort
  "M-0048_A-107E-12-5B58", // Theben TheLuxa P300
  "M-0048_A-140C-14-EB70", // Theben Meteodata 140 S
  "M-0048_A-493B-21-B471", // Theben MIX 2
  "M-0048_A-9071-20-F258", // Theben DALI-Gateway KNX plus
];
const structuralFlashCaptured = (app: AppConfig): boolean =>
  STRUCTURAL_FLASH_CAPTURED.some((id) => String(app.id) === id || String(app.id).startsWith(`${id}-`));

// Firmware that persists its download on a timer after the last memory write and must be left alone
// before the restart, on a fresh connection (thelsing/OpenKNX, see planSystemBFullDownload). Every other
// System B download closes as ETS closes it: the restart on the same connection right after the steps
// that close it (Theben MIX 2, Jung 400021SE, GVS AMMA, Theben DALI-Gateway captures).
const SETTLE_BEFORE_RESTART = new Set<number>([0x00fa]);
const closesAtOnce = (app: AppConfig): boolean => !SETTLE_BEFORE_RESTART.has(appManufacturer(app));

// The bytes of the parameter segment ETS's image of a full download holds, per byte non-zero: a segment
// that declares a <Data> default image is imaged whole, or where it declares a <Mask> the bytes the mask
// marks and those a parameter owns; a segment without <Data> holds only the bytes a parameter owns.
// ETS's own log lists exactly these (MIX 2 and the MDT IP Interface/Router: whole with <Data>; the
// OpenKNX RaumController and the Theben DALI-Gateway: the owned bytes, without <Data>), and its wire of
// the Jung 400021SE (<Data> and <Mask>) and the GVS AMMA (<Data>) fits no other. A mask of another length
// than the segment, or marking single bits, and a <Data> shorter than it are refused: no capture shows one.
export function fullDownloadImageCoverage(app: AppConfig, owned: ReadonlyArray<number>): number[] {
  const seg = app.segments.find((x) => x.lsm === LSM);
  if (!seg || seg.data.length === 0) return [...owned];
  if (seg.data.length !== owned.length) {
    throw new ProductError("FULL_DOWNLOAD_SEGMENT_UNKNOWN", `segment ${seg.id} declares ${seg.data.length} bytes of <Data> for ${owned.length}; the ETS captures show <Data> over the whole segment only, refusing to guess which bytes it writes`);
  }
  const mask = seg.mask;
  if (!mask) return owned.map(() => 0xff);
  if (mask.length !== owned.length || mask.some((b) => b !== 0 && b !== 0xff)) {
    throw new ProductError("FULL_DOWNLOAD_SEGMENT_UNKNOWN", `segment ${seg.id} declares a <Mask> of ${mask.length} bytes for ${owned.length}, or one that marks single bits; the ETS captures show whole-byte masks over the whole segment only, refusing to guess which bytes it writes`);
  }
  return owned.map((o, i) => (mask[i] || o ? 0xff : 0));
}

// An IP interface serves its tunnelling connections from individual addresses outside the parameter
// image and the load procedure (MaxTunnelingUserEntries of them, the project's AdditionalAddresses).
// A full download unloads and reallocates every load object; no Busforge path writes those addresses
// and no capture shows what ETS writes for them, so the full download of such an application is
// refused until they are modeled. A declaration that is not a number counts as declaring entries.
export const declaresTunnelingEntries = (app: AppConfig): boolean => app.maxTunnelingUserEntries !== 0;
// Whether the tunnelling entries are what keeps the full download from this application: its profile
// would offer it without them. An application refused for its family anyway reports that instead.
export const fullDownloadRefusedForTunnelingEntries = (app: AppConfig): boolean =>
  declaresTunnelingEntries(app) && classify({ ...app, maxTunnelingUserEntries: 0 }).capabilities().fullDownload;
// Always refuses an application declaring entries, with the code the download route answers.
function refuseTunnelingEntries(app: AppConfig): void {
  if (!declaresTunnelingEntries(app)) return;
  if (!fullDownloadRefusedForTunnelingEntries(app)) {
    throw new ProductError("FULL_DOWNLOAD_UNSUPPORTED", "this application cannot be commissioned from scratch (and it declares tunnelling addresses no Busforge path writes)");
  }
  throw new ProductError("FULL_DOWNLOAD_TUNNELING_ENTRIES",
    `this application declares ${app.maxTunnelingUserEntries} tunnelling address(es) (MaxTunnelingUserEntries), which no Busforge path writes; refusing a full download that would reallocate the interface without them`);
}

// An operation the application itself keeps Busforge from running, with the code and message the
// operation refuses with. capabilities() withholds exactly the operations a profile's
// operationRefusals() names, and the server answers with the same code before anything is queued, so
// the UI can say why instead of offering a write that is then refused.
export interface OperationRefusal { code: string; message: string }
export type OperationRefusals = Partial<Record<"flashParams" | "flashLinks" | "fullDownload", OperationRefusal>>;

function refuseWith(r: OperationRefusal): never {
  throw new ProductError(r.code, r.message);
}
function refuse(r: OperationRefusal | null | undefined): void {
  if (r) refuseWith(r);
}

// Every step a par-style write is held to must have an explicit disposition (executed / caller /
// documented skip). A step the model cannot execute blocks the write: running a partial recipe and
// reporting "programmed and verified" is exactly the silent-skip class this codebase refuses.
function parRefusal(coverage: ParCoverage, what: string): OperationRefusal | null {
  if (!coverage.blocked.length) return null;
  const details = [...new Set(coverage.blocked.map((b) => b.detail))].join("; ");
  return { code: "LOAD_STEP_UNSUPPORTED", message: `the device's load procedure declares ${coverage.blocked.length} step(s) this ${what} cannot execute yet (${details}); refusing to flash rather than run a partial recipe` };
}

// Guard a par download against its own declared load procedure.
function assertParCoverage(proc: LoadProcedures, model: "absolute" | "relative"): ParCoverage {
  const coverage = assessParCoverage(proc, model);
  refuse(parRefusal(coverage, "parameter download"));
  return coverage;
}

// The absolute parameter flash follows the procedure the application declares; without one there is
// no bracket to follow.
function absoluteParRefusal(proc: LoadProcedures): OperationRefusal | null {
  if (proc.style === "DefaultProcedure" || proc.blocks.length === 0) {
    return { code: "LOAD_PROCEDURE_UNSUPPORTED", message: `device declares no usable load procedure (style ${proc.style}); cannot flash safely` };
  }
  return parRefusal(assessParCoverage(proc, "absolute"), "parameter download");
}

// What a System 7 group-address flash writes and is held to. Besides the address and association
// tables (objects 1 and 2), the com-object table's linked bits where the application names that
// table's segment (object 3). A memory-mapped device (MV-0700/0701) whose application names none is
// refused: its table cannot be located, and a newly linked object would be left without its linked
// bit. A property-mapped one (MV-0705) keeps the device's table untouched (l3 null): its full download
// is refused without that segment, so the table there was written by another tool. The declared steps
// addressed to those objects must each have a disposition, as for the parameter flash. A declared
// CompareProp is a read of the device, not a step on these tables: the group-address flash runs none,
// and whether it should run the application's checks first is an open question (docs/roadmap.md).
function system7GaScope(cfg: AppConfig, mask: string): { l3: { address: number; size: number } | null } | { refusal: OperationRefusal } {
  const segId = cfg.groupTables.comObjectSegment;
  const seg = segId === undefined ? undefined : cfg.absoluteSegments.find((s) => s.id === segId);
  const l3 = seg && seg.data.length > 0 ? { address: seg.address, size: seg.data.length } : null;
  if (!l3 && isMemoryMappedLsm(mask)) {
    return { refusal: { code: "FULL_DOWNLOAD_TABLE_SEGMENT_MISSING", message: "this application names no com-object table segment with a template; refusing a group-address flash that would leave newly linked objects without their link flag" } };
  }
  const tableSteps = { ...cfg.loadProcedures, blocks: cfg.loadProcedures.blocks.map((b) => ({ ...b, steps: b.steps.filter((st) => st.verb !== "LdCtrlCompareProp") })) };
  const refusal = parRefusal(assessParCoverage(tableSteps, "absolute", new Set([OBJ.ADDR_TABLE, OBJ.ASSOC_TABLE, ...(l3 ? [OBJ.COMOBJ_TABLE] : [])])), "group-address flash");
  if (refusal) return { refusal };
  // What the planner refuses for the application itself (its procedure style, where its tables go) is
  // refused here too, so the flash is not offered only to stop at the plan.
  try {
    planSystem7GaFlash(cfg, cfg.loadProcedures, buildGroupTablesMv0705([], 0), null);
  } catch (e) {
    if (e instanceof ProductError) return { refusal: { code: e.code, message: e.message } };
    throw e;
  }
  return { l3 };
}

// The memory-control-block regions a loaded segment reports (PID 27), element by element until they
// cover `size` bytes; null where the object reports none.
async function readMcbRegions(dev: KnxDevice, obj: number, size: number): Promise<McbRegion[] | null> {
  const regions: McbRegion[] = [];
  for (let element = 1, covered = 0; covered < size && element <= 16; element++) {
    const e = await dev.propRead(obj, PID.MCB_TABLE, element);
    if (e.length < 8) break;
    regions.push({ size: e.readUInt32BE(0), control: e[4] });
    covered += e.readUInt32BE(0);
  }
  return regions.length ? regions : null;
}

// Run the procedure's declared CompareProp pre-flights (the hardware/application check
// ETS performs before a download). Read-only; a mismatch aborts before any write.
async function runDeclaredChecks(dev: KnxDevice, coverage: ParCoverage): Promise<void> {
  for (const c of coverage.checks) {
    const { ok, got } = await compareDeclaredProp(dev, c.obj, c.pid, c.expect, c.mask);
    if (!ok) {
      throw new ProductError("LOAD_PROC_CHECK_FAILED",
        `load-procedure check failed: object ${c.obj} property ${c.pid} reads ${got.toString("hex")} but the application declares ${c.expect.toString("hex")} (wrong hardware or application version?)`);
    }
  }
}

// The outcome of a flash operation, as a discriminated union so honesty is
// compiler-enforced: a "flashed" result MUST state whether it verified. The old shape
// (`verified?: boolean`) treated a forgotten field as verified at the persistence
// boundary (baseline reset), which is exactly the fake-green class this codebase bans.
// `structural`: the result of a structural flash (flashStructure), which covers the parameters and
// the group tables together.
// `confirmedOnly`: the bytes of a verified flash the device does not give back when read, verified by
// its write confirmation alone (confirmedMatch); absent when the read-back shows every byte.
export type FlashResult = (
  | { kind: "unchanged"; mask: string; imageBytes: number; backup: string }
  | { kind: "dryRun"; mask: string; imageBytes: number; diffBytes: number; backup: string; imageDigest?: string }
  | { kind: "flashed"; mask: string; imageBytes: number; diffBytes: number; verified: boolean; backup: string; confirmedOnly?: ConfirmedOnlyRange[]; stamps?: ImageStamp[] }
) & { structural?: true };

// One element of a load-state machine's memory-control block (PID 27: size, CRC control, access, CRC),
// as the closing reads of a download that wrote the application's parameters returned it: ETS's record of
// that download (LdCtrlLoadImageProp). `stamps` on a flashed result: the record of this download; absent
// where the operation keeps none.
export interface ImageStamp { obj: number; element: number; hex: string }
const MCB_ELEMENT_BYTES = 8;
function stampCollector(): { stamps: ImageStamp[]; onRead: (obj: number, pid: number, start: number, data: Buffer) => void } {
  const stamps: ImageStamp[] = [];
  return {
    stamps,
    onRead: (obj, pid, start, data) => {
      if (pid !== PID.MCB_TABLE) return;
      if (data.length === 0 || data.length % MCB_ELEMENT_BYTES !== 0) throw new ProductError("STAMP_UNREADABLE", `object ${obj} answered its memory-control block from element ${start} with ${data.length} bytes, not whole 8-byte elements`);
      for (let k = 0; (k + 1) * MCB_ELEMENT_BYTES <= data.length; k++) stamps.push({ obj, element: start + k, hex: data.subarray(k * MCB_ELEMENT_BYTES, (k + 1) * MCB_ELEMENT_BYTES).toString("hex") });
    },
  };
}
// ETS's stamp check before a parameter download: it reads the stamps of the objects that hold the
// application (not the two group tables) and takes its differential download only where every one equals
// its record of its last download that wrote the parameters ("Differential Image Stamp does not match,
// falling back" otherwise: Theben MIX 2, whose firmware clears its download marker after the restart; a
// group-address download leaves the record as it was, Gira M-0008's revert).
// The unit's stamps as read now, null where the record holds none to compare.
// Only the regions ETS sends differentially count: their CRC-control byte (element byte 4) is 0. A region
// with another control byte is written whole whatever its stamp says (Theben DALI-Gateway: its com-object
// table, control 1, changed by a group-address download, and ETS's next parameter download still
// differential; Theben MIX 2, control 0 throughout, falls back).
export const checkedStamps = (record: ImageStamp[] | undefined): ImageStamp[] =>
  (record ?? []).filter((r) => r.obj !== OBJ.ADDR_TABLE && r.obj !== OBJ.ASSOC_TABLE && Buffer.from(r.hex, "hex")[4] === 0);
// `read`: every element of the record's application objects as the unit answers now, the checked ones and
// the others, so the regions of a segment are laid out from all of its elements.
async function currentStamps(dev: KnxDevice, record: ImageStamp[] | undefined): Promise<{ equal: boolean; read: ImageStamp[] } | null> {
  const checked = checkedStamps(record);
  if (!checked.length) return null;
  const read: ImageStamp[] = [];
  for (const r of (record ?? []).filter((x) => x.obj !== OBJ.ADDR_TABLE && x.obj !== OBJ.ASSOC_TABLE)) {
    const v = await dev.propRead(r.obj, PID.MCB_TABLE, r.element);
    if (v.length !== MCB_ELEMENT_BYTES) throw new ProductError("STAMP_UNREADABLE", `object ${r.obj} answered memory-control-block element ${r.element} with ${v.length} bytes, not 8`);
    read.push({ obj: r.obj, element: r.element, hex: v.toString("hex") });
  }
  return { equal: checked.every((c) => read.find((x) => x.obj === c.obj && x.element === c.element)?.hex === c.hex), read };
}
// The owned bytes a System B parameter flash writes: with the unit's stamps equal to the record, those
// that differ from the unit (`current`), region by region (differentialMask; `regions` as the application
// declares them, else as the unit's stamps report them); otherwise every owned byte.
export function relativeParWriteSet(image: Buffer, current: Buffer, owned: ReadonlyArray<number>, mcb: McbWrite[], check: { equal: boolean; read: ImageStamp[] } | null): ReadonlyArray<number> {
  if (!check?.equal) return owned;
  const unitRegions = check.read.filter((x) => x.obj === LSM).sort((a, b) => a.element - b.element)
    .map((x) => { const b = Buffer.from(x.hex, "hex"); return { size: b.readUInt32BE(0), control: b[4] }; });
  return differentialMask(changedOwned(image, current, owned), owned, declaredMcbRegions(mcb) ?? (unitRegions.length ? unitRegions : null));
}

// One prepared flash operation, handed to runFlashOp by a profile after it has read the
// device's current state and computed the diff. The profile supplies only the
// model-specific pieces; the safety-critical sequencing lives in runFlashOp.
interface FlashOp {
  imageBytes: number;
  // The full download's image (deviceflash.ts fullDownloadImageDigest), reported by its dry run so a
  // caller can check the plan it compared with the device is the one this server writes.
  imageDigest?: string;
  diffBytes: number;
  backup: string;                                 // representative path reported in the result
  backups: { file: string; bytes: Buffer }[];     // on-disk copies of the device's CURRENT state
  write: () => Promise<void>;                     // the model-specific download (device restarts after)
  // The application's <Options SupportsExtendedMemoryServices>: which memory write service the device
  // takes (KnxDevice.setExtendedMemoryServices). Required, so no write path can leave it to the device.
  extendedMemory: boolean;
  // Post-restart read-back comparison. A byte it accepts on the device's write confirmation alone goes
  // into `confirmedOnly` (see confirmedOnlyMatch).
  verify: (confirmedOnly: ConfirmedOnlyRange[]) => Promise<boolean>;
  // A load-state machine this operation concerns is not LOADED (an interrupted earlier write left it
  // Loading, say), so equal bytes are no proof the device runs them. "rewrite": the bracket always
  // covers it, so run it even without a diff and let it finish the load. "refuse": the plan brackets
  // only what differs and could leave it as it is, with or without a diff.
  loadIncomplete?: "rewrite" | "refuse";
  // Filled by `write` with the closing stamp reads of a download that writes the parameters (ImageStamp).
  stamps?: ImageStamp[];
}

// A device that has just rebooted can still be starting its application and drop management frames
// for a while (the OpenKNX RaumController went silent 9 KB into the 21.6 KB read-back, the write
// itself committed and LOADED, 2026-09-27). One lost read is not a verdict on the write: reconnect and
// read once more; a second silence is reported as it is.
async function verifyAfterRestart(dev: KnxDevice, verify: () => Promise<boolean>): Promise<boolean> {
  try { return await verify(); }
  catch (e) {
    // A garbled secured frame, the device closing the link, or an interface reporting the device did
    // not acknowledge (still booting) is no verdict on the write either.
    const code = (e as { code?: string }).code;
    if (code !== "DEVICE_NOT_ANSWERING" && code !== "DEVICE_CLOSED_CONNECTION" && code !== "SECURE_ANSWER_REJECTED" && code !== "BUS_SEND_FAILED" && !isLinkError(e)) throw e;
    try { await dev.disconnect(); } catch { /* the link may already be gone */ }
    await reconnectAfterRestart(dev, { initialMs: 5000, linkDown: isLinkError(e) });
    return verify();
  }
}

// The one flash sequence every memory model runs: persist the backups, short-circuit an
// unchanged device and a dry run, write, reconnect across the device's restart, verify.
// Centralized so the invariants (backup BEFORE any write, verify AFTER the restart,
// a "flashed" result always carrying a real verified flag) hold structurally for every
// current and future profile instead of by convention in four hand-rolled copies.
async function runFlashOp(
  dev: KnxDevice, mask: string,
  ctx: { dryRun: boolean; persistBackups: PersistBackups } & WriteGate,
  op: FlashOp,
): Promise<FlashResult> {
  if (ctx.signal?.aborted) throw new ProductError("READ_ABORTED", "read aborted");
  // Persisting the device's current state is the FIRST step, structurally before any
  // write; the hook is injected (the server stores files on disk) so this layer stays
  // filesystem-free and the ordering is testable with a plain recording stub.
  const backup = ctx.persistBackups(op.backups, op.backup);
  if (op.loadIncomplete === "refuse") {
    throw new ProductError("DEVICE_LOAD_INCOMPLETE", "a load-state machine this flash concerns is not LOADED (an earlier write was interrupted), and this flash brackets only what differs, so it could leave it that way; a full download completes the load");
  }
  if (op.diffBytes === 0 && !op.loadIncomplete) return { kind: "unchanged", mask, imageBytes: op.imageBytes, backup };
  if (ctx.dryRun) return { kind: "dryRun", mask, imageBytes: op.imageBytes, diffBytes: op.diffBytes, backup, ...(op.imageDigest ? { imageDigest: op.imageDigest } : {}) };
  // Everything before this line only read the device; from here on the write runs to its end.
  ctx.beforeWrite?.();
  dev.clearConfirmedWrites();
  dev.setExtendedMemoryServices(op.extendedMemory);
  await op.write();
  await reconnectAfterRestart(dev);
  const confirmedOnly: ConfirmedOnlyRange[] = [];
  const verified = await verifyAfterRestart(dev, () => { confirmedOnly.length = 0; return op.verify(confirmedOnly); });
  return { kind: "flashed", mask, imageBytes: op.imageBytes, diffBytes: op.diffBytes, verified, backup, ...(verified && confirmedOnly.length ? { confirmedOnly } : {}), ...(op.stamps ? { stamps: op.stamps } : {}) };
}

// The read-back check of a segment read at `at` against the bytes it should hold, accepting the bytes
// the device does not give back where this operation's confirmed writes cover them (confirmedMatch).
// `before`: the segment as read before the operation, null where the operation did not read it (then
// every byte has to read back as written). The accepted runs are added to `confirmedOnly` once the
// returned check is the one the verify settles on (see settledMatch).
function confirmedOnlyMatch(dev: KnxDevice, at: number, want: Buffer, mask: ReadonlyArray<number | boolean>, before: Buffer | null) {
  return (back: Buffer) => confirmedMatch(back, want, mask, at, dev.confirmedWrites(), before);
}
function settledMatch(runs: ConfirmedOnlyRange[] | null, confirmedOnly: ConfirmedOnlyRange[]): boolean {
  if (runs === null) return false;
  confirmedOnly.push(...runs);
  return true;
}

const structural = async (r: Promise<FlashResult>): Promise<FlashResult> => ({ ...(await r), structural: true });

// The programmed-baseline read back off the bus (see readState). `paramBase` is sparse like
// device_parameters; the caller persists only the aspects whose *Read flag is true.
// `deviceConfig` is the configuration the read converged on: the project's values with the
// device's own value for every parameter active in its image. It is what the device numbers its
// com-objects by; parameters without a memory offset carry the project's value, since the device
// cannot show them. Absent when the parameters were not read or no configuration was supplied.
export interface DeviceReadback { mask: string; paramsRead: boolean; linksRead: boolean; paramBase: Map<string, string>; links: ComObjectLink[]; deviceConfig?: Map<string, string>; }

// DeviceCapabilities lives in config.ts (the lower module) so the wire view can carry it without a
// cycle; re-exported here (imported above) because it is the return type of capabilities().
export type { DeviceCapabilities };

export interface ReadStateCtx {
  liveParams: Map<string, string>;
  // The programmed baseline as it stands BEFORE this read. Refs the device's memory image
  // does not encode (parameters with no memory offset, e.g. a channel-count parameter that
  // only ever lived in the project) cannot be observed on the bus, so the read must leave
  // their baseline alone. Seeding the baseline from the LIVE values instead would adopt an
  // unflashed edit as "programmed" purely because the device cannot contradict it, which is
  // the fake-green this whole layer exists to prevent. Omitted => same as live (import time).
  baseParams?: Map<string, string>;
  moduleInstances?: ModuleInstance[];
  // The config view for a given set of values: the param refs it shows, and the refs active in the
  // image. Drift is recorded only for refs the project's or the device's configuration shows
  // (deviceRelevantRefs); omitted => every decodable ref.
  configFor?: (values: Map<string, string>) => { shown: Set<string>; active: Set<string> };
  onProgress?: ProgressFn;
  signal?: AbortSignal;
}
// Persist the pre-flash device-state backups somewhere durable and return the
// representative path/name reported in the FlashResult. Injected by the caller (the
// server writes .bin files under the project's backup dir); called by runFlashOp
// BEFORE any write reaches the device.
export type PersistBackups = (files: { file: string; bytes: Buffer }[], representative: string) => string;

// A flash reads the device before it writes anything. `signal` cancels that read-only part;
// `beforeWrite` runs once, right before the first write, and may throw to stop there (a task cancelled
// in time). After it the write is never interrupted by the signal.
export interface WriteGate { signal?: AbortSignal; beforeWrite?: () => void }

export interface ParamFlashCtx extends WriteGate {
  deviceId: string; // used in backup file names
  appXml: string;
  params: Map<string, string>;
  // The programmed baseline: the parameter set the device was last programmed with, hence the
  // one its (kept-from-device) com-object table was compiled for. REQUIRED, not optional: a
  // caller that forgot it would silently disable the com-object staleness gate, and a safety
  // gate that can be switched off by omission is not a gate. See comobjtable.ts.
  baseParams: Map<string, string>;
  moduleInstances?: ModuleInstance[];
  dryRun: boolean;
  onProgress?: ProgressFn;
  persistBackups: PersistBackups;
  // The stamps of the device's last download that wrote its parameters (ImageStamp), the record ETS
  // keeps; absent where there is none.
  stampRecord?: ImageStamp[];
}
// Commissioning a device from nothing needs everything at once: the parameters AND the links,
// because the com-object table it writes has to agree with the association table it writes.
export interface FullDownloadCtx extends WriteGate {
  deviceId: string;
  ia: string; // the device's individual address; the System 7 address table stores it, so the plan needs it
  appXml: string;
  params: Map<string, string>;
  links: ComObjectLink[];
  moduleInstances?: ModuleInstance[];
  // The device's own com-object flags and priority set in the project, by object number
  // (comobjbuild.ts withInstanceOverrides), laid over the application's wherever the com-object table
  // is authored. Absent: the project sets none.
  comObjectOverrides?: ReadonlyMap<number, ComObjInstanceOverride>;
  dryRun: boolean;
  // Read and persist the device's CURRENT memory to .bin files BEFORE the unload/rewrite destroys it,
  // as a recovery copy for a full download that lands on a device holding a configuration we cannot
  // reproduce (e.g. one programmed by ETS, never imported). OFF by default: on a full download every
  // written byte is derived from the project, so the image is reproducible and the backup's payoff is
  // narrow, while reading the whole parameter segment back (~1800 TP round trips, minutes) dominates the
  // wall-clock. The backup PATH stays fully implemented and tested; this only gates whether it runs, so
  // a future UI can offer "back up before commissioning" for the ETS-migration case. See
  // docs/load-procedures.md and docs/roadmap.md.
  backupBeforeUnload?: boolean;
  // Present exactly when the device runs KNX Data Secure: the project's group keys, by address.
  security?: SecureTablesCtx;
  onProgress?: ProgressFn;
  persistBackups: PersistBackups;
}
// A Data Secure device's group-address tables come with its security object (group keys and
// per-object flags), which every write of those tables reloads.
// senders: per group address, the individual addresses the project assigns as its senders;
// otherDevices: per group address, the other devices of the project linked to it (both feed the
// device's security individual address table, see buildSecurityObject). Both absent means none.
export interface SecureTablesCtx {
  groupKeys: ReadonlyMap<number, Buffer>;
  senders?: ReadonlyMap<number, readonly number[]>;
  otherDevices?: ReadonlyMap<number, readonly OtherDevice[]>;
}
const secureSenders = (sec: SecureTablesCtx, ia: string) => ({ byGa: sec.senders ?? new Map(), ownIa: iaToNum(ia), otherDevices: sec.otherDevices ?? new Map<number, OtherDevice[]>() });
export interface GaFlashCtx extends WriteGate {
  deviceId: string; // used in backup file names
  ia: string;
  links: ComObjectLink[];
  // The com-object staleness gate applies here too, and for the same reason: `links` carries the
  // com-object NUMBERS of the live configuration, while the device's com-object table is still
  // the one it was last programmed with. Writing an association onto an object number that table
  // does not configure wires the group address to nothing, and the verify (which only re-reads
  // the tables we wrote) would still report success. Both maps are REQUIRED, like ParamFlashCtx.
  params: Map<string, string>;
  baseParams: Map<string, string>;
  moduleInstances?: ModuleInstance[];
  // The device's own com-object flags and priority set in the project, by object number
  // (comobjbuild.ts withInstanceOverrides), laid over the application's wherever the com-object table
  // is authored. Absent: the project sets none.
  comObjectOverrides?: ReadonlyMap<number, ComObjInstanceOverride>;
  dryRun: boolean;
  security?: SecureTablesCtx;
  onProgress?: ProgressFn;
  persistBackups: PersistBackups;
}

// A change that alters the com-object table, written without a full download: the parameters, the
// com-object table those parameters and links imply, and the group tables, in one bracket. It needs
// what a full download needs, and it reads the device first like the surgical flashes.
export interface StructureFlashCtx extends WriteGate {
  deviceId: string;
  ia: string;
  appXml: string;
  params: Map<string, string>;
  // The programmed baseline: on System 7 a parameter active there and not in `params` goes back to its
  // template value (absoluteStructuralImages). Required, like ParamFlashCtx.baseParams.
  baseParams: Map<string, string>;
  links: ComObjectLink[];
  moduleInstances?: ModuleInstance[];
  // The device's own com-object flags and priority set in the project, by object number
  // (comobjbuild.ts withInstanceOverrides), laid over the application's wherever the com-object table
  // is authored. Absent: the project sets none.
  comObjectOverrides?: ReadonlyMap<number, ComObjInstanceOverride>;
  dryRun: boolean;
  security?: SecureTablesCtx;
  onProgress?: ProgressFn;
  persistBackups: PersistBackups;
}

// What a full download needs to build its image; the device-independent part of FullDownloadCtx.
export interface FullDownloadInputs {
  ia: string;
  params: Map<string, string>;
  links: ComObjectLink[];
  moduleInstances?: ModuleInstance[];
  proc: LoadProcedures;
  security?: SecureTablesCtx;
  // The device's own com-object flags and priority set in the project, by object number
  // (comobjbuild.ts withInstanceOverrides), laid over the application's wherever the com-object table
  // is authored. Absent: the project sets none.
  comObjectOverrides?: ReadonlyMap<number, ComObjInstanceOverride>;
  // The unit holds this application, loaded (program id equal, load-state machines 1-3 LOADED). On a
  // System 7 application declaring PreferPartialDownloadIfApplicationLoaded it selects ETS's partial form
  // of the full download (deviceflash.ts absoluteFullForm). On a System B application declaring it, the
  // unit holds it when its application object is LOADED with this program id, and the download takes
  // ETS's partial form (planRelativePartialFullDownload), which needs `unitMemory`.
  // Absent: not known to hold it.
  unitHoldsApplication?: boolean;
  unitMemory?: RelativeUnitMemory;
}
// What a System B unit holding the application has in its application segment and com-object table,
// read before the partial form: the bytes, where each segment is, and the memory-control-block regions
// (PID 27) each reports, null where it reports none.
export interface RelativeUnitMemory { params: Buffer; paramsAt: number; paramsMcb: McbRegion[] | null; comObj: Buffer; comObjAt: number; comObjMcb: McbRegion[] | null }
// One segment a full download writes. `address` is null where the device assigns it (a System B
// relative segment, allocated during the download); `fillByte` is set where the allocation pre-fills
// the segment, so the bytes of `image` equal to it are not transmitted but are still the segment's content.
export interface FullDownloadSegment {
  id: string;
  lsm: number;
  source: AbsFullSegment["source"];
  address: number | null;
  image: Buffer;
  fillByte?: number;
}
// A full download, planned without touching the device: the load plan and every segment's image.
export interface FullDownloadBuild { plan: LoadPlan; segments: FullDownloadSegment[]; imageBytes: number; }

// An operation a device's memory model does not implement. Carries an ProductError code so the
// HTTP layer surfaces an honest "unsupported" rather than a 500.
export class UnsupportedOperation extends ProductError {
  constructor(op: string, family: SystemFamily, mask: string) {
    super("DEVICE_FAMILY_UNSUPPORTED", `${op} is not supported for ${family} devices (mask ${mask}); this device family is recognised but not yet implemented`);
  }
}

// The System B image model: the device's module instances materialised, and top-level union
// members kept. It must be the SAME model buildRelativeSegmentTarget builds from, because it
// is what read-back decodes with and what the flash guard tests stored values against; a model
// that is narrower than the builder decodes nothing at the offsets the builder writes (a union
// byte would be flashed and then read back as "no drift" whatever the device holds).
function moduleAwareModel(cfg: AppConfig, params: Map<string, string>, provided: ModuleInstance[]): { model: AppModel; instances: ModuleInstance[] } {
  const instances = cfg.hasModules ? (provided.length ? provided : resolveModuleInstances(cfg, params)) : [];
  return { model: toAppModel(cfg, { includeUnions: true, instances }), instances };
}

// Group-table readers (readGroupTables / readGroupTablesMv0705) live in @busforge/knx
// (grouptable-read.ts) next to the layout descriptors the product codec is asserted
// against, so the byte layout has one home instead of a copy per layer.

// ─────────────────────────────────────────────────────────────────────────────

export abstract class DeviceProfile {
  abstract readonly memoryModel: MemoryModel;
  abstract readonly family: SystemFamily;
  // Whether a Data Secure device of this model gets its security object loaded with its group
  // tables (group-address flash and full download); where not, those writes refuse a secure device.
  readonly loadsSecurityObject: boolean = false;
  constructor(readonly mask: string, protected readonly cfg: AppConfig | null) {}

  // Capabilities are a function of the memory model + parsed application alone; they
  // deliberately take NO live parameter state (every implementation ignored it, and the
  // callers paid two DB reads per call to feed it).
  abstract capabilities(): DeviceCapabilities;
  // Why capabilities() withholds a write the profile would otherwise offer, where the application
  // itself is the reason (its declared load procedure, the tables a write would have to touch).
  operationRefusals(): OperationRefusals { return {}; }
  // Whether this profile's full download loads the application into a device that does not hold it
  // (a factory device, another application, or one a broken-off write left unloaded), so it is the
  // way back for such a device. Where it is false, ETS is.
  fullDownloadLoadsApplication(): boolean { return this.capabilities().fullDownload; }
  abstract readState(dev: KnxDevice, mask: string, ctx: ReadStateCtx): Promise<DeviceReadback>;
  abstract flashParameters(dev: KnxDevice, mask: string, ctx: ParamFlashCtx): Promise<FlashResult>;
  abstract flashGroupTables(dev: KnxDevice, mask: string, ctx: GaFlashCtx): Promise<FlashResult>;

  // Commission the device from nothing. Default: refuse. A memory model that has not been proven
  // to survive a full download must not fall through into one, because a half-written download
  // leaves a device that answers nothing and has to be recovered by hand.
  async downloadFull(_dev: KnxDevice, _mask: string, _ctx: FullDownloadCtx): Promise<FlashResult> {
    throw new UnsupportedOperation("full download", this.family, this.mask);
  }

  // Write a change that alters the com-object table without a full download. Default: refuse, as
  // capabilities().structuralFlash says.
  async flashStructure(_dev: KnxDevice, _mask: string, _ctx: StructureFlashCtx): Promise<FlashResult> {
    throw new UnsupportedOperation("structural flash", this.family, this.mask);
  }

  // The image and load plan downloadFull writes, built offline. The same refusals apply; the
  // device-side pre-flight (declared property checks) is downloadFull's, not part of the plan.
  planFullDownload(_mask: string, _inputs: FullDownloadInputs): FullDownloadBuild {
    throw new UnsupportedOperation("full download", this.family, this.mask);
  }

  protected requireCfg(op: string): AppConfig {
    if (!this.cfg) throw new ProductError("APP_PROGRAM_MISSING", `${op} needs the application program but it was not provided`);
    return this.cfg;
  }
}

// System B (relative-segment) devices: MV-07B0 and its medium variants. Parameters live in a
// relative LSM4 segment (surgical owned-byte download); group tables use the count-prefixed
// System B layout. Hardware-proven (read and flash, on twisted pair).
export class SystemBProfile extends DeviceProfile {
  readonly memoryModel = "relative" as const;
  override readonly loadsSecurityObject = true;
  constructor(readonly family: SystemFamily, mask: string, cfg: AppConfig | null) { super(mask, cfg); }

  capabilities(): DeviceCapabilities {
    // Parameters are decoded from the LSM4 segment; a relative device WITHOUT one has nowhere
    // to read them from, so don't claim its params verify. Group tables are always present.
    const hasParamSegment = this.hasParamSegment();
    const refused = this.operationRefusals();
    return {
      readParams: hasParamSegment, readLinks: true, flashParams: !refused.flashParams, flashLinks: !refused.flashLinks,
      fullDownload: this.fullDownloadOffered() && !refused.fullDownload,
      structuralFlash: hasParamSegment && !!this.cfg && structuralFlashCaptured(this.cfg) && !declaresTunnelingEntries(this.cfg) && !refused.flashParams && !refused.flashLinks,
    };
  }

  // Both downloads run the mask's base bracket parameterized by the application's fragments, so a
  // fragment step without a disposition refuses the parameter flash and the full download alike. The
  // procedure is checked before the tunnelling entries, so it is the reason given where both apply.
  // The group-address flash refuses a step named for it ("grp" or "all") that it does not run.
  override operationRefusals(): OperationRefusals {
    if (!this.cfg) return {};
    const par = parRefusal(assessParCoverage(this.cfg.loadProcedures, "relative"), "parameter download");
    const grp = parRefusal({ blocked: unrunGrpSteps(this.cfg.loadProcedures), skipped: [], checks: [] }, "group-address flash");
    return {
      ...(par ? { flashParams: par, ...(this.hasParamSegment() ? { fullDownload: par } : {}) } : {}),
      ...(grp ? { flashLinks: grp } : {}),
    };
  }

  private hasParamSegment(): boolean {
    return this.cfg ? toAppModel(this.cfg).segments.some((s) => s.lsm === LSM) : false;
  }

  // A full download needs the parameter segment to fill AND an application to author the
  // com-object table from; without either there is nothing to commission.
  private fullDownloadOffered(): boolean {
    return this.hasParamSegment() && !!this.cfg && !declaresTunnelingEntries(this.cfg);
  }

  planFullDownload(mask: string, inputs: FullDownloadInputs): FullDownloadBuild {
    if (inputs.proc.preferPartialIfLoaded && inputs.unitHoldsApplication) {
      const { plan, segments, imageBytes } = this.planSystemBPartial(inputs);
      return { plan, segments, imageBytes };
    }
    return this.planSystemBFull(mask, inputs);
  }

  private planSystemBFull(_mask: string, ctx: FullDownloadInputs): FullDownloadBuild & { target: RelativeSegmentTarget; comObj: Buffer; addr: Buffer; assoc: Buffer; security?: SecurityObjectTables } {
    const cfg = this.requireCfg("full download");
    const proc = ctx.proc;
    assertParCoverage(proc, "relative");
    refuseTunnelingEntries(cfg);
    // What the application wants the parameter segment pre-filled with (0 for most, 0xFF for e.g. the
    // GVS AMMA). Threaded into the plan so the allocation and the bytes left out agree with it. Every
    // captured application declares the filled allocation (Mode 1) for its full download, and an
    // application declaring no allocation gets it with fill 0. No capture shows what ETS writes into
    // an unfilled one.
    const mode = relParamFullMode(proc);
    if (mode !== undefined && mode !== "1") {
      throw new ProductError("FULL_DOWNLOAD_STEP_UNSUPPORTED", `the full download allocates the parameter segment with LdCtrlRelSegment Mode=${mode}; no ETS capture shows which bytes a download writes into a segment allocated so`);
    }
    const fillByte = relParamFillByte(proc);
    const { target, comObj, addr, assoc, security } = this.systemBImages(cfg, ctx);

    // Whether the closing A_Restart must prove a reboot. thelsing/knx persists ON the restart, so a
    // device that does not reboot lost the download; other firmware persists at LoadCompleted and
    // never goes silent (see PERSIST_ON_LOAD_COMPLETED). Default true keeps the safe behavior.
    const requireReboot = !persistsOnLoadCompleted(cfg);
    // The mask's full download unloads the PEI program first (MV-07B0 Load ap1); the application's
    // secure procedure closes with the confirmed restart (IsSecureEnabled), the plain one with A_Restart.
    const plan = withClosing(withConfirmedRestart(planSystemBFullDownload({
      params: target.bytes, paramsInImage: fullDownloadImageCoverage(cfg, target.owned), comObj, addr, assoc, programId: programIdStamp(cfg),
    }, fillByte, requireReboot, declaredMcbWrites(proc, target.size), security, true, closesAtOnce(cfg)), proc.secureEnabled), proc, "full");
    const imageBytes = target.size + comObj.length + addr.length + assoc.length;

    return {
      plan, imageBytes, target, comObj, addr, assoc, security,
      segments: [
        { id: "L4 parameter segment", lsm: LSM, source: "params", address: null, image: target.bytes, fillByte },
        { id: "L3 com-object table", lsm: OBJ.COMOBJ_TABLE, source: "comObjTable", address: null, image: comObj },
        { id: "L2 association table", lsm: OBJ.ASSOC_TABLE, source: "assocTable", address: null, image: assoc },
        { id: "L1 address table", lsm: OBJ.ADDR_TABLE, source: "addrTable", address: null, image: addr },
      ],
    };
  }

  // ETS's partial form of the full download (planRelativePartialFullDownload), against what the unit
  // holds (`ctx.unitMemory`). The application segment's image is the unit's segment with the owned bytes
  // of this configuration laid over it, so what no parameter owns stays as the unit holds it.
  private planSystemBPartial(ctx: FullDownloadInputs): FullDownloadBuild & { params: Buffer; target: RelativeSegmentTarget; comObj: Buffer; addr: Buffer; assoc: Buffer; security?: SecurityObjectTables; changedBytes: number } {
    const cfg = this.requireCfg("full download");
    const proc = ctx.proc;
    assertParCoverage(proc, "relative");
    refuseTunnelingEntries(cfg);
    const unit = ctx.unitMemory;
    if (!unit) {
      throw new ProductError("FULL_DOWNLOAD_UNIT_UNKNOWN", "the unit holds this application, so the download takes ETS's partial form, which writes only what the unit does not hold; it cannot be planned without the unit's application segment and com-object table");
    }
    const { target, comObj, addr, assoc, security } = this.systemBImages(cfg, ctx);
    const unitSize = unit.paramsMcb ? unit.paramsMcb.reduce((n, r) => n + r.size, 0) : unit.params.length;
    if (unit.params.length !== target.size || unitSize !== target.size) {
      throw new ProductError("FULL_DOWNLOAD_UNIT_LAYOUT", `the unit's application segment is ${unitSize} B where this application's is ${target.size} B; refusing to merge into a segment of another layout`);
    }
    const { image } = mergeRelativeTarget(unit.params, target);
    // The application's regions as the application declares them (written again after its allocation),
    // else as the unit reports them; the com-object table's as the unit reports them (differentialMask).
    const mcb = declaredMcbWrites(proc, target.size);
    const paramsWrite = differentialMask(changedOwned(image, unit.params, target.owned), target.owned, declaredMcbRegions(mcb) ?? unit.paramsMcb);
    const comObjWrite = differentialMask(differingBytes(comObj, unit.comObj), new Array<number>(comObj.length).fill(0xff), unit.comObjMcb);
    const writes = (m: number[]) => m.filter((x) => x !== 0).length;
    const plan = withClosing(withConfirmedRestart(planRelativePartialFullDownload(LSM, {
      params: writes(paramsWrite) ? { image, owned: paramsWrite, keptAt: unit.paramsAt } : null,
      comObj: writes(comObjWrite) ? { image: comObj, owned: comObjWrite, keptAt: unit.comObjAt } : null,
      addr, assoc,
    }, programIdStamp(cfg), !persistsOnLoadCompleted(cfg), mcb, security), proc.secureEnabled), proc, "full");
    const changedBytes = writes(paramsWrite) + writes(comObjWrite) + addr.length + assoc.length;
    return {
      plan, imageBytes: image.length + comObj.length + addr.length + assoc.length, params: image, target, comObj, addr, assoc, security, changedBytes,
      segments: [
        { id: "L4 parameter segment", lsm: LSM, source: "params", address: unit.paramsAt, image },
        { id: "L3 com-object table", lsm: OBJ.COMOBJ_TABLE, source: "comObjTable", address: unit.comObjAt, image: comObj },
        { id: "L2 association table", lsm: OBJ.ASSOC_TABLE, source: "assocTable", address: null, image: assoc },
        { id: "L1 address table", lsm: OBJ.ADDR_TABLE, source: "addrTable", address: null, image: addr },
      ],
    };
  }

  // The images a full download writes, in either form: the parameter target, the com-object table
  // authored for this configuration and its links, both group tables and, on a Data Secure device, the
  // security object.
  private systemBImages(cfg: AppConfig, ctx: FullDownloadInputs): { target: RelativeSegmentTarget; comObj: Buffer; addr: Buffer; assoc: Buffer; security?: SecurityObjectTables } {
    const { model, instances } = moduleAwareModel(cfg, ctx.params, ctx.moduleInstances ?? []);
    const unmapped = unmappedParamRefs(model, ctx.params);
    if (unmapped.length) {
      throw new ProductError("CHANNEL_MODULES_UNSUPPORTED",
        `${unmapped.length} stored value(s) cannot be placed in this device's parameter image (e.g. ${unmapped[0]}); refusing to commission a device with a configuration we cannot express`);
    }

    // In the full form the download owns the whole segment: every byte we do not derive is the
    // allocation's fill. The partial form merges the owned bytes into the unit's segment.
    const target = buildRelativeSegmentTarget(cfg, ctx.params, LSM, { moduleInstances: instances, ownIdleUnionDefaults: true });
    if (!target || target.size === 0) throw new ProductError("EMPTY_IMAGE", "built an empty parameter image; refusing to download");

    const view = buildDeviceConfig(cfg, ctx.params, undefined, instances);
    // A link whose com-object this configuration does not activate cannot be programmed: the
    // association table would point a group address at an entry that reads 0x0000, i.e. at an
    // object that does not communicate. Filtering such a link away and carrying on would leave the
    // user with a group address the UI calls programmed and the device ignores. Refuse.
    const active = new Set(view.imageComObjects.keys());
    const orphans = ctx.links.filter((l) => !active.has(l.comObjNum));
    if (orphans.length) {
      throw new ProductError("LINK_COM_OBJECT_INACTIVE",
        `${orphans.length} group-address link(s) target communication objects this configuration does not activate (e.g. #${orphans[0].comObjNum}); the device would ignore them, so refusing to report them as programmed`);
    }
    // The linked objects are exactly those the association table connects; ETS clears the
    // Communication flag on every other object, so the com-object table build needs to know them.
    const linked = new Set(ctx.links.map((l) => l.comObjNum));
    const comObj = buildComObjectTable(withInstanceOverrides(view.imageComObjects, ctx.comObjectOverrides), view.maxComObjectNumber, linked);
    const { addr, assoc } = buildGroupTables(ctx.links);
    const security = ctx.security ? buildSecurityObject(ctx.links, comObj.readUInt16BE(0), ctx.security.groupKeys, secureSenders(ctx.security, ctx.ia)) : undefined;
    return { target, comObj, addr, assoc, security };
  }

  // Commission a System B device from nothing: write the application id, the parameter image, the
  // com-object table and the two group tables in ONE bracket, in the order the mask's own load
  // procedure prescribes (see planSystemBFullDownload).
  //
  // Unlike every other write in this codebase, this one AUTHORS the com-object table instead of
  // keeping the device's: a virgin device has no table to keep. That is the whole point, and it is
  // also the risk, because the firmware validates nothing it is given (see comobjbuild.ts). So the
  // table is built from the same active-configuration projection the read-back and the staleness
  // gate use, and the result is verified by reading it back off the device afterwards.
  async downloadFull(dev: KnxDevice, mask: string, ctx: FullDownloadCtx): Promise<FlashResult> {
    // The device's own declared pre-flight (hardware type / application id) still runs: a full
    // download to the wrong hardware is the most expensive mistake available here.
    const proc = parseLoadProcedures(ctx.appXml);
    const coverage = assertParCoverage(proc, "relative");
    refuseTunnelingEntries(this.requireCfg("full download"));
    await runDeclaredChecks(dev, coverage);
    // Which form ETS runs: an application declaring PreferPartialDownloadIfApplicationLoaded on a unit
    // holding it takes the partial form. ETS tells by the application object's load state and program
    // id (Jung 400021SE, Theben DALI-Gateway captures). The partial form keeps what the unit holds, so
    // Busforge also wants the three tables LOADED and the application segment at this application's
    // size (its memory-control block, PID 27); a unit that is not, which no capture shows ETS on, gets
    // the full form, which rewrites every object. So do the two firmware stacks hardware-shown not to
    // take the structural bracket this form is made of (STRUCTURAL_FLASH_CAPTURED above).
    if (proc.preferPartialIfLoaded && closesAtOnce(this.requireCfg("full download")) && !persistsOnLoadCompleted(this.requireCfg("full download"))) {
      const cfg = this.requireCfg("full download");
      const id = await dev.propRead(OBJ.APP_PROGRAM, PID.PROGRAM_ID);
      if (id.equals(programIdStamp(cfg)) && await allLoaded(dev, [OBJ.APP_PROGRAM, OBJ.COMOBJ_TABLE, OBJ.ASSOC_TABLE, OBJ.ADDR_TABLE])) {
        const size = this.systemBImages(cfg, { ...ctx, proc }).target.size;
        const paramsMcb = await readMcbRegions(dev, LSM, size);
        if (paramsMcb && paramsMcb.reduce((n, r) => n + r.size, 0) === size) return this.downloadPartialForm(dev, mask, ctx, proc, size, paramsMcb);
      }
    }
    const { plan, imageBytes, target, comObj, addr, assoc, security, segments } = this.planSystemBFull(mask, { ...ctx, proc });
    // A full download UNLOADS every segment before it rewrites them, so whatever the device held is
    // gone the moment it starts. A virgin device holds nothing (its load-state machines point at
    // address 0) and there is genuinely nothing to save. A device that was already programmed, by
    // ETS or by us, holds bytes we may not be able to reproduce, and destroying them without a copy
    // is not something this codebase does anywhere else.
    const stamp = Date.now();
    const backups: { file: string; bytes: Buffer }[] = [];
    // The pre-unload backup is OFF by default (ctx.backupBeforeUnload): reading the whole parameter
    // segment back is minutes of bus traffic to preserve bytes a full download reproduces from the
    // project anyway. The whole read stays here, gated, so it can be turned back on (a future UI for
    // the ETS-migration case). See FullDownloadCtx.backupBeforeUnload.
    if (ctx.backupBeforeUnload) {
      ctx.onProgress?.("backup");
      // Sizes first, bytes second. Reading the parameter segment back is ~1800 twelve-byte round
      // trips over TP, i.e. minutes; without a done/total the phase reports 0/0 for all of it and is
      // indistinguishable from a hang. It was mistaken for one. Sum the work before doing it so the
      // progress is against a real total.
      const segs: { obj: number; what: string; at: number; size: number }[] = [];
      for (const [obj, what] of [[LSM, "params"], [OBJ.COMOBJ_TABLE, "comobj"], [OBJ.ASSOC_TABLE, "assoc"], [OBJ.ADDR_TABLE, "addr"]] as [number, string][]) {
        const at = await dev.tableAddr(obj);
        if (at === 0) continue; // never loaded: there is nothing there to lose
        // Size the backup from the DEVICE's own loaded segment, never from the image we are about to
        // write. A device programmed (by ETS or by us) with a LARGER parameter segment than our new
        // image has a tail the unload is about to destroy; sizing this backup by `target.size` would
        // silently omit exactly those bytes and produce a "backup" that cannot restore what it
        // replaced. The parameter segment reports its loaded size in its MCB (PID_MCB_TABLE); the
        // group tables report theirs in their count header. If either cannot be determined, refuse the
        // whole download rather than back up a guessed length.
        let size: number;
        if (obj === LSM) {
          const mcb = await readSegmentCrc(dev, LSM);
          if (mcb === null || mcb.size === 0) {
            throw new ProductError("SEGMENT_SIZE_UNKNOWN",
              `the device will not report the size of its loaded parameter segment (PID_MCB_TABLE); refusing the full download rather than back up a guessed length and let the unload destroy the remainder`);
          }
          size = mcb.size;
        } else {
          size = await tableByteLength(dev, obj, at);
        }
        segs.push({ obj, what, at, size });
      }
      const backupTotal = segs.reduce((n, s) => n + s.size, 0);
      let backupDone = 0;
      for (const s of segs) {
        const bytes = await dev.memRead(s.at, s.size, undefined, (d) => ctx.onProgress?.("backup", backupDone + d, backupTotal), ctx.signal);
        backupDone += s.size;
        backups.push({ file: `${ctx.deviceId}-full-${stamp}-${s.what}.bin`, bytes });
      }
    }

    const fullStamps = stampCollector();
    return runFlashOp(dev, mask, ctx, {
      extendedMemory: this.requireCfg("full download").loadProcedures.extendedMemoryServices,
      imageBytes,
      imageDigest: fullDownloadImageDigest(segments),
      // Everything is written: a full download owns every byte of every segment, so there is no
      // meaningful diff against what was there (and on a virgin device there was nothing).
      diffBytes: imageBytes,
      backup: `${ctx.deviceId}-full-${stamp}`,
      backups,
      stamps: fullStamps.stamps,
      write: async () => {
        await runLoadPlan(dev, plan, { onWrite: (d, t) => ctx.onProgress?.("write", d, t), onRead: fullStamps.onRead });
      },
      // The firmware accepts any bytes it is handed (it validates nothing on LoadCompleted), so
      // this read-back is the ONLY thing standing between a wrong table and a device that silently
      // mis-communicates. The three tables are small and are compared byte for byte. The parameter
      // image is 21601 bytes, i.e. 1800 memory reads, so it is checked against the CRC the device
      // itself computes over the loaded segment (PID_MCB_TABLE) instead: the very thing the
      // device's own load procedure declares `LdCtrlLoadImageProp ObjIdx=4 PropId=27` for.
      //
      // If the device declines to report a CRC, that is NOT a pass: fall back to reading the whole
      // segment. Slow, but the alternative would be calling a download verified because we could
      // not check it.
      verify: async () => {
        ctx.onProgress?.("verify");
        // The device reports its segment CRC via PID_MCB_TABLE, but which CRC-16 convention it uses
        // is firmware-specific: thelsing/knx (OpenKNX) augments the CCITT CRC with 16 zero bits,
        // other System B firmware (GVS K-BUS) does not. Both are legitimate; accept EITHER. Only when
        // the reported CRC matches neither convention (or the device reports none) do we read the
        // whole segment back and compare byte for byte — the ultimate truth, but slow, so it is the
        // fallback and not the default. A CRC that matches nothing is NOT itself a failure verdict.
        const wantAug = crc16Ccitt(target.bytes);        // thelsing / OpenKNX (augmented)
        const wantPlain = crc16CcittFalse(target.bytes); // GVS and other CCITT-FALSE firmware
        const { ok } = await verifySettled(
          async () => {
            const gt = await readGroupTables(dev);
            const mcb = await readSegmentCrc(dev, LSM);
            const crcOk = mcb !== null && mcb.size === target.size && (mcb.crc === wantAug || mcb.crc === wantPlain);
            const img = crcOk ? null : await dev.memRead(await loadedTableAddr(dev, LSM, "parameter segment"), target.size);
            const sec = security ? await readSecurityObject(dev, security.goFlags.length, addr.readUInt16BE(0)) : null;
            return { gt, crcOk, img, sec };
          },
          ({ gt, crcOk, img, sec }) => {
            const tablesOk = gt.addr.equals(addr) && gt.assoc.equals(assoc) && gt.comObj.equals(comObj);
            const paramsOk = crcOk || (img !== null && verifyMaskedBytes(img, target.bytes, wholeBytes(target.verify, target.markers)));
            const securityOk = !security || (sec !== null && sameSecurityObject(sec, security));
            return tablesOk && paramsOk && securityOk;
          },
        );
        return ok;
      },
    });
  }

  // The partial form on a unit holding the application (planSystemBPartial): the unit's application
  // segment and com-object table are read first, as the base the owned bytes are merged into and the
  // backup, then only what differs is written. The verify checks every byte the way the structural
  // flash does: the owned bits against the new configuration, the rest against what the unit held.
  private async downloadPartialForm(dev: KnxDevice, mask: string, ctx: FullDownloadCtx, proc: LoadProcedures, size: number, paramsMcb: McbRegion[]): Promise<FlashResult> {
    const paramsAt = await loadedTableAddr(dev, LSM, "parameter segment");
    const current = await dev.memRead(paramsAt, size, undefined, (d, t) => ctx.onProgress?.("backup", d, t), ctx.signal);
    const cur = await readGroupTables(dev, undefined, false);
    const comObjAt = await loadedTableAddr(dev, OBJ.COMOBJ_TABLE, "com-object table");
    const unitMemory: RelativeUnitMemory = {
      params: current, paramsAt, paramsMcb,
      comObj: cur.comObj, comObjAt, comObjMcb: await readMcbRegions(dev, OBJ.COMOBJ_TABLE, cur.comObj.length),
    };
    const { plan, params, target, comObj, addr, assoc, security, segments, imageBytes, changedBytes } = this.planSystemBPartial({ ...ctx, proc, unitHoldsApplication: true, unitMemory });
    const curSecurity = security ? await readSecurityObject(dev, security.goFlags.length, addr.readUInt16BE(0)) : undefined;
    const prefix = `${ctx.deviceId}-full-partial-${Date.now()}`;
    const partialStamps = stampCollector();
    return runFlashOp(dev, mask, ctx, {
      extendedMemory: this.requireCfg("full download").loadProcedures.extendedMemoryServices,
      imageBytes,
      imageDigest: fullDownloadImageDigest(segments),
      diffBytes: changedBytes
        + (security && curSecurity ? byteDiff(security.groupKeys, curSecurity.groupKeys) + byteDiff(security.goFlags, curSecurity.goFlags)
          + (senderAddresses(security.senders) === senderAddresses(curSecurity.senders) ? 0 : Math.max(security.senders.length, curSecurity.senders.length, 1)) : 0),
      backup: `${prefix}-params.bin`,
      backups: ctx.dryRun ? [] : [
        { file: `${prefix}-params.bin`, bytes: current },
        { file: `${prefix}-comobj.bin`, bytes: cur.comObj },
        { file: `${prefix}-assoc.bin`, bytes: cur.assoc },
        { file: `${prefix}-addr.bin`, bytes: cur.addr },
      ],
      stamps: partialStamps.stamps,
      write: () => runLoadPlan(dev, plan, { onWrite: (d, t) => ctx.onProgress?.("write", d, t), onRead: partialStamps.onRead }),
      verify: async (confirmedOnly) => {
        ctx.onProgress?.("verify");
        const paramMask = target.owned.map((m, i) => (~m | target.verify[i]) & 0xff);
        const verifyAt = await dev.tableAddr(LSM);
        const match = confirmedOnlyMatch(dev, verifyAt, params, paramMask, verifyAt === paramsAt ? current : null);
        const { value, ok } = await verifySettled(
          async () => ({
            app: await lsmState(dev, OBJ.APP_PROGRAM),
            tablesLoaded: await allLoaded(dev, [OBJ.COMOBJ_TABLE, OBJ.ASSOC_TABLE, OBJ.ADDR_TABLE]),
            back: await dev.memRead(verifyAt, params.length, undefined, (d, t) => ctx.onProgress?.("verify", d, t)),
            tables: await readGroupTables(dev),
            sec: security ? await readSecurityObject(dev, security.goFlags.length, addr.readUInt16BE(0)) : null,
          }),
          ({ app, tablesLoaded, back, tables, sec }) => app === STATE.LOADED && tablesLoaded && match(back) !== null
            && tables.addr.equals(addr) && tables.assoc.equals(assoc) && tables.comObj.equals(comObj)
            && (!security || (sec !== null && sameSecurityObject(sec, security))),
        );
        return ok && settledMatch(match(value.back), confirmedOnly);
      },
    });
  }

  async readState(dev: KnxDevice, mask: string, ctx: ReadStateCtx): Promise<DeviceReadback> {
    const cfg = this.requireCfg("read-back");
    const { model, instances } = moduleAwareModel(cfg, ctx.liveParams, ctx.moduleInstances ?? []);
    const support = this.capabilities();
    const paramBase = new Map(ctx.baseParams ?? ctx.liveParams);
    let links: ComObjectLink[] = [];
    let paramsRead = false, linksRead = false;
    let deviceConfig: Map<string, string> | undefined;

    // Parameters (LSM 4): read the whole segment, decode it, compare against the image the
    // FLASH would write, both normalized via the same codec. The project side is the surgical
    // target (not the legacy full-image build), so read-back compares against exactly the bytes
    // we would put on the device, and union branches resolve to the active one instead of the
    // last writer of an overlapping region. Same shape as the System 7 path below.
    // A text field the codec refuses is left out of the comparison here (textRefusals), not the whole read.
    const target = support.readParams ? buildRelativeSegmentTarget(cfg, ctx.liveParams, LSM, { moduleInstances: instances, textRefusals: "skip" }) : null;
    if (target) {
      // loadedTableAddr, not tableAddr: a device that was never programmed points its parameter
      // segment at address 0, and reading there would decode whatever bytes happen to live at the
      // bottom of its memory into a "programmed baseline". Refuse instead (DEVICE_NOT_PROGRAMMED).
      const img = await dev.memRead(await loadedTableAddr(dev, LSM, "parameter segment"), target.size, undefined, (d, t) => ctx.onProgress?.("params", d, t), ctx.signal);
      const deviceVals = decodeParameterImage(model, LSM, img);
      dropUnownedText(model, deviceVals, (p) => (!p.codeSegment || model.segments.find((s) => s.id === p.codeSegment)?.lsm === LSM ? target.owned : undefined));
      const device = deviceRelevantRefs(deviceVals, ctx.liveParams, ctx.configFor);
      foldDeviceValues(paramBase, deviceVals, decodeParameterImage(model, LSM, target.bytes), ctx.liveParams, device?.relevant, target.defaulted);
      deviceConfig = device?.deviceConfig;
      paramsRead = true;
    }
    // Group-address links: read address + association tables (skip the com-object table) and reverse.
    if (support.readLinks) {
      if (ctx.signal?.aborted) throw new ProductError("READ_ABORTED", "read aborted");
      ctx.onProgress?.("links", 0, 2);
      const gt = await readGroupTables(dev, (d, total) => ctx.onProgress?.("links", d, total), true);
      links = decodeGroupTables(gt.addr, gt.assoc, gt.long);
      linksRead = true;
    }
    return { mask, paramsRead, linksRead, paramBase, links, deviceConfig };
  }

  async flashParameters(dev: KnxDevice, mask: string, ctx: ParamFlashCtx): Promise<FlashResult> {
    const cfg = this.requireCfg("parameter flash");
    // The MergedProcedure fragments parameterize the proven base bracket; every
    // par-applicable fragment step must be dispositioned (executed/skip) or the flash
    // refuses. The declared CompareProp pre-flights run below, before any bus write.
    const proc = parseLoadProcedures(ctx.appXml);
    const coverage = assertParCoverage(proc, "relative");
    // Build + safety refusals. These run AFTER the session's connect/mask-check (vs before, in
    // the original), which is harmless: no device byte is written until below, and verifying we
    // are on the right device first is if anything safer.
    const { model } = moduleAwareModel(cfg, ctx.params, ctx.moduleInstances ?? []);
    // SAFETY: a stored value the image model cannot place would be silently dropped and its
    // region reset to default. Refuse rather than wipe a configured channel.
    const unmapped = unmappedParamRefs(model, ctx.params);
    if (unmapped.length) {
      throw new ProductError("CHANNEL_MODULES_UNSUPPORTED",
        `parameter programming cannot place ${unmapped.length} stored value(s) for this device (e.g. ${unmapped[0]}); they would be dropped and that region reset to defaults. Refusing to flash to protect the device configuration.`);
    }
    // The device keeps the com-object table it was last programmed with. If these parameters
    // imply a different one, flashing would leave that table stale while reporting success.
    assertComObjectTableStable(cfg, ctx.baseParams, ctx.params, ctx.moduleInstances ?? []);
    // Surgical owned-byte target: only these bytes may be written; everything ETS computes that
    // we cannot reproduce is preserved by sourcing unowned bytes from the live read. The unions with
    // no active member are owned at their DefaultUnionParameter, as ETS's parameter download writes
    // them (GVS AMMA partial-download capture, 2026-09-26: exactly the owned bytes, those included).
    const target = buildRelativeSegmentTarget(cfg, ctx.params, LSM, { moduleInstances: ctx.moduleInstances, ownIdleUnionDefaults: true });
    if (!target || target.size === 0) throw new ProductError("EMPTY_IMAGE", "built an empty parameter image; refusing to flash");
    const mcb = declaredMcbWrites(proc, target.size, "par");

    await runDeclaredChecks(dev, coverage);
    // A parameter (par) download rewrites an EXISTING segment; on a never-programmed device
    // there is nothing to back up and nothing to merge our owned bytes into. Refuse: that device
    // needs a full download, which is a different operation (docs/commissioning.md).
    const addr = await loadedTableAddr(dev, LSM, "parameter segment");
    const current = await dev.memRead(addr, target.size, undefined, (d, t) => ctx.onProgress?.("backup", d, t), ctx.signal);

    const { image, diffBytes } = mergeRelativeTarget(current, target);
    // With the unit's stamps equal to the record, ETS's differential: the owned bytes that differ from the
    // unit, region by region (differentialMask; the regions as the application declares them, else as the
    // unit reports them now). Otherwise every owned byte. The record is the stamps of the last download
    // that wrote the parameters, so when they match the unit holds what that download left and the unit's
    // read stands for ETS's record of it.
    const loaded = await allLoaded(dev, [LSM]);
    // An application not LOADED (an interrupted write) takes every owned byte, as ETS's differential is
    // shown only onto a loaded one.
    const written = loaded ? relativeParWriteSet(image, current, target.owned, mcb, await currentStamps(dev, ctx.stampRecord)) : target.owned;
    const parStamps = stampCollector();
    const backupFile = `${ctx.deviceId}-LSM${LSM}-${Date.now()}.bin`;
    return runFlashOp(dev, mask, ctx, {
      extendedMemory: this.requireCfg("parameter flash").loadProcedures.extendedMemoryServices,
      imageBytes: image.length,
      diffBytes,
      ...(loaded ? {} : { loadIncomplete: "rewrite" as const }),
      backup: backupFile,
      backups: [{ file: backupFile, bytes: current }],
      stamps: parStamps.stamps,
      write: () => runLoadPlan(
        dev,
        withClosing(withConfirmedRestart(planRelativeParFlash(LSM, image, written, addr, appId(model.manufacturer, model.appNumber, model.version), !persistsOnLoadCompleted(cfg), mcb), proc.secureEnabled), proc, "par"),
        { onWrite: (d, t) => ctx.onProgress?.("write", d, t), onRead: parStamps.onRead },
      ),
      // The device restarts after load-completed. Every bit is checked: the owned ones against the
      // target (minus Access="None" markers the device re-stamps), the rest against the read before
      // the flash, because only the owned bytes were written and the device had to keep the others.
      verify: async (confirmedOnly) => {
        const verifyAddr = await dev.tableAddr(LSM);
        const mask = target.owned.map((m, i) => (~m | target.verify[i]) & 0xff);
        const match = confirmedOnlyMatch(dev, verifyAddr, image, mask, verifyAddr === addr ? current : null);
        const { value, ok } = await verifySettled(
          () => dev.memRead(verifyAddr, image.length, undefined, (d, t) => ctx.onProgress?.("verify", d, t)),
          (back) => match(back) !== null,
        );
        return ok && settledMatch(match(value), confirmedOnly);
      },
    });
  }

  async flashGroupTables(dev: KnxDevice, mask: string, ctx: GaFlashCtx): Promise<FlashResult> {
    // `links` numbers its com-objects from the LIVE configuration, but the device's com-object
    // table is the one it was last programmed with. Associating a group address with an object
    // that table does not configure wires it to nothing, and the verify (which only re-reads the
    // tables we wrote) would still report success. Refuse for the same reason the param flash does.
    const cfg = this.requireCfg("group address flash");
    refuse(this.operationRefusals().flashLinks);
    assertComObjectTableStable(cfg, ctx.baseParams, ctx.params, ctx.moduleInstances ?? []);
    // Author the com-object table (L3) that THIS link set implies, and write it alongside the group
    // tables. It is NOT enough to write the address/association tables and keep the device's L3: ETS
    // (and buildComObjectTable) clears the Communication flag on every object WITHOUT a link, so an
    // object that was unlinked at the last full download holds comm=0 in the device's L3. Writing only
    // the association would then wire a group address to an object the device still refuses to talk on
    // — the link reads back byte-perfect (the group tables match our image) yet is functionally dead
    // (hardware-proven on the GVS AMMA: a status object linked by a GA flash never answered a read nor
    // transmitted, while the same object linked by a full download did). So the GA flash rebuilds L3
    // from the current config and writes L3+L1+L2 in one bracket. It stays a SURGICAL flash: L3/L1/L2
    // are small tables, so this never touches the large parameter image (L4) — the point of not
    // promoting a mere link change to a full download. The staleness gate above guarantees the only L3
    // difference is link-driven (params did not move it), so on a pure re-point L3 is byte-identical.
    const { instances } = moduleAwareModel(cfg, ctx.params, ctx.moduleInstances ?? []);
    const view = buildDeviceConfig(cfg, ctx.params, undefined, instances);
    const active = new Set(view.imageComObjects.keys());
    const orphans = ctx.links.filter((l) => !active.has(l.comObjNum));
    if (orphans.length) {
      throw new ProductError("LINK_COM_OBJECT_INACTIVE",
        `${orphans.length} group-address link(s) target communication objects this configuration does not activate (e.g. #${orphans[0].comObjNum}); the device would ignore them, so refusing to report them as programmed`);
    }
    const linked = new Set(ctx.links.map((l) => l.comObjNum));
    const comObj = buildComObjectTable(withInstanceOverrides(view.imageComObjects, ctx.comObjectOverrides), view.maxComObjectNumber, linked);
    const { addr, assoc } = buildGroupTables(ctx.links);
    const security = ctx.security ? buildSecurityObject(ctx.links, comObj.readUInt16BE(0), ctx.security.groupKeys, secureSenders(ctx.security, ctx.ia)) : undefined;
    // Read the current L3 as well (not just addr/assoc): it is the backup, and its diff against the
    // rebuilt table is what makes the link-driven L3 change visible in the dry-run preview.
    const cur = await readGroupTables(dev, undefined, false);
    // The security object is compared, not backed up: its group keys are secrets, and the project
    // holds them anyway.
    const curSecurity = security ? await readSecurityObject(dev, security.goFlags.length, addr.readUInt16BE(0)) : undefined;
    // The application program object's load state BEFORE the flash. A GA flash unloads and rewrites the
    // three tables the running application references, and on some System B stacks that invalidates the
    // application itself: hardware-proven on the Jung 400021SE (Insta), where the flash leaves all three
    // tables LOADED and byte-perfect while object 4 drops to ERROR — the device keeps answering
    // management (so every table verified green) but its application no longer runs, so the freshly
    // linked object is functionally dead and no cheap recovery exists (a bare LoadCompleted, a
    // LOAD+LoadCompleted and a restart all leave it ERROR; only a full download brings it back).
    // Reporting `verified: true` for that is exactly the fake-green this codebase refuses, so the state
    // is captured here and re-checked after the write.
    const appBefore = await lsmState(dev, OBJ.APP_PROGRAM);
    const prefix = `${ctx.deviceId}-GA-${Date.now()}`;
    const tablesLoaded = await allLoaded(dev, [OBJ.ADDR_TABLE, OBJ.ASSOC_TABLE, OBJ.COMOBJ_TABLE]);
    return runFlashOp(dev, mask, ctx, {
      extendedMemory: this.requireCfg("group address flash").loadProcedures.extendedMemoryServices,
      imageBytes: addr.length + assoc.length + comObj.length,
      diffBytes: byteDiff(addr, cur.addr) + byteDiff(assoc, cur.assoc) + byteDiff(comObj, cur.comObj) // 0 iff all three match
        + (security && curSecurity ? byteDiff(security.groupKeys, curSecurity.groupKeys) + byteDiff(security.goFlags, curSecurity.goFlags)
          + (senderAddresses(security.senders) === senderAddresses(curSecurity.senders) ? 0 : Math.max(security.senders.length, curSecurity.senders.length, 1)) : 0),
      ...(tablesLoaded ? {} : { loadIncomplete: "rewrite" as const }),
      backup: prefix,
      backups: [
        { file: `${prefix}-addr.bin`, bytes: cur.addr },
        { file: `${prefix}-assoc.bin`, bytes: cur.assoc },
        ...(ctx.dryRun ? [] : [{ file: `${prefix}-comobj.bin`, bytes: cur.comObj }]),
      ],
      write: async () => {
        ctx.onProgress?.("write");
        // The application object is held in its own load bracket across the table rewrite (see
        // planSystemBGaFlash): unloading a table underneath a running application invalidates it on some
        // System B stacks, and the tables then read back byte-perfect while the device communicates on
        // nothing. Hardware-proven on the Jung 400021SE, where this is the difference between a link that
        // works and one that is silently dead.
        // Hold the application object open across the rewrite, but ONLY for a family hardware-proven to
        // need it (see HOLD_APPLICATION_ON_GA_FLASH: the extra LoadCompleted is not free on a
        // persist-at-LoadCompleted device) and only when its application is actually LOADED (driving
        // LOAD/LoadCompleted on an object holding no application is a transition this flash has no
        // business making, and its assertLoaded would then fail AFTER the tables were written). Any
        // family that needs it but is not listed still cannot fail silently: the guard below refuses.
        // The steps the application closes every download with (closingSteps) close this one too.
        await runLoadPlan(dev, withClosing(withConfirmedRestart(planSystemBGaFlash({ addr, assoc, comObj }, !persistsOnLoadCompleted(cfg), appBefore === STATE.LOADED && holdsApplicationOnGaFlash(cfg), security), cfg.loadProcedures.secureEnabled), cfg.loadProcedures, "grp")); // rebuilt L3 carries the correct comm flags for the new link set
      },
      verify: async () => {
        ctx.onProgress?.("verify");
        // The application must still be loaded. Checking the tables alone cannot see that the device
        // stopped running its application (see appBefore above): the tables read back byte-perfect
        // either way. Only a DEGRADATION is an error — a device whose application object was already
        // not LOADED before the flash is left to the table check, so this never invents a new refusal
        // for a device that was in that state to begin with.
        // Read it the same way the table check is read: through verifySettled, so a device still
        // settling after the closing restart is given the same second chance and cannot produce a false
        // "your application is broken, run a full download" (an expensive lie in the other direction).
        const { ok: appOk } = await verifySettled(() => lsmState(dev, OBJ.APP_PROGRAM), (s) => appBefore !== STATE.LOADED || s === STATE.LOADED);
        if (!appOk) {
          throw new ProductError("GA_FLASH_BROKE_APPLICATION",
            "the group-address flash left the device's application program object out of the LOADED state (it was LOADED before): the tables were written but the device is no longer running its application, so the links are not functional. Recover the device with a full download.");
        }
        const { ok } = await verifySettled(
          async () => ({ tables: await readGroupTables(dev), sec: security ? await readSecurityObject(dev, security.goFlags.length, addr.readUInt16BE(0)) : null }),
          ({ tables: back, sec }) => back.addr.equals(addr) && back.assoc.equals(assoc) && back.comObj.equals(comObj)
            && (!security || (sec !== null && sameSecurityObject(sec, security))),
        );
        return ok;
      },
    });
  }

  // A parameter change that alters the com-object table, written the way ETS writes it as a partial
  // download (planRelativeStructuralFlash): the application segment, the com-object table authored for
  // the new parameters and links, and both group tables, in one bracket. The parameter bytes follow
  // the parameter flash (owned bytes merged into the device's segment), the com-object table goes
  // only where it differs from the device's, the group tables whole, and a Data Secure device's
  // security object is reloaded with them. Unlike the full download nothing is pre-filled, so what
  // the device holds outside the owned bytes stays.
  override async flashStructure(dev: KnxDevice, mask: string, ctx: StructureFlashCtx): Promise<FlashResult> {
    const cfg = this.requireCfg("structural flash");
    if (!this.capabilities().structuralFlash) throw new UnsupportedOperation("structural flash", this.family, this.mask);
    const proc = parseLoadProcedures(ctx.appXml);
    const coverage = assertParCoverage(proc, "relative");
    const { model, instances } = moduleAwareModel(cfg, ctx.params, ctx.moduleInstances ?? []);
    const unmapped = unmappedParamRefs(model, ctx.params);
    if (unmapped.length) {
      throw new ProductError("CHANNEL_MODULES_UNSUPPORTED",
        `parameter programming cannot place ${unmapped.length} stored value(s) for this device (e.g. ${unmapped[0]}); they would be dropped and that region reset to defaults. Refusing to flash to protect the device configuration.`);
    }
    const target = buildRelativeSegmentTarget(cfg, ctx.params, LSM, { moduleInstances: instances, ownIdleUnionDefaults: true });
    if (!target || target.size === 0) throw new ProductError("EMPTY_IMAGE", "built an empty parameter image; refusing to flash");
    const view = buildDeviceConfig(cfg, ctx.params, undefined, instances);
    const active = new Set(view.imageComObjects.keys());
    const orphans = ctx.links.filter((l) => !active.has(l.comObjNum));
    if (orphans.length) {
      throw new ProductError("LINK_COM_OBJECT_INACTIVE",
        `${orphans.length} group-address link(s) target communication objects this configuration does not activate (e.g. #${orphans[0].comObjNum}); the device would ignore them, so refusing to report them as programmed`);
    }
    const comObj = buildComObjectTable(withInstanceOverrides(view.imageComObjects, ctx.comObjectOverrides), view.maxComObjectNumber, new Set(ctx.links.map((l) => l.comObjNum)));
    const { addr, assoc } = buildGroupTables(ctx.links);
    const security = ctx.security ? buildSecurityObject(ctx.links, comObj.readUInt16BE(0), ctx.security.groupKeys, secureSenders(ctx.security, ctx.ia)) : undefined;
    const mcb = declaredMcbWrites(proc, target.size, "par");

    await runDeclaredChecks(dev, coverage);
    const paramsAt = await loadedTableAddr(dev, LSM, "parameter segment");
    const current = await dev.memRead(paramsAt, target.size, undefined, (d, t) => ctx.onProgress?.("backup", d, t), ctx.signal);
    const { image, diffBytes: paramDiff } = mergeRelativeTarget(current, target);
    const cur = await readGroupTables(dev, undefined, false);
    const comObjAt = await loadedTableAddr(dev, OBJ.COMOBJ_TABLE, "com-object table");
    const curSecurity = security ? await readSecurityObject(dev, security.goFlags.length, addr.readUInt16BE(0)) : undefined;
    const prefix = `${ctx.deviceId}-structure-${Date.now()}`;
    const loaded = await allLoaded(dev, [LSM, OBJ.COMOBJ_TABLE, OBJ.ASSOC_TABLE, OBJ.ADDR_TABLE]);
    const plan = planRelativeStructuralFlash(LSM, {
      params: { image, owned: target.owned, keptAt: paramsAt },
      comObj: { image: comObj, owned: differingBytes(comObj, cur.comObj), keptAt: comObjAt },
      addr, assoc,
    }, appId(model.manufacturer, model.appNumber, model.version), !persistsOnLoadCompleted(cfg), mcb, security);
    const closed = withClosing(withConfirmedRestart(plan, proc.secureEnabled), proc, "par");
    const structureStamps = stampCollector();
    return structural(runFlashOp(dev, mask, ctx, {
      extendedMemory: this.requireCfg("structural flash").loadProcedures.extendedMemoryServices,
      imageBytes: image.length + comObj.length + addr.length + assoc.length,
      diffBytes: paramDiff + byteDiff(addr, cur.addr) + byteDiff(assoc, cur.assoc) + byteDiff(comObj, cur.comObj)
        + (security && curSecurity ? byteDiff(security.groupKeys, curSecurity.groupKeys) + byteDiff(security.goFlags, curSecurity.goFlags)
          + (senderAddresses(security.senders) === senderAddresses(curSecurity.senders) ? 0 : Math.max(security.senders.length, curSecurity.senders.length, 1)) : 0),
      ...(loaded ? {} : { loadIncomplete: "rewrite" as const }),
      backup: `${prefix}-params.bin`,
      backups: ctx.dryRun ? [] : [
        { file: `${prefix}-params.bin`, bytes: current },
        { file: `${prefix}-comobj.bin`, bytes: cur.comObj },
        { file: `${prefix}-assoc.bin`, bytes: cur.assoc },
        { file: `${prefix}-addr.bin`, bytes: cur.addr },
      ],
      stamps: structureStamps.stamps,
      write: () => runLoadPlan(dev, closed, { onWrite: (d, t) => ctx.onProgress?.("write", d, t), onRead: structureStamps.onRead }),
      // Every byte of the parameter segment is checked as the parameter flash checks it, the three
      // tables and the security object whole, and the application and the three tables must be
      // LOADED again after the restart.
      verify: async (confirmedOnly) => {
        ctx.onProgress?.("verify");
        const paramMask = target.owned.map((m, i) => (~m | target.verify[i]) & 0xff);
        const verifyAt = await dev.tableAddr(LSM);
        const match = confirmedOnlyMatch(dev, verifyAt, image, paramMask, verifyAt === paramsAt ? current : null);
        const { value, ok } = await verifySettled(
          async () => ({
            app: await lsmState(dev, OBJ.APP_PROGRAM),
            tablesLoaded: await allLoaded(dev, [OBJ.COMOBJ_TABLE, OBJ.ASSOC_TABLE, OBJ.ADDR_TABLE]),
            params: await dev.memRead(verifyAt, image.length, undefined, (d, t) => ctx.onProgress?.("verify", d, t)),
            tables: await readGroupTables(dev),
            sec: security ? await readSecurityObject(dev, security.goFlags.length, addr.readUInt16BE(0)) : null,
          }),
          ({ app, tablesLoaded, params, tables, sec }) => app === STATE.LOADED && tablesLoaded && match(params) !== null
            && tables.addr.equals(addr) && tables.assoc.equals(assoc) && tables.comObj.equals(comObj)
            && (!security || (sec !== null && sameSecurityObject(sec, security))),
        );
        return ok && settledMatch(match(value.params), confirmedOnly);
      },
    }));
  }
}

// System 7 (absolute-segment) devices: MV-0700/0701/0705 and the RF/IP variants. Parameters
// live at fixed EEPROM addresses (driven by the device's declared LoadProcedure); group tables
// use the System-7 layout. Read-back, parameter flash and GA flash are all hardware-verified
// on twisted-pair (M-0081): identity flash, re-point and revert each byte-matched.
// The bits of a System 7 com-object config byte a project override can set (buildComObjectTableMv0705):
// priority, read, write, transmit. Its communication bit follows the links, its update bit the application.
const MV0705_OVERRIDABLE: readonly OverridableBit[] = ["read", "write", "transmit", "priority"];

export class System7Profile extends DeviceProfile {
  readonly memoryModel = "absolute" as const;
  constructor(readonly family: SystemFamily, mask: string, cfg: AppConfig | null) { super(mask, cfg); }

  capabilities(): DeviceCapabilities {
    // Parameters (absolute segments) and links (System-7 tables) are both read back. Parameter
    // and GA flash are hardware-proven on TP (M-0081); the RF/IP variants share the codec
    // but have not been exercised on that medium (see the device-support.md medium caveat).
    //
    // Full download needs the group-table segments and, for the memory-mapped System 7 masks
    // (MV-0700/0701, hardware-proven on the ABB US/U 4.2), nothing more: the app ships every
    // segment's <Data> so the whole image is authored from it. The property-mapped MV-0705 variants
    // do NOT ship a configured com-object table; downloadFull authors L3 into the <ComObjectTable
    // CodeSegment>, so a full download is possible exactly when the app declares that segment
    // (buildComObjectTableMv0705). Byte-verified against two ETS captures of the MDT BE-02001.02 and
    // live-hardware certified on it: full download verified=true, and the device answers
    // group communication on a flashed link, unchanged across a bus power-cycle (docs/commissioning.md).
    //
    // Each write is offered only where its planner can run the procedure the application declares
    // (operationRefusals): a full download in at least one of its forms (absoluteFullForm), a parameter or
    // group-address flash with every step addressed to what it writes dispositioned.
    const canAuthor = this.canAuthor();
    // The structural flash authors the com-object table from its segment's template, as the full
    // download does on both LSM styles, so it needs the segment the application names for it.
    const canStructure = canAuthor && !!this.cfg && structuralFlashCaptured(this.cfg) && this.cfg.groupTables.comObjectSegment !== undefined && this.cfg.loadProcedures.style === "ProductProcedure";
    const refused = this.operationRefusals();
    return {
      readParams: true, readLinks: true, flashParams: !refused.flashParams, flashLinks: !refused.flashLinks,
      fullDownload: this.fullDownloadOffered() && !refused.fullDownload, structuralFlash: canStructure && !refused.flashParams,
    };
  }

  override operationRefusals(): OperationRefusals {
    const cfg = this.cfg;
    if (!cfg) return {};
    const out: OperationRefusals = {};
    const par = absoluteParRefusal(cfg.loadProcedures);
    if (par) out.flashParams = par;
    const ga = system7GaScope(cfg, this.mask);
    if ("refusal" in ga) out.flashLinks = ga.refusal;
    // Checked before the tunnelling entries, so the procedure is the reason given where both apply. Offered
    // where one form can run; the unit's state picks the form at download time.
    const declared = this.canAuthor() ? absoluteFullStepRefusal(cfg.loadProcedures, "declared") : null;
    const partial = declared && cfg.loadProcedures.preferPartialIfLoaded ? absoluteFullStepRefusal(cfg.loadProcedures, "partial") : declared;
    const full = (declared && partial) ?? (this.canAuthor() ? fullDownloadSegmentRefusal(cfg, cfg.loadProcedures) : null);
    if (full) out.fullDownload = full;
    return out;
  }

  // An application whose declared form cannot run is downloaded only in the partial form, on a unit that
  // holds it (downloadFull refuses FULL_DOWNLOAD_APPLICATION_NOT_LOADED), so a unit left without it goes
  // back to ETS.
  override fullDownloadLoadsApplication(): boolean {
    return super.fullDownloadLoadsApplication() && !(this.cfg && absoluteFullStepRefusal(this.cfg.loadProcedures, "declared"));
  }

  private canAuthor(): boolean {
    return !!this.cfg && this.cfg.absoluteSegments.length > 0 &&
      this.cfg.groupTables.addressSegment !== undefined && this.cfg.groupTables.associationSegment !== undefined &&
      (isMemoryMappedLsm(this.mask) || this.cfg.groupTables.comObjectSegment !== undefined);
  }

  private fullDownloadOffered(): boolean {
    return this.canAuthor() && !!this.cfg && !declaresTunnelingEntries(this.cfg);
  }

  async readState(dev: KnxDevice, mask: string, ctx: ReadStateCtx): Promise<DeviceReadback> {
    const cfg = this.requireCfg("read-back");
    const paramBase = new Map(ctx.baseParams ?? ctx.liveParams);
    const instances = ctx.moduleInstances?.length ? ctx.moduleInstances : (cfg.hasModules ? resolveModuleInstances(cfg, ctx.liveParams) : []);
    const absModel = toAppModel(cfg, { includeUnions: true, instances });
    const absoluteTargets = buildAbsoluteSegmentTargets(cfg, ctx.liveParams, { moduleInstances: ctx.moduleInstances, textRefusals: "skip" });

    // memRead reports progress in BYTES; accumulate across segments for a whole-read bar.
    const totalBytes = absoluteTargets.reduce((n, t) => n + t.size, 0);
    let doneBytes = 0;
    const deviceVals = new Map<string, string>(), projectVals = new Map<string, string>();
    for (const t of absoluteTargets) {
      const deviceImg = await dev.memRead(t.address, t.size, undefined, (d) => ctx.onProgress?.("params", doneBytes + d, totalBytes), ctx.signal);
      for (const [r, v] of decodeAbsoluteImage(absModel, t.id, deviceImg)) deviceVals.set(r, v);
      for (const [r, v] of decodeAbsoluteImage(absModel, t.id, t.bytes)) projectVals.set(r, v);
      doneBytes += t.size;
    }
    for (const t of absoluteTargets) dropUnownedText(absModel, deviceVals, (p) => (p.codeSegment === t.id ? t.owned : undefined));
    const device = deviceRelevantRefs(deviceVals, ctx.liveParams, ctx.configFor);
    foldDeviceValues(paramBase, deviceVals, projectVals, ctx.liveParams, device?.relevant);

    if (ctx.signal?.aborted) throw new ProductError("READ_ABORTED", "read aborted");
    ctx.onProgress?.("links", 0, 2);
    const gt = await readGroupTablesMv0705(dev, (d, total) => ctx.onProgress?.("links", d, total));
    const links = decodeGroupTablesMv0705(gt.addr, gt.assoc);
    return { mask, paramsRead: true, linksRead: true, paramBase, links, deviceConfig: device?.deviceConfig };
  }

  async flashParameters(dev: KnxDevice, mask: string, ctx: ParamFlashCtx): Promise<FlashResult> {
    const cfg = this.requireCfg("parameter flash");
    const proc = parseLoadProcedures(ctx.appXml);
    refuse(absoluteParRefusal(proc));
    const coverage = assessParCoverage(proc, "absolute");
    // Same com-object-table staleness gate as System B: the absolute path keeps the device's
    // com-object table too, so a parameter that changes the active object set or its flags
    // would silently invalidate it. See comobjtable.ts.
    assertComObjectTableStable(cfg, ctx.baseParams, ctx.params, ctx.moduleInstances ?? []);
    const moduleInstances = ctx.moduleInstances;
    const targets = buildAbsoluteSegmentTargets(cfg, ctx.params, { moduleInstances }).filter((t) => t.size > 0);
    const totalBytes = targets.reduce((n, t) => n + t.size, 0);

    await runDeclaredChecks(dev, coverage);

    // Read each parameter segment at its fixed address; this is the backup and the diff source.
    const current = new Map<string, Buffer>();
    const stamp = Date.now();
    let read = 0;
    for (const t of targets) {
      const onDev = await dev.memRead(t.address, t.size, undefined, (d) => ctx.onProgress?.("backup", read + d, totalBytes), ctx.signal);
      read += t.size;
      current.set(t.id, onDev);
    }

    const { plan, changedBytes, unplaceable, covered } = planAbsoluteParFlash(cfg, ctx.params, proc, current, { moduleInstances, requireReboot: !persistsOnLoadCompleted(cfg) });
    const writeBytes = plan.reduce((n, st) => n + (st.op === "writeMem" ? st.bytes.length : 0), 0);
    // No-silent-drop: a changed segment with no LSM in the load procedure cannot be programmed.
    if (unplaceable.length) {
      throw new ProductError("FLASH_SEGMENT_UNPLACEABLE", `${unplaceable.length} changed parameter segment(s) are not declared in the device's load procedure; refusing to flash to avoid a silent partial write`);
    }
    // The load-state machines the parameter segments are declared under (LdCtrlAbsSegment).
    const targetAddrs = new Set(targets.map((t) => t.address));
    const declared = proc.blocks.flatMap((b) => b.steps).filter((st) => st.verb === "LdCtrlAbsSegment" && targetAddrs.has(stepAddress(st) ?? -1));
    const paramLsms = [...new Set(declared.flatMap((st) => { const l = lsmIdx(st); return l === undefined ? [] : [l]; }))];
    if (declared.length < targetAddrs.size || paramLsms.length === 0) {
      throw new ProductError("FLASH_SEGMENT_UNPLACEABLE", "a parameter segment is not declared with its load-state machine in the device's load procedure; its load state cannot be checked, so refusing to flash");
    }
    const paramsLoaded = await allLoaded(dev, paramLsms, isMemoryMappedLsm(mask));
    return runFlashOp(dev, mask, ctx, {
      extendedMemory: this.requireCfg("parameter flash").loadProcedures.extendedMemoryServices,
      imageBytes: totalBytes,
      diffBytes: changedBytes,
      ...(paramsLoaded ? {} : { loadIncomplete: "refuse" as const }),
      backup: `${ctx.deviceId}-${targets[0]?.id.split("_").pop() ?? "AS"}-${stamp}.bin`,
      backups: targets.map((t) => ({ file: `${ctx.deviceId}-${t.id.split("_").pop()}-${stamp}.bin`, bytes: current.get(t.id)! })),
      write: async () => {
        let wrote = 0;
        // The memory-mapped System 7 masks (MV-0700/0701) drive their LSMs over 0x0104, not PID 5;
        // a surgical param flash needs the same transport the full download does, or it would talk
        // to a dead property interface (hardware: the ABB US/U 4.2 flash never acked otherwise).
        await runLoadPlan(dev, plan, { memMappedLsms: isMemoryMappedLsm(mask), readCompare: isMemoryMappedLsm(mask), onStep: (_i, step) => { if (step.op === "writeMem") ctx.onProgress?.("write", (wrote += step.bytes.length), writeBytes); } });
      },
      verify: async (confirmedOnly) => {
        for (const t of targets) {
          // Verify only user-facing owned bytes (t.verify). Access="None" device-internal markers
          // are written but excluded: the device re-stamps them on download (e.g. M-008E AS-4B00[0:2]),
          // so checking them would fail every successful flash. Same authority boundary as unowned bytes.
          const match = confirmedOnlyMatch(dev, t.address, t.bytes, t.verify, current.get(t.id) ?? null);
          // The bytes a parameter covers and none owns were written back with the device's own values
          // (parWriteSet): they must read back as written, as owned bytes must.
          const cov = covered.find((c) => c.id === t.id);
          const keptAsWritten = (back: Buffer) => !cov || cov.covered.every((c, i) => !c || t.owned[i] !== 0 || back[i] === cov.image[i]);
          const { value, ok } = await verifySettled(
            () => dev.memRead(t.address, t.size, undefined, (d, n) => ctx.onProgress?.("verify", d, n)),
            (back) => match(back) !== null && keptAsWritten(back),
          );
          if (!ok || !keptAsWritten(value) || !settledMatch(match(value), confirmedOnly)) return false;
        }
        return true;
      },
    });
  }

  async flashGroupTables(dev: KnxDevice, mask: string, ctx: GaFlashCtx): Promise<FlashResult> {
    refuseSecureTables(ctx, this.family);
    const cfg = this.requireCfg("group address flash");
    const scope = system7GaScope(cfg, mask);
    if ("refusal" in scope) refuseWith(scope.refusal);
    // Same com-object staleness gate as System B: the flash keeps every config byte of the device's
    // com-object table but the linked bit, so an association onto an object that table does not
    // configure is a link to nothing.
    assertComObjectTableStable(cfg, ctx.baseParams, ctx.params, ctx.moduleInstances ?? []);
    // The group-address flash ETS's partial download runs on every System 7 application with its own
    // procedure (planSystem7GaFlash): both tables unloaded and declared where tablePlacement puts them,
    // the com-object table written in the application's bracket.
    const { addr, assoc } = buildGroupTablesMv0705(ctx.links, iaToNum(ctx.ia));
    const cur = await readGroupTablesMv0705(dev);
    // CAPACITY: a System 7 device's address/association tables sit in PRE-RESERVED absolute
    // segments (no reallocation, unlike System B's allocSegment). The app program declares how
    // many entries the device reserved room for (<AddressTable>/<AssociationTable> MaxEntries),
    // so growing the tables UP TO that capacity stays inside the reserved segment; beyond it the
    // write would overrun adjacent memory (association/com-object table), which the table-only
    // verify below would not catch. Layouts: address = [count:1][own IA:2][GA:2 x N] -> max
    // 3 + 2*addressMaxEntries; association = [count:1][groupIdx:1][comObj:1 x M] -> max
    // 1 + 2*associationMaxEntries. If the program declares no capacity, fall back to the
    // conservative "no growth beyond the current table" bound (the current table demonstrably fits).
    const cap = this.cfg?.groupTables;
    const maxAddr = cap?.addressMaxEntries !== undefined ? 3 + 2 * cap.addressMaxEntries : cur.addr.length;
    const maxAssoc = cap?.associationMaxEntries !== undefined ? 1 + 2 * cap.associationMaxEntries : cur.assoc.length;
    if (addr.length > maxAddr || assoc.length > maxAssoc) {
      throw new ProductError("GA_TABLE_TOO_LARGE",
        `the group tables would need address ${addr.length} B / association ${assoc.length} B, but this device reserves only ${maxAddr} B / ${maxAssoc} B${cap?.addressMaxEntries !== undefined ? ` (${cap.addressMaxEntries} group addresses)` : ""}. Remove links or assign fewer group addresses.`);
    }
    // Each object's L3 config byte carries a linked bit, and ETS rewrites it on a group-address
    // download (comobjbuild.ts withLinkedCommFlags). Keeping the device's table would leave a newly
    // linked object silent, so where the application names the table's segment only that bit is
    // changed in the table the device holds, and the table is verified with the group tables.
    // That bit is the object's communication flag; a project that sets it otherwise than the links do
    // cannot be written by this flash, and the other bits stay as the device holds them.
    if (scope.l3 && ctx.comObjectOverrides?.size) {
      const { instances } = moduleAwareModel(cfg, ctx.params, ctx.moduleInstances ?? []);
      refuseUnwritableOverrides(buildDeviceConfig(cfg, ctx.params, undefined, instances).imageComObjects, ctx.comObjectOverrides,
        ["read", "write", "transmit", "update", "readOnInit", "priority"], "the group-address flash, which sets only the communication bit from the links");
    }
    const l3Seg = scope.l3;
    const curL3 = l3Seg ? await dev.memRead(l3Seg.address, l3Seg.size) : null;
    const l3 = l3Seg && curL3 ? { address: l3Seg.address, bytes: withLinkedCommFlags(curL3, new Set(ctx.links.map((l) => l.comObjNum))) } : null;
    const ga = planSystem7GaFlash(cfg, cfg.loadProcedures, { addr, assoc }, l3);
    // The change is counted over exactly the runs the plan writes, read where it writes them (the address
    // table's own individual address is neither written nor counted); a table the plan moves whose
    // reference the device does not hold at the new address counts whole, since the device does not read
    // it from there.
    let diffBytes = 0;
    for (const [lsm, at] of [[OBJ.ADDR_TABLE, ga.addrAt], [OBJ.ASSOC_TABLE, ga.assocAt]] as const) {
      const placed = (isMemoryMappedLsm(mask) && !ga.moved) || (await dev.tableAddr(lsm)) === at;
      for (const r of ga.writes.filter((w) => w.lsm === lsm)) diffBytes += placed ? byteDiff(r.image, await dev.memRead(r.address, r.image.length)) : r.image.length;
    }
    for (const r of ga.comObjWrites) diffBytes += byteDiff(r.image, await dev.memRead(r.address, r.image.length));
    const prefix = `${ctx.deviceId}-GA-${Date.now()}`;
    const gaTablesLoaded = await allLoaded(dev, [OBJ.ADDR_TABLE, OBJ.ASSOC_TABLE, ...(l3 ? [OBJ.COMOBJ_TABLE] : [])], isMemoryMappedLsm(mask));
    return runFlashOp(dev, mask, ctx, {
      extendedMemory: this.requireCfg("group address flash").loadProcedures.extendedMemoryServices,
      imageBytes: [...ga.writes, ...ga.comObjWrites].reduce((n, w) => n + w.image.length, 0),
      ...(gaTablesLoaded ? {} : { loadIncomplete: "refuse" as const }),
      diffBytes,
      backup: prefix,
      backups: [
        { file: `${prefix}-addr.bin`, bytes: cur.addr },
        { file: `${prefix}-assoc.bin`, bytes: cur.assoc },
        ...(curL3 ? [{ file: `${prefix}-comobj.bin`, bytes: curL3 }] : []),
      ],
      write: async () => {
        ctx.onProgress?.("write");
        await runLoadPlan(dev, ga.plan, { memMappedLsms: isMemoryMappedLsm(mask), readCompare: isMemoryMappedLsm(mask) }); // same memory-mapped transport as the param flash / download on MV-0700/0701
      },
      verify: async () => {
        ctx.onProgress?.("verify");
        // Each table's reference (PID 7) must be the address it was declared at, or the device does not
        // read the bytes written (a memory-mapped mask is not asked unless the plan moved the tables); then
        // exactly the runs written, so the own individual address and the com-object segment's bytes
        // behind its table, which are not written, are not read back either.
        if (ga.moved || !isMemoryMappedLsm(mask)) {
          for (const [lsm, at] of [[OBJ.ADDR_TABLE, ga.addrAt], [OBJ.ASSOC_TABLE, ga.assocAt]] as const) {
            const { ok } = await verifySettled(() => dev.tableAddr(lsm), (got) => got === at);
            if (!ok) return false;
          }
        }
        for (const w of [...ga.writes, ...ga.comObjWrites]) {
          const { ok } = await verifySettled(() => dev.memRead(w.address, w.image.length), (back) => back.equals(w.image));
          if (!ok) return false;
        }
        return true;
      },
    });
  }

  // A parameter change that alters the com-object table, written as ETS writes it in a partial
  // download (planAbsoluteStructuralFlash): the group tables and the application in one bracket set, the
  // com-object table authored from its template for the new parameters and links. Everything is read
  // first, so the comparison is against the device, not against what the project believes it holds.
  override async flashStructure(dev: KnxDevice, mask: string, ctx: StructureFlashCtx): Promise<FlashResult> {
    refuseSecureTables(ctx, this.family);
    const cfg = this.requireCfg("structural flash");
    if (!this.capabilities().structuralFlash) throw new UnsupportedOperation("structural flash", this.family, this.mask);
    const proc = parseLoadProcedures(ctx.appXml);
    const coverage = assertParCoverage(proc, "absolute");
    const instances = cfg.hasModules ? (ctx.moduleInstances?.length ? ctx.moduleInstances : resolveModuleInstances(cfg, ctx.params)) : [];
    const view = buildDeviceConfig(cfg, ctx.params, undefined, instances);
    const active = new Set(view.imageComObjects.keys());
    const orphans = ctx.links.filter((l) => !active.has(l.comObjNum));
    if (orphans.length) {
      throw new ProductError("LINK_COM_OBJECT_INACTIVE",
        `${orphans.length} group-address link(s) target communication objects this configuration does not activate (e.g. #${orphans[0].comObjNum}); the device would ignore them, so refusing to report them as programmed`);
    }
    refuseUnwritableOverrides(view.imageComObjects, ctx.comObjectOverrides, MV0705_OVERRIDABLE, "the System 7 com-object table");
    const comObjectTable = { active: withInstanceOverrides(view.imageComObjects, ctx.comObjectOverrides), linked: new Set(ctx.links.map((l) => l.comObjNum)) };
    const baseInstances = cfg.hasModules ? (ctx.moduleInstances?.length ? ctx.moduleInstances : resolveModuleInstances(cfg, ctx.baseParams)) : [];
    const images = absoluteStructuralImages(cfg, ctx.params, ctx.links, iaToNum(ctx.ia), { baseValues: ctx.baseParams, baseInstances, moduleInstances: instances, comObjectTable });
    await runDeclaredChecks(dev, coverage);
    const memMapped = isMemoryMappedLsm(mask);
    const current = new Map<number, Buffer>();
    const total = images.reduce((n, r) => n + r.image.length, 0);
    let read = 0;
    for (const r of images) {
      current.set(r.address, await dev.memRead(r.address, r.image.length, undefined, (d) => ctx.onProgress?.("backup", read + d, total), ctx.signal));
      read += r.image.length;
    }
    // The closing restart is held to what the parameter flash proves on these devices.
    const { plan, changedBytes, concerned, segments, tableRefs } = planAbsoluteStructuralFlash(cfg, images, proc, current, !persistsOnLoadCompleted(cfg));
    const loaded = await allLoaded(dev, concerned, memMapped);
    const stamp = Date.now();
    return structural(runFlashOp(dev, mask, ctx, {
      extendedMemory: this.requireCfg("structural flash").loadProcedures.extendedMemoryServices,
      imageBytes: total,
      diffBytes: changedBytes,
      ...(loaded ? {} : { loadIncomplete: "refuse" as const }),
      backup: `${ctx.deviceId}-structure-${stamp}`,
      backups: ctx.dryRun ? [] : images.map((r) => ({ file: `${ctx.deviceId}-structure-${stamp}-${r.id.split("_").pop()}.bin`, bytes: current.get(r.address)! })),
      write: () => runLoadPlan(dev, plan, { memMappedLsms: memMapped, readCompare: memMapped, onStep: (_i, step) => { if (step.op === "writeMem") ctx.onProgress?.("write"); } }),
      // Every written segment is read back, and every load-state machine it concerns must be LOADED.
      verify: async () => {
        ctx.onProgress?.("verify");
        const { ok: loadedAfter } = await verifySettled(() => allLoaded(dev, concerned, memMapped), (l) => l);
        if (!loadedAfter) return false;
        for (const t of tableRefs ?? []) {
          const { ok } = await verifySettled(() => dev.tableAddr(t.lsm), (got) => got === t.address);
          if (!ok) return false;
        }
        for (const s of segments) {
          const { ok } = await verifySettled(() => dev.memRead(s.address, s.image.length), (back) => verifyMaskedBytes(back, s.image, s.verify));
          if (!ok) return false;
        }
        return true;
      },
    }));
  }

  planFullDownload(mask: string, inputs: FullDownloadInputs): FullDownloadBuild {
    refuseSecureTables(inputs, this.family);
    const { plan, segments, imageBytes } = this.planSystem7Full(mask, inputs);
    return { plan, imageBytes, segments: segments.map((s) => ({ id: s.id, lsm: s.lsm, source: s.source, address: s.address, image: s.image })) };
  }

  private planSystem7Full(mask: string, ctx: FullDownloadInputs): { plan: LoadPlan; segments: AbsFullSegment[]; imageBytes: number; tableRefs?: { lsm: number; address: number }[] } {
    const cfg = this.requireCfg("full download");
    const proc = ctx.proc;
    const propertyMapped = !isMemoryMappedLsm(mask);
    if (propertyMapped && !cfg.groupTables.comObjectSegment) {
      throw new ProductError("FULL_DOWNLOAD_UNSUPPORTED",
        `property-mapped device (mask ${mask}) declares no <ComObjectTable CodeSegment>; cannot author its com-object table, refusing to write a manufacturer-default L3`);
    }
    refuse(absoluteFullStepRefusal(proc, absoluteFullForm(proc, ctx.unitHoldsApplication ?? false)) ?? fullDownloadSegmentRefusal(cfg, proc));
    refuseTunnelingEntries(cfg);
    const instances = cfg.hasModules ? (ctx.moduleInstances?.length ? ctx.moduleInstances : resolveModuleInstances(cfg, ctx.params)) : [];
    const view = buildDeviceConfig(cfg, ctx.params, undefined, instances);
    // A link whose com-object this configuration does not activate would build an association to an
    // object the device ignores: a group address the UI calls programmed and the device never answers.
    // Refuse, exactly as the surgical GA flash and the System B full download do. Without this the
    // MV-0705 L3 author clears the (inactive) object's linked bit while the association is still emitted.
    const active = new Set(view.imageComObjects.keys());
    const orphans = ctx.links.filter((l) => !active.has(l.comObjNum));
    if (orphans.length) {
      throw new ProductError("LINK_COM_OBJECT_INACTIVE",
        `${orphans.length} group-address link(s) target communication objects this configuration does not activate (e.g. #${orphans[0].comObjNum}); the device would ignore them, so refusing to report them as programmed`);
    }
    // The com-object table is authored on both LSM styles where the application names its segment:
    // the visibility-gated active objects (imageComObjects) overlaid on the segment's static template,
    // with the linked set from the group-address links (comobjbuild.ts buildComObjectTableMv0705;
    // MDT BE-02001.02 and ABB US/U 4.2 ETS captures).
    const comObjectTable = cfg.groupTables.comObjectSegment !== undefined
      ? { active: withInstanceOverrides(view.imageComObjects, ctx.comObjectOverrides), linked: new Set(ctx.links.map((l) => l.comObjNum)) }
      : undefined;
    refuseUnwritableOverrides(view.imageComObjects, ctx.comObjectOverrides, comObjectTable ? MV0705_OVERRIDABLE : [],
      comObjectTable ? "the System 7 com-object table" : "this full download, which writes the application's own com-object table");
    // These devices persist to EEPROM as each segment is written, so the closing A_Restart only
    // re-runs the application; it is not the persistence boundary (unlike thelsing/knx). Do not
    // demand a reboot signal the BIM M112 firmware need not give; the post-restart read-back proves
    // the configuration is really there.
    const form = absoluteFullForm(proc, ctx.unitHoldsApplication ?? false);
    const { plan, segments, imageBytes, tableRefs } = planAbsoluteFullDownload(cfg, ctx.params, ctx.links, iaToNum(ctx.ia), proc, { moduleInstances: instances, requireReboot: false, propertyMapped, comObjectTable, form });
    if (imageBytes === 0) throw new ProductError("EMPTY_IMAGE", "built an empty download image; refusing to commission nothing");

    return { plan, segments, imageBytes, ...(tableRefs ? { tableRefs } : {}) };
  }

  // Commission an absolute-segment (System 7) device from its declared load procedure: author the
  // address + association tables (from the links), every parameter-bearing segment (its <Data>
  // overlaid with the active parameters), and the static application segments (com-object table +
  // code, straight from their <Data>), driving the LSM brackets over the memory-mapped interface
  // (MV-0700/0701). Unlike the surgical par flash this writes EVERY segment, so a virgin device
  // comes up running. The device validates none of it; the read-back after the restart is the
  // only proof, so a "flashed" result carries a real verified flag.
  async downloadFull(dev: KnxDevice, mask: string, ctx: FullDownloadCtx): Promise<FlashResult> {
    refuseSecureTables(ctx, this.family);
    const cfg = this.requireCfg("full download");
    // Property-mapped System 7 (MV-0705) authors its com-object table (L3); memory-mapped MV-0700/0701
    // writes L3 as the manufacturer's static <Data>. The two paths share planAbsoluteFullDownload; the
    // difference is whether `comObjectTable` is supplied (see deviceflash.ts). ETS puts these devices
    // into verify mode (DeviceControl obj0/PID14 |= VERIFY_MODE) so the device echoes each write; we do
    // not need it — planAbsoluteFullDownload's writeMem reads every write back instead, the mechanism
    // the MV-0705 par flash is hardware-proven on for this device family (docs/commissioning.md).
    const propertyMapped = !isMemoryMappedLsm(mask);
    if (propertyMapped && !cfg.groupTables.comObjectSegment) {
      throw new ProductError("FULL_DOWNLOAD_UNSUPPORTED",
        `property-mapped device (mask ${mask}) declares no <ComObjectTable CodeSegment>; cannot author its com-object table, refusing to write a manufacturer-default L3`);
    }
    const proc = parseLoadProcedures(ctx.appXml);
    refuseTunnelingEntries(cfg);
    // App-id pre-flight, virgin-aware. The checks come from the download's OWN "full" steps (not
    // the "par" list), so a CompareProp declared AppliesTo="full" is never missed. A match = the
    // device already holds this application (re-commission); an all-zero read = a virgin device
    // (the intended from-nothing case); a DIFFERENT non-zero application is refused, so a full
    // download never lands the wrong app's image on a device. Unmodeled *steps* are refused by the
    // planner (planAbsoluteFullDownload's default case), which walks the same "full" list.
    for (const c of declaredPropChecks(proc, "full")) {
      const { ok, got } = await compareDeclaredProp(dev, c.obj, c.pid, c.expect, c.mask);
      const virgin = got.length === 0 || got.every((b) => b === 0);
      if (!ok && !virgin) {
        throw new ProductError("LOAD_PROC_CHECK_FAILED",
          `object ${c.obj} property ${c.pid} reads ${got.toString("hex")} but this application is ${c.expect.toString("hex")}; refusing to commission a different application onto this device`);
      }
    }
    // Which form ETS runs (absoluteFullForm): an application declaring PreferPartialDownloadIfApplicationLoaded
    // on a unit that holds it, loaded, takes the partial form; ETS reads the program id and the load states
    // to tell (ABB US/U 4.2, Gira M-0008 captures). The declared form reads nothing first.
    // A unit holding another application (a non-zero program id that is not this one) is not overwritten:
    // which application a device runs is the user's decision, made in the project, not the download's.
    const id = await dev.propRead(OBJ.COMOBJ_TABLE, PID.PROGRAM_ID);
    if (id.length && id.some((x) => x !== 0) && !id.equals(programIdStamp(cfg))) {
      throw new ProductError("LOAD_PROC_CHECK_FAILED", `the device holds program id ${id.toString("hex")} where this application is ${programIdStamp(cfg).toString("hex")}; refusing to commission a different application onto it`);
    }
    let unitHoldsApplication = false;
    if (proc.preferPartialIfLoaded) {
      const states = [];
      for (const obj of [OBJ.ADDR_TABLE, OBJ.ASSOC_TABLE, OBJ.COMOBJ_TABLE]) states.push(await lsmState(dev, obj, isMemoryMappedLsm(mask)));
      unitHoldsApplication = id.equals(programIdStamp(cfg)) && states.every((st) => st === STATE.LOADED);
    }
    const form = absoluteFullForm(proc, unitHoldsApplication);
    const stepRefusal = absoluteFullStepRefusal(proc, form);
    if (stepRefusal && form === "declared" && proc.preferPartialIfLoaded && !absoluteFullStepRefusal(proc, "partial")) {
      throw new ProductError("FULL_DOWNLOAD_APPLICATION_NOT_LOADED",
        `the device does not hold this application loaded (program id ${programIdStamp(cfg).toString("hex")}, load-state machines 1-3), and the procedure ETS runs on such a device cannot be executed: ${stepRefusal.message}`);
    }
    refuse(stepRefusal ?? fullDownloadSegmentRefusal(cfg, proc));
    if (form === "partial") {
      // ETS authorizes with the free key first and is granted level 0 (gira-m0008-ets-fulldownload.log); a
      // device that grants less was not captured taking the partial form.
      const level = await dev.authorizeFreeKey();
      if (level !== 0) {
        throw new ProductError("FULL_DOWNLOAD_ACCESS_LEVEL", `the device grants access level ${level} to the free key where the ETS capture of the partial download shows level 0; refusing to start a download it may refuse halfway`);
      }
    }

    const { plan, segments, imageBytes, tableRefs } = this.planSystem7Full(mask, { ...ctx, proc, unitHoldsApplication });

    // Back up every declared absolute segment before the unload/rewrite destroys it, sized by the
    // app's own segment declarations. OFF by default (ctx.backupBeforeUnload): the download rebuilds
    // every segment from the project, so reading them all back first is minutes of bus traffic for a
    // recovery copy whose payoff is narrow (see FullDownloadCtx.backupBeforeUnload). The read stays
    // here, gated, for a future opt-in.
    const stamp = Date.now();
    const backups: { file: string; bytes: Buffer }[] = [];
    if (ctx.backupBeforeUnload) {
      ctx.onProgress?.("backup");
      const backTotal = cfg.absoluteSegments.reduce((n, s) => n + s.size, 0);
      let backDone = 0;
      for (const seg of cfg.absoluteSegments) {
        const bytes = await dev.memRead(seg.address, seg.size, undefined, (d) => ctx.onProgress?.("backup", backDone + d, backTotal), ctx.signal);
        backDone += seg.size;
        backups.push({ file: `${ctx.deviceId}-abs-${seg.id.split("_").pop()}-${stamp}.bin`, bytes });
      }
    }

    const memMappedLsms = isMemoryMappedLsm(mask);
    return runFlashOp(dev, mask, ctx, {
      extendedMemory: this.requireCfg("full download").loadProcedures.extendedMemoryServices,
      imageBytes,
      imageDigest: fullDownloadImageDigest(segments),
      diffBytes: imageBytes, // a full download owns every byte it writes
      backup: `${ctx.deviceId}-full-${stamp}`,
      backups,
      write: async () => { await runLoadPlan(dev, plan, { memMappedLsms, readCompare: memMappedLsms, onWrite: (d, t) => ctx.onProgress?.("write", d, t) }); },
      // Read every written segment back and compare to what we built, masking out the download-
      // recognition bytes the device re-stamps for itself (the MV-0701 P-2228 "Downloaderkennung").
      // Only a full byte-match across every segment is a verified download.
      verify: async () => {
        // Tables re-declared away from their declared segments: the bytes alone do not show the device
        // reads them there, so each table's reference (PID 7) must be the address it was declared at.
        for (const t of tableRefs ?? []) {
          const { ok } = await verifySettled(() => dev.tableAddr(t.lsm), (at) => at === t.address);
          if (!ok) return false;
        }
        for (const s of segments) {
          const back = await dev.memRead(s.address, s.image.length, undefined, (d, n) => ctx.onProgress?.("verify", d, n));
          if (!verifyMaskedBytes(back, s.image, s.verify)) return false;
        }
        return true;
      },
    });
  }
}


// System 1 (BCU1) devices: the application's parameters and every table in the EEPROM segment at 0x0100
// (system1.ts). Read: the segment, where it holds this application loaded, decoded at the offsets the application gives (the MDT IP Interface
// Secure read under its secure session holds ETS's values there), and the group tables where they are
// empty. Every write is refused: no ETS capture of a System 1 download exists (system1LoadRefusal).
export class System1Profile extends DeviceProfile {
  readonly memoryModel = "bcu1" as const;
  constructor(readonly family: SystemFamily, mask: string, cfg: AppConfig | null) { super(mask, cfg); }

  capabilities(): DeviceCapabilities {
    const read = !!this.cfg && bcu1Segment(this.cfg) !== undefined;
    return { readParams: read, readLinks: read, flashParams: false, flashLinks: false, fullDownload: false, structuralFlash: false };
  }

  override operationRefusals(): OperationRefusals {
    if (!this.cfg) return {};
    const load = system1LoadRefusal(this.cfg);
    return { flashParams: load, fullDownload: load, flashLinks: SYSTEM1_GROUP_TABLES_REFUSAL };
  }

  async readState(dev: KnxDevice, mask: string, ctx: ReadStateCtx): Promise<DeviceReadback> {
    const cfg = this.requireCfg("read-back");
    const seg = bcu1Segment(cfg);
    if (!seg) throw new UnsupportedOperation("read-back", this.family, this.mask);
    const paramBase = new Map(ctx.baseParams ?? ctx.liveParams);
    const model = toAppModel(cfg, { includeUnions: true, instances: [] });
    const target = buildAbsoluteSegmentTargets(cfg, ctx.liveParams, { textRefusals: "skip" }).find((t) => t.id === seg.id);
    const eeprom = await dev.memRead(seg.address, seg.size, undefined, (d) => ctx.onProgress?.("params", d, seg.size), ctx.signal);
    refuse(bcu1ApplicationRefusal(cfg, eeprom));
    const deviceVals = decodeAbsoluteImage(model, seg.id, eeprom);
    const projectVals = target ? decodeAbsoluteImage(model, seg.id, target.bytes) : new Map<string, string>();
    if (target) dropUnownedText(model, deviceVals, (p) => (p.codeSegment === seg.id ? target.owned : undefined));
    const device = deviceRelevantRefs(deviceVals, ctx.liveParams, ctx.configFor);
    foldDeviceValues(paramBase, deviceVals, projectVals, ctx.liveParams, device?.relevant);
    const links = decodeEmptyBcu1Tables(eeprom);
    return { mask, paramsRead: true, linksRead: links !== null, paramBase, links: links ?? [], deviceConfig: device?.deviceConfig };
  }

  async flashParameters(): Promise<FlashResult> { refuseWith(system1LoadRefusal(this.requireCfg("parameter flash"))); }
  async flashGroupTables(): Promise<FlashResult> { refuseWith(SYSTEM1_GROUP_TABLES_REFUSAL); }
  override async downloadFull(): Promise<FlashResult> { refuseWith(system1LoadRefusal(this.requireCfg("full download"))); }
  override planFullDownload(): FullDownloadBuild { refuseWith(system1LoadRefusal(this.requireCfg("full download"))); }
}

// Every recognised-but-not-implemented memory model: System 2 (BCU2), System 300, couplers,
// interfaces, IR decoders, media couplers, RF-only, unknown masks.
// Capabilities are all false and every operation throws, so such a device is reported as
// honestly unsupported instead of being misrouted into a path that would fabricate a result.
export class UnsupportedProfile extends DeviceProfile {
  constructor(readonly memoryModel: MemoryModel, readonly family: SystemFamily, mask: string, cfg: AppConfig | null) { super(mask, cfg); }
  capabilities(): DeviceCapabilities { return { readParams: false, readLinks: false, flashParams: false, flashLinks: false, fullDownload: false, structuralFlash: false }; }
  async readState(): Promise<DeviceReadback> { throw new UnsupportedOperation("read-back", this.family, this.mask); }
  async flashParameters(): Promise<FlashResult> { throw new UnsupportedOperation("parameter flash", this.family, this.mask); }
  async flashGroupTables(): Promise<FlashResult> { throw new UnsupportedOperation("group-address flash", this.family, this.mask); }
}

function profileFor(mask: string, cfg: AppConfig | null): DeviceProfile {
  const info = maskInfo(mask);
  switch (info.memoryModel) {
    case "relative": return new SystemBProfile(info.family, mask, cfg);
    case "absolute": return new System7Profile(info.family, mask, cfg);
    case "bcu1": return new System1Profile(info.family, mask, cfg);
    // Memory models nobody has implemented. They resolve to a profile whose every operation
    // throws, which is the whole point (see UnsupportedProfile). Enumerated rather than caught by
    // a `default`, so that a model added to masks.ts cannot land here by accident and be declared
    // unsupported when someone has in fact implemented it.
    case "bcu2": case "system300": case "none":
      return new UnsupportedProfile(info.memoryModel, info.family, mask, cfg);
  }
}

// Resolve a parsed application to its device profile. Dispatches on the MEMORY MODEL the mask
// version implies (masks.ts), never on incidental structure (the old "has an absolute segment"
// heuristic misrouted System 1 devices that happen to carry one).
export function classify(cfg: AppConfig): DeviceProfile {
  return profileFor(cfg.mask, cfg);
}

// Resolve a profile from a mask string alone, for the GA-flash path where the application is
// not re-parsed (group tables depend only on the memory model). Parameter operations on the
// returned profile throw (no cfg); the GA path never calls them.
export function classifyByMask(mask: string): DeviceProfile {
  return profileFor(mask, null);
}


// The reader (grouptable-read.ts) refuses a group table whose count header exceeds this; the
// backup path matches it so the two twins agree on what "not in the expected format" means.
const MAX_BACKUP_TABLE_ENTRIES = 2048;

// How many bytes a loaded group table occupies on the device, from its own count header. Used to
// back up an already-programmed device's tables before a full download destroys them. An
// implausible count means the loaded table is not in the expected System B form, so its true
// length is unknown: backing up a guessed span and then unloading the real table would destroy
// bytes the "backup" never captured. Refuse the whole download instead (the same coded error the
// reader raises on the same condition), rather than silently skipping the table and unloading it.
async function tableByteLength(dev: KnxDevice, obj: number, at: number): Promise<number> {
  const head = await dev.memRead(at, 2);
  const count = (head[0] << 8) | head[1];
  if (count > MAX_BACKUP_TABLE_ENTRIES) {
    throw new GroupTableUnreadable(
      `loaded group object ${obj} table reports ${count} entries (implausible); refusing the full download rather than unloading a table this backup cannot capture`);
  }
  const entryBytes = obj === OBJ.ASSOC_TABLE ? 4 : 2;
  return 2 + count * entryBytes;
}
