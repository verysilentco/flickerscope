# Publishing FlickerScope

Steps for the owner (Silent Co, LLC). Nothing here has been run yet: the repository exists
only locally until you push it, and the package is not on npm until you publish it.

Order: GitHub first (so the links in the README and on npm work), then GitHub Pages for the
demo, then npm. jsDelivr and unpkg follow from npm by themselves.

## 0. Check the package

From the repository folder:

```sh
npm install          # installs esbuild, the only dev dependency
npm test             # 31 tests (math and browser paths)
npm run build        # writes dist/ and reports the size (must stay under 6 KB gzipped)
npm pack --dry-run   # lists exactly what will be published
```

`npm pack --dry-run` should list only `LICENSE`, `README.md`, `package.json` and the files in
`dist/` (`flickerscope.mjs`, `flickerscope.cjs`, `flickerscope.min.js`, `flickerscope.d.ts`,
`flickerscope.d.cts`, `size.json`). No video files, no `docs/`, no `scripts/`.

## 1. GitHub repository

1. Sign in to GitHub as **verysilentco**.
2. Create a new public repository named **flickerscope** at https://github.com/new.
   Leave "Add a README", ".gitignore" and "license" unticked (the repository already has them).
   Description: `Measure flicker in any video, in the browser: a flicker % from LED and fluorescent lights, no upload.`
   Website: `https://deflickerapp.com`.
3. Push:

   ```sh
   git remote add origin https://github.com/verysilentco/flickerscope.git
   git push -u origin main
   ```

   Commits in this repository use the identity `verysilentco <345459761+verysilentco@users.noreply.github.com>`
   (set with `git config` inside this repository only). Check with `git config user.name` and
   `git config user.email` before committing from a new machine.
4. Topics (optional, under the repository's About gear): `flicker`, `video`, `deflicker`,
   `led`, `ieee-1789`, `browser`, `javascript`.

## 2. Demo page on GitHub Pages

1. In the repository: Settings, Pages.
2. Source: "Deploy from a branch". Branch: `main`, folder: `/docs`. Save.
3. After a minute the demo is at https://verysilentco.github.io/flickerscope/ (the README links there).

The page loads `docs/flickerscope.min.js`, a copy that `npm run build` writes next to it, so
run the build and commit before pushing whenever the library changes.

## 3. npm

1. Create an account at https://www.npmjs.com/signup (use contact@silent.co or another
   Silent Co address; the username is public and appears on the package page).
2. Turn on two-factor authentication (Account, Two-Factor Authentication). npm asks for a
   one-time code on publish.
3. Log in from the terminal and check:

   ```sh
   npm login
   npm whoami
   ```

4. Publish (the name `flickerscope` was free on npm on 2026-10-20; if `npm publish` says the name
   is taken, someone registered it since, and the package needs a new name or a scope such as
   `@silentco/flickerscope`):

   ```sh
   npm publish --access public
   ```

   `prepublishOnly` runs the build and the tests first and stops the publish if either fails.
5. Check https://www.npmjs.com/package/flickerscope.

Later releases:

```sh
npm version patch   # or minor / major; updates package.json, commits and tags
npm publish --access public
git push --follow-tags
```

## 4. jsDelivr and unpkg (automatic)

Both mirror npm. Within minutes of publishing these work, with no account or request:

- https://cdn.jsdelivr.net/npm/flickerscope@1/dist/flickerscope.min.js
- https://unpkg.com/flickerscope@1/dist/flickerscope.min.js

`@1` follows the newest 1.x release. A new release can take a while to replace the cached
`@1` file on jsDelivr; to refresh it at once, open
https://purge.jsdelivr.net/npm/flickerscope@1/dist/flickerscope.min.js in a browser.
Pinned versions (`flickerscope@1.0.0`) never change.

## 5. cdnjs (Cloudflare), later

cdnjs does not mirror npm automatically. A library is added by request, and cdnjs only
accepts libraries that already have some popularity. Their guide sets the current bar
(it has been stated as a minimum number of GitHub stars or monthly npm downloads); read
https://github.com/cdnjs/packages/blob/master/CONTRIBUTING.md when applying.

When to apply: once the package clears that bar, for example after the demo and bookmarklet
have been out for a while and npm shows steady weekly downloads. Until then jsDelivr and unpkg
cover the same need.

How to apply: open a pull request on https://github.com/cdnjs/packages adding
`packages/f/flickerscope.json`, along these lines (check the field names against the current
schema in that repository):

```json
{
  "name": "flickerscope",
  "description": "Measure flicker in any video, in the browser: a flicker % from LED and fluorescent lights, no upload.",
  "keywords": ["flicker", "video", "deflicker", "led", "ieee 1789"],
  "authors": [{ "name": "Silent Co, LLC", "email": "contact@silent.co" }],
  "license": "MIT",
  "homepage": "https://deflickerapp.com",
  "repository": { "type": "git", "url": "https://github.com/verysilentco/flickerscope.git" },
  "filename": "flickerscope.min.js",
  "autoupdate": {
    "source": "npm",
    "target": "flickerscope",
    "fileMap": [{ "basePath": "dist", "files": ["flickerscope.min.js", "flickerscope.mjs"] }]
  }
}
```

Once merged, cdnjs picks up new npm releases by itself.

## Never publish

- Test footage. Phone clips carry GPS location and device metadata. `.gitignore` blocks video
  files (except the synthetic `docs/sample-flicker.mp4`), and the npm `files` list only ships `dist/`.
- Personal names, phone numbers or addresses. Author and copyright are "Silent Co, LLC",
  contact contact@silent.co.
