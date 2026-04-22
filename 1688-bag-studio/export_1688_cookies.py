from __future__ import annotations

import json
from pathlib import Path

import browser_cookie3
from playwright.sync_api import sync_playwright


BASE_DIR = Path(__file__).parent
COOKIE_DIR = BASE_DIR / "cookies"
COOKIE_FILE = COOKIE_DIR / "1688_cookies.json"


def export_from_local_browser() -> int:
    """
    优先从本机浏览器现有登录态自动读取 cookie（无需再次登录）。
    """
    all_items: list[dict] = []
    loaders = [browser_cookie3.edge, browser_cookie3.chrome]
    domains = ["1688.com", "taobao.com", "alibaba.com"]
    for loader in loaders:
        for domain in domains:
            try:
                jar = loader(domain_name=domain)
            except Exception:
                continue
            for c in jar:
                item = {
                    "name": c.name,
                    "value": c.value,
                    "domain": c.domain or ".1688.com",
                    "path": c.path or "/",
                    "secure": bool(c.secure),
                }
                if getattr(c, "expires", None):
                    item["expires"] = c.expires
                all_items.append(item)

    # 去重（name + domain + path）
    dedup: dict[str, dict] = {}
    for c in all_items:
        k = f'{c.get("name")}|{c.get("domain")}|{c.get("path")}'
        dedup[k] = c
    cookies = list(dedup.values())
    # 至少要有关键登录 cookie，避免写入空壳文件
    key_names = {"_m_h5_tk", "_m_h5_tk_enc", "cookie2", "sgcookie", "JSESSIONID", "_tb_token_"}
    has_key_cookie = any(c.get("name") in key_names for c in cookies)
    if not cookies or not has_key_cookie:
        return 0

    COOKIE_FILE.write_text(json.dumps(cookies, ensure_ascii=False, indent=2), encoding="utf-8")
    return len(cookies)


def main() -> None:
    COOKIE_DIR.mkdir(exist_ok=True)

    auto_count = export_from_local_browser()
    if auto_count > 0:
        print(f"已自动读取本机登录态，导出 {auto_count} 条 cookies -> {COOKIE_FILE}")
        return

    print("未能自动读取到本机登录态，切换为交互登录导出模式...")
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=False)
        context = browser.new_context(locale="zh-CN")
        page = context.new_page()
        page.goto("https://www.1688.com/", wait_until="domcontentloaded", timeout=60000)
        print("请在弹出的浏览器中完成 1688 登录，然后回到终端按回车继续...")
        input()

        cookies = context.cookies(["https://www.1688.com", "https://detail.1688.com"])
        COOKIE_FILE.write_text(
            json.dumps(cookies, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"已导出 {len(cookies)} 条 cookies -> {COOKIE_FILE}")
        browser.close()


if __name__ == "__main__":
    main()

