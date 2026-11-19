import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";

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
  return (
    <span className="flex h-9 w-full items-center gap-2 pointer-coarse:h-11">
      <Checkbox
        checked={value === "1"} indeterminate={outside} disabled={disabled} aria-label={label}
        onChange={(e) => onChange(e.target.checked ? "1" : "0")} data-testid={testId}
      />
      {outside ? <Badge tone="danger" data-testid={`${testId}-outside`}>{t("device.noOption", { value })}</Badge> : null}
    </span>
  );
}
