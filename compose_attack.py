import cairosvg
from PIL import Image
import io
import os
import math

svg_path = os.path.expanduser("~/repos/Extensions/sight/client/icon_clean.svg")
png_path = os.path.expanduser("~/repos/Extensions/raven/editors/vscode/icon.png")

# Render SVG at 512x512 (scale = 4)
# viewBox is 0 0 128 128
scale = 4
svg_png_data = cairosvg.svg2png(url=svg_path, output_width=128*scale, output_height=128*scale)
bg = Image.open(io.BytesIO(svg_png_data)).convert("RGBA")

# Raven image
raven_orig = Image.open(png_path).convert("RGBA")

# Let's try 3 different placements/rotations and save them so we can pick the best.

# 1. Perched at the peak, slightly tilted.
# Peak is at x=64, y=22 -> scaled to 256, 88
raven1 = raven_orig.resize((200, 200), Image.Resampling.LANCZOS)
# Rotate it a little bit forward (e.g. -15 degrees if facing right, or +15 if facing left. We'll do both)
bg1 = bg.copy()
# Just paste it so bottom-center of raven is at (256, 88)
rx1, ry1 = 256 - 100, 88 - 180 
bg1.paste(raven1, (rx1, ry1), raven1)
bg1.save("attack_peak.png")

# 2. Diving off the right side
# At x=80, y=59.25 -> scaled to 320, 237
raven2 = raven_orig.resize((160, 160), Image.Resampling.LANCZOS).rotate(-30, expand=True)
bg2 = bg.copy()
rx2, ry2 = 320 - raven2.width//2, 237 - raven2.height + 20
bg2.paste(raven2, (rx2, ry2), raven2)
bg2.save("attack_right_slope.png")

# 3. Diving off the left side
# At x=48, y=59.25 -> scaled to 192, 237
raven3 = raven_orig.resize((160, 160), Image.Resampling.LANCZOS).rotate(30, expand=True)
bg3 = bg.copy()
rx3, ry3 = 192 - raven3.width//2, 237 - raven3.height + 20
bg3.paste(raven3, (rx3, ry3), raven3)
bg3.save("attack_left_slope.png")

