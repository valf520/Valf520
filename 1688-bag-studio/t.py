import httpx, json
r = httpx.post("http://127.0.0.1:8000/api/scrape", data={"keyword": "baobao", "max_pages": "1", "max_items": "3"}, timeout=300)
d = r.json()
print(json.dumps(d, ensure_ascii=False, indent=2))
