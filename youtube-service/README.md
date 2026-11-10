# PianoGiri YouTube audio service

A small Cloud Run service. PianoGiri sends it a YouTube link, and it streams back the audio-only track (m4a when available). The browser then converts the audio to notes and keeps a copy so the original song can play along.

- `GET /audio?url=<youtube link>` returns audio bytes, with `X-Title` and `X-Duration` headers.
- `GET /health` returns `{"ok": true}`.

Guards:
- **Origin allow-list** (`ALLOWED_ORIGINS`): other sites get a 403.
- **Per-IP rate limit** (`RATE_LIMIT` per hour).
- **Length limit** (`MAX_SECONDS`, default 8 min); live streams are refused.
- **Instance cap**: `--max-instances` limits the worst-case bill.
- **Logging**: logs record method, path and status only, never the link.

## Run locally

```sh
docker build -t pianogiri-yt .
docker run --rm -p 8790:8080 -e ALLOWED_ORIGINS=http://localhost:8765 pianogiri-yt
```

Set `IMPORT.youtubeEndpoint` in `js/config.js` to `http://localhost:8790` while testing.

## Deploy to Cloud Run

```sh
gcloud run deploy pianogiri-yt \
  --source . \
  --region asia-south1 \
  --allow-unauthenticated \
  --cpu 1 --memory 512Mi \
  --concurrency 4 --max-instances 2 --min-instances 0 \
  --timeout 300 \
  --set-env-vars ALLOWED_ORIGINS=https://piano.gauravgiri.com.np,RATE_LIMIT=12,MAX_SECONDS=480
```

Then set `IMPORT.youtubeEndpoint` to the service URL (no trailing slash) and push.

## When YouTube blocks it

Cloud Run uses Google datacenter IPs, which YouTube often challenges ("Sign in to confirm you're not a bot"). The service reports this as a `503 blocked` error, and the app shows the user a friendly message suggesting a file upload instead. Options, in order of preference:

1. **Rebuild the image** to get the latest yt-dlp (`gcloud run deploy` again). Most breakages are fixed upstream within days.
2. **Cookies**: put a `cookies.txt` export from a *throwaway* YouTube account in Secret Manager and mount it as the `YTDLP_COOKIES` env var (`--set-secrets YTDLP_COOKIES=yt-cookies:latest`). The account may get flagged.
3. **Residential proxy**: costs money; the free option is gone at that point.

## Cost

With scale-to-zero, light use stays inside Cloud Run's free tier. The main cost is internet egress: about 3–5 MB per song. Beyond the free allowance, 1,000 imports a month is roughly 4 GB, which comes to well under $1. `--max-instances 2` caps the worst case.
