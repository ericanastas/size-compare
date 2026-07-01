import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import type { SizeObject } from "./types";

const BOX_OPACITY = 0.35;

function hasDimensionsChanged(previous: SizeObject | undefined, current: SizeObject): boolean {
  if (!previous) return false;
  return (
    previous.name !== current.name ||
    previous.width !== current.width ||
    previous.height !== current.height ||
    previous.depth !== current.depth ||
    previous.color !== current.color
  );
}

export interface SceneManager {
  syncObjects(objects: readonly SizeObject[]): void;
  select(id: string | null): void;
  onSelect(callback: (id: string | null) => void): void;
  resize(): void;
  render(): void;
}

export function createSceneManager(container: HTMLElement): SceneManager {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1d22);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  camera.position.set(18, 14, 22);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.style.position = "absolute";
  labelRenderer.domElement.style.top = "0";
  labelRenderer.domElement.style.left = "0";
  labelRenderer.domElement.style.pointerEvents = "none";
  container.appendChild(labelRenderer.domElement);

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const directional = new THREE.DirectionalLight(0xffffff, 0.9);
  directional.position.set(12, 20, 10);
  scene.add(directional);

  const grid = new THREE.GridHelper(60, 60, 0x444444, 0x2a2d33);
  scene.add(grid);

  const orbitControls = new OrbitControls(camera, renderer.domElement);
  orbitControls.target.set(0, 2, 0);
  orbitControls.enableDamping = true;

  const transformControls = new TransformControls(camera, renderer.domElement);
  transformControls.setMode("translate");
  scene.add(transformControls.getHelper());
  transformControls.addEventListener("dragging-changed", (event) => {
    orbitControls.enabled = !event.value;
  });
  transformControls.addEventListener("objectChange", () => {
    if (!selectedId) return;
    const object = lastSeen.get(selectedId);
    const group = groups.get(selectedId);
    if (!object || !group) return;
    const minY = object.height / 2;
    if (group.position.y < minY) {
      group.position.y = minY;
    }
  });

  const groups = new Map<string, THREE.Group>();
  const lastSeen = new Map<string, SizeObject>();
  const meshToId = new Map<THREE.Mesh, string>();
  const selectListeners: Array<(id: string | null) => void> = [];
  let selectedId: string | null = null;

  function buildGroup(object: SizeObject): THREE.Group {
    const group = new THREE.Group();
    group.position.set(object.position.x, object.position.y, object.position.z);

    const geometry = new THREE.BoxGeometry(object.width, object.height, object.depth);
    const material = new THREE.MeshStandardMaterial({
      color: object.color,
      transparent: true,
      opacity: BOX_OPACITY,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    group.add(mesh);
    meshToId.set(mesh, object.id);

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({ color: object.color }),
    );
    group.add(edges);

    const labelEl = document.createElement("div");
    labelEl.className = "object-label";
    labelEl.textContent = object.name;
    const label = new CSS2DObject(labelEl);
    label.position.set(0, object.height / 2 + 0.6, 0);
    group.add(label);

    return group;
  }

  function updateGroup(group: THREE.Group, object: SizeObject): void {
    const mesh = group.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh);
    const edges = group.children.find((c): c is THREE.LineSegments => c instanceof THREE.LineSegments);
    const label = group.children.find((c): c is CSS2DObject => c instanceof CSS2DObject);
    if (!mesh || !edges || !label) return;

    mesh.geometry.dispose();
    mesh.geometry = new THREE.BoxGeometry(object.width, object.height, object.depth);
    (mesh.material as THREE.MeshStandardMaterial).color.setHex(object.color);

    edges.geometry.dispose();
    edges.geometry = new THREE.EdgesGeometry(mesh.geometry);
    (edges.material as THREE.LineBasicMaterial).color.setHex(object.color);

    label.element.textContent = object.name;
    label.position.set(0, object.height / 2 + 0.6, 0);
  }

  function disposeGroup(group: THREE.Group): void {
    group.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
        meshToId.delete(child);
      } else if (child instanceof THREE.LineSegments) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      } else if (child instanceof CSS2DObject) {
        child.element.remove();
      }
    });
  }

  function select(id: string | null): void {
    selectedId = id;
    const group = id ? groups.get(id) ?? null : null;
    if (group) {
      transformControls.attach(group);
    } else {
      transformControls.detach();
    }
    for (const listener of selectListeners) listener(selectedId);
  }

  function syncObjects(objects: readonly SizeObject[]): void {
    const currentIds = new Set(objects.map((o) => o.id));

    for (const [id, group] of groups) {
      if (!currentIds.has(id)) {
        if (selectedId === id) select(null);
        disposeGroup(group);
        scene.remove(group);
        groups.delete(id);
        lastSeen.delete(id);
      }
    }

    for (const object of objects) {
      const existing = groups.get(object.id);
      if (!existing) {
        const group = buildGroup(object);
        groups.set(object.id, group);
        scene.add(group);
      } else if (hasDimensionsChanged(lastSeen.get(object.id), object)) {
        updateGroup(existing, object);
      }
      lastSeen.set(object.id, object);
    }

    frameScene(objects);
  }

  function frameScene(objects: readonly SizeObject[]): void {
    if (objects.length === 0) return;

    const box = new THREE.Box3();
    for (const object of objects) {
      const halfWidth = object.width / 2;
      const halfHeight = object.height / 2;
      const halfDepth = object.depth / 2;
      box.expandByPoint(
        new THREE.Vector3(
          object.position.x - halfWidth,
          object.position.y - halfHeight,
          object.position.z - halfDepth,
        ),
      );
      box.expandByPoint(
        new THREE.Vector3(
          object.position.x + halfWidth,
          object.position.y + halfHeight,
          object.position.z + halfDepth,
        ),
      );
    }

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 1);
    const distance = radius / Math.sin((camera.fov * Math.PI) / 360) + radius;

    const direction = new THREE.Vector3(0.6, 0.45, 0.9).normalize();
    camera.position.copy(center).addScaledVector(direction, distance);
    camera.near = Math.max(distance / 100, 0.1);
    camera.far = distance * 20;
    camera.updateProjectionMatrix();

    orbitControls.target.copy(center);
    orbitControls.update();
  }

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  renderer.domElement.addEventListener("pointerdown", (event) => {
    if (transformControls.dragging) return;

    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(pointer, camera);
    const meshes = Array.from(meshToId.keys());
    const intersections = raycaster.intersectObjects(meshes, false);

    if (intersections.length > 0) {
      const mesh = intersections[0].object as THREE.Mesh;
      select(meshToId.get(mesh) ?? null);
    } else {
      select(null);
    }
  });

  function resize(): void {
    const width = container.clientWidth;
    const height = container.clientHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    labelRenderer.setSize(width, height);
  }

  function render(): void {
    orbitControls.update();
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
  }

  return {
    syncObjects,
    select,
    onSelect: (callback) => selectListeners.push(callback),
    resize,
    render,
  };
}
