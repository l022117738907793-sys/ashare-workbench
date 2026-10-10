/** 第四层视图：设置（数据路径 / 刷新间隔 / 规则阈值覆盖 / 本地数据 / 快照信息）。 */
import type { Rules } from "@aw/core";
import {
  clearRuleOverride,
  MAX_REFRESH_MS,
  MIN_REFRESH_MS,
  overrideCount,
  ruleValue,
  RULE_FIELDS,
  setRuleOverride,
  DEFAULT_SETTINGS,
  type AppSettings,
  type RuleGroup,
} from "../lib/helpers";
import { useState } from "react";
import {
  HISUI_NAME,
  isUsableEndpoint,
  loadHisuiSettings,
  saveHisuiSettings,
  type HisuiSettings,
} from "../lib/hisui";
import { Card, KV, Notice } from "./common";

export interface SettingsProps {
  settings: AppSettings;
  onChange: (next: AppSettings) => void;
  rules: Rules;
  onReload: () => void;
  onClearLocal: () => void;
  /** 从页头齿轮进来，所以需要自己把人送回去 */
  onBack: () => void;
  snapshotName: string | null;
  metaAsOf: string | null;
  metaSource: string | null;
  metaDays: string | null;
  calendarDays: number;
  sessionText: string;
  polling: boolean;
  updatedText: string;
  quoteSourceText: string;
}

const GROUP_TITLE: Record<RuleGroup, string> = {
  market: "大盘环境阈值",
  sector: "板块强弱阈值",
  stock: "个股分类阈值",
};

export function SettingsView(props: SettingsProps) {
  const {
    settings,
    onChange,
    rules,
    onReload,
    onClearLocal,
    onBack,
    snapshotName,
    metaAsOf,
    metaSource,
    metaDays,
    calendarDays,
    sessionText,
    polling,
    updatedText,
    quoteSourceText,
  } = props;

  /*
   * 交易员的问答代理。**默认是空的**，因为纯静态站点不能保管 API Key ——
   * 留一个「看着能问、点了说没接通」的入口比没有入口更糟，所以没配就整块
   * 提问框都不渲染（判断在 AskBox 里，见 Terms.tsx）。
   */
  const [hisui, setHisui] = useState<HisuiSettings>(() => loadHisuiSettings());
  const [hisuiDraft, setHisuiDraft] = useState(() => loadHisuiSettings().endpoint);
  const [hisuiSaved, setHisuiSaved] = useState(false);
  const hisuiOk = hisui.endpoint !== "" && isUsableEndpoint(hisui.endpoint);

  const overrides = overrideCount(settings.ruleOverrides);
  const groups: RuleGroup[] = ["market", "sector", "stock"];

  return (
    <div className="view">
      {/*
        设置现在从页头右上角的齿轮进来，不再占底部导航的一格，所以必须自己带一个出口。
        标题不写「返回设置」这类绕圈的话，直接写这一页是什么。
      */}
      <div className="back-bar">
        <button type="button" className="btn btn-ghost btn-tiny" onClick={onBack}>
          ← 返回
        </button>
        <h2 className="back-title">设置</h2>
      </div>

      <Card title="数据源" subtitle="快照是分析的数据底座；实时行情只用于盘中叠加最新价。">
        <label className="field">
          <span className="field-label">数据根路径</span>
          <input
            className="text-input"
            type="text"
            value={settings.dataBase}
            spellCheck={false}
            onChange={(e) => onChange({ ...settings, dataBase: e.target.value })}
            onBlur={(e) => onChange({ ...settings, dataBase: e.target.value.trim() || DEFAULT_SETTINGS.dataBase })}
            placeholder="./data"
            aria-label="数据根路径"
          />
          <span className="field-hint">
            加载 <code>{(settings.dataBase || "./data").replace(/\/+$/, "")}/latest.json</code> 指向的快照目录；
            相对路径在 GitHub Pages 子路径下同样可用。
          </span>
        </label>
        <div className="btn-row">
          <button type="button" className="btn" onClick={onReload}>
            重新加载快照
          </button>
        </div>
        <div className="kv-list">
          <KV k="当前快照" v={snapshotName ?? "—"} />
          <KV k="数据日期 (meta.asOf)" v={metaAsOf ?? "—"} />
          <KV k="快照天数 (meta.days)" v={metaDays ?? "—"} />
          <KV k="交易日历天数" v={calendarDays > 0 ? `${calendarDays} 天` : "—"} />
          <KV k="数据来源 (meta.source)" v={metaSource ?? "—"} />
          <KV k="当前交易时段" v={`${sessionText}${polling ? " · 正在轮询实时价" : ""}`} />
          <KV k="最后更新" v={updatedText} />
          <KV k="实时行情来源" v={quoteSourceText} />
        </div>
      </Card>

      <Card title="实时刷新" subtitle="只在交易时段轮询，且只轮询屏幕上看得见的标的。">
        <div className="chips">
          {[3000, 4000, 5000].map((ms) => (
            <button
              key={ms}
              type="button"
              className={`chip${settings.refreshMs === ms ? " chip-active" : ""}`}
              onClick={() => onChange({ ...settings, refreshMs: ms })}
              aria-pressed={settings.refreshMs === ms}
            >
              {ms / 1000} 秒
            </button>
          ))}
        </div>
        <label className="field">
          <span className="field-label">自定义间隔（毫秒，限制 {MIN_REFRESH_MS}~{MAX_REFRESH_MS}）</span>
          <input
            className="text-input"
            type="number"
            min={MIN_REFRESH_MS}
            max={MAX_REFRESH_MS}
            step={500}
            value={settings.refreshMs}
            onChange={(e) => onChange({ ...settings, refreshMs: Number(e.target.value) })}
            aria-label="刷新间隔毫秒"
          />
        </label>
        <Notice tone="info">
          非交易时段完全停止请求，只在下一个开盘时刻用一次定时器重新探测；页面切到后台也会暂停。
        </Notice>
      </Card>

      <Card
        title="规则阈值覆盖"
        subtitle={`覆盖项 ${overrides} 个 · 只覆盖下列字段，其余沿用 @aw/core 的 rules.json`}
        right={
          overrides > 0 ? (
            <button type="button" className="btn btn-ghost" onClick={() => onChange({ ...settings, ruleOverrides: {} })}>
              全部还原
            </button>
          ) : undefined
        }
      >
        {groups.map((g) => (
          <div key={g} className="rule-group">
            <h3 className="rule-group-title">{GROUP_TITLE[g]}</h3>
            {RULE_FIELDS.filter((f) => f.group === g).map((f) => {
              const current = ruleValue(rules, f.group, f.key);
              const overridden = settings.ruleOverrides[f.group]?.[f.key] !== undefined;
              return (
                <div key={`${f.group}.${f.key}`} className={`rule-row${overridden ? " rule-row-overridden" : ""}`}>
                  <span className="rule-label">{f.label}</span>
                  <span className="rule-input">
                    <input
                      className="text-input text-input-num"
                      type="number"
                      step={f.step}
                      value={Number.isFinite(current) ? current : ""}
                      onChange={(e) =>
                        onChange({
                          ...settings,
                          ruleOverrides: setRuleOverride(
                            settings.ruleOverrides,
                            f.group,
                            f.key,
                            Number(e.target.value),
                          ),
                        })
                      }
                      aria-label={f.label}
                    />
                    <span className="rule-unit">{f.unit}</span>
                  </span>
                  {overridden && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-tiny"
                      onClick={() =>
                        onChange({
                          ...settings,
                          ruleOverrides: clearRuleOverride(settings.ruleOverrides, f.group, f.key),
                        })
                      }
                    >
                      还原
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </Card>

      <Card
        title={`${HISUI_NAME}的问答（可选）`}
        subtitle="不填也能用：术语解释是写好的，问答题才需要这个地址。"
      >
        <KV
          k="现在的状态"
          v={hisuiOk ? `已接通 ${hisui.endpoint}` : "没配 —— 术语照常解释，只是没有提问框"}
        />
        <label className="field">
          <span className="field-label">问答代理地址</span>
          <input
            className="text-input"
            type="url"
            inputMode="url"
            placeholder="https://你的代理.example.com/ask"
            value={hisuiDraft}
            onChange={(e) => {
              setHisuiDraft(e.target.value);
              setHisuiSaved(false);
            }}
          />
        </label>
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              const endpoint = hisuiDraft.trim();
              const next = { endpoint };
              saveHisuiSettings(next);
              setHisui(next);
              setHisuiSaved(true);
            }}
          >
            保存
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              const next = { endpoint: "" };
              saveHisuiSettings(next);
              setHisui(next);
              setHisuiDraft("");
              setHisuiSaved(true);
            }}
          >
            清除
          </button>
        </div>
        {hisuiDraft.trim() !== "" && !isUsableEndpoint(hisuiDraft.trim()) ? (
          <p className="field-hint">
            这个地址看起来不对：要是一个 <code>https://</code> 开头的完整地址。
          </p>
        ) : null}
        {hisuiSaved ? <p className="field-hint">已存在这台浏览器上，只影响你自己。</p> : null}
        <Notice tone="info">
          问答题要调用大模型，而大模型需要一个密钥。这个站点是<strong>纯静态</strong>的，
          没有后端、也不保管任何密钥 —— 所以密钥得放在你自己的代理上，这里只填代理地址。
          {HISUI_NAME}只会把屏幕上已经显示过的术语和解释发过去，
          <strong>不会</strong>发送你的账户、持仓或没走到的行情。
        </Notice>
      </Card>

      <Card title="本地数据" subtitle="历史记录与设置都存在浏览器里。">
        <div className="btn-row">
          <button type="button" className="btn btn-danger" onClick={onClearLocal}>
            清空本地数据
          </button>
        </div>
        <Notice tone="info">
          清空后：历史记录、学习作答、设置与阈值覆盖全部移除，页面回到默认状态；随后会重新加载快照。
        </Notice>
      </Card>
    </div>
  );
}
