"""Builds public/img/basemap.jpg: NASA Blue Marble (public domain) colour, relief-shaded
from elevation, with a toned ocean. Run: python3 -I scripts/build-basemap.py"""
from PIL import Image, ImageEnhance
import numpy as np, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
R = os.path.join(ROOT, 'data-raw') + '/'
W, H = 4096, 2048
col = np.asarray(Image.open(R+'earth-blue-marble.jpg').convert('RGB').resize((W, H), Image.LANCZOS)).astype(np.float32)/255
el = np.asarray(Image.open(R+'earth-topology.png').convert('L').resize((W, H), Image.BICUBIC)).astype(np.float32)
water = np.asarray(Image.open(R+'earth-water.png').convert('L').resize((W, H), Image.BILINEAR)).astype(np.float32)/255
gy, gx = np.gradient(el)
az, alt, z = np.radians(315), np.radians(40), 3.2
slope = np.arctan(z*np.hypot(gx, gy)/8); aspect = np.arctan2(-gx, gy)
hs = np.sin(alt)*np.cos(slope)+np.cos(alt)*np.sin(slope)*np.cos(az-aspect)
hs = np.clip(hs, 0, 1); hs = (hs-hs.mean())+0.72
shade = np.clip(hs, 0.35, 1.25)[..., None]
land = (water < 0.5)[..., None]
lum = col.mean(axis=2, keepdims=True)
ocean = np.clip(lum*np.array([0.35, 0.62, 0.95])*1.25+np.array([0.02, 0.05, 0.10]), 0, 1)
out = np.where(land, col*shade, ocean)
img = Image.fromarray((np.clip(out, 0, 1)*255).astype(np.uint8))
img = ImageEnhance.Contrast(img).enhance(1.06); img = ImageEnhance.Color(img).enhance(1.05)
y0 = int((90-84)/180*H); y1 = int((90+58)/180*H)
img = img.crop((0, y0, W, y1))
img.save(os.path.join(ROOT, 'public/img/basemap.jpg'), quality=86, optimize=True, progressive=True)
img.resize((W//4, (y1-y0)//4), Image.LANCZOS).save(os.path.join(ROOT, 'public/img/basemap-small.jpg'), quality=80)
