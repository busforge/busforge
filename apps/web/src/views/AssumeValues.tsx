import { AlertTriangle, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ApiError, type AssumedValue, type DeviceConfigView } from "../api.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { localizeError } from "../lib/apiError.ts";

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

// Offered after a read-back whose device links objects its configuration does not show under the
// values read: the parameters that may decide this cannot be read, so the user names the values the
// device runs and reads again with them. Nothing is taken unless that read proves them (server side).
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

// Assumed values the read-back took although another value of the same parameter writes the same
// bytes: the device cannot show them, so they stand as assumed, never as read. Named as the page
// showed them around the read; a parameter it showed nowhere is named generically, never by its id.
export function UnprovenAssumptionsNote({ params }: { params: { refId: string; name?: string }[] }) {
  const { t } = useTranslation();
  if (!params.length) return null;
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-sm text-amber-700 dark:text-amber-300" data-testid="unproven-assumptions">
      <p className="flex items-center gap-2 font-medium"><AlertTriangle className="size-4 shrink-0" /> {t("device.unprovenTitle")}</p>
      <p className="mt-0.5 text-xs text-amber-700/90 dark:text-amber-300/90">{t("device.unprovenBody", { params: params.map((p) => p.name ?? t("device.unprovenUnnamed")).join(", ") })}</p>
    </div>
  );
}

const paramNames = (view?: DeviceConfigView): Map<string, string> => {
  const m = new Map<string, string>();
  for (const b of view?.blocks ?? []) for (const it of b.items) if (it.kind === "param" && !m.has(it.param.refId)) m.set(it.param.refId, it.param.name.trim());
  return m;
};

// What the last read-back of the shown device left open: objects of device links its configuration
// does not show, and assumed values the device could not tell apart; plus the offer's own state. A
// result or edit for another device than the shown one is ignored.
export interface AssumeState {
  deviceId: string;
  lastRead: { unresolved: number[]; unproven: { refId: string; name?: string }[] } | null;
  choices: Record<string, string>;
  error?: AssumeRefusal;
}
export type AssumeAction =
  | { type: "device"; deviceId: string }
  | { type: "choose"; refId: string; value: string }
  | { type: "invalid"; names: string[] }
  // `sent`: the parameters this read was asked to assume (none for a plain read).
  | { type: "readOk"; deviceId: string; sent: string[]; result: DeviceConfigView; before?: DeviceConfigView }
  | { type: "readFailed"; deviceId: string; assumed: boolean; error: unknown }
  | { type: "paramChanged"; deviceId: string; refId: string };

export const initialAssumeState = (deviceId: string): AssumeState => ({ deviceId, lastRead: null, choices: {} });

export function assumeReducer(s: AssumeState, a: AssumeAction): AssumeState {
  switch (a.type) {
    case "device": return a.deviceId === s.deviceId ? s : initialAssumeState(a.deviceId);
    case "choose": return { ...s, choices: { ...s.choices, [a.refId]: a.value }, error: s.error?.invalid ? undefined : s.error };
    case "invalid": return { ...s, error: { message: "", invalid: a.names } };
    case "readOk": {
      if (a.deviceId !== s.deviceId) return s;
      // A read decides only the parameters it was asked to assume: an earlier unproven value of another
      // parameter stays, one assumed again takes this read's verdict.
      const after = paramNames(a.result), before = paramNames(a.before), sent = new Set(a.sent);
      const unproven = [
        ...(s.lastRead?.unproven ?? []).filter((u) => !sent.has(u.refId)),
        ...(a.result.readback?.unprovenAssumptions ?? []).map((refId) => ({ refId, name: after.get(refId) ?? before.get(refId) })),
      ];
      return { ...s, lastRead: { unresolved: a.result.readback?.unresolvedObjects ?? [], unproven }, error: undefined, choices: a.sent.length ? {} : s.choices };
    }
    case "readFailed": return a.deviceId !== s.deviceId ? s : { ...s, error: a.assumed ? assumeRefusal(a.error) : undefined };
    case "paramChanged":
      if (a.deviceId !== s.deviceId || !s.lastRead?.unproven.some((u) => u.refId === a.refId)) return s;
      return { ...s, lastRead: { ...s.lastRead, unproven: s.lastRead.unproven.filter((u) => u.refId !== a.refId) } };
  }
}
