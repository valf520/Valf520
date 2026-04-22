"""快速测试采集 API"""
import httpx
import json

resp = httpx.post(
    "http://127.0.0.1:8000/api/scrape",
    data={"keyword": "包包", "max_pages": "1", "max_items": "5"},
    timeout=300,
)
data = resp.json()
print(f"状态: {data.get('ok')}, 数量: {data.get('count')}")
print(f"消息: {data.get('message')}")

for i, item in enumerate(data.get("preview", []), 1):
    print(f"\n--- 商品 {i} ---")
    print(f"  标题: {item.get('商品标题', '?')[:40]}")
    print(f"  价格: {item.get('价格', '?')}")
    print(f"  图片: {'有' if item.get('图片URL') else '无'}")
    print(f"  店铺: {item.get('店铺名', '?')}")
    print(f"  性别: {item.get('适用性别', '?')}")
    print(f"  风格: {item.get('风格', '?')}")
    print(f"  材质: {item.get('材质', '?')}")
    print(f"  款式: {item.get('箱包潮流款式', '?')}")

total = data.get("count", 0)
items = data.get("preview", [])
price_miss = sum(1 for x in items if x.get("价格") in ("未知", "", None))
img_miss = sum(1 for x in items if not x.get("图片URL"))
shop_miss = sum(1 for x in items if x.get("店铺名") in ("未知", "", None))
print(f"\n=== 数据质量 ===")
print(f"总数: {total}")
print(f"价格缺失: {price_miss}/{total}")
print(f"图片缺失: {img_miss}/{total}")
print(f"店铺缺失: {shop_miss}/{total}")
