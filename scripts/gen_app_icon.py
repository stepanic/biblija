#!/usr/bin/env python3
"""Ikona aplikacije (1024×1024) za iOS: pergamena, zlatni križ, boje iz styles.css."""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "ios", "Biblija", "Resources", "Assets.xcassets", "AppIcon.appiconset", "AppIcon-1024.png")
S = 1024

img = Image.new("RGB", (S, S), (0x8F, 0x5E, 0x1E))
d = ImageDraw.Draw(img)
# blagi vertikalni gradijent prema tamnijoj smeđoj
for y in range(S):
    t = y / S
    d.line([(0, y), (S, y)], fill=(int(0x9C - 0x2C * t), int(0x68 - 0x20 * t), int(0x24 - 0x0C * t)))
# knjiga: dvije stranice
page = (0xF8, 0xF5, 0xEF)
d.rounded_rectangle([170, 300, 505, 760], radius=36, fill=page)
d.rounded_rectangle([519, 300, 854, 760], radius=36, fill=page)
d.rectangle([497, 300, 527, 760], fill=(0x6B, 0x45, 0x14))
# križ na desnoj stranici
gold = (0xD8, 0xA2, 0x4A)
d.rounded_rectangle([668, 380, 706, 680], radius=10, fill=gold)
d.rounded_rectangle([600, 450, 774, 488], radius=10, fill=gold)
# retci teksta na lijevoj stranici
for i, y in enumerate(range(400, 680, 46)):
    d.rounded_rectangle([220, y, 455 - (60 if i % 3 == 2 else 0), y + 16], radius=8, fill=(0xC9, 0xB8, 0x9C))
img.save(OUT)
print(os.path.relpath(OUT, ROOT))
