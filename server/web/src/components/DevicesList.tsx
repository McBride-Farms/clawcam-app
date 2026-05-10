import {
  For,
  Show,
  createResource,
  createSignal,
  type Component,
} from "solid-js";
import { api } from "~/lib/api";
import type { Device } from "@shared/types";

// Relative-time formatter, ported verbatim from app.js lines 13-22. Falls
// back to the locale string for anything older than a day so the user can
// see the actual date instead of a misleading "1d ago".
function fmtTime(epoch: number | null | undefined): string {
  if (!epoch) return "";
  const d = new Date(epoch * 1000);
  const now = Date.now();
  const diff = (now - d.getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleString();
}

// Per-device card. Each card owns its own "dirty / saving / saved" state
// because the Save button only enables when *this* textarea diverges from
// the *originally loaded* value for *this* device — two cards must not
// share a signal or saving one would clobber the other's button state.
const DeviceCard: Component<{ device: Device }> = (props) => {
  const [value, setValue] = createSignal<string>(props.device.system_prompt ?? "");
  const [initial, setInitial] = createSignal<string>(props.device.system_prompt ?? "");
  const [saving, setSaving] = createSignal<boolean>(false);
  const [status, setStatus] = createSignal<string>("");

  const isDirty = () => value() !== initial();
  const isDisabled = () => saving() || !isDirty();

  let clearTimer: ReturnType<typeof setTimeout> | null = null;

  const onSave = async () => {
    setSaving(true);
    setStatus("saving…");
    if (clearTimer) {
      clearTimeout(clearTimer);
      clearTimer = null;
    }
    try {
      const r = await api.setDeviceSystemPrompt(props.device.host, value());
      const newVal = r.device.system_prompt ?? "";
      setValue(newVal);
      setInitial(newVal);
      setStatus("saved");
      clearTimer = setTimeout(() => setStatus(""), 2000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus(`error: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="device">
      <div class="device-head">
        <div>
          <div class="host">{props.device.name || props.device.host}</div>
          <div class="mute">{props.device.host}</div>
        </div>
        <div class="mute">{props.device.event_count} events</div>
        <div class="mute">first: {fmtTime(props.device.first_seen)}</div>
        <div class="mute">last: {fmtTime(props.device.last_seen)}</div>
      </div>
      <div class="device-prompt">
        <label class="prompt-label">
          Vision prompt for this camera
          <span class="mute">
            {" "}— steers what the model treats as routine vs. interesting. Leave blank for the generic prompt.
          </span>
        </label>
        <textarea
          class="prompt-input"
          rows={3}
          placeholder="e.g. Front-door camera. Treat any unfamiliar person or vehicle as suggested_action=alert. Mail delivery and the homeowner's silver pickup are routine."
          value={value()}
          onInput={(e) => setValue(e.currentTarget.value)}
        />
        <div class="prompt-actions">
          <span class="prompt-status mute">{status()}</span>
          <button
            class="prompt-save"
            disabled={isDisabled()}
            onClick={onSave}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
};

const DevicesList: Component = () => {
  const [data] = createResource<{ devices: Device[] }>(() => api.devices());

  return (
    <div>
      <Show when={data.loading}>
        <div class="empty-state">Loading…</div>
      </Show>
      <Show when={data.error}>
        <div class="empty-state">
          Failed to load devices: {String(data.error)}
        </div>
      </Show>
      <Show when={data() && !data.loading}>
        <Show
          when={(data()?.devices ?? []).length > 0}
          fallback={
            <div class="empty-state">No devices have reported yet.</div>
          }
        >
          <For each={data()?.devices ?? []}>
            {(device) => <DeviceCard device={device} />}
          </For>
        </Show>
      </Show>
    </div>
  );
};

export default DevicesList;
