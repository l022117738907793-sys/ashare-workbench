/** 通用展示组件：卡片 / 状态徽章 / 判断依据列表 / 提示条。 */
import type { ReactNode } from "react";
import type { ReasonItem } from "@aw/core";
import { reasonStatus, reasonStatusText, reasonValueText, stateTone } from "../lib/helpers";

export function Card(props: {
  title?: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  tone?: "default" | "quiet";
  children: ReactNode;
}) {
  const { title, subtitle, right, tone = "default", children } = props;
  return (
    <section className={`card${tone === "quiet" ? " card-quiet" : ""}`}>
      {(title || right) && (
        <header className="card-head">
          <div className="card-head-text">
            {title && <h2 className="card-title">{title}</h2>}
            {subtitle && <p className="card-subtitle">{subtitle}</p>}
          </div>
          {right && <div className="card-head-right">{right}</div>}
        </header>
      )}
      <div className="card-body">{children}</div>
    </section>
  );
}

export function StateBadge({ state, size = "md" }: { state: string; size?: "sm" | "md" | "lg" }) {
  const tone = stateTone(state);
  return (
    <span className={`badge badge-${tone} badge-${size}`} title={`引擎判定：${state}`}>
      {state}
    </span>
  );
}

export function Notice({
  tone = "info",
  children,
  role,
}: {
  tone?: "info" | "warn" | "danger" | "ok";
  children: ReactNode;
  role?: "status" | "alert";
}) {
  return (
    <div className={`notice notice-${tone}`} role={role ?? (tone === "danger" ? "alert" : "status")}>
      {children}
    </div>
  );
}

/**
 * 判断依据列表 —— 每一次分类判定都必须带上它。
 * 取不到的数字显示 `数据不足` / `—`，绝不补 0。
 */
export function ReasonList({
  reasons,
  emptyText = "引擎未返回判断依据",
}: {
  reasons: ReasonItem[];
  emptyText?: string;
}) {
  if (!reasons || reasons.length === 0) {
    return <p className="muted small">{emptyText}</p>;
  }
  return (
    <div className="reasons">
      <div className="reasons-head">判断依据</div>
      <ul className="reasons-list">
        {reasons.map((r) => {
          const status = reasonStatus(r);
          // 「是/否」类判定的 threshold 与 value 是同一个意思（值本身已渲染成 是/否），不重复显示
          const showThreshold = r.threshold !== "" && r.threshold !== "是" && r.threshold !== "否";
          return (
            <li key={r.key} className={`reason reason-${status}`}>
              <span className="reason-label">{r.label}</span>
              <span className="reason-value">{reasonValueText(r)}</span>
              {showThreshold && <span className="reason-threshold">{r.threshold}</span>}
              <span className={`reason-status status-${status}`}>{reasonStatusText(r)}</span>
              {r.note !== "" && <span className="reason-note">{r.note}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** 键值对行（快照信息、设置项等） */
export function KV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="kv">
      <span className="kv-key">{k}</span>
      <span className="kv-val">{v}</span>
    </div>
  );
}

export function EmptyHint({ children }: { children: ReactNode }) {
  return <p className="empty-hint">{children}</p>;
}
