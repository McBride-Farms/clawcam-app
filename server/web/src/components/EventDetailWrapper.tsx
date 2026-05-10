import { createSignal, onMount, Show, type Component } from "solid-js";
import EventDetail from "./EventDetail";

// Reads the event id from the URL query string (`?id=…`) after the page
// has hydrated, so the dynamic detail view works under Astro's static
// output without enumerating all ids at build time. EventsList links
// to `/event?id=<uuid>` so this is the only entry point.
const EventDetailWrapper: Component = () => {
  const [id, setId] = createSignal<string | null>(null);

  onMount(() => {
    const u = new URL(window.location.href);
    setId(u.searchParams.get("id"));
  });

  return (
    <Show
      when={id()}
      fallback={
        <div class="empty-state">No event id in URL.</div>
      }
    >
      {(eid) => <EventDetail id={eid()} />}
    </Show>
  );
};

export default EventDetailWrapper;
