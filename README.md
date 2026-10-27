# Bike3D 🚴

Petit jeu de vélo en 3D, style cartoon avec cel shading, qui tourne entièrement dans le navigateur (HTML, CSS, JavaScript et [three.js](https://threejs.org)).

On importe un tracé **GPX** : une route en 3D est construite à partir du tracé. Ensuite, chaque clic sur **« Modéliser en 3D »** génère un nouveau paysage aléatoire autour de cette route : relief, falaises dans les cols, forêts, prés, champs, rivières avec leurs ponts, lacs, vaches, spectateurs… On recommence jusqu'à trouver un paysage qui plaît, on le **valide**, puis on roule dessus.

## Lancer le jeu

Aucune installation ni compilation : three.js est fourni dans `vendor/`.

- **Le plus simple** : double-cliquer sur `index.html`.
- **Ou** servir le dossier avec un petit serveur web, par exemple :
  ```bash
  python3 -m http.server 8000
  # puis ouvrir http://localhost:8000
  ```

Il faut un navigateur récent avec WebGL 2 (Chrome, Edge, Firefox ou Safari récents).

## Déroulement

1. **Importer un GPX** (clic ou glisser-déposer), ou choisir un parcours de démo. Les fichiers `samples/*.gpx` permettent de tester l'import.
2. Consulter le profil du parcours (distance, D+, montées détectées et classées), puis choisir le maillot et la qualité graphique.
3. **Modéliser en 3D** : un paysage aléatoire est généré. Un survol automatique le présente : on peut tourner autour à la souris, zoomer à la molette, et se déplacer le long du parcours avec le curseur.
4. Cliquer à nouveau sur **Modéliser en 3D** pour en obtenir un autre, autant de fois que voulu.
5. **Valider ce paysage** : 3, 2, 1… partez !

## Commandes

| Touche | Action |
| --- | --- |
| <kbd>↑</kbd> | accélérer (pédaler plus fort) |
| <kbd>↓</kbd> | ralentir / freiner |
| <kbd>←</kbd> <kbd>→</kbd> | se déplacer sur la largeur de la route |
| <kbd>C</kbd> | changer de caméra (poursuite, large, TV, vue cycliste, drone) |
| <kbd>T</kbd> | accélérer le temps (x1, x2, x4, x8) |
| <kbd>M</kbd> | couper / remettre le son |
| <kbd>Échap</kbd> ou <kbd>P</kbd> | pause |

Sur écran tactile, des boutons fléchés s'affichent.

Quand on relâche les flèches, le cycliste garde le même effort : la vitesse se maintient sur le plat, baisse en montée et augmente en descente. En montée raide il se met en danseuse, en descente rapide il prend la position aérodynamique.

## Sons

Tous les sons sont synthétisés dans le navigateur (Web Audio), sans fichier audio :

- le « woum » des roues carbone à chaque coup de pédale, le roulement des boyaux et le vrombissement des jantes à haute vitesse ;
- le cliquetis de la roue libre, le vent ;
- les meuglements des vaches quand on passe près d'un troupeau (avec une bulle « MEUH ! ») et leurs clarines ;
- les applaudissements, sifflets et la rumeur du public, plus forts là où il y a du monde, et l'ovation de l'arrivée.

## Ce que fait le générateur

- **Route** : le tracé GPX est projeté en mètres, rééchantillonné tous les ~5 m et lissé (bruit GPS, altitude). Si le GPX n'a pas d'altitudes, un relief doux est inventé.
- **Relief** : un versant est ajusté localement sur les altitudes de la route (les lacets s'inscrivent dans une pente), puis des montagnes et des collines sont ajoutées par bruit procédural, selon l'altitude et le dénivelé du parcours. Le terrain est aplani sous la route, avec des talus raides qui deviennent des falaises rocheuses dans les cols.
- **Eau** : rivières qui suivent les fonds de vallée (ponts automatiques aux croisements) et lacs placés à l'écart de la route.
- **Sol et végétation** : prés fleuris, parcelles de champs avec haies, forêts de feuillus ou de sapins selon l'altitude, alpages, neige sur les sommets, rochers, bottes de foin, troupeaux de vaches.
- **Villages** : la route traverse des villages aux noms farfelus (« Saint-Pédalin-la-Montée »…) avec panneaux d'entrée et de sortie, trottoirs, lampadaires et fanions. On y trouve des maisons à volets, une église et son clocher (horloge, vitraux, fontaine sur le parvis), une boulangerie (avec sa baguette géante), un café et sa terrasse, un tabac, une pharmacie, une mairie avec son drapeau et d'autres commerces. Le style dépend de la région : chalets en bois et toits d'ardoise en montagne, tuiles rouges et façades ocre dans le Sud, ardoise et façades claires ailleurs.
- **Public** : des supporters applaudissent, lèvent les bras ou font coucou au bord de la route. Ils sont regroupés dans les villages, les montées (parfois avec leur camping-car), aux sommets et à l'arrivée, et s'excitent quand le coureur passe devant eux.
- **Bord de route** : glissières au-dessus des ravins, parapets sur les ponts, bornes kilométriques, panneaux de col, arche du sommet, flamme rouge, arches de départ et d'arrivée, messages peints sur la route dans les montées.
- **Ambiances** : printemps, plein été, automne ou fin de journée, avec chacune ses couleurs et sa lumière.

Le terrain est découpé en tuiles chargées autour du cycliste, ce qui permet de rouler sur des parcours longs.

## Organisation du code

| Fichier | Rôle |
| --- | --- |
| `index.html`, `css/style.css` | interface (menus, HUD) |
| `js/gpx.js` | lecture / écriture GPX |
| `js/route.js` | tracé en mètres, lissage, index spatial, détection des montées |
| `js/landscape.js` | relief, rivières, lacs, occupation du sol |
| `js/tiles.js` | tuiles de terrain et végétation instanciée |
| `js/road.js` | chaussée, glissières, panneaux, arches, supporters et camping-cars |
| `js/village.js` | villages : maisons, église, commerces, trottoirs, fanions, habitants |
| `js/water.js`, `js/sky.js` | eau animée, ciel, nuages, montagnes lointaines |
| `js/cyclist.js` | modèle et animation du cycliste |
| `js/toon.js`, `js/props.js` | matériaux cartoon, contours, objets du décor |
| `js/hud.js`, `js/audio.js`, `js/confetti.js`, `js/game.js` | HUD, sons, confettis, boucle de jeu |
| `tools/make-samples.js` | régénère les GPX d'exemple (`node tools/make-samples.js`) |

## Licences

Code sous licence GPL v3 (voir `LICENSE`). three.js est distribué sous licence MIT (`vendor/three.LICENSE`).
