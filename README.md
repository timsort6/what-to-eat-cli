# 食见 Web 客户端

Vue 3 + Vite 的最小中文客户端，对接现有认证、地址簿和 SSE 聊天接口。

## 运行

```bash
npm install
npm run dev
```

需要 Node.js 20.19+。默认访问 `http://localhost:5173`。Vite 会把 `/api` 转发到 `http://127.0.0.1:8080`；可复制 `.env.example` 为 `.env.local`，用 `VITE_API_PROXY_TARGET` 改变目标地址。

`npm run build` 先执行严格的 TypeScript/Vue 类型检查，再构建到 `dist/`；`npm run preview` 预览构建。`npm test` 使用已有 TypeScript 和 Node 内置测试工具检查 SSE 分块、中文 UTF-8、CR/LF、多行事件、异常、提前断流和坐标边界，不需要测试库。

开发代理只作用于 `npm run dev`。生产部署和预览联调时，需由反向代理转发同源 `/api`（关闭 SSE 缓冲），或在构建前设置 `VITE_API_BASE_URL=https://你的后端域名`。该值只填 origin，不带 `/api`；跨域后端须配置相应 CORS。环境变量变更后重启开发服务，生产环境则重新构建。

浏览器定位只在 HTTPS 或 localhost 且获得用户授权时可用。定位失败时可直接从已保存地址簿选择地址。

## 使用与接口

- 注册成功后自动登录；刷新标签页会调用 `/api/v1/me` 校验会话。Token 仅放在 `sessionStorage`，退出或遇到 401 会清理会话并取消旧请求。
- 地址簿读取 `GET /api/v1/addresses` 的 `data.items`，选中默认有效地址；可重试加载。条目描述在名称与地址都存在且不同时显示“名称 · 地址”，否则依次回退到地址、名称、坐标。
- 选择地址后发送 `address_id`；浏览器定位或搜索确认后发送 `location: "lng,lat"`。两者均验证坐标完整、有限且在经纬度范围内。
- 每次提交发送完整 `preferences`，支持 `decision` / `delta` / `done` / `error`；协商选项仅在完整成功 `done` 后可点，点选后提交 `selection`。提前断流保留已输出内容并标“未完成”。

## 新组件
- `LocationSearch.vue` + `locationSearch.ts`：调用 `GET /api/v1/locations/search`，300ms 防抖、取消旧请求、代际号丢弃迟到结果；先选候选再“使用此地点”确认。用搜索列表代替交互地图。
- `AddressCreate.vue`：“保存为地址”，复用 `POST /api/v1/addresses`；未确认地点不能保存。
- `PreferencesPanel.vue`：推荐数量、搜索范围、用餐安排、人均上限四项控件与“当前条件”摘要。
- `NegotiationPanel.vue` + `recommendation.ts`：`needs_choice` 方案展示与应用；无法由四项控件精确表示的方案保持禁用，不近似改写。
- `MarkdownAnswer.vue` + `markdown.ts` + `markdownThrottle.ts`：安全 Markdown 正文。
- `PlaceCard.vue` + `mapLinks.ts`：可跳高德的商家整卡。

## Markdown 安全边界
- 依赖 `markdown-it@15.0.3`（`html: false`）与 `dompurify@3.4.17`；只允许标题/段落/列表/强调/引用/代码/表格/链接标签，移除图片、脚本、样式、iframe、SVG/Math 与事件属性。
- 链接仅 HTTP/HTTPS，统一 `rel="noopener noreferrer"`；累计文本每次重新解析消毒，最多每 50ms 刷新，上限 64000 个 Unicode 码点（与后端一致），超限受控失败。生成的 HTML 只进入 `MarkdownAnswer.vue` 的单一 `v-html`。

## 高德卡片链接
- 有效真实 POI ID（去空白后 1–64 位 ASCII 字母数字）→ `https://uri.amap.com/poidetail?poiid=…&callnative=0`；否则合法 GCJ-02 坐标 → `https://uri.amap.com/marker?position=lon,lat&name=…&coordinate=gaode&callnative=0`，标“在高德地图查看位置”。
- origin 固定，不接受模型或原始数据给的 URL；候选稳定键不当 POI ID；两者都无效则为非链接卡片并提示无法定位。整卡为 `<a target="_blank" rel="noopener noreferrer">`，卡内不嵌套交互元素。

## 主题
- 固定浅色（`color-scheme: light`），系统深色偏好下不切换主题，详见 `DESIGN.md`。

## 测试
- `npm test`：Node 内置测试（`tests/check.mjs`），无需浏览器；未设置 `TASK6_BROWSER_LOADER` 时不加载浏览器用例；设置后同一命令会追加真实浏览器用例。
- 真实浏览器用例（需 Node 22+，因使用 `Promise.withResolvers`；`npm test` 本身不要求 Node 22）：
  - `npm run test:markdown-browser`（必须设置 `MARKDOWN_BROWSER_LOADER`/`MARKDOWN_BROWSER_PATH`，含义同下方 `TASK6_BROWSER_*`）
  - `npm run test:acceptance`、`npm run test:acceptance-matrix`
  - 变量：`TASK6_BROWSER_LOADER`（浏览器驱动加载脚本）、`TASK6_BROWSER_PATH`（Edge/Chromium 可执行文件）、`TASK6_DIST_DIR`（已构建的 dist 目录）；`TASK14_SKIP_PUBLIC=1` 跳过矩阵中的公开 URI 可达性步骤。
- 所有浏览器测试共用 `tests/browser-network-guard.mjs`：本地代理以 403 拒绝全部外部请求，仅放行回环地址，离线断言不联网。
- 离线夹具结果不代表真实模型或高德线上质量；公开 URI 仅验证跳转可达，不验证页面渲染或 App 唤起。
- 页面不申请位置前的权限、不保存密码、位置或聊天记录。仅浏览器定位的 WGS84 坐标会在中国大陆范围内用近似算法转为高德 GCJ-02 并保留六位小数；范围外原样传递，已保存地址不转换。该区域边界和算法均为近似实现，精确距离以服务端为准。
