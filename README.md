# Bike3D 🚴

Petit jeu de vélo en 3D, style cartoon avec cel shading, qui tourne entièrement dans le navigateur (HTML, CSS, JavaScript et [three.js](https://threejs.org)).

On importe un tracé **GPX** : une route en 3D est construite à partir du tracé. Ensuite, chaque clic sur **« Modéliser en 3D »** génère un nouveau paysage aléatoire autour de cette route : relief, falaises dans les cols, forêts, prés, champs, vignes, garrigue, rivières avec leurs ponts, lacs et mares, villages, animaux, spectateurs… On recommence jusqu'à trouver un paysage qui plaît, on le **valide**, puis on roule dessus, seul ou au milieu d'un peloton, avec des sprints, des cols classés, un ravitaillement et toute la caravane, comme sur une vraie course.

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
2. Consulter le profil du parcours (distance, D+, montées détectées et classées), puis choisir le maillot, le nombre d'autres coureurs (seul, 5, 10, 20 ou 40) et la qualité graphique.
3. **Modéliser en 3D** : un paysage aléatoire est généré. Un survol automatique le présente : on peut tourner autour à la souris, zoomer à la molette, et se déplacer le long du parcours avec le curseur.
4. Cliquer à nouveau sur **Modéliser en 3D** pour en obtenir un autre, autant de fois que voulu.
5. **Valider ce paysage** : 3, 2, 1… partez !

## Commandes

| Commande | Action |
| --- | --- |
| jauge de puissance (à gauche) | la saisir et la faire glisser à la souris ou au doigt pour régler les watts |
| molette | monter / descendre la jauge |
| <kbd>Z</kbd> / <kbd>S</kbd> (<kbd>W</kbd> / <kbd>S</kbd> en QWERTY) | monter / descendre la jauge (on peut les maintenir) |
| <kbd>1</kbd> … <kbd>9</kbd>, <kbd>0</kbd> | jauge directement à 10 %… 90 %, 100 % |
| <kbd>Espace</kbd> | freiner |
| <kbd>←</kbd> <kbd>→</kbd> (ou <kbd>Q</kbd> <kbd>D</kbd>) | se déplacer sur la largeur de la route |
| <kbd>C</kbd> | changer de caméra (poursuite, large, TV, vue cycliste, drone) |
| <kbd>T</kbd> | accélérer le temps (x1, x2, x4, x8) |
| <kbd>M</kbd> | couper / remettre le son |
| <kbd>Échap</kbd> ou <kbd>P</kbd> | pause |

Sur écran tactile, la jauge se règle au doigt, avec des boutons ◀ ▶ pour se déplacer et 🛑 pour freiner.

### La jauge de puissance et la réserve

On ne pédale plus « plus fort » ou « moins fort » avec les flèches : on règle sur la jauge la **puissance** que développe le coureur (de 0 à 720 W). La vitesse en découle : elle se maintient sur le plat, baisse en montée, augmente en descente, et elle est plus élevée dans l'aspiration d'un autre coureur. La jauge affiche la consigne, la puissance réelle, les watts par kilo et les zones d'effort : endurance, tempo, seuil, rouge.

Sous la jauge, la **réserve d'énergie** se vide quand on roule au-dessus du **seuil** (330 W, la ligne pointillée) et se recharge en dessous. Si elle tombe à zéro, c'est le **coup de bambou** : impossible de dépasser le seuil tant qu'on n'a pas récupéré. Il faut donc doser ses efforts, et se cacher dans les roues pour économiser.

En montée raide le coureur se met en danseuse, en descente rapide (jauge à zéro) il prend la position aérodynamique.

## Le peloton

On peut courir seul ou avec 5 à 40 autres coureurs aux noms farfelus (Kévin Watts, Lulu Lagrimpette…), répartis en équipes. Chacun a son profil (rouleur, grimpeur, sprinteur), son poids, sa puissance critique et sa réserve, et roule avec la même physique que le joueur.

- **Aspiration** : derrière un coureur, la résistance de l'air diminue (jusqu'à environ 40 % dans la roue, davantage au cœur du peloton). Le sillage du coureur qui précède est dessiné : des filets d'air et des chevrons sur la route, **gris clair** quand on est à côté, **verts** quand on est dans l'aspiration. Une pastille « 🌀 Aspiration −35 % » l'indique aussi près de la jauge, et on entend moins le vent.
- **Relais** : le coureur de tête mène un moment puis se décale et se laisse glisser en queue de groupe. Si tu mènes trop longtemps, un coureur vient prendre le relais. Quand c'est ton tour, un message te le signale.
- **Course** : les groupes se forment et se cassent (bordures, montées, coureurs lâchés qui recollent), il y a des attaques, des contre-attaques, des sprints groupés, et des crevaisons dépannées par la voiture d'assistance.
- Le HUD donne ta place, la taille de ton groupe et l'écart avec la tête. À l'arrivée, le classement de l'étape s'affiche, avec les écarts.

Quand il y a d'autres coureurs, les sprints et les sommets sont disputés pour de vrai : ce sont eux qu'il faut battre sur la ligne. En solo, on est comparé à des rivaux virtuels.

## La caravane

- **Motos de la télévision** : une devant la tête de course, une avec le groupe du joueur, avec un caméraman assis à l'envers, caméra à l'épaule.
- **Voitures suiveuses** : la voiture d'assistance jaune et deux voitures d'équipe, avec des vélos de rechange sur le toit. Elles suivent le groupe du joueur. Quand un coureur crève, la voiture d'assistance s'arrête derrière lui et un mécanicien change la roue.
- **Voiture-balai** : derrière le dernier coureur de la course, avec son balai sur le toit et sa plaque « FIN DE COURSE ».
- **Hélicoptère** : il tourne au-dessus de la tête de course.

## Les cols hors catégorie

Dans les montées classées HC, une foule dense envahit la route sur les derniers kilomètres. Les spectateurs ne laissent qu'un étroit couloir et s'écartent au dernier moment devant les coureurs et les véhicules, puis se referment derrière eux. Certains agitent des drapeaux, d'autres allument des fumigènes colorés. Le parcours de démo **« Col hors catégorie »** (onze lacets à 9 %) permet de le voir tout de suite.

## La course

Le parcours est jalonné d'arches, signalées sur le profil en bas de l'écran et par une pastille « prochain évènement » :

- **Sprints intermédiaires** (arche verte) : placés sur du plat, de préférence dans un village, avec barrières, public et panneaux 400 m / 200 m. Avec d'autres coureurs, c'est l'ordre de passage sur la ligne qui compte. En solo, le temps des 400 derniers mètres est comparé à celui de sept rivaux virtuels : il faut lancer son effort avant la ligne pour gagner. Points : 20, 17, 15…
- **Grand Prix de la Montagne** : arche à pois au sommet de chaque montée classée (HC, 1re à 4e catégorie) et, pour les grands cols, arche « GPM » au pied qui lance le chrono. Au sommet : classement, temps de montée, VAM et points du maillot à pois.
- **Zone de ravitaillement** (arche orange) : des soigneurs tendent des musettes au bord de la route, devant les voitures d'équipe et les tables de bidons. En serrant du bon côté, on attrape une musette au passage : elle recharge la moitié de la réserve d'énergie. Panneau « Fin de zone » à la sortie.

Les points sprint, les points montagne et le nombre de musettes s'affichent pendant la course et sur l'écran d'arrivée.

## Sons

Tous les sons sont synthétisés dans le navigateur (Web Audio), sans fichier audio :

- le « woum » des roues carbone à chaque coup de pédale, le roulement des boyaux et le vrombissement des jantes à haute vitesse ;
- le cliquetis de la roue libre, le vent (plus discret dans l'aspiration), le roulement et la roue libre des coureurs autour de soi ;
- le moteur des motos et le battement des pales de l'hélicoptère ;
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
| `js/peloton.js` | autres coureurs : physique, aspiration, groupes, relais, attaques, rendu instancié, sillage |
| `js/convoy.js` | caravane : motos TV, voitures suiveuses, voiture-balai, hélicoptère, dépannage |
| `js/hccrowd.js` | foule des cols hors catégorie, drapeaux et fumigènes |
| `js/village.js` | villages : maisons, église, commerces, trottoirs, fanions, habitants |
| `js/fauna.js` | oiseaux en vol et canards animés |
| `js/water.js`, `js/sky.js` | eau animée, ciel, nuages, montagnes lointaines |
| `js/cyclist.js` | modèle et animation du cycliste |
| `js/toon.js`, `js/props.js` | matériaux cartoon, contours, objets du décor |
| `js/hud.js`, `js/audio.js`, `js/confetti.js`, `js/game.js` | HUD, sons, confettis, boucle de jeu |
| `tools/make-samples.js` | régénère les GPX d'exemple (`node tools/make-samples.js`) |

## Licences

Code sous licence GPL v3 (voir `LICENSE`). three.js est distribué sous licence MIT (`vendor/three.LICENSE`).
