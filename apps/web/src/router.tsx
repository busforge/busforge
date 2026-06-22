import { createRootRoute, createRoute, createRouter, redirect, Outlet } from "@tanstack/react-router";
import { Toaster } from "@/components/ui/sonner";
import { ProjectsScreen } from "./views/Projects.tsx";
import { ProjectLayout } from "./views/ProjectLayout.tsx";
import { DevicesView } from "./views/Devices.tsx";
import { DeviceConfig } from "./views/DeviceConfig.tsx";
import { GroupAddressesView } from "./views/GroupAddresses.tsx";
import { MonitorView } from "./views/Monitor.tsx";
import { InterfaceView } from "./views/Interface.tsx";

function RootLayout() {
  return (
    <>
      <Outlet />
      <Toaster position="bottom-right" />
    </>
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

const devicesRoute = createRoute({ getParentRoute: () => projectRoute, path: "devices", component: DevicesView });
const deviceRoute = createRoute({ getParentRoute: () => projectRoute, path: "devices/$deviceId", component: DeviceConfig });
const groupsRoute = createRoute({ getParentRoute: () => projectRoute, path: "groups", component: GroupAddressesView });
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
