import type { ObjectStore } from "./state";
import { objectsToCsv, parseShapesCsv } from "./csv";

export interface Sidebar {
  setSelected(id: string | null): void;
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
  onSelectRequest: (id: string | null) => void,
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
    heightField.wrapper,
    depthField.wrapper,
    error,
    formButtons,
  );
  container.appendChild(form);

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
      skipped > 0
        ? `Loaded ${rows.length} object${rows.length === 1 ? "" : "s"}, skipped ${skipped} invalid row${skipped === 1 ? "" : "s"}.`
        : `Loaded ${rows.length} object${rows.length === 1 ? "" : "s"}.`;
  });

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

  const list = document.createElement("div");
  list.className = "object-list";
  container.appendChild(list);

  let selectedId: string | null = null;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
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
    if (selectedId) {
      store.update(selectedId, name, width, height, depth);
    } else {
      store.add(name, width, height, depth);
      form.reset();
      widthField.input.value = "1";
      heightField.input.value = "1";
      depthField.input.value = "1";
      nameField.input.focus();
    }
  });

  function applyFormMode(): void {
    error.textContent = "";
    const object = selectedId ? store.objects.find((o) => o.id === selectedId) : undefined;
    if (object) {
      nameField.input.value = object.name;
      widthField.input.value = String(object.width);
      heightField.input.value = String(object.height);
      depthField.input.value = String(object.depth);
      submitButton.textContent = "Update object";
      cancelButton.hidden = false;
    } else {
      nameField.input.value = "";
      widthField.input.value = "1";
      heightField.input.value = "1";
      depthField.input.value = "1";
      submitButton.textContent = "Add object";
      cancelButton.hidden = true;
    }
  }

  function renderList(objects: readonly import("./types").SizeObject[]): void {
    list.innerHTML = "";
    for (const object of objects) {
      const row = document.createElement("div");
      row.className = "object-row";
      row.classList.toggle("selected", object.id === selectedId);
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
      dimsEl.textContent = `${object.width} × ${object.height} × ${object.depth}`;
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

      row.addEventListener("click", () => onSelectRequest(object.id));

      row.append(swatch, info, removeButton);
      list.appendChild(row);
    }
  }

  store.subscribe(renderList);

  return {
    setSelected(id) {
      selectedId = id;
      for (const child of Array.from(list.children)) {
        const row = child as HTMLElement;
        row.classList.toggle("selected", row.dataset.id === id);
      }
      applyFormMode();
    },
  };
}
