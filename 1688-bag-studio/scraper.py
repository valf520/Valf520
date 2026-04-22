from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx
from bs4 import BeautifulSoup
from playwright.async_api import async_playwright


GENDER_KEYWORDS = {
    "男": ["男包", "男士", "男款", "男用", "男生", "商务男", "男"],
    "女": ["女包", "女士", "女款", "女用", "女生", "淑女", "少女", "妈妈", "女"],
    "中性": ["中性", "男女同款", "通用", "情侣", "男女通用", "男女兼用"],
}

SIZE_KEYWORDS = {
    "大": ["大容量", "大号", "大包", "超大", "特大", "大"],
    "中": ["中号", "中等", "中"],
    "小": ["小包", "迷你", "mini", "小号", "小方包", "零钱包", "手拿包", "口红包", "小"],
}

STYLE_KEYWORDS = {
    "通勤": ["通勤", "上班", "职场", "OL"],
    "韩版": ["韩版", "韩系", "韩风", "东大门"],
    "复古": ["复古", "中古", "老钱风", "vintage", "怀旧"],
    "简约": ["简约", "极简", "纯色", "素色"],
    "时尚": ["时尚", "百搭", "潮流", "新款", "爆款"],
    "休闲": ["休闲", "日常", "出行", "旅行", "运动"],
    "轻奢": ["轻奢", "高级感", "质感", "品质"],
    "可爱": ["可爱", "卡通", "学生", "甜美", "少女心"],
}

MATERIAL_KEYWORDS = {
    "真皮": ["真皮", "头层牛皮", "牛皮", "羊皮", "鳄鱼皮", "蜥蜴皮", "荔枝纹", "牛皮革", "全皮"],
    "PU": ["PU", "仿皮", "人造革", "PU皮", "合成皮"],
    "帆布": ["帆布", "棉布", "粗布"],
    "尼龙": ["尼龙", "牛津布", "涤纶", "防水布"],
    "编织": ["编织", "草编", "藤编", "针织"],
}

BAG_TYPE_KEYWORDS = {
    "托特包": ["托特", "tote"],
    "腋下包": ["腋下"],
    "斜挎包": ["斜挎", "斜跨", "单肩"],
    "双肩包": ["双肩", "背包", "书包"],
    "手提包": ["手提"],
    "手拿包": ["手拿", "手抓", "信封包"],
    "水桶包": ["水桶"],
    "马鞍包": ["马鞍"],
    "饺子包": ["饺子", "云朵包"],
    "链条包": ["链条"],
    "公文包": ["公文"],
}

BASE_DIR = Path(__file__).parent
COOKIE_FILE = BASE_DIR / "cookies" / "1688_cookies.json"
EDGE_USER_DATA_DIR = Path.home() / "AppData" / "Local" / "Microsoft" / "Edge" / "User Data"
CALIBRATION_FILE = BASE_DIR / "cookies" / "calibration_links.json"


def _cookie_candidates() -> list[Path]:
    return [
        COOKIE_FILE,
        BASE_DIR / "1688_cookies.json",
        BASE_DIR.parent / "cookies" / "1688_cookies.json",
        BASE_DIR.parent / "1688_cookies.json",
    ]


def _pick_by_keywords(text: str, mapping: dict[str, list[str]], default: str = "未知") -> str:
    t = text.lower()
    for label, words in mapping.items():
        for word in words:
            if word.lower() in t:
                return label
    return default


def _extract_season(text: str) -> str:
    if not text:
        return "未知"
    year = re.search(r"(20\d{2})", text)
    season = re.search(r"(春夏|秋冬|春|夏|秋|冬)", text)
    if year and season:
        return f"{year.group(1)}{season.group(1)}"
    if season:
        return season.group(1)
    return "未知"


def _normalize_1688_detail_url(url: str) -> str:
    if not url:
        return ""
    normalized = url.strip()
    if normalized.startswith("//"):
        normalized = f"https:{normalized}"
    if normalized.startswith("http://"):
        normalized = normalized.replace("http://", "https://", 1)
    normalized = normalized.split("#", 1)[0]
    return normalized


def _is_valid_detail_url(url: str) -> bool:
    normalized = _normalize_1688_detail_url(url)
    if not normalized:
        return False
    if "detail.1688.com/offer/" not in normalized:
        return False
    if any(bad in normalized for bad in ["view.1688.com", "s.1688.com", "cms", "act.1688.com"]):
        return False
    return bool(re.search(r"/offer/\d+", normalized))


def _extract_attribute_pairs(text: str) -> dict[str, str]:
    if not text:
        return {}
    compact = re.sub(r"\s+", " ", text)
    patterns = {
        "适用性别": [r"适用性别[:：]\s*([^\s|]+)", r"适用对象[:：]\s*([^\s|]+)"],
        "箱包大小": [r"箱包大小[:：]\s*([^\s|]+)", r"包袋大小[:：]\s*([^\s|]+)"],
        "上市年份季节": [r"上市年份季节[:：]\s*([^\s|]+)", r"上市时间[:：]\s*([^\s|]+)"],
        "风格": [r"风格[:：]\s*([^\s|]+)"],
        "箱包潮流款式": [r"箱包潮流款式[:：]\s*([^\s|]+)", r"款式[:：]\s*([^\s|]+)", r"包袋款式[:：]\s*([^\s|]+)"],
        "材质": [r"材质[:：]\s*([^\s|]+)", r"面料[:：]\s*([^\s|]+)", r"皮质特征[:：]\s*([^\s|]+)"],
    }
    results: dict[str, str] = {}
    for field, regexes in patterns.items():
        for regex in regexes:
            m = re.search(regex, compact, re.IGNORECASE)
            if m:
                value = m.group(1).strip(" ,，;；")
                if value:
                    results[field] = value
                    break
    return results


def _infer_attributes_from_text(text: str) -> dict[str, str]:
    return {
        "适用性别": _pick_by_keywords(text, GENDER_KEYWORDS),
        "箱包大小": _pick_by_keywords(text, SIZE_KEYWORDS),
        "上市年份季节": _extract_season(text),
        "风格": _pick_by_keywords(text, STYLE_KEYWORDS),
        "箱包潮流款式": _pick_by_keywords(text, BAG_TYPE_KEYWORDS),
        "材质": _pick_by_keywords(text, MATERIAL_KEYWORDS),
    }


def _extract_price_from_text(text: str) -> str:
    """从任意文本中提取价格，返回字符串或 '未知'"""
    if not text:
        return "未知"
    range_match = re.search(r"(?:¥|￥|价格[:：]?\s*)\s*(\d+\.?\d*)\s*[-~～]\s*(\d+\.?\d*)", text)
    if range_match:
        return f"{range_match.group(1)}-{range_match.group(2)}"
    single_match = re.search(r"(?:¥|￥)\s*(\d+\.?\d+)", text)
    if single_match:
        return single_match.group(1)
    price_label = re.search(r"(?:价格|报价|批发价|单价)[:：]?\s*(\d+\.?\d+)", text)
    if price_label:
        return price_label.group(1)
    return "未知"


def _extract_first_image_from_markdown(markdown_text: str) -> str:
    """从 markdown 文本中提取第一张有效的产品图片 URL"""
    if not markdown_text:
        return ""
    img_pattern = re.compile(r"!\[[^\]]*\]\((https?://[^\s\)]+(?:alicdn|cbu01|1688)[^\s\)]*)\)")
    m = img_pattern.search(markdown_text)
    if m:
        return m.group(1)
    any_img = re.compile(r"!\[[^\]]*\]\((https?://[^\s\)]+\.(?:jpg|jpeg|png|webp)[^\s\)]*)\)", re.IGNORECASE)
    m = any_img.search(markdown_text)
    if m:
        return m.group(1)
    return ""


def _extract_products_from_markdown(markdown_text: str, keyword: str, now: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    # 匹配 markdown 图片链接中的商品标题与详情地址
    pattern = re.compile(r"\[!\[[^\]]*\]\((https?://[^\)]+)\)\]\((https?://detail\.1688\.com/offer/[^\s\)]+)(?:\s+\"([^\"]+)\")?\)")
    for m in pattern.finditer(markdown_text):
        image_url = m.group(1)
        detail_url = m.group(2)
        title = m.group(3) or "未识别标题"
        attrs = _infer_attributes_from_text(title)

        # 尝试从该匹配位置附近的文本中提取价格
        start = max(0, m.start() - 200)
        end = min(len(markdown_text), m.end() + 300)
        context_text = markdown_text[start:end]
        price = _extract_price_from_text(context_text)

        rows.append(
            {
                "关键词": keyword,
                "商品标题": title,
                "详情网址": detail_url,
                "图片URL": image_url,
                "适用性别": attrs["适用性别"],
                "箱包大小": attrs["箱包大小"],
                "上市年份季节": attrs["上市年份季节"],
                "风格": attrs["风格"],
                "箱包潮流款式": attrs["箱包潮流款式"],
                "材质": attrs["材质"],
                "价格": price,
                "店铺名": "1688",
                "抓取时间": now,
            }
        )
    return rows


def _load_1688_cookies() -> list[dict[str, Any]]:
    """
    统一读取登录态 cookie 文件。
    支持两种格式：
    1) 纯 cookies 数组
    2) Playwright storage_state JSON（包含 cookies 字段）
    """
    target: Path | None = None
    for p in _cookie_candidates():
        if p.exists():
            target = p
            break
    if not target:
        return []
    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
    except Exception:
        return []

    if isinstance(raw, dict) and isinstance(raw.get("cookies"), list):
        cookies = raw["cookies"]
    elif isinstance(raw, list):
        cookies = raw
    else:
        return []

    valid: list[dict[str, Any]] = []
    for c in cookies:
        if not isinstance(c, dict):
            continue
        if not c.get("name") or not c.get("value"):
            continue
        # 补齐 url/domain/path，便于 add_cookies 生效
        item = dict(c)
        if "url" not in item and "domain" not in item:
            item["domain"] = ".1688.com"
            item["path"] = "/"
        valid.append(item)
    return valid


def _extract_text(block, selectors: list[str], default: str = "未知") -> str:
    for selector in selectors:
        node = block.select_one(selector)
        if node and node.get_text(strip=True):
            return node.get_text(strip=True)
    return default


def _extract_image(block) -> str:
    img = block.select_one("img")
    if not img:
        return ""
    src = img.get("data-src") or img.get("src") or ""
    if src.startswith("//"):
        return f"https:{src}"
    return src


def _extract_link(block) -> str:
    link = block.select_one("a")
    if not link:
        return ""
    href = link.get("href", "")
    if href.startswith("//"):
        return f"https:{href}"
    return href


async def scrape_1688_bags(
    keyword: str,
    max_pages: int = 2,
    max_items: int = 30,
    assist_mode: bool = False,
) -> list[dict[str, Any]]:
    """
    轻量抓取策略：
    - 直接请求 1688 搜索页 HTML
    - 尽可能提取列表中的标题/图片/链接
    - 属性字段在页面不存在时填充为“未知”，保持表结构稳定
    """
    rows: list[dict[str, Any]] = await _playwright_detail_pipeline(keyword, max_pages, max_items, assist_mode=assist_mode)
    if rows:
        return rows[:max_items]

    rows = []
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
        ),
        "Accept-Language": "zh-CN,zh;q=0.9",
    }

    async with httpx.AsyncClient(timeout=15, follow_redirects=True, headers=headers) as client:
        for page in range(1, max_pages + 1):
            if len(rows) >= max_items:
                break

            url = f"https://s.1688.com/selloffer/offer_search.htm?keywords={quote(keyword)}&n=y&beginPage={page}"
            try:
                resp = await client.get(url)
                if resp.status_code != 200:
                    continue
            except httpx.HTTPError:
                continue

            soup = BeautifulSoup(resp.text, "html.parser")
            cards = soup.select("div.fy23-search-card, div.sm-offer-item, div.offer-card-wrapper")

            for card in cards:
                if len(rows) >= max_items:
                    break

                title = _extract_text(
                    card,
                    [
                        ".title-text",
                        ".fy23-search-card-title",
                        ".offer-title-row span",
                        "h2",
                    ],
                    default="未识别标题",
                )
                image_url = _extract_image(card)
                detail_url = _extract_link(card)
                attrs = _infer_attributes_from_text(title)

                now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                price_raw = _extract_text(
                    card,
                    [
                        ".price", ".offer-price", ".fy23-search-card-price",
                        "[class*='price']", "[class*='Price']",
                        ".sm-offer-priceNum", ".price-original",
                    ],
                    "未知",
                )
                price_val = "未知"
                if price_raw and price_raw != "未知":
                    pm = re.search(r"(\d+\.?\d*)\s*[-~～]\s*(\d+\.?\d*)", price_raw)
                    if pm:
                        price_val = f"{pm.group(1)}-{pm.group(2)}"
                    else:
                        pm = re.search(r"[\d.]+", price_raw)
                        if pm and float(pm.group()) > 0:
                            price_val = pm.group()

                rows.append(
                    {
                        "关键词": keyword,
                        "商品标题": title,
                        "详情网址": detail_url,
                        "图片URL": image_url,
                        "适用性别": attrs["适用性别"],
                        "箱包大小": attrs["箱包大小"],
                        "上市年份季节": attrs["上市年份季节"],
                        "风格": attrs["风格"],
                        "箱包潮流款式": attrs["箱包潮流款式"],
                        "材质": attrs["材质"],
                        "价格": price_val,
                        "店铺名": _extract_text(card, [".shop-name", ".company-name", ".seller", "[class*='company']"], "未知"),
                        "抓取时间": now,
                    }
                )

    if rows:
        return rows[:max_items]
    return _firecrawl_fallback(keyword, max_items)


async def _playwright_detail_pipeline(keyword: str, max_pages: int, max_items: int, assist_mode: bool = False) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    try:
        async with async_playwright() as p:
            context = await _create_context(p, assist_mode=assist_mode)
            page = await context.new_page()

            for page_no in range(1, max_pages + 1):
                if len(rows) >= max_items:
                    break
                search_url = (
                    "https://s.1688.com/selloffer/offer_search.htm"
                    f"?keywords={quote(keyword)}&n=y&beginPage={page_no}"
                )
                await page.goto(search_url, wait_until="domcontentloaded", timeout=30000)
                await page.wait_for_timeout(2000)
                if assist_mode and page_no == 1:
                    # 给用户窗口操作时间：手工点进详情页或完成一次验证
                    await page.wait_for_timeout(45000)

                html = await page.content()
                soup = BeautifulSoup(html, "html.parser")
                cards = soup.select("a[href*='detail.1688.com/offer/'], a[href*='offer/']")
                detail_links: list[str] = []
                for a in cards:
                    href = a.get("href", "")
                    if not href:
                        continue
                    if href.startswith("//"):
                        href = f"https:{href}"
                    if "detail.1688.com/offer/" not in href:
                        continue
                    if href not in detail_links:
                        detail_links.append(href)
                    if len(detail_links) >= max_items:
                        break

                for link in detail_links:
                    if len(rows) >= max_items:
                        break
                    item = await _extract_detail_with_playwright(context, link, keyword, now)
                    if item:
                        rows.append(item)
                if detail_links:
                    _save_calibration_links(detail_links)

            await context.close()
    except Exception:
        return []

    if rows:
        return rows[:max_items]

    # 搜索页被反爬时，先用 Firecrawl 找到详情链接，再走 Playwright 详情抽取
    detail_links = _load_calibration_links() or _firecrawl_detail_links(keyword, max_items)
    if not detail_links:
        return []

    try:
        async with async_playwright() as p:
            context = await _create_context(p, assist_mode=assist_mode)
            for link in detail_links:
                if len(rows) >= max_items:
                    break
                item = await _extract_detail_with_playwright(context, link, keyword, now)
                if item:
                    rows.append(item)
            await context.close()
    except Exception:
        return []

    return rows[:max_items]


async def _extract_detail_with_playwright(context, detail_url: str, keyword: str, now: str) -> dict[str, Any] | None:
    page = await context.new_page()
    try:
        await page.goto(detail_url, wait_until="domcontentloaded", timeout=30000)
        await page.wait_for_timeout(2500)

        # 尝试通过 JS 直接获取页面数据（1688 SPA 结构经常在 window 变量中存储数据）
        js_data = await _try_extract_js_data(page)

        html = await page.content()
        soup = BeautifulSoup(html, "html.parser")

        title = (
            soup.select_one("h1")
            or soup.select_one(".title-text")
            or soup.select_one(".mod-detail-title")
            or soup.select_one("[class*='title'] h1")
            or soup.select_one("[class*='Title']")
            or soup.select_one("title")
        )
        title_text = title.get_text(strip=True) if title else "未识别标题"
        if js_data.get("title") and title_text in ("未识别标题", ""):
            title_text = js_data["title"]

        # 图片提取：优先从 og:image / meta / 大图区域获取
        image_url = ""
        og_img = soup.select_one('meta[property="og:image"]')
        if og_img and og_img.get("content"):
            image_url = og_img["content"]
        if not image_url:
            for sel in [
                ".detail-gallery-img img", ".main-image img",
                ".detail-gallery img", "#dt-tab img",
                "[class*='gallery'] img", "[class*='Gallery'] img",
                "[class*='mainImg'] img", "[class*='MainImage'] img",
                ".vertical-img img", ".tab-pane img",
            ]:
                node = soup.select_one(sel)
                if node:
                    src = node.get("data-src") or node.get("src") or ""
                    if src.startswith("//"):
                        src = f"https:{src}"
                    if src and ("alicdn" in src or "cbu01" in src or "1688" in src):
                        image_url = src
                        break
        if not image_url:
            images = soup.select("img[src], img[data-src]")
            for img in images:
                src = img.get("data-src") or img.get("src") or ""
                if src.startswith("//"):
                    src = f"https:{src}"
                if src and ("alicdn" in src or "cbu01" in src):
                    w = img.get("width", "")
                    h = img.get("height", "")
                    if (w and int(w) > 100) or (h and int(h) > 100) or "ibank" in src:
                        image_url = src
                        break
            if not image_url and images:
                src = images[0].get("data-src") or images[0].get("src") or ""
                if src.startswith("//"):
                    src = f"https:{src}"
                image_url = src
        if js_data.get("image") and not image_url:
            image_url = js_data["image"]

        # 价格提取：多种选择器 + JS 数据 + 正则全文扫描
        price_text = "未知"
        price_selectors = [
            ".price", ".price-text", ".od-pc-offer-price",
            ".mod-detail-price", "[class*='price']", "[class*='Price']",
            ".value-price", ".ladder-price", ".price-num",
            "[class*='offerPrice']", "[class*='OfferPrice']",
            "span[class*='price']", "div[class*='price']",
            ".detail-price", ".sku-price", ".range-price",
        ]
        for sel in price_selectors:
            nodes = soup.select(sel)
            for n in nodes:
                raw = n.get_text(strip=True)
                price_match = re.search(r"(\d+\.?\d*)\s*[-~～]\s*(\d+\.?\d*)", raw)
                if price_match:
                    price_text = f"{price_match.group(1)}-{price_match.group(2)}"
                    break
                price_match = re.search(r"[\d.]+", raw)
                if price_match and float(price_match.group()) > 0:
                    price_text = price_match.group()
                    break
            if price_text != "未知":
                break

        if price_text == "未知" and js_data.get("price"):
            price_text = js_data["price"]

        if price_text == "未知":
            full_text = soup.get_text(" ", strip=True)[:3000]
            range_match = re.search(r"(?:¥|￥)\s*(\d+\.?\d*)\s*[-~～]\s*(\d+\.?\d*)", full_text)
            if range_match:
                price_text = f"{range_match.group(1)}-{range_match.group(2)}"
            else:
                single_match = re.search(r"(?:¥|￥)\s*(\d+\.?\d+)", full_text)
                if single_match:
                    price_text = single_match.group(1)

        # 店铺名提取
        shop_text = "未知"
        shop_selectors = [
            ".company-name", ".shop-name", ".company-name-text",
            "[class*='company']", "[class*='Company']",
            "[class*='shopName']", "[class*='ShopName']",
            ".app-common_supplierInfoSmall",
            "a[class*='seller']", "a[class*='Seller']",
            ".supplier-name", "[class*='supplier']",
        ]
        for sel in shop_selectors:
            nodes = soup.select(sel)
            for n in nodes:
                text = n.get_text(strip=True)
                if text and len(text) > 1 and len(text) < 60:
                    shop_text = text
                    break
            if shop_text != "未知":
                break
        if shop_text == "未知" and js_data.get("shop"):
            shop_text = js_data["shop"]

        # 属性提取
        attr_text_parts = []
        attr_selectors = [
            ".obj-leading", ".detail-attributes", "[class*='attribute']",
            "[class*='Attribute']", ".mod-detail-attributes",
            "ul.attributes-list", ".offer-attr-list",
            "table.detail-attributes-table",
            "[class*='offerDetail']", "[class*='OfferDetail']",
            "li[class*='attr']", "[class*='detailAttr']",
        ]
        for sel in attr_selectors:
            nodes = soup.select(sel)
            for nd in nodes:
                attr_text_parts.append(nd.get_text(" ", strip=True))
        attr_block = "\n".join(attr_text_parts)

        explicit_attrs = _extract_attribute_pairs(attr_block)
        merged_text = f"{title_text}\n{attr_block}\n{soup.get_text(' ', strip=True)[:2000]}"
        inferred = _infer_attributes_from_text(merged_text)

        attrs = {}
        for field in ("适用性别", "箱包大小", "上市年份季节", "风格", "箱包潮流款式", "材质"):
            attrs[field] = explicit_attrs.get(field) or inferred.get(field, "未知")

        return {
            "关键词": keyword,
            "商品标题": title_text,
            "详情网址": detail_url,
            "图片URL": image_url,
            "适用性别": attrs["适用性别"],
            "箱包大小": attrs["箱包大小"],
            "上市年份季节": attrs["上市年份季节"],
            "风格": attrs["风格"],
            "箱包潮流款式": attrs["箱包潮流款式"],
            "材质": attrs["材质"],
            "价格": price_text,
            "店铺名": shop_text,
            "抓取时间": now,
        }
    except Exception:
        return None
    finally:
        await page.close()


async def _try_extract_js_data(page) -> dict[str, str]:
    """从 1688 详情页的 JS 全局变量中提取结构化数据"""
    result: dict[str, str] = {}
    try:
        data = await page.evaluate("""() => {
            const out = {};
            // 尝试从 window.__INIT_DATA 或 window.detailData 中获取
            const d = window.__INIT_DATA || window.detailData || window.__detail_data__ || {};
            const offerData = d.offerDetail || d.data || d.globalData || d;

            // 标题
            if (offerData.subject) out.title = offerData.subject;
            else if (offerData.title) out.title = offerData.title;

            // 价格 —— 多种取法
            if (offerData.price) out.price = String(offerData.price);
            else if (offerData.mixAmount) out.price = String(offerData.mixAmount);
            else if (offerData.priceRange) out.price = offerData.priceRange;
            else {
                const priceEl = document.querySelector('[class*="price"]');
                if (priceEl) {
                    const t = priceEl.textContent.replace(/[^\\d.\\-~～]/g, '');
                    if (t) out.price = t;
                }
            }

            // 图片
            if (offerData.image && offerData.image.images && offerData.image.images.length) {
                out.image = offerData.image.images[0];
            }

            // 店铺
            if (offerData.companyName) out.shop = offerData.companyName;

            return out;
        }""")
        if isinstance(data, dict):
            result = {k: str(v) for k, v in data.items() if v}
    except Exception:
        pass
    return result


def _firecrawl_fallback(keyword: str, max_items: int) -> list[dict[str, Any]]:
    """
    当 1688 直抓被反爬拦截时，使用 Firecrawl 搜索兜底。
    这样至少能稳定拿到标题、链接、摘要及部分图片信息，保障可导出。
    """
    query = f"site:1688.com {keyword} 箱包"
    firecrawl_bin = shutil.which("firecrawl") or shutil.which("firecrawl.cmd")
    if not firecrawl_bin:
        return []

    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tmp:
        output_path = tmp.name

    cmd = [
        firecrawl_bin,
        "search",
        query,
        "--limit",
        str(max_items),
        "--scrape",
        "--json",
        "-o",
        output_path,
    ]

    try:
        subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=180)
        with open(output_path, "r", encoding="utf-8") as f:
            payload = json.load(f)
    except Exception:
        return []

    result_rows: list[dict[str, Any]] = []
    web_items = payload.get("data", {}).get("web", []) if isinstance(payload, dict) else []
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    for item in web_items[:max_items]:
        scraped = item.get("scrapeResult", {}) if isinstance(item, dict) else {}
        image_url = ""
        markdown_text = ""
        if isinstance(scraped, dict):
            image_url = scraped.get("metadata", {}).get("ogImage", "") or ""
            if not image_url:
                image_url = scraped.get("metadata", {}).get("og:image", "") or ""
            markdown_text = scraped.get("markdown", "") or ""
        title = item.get("title", "未识别标题")
        description = item.get("description", "")
        merged_text = f"{title}\n{description}\n{markdown_text[:1200]}"
        attrs = _infer_attributes_from_text(merged_text)

        # 若页面是图片集合页，尽量拆成具体商品项，提升属性字段完整率
        markdown_products = _extract_products_from_markdown(markdown_text, keyword, now)
        if markdown_products:
            result_rows.extend(markdown_products)
            if len(result_rows) >= max_items:
                break
            continue

        # 从 markdown 中提取价格
        price = _extract_price_from_text(f"{title}\n{description}\n{markdown_text[:2000]}")

        # 从 markdown 中提取第一张有效图片（如果 ogImage 不可用）
        if not image_url:
            image_url = _extract_first_image_from_markdown(markdown_text)

        result_rows.append(
            {
                "关键词": keyword,
                "商品标题": title,
                "详情网址": item.get("url", ""),
                "图片URL": image_url,
                "适用性别": attrs["适用性别"],
                "箱包大小": attrs["箱包大小"],
                "上市年份季节": attrs["上市年份季节"],
                "风格": attrs["风格"],
                "箱包潮流款式": attrs["箱包潮流款式"],
                "材质": attrs["材质"],
                "价格": price,
                "店铺名": item.get("source", "1688"),
                "抓取时间": now,
            }
        )

    return result_rows[:max_items]


def _firecrawl_detail_links(keyword: str, max_items: int) -> list[str]:
    query = f"site:detail.1688.com/offer {keyword} 箱包"
    firecrawl_bin = shutil.which("firecrawl") or shutil.which("firecrawl.cmd")
    if not firecrawl_bin:
        return []
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tmp:
        output_path = tmp.name
    cmd = [
        firecrawl_bin,
        "search",
        query,
        "--limit",
        str(max_items * 2),
        "--json",
        "-o",
        output_path,
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=120)
        with open(output_path, "r", encoding="utf-8") as f:
            payload = json.load(f)
    except Exception:
        return []

    links: list[str] = []
    web_items = payload.get("data", {}).get("web", []) if isinstance(payload, dict) else []
    for item in web_items:
        url = item.get("url", "")
        if "detail.1688.com/offer/" in url and url not in links:
            links.append(url)
        if len(links) >= max_items:
            break
    return links


def _save_calibration_links(links: list[str]) -> None:
    CALIBRATION_FILE.parent.mkdir(exist_ok=True)
    uniq = []
    for link in links:
        if link not in uniq and "detail.1688.com/offer/" in link:
            uniq.append(link)
    if not uniq:
        return
    CALIBRATION_FILE.write_text(json.dumps(uniq[:200], ensure_ascii=False, indent=2), encoding="utf-8")


def _load_calibration_links() -> list[str]:
    if not CALIBRATION_FILE.exists():
        return []
    try:
        data = json.loads(CALIBRATION_FILE.read_text(encoding="utf-8"))
        if isinstance(data, list):
            return [x for x in data if isinstance(x, str)]
    except Exception:
        return []
    return []


async def _create_context(playwright, assist_mode: bool = False):
    """
    优先复用本机 Edge 持久化用户目录（完整登录态、localStorage、指纹更接近真实浏览器）；
    若失败则退回普通上下文 + cookie 注入。
    """
    if EDGE_USER_DATA_DIR.exists():
        try:
            context = await playwright.chromium.launch_persistent_context(
                user_data_dir=str(EDGE_USER_DATA_DIR),
                channel="msedge",
                headless=not assist_mode,
                locale="zh-CN",
                args=["--disable-blink-features=AutomationControlled"],
            )
            return context
        except Exception:
            pass

    browser = await playwright.chromium.launch(channel="msedge", headless=not assist_mode)
    context = await browser.new_context(
        user_agent=(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
        ),
        locale="zh-CN",
    )
    cookies = _load_1688_cookies()
    if cookies:
        await context.add_cookies(cookies)
    return context

