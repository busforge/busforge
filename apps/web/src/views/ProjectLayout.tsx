import { Activity, Cpu, Network } from "lucide-react";
import { Link, Outlet, useParams, useRouterState } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useProject } from "../queries.ts";
import { Brandmark } from "@/components/Brandmark.tsx";
import { TaskIndicator } from "@/components/TaskIndicator.tsx";
import { SnapshotPanel } from "@/components/SnapshotPanel.tsx";
import { ExportDialog } from "@/components/ExportDialog.tsx";
import { LanguageSwitcher } from "@/components/LanguageSwitcher.tsx";

const TABS = [
  { id: "devices", to: "/projects/$projectId/devices", labelKey: "nav.devices", icon: Cpu },
  { id: "groups", to: "/projects/$projectId/groups", labelKey: "nav.groups", icon: Network },
  { id: "monitor", to: "/projects/$projectId/monitor", labelKey: "nav.monitor", icon: Activity },
] as const;

export function ProjectLayout() {
  const { t } = useTranslation();
  const { projectId } = useParams({ from: "/projects/$projectId" });
  const { data: project } = useProject(projectId);

  // Which tab is active, derived from the path segment after the project id.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const seg = pathname.split("/")[3] ?? "devices"; // /projects/:id/<seg>/...

  return (
    <div className="mx-auto flex min-h-full max-w-6xl flex-col gap-0">
      <div className="sticky top-0 z-20 bg-background/90 backdrop-blur">
        <header className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <Link
              to="/"
              aria-label={t("nav.allProjects")}
              className="grid size-9 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground shadow-[0_0_20px_-6px] shadow-primary/50 transition hover:brightness-105"
            >
              <Brandmark className="size-5" />
            </Link>
            <div className="min-w-0 leading-tight">
              <div className="truncate text-base font-bold">{project?.name ?? "…"}</div>
              {project && (
                <div className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">{t("nav.projectMeta", { devices: project.devices.length, gas: project.gaCount })}</div>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <ExportDialog projectId={projectId} />
            <SnapshotPanel projectId={projectId} />
            <TaskIndicator projectId={projectId} />
            <LanguageSwitcher />
          </div>
        </header>

        <nav className="flex w-full justify-start gap-1 overflow-x-auto border-y border-border px-2 sm:px-4">
          {TABS.map((tab) => {
          const active = seg === tab.id;
          return (
            <Link
              key={tab.id}
              to={tab.to}
              params={{ projectId }}
              className={`flex shrink-0 items-center gap-2 border-b-2 px-3 py-3 text-sm outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50 ${active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
            >
              <tab.icon className="size-4" />
              <span className="hidden sm:inline">{t(tab.labelKey)}</span>
            </Link>
          );
        })}
        </nav>
      </div>

      <main className="flex-1 px-4 py-6 sm:px-6">
        <Outlet />
      </main>
    </div>
  );
}
