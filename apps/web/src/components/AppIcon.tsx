import type { CSSProperties } from "react";

export function AppIcon({ name, size = 20, style }: { name: string; size?: number; style?: CSSProperties }) {
  const paths: Record<string, string> = {
    game: "M8 7h8a5 5 0 0 1 4.8 3.6l1 4.4a2 2 0 0 1-3.3 1.9L16 15H8l-2.5 1.9a2 2 0 0 1-3.3-1.9l1-4.4A5 5 0 0 1 8 7ZM7 10v4m-2-2h4m7-1h.01m2 2h.01",
    chart: "M4 4v16h16M7 15l4-5 4 3 5-7",
    book: "M12 5C8 3 5 3 3 4v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-2-1-5-1-9 1Zm0 0v15",
    arrow: "M5 12h14m-6-6 6 6-6 6",
    settings: "M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3Zm3 5a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z",
    clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4v5l3 2",
    history: "M3 10a9 9 0 1 1 1 8M3 5v5h5m4-3v5l3 2",
    help: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-3 6a3 3 0 0 1 6 0c0 2-3 2-3 4m0 3h.01",
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" style={style} aria-hidden="true"><path d={paths[name] ?? paths.chart} /></svg>;
}
