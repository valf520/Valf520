from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import FastAPI, Form, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from excel_exporter import export_to_excel
from scraper import scrape_1688_bags

import httpx

BASE_DIR = Path(__file__).parent
EXPORT_DIR = BASE_DIR / "exports"
EXPORT_DIR.mkdir(exist_ok=True)

app = FastAPI(title="1688 Bag Studio")
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))

LAST_RESULTS: list[dict[str, Any]] = []


@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(
        request,
        "index.html",
        {"sample_count": len(LAST_RESULTS)},
    )


@app.post("/api/scrape")
async def api_scrape(
    keyword: str = Form(...),
    max_pages: int = Form(2),
    max_items: int = Form(30),
    assist_mode: bool = Form(False),
) -> JSONResponse:
    pages = max(1, min(max_pages, 5))
    items = max(5, min(max_items, 80))

    data = await scrape_1688_bags(
        keyword=keyword,
        max_pages=pages,
        max_items=items,
        assist_mode=assist_mode,
    )

    global LAST_RESULTS
    LAST_RESULTS = data

    return JSONResponse(
        {
            "ok": True,
            "count": len(data),
            "preview": data,
            "message": "采集完成，可以导出 Excel。" if not assist_mode else "校准采集完成，已尝试复用你的手工操作轨迹。",
        }
    )


@app.get("/api/export", response_model=None)
async def api_export():
    if not LAST_RESULTS:
        return JSONResponse(
            {"ok": False, "message": "暂无可导出的数据，请先执行采集。"},
            status_code=400,
        )

    file_path = export_to_excel(LAST_RESULTS, EXPORT_DIR)
    return FileResponse(
        path=file_path,
        filename=file_path.name,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


@app.get("/api/imgproxy")
async def api_imgproxy(url: str = ""):
    """代理请求阿里CDN图片，绕过 Referer 限制"""
    if not url:
        return Response(status_code=400)
    try:
        if url.startswith("//"):
            url = f"https:{url}"
        async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
            resp = await client.get(
                url,
                headers={
                    "Referer": "https://detail.1688.com/",
                    "User-Agent": (
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
                    ),
                },
            )
            if resp.status_code != 200:
                return Response(status_code=resp.status_code)
            ct = resp.headers.get("content-type", "image/jpeg")
            return Response(content=resp.content, media_type=ct)
    except Exception:
        return Response(status_code=502)

