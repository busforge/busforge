import { AlertTriangle, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ApiError, type AssumedValue, type DeviceConfigView } from "../api.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { localizeError } from "../lib/apiError.ts";

type KeptReasons = NonNullable<NonNullable<DeviceConfigView["readback"]>["neverProgrammedKept"]>;

// A parameter the device does not hold (no memory or property location), shown and editable on the
// device page, whose value a read-back can be asked to assume. The server takes enumerated and
// whole-number values only.
export interface AssumeCandidate {
  refId: string; name: string; block: string; value: string;
  options?: { value: number; text: string }[]; min?: number; max?: number;
}

export function assumeCandidates(view: DeviceConfigView): AssumeCandidate[] {
  const out: AssumeCandidate[] = [], seen = new Set<string>();
  for (const b of view.blocks) for (const it of b.items) {
    if (it.kind !== "param") continue;
    const p = it.param;
    if (!p.memoryless || p.readOnly || seen.has(p.refId)) continue;
    if (!(p.control === "enum" && p.options?.length) && !(p.control === "number" && !p.float)) continue;
    seen.add(p.refId);
    out.push({ refId: p.refId, name: p.name.trim(), block: b.name, value: p.value, ...(p.control === "enum" ? { options: p.options } : { min: p.min, max: p.max }) });
  }
  return out;
}

// A whole number as the server takes it (no sign on zero, no leading zeros), within the parameter's
// range; null for anything else.
function wholeNumber(c: AssumeCandidate, raw: string): string | null {
  const m = /^\s*([+-]?)0*(\d+)\s*$/.exec(raw);
  if (!m) return null;
  const v = m[2] === "0" ? "0" : `${m[1] === "-" ? "-" : ""}${m[2]}`;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || (c.min !== undefined && n < c.min) || (c.max !== undefined && n > c.max)) return null;
  return v;
}

// The chosen values of the offered parameters, as the read-back's `assume`, with the names of the
// chosen ones the server would refuse (a number that is no whole number in range); an empty choice is none.
export function assumeList(candidates: AssumeCandidate[], choices: Record<string, string>): { assume: AssumedValue[]; invalid: string[] } {
  const assume: AssumedValue[] = [], invalid: string[] = [];
  for (const c of candidates) {
    const raw = choices[c.refId] ?? "";
    if (raw.trim() === "") continue;
    const value = c.options ? raw : wholeNumber(c, raw);
    if (value === null) invalid.push(c.name);
    else assume.push({ paramRefId: c.refId, value });
  }
  return { assume, invalid };
}

// `invalid`: names of chosen values refused before sending (no server code).
export interface AssumeRefusal { code?: string; message: string; objects?: number[]; invalid?: string[] }
export function assumeRefusal(e: unknown): AssumeRefusal {
  if (!(e instanceof ApiError)) return { message: e instanceof Error ? e.message : String(e) };
  const objects = e.details?.objects;
  return { code: e.code, message: e.message, ...(Array.isArray(objects) && objects.every((n) => typeof n === "number") ? { objects } : {}) };
}

const cls = "h-8 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:w-64";

// Offered after a read-back whose device links objects no object of its own configuration takes under
// the values read (`unplacedObjects`): the parameters that may decide this cannot be read, so the user
// names the values the device runs and reads again with them. Nothing is taken unless that read proves
// them (server side).
export function AssumeValuesPanel({ candidates, unresolved, choices, onChoose, onSubmit, pending, error }: {
  candidates: AssumeCandidate[]; unresolved: number[]; choices: Record<string, string>;
  onChoose: (refId: string, value: string) => void; onSubmit: () => void; pending: boolean; error?: AssumeRefusal;
}) {
  const { t } = useTranslation();
  const list = assumeList(candidates, choices);
  const chosen = list.assume.length + list.invalid.length;
  return (
    <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300" data-testid="assume-values">
      <p className="flex items-center gap-2 font-medium"><AlertTriangle className="size-4 shrink-0" /> {t("device.assumeTitle")}</p>
      <p className="text-xs text-amber-700/90 dark:text-amber-300/90">{t("device.assumeIntro", { objects: unresolved.join(", ") })}</p>
      <ul className="max-h-72 space-y-1 overflow-y-auto pr-1">
        {candidates.map((c) => (
          <li key={c.refId} className="flex flex-col gap-1 text-foreground sm:flex-row sm:items-center sm:justify-between">
            <span className="min-w-0 truncate text-sm" title={`${c.block}: ${c.name}`}>
              <span className="text-muted-foreground">{c.block}: </span>{c.name}
            </span>
            {c.options ? (
              <select
                value={choices[c.refId] ?? ""} onChange={(e) => onChoose(c.refId, e.target.value)} aria-label={`${c.block}: ${c.name}`}
                className={cls} data-testid={`assume-${c.refId}`} disabled={pending}
              >
                <option value="">{t("device.assumeNotAssumed")}</option>
                {c.options.map((o) => <option key={o.value} value={String(o.value)}>{o.text}</option>)}
              </select>
            ) : (
              <Input
                type="number" step={1} min={c.min} max={c.max} value={choices[c.refId] ?? ""} placeholder={t("device.assumeNotAssumed")}
                onChange={(e) => onChoose(c.refId, e.target.value)} aria-label={`${c.block}: ${c.name}`} className="h-8 w-full sm:w-64"
                data-testid={`assume-${c.refId}`} disabled={pending}
              />
            )}
          </li>
        ))}
      </ul>
      {error && (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive" data-testid="assume-refused">
          <p>{error.invalid ? t("device.assumeNumberInvalid", { params: error.invalid.join(", ") }) : localizeError(t, error.code, error.message)}</p>
          {error.objects?.length ? <p data-testid="assume-refused-objects">{t("device.assumeStillUnresolved", { objects: error.objects.join(", ") })}</p> : null}
        </div>
      )}
      <div className="flex justify-end">
        <Button type="button" size="sm" onClick={onSubmit} disabled={pending || chosen === 0} data-testid="assume-submit">
          {pending && <Loader2 className="size-4 animate-spin" />} {t("device.assumeSubmit")}
        </Button>
      </div>
    </div>
  );
}

// The parameters whose shown value a read-back took as assumed and the device could not tell from
// another value (the view marks their rows `assumed`), each once, by their label.
export function assumedParams(view?: DeviceConfigView): { refId: string; name: string }[] {
  const out: { refId: string; name: string }[] = [], seen = new Set<string>();
  for (const b of view?.blocks ?? []) for (const it of b.items) {
    if (it.kind !== "param" || !it.param.assumed || seen.has(it.param.refId)) continue;
    seen.add(it.param.refId);
    out.push({ refId: it.param.refId, name: it.param.name.trim() });
  }
  return out;
}

// `hidden`: such parameters this configuration does not show (DeviceConfigView.assumedHidden).
export function UnprovenAssumptionsNote({ params, hidden = 0 }: { params: { refId: string; name: string }[]; hidden?: number }) {
  const { t } = useTranslation();
  if (!params.length && !hidden) return null;
  const names = params.map((p) => p.name).join(", ");
  const unshown = hidden ? t("device.unprovenHiddenCount", { count: hidden }) : "";
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-sm text-amber-700 dark:text-amber-300" data-testid="unproven-assumptions">
      <p className="flex items-center gap-2 font-medium"><AlertTriangle className="size-4 shrink-0" /> {t("device.unprovenTitle")}</p>
      <p className="mt-0.5 text-xs text-amber-700/90 dark:text-amber-300/90">{t("device.unprovenBody", { params: names && unshown ? t("device.unprovenAndHidden", { names, unshown }) : names || unshown })}</p>
    </div>
  );
}

const noteCls = "flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-sm text-amber-700 dark:text-amber-300";

// Objects of device links the last read left unresolved that no assumption places: those the project's
// own values hide (Revert takes the device's values), those the read could not tell without the device's
// parameters, and those no parameter this page offers to assume could place.
export function UnresolvedNotes({ hidden, unknown, unplacedUnoffered }: { hidden: number[]; unknown: number[]; unplacedUnoffered: number[] }) {
  const { t } = useTranslation();
  const notes = ([["unresolved-hidden", "device.unresolvedHidden", hidden], ["unresolved-unknown", "device.unresolvedUnknown", unknown], ["unresolved-unplaced", "device.unresolvedUnoffered", unplacedUnoffered]] as const)
    .filter(([, , objects]) => objects.length > 0);
  if (!notes.length) return null;
  return (
    <>
      {notes.map(([id, key, objects]) => (
        <div key={id} className={noteCls} data-testid={id}><AlertTriangle className="mt-0.5 size-4 shrink-0" /><span>{t(key, { objects: objects.join(", ") })}</span></div>
      ))}
    </>
  );
}

// Why a device never programmed from this project still counts so after the last read.
// The code of why the image was not compared is shown by its error text, else named as a code.
// `ets`: the device is never programmed because ETS has parts still to download, not because nothing of
// the project was ever in it.
export function NeverProgrammedKeptNote({ reasons, ets = false }: { reasons: KeptReasons; ets?: boolean }) {
  const { t, i18n } = useTranslation();
  if (!reasons.length) return null;
  return (
    <div className={noteCls} data-testid="never-programmed-kept">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <div className="space-y-0.5">
        <p className="font-medium">{t(ets ? "device.etsNotDownloadedKeptTitle" : "device.neverProgrammedKeptTitle")}</p>
        <p className="text-xs text-amber-700/90 dark:text-amber-300/90">{t("device.neverProgrammedKeptBody")}</p>
        <ul className="list-disc pl-4 text-xs text-amber-700/90 dark:text-amber-300/90">
          {reasons.map((r) => <li key={r.reason}>{t(`device.neverProgrammedReason.${r.reason}`)}{r.code ? ` (${i18n.exists(`errors.${r.code}`) ? t(`errors.${r.code}`) : t("device.errorCode", { code: r.code })})` : ""}</li>)}
        </ul>
      </div>
    </div>
  );
}

// What the last read-back of the shown device left open: the objects of device links it did not
// resolve, by what resolves them, and why the device stays never programmed; plus the offer's own
// state. A result or edit for another device than the shown one is ignored.
export interface AssumeState {
  deviceId: string;
  lastRead: { unplaced: number[]; hidden: number[]; unknown: number[]; neverProgrammedKept: KeptReasons } | null;
  choices: Record<string, string>;
  error?: AssumeRefusal;
}
export type AssumeAction =
  | { type: "device"; deviceId: string }
  | { type: "choose"; refId: string; value: string }
  | { type: "invalid"; names: string[] }
  // `assumed`: the read was asked to assume values.
  | { type: "readOk"; deviceId: string; assumed: boolean; result: DeviceConfigView }
  | { type: "readFailed"; deviceId: string; assumed: boolean; error: unknown }
  // An edit or a revert changed what the last read's objects were judged against.
  | { type: "stale"; deviceId: string }
  // A verified write: it can change what the device holds too (its application, its load states).
  | { type: "written"; deviceId: string };

export const initialAssumeState = (deviceId: string): AssumeState => ({ deviceId, lastRead: null, choices: {} });

// Never-programmed reasons that are facts about the device, not judgements of it against the project.
const DEVICE_REASONS = new Set<KeptReasons[number]["reason"]>(["readIncomplete", "otherApplication", "applicationIdNotReported", "notLoaded"]);

export function assumeReducer(s: AssumeState, a: AssumeAction): AssumeState {
  switch (a.type) {
    case "device": return a.deviceId === s.deviceId ? s : initialAssumeState(a.deviceId);
    case "choose": return { ...s, choices: { ...s.choices, [a.refId]: a.value }, error: s.error?.invalid ? undefined : s.error };
    case "invalid": return { ...s, error: { message: "", invalid: a.names } };
    case "readOk": {
      if (a.deviceId !== s.deviceId) return s;
      const rb = a.result.readback;
      const lastRead = { unplaced: rb?.unplacedObjects ?? [], hidden: rb?.hiddenObjects ?? [], unknown: rb?.unknownObjects ?? [], neverProgrammedKept: rb?.neverProgrammedKept ?? [] };
      return { ...s, lastRead, error: undefined, choices: a.assumed ? {} : s.choices };
    }
    // A refused assumption stores nothing, so the read before it still stands; a failed plain read does not.
    case "readFailed": return a.deviceId !== s.deviceId ? s : a.assumed ? { ...s, error: assumeRefusal(a.error) } : { ...s, lastRead: null, error: undefined };
    // The objects and the reasons judged against the project's values go; what the device reported stays.
    case "stale": return a.deviceId !== s.deviceId || !s.lastRead ? s
      : { ...s, lastRead: { unplaced: [], hidden: [], unknown: [], neverProgrammedKept: s.lastRead.neverProgrammedKept.filter((r) => DEVICE_REASONS.has(r.reason)) } };
    case "written": return a.deviceId !== s.deviceId ? s : { ...s, lastRead: null };
  }
}
