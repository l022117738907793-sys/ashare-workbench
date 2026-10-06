/**
 * 按日期、按市场生效的交易规则。
 *
 * 为什么单独成模块：A 股的费率与涨跌停制度**在历史上变过多次**，
 * 而游戏要回放历史。用固定常量会让 2023 年后的印花税、2020 年前的创业板涨跌幅全算错。
 *
 * 这也是一次纠错：初版的 `portfolio.ts` 用的是固定常量，37 个测试全绿，
 * 但那些测试验证的是**简化后的规则**，不是真实规则 —— 测试全绿不等于规则准确。
 *
 * 所有变更日期以交易所公告为准；每条都注明生效日，便于核对与增补。
 *
 * ── 境外规则一律标注「简化」────────────────────────────────
 * 港股真实的交易成本有四五项零碎费用（交易费 0.00565%、交易系统使用费、
 * 证监会交易征费 0.0027%、会计局交易征费 0.00015%），加起来约 0.008%，
 * 对教学局没有意义，却会让「为什么手续费是 37.4 而不是 38」变成一道算术题。
 * 所以只保留**对结果有量级影响**的那几项，并在下面每条注明简化了什么。
 * 宁可少列几项并写明，也不要列一堆查不准的数字假装精确。
 */

/** 板块。规则差异主要来自这里 */
export type Board = "main" | "star" | "chinext" | "bse";

export function boardOf(code: string): Board {
  const num = code.split(".")[0];
  if (num.startsWith("688") || num.startsWith("689")) return "star"; // 科创板
  if (num.startsWith("300") || num.startsWith("301")) return "chinext"; // 创业板
  if (num.startsWith("8") || num.startsWith("4")) return "bse"; // 北交所
  return "main";
}

export const BOARD_NAME: Record<Board, string> = {
  main: "主板",
  star: "科创板",
  chinext: "创业板",
  bse: "北交所",
};

/**
 * 市场分组。规则差异不止「哪个板块」，还有「哪个市场」这一层。
 *
 * ⚠️ 这里的解析必须和 `@aw/data` 的 `codes.ts` **保持一致**：那边负责把代码写进分片，
 * 这边负责读出来。两边对不上的症状是「A 股按美股规则成交」—— 而且不会报错，
 * 只会安静地少收一笔印花税。
 *
 * 认不出的一律按 CN：池子里绝大多数是 A 股，猜错的代价最小。
 */
export type MarketGroup = "CN" | "HK" | "US" | "JP" | "KR";

export function marketGroupOf(code: string): MarketGroup {
  if (/^\d{4,5}\.HK$/i.test(code)) return "HK";
  if (/^\d{4}\.JP$/i.test(code)) return "JP";
  if (/^\d{6}\.KR$/i.test(code)) return "KR";
  if (/^[A-Z][A-Z0-9.\-]{0,9}\.US$/i.test(code)) return "US";
  return "CN";
}

export const MARKET_NAME: Record<MarketGroup, string> = {
  CN: "A 股",
  HK: "港股",
  US: "美股",
  JP: "日股",
  KR: "韩股",
};

export type Currency = "CNY" | "HKD" | "USD" | "JPY" | "KRW";

/** 用哪个币种报价。账户始终以人民币记账，这里说的是**标的自己的报价币**。 */
export function currencyOfMarket(market: MarketGroup): Currency {
  if (market === "HK") return "HKD";
  if (market === "US") return "USD";
  if (market === "JP") return "JPY";
  if (market === "KR") return "KRW";
  return "CNY";
}

export const CURRENCY_NAME: Record<Currency, string> = {
  CNY: "人民币",
  HKD: "港币",
  USD: "美元",
  JPY: "日元",
  KRW: "韩元",
};

export const CURRENCY_SYMBOL: Record<Currency, string> = {
  CNY: "¥",
  HKD: "HK$",
  USD: "$",
  JPY: "¥",
  KRW: "₩",
};

/**
 * 这个市场有没有**引擎会强制执行的百分比涨跌停**。
 *
 * A 股有，韩股有（±30%），港股、美股、日股都没有。
 *
 * 判据是「能不能用一个百分比表达」，而不是「现实中管不管」——日股**确实有**涨跌停，
 * 但它是按前收价分 **35 档的绝对金额**（100 日元以下 ±30 日元、5 万日元档 ±7000 日元……），
 * 编一个百分比会比不限制更错：要么宽到形同虚设，要么把正常的成交挡掉。
 * 所以这里对日股返回 false，界面上明说「本局不做限制」，见 `describeRules`。
 *
 * 这不是细节：把 ±10% 套到美股上，玩家会发现自己**买不进当天涨了 12% 的英伟达**，
 * 而现实里那笔单子会正常成交。
 */
export function hasPriceLimit(market: MarketGroup): boolean {
  return market === "CN" || market === "KR";
}

/**
 * 这个市场是不是 T+1（当天买入当天不能卖）。
 *
 * A 股是；港股、美股、**日股、韩股都是 T+0** —— 当天买的当天就能卖。
 * 这条比费率更容易被忽略：它决定了玩家能不能做日内回转。
 *
 * ⚠️ 日韩的 **T+2 是交割周期，不是可卖限制**。把 T+2 实现成「T+2 才能卖」
 * 是接日韩最容易犯的错，会直接砍掉日内回转这个玩法。
 */
export function isTPlusOne(market: MarketGroup): boolean {
  return market === "CN";
}

export interface FeeRules {
  /** 佣金费率（双向） */
  commissionRate: number;
  /** 单笔最低佣金，单位是**标的的报价币** */
  commissionMin: number;
  /**
   * 卖方交易税率。
   *
   * 字段名沿用 A 股的「印花税」，但它其实是**各国卖方税费的通用槽位**：
   * - A 股：证券交易印花税 0.05%（2023-08-28 起）
   * - 港股：股票印花税 0.1%
   * - 韩股：**证券交易税** 0.20%（2026-01-01 起，此前 0.15%）
   * - 美股、日股：0
   *
   * 界面上不能一律叫「印花税」—— 韩国那项叫证券交易税，见 `describeRules`。
   */
  stampDutyRate: number;
  /**
   * 卖方交易税是不是买卖双边都收。
   *
   * A 股、韩股只有卖出收；港股**买卖都收**。这一个布尔值值不少钱：
   * 港股来回一趟的印花税是 A 股的四倍（0.1% × 2 vs 0.1% × 1，再叠 A 股 2023 年减半）。
   */
  stampDutyBothSides: boolean;
  /** 过户费（双向） */
  transferFeeRate: number;
}

/**
 * 取某日、某市场生效的费用规则。
 *
 * A 股历史变更：
 * - 2023-08-28 起，证券交易印花税由 0.1% 减半至 0.05%（财政部/税务总局公告 2023 年第 39 号）
 * - 2022-04-29 起，过户费下调 50%（沪深均按成交金额 0.001% 双向收取）
 *
 * 港股：
 * - 印花税 0.1%，**买卖双边**；2021-08-01 起上调至 0.13%，2023-11-17 起恢复 0.1%
 * - 佣金按 0.25%、最低 100 港币（多数券商的档位）
 * - 简化掉：交易费/交易系统使用费/证监会交易征费/会计局交易征费（合计约 0.008%）
 * - 港股没有「过户费」这一项（有股份登记费，量级更小，忽略）
 *
 * 美股：
 * - 佣金 0、无印花税。这不是偷懒：主流零售券商（嘉信、Robinhood 等）确实零佣金，
 *   美国也没有印花税，只有卖出时约 0.0028% 的 SEC 规费，量级小到可以忽略。
 *   于是「同样一笔交易，A 股要交千分之一、美股不花钱」本身就是一个很好的教学点。
 *
 * 日股：
 * - 佣金 0（网络券商已是零佣金）、**卖出无任何税费**。
 * - 简化掉：无。日股是这几个市场里费用最简单的。
 *
 * 韩股：
 * - **证券交易税 0.20%，仅卖出**（2026-01-01 起由 0.15% 上调，
 *   同时废除农渔村特别税，KOSPI 与 KOSDAQ 的税率由此趋同）。
 * - 这一项是日韩里**唯一会显著改变盈亏**的费率：0.20% 是 A 股印花税的四倍，
 *   意味着股价要涨 0.2% 才刚够覆盖卖出税费。
 * - 佣金按网络券商档位 0.015%，无最低（韩国券商普遍没有最低佣金）；
 *   ⚠️ 柜台/传统渠道能到 0.15%，差一个数量级 —— 这里取网络价并明说。
 * - 过户费 0（韩国已废除）。
 */
export function feeRulesAt(date: string, market: MarketGroup = "CN"): FeeRules {
  if (market === "HK") {
    const stampDutyRate = date >= "2023-11-17" ? 0.001 : date >= "2021-08-01" ? 0.0013 : 0.001;
    return {
      commissionRate: 0.0025,
      commissionMin: 100,
      stampDutyRate,
      stampDutyBothSides: true,
      transferFeeRate: 0,
    };
  }
  if (market === "US") {
    return {
      commissionRate: 0,
      commissionMin: 0,
      stampDutyRate: 0,
      stampDutyBothSides: false,
      transferFeeRate: 0,
    };
  }
  if (market === "JP") {
    return {
      commissionRate: 0,
      commissionMin: 0,
      stampDutyRate: 0,
      stampDutyBothSides: false,
      transferFeeRate: 0,
    };
  }
  if (market === "KR") {
    return {
      commissionRate: 0.00015,
      commissionMin: 0,
      stampDutyRate: date >= "2026-01-01" ? 0.002 : 0.0015,
      stampDutyBothSides: false,
      transferFeeRate: 0,
    };
  }
  const stampDutyRate = date >= "2023-08-28" ? 0.0005 : 0.001;
  return {
    commissionRate: 0.00025,
    commissionMin: 5,
    stampDutyRate,
    stampDutyBothSides: false,
    transferFeeRate: 0.00001,
  };
}

export interface LimitRules {
  /** 普通股票涨跌幅 */
  normalPct: number;
  /** ST / 风险警示股涨跌幅 */
  stPct: number;
}

/**
 * 取某日、某板块生效的涨跌停幅度。**只对 A 股有意义**，
 * 调用前先用 `hasPriceLimit(market)` 判断，别把结果套到港股/美股上。
 *
 * 历史变更：
 * - 科创板 2019-07-22 开市即 20%
 * - 创业板 2020-08-24 注册制起由 10% 改为 20%
 * - 创业板/科创板的风险警示股**仍是 20%**（不适用主板的 5%）
 * - 北交所 30%
 */
export function limitRulesAt(date: string, board: Board): LimitRules {
  if (board === "bse") return { normalPct: 0.3, stPct: 0.3 };
  if (board === "star") return { normalPct: 0.2, stPct: 0.2 };
  if (board === "chinext") {
    const pct = date >= "2020-08-24" ? 0.2 : 0.1;
    return { normalPct: pct, stPct: pct };
  }
  return { normalPct: 0.1, stPct: 0.05 };
}

/**
 * 单笔涨跌幅。**调用前先问 `hasPriceLimit(market)`**，别把结果套到没有涨跌停的市场。
 *
 * 韩股是一个干净的 ±30%，与板块、ST 都无关，所以在最前面就短路掉；
 * 后面 A 股那套（主板 10%、科创板/创业板 20%、北交所 30%）只对 CN 有意义。
 * 日股不在这里 —— 它的涨跌停是绝对金额，`hasPriceLimit("JP")` 已经是 false。
 */
export function limitPctAt(
  date: string,
  board: Board,
  isST = false,
  market: MarketGroup = "CN",
): number {
  if (market === "KR") return 0.3;
  const r = limitRulesAt(date, board);
  return isST ? r.stPct : r.normalPct;
}

export interface LotRules {
  /** 最低买入股数 */
  minShares: number;
  /** 超过最低数量后的递增单位 */
  increment: number;
}

/**
 * 取某市场、某板块的买入单位规则。
 *
 * - 主板/创业板：100 股起，100 股递增
 * - **科创板：200 股起，之后可按 1 股递增**（这是容易忽略的一条）
 * - 北交所：100 股起，1 股递增
 * - 港股：按每手 100 股简化。**真实每手股数因股而异** —— 腾讯 100 股、
 *   友邦 200 股、汇丰 400 股，是每只股票自己的合约规格。要精确就得给每只股票
 *   存一份「每手股数」表（港交所的 board lot 数据），这里选了简化 + 明说，
 *   而不是编一张查不准的表。
 * - 美股：1 股起，1 股递增。真实还能买碎股，这里不做。
 * - 日股：**100 股起，100 股递增**（単元株）。这条是真的会挡人：丰田一手约 29 万日元、
 *   而 Fast Retailing 这种高价股一手要 500 万日元上下（≈24 万人民币），
 *   在 10–30 万本金的局里根本买不起。**这不是 bug，日本散户面对的就是这个约束。**
 * - 韩股：**1 股起，1 股递增**。这是日韩里最友好的，也是把韩股排在日股前面的原因之一。
 */
export function lotRulesAt(board: Board, market: MarketGroup = "CN"): LotRules {
  if (market === "HK") return { minShares: 100, increment: 100 };
  if (market === "US") return { minShares: 1, increment: 1 };
  if (market === "KR") return { minShares: 1, increment: 1 };
  if (market === "JP") return { minShares: 100, increment: 100 };
  if (board === "star") return { minShares: 200, increment: 1 };
  if (board === "bse") return { minShares: 100, increment: 1 };
  return { minShares: 100, increment: 100 };
}

/**
 * 卖方税费在各国叫什么。
 *
 * 韩国那项叫**证券交易税**（증권거래세），跟印花税不是一回事 ——
 * 界面上一律写「印花税」会让玩家以为韩国也收印花税，而实际税率是 A 股的四倍。
 */
export function taxName(market: MarketGroup): string {
  return market === "KR" ? "证券交易税" : "印花税";
}

/** 校验买入股数是否符合该市场/板块的申报规则 */
export function isValidBuyQuantity(board: Board, shares: number, market: MarketGroup = "CN"): boolean {
  if (!Number.isInteger(shares) || shares <= 0) return false;
  const r = lotRulesAt(board, market);
  if (shares < r.minShares) return false;
  if (r.increment === 1) return true;
  return (shares - r.minShares) % r.increment === 0;
}

/**
 * 规则描述，用于界面展示「这一局适用什么规则」。
 *
 * 没有涨跌停的市场就不提涨跌停 —— 写一句「无涨跌停」比省略更有信息量，
 * 因为玩家会默认所有市场都跟 A 股一样。
 */
export function describeRules(date: string, board: Board, market: MarketGroup = "CN"): string[] {
  const fee = feeRulesAt(date, market);
  const lot = lotRulesAt(board, market);
  const lines: string[] = [];

  // 韩国那项叫证券交易税，不能写「印花税」——税率是 A 股的四倍，名字错了会让人低估它
  if (fee.stampDutyRate > 0) {
    lines.push(
      `${taxName(market)} ${(fee.stampDutyRate * 100).toFixed(2)}%（${fee.stampDutyBothSides ? "买卖双边" : "仅卖出"}）`,
    );
  } else {
    lines.push(`无${taxName(market)}`);
  }

  if (fee.commissionRate > 0) {
    const sym = CURRENCY_SYMBOL[currencyOfMarket(market)];
    lines.push(
      fee.commissionMin > 0
        ? `佣金 ${(fee.commissionRate * 100).toFixed(3)}%，最低 ${fee.commissionMin} ${sym}`
        : `佣金 ${(fee.commissionRate * 100).toFixed(3)}%，无最低`,
    );
  } else {
    lines.push("零佣金");
  }

  if (hasPriceLimit(market)) {
    if (market === "KR") {
      // 韩股与板块、ST 无关，就一个 ±30%。不能套 A 股那套 BOARD_NAME ——
      // boardOf("005930.KR") 会落到 "main"，写出来就成了「主板涨跌停 ±30%」
      lines.push("涨跌停 ±30%");
    } else {
      const limit = limitRulesAt(date, board);
      lines.push(
        `${BOARD_NAME[board]}涨跌停 ±${(limit.normalPct * 100).toFixed(0)}%${limit.stPct !== limit.normalPct ? `（ST ±${(limit.stPct * 100).toFixed(0)}%）` : ""}`,
      );
    }
  } else if (market === "JP") {
    // 日股确实有涨跌停，只是不是百分比。写「无涨跌停」是错的，写个编出来的百分比更错
    lines.push("涨跌停按前收价分 35 档的绝对金额（本局不做限制）");
  } else {
    lines.push("无涨跌停");
  }

  lines.push(isTPlusOne(market) ? "T+1（当天买入次日才能卖）" : "T+0（当天买入当天可卖）");

  lines.push(
    lot.increment === 1
      ? `${lot.minShares} 股起，可 1 股递增`
      : `${lot.minShares} 股起，${lot.increment} 股递增`,
  );

  return lines;
}
