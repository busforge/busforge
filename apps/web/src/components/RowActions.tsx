import type { ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { IconButton } from "@/components/ui/icon-button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export interface RowAction { label: string; icon: ReactNode; onClick: () => void; danger?: boolean; testId?: string }

// The management actions of a list row or a section heading (add, rename, delete). With a mouse they
// are icon buttons that appear on hover or keyboard focus, out of the way while browsing; on a touch
// screen, which has no hover, one always-visible menu button opens them with their labels. Without
// any pointer (keyboard only) the icon buttons stay visible.
// `shown`: the icon buttons stay visible with a mouse too (a heading whose actions are its point).
export function RowActions({ actions, menuLabel, shown = false, className }: { actions: RowAction[]; menuLabel: string; shown?: boolean; className?: string }) {
  return (
    <div className={cn("flex items-center", className)}>
      <div className={cn("flex items-center pointer-coarse:hidden", !shown && "transition-opacity pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:focus-within:opacity-100")}>
        {actions.map((a) => (
          <IconButton
            key={a.label} size="icon-sm" label={a.label} data-testid={a.testId}
            onClick={(e) => { e.stopPropagation(); a.onClick(); }}
            className={cn("text-muted-foreground", a.danger ? "hover:not-disabled:text-destructive" : "hover:not-disabled:text-foreground")}
          >
            {a.icon}
          </IconButton>
        ))}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton size="icon-sm" label={menuLabel} tooltip={false} className="hidden text-muted-foreground pointer-coarse:inline-flex" onClick={(e) => e.stopPropagation()}>
            <MoreHorizontal className="size-4" />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
          {actions.map((a) => (
            <DropdownMenuItem key={a.label} onSelect={a.onClick} data-testid={a.testId && `${a.testId}-menu`} className={cn(a.danger && "text-destructive focus:bg-destructive/10 focus:text-destructive")}>
              {a.icon} {a.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
