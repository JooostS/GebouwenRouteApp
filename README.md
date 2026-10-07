# Hoornbeeck Gebouwenroute

Een installeerbare webapp (PWA) die je op het Hoornbeeck College in Gouda de weg wijst: kies een lokaal, en de app tekent de kortste looproute over de plattegrond, ook over meerdere verdiepingen via de trappen. Met live locatie ("blauwe stip") of door op de kaart te tikken waar je staat.

## Functies

- **Plattegronden** van de kelder (-1) tot en met verdieping 6, gemaakt uit de officiële bouwtekeningen; zoomen en slepen met vingers of muis.
- **Lokalen zoeken**: `A.1.01`, `a1.01` en `a101` vinden hetzelfde lokaal.
- **Routeplanner**: A* over een raster van 25 cm-cellen. Muren zijn dicht, deuren gaan open, en de route blijft netjes midden in de gang.
- **Meerdere verdiepingen**: de app probeert elke trap en kiest de kortste totale route.
- **Live locatie** via de Geolocation API. De plattegronden zijn gegeorefereerd, dus een lat/lng rekent direct om naar een punt op de kaart. Metingen worden gemiddeld en de stip wordt op een loopbare plek (en tijdens een route op de lijn) gezet.
- **Offline**: een service worker cachet alle bestanden, dus de app werkt ook zonder bereik.

## Bestanden

| Bestand | Wat het doet |
| --- | --- |
| `index.html`, `style.css` | Schermen (home, route, lokalen, badges, profiel, info) en opmaak |
| `app.js` | Kaart (zoom/pan), lokalenlijst, GPS, routekaart en meerdere verdiepingen |
| `route.js` | Routeplanner: raster bouwen uit de muren en A* zoeken. Werkt in de browser en in Node |
| `kaarten/<n>.svg` | Tekening van verdieping `n`: muren, deuren en lokaalnummers (alleen voor het oog) |
| `kaarten/<n>.nav.json` | Originele muurlijnen voor de routeplanner; wordt pas geladen als er een route wordt gezocht |
| `kaarten/index.json` | Per verdieping: naam, georeferentie, deuren, handmatige doorgangen en lokalen |
| `sw.js`, `manifest.json`, `icon.svg` | Offline-cache en installeerbaarheid |

## Draaien

Het zijn statische bestanden, er is geen build nodig. Serveer de map via een webserver:

```
# bijvoorbeeld met XAMPP: zet de map in htdocs en open
http://localhost/Leerjaar-3/PGF/GebouwenRouteApp/hoornbeeck-gebouwenroute-pwa/

# of met Node
npx serve .
```

Live locatie en installeren werken alleen via **https** (of `localhost`). Op GitHub Pages is dat vanzelf zo.

## Kaarten opnieuw bouwen

De kaarten worden gegenereerd uit de PDF's in `../Plattegronden/`. De tool staat één map hoger, in `../tools/`:

```
cd ../tools
npm install
npm run kaarten
```

Dit schrijft `kaarten/<n>.svg`, `kaarten/<n>.nav.json` en `kaarten/index.json`. Wat de tool doet:

- Wandlijnen uit de PDF samenvoegen: de 2-3 parallelle lijnen van een muur worden één middenlijn, buitenmuren worden apart (dikker) getekend.
- Deuren herkennen aan hun boog, zodat de routeplanner er doorheen mag.
- Lokaalnummers en namen plaatsen en per verdieping een georeferentie berekenen.

Mist de tekening ergens een deur, voeg dan een handmatige doorgang toe in `OPENINGS` in `tools/kaarten-bouwen.mjs`.

## Een wijziging uitrollen

Verhoog het cachenummer in `sw.js` (`CACHE = "hoornbeeck-route-vN"`) bij elke wijziging aan de bestanden. Anders blijft een telefoon de oude, gecachete versie tonen.

## Prestaties

De kaart is bewust licht gehouden voor telefoons:

- De tekening bevat alleen wat je ziet; de zware routedata zit in aparte `.nav.json`-bestanden.
- Lijndikte en lokaalteksten worden pas bijgewerkt als het zoomen stopt, niet bij elk frame.
- Tijdens live locatie wordt de route pas opnieuw berekend als je meer dan 1,5 m bent verplaatst. Bij een route naar een andere verdieping worden trappen op een ondergrens gesorteerd en niet meer allemaal doorgerekend.

## Bekende beperkingen

- GPS binnen een gebouw is grof (10-60 m). De app middelt metingen en zet de stip op de route, maar het blijft een schatting.
- GPS weet niet op welke verdieping je bent; die kies je zelf met de tabs.
- Mist de bouwtekening een doorgang, dan stopt de route zo dichtbij als het kan en meldt de app dat het laatste stuk niet op de kaart staat.
