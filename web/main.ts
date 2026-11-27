// Entry point: global button handling and start-up.

import { $, $$, $opt, closest, icon } from "./dom";
import { clearMapHistory, closeMapHistory, compareMapSnapshots, mapEmpty, previewMapSnapshot, refreshMapOverlays, setTool, showMapHistory } from "./map/core";
import { fitMap } from "./map/fit";
import {
  clearEditPicks, deleteSelected, discardEdits, endEdit, mergeRooms, renameRoom, saveRestrictions,
  resetRoomColour, setEditMode, setEditTool, splitRoom, startEdit, undoEdit,
} from "./map/editor";
import { centerOnRobot, resetView } from "./map/panzoom";
import { get3D, setViewMode, show3D, syncViewChrome } from "./map/views";
import { renderFreshPanel } from "./freshness";
import { resetSuspects } from "./suspects";
import { setNotify } from "./notify";
import { doAction, renderActions, renderSkeletons, renderStatus, setHomePasses, setModeValue } from "./panels";
import { logout, reconnect, refreshAuth, startLoops } from "./session";
import { loadSettings, setChoice } from "./settings";
import { S, type EditTool, type ViewMode } from "./state";
import { deletePreset, presets, restoreZone, savePlan, saveZone } from "./presets";
import "./theme";
import { initAssist } from "./assist";

initAssist();

// Bring the robot into view, wherever it is: switch to Home, then center on it.
function showRobot(): void {
  if (S.tab !== "home") ($opt<HTMLButtonElement>('[data-tab="home"]'))?.click();
  const m3 = get3D();
  if (S.viewMode === "3d" && m3) m3.centerOnRobot();
  else centerOnRobot();
}

document.addEventListener("click", async (e) => {
  const t = closest<HTMLButtonElement>(e.target, "button");
  if (!t) return;
  const ds = t.dataset;

  if (ds.tab) {
    S.tab = ds.tab === "settings" ? "settings" : "home";
    $$(".tabs button").forEach((b) => {
      b.classList.toggle("active", b === t);
      b.setAttribute("aria-current", b === t ? "page" : "false");
    });
    $("#tab-home").hidden = S.tab !== "home";
    $("#tab-settings").hidden = S.tab !== "settings";
    if (S.tab === "settings") void loadSettings();
    else fitMap();
    window.scrollTo({ top: 0 });
    return;
  }
  if (ds.snapshot) return previewMapSnapshot(ds.snapshot);
  if (ds.view) return setViewMode(ds.view as ViewMode);
  if (ds.etool) return setEditTool(ds.etool as EditTool);
  if (ds.emode) return setEditMode(ds.emode === "rooms" ? "rooms" : "walls");
  if (ds.homePasses) return setHomePasses(Number(ds.homePasses));
  if (ds.repeat) {
    S.repeat = Number(ds.repeat);
    renderActions();
    return;
  }
  if (ds.cmode) return setModeValue("cleaning", ds.cmode, "set_cleaning_mode", { mode: ds.cmode });
  if (ds.fan) return setModeValue("fan", Number(ds.fan), "set_fan", { code: Number(ds.fan) });
  if (ds.water) return setModeValue("water", Number(ds.water), "set_water", { code: Number(ds.water) });
  if (ds.mop) return setModeValue("mop", Number(ds.mop), "set_mop", { code: Number(ds.mop) });
  if (ds.choice && ds.value) return setChoice(ds.choice, ds.value);
  if (ds.reset) {
    const name = ds.name ?? "part";
    if (!confirm(`Reset the ${name.toLowerCase()} counter? Do this after cleaning or replacing it.`)) return;
    try {
      await doAction("reset_consumable", { key: ds.reset }, { okMsg: `${name} reset` });
      void loadSettings();
    } catch {
      // toast shown
    }
    return;
  }
  if (ds.routine) {
    doAction("run_routine", { id: Number(ds.routine) }, { button: t }).catch(() => {});
    return;
  }
  if (ds.savedZone && S.map) {
    const rect = restoreZone(ds.savedZone, S.map);
    if (rect) { setTool("zone"); S.zone = rect; refreshMapOverlays(); }
    return;
  }
  if (ds.savedPlan) {
    const plan = presets().plans.find((item) => item.id === ds.savedPlan);
    if (!plan) return;
    setTool("rooms");
    const valid = new Set(S.map?.rooms.map((room) => room.id) ?? []);
    S.selected = plan.rooms.filter((room) => valid.has(room));
    S.repeat = plan.repeat;
    if (plan.cleaning) await setModeValue("cleaning", plan.cleaning, "set_cleaning_mode", { mode: plan.cleaning });
    if (plan.fan != null) await setModeValue("fan", plan.fan, "set_fan", { code: plan.fan });
    if (plan.water != null) await setModeValue("water", plan.water, "set_water", { code: plan.water });
    if (plan.mop != null) await setModeValue("mop", plan.mop, "set_mop", { code: plan.mop });
    refreshMapOverlays();
    return;
  }
  if (ds.deletePreset && ds.presetKind) {
    deletePreset(ds.presetKind === "zone" ? "zone" : "plan", ds.deletePreset);
    return loadSettings();
  }

  const act = ds.act;
  if (!act) return;
  switch (act) {
    case "reload":
      return location.reload();
    case "logout":
      return logout();
    case "reconnect":
      return reconnect(t);
    case "show-robot":
      return showRobot();
    case "notify-on":
      await setNotify(true);
      return renderStatus();
    case "refresh-settings":
      return loadSettings();
    case "dismiss-update":
      S.updateDismissed = true;
      $("#update-banner").hidden = true;
      return;
    case "clear-map-history":
      if (confirm("Clear saved map versions for this robot from this browser?")) clearMapHistory();
      return;
    case "save-zone": {
      if (!S.zone || !S.map) return;
      const name = prompt("Name this cleaning zone:")?.trim();
      if (!name) return;
      saveZone(name, S.zone, S.map);
      refreshMapOverlays();
      return;
    }
    case "save-plan": {
      if (!S.selected.length) return;
      const name = prompt("Name this cleaning plan:")?.trim();
      if (!name) return;
      savePlan(name, S.selected, S.repeat ?? S.status?.mode?.repeat ?? 1);
      refreshMapOverlays();
      return;
    }
    case "history-open":
      return showMapHistory();
    case "history-compare":
      return compareMapSnapshots($<HTMLSelectElement>("#history-before").value, $<HTMLSelectElement>("#history-after").value);
    case "history-close":
    case "history-toggle":
      return closeMapHistory();
    case "edit-start":
      return startEdit();
    case "edit-done":
      return endEdit();
    case "edit-save":
      return saveRestrictions(t);
    case "edit-undo":
      return undoEdit();
    case "edit-delete":
      return deleteSelected();
    case "edit-discard":
      return discardEdits();
    case "edit-clear":
      return clearEditPicks();
    case "room-merge":
      return mergeRooms(t);
    case "room-split":
      return splitRoom(t);
    case "room-reset-name":
      return renameRoom("", t);
    case "room-reset-colour":
      return resetRoomColour();
    case "clear-sel":
      return clearPicks();
    default:
      if (act === "stop" && S.status?.job && !confirm("Stop the current cleaning job?")) return;
      doAction(act, {}, { button: t }).catch(() => {});
  }
});

// Escape lets go of the rooms, zone or spot picked on the map (the editor has its own keys).
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || S.edit || S.tab !== "home" || closest(e.target, "input, select, textarea")) return;
  if (!S.selected.length && !S.zone && !S.pin) return;
  clearPicks();
});

function clearPicks(): void {
  S.selected = [];
  S.zone = null;
  S.pin = null;
  S.drag = null; // a zone still being dragged out
  refreshMapOverlays();
  renderFreshPanel(); // its room rows show what's picked too
}

$<HTMLSelectElement>("#device-select").addEventListener("change", (e) => {
  S.duid = (e.target as HTMLSelectElement).value;
  try {
    localStorage.setItem("duid", S.duid);
  } catch {
    // storage blocked
  }
  endEdit(true);
  S.status = null;
  S.map = null;
  S.mask = null;
  S.settings = null;
  S.fresh = null;
  S.freshAge = null;
  S.sus = null;
  S.susHeat = null;
  resetSuspects();
  resetView(false);
  S.selected = [];
  S.zone = null;
  S.pin = null;
  mapEmpty(`<div class="spinner"></div>Loading map…`);
  renderSkeletons();
  startLoops();
  if (S.tab === "settings") void loadSettings();
});

/* ---------------- start-up ---------------- */
syncViewChrome();
if (S.viewMode === "3d") void show3D();
$$("[data-icon]").forEach((el) => {
  el.innerHTML = icon(el.dataset.icon ?? "");
});
void refreshAuth();
