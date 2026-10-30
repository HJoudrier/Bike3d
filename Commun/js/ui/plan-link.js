/* author : Hugo Joudrier-Faure */
/* PaceYourRide — plan optimal enregistré avec le projet (state.ride.plan, forme compacte de PYR.ride.packPlan) et empreinte des réglages
 * pour lesquels il a été calculé (state.ride.planInfo.fp). PaceYourRide l'enregistre dès que la page Pacing optimal l'a calculé ; il part
 * avec le projet dans Dropbox, où le compteur le suit et où le jeu en fait son fantôme. Un plan n'est repris que si le parcours,
 * l'athlète et le vélo n'ont pas changé depuis son calcul. */
(function (PYR) {
  'use strict';

  const store = PYR.store, R = PYR.ride;

  /** Empreinte des réglages qui déterminent un plan. `ignoreWeather` : sans la météo (le fantôme du jeu reste valable sous une autre météo). */
  function fingerprint(ignoreWeather) {
    const st = store.state, p = store.profile;
    const parts = [p ? Math.round(p.length) : 0, p ? p.n : 0, st.rider.ftp, st.rider.cp, st.rider.wPrime, st.rider.pmax, st.rider.weight, st.rider.age, JSON.stringify(st.rider.records),
      st.bike.weight, st.bike.load, st.bike.frame, st.bike.wheels, st.bike.tire, st.bike.cdaOverride, st.bike.cdaAdjust, st.perf.formPct, st.perf.formPct !== 100 ? st.perf.formRef : '', st.perf.cornering, st.perf.vmaxKmh,
      st.env.temperature, JSON.stringify(st.winds), JSON.stringify(st.surfaces), !ignoreWeather && st.weather.enabled ? st.weather.fetchedFor : 0];
    // plan vérifié sur le modèle physiologique : la carte athlète, l'intestin et le matériel emporté comptent aussi
    if (st.perf.physio) parts.push('physio', JSON.stringify(st.rider.physio), st.rider.gut, st.rider.sex, st.rider.height, JSON.stringify(st.ride.kit));
    const s = parts.join('|');
    let hsh = 5381;
    for (let i = 0; i < s.length; i++) hsh = ((hsh << 5) + hsh + s.charCodeAt(i)) | 0;
    return String(hsh);
  }

  /**
   * Forme ≠ 100 % : le plan est calculé avec les capacités ajustées à la forme, mais W′bal et le temps avant épuisement se lisent par
   * défaut sur le profil de l'athlète à 100 % (réglage `perf.formRef`). « form » : tout reste sur le profil ajusté.
   */
  const refIsForm = (margin) => margin !== 0 && store.state.perf.formRef === 'form';
  /** Référence pour R.planFromResult : null quand W′bal de l'optimiseur est déjà la bonne référence. */
  function planRef(athlete, margin, w) { return margin === 0 || refIsForm(margin) ? null : { athlete, w }; }

  /** Enregistre le plan (forme compacte) avec le projet. */
  function save(plan, source) {
    const r = store.state.ride;
    r.plan = R.packPlan(plan);
    r.planInfo = { fp: fingerprint(), fp0: fingerprint(true), at: Date.now(), source, length: plan.length };
    store.save();
  }

  let adopted = null;
  /** Le plan calculé sur la page Pacing optimal, s'il est à jour, est enregistré avec le projet. */
  function adoptPerfPlan(force) {
    const res = store.plan;
    if (!res || store.planStale || !store.profile || (!force && adopted === res)) return false;
    adopted = res;
    save(R.planFromResult(res, res.inputs ? res.inputs.length : store.profile.length, planRef(res.athlete, res.margin)), 'perf');
    return true;
  }

  /** Plan enregistré avec le projet, s'il correspond encore au parcours, à l'athlète et au vélo ; sinon null. `ignoreWeather` : la météo n'y compte pas. */
  function saved(ignoreWeather) {
    const rs = store.state.ride;
    if (!rs || !rs.plan || !rs.planInfo || !store.profile) return null;
    const ok = rs.planInfo.fp === fingerprint() || (ignoreWeather && rs.planInfo.fp0 !== undefined && rs.planInfo.fp0 === fingerprint(true));
    return ok ? R.unpackPlan(rs.plan) : null;
  }

  /** Le plan enregistré a-t-il été calculé pour d'autres réglages que les actuels ? */
  function isStale() {
    const rs = store.state.ride;
    return !!(rs && rs.planInfo && rs.planInfo.fp !== fingerprint());
  }

  PYR.planLink = { fingerprint, refIsForm, planRef, save, adoptPerfPlan, saved, isStale };
})(globalThis.PYR = globalThis.PYR || {});
