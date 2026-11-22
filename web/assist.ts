// AI assistant: a ⌘K palette that turns a plain request into robot steps (nothing moves until
// Run), "Explain" for past runs, and the Settings card for the Anthropic API key.

import { api, devicePath } from "./api";
import { $opt, closest, esc, errorMessage, icon, toast } from "./dom";
import { refreshMapOverlays } from "./map/core";
import { doAction } from "./panels";
import { S } from "./state";

interface Step {
  action: string;
  params: Record<string, unknown>;
}
interface Plan {
  say: string;
  actions: Step[];
}
interface AiState {
  configured: boolean;
  source: string | null;
}

const NOT_SET_UP = "Add your Anthropic API key in Settings → AI assistant";
let ai: AiState | null = null;
let plan: Plan | null = null;
let busy = false;
const explained = new Map<number, string>();

async function loadAi(): Promise<AiState> {
  ai = await api<AiState>("/api/ai");
  return ai;
}

/* ---------------- palette ---------------- */

const roomName = (id: unknown): string => S.map?.rooms?.find((r) => r.id === id)?.name ?? `Room ${String(id)}`;

const LABELS: Record<string, string> = {
  start: "Clean the whole home", pause: "Pause", resume: "Resume", stop: "Stop", dock: "Go back to the dock",
  locate: "Beep so you can find it", empty_bin: "Empty the bin", wash_mop: "Wash the mop",
};

function stepText(s: Step): string {
  const p = s.params;
  const times = (n: unknown): string => (Number(n) > 1 ? `, ${Number(n)} passes` : "");
  switch (s.action) {
    case "clean_rooms":
      return `Clean ${((p.rooms as number[]) ?? []).map(roomName).join(", ")}${times(p.repeat)}`;
    case "start":
      return `Clean the whole home${times(p.repeat)}`;
    case "set_repeat":
      return `Set passes to ${Number(p.repeat)}`;
    case "set_cleaning_mode":
      return `Switch to ${String(p.mode).replace(/_/g, " ")}`;
    case "set_fan":
    case "set_water":
    case "set_mop": {
      const kind = s.action.slice(4) as "fan" | "water" | "mop";
      const opts = (S.status?.mode?.[`${kind}_options`] ?? []) as { code: number; name: string }[];
      const name = opts.find((o) => o.code === p.code)?.name ?? String(p.code);
      return `Set ${kind === "fan" ? "suction" : kind} to ${name.replace(/_/g, " ")}`;
    }
    default:
      return LABELS[s.action] ?? s.action;
  }
}

function palette(): HTMLElement {
  let el = $opt("#assist");
  if (el) return el;
  el = document.createElement("div");
  el.id = "assist";
  el.className = "assist-backdrop";
  el.hidden = true;
  const mic = "webkitSpeechRecognition" in window || "SpeechRecognition" in window;
  el.innerHTML = `<div class="assist" role="dialog" aria-modal="true" aria-label="Ask">
    <form class="assist-form">
      <span class="assist-spark">${icon("spark")}</span>
      <input id="assist-input" type="text" autocomplete="off" placeholder="Clean the kitchen twice, or ask what got missed" aria-label="What should it do?">
      ${mic ? `<button type="button" class="assist-mic" data-ai="mic" title="Speak" aria-label="Speak">${icon("mic")}</button>` : ""}
    </form>
    <div class="assist-body" id="assist-body"></div>
  </div>`;
  document.body.append(el);
  el.addEventListener("click", (e) => {
    if (e.target === el) closePalette();
  });
  el.querySelector("form")!.addEventListener("submit", (e) => {
    e.preventDefault();
    void ask();
  });
  return el;
}

function body(html: string): void {
  $opt("#assist-body")!.innerHTML = html;
}

export async function openPalette(): Promise<void> {
  const el = palette();
  el.hidden = false;
  const input = $opt<HTMLInputElement>("#assist-input")!;
  input.focus();
  input.select();
  if (!plan) body(`<p class="assist-hint">Tell it what to do in your own words. You'll see the steps before anything moves.</p>`);
  try {
    if (!(ai ?? (await loadAi())).configured) body(`<p class="assist-hint">${esc(NOT_SET_UP)}.</p>`);
  } catch {
    // shown when asking
  }
}

function closePalette(): void {
  const el = $opt("#assist");
  if (el) el.hidden = true;
}

function renderPlan(): void {
  if (!plan) return;
  const steps = plan.actions;
  body(`${plan.say ? `<p class="assist-say">${esc(plan.say)}</p>` : ""}
    ${steps.length ? `<ol class="assist-steps">${steps.map((s) => `<li>${esc(stepText(s))}</li>`).join("")}</ol>
    <div class="assist-buttons"><button class="btn-soft" data-ai="cancel">Cancel</button>
      <button class="btn-primary" data-ai="run">${icon("play")}<span>Run</span></button></div>` : ""}`);
}

async function ask(): Promise<void> {
  const input = $opt<HTMLInputElement>("#assist-input")!;
  const text = input.value.trim();
  if (!text || busy) return;
  if (!S.duid) return body(`<p class="assist-hint">No robot selected yet.</p>`);
  busy = true;
  plan = null;
  body(`<p class="assist-hint assist-wait">Thinking…</p>`);
  try {
    plan = await api<Plan>(devicePath("ai/plan"), { method: "POST", body: { text } });
    // Show the rooms it means on the map; nothing runs until Run.
    const rooms = plan.actions.filter((s) => s.action === "clean_rooms").flatMap((s) => (s.params.rooms as number[]) ?? []);
    if (rooms.length) {
      S.selected = [...new Set(rooms)];
      refreshMapOverlays();
    }
    renderPlan();
  } catch (e) {
    body(`<p class="assist-hint assist-err">${esc(errorMessage(e))}</p>`);
  } finally {
    busy = false;
  }
}

async function runPlan(btn: HTMLButtonElement): Promise<void> {
  if (!plan || busy) return;
  busy = true;
  btn.disabled = true;
  const steps = plan.actions;
  try {
    for (const s of steps) await doAction(s.action, s.params, { quiet: true });
    toast("Done");
    plan = null;
    closePalette();
  } catch {
    // doAction already showed the error
  } finally {
    busy = false;
    btn.disabled = false;
  }
}

function listen(): void {
  const SR = (window as unknown as Record<string, unknown>).webkitSpeechRecognition ?? (window as unknown as Record<string, unknown>).SpeechRecognition;
  if (!SR) return;
  const rec = new (SR as new () => { lang: string; onresult: (e: { results: { 0: { transcript: string } }[] }) => void; onend: () => void; start: () => void })();
  rec.lang = navigator.language || "en-US";
  const mic = $opt(".assist-mic");
  mic?.classList.add("on");
  rec.onresult = (e) => {
    const input = $opt<HTMLInputElement>("#assist-input")!;
    input.value = e.results[0][0].transcript;
    void ask();
  };
  rec.onend = () => mic?.classList.remove("on");
  rec.start();
}

/* ---------------- explain a run ---------------- */

/** The answer slot under a run in Recent runs (keeps answers across re-renders). */
export function explainHtml(begin: number): string {
  const said = explained.get(begin);
  return `<button class="link ai-explain" data-ai="explain" data-begin="${begin}">Explain</button>
    <div class="ai-answer" data-begin="${begin}" ${said ? "" : "hidden"}>${esc(said ?? "")}</div>`;
}

async function explain(btn: HTMLButtonElement): Promise<void> {
  const begin = Number(btn.dataset.begin);
  const slot = btn.parentElement?.querySelector<HTMLElement>(`.ai-answer[data-begin="${begin}"]`);
  if (!slot) return;
  const show = (t: string): void => {
    slot.hidden = false;
    slot.textContent = t;
  };
  if (!(ai ?? (await loadAi().catch(() => null)))?.configured) return show(`${NOT_SET_UP}.`);
  show("Thinking…");
  try {
    const r = await api<{ say: string }>(devicePath("ai/explain"), { method: "POST", body: { run_begin: begin } });
    explained.set(begin, r.say);
    show(r.say);
  } catch (e) {
    show(errorMessage(e));
  }
}

/* ---------------- settings card ---------------- */

export function aiCardHtml(): string {
  return `<div class="card" id="ai-card"><div class="card-head"><h3 class="card-title">${icon("spark")}AI assistant</h3></div><div id="ai-card-body"><div class="skel" style="height:40px"></div></div></div>`;
}

export async function renderAiCard(): Promise<void> {
  const el = $opt("#ai-card-body");
  if (!el) return;
  let st: AiState;
  try {
    st = await loadAi();
  } catch (e) {
    el.innerHTML = `<p class="muted">${esc(errorMessage(e))}</p>`;
    return;
  }
  const where = st.source === "settings" ? "Using the key saved here" : st.source === "environment" ? "Using ANTHROPIC_API_KEY" : st.source === "profile" ? "Using your Anthropic login" : "Not set up";
  el.innerHTML = `<div class="ai-status ${st.configured ? "ok" : ""}">${icon(st.configured ? "check" : "info", "i tiny")}${where}</div>
    <form class="ai-key" id="ai-key-form">
      <input type="password" id="ai-key" autocomplete="off" placeholder="${st.source === "settings" ? "••••••••" : "Anthropic API key"}" aria-label="Anthropic API key">
      <button class="btn-soft" type="submit">Save</button>
      ${st.source === "settings" ? `<button class="btn-soft danger" type="button" data-ai="remove-key">Remove</button>` : ""}
    </form>
    <div class="note">Press ⌘K (Ctrl+K) or Ask on the map. Your requests, room names and cleaning history go to Anthropic when you use AI.</div>`;
  $opt("#ai-key-form")!.addEventListener("submit", (e) => {
    e.preventDefault();
    const key = $opt<HTMLInputElement>("#ai-key")!.value.trim();
    if (key) void saveKey(key);
  });
}

async function saveKey(key: string): Promise<void> {
  try {
    ai = await api<AiState>("/api/ai/key", { method: "POST", body: { key } });
    toast(key ? "Key saved" : "Key removed");
  } catch (e) {
    toast(errorMessage(e), true);
  }
  void renderAiCard();
}

/* ---------------- wiring ---------------- */

export function initAssist(): void {
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      void openPalette();
    } else if (e.key === "Escape" && !($opt("#assist")?.hidden ?? true)) {
      closePalette();
    }
  });
  document.addEventListener("click", (e) => {
    const b = closest<HTMLButtonElement>(e.target, "[data-ai]");
    if (!b) return;
    switch (b.dataset.ai) {
      case "open": return void openPalette();
      case "cancel":
        plan = null;
        return closePalette();
      case "run": return void runPlan(b);
      case "mic": return listen();
      case "explain": return void explain(b);
      case "remove-key": return void saveKey("");
    }
  });
}
