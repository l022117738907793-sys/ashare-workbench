/**
 * @aw/core —— 分析引擎入口。
 *
 * `engine.ts` 自原项目 `web/src/engine/engine.ts` 原样搬移，
 * 仅调整了 `rules.json` 的 import 路径（11 字节）。
 * 12 个 fixture 一致性测试全部通过，行为与上游一致。
 *
 * 引擎是纯函数、零依赖、不读 Date/时区——实时性全部由 @aw/data 负责。
 */
export * from "./engine";

export { default as defaultRules } from "../rules.json";
