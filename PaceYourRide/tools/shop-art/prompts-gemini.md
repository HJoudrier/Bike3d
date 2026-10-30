# Images du magasin avec Gemini — prompts

Objectif : remplacer les calques dessinés du magasin par des images photo-réalistes, **une par élément**, que
le site superpose. Deux séries indépendantes :

- **le vélo seul**, de profil (47 images : décor, roues, pneus, cadres, transmission…) ;
- **le coureur seul, debout, face à la caméra**, sans vélo (24 images : peau, tenues, chaussettes, chaussures,
  casques, lunettes).

Pour que les calques se superposent, toutes les images d'une série doivent avoir **exactement** le même
cadrage. Méthode :

1. coller le **prompt maître** de la série au début d'une conversation (une seule fois) ;
2. demander les images **une par une** en joignant l'**image guide** quand il y en a une
   (`PaceYourRide/tools/shop-art/guides/`) ;
3. détourer le fond vert, vérifier l'alignement, puis remplacer les fichiers.

Gemini ne produit pas de transparence : les calques sont demandés sur un fond vert chroma uni, à détourer
ensuite (Photoshop, remove.bg, rembg…). Pour les éléments verts, le fond est magenta.

---

## 0. Test rapide (un vélo)

Joindre `PaceYourRide/tools/shop-art/guides/velo-aero-guide.png` :

```
Voici une image guide (un dessin) d'un vélo de route aéro vu de profil. Transforme-la en photographie de
studio photo-réaliste du même vélo, comme une photo de catalogue. Garde EXACTEMENT la même silhouette, la
même géométrie, la même position et la même taille de chaque élément, et le même cadrage (2240 × 1364 px,
vue de profil stricte, sans perspective) : les deux images doivent pouvoir se superposer.
Matières : cadre en carbone à peinture irisée bleu → violet très brillante, grand logo « PACEYOURRIDE » bleu
nuit sur le tube diagonal, cintre-potence monobloc et tige de selle en carbone noir, selle de course noire,
jantes carbone noir mat de 45 mm avec lettrage blanc « CARBON », rayons noirs, pneus noirs de 28 mm,
transmission électronique noire, cassette et chaîne argent, disques de frein en acier.
Fond de studio gris clair neutre, lumière douce venant d'en haut à gauche, ombres douces sous les roues.
Aucune autre marque, aucun autre texte.
```

Puis, pour tester un calque, joindre `PaceYourRide/tools/shop-art/guides/velo-aero-cadre-guide.png` :

```
Même vélo, même cadrage. À partir de cette image guide, produis uniquement le cadre (avec la fourche, la tige
de selle et la selle, le cintre-potence, les cocottes et les leviers) en photo-réaliste, exactement à la même
place et à la même taille. Tout le reste de l'image est un vert chroma #00FF00 uni, sans ombre ni dégradé.
```

---

## 1. Vélo — prompt maître (à coller une fois)

```
Tu vas produire une série de photos photo-réalistes de vélo qui seront superposées comme des calques dans un
site web (un magasin de vélo). Toutes les images doivent respecter EXACTEMENT les mêmes conventions, sinon
elles ne se superposeront pas.

CADRAGE (identique pour toutes les images)
- Format 2240 × 1364 px (paysage). Si je joins une image guide, garde exactement son cadre.
- Vue de profil stricte du côté transmission (côté droit du vélo), vélo orienté vers la droite de l'image.
- Aucune perspective (comme un très long téléobjectif), appareil à hauteur des moyeux, jamais de trois-quarts.
- Échelle : 1 m = 1200 px. Le vélo ne bouge jamais d'une image à l'autre.
- Repères (x, y en pixels depuis le coin haut-gauche) :
  · axe de la roue arrière (480, 888), axe de la roue avant (1680, 888) ;
  · diamètre extérieur des pneus 816 px ; sol (bas des pneus) à y = 1296 ;
  · axe du pédalier (964, 972) ; manivelles de 208 px : côté visible vers l'avant et 18° vers le bas
    (pédale visible en (1162, 1036)), côté caché à l'opposé (pédale en (766, 908)) ;
  · vélo de route : dessus de selle à (716, 102), centre du cintre au serrage de la potence (1524, 228),
    sommet des cocottes vers (1760, 176), bas du cintre vers (1496, 396) ;
  · vélo de contre-la-montre : dessus de selle à (772, 76), base du cintre à (1632, 348).

LUMIÈRE ET RENDU
- Photo de studio type catalogue : lumière principale douce venant d'en haut à gauche, reflets nets sur le
  carbone, la peinture et le métal, netteté maximale, pas de flou ni de grain.
- Aucune marque réelle : pas de logo ni de nom de fabricant. Seuls marquages autorisés : « PACEYOURRIDE » sur
  le tube diagonal, « CARBON » sur les jantes carbone, la taille des pneus (« 700×25C »…).

CALQUES
- Sauf indication contraire, chaque image ne montre QU'UN SEUL élément. Tout le reste de l'image est un fond
  uni vert chroma #00FF00, sans dégradé ni ombre portée. Pour les éléments verts (cadre gravel vert olive),
  utilise un fond magenta #FF00FF.
- L'élément est exactement à la place et à la taille qu'il aurait sur l'image complète : ne le recentre pas,
  ne l'agrandis pas. Les parties qui seraient cachées par d'autres éléments restent dessinées en entier.
- Si je joins une image guide, reproduis exactement sa silhouette, sa position et ses proportions ;
  ne change que le rendu (matières, lumière, détails).

Réponds seulement « Compris » ; je te demanderai ensuite les images une par une, avec leur nom de fichier.
```

### Modèle de demande

```
Image « <nom de fichier> » : <description, prise dans les listes ci-dessous>. Seulement cet élément, sur fond
vert chroma #00FF00, au cadrage et à l'échelle convenus. [Image guide jointe : respecte sa silhouette et sa
position exactes.]
```

### Décor — `scene.png` (le seul calque sans fond vert)

Le studio vide : fond gris clair neutre (#EBEBEA) en léger dégradé, sol à peine plus sombre, une ombre douce
sous chaque roue (points de contact x = 480 et x = 1680, y = 1296) et une ombre très diffuse entre les deux.
Pas de vélo.

### Roues sans pneu ni disque de frein — `bike/wheel-rear-<roue>.png` et `bike/wheel-front-<roue>.png` (14)

Jante, rayons et moyeu seulement (la cassette est dans la transmission). Rayon extérieur de la jante : 372 px.

| `<roue>` | Description |
|---|---|
| `box` | Jante plate en alu argent, profil 18 mm, 32 rayons argent croisés, moyeu alu poli |
| `alu` | Jante alu argent, profil 25 mm, 24 rayons argent, moyeu alu poli |
| `climb` | Jante carbone noire mate, profil 30 mm, 24 rayons noirs, moyeu noir, lettrage blanc « CARBON » |
| `c45` | Jante carbone noire mate, profil 45 mm, 21 rayons noirs, grand lettrage blanc « CARBON » (3 fois sur le tour, sur toute la hauteur de la jante), petit « AERO 45 » |
| `c65` | Comme `c45`, profil 65 mm, 18 rayons, petit « AERO 65 » |
| `disc` | Arrière : roue lenticulaire pleine en carbone noir, bombée, « CARBON DISC » en blanc. Avant : jante carbone 80 mm, 16 rayons, « CARBON » |
| `gravel` | Jante alu noire, profil 25 mm, 28 rayons noirs croisés, petit marquage « GRAVEL » |

### Pneus seuls — `bike/tire-rear-<pneu>.png` et `bike/tire-front-<pneu>.png` (12)

L'anneau du pneu monté seulement (diamètre extérieur 816 px), avec la taille sur le flanc.

| `<pneu>` | Description (hauteur visible du flanc) |
|---|---|
| `training` | Route renforcé 28 mm, noir, fin liseré réfléchissant gris-bleu (40 px) |
| `road` | Route 25 mm, noir, bande de roulement lisse (36 px) |
| `tubeless` | Route tubeless 28 mm, noir (40 px) |
| `race` | Course 25 mm à flancs beige clair (latex) (36 px) |
| `gravel` | Gravel 40 mm, noir, petits crampons serrés (58 px) |
| `mtb` | VTT 52 mm, noir, gros crampons (75 px) |

### Freins à disque — `bike/disc-brakes.png` (1)

Les deux disques acier (arrière : rayon 84 px, avant : rayon 96 px, centrés sur les axes) sur une araignée
noire, avec leurs étriers noirs (arrière au-dessus de la base, avant derrière la fourche). Ils sont du côté
gauche du vélo et apparaîtront à travers les rayons.

### Cadres — `bike/frame-<cadre>.png` (8)

Le cadre complet avec la fourche, la tige de selle et la selle (selle de course noire), la potence, le cintre
avec sa guidoline noire, les cocottes et leviers de frein, les freins sur jante quand il n'y a pas de disque,
et les blocages ou axes de roue. Sans roues, sans transmission, sans pédalier.

| `<cadre>` | Description |
|---|---|
| `alu` | Route aluminium gris argent, tubes ronds, petits décors bleus, freins sur jante, potence et cintre route noirs |
| `endurance` | Route carbone bleu marine, douille plus haute, décors bleu clair, freins à disque |
| `climber` | Route carbone blanc, tubes très fins, décors rouges, freins sur jante |
| `aero` | Route aéro carbone à peinture irisée bleu → violet : tube diagonal très épais, douille profonde, haubans abaissés, tube de selle qui épouse la roue arrière, tige de selle profilée noire, cintre-potence monobloc noir, freins à disque, grand logo « PACEYOURRIDE » foncé sur le tube diagonal |
| `tt` | Contre-la-montre carbone noir, décors jaunes, tubes très profilés, base de cintre profilée avec leviers en bout, repose-coudes et prolongateurs relevés au bout, freins à disque |
| `gravel` | Gravel aluminium vert olive (fond magenta), décors crème, cintre évasé, freins à disque |
| `city` | Vélo de ville bleu acier, potence haute argent, cintre relevé vers l'arrière, poignées en cuir marron, freins à disque |
| `mtb` | VTT rouge foncé, potence courte, cintre plat relevé, poignées noires, freins à disque |

### Transmission — `bike/drivetrain-<chaîne>.png` (4)

Cassette 12 vitesses argent sur la roue arrière, chaîne, dérailleur arrière électronique noir (avec sa
batterie), dérailleur avant électronique noir au-dessus du plateau, double plateau noir 48/35 (rayon 116 px)
centré sur le pédalier. Pas de manivelle.

| `<chaîne>` | Description |
|---|---|
| `waxed` | Chaîne cirée, argent brillant presque blanc |
| `clean` | Chaîne lubrifiée, propre, gris acier |
| `average` | Chaîne moyennement entretenue, gris foncé terne |
| `dirty` | Chaîne sale, brunâtre et grasse |

### Pédalier, pédales, prolongateurs (7)

| Fichier | Description |
|---|---|
| `bike/crank-near.png` | Manivelle droite en carbone noir avec l'araignée à 4 branches, vers l'avant et 18° vers le bas |
| `bike/crank-far.png` | Manivelle gauche (cachée, plus sombre), à l'opposé |
| `bike/pedal-near-clip.png`, `bike/pedal-far-clip.png` | Pédale automatique route noire, côté visible ou caché |
| `bike/pedal-near-flat.png`, `bike/pedal-far-flat.png` | Pédale plate en alu anthracite à picots, côté visible ou caché |
| `bike/clipon.png` | Prolongateurs fixés sur le cintre d'un vélo de route : repose-coudes noirs et tubes carbone relevés au bout |

---

## 2. Coureur debout — prompt maître (dans une autre conversation)

```
Tu vas produire une série de photos photo-réalistes d'un coureur cycliste, debout, sans vélo, qui seront
superposées comme des calques dans un site web. Toutes les images doivent respecter EXACTEMENT les mêmes
conventions, sinon elles ne se superposeront pas.

LE COUREUR (toujours le même)
- Homme adulte de 1,78 m, 70 kg, athlétique (cuisses et mollets musclés, bras fins), peau claire légèrement
  hâlée, cheveux courts châtains, visage neutre et sympathique, regard vers l'objectif.
- Debout, de face, face à la caméra, pieds écartés à la largeur des hanches, bras le long du corps légèrement
  écartés du tronc, mains ouvertes et détendues. Il ne bouge jamais d'une image à l'autre.

CADRAGE (identique pour toutes les images)
- Format 1200 × 2500 px (portrait), appareil à hauteur de poitrine, sans perspective marquée.
- Échelle : 1 m = 1200 px. Plante des pieds sur le sol à y = 2400, sommet du crâne à y ≈ 264,
  axe du corps à x = 600.

LUMIÈRE ET RENDU
- Photo de studio : lumière principale douce venant d'en haut à gauche, netteté maximale, pas de flou.
- Aucune marque réelle sur les vêtements, le casque, les lunettes ou les chaussures. Aucun texte.

CALQUES
- Chaque image ne montre QU'UN SEUL élément, à sa place exacte sur le coureur (ne le recentre pas, ne
  l'agrandis pas). Tout le reste est un fond uni vert chroma #00FF00, sans ombre. Pour les éléments verts
  (casque urbain vert), utilise un fond magenta #FF00FF.
- Les vêtements sont montrés seuls, comme portés par un mannequin invisible (même forme, mêmes plis).

Réponds seulement « Compris » ; je te demanderai ensuite les images une par une, avec leur nom de fichier.
```

### Calques du coureur (24)

Ordre d'empilement, du fond vers l'avant : jambes, bras, chaussettes, chaussures, tête, tenue, lunettes, casque.

| Fichier | Description |
|---|---|
| `rider/legs-hairy.png` | Les deux jambes nues, du milieu des cuisses aux chevilles, musclées, au naturel (poils) |
| `rider/legs-smooth.png` | Les mêmes jambes, rasées : peau lisse et légèrement brillante |
| `rider/arms-hairy.png` | Les deux bras nus avec les mains, de l'épaule aux doigts, au naturel (poils sur les avant-bras) |
| `rider/arms-smooth.png` | Les mêmes bras, épilés : peau lisse |
| `rider/head.png` | La tête et le cou, sans casque ni lunettes : visage, oreilles, cheveux courts châtains |
| `rider/kit-<tenue>.png` | La tenue seule (haut et bas), portée par un mannequin invisible |
| `rider/socks-<chaussettes>.png` | La paire de chaussettes seule |
| `rider/shoes-<chaussures>.png` | La paire de chaussures seule (avec les couvre-chaussures pour `aero`) |
| `rider/helmet-<casque>.png` | Le casque seul, posé sur la tête invisible, avec ses sangles |
| `rider/glasses-<lunettes>.png` | Les lunettes seules, sur le visage invisible |

### Tenues `<tenue>` (5)

| Valeur | Description |
|---|---|
| `loose` | T-shirt ample bleu-gris clair, short ample gris anthracite jusqu'aux genoux |
| `fitted` | Maillot ajusté bleu vif à bande blanche sur la poitrine, manches courtes à poignets blancs ; cuissard noir à bande de maintien |
| `aero` | Maillot aéro rouge au tissu texturé, manches jusqu'au coude à poignets noirs ; cuissard noir |
| `skinsuit` | Combinaison route noire d'une pièce, liseré bleu sur les côtés, manches courtes |
| `skinsuit_tt` | Combinaison chrono noire au tissu texturé, manches longues jusqu'aux poignets, liseré jaune sur les côtés |

### Chaussettes `<chaussettes>` (3)

| Valeur | Description |
|---|---|
| `short` | Socquettes blanches, juste au-dessus de la chaussure |
| `classic` | Chaussettes blanches mi-mollet, bord côtelé |
| `aero` | Chaussettes aéro noires, hautes (jusque sous le mollet), surface texturée |

### Chaussures `<chaussures>` (5)

| Valeur | Description |
|---|---|
| `flat` | Baskets blanches à semelle en gomme beige, lacets |
| `mtb` | Chaussures VTT grises, semelle crantée, deux sangles |
| `road` | Chaussures route noires, molette de serrage, semelle rigide |
| `carbon` | Chaussures route blanches, semelle carbone, molette |
| `aero` | Chaussures route couvertes de couvre-chaussures en lycra noir lisse qui montent au-dessus de la cheville |

### Casques `<casque>` (4) et lunettes `<lunettes>` (2)

| Valeur | Description |
|---|---|
| `helmet-city` | Casque urbain en bol, vert mat (fond magenta), petite visière, quelques aérations |
| `helmet-road` | Casque route blanc brillant, nombreuses aérations allongées, sangles noires |
| `helmet-aero` | Casque aéro route noir brillant, coque lisse, quelques ouïes, sangles noires |
| `helmet-tt` | Casque chrono noir en goutte d'eau, visière intégrée irisée, liseré jaune |
| `glasses-sport` | Lunettes de sport enveloppantes, monture noire, verres irisés bleu-violet |
| `glasses-shield` | Grand écran panoramique, verre irisé bleu-violet |

---

## 3. Après la génération

- Format : `.png` avec transparence après détourage.
- Vélo : dans `Commun/img/bike/<nom>.png` ; les axes de roue (480, 888) et (1680, 888)
  doivent tomber au même endroit que sur le guide.
- Coureur : la page « Cycliste » du magasin montrera le coureur seul, debout (à adapter dans
  `Commun/js/ui/gear-art.js`, qui n'affiche aujourd'hui que les photos du vélo).
