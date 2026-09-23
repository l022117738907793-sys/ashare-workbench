/**
 * 数据层的公共类型。
 *
 * 设计红线：任何行情都必须带 `source` 与 `asOf`，UI 必须把实际数据来源显示出来。
 * 这沿用原项目「数据不足必须明说，不许编造」的原则——降级了就要让人看见降级了。
 */

/** 实时报价。任何字段取不到时为 null，绝不用 0 顶替。 */
export interface Quote {
  /** 带市场后缀的代码，如 `600519.SH` */
  code: string;
  name: string;
  /** 最新价 */
  price: number | null;
  /** 涨跌幅（百分数，如 -0.20 表示 -0.20%） */
  changePct: number | null;
  /** 涨跌额 */
  change: number | null;
  /** 成交额（元）。东财直接给元；腾讯给万元，已统一折算为元。 */
  amount: number | null;
  /** 报价时间戳（毫秒）。取不到时为 null。 */
  asOf: number | null;
  /** 实际数据来源，UI 必须展示 */
  source: QuoteSource;
}

export type QuoteSource = "eastmoney" | "tencent" | "snapshot";

/** 一次批量取数的结果 */
export interface QuoteResult {
  quotes: Quote[];
  /** 实际生效的来源；降级时与请求来源不同 */
  source: QuoteSource;
  /** 未能取到的代码 */
  missing: string[];
  /** 降级原因，供 UI 提示；未降级时为 null */
  degradedReason: string | null;
}

/** 数据源适配器接口。将来接后端 / 同花顺，只需再实现一个。 */
export interface QuoteProvider {
  readonly name: QuoteSource;
  /** 是否可用（如腾讯需要 TextDecoder('gbk')） */
  isSupported(): boolean;
  fetchQuotes(codes: string[]): Promise<Quote[]>;
}
