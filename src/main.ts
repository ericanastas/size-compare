import { ObjectStore } from "./state";
import { createSceneManager } from "./sceneManager";
import { createSidebar } from "./sidebar";
import { buildShareUrl, decodeStateFromLocation } from "./urlState";

const sidebarEl = document.getElementById("sidebar");
const viewportEl = document.getElementById("viewport");
if (!sidebarEl || !viewportEl) {
  throw new Error("Missing #sidebar or #viewport element");
}

const store = new ObjectStore();
const sceneManager = createSceneManager(viewportEl);

// Reflects live drag/resize state (from the scene), not just the store's
// last known values — used so Save CSV and the share link both capture
// what's actually on screen right now.
const getLiveObjects = () =>
  store.objects.map((o) => ({
    ...o,
    ...(sceneManager.getDimensions(o.id) ?? {}),
    position: sceneManager.getPosition(o.id) ?? o.position,
  }));

const sidebar = createSidebar(
  sidebarEl,
  store,
  (id, additive) => sceneManager.select(id, additive),
  () => window.location.href,
  getLiveObjects,
);

store.subscribe((objects) => sceneManager.syncObjects(objects));
sceneManager.onSelect((ids) => sidebar.setSelected(ids));

const sharedObjects = decodeStateFromLocation();
if (sharedObjects) {
  store.loadFull(sharedObjects);
}

// Keeps the address bar itself a live, refresh-safe, ready-to-copy snapshot
// of the scene — for any scene, not just ones loaded from a share link.
// Registered after the share-link load above: store.subscribe() invokes its
// callback immediately, so subscribing any earlier would strip the `state`
// param before decodeStateFromLocation() ever got to read it.
function syncUrl(): void {
  const objects = getLiveObjects();
  if (objects.length === 0) {
    history.replaceState(null, "", window.location.pathname);
  } else {
    history.replaceState(null, "", buildShareUrl(objects));
  }
}

store.subscribe(syncUrl);

// Reconcile the store with the scene once a translate- or resize-drag
// finishes — this also triggers syncUrl via the store.subscribe above, so no
// separate call is needed here.
sceneManager.onDragEnd(() => store.syncGeometry(getLiveObjects()));

sceneManager.resize();
window.addEventListener("resize", () => sceneManager.resize());

function animate() {
  sceneManager.render();
  requestAnimationFrame(animate);
}
animate();
