/**
 * 新闻相关类型。
 *
 * 单独成文件是为了避免 `news.ts` 与 `types.ts` 循环引用：
 * 行情与新闻是两条独立的链路，类型上也分开。
 */

export interface NewsItem {
  id: string;
  title: string;
  /** 摘要，可能为空串 */
  digest: string;
  /** 发布时间戳（毫秒）。解析失败时为 0 */
  at: number;
  /** 数据来源，UI 必须展示 */
  source: string;
  /** 原始链接（有则给） */
  url?: string;
  /**
   * 时间是否解析成功。
   * 为 false 时 UI **不能**把 at=0 渲染成 1970-01-01，应显示「时间未知」。
   */
  timeKnown: boolean;
}

export interface NewsProvider {
  readonly name: string;
  isSupported(): boolean;
  fetchLatest(limit: number): Promise<NewsItem[]>;
}
