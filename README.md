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

Pour jouer avec un casque de réalité virtuelle, voir [Réalité virtuelle](#réalité-virtuelle-meta-quest-et-autres-casques) : il faut alors servir le jeu avec `python3 tools/serve.py`.

## Avec PaceYourRide : la vue 3D d'une course simulée

Le dossier [`PaceYourRide/`](PaceYourRide/) contient l'application de stratégie et de course (parcours, cycliste, matériel, météo réelle, modèle physiologique, mode jeu, courses en direct). Son mode jeu peut afficher la course **dans le paysage de Bike3D** au lieu du fond de carte : c'est PaceYourRide qui simule, Bike3D qui montre.

1. Servir **la racine du dépôt** (les deux applications doivent être sur le même site) : `python3 -m http.server 8000`, puis ouvrir `http://localhost:8000/PaceYourRide/`.
2. Tracer ou importer un parcours, aller dans **Mode jeu**, cliquer sur **Démarrer**.
3. Sur l'écran de course, le bouton **3D** de la colonne remplace la carte par le paysage (le HUD de PaceYourRide reste par-dessus). 🎥 (ou un toucher sur la vue, ou la touche <kbd>C</kbd>) change de caméra, 🔇 / 🔊 coupe ou remet le son, ⧉ ouvre la vue dans **une autre fenêtre** avec son propre compteur (second écran, téléviseur devant le home-trainer).

Ce que la vue reçoit de PaceYourRide, à chaque image : la position de chaque coureur (le joueur, les coureurs virtuels, les fantômes, les autres joueurs d'une course en direct), sa position latérale dans le peloton en 2D, sa vitesse et sa puissance, l'abri (le sillage devient vert), et la météo à la position et à l'heure du joueur (heure locale, pluie, neige, orage, vent réel). Les sprints, les côtes classées et les zones de ravitaillement de la course y ont leurs arches. Les **portions de revêtement** de PaceYourRide se voient sur la route : enrobé neuf, asphalte dégradé (rustines, fissures, lignes effacées), pavés réguliers ou difficiles « façon Roubaix » (pierres irrégulières, herbe et boue entre les pavés), chemin blanc, gravier, chemin de terre (ornières, herbe au milieu), herbe et sable, route mouillée (flaques). Chaque portion a sa largeur : la plateforme garde 6 m et une chaussée plus étroite est bordée de bas-côtés herbeux (gravillonnés dans les villages) ; plus large que 6 m, elle est dessinée à 6 m ; sur un pont, le tablier garde toute sa largeur. Les secteurs pavés et les chemins de plus de 80 m ont leur panneau à l'entrée (« SECTEUR PAVÉ N°3 · 2,1 km · ★★★★★ », numérotés à rebours jusqu'à l'arrivée), leur annonce, et sur les pavés le vélo et la caméra tremblent. Les coureurs restent sur la largeur de la chaussée ; on ne peint pas d'encouragements sur les pavés ni sur un chemin étroit. Sur les **chemins blancs**, les roues soulèvent un **nuage de poussière** (`js/dust.js`) : des bouffées naissent au contact de la roue arrière, partent en arrière, montent jusqu'à hauteur des coureurs en gonflant, dérivent avec le vent et s'effacent en quelques secondes ; plus épais à grande vitesse, très clair et dense sur un chemin blanc, un peu moins sur le gravier meuble, ocre et plus léger sur la terre, à peine sur les pavés secs. Les voitures et les motos de la caravane en soulèvent de gros nuages. Rien sur une route mouillée ou enneigée ; la nuit, la poussière s'assombrit. On en soulève aussi en roulant sur le bas-côté en terre (dans le jeu Bike3D seul aussi). La graine du paysage est tirée du parcours : **tous les joueurs d'une course en direct roulent dans le même monde**. Les touches pressées dans la vue (puissance, tactiques, changement de rang…) pilotent le jeu comme d'habitude.

Les participants peuvent être des **avatars** (puissance réglée à la jauge, avec la physiologie de l'utilisateur), des cyclistes sur **home-trainer** (leurs watts réels, le home-trainer FTMS reçoit la pente, le vent et l'abri) ou des cyclistes **sur la vraie route** (position GPS) : voir le README de PaceYourRide, « Vue 3D et monde partagé ».

Techniquement, `index.html?pyr` ouvre Bike3D en vue pilotée (`js/bridge.js`) : il attend le parcours par `postMessage`, construit le paysage, puis place un peloton « marionnette » (même rendu que les coureurs de Bike3D) là où la simulation le met. Le protocole est décrit en tête de `js/bridge.js`. Ajouter `&hud=1` affiche le compteur de la vue.

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

## Météo, vent, neige, jour et nuit

Le ciel vit pendant la course, et se règle dans l'aperçu (carte « Ciel et météo ») ou dans le menu pause :

- **Heure** : un curseur règle l'heure de départ (🎲 : tirée au hasard pour chaque paysage). Le soleil suit sa course réelle selon la saison de l'ambiance : il se lève à l'est vers 6 h en été, plus tard en automne, monte haut à midi, se couche à l'ouest avec un ciel doré, puis vient la nuit, avec la lune et les étoiles. Le temps peut être **figé**, s'écouler **×30** (une minute de jeu = une demi-heure) ou **×300**, et il avance aussi avec l'accélération <kbd>T</kbd>.
- **Météo** : grand soleil, nuageux, pluie, orage ou neige, ou **variable** : le temps évolue alors tout seul au fil de la course. Le passage d'un temps à l'autre est progressif (environ une minute) : le ciel se couvre, la lumière baisse, la pluie s'intensifie, la route se mouille puis sèche lentement après l'averse.
  - **Nuages** : une couche nuageuse qui défile avec le vent, plus ou moins épaisse, et des cumulus cartoon. Ils deviennent gris sombre sous l'orage et dorés au coucher du soleil.
  - **Pluie** : des gouttes inclinées par le vent, une route plus sombre avec des flaques qui reflètent le ciel, une visibilité réduite. On roule un peu moins vite et on freine moins bien.
  - **Orage** : ciel très sombre, éclairs (flash et arc électrique), puis tonnerre avec un retard qui dépend de la distance (3 s par kilomètre).
  - **Neige** : des flocons qui tombent en tourbillonnant et dérivent avec le vent, un ciel gris clair, une visibilité réduite. Le manteau neigeux se forme en une minute environ : les prés, les toits, les arbres et les rochers blanchissent, des bourrelets de neige bordent la route. Après la chute, il fond lentement. Sur la neige, on roule moins vite, on freine moins bien, et le bas-côté devient très lent. En montagne, au-dessus de 1 800 m environ, la pluie se transforme en neige : on traverse la limite pluie-neige en montant un col.
- **Vent** : calme, brise, fort ou tempête (🎲 : au hasard), avec une direction et des rafales. Il entre dans la physique : de face il freine, de dos il pousse. À 300 W, sous un vent de 25 km/h, on roule à 27 km/h de face et à 50 km/h de dos. De côté, le sillage des coureurs est déporté sous le vent : il faut se décaler pour rester abrité, et le peloton se met **en bordure**, une file en diagonale, avec la tête du côté d'où vient le vent. Les arbres, les herbes et les fleurs se couchent dans le sens du vent. Le HUD indique l'heure et le vent, avec une flèche orientée par rapport au coureur (« 47 km/h · ¾ face, droite »).
- **Hiver** : une ambiance « Hiver enneigé » peut être tirée au sort. Le paysage est sous la neige, les feuillus sont dénudés, les lacs et les mares sont gelés, et les journées sont courtes (lever vers 8 h 30, coucher vers 17 h). La météo variable y apporte des chutes de neige au lieu de la pluie. Les vaches restent presque toutes à l'étable, les hirondelles sont parties, et on n'entend ni grenouilles ni cigales.
- **Nuit** : les fenêtres et les lampadaires des villages s'allument dès le crépuscule. Le vélo a un phare qui éclaire la route et un feu arrière, les autres coureurs et les véhicules de la caravane allument leurs feux, et l'hélicoptère sa balise clignotante.
- **Animaux de jour et de nuit** : le jour, on voit les vaches, chevaux, moutons, bouquetins, marmottes et hérons, et dans le ciel les aigles, corbeaux, hirondelles, mouettes, oies, pigeons et canards. Au crépuscule, ils rentrent ou se posent, et les animaux de la nuit sortent : sangliers dans les sous-bois et les champs, renards en lisière, hérissons dans les haies et les jardins. Les chevreuils sortent brouter à l'aube et au crépuscule, et restent la nuit. Les chauves-souris virevoltent autour du coureur, attirées par les insectes du phare, et des chouettes planent au-dessus des bois. Il n'y a donc pas de vache la nuit, et les meuglements et les clarines se taisent.
- **Sons** : la pluie et les gouttes sur le casque, le tonnerre, le vent (qui dépend du vent réel). La nuit, des grillons (sauf dans la neige), des chouettes, les grognements des sangliers, les glapissements du renard et l'aboiement du chevreuil. Les oiseaux se taisent sous la pluie et les cigales ne chantent qu'au soleil.

Des messages annoncent les changements : « 🌧️ La pluie arrive », « 🌇 Coucher de soleil », « 🌙 La nuit tombe »…

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

## Réalité virtuelle (Meta Quest et autres casques)

Le jeu a un mode immersif WebXR : on roule assis sur le vélo, au milieu du paysage et du peloton, en tournant la tête pour regarder autour de soi.

### Ouvrir le jeu dans le casque

Le navigateur n'autorise la réalité virtuelle que sur une page sécurisée (`https://` ou `localhost`) : il faut donc servir le dossier. Le script `tools/serve.py` (Python 3) s'en charge.

1. **Avec le câble USB** (casque en mode développeur) : sur le PC, lancer `python3 tools/serve.py` puis `adb reverse tcp:8000 tcp:8000`, et ouvrir `http://localhost:8000` dans le navigateur du Quest.
2. **En Wi-Fi** : lancer `python3 tools/serve.py --https` (il faut `openssl`). Ouvrir l'adresse affichée (`https://192.168.x.x:8443`) dans le navigateur du Quest, et accepter le certificat (« Avancé » puis « Continuer »).
3. **En ligne** : publier le dossier sur un hébergement en HTTPS (GitHub Pages, par exemple) et ouvrir l'adresse dans le casque.

Avec un casque relié au PC (Quest Link, Air Link…), on peut aussi utiliser Chrome ou Edge sur le PC, avec `python3 tools/serve.py` et `http://localhost:8000`.

Ensuite, on choisit un parcours, on modélise le paysage, puis on clique sur **« 🥽 Rouler en réalité virtuelle »**. Ce bouton n'apparaît que si un casque est disponible ; on le retrouve aussi dans le menu pause d'une course commencée à l'écran.

Sur un casque autonome, mieux vaut choisir la qualité « Rapide » et 10 à 20 coureurs. Et s'asseoir !

### Dans le casque

- **Vue cycliste** : on est sur le vélo et on voit ses bras, le guidon et le **compteur fixé sur la potence**. Il affiche la vitesse, la jauge de puissance (consigne, puissance réelle, seuil), la réserve, la pente, l'aspiration, la position, la distance et le chrono. L'horizon reste droit, sans roulis dans les virages.
- **Vue poursuite** : on se place derrière et au-dessus du coureur, avec le compteur qui flotte en bas du champ de vision.
- Les messages (sprints, attaques, relais…), le compte à rebours, la pause et l'arrivée s'affichent sur un panneau flottant.
- **Effet tunnel** : dans les virages serrés et à grande vitesse, la périphérie s'assombrit pour limiter le mal des transports. On peut le désactiver.
- **Vibrations des manettes** : roue de devant touchée, bas-côté, musette attrapée, ligne de sprint ou de sommet, coup de bambou.

| Manettes Touch | Action |
| --- | --- |
| stick gauche ← → | se déplacer sur la route |
| stick droit ↑ ↓ | régler la jauge de puissance |
| gâchettes (maintenues) | à fond, pour sprinter |
| grips | freiner |
| <kbd>A</kbd> | vue cycliste / vue poursuite |
| <kbd>B</kbd> | accélérer le temps |
| <kbd>X</kbd> | pause (<kbd>A</kbd> ou <kbd>X</kbd> pour reprendre, <kbd>B</kbd> pour quitter la réalité virtuelle) |
| <kbd>Y</kbd> | recentrer la vue |
| clic du stick droit | activer / désactiver l'effet tunnel |

À l'arrivée, <kbd>A</kbd> relance la course et <kbd>B</kbd> quitte la réalité virtuelle. Si on retire le casque ou qu'on ouvre le menu du Quest, la course se met en pause.

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
- **Faune** : vaches, chevaux, moutons, cerfs dans les clairières, bouquetins et marmottes en montagne, hérons au bord de l'eau. Dans le ciel : aigles qui planent au-dessus des cols, nuées de corbeaux sur les champs, hirondelles qui virevoltent autour du coureur, mouettes au-dessus des lacs, vols d'oies en V. Les pigeons picorent sur les trottoirs des villages et s'envolent au passage du coureur. La nuit, place aux sangliers, renards, hérissons, chevreuils, chauves-souris et chouettes.
- **Villages** : la route traverse des villages aux noms farfelus (« Saint-Pédalin-la-Montée »…) avec panneaux d'entrée et de sortie, trottoirs, lampadaires et fanions. On y trouve des maisons à volets, une église et son clocher (horloge, vitraux, fontaine sur le parvis), une boulangerie (avec sa baguette géante), un café et sa terrasse, un tabac, une pharmacie, une mairie avec son drapeau et d'autres commerces. Le style dépend de la région : chalets en bois et toits d'ardoise en montagne, tuiles rouges et façades ocre dans le Sud, ardoise et façades claires ailleurs.
- **Public** : des supporters applaudissent, lèvent les bras ou font coucou au bord de la route. Ils sont regroupés dans les villages, les montées (parfois avec leur camping-car), aux sommets et à l'arrivée, et s'excitent quand le coureur passe devant eux.
- **Bord de route** : glissières au-dessus des ravins, parapets sur les ponts, bornes kilométriques, panneaux de col, flamme rouge, arches de départ et d'arrivée, arches de sprint, du GPM et du ravitaillement, messages peints sur la route dans les montées.
- **Ambiances** : printemps, plein été, automne, fin de journée ou hiver enneigé, avec chacune ses couleurs. L'heure et la météo font ensuite varier la lumière (voir plus haut).

Le terrain est découpé en tuiles chargées autour du cycliste, ce qui permet de rouler sur des parcours longs.

## Organisation du code

| Fichier | Rôle |
| --- | --- |
| `index.html`, `css/style.css` | interface (menus, HUD) |
| `js/gpx.js` | lecture / écriture GPX |
| `js/route.js` | tracé en mètres, lissage, index spatial, détection des montées |
| `js/landscape.js` | relief, rivières, lacs et mares, biomes, occupation du sol |
| `js/tiles.js` | tuiles de terrain, végétation et animaux instanciés |
| `js/road.js` | chaussée (revêtements et largeur des portions de PaceYourRide, bas-côtés, panneaux de secteur), glissières, panneaux, arches, supporters et camping-cars |
| `js/race.js` | sprints, GPM, ravitaillement : placement, arches, soigneurs, rivaux virtuels et points |
| `js/peloton.js` | autres coureurs : physique, aspiration, groupes, relais, attaques, rendu instancié, sillage |
| `js/convoy.js` | caravane : motos TV, voitures suiveuses, voiture-balai, hélicoptère, dépannage |
| `js/hccrowd.js` | foule des cols hors catégorie, drapeaux et fumigènes |
| `js/dust.js` | nuages de poussière soulevés par les roues et les véhicules (chemins blancs, gravier, terre, pavés secs, bas-côté) |
| `js/village.js` | villages : maisons, église, commerces, trottoirs, fanions, habitants |
| `js/fauna.js` | oiseaux en vol et canards animés, chauves-souris et chouettes la nuit |
| `js/water.js`, `js/sky.js` | eau animée, ciel, nuages, montagnes lointaines |
| `js/atmosphere.js` | heure, soleil, lune et étoiles, météo et transitions, vent, pluie, neige et manteau neigeux, route mouillée, éclairs |
| `js/cyclist.js` | modèle et animation du cycliste |
| `js/toon.js`, `js/props.js` | matériaux cartoon, contours, objets du décor |
| `js/hud.js`, `js/audio.js`, `js/confetti.js`, `js/game.js` | HUD, sons, confettis, boucle de jeu |
| `js/vr.js` | réalité virtuelle : nacelle de caméra, compteur sur la potence, panneaux, manettes, effet tunnel |
| `js/bridge.js` | vue pilotée par PaceYourRide (`index.html?pyr`) : parcours et positions reçus par `postMessage`, peloton « marionnette », ciel et météo imposés, compteur de la fenêtre à part, touches renvoyées au jeu |
| `tools/serve.py` | serveur local HTTP / HTTPS pour jouer depuis un casque (`python3 tools/serve.py --https`) |
| `tools/make-samples.js` | régénère les GPX d'exemple (`node tools/make-samples.js`) |

## Licences

Code sous licence GPL v3 (voir `LICENSE`). three.js est distribué sous licence MIT (`vendor/three.LICENSE`).
