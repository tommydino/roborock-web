"""Small local web app for controlling a Roborock vacuum.

    python server.py            # real robot (sign in from the browser)
    python server.py --demo     # simulated Qrevo S, no account needed
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import shutil
import sys
import threading
import webbrowser
from contextlib import asynccontextmanager
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from roborock.exceptions import RoborockException

from ai import register_ai_routes

ROOT = Path(__file__).parent
STATIC = ROOT / "static"
BUNDLE = STATIC / "dist" / "main.js"  # built from web/*.ts by `npm run build`


def persistent_data_dir(root: Path) -> Path:
    """Use a per-user data folder so replacing the downloaded app keeps sign-in."""
    configured = os.environ.get("ROBOROCK_WEB_DATA_DIR")
    if configured:
        data_dir = Path(configured).expanduser()
    elif sys.platform == "darwin":
        data_dir = Path.home() / "Library" / "Application Support" / "Roborock Web" / "data"
    elif os.name == "nt":
        data_dir = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "Roborock Web" / "data"
    else:
        data_home = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")).expanduser()
        data_dir = data_home / "roborock-web" / "data"

    legacy_dirs = [root / "data"]
    # ZIP downloads are often unpacked into a new sibling directory. Import
    # state from earlier Roborock Web copies once, without replacing newer data.
    parents = {root.parent, Path.home() / "Downloads"}
    for parent in parents:
        try:
            legacy_dirs.extend(
                child / "data"
                for child in parent.iterdir()
                if child.is_dir() and child.name.casefold().startswith(("roborock-web", "roborock web"))
            )
        except OSError:
            continue

    data_dir.mkdir(parents=True, exist_ok=True)
    session_file = data_dir / "session.json"
    if not session_file.exists():
        target = data_dir.resolve()
        candidates: list[Path] = []
        seen: set[Path] = set()
        for path in legacy_dirs:
            source = path.resolve()
            if source == target or source in seen or not path.is_dir():
                continue
            seen.add(source)
            candidates.append(path)
        session_sources = [path for path in candidates if (path / "session.json").is_file()]
        session_sources.sort(key=lambda path: (path / "session.json").stat().st_mtime, reverse=True)
        source = next((path for path in candidates if path == root / "data" and (path / "session.json").is_file()), None)
        if source is None:
            source = session_sources[0] if session_sources else next((p for p in candidates if p == root / "data"), None)
        if source is not None:
            for item in source.iterdir():
                destination = data_dir / item.name
                if destination.exists():
                    continue
                try:
                    if item.is_dir():
                        shutil.copytree(item, destination)
                    else:
                        shutil.copy2(item, destination)
                except OSError as err:
                    logging.getLogger(__name__).warning("Could not migrate app data from %s: %s", source, err)

    session_file = data_dir / "session.json"
    if session_file.exists():
        try:
            os.chmod(session_file, 0o600)
        except OSError as err:
            logging.getLogger(__name__).warning("Could not restrict permissions on the saved session: %s", err)
    return data_dir


def code_fingerprint() -> str:
    """Hash of the app's Python files, to notice updates made after the server started."""
    h = hashlib.sha1()
    for f in sorted(ROOT.glob("*.py")):
        h.update(f.read_bytes())
    return h.hexdigest()


def ui_outdated() -> bool:
    """True when the TypeScript sources changed after the last build."""
    if not BUNDLE.exists():
        return True
    newest = max((f.stat().st_mtime for f in (ROOT / "web").rglob("*.ts")), default=0.0)
    return newest > BUNDLE.stat().st_mtime


def create_app(demo: bool, data_dir: Path | None = None) -> FastAPI:
    started_with = code_fingerprint()
    if demo:
        from demo import DemoService

        service: Any = DemoService()
    else:
        from robot import RoborockService

        service = RoborockService(data_dir or persistent_data_dir(ROOT))

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        await service.start()
        yield
        await service.stop()

    app = FastAPI(title="Roborock", lifespan=lifespan, docs_url=None, redoc_url=None)
    # Mostly for opening it from another device: the script and map data shrink to about a third.
    app.add_middleware(GZipMiddleware, minimum_size=2048, compresslevel=5)

    @app.middleware("http")
    async def revalidate_static(request: Request, call_next):
        # Always re-check UI files so a normal reload picks up changes.
        response = await call_next(request)
        if request.url.path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-cache"
        return response

    @app.exception_handler(RoborockException)
    async def roborock_error(_req: Request, exc: RoborockException):
        return JSONResponse({"detail": str(exc) or type(exc).__name__}, status_code=502)

    @app.exception_handler(ValueError)
    async def value_error(_req: Request, exc: ValueError):
        return JSONResponse({"detail": str(exc)}, status_code=400)

    async def ctrl(duid: str):
        try:
            return await service.controller(duid)
        except KeyError:
            raise HTTPException(404, "Robot not found") from None

    register_ai_routes(app, ctrl)

    @app.get("/api/auth")
    async def auth():
        # The UI files are always served fresh, but Python changes need a restart
        # and TypeScript changes need a rebuild (start.command does both).
        outdated = code_fingerprint() != started_with or ui_outdated()
        return {**service.auth_state(), "restart_needed": outdated}

    @app.post("/api/auth/code")
    async def request_code(email: str = Body(..., embed=True), send: bool = Body(True, embed=True)):
        await service.request_code(email, send)
        return service.auth_state()

    @app.post("/api/auth/login")
    async def login(code: str = Body(..., embed=True)):
        await service.login(code)
        return service.auth_state()

    @app.post("/api/reconnect")
    async def reconnect():
        await service.reconnect()
        return service.auth_state()

    @app.post("/api/auth/logout")
    async def logout():
        await service.logout()
        return service.auth_state()

    @app.get("/api/devices")
    async def devices():
        return await service.devices()

    @app.get("/api/devices/{duid}/status")
    async def status(duid: str):
        return await (await ctrl(duid)).status()

    @app.get("/api/devices/{duid}/map")
    async def map_(duid: str, since: str | None = None, img: str | None = None):
        return await (await ctrl(duid)).map(since, img)

    @app.get("/api/devices/{duid}/obstacle-photo")
    async def obstacle_photo(duid: str, photo_id: str):
        try:
            content, media_type, bbox, diagnostic = await (await ctrl(duid)).obstacle_photo(photo_id)
        except ValueError as err:
            raise HTTPException(404, str(err)) from err
        headers = {"Cache-Control": "private, max-age=300", "X-Obstacle-Photo-Diagnostic": diagnostic}
        if bbox:
            headers["X-Obstacle-BBox"] = json.dumps(bbox, separators=(",", ":"))
        return Response(content, media_type=media_type, headers=headers)

    @app.post("/api/devices/{duid}/obstacle-ignore")
    async def obstacle_ignore(duid: str, body: dict[str, Any] = Body(...)):
        try:
            return await (await ctrl(duid)).ignore_obstacle(body.get("photo_ids", []))
        except ValueError as err:
            raise HTTPException(400, str(err)) from err

    @app.get("/api/devices/{duid}/settings")
    async def settings(duid: str):
        return await (await ctrl(duid)).settings()

    @app.get("/api/devices/{duid}/estimates")
    async def estimates(duid: str):
        return await (await ctrl(duid)).estimates()

    @app.get("/api/devices/{duid}/freshness")
    async def freshness(duid: str):
        return await (await ctrl(duid)).freshness()

    @app.get("/api/devices/{duid}/runs")
    async def runs(duid: str):
        return await (await ctrl(duid)).runs()

    @app.get("/api/devices/{duid}/history-backup")
    async def history_backup(duid: str):
        data = (await ctrl(duid)).history.export_backup()
        return JSONResponse(
            data,
            headers={"Content-Disposition": 'attachment; filename="roborock-history-backup.json"'},
        )

    @app.post("/api/devices/{duid}/history-backup")
    async def restore_history_backup(duid: str, body: dict[str, Any] = Body(...)):
        try:
            (await ctrl(duid)).history.import_backup(body)
        except (TypeError, ValueError) as err:
            raise HTTPException(400, str(err)) from err
        return {"ok": True}

    @app.get("/api/devices/{duid}/runs/{run_id}")
    async def run_detail(duid: str, run_id: str, cached: bool = False):
        controller = await ctrl(duid)
        detail = controller.history.detail(run_id) if cached and not demo else await controller.run_detail(run_id)
        if detail is None:
            raise HTTPException(404, "Cleaning run not found")
        if not demo:
            detail["needs_timeline"] = controller.needs_timeline(run_id)
        return detail

    @app.get("/api/devices/{duid}/runs/{run_id}/diagnostics")
    async def run_diagnostics(duid: str, run_id: str):
        data = await (await ctrl(duid)).run_diagnostics(run_id)
        return JSONResponse(
            data,
            headers={"Content-Disposition": f'attachment; filename="roborock-run-{run_id}-source.json"'},
        )

    @app.delete("/api/devices/{duid}/runs/{run_id}", status_code=204)
    async def delete_run(duid: str, run_id: str):
        await (await ctrl(duid)).delete_run(run_id)

    @app.get("/api/devices/{duid}/suspects")
    async def suspects(duid: str):
        return await (await ctrl(duid)).suspects()

    @app.post("/api/devices/{duid}/suspects/name")
    async def name_suspect(duid: str, x: int = Body(...), y: int = Body(...), name: str = Body("")):
        return await (await ctrl(duid)).name_suspect(x, y, name)

    @app.post("/api/devices/{duid}/action")
    async def action(duid: str, body: dict[str, Any] = Body(...)):
        name = body.pop("action", None)
        if not name:
            raise HTTPException(400, "Missing action")
        return await (await ctrl(duid)).action(name, body)

    @app.get("/")
    async def index():
        if not BUNDLE.exists():
            return HTMLResponse(
                "<p style='font:16px system-ui;margin:40px'>The interface isn't built yet. Start the app with "
                "<code>start.command</code>, or run <code>npm install</code> and <code>npm run build</code>.</p>",
                status_code=503,
            )
        return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-store"})

    app.mount("/static", StaticFiles(directory=STATIC), name="static")
    return app


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--demo", action="store_true", help="run with a simulated robot")
    parser.add_argument("--host", default="127.0.0.1", help="use 0.0.0.0 to open it from your phone on the LAN")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true", help="don't open the browser on start")
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.debug else logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    data_dir = None if args.demo else persistent_data_dir(ROOT)
    if not args.demo:
        # Keep a small diagnostic log alongside persistent local app data.
        log_file = RotatingFileHandler(data_dir / "app.log", maxBytes=1_000_000, backupCount=2)
        log_file.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
        logging.getLogger().addHandler(log_file)
    url = f"http://localhost:{args.port}"
    print(f"\n  Roborock is running at {url}" + ("  (demo mode)" if args.demo else "") + "\n  Press Ctrl+C to stop.\n")
    if not args.no_browser:
        threading.Timer(1.2, webbrowser.open, [url]).start()
    uvicorn.run(create_app(args.demo, data_dir), host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
