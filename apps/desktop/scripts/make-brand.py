# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow==11.3.0"]
# ///
"""从两张原图出应用图标和 README 里的标志。原图换了之后重跑：

    uv run apps/desktop/scripts/make-brand.py

原图（apps/desktop/assets/brand/）：
    icon-source.png   应用图标的原图：黑底，正中是图形
    logo-source.png   品牌标志的原图：黑底，正中是带字的标志
产物（都提交进仓库，打包和看 README 时不需要 Python）：
    apps/desktop/assets/icon.icns   macOS 的应用图标
    apps/desktop/assets/icon.ico    Windows 的应用图标
    apps/desktop/assets/icon.png    Linux 上窗口的图标（那里的窗口不会自己从可执行文件上取）
    apps/desktop/assets/icon-dock.png   开发时 macOS 程序坞上的图标（没打包的时候系统给的是 Electron 自己的）
    docs/images/litch-logo.png      README 开头的标志
    packages/ui/src/settings/litch-icon.png   设置页“关于”里的图标（方的，圆角由界面按皮肤裁）

macOS 的图标按系统的规矩来：1024 的画布，正中 824 见方的圆角底板，四周留空，底板下面一层很淡的投影。
Windows 和 Linux 的图标不留空，底板铺满。两张原图的底都是黑的，底板也用黑的，图形原样放上去。
"""

from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ASSETS = Path(__file__).resolve().parent.parent / "assets"
REPO = ASSETS.parent.parent.parent
ICON_SOURCE = ASSETS / "brand" / "icon-source.png"
LOGO_SOURCE = ASSETS / "brand" / "logo-source.png"

# 画的时候放大几倍再缩回去，圆角的边才平滑
SCALE = 4
# 内容和底的分界：原图的底不是严格的 0，亮度到这个数以上才算内容
INK = 24


def content_box(image: Image.Image) -> tuple[int, int, int, int]:
    """图里内容（不是黑底的部分）的外接框。"""
    box = image.convert("L").point(lambda value: 255 if value > INK else 0).getbbox()
    if box is None:
        raise SystemExit("原图是全黑的，找不到内容")
    return box


def centered_crop(image: Image.Image, width: int, height: int) -> Image.Image:
    """以内容的中心为中心裁出一块，超出原图的地方补黑。"""
    left, top, right, bottom = content_box(image)
    center_x, center_y = (left + right) // 2, (top + bottom) // 2
    canvas = Image.new("RGB", (width, height), (0, 0, 0))
    canvas.paste(image.convert("RGB"), (width // 2 - center_x, height // 2 - center_y))
    return canvas


def rounded_mask(size: tuple[int, int], radius: float) -> Image.Image:
    """圆角矩形的蒙版，铺满 size。"""
    big = Image.new("L", (size[0] * SCALE, size[1] * SCALE), 0)
    ImageDraw.Draw(big).rounded_rectangle(
        (0, 0, big.width - 1, big.height - 1), radius=radius * SCALE, fill=255
    )
    return big.resize(size, Image.Resampling.LANCZOS)


def tile(source: Image.Image, side: int, radius: float, glyph_share: float) -> Image.Image:
    """一块圆角的黑底板，图形在正中。glyph_share：图形的宽占底板的几成。"""
    left, _, right, _ = content_box(source)
    window = round((right - left) / glyph_share)
    art = centered_crop(source, window, window).resize((side, side), Image.Resampling.LANCZOS)
    mask = rounded_mask((side, side), radius)
    # 沿边一圈很淡的亮线：黑底板放在深色的程序坞、深色的壁纸上还看得出边
    inner = rounded_mask((side - 4, side - 4), max(radius - 2, 0))
    rim = Image.new("L", (side, side), 0)
    rim.paste(inner, (2, 2))
    rim = ImageChops.subtract(mask, rim).point(lambda value: value * 30 // 255)
    art = ImageChops.lighter(art, Image.merge("RGB", (rim, rim, rim)))
    result = art.convert("RGBA")
    result.putalpha(mask)
    return result


def mac_icon(source: Image.Image) -> Image.Image:
    canvas = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    body = tile(source, 824, 185.4, 0.6)
    # 投影：底板的形状往下挪一点、糊开、压淡
    shadow = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    shade = body.getchannel("A").point(lambda value: value * 80 // 255)
    shadow.paste((0, 0, 0, 255), (100, 112), shade)
    canvas = Image.alpha_composite(canvas, shadow.filter(ImageFilter.GaussianBlur(14)))
    canvas.alpha_composite(body, (100, 100))
    return canvas


def windows_icon(source: Image.Image) -> Image.Image:
    return tile(source, 256, 44, 0.64)


def linux_icon(source: Image.Image) -> Image.Image:
    return tile(source, 512, 88, 0.64)


def about_icon(source: Image.Image) -> Image.Image:
    """“关于”那一页上的图标：方的黑底，图形在正中。不带圆角和留空，圆角由界面按皮肤裁。"""
    left, _, right, _ = content_box(source)
    window = round((right - left) / 0.64)
    return centered_crop(source, window, window).resize((192, 192), Image.Resampling.LANCZOS)


def readme_logo(source: Image.Image) -> Image.Image:
    left, top, right, bottom = content_box(source)
    width, height = right - left, bottom - top
    # 左右各留内容高度的一半，上下各留四成半
    banner = centered_crop(source, width + height, round(height * 1.9))
    result = banner.convert("RGBA")
    result.putalpha(rounded_mask(banner.size, height * 0.22))
    return result


def main() -> None:
    icon_source = Image.open(ICON_SOURCE)
    mac_icon(icon_source).save(ASSETS / "icon.icns", format="ICNS")
    windows_icon(icon_source).save(
        ASSETS / "icon.ico",
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    linux_icon(icon_source).save(ASSETS / "icon.png", optimize=True)
    mac_icon(icon_source).resize((512, 512), Image.Resampling.LANCZOS).save(
        ASSETS / "icon-dock.png", optimize=True
    )
    about_icon(icon_source).save(
        REPO / "packages" / "ui" / "src" / "settings" / "litch-icon.png", optimize=True
    )
    logo = readme_logo(Image.open(LOGO_SOURCE))
    logo.save(REPO / "docs" / "images" / "litch-logo.png", optimize=True)
    print(f"图标和标志已生成（标志 {logo.width}×{logo.height}）")


if __name__ == "__main__":
    main()
