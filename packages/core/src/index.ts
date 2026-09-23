/**
 * @aw/core —— 分析引擎与信号。
 *
 * `engine.ts` 自原项目 `web/src/engine/engine.ts` 原样搬移，
 * 仅调整了 `rules.json` 的 import 路径（11 字节）。
 * 12 个 fixture 一致性测试全部通过，行为与上游一致。
 * 引擎是纯函数、零依赖、不读 Date/时区——实时性全部由 @aw/data 负责。
 *
 * `signal.ts` 是叠加在引擎之上的派生层：把分类结果转成可执行的买卖信号。
 * 它**刻意不改动 engine.ts**，这样信号规则的调整永远不会影响引擎的一致性测试。
 */
export * from "./engine";
export * from "./signal";

export { default as defaultRules } from "../rules.json";
