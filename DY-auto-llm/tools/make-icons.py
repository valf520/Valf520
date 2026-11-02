"""生成扩展图标：品牌红圆角方块 + 白色对话气泡 + AI 字样"""
from PIL import Image, ImageDraw, ImageFont
import os

OUT = r"E:\tool\douying-messageself\DY-auto-llm\icons"
os.makedirs(OUT, exist_ok=True)

BRAND = (254, 44, 85, 255)
BRAND_DARK = (214, 20, 62, 255)
WHITE = (255, 255, 255, 255)

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\arialbd.ttf",
]


def font(size):
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


def draw_icon(size):
    S = size * 8  # 超采样再缩，边缘才干净
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 圆角底
    r = int(S * 0.24)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=r, fill=BRAND)
    # 顶部高光
    d.rounded_rectangle([int(S * 0.08), int(S * 0.06), int(S * 0.92), int(S * 0.5)],
                        radius=int(S * 0.2), fill=(255, 255, 255, 26))

    # 对话气泡
    bx0, by0, bx1, by1 = int(S * 0.2), int(S * 0.22), int(S * 0.8), int(S * 0.62)
    d.rounded_rectangle([bx0, by0, bx1, by1], radius=int(S * 0.12), fill=WHITE)
    # 气泡尾巴
    d.polygon([(int(S * 0.33), by1 - int(S * 0.02)),
               (int(S * 0.33), int(S * 0.72)),
               (int(S * 0.48), by1 - int(S * 0.02))], fill=WHITE)

    # 三个点（打字中）
    cy = (by0 + by1) // 2
    rr = int(S * 0.045)
    for i, cx in enumerate([0.32, 0.5, 0.68]):
        x = int(S * cx)
        d.ellipse([x - rr, cy - rr, x + rr, cy + rr], fill=BRAND_DARK)

    # 底部 AI
    f = font(int(S * 0.17))
    txt = "AI"
    try:
        l, t, rr2, b = d.textbbox((0, 0), txt, font=f)
        tw, th = rr2 - l, b - t
        d.text(((S - tw) / 2 - l, int(S * 0.74) - t), txt, font=f, fill=WHITE)
    except Exception:
        pass

    return img.resize((size, size), Image.LANCZOS)


for s in (16, 32, 48, 128):
    p = os.path.join(OUT, f"{s}.png")
    draw_icon(s).save(p)
    print(f"{p}  {os.path.getsize(p)} bytes")

# 预览拼图，方便截图看
prev = Image.new("RGBA", (128 * 3 + 40, 148), (245, 245, 245, 255))
x = 10
for s in (128, 48, 32):
    im = draw_icon(s).resize((128 if s == 128 else s * 2, 128 if s == 128 else s * 2), Image.LANCZOS)
    prev.paste(im, (x, (148 - im.height) // 2), im)
    x += im.width + 10
prev.save(os.path.join(OUT, "preview.png"))
print("preview ->", os.path.join(OUT, "preview.png"))
