import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import type { SizeObject } from "./types";

const BOX_OPACITY = 0.35;
const SELECTION_OUTLINE_COLOR = 0x4a7dfc;
const FACE_HIGHLIGHT_COLOR = 0xffa726;
const FACE_HIGHLIGHT_OPACITY = 0.4;
const MIN_DIMENSION = 0.01;

// Shared unit-plane geometry for every face handle on every object — each
// handle is oriented (rotation, set once at creation) and sized (non-uniform
// scale, updated on every reposition) via its transform, never by
// regenerating geometry, so there's nothing per-object to dispose beyond
// each handle's own material.
const FACE_HANDLE_GEOMETRY = new THREE.PlaneGeometry(1, 1);

type FaceAxis = { axis: "x" | "y" | "z"; sign: 1 | -1 };

const FACES: readonly FaceAxis[] = [
  { axis: "x", sign: 1 },
  { axis: "x", sign: -1 },
  { axis: "y", sign: 1 },
  { axis: "y", sign: -1 },
  { axis: "z", sign: 1 },
  { axis: "z", sign: -1 },
];

function gripLocalPosition(
  object: { width: number; height: number; depth: number },
  face: FaceAxis,
): THREE.Vector3 {
  const half: Record<"x" | "y" | "z", number> = {
    x: object.width / 2,
    y: object.height / 2,
    z: object.depth / 2,
  };
  const position = new THREE.Vector3();
  position[face.axis] = half[face.axis] * face.sign;
  return position;
}

// A PlaneGeometry(1,1) lies in its local XY plane (normal along local +Z).
// Rotating it so that normal points along a given world axis leaves its
// local X/Y scale axes spanning two of the *other* world axes — this table
// is exactly that mapping, so scaling by (u, v, 1) after this rotation
// stretches the plane to that face's real rectangle. Rotation only depends
// on axis (not sign): +X/-X use the identical rotation, only position
// differs — the material is DoubleSide + unlit, so the exact rotation sign
// is visually irrelevant.
function faceHandleRotation(face: FaceAxis): THREE.Euler {
  if (face.axis === "x") return new THREE.Euler(0, Math.PI / 2, 0);
  if (face.axis === "y") return new THREE.Euler(-Math.PI / 2, 0, 0);
  return new THREE.Euler(0, 0, 0);
}

function faceHandleScale(
  object: { width: number; height: number; depth: number },
  face: FaceAxis,
): { u: number; v: number } {
  if (face.axis === "x") return { u: object.depth, v: object.height };
  if (face.axis === "y") return { u: object.width, v: object.depth };
  return { u: object.width, v: object.height };
}

interface GroupParts {
  mesh: THREE.Mesh;
  edges: THREE.LineSegments;
  selectionOutline: THREE.LineSegments;
  nameLabel: CSS2DObject;
  widthLabel: CSS2DObject;
  heightLabel: CSS2DObject;
  depthLabel: CSS2DObject;
}

function findGroupParts(group: THREE.Group): GroupParts | null {
  const mesh = group.children.find(
    (c): c is THREE.Mesh => c instanceof THREE.Mesh && c.userData.role === "box",
  );
  const lineSegments = group.children.filter((c): c is THREE.LineSegments => c instanceof THREE.LineSegments);
  const edges = lineSegments.find((l) => l.userData.role === "edges");
  const selectionOutline = lineSegments.find((l) => l.userData.role === "selectionOutline");
  const labels = group.children.filter((c): c is CSS2DObject => c instanceof CSS2DObject);
  const nameLabel = labels.find((l) => l.userData.role === "nameLabel");
  const widthLabel = labels.find((l) => l.element.classList.contains("dimension-label--width"));
  const heightLabel = labels.find((l) => l.element.classList.contains("dimension-label--height"));
  const depthLabel = labels.find((l) => l.element.classList.contains("dimension-label--depth"));
  if (!mesh || !edges || !selectionOutline || !nameLabel || !widthLabel || !heightLabel || !depthLabel) return null;
  return { mesh, edges, selectionOutline, nameLabel, widthLabel, heightLabel, depthLabel };
}

// Recreates box/edge geometry from scratch — shared by the store-driven
// update path (updateGroup) and the live resize-drag path, which calls this
// on every pointermove with a scratch object rather than a real SizeObject.
function rebuildGeometry(
  object: { width: number; height: number; depth: number; color: number },
  parts: Pick<GroupParts, "mesh" | "edges" | "selectionOutline">,
): void {
  parts.mesh.geometry.dispose();
  parts.mesh.geometry = new THREE.BoxGeometry(object.width, object.height, object.depth);
  (parts.mesh.material as THREE.MeshStandardMaterial).color.setHex(object.color);

  parts.edges.geometry.dispose();
  const edgesGeometry = new THREE.EdgesGeometry(parts.mesh.geometry);
  parts.edges.geometry = edgesGeometry;
  parts.selectionOutline.geometry = edgesGeometry;
  (parts.edges.material as THREE.LineBasicMaterial).color.setHex(object.color);
}

function repositionFaceHandles(
  faceHandles: readonly THREE.Mesh[],
  object: { width: number; height: number; depth: number },
): void {
  for (let i = 0; i < FACES.length; i++) {
    const face = FACES[i];
    const { u, v } = faceHandleScale(object, face);
    faceHandles[i].position.copy(gripLocalPosition(object, face));
    faceHandles[i].scale.set(u, v, 1);
  }
}

function hasObjectChanged(previous: SizeObject | undefined, current: SizeObject): boolean {
  if (!previous) return false;
  return (
    previous.name !== current.name ||
    previous.width !== current.width ||
    previous.height !== current.height ||
    previous.depth !== current.depth ||
    previous.color !== current.color ||
    previous.position.x !== current.position.x ||
    previous.position.y !== current.position.y ||
    previous.position.z !== current.position.z
  );
}

export type ProjectionMode = "perspective" | "orthographic";
export type StandardView = "front" | "back" | "top" | "bottom" | "left" | "right";
export type DisplayStyle = "solid" | "transparent" | "wireframe";

export interface SceneManager {
  syncObjects(objects: readonly SizeObject[]): void;
  select(id: string | null, additive?: boolean): void;
  onSelect(callback: (ids: string[]) => void): void;
  onDragEnd(callback: () => void): void;
  setProjection(mode: ProjectionMode): void;
  setStandardView(view: StandardView): void;
  zoomExtents(): void;
  getPosition(id: string): { x: number; y: number; z: number } | null;
  getDimensions(id: string): { width: number; height: number; depth: number } | null;
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

  // Panning shifts camera position and target together, and orthographic
  // dolly (zoom) only touches camera.zoom — neither changes the viewing
  // direction, so the active standard-view button stays highlighted through
  // both. Orbiting is the only gesture that actually changes this vector,
  // so it's the only thing that should clear the highlight.
  orbitControls.addEventListener("change", () => {
    if (!currentStandardView) return;
    const direction = camera.position.clone().sub(orbitControls.target);
    if (direction.lengthSq() < 1e-9) return;
    direction.normalize();
    if (direction.dot(STANDARD_VIEW_DIRECTIONS[currentStandardView]) < 0.9999) {
      currentStandardView = null;
      updateToolbarUI();
    }
  });

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
  const faceHandleToFace = new Map<THREE.Mesh, FaceAxis>();
  const faceHandleToId = new Map<THREE.Mesh, string>();
  // Live width/height/depth during a resize-drag, read by computeBoundsBox
  // and getDimensions in preference to lastSeen (which — like groups does
  // for position during any drag — is never updated mid-drag, only by
  // syncObjects). Cleared once the drag-end store reconciliation completes.
  const liveDimensions = new Map<string, { width: number; height: number; depth: number }>();
  const selectListeners: Array<(ids: string[]) => void> = [];
  const selectedIds = new Set<string>();
  let attachedId: string | null = null;
  let showNameLabels = true;
  let showDimensionLabels = true;
  let freeResizeEnabled = false;
  let displayStyle: DisplayStyle = "transparent";
  let currentStandardView: StandardView | null = null;

  // Wireframe is driven by opacity, not mesh.visible — Raycaster skips
  // invisible objects, and this mesh is exactly what click-to-select
  // raycasts against (meshToId / the pointerup handler below). Hiding it
  // would silently break selecting objects while in Wireframe mode. The
  // always-visible `edges` LineSegments (EdgesGeometry) already draws a
  // clean box outline, which also looks better than material.wireframe —
  // that would additionally draw the diagonal triangle-split line per face.
  function applyDisplayStyleToMesh(mesh: THREE.Mesh): void {
    const material = mesh.material as THREE.MeshStandardMaterial;
    material.transparent = displayStyle !== "solid";
    material.opacity = displayStyle === "solid" ? 1 : displayStyle === "transparent" ? BOX_OPACITY : 0;
    material.depthWrite = displayStyle === "solid";
    material.needsUpdate = true;
  }

  function applyDisplayStyle(): void {
    for (const group of groups.values()) {
      const mesh = group.children.find(
        (c): c is THREE.Mesh => c instanceof THREE.Mesh && c.userData.role === "box",
      );
      if (mesh) applyDisplayStyleToMesh(mesh);
    }
  }

  function setDisplayStyle(style: DisplayStyle): void {
    displayStyle = style;
    applyDisplayStyle();
  }

  function buildGroup(object: SizeObject): THREE.Group {
    const group = new THREE.Group();
    group.position.set(object.position.x, object.position.y, object.position.z);

    const geometry = new THREE.BoxGeometry(object.width, object.height, object.depth);
    const material = new THREE.MeshStandardMaterial({
      color: object.color,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.role = "box";
    applyDisplayStyleToMesh(mesh);
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

    // Resize face handles — one per face, covering the whole face (not a
    // small grip on it), only shown for a single-object selection (toggled
    // in applySelectionState) and only *visible* (opacity) while hovered —
    // otherwise fully transparent so there's no permanent visual clutter.
    // depthTest:false keeps them clickable regardless of display style or
    // occlusion, same reasoning as selectionOutline above.
    const faceHandles = FACES.map((face) => {
      const handle = new THREE.Mesh(
        FACE_HANDLE_GEOMETRY,
        new THREE.MeshBasicMaterial({
          color: FACE_HIGHLIGHT_COLOR,
          transparent: true,
          opacity: 0,
          depthTest: false,
          side: THREE.DoubleSide,
        }),
      );
      handle.userData.role = "faceHandle";
      handle.visible = false;
      handle.rotation.copy(faceHandleRotation(face));
      handle.position.copy(gripLocalPosition(object, face));
      const { u, v } = faceHandleScale(object, face);
      handle.scale.set(u, v, 1);
      group.add(handle);
      faceHandleToFace.set(handle, face);
      faceHandleToId.set(handle, object.id);
      return handle;
    });
    group.userData.faceHandles = faceHandles;

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
    group.position.set(object.position.x, object.position.y, object.position.z);

    const parts = findGroupParts(group);
    if (!parts) return;

    rebuildGeometry(object, parts);
    repositionFaceHandles((group.userData.faceHandles as THREE.Mesh[] | undefined) ?? [], object);

    parts.nameLabel.element.textContent = object.name;
    parts.nameLabel.position.set(0, 0, 0);

    updateDimensionLabels(parts.widthLabel, parts.heightLabel, parts.depthLabel, object);
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

  function setFreeResizeEnabled(enabled: boolean): void {
    freeResizeEnabled = enabled;
    applySelectionState();
  }

  function disposeGroup(group: THREE.Group): void {
    group.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        // Face handles share FACE_HANDLE_GEOMETRY across every object —
        // disposing it here would break every other still-alive object's
        // handles.
        if (child.userData.role !== "faceHandle") child.geometry.dispose();
        (child.material as THREE.Material).dispose();
        meshToId.delete(child);
        faceHandleToFace.delete(child);
        faceHandleToId.delete(child);
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

      // Resize face handles only ever show for a single-object selection.
      const faceHandles = (group.userData.faceHandles as THREE.Mesh[] | undefined) ?? [];
      const showFaceHandles = freeResizeEnabled && selectedIds.size === 1 && selectedIds.has(id);
      for (const handle of faceHandles) handle.visible = showFaceHandles;
    }

    // Selection changed — don't leave a stale highlight on a face that's
    // no longer shown (e.g. selection moved to a different object).
    setHoveredFaceHandle(null);

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
      } else if (hasObjectChanged(lastSeen.get(object.id), object)) {
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
      const dims = liveDimensions.get(id) ?? lastSeen.get(id);
      if (!dims) continue;
      const halfWidth = dims.width / 2;
      const halfHeight = dims.height / 2;
      const halfDepth = dims.depth / 2;
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

    // OrbitControls implements mouse-wheel zoom on an orthographic camera by
    // scaling .zoom (not by changing the frustum bounds below), so any
    // leftover zoom from manual scrolling has to be cleared here — otherwise
    // it silently distorts the frustum we're about to compute from scratch.
    orthographicCamera.zoom = 1;

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
      orthographicCamera.zoom = 1;
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
    orthographicCamera.zoom = 1;
    orthographicCamera.updateProjectionMatrix();

    // Set before orbitControls.update() so the "change" listener above sees
    // the new target view already in place and confirms the direction match
    // rather than momentarily comparing against the view being left.
    currentStandardView = view;

    orbitControls.target.copy(frameCenter);
    orbitControls.update();
    updateToolbarUI();
  }

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  function setPointerFromEvent(event: PointerEvent): void {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
  }

  interface ResizeDragState {
    id: string;
    face: FaceAxis;
    plane: THREE.Plane;
    pointStart: THREE.Vector3;
    startWidth: number;
    startHeight: number;
    startDepth: number;
    startPosition: THREE.Vector3;
    parts: GroupParts;
    faceHandles: THREE.Mesh[];
  }
  let resizeDrag: ResizeDragState | null = null;

  let hoveredFaceHandle: THREE.Mesh | null = null;

  function setHoveredFaceHandle(handle: THREE.Mesh | null): void {
    if (hoveredFaceHandle === handle) return;
    if (hoveredFaceHandle) (hoveredFaceHandle.material as THREE.MeshBasicMaterial).opacity = 0;
    hoveredFaceHandle = handle;
    if (hoveredFaceHandle) (hoveredFaceHandle.material as THREE.MeshBasicMaterial).opacity = FACE_HIGHLIGHT_OPACITY;
    renderer.domElement.style.cursor = handle ? "pointer" : "";
  }

  // Raycasts only the currently-selected object's face handles (never the
  // whole scene's — only one group's are ever visible at a time anyway).
  // Reused for both starting a drag (pointerdown) and hover detection.
  function hitTestFaceHandle(event: PointerEvent): { id: string; face: FaceAxis; grip: THREE.Mesh } | null {
    if (!freeResizeEnabled || selectedIds.size !== 1) return null;
    const [id] = selectedIds;
    const group = groups.get(id);
    if (!group) return null;
    const faceHandles = (group.userData.faceHandles as THREE.Mesh[] | undefined) ?? [];

    setPointerFromEvent(event);
    const hits = raycaster.intersectObjects(faceHandles, false);
    if (hits.length === 0) return null;
    const grip = hits[0].object as THREE.Mesh;
    const face = faceHandleToFace.get(grip);
    return face ? { id, face, grip } : null;
  }

  // Hover highlight — deliberately on renderer.domElement, not window, since
  // hover is only meaningful while actually over the canvas. Skips while any
  // drag (orbit, translate, or resize) is in progress: event.buttons !== 0
  // covers orbit/translate (this always fires alongside their own
  // listeners), and the resizeDrag/transformControls.dragging checks cover
  // the rest. Because of this guard, whichever face is highlighted when a
  // resize-drag starts (set explicitly in startResizeDrag) simply stays
  // highlighted for the whole drag, for free.
  renderer.domElement.addEventListener("pointermove", (event) => {
    if (event.buttons !== 0 || resizeDrag || transformControls.dragging) return;
    if (selectedIds.size !== 1) {
      setHoveredFaceHandle(null);
      return;
    }
    const hit = hitTestFaceHandle(event);
    setHoveredFaceHandle(hit ? hit.grip : null);
  });

  renderer.domElement.addEventListener("pointerleave", () => setHoveredFaceHandle(null));

  // Builds the same axis-constrained drag plane TransformControlsPlane uses
  // internally for single-axis translate (verified against
  // TransformControls.js): a plane containing the drag axis, tilted to face
  // the camera as much as possible. Returns false (and starts nothing) if
  // the camera is looking straight down the axis — the plane degenerates
  // there, same inherent weakness the move gizmo's own axis arrows have from
  // directly overhead.
  function startResizeDrag(hit: { id: string; face: FaceAxis; grip: THREE.Mesh }): boolean {
    const group = groups.get(hit.id);
    const object = lastSeen.get(hit.id);
    const parts = group ? findGroupParts(group) : null;
    if (!group || !object || !parts) return false;

    const gripWorldPosition = new THREE.Vector3();
    hit.grip.getWorldPosition(gripWorldPosition);

    const axisUnit = new THREE.Vector3(
      hit.face.axis === "x" ? 1 : 0,
      hit.face.axis === "y" ? 1 : 0,
      hit.face.axis === "z" ? 1 : 0,
    );
    const eye = camera.position.clone().sub(gripWorldPosition).normalize();
    const planeNormal = axisUnit.clone().cross(eye.clone().cross(axisUnit));
    if (planeNormal.lengthSq() < 1e-9) return false;
    planeNormal.normalize();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal, gripWorldPosition);

    const pointStart = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(plane, pointStart)) return false;

    resizeDrag = {
      id: hit.id,
      face: hit.face,
      plane,
      pointStart,
      startWidth: object.width,
      startHeight: object.height,
      startDepth: object.depth,
      startPosition: group.position.clone(),
      parts,
      faceHandles: (group.userData.faceHandles as THREE.Mesh[] | undefined) ?? [],
    };
    orbitControls.enabled = false;
    setHoveredFaceHandle(hit.grip);
    return true;
  }

  window.addEventListener("pointermove", (event) => {
    if (!resizeDrag) return;
    setPointerFromEvent(event);

    const hit = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(resizeDrag.plane, hit)) return;
    const offset = hit.sub(resizeDrag.pointStart);
    const rawDelta = offset[resizeDrag.face.axis];
    let delta = rawDelta * resizeDrag.face.sign;

    const startDimension =
      resizeDrag.face.axis === "x"
        ? resizeDrag.startWidth
        : resizeDrag.face.axis === "y"
          ? resizeDrag.startHeight
          : resizeDrag.startDepth;

    // Clamp delta itself, not the derived outputs separately — otherwise the
    // anchored opposite face would drift the instant a clamp saturates.
    const minDelta = MIN_DIMENSION - startDimension;
    if (delta < minDelta) delta = minDelta;
    if (resizeDrag.face.axis === "y" && resizeDrag.face.sign === -1) {
      const maxDeltaForGround = 2 * (resizeDrag.startPosition.y - resizeDrag.startHeight / 2);
      if (delta > maxDeltaForGround) delta = maxDeltaForGround;
    }

    const newDimension = startDimension + delta;
    const positionDelta = resizeDrag.face.sign === 1 ? delta / 2 : -delta / 2;

    const newWidth = resizeDrag.face.axis === "x" ? newDimension : resizeDrag.startWidth;
    const newHeight = resizeDrag.face.axis === "y" ? newDimension : resizeDrag.startHeight;
    const newDepth = resizeDrag.face.axis === "z" ? newDimension : resizeDrag.startDepth;

    const newPosition = resizeDrag.startPosition.clone();
    newPosition[resizeDrag.face.axis] += positionDelta;

    const group = groups.get(resizeDrag.id);
    const lastObject = lastSeen.get(resizeDrag.id);
    if (!group || !lastObject) return;

    group.position.copy(newPosition);
    const scratch: SizeObject = { ...lastObject, width: newWidth, height: newHeight, depth: newDepth, position: newPosition };
    rebuildGeometry(scratch, resizeDrag.parts);
    repositionFaceHandles(resizeDrag.faceHandles, scratch);
    updateDimensionLabels(resizeDrag.parts.widthLabel, resizeDrag.parts.heightLabel, resizeDrag.parts.depthLabel, scratch);

    liveDimensions.set(resizeDrag.id, { width: newWidth, height: newHeight, depth: newDepth });
    updateGrid();
  });

  window.addEventListener("pointerup", () => {
    if (!resizeDrag) return;
    const id = resizeDrag.id;
    orbitControls.enabled = true;
    resizeDrag = null;
    // Fire while liveDimensions still holds the final live value — the
    // listener (main.ts) reads it via getDimensions to reconcile the store,
    // and that store update synchronously re-populates lastSeen to match
    // before we clear liveDimensions below.
    for (const listener of dragEndListeners) listener();
    liveDimensions.delete(id);
  });

  // A click and the start of an orbit/pan drag both begin with the same
  // pointerdown — only the pointerup position tells them apart. Selecting on
  // pointerdown made every orbit drag clear or change the selection before
  // the drag even happened.
  const CLICK_DRAG_THRESHOLD = 5;
  let pointerDownGesture: { x: number; y: number; skip: boolean } | null = null;

  renderer.domElement.addEventListener("pointerdown", (event) => {
    if (transformControls.dragging) {
      pointerDownGesture = { x: event.clientX, y: event.clientY, skip: true };
      return;
    }

    const grip = hitTestFaceHandle(event);
    if (grip && startResizeDrag(grip)) {
      pointerDownGesture = { x: event.clientX, y: event.clientY, skip: true };
      return;
    }

    pointerDownGesture = { x: event.clientX, y: event.clientY, skip: false };
  });

  window.addEventListener("pointerup", (event) => {
    const gesture = pointerDownGesture;
    pointerDownGesture = null;
    if (!gesture || gesture.skip) return;
    if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > CLICK_DRAG_THRESHOLD) return;

    setPointerFromEvent(event);
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

  const displayStyleGroup = document.createElement("div");
  displayStyleGroup.className = "toolbar-group";

  const DISPLAY_STYLE_LABELS: Record<DisplayStyle, string> = {
    solid: "Solid",
    transparent: "Transparent",
    wireframe: "Wireframe",
  };

  const displayStyleButtons = (Object.keys(DISPLAY_STYLE_LABELS) as DisplayStyle[]).map((style) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = DISPLAY_STYLE_LABELS[style];
    btn.addEventListener("click", () => {
      setDisplayStyle(style);
      updateToolbarUI();
    });
    displayStyleGroup.appendChild(btn);
    return { style, btn };
  });

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
    return { view, btn };
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

  const freeResizeBtn = document.createElement("button");
  freeResizeBtn.type = "button";
  freeResizeBtn.textContent = "Free Resize";
  freeResizeBtn.addEventListener("click", () => {
    setFreeResizeEnabled(!freeResizeEnabled);
    updateToolbarUI();
  });

  labelGroup.append(zoomExtentsBtn, nameLabelsBtn, dimensionLabelsBtn, freeResizeBtn);

  const topRow = document.createElement("div");
  topRow.className = "toolbar-row";
  topRow.append(projectionGroup, displayStyleGroup, labelGroup);

  toolbar.append(topRow, viewGroup);
  container.appendChild(toolbar);

  function updateToolbarUI(): void {
    perspectiveBtn.classList.toggle("active", projectionMode === "perspective");
    orthographicBtn.classList.toggle("active", projectionMode === "orthographic");
    viewGroup.classList.toggle("visible", projectionMode === "orthographic");
    for (const { view, btn } of viewButtons) {
      btn.disabled = projectionMode !== "orthographic";
      btn.classList.toggle("active", view === currentStandardView);
    }
    for (const { style, btn } of displayStyleButtons) btn.classList.toggle("active", displayStyle === style);
    nameLabelsBtn.classList.toggle("active", showNameLabels);
    dimensionLabelsBtn.classList.toggle("active", showDimensionLabels);
    freeResizeBtn.classList.toggle("active", freeResizeEnabled);
  }

  updateToolbarUI();

  function getPosition(id: string): { x: number; y: number; z: number } | null {
    const group = groups.get(id);
    if (!group) return null;
    return { x: group.position.x, y: group.position.y, z: group.position.z };
  }

  function getDimensions(id: string): { width: number; height: number; depth: number } | null {
    const live = liveDimensions.get(id);
    if (live) return live;
    const object = lastSeen.get(id);
    return object ? { width: object.width, height: object.height, depth: object.depth } : null;
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
    getDimensions,
    resize,
    render,
  };
}
