import { useEffect, useState } from "react";
import { AppShell } from "../components/AppShell";
import { ConnectionList } from "../features/connections/ConnectionList";
import { FlowLibrary } from "../features/flows/FlowLibrary";
import "../styles/global.css";
import { getRoute, routeFromHash, type RouteId } from "./routes";

function currentRoute(): RouteId {
  return routeFromHash(window.location.hash);
}

function PlaceholderPage({ route }: { route: ReturnType<typeof getRoute> }) {
  return <section className="app-page" aria-labelledby="page-title">
    <p className="app-page__eyebrow">DB Relay</p>
    <h1 className="app-page__title" id="page-title">{route.label}</h1>
    <p className="app-page__description">{route.description}</p>
    <div className="app-page__placeholder">This screen will be completed in a later task.</div>
  </section>;
}

export function App() {
  const [activeRoute, setActiveRoute] = useState<RouteId>(currentRoute);
  const route = getRoute(activeRoute);

  useEffect(() => {
    const handleHashChange = () => setActiveRoute(currentRoute());
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  let content: React.ReactNode = <PlaceholderPage route={route} />;
  if (activeRoute === "database-settings") content = <ConnectionList />;
  if (activeRoute === "query-sequences") content = <FlowLibrary />;

  return <AppShell activeRoute={activeRoute}>{content}</AppShell>;
}
