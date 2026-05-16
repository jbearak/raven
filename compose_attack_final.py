import cairosvg
from PIL import Image, ImageOps
import io
import os

svg_path = os.path.expanduser("~/repos/Extensions/sight/client/icon_clean.svg")
png_path = os.path.expanduser("~/repos/Extensions/raven/editors/vscode/icon.png")

# Render SVG at 512x512
scale = 4
svg_png_data = cairosvg.svg2png(url=svg_path, output_width=128*scale, output_height=128*scale)
bg = Image.open(io.BytesIO(svg_png_data)).convert("RGBA")

# Raven image
raven_orig = Image.open(png_path).convert("RGBA")

# Flip the raven so it faces RIGHT
raven_flipped = ImageOps.mirror(raven_orig)

# Resize to something reasonable, e.g., 200x200
raven_resized = raven_flipped.resize((200, 200), Image.Resampling.LANCZOS)

# Rotate to match the downward right slope.
# Right slope goes down. PIL rotate positive is counter-clockwise. 
# We want it to tilt forward (clockwise), so we use a negative angle.
raven_rotated = raven_resized.rotate(-25, expand=True)

# Place it on the right slope. 
# Peak is roughly x=256. 
# Let's put it around x=320, y=200
bg_final = bg.copy()
rx, ry = 300 - raven_rotated.width//2, 210 - raven_rotated.height//2
bg_final.paste(raven_rotated, (rx, ry), raven_rotated)
bg_final.save("raven_attack_final.png")
print("Saved raven_attack_final.png")

