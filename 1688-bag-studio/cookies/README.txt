将 1688 登录态放在本目录下，文件名固定为：
1688_cookies.json

支持两种 JSON 格式：
1) 纯 cookies 数组
2) Playwright storage_state 对象（包含 cookies 字段）

示例：
[
  {
    "name": "cookie_name",
    "value": "cookie_value",
    "domain": ".1688.com",
    "path": "/"
  }
]
