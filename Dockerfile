FROM node:22-bookworm-slim AS ui
WORKDIR /build
COPY package*.json ./
RUN npm ci
COPY web/ web/
RUN npm run build

FROM python:3.12-slim-bookworm
WORKDIR /app
ENV ROBOROCK_WEB_DATA_DIR=/data PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && useradd --create-home --uid 10001 roborock && install -d -m 0700 -o roborock -g roborock /data
COPY *.py ./
COPY static/ static/
COPY --from=ui /build/static/dist/ static/dist/
USER roborock
EXPOSE 8765
CMD ["python", "server.py", "--host", "0.0.0.0", "--port", "8765", "--no-browser"]
