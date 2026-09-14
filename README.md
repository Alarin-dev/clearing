# Reflective Thinking (static, client-side)

A thinking tool that separates raw capture from AI-assisted structure.
Runs entirely in the browser -- no backend, no server, no build step.

## How data and keys are handled

- **Your raw thoughts and document data** live in your browser's
  IndexedDB. Nothing is sent anywhere except the specific text of a
  new thought (to classify it) or your full raw stream history (to
  compose a draft), both sent only to OpenRouter.
- **Your OpenRouter API key** is stored only in your browser's
  localStorage and is sent only in requests to OpenRouter. It is never
  sent to any server of ours, because there is no server here --
  this is a static site. Each person who uses this app brings and
  stores their own key, in their own browser.
- Clearing your browser's site data for this page will delete
  everything -- there is no cloud backup in this version.

## Running locally

Just open `index.html` in a browser -- but note some browsers restrict
`fetch()` and IndexedDB on the `file://` protocol. If you hit issues,
serve it locally instead:

```bash
cd reflective-thinking-web
python3 -m http.server 8000
```

Then visit `http://localhost:8000`.

## Deploying to GitHub Pages

1. Push this folder to a GitHub repository.
2. In the repo, go to Settings -> Pages.
3. Under "Source," choose the branch and root folder containing
   `index.html`.
4. Save. GitHub will give you a URL like
   `https://yourusername.github.io/your-repo-name/`.

No further configuration needed -- there's no build step, no
environment variables, nothing server-side to set up.

## Getting an OpenRouter key

1. Create a free account at https://openrouter.ai
2. Go to Settings -> Keys, create a key.
3. Open the app, click "Settings," paste the key in.
4. Free models (e.g. `google/gemma-4-26b-a4b-it:free`) work at zero
   cost but are rate-limited and occasionally deprecated -- check
   https://openrouter.ai/models for current free options if the
   default model stops working.

## Architecture notes

- `storage.js` -- IndexedDB layer. Raw text is written once per
  passage and never modified by any function in this file. Only the
  `section` field of a passage ever changes.
- `ai.js` -- the only file that calls an AI model. The classifier
  returns filing decisions only, never text. The composer is a
  separate, explicitly disposable layer allowed to rewrite freely.
- `app.js` -- UI wiring, mirrors the loop: save raw -> classify ->
  file -> re-render -> recompose.

Sessions can be archived (not deleted) via the Sessions panel, which
marks the current session archived and starts a fresh one -- all data
stays in IndexedDB under its original session ID.
