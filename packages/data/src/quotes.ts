/**
 * 实时行情获取链：东财为主，腾讯兜底。
 *
 * 关键行为：**部分失败也要拿到能拿的部分**。第一个来源缺的代码，
 * 继续问下一个来源补齐，而不是整体失败。最终把实际来源和降级原因报给 UI。
 */
import { eastmoneyProvider } from "./providers/eastmoney";
import { tencentProvider } from "./providers/tencent";
import type { Quote, QuoteProvider, QuoteResult, QuoteSource } from "./types";

/** 默认来源优先级。将来接后端 / 同花顺，在这里插一个 provider 即可。 */
export const DEFAULT_CHAIN: QuoteProvider[] = [tencentProvider, eastmoneyProvider];

export interface FetchQuotesOptions {
  /** 覆盖默认来源链 */
  chain?: QuoteProvider[];
  /** 单个来源的超时（毫秒），默认 8000 */
  timeoutMs?: number;
  /** 外部取消信号 */
  signal?: AbortSignal;
}

function withTimeout(ms: number, outer?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`请求超时（${ms}ms）`)), ms);
  const onAbort = () => ctrl.abort(outer?.reason);
  if (outer) {
    if (outer.aborted) ctrl.abort(outer.reason);
    else outer.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    done: () => {
      clearTimeout(timer);
      if (outer) outer.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * 批量取实时行情。
 *
 * @returns 每个代码最多一条报价；取不到的列在 `missing` 里，绝不编造。
 */
export async function fetchQuotes(
  codes: string[],
  options: FetchQuotesOptions = {},
): Promise<QuoteResult> {
  const chain = options.chain ?? DEFAULT_CHAIN;
  const timeoutMs = options.timeoutMs ?? 8000;

  const unique = [...new Set(codes.filter(Boolean))];
  const collected = new Map<string, Quote>();
  const failures: string[] = [];
  let primarySource: QuoteSource | null = null;
  let degradedReason: string | null = null;

  for (const provider of chain) {
    const pending = unique.filter((c) => !collected.has(c));
    if (pending.length === 0) break;

    if (!provider.isSupported()) {
      failures.push(`${provider.name}: 当前环境不支持`);
      continue;
    }

    const { signal, done } = withTimeout(timeoutMs, options.signal);
    try {
      const quotes = await provider.fetchQuotes(pending);
      done();

      if (quotes.length === 0) {
        failures.push(`${provider.name}: 无返回`);
        continue;
      }
      if (primarySource === null) {
        primarySource = provider.name;
        // 关键：如果前面的来源已经失败过，那么这次成功就是"降级"，
        // 必须把原因报出去——否则 UI 会把降级后的数据当成主来源数据展示。
        if (failures.length > 0 && !degradedReason) {
          degradedReason = `已降级到${provider.name}：${failures.join("；")}`;
        }
      } else if (!degradedReason) {
        degradedReason = `部分代码由${provider.name}补齐（${primarySource}未覆盖）`;
      }
      for (const q of quotes) {
        if (q.code && !collected.has(q.code)) collected.set(q.code, q);
      }
    } catch (err) {
      done();
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`${provider.name}: ${msg}`);
    }
  }

  const missing = unique.filter((c) => !collected.has(c));

  // 全部来源都失败时，明确报错，不返回空壳让人误以为"没有数据"
  if (collected.size === 0 && unique.length > 0) {
    throw new Error(`实时行情获取失败 —— ${failures.join("；") || "无可用数据源"}`);
  }

  if (primarySource === null) primarySource = "snapshot";
  if (missing.length > 0 && !degradedReason) {
    degradedReason = `${missing.length} 个代码无实时数据`;
  }

  return {
    quotes: [...collected.values()],
    source: primarySource,
    missing,
    degradedReason,
  };
}

export function sourceLabel(s: QuoteSource): string {
  switch (s) {
    case "eastmoney":
      return "东方财富";
    case "tencent":
      return "腾讯行情";
    case "snapshot":
      return "本地快照";
  }
}
