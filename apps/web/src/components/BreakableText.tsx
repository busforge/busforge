import { Fragment } from "react";

// Catalogue text such as "RMG4x/8x,DMG/E2x,SME2S" has no space to wrap at. This offers a line break
// after each comma and slash, so on a narrow screen it wraps between its parts instead of running
// past its column. The text itself is unchanged (copy, search and screen readers see it as it is).
export function BreakableText({ text }: { text: string }) {
  const parts = text.split(/(?<=[,/])/);
  return <>{parts.map((part, i) => <Fragment key={i}>{i > 0 && <wbr />}{part}</Fragment>)}</>;
}
