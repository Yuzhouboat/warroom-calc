# War Room Battle Calculator

A browser-based battle calculator for the War Room board game, with land and sea combat simulations and unit stance recommendations.

## Run locally

No dependencies or build step are required. From this directory, run:

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

Open <http://localhost:8000> in your browser.

## Project files

- `index.html` — calculator interface, styling, and English/Chinese translations.
- `engine.js` — battle simulation engine; supports browsers and Node.js.
- `recommend.js` — stance recommendation search; supports browsers and Node.js.
- `icons/` — unit images used by the interface.

The interface saves settings in browser local storage. The app can be hosted on any static web server.
