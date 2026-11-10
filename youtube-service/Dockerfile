FROM python:3.12-slim

# yt-dlp needs a JavaScript runtime (Deno) to solve YouTube's player challenges.
COPY --from=denoland/deno:bin-2.5.6 /deno /usr/local/bin/deno

RUN pip install --no-cache-dir "yt-dlp[default]" \
    && useradd --create-home app

USER app
WORKDIR /home/app
COPY server.py .

ENV PYTHONUNBUFFERED=1
CMD ["python", "server.py"]
