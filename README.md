# Bike3D 🚴

Petit jeu de vélo en 3D, style cartoon avec cel shading, qui tourne entièrement dans le navigateur (HTML, CSS, JavaScript et [three.js](https://threejs.org)).

On importe un tracé **GPX** : une route en 3D est construite à partir du tracé. Ensuite, chaque clic sur **« Modéliser en 3D »** génère un nouveau paysage aléatoire autour de cette route : relief, falaises dans les cols, forêts, prés, champs, vignes, garrigue, rivières avec leurs ponts, lacs et mares, villages, animaux, spectateurs… On recommence jusqu'à trouver un paysage qui plaît, on le **valide**, puis on roule dessus, avec des sprints, des cols classés et un ravitaillement comme sur une vraie course.

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

## La course

Le parcours est jalonné d'arches, signalées sur le profil en bas de l'écran et par une pastille « prochain évènement » :

- **Sprints intermédiaires** (arche verte) : placés sur du plat, de préférence dans un village, avec barrières, public et panneaux 400 m / 200 m. Le temps des 400 derniers mètres est comparé à celui de sept rivaux virtuels (Kévin Watts, Lulu Lagrimpette…) : il faut appuyer sur ↑ avant la ligne pour gagner. Points : 20, 17, 15…
- **Grand Prix de la Montagne** : arche à pois au sommet de chaque montée classée (HC, 1re à 4e catégorie) et, pour les grands cols, arche « GPM » au pied qui lance le chrono. Au sommet : classement face aux rivaux, temps de montée, VAM et points du maillot à pois.
- **Zone de ravitaillement** (arche orange) : des soigneurs tendent des musettes au bord de la route, devant les voitures d'équipe et les tables de bidons. En serrant du bon côté, on attrape une musette au passage : coup de boost de +15 % de puissance pendant 45 s. Panneau « Fin de zone » à la sortie.

Les points sprint, les points montagne et le nombre de musettes s'affichent pendant la course et sur l'écran d'arrivée.

## Sons

Tous les sons sont synthétisés dans le navigateur (Web Audio), sans fichier audio :

- le « woum » des roues carbone à chaque coup de pédale, le roulement des boyaux et le vrombissement des jantes à haute vitesse ;
- le cliquetis de la roue libre, le vent ;
- les meuglements des vaches quand on passe près d'un troupeau (avec une bulle « MEUH ! ») et leurs clarines ;
- les applaudissements, sifflets et la rumeur du public, plus forts là où il y a du monde, et l'ovation de l'arrivée ;
- les cris des animaux proches : hennissements, bêlements, sifflements d'alerte des marmottes, coin-coin des canards, cri de l'aigle, croassements, cacardements des oies, mouettes, envol des pigeons ;
- l'ambiance du milieu traversé : chants d'oiseaux dans les prés et les bois, grenouilles près des mares, cigales dans la garrigue et la campagne du Sud en été ;
- les signaux de course : coup de sifflet au début du sprint et au pied des cols, fanfare quand on gagne, bruit de la musette attrapée.

## Ce que fait le générateur

- **Route** : le tracé GPX est projeté en mètres, rééchantillonné tous les ~5 m et lissé (bruit GPS, altitude). Si le GPX n'a pas d'altitudes, un relief doux est inventé.
- **Relief** : un versant est ajusté localement sur les altitudes de la route (les lacets s'inscrivent dans une pente), puis des montagnes et des collines sont ajoutées par bruit procédural, selon l'altitude et le dénivelé du parcours. Le terrain est aplani sous la route, avec des talus raides qui deviennent des falaises rocheuses dans les cols.
- **Eau** : rivières qui suivent les fonds de vallée (ponts automatiques aux croisements), lacs placés à l'écart de la route et petites mares bordées de roseaux, avec nénuphars et canards.
- **Sol et végétation** : prés fleuris, parcelles de champs avec haies (labours, lavande, tournesols, citrouilles), forêts de feuillus ou de sapins selon l'altitude, alpages, neige sur les sommets, rochers, bottes de foin.
- **Biomes** : selon la région et le tirage, le paysage peut contenir des vignes en rangs, des vergers, de la garrigue (pins parasols, oliviers, cyprès), des landes de bruyère, des zones humides (saules, roseaux, hérons) et des bois de bouleaux.
- **Faune** : vaches, chevaux, moutons, cerfs dans les clairières, bouquetins et marmottes en montagne, hérons au bord de l'eau. Dans le ciel : aigles qui planent au-dessus des cols, nuées de corbeaux sur les champs, hirondelles qui virevoltent autour du coureur, mouettes au-dessus des lacs, vols d'oies en V. Les pigeons picorent sur les trottoirs des villages et s'envolent au passage du coureur.
- **Villages** : la route traverse des villages aux noms farfelus (« Saint-Pédalin-la-Montée »…) avec panneaux d'entrée et de sortie, trottoirs, lampadaires et fanions. On y trouve des maisons à volets, une église et son clocher (horloge, vitraux, fontaine sur le parvis), une boulangerie (avec sa baguette géante), un café et sa terrasse, un tabac, une pharmacie, une mairie avec son drapeau et d'autres commerces. Le style dépend de la région : chalets en bois et toits d'ardoise en montagne, tuiles rouges et façades ocre dans le Sud, ardoise et façades claires ailleurs.
- **Public** : des supporters applaudissent, lèvent les bras ou font coucou au bord de la route. Ils sont regroupés dans les villages, les montées (parfois avec leur camping-car), aux sommets et à l'arrivée, et s'excitent quand le coureur passe devant eux.
- **Bord de route** : glissières au-dessus des ravins, parapets sur les ponts, bornes kilométriques, panneaux de col, flamme rouge, arches de départ et d'arrivée, arches de sprint, du GPM et du ravitaillement, messages peints sur la route dans les montées.
- **Ambiances** : printemps, plein été, automne ou fin de journée, avec chacune ses couleurs et sa lumière.

Le terrain est découpé en tuiles chargées autour du cycliste, ce qui permet de rouler sur des parcours longs.

## Organisation du code

| Fichier | Rôle |
| --- | --- |
| `index.html`, `css/style.css` | interface (menus, HUD) |
| `js/gpx.js` | lecture / écriture GPX |
| `js/route.js` | tracé en mètres, lissage, index spatial, détection des montées |
| `js/landscape.js` | relief, rivières, lacs et mares, biomes, occupation du sol |
| `js/tiles.js` | tuiles de terrain, végétation et animaux instanciés |
| `js/road.js` | chaussée, glissières, panneaux, arches, supporters et camping-cars |
| `js/race.js` | sprints, GPM, ravitaillement : placement, arches, soigneurs, rivaux virtuels et points |
| `js/village.js` | villages : maisons, église, commerces, trottoirs, fanions, habitants |
| `js/fauna.js` | oiseaux en vol et canards animés |
| `js/water.js`, `js/sky.js` | eau animée, ciel, nuages, montagnes lointaines |
| `js/cyclist.js` | modèle et animation du cycliste |
| `js/toon.js`, `js/props.js` | matériaux cartoon, contours, objets du décor |
| `js/hud.js`, `js/audio.js`, `js/confetti.js`, `js/game.js` | HUD, sons, confettis, boucle de jeu |
| `tools/make-samples.js` | régénère les GPX d'exemple (`node tools/make-samples.js`) |

## Licences

Code sous licence GPL v3 (voir `LICENSE`). three.js est distribué sous licence MIT (`vendor/three.LICENSE`).
