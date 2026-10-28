/* author : Hugo Joudrier-Faure */
/* PaceYourRide — barre de puissance de l'écran de course mobile : cinq segments de même largeur
 * (Récup, Endur, Tempo, Seuil, PMA) dont les bornes suivent les zones de la FTP. Sans DOM (testable). */
(function (PYR) {
  'use strict';

  const NAMES = ['Récup', 'Endur', 'Tempo', 'Seuil', 'PMA'];
  const LABELS = ['Récupération', 'Endurance', 'Tempo', 'Seuil', 'PMA'];
  const MODES = ['recover', 'endurance', 'tempo', 'threshold', 'pma']; // tactique (puissance nominale) de chaque segment

  /**
   * Texte d'un segment selon la place disponible : 0 = « Z1 - Récupération » (nom complet), 1 = « Z1 - Récup » (nom court),
   * 2 = « Récup » (nom court seul). Le segment PMA couvre Z5 et Z6 mais porte le numéro Z5.
   */
  const LEVELS = 3;
  function zoneText(i, level) {
    if (level <= 0) return `Z${i + 1} - ${LABELS[i]}`;
    if (level === 1) return `Z${i + 1} - ${NAMES[i]}`;
    return NAMES[i];
  }

  /**
   * Bornes des cinq segments, en W : 0, fin des zones Z1 à Z4 (55, 75, 90 et 105 % de la FTP), puis le maximum de la
   * barre (en pratique 150 % de la FTP, fin de Z6). Le dernier segment (PMA) absorbe donc les zones Z5 et Z6.
   */
  function zoneEdges(ftp, max) {
    const z = PYR.physio.ZONES;
    const edges = [0, z[0].max * ftp, z[1].max * ftp, z[2].max * ftp, z[3].max * ftp, max];
    // FTP très haute devant le maximum de la jauge : on resserre les bornes pour garder cinq segments non vides
    if (edges[4] > max * 0.9) {
      const k = max * 0.9 / edges[4];
      for (let i = 1; i < 5; i++) edges[i] *= k;
    }
    return edges;
  }

  /** Position (0 à 1) d'une puissance sur la barre : linéaire par segment. */
  function powerToPos(p, edges) {
    if (p <= edges[0]) return 0;
    for (let j = 0; j < 5; j++) {
      if (p <= edges[j + 1]) return (j + (p - edges[j]) / (edges[j + 1] - edges[j])) / 5;
    }
    return 1;
  }

  /** Puissance (W) à une position de la barre (0 à 1). */
  function posToPower(frac, edges) {
    const f = Math.max(0, Math.min(1, frac));
    const x = f * 5, j = Math.min(4, Math.floor(x));
    return edges[j] + (x - j) * (edges[j + 1] - edges[j]);
  }

  /** Segment (0 à 4) d'une puissance. */
  function zoneIndex(p, edges) {
    for (let j = 0; j < 4; j++) if (p < edges[j + 1]) return j;
    return 4;
  }

  PYR.powerBar = { NAMES, LABELS, MODES, LEVELS, zoneText, zoneEdges, powerToPos, posToPower, zoneIndex };
})(globalThis.PYR = globalThis.PYR || {});
