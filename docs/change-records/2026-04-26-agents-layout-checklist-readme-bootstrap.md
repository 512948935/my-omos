# 2026-04-26 - AGENTS 布局清单补齐 + README 初始化

## 改了什么

- 在根 `AGENTS.md` 新增 **Multiplexer Layout Checklist**：
  - 补充 `multiplexer.type` 部署方式清单；
  - 补充 tmux `layout` 策略表（含 `right-even-2col-4`）；
  - 明确 `right-even-2col-4` 的阈值行为：`3` 为上二下一、
    `4` 为 2x2，`5+` 切单列；
  - 增加布局变更时的联动更新清单。
- 新增根目录 `README.md`（此前缺失）：
  - 提供安装/重置（重新初始化）入口；
  - 提供完整使用步骤（安装 tmux → tmux 常用配置 → 安装插件 →
    配置项 → `omos` 启动函数 → 环境变量/启动 → 验证）；
  - `omos` 函数支持端口占用检查（`lsof`/`ss`）与 tmux 环境变量同步；
  - 提供 `multiplexer.type` 与 `layout` 效果清单；
  - 提供推荐配置（`right-even-2col-4`）；
  - 提供本地开发命令与文档索引。

## 为什么改

- 当前仓库根 README 缺失，使用者缺少统一入口。
- 需要把“部署方式 + 布局效果”集中到 AGENTS 与 README，方便
  快速选择与落地配置。

## 涉及文件

- `AGENTS.md`
- `README.md`

## 如何验证

1. 检查 `AGENTS.md` 是否包含 `Multiplexer Layout Checklist`。
2. 检查 `README.md` 是否包含：
   - 安装与 `--reset` 重置；
   - 完整使用步骤（tmux / tmux.conf / 插件 / 配置 / `omos` / 环境变量 / 验证）；
   - `multiplexer.type` 清单；
   - tmux 布局清单与 `right-even-2col-4` 阈值说明；
   - 推荐配置与文档索引。
