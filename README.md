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
- 地址簿读取 `GET /api/v1/addresses` 的 `data.items`，选中默认有效地址；可重试加载。该最小客户端只选择现有地址，地址维护使用已有客户端。
- 选择地址后发送 `address_id`；浏览器定位后发送 `location: "lng,lat"`。两者均验证坐标完整、有限且在经纬度范围内。
- 每次提交为独立推荐，发送一条 `messages`，支持 `delta` / `done` / `error`。提前断流保留已输出内容并允许重试；服务端文本作为纯文本展示。
- 页面不申请位置前的权限、不保存密码、位置或聊天记录。仅浏览器定位的 WGS84 坐标会在中国大陆范围内用近似算法转为高德 GCJ-02 并保留六位小数；范围外原样传递，已保存地址不转换。该区域边界和算法均为近似实现，精确距离以服务端为准。
