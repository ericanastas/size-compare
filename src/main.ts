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

// Reflects live drag positions (from the scene), not just the store's last
// known ones — used so Save CSV and the share link both capture what's
// actually on screen right now.
const getLiveObjects = () =>
  store.objects.map((o) => ({
    ...o,
    position: sceneManager.getPosition(o.id) ?? o.position,
  }));

const sidebar = createSidebar(
  sidebarEl,
  store,
  (id, additive) => sceneManager.select(id, additive),
  () => buildShareUrl(getLiveObjects()),
  getLiveObjects,
);

store.subscribe((objects) => sceneManager.syncObjects(objects));
sceneManager.onSelect((ids) => sidebar.setSelected(ids));

const sharedObjects = decodeStateFromLocation();
if (sharedObjects) {
  store.loadFull(sharedObjects);
}

sceneManager.resize();
window.addEventListener("resize", () => sceneManager.resize());

function animate() {
  sceneManager.render();
  requestAnimationFrame(animate);
}
animate();
