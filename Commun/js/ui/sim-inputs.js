/* author : Hugo Joudrier-Faure */
/* PaceYourRide — entrées de simulation : assemble, à partir de l'état (parcours, météo, athlète, vélo, réglages), tout ce que les moteurs
 * attendent (parcours de simulation, montage du vélo, athlète, modèle physiologique). Partagé par la page Pacing optimal, le magasin, le
 * jeu et le compteur. */
(function (PYR) {
  'use strict';

  const store = PYR.store;

  const CORNERING = { off: { aLat: 0, aBrake: 3.5 }, safe: { aLat: 2.94, aBrake: 2.5 }, normal: { aLat: 4.41, aBrake: 3.5 }, racing: { aLat: 5.88, aBrake: 5 } };

  /**
   * Assemble tout ce qu'il faut pour simuler (partagé avec le mode jeu).
   * machine : {rider, bike} imposés (défi « armes égales », course en direct), sinon les réglages locaux.
   */
  function build(machine, opts) {
    const st = store.state;
    const p = store.profile;
    if (!p) throw new Error('Trace d\'abord un parcours (page Parcours).');
    const corner = CORNERING[st.perf.cornering] || CORNERING.normal;
    // largeur de route (page Parcours) : seul le peloton du mode jeu s'en sert
    const env = Object.assign({}, st.env, { roadWidth: st.road ? st.road.width : undefined });
    const course = PYR.course.buildCourse(p, { surfaces: st.surfaces, winds: st.winds }, env,
      { aLat: corner.aLat, aBrake: corner.aBrake, vmaxKmh: Number(st.perf.vmaxKmh) || 80, weather: PYR.tabWeather.snapshotForSim() });
    const rider = machine && machine.rider ? machine.rider : st.rider;
    const bike = machine && machine.bike ? machine.bike : st.bike;
    const setup = PYR.physics.buildSetup(rider, bike);
    let athlete = PYR.physio.buildAthlete(rider);
    // stratégie optimale avec le modèle physiologique (option) : la chaleur, l'eau, le glycogène et la fatigue agissent le long du
    // parcours (optimizer.optimizePhysio), avec le matériel et le plan d'alimentation du compteur
    const physio = opts && opts.plan && st.perf.physio && PYR.metabo
      ? { card: PYR.metabo.card(rider, athlete), kit: st.ride.kit, gut: Number(rider.gut) || 0 } : null;
    // sinon, la chaleur (ou le grand froid) réduit PC et W′ de la moyenne du parcours ; en course elle s'applique seconde par
    // seconde, donc pas ici
    if (opts && opts.plan && !physio) {
      const k = PYR.tabWeather.meanHeatK();
      if (k < 0.9999) athlete = PYR.physio.scaleAthlete(athlete, k, k);
    }
    return {
      course, setup, athlete, physio,
      v0: (Number(st.perf.startSpeedKmh) || 0) / 3.6,
      margin: 1 - (Number(st.perf.formPct) > 0 ? Number(st.perf.formPct) : 100) / 100,   // forme 100 % = capacités entières ; < 100 : marge, > 100 : surpuissance
      seed: 20240917,
    };
  }

  PYR.simInputs = { build, CORNERING };
})(globalThis.PYR = globalThis.PYR || {});
