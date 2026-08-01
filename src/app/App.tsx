import { useEffect, useState } from "react";
import { AppShell } from "../components/AppShell";
import "../styles/global.css";
import { getRoute, routeFromHash, type RouteId } from "./routes";

function currentRoute(): RouteId {
  return routeFromHash(window.location.hash);
}

export function App() {
  const [activeRoute, setActiveRoute] = useState<RouteId>(currentRoute);
  const route = getRoute(activeRoute);

  useEffect(() => {
    const handleHashChange = () => setActiveRoute(currentRoute());
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  return (
    <AppShell activeRoute={activeRoute}>
      <section className="app-page" aria-labelledby="page-title">
        <p className="app-page__eyebrow">DB Relay</p>
        <h1 className="app-page__title" id="page-title">{route.label}</h1>
        <p className="app-page__description">{route.description}</p>
        <div className="app-page__placeholder">
          이 화면의 세부 기능은 다음 작업에서 추가됩니다.
        </div>
      </section>
    </AppShell>
  );
}
