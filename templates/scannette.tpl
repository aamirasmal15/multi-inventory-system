# Fichiers de déploiement de la Scannette (nginx), un par section (### nom ###).
# create-asso.sh en extrait chaque section (voir extract_section) et substitue
# __NAME__ / __UPSTREAM__ / __SCAN_HOST__ avant d'écrire le fichier final.
#
# - dockerfile      -> Dockerfile
# - nginx-conf      -> default.conf
# - docker-compose  -> docker-compose.yml

### dockerfile ###
FROM nginx:1.27-alpine
COPY default.conf /etc/nginx/conf.d/default.conf
COPY html/        /usr/share/nginx/html/
EXPOSE 80

### nginx-conf ###
server {
    listen 80;
    server_name _;
    resolver 127.0.0.11 valid=30s ipv6=off;

    set $inv_upstream "__UPSTREAM__";
    set $inv_host     "__SCAN_HOST__";

    client_max_body_size 25m;

    # Page 404 au thème Scannette (scannette-src/404.html, copiée dans html/) :
    # servie pour tout chemin inconnu du bloc racine (try_files =404 ci-dessous).
    error_page 404 /404.html;

    # En-têtes communs pour tout ce qui part vers InvenTree (hérités par les location proxy).
    proxy_http_version 1.1;
    proxy_set_header Host              $inv_host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-Host  $inv_host;
    proxy_set_header X-Forwarded-For   $remote_addr;
    proxy_set_header X-Real-IP         $remote_addr;

    # --- App Scannette servie UNIQUEMENT à la racine (index.html + css/ + js/) ---
    # try_files sert les vrais fichiers (css/styles.css, js/core/api.js, ...) et
    # index.html pour "/". L'appli tourne toujours à la racine (boot.js remet
    # l'URL à "/", retour SSO = /?sso=1) : aucune route profonde à servir, donc
    # tout chemin inconnu (/web/login, ...) renvoie 404 au lieu du shell.
    location / {
        root /usr/share/nginx/html;
        try_files $uri $uri/ =404;
        add_header Cache-Control "no-cache";
        # durcissement : pas d'iframe (clickjacking sur les boutons de stock),
        # pas de sniffing MIME, pas d'URL interne dans le Referer sortant
        add_header X-Frame-Options "DENY" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "same-origin" always;
    }
    # Décodeur WebAssembly servi avec le bon type MIME
    location = /zxing_reader.wasm {
        default_type application/wasm;
        alias /usr/share/nginx/html/zxing_reader.wasm;
        add_header X-Content-Type-Options "nosniff" always;
    }

    # Vérification d'adresse e-mail au thème Scannette (scannette-src/verify-email.html).
    # Cible des liens de confirmation envoyés DEPUIS la Scannette : allauth construit
    # ces liens sur l'hôte de la requête (Host = $inv_host ci-dessus), donc en
    # /web/verify-email/<clé> sur CE vhost. La page lit la clé dans l'URL et la
    # valide elle-même via /api/auth/v1/ (proxifié same-origin plus bas) : verdict
    # clair à l'écran, sans détour par l'interface InvenTree.
    location /web/verify-email/ {
        root /usr/share/nginx/html;
        try_files /verify-email.html =404;
        add_header Cache-Control "no-cache";
        add_header X-Frame-Options "DENY" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "same-origin" always;
    }

    # --- InvenTree, proxifié en same-origin (pas de CORS, session partagée avec l'app) ---
    #   /api/      : API REST + endpoints headless allauth (/api/auth/v1/...)
    #   /accounts/ : callback OIDC (allauth monte /accounts/<provider>/login/callback/ même en headless)
    #   /plugin/   : endpoints des plugins (UrlsMixin), ex. /plugin/prets/ pour les prêts
    #   /static/ /media/ : assets servis par le Caddy interne d'InvenTree
    location /api/      { proxy_pass $inv_upstream; }
    location /accounts/ { proxy_pass $inv_upstream; }
    location /plugin/   { proxy_pass $inv_upstream; }
    location /static/   { proxy_pass $inv_upstream; }

    # /media/ est protégé par le forward_auth du Caddy interne d'InvenTree, mais les
    # balises <img> n'envoient jamais de header Authorization : on le reconstruit ici
    # depuis le cookie de session Scannette (eir_token). Sans cookie (login SSO pur),
    # on n'envoie rien : le cookie de session Django, transmis tel quel, suffit.
    # NB : un proxy_set_header local coupe l'héritage de ceux du bloc server,
    # d'où leur redéclaration complète.
    location /media/ {
        set $media_auth "";
        if ($cookie_eir_token) {
            set $media_auth "Token $cookie_eir_token";
        }
        proxy_set_header Host              $inv_host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host  $inv_host;
        proxy_set_header X-Forwarded-For   $remote_addr;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header Authorization     $media_auth;
        proxy_pass $inv_upstream;
    }
}

### docker-compose ###
name: __NAME__-scan
services:
  scannette:
    build: .
    container_name: __NAME__-scan
    restart: unless-stopped
    networks:
      - inventree-front

networks:
  inventree-front:
    external: true
