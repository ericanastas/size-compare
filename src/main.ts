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
const sidebar = createSidebar(
  sidebarEl,
  store,
  (id, additive) => sceneManager.select(id, additive),
  () =>
    buildShareUrl(
      store.objects.map((o) => ({
        ...o,
        position: sceneManager.getPosition(o.id) ?? o.position,
      })),
    ),
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
