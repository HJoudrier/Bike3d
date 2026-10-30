#!/usr/bin/env python3
"""Sert le site (PaceYourRide et son univers 3D, Bike3D) sur le réseau local, pour jouer depuis un casque de réalité virtuelle
(Meta Quest…) : tout le site, depuis sa racine, pour que l'écran de course en 3D (Jeu3D/) trouve aussi les scripts de PaceYourRide.

La réalité virtuelle dans le navigateur (WebXR) n'est permise que sur une page sécurisée :
« localhost » ou une adresse en https://. Avec --https, un certificat auto-signé est créé
(il faut openssl) et le navigateur du casque demandera de l'accepter une fois.

    python3 Jeu3D/univers/tools/serve.py              # http://localhost:8000
    python3 Jeu3D/univers/tools/serve.py --https      # https://<adresse du PC>:8443
"""
import argparse
import functools
import http.server
import os
import socket
import ssl
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
UNIVERSE = os.path.dirname(HERE)                                       # Jeu3D/univers : Bike3D
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(UNIVERSE)))     # racine du site (PaceYourRide)
GAME = 'Jeu3D/univers/index.html'                                     # Bike3D seul (menu, GPX, réalité virtuelle)


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('10.255.255.255', 1))  # aucun paquet envoyé : sert juste à choisir l'interface
        return s.getsockname()[0]
    except OSError:
        return '127.0.0.1'
    finally:
        s.close()


def certificate(ip):
    """Crée (une fois) un certificat auto-signé valable pour localhost et l'adresse du PC."""
    folder = os.path.join(UNIVERSE, '.cert')
    crt, key = os.path.join(folder, 'bike3d.crt'), os.path.join(folder, 'bike3d.key')
    if os.path.exists(crt) and os.path.exists(key):
        return crt, key
    os.makedirs(folder, exist_ok=True)
    try:
        subprocess.run([
            'openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '825',
            '-keyout', key, '-out', crt, '-subj', '/CN=Bike3D',
            '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:' + ip
        ], check=True, capture_output=True)
    except (OSError, subprocess.CalledProcessError) as err:
        sys.exit("Impossible de créer le certificat (openssl est-il installé ?) : %s" % err)
    return crt, key


def main():
    ap = argparse.ArgumentParser(description='Sert Bike3D sur le réseau local.')
    ap.add_argument('--https', action='store_true', help='HTTPS avec un certificat auto-signé (VR en Wi-Fi)')
    ap.add_argument('--port', type=int, help='port (8000 en HTTP, 8443 en HTTPS)')
    args = ap.parse_args()
    port = args.port or (8443 if args.https else 8000)
    ip = lan_ip()
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
    httpd = http.server.ThreadingHTTPServer(('0.0.0.0', port), handler)
    scheme = 'http'
    if args.https:
        crt, key = certificate(ip)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(crt, key)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
        scheme = 'https'
    print('Le site est servi (accueil de PaceYourRide ; Bike3D seul : /%s) :' % GAME)
    print('  sur ce PC          %s://localhost:%d/' % (scheme, port))
    print('  sur le réseau      %s://%s:%d/' % (scheme, ip, port))
    print('  Bike3D seul        %s://%s:%d/%s' % (scheme, ip, port, GAME))
    if not args.https:
        print('Casque branché en USB : « adb reverse tcp:%d tcp:%d » puis http://localhost:%d dans le navigateur du casque.' % (port, port, port))
    else:
        print('Dans le navigateur du casque, accepte le certificat (« Avancé » puis « Continuer »).')
    print('Ctrl+C pour arrêter.')
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
