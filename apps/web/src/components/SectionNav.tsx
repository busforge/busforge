import { useRef, type ReactNode } from "react";
import { useStickyVar } from "@/lib/stickyChrome.ts";
import { cn } from "@/lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// One place a page section can be jumped to: a head entry, or a sub entry indented under it.
// `prefix` is a leading mark (a group-address range number), `changed` the amber "has changes" dot.
export interface SectionNavEntry { id: string; label: string; sub?: boolean; changed?: boolean; prefix?: ReactNode; testId?: string }

// The section index of a long page (floors and rooms, group-address ranges, a device's parameter
// sections). Wide windows get a sticky sidebar list; narrow ones a single "jump to" select, pinned
// under the tabs and following the scroll position, so it always names where the user is and the
// index never pushes the content down the screen.
export function SectionNav({ entries, active, onJump, label, changedTitle, context }: {
  entries: SectionNavEntry[];
  // What the page is about (a device's name and address), shown above the pinned narrow-window
  // jump, so the page's subject stays in view once its header has scrolled away.
  context?: ReactNode;
  active: string | null;
  onJump: (id: string) => void;
  // Accessible name of the index, also the select's placeholder.
  label: string;
  // Tooltip of the "has changes" dot; only needed where entries can be changed.
  changedTitle?: string;
}) {
  const current = active ?? entries[0]?.id;
  const jumpRef = useRef<HTMLDivElement>(null);
  useStickyVar([jumpRef], "--section-nav-h");
  const dot = (e: SectionNavEntry) => e.changed && <span className="ml-auto size-1.5 shrink-0 rounded-full bg-primary" title={changedTitle} />;
  return (
    <>
      <nav aria-label={label} className="hidden lg:sticky lg:top-[calc(var(--bar-h,0px)+var(--page-header-h,0px)+1rem)] lg:block lg:max-h-[calc(100vh-var(--bar-h,0px)-var(--page-header-h,0px)-2rem)] lg:w-60 lg:shrink-0 lg:overflow-y-auto">
        <ul className="flex flex-col gap-0.5">
          {entries.map((e) => {
            const on = active === e.id;
            return (
              <li key={e.id}>
                <button
                  type="button" onClick={() => onJump(e.id)} data-testid={e.testId} aria-current={on ? "location" : undefined}
                  className={cn(
                    "flex w-full items-center gap-1.5 rounded-md border-l-2 py-1 pr-2 text-left text-sm transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    e.sub ? "pl-5" : "pl-2",
                    on ? "border-foreground/50 bg-secondary font-medium text-foreground"
                      : e.sub ? "border-transparent text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
                      : "border-transparent font-medium text-foreground/80 hover:bg-secondary/60 hover:text-foreground",
                  )}
                >
                  {e.prefix}
                  <span className="truncate">{e.label}</span>
                  {dot(e)}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <div ref={jumpRef} className="sticky top-(--bar-h) z-10 -mx-4 bg-background/95 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6 lg:hidden">
        {context && <div className="mb-1.5 truncate text-xs text-muted-foreground">{context}</div>}
        <Select value={current} onValueChange={onJump}>
          <SelectTrigger aria-label={label} className="h-10 w-full" data-testid="section-jump">
            <SelectValue placeholder={label} />
          </SelectTrigger>
          <SelectContent position="popper" className="max-h-[60vh]">
            {entries.map((e) => (
              <SelectItem
                key={e.id} value={e.id} className={cn("min-h-10", e.sub && "pl-6 text-muted-foreground")}
                // Choosing the section already shown changes no value, so the select reports nothing:
                // jump back to its start here.
                onPointerUp={() => { if (e.id === current) onJump(e.id); }}
                onKeyDown={(k) => { if (e.id === current && (k.key === "Enter" || k.key === " ")) onJump(e.id); }}
              >
                {e.prefix}
                <span className="truncate">{e.label}</span>
                {e.changed && <span className="size-1.5 shrink-0 rounded-full bg-primary" title={changedTitle} />}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </>
  );
}
