import { Activity, ChevronLeft, Cpu, Network, SlidersHorizontal } from "lucide-react";
import { Link, Outlet, useParams, useRouterState } from "@tanstack/react-router";
import { useProject, useBusStatus } from "../queries.ts";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/StatusBadge.tsx";

const TABS = [
  { id: "devices", to: "/projects/$projectId/devices", label: "Devices", icon: Cpu },
  { id: "groups", to: "/projects/$projectId/groups", label: "Group addresses", icon: Network },
  { id: "monitor", to: "/projects/$projectId/monitor", label: "Bus monitor", icon: Activity },
  { id: "interface", to: "/projects/$projectId/interface", label: "Interface", icon: SlidersHorizontal },
] as const;

export function ProjectLayout() {
  const { projectId } = useParams({ from: "/projects/$projectId" });
  const { data: project } = useProject(projectId);
  const { data: bus } = useBusStatus(projectId);

  // Which tab is active, derived from the path segment after the project id.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const seg = pathname.split("/")[3] ?? "devices"; // /projects/:id/<seg>/...

  return (
    <div className="mx-auto flex min-h-full max-w-6xl flex-col gap-0">
      <header className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <Button asChild variant="ghost" size="icon" aria-label="All projects" className="shrink-0 text-muted-foreground">
            <Link to="/"><ChevronLeft className="size-5" /></Link>
          </Button>
          <div className="min-w-0 leading-tight">
            <div className="truncate text-base font-bold">{project?.name ?? "…"}</div>
            {project && (
              <div className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">{project.devices.length} devices · {project.gaCount} GAs</div>
            )}
          </div>
        </div>
        <StatusBadge status={bus?.status ?? "disconnected"} />
      </header>

      <nav className="sticky top-0 z-10 flex w-full justify-start gap-1 overflow-x-auto border-y border-border bg-background/85 px-2 backdrop-blur sm:px-4">
        {TABS.map((t) => {
          const active = seg === t.id;
          return (
            <Link
              key={t.id}
              to={t.to}
              params={{ projectId }}
              className={`flex shrink-0 items-center gap-2 border-b-2 px-3 py-3 text-sm ${active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
            >
              <t.icon className="size-4" />
              <span className="hidden sm:inline">{t.label}</span>
            </Link>
          );
        })}
      </nav>

      <main className="flex-1 px-4 py-6 sm:px-6">
        <Outlet />
      </main>
    </div>
  );
}
