import { ObjectStore } from "./state";
import { createSceneManager } from "./sceneManager";
import { createSidebar } from "./sidebar";

const sidebarEl = document.getElementById("sidebar");
const viewportEl = document.getElementById("viewport");
if (!sidebarEl || !viewportEl) {
  throw new Error("Missing #sidebar or #viewport element");
}

const store = new ObjectStore();
const sceneManager = createSceneManager(viewportEl);
const sidebar = createSidebar(sidebarEl, store, (id) => sceneManager.select(id));

store.subscribe((objects) => sceneManager.syncObjects(objects));
sceneManager.onSelect((id) => sidebar.setSelected(id));

sceneManager.resize();
window.addEventListener("resize", () => sceneManager.resize());

function animate() {
  sceneManager.render();
  requestAnimationFrame(animate);
}
animate();
