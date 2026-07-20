#!/usr/bin/env python3
"""
lib/finalize.py : finalisation d'une instance InvenTree via son API REST.

Se connecte avec le compte admin (créé par create-asso.sh), puis :
  1. applique les réglages globaux listés dans inventree-settings.conf
  2. crée le groupe membres_<nom> avec les rôles admin / part / part_category /
     stock / stock_location en view+add+change+delete
     (le rôle 'admin' reste DORMANT : côté InvenTree toutes les surfaces
     sensibles (users, groupes, plugins, rapports) exigent EN PLUS le drapeau
     is_staff sur le compte, que les membres n'ont pas. Promouvoir un
     gestionnaire = cocher « Administrator » (is_staff) sur son compte, rien de
     plus : le rôle admin déjà présent s'active alors. Voir StaffRolePermission /
     IsStaffOrReadOnlyScope / IsAdminOrAdminScope dans InvenTree/permissions.py.)
  3. désactive le Spotlight pour le compte admin (préférence par utilisateur)
  4. fixe le format de date jour-mois-année (DD-MM-YYYY), format de TOUTE
     l'instance : c'est le plugin Prêts qui en fait le défaut de chaque compte
     (apps.py). Ce PATCH ne fait que l'appliquer AUSSI au compte admin, en
     filet de sécurité (préférence par utilisateur, sans défaut global côté
     InvenTree ; couvre le cas où le plugin serait désactivé)

Zéro dépendance (stdlib uniquement). Zéro exception non gérée : chaque étape
affiche OK ou un warning et on continue. Code retour toujours 0.

Usage :
  finalize.py --url https://inventaire-bde.eirspace.fr \
              --user admin_bde --password '...' \
              --name bde --settings-file /chemin/inventree-settings.conf
"""

import argparse
import base64
import json
import ssl
import sys
import time
import urllib.error
import urllib.request

OK = ">> "
KO = "!! "


def build_opener():
    ctx = ssl.create_default_context()
    return urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx))


class Api:
    """Mini client API InvenTree (token obtenu via basic auth)."""

    def __init__(self, base_url, user, password):
        self.base = base_url.rstrip("/")
        self.user = user
        self.password = password
        self.token = None
        self.opener = build_opener()

    def _request(self, method, path, payload=None, basic=False):
        url = self.base + path
        headers = {"Accept": "application/json"}
        if basic:
            cred = base64.b64encode(f"{self.user}:{self.password}".encode()).decode()
            headers["Authorization"] = f"Basic {cred}"
        elif self.token:
            headers["Authorization"] = f"Token {self.token}"
        data = None
        if payload is not None:
            data = json.dumps(payload).encode()
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        with self.opener.open(req, timeout=15) as resp:
            body = resp.read().decode() or "null"
            return resp.status, json.loads(body)

    def call(self, method, path, payload=None, basic=False):
        """Comme _request mais ne lève jamais : retourne (status|None, data|str)."""
        try:
            return self._request(method, path, payload, basic)
        except urllib.error.HTTPError as e:
            try:
                detail = e.read().decode()[:200]
            except Exception:
                detail = str(e)
            return e.code, detail
        except Exception as e:  # réseau, TLS, JSON...
            return None, str(e)

    def wait_ready(self, tries=12, delay=5):
        """Attend que l'API réponde (serveur en cours de démarrage)."""
        for i in range(tries):
            status, _ = self.call("GET", "/api/")
            if status and status < 500:
                return True
            if i < tries - 1:
                time.sleep(delay)
        return False

    def login(self):
        status, data = self.call("GET", "/api/user/token/", basic=True)
        if status == 200 and isinstance(data, dict) and data.get("token"):
            self.token = data["token"]
            return True
        print(f"{KO}Connexion API impossible (HTTP {status}) : {data}")
        return False


def parse_settings_file(path, name):
    """Lit inventree-settings.conf -> liste de (clé, valeur), {NAME} remplacé."""
    pairs = []
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split(None, 1)
                if len(parts) != 2:
                    print(f"{KO}Ligne ignorée dans {path} : {line!r}")
                    continue
                key, val = parts
                pairs.append((key, val.replace("{NAME}", name)))
    except OSError as e:
        print(f"{KO}inventree-settings.conf illisible ({e}) : réglages sautés.")
    return pairs


def apply_settings(api, pairs):
    fails = []
    for key, val in pairs:
        status, data = api.call("PATCH", f"/api/settings/global/{key}/", {"value": val})
        if status != 200:
            fails.append(f"{key} (HTTP {status})")
    if fails:
        print(f"{KO}Réglages en échec (clé renommée sur cette version ?) : {', '.join(fails)}")
        print(f"{KO}  -> à poser à la main dans Admin Center > System Settings.")
    if len(fails) < len(pairs):
        print(f"{OK}{len(pairs) - len(fails)}/{len(pairs)} réglages appliqués (modifiables dans l'UI).")


# 'admin' est volontairement inclus mais DORMANT : sans is_staff sur le compte,
# InvenTree le neutralise partout (cf. docstring en tête). Un seul groupe suffit
# ainsi : promouvoir = cocher « Administrator » (is_staff), le rôle est déjà là.
ROLES = ("admin", "part", "part_category", "stock", "stock_location")
PERMS = ("view", "add", "change", "delete")


def seed_group(api, name):
    group = f"membres_{name}"

    # 1) le groupe existe-t-il déjà ?
    status, data = api.call("GET", f"/api/user/group/?name={group}")
    pk = None
    if status == 200 and isinstance(data, list) and data:
        pk = data[0].get("pk")
    elif status == 200 and isinstance(data, dict):  # réponse paginée
        results = data.get("results") or []
        if results:
            pk = results[0].get("pk")

    # 2) sinon on le crée
    if pk is None:
        status, data = api.call("POST", "/api/user/group/", {"name": group})
        if status in (200, 201) and isinstance(data, dict):
            pk = data.get("pk")
        else:
            print(f"{KO}Groupe '{group}' non créé (HTTP {status}) : {data}")
            print(f"{KO}  -> à créer à la main dans Admin Center > Groups.")
            return

    # 3) récupérer le détail avec les rôles
    status, detail = api.call("GET", f"/api/user/group/{pk}/?role_detail=true")
    if status != 200 or not isinstance(detail, dict):
        status, detail = api.call("GET", f"/api/user/group/{pk}/")
    roles = detail.get("roles") if isinstance(detail, dict) else None

    if not isinstance(roles, list) or not roles:
        print(f"{OK}Groupe '{group}' créé, mais rôles non exposés par l'API sur cette version.")
        print(f"{KO}  -> coche les rôles à la main : Admin Center > Groups > {group}")
        print(f"{KO}     (admin, part, part categories, stock items, stock locations : view/add/change/delete)")
        return

    # 4) mettre à jour les rôles voulus. Deux formats possibles selon la version :
    #    a) chaque rôle a un pk -> PATCH /api/user/ruleset/<pk>/
    #    b) sinon -> PATCH du groupe avec la liste 'roles' modifiée
    wanted = {r: True for r in ROLES}
    patched_via_ruleset = 0
    for role in roles:
        rname = role.get("name") or role.get("role")
        if rname not in wanted:
            continue
        rpk = role.get("pk")
        body = {f"can_{p}": True for p in PERMS}
        if rpk is not None:
            status, _ = api.call("PATCH", f"/api/user/ruleset/{rpk}/", body)
            if status == 200:
                patched_via_ruleset += 1
                continue
        # fallback : modifier l'objet dans la liste puis PATCH le groupe
        role.update(body)
        perms = role.get("permissions")
        if isinstance(perms, list):
            role["permissions"] = list(set(perms) | set(PERMS))

    if patched_via_ruleset == len(ROLES):
        print(f"{OK}Groupe '{group}' prêt ({len(ROLES)} rôles en view/add/change/delete).")
        return

    status, data = api.call("PATCH", f"/api/user/group/{pk}/", {"roles": roles})
    if status == 200:
        print(f"{OK}Groupe '{group}' prêt ({len(ROLES)} rôles en view/add/change/delete).")
    else:
        print(f"{OK}Groupe '{group}' créé, mais permissions non posées via l'API (HTTP {status}).")
        print(f"{KO}  -> coche les rôles à la main : Admin Center > Groups > {group}")


def disable_spotlight(api):
    status, data = api.call("GET", "/api/settings/user/")
    items = data if isinstance(data, list) else (data.get("results") if isinstance(data, dict) else None)
    if status != 200 or not isinstance(items, list):
        print(f"{KO}Spotlight : liste des réglages utilisateur indisponible (HTTP {status}).")
        return
    keys = [s.get("key") for s in items if "SPOTLIGHT" in str(s.get("key", "")).upper()]
    if not keys:
        print(f"{KO}Spotlight : pas de réglage correspondant sur cette version, laissé tel quel.")
        return
    fails = []
    for key in keys:
        status, _ = api.call("PATCH", f"/api/settings/user/{key}/", {"value": "False"})
        if status != 200:
            fails.append(f"{key} (HTTP {status})")
    if fails:
        print(f"{KO}Spotlight : échec sur {', '.join(fails)}.")
    else:
        print(f"{OK}Spotlight désactivé pour le compte admin (préférence PAR utilisateur :")
        print(f"{OK}  les futurs comptes SSO arriveront avec le défaut InvenTree).")


def set_date_format(api):
    """Format de date jour-mois-année (DD-MM-YYYY) : le format de TOUTE l'instance.

    DATE_DISPLAY_FORMAT est une préférence PAR utilisateur sans défaut
    global dans InvenTree. Depuis le plugin Prêts v0.31.0, apps.py patche
    ce défaut en DD-MM-YYYY pour tous les comptes sans choix explicite : le
    format se propage donc à tout le monde, pas seulement à l'admin. Ce PATCH
    explicite sur le compte admin reste en ceinture-bretelles (il couvre aussi
    une instance où le plugin serait désactivé).
    """
    status, _ = api.call(
        "PATCH", "/api/settings/user/DATE_DISPLAY_FORMAT/", {"value": "DD-MM-YYYY"}
    )
    if status == 200:
        print(f"{OK}Format de date DD-MM-YYYY confirmé sur le compte admin "
              f"(défaut de toute l'instance, posé par le plugin Prêts).")
    else:
        print(f"{KO}Format de date non posé sur le compte admin (HTTP {status}) ; "
              f"le défaut d'instance DD-MM-YYYY du plugin Prêts s'applique quand même.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--user", required=True)
    ap.add_argument("--password", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--settings-file", required=True)
    args = ap.parse_args()

    api = Api(args.url, args.user, args.password)

    if not api.wait_ready():
        print(f"{KO}L'API {args.url} ne répond pas, finalisation sautée (FORCE_SETTINGS=1 pour retenter).")
        return 0
    if not api.login():
        print(f"{KO}  -> vérifie INVENTREE_ADMIN_USER / INVENTREE_ADMIN_PASSWORD dans le .env de l'asso.")
        return 0

    pairs = parse_settings_file(args.settings_file, args.name)
    if pairs:
        apply_settings(api, pairs)
    seed_group(api, args.name)
    disable_spotlight(api)
    set_date_format(api)
    return 0


if __name__ == "__main__":
    sys.exit(main())
