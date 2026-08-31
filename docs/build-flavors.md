# KDJ 构建

KDJ 只发布一个正式产品：**KDJ**（`com.kdj.app`）。本地开发、GitHub 桌面构建和
自动更新都使用同一份功能边界，不再存在并行实验构建或运行时实验模式。

## 本机构建

~~~bash
npm run dev
npm run build
~~~

桌面发布仅生成一套平台安装包与 `latest.json` 更新清单。Android 仍由独立工作流构建，
但与桌面版使用相同版本号和正式功能边界。
