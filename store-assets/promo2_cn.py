#!/usr/bin/env python3
# Chrome 商店截图 promo2_cn.png — 1280x800，主打「5 小时窗口规划」
# 2x 超采样绘制后缩小，保证圆角/文字平滑
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import numpy as np

S = 2
W, H = 1280 * S, 800 * S
REPO = "/sessions/pensive-trusting-cori/mnt/Claude-Cooldown-Reminder"

# ---------- fonts ----------
TTC_R = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
TTC_B = "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"

def sc_index(path):
    for i in range(10):
        try:
            f = ImageFont.truetype(path, 20, index=i)
            if f.getname()[0] == "Noto Sans CJK SC":
                return i
        except Exception:
            break
    return 0

IR, IB = sc_index(TTC_R), sc_index(TTC_B)
def FR(px): return ImageFont.truetype(TTC_R, px * S, index=IR)
def FB(px): return ImageFont.truetype(TTC_B, px * S, index=IB)

# ---------- colors ----------
BG      = (14, 15, 19)
TEXT    = (232, 232, 236)
TEXT2   = (160, 160, 171)
TEXT3   = (109, 109, 120)
ACCENT  = (255, 122, 69)
READY   = (61, 220, 132)
OK1, OK2 = (76, 141, 255), (111, 211, 255)
WARN1, WARN2 = (255, 138, 0), (255, 176, 46)

img = Image.new("RGB", (W, H), BG)

# ---------- background glows (radial) ----------
def add_glow(cx, cy, rx, ry, color, alpha):
    yy, xx = np.mgrid[0:H, 0:W]
    d = ((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2
    a = np.clip(1 - np.sqrt(d), 0, 1) * alpha
    base = np.asarray(img, dtype=np.float32)
    col = np.array(color, dtype=np.float32)
    out = base + (col - base) * a[..., None]
    return Image.fromarray(out.astype(np.uint8))

img = add_glow(0.78 * W, 0.30 * H, 0.55 * W, 0.55 * H, (255, 122, 69), 0.13)
img = add_glow(0.15 * W, 0.90 * H, 0.40 * W, 0.45 * H, (76, 141, 255), 0.05)

d = ImageDraw.Draw(img, "RGBA")

# dot grid
for y in range(0, H, 26 * S):
    for x in range(0, W, 26 * S):
        d.ellipse([x, y, x + S, y + S], fill=(255, 255, 255, 8))

def rr(box, r, fill=None, outline=None, width=1):
    d.rounded_rectangle(box, radius=r * S, fill=fill, outline=outline, width=width)

def tw(txt, font):
    b = font.getbbox(txt)
    return b[2] - b[0]

def text(x, y, txt, font, fill):
    d.text((x, y), txt, font=font, fill=fill)

# =====================================================
# LEFT column
# =====================================================
LX = 88 * S

# badge
icon32 = Image.open(f"{REPO}/icons/icon32.png").convert("RGBA").resize((18 * S, 18 * S), Image.LANCZOS)
badge_txt = "Chrome 扩展 · Claude 提醒助手"
bf = FB(15)
bw = 16 * S + 18 * S + 8 * S + tw(badge_txt, bf) + 16 * S
by = 96 * S
rr([LX, by, LX + bw, by + 38 * S], 19, fill=(255, 122, 69, 31), outline=(255, 122, 69, 71), width=S)
img.paste(icon32, (LX + 16 * S, by + 10 * S), icon32)
text(LX + 16 * S + 18 * S + 8 * S, by + 8 * S, badge_txt, bf, ACCENT)

# headline
h1 = FB(52)
hy = by + 38 * S + 34 * S
text(LX, hy, "下一个 5 小时窗口", h1, TEXT)
line2_y = hy + 69 * S
text(LX, line2_y, "提前", h1, READY)
text(LX + tw("提前", h1), line2_y, "替你排好", h1, TEXT)

# sub
sf = FR(19)
sy = line2_y + 69 * S + 24 * S
text(LX, sy, "额度一恢复就亮绿灯，还把接下来三个使用窗口", sf, TEXT2)
text(LX, sy + 33 * S, "的起止时间列成时间表，工作节奏心里有数。", sf, TEXT2)

# features
def feat_icon(x, y, kind, green=False):
    c = READY if green else ACCENT
    fill = (61, 220, 132, 26) if green else (255, 122, 69, 31)
    bord = (61, 220, 132, 77) if green else (255, 122, 69, 71)
    rr([x, y, x + 52 * S, y + 52 * S], 14, fill=fill, outline=bord, width=S)
    cx, cy = x + 26 * S, y + 26 * S
    lw = 2 * S
    if kind == "check":
        d.line([cx - 8 * S, cy + 1 * S, cx - 2 * S, cy + 7 * S, cx + 9 * S, cy - 6 * S],
               fill=c, width=lw, joint="curve")
    elif kind == "cal":
        d.rounded_rectangle([cx - 10 * S, cy - 8 * S, cx + 10 * S, cy + 10 * S], radius=2 * S, outline=c, width=lw)
        d.line([cx - 10 * S, cy - 2 * S, cx + 10 * S, cy - 2 * S], fill=c, width=lw)
        d.line([cx - 5 * S, cy - 12 * S, cx - 5 * S, cy - 8 * S], fill=c, width=lw)
        d.line([cx + 5 * S, cy - 12 * S, cx + 5 * S, cy - 8 * S], fill=c, width=lw)
    elif kind == "clock":
        d.ellipse([cx - 10 * S, cy - 10 * S, cx + 10 * S, cy + 10 * S], outline=c, width=lw)
        d.line([cx, cy - 6 * S, cx, cy], fill=c, width=lw)
        d.line([cx, cy, cx + 5 * S, cy + 3 * S], fill=c, width=lw)

feats = [
    ("check", True,  "绿灯即发",   "倒计时归零立刻变绿，发一条消息就开启新窗口"),
    ("cal",   False, "窗口时间表", "未来 3 个 5 小时窗口的起止时间一目了然"),
    ("clock", False, "随开随算",   "时间表锚定「现在」，什么时候开始都算得准"),
]
fy = sy + 33 * S * 2 + 40 * S
ft_b, ft_r = FB(17), FR(14)
for kind, green, t1, t2 in feats:
    feat_icon(LX, fy, kind, green)
    text(LX + 70 * S, fy + 3 * S, t1, ft_b, TEXT)
    text(LX + 70 * S, fy + 29 * S, t2, ft_r, TEXT2)
    fy += 74 * S

# footer
foot_y = fy + 16 * S
star_f = FB(15)
text(LX, foot_y, "★★★★★", star_f, ACCENT)
text(LX + tw("★★★★★", star_f) + 12 * S, foot_y + 1 * S, "免费 · 支持中英文 · 无需注册", FR(14), TEXT3)

# =====================================================
# RIGHT: popup mockup
# =====================================================
PW = 442 * S
PX = W - PW - 130 * S
PY = 108 * S

# shadow
sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
ds = ImageDraw.Draw(sh)
ds.rounded_rectangle([PX - 6 * S, PY + 14 * S, PX + PW + 6 * S, PY + 667 * S + 34 * S], radius=24 * S, fill=(0, 0, 0, 150))
sh = sh.filter(ImageFilter.GaussianBlur(24 * S))
img.paste(Image.alpha_composite(img.convert("RGBA"), sh).convert("RGB"), (0, 0))
d = ImageDraw.Draw(img, "RGBA")

def measure_popup():
    pass

# popup body
PH = 667 * S
rr([PX, PY, PX + PW, PY + PH], 18, fill=(19, 20, 25), outline=(255, 255, 255, 140), width=S)
# inner orange top glow
glow = Image.new("RGBA", (PW, PH), (0, 0, 0, 0))
gy, gx = np.mgrid[0:PH, 0:PW]
gd = ((gx - PW / 2) / (0.6 * PW)) ** 2 + ((gy + 0.1 * PH) / (0.55 * PH)) ** 2
ga = (np.clip(1 - np.sqrt(gd), 0, 1) * 0.10 * 255).astype(np.uint8)
glow = Image.fromarray(np.dstack([np.full_like(ga, 255), np.full_like(ga, 122), np.full_like(ga, 69), ga]))
mask = Image.new("L", (PW, PH), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, PW - 1, PH - 1], radius=18 * S, fill=255)
glow.putalpha(Image.composite(glow.split()[3], Image.new("L", (PW, PH), 0), mask))
img.paste(glow, (PX, PY), glow)
d = ImageDraw.Draw(img, "RGBA")

# header
icon128 = Image.open(f"{REPO}/icons/icon128.png").convert("RGBA").resize((34 * S, 34 * S), Image.LANCZOS)
img.paste(icon128, (PX + 22 * S, PY + 18 * S), icon128)
text(PX + 69 * S, PY + 16 * S, "Claude 提醒助手", FB(19), TEXT)
text(PX + 69 * S, PY + 46 * S, "额度恢复后自动提醒你", FR(14), TEXT2)
d.line([PX + S, PY + 76 * S, PX + PW - S, PY + 76 * S], fill=(255, 255, 255, 15), width=S)

CARD_X = PX + 16 * S
CARD_W = PW - 32 * S

# ---- status card ----
c1y = PY + 92 * S
C1H = 268 * S
rr([CARD_X, c1y, CARD_X + CARD_W, c1y + C1H], 16, fill=(255, 255, 255, 10), outline=(255, 255, 255, 20), width=S)

# green dot + glow
dot_cx, dot_cy = CARD_X + 24 * S, c1y + 29 * S
gl = Image.new("RGBA", (60 * S, 60 * S), (0, 0, 0, 0))
ImageDraw.Draw(gl).ellipse([18 * S, 18 * S, 42 * S, 42 * S], fill=(61, 220, 132, 130))
gl = gl.filter(ImageFilter.GaussianBlur(7 * S))
img.paste(gl, (dot_cx - 30 * S, dot_cy - 30 * S), gl)
d = ImageDraw.Draw(img, "RGBA")
d.ellipse([dot_cx - 5 * S, dot_cy - 5 * S, dot_cx + 6 * S, dot_cy + 6 * S], fill=READY)

text(CARD_X + 41 * S, c1y + 17 * S, "额度可用", FB(17), TEXT)

hf = FR(15)
hx, hy2 = CARD_X + 18 * S, c1y + 56 * S
text(hx, hy2, "现在发送一条消息，即可开启新的 5 小时窗口。", hf, TEXT2)

# window rows
wf = FR(15)
wtf = FB(14)
wy = hy2 + 38 * S
rows = [("1", "今天 14:10 → 今天 19:10", True),
        ("2", "今天 19:10 → 明天 00:10", False),
        ("3", "明天 00:10 → 明天 05:10", False)]
for tag, when, first in rows:
    fill = (255, 122, 69, 13) if first else (255, 255, 255, 8)
    bord = (255, 122, 69, 71) if first else (255, 255, 255, 15)
    rr([CARD_X + 18 * S, wy, CARD_X + CARD_W - 18 * S, wy + 48 * S], 12, fill=fill, outline=bord, width=S)
    # tag
    tx = CARD_X + 31 * S
    rr([tx, wy + 11 * S, tx + 30 * S, wy + 37 * S], 8, fill=(255, 122, 69, 31), outline=(255, 122, 69, 71), width=S)
    text(tx + (30 * S - tw(tag, wtf)) // 2, wy + 13 * S, tag, wtf, ACCENT)
    text(tx + 43 * S, wy + 13 * S, when, wf, TEXT if first else TEXT2)
    wy += 57 * S

# ---- usage card ----
c2y = c1y + C1H + 13 * S
C2H = 278 * S
rr([CARD_X, c2y, CARD_X + CARD_W, c2y + C2H], 16, fill=(255, 255, 255, 10), outline=(255, 255, 255, 20), width=S)
text(CARD_X + 18 * S, c2y + 16 * S, "用量额度", FB(16), TEXT)
lf = FR(13)
lw_ = tw("刷新", lf) + 26 * S
rr([CARD_X + CARD_W - 18 * S - lw_, c2y + 14 * S, CARD_X + CARD_W - 18 * S, c2y + 14 * S + 27 * S], 9,
   outline=(255, 255, 255, 20), width=S)
text(CARD_X + CARD_W - 18 * S - lw_ + 13 * S, c2y + 17 * S, "刷新", lf, TEXT2)

def grad_bar(x, y, w, h, pct, c1, c2):
    # track
    rr([x, y, x + w, y + h], 3, fill=(255, 255, 255, 18))
    fw = max(int(w * pct / 100), h)
    if pct <= 0:
        fw = int(0.012 * w)
    arr = np.zeros((h, fw, 4), dtype=np.uint8)
    for i in range(fw):
        t = i / max(fw - 1, 1)
        arr[:, i, 0] = int(c1[0] + (c2[0] - c1[0]) * t)
        arr[:, i, 1] = int(c1[1] + (c2[1] - c1[1]) * t)
        arr[:, i, 2] = int(c1[2] + (c2[2] - c1[2]) * t)
        arr[:, i, 3] = 255
    bar = Image.fromarray(arr)
    m = Image.new("L", (fw, h), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, fw - 1, h - 1], radius=h // 2, fill=255)
    # soft glow under bar
    glw = Image.new("RGBA", (fw + 24 * S, h + 24 * S), (0, 0, 0, 0))
    ImageDraw.Draw(glw).rounded_rectangle([12 * S, 12 * S, 12 * S + fw, 12 * S + h], radius=h // 2,
                                          fill=(c2[0], c2[1], c2[2], 90))
    glw = glw.filter(ImageFilter.GaussianBlur(4 * S))
    img.paste(glw, (x - 12 * S, y - 12 * S), glw)
    img.paste(bar, (x, y), m)

unf, upf, urf = FB(15), FB(15), FR(13)
uy = c2y + 58 * S
usage = [("会话（5 小时）", "0%", 0, OK1, OK2, ""),
         ("每周", "26%", 26, OK1, OK2, "3天"),
         ("Fable 每周", "45%", 45, WARN1, WARN2, "3天")]
for name, pct_s, pct, cA, cB, reset in usage:
    text(CARD_X + 18 * S, uy, name, unf, TEXT2)
    pc = OK2 if cA == OK1 else WARN2
    text(CARD_X + 18 * S + tw(name, unf) + 10 * S, uy, pct_s, upf, pc)
    if reset:
        text(CARD_X + CARD_W - 18 * S - tw(reset, urf), uy + 2 * S, reset, urf, TEXT3)
    grad_bar(CARD_X + 18 * S, uy + 30 * S, CARD_W - 36 * S, 6 * S, pct, cA, cB)
    uy += 62 * S
d = ImageDraw.Draw(img, "RGBA")
text(CARD_X + 18 * S, uy - 4 * S, "更新于 14:08", FR(13), TEXT3)

# ---- green chip floating above popup ----
chip_f = FB(15)
chip_txt = "额度已恢复，可以发消息了"
cw = 18 * S + 17 * S + 9 * S + tw(chip_txt, chip_f) + 18 * S
chx = PX + PW - cw - 4 * S
chy = PY - 26 * S
# chip shadow
shc = Image.new("RGBA", (W, H), (0, 0, 0, 0))
ImageDraw.Draw(shc).rounded_rectangle([chx, chy + 6 * S, chx + cw, chy + 44 * S + 6 * S], radius=22 * S, fill=(0, 0, 0, 140))
shc = shc.filter(ImageFilter.GaussianBlur(8 * S))
img.paste(Image.alpha_composite(img.convert("RGBA"), shc).convert("RGB"), (0, 0))
d = ImageDraw.Draw(img, "RGBA")
rr([chx, chy, chx + cw, chy + 44 * S], 22, fill=(23, 32, 27, 245), outline=(61, 220, 132, 115), width=S)
ccx, ccy = chx + 18 * S + 8 * S, chy + 22 * S
d.line([ccx - 7 * S, ccy + 1 * S, ccx - 2 * S, ccy + 6 * S, ccx + 8 * S, ccy - 5 * S],
       fill=READY, width=int(2.4 * S), joint="curve")
text(chx + 18 * S + 17 * S + 9 * S, chy + 9 * S, chip_txt, chip_f, READY)

# ---------- downscale & save ----------
final = img.resize((1280, 800), Image.LANCZOS)
out = f"{REPO}/store-assets/promo2_cn.png"
final.save(out, optimize=True)
print("saved", out, final.size)
