export const routes = [
  { id: "run", label: "실행", href: "#run", description: "검증된 쿼리 시퀀스를 실행합니다." },
  { id: "query-sequences", label: "쿼리 시퀀스", href: "#query-sequences", description: "실행할 쿼리와 순서를 관리합니다." },
  { id: "database-settings", label: "DB 설정", href: "#database-settings", description: "데이터베이스 연결을 안전하게 설정합니다." },
  { id: "run-history", label: "실행 이력", href: "#run-history", description: "과거 실행 결과와 상태를 확인합니다." },
] as const;

export type RouteId = (typeof routes)[number]["id"];

export function routeFromHash(hash: string): RouteId {
  const match = routes.find((route) => route.href === hash);
  return match?.id ?? "run";
}

export function getRoute(routeId: RouteId) {
  return routes.find((route) => route.id === routeId)!;
}
