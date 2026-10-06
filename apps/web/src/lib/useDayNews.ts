/**
 * 历史推演里「那一天发生了什么」。
 *
 * 和 `useLiveNews` 是两回事：那个拉的是**今天**的滚动快讯（实时模式用），
 * 这个按模拟日读一份离线归档（`history/news/<日期>.json`）。
 *
 * 三条设计约束：
 *
 * 1. **离线优先，取不到就当没有。** 归档是抓来的，缺几天很正常（那天不是
 *    交易日、或者抓的时候失败了）。文件不在就返回空，绝不报错、绝不编造 ——
 *    历史推演最不能出的错就是让玩家以为「那天没大事」，实际是我们没数据。
 *    所以界面必须把「抓到了 0 条」和「没抓到这一天」分开说。
 * 2. **一天只拉一次。** 玩家来回翻也常见，模块级缓存
 *    按日期存住，重复访问不再发请求。缓存只在内存里，刷新页面就重来。
 * 3. **不预取未来的日子。** 只拉当前这一天 —— 提前把 26 天全下下来，等于把
 *    后面的新闻放进了内存，哪天有人手滑渲染出来就是剧透。
 */
import { useEffect, useState } from "react";
import { loadDayNews, type DayNews } from "./replay";

/** 按日期缓存。value 为 null 表示「拉过了，这天没有」。 */
const cache = new Map<string, DayNews | null>();

export interface DayNewsState {
  news: DayNews | null;
  /** 还在拉。为真时界面说「正在找这一天的资讯」，不要说「没有」。 */
  loading: boolean;
  /** 拉过了而且确实没有。只有它为真才能写「这一天没抓到」。 */
  missing: boolean;
}

/** 测试用：清掉缓存，避免用例之间互相影响。 */
export function resetDayNewsCache(): void {
  cache.clear();
}

export function useDayNews(date: string, enabled = true): DayNewsState {
  const key = enabled && date ? date : "";
  const [state, setState] = useState<DayNewsState>(() =>
    key && cache.has(key)
      ? { news: cache.get(key) ?? null, loading: false, missing: !cache.get(key) }
      : { news: null, loading: false, missing: false },
  );

  useEffect(() => {
    if (!key) {
      setState({ news: null, loading: false, missing: false });
      return;
    }
    if (cache.has(key)) {
      const hit = cache.get(key) ?? null;
      setState({ news: hit, loading: false, missing: hit === null });
      return;
    }

    let alive = true;
    setState({ news: null, loading: true, missing: false });
    void loadDayNews(key).then((res) => {
      // 组件卸载了、或者玩家已经推进到别的日子，就不要拿旧结果覆盖新状态
      if (!alive) return;
      cache.set(key, res);
      setState({ news: res, loading: false, missing: res === null });
    });
    return () => {
      alive = false;
    };
  }, [key]);

  return state;
}
