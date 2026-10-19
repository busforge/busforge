import { RotateCcw, Undo2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { CfgComObjView, ComObjFlagEdit, DeviceConfigView } from "../api.ts";

type Flag = keyof CfgComObjView["flags"];
type Bit = NonNullable<DeviceConfigView["comObjFlagsEditable"]>[number];
// ETS's order of the flags (C R W T U I).
const FLAGS: { flag: Flag; key: string }[] = [
  { flag: "comm", key: "Communication" }, { flag: "read", key: "Read" }, { flag: "write", key: "Write" },
  { flag: "transmit", key: "Transmit" }, { flag: "update", key: "Update" }, { flag: "readOnInit", key: "ReadOnInit" },
];
const PRIORITIES = ["Low", "High", "Alert"] as const;

interface Props {
  co: CfgComObjView;
  editable: readonly Bit[];
  onEdit: (edit: ComObjFlagEdit) => void;
  onRevert: () => void;
  disabled?: boolean;
  testId: string;
}

// The flags and priority the project gives a com-object, editable where the device's full download
// writes them (`editable`, the device view's comObjFlagsEditable): each flag set otherwise than the
// application can be reset to the application's value, and an edit not yet written to the device can
// be reverted to what the device holds.
export function FlagEditorPanel({ co, editable, onEdit, onRevert, disabled, testId }: Props) {
  const { t } = useTranslation();
  const can = new Set<Bit>(editable);
  const overridden = new Set(co.overriddenFlags ?? []);
  return (
    <div className="flex flex-col gap-2 text-sm" data-testid={`${testId}-panel`}>
      {!editable.length && <p className="text-xs text-muted-foreground" data-testid={`${testId}-not-editable`}>{t("device.flagsNotEditable")}</p>}
      {FLAGS.map(({ flag, key }) => (
        <div key={flag} className="flex items-center gap-2">
          <label className={cn("flex flex-1 items-center gap-2", !can.has(flag) && "text-muted-foreground")} title={can.has(flag) ? undefined : t("device.flagNotWritable")}>
            <input
              type="checkbox" checked={co.flags[flag]} disabled={disabled || !can.has(flag)} data-testid={`${testId}-${flag}`}
              onChange={(e) => onEdit({ flags: { [flag]: e.target.checked } })}
            />
            <span>{t(`device.flag${key}`)}{overridden.has(flag) ? "*" : ""}</span>
          </label>
          {overridden.has(flag) && can.has(flag) && (
            <Button
              type="button" variant="ghost" size="sm" className="h-6 px-1.5 text-xs text-muted-foreground" disabled={disabled} data-testid={`${testId}-${flag}-reset`}
              title={t("device.flagResetTitle", { value: t(co.flags[flag] ? "device.flagOff" : "device.flagOn") })}
              onClick={() => onEdit({ flags: { [flag]: null } })}
            >
              <Undo2 className="size-3" /> {t("device.flagReset")}
            </Button>
          )}
        </div>
      ))}
      <div className="flex items-center gap-2">
        <label className={cn("flex flex-1 items-center gap-2", !can.has("priority") && "text-muted-foreground")} title={can.has("priority") ? undefined : t("device.flagNotWritable")}>
          <span>{t("device.priority")}{co.overriddenPriority ? "*" : ""}</span>
          <select
            className="h-7 rounded-md border bg-background px-1 text-sm" value={co.priority} disabled={disabled || !can.has("priority")} data-testid={`${testId}-priority`}
            onChange={(e) => onEdit({ priority: e.target.value as (typeof PRIORITIES)[number] })}
          >
            {PRIORITIES.map((p) => <option key={p} value={p}>{t(`device.priority${p}`)}</option>)}
          </select>
        </label>
        {co.overriddenPriority && can.has("priority") && (
          <Button type="button" variant="ghost" size="sm" className="h-6 px-1.5 text-xs text-muted-foreground" disabled={disabled} data-testid={`${testId}-priority-reset`} onClick={() => onEdit({ priority: null })}>
            <Undo2 className="size-3" /> {t("device.flagReset")}
          </Button>
        )}
      </div>
      {(overridden.size > 0 || co.overriddenPriority) && <p className="text-xs text-muted-foreground">{t("device.flagsOverriddenNote")}</p>}
      {co.flagsChanged && (
        <Button type="button" variant="outline" size="sm" className="self-start" disabled={disabled} data-testid={`${testId}-revert`} onClick={onRevert}>
          <RotateCcw className="size-3.5" /> {t("device.flagsRevert")}
        </Button>
      )}
    </div>
  );
}

// The object's set flags as ETS's letters, opening the panel.
export function FlagEditor(props: Props) {
  const { t } = useTranslation();
  const { co, testId } = props;
  const letters = FLAGS.filter(({ flag }) => co.flags[flag]).map(({ key }) => t(`device.flagLetter${key}`)).join(" ");
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button" variant="outline" size="sm" data-testid={testId} title={t("device.flagsEdit")}
          className={cn("h-7 shrink-0 px-2 font-mono text-xs", co.flagsChanged && "border-primary text-primary")}
        >
          {letters || "–"}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64"><FlagEditorPanel {...props} /></PopoverContent>
    </Popover>
  );
}
