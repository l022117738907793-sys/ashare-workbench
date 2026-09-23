/**
 * 新闻面板。
 *
 * 三条设计约束（重要，改之前先读）：
 *
 * 1. **不标利好利空。** 只展示新闻原文。判断交给人 ——
 *    这是本项目一以贯之的立场：程序不做它做不到的事。
 *    实测同一天的新闻里既有"对市场冲击有限"也有"短期存在调整需求"，
 *    这种矛盾本身就是真实的信息环境。
 *
 * 2. **必须带来源与时间。** 时间解析失败时显示「时间未知」，
 *    绝不渲染成 1970-01-01。
 *
 * 3. **持仓相关单独一栏**，但只是**关键词匹配**（公司名/代码命中），
 *    不代表这条新闻真的影响该股 —— 所以文案要说"可能相关"而不是"利好"。
 */
import { useMemo, useState } from "react";
import type { NewsItem } from "@aw/data";
import { matchNewsToStock } from "@aw/data";
import { beijingDateTime } from "../lib/helpers";
import { Card, EmptyHint, Notice } from "./common";

export interface NewsPanelProps {
  items: NewsItem[];
  source: string | null;
  degradedReason: string | null;
  updatedAt: number | null;
  loading: boolean;
  onRefresh: () => void;
  /** 当前持仓（代码 + 名称），用于筛出可能相关的新闻 */
  holdings: Array<{ code: string; name: string }>;
}

/** 单条新闻：默认折叠，点开看摘要 */
function NewsRow({ item, related }: { item: NewsItem; related: boolean }) {
  const [open, setOpen] = useState(false);
  const hasMore = item.digest.length > 0 && item.digest !== item.title;

  return (
    <li className="news-row">
      <button type="button" className="news-head" onClick={() => hasMore && setOpen((v) => !v)}>
        <span className="news-time">
          {item.timeKnown ? beijingDateTime(item.at) : "时间未知"}
        </span>
        <span className="news-title">{item.title}</span>
        {related && <span className="tag news-related">持仓</span>}
        {hasMore && <span className="news-toggle">{open ? "收起" : "展开"}</span>}
      </button>
      {open && hasMore && <p className="news-digest">{item.digest}</p>}
    </li>
  );
}

export function NewsPanel(props: NewsPanelProps) {
  const { items, source, degradedReason, updatedAt, loading, onRefresh, holdings } = props;

  /** 与持仓可能相关的新闻。关键词匹配，不是语义判断 */
  const related = useMemo(() => {
    if (holdings.length === 0) return [];
    const seen = new Set<string>();
    const out: NewsItem[] = [];
    for (const h of holdings) {
      for (const n of matchNewsToStock(items, h.name, h.code)) {
        if (seen.has(n.id)) continue;
        seen.add(n.id);
        out.push(n);
      }
    }
    return out;
  }, [items, holdings]);

  const relatedIds = useMemo(() => new Set(related.map((n) => n.id)), [related]);

  return (
    <>
      {related.length > 0 && (
        <Card
          title={`持仓相关新闻（${related.length}）`}
          subtitle="按公司名或代码匹配到的新闻，可能相关，不构成任何判断"
        >
          <ul className="news-list">
            {related.slice(0, 8).map((n) => (
              <NewsRow key={`r-${n.id}`} item={n} related />
            ))}
          </ul>
        </Card>
      )}

      <Card
        title="市场快讯"
        subtitle={
          updatedAt
            ? `来源 ${source ?? "—"} · 更新于 ${beijingDateTime(updatedAt)} · 每 3 分钟自动刷新`
            : `来源 ${source ?? "—"}`
        }
        right={
          <button type="button" className="btn btn-ghost btn-tiny" onClick={onRefresh} disabled={loading}>
            {loading ? "刷新中…" : "刷新"}
          </button>
        }
      >
        {degradedReason && <Notice tone="warn">新闻获取异常：{degradedReason}</Notice>}

        {items.length === 0 ? (
          <EmptyHint>
            {loading ? "正在获取新闻…" : "暂时没有取到新闻（数据源不可用时不会编造内容）。"}
          </EmptyHint>
        ) : (
          <ul className="news-list">
            {items.slice(0, 30).map((n) => (
              <NewsRow key={n.id} item={n} related={relatedIds.has(n.id)} />
            ))}
          </ul>
        )}

        <p className="field-hint">
          新闻只作原文展示，<strong>不标注利好利空</strong> —— 同一天的新闻常常互相矛盾，
          怎么解读是你的判断。请结合自己的分析使用。
        </p>
      </Card>
    </>
  );
}
