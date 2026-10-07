# superzoom
Enhance zoom with AI

A camera app for iOS and Android (Expo) built for extreme zoom. It uses the phone's optical lenses as far as they go, crops past that, and sends the crop to a cloud AI upscaler (fal.ai) to rebuild a sharper image. Planning docs live in [`openspec/changes/add-zoom-camera-mvp`](openspec/changes/add-zoom-camera-mvp).

## Development

The app uses native modules (VisionCamera), so it needs a development build; Expo Go won't work.

```sh
npm install
npx expo run:ios       # or: npx expo run:android, or an EAS build with the "development" profile
npx expo start         # dev server; also serves the /api/enhance route
```

Checks: `npm test`, `npm run lint`, `npm run typecheck`.

The enhancement backend needs a fal.ai key and, in production, an Upstash Redis database. See [docs/backend.md](docs/backend.md).

## Layout

- `src/app/`: screens (`index.tsx` camera, `result.tsx` comparison) and the `api/enhance+api.ts` server route
- `src/camera/`: lens analysis, zoom split, crop math, capture pipeline
- `src/enhance/`: API client, cancellation, error messages
- `src/server/`: request validation, fal.ai upscaler, rate limiting
- `src/shared/`: the request/response contract shared by app and server
- `src/state/`: persisted settings and the capture session store
