import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import type { SizeObject } from "./types";

const BOX_OPACITY = 0.35;
const SELECTION_OUTLINE_COLOR = 0x4a7dfc;

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

export type ProjectionMode = "perspective" | "orthographic";
export type StandardView = "front" | "back" | "top" | "bottom" | "left" | "right";

export interface SceneManager {
  syncObjects(objects: readonly SizeObject[]): void;
  select(id: string | null, additive?: boolean): void;
  onSelect(callback: (ids: string[]) => void): void;
  onDragEnd(callback: () => void): void;
  setProjection(mode: ProjectionMode): void;
  setStandardView(view: StandardView): void;
  zoomExtents(): void;
  getPosition(id: string): { x: number; y: number; z: number } | null;
  resize(): void;
  render(): void;
}

// OrbitControls always orbits around world "up" (0, 1, 0) — that's what keeps the
// vertical axis vertical while dragging. Looking exactly straight down/up is
// degenerate for that (view direction parallel to up), so top/bottom are nudged a
// hair off the pole; visually indistinguishable from a true top/bottom view, but it
// keeps orbiting well-defined instead of rolling around the view axis.
const POLE_TILT = 0.001;

const DEFAULT_FRAME_DIRECTION = new THREE.Vector3(0.6, 0.45, 0.9).normalize();

const STANDARD_VIEW_DIRECTIONS: Record<StandardView, THREE.Vector3> = {
  front: new THREE.Vector3(0, 0, 1),
  back: new THREE.Vector3(0, 0, -1),
  top: new THREE.Vector3(0, 1, POLE_TILT).normalize(),
  bottom: new THREE.Vector3(0, -1, POLE_TILT).normalize(),
  left: new THREE.Vector3(-1, 0, 0),
  right: new THREE.Vector3(1, 0, 0),
};

function copyCameraPose(from: THREE.Camera, to: THREE.Camera): void {
  to.position.copy(from.position);
  to.quaternion.copy(from.quaternion);
}

export function createSceneManager(container: HTMLElement): SceneManager {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1d22);

  // perspectiveCamera.up is intentionally never modified; always (0, 1, 0).
  const perspectiveCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  perspectiveCamera.position.set(18, 14, 22);

  const orthographicCamera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 1000);
  orthographicCamera.position.set(18, 14, 22);

  let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = perspectiveCamera;
  let projectionMode: ProjectionMode = "perspective";
  let frameRadius = 10;
  const frameCenter = new THREE.Vector3(0, 2, 0);

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

  // Target cell count — cell size is snapped to a power of two (1, 2, 4, 8,
  // ...), so the actual division count can't hit this exactly, but whichever
  // power of two lands closest to it wins.
  const TARGET_GRID_DIVISIONS = 50;
  const GRID_PADDING = 4;
  const MIN_HALF_REACH = 10;

  function createGrid(size: number, divisions: number): THREE.GridHelper {
    return new THREE.GridHelper(size, divisions, 0x444444, 0x2a2d33);
  }

  // One label per grid line along each ground-plane axis, strung along the
  // axis lines themselves (through the origin) rather than the grid's
  // outer edges. Divisions are always even and cell size is always a power
  // of two, so size is always even and every coordinate here is an exact
  // integer.
  function createAxisLabels(size: number, divisions: number): CSS2DObject[] {
    const half = size / 2;
    const cellSize = size / divisions;
    const labels: CSS2DObject[] = [];

    for (let i = 0; i <= divisions; i++) {
      const coord = Math.round(-half + i * cellSize);

      const xEl = document.createElement("div");
      xEl.className = "axis-label axis-label--x";
      xEl.textContent = String(coord);
      const xLabel = new CSS2DObject(xEl);
      xLabel.position.set(coord, 0, 0);
      labels.push(xLabel);

      const zEl = document.createElement("div");
      zEl.className = "axis-label axis-label--z";
      zEl.textContent = String(coord);
      const zLabel = new CSS2DObject(zEl);
      zLabel.position.set(0, 0, coord);
      labels.push(zLabel);
    }

    return labels;
  }

  function disposeAxisLabels(labels: readonly CSS2DObject[]): void {
    for (const label of labels) {
      scene.remove(label);
      label.element.remove();
    }
  }

  // Picks a power-of-two cell size and however many of them are needed to
  // cover `minCoverage`, choosing whichever power of two leaves the
  // resulting division count closest to TARGET_GRID_DIVISIONS. Divisions are
  // kept even so a grid line always lands exactly on the origin, rather than
  // straddling it in the middle of a cell.
  function pickGrid(minCoverage: number): { size: number; divisions: number } {
    let best = { size: minCoverage, divisions: 2 };
    let bestDiff = Infinity;
    for (let k = 0; k <= 20; k++) {
      const cellSize = 2 ** k;
      let divisions = Math.max(2, Math.ceil(minCoverage / cellSize));
      if (divisions % 2 !== 0) divisions += 1;
      const diff = Math.abs(divisions - TARGET_GRID_DIVISIONS);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = { size: cellSize * divisions, divisions };
      }
    }
    return best;
  }

  let { size: gridSize, divisions: gridDivisions } = pickGrid(2 * (MIN_HALF_REACH + GRID_PADDING));
  let grid = createGrid(gridSize, gridDivisions);
  scene.add(grid);
  let axisLabels = createAxisLabels(gridSize, gridDivisions);
  for (const label of axisLabels) scene.add(label);

  // The grid's own origin always stays at the world origin — only its
  // extent grows or shrinks to comfortably cover how far objects reach from
  // there, so it never has to re-center itself around the objects. Reads
  // live group positions (not the store's), so dragging an object past the
  // current edge grows the grid immediately, mid-drag.
  function updateGrid(): void {
    updateClippingPlanes();

    let maxReach = MIN_HALF_REACH;
    for (const [id, group] of groups) {
      const object = lastSeen.get(id);
      if (!object) continue;
      maxReach = Math.max(
        maxReach,
        Math.abs(group.position.x) + object.width / 2,
        Math.abs(group.position.z) + object.depth / 2,
      );
    }
    const { size, divisions } = pickGrid((maxReach + GRID_PADDING) * 2);
    if (size === gridSize && divisions === gridDivisions) return;

    gridSize = size;
    gridDivisions = divisions;
    scene.remove(grid);
    grid.geometry.dispose();
    (grid.material as THREE.Material).dispose();
    grid = createGrid(gridSize, gridDivisions);
    scene.add(grid);

    disposeAxisLabels(axisLabels);
    axisLabels = createAxisLabels(gridSize, gridDivisions);
    for (const label of axisLabels) scene.add(label);
  }

  const orbitControls = new OrbitControls(camera, renderer.domElement);
  orbitControls.target.set(0, 2, 0);
  orbitControls.enableDamping = true;

  const transformControls = new TransformControls(camera, renderer.domElement);
  transformControls.setMode("translate");
  transformControls.setSize(0.5);
  scene.add(transformControls.getHelper());

  // When multiple objects are selected the gizmo attaches to this invisible
  // proxy (positioned at the selection's centroid) instead of any one
  // object, since TransformControls can only drive a single Object3D.
  const multiSelectProxy = new THREE.Object3D();
  scene.add(multiSelectProxy);
  let multiDragStart: { proxyPosition: THREE.Vector3; groupPositions: Map<string, THREE.Vector3> } | null = null;
  const dragEndListeners: Array<() => void> = [];

  transformControls.addEventListener("dragging-changed", (event) => {
    orbitControls.enabled = !event.value;

    if (event.value && selectedIds.size > 1) {
      const groupPositions = new Map<string, THREE.Vector3>();
      for (const id of selectedIds) {
        const group = groups.get(id);
        if (group) groupPositions.set(id, group.position.clone());
      }
      multiDragStart = { proxyPosition: multiSelectProxy.position.clone(), groupPositions };
    } else {
      multiDragStart = null;
    }

    // dragging-changed only fires when the value actually flips, so
    // event.value === false reliably means a drag just finished (covers
    // both single-object and multi-select rigid-group drags).
    if (!event.value) {
      for (const listener of dragEndListeners) listener();
    }
  });

  transformControls.addEventListener("objectChange", () => {
    if (multiDragStart) {
      const rawDelta = multiSelectProxy.position.clone().sub(multiDragStart.proxyPosition);

      // Clamp deltaY to the most restrictive object in the group (the one
      // closest to the ground) so the whole selection stops moving down
      // together, rigidly, the instant any one of them would hit the floor —
      // rather than each object clamping independently and drifting apart.
      let deltaY = rawDelta.y;
      for (const [id, startPosition] of multiDragStart.groupPositions) {
        const object = lastSeen.get(id);
        if (!object) continue;
        const minDeltaY = object.height / 2 - startPosition.y;
        if (minDeltaY > deltaY) deltaY = minDeltaY;
      }
      const delta = new THREE.Vector3(rawDelta.x, deltaY, rawDelta.z);

      for (const [id, startPosition] of multiDragStart.groupPositions) {
        const group = groups.get(id);
        if (!group) continue;
        group.position.copy(startPosition).add(delta);
      }
      multiSelectProxy.position.y = multiDragStart.proxyPosition.y + deltaY;
      updateGrid();
      return;
    }

    if (!attachedId) return;
    const object = lastSeen.get(attachedId);
    const group = groups.get(attachedId);
    if (!object || !group) return;
    const minY = object.height / 2;
    if (group.position.y < minY) {
      group.position.y = minY;
    }
    updateGrid();
  });

  const groups = new Map<string, THREE.Group>();
  const lastSeen = new Map<string, SizeObject>();
  const meshToId = new Map<THREE.Mesh, string>();
  const selectListeners: Array<(ids: string[]) => void> = [];
  const selectedIds = new Set<string>();
  let attachedId: string | null = null;
  let showNameLabels = true;
  let showDimensionLabels = true;

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

    const edgesGeometry = new THREE.EdgesGeometry(geometry);
    const edges = new THREE.LineSegments(edgesGeometry, new THREE.LineBasicMaterial({ color: object.color }));
    edges.userData.role = "edges";
    group.add(edges);

    const selectionOutline = new THREE.LineSegments(
      edgesGeometry,
      new THREE.LineBasicMaterial({ color: SELECTION_OUTLINE_COLOR, depthTest: false }),
    );
    selectionOutline.userData.role = "selectionOutline";
    selectionOutline.visible = false;
    group.add(selectionOutline);

    const labelEl = document.createElement("div");
    labelEl.className = "object-label";
    labelEl.textContent = object.name;
    const label = new CSS2DObject(labelEl);
    label.position.set(0, 0, 0);
    label.userData.role = "nameLabel";
    label.visible = showNameLabels;
    group.add(label);

    const widthLabel = createDimensionLabel("width");
    const heightLabel = createDimensionLabel("height");
    const depthLabel = createDimensionLabel("depth");
    for (const dimensionLabel of [widthLabel, heightLabel, depthLabel]) {
      dimensionLabel.userData.role = "dimensionLabel";
      dimensionLabel.visible = showDimensionLabels;
    }
    group.add(widthLabel, heightLabel, depthLabel);

    updateDimensionLabels(widthLabel, heightLabel, depthLabel, object);

    return group;
  }

  function createDimensionLabel(kind: "width" | "height" | "depth"): CSS2DObject {
    const el = document.createElement("div");
    el.className = `dimension-label dimension-label--${kind}`;
    return new CSS2DObject(el);
  }

  function updateDimensionLabels(
    widthLabel: CSS2DObject,
    heightLabel: CSS2DObject,
    depthLabel: CSS2DObject,
    object: SizeObject,
  ): void {
    const halfWidth = object.width / 2;
    const halfHeight = object.height / 2;
    const halfDepth = object.depth / 2;

    widthLabel.element.textContent = String(object.width);
    widthLabel.position.set(0, halfHeight, halfDepth);

    heightLabel.element.textContent = String(object.height);
    heightLabel.position.set(-halfWidth, 0, halfDepth);

    depthLabel.element.textContent = String(object.depth);
    depthLabel.position.set(-halfWidth, halfHeight, 0);
  }

  function updateGroup(group: THREE.Group, object: SizeObject): void {
    const mesh = group.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh);
    const lineSegments = group.children.filter((c): c is THREE.LineSegments => c instanceof THREE.LineSegments);
    const edges = lineSegments.find((l) => l.userData.role === "edges");
    const selectionOutline = lineSegments.find((l) => l.userData.role === "selectionOutline");
    const labels = group.children.filter((c): c is CSS2DObject => c instanceof CSS2DObject);
    const label = labels.find((l) => l.element.classList.contains("object-label"));
    const widthLabel = labels.find((l) => l.element.classList.contains("dimension-label--width"));
    const heightLabel = labels.find((l) => l.element.classList.contains("dimension-label--height"));
    const depthLabel = labels.find((l) => l.element.classList.contains("dimension-label--depth"));
    if (!mesh || !edges || !selectionOutline || !label || !widthLabel || !heightLabel || !depthLabel) return;

    mesh.geometry.dispose();
    mesh.geometry = new THREE.BoxGeometry(object.width, object.height, object.depth);
    (mesh.material as THREE.MeshStandardMaterial).color.setHex(object.color);

    edges.geometry.dispose();
    const edgesGeometry = new THREE.EdgesGeometry(mesh.geometry);
    edges.geometry = edgesGeometry;
    selectionOutline.geometry = edgesGeometry;
    (edges.material as THREE.LineBasicMaterial).color.setHex(object.color);

    label.element.textContent = object.name;
    label.position.set(0, 0, 0);

    updateDimensionLabels(widthLabel, heightLabel, depthLabel, object);
  }

  function applyLabelVisibility(): void {
    for (const group of groups.values()) {
      for (const child of group.children) {
        if (!(child instanceof CSS2DObject)) continue;
        if (child.userData.role === "nameLabel") child.visible = showNameLabels;
        else if (child.userData.role === "dimensionLabel") child.visible = showDimensionLabels;
      }
    }
  }

  function setNameLabelsVisible(visible: boolean): void {
    showNameLabels = visible;
    applyLabelVisibility();
  }

  function setDimensionLabelsVisible(visible: boolean): void {
    showDimensionLabels = visible;
    applyLabelVisibility();
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

  function applySelectionState(): void {
    for (const [id, group] of groups) {
      const outline = group.children.find(
        (c): c is THREE.LineSegments => c instanceof THREE.LineSegments && c.userData.role === "selectionOutline",
      );
      if (outline) outline.visible = selectedIds.has(id);
    }

    if (selectedIds.size === 1) {
      const [id] = selectedIds;
      const group = groups.get(id);
      attachedId = group ? id : null;
      if (group) {
        transformControls.attach(group);
      } else {
        transformControls.detach();
      }
    } else if (selectedIds.size > 1) {
      attachedId = null;
      const centroid = computeCentroid(selectedIds);
      if (centroid) {
        multiSelectProxy.position.copy(centroid);
        transformControls.attach(multiSelectProxy);
      } else {
        transformControls.detach();
      }
    } else {
      attachedId = null;
      transformControls.detach();
    }

    for (const listener of selectListeners) listener(Array.from(selectedIds));
  }

  function computeCentroid(ids: Iterable<string>): THREE.Vector3 | null {
    const sum = new THREE.Vector3();
    let count = 0;
    for (const id of ids) {
      const group = groups.get(id);
      if (!group) continue;
      sum.add(group.position);
      count++;
    }
    return count > 0 ? sum.divideScalar(count) : null;
  }

  function select(id: string | null, additive = false): void {
    if (id === null) {
      selectedIds.clear();
    } else if (additive) {
      if (selectedIds.has(id)) {
        selectedIds.delete(id);
      } else {
        selectedIds.add(id);
      }
    } else {
      selectedIds.clear();
      selectedIds.add(id);
    }
    applySelectionState();
  }

  function syncObjects(objects: readonly SizeObject[]): void {
    const wasEmpty = groups.size === 0;
    const currentIds = new Set(objects.map((o) => o.id));

    let removedSelected = false;
    for (const [id, group] of groups) {
      if (!currentIds.has(id)) {
        if (selectedIds.delete(id)) removedSelected = true;
        disposeGroup(group);
        scene.remove(group);
        groups.delete(id);
        lastSeen.delete(id);
      }
    }
    if (removedSelected) applySelectionState();

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

    updateGrid();

    // Auto-frame only when the scene goes from empty to populated (initial
    // load / first object) — reframing on every add/remove/edit would yank
    // the camera out from under a user who's mid-comparison.
    if (wasEmpty && objects.length > 0) {
      frameScene(computeBoundsBox());
    }
  }

  // Reads live group positions (not the store's), matching updateGrid, so it
  // reflects objects that have been dragged since the last store update.
  function computeBoundsBox(): THREE.Box3 {
    const box = new THREE.Box3();
    for (const [id, group] of groups) {
      const object = lastSeen.get(id);
      if (!object) continue;
      const halfWidth = object.width / 2;
      const halfHeight = object.height / 2;
      const halfDepth = object.depth / 2;
      box.expandByPoint(
        new THREE.Vector3(
          group.position.x - halfWidth,
          group.position.y - halfHeight,
          group.position.z - halfDepth,
        ),
      );
      box.expandByPoint(
        new THREE.Vector3(
          group.position.x + halfWidth,
          group.position.y + halfHeight,
          group.position.z + halfDepth,
        ),
      );
    }
    return box;
  }

  // frameScene()/zoomExtents() only set near/far at the moment they run —
  // dragging an object far from where the camera was last framed can push
  // it past the far plane (or, if dragged very close, inside the near
  // plane), clipping it out of view without ever re-triggering a reframe.
  // Called every time updateGrid() is (i.e. on every store sync and on
  // every drag frame), this keeps both cameras' clipping planes wide enough
  // to always contain every object's current live position, independent of
  // whether the grid itself needed to resize.
  function updateClippingPlanes(): void {
    const box = computeBoundsBox();
    box.expandByPoint(new THREE.Vector3(0, 0, 0));
    if (box.isEmpty()) return;

    const sphere = box.getBoundingSphere(new THREE.Sphere());

    const perspectiveFar = Math.max(perspectiveCamera.position.distanceTo(sphere.center) + sphere.radius, 1) * 2;
    perspectiveCamera.near = Math.max(perspectiveFar / 10000, 0.01);
    perspectiveCamera.far = perspectiveFar;
    perspectiveCamera.updateProjectionMatrix();

    const orthographicFar = Math.max(orthographicCamera.position.distanceTo(sphere.center) + sphere.radius, 1) * 2;
    orthographicCamera.near = Math.max(orthographicFar / 10000, 0.01);
    orthographicCamera.far = orthographicFar;
    orthographicCamera.updateProjectionMatrix();
  }

  // Zoom Extents pans and zooms to fit — it must not change which way the
  // camera is looking, so it re-derives "direction" from the camera's
  // current position relative to its current look-at point, instead of
  // resetting to the default framing angle.
  function zoomExtents(): void {
    const box = computeBoundsBox();
    box.expandByPoint(new THREE.Vector3(0, 0, 0));

    const direction = camera.position.clone().sub(orbitControls.target);
    if (direction.lengthSq() < 1e-6) direction.copy(DEFAULT_FRAME_DIRECTION);
    else direction.normalize();

    frameScene(box, direction);
  }

  function frameScene(box: THREE.Box3, direction: THREE.Vector3 = DEFAULT_FRAME_DIRECTION): void {
    if (box.isEmpty()) return;

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 1);

    const perspectiveDistance = radius / Math.sin((perspectiveCamera.fov * Math.PI) / 360) + radius;
    perspectiveCamera.position.copy(center).addScaledVector(direction, perspectiveDistance);
    perspectiveCamera.near = Math.max(perspectiveDistance / 100, 0.1);
    perspectiveCamera.far = perspectiveDistance * 20;
    perspectiveCamera.updateProjectionMatrix();

    const orthographicDistance = radius * 4 + 10;
    orthographicCamera.position.copy(center).addScaledVector(direction, orthographicDistance);
    orthographicCamera.up.set(0, 1, 0);
    orthographicCamera.lookAt(center);
    orthographicCamera.near = Math.max(orthographicDistance / 100, 0.1);
    orthographicCamera.far = orthographicDistance * 20;

    frameCenter.copy(center);
    frameRadius = radius * 1.1;
    updateOrthographicFrustum();

    orbitControls.target.copy(center);
    orbitControls.update();
  }

  function updateOrthographicFrustum(): void {
    const aspect = container.clientWidth / container.clientHeight || 1;
    orthographicCamera.left = -frameRadius * aspect;
    orthographicCamera.right = frameRadius * aspect;
    orthographicCamera.top = frameRadius;
    orthographicCamera.bottom = -frameRadius;
    orthographicCamera.updateProjectionMatrix();
  }

  function setProjection(mode: ProjectionMode): void {
    if (mode === projectionMode) return;
    projectionMode = mode;

    if (mode === "orthographic") {
      copyCameraPose(perspectiveCamera, orthographicCamera);
      const distance = perspectiveCamera.position.distanceTo(orbitControls.target);
      const halfHeight = distance * Math.tan((THREE.MathUtils.DEG2RAD * perspectiveCamera.fov) / 2);
      frameRadius = Math.max(halfHeight, 0.1);
      updateOrthographicFrustum();
      camera = orthographicCamera;
    } else {
      copyCameraPose(orthographicCamera, perspectiveCamera);
      camera = perspectiveCamera;
    }

    orbitControls.object = camera;
    transformControls.camera = camera;
    resize();
    orbitControls.update();
    updateToolbarUI();
  }

  function setStandardView(view: StandardView): void {
    if (projectionMode !== "orthographic") return;

    const distance = Math.max(frameRadius, 1) * 4 + 10;
    orthographicCamera.position.copy(frameCenter).addScaledVector(STANDARD_VIEW_DIRECTIONS[view], distance);
    orthographicCamera.lookAt(frameCenter);
    orthographicCamera.near = Math.max(distance / 100, 0.1);
    orthographicCamera.far = distance * 20;
    orthographicCamera.updateProjectionMatrix();

    orbitControls.target.copy(frameCenter);
    orbitControls.update();
  }

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  // A click and the start of an orbit/pan drag both begin with the same
  // pointerdown — only the pointerup position tells them apart. Selecting on
  // pointerdown made every orbit drag clear or change the selection before
  // the drag even happened.
  const CLICK_DRAG_THRESHOLD = 5;
  let pointerDownGesture: { x: number; y: number; skip: boolean } | null = null;

  renderer.domElement.addEventListener("pointerdown", (event) => {
    pointerDownGesture = { x: event.clientX, y: event.clientY, skip: transformControls.dragging };
  });

  window.addEventListener("pointerup", (event) => {
    const gesture = pointerDownGesture;
    pointerDownGesture = null;
    if (!gesture || gesture.skip) return;
    if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > CLICK_DRAG_THRESHOLD) return;

    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(pointer, camera);
    const meshes = Array.from(meshToId.keys());
    const intersections = raycaster.intersectObjects(meshes, false);
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;

    if (intersections.length > 0) {
      const mesh = intersections[0].object as THREE.Mesh;
      const id = meshToId.get(mesh) ?? null;
      if (id) select(id, additive);
      else select(null);
    } else {
      select(null);
    }
  });

  function resize(): void {
    const width = container.clientWidth;
    const height = container.clientHeight;

    perspectiveCamera.aspect = width / height;
    perspectiveCamera.updateProjectionMatrix();
    updateOrthographicFrustum();

    renderer.setSize(width, height);
    labelRenderer.setSize(width, height);
  }

  function render(): void {
    orbitControls.update();
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
  }

  const toolbar = document.createElement("div");
  toolbar.className = "viewport-toolbar";

  const projectionGroup = document.createElement("div");
  projectionGroup.className = "toolbar-group";

  const perspectiveBtn = document.createElement("button");
  perspectiveBtn.type = "button";
  perspectiveBtn.textContent = "Perspective";
  perspectiveBtn.addEventListener("click", () => setProjection("perspective"));

  const orthographicBtn = document.createElement("button");
  orthographicBtn.type = "button";
  orthographicBtn.textContent = "Orthographic";
  orthographicBtn.addEventListener("click", () => setProjection("orthographic"));

  projectionGroup.append(perspectiveBtn, orthographicBtn);

  const viewGroup = document.createElement("div");
  viewGroup.className = "toolbar-group view-group";

  const VIEW_LABELS: Record<StandardView, string> = {
    front: "Front",
    back: "Back",
    top: "Top",
    bottom: "Bottom",
    left: "Left",
    right: "Right",
  };

  const viewButtons = (Object.keys(VIEW_LABELS) as StandardView[]).map((view) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = VIEW_LABELS[view];
    btn.addEventListener("click", () => setStandardView(view));
    viewGroup.appendChild(btn);
    return btn;
  });

  const labelGroup = document.createElement("div");
  labelGroup.className = "toolbar-group";

  const zoomExtentsBtn = document.createElement("button");
  zoomExtentsBtn.type = "button";
  zoomExtentsBtn.textContent = "Zoom Extents";
  zoomExtentsBtn.addEventListener("click", () => zoomExtents());

  const nameLabelsBtn = document.createElement("button");
  nameLabelsBtn.type = "button";
  nameLabelsBtn.textContent = "Show Names";
  nameLabelsBtn.addEventListener("click", () => {
    setNameLabelsVisible(!showNameLabels);
    updateToolbarUI();
  });

  const dimensionLabelsBtn = document.createElement("button");
  dimensionLabelsBtn.type = "button";
  dimensionLabelsBtn.textContent = "Show Dimensions";
  dimensionLabelsBtn.addEventListener("click", () => {
    setDimensionLabelsVisible(!showDimensionLabels);
    updateToolbarUI();
  });

  labelGroup.append(zoomExtentsBtn, nameLabelsBtn, dimensionLabelsBtn);

  const topRow = document.createElement("div");
  topRow.className = "toolbar-row";
  topRow.append(projectionGroup, labelGroup);

  toolbar.append(topRow, viewGroup);
  container.appendChild(toolbar);

  function updateToolbarUI(): void {
    perspectiveBtn.classList.toggle("active", projectionMode === "perspective");
    orthographicBtn.classList.toggle("active", projectionMode === "orthographic");
    viewGroup.classList.toggle("visible", projectionMode === "orthographic");
    for (const btn of viewButtons) btn.disabled = projectionMode !== "orthographic";
    nameLabelsBtn.classList.toggle("active", showNameLabels);
    dimensionLabelsBtn.classList.toggle("active", showDimensionLabels);
  }

  updateToolbarUI();

  function getPosition(id: string): { x: number; y: number; z: number } | null {
    const group = groups.get(id);
    if (!group) return null;
    return { x: group.position.x, y: group.position.y, z: group.position.z };
  }

  return {
    syncObjects,
    select,
    onSelect: (callback) => selectListeners.push(callback),
    onDragEnd: (callback) => dragEndListeners.push(callback),
    setProjection,
    setStandardView,
    zoomExtents,
    getPosition,
    resize,
    render,
  };
}
