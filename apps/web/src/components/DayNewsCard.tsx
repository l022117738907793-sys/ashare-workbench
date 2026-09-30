/**
 * 历史推演里「那一天发生了什么」。
 *
 * 和 `NewsPanel`（实时模式看今天的滚动快讯）刻意分开写，因为约束不一样：
 *
 * 1. **数据是离线归档，缺就是缺。** 抓取脚本按交易日抓新浪财经首页归档，
 *    某天没抓到、或者那天不是交易日，文件就不存在。界面必须说「这一天没抓到」，
 *    而不是显示一个空列表让人以为「那天没发生什么大事」—— 后者是编造。
 * 2. **随机模式要藏日期。** 标题里常有「2月3日」「2020年2月3日」，会直接
 *    漏出模拟日。`mask` 由调用方传进来（ReplayView 手上有 state）。
 * 3. **同样不标注利好利空。** 和实时资讯同一条红线：同一天的新闻常常互相
 *    矛盾，怎么解读是玩家的判断。
 * 4. **原文链接放在按钮外面。** `<a>` 嵌在 `<button>` 里是非法 HTML。
 *    （同 NewsPanel，链接是行的兄弟节点，不是子节点。）
 */
import type { DayNewsItem } from "../lib/replay";
import { Card, EmptyHint } from "./common";

export interface DayNewsCardProps {
  loading: boolean;
  /** 拉过了、确实没有。只有它为真才允许写「没抓到」。 */
  missing: boolean;
  items: DayNewsItem[];
  source?: string;
  /** 随机模式藏日期时用来抹掉标题里的日期写法 */
  mask?: (text: string) => string;
}

export function DayNewsCard(props: DayNewsCardProps) {
  const { loading, missing, items, source, mask } = props;
  const show = mask ?? ((t: string) => t);

  return (
    <Card
      title="那一天的资讯"
      subtitle={
        items.length > 0
          ? `当天发布的原始标题 ${items.length} 条${source ? ` · 来自${source}` : ""}`
          : "当天发布的原始标题，也就是当时的人翻报纸能看到的东西"
      }
    >
      {loading ? <EmptyHint>正在找这一天的资讯…</EmptyHint> : null}

      {!loading && (missing || items.length === 0) ? (
        <EmptyHint>
          这一天的资讯没有抓到。历史归档缺几天是常事，缺着的就不补 ——
          推演里宁可少一份材料，也不拿别处的新闻凑数。
        </EmptyHint>
      ) : null}

      {!loading && items.length > 0 ? (
        <>
          <ul className="news-list news-list-scroll">
            {items.map((it, i) => (
              <li key={`${it.url}-${i}`} className="news-row">
                <span className="news-head news-head-static">
                  <span className="news-title">{show(it.title)}</span>
                </span>
                <a
                  className="news-link"
                  href={it.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  查看原文 ↗
                </a>
              </li>
            ))}
          </ul>
          <p className="field-hint">
            这里只是把当天的标题和原文摆出来，<strong>不标注利好利空</strong> ——
            同一天的新闻常常互相矛盾，怎么解读是你的判断。
          </p>
        </>
      ) : null}
    </Card>
  );
}
