import { useTranslation } from "react-i18next";
import type { FlashResult } from "../api.ts";

const hex = (n: number) => `0x${n.toString(16).toUpperCase().padStart(4, "0")}`;
const rangeText = (rs: { address: number; length: number }[]) => rs.map((x) => (x.length === 1 ? hex(x.address) : `${hex(x.address)}-${hex(x.address + x.length - 1)}`)).join(", ");

// The bytes of a verified write the device does not give back when read, resting on its write
// confirmation alone (FlashResult.confirmedOnly): their count and device addresses, null where the
// read-back showed every byte.
export function confirmedOnlyNote(r: FlashResult): { bytes: number; ranges: string } | null {
  if (r.kind !== "flashed" || !r.verified || !r.confirmedOnly?.length) return null;
  return {
    bytes: r.confirmedOnly.reduce((n, x) => n + x.length, 0),
    ranges: rangeText(r.confirmedOnly),
  };
}

// The bytes of a dry run's difference the device reads as FF (FlashResult.readsFF): what it returns for a
// byte it does not give back, so the preview names them; null where there are none.
export function readsFFNote(r: FlashResult): { bytes: number; ranges: string } | null {
  if (r.kind !== "dryRun" || !r.readsFF?.length) return null;
  return { bytes: r.readsFF.reduce((n, x) => n + x.length, 0), ranges: rangeText(r.readsFF) };
}

// Shown beside a dry run's preview line.
export function ReadsFFNote({ result }: { result: FlashResult }) {
  const { t } = useTranslation();
  const note = readsFFNote(result);
  if (!note) return null;
  return <span className="text-amber-600 dark:text-amber-400" data-testid="flash-reads-ff"> {t("flash.readsFF", note)}</span>;
}

// Shown beside a verified write's success line, in the warning colour: these bytes are not read back.
export function ConfirmedOnlyNote({ result }: { result: FlashResult }) {
  const { t } = useTranslation();
  const note = confirmedOnlyNote(result);
  if (!note) return null;
  return <span className="text-amber-600 dark:text-amber-400" data-testid="flash-confirmed-only">{t("flash.confirmedOnly", note)}</span>;
}
