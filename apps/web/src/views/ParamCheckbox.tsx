import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

interface Props {
  value: string;
  label?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  testId: string;
}

// A number parameter ETS draws as a checkbox (CfgParamView.checkbox): ticked is 1, unticked 0. A value that is
// neither, which the project can hold from an import, is shown with the box neither ticked nor unticked and the
// value next to it; only a click sets the parameter to 0 or 1.
export function ParamCheckbox({ value, label, disabled, onChange, testId }: Props) {
  const { t } = useTranslation();
  const outside = value !== "0" && value !== "1";
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = outside; }, [outside]);
  return (
    <span className="flex h-9 w-full items-center gap-2 pointer-coarse:h-11">
      <input
        ref={ref} type="checkbox" checked={value === "1"} disabled={disabled} aria-label={label}
        onChange={(e) => onChange(e.target.checked ? "1" : "0")}
        className="size-4 shrink-0 accent-primary pointer-coarse:size-5" data-testid={testId}
      />
      {outside ? <span className="text-xs text-destructive" data-testid={`${testId}-outside`}>{t("device.noOption", { value })}</span> : null}
    </span>
  );
}
