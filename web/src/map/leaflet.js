// Leaflet-Geoman lit `L` en global : ce module doit être importé avant lui.
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Défaut connu de Leaflet : une fin d'animation de zoom programmée peut
// s'exécuter après la destruction de la carte (changement de page pendant un
// zoom) et lever « reading '_leaflet_pos' ». On l'ignore si la carte n'existe plus.
const onZoomEnd = L.Map.prototype._onZoomTransitionEnd;
L.Map.prototype._onZoomTransitionEnd = function patched(...args) {
  if (!this._mapPane) return undefined;
  return onZoomEnd.apply(this, args);
};

window.L = L;
export default L;
