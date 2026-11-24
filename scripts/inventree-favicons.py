"""Remplace les favicons d'InvenTree par le logo de l'asso.

À exécuter DANS le conteneur <asso>-server (Pillow y est) :
    docker exec -i <asso>-server python3 - < scripts/inventree-favicons.py

Source : static/img/custom_logo.png (posé par create-asso.sh). Sans lui, ne fait rien.
Les originaux d'InvenTree sont gardés une fois pour toutes dans
static/img/favicon-inventree-orig/. Une montée de version (collectstatic) remet les
icônes d'InvenTree : relancer ce script (ou create-asso.sh) après.
"""
import os
import re
import shutil

from PIL import Image

STATIC = '/home/inventree/data/static/img'
SRC = os.path.join(STATIC, 'custom_logo.png')
DIR = os.path.join(STATIC, 'favicon')
BACKUP = os.path.join(STATIC, 'favicon-inventree-orig')

if not os.path.isfile(SRC):
    print('favicons : pas de custom_logo.png, rien à faire')
    raise SystemExit(0)

if not os.path.isdir(BACKUP):
    shutil.copytree(DIR, BACKUP)

logo = Image.open(SRC).convert('RGBA')
# rogne la transparence ET le fond blanc (logos JPEG/RGB) : sinon illisible en 16 px
ink = Image.eval(logo.convert('L'), lambda v: 255 if v < 245 else 0)
bbox = Image.composite(ink, Image.new('L', logo.size, 0), logo.getchannel('A')).getbbox()
if bbox:
    logo = logo.crop(bbox)


def render(size, opaque):
    """Logo centré dans un carré, marge ~6 %, fond blanc si opaque."""
    bg = (255, 255, 255, 255) if opaque else (255, 255, 255, 0)
    canvas = Image.new('RGBA', (size, size), bg)
    inner = max(1, round(size * 0.88))
    img = logo.copy()
    img.thumbnail((inner, inner), Image.LANCZOS)
    canvas.alpha_composite(img, ((size - img.width) // 2, (size - img.height) // 2))
    return canvas.convert('RGB') if opaque else canvas


count = 0
for name in sorted(os.listdir(DIR)):
    m = re.fullmatch(r'(apple|android|ms|favicon)-icon-?(\d+)x\d+\.png|favicon-(\d+)x\d+\.png', name)
    if m:
        size = int(m.group(2) or m.group(3))
        # iOS et tuiles Windows veulent un fond plein
        render(size, opaque=not name.startswith(('favicon', 'android'))).save(os.path.join(DIR, name))
        count += 1
    elif name in ('apple-icon.png', 'apple-icon-precomposed.png'):
        render(192, opaque=True).save(os.path.join(DIR, name))
        count += 1

render(48, opaque=False).save(os.path.join(DIR, 'favicon.ico'), sizes=[(16, 16), (32, 32), (48, 48)])
count += 1
# variantes précompressées de l'ancien .ico : obsolètes
for ext in ('.br', '.gz'):
    p = os.path.join(DIR, 'favicon.ico' + ext)
    if os.path.exists(p):
        os.remove(p)

print(f'favicons : {count} icônes régénérées depuis custom_logo.png')
