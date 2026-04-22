# 1688 Bag Studio

基于 Python 的轻量项目：输入关键词抓取 1688 商品信息，预览后导出包含缩略图的 Excel。

## 快速启动

```bash
cd 1688-bag-studio
pip install -r requirements.txt
python -m uvicorn app:app --reload --port 8011
```

打开：<http://127.0.0.1:8011>

## 功能

- 输入关键词（默认“包包”）进行采集
- 预览采集结果卡片
- 一键导出 Excel
- Excel 内嵌缩略图（图片下载失败时会标记）

## 说明

- 首版采用轻量抓取策略，不接数据库。
- 由于目标站点存在动态渲染和反爬策略，部分字段可能显示“未知”，表结构保持稳定。
- 后续可升级为 Playwright 深度抓取详情页属性，以提高字段完整率。

## 登录态统一配置（推荐）

为提升 1688 详情页抓取成功率，支持统一读取登录态文件：

- 路径：`cookies/1688_cookies.json`
- 支持格式：
  - 纯 cookies 数组
  - Playwright `storage_state` JSON（包含 `cookies` 字段）

示例（数组格式）：

```json
[
  {
    "name": "cookie_name",
    "value": "cookie_value",
    "domain": ".1688.com",
    "path": "/"
  }
]
```

放置后无需额外配置，服务启动时会自动注入到 Playwright 上下文。

## 一键导出 1688 登录态

项目内提供了脚本：`export_1688_cookies.py`

```bash
cd 1688-bag-studio
python export_1688_cookies.py
```

运行后会打开 Edge 浏览器：

1. 在页面里完成 1688 登录
2. 回到终端按回车
3. 自动生成 `cookies/1688_cookies.json`

之后再启动服务采集，会自动使用该登录态。

