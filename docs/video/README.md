# Guide vidéo du président

Vidéo : `docs/guide-president.mp4` (non versionnée : régénérable).

Refaire la vidéo (après un changement d'interface) :

1. `reset.sh` : base de démonstration vierge `chassestu_demo` (association
   fictive, président au profil vide, 7 membres) et API locale dessus.
2. Narration : `scenes.json` → un fichier WAV par scène avec Piper
   (voix `fr_FR-siwis-medium`), durées dans `durations.json`.
3. `FAST=1 node tournage.cjs` : répétition rapide ; puis `node tournage.cjs`
   : prise continue en 1280×720 (`out/brut.webm`, `out/timeline.json`).
4. Montage ffmpeg : chaque narration au début de sa scène, H.264 + AAC.

Le serveur Vite doit tourner (`npm run dev -w web`) ; les cartes de
l'éditeur, des plans et des lieux sont exposées en développement seulement
(`window.__map`, `__plansMap`, `__placesMap`).
