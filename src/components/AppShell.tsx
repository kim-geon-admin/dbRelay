import type { PropsWithChildren } from "react";
import { routes, type RouteId } from "../app/routes";

type AppShellProps = PropsWithChildren<{
  activeRoute: RouteId;
}>;

export function AppShell({ activeRoute, children }: AppShellProps) {
  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <a className="app-brand" href="#run" aria-label="DB Relay 홈">
          <span className="app-brand__mark" aria-hidden="true">✦</span>
          DB Relay
        </a>
        <nav className="app-navigation" aria-label="주요 탐색">
          {routes.map((route) => (
            <a
              className="app-navigation__link"
              href={route.href}
              key={route.id}
              aria-current={route.id === activeRoute ? "page" : undefined}
            >
              {route.label}
            </a>
          ))}
        </nav>
      </aside>
      <main className="app-content">{children}</main>
    </div>
  );
}
