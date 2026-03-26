const $ = (sel) => document.querySelector(sel);

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeKeyId(key) {
  return String(key).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function getShotKey(appName, filename) {
  return `${appName}::${filename}`;
}

function getTrajectoryKey(appName, filenamesInOrder) {
  return `${appName}::${filenamesInOrder.join("|")}`;
}

function sortByStepAsc(shots) {
  return [...shots].sort((a, b) => Number(a.step) - Number(b.step));
}

function groupShotsByApp(shots) {
  const groups = new Map();
  for (const s of shots) {
    const appName = (s.app_name || "").trim() || "Unknown App";
    const pkg = (s.package_name || "").trim() || "unknown";
    if (!groups.has(appName)) groups.set(appName, { app_name: appName, package_name: pkg, screenshots: [] });
    groups.get(appName).screenshots.push(s);
  }
  const orderedApps = Array.from(groups.values()).sort((a, b) => a.app_name.localeCompare(b.app_name));
  for (const g of orderedApps) g.screenshots = sortByStepAsc(g.screenshots);
  return orderedApps;
}

function renderResultBox(result) {
  const pill = result.violation_detected ? "Violation" : "No violation";
  const pillClass = result.violation_detected ? "pill danger" : "pill";
  const typesText = (result.violation_types || []).join(", ");
  return `
    <div class="result">
      <div><span class="${pillClass}">${pill}</span><span class="pill">Severity: ${escapeHtml(result.severity || "low")}</span></div>
      <div style="margin-top:6px;"><b>Types:</b> ${escapeHtml(typesText || "[]")}</div>
      <div style="margin-top:6px;"><b>Reasoning:</b> ${escapeHtml(result.reasoning || "")}</div>
      <details>
        <summary>Raw response</summary>
        <pre>${escapeHtml(result.raw_response || "")}</pre>
      </details>
    </div>
  `;
}

function ensurePanels() {
  $("#baselinePanel").innerHTML = "";
  $("#contextPanel").innerHTML = "";
  $("#trajectoryPanel").innerHTML = "";
}

let state = {
  screenshots: [],
  uploadedKeys: new Set(),
  isLoading: false,
};

function renderPanels() {
  ensurePanels();
  const grouped = groupShotsByApp(state.screenshots);

  for (const appGroup of grouped) {
    const appBlockBaseline = document.createElement("div");
    appBlockBaseline.className = "app-block";
    appBlockBaseline.innerHTML = `<div class="app-title">${escapeHtml(appGroup.app_name)}</div>`;

    const appBlockContext = document.createElement("div");
    appBlockContext.className = "app-block";
    appBlockContext.innerHTML = `<div class="app-title">${escapeHtml(appGroup.app_name)}</div>`;

    for (const s of appGroup.screenshots) {
      const filename = s._uploadedFilename || "uploaded_image";
      const shotKey = getShotKey(appGroup.app_name, filename);
      const shotId = safeKeyId(shotKey);
      const meta = `Step ${s.step ?? ""} • ${s.seconds_since_launch ?? ""}s • ${s.user_action ? s.user_action : ""}`;

      const shotCardBaseline = document.createElement("div");
      shotCardBaseline.className = "shot-card";
      shotCardBaseline.innerHTML = `
        <img src="${s._previewUrl}" alt="${escapeHtml(filename)}" />
        <div>
          <div class="meta">${escapeHtml(meta)}</div>
          <div id="baseline-${shotId}" class="result" style="display:none;"></div>
          <div id="baseline-${shotId}-placeholder" class="meta">Not run</div>
        </div>
      `;
      appBlockBaseline.appendChild(shotCardBaseline);

      const shotCardContext = document.createElement("div");
      shotCardContext.className = "shot-card";
      shotCardContext.innerHTML = `
        <img src="${s._previewUrl}" alt="${escapeHtml(filename)}" />
        <div>
          <div class="meta">${escapeHtml(meta)}</div>
          <div id="context-${shotId}" class="result" style="display:none;"></div>
          <div id="context-${shotId}-placeholder" class="meta">Not run</div>
        </div>
      `;
      appBlockContext.appendChild(shotCardContext);
    }

    $("#baselinePanel").appendChild(appBlockBaseline);
    $("#contextPanel").appendChild(appBlockContext);
  }

  for (const appGroup of grouped) {
    const filenamesInOrder = appGroup.screenshots.map((s) => s._uploadedFilename || "uploaded_image");
    const trajKey = getTrajectoryKey(appGroup.app_name, filenamesInOrder);
    const trajId = safeKeyId(trajKey);

    const trajBlock = document.createElement("div");
    trajBlock.className = "app-block";
    trajBlock.innerHTML = `
      <div class="app-title">${escapeHtml(appGroup.app_name)}</div>
      <div class="traj-thumbs">
        ${appGroup.screenshots.map((s) => `<img class="thumb" src="${s._previewUrl}" alt="${escapeHtml(s._uploadedFilename)}" />`).join("")}
      </div>
      <div id="trajectory-${trajId}-placeholder" class="meta">Not run</div>
      <div id="trajectory-${trajId}"></div>
    `;
    $("#trajectoryPanel").appendChild(trajBlock);
  }
}

function updatePanelsWithResults(results) {
  for (const r of results) {
    if (r.condition === "baseline" || r.condition === "context") {
      const filename = r.screenshots_used?.[0] || "uploaded_image";
      const shotId = safeKeyId(getShotKey(r.app_name, filename));
      const prefix = r.condition === "baseline" ? "baseline" : "context";
      const placeholder = document.getElementById(`${prefix}-${shotId}-placeholder`);
      if (placeholder) placeholder.style.display = "none";
      const container = document.getElementById(`${prefix}-${shotId}`);
      if (container) {
        container.style.display = "block";
        container.innerHTML = renderResultBox(r);
      }
    } else if (r.condition === "trajectory") {
      const trajId = safeKeyId(getTrajectoryKey(r.app_name, r.screenshots_used || []));
      const placeholder = document.getElementById(`trajectory-${trajId}-placeholder`);
      if (placeholder) placeholder.style.display = "none";
      const container = document.getElementById(`trajectory-${trajId}`);
      if (container) container.innerHTML = renderResultBox(r);
    }
  }
}

function buildAppsPayload() {
  const grouped = groupShotsByApp(state.screenshots);
  return grouped.map((g) => ({
    app_name: g.app_name,
    package_name: g.package_name || "unknown",
    screenshots: g.screenshots.map((s) => ({
      filename: s._uploadedFilename,
      image_base64: s.image_base64,
      image_mime_type: s.image_mime_type,
      step: Number(s.step || 0),
      seconds_since_launch: Number(s.seconds_since_launch || 0),
      user_action: String(s.user_action || ""),
      notes: String(s.notes || ""),
    })),
  }));
}

async function runCondition(condition) {
  if (state.isLoading) return;
  state.isLoading = true;
  $("#status").textContent = `Running ${condition}...`;
  try {
    const base = $("#backendUrl").value.trim().replace(/\/+$/, "");
    const payload = { condition, model: "gemini-2.5-flash", apps: buildAppsPayload() };

    const resp = await fetch(`${base}/api/evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    const results = await resp.json();
    updatePanelsWithResults(results);
    $("#status").textContent = `Done: ${results.length} records`;
  } catch (e) {
    console.error(e);
    $("#status").textContent = `Error: ${e.message || e.toString()}`;
  } finally {
    state.isLoading = false;
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed reading file"));
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
}

function renderCustomUploads() {
  $("#customList").innerHTML = "";
  const uploaded = state.screenshots;
  for (const s of uploaded) {
    const div = document.createElement("div");
    div.className = "custom-item";
    div.innerHTML = `
      <img src="${s._previewUrl}" alt="${escapeHtml(s._uploadedFilename)}" />
      <div>
        <div class="form-row">
          <label>App name
            <input type="text" data-field="app_name" value="${escapeHtml(s.app_name || "")}" />
          </label>
          <label>Step
            <input type="number" data-field="step" value="${escapeHtml(s.step ?? 1)}" />
          </label>
          <label>Seconds since launch
            <input type="number" data-field="seconds_since_launch" value="${escapeHtml(s.seconds_since_launch ?? 0)}" />
          </label>
        </div>
        <div class="form-row">
          <label>User action before this screen
            <textarea data-field="user_action">${escapeHtml(s.user_action || "")}</textarea>
          </label>
        </div>
        <div class="form-row">
          <label>Notes (optional)
            <textarea data-field="notes">${escapeHtml(s.notes || "")}</textarea>
          </label>
        </div>
        <div class="meta">Filename: ${escapeHtml(s._uploadedFilename)}</div>
      </div>
    `;

    div.querySelectorAll("[data-field]").forEach((input) => {
      input.addEventListener("input", () => {
        const field = input.getAttribute("data-field");
        s[field] = input.value;
        renderPanels();
      });
    });
    $("#customList").appendChild(div);
  }
}

function addUploadedScreenshots(files) {
  const imgs = Array.from(files).filter((f) => f.type && f.type.startsWith("image/"));
  if (!imgs.length) return;

  for (let i = 0; i < imgs.length; i++) {
    const f = imgs[i];
    const entry = {
      app_name: "Custom",
      package_name: "unknown",
      step: 1 + i,
      seconds_since_launch: 0,
      user_action: "",
      notes: "",
      _uploadedFilename: f.name,
      image_base64: undefined,
      image_mime_type: f.type || "image/png",
      _previewUrl: URL.createObjectURL(f),
    };
    state.screenshots.push(entry);

    fileToBase64(f).then((dataUrl) => {
      entry.image_base64 = dataUrl;
    });
  }

  renderCustomUploads();
  renderPanels();
}

function init() {
  $("#status").textContent = "Ready. Upload screenshots to begin.";
  renderPanels();

  $("#btnBaseline").addEventListener("click", () => runCondition("baseline"));
  $("#btnContext").addEventListener("click", () => runCondition("context"));
  $("#btnTrajectory").addEventListener("click", () => runCondition("trajectory"));
  $("#btnAll").addEventListener("click", () => runCondition("all"));

  const dropzone = $("#dropzone");
  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.style.borderColor = "#3b82f6";
  });
  dropzone.addEventListener("dragleave", () => {
    dropzone.style.borderColor = "#94a3b8";
  });
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.style.borderColor = "#94a3b8";
    addUploadedScreenshots(e.dataTransfer.files);
  });
}

init();

