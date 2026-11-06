import { useRef, useState } from "react";
import { Activity, Check, Cpu, Download, MoreHorizontal, Network } from "lucide-react";
import { Link, Outlet, useParams, useRouterState } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useProject } from "../queries.ts";
import { Brandmark } from "@/components/Brandmark.tsx";
import { TaskIndicator } from "@/components/TaskIndicator.tsx";
import { SnapshotPanel } from "@/components/SnapshotPanel.tsx";
import { ExportDialog } from "@/components/ExportDialog.tsx";
import { LanguageSwitcher, useUiLanguage } from "@/components/LanguageSwitcher.tsx";
import { useStickyVar } from "@/lib/stickyChrome.ts";
import { setLanguage, supportedLngs, type Lng } from "@/lib/i18n";
import { IconButton } from "@/components/ui/icon-button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

// Each language named in itself, as a language menu does.
const LANGUAGE_NAME: Record<Lng, string> = { en: "English", de: "Deutsch" };

// The project bar's less frequent tools on a narrow window, where they do not fit beside the
// project name: the export and the UI language, labelled.
function NarrowProjectMenu({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const [exportOpen, setExportOpen] = useState(false);
  const current = useUiLanguage();
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton variant="outline" size="icon-sm" label={t("common.moreActions")} tooltip={false} className="sm:hidden" data-testid="project-bar-menu">
            <MoreHorizontal className="size-4" />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setExportOpen(true)}><Download /> {t("nav.exportProject")}</DropdownMenuItem>
          <DropdownMenuSeparator />
          {supportedLngs.map((lng) => (
            <DropdownMenuItem key={lng} onSelect={() => setLanguage(lng)}>
              <Check className={current === lng ? "opacity-100" : "opacity-0"} /> {LANGUAGE_NAME[lng]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <ExportDialog projectId={projectId} open={exportOpen} onOpenChange={setExportOpen} />
    </>
  );
}

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
  const barRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLElement>(null);
  useStickyVar([barRef, tabsRef], "--bar-h");

  return (
    <div className="mx-auto flex min-h-full max-w-6xl flex-col gap-0">
      {/* Wide windows pin the whole bar; narrow ones only the tabs, so the project header scrolls
          away and leaves the screen to the work. */}
      <div ref={barRef} className="contents sm:sticky sm:top-0 sm:z-20 sm:block sm:bg-background/90 sm:backdrop-blur">
        <header className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 flex-1 items-center gap-2">
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
            <span className="hidden sm:contents"><ExportDialog projectId={projectId} /></span>
            <SnapshotPanel projectId={projectId} />
            <TaskIndicator projectId={projectId} />
            <span className="hidden sm:contents"><LanguageSwitcher /></span>
            <NarrowProjectMenu projectId={projectId} />
          </div>
        </header>

        <nav ref={tabsRef} className="sticky top-0 z-20 flex w-full justify-start gap-1 overflow-x-auto border-y border-border bg-background/90 px-2 backdrop-blur sm:static sm:bg-transparent sm:px-4 sm:backdrop-blur-none">
          {TABS.map((tab) => {
          const active = seg === tab.id;
          return (
            <Link
              key={tab.id}
              to={tab.to}
              params={{ projectId }}
              className={`flex shrink-0 items-center gap-2 border-b-2 px-2.5 py-3 text-sm outline-none sm:px-3 transition-colors focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50 ${active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
            >
              <tab.icon className="size-4" />
              <span>{t(tab.labelKey)}</span>
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
