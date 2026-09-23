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
import { Card, KV, Notice } from "./common";

export interface SettingsProps {
  settings: AppSettings;
  onChange: (next: AppSettings) => void;
  rules: Rules;
  onReload: () => void;
  onClearLocal: () => void;
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

  const overrides = overrideCount(settings.ruleOverrides);
  const groups: RuleGroup[] = ["market", "sector", "stock"];

  return (
    <div className="view">
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
