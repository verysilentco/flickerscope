# Publishing

Releases come from git tags on github.com/verysilentco/flickerscope. jsDelivr serves any tagged
version straight from GitHub, with no npm account:

- https://cdn.jsdelivr.net/gh/verysilentco/flickerscope@1/dist/flickerscope.min.js (latest 1.x)
- https://cdn.jsdelivr.net/gh/verysilentco/flickerscope@1.0.0/dist/flickerscope.min.js (pinned)

## A new version

```sh
npm install          # esbuild, the only dev dependency
npm test             # all tests must pass
npm run build        # writes dist/ and docs/flickerscope.min.js (fails above 6 KB gzipped)
```

Bump `version` in `package.json`, commit `dist/` with it, then tag and release:

```sh
git tag v1.0.1 && git push origin main --tags
gh release create v1.0.1 --title "FlickerScope 1.0.1" --notes "What changed"
```

jsDelivr caches `@1` for up to a week; purge it at
https://purge.jsdelivr.net/gh/verysilentco/flickerscope@1/dist/flickerscope.min.js

## npm and unpkg (not used)

npm requires two-factor authentication on the account to publish, which the owner chose not to
turn on, so the package is not on npm and unpkg (an npm mirror) does not serve it.

## cdnjs (Cloudflare)

cdnjs adds libraries by request and normally wants about 200 GitHub stars for a git-sourced
library. When the repository gets there, open a pull request on github.com/cdnjs/packages adding
`packages/f/flickerscope.json`:

```json
{
  "name": "flickerscope",
  "filename": "flickerscope.min.js",
  "description": "Measure flicker in any video, in the browser: a flicker % from LED and fluorescent lights, no upload.",
  "keywords": ["flicker", "video", "deflicker", "led", "ieee-1789"],
  "license": "MIT",
  "homepage": "https://verysilentco.github.io/flickerscope/",
  "repository": { "type": "git", "url": "git+https://github.com/verysilentco/flickerscope.git" },
  "autoupdate": {
    "source": "git",
    "target": "git://github.com/verysilentco/flickerscope.git",
    "fileMap": [{ "basePath": "dist", "files": ["*.js", "*.mjs", "*.cjs"] }]
  }
}
```

## Safety

Never commit video files: phone clips carry GPS and device metadata. `.gitignore` blocks them
(except the synthetic `docs/sample-flicker.mp4`).
