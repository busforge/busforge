import { createRootRoute, createRoute, createRouter, redirect, Outlet } from "@tanstack/react-router";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProjectsScreen } from "./views/Projects.tsx";
import { ProjectLayout } from "./views/ProjectLayout.tsx";
import { DevicesView } from "./views/Devices.tsx";
import { DeviceConfig } from "./views/DeviceConfig.tsx";
import { GroupAddressesView } from "./views/GroupAddresses.tsx";
import { MonitorView } from "./views/Monitor.tsx";
import { InterfaceView } from "./views/Interface.tsx";

function RootLayout() {
  return (
    <TooltipProvider delayDuration={0}>
      <Outlet />
      <Toaster position="bottom-right" />
    </TooltipProvider>
  );
}

const rootRoute = createRootRoute({ component: RootLayout });

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: ProjectsScreen });

const projectRoute = createRoute({ getParentRoute: () => rootRoute, path: "projects/$projectId", component: ProjectLayout });

// /projects/:id alone has no content; send it to the Devices tab.
const projectIndexRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/",
  beforeLoad: ({ params }) => { throw redirect({ to: "/projects/$projectId/devices", params }); },
});

// Device-list filter state lives in the URL so it survives browser back/forward
// and reload (q = search text, changed = "only to program" toggle).
const devicesRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "devices",
  component: DevicesView,
  validateSearch: (s: Record<string, unknown>): { q?: string; changed?: boolean } => ({
    q: typeof s.q === "string" && s.q ? s.q : undefined,
    changed: s.changed === true || s.changed === "true" ? true : undefined,
  }),
});
// Carries the device-list filter (q, changed) so the back button and match
// highlighting can reuse it.
const deviceRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "devices/$deviceId",
  component: DeviceConfig,
  validateSearch: (s: Record<string, unknown>): { q?: string; changed?: boolean } => ({
    q: typeof s.q === "string" && s.q ? s.q : undefined,
    changed: s.changed === true || s.changed === "true" ? true : undefined,
  }),
});
// Group-address filter text lives in the URL so it survives back/forward and reload.
const groupsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "groups",
  component: GroupAddressesView,
  validateSearch: (s: Record<string, unknown>): { q?: string } => ({
    q: typeof s.q === "string" && s.q ? s.q : undefined,
  }),
});
const monitorRoute = createRoute({ getParentRoute: () => projectRoute, path: "monitor", component: MonitorView });
const interfaceRoute = createRoute({ getParentRoute: () => projectRoute, path: "interface", component: InterfaceView });

const routeTree = rootRoute.addChildren([
  indexRoute,
  projectRoute.addChildren([projectIndexRoute, devicesRoute, deviceRoute, groupsRoute, monitorRoute, interfaceRoute]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register { router: typeof router; }
}
