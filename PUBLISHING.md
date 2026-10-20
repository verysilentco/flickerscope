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

## Safety

Never commit video files: phone clips carry GPS and device metadata. `.gitignore` blocks them
(except the synthetic `docs/sample-flicker.mp4`).
