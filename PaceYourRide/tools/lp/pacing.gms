$title PaceYourRide - allure optimale par programmation lineaire (modele quasi-statique en distance)
$onText
Variables : tau(i) = duree du troncon i (s), E(i) = energie aux pedales sur le troncon (J).
Le temps total est lineaire en tau ; l'energie necessaire est une fonction CONVEXE g_i(tau) du temps passe sur le
troncon (trainee ~ v^2, v = ds/tau). Cette fonction est remplacee par l'enveloppe convexe de points echantillonnes,
c'est-a-dire par un jeu de facettes lineaires : E(i) >= fa(i,k)*tau(i) + fb(i,k).
W'bal est lineaire en energie : au-dessus de la PC on consomme ep(i) joule pour joule, en dessous on recupere em(i)
avec le rendement kap(i) (= kr * deficit, issu de l'iteration precedente : programmation lineaire sequentielle).
Les donnees viennent de data.inc, ecrit par run.js.
$offText

$include data.inc

Positive Variables tau(i), E(i), ep(i), em(i), wb(i), slk(w), eq(q), dq(q), zq(q);
Variable z;

Equations obj, cost(i,k), pmaxe(i), ebal(i), wdyn(i), win(w), tot, eqd(q), dqd(q), npc(q,c), npt;

* Les fenetres glissantes sont linearisees avec une appartenance des troncons FIXEE (temps de passage de l'iteration
* precedente) : si cette appartenance est trop eloignee de la solution, la contrainte peut etre impossible a tenir.
* Une variable d'ecart tres penalisee (penalite en s par joule) garde le LP faisable et mesure la violation.
Scalar pen 'penalite de depassement de fenetre (s/J)' / 0.05 /;

obj..          z =e= sum(i, tau(i)) + pen*sum(w, slk(w));
cost(i,k)..    E(i) =g= fa(i,k)*tau(i) + fb(i,k);
pmaxe(i)..     E(i) =l= pmax*tau(i);
ebal(i)..      E(i) - cp*tau(i) =e= ep(i) - em(i);
wdyn(i)..      wb(i) =l= w0$(ord(i) = 1) + wb(i-1)$(ord(i) > 1) - ep(i) + kap(i)*em(i);
* Fenetre de ~d secondes (appartenance des troncons fixee) : la puissance MOYENNE sur ces troncons ne depasse pas
* le record de d secondes, soit  somme(w*E) <= (record/d) * somme(w*tau). L'energie est rapportee a la duree REELLE
* des troncons (variable), pas a d secondes figees : sinon un plan plus rapide que l'iteration precedente voit ses
* fenetres sous-estimees.
win(w)..       sum(i$ww(w,i), ww(w,i)*(E(i) - wrate(w)*tau(i))) =l= slk(w);
tot..          sum(i, E(i)) =l= wtot0 + dwtot*(sum(i, tau(i)) - tprev);

* Puissance normalisee (sorties de plus de 20 min) : moyenne des puissances glissantes sur ~30 s elevees a la puissance 4.
* eq(q), dq(q) : energie et duree REELLES de la fenetre q (appartenance des troncons fixee, ponderee par w).
* La puissance moyenne vaut eq/dq ; D*(E/D)^4 = E^4/D^3 est convexe (fonction perspective), de tangentes
*   z >= 4 p^3 E - 3 p^4 D     (p = puissance de tangence, en centaines de watts ; E en centaines de J)
* et la moyenne temporelle des z reste sous (record/100)^4 : somme(z) <= 30 * nq * second membre.
eqd(q)..       eq(q) =e= sum(i$npw(q,i), npw(q,i)*E(i));
dqd(q)..       dq(q) =e= sum(i$npw(q,i), npw(q,i)*tau(i));
npc(q,c)..     zq(q) =g= npa(c)*eq(q)/100 + npb(c)*dq(q);
npt..          sum(q, zq(q)) =l= 30*nq*(nprhs0 + dnprhs*(sum(i, tau(i)) - tprev));

tau.lo(i) = taulo(i);
tau.up(i) = tauup(i);
wb.up(i)  = w0;

Model pacing / all /;
option lp = highs, limrow = 0, limcol = 0, solprint = off;
solve pacing using lp minimizing z;

file fs / sol.csv /;
put fs;
loop(i,
  put ord(i):0:0, ',', tau.l(i):0:9, ',', E.l(i):0:6, ',', wb.l(i):0:4 /
);
putclose fs;
file fst / status.txt /;
put fst;
put pacing.modelstat:0:0, ',', pacing.solvestat:0:0, ',', sum(i, tau.l(i)):0:6, ',', sum(w, slk.l(w)):0:3 /;
* diagnostic NP : moyenne des zq (ce que voit le LP), vraie moyenne de x^4, et second membre
Scalars nqs, dz, dx4, drhs, dxmax;
Parameter pq(q);
nqs = max(nq, 1);
pq(q)$(dq.l(q) > 1e-9) = eq.l(q)/dq.l(q)/100;
dz = sum(q, zq.l(q))/(30*nqs);
dx4 = sum(q, dq.l(q)*power(pq(q), 4))/(30*nqs);
drhs = nprhs0 + dnprhs*(sum(i, tau.l(i)) - tprev);
dxmax = smax(q, pq(q));
put dz:0:6, ',', dx4:0:6, ',', drhs:0:6, ',', dxmax:0:4 /;
putclose fst;
