import type { DaliDevice } from "./model.ts";
import { groupLabel, isPresentEcg, lampTypeLabel, commissioningLabel } from "./model.ts";

// Read-only DALI configuration view, the busforge-native replacement for the
// Theben e64 ETS DCA's Commissioning/Scenes screens. Rendered from the device's
// backup-store alone (no plugin, no bus). Tailwind classes resolve against the
// host app's stylesheet (the module is imported into its bundle).

const cell = "px-2 py-1 align-top";
const head = "px-2 py-1 text-left font-medium text-muted-foreground";

export default function DaliView({ model }: { model: DaliDevice }) {
  const fixtures = model.ecgs.filter(isPresentEcg);
  const slotOf = (shortAddress: number) => model.devEcgs.find((d) => d.index === shortAddress);
  const groupsUsed = model.groups.filter((g) => g.description);

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Fixtures ({fixtures.length})</h3>
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40">
              <tr>
                <th className={head}>#</th>
                <th className={head}>Name</th>
                <th className={head}>Group</th>
                <th className={head}>Short addr</th>
                <th className={head}>Long addr</th>
                <th className={head}>Type</th>
                <th className={head}>State</th>
              </tr>
            </thead>
            <tbody>
              {fixtures.map((e) => (
                <tr key={e.index} className="border-b border-border/40 last:border-0">
                  <td className={`${cell} font-mono text-muted-foreground`}>{e.index}</td>
                  <td className={cell}>{e.description || <span className="text-muted-foreground">(unnamed)</span>}</td>
                  <td className={cell}>{groupLabel(model.groups, e.groupIndex)}</td>
                  <td className={`${cell} font-mono`}>{e.shortAddress === 255 ? "-" : e.shortAddress}</td>
                  <td className={`${cell} font-mono text-muted-foreground`}>{slotOf(e.shortAddress)?.longAddress ?? "-"}</td>
                  <td className={cell}>{lampTypeLabel[e.type] ?? e.type}</td>
                  <td className={cell}>{commissioningLabel[e.flags] ?? e.flags}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Groups ({groupsUsed.length})</h3>
        <ul className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
          {groupsUsed.map((g) => {
            const n = fixtures.filter((e) => e.groupIndex === g.index).length;
            return (
              <li key={g.index} className="flex items-center justify-between rounded border border-border px-3 py-1.5 text-sm">
                <span>{g.description}</span>
                <span className="text-muted-foreground">{n} fixtures</span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Scenes ({model.scenes.length})</h3>
        <div className="flex flex-wrap gap-1.5">
          {model.scenes.map((s) => (
            <span key={s.index} className="rounded border border-border px-2 py-1 text-xs">
              Scene {s.index + 1} <span className="text-muted-foreground">→ KNX {s.knxScene}</span>
              {s.items.length > 0 && <span className="text-muted-foreground"> ({s.items.length})</span>}
            </span>
          ))}
        </div>
      </section>
    </div>
  );
}
