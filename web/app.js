const $ = (sel) => document.querySelector(sel);

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getShotKey(appName, filename) {
  return `${appName}::${filename}`;
}

function getTrajectoryKey(appName, filenamesInOrder) {
  return `${appName}::${filenamesInOrder.join("|")}`;
}

function safeKeyId(key) {
  // HTML id must not contain spaces; replace anything non-URL-safe with underscores.
  return String(key).replace(/[^a-zA-Z0-9_-]/g, "_");
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
  for (const g of orderedApps) {
    g.screenshots = sortByStepAsc(g.screenshots);
  }
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

  // Baseline + Context panels: show per screenshot.
  for (const appGroup of grouped) {
    const appBlockBaseline = document.createElement("div");
    appBlockBaseline.className = "app-block";
    const titleBaseline = document.createElement("div");
    titleBaseline.className = "app-title";
    titleBaseline.textContent = appGroup.app_name;
    appBlockBaseline.appendChild(titleBaseline);

    const appBlockContext = document.createElement("div");
    appBlockContext.className = "app-block";
    const titleContext = document.createElement("div");
    titleContext.className = "app-title";
    titleContext.textContent = appGroup.app_name;
    appBlockContext.appendChild(titleContext);

    for (const s of appGroup.screenshots) {
      const filename = s.filename || s._uploadedFilename || "uploaded_image";
      const shotKey = getShotKey(appGroup.app_name, filename);
      const shotId = safeKeyId(shotKey);
      const meta = `Step ${s.step ?? ""} • ${s.seconds_since_launch ?? ""}s • ${s.user_action ? s.user_action : ""}`;
      const imgSrc = s.filename
        ? `/api/screenshot?filename=${encodeURIComponent(s.filename)}`
        : s._previewUrl;

      const shotCardBaseline = document.createElement("div");
      shotCardBaseline.className = "shot-card";
      shotCardBaseline.innerHTML = `
        <img src="${imgSrc}" alt="${escapeHtml(filename)}" />
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
        <img src="${imgSrc}" alt="${escapeHtml(filename)}" />
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

  // Trajectory panel: show per app (sequence).
  for (const appGroup of grouped) {
    const filenamesInOrder = appGroup.screenshots.map((s) => s.filename || s._uploadedFilename || "uploaded_image");
    const trajKey = getTrajectoryKey(appGroup.app_name, filenamesInOrder);
    const trajId = safeKeyId(trajKey);

    const trajBlock = document.createElement("div");
    trajBlock.className = "app-block";
    trajBlock.innerHTML = `
      <div class="app-title">${escapeHtml(appGroup.app_name)}</div>
      <div class="traj-thumbs">
        ${appGroup.screenshots
          .map((s) => {
            const filename = s.filename || s._uploadedFilename || "uploaded_image";
            const imgSrc = s.filename
              ? `/api/screenshot?filename=${encodeURIComponent(s.filename)}`
              : s._previewUrl;
            return `<img class="thumb" src="${imgSrc}" alt="${escapeHtml(filename)}" />`;
          })
          .join("")}
      </div>
      <div id="trajectory-${trajId}-placeholder" class="meta">Not run</div>
      <div id="trajectory-${trajId}"></div>
    `;
    $("#trajectoryPanel").appendChild(trajBlock);
  }
}

function updatePanelsWithResults(results) {
  for (const r of results) {
    if (r.condition === "baseline") {
      const filename = r.screenshots_used && r.screenshots_used.length ? r.screenshots_used[0] : "uploaded_image";
      const shotKey = getShotKey(r.app_name, filename);
      const shotId = safeKeyId(shotKey);
      const placeholder = document.getElementById(`baseline-${shotId}-placeholder`);
      if (placeholder) placeholder.style.display = "none";
      const container = document.getElementById(`baseline-${shotId}`);
      if (container) {
        container.style.display = "block";
        container.innerHTML = renderResultBox(r);
      }
    } else if (r.condition === "context") {
      const filename = r.screenshots_used && r.screenshots_used.length ? r.screenshots_used[0] : "uploaded_image";
      const shotKey = getShotKey(r.app_name, filename);
      const shotId = safeKeyId(shotKey);
      const placeholder = document.getElementById(`context-${shotId}-placeholder`);
      if (placeholder) placeholder.style.display = "none";
      const container = document.getElementById(`context-${shotId}`);
      if (container) {
        container.style.display = "block";
        container.innerHTML = renderResultBox(r);
      }
    } else if (r.condition === "trajectory") {
      const filenamesInOrder = r.screenshots_used || [];
      const trajKey = getTrajectoryKey(r.app_name, filenamesInOrder);
      const trajId = safeKeyId(trajKey);
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
    screenshots: g.screenshots.map((s) => {
      const filename = s.filename || s._uploadedFilename || "uploaded_image";
      const payload = {
        // Always send filename so the backend can echo it back in screenshots_used.
        filename: filename,
        image_base64: s.image_base64 ? s.image_base64 : undefined,
        image_mime_type: s.image_mime_type || undefined,
        step: Number(s.step || 0),
        seconds_since_launch: Number(s.seconds_since_launch || 0),
        user_action: String(s.user_action || ""),
        notes: String(s.notes || ""),
      };
      // Remove undefined keys for smaller payload.
      for (const k of Object.keys(payload)) {
        if (payload[k] === undefined) delete payload[k];
      }
      return payload;
    }),
  }));
}

async function runCondition(condition) {
  if (state.isLoading) return;
  state.isLoading = true;
  $("#status").textContent = `Running ${condition}...`;
  try {
    const payload = {
      condition,
      model: "gemini-2.5-flash",
      apps: buildAppsPayload(),
    };

    const resp = await fetch("/api/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${text}`);
    }
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
    reader.onload = () => resolve(reader.result); // data URL
    reader.readAsDataURL(file);
  });
}

function renderCustomUploads() {
  $("#customList").innerHTML = "";
  const uploaded = state.screenshots.filter((s) => state.uploadedKeys.has(s._id));
  for (const s of uploaded) {
    const div = document.createElement("div");
    div.className = "custom-item";

    const filename = s.filename || s._uploadedFilename || "uploaded_image";
    div.innerHTML = `
      <img src="${s._previewUrl}" alt="${escapeHtml(filename)}" />
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
            <textarea data-field="user_action" placeholder="e.g., Opened app">${escapeHtml(s.user_action || "")}</textarea>
          </label>
        </div>
        <div class="form-row">
          <label>Notes (optional)
            <textarea data-field="notes" placeholder="e.g., Full-screen ad appeared immediately">${escapeHtml(s.notes || "")}</textarea>
          </label>
        </div>
        <div class="meta">Filename: ${escapeHtml(filename)}</div>
      </div>
    `;

    div.querySelectorAll("[data-field]").forEach((input) => {
      input.addEventListener("input", () => {
        const field = input.getAttribute("data-field");
        const value = input.value;
        if (field === "seconds_since_launch") s.seconds_since_launch = value;
        else s[field] = value;
        renderPanels(); // keep ordering visible if step changes
      });
    });

    $("#customList").appendChild(div);
  }
}

function addUploadedScreenshots(files) {
  const imgs = Array.from(files).filter((f) => f.type && f.type.startsWith("image/"));
  if (!imgs.length) return;

  const startIdx = state.screenshots.length;
  for (let i = 0; i < imgs.length; i++) {
    const f = imgs[i];
    const id = `up_${startIdx + i}_${Date.now()}`;

    const entry = {
      _id: id,
      app_name: "Custom",
      package_name: "unknown",
      step: 1 + i,
      seconds_since_launch: 0,
      user_action: "",
      notes: "",
      _uploadedFilename: f.name,
      filename: undefined,
      image_base64: undefined,
      image_mime_type: f.type || "image/png",
      _previewUrl: URL.createObjectURL(f),
    };

    state.uploadedKeys.add(id);
    state.screenshots.push(entry);

    // Load base64 for backend evaluation.
    fileToBase64(f).then((dataUrl) => {
      entry.image_base64 = dataUrl;
      entry.image_mime_type = f.type || entry.image_mime_type;
    });
  }

  renderCustomUploads();
  renderPanels();
}

async function init() {
  $("#status").textContent = "Loading metadata...";
  const resp = await fetch("/api/metadata");
  if (!resp.ok) throw new Error("Failed to load metadata.json");
  const data = await resp.json();
  const shots = [];
  for (const appObj of data.apps || []) {
    const appName = appObj.app_name;
    const pkg = appObj.package_name || "unknown";
    for (const s of appObj.screenshots || []) {
      shots.push({
        _id: `pre_${appName}_${s.filename}`,
        app_name: appName,
        package_name: pkg,
        filename: s.filename,
        step: s.step,
        seconds_since_launch: s.seconds_since_launch,
        user_action: s.user_action,
        notes: s.notes || "",
        image_base64: undefined,
        _previewUrl: null,
      });
    }
  }
  state.screenshots = shots;
  state.uploadedKeys = new Set();
  renderPanels();
  $("#status").textContent = "Ready (waiting for runs).";

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

  // If `evaluate.py` already produced results.json, preload it for comparison.
  try {
    const r2 = await fetch("/api/results");
    if (r2.ok) {
      const results = await r2.json();
      updatePanelsWithResults(results);
      $("#status").textContent = `Loaded precomputed results.json (${results.length} records).`;
    }
  } catch (e) {
    // Non-fatal: results.json may not exist yet.
  }
}

init().catch((e) => {
  console.error(e);
  $("#status").textContent = `Error loading UI: ${e.message || e.toString()}`;
});

