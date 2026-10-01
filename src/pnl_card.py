#!/usr/bin/env python3
"""pnl_card.py — koala-style NFT PnL card (800x420, dark, Poppins).

Example:
  python3 pnl_card.py --name "Juuju" --addr 0xabcd --collection "Whacky Whales" \
    --logo https://i2c.seadn.io/... --chain ETH \
    --invested 1.23 --gas 0.05 --sales 2.0 --holdings 3 --floor 0.5 --disc 10 \
    --minted 5 --bought 2 --sold 3 -o card.png

Images (--logo, --bg) accept a URL or a local file. Any aspect ratio is
auto-converted to the card shape (16:9) with a CENTER crop — a 1:1 picture
gets cropped in the middle, never stretched.
"""
import argparse, io, math, os, random, urllib.request
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 800, 420
HERE = os.path.dirname(os.path.abspath(__file__))
FONTDIR = os.path.join(HERE, "fonts")

def F(kind, size):
    return ImageFont.truetype(os.path.join(FONTDIR, f"Poppins-{kind}.ttf"), size)

def rrect(d, box, r, **kw):
    d.rounded_rectangle(box, radius=r, **kw)

def num(v, dp=4):
    if v is None:
        return "—"
    return f"{v:,.{dp}f}".rstrip("0").rstrip(".") if isinstance(v, float) else str(v)

def load_image(src):
    """Load an image from a URL or a local file path."""
    if not src:
        return None
    if src.startswith(("http://", "https://")):
        req = urllib.request.Request(src, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=12) as r:
            return Image.open(io.BytesIO(r.read()))
    return Image.open(src)


def cover_crop(img, w, h):
    """Auto-convert ANY aspect ratio to w:h — center crop (cover), no stretch.

    A 1:1 image becomes a 16:9 card bg by cropping the middle horizontally;
    a tall 9:16 image crops the middle vertically. The crop is always centered.
    """
    img = img.convert("RGB")
    iw, ih = img.size
    target = w / h
    if iw / ih > target:            # too wide -> crop left/right, keep center
        nw = int(ih * target)
        x0 = (iw - nw) // 2
        img = img.crop((x0, 0, x0 + nw, ih))
    elif iw / ih < target:          # too tall -> crop top/bottom, keep center
        nh = int(iw / target)
        y0 = (ih - nh) // 2
        img = img.crop((0, y0, iw, y0 + nh))
    return img.resize((w, h), Image.LANCZOS)


def draw_card(out, name, addr, collection, logo_url, chain,
              invested, gas, sales, holdings, floor, disc, minted, bought, sold,
              bg=None):
    # ---- calcs (same formulas as pnl.py) ----
    inv_total = invested + gas
    realized = sales - inv_total
    hold_v = (floor or 0) * (1 - disc / 100) * max(0, holdings)
    potential = realized + hold_v
    roi = (realized / inv_total * 100) if inv_total > 0 else 0.0
    pnl_col = (52, 211, 153) if potential >= 0 else (248, 113, 113)

    # ---- background: custom image (auto 16:9 center crop) or generated glow ----
    bg_ok = False
    if bg:
        try:
            img = cover_crop(load_image(bg), W, H)
            # darken so the white text stays readable on any picture
            shade = Image.new("RGB", (W, H), "#0d1117")
            img = Image.blend(img, shade, 0.62)
            bg_ok = True
        except Exception:
            bg_ok = False
    if not bg_ok:
        img = Image.new("RGB", (W, H), "#0d1117")
        glow = Image.new("RGB", (W, H), "#0d1117")
        gd = ImageDraw.Draw(glow)
        gd.ellipse([-160, -190, 420, 260], fill="#13233a")
        gd.ellipse([W - 300, H - 220, W + 180, H + 160], fill="#101b2e")
        glow = glow.filter(ImageFilter.GaussianBlur(90))
        img = Image.blend(img, glow, 0.55)
    d = ImageDraw.Draw(img)
    rrect(d, [0.5, 0.5, W - 1, H - 1], 22, outline=(255, 255, 255, 22), width=1)

    white = (240, 243, 248); gray = (139, 148, 158); dim = (96, 105, 117)

    # ---- logo circle (center-cropped, never stretched) ----
    lx, ly, lr = 34, 30, 30
    try:
        logo = load_image(logo_url)
        logo = cover_crop(logo, lr * 2, lr * 2)
        mask = Image.new("L", (lr * 2, lr * 2), 0)
        ImageDraw.Draw(mask).ellipse([0, 0, lr * 2 - 1, lr * 2 - 1], fill=255)
        img.paste(logo, (lx, ly), mask)
    except Exception:
        d.ellipse([lx, ly, lx + lr * 2, ly + lr * 2], fill="#1f2937")
        d.text((lx + lr, ly + lr), "?", font=F("SemiBold", 26), fill=gray, anchor="mm")

    # ---- chain chip (top-right) ----
    chip_col = {"ETH": (98, 126, 234), "BASE": (0, 87, 255), "APE": (0, 33, 255),
                "ARB": (40, 160, 255), "OP": (255, 4, 32), "POLY": (130, 70, 220),
                "SOL": (153, 69, 255), "RH": (0, 200, 120)}.get((chain or "ETH").upper(), (98, 126, 234))
    d.text((W - 34, 46), chain or "ETH", font=F("SemiBold", 13), fill=white, anchor="rm")
    tw = d.textlength(chain or "ETH", font=F("SemiBold", 13))
    rrect(d, [W - 34 - tw - 14, 32, W - 26, 60], 14, fill=chip_col)
    d.text((W - 34 - tw / 2 - 7, 46), chain or "ETH", font=F("SemiBold", 13), fill=white, anchor="mm")

    # ---- titles ----
    d.text((lx + lr * 2 + 16, 36), collection or "Collection", font=F("SemiBold", 26), fill=white)
    sub = f"{name or 'wallet'}" + (f" · {addr[:6]}…{addr[-4:]}" if addr else "")
    d.text((lx + lr * 2 + 17, 68), sub, font=F("Regular", 13), fill=gray)

    # ---- stats grid ----
    def cell(x, y, label, value, vcol=white):
        d.text((x, y), label.upper(), font=F("Medium", 11), fill=dim)
        d.text((x, y + 16), value, font=F("SemiBold", 17), fill=vcol)

    y0, colw = 122, (W - 68) / 4
    cell(34, y0, "Minted", num(minted, 0)); cell(34 + colw, y0, "Bought", num(bought, 0))
    cell(34 + 2 * colw, y0, "Sold", num(sold, 0)); cell(34 + 3 * colw, y0, "Holdings", num(holdings, 0))
    y1 = y0 + 62
    cell(34, y1, "Invested", num(inv_total)); cell(34 + colw, y1, "Gas", num(gas))
    cell(34 + 2 * colw, y1, "Sales", num(sales)); cell(34 + 3 * colw, y1, "Floor", num(floor))

    d.line([34, 246, W - 34, 246], fill=(255, 255, 255, 18), width=1)

    # ---- headline PnL ----
    d.text((34, 268), "POTENTIAL PNL", font=F("Medium", 12), fill=dim)
    sign = "+" if potential >= 0 else "-"
    d.text((34, 284), f"{sign}{num(abs(potential))}", font=F("Bold", 52), fill=pnl_col)
    d.text((34, 352), f"realized {num(realized)} · holding {num(hold_v)} (floor {num(floor)} −{num(disc, 0)}%)",
           font=F("Regular", 12), fill=gray)

    # ROI block right
    roi_txt = f"{'+' if roi >= 0 else ''}{roi:.1f}%"
    d.text((W - 34, 292), roi_txt, font=F("Bold", 34), fill=pnl_col, anchor="rm")
    d.text((W - 34, 322), "ROI", font=F("Medium", 12), fill=dim, anchor="rm")

    # ---- footer ----
    d.text((34, H - 28), "multi-wallet-pnl · public explorer data, no keys", font=F("Regular", 11), fill=dim)
    from datetime import datetime, timezone
    d.text((W - 34, H - 28), datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
           font=F("Regular", 11), fill=dim, anchor="rm")

    img.save(out)
    return out


def main():
    ap = argparse.ArgumentParser(description="koala-style PnL card renderer")
    for flag, hlp in [("--name", "wallet name"), ("--addr", "wallet address"),
                      ("--collection", "collection name"), ("--logo", "logo image URL or file (auto center-crop)"),
                      ("--bg", "background image URL or file (auto-converted to 16:9, center crop)"),
                      ("--chain", "chain label"), ("--invested", "total spent (excl. gas)"),
                      ("--gas", "gas spent"), ("--sales", "total earned"),
                      ("--holdings", "NFTs held"), ("--floor", "floor price"),
                      ("--disc", "discount %% vs floor (default 10)"),
                      ("--minted", "minted count"), ("--bought", "bought count"),
                      ("--sold", "sold count"), ("-o", "output png path")]:
        ap.add_argument(flag, help=hlp)
    ap.add_argument("--random", action="store_true", help="render a sample card with random data")
    a = ap.parse_args()

    if a.random:
        collections = ["Whacky Whales", "Hood Warrios", "Mutant Juuju", "Cash Giraffs", "Greed Cats"]
        chain = random.choice(["ETH", "BASE", "APE", "SOL", "RH"])
        invested = round(random.uniform(0.1, 3), 4)
        gas = round(invested * random.uniform(0.02, 0.15), 4)
        sales = round(random.uniform(0, 5), 4)
        holdings = random.randint(0, 12)
        floor = round(random.uniform(0.0008, 0.5), 5)
        draw_card(a.o or "card.png", random.choice(["Juuju", "vault", "main"]),
                  "0xe4550394890B37123d171D7B4eF8F71E0bA216d1",
                  random.choice(collections), "", chain,
                  invested, gas, sales, holdings, floor, 10,
                  holdings + random.randint(0, 5), random.randint(0, 3), random.randint(0, 4))
        print(a.o or "card.png")
        return

    missing = [f for f, v in [("--name", a.name), ("--addr", a.addr), ("--collection", a.collection),
                              ("--invested", a.invested), ("--gas", a.gas), ("--sales", a.sales),
                              ("--holdings", a.holdings)] if v is None]
    if missing:
        ap.error("required: " + ", ".join(missing))
    out = draw_card(a.o or "card.png", a.name, a.addr, a.collection, a.logo or "", a.chain or "ETH",
                    float(a.invested), float(a.gas), float(a.sales), int(float(a.holdings)),
                    float(a.floor or 0), float(a.disc or 10),
                    int(float(a.minted or 0)), int(float(a.bought or 0)), int(float(a.sold or 0)),
                    bg=a.bg or None)
    print(out)


if __name__ == "__main__":
    main()
