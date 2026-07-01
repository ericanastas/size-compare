import type { ObjectStore } from "./state";
import type { SizeObject } from "./types";
import { objectsToCsv, parseShapesCsv } from "./csv";

export interface Sidebar {
  setSelected(ids: readonly string[]): void;
}

const VARIES_HINT = "<Varies>";

function setFieldValue(input: HTMLInputElement, values: readonly string[]): void {
  const allSame = values.every((v) => v === values[0]);
  if (allSame) {
    input.value = values[0];
    input.placeholder = "";
  } else {
    input.value = "";
    input.placeholder = VARIES_HINT;
  }
}

function hexColor(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

function field(labelText: string, type: string, defaultValue: string): { wrapper: HTMLElement; input: HTMLInputElement } {
  const wrapper = document.createElement("label");
  wrapper.className = "field";
  const span = document.createElement("span");
  span.textContent = labelText;
  const input = document.createElement("input");
  input.type = type;
  if (type === "number") {
    input.min = "0.01";
    input.step = "any";
  }
  input.value = defaultValue;
  input.required = true;
  wrapper.append(span, input);
  return { wrapper, input };
}

export function createSidebar(
  container: HTMLElement,
  store: ObjectStore,
  onSelectRequest: (id: string | null, additive?: boolean) => void,
  getShareUrl: () => string,
): Sidebar {
  container.innerHTML = "";

  const heading = document.createElement("h1");
  heading.textContent = "Size Compare";
  container.appendChild(heading);

  const form = document.createElement("form");
  form.className = "add-form";
  form.noValidate = true;

  const nameField = field("Name", "text", "");
  const widthField = field("Width", "number", "1");
  const heightField = field("Height", "number", "1");
  const depthField = field("Depth", "number", "1");

  const error = document.createElement("p");
  error.className = "form-error";

  const submitButton = document.createElement("button");
  submitButton.type = "submit";
  submitButton.textContent = "Add object";

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.textContent = "Cancel";
  cancelButton.className = "cancel-btn";
  cancelButton.hidden = true;
  cancelButton.addEventListener("click", () => onSelectRequest(null));

  const formButtons = document.createElement("div");
  formButtons.className = "form-buttons";
  formButtons.append(submitButton, cancelButton);

  form.append(
    nameField.wrapper,
    widthField.wrapper,
    depthField.wrapper,
    heightField.wrapper,
    error,
    formButtons,
  );
  container.appendChild(form);

  const listHeading = document.createElement("h2");
  listHeading.className = "list-heading";
  listHeading.textContent = "Objects";
  container.appendChild(listHeading);

  const csvActions = document.createElement("div");
  csvActions.className = "csv-actions";

  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.textContent = "Save CSV";

  const loadButton = document.createElement("button");
  loadButton.type = "button";
  loadButton.textContent = "Load CSV";

  const loadInput = document.createElement("input");
  loadInput.type = "file";
  loadInput.accept = ".csv,text/csv";
  loadInput.className = "csv-file-input";

  const csvStatus = document.createElement("p");
  csvStatus.className = "csv-status";

  csvActions.append(saveButton, loadButton, loadInput, csvStatus);
  container.appendChild(csvActions);

  saveButton.addEventListener("click", () => {
    const csv = objectsToCsv(store.objects);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "shapes.csv";
    link.click();
    URL.revokeObjectURL(url);
  });

  loadButton.addEventListener("click", () => loadInput.click());

  loadInput.addEventListener("change", async () => {
    const file = loadInput.files?.[0];
    loadInput.value = "";
    if (!file) return;

    const text = await file.text();
    const { rows, skipped } = parseShapesCsv(text);

    if (rows.length === 0) {
      csvStatus.textContent = "No valid rows found in that file.";
      return;
    }

    store.load(rows);
    csvStatus.textContent =
      skipped > 0 ? `Skipped ${skipped} invalid row${skipped === 1 ? "" : "s"}.` : "";
  });

  const list = document.createElement("div");
  list.className = "object-list";
  container.appendChild(list);

  const shareActions = document.createElement("div");
  shareActions.className = "share-actions";

  const shareButton = document.createElement("button");
  shareButton.type = "button";
  shareButton.textContent = "Copy Share Link";

  const shareStatus = document.createElement("p");
  shareStatus.className = "share-status";

  shareActions.append(shareButton, shareStatus);
  container.appendChild(shareActions);

  shareButton.addEventListener("click", async () => {
    const url = getShareUrl();
    try {
      await navigator.clipboard.writeText(url);
      shareStatus.textContent = "Share link copied to clipboard.";
    } catch {
      shareStatus.textContent = url;
    }
  });

  let selectedIds: readonly string[] = [];

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    if (selectedIds.length > 0) {
      const nameRaw = nameField.input.value.trim();
      const widthRaw = widthField.input.value.trim();
      const heightRaw = heightField.input.value.trim();
      const depthRaw = depthField.input.value.trim();

      const patch: { name?: string; width?: number; height?: number; depth?: number } = {};
      if (nameRaw) patch.name = nameRaw;
      for (const [raw, key] of [
        [widthRaw, "width"],
        [heightRaw, "height"],
        [depthRaw, "depth"],
      ] as const) {
        if (raw === "") continue;
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) {
          error.textContent = "Width, height, and depth must be positive numbers.";
          return;
        }
        patch[key] = n;
      }

      error.textContent = "";
      store.updateMany(selectedIds, patch);
      return;
    }

    const name = nameField.input.value.trim();
    const width = Number(widthField.input.value);
    const height = Number(heightField.input.value);
    const depth = Number(depthField.input.value);

    if (!name) {
      error.textContent = "Name is required.";
      return;
    }
    if (![width, height, depth].every((n) => Number.isFinite(n) && n > 0)) {
      error.textContent = "Width, height, and depth must be positive numbers.";
      return;
    }

    error.textContent = "";
    store.add(name, width, height, depth);
    form.reset();
    widthField.input.value = "1";
    heightField.input.value = "1";
    depthField.input.value = "1";
    nameField.input.focus();
  });

  function applyFormMode(): void {
    error.textContent = "";
    const selected = selectedIds
      .map((id) => store.objects.find((o) => o.id === id))
      .filter((o): o is SizeObject => Boolean(o));

    if (selected.length > 0) {
      setFieldValue(nameField.input, selected.map((o) => o.name));
      setFieldValue(widthField.input, selected.map((o) => String(o.width)));
      setFieldValue(heightField.input, selected.map((o) => String(o.height)));
      setFieldValue(depthField.input, selected.map((o) => String(o.depth)));
      submitButton.textContent = selected.length > 1 ? `Update ${selected.length} objects` : "Update object";
      cancelButton.hidden = false;
    } else {
      nameField.input.value = "";
      nameField.input.placeholder = "";
      widthField.input.value = "1";
      widthField.input.placeholder = "";
      heightField.input.value = "1";
      heightField.input.placeholder = "";
      depthField.input.value = "1";
      depthField.input.placeholder = "";
      submitButton.textContent = "Add object";
      cancelButton.hidden = true;
    }
  }

  function renderList(objects: readonly SizeObject[]): void {
    saveButton.disabled = objects.length === 0;

    list.innerHTML = "";
    for (const object of objects) {
      const row = document.createElement("div");
      row.className = "object-row";
      row.classList.toggle("selected", selectedIds.includes(object.id));
      row.dataset.id = object.id;

      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.backgroundColor = hexColor(object.color);

      const info = document.createElement("div");
      info.className = "info";
      const nameEl = document.createElement("div");
      nameEl.className = "name";
      nameEl.textContent = object.name;
      const dimsEl = document.createElement("div");
      dimsEl.className = "dims";
      dimsEl.textContent = `${object.width} × ${object.depth} × ${object.height}`;
      info.append(nameEl, dimsEl);

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "remove-btn";
      removeButton.textContent = "×";
      removeButton.setAttribute("aria-label", `Remove ${object.name}`);
      removeButton.addEventListener("click", (event) => {
        event.stopPropagation();
        store.remove(object.id);
      });

      row.addEventListener("click", (event) => {
        onSelectRequest(object.id, event.shiftKey || event.ctrlKey || event.metaKey);
      });

      row.append(swatch, info, removeButton);
      list.appendChild(row);
    }
  }

  store.subscribe(renderList);

  return {
    setSelected(ids) {
      selectedIds = ids;
      for (const child of Array.from(list.children)) {
        const row = child as HTMLElement;
        row.classList.toggle("selected", ids.includes(row.dataset.id ?? ""));
      }
      applyFormMode();
    },
  };
}
