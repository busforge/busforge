import type { CfgParamView } from "../api.ts";

type Translate = (key: string, opts?: Record<string, unknown>) => string;
type CalcRefusal = Extract<NonNullable<CfgParamView["calculations"]>[number], { state: "refused" }>["refusal"];

// Why Busforge does not run a calculation, in the user's language: its reason by code with the values the text names.
export function calcRefusalReason(t: Translate, refusal: CalcRefusal): string {
  return t(`device.calcRefusal.${refusal.code}`, refusal.params);
}
