/**
 * 入口。
 *
 * 刻意不使用 `<StrictMode>`：开发模式下 StrictMode 会把 effect 跑两遍，
 * 而实时行情接口（东财/腾讯）对同一 IP 有频次限制 —— 首屏会立刻打两次请求。
 * 轮询 hook 本身对 cleanup 是安全的，这里只是避免无谓的重复请求。
 */
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("找不到 #root 容器");

createRoot(container).render(<App />);
