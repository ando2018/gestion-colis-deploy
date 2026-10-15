# Vidéo de présentation : diapositives (captures d'écran) + voix off française → presentation/presentation.mp4
# Prérequis : captures faites (node presentation/captures.mjs), puis  pip install edge-tts imageio-ffmpeg pillow
# Lancer :  python presentation/video.py   (option --voix fr-FR-HenriNeural pour une voix masculine)
import argparse, asyncio, json, os, subprocess, sys
from pathlib import Path

import edge_tts
import imageio_ffmpeg
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ICI = Path(__file__).resolve().parent
CAPTURES = ICI / 'captures'
TRAVAIL = ICI / 'travail'
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
L, H = 1920, 1080
FONDS = ('#0b1328', '#16244a')
ACCENT = '#3b82f6'
POLICE = 'C:/Windows/Fonts/segoeui.ttf'
POLICE_GRAS = 'C:/Windows/Fonts/segoeuib.ttf'

# (capture, étape, titre, texte lu)
DIAPOS = [
    (None, '', 'Gestion colis', "Gestion colis : du dépôt jusqu'à la destination, chaque colis est suivi, scan après scan. Découvrons ensemble le parcours d'un colis, de sa réception jusqu'au départ du conteneur."),
    ('01-connexion', 'Connexion', 'Un accès simple et sécurisé', "Chaque agent se connecte avec l'identifiant de son entreprise, son e-mail et un code à quatre chiffres. Il ne voit que les écrans utiles à son rôle : réception, cariste, chef de quai ou administrateur."),
    ('02-reception', 'Étape 1 · Réception', 'Enregistrer le colis au comptoir', "À la réception, l'agent saisit l'expéditeur, le destinataire, la destination et le poids. Le prix est calculé automatiquement selon le tarif au kilo. On peut ajouter des options, comme un emballage renforcé, et appliquer un code promo. Si le client le souhaite, il est inscrit pour recevoir nos offres."),
    ('03-etiquette', 'Étape 1 · Réception', 'Étiquette et reçu en un clic', "Le colis est enregistré. L'étiquette, avec son code-barres et son QR code, s'imprime aussitôt, ainsi que le reçu du client."),
    ('04-palettisation', 'Étape 2 · Palettisation', 'Poser les colis sur palette', "En palettisation, le cariste scanne chaque colis pour le poser sur une palette de la même destination. Le poids est contrôlé en temps réel, puis la palette est fermée."),
    ('05-zone-depart', 'Étape 3 · Mise en zone', 'Préparer le départ', "Le chef de quai place ensuite les palettes fermées en zone de départ, prêtes à être chargées. Les reliquats et les colis les plus anciens sont proposés en premier."),
    ('06-chargement', 'Étape 4 · Conteneur', 'Charger le conteneur', "Au chargement, on ouvre un conteneur pour la destination et on scanne chaque palette. Les compteurs indiquent les colis chargés, les retours au dépôt et les éventuels colis hors manifeste."),
    ('07-validation', 'Étape 5 · Validation', 'Valider le chargement', "Une fois le chargement terminé, on le valide. L'application vérifie que tous les colis sont payés ; sinon, une dérogation motivée est demandée."),
    ('07b-valide', 'Étape 5 · Validation', 'Scellé et départ', "Le conteneur est validé. Il suffit de saisir le numéro de scellé pour le faire partir : tous ses colis passent au statut « Parti », et le manifeste est prêt à imprimer."),
    ('08-suivi', 'Suivi', 'Tout voir en temps réel', "Le tableau de bord donne une vue d'ensemble en temps réel : colis reçus, palettes, zone de départ et conteneurs. Chaque colis se retrouve par un simple scan, avec son historique complet."),
    ('09-clients', 'Campagne clients', 'Une base clients qui se construit seule', "Côté campagne client, chaque client qui accepte nos offres rejoint automatiquement la base clients, avec son consentement. Il peut se désinscrire à tout moment."),
    ('10-codes-promo', 'Campagne clients', 'Des codes promo maîtrisés', "L'administrateur crée des codes promo : un pourcentage de réduction, une période de validité et un nombre maximum d'utilisations."),
    ('11-campagne', 'Campagne clients', 'Envoyer une offre par e-mail', "Il envoie ensuite une offre par e-mail à tous les abonnés, ou à une sélection de clients, avec le code promo mis en avant. L'aperçu montre le message tel que le client le recevra."),
    ('12-export', 'Administration', 'Export détaillé', "Enfin, l'export détaillé liste tous les colis avec leur palette, leur conteneur, les options, les offres de réduction et les montants payés, en Excel, CSV ou PDF."),
    (None, '', 'Gestion colis', "Gestion colis : de la réception au départ du conteneur, un suivi complet, et des clients fidélisés."),
]


def police(gras, taille):
    return ImageFont.truetype(POLICE_GRAS if gras else POLICE, taille)


def fond():
    img = Image.new('RGB', (L, H), FONDS[0])
    d = ImageDraw.Draw(img)
    a, b = [tuple(int(c[i:i + 2], 16) for i in (1, 3, 5)) for c in FONDS]
    for y in range(H):
        t = y / H
        d.line([(0, y), (L, y)], fill=tuple(int(a[k] + (b[k] - a[k]) * t) for k in range(3)))
    return img


def coins(img, r):
    masque = Image.new('L', img.size, 0)
    ImageDraw.Draw(masque).rounded_rectangle([0, 0, img.width - 1, img.height - 1], r, fill=255)
    return masque


def diapo_capture(capture, etape, titre, sortie):
    img = fond()
    d = ImageDraw.Draw(img)
    # Pastille de l'étape puis titre
    f_etape = police(True, 26)
    largeur = d.textlength(etape.upper(), font=f_etape) + 44
    d.rounded_rectangle([120, 52, 120 + largeur, 98], 23, fill=ACCENT)
    d.text((142, 58), etape.upper(), font=f_etape, fill='white')
    d.text((120 + largeur + 28, 44), titre, font=police(True, 50), fill='white')
    # Capture encadrée, avec ombre
    cap = Image.open(CAPTURES / f'{capture}.png').convert('RGB').resize((1520, 855), Image.LANCZOS)
    x, y = (L - cap.width) // 2, 150
    ombre = Image.new('L', (L, H), 0)
    ImageDraw.Draw(ombre).rounded_rectangle([x, y + 14, x + cap.width, y + cap.height + 14], 22, fill=150)
    img.paste(Image.new('RGB', (L, H), '#000000'), (0, 0), ombre.filter(ImageFilter.GaussianBlur(24)))
    img.paste(cap, (x, y), coins(cap, 18))
    img.save(sortie)


def diapo_titre(premiere, sortie):
    img = fond()
    d = ImageDraw.Draw(img)
    # Icône de l'application (web/public/icone-512.png)
    logo = Image.open(ICI.parent.parent / 'web' / 'public' / 'icone-512.png').convert('RGBA').resize((170, 170), Image.LANCZOS)
    img.paste(logo, ((L - 170) // 2, 240), logo)
    def centre(texte, y, f, couleur):
        d.text(((L - d.textlength(texte, font=f)) / 2, y), texte, font=f, fill=couleur)
    centre('Gestion colis', 440, police(True, 110), 'white')
    if premiere:
        centre('Du dépôt à la destination, chaque colis suivi scan après scan', 600, police(False, 44), '#c7d2fe')
        etapes = 'Réception  ·  Palettisation  ·  Zone de départ  ·  Conteneur  ·  Validation  ·  Campagne clients'
        centre(etapes, 720, police(True, 32), '#93c5fd')
    else:
        centre('Réception, palettes, conteneurs… et clients fidélisés', 600, police(False, 44), '#c7d2fe')
    img.save(sortie)


async def voix(texte, sortie, nom_voix, debit):
    await edge_tts.Communicate(texte, nom_voix, rate=debit).save(str(sortie))


def duree(fichier):
    r = subprocess.run([FFMPEG, '-i', str(fichier)], capture_output=True, text=True)
    h, m, s = r.stderr.split('Duration: ')[1].split(',')[0].split(':')
    return int(h) * 3600 + int(m) * 60 + float(s)


def horodatage(t):
    ms = int(round(t * 1000))
    return f'{ms // 3600000:02}:{ms // 60000 % 60:02}:{ms // 1000 % 60:02},{ms % 1000:03}'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--voix', default='fr-FR-DeniseNeural')
    ap.add_argument('--debit', default='+0%')
    args = ap.parse_args()
    TRAVAIL.mkdir(exist_ok=True)
    segments, srt, t = [], [], 0.0
    AVANT, APRES, FONDU = 0.6, 0.9, 0.35
    for i, (capture, etape, titre, texte) in enumerate(DIAPOS):
        png, mp3, mp4 = (TRAVAIL / f'{i:02}.{e}' for e in ('png', 'mp3', 'mp4'))
        if capture:
            diapo_capture(capture, etape, titre, png)
        else:
            diapo_titre(i == 0, png)
        asyncio.run(voix(texte, mp3, args.voix, args.debit))
        d = AVANT + duree(mp3) + APRES
        images = int(d * 30)
        # Léger zoom lent (image agrandie avant zoompan pour éviter les saccades), fondus d'entrée et de sortie
        filtre = (f"[0:v]scale=3840:2160,zoompan=z='1+0.04*on/{images}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={images}:s={L}x{H}:fps=30,"
                  f"fade=t=in:st=0:d={FONDU},fade=t=out:st={d - FONDU:.3f}:d={FONDU},format=yuv420p[v];"
                  f"[1:a]adelay={int(AVANT * 1000)}:all=1,apad,atrim=0:{d:.3f},aresample=48000[a]")
        subprocess.run([FFMPEG, '-y', '-loglevel', 'error', '-loop', '1', '-i', str(png), '-i', str(mp3), '-filter_complex', filtre,
                        '-map', '[v]', '-map', '[a]', '-t', f'{d:.3f}', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
                        '-c:a', 'aac', '-b:a', '160k', '-ac', '2', str(mp4)], check=True)
        segments.append(mp4)
        srt.append(f'{i + 1}\n{horodatage(t + AVANT)} --> {horodatage(t + d - APRES)}\n{texte}\n')
        t += d
        print(f'diapo {i + 1}/{len(DIAPOS)} : {titre} ({d:.1f} s)', flush=True)
    liste = TRAVAIL / 'liste.txt'
    liste.write_text(''.join(f"file '{s.as_posix()}'\n" for s in segments), encoding='utf-8')
    sortie = ICI / 'presentation.mp4'
    subprocess.run([FFMPEG, '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', str(liste), '-c', 'copy', '-movflags', '+faststart', str(sortie)], check=True)
    (ICI / 'presentation.srt').write_text('\n'.join(srt), encoding='utf-8')
    print(f'{sortie} — {t:.0f} s')


if __name__ == '__main__':
    main()
